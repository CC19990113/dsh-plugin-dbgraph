/**
 * Pure `information_schema` row mapping for the MySQL dialect.
 *
 * Kept out of `mysql.ts` on purpose: the network half can only be exercised against a live server,
 * while everything that decides "what does this row mean" is a plain function over plain data. That
 * is what lets the mapping be tested without pretending a mocked query proves anything about MySQL.
 *
 * Rows arrive as `unknown` fields because `mysql2` types `information_schema` results as
 * `RowDataPacket` (an index signature), and a driver upgrade may widen a column. Every reader
 * narrows; nothing here trusts a field's shape.
 * @module dsh-plugin-dbgraph-catalog/mysql-map
 */

import type { ConnectionConfig, RawColumn, RawEdge, RawObject } from 'dsh-plugin-dbgraph-service'
import { asFiniteNumber, asString, isSensitiveName } from './support.ts'

/** One `information_schema.TABLES` row, restricted to the columns the dialect selects. */
export interface MysqlTableRow {
  readonly TABLE_SCHEMA?: unknown
  readonly TABLE_NAME?: unknown
  readonly TABLE_TYPE?: unknown
  readonly TABLE_COMMENT?: unknown
  readonly TABLE_ROWS?: unknown
}

/** One `information_schema.COLUMNS` row, restricted to the columns the dialect selects. */
export interface MysqlColumnRow {
  readonly TABLE_NAME?: unknown
  readonly COLUMN_NAME?: unknown
  readonly ORDINAL_POSITION?: unknown
  readonly COLUMN_TYPE?: unknown
  readonly IS_NULLABLE?: unknown
  readonly COLUMN_DEFAULT?: unknown
  readonly COLUMN_KEY?: unknown
  readonly COLUMN_COMMENT?: unknown
}

/** One `information_schema.KEY_COLUMN_USAGE` row for a foreign key, restricted to what is needed. */
export interface MysqlForeignKeyRow {
  readonly TABLE_NAME?: unknown
  readonly CONSTRAINT_NAME?: unknown
  readonly COLUMN_NAME?: unknown
  readonly ORDINAL_POSITION?: unknown
  readonly REFERENCED_TABLE_NAME?: unknown
  readonly REFERENCED_COLUMN_NAME?: unknown
}

/** One `information_schema.STATISTICS` row, restricted to what is needed. */
export interface MysqlIndexRow {
  readonly TABLE_NAME?: unknown
  readonly INDEX_NAME?: unknown
  readonly NON_UNIQUE?: unknown
  readonly SEQ_IN_INDEX?: unknown
  readonly COLUMN_NAME?: unknown
}

/** What a `TABLES` row contributes to an object, before its columns are attached. */
export interface MysqlTableFacts {
  /** Whether the row describes a base table or a view. */
  readonly kind: 'table' | 'view'
  /** Table comment, absent for a view's synthetic `VIEW` comment and for an empty comment. */
  readonly comment?: string
  /** Approximate row count from catalog statistics; absent for views and unknown counts. */
  readonly rowEstimate?: number
}

/** Index edges and single-column uniqueness, both keyed by table name. */
export interface MysqlIndexFacts {
  /** One edge per named index, columns in index order. */
  readonly edges: ReadonlyMap<string, readonly RawEdge[]>
  /** Columns covered by a single-column unique index, per table. */
  readonly singleUnique: ReadonlyMap<string, ReadonlySet<string>>
}

/** Base type names whose values are worth sampling for enum literals. */
const STRINGISH_MYSQL_TYPES: ReadonlySet<string> = new Set([
  'char',
  'varchar',
  'nchar',
  'nvarchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
])

/**
 * Whether a column's declared type is string-like, and therefore worth sampling for enum values.
 * MySQL reports the declared type (`varchar(64)`, `enum('a','b')`), so the base word before any
 * parenthesized modifier decides.
 * @param columnType - `COLUMN_TYPE` as the server declared it.
 * @returns true for character, text, enum and set types.
 */
export function isStringishMysqlType(columnType: string): boolean {
  // `split` always returns at least one element, so the base word is never absent.
  const base = columnType.toLowerCase().split('(')[0]!.trim()
  const word = base.split(/\s+/)[0]!
  return STRINGISH_MYSQL_TYPES.has(word)
}

/**
 * Whether one column is a candidate for enum sampling.
 *
 * Three gates, each for its own reason: a view's sampling query executes its definition (unbounded
 * work for a catalog enrichment), a non-string column's distinct values are numbers rather than
 * vocabulary, and a sensitive column's literals must never reach the on-disk index.
 * @param objectKind - the object's kind (`table`, `view`, …).
 * @param connection - the connection whose masking configuration applies.
 * @param column - the column to screen.
 * @returns true when sampling this column is safe and useful.
 */
export function shouldSampleMysqlColumn(
  objectKind: string,
  connection: ConnectionConfig,
  column: RawColumn,
): boolean {
  if (objectKind !== 'table') return false
  if (!isStringishMysqlType(column.type)) return false
  return !isSensitiveName(connection, column.name)
}

