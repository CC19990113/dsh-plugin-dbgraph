/**
 * MySQL dialect: `mysql2/promise`, loaded lazily.
 *
 * The driver is an optional dependency, so it is imported through {@link loadMysqlDriver} rather
 * than at module scope. A deployment without `mysql2` gets a `DBGRAPH_DRIVER_MISSING` error from
 * that loader (and the plugin simply does not register this dialect) instead of a package that
 * fails to load.
 *
 * The catalog comes from `information_schema` in four queries rather than from `SHOW` statements
 * per object: one round trip per catalog facet, and the column names carry the facts (`TABLE_TYPE`,
 * `COLUMN_COMMENT`, `REFERENCED_TABLE_NAME`) instead of needing a parser.
 *
 * **Level split.** L1 is `TABLES` (names, kinds) plus `COLUMNS` (declared types, nullability,
 * defaults, primary keys). L2 re-reads `TABLES`/`COLUMNS` for comments and row estimates, then adds
 * `KEY_COLUMN_USAGE` foreign keys, `STATISTICS` indexes, single-column uniqueness and enum samples.
 * A view's `TABLE_COMMENT` is the marker `VIEW`, not a description, and is dropped.
 *
 * **Read-only is a statement gate here, not a connection mode.** MySQL has no read-only connection
 * mode a pooled session can adopt without changing the transaction shape callers see, so `execute`
 * applies the shared keyword gate before the statement reaches the driver; the connection-level
 * guarantee belongs to the account's grants.
 *
 * **Per-object failure is tolerated.** Each object's merge and each column's enum sample is guarded:
 * a failure appends a warning and that object keeps its L1 shape, so a permissions quirk on one
 * table cannot cost the enrichment of every other one. A failure of a bulk `information_schema`
 * query is different — there is no partial answer to keep — and propagates; the service already
 * degrades that case to "index stays at L1".
 * @module dsh-plugin-dbgraph-catalog/mysql
 */

