/**
 * SQLite dialect: `node:sqlite` (`DatabaseSync`), zero external dependencies.
 *
 * The catalog is read from `sqlite_master` plus the `PRAGMA` family rather than from a parser over
 * `CREATE TABLE` text: PRAGMAs are what SQLite itself considers the schema, they survive formatting
 * oddities, and `table_info` is the only way to learn a view's output columns.
 *
 * **Level split.** L1 lists objects and their columns (`table_info` is cheap, and a primary-key
 * flag comes with it). L2 adds what L1 deliberately omits: foreign keys (`foreign_key_list`),
 * indexes (`index_list` + `index_info`), single-column uniqueness, and enum samples. Comments are
 * never produced — SQLite keeps none, and inventing a description from a name would be the one
 * thing the catalog is not allowed to do.
 *
 * **Read-only at two layers.** Metadata (`test`, `fetchL1`, `fetchL2`) always opens the file with
 * `readOnly: true`, and `execute` applies the shared keyword gate. A statement the caller allowed to
 * write (`limits.readOnly: false`) is served by a read-write handle instead: the gate alone cannot see
 * inside a function call, and a `PRAGMA` or a trigger may write, so the file mode is the layer that
 * actually stops a write the gate cannot inspect. The handle cache keys on the mode, so a connection
 * never holds two handles at once — switching mode closes the previous one before opening the next.
 *
 * **Sampling is L2 and bounded.** Only text-affinity columns of real tables are sampled, with
 * `SELECT DISTINCT … WHERE … IS NOT NULL LIMIT ?` bounded by `DialectInput.enumSampleLimit`. Views
 * are skipped because sampling one runs its query plan, which can be arbitrarily expensive.
 *
 * **Timeouts.** `node:sqlite` is synchronous and exposes no statement interrupt in the supported
 * Node range, so `queryTimeoutMs` is not enforced here. Callers get an abort check between objects
 * during a catalog walk and before a statement; a single runaway statement cannot be cancelled
 * mid-flight. This is a capability gap of the binding, not a silent choice.
 * @module dsh-plugin-dbgraph-catalog/sqlite
 */

import type { DatabaseSync } from 'node:sqlite'
import { DbgraphError } from 'dsh-plugin-dbgraph-service'
import type {
  DialectInput,
  DialectProbe,
  ExecuteLimits,
  RawCatalog,
  RawColumn,
  RawEdge,
  RawObject,
  SqlResult,
} from 'dsh-plugin-dbgraph-service'
import { HandleCache } from './pool.ts'
import {
  asString,
  assertReadOnlyStatement,
  clampRowLimit,
  DBGRAPH_QUERY_FAILED_CODE,
  isReadStatement,
  isSensitiveName,
  messageOf,
  normalizeRows,
  throwIfAborted,
} from './support.ts'
import type { ManagedDialect } from './support.ts'

/**
 * The `node:sqlite` surface this dialect needs. Passed in rather than imported at module scope so a
 * Node build without the builtin can disable this dialect instead of failing the whole package.
 */
export type SqliteModule = Pick<typeof import('node:sqlite'), 'DatabaseSync'>

/**
 * Appended to every sqlite `SqlResult`: the seam advertises a statement timeout this binding cannot
 * enforce, and a caller that is never told cannot tell a slow query from a hung one.
 */
export const SQLITE_TIMEOUT_WARNING =
  'timeoutMs is not enforced by the sqlite dialect: node:sqlite cannot interrupt a running statement'

/** Prefix of SQLite's own bookkeeping tables, which are schema noise rather than user objects. */
const INTERNAL_TABLE_GLOB = 'sqlite_*'

/** Objects a catalog can describe: real tables and views. */
const LISTED_OBJECT_TYPES = new Set(['table', 'view'])

/** The statement that lists user objects. `NOT GLOB` treats `_` literally, unlike `LIKE`. */
const LIST_OBJECTS_QUERY =
  `SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT GLOB '${INTERNAL_TABLE_GLOB}' ORDER BY name`

/** The server version, for diagnostics only. */
const SERVER_VERSION_QUERY = 'SELECT sqlite_version() AS version'

/** One row of `sqlite_master`, restricted to the columns the query selects. */
interface MasterRow {
  readonly type: unknown
  readonly name: unknown
}

