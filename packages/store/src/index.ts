/**
 * The offline store plugin: `connections.json`, the index reader, the resolver, and the JavaScript
 * write path, mounted as one `DbgraphStore` on `ctx.dbgraph`.
 *
 * The store is host-local by construction — `node:sqlite` opens files on the machine running the
 * harness — and it reaches no network at all: dialects own every round-trip. `write()` is the one
 * mutating operation, and it follows the protocol the seam documents: staging file → rename → digest
 * sidecar, never the other way round.
 *
 * Namespace plugin (named exports, no default). Lifecycle is effect-scoped: disposal unregisters from
 * `ctx.dbgraph` and then closes every cached connection.
 * @module dsh-plugin-dbgraph-store
 */

import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import {
  DbgraphError,
  DEFAULT_INDEX_STALE_HOURS,
  DEFAULT_STATUS_DIGEST_OBJECTS,
  INDEX_META_KEYS,
  INDEX_SCHEMA_DDL,
  INDEX_SCHEMA_VERSION,
  ZH_ALIASES,
  isValidConnectionId,
} from 'dsh-plugin-dbgraph-service'
import type {
  AliasGroup,
  ColumnsRequest,
  ColumnsResult,
  ConnectionIdType,
  DbgraphStore,
  ImpactRequest,
  ImpactResult,
  IndexReport,
  IndexState,
  ObjectsRequest,
  ObjectsResult,
  RawCatalog,
  RefsRequest,
  RefsResult,
  Resolution,
  SchemaRequest,
  SchemaResult,
  FindRequest,
  StoredConnection,
  WriteOptions,
} from 'dsh-plugin-dbgraph-service'
import { findConnection, readConnections, writeConnections } from './connections.ts'
import { messageOf } from './message.ts'
import { DEFAULT_READER_CONFIG, IndexReader } from './reader.ts'
import type { ReaderConfig } from './reader.ts'
import { buildStatusEntry, writeStatusEntry } from './status.ts'
import { indexPath, indexRoot, stagingIndexPath, sweepStaleStaging } from './paths.ts'
import { DEFAULT_RESOLVE_OPTIONS, resolveFind } from './resolve.ts'
import type { ResolveOptions } from './resolve.ts'
import { writeIndexJs } from './writer-js.ts'
import { loadRustIndexer, parseRustReport } from './rust-engine.ts'
import type { RustIndexer } from './rust-engine.ts'

export {
  ADDON_ENV,
  loadRustIndexer,
  parseRustReport,
  resolveAddonPath,
  serializePayload,
} from './rust-engine.ts'
export type { RustBuildInput, RustBuildReport, RustIndexer, RustLoad, RustPayload } from './rust-engine.ts'

export { writeIndexJs } from './writer-js.ts'
export type { JsWriteInput } from './writer-js.ts'
export { assignCatalogIds, buildTerms, TERM_WEIGHTS } from './terms.ts'
export type { CatalogIds, SearchRow, TermBuild, TermRow } from './terms.ts'
export { buildEntityConcepts, DEFAULT_RESOLVE_OPTIONS } from './resolve.ts'
export type { ResolveOptions } from './resolve.ts'
export {
  ROOT_ENV,
  STALE_STAGING_MAX_AGE_MS,
  connectionDir,
  connectionsPath,
  indexRoot,
  indexPath,
  statusPath,
  stagingIndexPath,
  sweepStaleStaging,
} from './paths.ts'
export { CONNECTIONS_FORMAT_VERSION, findConnection, readConnections, writeConnections } from './connections.ts'
export { STATUS_FORMAT_VERSION, readStatusFile } from './status.ts'
export type { StatusEntryInput } from './status.ts'
export { IndexReader, DEFAULT_READER_CONFIG } from './reader.ts'
export type { ColumnRecord, ObjectLookup, ObjectRecord, ReaderConfig } from './reader.ts'
export { IndexPool, openIndex } from './database.ts'
export type { OpenedIndex } from './database.ts'

