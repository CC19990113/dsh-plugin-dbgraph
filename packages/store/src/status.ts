/**
 * The prompt-digest sidecar (`status.json`): a small JSON document every connection's index state is
 * mirrored into, so the system-prompt section can answer "what does this database look like" with one
 * synchronous `readFileSync` instead of an SQLite open per prompt assembly.
 *
 * It is a *derived* copy. The index file stays authoritative; a missing or unreadable sidecar only
 * degrades one sentence. The one ordering rule that matters is placement: the writer renames the index
 * into place first and records the digest second, so a reader can never describe an index that is not
 * there yet (it may describe an older one, which is why `l1IndexedAt` is carried per entry).
 * @module dsh-plugin-dbgraph-store/status
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_STATUS_DIGEST_OBJECTS } from 'dsh-plugin-dbgraph-service'
import type {
  IndexLevel,
  RawObject,
  StatusConnectionEntry,
  StatusDigestEntry,
  StatusFile,
} from 'dsh-plugin-dbgraph-service'
import { normalizeComment } from './normalize.ts'
import { statusPath } from './paths.ts'

/** Format version of `status.json`; a reader that sees another one falls back to the weaker sentence. */
export const STATUS_FORMAT_VERSION = 1

/**
 * Render one object's display name the way every other surface does.
 * @param object - a raw catalog object.
 * @returns `schema.name` when a schema is present, else `name`.
 */
export function objectDisplayName(object: RawObject): string {
  const schema = object.schema ?? ''
  return schema === '' ? object.name : `${schema}.${object.name}`
}

/**
 * Rank and cap the digest: the widest objects first (a column count is the one size signal every
 * engine reports), name as the stable tie-break.
 * @param objects - the snapshot's objects.
 * @param maxEntries - the cap.
 * @returns the digest and how many objects were left out.
 */
function buildDigest(
  objects: readonly RawObject[],
  maxEntries: number,
): { digest: StatusDigestEntry[]; omitted: number } {
  const ranked = objects
    .map(object => {
      const comment = normalizeComment(object.comment)
      return {
        object: objectDisplayName(object),
        ...(comment === undefined ? {} : { comment }),
        columns: object.columns.length,
      }
    })
    /* v8 ignore start -- display names are unique (objects_identity), so the equal case cannot occur. */
    .sort((left, right) =>
      right.columns - left.columns || (left.object < right.object ? -1 : left.object > right.object ? 1 : 0))
    /* v8 ignore stop */
  const digest = ranked.slice(0, maxEntries)
  return { digest, omitted: ranked.length - digest.length }
}

/** What {@link buildStatusEntry} needs from a writer's run. */
export interface StatusEntryInput {
  /** Database family. */
  readonly engine: string
  /** Human label from `connections.json`, when one is configured. */
  readonly label?: string
  /** Which level the snapshot covers. */
  readonly level: IndexLevel
  /** Epoch milliseconds the snapshot was taken. */
  readonly fetchedAt: number
  /** Objects written. */
  readonly objects: readonly RawObject[]
  /** Column rows written (equal to the sum of the objects' columns unless a dialect disagreed). */
  readonly columnCount: number
  /** Digest cap; defaults to {@link DEFAULT_STATUS_DIGEST_OBJECTS}. */
  readonly maxDigestObjects?: number
}

/**
 * Build the sidecar entry for a writer's run.
 * @param input - the catalog-derived facts.
 * @returns the entry to store under the connection id.
 */
export function buildStatusEntry(input: StatusEntryInput): StatusConnectionEntry {
  const { digest, omitted } = buildDigest(input.objects, input.maxDigestObjects ?? DEFAULT_STATUS_DIGEST_OBJECTS)
  let commented = 0
  for (const object of input.objects) {
    for (const column of object.columns) {
      if (normalizeComment(column.comment) !== undefined) commented += 1
    }
  }
  const total = input.columnCount
  return {
    engine: input.engine,
    ...(input.label === undefined ? {} : { label: input.label }),
    l1IndexedAt: input.fetchedAt,
    ...(input.level === 'l2' ? { l2IndexedAt: input.fetchedAt } : {}),
    objects: input.objects.length,
    columns: total,
    commentCoverage: total === 0 ? 0 : commented / total,
    digest,
    digestOmitted: omitted,
  }
}

/**
 * Read the sidecar.
 *
 * Never throws: prompt assembly runs this on every request, so a corrupt or half-written file means
 * "no digest", not "the prompt fails to assemble".
 * @param root - index root.
 * @returns the document, or undefined when it is absent or unusable.
 */
export function readStatusFile(root: string): StatusFile | undefined {
  let text: string
  try {
    text = readFileSync(statusPath(root), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as { version?: unknown; updatedAt?: unknown; connections?: unknown }
  if (typeof candidate.version !== 'number') return undefined
  if (typeof candidate.connections !== 'object' || candidate.connections === null) return undefined
  return {
    version: candidate.version,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
    connections: candidate.connections as Readonly<Record<string, StatusConnectionEntry>>,
  }
}

/**
 * Record one connection's entry, preserving every other connection's entry.
 *
 * A document at another format version is replaced rather than merged: this build cannot promise it
 * understands a future entry's shape, and a fresh document is honest about being partial.
 * @param root - index root.
 * @param connectionId - the connection whose entry changed.
 * @param entry - the fresh entry.
 * @param now - epoch milliseconds of the write; defaults to now.
 */
export function writeStatusEntry(
  root: string,
  connectionId: string,
  entry: StatusConnectionEntry,
  now: number = Date.now(),
): void {
  const existing = readStatusFile(root)
  const connections: Record<string, StatusConnectionEntry> = existing?.version === STATUS_FORMAT_VERSION
    ? { ...existing.connections }
    : {}
  connections[connectionId] = entry
  const document: StatusFile = { version: STATUS_FORMAT_VERSION, updatedAt: now, connections }
  const target = statusPath(root)
  mkdirSync(dirname(target), { recursive: true })
  const staging = `${target}.tmp`
  writeFileSync(staging, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { force: true })
    throw error
  }
}
