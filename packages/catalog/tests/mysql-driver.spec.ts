import { describe, expect, it } from 'vitest'
import { DbgraphError } from 'dsh-plugin-dbgraph-service'
import type { ConnectionConfig, DialectInput, ExecuteLimits, RawCatalog } from 'dsh-plugin-dbgraph-service'
import { createMysqlDialect, mysqlIdentifier } from '../src/mysql.ts'
import type { MysqlModule } from '../src/mysql.ts'

/**
 * A scripted `mysql2/promise` module, exercised through the dialect's public constructor.
 *
 * The collaboration contract followed here is mysql2's `QueryResult`:
 *
 * - `connection.query(sql, values?)` and `connection.query({ sql, timeout }, values?)` both resolve
 *   to `[rows, fields]`;
 * - `rows` is an array of row objects for a result set, or a `ResultSetHeader` object
 *   (`{ affectedRows, insertId, … }`) for a statement that affected rows instead — the dialect
 *   branches on exactly that `Array.isArray` difference;
 * - `fields` is an array of `FieldPacket` objects (`{ name, type, columnType, … }`) for a result
 *   set, and is treated as absent when the driver supplies none;
 * - `pool.getConnection()` resolves to a pooled connection with `release()`, and `pool.end()`
 *   closes the pool. `createPool(options)` receives mysql2's `PoolOptions`.
 *
 * `mysql.spec.ts` proves against a live server that these shapes are the real ones; this file uses
 * them to reach states a conforming server cannot produce on demand (an empty `SELECT VERSION()`, a
 * table visible with no columns, a driver error mid-catalog).
 */

/** One query answer: `[rows, fields]`, or an error to throw. */
type Outcome = readonly [unknown, unknown] | Error

/** The handler that scripts one `mysql2` pool. */
type QueryScript = (sql: string, values: readonly unknown[] | undefined) => Outcome

/** A connection stub, shaped like `mysql2/promise`'s `PoolConnection` for this dialect. */
class ScriptedConnection {
  released = 0

  private readonly script: QueryScript

  constructor(script: QueryScript) {
    this.script = script
  }

  async query(sqlOrOptions: string | { readonly sql: string }, values?: readonly unknown[]): Promise<readonly [unknown, unknown]> {
    const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql
    const outcome = this.script(sql, values)
    if (outcome instanceof Error) throw outcome
    return outcome
  }

  release(): void {
    this.released += 1
  }
}

/** A pool stub recording the options it was created with and what it handed out. */
class ScriptedPool {
  readonly options: Record<string, unknown>
  readonly connections: ScriptedConnection[] = []
  endCalls = 0

  private readonly script: QueryScript
  private readonly onGetConnection: (() => void) | undefined

  constructor(options: Record<string, unknown>, script: QueryScript, onGetConnection?: () => void) {
    this.options = options
    this.script = script
    this.onGetConnection = onGetConnection
  }

  async getConnection(): Promise<ScriptedConnection> {
    this.onGetConnection?.()
    const connection = new ScriptedConnection(this.script)
    this.connections.push(connection)
    return connection
  }

  async end(): Promise<void> {
    this.endCalls += 1
  }
}

/** A scripted driver module plus the pools it created. */
interface ScriptedDriver {
  readonly module: MysqlModule
  readonly pools: ScriptedPool[]
}

/**
 * Build the scripted driver.
 * @param script - per-query answers.
 * @param onGetConnection - hook run before a connection is handed out (used to abort mid-call).
 * @param getConnectionError - when set, every `getConnection` rejects with it.
 * @returns the module to inject plus its pools.
 */
function scriptedDriver(
  script: QueryScript,
  onGetConnection?: () => void,
  getConnectionError?: Error,
): ScriptedDriver {
  const pools: ScriptedPool[] = []
  const module = {
    createPool(options: Record<string, unknown>): ScriptedPool {
      const pool = new ScriptedPool(options, script, getConnectionError === undefined ? onGetConnection : () => { throw getConnectionError })
      pools.push(pool)
      return pool
    },
  }
  return { module: module as unknown as MysqlModule, pools }
}