/** Cordis plugin name, for loader diagnostics. */
export const name = 'dbgraph-store'

/** Services this plugin needs before it can register. */
export const inject = ['dbgraph']

/** Store identity this build reserves on the seam. */
export const DEFAULT_STORE_ID = 'dbgraph-store'

/** Plugin configuration: the only bounds a deployment may retune. */
export interface Config {
  /** Index root; defaults to `DSH_DBGRAPH_ROOT` or `~/.dsh/dbgraph`. */
  readonly root?: string
  /** Hours after which an L2 snapshot is reported stale. Default 6. */
  readonly indexStaleHours?: number
  /** Resolver gate below which an answer is `ambiguous`. Default 0.6. */
  readonly minConfidence?: number
  /** Top-2 margin below which an answer is `ambiguous`. Default 0.15. */
  readonly ambiguityGap?: number
  /** Alias table; defaults to the service's `ZH_ALIASES`. */
  readonly aliases?: readonly AliasGroup[]
  /** Index files kept open at once. Default 4. */
  readonly maxOpenIndexes?: number
  /** Objects one `schema` call returns. Default 500. */
  readonly maxSchemaObjects?: number
  /** Columns one object may expose to a match. Default 500. */
  readonly maxColumns?: number
  /** Objects one `objects` call returns when the request names no limit. Default 50. */
  readonly defaultObjectLimit?: number
  /** Digest entries written into the prompt sidecar. Default 120. */
  readonly maxDigestObjects?: number
  /** Foreign-key hops one `impact` walk follows. Default 3. */
  readonly impactDepth?: number
  /** Edges one `impact` or `refs` call may return. Default 200. */
  readonly maxRelations?: number
}

/** Whether the automatic writer selection has already explained itself. One line per process. */
let autoFallbackReported = false

/**
 * Explain, once, that the automatic selection fell back to JavaScript. An unresponsive host is worse
 * than a slow one, so a missing addon is never fatal — but it is never silent either.
 * @param reason - why the native kernel could not be used.
 */
function reportAutoFallback(reason: string): void {
  if (autoFallbackReported) return
  autoFallbackReported = true
  console.error(
    `[dbgraph-store] the native index writer is unavailable (${reason});`
    + ' index writes will use the JavaScript writer',
  )
}

/**
 * One in-flight writer per connection.
 *
 * The staging path is unique per run, so two runs can no longer share a file — what still collides is
 * the live index and the digest that describes it. Each run renames its own complete file onto
 * `<connection>/index.db` and then writes a `status.json` entry; interleaved, the surviving index
 * could be run A's while the digest reports run B's counts and timestamps, and one of the two reports
 * would describe a file it did not leave behind. A run holds its connection id for that whole
 * rename-then-digest sequence, and a second one is refused with `DBGRAPH_CONFLICT` instead of racing.
 */
export class WriteGuard {
  private readonly active = new Set<string>()

  /**
   * Whether a write for this connection is in flight.
   * @param connection - connection identity.
   * @returns true when a run holds it.
   */
  has(connection: string): boolean {
    return this.active.has(connection)
  }

  /**
   * Run `work` while holding the connection, releasing it on both outcomes.
   * @param connection - connection identity.
   * @param work - the write to run.
   * @returns the write's result.
   * @throws DbgraphError with `DBGRAPH_CONFLICT` when another write already holds the connection.
   */
  async run<T>(connection: string, work: () => Promise<T>): Promise<T> {
    if (this.active.has(connection)) {
      throw new DbgraphError(
        `an index write for connection "${connection}" is already in progress; wait for it to finish`,
        'DBGRAPH_CONFLICT',
      )
    }
    this.active.add(connection)
    try {
      return await work()
    } finally {
      this.active.delete(connection)
    }
  }
}

/**
 * The store implementation: one reader (which owns the connection pool) plus the two files it manages.
 */
export class DbgraphIndexStore implements DbgraphStore {
  /** Store identity, as the seam's conflict message renders it. */
  readonly id: string = DEFAULT_STORE_ID

