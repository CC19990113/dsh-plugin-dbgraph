import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionConfig, DialectInput, RawCatalog } from 'dsh-plugin-dbgraph-service'
import { createMysqlDialect, loadMysqlDriver } from '../src/mysql.ts'
import type { ManagedDialect } from '../src/support.ts'
import { DBGRAPH_READ_ONLY_CODE } from '../src/support.ts'

/**
 * Live MySQL coverage is opt-in through `DSH_DBGRAPH_TEST_MYSQL_DSN`, e.g.
 * `mysql://user:pass@127.0.0.1:3306/some_db`. Without it the suite is skipped — never faked: a
 * mocked driver would prove this package can call itself, not that it can read MySQL's catalog.
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
    l1 = await dialect.fetchL1(input)
  })

  afterAll(async () => {
    await dialect.close()
  })

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
})
