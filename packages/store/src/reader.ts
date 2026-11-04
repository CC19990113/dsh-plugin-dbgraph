/**
 * The read path over one connection's index: `state`, `schema`, `objects`, `columns`, `impact`, `refs`,
 * plus the summary `record()` rebuilds the prompt digest from.
 *
 * Every operation here is offline and read-only by construction, and one rule separates them:
 * {@link IndexReader.state} **never throws** — a configuration surface asking "is this indexed" must
 * get an answer even when the file is missing or unusable — while every other read fails loudly, so
 * "no index" and "empty index" never look the same.
 *
 * Identifiers that reach SQL as identifiers (as opposed to bound values) are never taken from the
 * index's own text; the only identifier interpolation is a placeholder list whose length comes from a
 * count we control.
 * @module dsh-plugin-dbgraph-store/reader
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  DbgraphError,
  DEFAULT_INDEX_STALE_HOURS,
  DEFAULT_STATUS_DIGEST_OBJECTS,
  INDEX_META_KEYS,
  isValidConnectionId,
  searchMatchQuery,
} from 'dsh-plugin-dbgraph-service'
import type {
  ColumnView,
  ColumnsRequest,
  ColumnsResult,
  EdgeKind,
  ImpactRequest,
  ImpactResult,
  IndexState,
  IndexWriterKind,
  ObjectView,
  ObjectsRequest,
  ObjectsResult,
  RelationView,
  RefsRequest,
  RefsResult,
  SchemaRequest,
  SchemaResult,
  StatusDigestEntry,
} from 'dsh-plugin-dbgraph-service'
import { IndexPool } from './database.ts'
import type { OpenedIndex } from './database.ts'
import { normalizeComment } from './normalize.ts'
import { indexPath } from './paths.ts'
import type { StatusEntryFromIndexInput } from './status.ts'

/** One row of `objects`, as every read operation wants it. */
export interface ObjectRecord {
  /** SQLite rowid of the object. */
  readonly id: number
  /** Namespace, or `''` when the engine has none. */
  readonly schema: string
  /** Declared name. */
  readonly name: string
  /** Node category. */
  readonly kind: string
  /** Comment, already normalized. */
  readonly comment: string | undefined
}

/** One row of `columns`, as the resolver and the column listing want it. */
export interface ColumnRecord {
  /** SQLite rowid of the column. */
  readonly id: number
  /** Declared name. */
  readonly name: string
  /** Declared type, verbatim. */
  readonly type: string
  /** Whether the column admits NULL. */
  readonly nullable: boolean
  /** Declared default, rendered as text. */
  readonly defaultValue: string | undefined
  /** Comment, already normalized. */
  readonly comment: string | undefined
  /** Whether the column participates in the primary key. */
  readonly isPrimaryKey: boolean
  /** Whether a single-column unique constraint covers it. */
  readonly isUnique: boolean
  /** One-based position within the object. */
  readonly ordinal: number
  /** Sampled distinct literals, when the enrichment pass captured them. */
  readonly enumValues: readonly string[] | undefined
}

/** Bounds the reader imposes on one call. */
export interface ReaderConfig {
  /** Hours after which an L2 snapshot is reported stale. */
  readonly staleHours: number
  /** Index files kept open at once. */
  readonly maxOpenIndexes: number
  /** Objects one `schema` call may return. */
  readonly maxSchemaObjects: number
  /** Columns one `columns` call may return. */
  readonly maxColumns: number
  /** Objects one `objects` call returns when the request names no limit. */
  readonly defaultObjectLimit: number
  /** Digest entries written into the prompt sidecar. */
  readonly maxDigestObjects: number
  /** Foreign-key hops one `impact` walk follows. */
  readonly impactDepth: number
  /** Edges one `impact` or `refs` call may return. */
  readonly maxRelations: number
}