  /** Absolute directory this store keeps its files under (also read by the tool's prompt digest). */
  readonly root: string
  private readonly aliases: readonly AliasGroup[]
  private readonly reader: IndexReader
  /** One in-flight writer per connection; see {@link WriteGuard}. */
  readonly writes = new WriteGuard()
  private readonly resolveOptions: ResolveOptions
  private readonly maxDigestObjects: number

  /**
   * @param config - plugin configuration.
   */
  constructor(config: Config = {}) {
    this.root = config.root ?? indexRoot()
    this.aliases = config.aliases ?? ZH_ALIASES
    this.maxDigestObjects = config.maxDigestObjects ?? DEFAULT_STATUS_DIGEST_OBJECTS
    const readerConfig: ReaderConfig = {
      ...DEFAULT_READER_CONFIG,
      staleHours: config.indexStaleHours ?? DEFAULT_INDEX_STALE_HOURS,
      maxOpenIndexes: config.maxOpenIndexes ?? DEFAULT_READER_CONFIG.maxOpenIndexes,
      maxSchemaObjects: config.maxSchemaObjects ?? DEFAULT_READER_CONFIG.maxSchemaObjects,
      maxColumns: config.maxColumns ?? DEFAULT_READER_CONFIG.maxColumns,
      defaultObjectLimit: config.defaultObjectLimit ?? DEFAULT_READER_CONFIG.defaultObjectLimit,
      maxDigestObjects: this.maxDigestObjects,
      impactDepth: config.impactDepth ?? DEFAULT_READER_CONFIG.impactDepth,
      maxRelations: config.maxRelations ?? DEFAULT_READER_CONFIG.maxRelations,
    }
    this.reader = new IndexReader(this.root, readerConfig)
    this.resolveOptions = {
      ...DEFAULT_RESOLVE_OPTIONS,
      aliases: this.aliases,
      minConfidence: config.minConfidence ?? DEFAULT_RESOLVE_OPTIONS.minConfidence,
      ambiguityGap: config.ambiguityGap ?? DEFAULT_RESOLVE_OPTIONS.ambiguityGap,
      maxCandidates: DEFAULT_RESOLVE_OPTIONS.maxCandidates,
      maxColumns: readerConfig.maxColumns,
    }
  }

  /**
   * Every configured connection, in file order.
   * @returns the list; empty when no file exists yet.
   */
  async connections(): Promise<readonly StoredConnection[]> {
    return readConnections(this.root)
  }

  /**
   * Replace the connection list (round-trip through {@link readConnections} to modify one entry).
   * @param connections - the full list.
   * @returns nothing.
   */
  async saveConnections(connections: readonly StoredConnection[]): Promise<void> {
    writeConnections(connections, this.root)
  }

  /**
   * One connection's index state; an unusable or absent index reports empty and stale.
   * @param connection - connection identity.
   * @returns the state.
   */
  async state(connection: string): Promise<IndexState> {
    return this.reader.state(connection)
  }

  /**
   * Structural overview, from the index.
   * @param request - which connection.
   * @returns the overview.
   */
  async schema(request: SchemaRequest): Promise<SchemaResult> {
    return this.reader.schema(request)
  }

  /**
   * Object listing, from the index.
   * @param request - which connection and what to look for.
   * @returns the listing.
   */
  async objects(request: ObjectsRequest): Promise<ObjectsResult> {
    return this.reader.objects(request)
  }

  /**
   * One object's columns, from the index.
   * @param request - which object.
   * @returns the listing.
   */
  async columns(request: ColumnsRequest): Promise<ColumnsResult> {
    return this.reader.columns(request)
  }

  /**
   * Resolve a request to an object, its columns, and a parameterized predicate — no network, no
   * execution. The service composes this with a dialect when it runs `find`.
   * @param request - what the user asked about.
   * @returns the resolution.
   */
  async resolve(request: FindRequest): Promise<Resolution> {
    const opened = this.reader.open(request.connection)
    const engine = opened.meta.get(INDEX_META_KEYS.engine)
    if (engine === undefined) {
      throw new DbgraphError('the index records no meta.engine', 'DBGRAPH_MALFORMED_INDEX')
    }
    return resolveFind(opened.db, engine, request, this.resolveOptions)
  }

