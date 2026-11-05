/**
 * `sql` is read-only unless a deployment says otherwise — and never because masking was turned off.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSqliteDialect } from 'dsh-plugin-dbgraph-catalog'
import Dbgraph from '../src/index.ts'
import type {
  DatabaseDialect,
  DbgraphStore,
  RawCatalog,
  SqlResult,
  StoredConnection,
} from '../src/index.ts'

const EMPTY: RawCatalog = { engine: 'mysql', database: 'shop', objects: [], fetchedAt: 0, level: 'l1' }

const SQL_RESULT: SqlResult = {
  columns: [], rows: [], rowCount: 0, truncated: false, redacted: [], elapsedMs: 1,
}

/** A dialect that records the limits each statement was executed with. */
function recordingDialect(readOnly: boolean[]): DatabaseDialect {
  return {
    engine: 'mysql',
    test: () => Promise.resolve({ ok: true, elapsedMs: 1 }),
    fetchL1: () => Promise.resolve(EMPTY),
    fetchL2: (_input, l1) => Promise.resolve({ ...l1, level: 'l2' }),
    execute: (_input, _query, limits) => {
      readOnly.push(limits.readOnly)
      return Promise.resolve(SQL_RESULT)
    },
  }
}

/** A store that serves exactly one connection. */
function storeWith(connection: StoredConnection): DbgraphStore {
  return {
    id: 'stub-store',
    root: '/tmp/dbgraph-readonly',
    connections: () => Promise.resolve([connection]),
    state: () => Promise.resolve({ objects: 0, columns: 0, stale: true }),
    schema: () => Promise.reject(new Error('unused')),
    objects: () => Promise.reject(new Error('unused')),
    columns: () => Promise.reject(new Error('unused')),
    resolve: () => Promise.resolve({ status: 'not_found', reason: 'unused', confidence: 0 }),
    impact: () => Promise.reject(new Error('unused')),
    refs: () => Promise.reject(new Error('unused')),
    write: () => Promise.reject(new Error('unused')),
  }
}

/** Run one `sql` call and report the read-only flag the dialect saw. */
async function sqlReadOnly(connection: StoredConnection, allowWrites = false): Promise<boolean[]> {
  const readOnly: boolean[] = []
  const ctx = new Context()
  await ctx.plugin(Dbgraph, { allowWrites })
  ctx.dbgraph.registerDialect(recordingDialect(readOnly))
  ctx.dbgraph.registerStore(storeWith(connection))
  await ctx.dbgraph.sql({ connection: connection.id, query: 'SELECT 1' })
  return readOnly
}

const HIDDEN_PASSWORD: StoredConnection = { id: 'prod', engine: 'mysql', host: 'db', database: 'shop' }
const SHOWN_PASSWORD: StoredConnection = { ...HIDDEN_PASSWORD, sensitiveColumns: 'show' }

describe('read-only enforcement', () => {
  it('runs a statement read-only by default', async () => {
    await expect(sqlReadOnly(HIDDEN_PASSWORD)).resolves.toEqual([true])
  })

  it('stays read-only when masking is turned off', async () => {
    // The regression: masking was the switch, so `sensitiveColumns: 'show'` also opened the write gate.
    await expect(sqlReadOnly(SHOWN_PASSWORD)).resolves.toEqual([true])
  })

  it('opens the gate only when the deployment opts in', async () => {
    await expect(sqlReadOnly(SHOWN_PASSWORD, true)).resolves.toEqual([false])
  })

  it('keeps find read-only even with allowWrites', async () => {
    const readOnly: boolean[] = []
    const ctx = new Context()
    await ctx.plugin(Dbgraph, { allowWrites: true })
    ctx.dbgraph.registerDialect(recordingDialect(readOnly))
    ctx.dbgraph.registerStore({
      ...storeWith(SHOWN_PASSWORD),
      resolve: () => Promise.resolve({
        status: 'resolved',
        reason: 'stub',
        confidence: 1,
        resolved: {
          object: 'sys_user',
          kind: 'table',
          score: 1,
          columns: [{ column: 'id', matchedBy: 'name', score: 1 }],
        },
        predicate: { clause: '', values: [] },
      }),
    })
    await ctx.dbgraph.find({ connection: 'prod', object: 'sys_user' })
    expect(readOnly).toEqual([true])
  })
})

/**
 * The end-to-end half: a real SQLite file behind the real dialect, so "read-only" and "allowed to
 * write" are decided by the file handle the service actually opened, not by a recording stub.
 */