/** Defaults for a store mounted without tuning. */
export const DEFAULT_READER_CONFIG: ReaderConfig = {
  staleHours: DEFAULT_INDEX_STALE_HOURS,
  maxOpenIndexes: 4,
  maxSchemaObjects: 500,
  maxColumns: 500,
  defaultObjectLimit: 50,
  maxDigestObjects: DEFAULT_STATUS_DIGEST_OBJECTS,
  impactDepth: 3,
  maxRelations: 200,
}

/** What an object lookup found, so a caller can report ambiguity instead of guessing. */
export interface ObjectLookup {
  /** The unique match, when there is exactly one. */
  readonly record?: ObjectRecord
  /** Every match, when there was more than one. */
  readonly matches: readonly ObjectRecord[]
  /** Near misses offered when nothing matched. */
  readonly suggestions: readonly ObjectRecord[]
}

/**
 * A string cell.
 * @param row - a SQLite row.
 * @param key - the column name.
 * @returns the value when it is a string.
 */
function textOf(row: Record<string, SQLOutputValue>, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * A numeric cell with a fallback.
 * @param row - a SQLite row.
 * @param key - the column name.
 * @param fallback - returned when the cell is absent or not numeric.
 * @returns the number.
 */
function numberOf(row: Record<string, SQLOutputValue>, key: string, fallback = 0): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

/**
 * An optional numeric cell.
 * @param row - a SQLite row.
 * @param key - the column name.
 * @returns the number, or undefined when the cell is NULL or not numeric.
 */
function optionalNumberOf(row: Record<string, SQLOutputValue>, key: string): number | undefined {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

/**
 * A boolean cell stored as 0/1.
 * @param row - a SQLite row.
 * @param key - the column name.
 * @returns true when the cell is non-zero.
 */
function flagOf(row: Record<string, SQLOutputValue>, key: string): boolean {
  return numberOf(row, key, 0) !== 0
}

/**
 * Render an object for a model-facing surface.
 * @param record - the object row.
 * @returns `schema.name` when a schema is present, else `name`.
 */
export function displayName(record: ObjectRecord): string {
  return record.schema === '' ? record.name : `${record.schema}.${record.name}`
}

/**
 * Convert an `objects` row.
 * @param row - a SQLite row with the object columns selected.
 * @returns the record.
 */
function toObjectRecord(row: Record<string, SQLOutputValue>): ObjectRecord {
  return {
    id: numberOf(row, 'id'),
    schema: textOf(row, 'schema_name') ?? '',
    name: textOf(row, 'name') ?? '',
    kind: textOf(row, 'kind') ?? '',
    comment: normalizeComment(textOf(row, 'comment')),
  }
}

/**
 * Convert a `columns` row.
 * @param row - a SQLite row with the column columns selected.
 * @returns the record.
 */
function toColumnRecord(row: Record<string, SQLOutputValue>): ColumnRecord {
  return {
    id: numberOf(row, 'id'),
    name: textOf(row, 'name') ?? '',
    type: textOf(row, 'type') ?? '',
    nullable: flagOf(row, 'nullable'),
    defaultValue: textOf(row, 'default_value'),
    comment: normalizeComment(textOf(row, 'comment')),
    isPrimaryKey: flagOf(row, 'is_primary_key'),
    isUnique: flagOf(row, 'is_unique'),
    ordinal: numberOf(row, 'ordinal'),
    enumValues: parseEnumValues(textOf(row, 'enum_values_json')),
  }
}

/**
 * Parse the sampled-literal JSON column.
 * @param encoded - the stored JSON, when present.
 * @returns the values, or undefined when the cell is absent or unparsable.
 */
function parseEnumValues(encoded: string | undefined): readonly string[] | undefined {
  if (encoded === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(encoded)
    if (!Array.isArray(parsed)) return undefined
    const values = parsed.filter((value): value is string => typeof value === 'string')
    return values.length === 0 ? undefined : values
  } catch {
    return undefined
  }
}

/**
 * Read one required meta value.
 * @param opened - the open index.
 * @param key - the meta key.
 * @returns the value.
 */
function requireMeta(opened: OpenedIndex, key: string): string {
  const value = opened.meta.get(key)
  if (value === undefined) {
    throw new DbgraphError(`the index records no meta.${key}`, 'DBGRAPH_MALFORMED_INDEX')
  }
  return value
}

/**
 * Read an optional meta value as a number.
 * @param opened - the open index.
 * @param key - the meta key.
 * @returns the number, or undefined.
 */
function numberMeta(opened: OpenedIndex, key: string): number | undefined {
  const value = opened.meta.get(key)
  if (value === undefined) return undefined
  // "Unknown" is an absent key by contract; an empty string is not a timestamp. Coercing `''` would
  // make it epoch zero and describe the index as written in 1970.
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The FTS expression for free-text words, or undefined when the words hold no token.
 * @param words - the user's words.
 * @returns a `MATCH` expression or undefined.
 */
function matchExpression(words: readonly string[]): string | undefined {
  const expression = searchMatchQuery(words)
  return expression === '' ? undefined : expression
}

/**
 * Object ids matched by the FTS index, best rank first.
 *
 * Both document kinds count: an object document carries the table's own name and comment, a column
 * document carries one column's — and a question about a field is a question about the table holding
 * it. `bm25()` is lower-is-better, so merging keeps the minimum rank.
 * @param db - the open index.
 * @param match - an FTS expression.
 * @param limit - maximum ids to return.
 * @returns object ids in rank order.
 */
export function ftsObjectIds(db: DatabaseSync, match: string, limit: number): number[] {
  const ranks = new Map<number, number>()
  const remember = (id: number, rank: number): void => {
    const known = ranks.get(id)
    if (known === undefined || rank < known) ranks.set(id, rank)
  }
  try {
    const objectRows = db
      .prepare(
        `SELECT object_id AS id, bm25(search) AS rank FROM search
         WHERE search MATCH ? AND object_id IS NOT NULL ORDER BY rank LIMIT ?`,
      )
      .all(match, limit)
    for (const row of objectRows) {
      const id = optionalNumberOf(row, 'id')
      if (id !== undefined) remember(id, numberOf(row, 'rank'))
    }
    const columnRows = db
      .prepare(
        `SELECT c.object_id AS id, bm25(search) AS rank FROM search
         JOIN columns c ON c.id = search.column_id
         WHERE search MATCH ? AND column_id IS NOT NULL ORDER BY rank LIMIT ?`,
      )
      .all(match, limit)
    for (const row of columnRows) {
      const id = optionalNumberOf(row, 'id')
      if (id !== undefined) remember(id, numberOf(row, 'rank'))
    }
  } catch {
    // A malformed MATCH expression must not fail a listing; the caller falls back to LIKE.
    return []
  }
  return [...ranks.entries()]
    .sort((left, right) => left[1] - right[1] || left[0] - right[0])
    .map(entry => entry[0])
    .slice(0, limit)
}

/**
 * Fetch objects by id, preserving the caller's order.
 * @param db - the open index.
 * @param ids - object ids, in display order.
 * @returns the object views that exist, in the same order.
 */
function objectViewsByIds(db: DatabaseSync, ids: readonly number[]): ObjectView[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT o.id, o.schema_name, o.name, o.kind, o.comment, o.row_estimate,
              (SELECT COUNT(*) FROM columns c WHERE c.object_id = o.id) AS column_count
       FROM objects o WHERE o.id IN (${placeholders})`,
    )
    .all(...ids)
  const byId = new Map<number, ObjectView>()
  for (const row of rows) {
    const record = toObjectRecord(row)
    const rowEstimate = optionalNumberOf(row, 'row_estimate')
    byId.set(record.id, {
      object: displayName(record),
      kind: record.kind,
      ...(record.comment === undefined ? {} : { comment: record.comment }),
      columnCount: numberOf(row, 'column_count'),
      ...(rowEstimate === undefined ? {} : { rowEstimate }),
    })
  }
  const ordered: ObjectView[] = []
  for (const id of ids) {
    const view = byId.get(id)
    if (view !== undefined) ordered.push(view)
  }
  return ordered
}

/**
 * Suggest objects when an exact name missed.
 * @param db - the open index.
 * @param words - what the caller typed.
 * @returns up to five near matches, best first.
 */
export function suggestObjects(db: DatabaseSync, words: readonly string[]): ObjectRecord[] {
  const match = matchExpression(words)
  if (match !== undefined) {
    const ids = ftsObjectIds(db, match, 5)
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ')
      const rows = db
        .prepare(`SELECT id, schema_name, name, kind, comment FROM objects WHERE id IN (${placeholders})`)
        .all(...ids)
      const byId = new Map<number, ObjectRecord>()
      for (const row of rows) {
        const record = toObjectRecord(row)
        byId.set(record.id, record)
      }
      return ids.map(id => byId.get(id)).filter((record): record is ObjectRecord => record !== undefined)
    }
  }
  const needle = `%${(words.find(word => word !== '') ?? '').toLowerCase()}%`
  if (needle === '%%') return []
  const rows = db
    .prepare(
      `SELECT id, schema_name, name, kind, comment FROM objects
       WHERE lower(name) LIKE ? OR lower(comment) LIKE ? ORDER BY name LIMIT 5`,
    )
    .all(needle, needle)
  return rows.map(toObjectRecord)
}

/**
 * Locate an object by its listed name — bare (`sys_user`) or schema-qualified (`public.sys_user`).
 * @param db - the open index.
 * @param name - the name the caller used.
 * @returns the unique match, the ambiguous matches, or suggestions.
 */
export function lookupObject(db: DatabaseSync, name: string): ObjectLookup {
  const wanted = name.trim()
  if (wanted === '') return { matches: [], suggestions: [] }
  const rows = db
    .prepare(
      `SELECT id, schema_name, name, kind, comment FROM objects
       WHERE lower(name) = lower(?)
          OR (schema_name <> '' AND lower(schema_name || '.' || name) = lower(?))`,
    )
    .all(wanted, wanted)
  if (rows.length === 1) {
    const record = toObjectRecord(rows[0] as Record<string, SQLOutputValue>)
    return { record, matches: [record], suggestions: [] }
  }
  if (rows.length > 1) {
    return { matches: rows.map(toObjectRecord), suggestions: [] }
  }
  return { matches: [], suggestions: suggestObjects(db, [wanted]) }
}

/**
 * Load one object's columns in declared order.
 * @param db - the open index.
 * @param objectId - the object id.
 * @param limit - maximum rows (a caller passes `cap + 1` to detect truncation).
 * @returns column records.
 */
export function loadColumns(db: DatabaseSync, objectId: number, limit: number): ColumnRecord[] {
  const rows = db
    .prepare(
      `SELECT id, name, type, nullable, default_value, comment, is_primary_key, is_unique,
              ordinal, enum_values_json
       FROM columns WHERE object_id = ? ORDER BY ordinal, id LIMIT ?`,
    )
    .all(objectId, limit)
  return rows.map(toColumnRecord)
}

/**
 * Load a set of objects by id.
 * @param db - the open index.
 * @param ids - their ids.
 * @returns records keyed by id.
 */
export function loadObjects(db: DatabaseSync, ids: readonly number[]): Map<number, ObjectRecord> {
  const found = new Map<number, ObjectRecord>()
  if (ids.length === 0) return found
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT id, schema_name, name, kind, comment FROM objects WHERE id IN (${placeholders})`)
    .all(...ids)
  for (const row of rows) {
    const record = toObjectRecord(row)
    found.set(record.id, record)
  }
  return found
}

/**
 * List one object's columns for the seam.
 * @param db - the open index.
 * @param request - the columns request.
 * @param limit - the column cap.
 * @returns the column listing.
 */
function listColumns(db: DatabaseSync, request: ColumnsRequest, limit: number): ColumnsResult {
  const lookup = lookupObject(db, request.object)
  if (lookup.record === undefined) {
    const known = lookup.matches.length > 0
      ? lookup.matches.map(displayName).join(', ')
      : lookup.suggestions.map(displayName).join(', ') || 'none'
    throw new DbgraphError(
      `no object "${request.object}" in the index; ${lookup.matches.length > 1 ? 'matches' : 'similar'}: ${known}`,
      'DBGRAPH_UNKNOWN_OBJECT',
    )
  }
  const rows = loadColumns(db, lookup.record.id, limit + 1)
  const columns: ColumnView[] = rows.slice(0, limit).map(column => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    ...(column.defaultValue === undefined ? {} : { defaultValue: column.defaultValue }),
    ...(column.comment === undefined ? {} : { comment: column.comment }),
    isPrimaryKey: column.isPrimaryKey,
    isUnique: column.isUnique,
    ...(column.enumValues === undefined ? {} : { enumValues: column.enumValues }),
  }))
  return {
    object: displayName(lookup.record),
    kind: lookup.record.kind,
    ...(lookup.record.comment === undefined ? {} : { comment: lookup.record.comment }),
    columns,
    truncated: rows.length > limit,
  }
}

