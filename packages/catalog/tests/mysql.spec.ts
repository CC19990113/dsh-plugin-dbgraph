import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionConfig, DialectInput, RawCatalog, RawObject } from 'dsh-plugin-dbgraph-service'
import { createMysqlDialect, loadMysqlDriver } from '../src/mysql.ts'
import type { ManagedDialect } from '../src/support.ts'
import { DBGRAPH_QUERY_FAILED_CODE, DBGRAPH_READ_ONLY_CODE, REDACTED_VALUE } from '../src/support.ts'

/**
 * Live MySQL coverage is opt-in through `DSH_DBGRAPH_TEST_MYSQL_DSN`, e.g.
 * `mysql://user:pass@127.0.0.1:3306/some_db`. Without it the suite is skipped: a mocked driver
 * would prove this package can call itself, not that it can read MySQL's catalog. That is why this
 * file stays the plain-language proof of the real protocol, while `mysql-driver.spec.ts` scripts
 * mysql2's documented `QueryResult` shapes for the states a live server cannot be asked to produce
 * (an empty `SELECT VERSION()`, a table visible with no columns, a driver failure mid-catalog).
 */
const DSN = process.env['DSH_DBGRAPH_TEST_MYSQL_DSN']
const describeLive = DSN === undefined ? describe.skip : describe

/**
 * Split a MySQL DSN into a connection plus its password.
 * @param dsn - the `mysql://` URL.
 * @returns the connection configuration and the password, when the DSN carries one.
 */