  /**
   * Objects a change to this one reaches.
   * @param request - the object to trace.
   * @returns the reached objects.
   */
  async impact(request: ImpactRequest): Promise<ImpactResult> {
    return this.reader.impact(request)
  }

  /**
   * Objects directly referencing this one.
   * @param request - the object to trace.
   * @returns the referencing objects.
   */
  async refs(request: RefsRequest): Promise<RefsResult> {
    return this.reader.refs(request)
  }

  /**
   * Write a snapshot, replacing the connection's index.
   *
   * Order is part of the contract: the index is renamed into place first, the digest sidecar second,
   * so no prompt ever describes an index that is not there yet. A sidecar failure is reported as a
   * warning on an otherwise successful report — the index itself is already durable and useful.
   * @param connection - connection identity.
   * @param catalog - the snapshot to write.
   * @param options - writer preference and the alias table.
   * @returns the run's report.
   */
  async write(connection: ConnectionIdType, catalog: RawCatalog, options: WriteOptions): Promise<IndexReport> {
    if (!isValidConnectionId(connection)) {
      throw new DbgraphError(`"${connection}" is not a usable connection id`, 'DBGRAPH_UNKNOWN_CONNECTION')
    }
    // One writer per connection: the staging file is per-run, but the live index and its digest are
    // not, so the second run is refused rather than allowed to interleave its rename and status write.
    return this.writes.run(connection, () => this.writeLocked(connection, catalog, options))
  }

  /**
   * The write body, run while this connection's in-flight slot is held.
   * @param connection - connection identity, already validated.
   * @param catalog - the snapshot to write.
   * @param options - writer preference and the alias table.
   * @returns the run's report.
   */
  private async writeLocked(
    connection: ConnectionIdType,
    catalog: RawCatalog,
    options: WriteOptions,
  ): Promise<IndexReport> {
    const aliases = options.aliases.length === 0 ? this.aliases : options.aliases
    const startedAt = performance.now()
    let report: IndexReport
    if (options.writer === 'js') {
      report = writeIndexJs({ connection, catalog, aliases, root: this.root })
    } else {
      const loaded = loadRustIndexer()
      if (options.writer === 'rust') {
        // Asked for explicitly: a silent JS fallback would make a parity check meaningless.
        if (loaded.engine === undefined) {
          throw new DbgraphError(
            `the rust writer is not available: ${loaded.reason}`,
            'DBGRAPH_UNAVAILABLE',
          )
        }
        report = await this.writeWithRust(loaded.engine, connection, catalog, aliases, startedAt)
      } else if (loaded.engine === undefined) {
        reportAutoFallback(loaded.reason)
        report = writeIndexJs({ connection, catalog, aliases, root: this.root })
      } else {
        try {
          report = await this.writeWithRust(loaded.engine, connection, catalog, aliases, startedAt)
        } catch (error) {
          // An automatic run degrades instead of failing: a host that cannot write natively still
          // owes the user an index. The staging file was already removed by writeWithRust.
          reportAutoFallback(`the native writer failed: ${messageOf(error)}`)
          report = writeIndexJs({ connection, catalog, aliases, root: this.root })
        }
      }
    }
    const merged = report
    const label = this.labelOf(connection)
    try {
      writeStatusEntry(
        this.root,
        connection,
        buildStatusEntry({
          engine: catalog.engine,
          ...(label === undefined ? {} : { label }),
          level: catalog.level,
          fetchedAt: catalog.fetchedAt,
          objects: catalog.objects,
          columnCount: merged.columns,
          maxDigestObjects: this.maxDigestObjects,
        }),
      )
    } catch (error) {
      return {
        ...merged,
        warnings: [
          ...merged.warnings,
          `the index was written but the prompt digest was not: ${messageOf(error)}`,
        ],
      }
    }
    return merged
  }