/** The `reader` half of the store: one pool, one root, no network. */
export class IndexReader {
  private readonly pool: IndexPool

  /**
   * @param root - index root.
   * @param config - the bounds this reader imposes.
   */
  constructor(
    private readonly root: string,
    private readonly config: ReaderConfig = DEFAULT_READER_CONFIG,
  ) {
    this.pool = new IndexPool(config.maxOpenIndexes)
  }

  /**
   * Open one connection's index, validating the identity first so no caller-supplied id becomes a
   * path fragment.
   * @param connection - connection identity.
   * @returns the open index.
   */
  open(connection: string): OpenedIndex {
    if (!isValidConnectionId(connection)) {
      throw new DbgraphError(`"${connection}" is not a usable connection id`, 'DBGRAPH_UNKNOWN_CONNECTION')
    }
    return this.pool.acquire(indexPath(connection, this.root))
  }

  /**
   * State of one connection's index. Never throws: an unusable index is reported as empty and stale.
   * @param connection - connection identity.
   * @returns the state.
   */
  state(connection: string): IndexState {
    try {
      const opened = this.open(connection)
      return this.stateOf(opened)
    } catch {
      return { objects: 0, columns: 0, stale: true }
    }
  }

  /**
   * Structural overview.
   * @param request - which connection.
   * @returns the overview.
   */
  schema(request: SchemaRequest): SchemaResult {
    const opened = this.open(request.connection)
    const engine = requireMeta(opened, INDEX_META_KEYS.engine)
    const database = requireMeta(opened, INDEX_META_KEYS.database)
    const total = numberOf(opened.db.prepare('SELECT COUNT(*) AS count FROM objects').get() ?? {}, 'count')
    const rows = opened.db
      .prepare(
        `SELECT o.schema_name, o.name, o.kind, o.comment, o.row_estimate,
                (SELECT COUNT(*) FROM columns c WHERE c.object_id = o.id) AS column_count
         FROM objects o ORDER BY column_count DESC, o.name ASC, o.id ASC LIMIT ?`,
      )
      .all(this.config.maxSchemaObjects)
    const objects: ObjectView[] = rows.map(row => {
      const comment = normalizeComment(textOf(row, 'comment'))
      const rowEstimate = optionalNumberOf(row, 'row_estimate')
      const schema = textOf(row, 'schema_name') ?? ''
      const name = textOf(row, 'name') ?? ''
      return {
        object: schema === '' ? name : `${schema}.${name}`,
        kind: textOf(row, 'kind') ?? '',
        ...(comment === undefined ? {} : { comment }),
        columnCount: numberOf(row, 'column_count'),
        ...(rowEstimate === undefined ? {} : { rowEstimate }),
      }
    })
    return {
      connection: request.connection,
      engine: engine as SchemaResult['engine'],
      database,
      objects,
      truncated: total > objects.length,
      index: this.stateOf(opened),
      commentCoverage: this.commentCoverageOf(opened),
    }
  }