/** One row of `PRAGMA table_info`. */
interface TableInfoRow {
  readonly cid: unknown
  readonly name: unknown
  readonly type: unknown
  readonly notnull: unknown
  readonly dflt_value: unknown
  readonly pk: unknown
}

/** One row of `PRAGMA foreign_key_list`, before rows are grouped into constraints. */
interface ForeignKeyRow {
  readonly id: unknown
  readonly seq: unknown
  readonly table: unknown
  readonly from: unknown
  readonly to: unknown
}

/** One row of `PRAGMA index_list`. */
interface IndexListRow {
  readonly seq: unknown
  readonly name: unknown
  readonly unique: unknown
  readonly origin: unknown
}

/** One row of `PRAGMA index_info`. `name` is `null` for an expression index. */
interface IndexInfoRow {
  readonly seqno: unknown
  readonly name: unknown
}

/** The parts of one foreign-key constraint, in declaration order. */
interface ForeignKeyPart {
  readonly seq: number
  readonly from: string
  readonly to: string | null
}

/** A dialect instance backed by a per-connection `DatabaseSync` cache. */
class SqliteDialect implements ManagedDialect {
  readonly engine = 'sqlite' as const

  private readonly module: SqliteModule
  private readonly handles = new HandleCache<DatabaseSync>()

  /**
   * @param module - the `node:sqlite` module, injected so availability is a plugin decision.
   */
  constructor(module: SqliteModule) {
    this.module = module
  }