/**
 * The join key for a comment map: a column is identified by table plus column, never by column name
 * alone (two tables routinely share `id`).
 * @param table - table name.
 * @param column - column name.
 * @returns a key that cannot collide with an ordinary name.
 */
export function mysqlColumnKey(table: string, column: string): string {
  return `${table}\u0000${column}`
}

/**
 * Interpret one `TABLES` row.
 *
 * `TABLE_COMMENT` is `VIEW` for every view in MySQL — that is a marker, not a description, so it is
 * dropped rather than shown to a model as if a human wrote it. An empty string is also no comment.
 * @param row - one `information_schema.TABLES` row.
 * @returns the object's kind plus whatever comment and row estimate are real.
 */
export function mysqlTableFacts(row: MysqlTableRow): MysqlTableFacts {
  const tableType = (asString(row.TABLE_TYPE) ?? '').toUpperCase()
  const kind = tableType.includes('VIEW') ? 'view' : 'table'
  const rawComment = asString(row.TABLE_COMMENT)?.trim()
  const comment = rawComment === undefined || rawComment === '' || (kind === 'view' && rawComment.toUpperCase() === 'VIEW')
    ? undefined
    : rawComment
  const rowEstimate = asFiniteNumber(row.TABLE_ROWS)
  return {
    kind,
    ...(comment === undefined ? {} : { comment }),
    ...(rowEstimate === undefined ? {} : { rowEstimate }),
  }
}

/**
 * Group `COLUMNS` rows into per-table column lists, in declared order.
 *
 * `isUnique` is deliberately not derived from `COLUMN_KEY`: MySQL reports `UNI` for the first
 * column of *any* unique index, including a multi-column one, which would claim a column is unique
 * on its own when it is not. L2 computes uniqueness from `STATISTICS` instead.
 * @param rows - `information_schema.COLUMNS` rows.
 * @returns columns keyed by table name.
 */
export function groupMysqlColumns(rows: readonly MysqlColumnRow[]): Map<string, RawColumn[]> {
  const grouped = new Map<string, RawColumn[]>()
  for (const row of rows) {
    const table = asString(row.TABLE_NAME)
    const name = asString(row.COLUMN_NAME)
    if (table === undefined || name === undefined) continue
    const list = grouped.get(table) ?? []
    const defaultValue = asString(row.COLUMN_DEFAULT)
    list.push({
      name,
      ordinal: asFiniteNumber(row.ORDINAL_POSITION) ?? list.length + 1,
      type: asString(row.COLUMN_TYPE) ?? '',
      nullable: (asString(row.IS_NULLABLE) ?? 'YES').toUpperCase() === 'YES',
      isPrimaryKey: (asString(row.COLUMN_KEY) ?? '').toUpperCase() === 'PRI',
      ...(defaultValue === undefined ? {} : { defaultValue }),
    })
    grouped.set(table, list)
  }
  for (const [table, columns] of grouped) {
    grouped.set(table, [...columns].sort((left, right) => left.ordinal - right.ordinal))
  }
  return grouped
}

/**
 * Extract column comments, keyed by {@link mysqlColumnKey}.
 * @param rows - `information_schema.COLUMNS` rows that selected `COLUMN_COMMENT`.
 * @returns non-empty comments only.
 */
export function mysqlColumnComments(rows: readonly MysqlColumnRow[]): Map<string, string> {
  const comments = new Map<string, string>()
  for (const row of rows) {
    const table = asString(row.TABLE_NAME)
    const column = asString(row.COLUMN_NAME)
    const comment = asString(row.COLUMN_COMMENT)?.trim()
    if (table === undefined || column === undefined || comment === undefined || comment === '') continue
    comments.set(mysqlColumnKey(table, column), comment)
  }
  return comments
}

/** The parts of one foreign-key constraint, before they become an edge. */
interface ForeignKeyGroup {
  readonly table: string
  readonly name: string | undefined
  readonly referencedTable: string
  readonly parts: { readonly seq: number; readonly column: string; readonly referencedColumn: string }[]
}

/**
 * Group `KEY_COLUMN_USAGE` rows into one edge per foreign-key constraint.
 *
 * `refObject` is the referenced table's plain name: a catalog describes exactly one schema, and
 * `RawEdge` has no `refSchema` field, so a schema-qualified name here would not match anything the
 * writer stores.
 * @param rows - foreign-key rows, in any order.
 * @returns edges keyed by the referencing table name.
 */