  /**
   * Ranked object listing.
   * @param request - which connection and what to look for.
   * @returns the listing.
   */
  objects(request: ObjectsRequest): ObjectsResult {
    const opened = this.open(request.connection)
    const limit = this.objectLimit(request.limit)
    const query = request.query?.trim() ?? ''
    if (query === '') {
      const total = numberOf(opened.db.prepare('SELECT COUNT(*) AS count FROM objects').get() ?? {}, 'count')
      const ids = opened.db
        .prepare(
          `SELECT o.id, (SELECT COUNT(*) FROM columns c WHERE c.object_id = o.id) AS column_count
           FROM objects o ORDER BY column_count DESC, o.name ASC, o.id ASC LIMIT ?`,
        )
        .all(limit)
        .map(row => numberOf(row, 'id'))
      return { objects: objectViewsByIds(opened.db, ids), truncated: total > ids.length }
    }
    const match = matchExpression([query])
    const ids = match === undefined ? [] : ftsObjectIds(opened.db, match, limit + 1)
    if (ids.length > 0) {
      return {
        objects: objectViewsByIds(opened.db, ids.slice(0, limit)),
        truncated: ids.length > limit,
      }
    }
    // No FTS token (punctuation) or no hit: a LIKE over the readable columns still answers.
    const needle = `%${query.toLowerCase()}%`
    const rows = opened.db
      .prepare(
        `SELECT o.id, o.schema_name, o.name, o.kind, o.comment, o.row_estimate,
                (SELECT COUNT(*) FROM columns c WHERE c.object_id = o.id) AS column_count
         FROM objects o WHERE lower(o.name) LIKE ? OR lower(o.comment) LIKE ?
         ORDER BY column_count DESC, o.name ASC LIMIT ?`,
      )
      .all(needle, needle, limit + 1)
    const objects: ObjectView[] = rows.slice(0, limit).map(row => {
      const record = toObjectRecord(row)
      const rowEstimate = optionalNumberOf(row, 'row_estimate')
      return {
        object: displayName(record),
        kind: record.kind,
        ...(record.comment === undefined ? {} : { comment: record.comment }),
        columnCount: numberOf(row, 'column_count'),
        ...(rowEstimate === undefined ? {} : { rowEstimate }),
      }
    })
    return { objects, truncated: rows.length > limit }
  }