  /**
   * Write one index through the native kernel, then rename it into place.
   *
   * The addon owns exactly one file — the staging path — and deletes it on any failure. This method
   * owns the two decisions the addon must not make: that a successful build is renamed over the live
   * index, and that a failed or nonsensical one never is.
   * @param engine - the loaded native kernel.
   * @param connection - connection identity.
   * @param catalog - the snapshot to write.
   * @param aliases - the alias table.
   * @param startedAt - `performance.now()` when the call began.
   * @returns the run's report, with `writer: 'rust'`.
   */
  private async writeWithRust(
    engine: RustIndexer,
    connection: ConnectionIdType,
    catalog: RawCatalog,
    aliases: readonly AliasGroup[],
    startedAt: number,
  ): Promise<IndexReport> {
    const finalPath = indexPath(connection, this.root)
    const stagingPath = stagingIndexPath(connection, this.root)
    mkdirSync(dirname(finalPath), { recursive: true })
    // Clean up staging files a previous run left behind (a killed build never returns to rename).
    sweepStaleStaging(finalPath)
    rmSync(stagingPath, { force: true })
    let built: unknown
    try {
      built = await engine.buildIndex({
        dbPath: stagingPath,
        schemaDdl: [...INDEX_SCHEMA_DDL],
        schemaVersion: INDEX_SCHEMA_VERSION,
        connection,
        catalogJson: JSON.stringify(catalog),
        aliasesJson: JSON.stringify(aliases),
        now: Date.now(),
      })
    } catch (error) {
      // The addon deletes its own partial file; this is defense in depth for a load-time failure
      // that happened after the file was opened.
      rmSync(stagingPath, { force: true })
      throw new DbgraphError(
        `the rust writer failed for "${connection}": ${messageOf(error)}`,
        'DBGRAPH_WRITE_FAILED',
        { cause: error },
      )
    }
    const parsed = parseRustReport(built)
    if (parsed === undefined) {
      rmSync(stagingPath, { force: true })
      throw new DbgraphError(
        `the rust writer returned an unusable report for "${connection}"`,
        'DBGRAPH_WRITE_FAILED',
      )
    }
    try {
      renameSync(stagingPath, finalPath)
    } catch (error) {
      rmSync(stagingPath, { force: true })
      throw new DbgraphError(
        `renaming the rust-written index for "${connection}" failed: ${messageOf(error)}`,
        'DBGRAPH_WRITE_FAILED',
        { cause: error },
      )
    }
    return {
      connection,
      level: catalog.level,
      objects: parsed.objects,
      columns: parsed.columns,
      edges: parsed.edges,
      terms: parsed.terms,
      writer: 'rust',
      elapsedMs: Math.round(performance.now() - startedAt),
      warnings: [...(catalog.warnings ?? [])],
    }
  }

  /**
   * Close every cached connection. Idempotent; the store is unusable afterwards.
   */
  dispose(): void {
    this.reader.close()
  }

  /**
   * A connection's display label, when `connections.json` has one. A malformed file must not stop an
   * index write — the label is decoration, the index is the product.
   * @param connection - connection identity.
   * @returns the label, or undefined.
   */
  private labelOf(connection: string): string | undefined {
    try {
      return findConnection(connection, this.root)?.label
    } catch {
      return undefined
    }
  }
}

/**
 * Build a store without mounting it (tests, and callers that want the object directly).
 * @param config - plugin configuration.
 * @returns the store.
 */
export function createStore(config: Config = {}): DbgraphIndexStore {
  return new DbgraphIndexStore(config)
}

/**
 * Register the store on `ctx.dbgraph`.
 * @param ctx - the plugin context (must inject `dbgraph`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const store = new DbgraphIndexStore(config)
  ctx.effect(function* () {
    // Registered first so it disposes last: the store unregisters before its connections close, and
    // no call can be routed to a pool that is already shut.
    yield () => {
      store.dispose()
    }
    yield ctx.dbgraph.registerStore(store)
  }, 'dbgraph-store')
}