const READ_ONLY_LIMITS: ExecuteLimits = { maxRows: 50, timeoutMs: 5_000, readOnly: true }

/**
 * A connection with everything filled in.
 * @returns the connection config.
 */
function fullConnection(): ConnectionConfig {
  return {
    id: 'prod',
    engine: 'mysql',
    host: 'db.internal',
    port: 4406,
    database: 'shop',
    user: 'reader',
  }
}

/**
 * The dialect input for one connection.
 * @param connection - the connection to serve.
 * @param overrides - input fields to replace.
 * @returns the input.
 */
function dialectInput(connection: ConnectionConfig, overrides: Partial<DialectInput> = {}): DialectInput {
  return { connection, enumSampleLimit: 10, queryTimeoutMs: 5_000, ...overrides }
}

/** A minimal L1 object used by the L2 tests. */
const USERS_OBJECT = {
  kind: 'table' as const,
  schema: 'shop',
  name: 'users',
  columns: [
    { name: 'id', ordinal: 1, type: 'bigint' },
    { name: 'status', ordinal: 2, type: 'varchar(16)' },
  ],
}

/**
 * The L1 catalog the L2 tests start from.
 * @param objects - objects to include.
 * @param serverVersion - version to record, when one exists.
 * @returns the catalog.
 */
function l1With(objects: RawCatalog['objects'], serverVersion?: string): RawCatalog {
  return {
    engine: 'mysql',
    ...(serverVersion === undefined ? {} : { serverVersion }),
    database: 'shop',
    objects,
    fetchedAt: 1,
    level: 'l1',
  }
}

describe('mysql dialect — probe', () => {
  it('reports success without a version when SELECT VERSION() returns no row', async () => {
    const driver = scriptedDriver((sql) => (sql.includes('VERSION()') ? [[], []] : [[], []]))
    const dialect = createMysqlDialect(driver.module)

    const probe = await dialect.test(dialectInput(fullConnection()))

    expect(probe.ok).toBe(true)
    expect(probe.serverVersion).toBeUndefined()
    expect(driver.pools[0]?.connections[0]?.released).toBe(1)
    await dialect.close()
  })

  it('reports a version the driver returned in the expected shape', async () => {
    const driver = scriptedDriver(() => [[{ version: '8.4.13' }], []])
    const dialect = createMysqlDialect(driver.module)

    const probe = await dialect.test(dialectInput(fullConnection()))

    expect(probe).toMatchObject({ ok: true, serverVersion: '8.4.13' })
  })

  it('turns a connection failure into a failed probe', async () => {
    const driver = scriptedDriver(() => [[], []], undefined, new Error('connect ECONNREFUSED'))
    const dialect = createMysqlDialect(driver.module)

    const probe = await dialect.test(dialectInput(fullConnection()))

    expect(probe.ok).toBe(false)
    expect(probe.error).toBe('connect ECONNREFUSED')
  })

  it('turns a query failure into a failed probe and still releases the connection', async () => {
    const driver = scriptedDriver(() => new Error('version query refused'))
    const dialect = createMysqlDialect(driver.module)

    const probe = await dialect.test(dialectInput(fullConnection()))

    expect(probe.ok).toBe(false)
    expect(probe.error).toBe('version query refused')
    expect(driver.pools[0]?.connections[0]?.released).toBe(1)
  })
})