  /**
   * One object's columns.
   * @param request - which object.
   * @returns the listing.
   */
  columns(request: ColumnsRequest): ColumnsResult {
    return listColumns(this.open(request.connection).db, request, this.config.maxColumns)
  }

  /**
   * Objects a change to this one reaches: the transitive inbound reference closure, nearest first.
   * @param request - the object to trace.
   * @returns the reached objects.
   */
  impact(request: ImpactRequest): ImpactResult {
    const opened = this.open(request.connection)
    const lookup = lookupObject(opened.db, request.object)
    if (lookup.record === undefined) throw unknownObject(request.object, lookup)
    const entries: RelationView[] = []
    const visited = new Set<number>([lookup.record.id])
    let frontier: number[] = [lookup.record.id]
    let truncated = false
    for (let depth = 0; depth < this.config.impactDepth && frontier.length > 0 && !truncated; depth += 1) {
      const remaining = this.config.maxRelations - entries.length
      const rows = inboundEdges(opened.db, frontier, remaining + 1)
      if (rows.length > remaining) truncated = true
      const next: number[] = []
      for (const row of rows.slice(0, Math.max(0, remaining))) {
        entries.push(relationFromRow(row))
        const source = numberOf(row, 'src_object')
        if (!visited.has(source)) {
          visited.add(source)
          next.push(source)
        }
      }
      frontier = next
    }
    return { object: displayName(lookup.record), entries, truncated }
  }