export function groupMysqlForeignKeys(rows: readonly MysqlForeignKeyRow[]): Map<string, RawEdge[]> {
  const groups = new Map<string, ForeignKeyGroup>()
  for (const row of rows) {
    const table = asString(row.TABLE_NAME)
    const column = asString(row.COLUMN_NAME)
    const referencedTable = asString(row.REFERENCED_TABLE_NAME)
    const referencedColumn = asString(row.REFERENCED_COLUMN_NAME)
    if (table === undefined || column === undefined) continue
    if (referencedTable === undefined || referencedColumn === undefined) continue
    const name = asString(row.CONSTRAINT_NAME)
    const key = `${table}\u0000${name ?? ''}`
    const group = groups.get(key) ?? { table, name, referencedTable, parts: [] }
    group.parts.push({
      seq: asFiniteNumber(row.ORDINAL_POSITION) ?? group.parts.length + 1,
      column,
      referencedColumn,
    })
    groups.set(key, group)
  }

  const edges = new Map<string, RawEdge[]>()
  for (const group of groups.values()) {
    const parts = [...group.parts].sort((left, right) => left.seq - right.seq)
    const list = edges.get(group.table) ?? []
    list.push({
      kind: 'fk',
      ...(group.name === undefined ? {} : { name: group.name }),
      columns: parts.map(part => part.column),
      refObject: group.referencedTable,
      refColumns: parts.map(part => part.referencedColumn),
    })
    edges.set(group.table, list)
  }
  return edges
}

/**
 * Group `STATISTICS` rows into index edges and the set of singly-unique columns.
 *
 * A functional index (MySQL 8) reports a `NULL` `COLUMN_NAME` and an expression instead; the seam's
 * edge shape only has column names, so such an index is skipped rather than recorded with a wrong
 * or empty column list.
 * @param rows - `information_schema.STATISTICS` rows, in any order.
 * @returns edges and single-column uniqueness, both keyed by table name.
 */
export function groupMysqlIndexes(rows: readonly MysqlIndexRow[]): MysqlIndexFacts {
  interface IndexGroup {
    readonly table: string
    readonly name: string
    readonly unique: boolean
    readonly parts: { readonly seq: number; readonly column: string | undefined }[]
  }

  const groups = new Map<string, IndexGroup>()
  for (const row of rows) {
    const table = asString(row.TABLE_NAME)
    const name = asString(row.INDEX_NAME)
    if (table === undefined || name === undefined) continue
    const key = `${table}\u0000${name}`
    const group = groups.get(key) ?? {
      table,
      name,
      unique: asFiniteNumber(row.NON_UNIQUE) === 0,
      parts: [],
    }
    group.parts.push({
      seq: asFiniteNumber(row.SEQ_IN_INDEX) ?? group.parts.length + 1,
      column: asString(row.COLUMN_NAME),
    })
    groups.set(key, group)
  }

  const edges = new Map<string, RawEdge[]>()
  const singleUnique = new Map<string, Set<string>>()
  for (const group of groups.values()) {
    const parts = [...group.parts].sort((left, right) => left.seq - right.seq)
    if (parts.some(part => part.column === undefined)) continue
    const columns = parts.map(part => part.column as string)
    const list = edges.get(group.table) ?? []
    list.push({ kind: 'index', name: group.name, columns, unique: group.unique })
    edges.set(group.table, list)
    const only = columns.length === 1 ? columns[0] : undefined
    if (group.unique && only !== undefined) {
      const set = singleUnique.get(group.table) ?? new Set<string>()
      set.add(only)
      singleUnique.set(group.table, set)
    }
  }
  return { edges, singleUnique }
}

/**
 * Merge one table's L1 object with its L2 facts, without mutating the input.
 *
 * Column comments are applied here rather than in `groupMysqlColumns` so L1 stays a structural
 * snapshot and L2 is the only level that reads `COLUMN_COMMENT`.
 * @param object - the L1 object.
 * @param facts - what the `TABLES` row says about it, when one still exists.
 * @param columnComments - comments keyed by {@link mysqlColumnKey}.
 * @param uniqueColumns - columns covered by a single-column unique index.
 * @param edges - foreign-key and index edges leaving this object.
 * @param enumSamples - sampled literals keyed by column name.
 * @returns a new object carrying the enrichment.
 */
export function mergeMysqlObject(
  object: RawObject,
  facts: MysqlTableFacts | undefined,
  columnComments: ReadonlyMap<string, string>,
  uniqueColumns: ReadonlySet<string> | undefined,
  edges: readonly RawEdge[],
  enumSamples: ReadonlyMap<string, readonly string[]>,
): RawObject {
  const columns = object.columns.map(column => {
    const comment = columnComments.get(mysqlColumnKey(object.name, column.name))
    const sampled = enumSamples.get(column.name)
    return {
      ...column,
      isUnique: uniqueColumns?.has(column.name) ?? false,
      ...(comment === undefined ? {} : { comment }),
      ...(sampled === undefined ? {} : { enumValues: sampled }),
    }
  })
  return {
    ...object,
    ...(facts?.comment === undefined ? {} : { comment: facts.comment }),
    ...(facts?.rowEstimate === undefined ? {} : { rowEstimate: facts.rowEstimate }),
    columns,
    ...(edges.length === 0 ? {} : { edges }),
  }
}