import type {
  FieldPacket,
  Pool,
  PoolConnection,
  PoolOptions,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { DbgraphError } from 'dsh-plugin-dbgraph-service'
import type {
  DialectInput,
  DialectProbe,
  ExecuteLimits,
  RawCatalog,
  RawEdge,
  RawObject,
  SqlResult,
} from 'dsh-plugin-dbgraph-service'
import {
  groupMysqlColumns,
  groupMysqlForeignKeys,
  groupMysqlIndexes,
  mergeMysqlObject,
  mysqlColumnComments,
  mysqlTableFacts,
  shouldSampleMysqlColumn,
} from './mysql-map.ts'
import type {
  MysqlColumnRow,
  MysqlForeignKeyRow,
  MysqlIndexRow,
  MysqlTableFacts,
  MysqlTableRow,
} from './mysql-map.ts'
import { HandleCache } from './pool.ts'
import {
  asString,
  assertReadOnlyStatement,
  clampRowLimit,
  DBGRAPH_QUERY_FAILED_CODE,
  messageOf,
  normalizeRows,
  throwIfAborted,
} from './support.ts'
import type { ManagedDialect } from './support.ts'

/** The optional driver package this dialect needs. */
export const MYSQL_DRIVER_PACKAGE = 'mysql2'

/** The `mysql2/promise` module surface this dialect uses, for the driver passed in at construction. */
export type MysqlModule = typeof import('mysql2/promise')

/** Where a connection with no `host` points. */
const DEFAULT_HOST = '127.0.0.1'

/** Where a connection with no `port` points. */
const DEFAULT_PORT = 3306

/** One pool per connection id; catalog reads serialize, execution occasionally overlaps them. */
const POOL_CONNECTION_LIMIT = 4

/** How long an idle pooled socket is kept before the pool closes it. */
const POOL_IDLE_TIMEOUT_MS = 60_000

/** Statement timeout used when the caller supplies a value that is not a usable number. */
const FALLBACK_TIMEOUT_MS = 10_000

/** L1 object listing: names and kinds only; comments belong to L2. */
const LIST_TABLES_QUERY = `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_NAME`

/** L1 column listing: declared shape only; comments belong to L2. */
const LIST_COLUMNS_QUERY = `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE,
    IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_NAME, ORDINAL_POSITION`

/** L2 table enrichment: comments and catalog row estimates. */
const ENRICH_TABLES_QUERY = `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_NAME`

/** L2 column enrichment: comments only; shape came from L1. */
const ENRICH_COLUMNS_QUERY = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_NAME, ORDINAL_POSITION`

/** L2 foreign keys. `REFERENCED_TABLE_NAME IS NULL` marks non-FK key usage rows. */
const FOREIGN_KEYS_QUERY = `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION,
    REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
  ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`

/** L2 indexes. */
const INDEXES_QUERY = `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`

/** The server version, for diagnostics only. */
const SERVER_VERSION_QUERY = 'SELECT VERSION() AS version'

/**
 * The in-flight or settled driver import. Cached so every connection shares one load, and cleared on
 * failure so a driver that appears later can still be picked up without restarting the process.
 */
let driverPromise: Promise<MysqlModule> | undefined

/**
 * Load `mysql2/promise`, or report that the optional driver is missing.
 * @returns the driver module.
 * @throws DbgraphError with `DBGRAPH_DRIVER_MISSING` when the package cannot be imported.
 */
export function loadMysqlDriver(): Promise<MysqlModule> {
  if (driverPromise === undefined) {
    driverPromise = import('mysql2/promise').catch((error: unknown) => {
      driverPromise = undefined
      throw new DbgraphError(
        `${MYSQL_DRIVER_PACKAGE} is required by the mysql dialect but could not be imported: ${messageOf(error)}`,
        'DBGRAPH_DRIVER_MISSING',
      )
    })
  }
  return driverPromise
}

/**
 * Create the MySQL dialect.
 * @param driver - the loaded `mysql2/promise` module.
 * @returns a dialect that caches one pool per connection id.
 */
export function createMysqlDialect(driver: MysqlModule): ManagedDialect {
  return new MysqlDialect(driver)
}

/**
 * Quote a MySQL identifier for a statement the server cannot parameterize.
 * @param name - the identifier, as read from the catalog.
 * @returns the backtick-quoted identifier.
 */
export function mysqlIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}

/** A dialect instance backed by a per-connection pool cache. */
class MysqlDialect implements ManagedDialect {
  readonly engine = 'mysql' as const

  private readonly driver: MysqlModule
  private readonly pools = new HandleCache<Pool>()

  /**
   * @param driver - the loaded driver module.
   */
  constructor(driver: MysqlModule) {
    this.driver = driver
  }

  /**
   * Round-trip check: connect and read the server version.
   * @param input - the connection to probe.
   * @returns the probe answer; a failure is reported, not thrown, except an abort.
   */
  async test(input: DialectInput): Promise<DialectProbe> {
    throwIfAborted(input.signal)
    const started = Date.now()
    try {
      const pool = await this.pool(input)
      const connection = await pool.getConnection()
      try {
        const [rows] = await connection.query<RowDataPacket[]>({
          sql: SERVER_VERSION_QUERY,
          timeout: statementTimeout(input.queryTimeoutMs),
        })
        const version = rows.length === 0 ? undefined : asString(rows[0]?.['version'])
        return {
          ok: true,
          ...(version === undefined ? {} : { serverVersion: version }),
          elapsedMs: Date.now() - started,
        }
      } finally {
        connection.release()
      }
    } catch (error) {
      return { ok: false, error: messageOf(error), elapsedMs: Date.now() - started }
    }
  }

  /**
   * Structural snapshot: every listed table and view with its declared columns.
   * @param input - the connection to read.
   * @returns an `l1` catalog.
   */
  async fetchL1(input: DialectInput): Promise<RawCatalog> {
    throwIfAborted(input.signal)
    const database = requireDatabase(input)
    return this.withConnection(input, async connection => {
      throwIfAborted(input.signal)
      const version = await this.readVersion(connection, input)
      const tables = await queryRows<MysqlTableRow>(connection, input, LIST_TABLES_QUERY, [database])
      const columns = await queryRows<MysqlColumnRow>(connection, input, LIST_COLUMNS_QUERY, [database])
      const columnsByTable = groupMysqlColumns(columns)
      const warnings: string[] = []
      const objects: RawObject[] = []

      for (const row of tables) {
        throwIfAborted(input.signal)
        const name = asString(row.TABLE_NAME)
        if (name === undefined) continue
        const facts = mysqlTableFacts(row)
        const tableColumns = columnsByTable.get(name) ?? []
        if (tableColumns.length === 0) {
          // Visible in TABLES but not in COLUMNS: the account can see the object, not its shape.
          warnings.push(`mysql: "${name}" exposed no columns`)
        }
        objects.push({
          kind: facts.kind,
          schema: database,
          name,
          columns: tableColumns,
        })
      }

      return {
        engine: 'mysql',
        ...(version === undefined ? {} : { serverVersion: version }),
        database,
        objects,
        fetchedAt: Date.now(),
        level: 'l1',
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    })
  }

  /**
   * Enrichment snapshot: comments, row estimates, foreign keys, indexes, single-column uniqueness and
   * enum samples merged onto the L1 objects passed in.
   * @param input - the connection to read.
   * @param l1 - the structural snapshot this run starts from; never mutated.
   * @returns an `l2` catalog.
   */
  async fetchL2(input: DialectInput, l1: RawCatalog): Promise<RawCatalog> {
    throwIfAborted(input.signal)
    const database = requireDatabase(input)
    return this.withConnection(input, async connection => {
      throwIfAborted(input.signal)
      const tables = await queryRows<MysqlTableRow>(connection, input, ENRICH_TABLES_QUERY, [database])
      const columns = await queryRows<MysqlColumnRow>(connection, input, ENRICH_COLUMNS_QUERY, [database])
      const foreignKeys = await queryRows<MysqlForeignKeyRow>(connection, input, FOREIGN_KEYS_QUERY, [database])
      const indexes = await queryRows<MysqlIndexRow>(connection, input, INDEXES_QUERY, [database])

      const facts = new Map<string, MysqlTableFacts>()
      for (const row of tables) {
        const name = asString(row.TABLE_NAME)
        if (name !== undefined) facts.set(name, mysqlTableFacts(row))
      }
      const comments = mysqlColumnComments(columns)
      const foreignKeyEdges = groupMysqlForeignKeys(foreignKeys)
      const indexFacts = groupMysqlIndexes(indexes)
      const warnings: string[] = []
      const objects: RawObject[] = []

      for (const object of l1.objects) {
        throwIfAborted(input.signal)
        objects.push(await this.enrichObject(
          connection,
          input,
          object,
          facts.get(object.name),
          comments,
          indexFacts.singleUnique.get(object.name),
          indexFacts.edges.get(object.name),
          foreignKeyEdges.get(object.name),
          warnings,
        ))
      }

      return {
        engine: 'mysql',
        ...(l1.serverVersion === undefined ? {} : { serverVersion: l1.serverVersion }),
        database: l1.database,
        objects,
        fetchedAt: Date.now(),
        level: 'l2',
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    })
  }

  /**
   * Execute one statement.
   *
   * The row cap is applied after the driver returns the result set: the statement is caller-authored,
   * and adding a `LIMIT` to it would change what the caller asked for. The seam's `maxRows` is a
   * display/cost bound, not a promise that the server stopped early.
   * @param input - the connection to run against.
   * @param query - the statement.
   * @param limits - row cap, statement timeout and the read-only flag.
   * @param parameters - values bound to the statement's `?` placeholders, in order. The driver
   * escapes them client-side, and omitting them leaves the statement exactly as written.
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
    const started = Date.now()
    // Prepared once: mysql2 treats `undefined` values as "no parameters", which keeps the prior
    // call shape for callers that never bind anything.
    const values = parameters === undefined ? undefined : [...parameters]
    return this.withConnection(input, async connection => {
      throwIfAborted(input.signal)
      const [result, fields] = await connection.query<RowDataPacket[] | ResultSetHeader>(
        { sql: query, timeout: statementTimeout(limits.timeoutMs) },
        values,
      )
      if (!Array.isArray(result)) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          redacted: [],
          affectedRows: result.affectedRows,
          elapsedMs: Date.now() - started,
        }
      }

      const columns = resultColumns(fields)
      const cap = clampRowLimit(limits.maxRows)
      const normalized = normalizeRows(columns, result.slice(0, cap), input.connection)
      return {
        columns,
        rows: normalized.rows,
        rowCount: normalized.rows.length,
        truncated: result.length > cap,
        redacted: normalized.redacted,
        elapsedMs: Date.now() - started,
      }
    })
  }

  /** Close every cached pool. */
  async close(): Promise<void> {
    await this.pools.closeAll()
  }

  /**
   * The warm pool for a connection.
   * @param input - the connection to serve.
   * @returns the cached pool.
   */
  private async pool(input: DialectInput): Promise<Pool> {
    const database = requireDatabase(input)
    const host = input.connection.host ?? DEFAULT_HOST
    const port = input.connection.port ?? DEFAULT_PORT
    // The password is deliberately not part of the fingerprint: this module must not retain it, and
    // a pool necessarily holds authenticated sockets. A rotated password takes effect when the pool
    // is recycled (target change or plugin reload).
    const fingerprint = `${host}:${port}/${database}/${input.connection.user ?? ''}`
    return this.pools.acquire(
      input.connection.id,
      fingerprint,
      () => {
        const options: PoolOptions = {
          host,
          port,
          database,
          waitForConnections: true,
          connectionLimit: POOL_CONNECTION_LIMIT,
          maxIdle: POOL_CONNECTION_LIMIT,
          idleTimeout: POOL_IDLE_TIMEOUT_MS,
          connectTimeout: statementTimeout(input.queryTimeoutMs),
          // UTF-8 must survive end to end: comments in this catalog are routinely Chinese.
          charset: 'utf8mb4',
          ...(input.connection.user === undefined ? {} : { user: input.connection.user }),
          ...(input.password === undefined ? {} : { password: input.password }),
        }
        return this.driver.createPool(options)
      },
      pool => pool.end(),
    )
  }

  /**
   * Run work against one pooled connection, releasing it afterwards.
   * @param input - the connection being served.
   * @param work - the queries to run on the borrowed connection.
   * @returns the work's result.
   */
  private async withConnection<T>(
    input: DialectInput,
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const pool = await this.pool(input)
    let connection: PoolConnection
    try {
      connection = await pool.getConnection()
    } catch (error) {
      throw new DbgraphError(
        `cannot connect to MySQL for connection "${input.connection.id}": ${messageOf(error)}`,
        'DBGRAPH_UNAVAILABLE',
      )
    }
    try {
      return await work(connection)
    } catch (error) {
      if (error instanceof DbgraphError) throw error
      throw new DbgraphError(
        `MySQL statement failed on connection "${input.connection.id}": ${messageOf(error)}`,
        DBGRAPH_QUERY_FAILED_CODE,
      )
    } finally {
      connection.release()
    }
  }

  /**
   * Read the server version, tolerating a failure: version text is diagnostics, not catalog data.
   * @param connection - the borrowed connection.
   * @param input - the connection being served, for the timeout.
   * @returns the version, or `undefined`.
   */
  private async readVersion(
    connection: PoolConnection,
    input: DialectInput,
  ): Promise<string | undefined> {
    try {
      const [rows] = await connection.query<RowDataPacket[]>({
        sql: SERVER_VERSION_QUERY,
        timeout: statementTimeout(input.queryTimeoutMs),
      })
      return rows.length === 0 ? undefined : asString(rows[0]?.['version'])
    } catch {
      return undefined
    }
  }

  /**
   * Merge L2 facts and samples onto one L1 object.
   * @param connection - the borrowed connection, for enum sampling.
   * @param input - the connection being served.
   * @param object - the L1 object.
   * @param facts - its `TABLES` facts, when the table still exists.
   * @param comments - column comments keyed by table+column.
   * @param uniqueColumns - its singly-unique columns.
   * @param indexEdges - its index edges.
   * @param foreignKeyEdges - its foreign-key edges.
   * @param warnings - collector for tolerated per-object failures.
   * @returns the enriched object, or an L1 copy when enrichment failed.
   */
  private async enrichObject(
    connection: PoolConnection,
    input: DialectInput,
    object: RawObject,
    facts: MysqlTableFacts | undefined,
    comments: ReadonlyMap<string, string>,
    uniqueColumns: ReadonlySet<string> | undefined,
    indexEdges: readonly RawEdge[] | undefined,
    foreignKeyEdges: readonly RawEdge[] | undefined,
    warnings: string[],
  ): Promise<RawObject> {
    try {
      const samples = new Map<string, readonly string[]>()
      for (const column of object.columns) {
        throwIfAborted(input.signal)
        if (!shouldSampleMysqlColumn(object.kind, input.connection, column)) continue
        const sampled = await this.sampleEnumValues(connection, input, object.name, column.name, warnings)
        if (sampled !== undefined) samples.set(column.name, sampled)
      }
      const edges = [...(foreignKeyEdges ?? []), ...(indexEdges ?? [])]
      return mergeMysqlObject(object, facts, comments, uniqueColumns, edges, samples)
    } catch (error) {
      if (error instanceof DbgraphError && error.code === 'DBGRAPH_ABORTED') throw error
      warnings.push(`mysql: enrichment failed for "${object.name}": ${messageOf(error)}`)
      return { ...object, columns: object.columns.map(column => ({ ...column })) }
    }
  }

  /**
   * Sample a bounded set of distinct literals for one string-like column.
   * @param connection - the borrowed connection.
   * @param input - the connection being served.
   * @param table - the table name.
   * @param column - the column name.
   * @param warnings - collector for a sample the server refused.
   * @returns the literals, or `undefined` when sampling was skipped or produced nothing.
   */
  private async sampleEnumValues(
    connection: PoolConnection,
    input: DialectInput,
    table: string,
    column: string,
    warnings: string[],
  ): Promise<readonly string[] | undefined> {
    if (!Number.isFinite(input.enumSampleLimit) || input.enumSampleLimit < 1) return undefined
    const limit = Math.floor(input.enumSampleLimit)
    const database = requireDatabase(input)
    const identifier = mysqlIdentifier(column)
    const sql = `SELECT DISTINCT ${identifier} AS value`
      + ` FROM ${mysqlIdentifier(database)}.${mysqlIdentifier(table)}`
      + ` WHERE ${identifier} IS NOT NULL LIMIT ?`
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        { sql, timeout: statementTimeout(input.queryTimeoutMs) },
        [limit],
      )
      const values: string[] = []
      for (const row of rows) {
        const value = enumText(row['value'])
        if (value !== undefined && !values.includes(value)) values.push(value)
      }
      return values.length === 0 ? undefined : values
    } catch (error) {
      warnings.push(`mysql: enum sampling failed for "${table}.${column}": ${messageOf(error)}`)
      return undefined
    }
  }
}

/**
 * Run one `information_schema` query and return its rows.
 * @param connection - the borrowed connection.
 * @param input - the connection being served, for the timeout.
 * @param sql - the statement.
 * @param values - bound values, in placeholder order.
 * @returns the rows, typed by the caller's chosen row shape.
 */
async function queryRows<T extends object>(
  connection: PoolConnection,
  input: DialectInput,
  sql: string,
  values: readonly unknown[],
): Promise<T[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    { sql, timeout: statementTimeout(input.queryTimeoutMs) },
    values as unknown[],
  )
  return rows as unknown as T[]
}

/**
 * The result column names, in result order.
 * @param fields - the field packets `mysql2` returns beside a result set.
 * @returns column names; an empty list when the driver supplied no fields.
 */
function resultColumns(fields: FieldPacket[] | undefined): string[] {
  return (fields ?? []).map(field => field.name)
}

/**
 * The configured database name for a connection.
 * @param input - the connection.
 * @returns the database name.
 * @throws DbgraphError with `DBGRAPH_UNAVAILABLE` when the connection names no database.
 */
function requireDatabase(input: DialectInput): string {
  const database = input.connection.database
  if (database === undefined || database.trim() === '') {
    throw new DbgraphError(
      `connection "${input.connection.id}" has no MySQL database configured`,
      'DBGRAPH_UNAVAILABLE',
    )
  }
  return database
}

/**
 * A usable statement timeout.
 * @param timeoutMs - the caller's value.
 * @returns a positive whole number of milliseconds.
 */
function statementTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return FALLBACK_TIMEOUT_MS
  return Math.floor(timeoutMs)
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