  /**
   * Objects directly referencing this one.
   * @param request - the object to trace.
   * @returns the referencing objects.
   */
  refs(request: RefsRequest): RefsResult {
    const opened = this.open(request.connection)
    const lookup = lookupObject(opened.db, request.object)
    if (lookup.record === undefined) throw unknownObject(request.object, lookup)
    const rows = inboundEdges(opened.db, [lookup.record.id], this.config.maxRelations + 1)
    return {
      object: displayName(lookup.record),
      entries: rows.slice(0, this.config.maxRelations).map(row => relationFromRow(row)),
      truncated: rows.length > this.config.maxRelations,
    }
  }

  /**
   * Read the facts a prompt-digest entry is rebuilt from, for an index this process did not write.
   * @param connection - connection identity.
   * @returns the entry's facts without the display label (the caller adds it).
   */
  summary(connection: string): StatusEntryFromIndexInput {
    const opened = this.open(connection)
    const engine = requireMeta(opened, INDEX_META_KEYS.engine)
    const level = opened.meta.get(INDEX_META_KEYS.level) ?? 'l1'
    const fetchedAt = numberMeta(opened, INDEX_META_KEYS.fetchedAt) ?? numberMeta(opened, INDEX_META_KEYS.l1IndexedAt)
    if (fetchedAt === undefined) {
      throw new DbgraphError('the index records no fetched_at snapshot time', 'DBGRAPH_MALFORMED_INDEX')
    }
    const l1IndexedAt = numberMeta(opened, INDEX_META_KEYS.l1IndexedAt) ?? fetchedAt
    const l2IndexedAt = numberMeta(opened, INDEX_META_KEYS.l2IndexedAt)
      ?? (level === 'l2' ? fetchedAt : undefined)
    const objects = numberOf(opened.db.prepare('SELECT COUNT(*) AS count FROM objects').get() ?? {}, 'count')
    const columns = numberOf(opened.db.prepare('SELECT COUNT(*) AS count FROM columns').get() ?? {}, 'count')
    const digestRows = opened.db
      .prepare(
        `SELECT o.schema_name, o.name, o.comment,
                (SELECT COUNT(*) FROM columns c WHERE c.object_id = o.id) AS column_count
         FROM objects o ORDER BY column_count DESC, o.name ASC, o.id ASC LIMIT ?`,
      )
      .all(this.config.maxDigestObjects)
    const digest: StatusDigestEntry[] = digestRows.map(row => {
      const schema = textOf(row, 'schema_name') ?? ''
      const name = textOf(row, 'name') ?? ''
      const comment = normalizeComment(textOf(row, 'comment'))
      return {
        object: schema === '' ? name : `${schema}.${name}`,
        ...(comment === undefined ? {} : { comment }),
        columns: numberOf(row, 'column_count'),
      }
    })
    return {
      engine,
      level,
      l1IndexedAt,
      ...(l2IndexedAt === undefined ? {} : { l2IndexedAt }),
      objects,
      columns,
      commentCoverage: this.commentCoverageOf(opened),
      digest,
      digestOmitted: objects - digest.length,
    }
  }