describe('mysql dialect — fetchL1', () => {
  it('lists objects and reports one visible without columns', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('VERSION()')) return [[], []]
      if (sql.includes('information_schema.TABLES')) {
        return [[
          { TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE' },
          { TABLE_TYPE: 'VIEW' },
          { TABLE_SCHEMA: 'shop', TABLE_NAME: 'ghost', TABLE_TYPE: 'BASE TABLE' },
        ], []]
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return [[
          { TABLE_NAME: 'orders', COLUMN_NAME: 'id', ORDINAL_POSITION: 1, COLUMN_TYPE: 'bigint', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI' },
        ], []]
      }
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)

    const catalog = await dialect.fetchL1(dialectInput(fullConnection()))

    expect(catalog.engine).toBe('mysql')
    expect(catalog.database).toBe('shop')
    expect(catalog.serverVersion).toBeUndefined()
    expect(catalog.objects.map(object => object.name)).toEqual(['orders', 'ghost'])
    expect(catalog.objects[1]?.columns).toEqual([])
    expect(catalog.warnings).toEqual(['mysql: "ghost" exposed no columns'])
    await dialect.close()
  })

  it('refuses a connection with no database before opening a pool', async () => {
    const driver = scriptedDriver(() => [[], []])
    const dialect = createMysqlDialect(driver.module)

    for (const database of [undefined, '   ']) {
      const connection: ConnectionConfig = { id: 'no-db', engine: 'mysql', ...(database === undefined ? {} : { database }) }
      await expect(dialect.fetchL1(dialectInput(connection))).rejects.toMatchObject({
        code: 'DBGRAPH_UNAVAILABLE',
      })
    }
    expect(driver.pools).toEqual([])
    await dialect.close()
  })

  it('reports a pool that cannot hand out a connection as unavailable', async () => {
    const driver = scriptedDriver(() => [[], []], undefined, new Error('too many connections'))
    const dialect = createMysqlDialect(driver.module)

    await expect(dialect.fetchL1(dialectInput(fullConnection()))).rejects.toMatchObject({
      code: 'DBGRAPH_UNAVAILABLE',
      message: expect.stringContaining('cannot connect to MySQL for connection "prod"'),
    })
    await dialect.close()
  })

  it('aborts before opening anything when the signal is already aborted', async () => {
    const driver = scriptedDriver(() => [[], []])
    const dialect = createMysqlDialect(driver.module)
    const controller = new AbortController()
    controller.abort()

    await expect(dialect.fetchL1(dialectInput(fullConnection(), { signal: controller.signal })))
      .rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
    await expect(dialect.fetchL2(
      dialectInput(fullConnection(), { signal: controller.signal }),
      l1With([]),
    )).rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
    await expect(dialect.execute(
      dialectInput(fullConnection(), { signal: controller.signal }),
      'SELECT 1',
      READ_ONLY_LIMITS,
    )).rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
    expect(driver.pools).toHaveLength(0)
    await dialect.close()
  })

  it('aborts between borrowing a connection and reading', async () => {
    const controller = new AbortController()
    const driver = scriptedDriver(() => [[], []], () => controller.abort())
    const dialect = createMysqlDialect(driver.module)

    await expect(dialect.fetchL1(dialectInput(fullConnection(), { signal: controller.signal })))
      .rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
    await expect(dialect.execute(
      dialectInput(fullConnection(), { signal: controller.signal }),
      'SELECT 1',
      READ_ONLY_LIMITS,
    )).rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
    expect(driver.pools[0]?.connections[0]?.released).toBe(1)
    await dialect.close()
  })

  it('records the server version it read', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('VERSION()')) return [[{ version: '8.0.36' }], []]
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)

    const catalog = await dialect.fetchL1(dialectInput(fullConnection()))

    expect(catalog.serverVersion).toBe('8.0.36')
    expect(catalog.objects).toEqual([])
    await dialect.close()
  })

  it('reads the version tolerantly and keeps going when it fails', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('VERSION()')) return new Error('no privilege on VERSION()')
      if (sql.includes('information_schema.TABLES')) return [[], []]
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)

    const catalog = await dialect.fetchL1(dialectInput(fullConnection()))

    expect(catalog.serverVersion).toBeUndefined()
    expect(catalog.objects).toEqual([])
    await dialect.close()
  })
})