describe('read-only enforcement against a real SQLite file', () => {
  let directory: string
  let databasePath: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'dbgraph-sql-readonly-'))
    databasePath = join(directory, 'app.db')
    const database = new DatabaseSync(databasePath)
    try {
      database.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
      database.prepare('INSERT INTO notes (id, body) VALUES (?, ?)').run(1, 'hello')
    } finally {
      database.close()
    }
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  /** The one connection every test in this block uses. */
  function connection(): StoredConnection {
    return { id: 'local', engine: 'sqlite', database: databasePath }
  }

  /**
   * Build a context whose dialect is the real SQLite one.
   * @param allowWrites - the plugin's write switch.
   * @returns the plugin context.
   */
  async function sqliteContext(allowWrites: boolean): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(Dbgraph, { allowWrites })
    ctx.dbgraph.registerDialect(createSqliteDialect({ DatabaseSync }))
    ctx.dbgraph.registerStore(storeWith(connection()))
    return ctx
  }

  /**
   * Run one statement that must be refused and report the refusal.
   * @param ctx - the plugin context.
   * @param query - the statement.
   * @returns the error code and message.
   */
  async function refusal(ctx: Context, query: string): Promise<{ code: string; message: string }> {
    try {
      await ctx.dbgraph.sql({ connection: 'local', query })
    } catch (error) {
      const dbgraph = error as { code?: unknown; message?: unknown }
      return {
        code: typeof dbgraph.code === 'string' ? dbgraph.code : '',
        message: typeof dbgraph.message === 'string' ? dbgraph.message : '',
      }
    }
    throw new Error(`the statement should have been refused: ${query}`)
  }

  it('reads the real file through the dialect', async () => {
    const ctx = await sqliteContext(false)
    const result = await ctx.dbgraph.sql({
      connection: 'local',
      query: 'SELECT id, body FROM notes ORDER BY id',
    })
    expect(result.columns).toEqual(['id', 'body'])
    expect(result.rows).toEqual([{ id: 1, body: 'hello' }])
  })

  it('refuses a CREATE TABLE before the engine, leaving the file untouched', async () => {
    const ctx = await sqliteContext(false)
    const refused = await refusal(ctx, 'CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)')
    expect(refused.code).toBe('DBGRAPH_READ_ONLY')
    expect(refused.message).toContain('CREATE')
    const probe = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(probe.prepare("SELECT name FROM sqlite_master WHERE name = 'audit'").all()).toEqual([])
    } finally {
      probe.close()
    }
  })

  it('refuses EXPLAIN ANALYZE, which would execute the update it explains', async () => {
    const ctx = await sqliteContext(false)
    const refused = await refusal(ctx, 'EXPLAIN ANALYZE UPDATE notes SET body = NULL')
    expect(refused.code).toBe('DBGRAPH_READ_ONLY')
    expect(refused.message).toContain('EXPLAIN ANALYZE')
    // Nothing ran: the row is intact.
    const probe = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(probe.prepare('SELECT body FROM notes WHERE id = 1').get()).toMatchObject({ body: 'hello' })
    } finally {
      probe.close()
    }
  })

  it('refuses SELECT ... INTO OUTFILE before the engine', async () => {
    const ctx = await sqliteContext(false)
    const target = join(directory, 'stolen.txt')
    const refused = await refusal(ctx, `SELECT body FROM notes INTO OUTFILE '${target}'`)
    expect(refused.code).toBe('DBGRAPH_READ_ONLY')
    expect(refused.message).toContain('INTO OUTFILE')
  })

  it('writes through the real file when the deployment allows it, and reads the result back', async () => {
    const ctx = await sqliteContext(true)
    const created = await ctx.dbgraph.sql({
      connection: 'local',
      query: 'CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)',
    })
    expect(created.columns).toEqual([])
    const inserted = await ctx.dbgraph.sql({
      connection: 'local',
      query: "INSERT INTO audit (id, note) VALUES (2, 'written')",
    })
    expect(inserted.affectedRows).toBe(1)

    const selected = await ctx.dbgraph.sql({ connection: 'local', query: 'SELECT note FROM audit WHERE id = 2' })
    expect(selected.rows).toEqual([{ note: 'written' }])

    // Independent proof that the write reached the file, not a cached statement somewhere.
    const probe = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(probe.prepare("SELECT name FROM sqlite_master WHERE name = 'audit'").all()).toHaveLength(1)
      expect(probe.prepare('SELECT note FROM audit WHERE id = 2').get()).toMatchObject({ note: 'written' })
    } finally {
      probe.close()
    }
  })
})