  /**
   * Close every cached connection. Idempotent.
   */
  close(): void {
    this.pool.close()
  }

  /**
   * State derived from an already-open index, so `schema` does not stat the file twice.
   * @param opened - the open index.
   * @returns the state.
   */
  private stateOf(opened: OpenedIndex): IndexState {
    const counts = opened.db
      .prepare('SELECT (SELECT COUNT(*) FROM objects) AS objects, (SELECT COUNT(*) FROM columns) AS columns')
      .get() ?? {}
    const l1IndexedAt = numberMeta(opened, INDEX_META_KEYS.l1IndexedAt)
      ?? numberMeta(opened, INDEX_META_KEYS.fetchedAt)
    const l2IndexedAt = numberMeta(opened, INDEX_META_KEYS.l2IndexedAt)
      ?? (opened.meta.get(INDEX_META_KEYS.level) === 'l2' ? numberMeta(opened, INDEX_META_KEYS.fetchedAt) : undefined)
    const stale = l2IndexedAt === undefined || Date.now() - l2IndexedAt > this.config.staleHours * 3_600_000
    const writerValue = opened.meta.get(INDEX_META_KEYS.writer)
    const writer: IndexWriterKind | undefined = writerValue === 'js' || writerValue === 'rust' ? writerValue : undefined
    return {
      ...(l1IndexedAt === undefined ? {} : { l1IndexedAt }),
      ...(l2IndexedAt === undefined ? {} : { l2IndexedAt }),
      objects: numberOf(counts, 'objects'),
      columns: numberOf(counts, 'columns'),
      stale,
      ...(writer === undefined ? {} : { writer }),
    }
  }

