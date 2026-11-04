/**
 * Loader for the optional native index kernel (`crates/dbgraph-indexer`).
 *
 * The addon is optional at every level, the same posture `dsh-plugin-codegraph` takes with its Rust
 * extractor: a missing artifact, an unsupported platform, an unloadable binary, or an unusable answer
 * all mean "the JavaScript writer runs instead, it says so once, and nothing else changes".
 *
 * One deliberate exception to that posture: the caller that *asked* for `writer: 'rust'` gets an error
 * rather than a silent fallback. A parity check that quietly compared JS against JS would be worse
 * than a failed one.
 *
 * Artifact naming follows the build script (`dbgraph-indexer.<platform>-<arch>.node`, produced by
 * `crates/dbgraph-indexer/build-addon.sh`). `napi build` names some targets with a qualifier
 * (`linux-x64-gnu`, `win32-x64-msvc`), so both spellings are probed. `DSH_DBGRAPH_RUST_ADDON` may
 * point at an explicit artifact — a test hook, and an escape hatch for a deployment that ships the
 * binary outside the checkout.
 * @module dsh-plugin-dbgraph-store/rust-engine
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AliasGroup, RawCatalog } from 'dsh-plugin-dbgraph-service'

/** Environment variable that overrides the addon path. */
export const ADDON_ENV = 'DSH_DBGRAPH_RUST_ADDON'

/** What the addon's `buildIndex` returns. */
export interface RustBuildReport {
  /** Objects written. */
  readonly objects: number
  /** Columns written. */
  readonly columns: number
  /** Edges written. */
  readonly edges: number
  /** Search terms written. */
  readonly terms: number
  /** Wall-clock duration of the native call, in milliseconds. */
  readonly elapsedMs: number
}

/** What the addon's `buildIndex` accepts. */
export interface RustBuildInput {
  /** Absolute path of the `.tmp` index file. The caller renames it into place. */
  readonly dbPath: string
  /** `INDEX_SCHEMA_DDL`, executed verbatim. */
  readonly schemaDdl: readonly string[]
  /** `INDEX_SCHEMA_VERSION`. */
  readonly schemaVersion: number
  /** Connection identity stored in `meta.connection`. */
  readonly connection: string
  /** `JSON.stringify(catalog)` — text transport keeps the conversion off the event loop. */
  readonly catalogJson: string
  /** `JSON.stringify(aliases)`. */
  readonly aliasesJson: string
  /** Epoch milliseconds to stamp on every row, so the caller controls time. */
  readonly now: number
}

/** The narrow surface this module needs from the addon. */
export interface RustIndexer {
  /** Write one complete index to `input.dbPath`. */
  buildIndex(input: RustBuildInput): Promise<unknown>
}

/** The result of one load attempt. */
export interface RustLoad {
  /** The loaded kernel, when the artifact is usable. */
  readonly engine?: RustIndexer
  /** Why it could not be loaded; empty on success. */
  readonly reason: string
  /** Absolute artifact path that was loaded, when one was found. */
  readonly path?: string
}

const require = createRequire(import.meta.url)
const moduleDirectory = dirname(fileURLToPath(import.meta.url))

/** `<repo>/crates/dbgraph-indexer/artifacts` — three levels up from `src/` or `lib/`. */
const artifactsDirectory = join(moduleDirectory, '..', '..', '..', 'crates', 'dbgraph-indexer', 'artifacts')

/** Every artifact suffix this host could plausibly use, most specific build first. */
function artifactSuffixes(): string[] {
  const base = `${process.platform}-${process.arch}`
  const suffixes = [base]
  if (process.platform === 'linux') suffixes.push(`${base}-gnu`, `${base}-musl`)
  else if (process.platform === 'win32') suffixes.push(`${base}-msvc`)
  return suffixes
}

/** One load attempt's outcome is reused for the process lifetime, keyed by path. */
let cachedPath: string | undefined
let cachedLoad: RustLoad | undefined

/**
 * Where this host's artifact should be, and whether it is there.
 *
 * A missing file is not cached: an addon built while the host is running starts working on the next
 * call without a restart. A file that exists but throws while loading *is* cached — a corrupt binary
 * does not repair itself mid-process.
 * @returns the first existing candidate, or the reason none did.
 */
export function resolveAddonPath(): { readonly path?: string; readonly reason: string } {
  const override = process.env[ADDON_ENV]?.trim()
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) {
      return { reason: `${ADDON_ENV} points at ${override}, which does not exist` }
    }
    return { path: override, reason: `loaded from ${ADDON_ENV}` }
  }
  const tried = artifactSuffixes().map(suffix => join(artifactsDirectory, `dbgraph-indexer.${suffix}.node`))
  for (const candidate of tried) {
    if (existsSync(candidate)) return { path: candidate, reason: `found at ${candidate}` }
  }
  return {
    reason: `no native artifact for ${process.platform}-${process.arch}; looked for ${tried.join(', ')}`,
  }
}

/**
 * Load the native kernel, or explain why it is not available.
 * @returns the loaded kernel and the reason string for diagnostics.
 */
export function loadRustIndexer(): RustLoad {
  const resolution = resolveAddonPath()
  if (resolution.path === undefined) return { reason: resolution.reason }
  if (cachedLoad !== undefined && cachedPath === resolution.path) return cachedLoad
  const path = resolution.path
  try {
    const loaded: unknown = require(path)
    const buildIndex = typeof loaded === 'object' && loaded !== null
      ? (loaded as { buildIndex?: unknown }).buildIndex
      : undefined
    if (typeof buildIndex !== 'function') {
      const failed: RustLoad = { reason: `the addon at ${path} exports no buildIndex function`, path }
      cachedPath = path
      cachedLoad = failed
      return failed
    }
    const engine: RustIndexer = {
      buildIndex: async (input: RustBuildInput) =>
        (buildIndex as (value: RustBuildInput) => unknown).call(loaded, input),
    }
    const ready: RustLoad = { engine, reason: `loaded ${path}`, path }
    cachedPath = path
    cachedLoad = ready
    return ready
  } catch (error) {
    const failed: RustLoad = {
      reason: `the addon at ${path} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      path,
    }
    cachedPath = path
    cachedLoad = failed
    return failed
  }
}

/**
 * Validate and normalize the addon's answer.
 *
 * An addon that resolves with nonsense is treated exactly like an addon that threw: no partial answer
 * ever reaches the rename, so `index.db` keeps describing the previous run.
 * @param value - the resolved value of `buildIndex`.
 * @returns the report, or undefined when it is not a usable one.
 */
export function parseRustReport(value: unknown): RustBuildReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const counts: number[] = []
  for (const key of ['objects', 'columns', 'edges', 'terms'] as const) {
    const count = record[key]
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return undefined
    counts.push(count)
  }
  const elapsedMs = record.elapsedMs
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined
  return {
    objects: counts[0] as number,
    columns: counts[1] as number,
    edges: counts[2] as number,
    terms: counts[3] as number,
    elapsedMs,
  }
}

/** One catalog, ready to cross the addon boundary as text. */
export interface RustPayload {
  /** The snapshot. */
  readonly catalog: RawCatalog
  /** The alias table the writer expands. */
  readonly aliases: readonly AliasGroup[]
}

/**
 * Serialize one payload for the text transport.
 * @param payload - the catalog and aliases.
 * @returns the two JSON strings the addon expects.
 */
export function serializePayload(payload: RustPayload): { catalogJson: string; aliasesJson: string } {
  return {
    catalogJson: JSON.stringify(payload.catalog),
    aliasesJson: JSON.stringify(payload.aliases),
  }
}