function parseDsn(dsn: string): { connection: ConnectionConfig; password?: string } {
  const url = new URL(dsn)
  if (url.protocol !== 'mysql:') {
    throw new Error(`DSH_DBGRAPH_TEST_MYSQL_DSN must use the mysql:// scheme, got "${url.protocol}"`)
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (database === '') {
    throw new Error('DSH_DBGRAPH_TEST_MYSQL_DSN must name a database in its path')
  }
  const connection: ConnectionConfig = {
    id: 'mysql-live',
    engine: 'mysql',
    host: url.hostname,
    port: url.port === '' ? 3306 : Number(url.port),
    database,
    ...(url.username === '' ? {} : { user: decodeURIComponent(url.username) }),
  }
  return {
    connection,
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
  }
}


/**
 * The fixture schema. Recreated per run: it is what makes L1/L2 assertions about foreign keys,
 * indexes, comments and enum samples meaningful rather than "whatever the server had".
 */
const WRITABLE_LIMITS = { maxRows: 1, timeoutMs: 30_000, readOnly: false } as const

const FIXTURE_STATEMENTS: readonly string[] = [
  'DROP VIEW IF EXISTS v_users',
  'DROP TABLE IF EXISTS order_items',
  'DROP TABLE IF EXISTS orders',
  'DROP TABLE IF EXISTS accounts',
  'DROP TABLE IF EXISTS api_keys',
  'DROP TABLE IF EXISTS users',
  `CREATE TABLE users (
    id BIGINT PRIMARY KEY,
    name VARCHAR(64) NOT NULL COMMENT '姓名',
    password VARCHAR(64),
    status ENUM('active','disabled'),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) COMMENT='账户表'`,
  `CREATE TABLE orders (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    status VARCHAR(16),
    CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
  )`,
  `CREATE TABLE accounts (
    id BIGINT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    tenant VARCHAR(16) NOT NULL,
    UNIQUE KEY uq_accounts_email (email),
    UNIQUE KEY uq_accounts_tenant_email (tenant, email),
    KEY idx_accounts_lower_email ((lower(email)))
  )`,
  'CREATE TABLE api_keys (id BIGINT PRIMARY KEY, token VARCHAR(64), label VARCHAR(32))',
  'CREATE VIEW v_users AS SELECT id, name FROM users',
  `INSERT INTO users (id, name, password, status) VALUES
    (1, 'alice', 's3cret', 'active'),
    (2, 'bob', 'hunter2', 'disabled')`,
  `INSERT INTO orders (id, user_id, amount, status) VALUES
    (10, 1, 99.5, 'paid'),
    (11, 2, 10, 'pending')`,
  `INSERT INTO accounts (id, email, tenant) VALUES
    (1, 'a@example.com', 't1'),
    (2, 'b@example.com', 't2')`,
  `INSERT INTO api_keys (id, token, label) VALUES
    (1, 'tok_live_1', 'primary'),
    (2, 'tok_live_2', 'backup')`,
]

describeLive('mysql dialect against a live server', () => {
  let dialect: ManagedDialect
  let input: DialectInput
  let l1: RawCatalog

  beforeAll(async () => {
    if (DSN === undefined) throw new Error('unreachable: the suite is skipped without a DSN')
    const parsed = parseDsn(DSN)
    dialect = createMysqlDialect(await loadMysqlDriver())
    input = {
      connection: parsed.connection,
      ...(parsed.password === undefined ? {} : { password: parsed.password }),
      enumSampleLimit: 10,
      queryTimeoutMs: 15_000,
    }
    for (const statement of FIXTURE_STATEMENTS) {
      await dialect.execute(input, statement, WRITABLE_LIMITS)
    }
    l1 = await dialect.fetchL1(input)
  })

  afterAll(async () => {
    await dialect.close()
  })

  /**
   * Locate one object in a catalog.
   * @param catalog - the catalog to search.
   * @param name - the object name.
   * @returns the object.
   */
  function objectNamed(catalog: RawCatalog, name: string): RawObject {
    const found = catalog.objects.find(object => object.name === name)
    if (found === undefined) throw new Error(`catalog has no object named "${name}"`)
    return found
  }

  it('answers a round-trip probe with the server version', async () => {
    const probe = await dialect.test(input)
    expect(probe.ok).toBe(true)
    expect(typeof probe.serverVersion).toBe('string')
    expect(probe.serverVersion?.length).toBeGreaterThan(0)
  })

  it('reads a structural snapshot from information_schema', () => {
    expect(l1.engine).toBe('mysql')
    expect(l1.level).toBe('l1')
    expect(l1.database).toBe(input.connection.database)
    for (const object of l1.objects) {
      expect(typeof object.name).toBe('string')
      expect(Array.isArray(object.columns)).toBe(true)
      expect(object.kind === 'table' || object.kind === 'view').toBe(true)
    }
  })

  it('enriches the snapshot without changing its object set', async () => {
    const l2 = await dialect.fetchL2(input, l1)
    expect(l2.level).toBe('l2')
    expect(l2.objects.map(object => object.name)).toEqual(l1.objects.map(object => object.name))
  })

  it('executes a read and reports its rows', async () => {
    const result = await dialect.execute(input, 'SELECT 1 AS one', {
      maxRows: 10,
      timeoutMs: 15_000,
      readOnly: true,
    })
    expect(result.columns).toEqual(['one'])
    expect(result.rows).toEqual([{ one: 1 }])
    expect(result.rowCount).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('truncates a result at the row cap', async () => {
    const result = await dialect.execute(input, 'SELECT 1 AS one UNION ALL SELECT 2 AS one', {
      maxRows: 1,
      timeoutMs: 15_000,
      readOnly: true,
    })
    expect(result.rowCount).toBe(1)
    expect(result.truncated).toBe(true)
  })

  it('refuses a write before it reaches the server', async () => {
    try {
      await dialect.execute(input, 'CREATE TEMPORARY TABLE dbgraph_refused (id INT)', {
        maxRows: 1,
        timeoutMs: 15_000,
        readOnly: true,
      })
      expect.unreachable('the write should have been refused')
    } catch (error) {
      expect((error as { code?: string }).code).toBe(DBGRAPH_READ_ONLY_CODE)
    }
  })

  it('binds positional parameters in order', async () => {
    const result = await dialect.execute(
      input,
      'SELECT ? AS word, ? AS n',
      { maxRows: 10, timeoutMs: 15_000, readOnly: true },
      ['张三', 7],
    )
    expect(result.columns).toEqual(['word', 'n'])
    expect(result.rows).toEqual([{ word: '张三', n: 7 }])
  })

  it('binds a WHERE placeholder instead of turning the predicate into NULL', async () => {
    const limits = { maxRows: 10, timeoutMs: 15_000, readOnly: true }
    const bound = await dialect.execute(input, 'SELECT ? AS value FROM DUAL WHERE ? = ?', limits, ['ok', 'x', 'x'])
    expect(bound.rows).toEqual([{ value: 'ok' }])

    // The same statement with mismatched values proves the parameters are what the predicate sees.
    const unbound = await dialect.execute(input, 'SELECT ? AS value FROM DUAL WHERE ? = ?', limits, ['ok', 'x', 'y'])
    expect(unbound.rows).toEqual([])
  })

  it('refuses a write that carries parameters', async () => {
    try {
      await dialect.execute(
        input,
        'CREATE TEMPORARY TABLE dbgraph_refused (id INT)',
        { maxRows: 1, timeoutMs: 15_000, readOnly: true },
        [],
      )
      expect.unreachable('the write should have been refused')
    } catch (error) {
      expect((error as { code?: string }).code).toBe(DBGRAPH_READ_ONLY_CODE)
    }
  })

  it('lists the fixture tables and the view with their declared columns', () => {
    expect(l1.objects.map(object => object.name)).toEqual(
      expect.arrayContaining(['accounts', 'api_keys', 'orders', 'users', 'v_users']),
    )
    expect(objectNamed(l1, 'users').kind).toBe('table')
    expect(objectNamed(l1, 'v_users').kind).toBe('view')
    expect(objectNamed(l1, 'users').columns.map(column => column.name)).toEqual([
      'id',
      'name',
      'password',
      'status',
      'created_at',
    ])
    const status = objectNamed(l1, 'users').columns.find(column => column.name === 'status')
    expect(status).toMatchObject({ nullable: true, isPrimaryKey: false })
    // L1 is structure only: comments and edges belong to L2.
    expect('comment' in objectNamed(l1, 'users')).toBe(false)
    expect(objectNamed(l1, 'orders').edges).toBeUndefined()
  })

  it('enriches comments, foreign keys, indexes and enum samples', async () => {
    const l2 = await dialect.fetchL2(input, l1)
    const users = objectNamed(l2, 'users')
    expect(users.comment).toBe('账户表')
    expect(users.columns.find(column => column.name === 'name')?.comment).toBe('姓名')
    expect([...(users.columns.find(column => column.name === 'status')?.enumValues ?? [])].sort())
      .toEqual(['active', 'disabled'])
    // A sensitive column is never sampled.
    expect(users.columns.find(column => column.name === 'password')).not.toHaveProperty('enumValues')

    const orders = objectNamed(l2, 'orders')
    const foreignKeys = (orders.edges ?? []).filter(edge => edge.kind === 'fk')
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]).toMatchObject({
      kind: 'fk',
      name: 'fk_orders_user',
      columns: ['user_id'],
      refObject: 'users',
      refColumns: ['id'],
    })

    const accounts = objectNamed(l2, 'accounts')
    const indexNames = (accounts.edges ?? []).map(edge => edge.name).sort()
    // The functional index has no column names, so no edge is recorded for it.
    expect(indexNames).toEqual(['PRIMARY', 'uq_accounts_email', 'uq_accounts_tenant_email'])
    expect(accounts.columns.find(column => column.name === 'email')?.isUnique).toBe(true)
    expect(accounts.columns.find(column => column.name === 'tenant')?.isUnique).toBe(false)

    // The synthetic VIEW marker is not a description.
    expect('comment' in objectNamed(l2, 'v_users')).toBe(false)
  })

  it('samples no literals when the limit is not a usable number', async () => {
    const limited = await dialect.fetchL2({ ...input, enumSampleLimit: 0 }, l1)
    const status = objectNamed(limited, 'users').columns.find(column => column.name === 'status')
    expect(status).not.toHaveProperty('enumValues')
    // Enrichment still ran.
    expect(objectNamed(limited, 'orders').edges?.length).toBeGreaterThan(0)
  })

  it('executes a write and reports affected rows', async () => {
    const inserted = await dialect.execute(
      input,
      "INSERT INTO api_keys (id, token, label) VALUES (3, 'tok_live_3', 'temp')",
      WRITABLE_LIMITS,
    )
    expect(inserted.affectedRows).toBe(1)
    expect(inserted.rows).toEqual([])
    expect(inserted.columns).toEqual([])

    const deleted = await dialect.execute(
      input,
      'DELETE FROM api_keys WHERE id = 3',
      WRITABLE_LIMITS,
    )
    expect(deleted.affectedRows).toBe(1)
  })

  it('masks a sensitive column and names it in redacted', async () => {
    const result = await dialect.execute(
      input,
      'SELECT id, password FROM users ORDER BY id',
      { maxRows: 10, timeoutMs: 15_000, readOnly: true },
    )
    expect(result.redacted).toEqual(['password'])
    expect(result.rows.map(row => row['password'])).toEqual([REDACTED_VALUE, REDACTED_VALUE])
    expect(result.rowCount).toBe(2)
  })

  it('reports a bad statement as a query failure', async () => {
    try {
      await dialect.execute(input, 'SELECT * FROM no_such_table', {
        maxRows: 1,
        timeoutMs: 15_000,
        readOnly: true,
      })
      expect.unreachable('the statement should have failed')
    } catch (error) {
      expect((error as { code?: string }).code).toBe(DBGRAPH_QUERY_FAILED_CODE)
    }
  })

  it('honours an abort signal before touching the server', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(dialect.fetchL2(
      { ...input, signal: controller.signal },
      l1,
    )).rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
    await expect(dialect.execute(
      { ...input, signal: controller.signal },
      'SELECT 1',
      { maxRows: 1, timeoutMs: 15_000, readOnly: true },
    )).rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
  })

  it('refuses a connection with no database', async () => {
    const noDatabase: DialectInput = {
      ...input,
      connection: { id: 'mysql-no-db', engine: 'mysql' },
    }
    await expect(dialect.fetchL1(noDatabase)).rejects.toMatchObject({ code: 'DBGRAPH_UNAVAILABLE' })
    await expect(dialect.fetchL2(noDatabase, l1)).rejects.toMatchObject({ code: 'DBGRAPH_UNAVAILABLE' })
  })

  it('still executes when the stated timeout is not a usable number', async () => {
    const result = await dialect.execute(input, 'SELECT 1 AS one', {
      maxRows: 1,
      timeoutMs: 0,
      readOnly: true,
    })
    expect(result.rows).toEqual([{ one: 1 }])
  })

  it('reports a failed probe instead of throwing when the server is unreachable', async () => {
    const database = input.connection.database
    if (database === undefined) throw new Error('the DSN must name a database')
    const unreachable: DialectInput = {
      ...input,
      connection: {
        id: 'mysql-unreachable',
        engine: 'mysql',
        host: '127.0.0.1',
        port: 3399,
        database,
      },
      queryTimeoutMs: 1_000,
    }
    const probe = await dialect.test(unreachable)
    expect(probe.ok).toBe(false)
    expect(typeof probe.error).toBe('string')
  })
})

