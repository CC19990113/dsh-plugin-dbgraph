/**
 * Opening an index file, verifying its format version, and keeping a bounded number of connections
 * warm.
 *
 * Databases open READ-ONLY. A writer replaces the file wholesale (a per-run staging file → rename) while this
 * reader may be serving a query, so the store never takes a write lock and never repairs a file it does
 * not own. The pool therefore keys a cached handle on the path's *on-disk identity* (`dev:ino`): after
 * a rename the path names a new inode, the cached handle is stale, and the next read reopens instead of
 * serving the previous index forever.
 * @module dsh-plugin-dbgraph-store/database
 */

import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  DbgraphError,
  INDEX_META_KEYS,
  INDEX_SCHEMA_VERSION,
} from 'dsh-plugin-dbgraph-service'
import { messageOf } from './message.ts'

/** An open index and the `meta` rows read from it. */
export interface OpenedIndex {
  /** The live, read-only connection. */
  readonly db: DatabaseSync
  /** Every `meta` key/value the file carries. */
  readonly meta: ReadonlyMap<string, string>
}

/** One cached handle. */
interface PoolEntry {
  readonly opened: OpenedIndex
  /** `dev:ino` of the file at the moment it was opened. */
  readonly identity: string
  /** Monotonic last-use counter for LRU eviction. */
  lastUsed: number
}

/**
 * Read `meta` into a map.
 * @param db - an open index.
 * @returns every key/value pair.
 */
function readMeta(db: DatabaseSync): ReadonlyMap<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta').all()
  const meta = new Map<string, string>()
  for (const row of rows) {
    const key = row.key
    const value = row.value
    if (typeof key === 'string' && typeof value === 'string') meta.set(key, value)
  }
  return meta
}

/**
 * Open one index read-only and refuse a file this build does not understand.
 * @param path - absolute path of the index file.
 * @returns the live connection and its meta rows.
 */
export function openIndex(path: string): OpenedIndex {
  if (!existsSync(path)) {
    throw new DbgraphError(`no database-graph index exists at ${path}`, 'DBGRAPH_UNAVAILABLE')
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const meta = readMeta(db)
    const version = meta.get(INDEX_META_KEYS.schemaVersion)
    if (version === undefined) {
      throw new DbgraphError(`the index at ${path} records no schema version`, 'DBGRAPH_MALFORMED_INDEX')
    }
    if (Number(version) !== INDEX_SCHEMA_VERSION) {
      throw new DbgraphError(
        `the index at ${path} uses schema version ${version}; this build understands ${INDEX_SCHEMA_VERSION}`,
        'DBGRAPH_MALFORMED_INDEX',
      )
    }
    return { db, meta }
  } catch (error) {
    try {
      db?.close()
    } catch {
      // Closing a handle that failed to open is best-effort; the original error is the signal.
    }
    if (error instanceof DbgraphError) throw error
    throw new DbgraphError(
      `the index at ${path} is not readable: ${messageOf(error)}`,
      'DBGRAPH_MALFORMED_INDEX',
      { cause: error },
    )
  }
}

/**
 * A bounded LRU pool of read-only index connections.
 *
 * A stat per acquire is deliberate: it is the cheapest way to notice that a writer replaced the file,
 * and the alternative — trusting a handle until the process restarts — is exactly the bug an
 * atomically-replaced index would otherwise create.
 */
export class IndexPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly maxOpen: number
  private clock = 0
  private disposed = false

  /**
   * @param maxOpen - how many index files to keep open at once (default 4).
   */
  constructor(maxOpen = 4) {
    if (!Number.isInteger(maxOpen) || maxOpen < 1) {
      throw new Error('dbgraph-store: maxOpenIndexes must be a positive integer')
    }
    this.maxOpen = maxOpen
  }

  /**
   * Acquire the live connection for one index, reopening when the file on disk was replaced.
   * @param path - absolute path of the index file.
   * @returns the open index.
   */
  acquire(path: string): OpenedIndex {
    if (this.disposed) throw new DbgraphError('the dbgraph store is disposed', 'DBGRAPH_UNAVAILABLE')
    const identity = this.identityOf(path)
    const cached = this.entries.get(path)
    if (cached !== undefined && cached.identity !== identity) {
      this.closeEntry(cached)
      this.entries.delete(path)
    }
    const existing = this.entries.get(path)
    if (existing !== undefined) {
      existing.lastUsed = ++this.clock
      return existing.opened
    }
    const opened = openIndex(path)
    // Re-stat after opening: a rename between the first stat and the open would otherwise record the
    // previous file's identity against the new handle, and the next acquire would trust a stale map.
    const openedIdentity = this.identityOf(path)
    const entry: PoolEntry = { opened, identity: openedIdentity, lastUsed: ++this.clock }
    this.entries.set(path, entry)
    this.evictIfNeeded()
    return opened
  }

  /**
   * Close every pooled connection. Idempotent.
   */
  close(): void {
    this.disposed = true
    for (const entry of this.entries.values()) this.closeEntry(entry)
    this.entries.clear()
  }

  /**
   * The `dev:ino` identity of a file, as a cache key for "is this still the same file".
   * @param path - absolute path.
   * @returns the identity string.
   */
  private identityOf(path: string): string {
    try {
      const stats = statSync(path)
      return `${stats.dev}:${stats.ino}`
    } catch (error) {
      throw new DbgraphError(
        `no database-graph index exists at ${path}: ${messageOf(error)}`,
        'DBGRAPH_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  private closeEntry(entry: PoolEntry): void {
    try {
      entry.opened.db.close()
    } catch (error) {
      // A handle that already died needs no second close, but a failure here can leak a descriptor:
      // one line is enough to notice it.
      console.error('[dbgraph-store] closing a cached index handle failed:', messageOf(error))
    }
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxOpen) return
    // The pool is non-empty here: its size exceeds `maxOpen`, which is at least 1.
    let victim = this.entries.entries().next().value as [string, PoolEntry]
    for (const candidate of this.entries) {
      if (candidate[1].lastUsed < victim[1].lastUsed) victim = candidate
    }
    this.closeEntry(victim[1])
    this.entries.delete(victim[0])
  }
}