describe('mysql dialect — fetchL2', () => {
  it('merges facts, comments, edges and samples onto each object', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('information_schema.TABLES')) {
        return [[{ TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '账户表', TABLE_ROWS: 42 }], []]
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return [[
          { TABLE_NAME: 'users', COLUMN_NAME: 'status', COLUMN_COMMENT: '状态' },
          { TABLE_NAME: 'users', COLUMN_NAME: 'id', COLUMN_COMMENT: '' },
        ], []]
      }
      if (sql.includes('KEY_COLUMN_USAGE')) {
        return [[
          {
            TABLE_NAME: 'users',
            CONSTRAINT_NAME: 'fk_users_org',
            COLUMN_NAME: 'org_id',
            ORDINAL_POSITION: 1,
            REFERENCED_TABLE_NAME: 'orgs',
            REFERENCED_COLUMN_NAME: 'id',
          },
        ], []]
      }
      if (sql.includes('information_schema.STATISTICS')) {
        return [[
          { TABLE_NAME: 'users', INDEX_NAME: 'idx_status', NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'status' },
        ], []]
      }
      if (sql.includes('SELECT DISTINCT')) {
        return [[{ value: 'active' }, { value: 'active' }, { value: 7 }, { value: 7n }, { value: true }, { value: Buffer.from([0]) }, { value: null }], []]
      }
      if (sql.includes('VERSION()')) return [[], []]
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)
    const l1 = l1With([USERS_OBJECT], '8.0.36')

    const catalog = await dialect.fetchL2(dialectInput(fullConnection()), l1)

    const users = catalog.objects[0]
    expect(users?.comment).toBe('账户表')
    expect(users?.rowEstimate).toBe(42)
    expect(users?.columns[0]).toMatchObject({ name: 'id', isUnique: false })
    expect(users?.columns[1]).toMatchObject({ name: 'status', comment: '状态', isUnique: false })
    expect([...(users?.columns[1]?.enumValues ?? [])]).toEqual(['active', '7', 'true'])
    expect(users?.edges?.map(edge => edge.kind).sort()).toEqual(['fk', 'index'])
    expect(catalog.serverVersion).toBe('8.0.36')
    expect(catalog.warnings).toBeUndefined()
    await dialect.close()
  })

  it('keeps an object at L1 shape when its columns are not the shape this build writes', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[], []]
      if (sql.includes('information_schema.COLUMNS')) return [[], []]
      if (sql.includes('KEY_COLUMN_USAGE')) return [[], []]
      if (sql.includes('information_schema.STATISTICS')) return [[], []]
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)
    // A catalog this build did not write: one column's declared type is not text. Enrichment must
    // tolerate that per object rather than losing the whole L2 pass.
    const malformed = {
      kind: 'table' as const,
      schema: 'shop',
      name: 'legacy',
      columns: [{ name: 'c', ordinal: 1, type: 42 }],
    } as unknown as RawCatalog['objects'][number]
    const l1 = l1With([malformed, USERS_OBJECT])

    const catalog = await dialect.fetchL2(dialectInput(fullConnection()), l1)

    expect(catalog.warnings).toEqual([
      expect.stringContaining('mysql: enrichment failed for "legacy":'),
    ])
    expect(catalog.objects[0]?.edges).toBeUndefined()
    expect(catalog.objects[0]?.columns.map(column => 'isUnique' in column)).toEqual([false])
    // The other object was still enriched.
    expect(catalog.objects[1]?.columns.every(column => 'isUnique' in column)).toBe(true)
    await dialect.close()
  })

  it('reports a per-column sampling failure as a warning and keeps the column', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[], []]
      if (sql.includes('information_schema.COLUMNS')) return [[], []]
      if (sql.includes('KEY_COLUMN_USAGE')) return [[], []]
      if (sql.includes('information_schema.STATISTICS')) return [[], []]
      if (sql.includes('SELECT DISTINCT')) return new Error('sampling refused')
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)

    const catalog = await dialect.fetchL2(dialectInput(fullConnection()), l1With([USERS_OBJECT]))

    expect(catalog.warnings).toEqual([
      expect.stringContaining('mysql: enum sampling failed for "users.status": sampling refused'),
    ])
    expect(catalog.objects[0]?.columns[1]).not.toHaveProperty('enumValues')
    expect(catalog.objects[0]?.columns[1]?.isUnique).toBe(false)
    await dialect.close()
  })

  it('samples nothing when the limit is not a usable number', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('SELECT DISTINCT')) return [[{ value: 'active' }], []]
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)

    const catalog = await dialect.fetchL2(
      dialectInput(fullConnection(), { enumSampleLimit: 0 }),
      l1With([USERS_OBJECT]),
    )

    expect(catalog.objects[0]?.columns[1]).not.toHaveProperty('enumValues')
    await dialect.close()
  })

  it('aborts while walking columns', async () => {
    const controller = new AbortController()
    let sampled = 0
    const driver = scriptedDriver((sql) => {
      if (sql.includes('SELECT DISTINCT')) {
        sampled += 1
        controller.abort()
        return [[{ value: 'x' }], []]
      }
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)
    const wide = {
      kind: 'table' as const,
      schema: 'shop',
      name: 'users',
      columns: [
        { name: 'id', ordinal: 1, type: 'bigint' },
        { name: 'secret_thing', ordinal: 2, type: 'varchar(8)' },
        { name: 'status', ordinal: 3, type: 'varchar(16)' },
        { name: 'after_status', ordinal: 4, type: 'varchar(16)' },
      ],
    }

    // The abort fires during the first sample; the next column's pre-check is where it surfaces.
    await expect(dialect.fetchL2(
      dialectInput(fullConnection(), { signal: controller.signal }),
      l1With([wide]),
    )).rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
    expect(sampled).toBe(1)
    await dialect.close()
  })

  it('drops a TABLE fact row the driver returned without a name', async () => {
    const driver = scriptedDriver((sql) => {
      if (sql.includes('information_schema.TABLES')) {
        return [[
          { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '账户表', TABLE_ROWS: 2 },
          { TABLE_TYPE: 'BASE TABLE' },
        ], []]
      }
      return [[], []]
    })
    const dialect = createMysqlDialect(driver.module)

    const catalog = await dialect.fetchL2(dialectInput(fullConnection()), l1With([USERS_OBJECT]))

    expect(catalog.objects[0]?.comment).toBe('账户表')
    expect(catalog.objects[0]?.rowEstimate).toBe(2)
    await dialect.close()
  })

  it('reports L2 without a version when L1 carried none', async () => {
    const driver = scriptedDriver(() => [[], []])
    const dialect = createMysqlDialect(driver.module)

    const catalog = await dialect.fetchL2(dialectInput(fullConnection()), l1With([]))

    expect(catalog.serverVersion).toBeUndefined()
    await dialect.close()
  })
})