  /**
   * Round-trip check: open the file (read-only) and read the library version.
   * @param input - the connection to probe.
   * @returns the probe answer; a failure is reported, not thrown, except an abort.
   */
  async test(input: DialectInput): Promise<DialectProbe> {
    throwIfAborted(input.signal)
    const started = Date.now()
    try {
      const database = await this.acquire(input, true)
      const row = database.prepare(SERVER_VERSION_QUERY).get()
      const version = asString(row?.['version'])
      return {
        ok: true,
        ...(version === undefined ? {} : { serverVersion: version }),
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      return { ok: false, error: messageOf(error), elapsedMs: Date.now() - started }
    }
  }

  /**
   * Structural snapshot: every user table and view with its declared columns.
   * @param input - the connection to read.
   * @returns an `l1` catalog; per-object failures become warnings rather than aborting the run.
   */
  async fetchL1(input: DialectInput): Promise<RawCatalog> {
    throwIfAborted(input.signal)
    const database = await this.acquire(input, true)
    throwIfAborted(input.signal)
    const target = requireTarget(input)
    const fetchedAt = Date.now()
    const warnings: string[] = []
    const objects: RawObject[] = []

    for (const row of listObjects(database)) {
      throwIfAborted(input.signal)
      try {
        objects.push({
          kind: row.type === 'view' ? 'view' : 'table',
          name: row.name,
          columns: readColumns(database, row.name),
        })
      } catch (error) {
        // One broken object (a view over a dropped table, a malformed virtual table) must not cost
        // the snapshot every other table it already read.
        warnings.push(`sqlite: skipped "${row.name}": ${messageOf(error)}`)
      }
    }

    const serverVersion = readServerVersion(database)
    return {
      engine: 'sqlite',
      ...(serverVersion === undefined ? {} : { serverVersion }),
      database: target,
      objects,
      fetchedAt,
      level: 'l1',
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /**
   * Enrichment snapshot: merge foreign keys, indexes, single-column uniqueness and enum samples
   * onto the L1 objects passed in.
   * @param input - the connection to read.
   * @param l1 - the structural snapshot this run starts from; it is never mutated.
   * @returns an `l2` catalog; a per-object failure is recorded and that object stays at L1 shape.
   */
  async fetchL2(input: DialectInput, l1: RawCatalog): Promise<RawCatalog> {
    throwIfAborted(input.signal)
    const database = await this.acquire(input, true)
    throwIfAborted(input.signal)
    const warnings: string[] = []
    const objects: RawObject[] = []

    for (const object of l1.objects) {
      throwIfAborted(input.signal)
      objects.push(enrichObject(database, input, object, warnings))
    }

    return {
      engine: 'sqlite',
      ...(l1.serverVersion === undefined ? {} : { serverVersion: l1.serverVersion }),
      database: l1.database,
      objects,
      fetchedAt: Date.now(),
      level: 'l2',
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /**
   * Execute one statement. Reads are streamed and stopped at the row cap; a non-read is refused
   * before reaching the engine when the caller asked for read-only, and is otherwise run against a
   * read-write file handle. A read that hides a write channel (`EXPLAIN ANALYZE`, `INTO OUTFILE`) is
   * refused only while the execution is read-only; `allowWrites` is the deployment's explicit "this
   * statement may write" switch, and the gate does not second-guess it.
   *
   * `node:sqlite` compiles only the first statement of a multi-statement string and ignores the
   * rest, so a trailing `; DELETE …` is never executed — but the read-only rule still decides
   * whether that first statement may run at all.
   * @param input - the connection to run against.
   * @param query - the statement.
   * @param limits - row cap, timeout (not enforceable here) and the read-only flag.
   * @param parameters - values bound to the statement's `?` placeholders, in order. Omitting them
   * binds nothing, and a placeholder then evaluates as NULL — which silently turns
   * `WHERE name = ?` into `WHERE name = NULL` (no rows).
   * @returns the normalized result set.
   */
  async execute(
    input: DialectInput,
    query: string,
    limits: ExecuteLimits,
    parameters?: readonly unknown[],
  ): Promise<SqlResult> {
    throwIfAborted(input.signal)
    assertReadOnlyStatement(query, limits)
    const database = await this.acquire(input, limits.readOnly)
    throwIfAborted(input.signal)
    const started = Date.now()
    const cap = clampRowLimit(limits.maxRows)
    const bindings = sqliteBindings(parameters)

    try {
      const statement = database.prepare(query)
      if (!isReadStatement(query)) {
        const changes = statement.run(...bindings).changes
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          redacted: [],
          affectedRows: typeof changes === 'bigint' ? Number(changes) : changes,
          elapsedMs: Date.now() - started,
          warnings: [SQLITE_TIMEOUT_WARNING],
        }
      }

      const columns = statement.columns().map(column => column.name)
      const rawRows: Record<string, unknown>[] = []
      let truncated = false
      // Streaming stops at cap + one row: enough to prove there is more, without materializing a
      // result set the caller explicitly asked to bound.
      for (const row of statement.iterate(...bindings)) {
        if (rawRows.length >= cap) {
          truncated = true
          break
        }
        rawRows.push({ ...row })
      }
      const normalized = normalizeRows(columns, rawRows, input.connection)
      return {
        columns,
        rows: normalized.rows,
        rowCount: normalized.rows.length,
        truncated,
        redacted: normalized.redacted,
        elapsedMs: Date.now() - started,
        warnings: [SQLITE_TIMEOUT_WARNING],
      }
    } catch (error) {
      if (error instanceof DbgraphError) throw error
      throw new DbgraphError(
        `SQLite statement failed on connection "${input.connection.id}": ${messageOf(error)}`,
        DBGRAPH_QUERY_FAILED_CODE,
      )
    }
  }

  /** Close every cached file handle. */
  async close(): Promise<void> {
    await this.handles.closeAll()
  }

  /**
   * The warm handle for a connection, in the mode the current call needs.
   *
   * The cache fingerprint carries the mode, so a read-only and a writable execution cannot share a
   * handle: the entry is keyed by connection id, and a changed fingerprint closes the previous handle
   * before the next one is opened. Replacing rather than accumulating is the point — which mode a
   * statement runs in must be the one it asked for, not whichever mode a connection happened to
   * open first, and one connection id owns exactly one open file.
   * @param input - the connection to open.
   * @param readOnly - whether the handle must refuse writes.
   * @returns the cached handle.
   */
  private async acquire(input: DialectInput, readOnly: boolean): Promise<DatabaseSync> {
    const target = requireTarget(input)
    return this.handles.acquire(
      input.connection.id,
      `${target}\u0000${readOnly ? 'ro' : 'rw'}`,
      () => {
        try {
          // The file mode makes the guarantee real rather than a keyword-list promise: a read-only
          // handle also means a mistyped path fails instead of silently creating an empty database.
          // A writable call (`allowWrites`) needs the opposite mode, or every write would fail.
          return new this.module.DatabaseSync(target, readOnly ? { readOnly: true } : {})
        } catch (error) {
          throw new DbgraphError(
            `cannot open SQLite database "${target}" for connection "${input.connection.id}"`
            + `${readOnly ? ' read-only' : ' for writing'}: ${messageOf(error)}`,
            'DBGRAPH_UNAVAILABLE',
          )
        }
      },
      database => database.close(),
    )
  }
}

/**
 * Create the SQLite dialect.
 * @param module - the loaded `node:sqlite` module.
 * @returns a dialect that caches one handle per connection id, in the mode each call needs.
 */
export function createSqliteDialect(module: SqliteModule): ManagedDialect {
  return new SqliteDialect(module)
}

/**
 * Quote a SQLite identifier for a `PRAGMA` argument. PRAGMAs cannot take bound parameters, so the
 * name is the one place a catalog query interpolates — double quotes inside it are doubled.
 * @param name - the identifier, as read from the database.
 * @returns the quoted identifier.
 */
export function sqliteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Whether a declared SQLite type has text affinity, and is therefore worth sampling for enum
 * values. SQLite has no enum type of its own, but a column declared `ENUM(...)` or `SET(...)` is
 * still semantically one, so those words count too.
 * @param declaredType - the type text as declared.
 * @returns true when the column is string-like.
 */
export function isStringishSqliteType(declaredType: string): boolean {
  const normalized = declaredType.toLowerCase()
  return normalized.includes('char')
    || normalized.includes('clob')
    || normalized.includes('text')
    || normalized.includes('enum')
    || normalized.includes('set')
}

/**
 * A value `node:sqlite` can bind as an anonymous positional parameter.
 */
type SqliteBinding = null | number | bigint | string | Uint8Array

/**
 * Convert caller-supplied predicate values into values `node:sqlite` accepts.
 *
 * The seam hands over JSON-ish values (`unknown[]`), while the binding accepts only null, numbers,
 * text, bigints and binary views. Two conversions matter in practice: a JSON boolean becomes 1/0
 * (SQLite's storage convention) and a `Date` becomes ISO text (the same representation
 * {@link import('./support.ts').toJsonSafe} gives a result value), so a predicate value written the
 * same way it will be read back still matches. Anything else is refused loudly rather than bound as
 * something the caller did not ask for.
 * @param parameters - the values from `DatabaseDialect.execute`, when supplied.
 * @returns positional bindings, in order.
 * @throws DbgraphError with `DBGRAPH_QUERY_FAILED` for a value SQLite has no representation for.
 */
function sqliteBindings(parameters: readonly unknown[] | undefined): SqliteBinding[] {
  if (parameters === undefined) return []
  return parameters.map(toSqliteBinding)
}

/**
 * Convert one caller value.
 * @param value - the value to bind.
 * @returns the SQLite representation.
 */
function toSqliteBinding(value: unknown): SqliteBinding {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Uint8Array) return value
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  }
  throw new DbgraphError(
    `cannot bind a value of type ${typeof value} as a SQLite parameter; only scalars, dates and binary values are supported`,
    DBGRAPH_QUERY_FAILED_CODE,
  )
}

/**
 * The configured database file path for a connection.
 * @param input - the connection.
 * @returns the path.
 * @throws DbgraphError with `DBGRAPH_UNAVAILABLE` when the connection names no database.
 */
function requireTarget(input: DialectInput): string {
  const target = input.connection.database
  if (target === undefined || target === '') {
    throw new DbgraphError(
      `connection "${input.connection.id}" has no SQLite database path configured`,
      'DBGRAPH_UNAVAILABLE',
    )
  }
  return target
}

/**
 * Every listed object, with its name and declared kind.
 * @param database - the open database.
 * @returns rows with only string fields; malformed rows are dropped.
 */
function listObjects(database: DatabaseSync): { readonly type: 'table' | 'view'; readonly name: string }[] {
  const rows = queryAll(database, LIST_OBJECTS_QUERY) as unknown as MasterRow[]
  const listed: { readonly type: 'table' | 'view'; readonly name: string }[] = []
  for (const row of rows) {
    const name = asString(row.name)
    const type = asString(row.type)
    if (name === undefined || type === undefined) continue
    if (!LISTED_OBJECT_TYPES.has(type)) continue
    listed.push({ type: type === 'view' ? 'view' : 'table', name })
  }
  return listed
}

/**
 * Read a table's or view's declared columns.
 * @param database - the open database.
 * @param name - the object name.
 * @returns columns in declared order, with comment intentionally absent.
 */
function readColumns(database: DatabaseSync, name: string): RawColumn[] {
  const rows = queryAll(database, `PRAGMA table_info(${sqliteIdentifier(name)})`) as unknown as TableInfoRow[]
  return rows.map((row, index) => {
    const declaredName = asString(row.name) ?? ''
    const declaredType = asString(row.type) ?? ''
    const defaultValue = asString(row.dflt_value)
    const cid = asFiniteInteger(row.cid)
    return {
      name: declaredName,
      ordinal: cid === undefined ? index + 1 : cid + 1,
      type: declaredType,
      nullable: asFiniteInteger(row.notnull) !== 1,
      isPrimaryKey: (asFiniteInteger(row.pk) ?? 0) > 0,
      ...(defaultValue === undefined ? {} : { defaultValue }),
    }
  })
}

/**
 * Read every foreign-key constraint on one object.
 * @param database - the open database.
 * @param name - the object name.
 * @returns one edge per constraint, columns in declaration order.
 */
function readForeignKeys(database: DatabaseSync, name: string): RawEdge[] {
  const rows = queryAll(database, `PRAGMA foreign_key_list(${sqliteIdentifier(name)})`) as unknown as ForeignKeyRow[]
  const groups = new Map<number, { refObject: string; parts: ForeignKeyPart[] }>()
  for (const row of rows) {
    const id = asFiniteInteger(row.id)
    const from = asString(row.from)
    const refObject = asString(row.table)
    if (id === undefined || from === undefined || refObject === undefined) continue
    const seq = asFiniteInteger(row.seq) ?? 0
    const to = asString(row.to) ?? null
    const group = groups.get(id) ?? { refObject, parts: [] }
    group.parts.push({ seq, from, to })
    groups.set(id, group)
  }

  const edges: RawEdge[] = []
  for (const group of groups.values()) {
    const parts = [...group.parts].sort((left, right) => left.seq - right.seq)
    const columns = parts.map(part => part.from)
    const refColumns = parts.every(part => part.to !== null)
      ? parts.map(part => part.to as string)
      : undefined
    edges.push({
      kind: 'fk',
      columns,
      refObject: group.refObject,
      ...(refColumns === undefined ? {} : { refColumns }),
    })
  }
  return edges
}

/**
 * Read every index on one object, and note which columns a single-column unique index covers.
 * @param database - the open database.
 * @param name - the object name.
 * @returns index edges plus the set of singly-unique column names.
 */
function readIndexes(database: DatabaseSync, name: string): {
  readonly edges: RawEdge[]
  readonly singleUnique: ReadonlySet<string>
} {
  const rows = queryAll(database, `PRAGMA index_list(${sqliteIdentifier(name)})`) as unknown as IndexListRow[]
  const edges: RawEdge[] = []
  const singleUnique = new Set<string>()
  for (const index of rows) {
    const indexName = asString(index.name)
    if (indexName === undefined) continue
    const parts = queryAll(
      database,
      `PRAGMA index_info(${sqliteIdentifier(indexName)})`,
    ) as unknown as IndexInfoRow[]
    const columns: string[] = []
    for (const part of parts) {
      const column = asString(part.name)
      // An expression index has no column name (`name` is null); a column-name edge is the only
      // shape the seam can express, so such an index is not recorded rather than recorded wrongly.
      if (column !== undefined) columns.push(column)
    }
    if (columns.length === 0) continue
    const unique = asFiniteInteger(index.unique) === 1
    const only = columns.length === 1 ? columns[0] : undefined
    if (unique && only !== undefined) singleUnique.add(only)
    edges.push({ kind: 'index', name: indexName, columns, unique })
  }
  return { edges, singleUnique }
}

/**
 * Add L2 enrichment to one object without touching the L1 object it was given.
 * @param database - the open database.
 * @param input - the connection, for the enum sample bound.
 * @param object - the L1 object.
 * @param warnings - collector for tolerated per-object failures.
 * @returns the enriched object, or an L1 copy when its enrichment failed.
 */
function enrichObject(
  database: DatabaseSync,
  input: DialectInput,
  object: RawObject,
  warnings: string[],
): RawObject {
  let edges: RawEdge[]
  let singleUnique: ReadonlySet<string>
  try {
    const foreignKeys = readForeignKeys(database, object.name)
    const indexes = readIndexes(database, object.name)
    edges = [...foreignKeys, ...indexes.edges]
    singleUnique = indexes.singleUnique
  } catch (error) {
    warnings.push(`sqlite: enrichment failed for "${object.name}": ${messageOf(error)}`)
    return { ...object, columns: object.columns.map(column => ({ ...column })) }
  }

  // A single-column primary key is a single-column unique constraint too. A rowid primary key has
  // no index for `index_list` to report, so this is the only way that fact reaches the catalog.
  // (SQLite's legacy NULL quirk means a *nullable* non-INTEGER primary key is not a runtime unique
  // guarantee; the catalog reports the declared constraint, which is what the schema says.)
  const primaryKeys = object.columns.filter(column => column.isPrimaryKey === true)
  const [onlyPrimaryKey] = primaryKeys
  if (primaryKeys.length === 1 && onlyPrimaryKey !== undefined) {
    singleUnique = new Set([...singleUnique, onlyPrimaryKey.name])
  }

  const columns = object.columns.map(column => {
    const sampled = object.kind === 'table'
      ? sampleEnumValues(database, input, object.name, column, warnings)
      : undefined
    return {
      ...column,
      isUnique: singleUnique.has(column.name),
      ...(sampled === undefined ? {} : { enumValues: sampled }),
    }
  })

  return {
    ...object,
    columns,
    ...(edges.length === 0 ? {} : { edges }),
  }
}

/**
 * Sample a bounded set of distinct literals for one text-affinity column.
 * @param database - the open database.
 * @param input - the connection, for the sample bound.
 * @param table - the table name.
 * @param column - the column being sampled.
 * @param warnings - collector for a sample the server refused.
 * @returns the literals, or `undefined` when sampling was skipped or produced nothing.
 */
function sampleEnumValues(
  database: DatabaseSync,
  input: DialectInput,
  table: string,
  column: RawColumn,
  warnings: string[],
): readonly string[] | undefined {
  if (!isStringishSqliteType(column.type)) return undefined
  // A literal sampled from a password/token column would persist in the index; never take one.
  if (isSensitiveName(input.connection, column.name)) return undefined
  if (!Number.isFinite(input.enumSampleLimit) || input.enumSampleLimit < 1) return undefined
  const limit = Math.floor(input.enumSampleLimit)
  const identifier = sqliteIdentifier(column.name)
  const sql = `SELECT DISTINCT ${identifier} AS value FROM ${sqliteIdentifier(table)}`
    + ` WHERE ${identifier} IS NOT NULL LIMIT ?`
  try {
    const rows = database.prepare(sql).all(limit)
    const values: string[] = []
    for (const row of rows) {
      const value = enumText(row['value'])
      // DISTINCT already deduplicated on the server; the set guards a type-coerced collision
      // (1 and '1' in a text-affinity column).
      if (value !== undefined && !values.includes(value)) values.push(value)
    }
    return values.length === 0 ? undefined : values
  } catch (error) {
    warnings.push(`sqlite: enum sampling failed for "${table}.${column.name}": ${messageOf(error)}`)
    return undefined
  }
}

/**
 * Render one sampled value as text.
 * @param value - a driver value.
 * @returns the text form, or `undefined` for values that are not meaningful enum literals.
 */
function enumText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  return undefined
}

/**
 * The SQLite library version, when it can be read.
 * @param database - the open database.
 * @returns the version string, or `undefined`; a version probe never fails a catalog.
 */
function readServerVersion(database: DatabaseSync): string | undefined {
  try {
    const row = database.prepare(SERVER_VERSION_QUERY).get()
    return asString(row?.['version'])
  } catch {
    return undefined
  }
}

/**
 * Run a catalog query and hand back plain row objects.
 * @param database - the open database.
 * @param sql - a statement with no bound parameters.
 * @returns rows as ordinary objects (the driver returns null-prototype objects).
 * @throws DbgraphError with `DBGRAPH_QUERY_FAILED` when the statement fails.
 */
function queryAll(database: DatabaseSync, sql: string): Record<string, unknown>[] {
  try {
    return database.prepare(sql).all().map(row => ({ ...row }))
  } catch (error) {
    throw new DbgraphError(`SQLite catalog query failed: ${messageOf(error)}`, DBGRAPH_QUERY_FAILED_CODE)
  }
}

/**
 * A finite integer field, from a driver value of unknown shape.
 * @param value - the field value.
 * @returns the integer, or `undefined`.
 */
function asFiniteInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value === 'bigint') {
    const converted = Number(value)
    return Number.isSafeInteger(converted) ? converted : undefined
  }
  return undefined
}