  /**
   * Fraction of columns carrying a comment.
   * @param opened - the open index.
   * @returns 0..1, and 0 for an empty index (no evidence, not full coverage).
   */
  private commentCoverageOf(opened: OpenedIndex): number {
    const row = opened.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END) AS commented
         FROM columns`,
      )
      .get() ?? {}
    const total = numberOf(row, 'total')
    const commented = numberOf(row, 'commented')
    return total === 0 ? 0 : commented / total
  }

  /**
   * Clamp a requested object limit into the configured bounds.
   * @param requested - the caller's value, when one was set.
   * @returns a limit of at least 1, at most 500.
   */
  private objectLimit(requested: number | undefined): number {
    const fallback = this.config.defaultObjectLimit
    if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
      return Math.min(fallback, 500)
    }
    return Math.min(Math.floor(requested), 500)
  }
}

/**
 * Throw the structured error for an object name that did not resolve uniquely.
 * @param requested - the name the request used.
 * @param lookup - what the lookup found.
 * @returns never.
 */
function unknownObject(requested: string, lookup: ObjectLookup): DbgraphError {
  const known = lookup.matches.length > 0
    ? lookup.matches.map(displayName).join(', ')
    : lookup.suggestions.map(displayName).join(', ') || 'none'
  const qualifier = lookup.matches.length > 1 ? 'matches' : 'similar'
  return new DbgraphError(
    `no object "${requested}" in the index; ${qualifier}: ${known}`,
    'DBGRAPH_UNKNOWN_OBJECT',
  )
}

/**
 * Inbound edges (`dst_object` in the frontier) with both endpoints' display data.
 * @param db - the open index.
 * @param destinationIds - the objects being referenced.
 * @param limit - maximum rows.
 * @returns the rows.
 */
function inboundEdges(
  db: DatabaseSync,
  destinationIds: readonly number[],
  limit: number,
): Record<string, SQLOutputValue>[] {
  if (destinationIds.length === 0) return []
  const placeholders = destinationIds.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT e.id, e.kind, e.name, e.src_object, e.dst_object,
              so.schema_name AS src_schema, so.name AS src_name,
              sc.name AS src_column, dc.name AS dst_column
       FROM edges e
       JOIN objects so ON so.id = e.src_object
       LEFT JOIN columns sc ON sc.id = e.src_column_id
       LEFT JOIN columns dc ON dc.id = e.dst_column_id
       WHERE e.dst_object IN (${placeholders})
       ORDER BY e.dst_object, e.kind, so.name, e.id
       LIMIT ?`,
    )
    .all(...destinationIds, limit)
}

/**
 * Convert an inbound-edge row to the seam's relation shape.
 *
 * The named object in a `refs`/`impact` request is the edge's destination, so `object` is the source
 * end, `column` is the destination column (on the named object) and `refColumn` is the source column
 * (on the object that points at it).
 * @param row - the row.
 * @returns the relation view.
 */
function relationFromRow(row: Record<string, SQLOutputValue>): RelationView {
  const schema = textOf(row, 'src_schema') ?? ''
  const name = textOf(row, 'src_name') ?? ''
  const object = displayName({ id: 0, schema, name, kind: '', comment: undefined })
  const srcColumn = textOf(row, 'src_column')
  const dstColumn = textOf(row, 'dst_column')
  const edgeName = textOf(row, 'name')
  const kind = (textOf(row, 'kind') ?? 'fk') as EdgeKind
  return {
    kind,
    object,
    ...(dstColumn === undefined ? {} : { column: dstColumn }),
    ...(srcColumn === undefined ? {} : { refColumn: srcColumn }),
    ...(edgeName === undefined ? {} : { name: edgeName }),
  }
}