describe('mysql dialect — execute', () => {
  it('reports affected rows for a statement that returns no result set', async () => {
    const seen: (readonly unknown[] | undefined)[] = []
    const driver = scriptedDriver((_sql, values) => {
      seen.push(values)
      return [{ affectedRows: 3, insertId: 0 }, undefined]
    })
    const dialect = createMysqlDialect(driver.module)

    const result = await dialect.execute(
      dialectInput(fullConnection()),
      'UPDATE users SET status = ? WHERE id = ?',
      { ...READ_ONLY_LIMITS, readOnly: false },
      ['disabled', 7],
    )

    expect(result.columns).toEqual([])
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(0)
    expect(result.affectedRows).toBe(3)
    expect(result.truncated).toBe(false)
    expect(seen).toEqual([['disabled', 7]])
    await dialect.close()
  })

  it('returns the result rows with no field packets, using the driver row keys', async () => {
    const driver = scriptedDriver(() => [[{ one: 1 }], undefined])
    const dialect = createMysqlDialect(driver.module)

    const result = await dialect.execute(
      dialectInput(fullConnection()),
      'SELECT 1 AS one',
      READ_ONLY_LIMITS,
      undefined,
    )

    expect(result.columns).toEqual([])
    expect(result.rows).toEqual([{}])
    expect(result.rowCount).toBe(1)
    expect(result.truncated).toBe(false)
    await dialect.close()
  })

  it('truncates at maxRows and masks sensitive columns', async () => {
    const driver = scriptedDriver(() => [[
      { password: 's3cret', id: 1 },
      { password: 'hunter2', id: 2 },
    ], [{ name: 'password' }, { name: 'id' }]])
    const dialect = createMysqlDialect(driver.module)

    const result = await dialect.execute(
      dialectInput(fullConnection()),
      'SELECT password, id FROM users',
      { ...READ_ONLY_LIMITS, maxRows: 1 },
    )

    expect(result.redacted).toEqual(['password'])
    expect(result.rows).toEqual([{ password: '[REDACTED]', id: 1 }])
    expect(result.truncated).toBe(true)
    await dialect.close()
  })

  it('falls back to a default statement timeout for an unusable value', async () => {
    const driver = scriptedDriver(() => [[], []])
    const dialect = createMysqlDialect(driver.module)

    await dialect.execute(
      dialectInput({ ...fullConnection(), id: 'timeout-default' }, { queryTimeoutMs: 0 }),
      'SELECT 1',
      { maxRows: 1, timeoutMs: Number.NaN, readOnly: true },
    )

    // connectTimeout is built by the same helper as the per-statement timeout.
    expect(driver.pools[0]?.options['connectTimeout']).toBe(10_000)
    await dialect.close()
  })
})

describe('mysql dialect — connection and pool lifecycle', () => {
  it('fills pool defaults and forwards an explicit target plus credentials', async () => {
    const driver = scriptedDriver(() => [[], []])
    const dialect = createMysqlDialect(driver.module)

    await dialect.fetchL1(dialectInput({ id: 'prod', engine: 'mysql', database: 'shop' }))
    const defaults = driver.pools[0]?.options
    expect(defaults).toMatchObject({
      host: '127.0.0.1',
      port: 3306,
      database: 'shop',
      waitForConnections: true,
      charset: 'utf8mb4',
    })
    expect(defaults !== undefined && 'user' in defaults).toBe(false)
    expect(defaults !== undefined && 'password' in defaults).toBe(false)

    // The same connection id now names a different target: the old pool must be closed, not reused.
    await dialect.fetchL1(dialectInput({ ...fullConnection(), id: 'prod' }, { password: 'pa55' }))
    expect(driver.pools).toHaveLength(2)
    expect(driver.pools[0]?.endCalls).toBe(1)
    expect(driver.pools[1]?.options).toMatchObject({
      host: 'db.internal',
      port: 4406,
      user: 'reader',
      password: 'pa55',
    })

    await dialect.close()
    expect(driver.pools[1]?.endCalls).toBe(1)
  })

  it('wraps a driver failure as a query failure and releases the connection', async () => {
    const driver = scriptedDriver(() => new Error('ER_BAD_FIELD_ERROR'))
    const dialect = createMysqlDialect(driver.module)

    await expect(dialect.execute(
      dialectInput(fullConnection()),
      'SELECT nope FROM users',
      READ_ONLY_LIMITS,
    )).rejects.toMatchObject({
      code: 'DBGRAPH_QUERY_FAILED',
      message: expect.stringContaining('MySQL statement failed on connection "prod": ER_BAD_FIELD_ERROR'),
    })
    expect(driver.pools[0]?.connections[0]?.released).toBe(1)
    await dialect.close()
  })

  it('preserves a DbgraphError the driver already raised', async () => {
    const original = new DbgraphError('driver refused', 'DBGRAPH_QUERY_FAILED')
    const driver = scriptedDriver(() => original)
    const dialect = createMysqlDialect(driver.module)

    await expect(dialect.execute(
      dialectInput(fullConnection()),
      'SELECT 1',
      READ_ONLY_LIMITS,
    )).rejects.toBe(original)
    await dialect.close()
  })

  it('refuses a statement the read-only gate rejects before reaching the pool', async () => {
    const driver = scriptedDriver(() => [[], []])
    const dialect = createMysqlDialect(driver.module)

    await expect(dialect.execute(
      dialectInput(fullConnection()),
      'DELETE FROM users',
      READ_ONLY_LIMITS,
    )).rejects.toMatchObject({ code: 'DBGRAPH_READ_ONLY' })
    expect(driver.pools).toHaveLength(0)
    await dialect.close()
  })
})

describe('mysqlIdentifier', () => {
  it('doubles a backtick so a quoted identifier cannot break out', () => {
    expect(mysqlIdentifier('users')).toBe('`users`')
    expect(mysqlIdentifier('we`ird')).toBe('`we``ird`')
  })
})
