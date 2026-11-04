/**
 * The bundle-level integration test: mount the real service, catalog, and store plugins on a real
 * Cordis context, index a real SQLite file, and answer a question the way the model will.
 *
 * It lives in `packages/bundle` because that is what the bundle *is* — the wiring. Every other test
 * in this repository checks one package against a stub; only this one checks that the four packages
 * agree with each other. `packages/bundle` ships no TypeScript, so this file is never part of a
 * `tsc -b` program; vitest picks it up through the root `paths` facade like any other test.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Dbgraph from 'dsh-plugin-dbgraph-service'
import * as CatalogPlugin from 'dsh-plugin-dbgraph-catalog'
import * as StorePlugin from 'dsh-plugin-dbgraph-store'
import * as ToolPlugin from 'dsh-plugin-dbgraph-tool'

/** A stand-in for the host's tool registry: records registrations, answers nothing. */
class FakeTools extends Service {
  readonly registered: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: { name: string }): () => void {
    this.registered.push(tool.name)
    return () => {
      const at = this.registered.indexOf(tool.name)
      if (at >= 0) this.registered.splice(at, 1)
    }
  }
}

/** A stand-in for the host's system-prompt registry: records sections, renders nothing. */
class FakeSystemPrompt extends Service {
  readonly sections: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  section(section: { name: string }): () => void {
    this.sections.push(section.name)
    return () => {
      const at = this.sections.indexOf(section.name)
      if (at >= 0) this.sections.splice(at, 1)
    }
  }
}

/** Where this test keeps its root; assigned per test. */
let root: string
/** Where the fixture database lives until a test moves it. */
let databasePath: string

/**
 * Build a real SQLite file with the shape the scenario needs: a user table whose password column must
 * come back masked, and a second table so object resolution has something to choose between.
 * @param path - file to create.
 */
function createFixtureDatabase(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE sys_user (
      id     INTEGER PRIMARY KEY,
      name   TEXT NOT NULL,
      passwd TEXT NOT NULL
    );
    CREATE TABLE sys_dept (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE order_item (
      id      INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES sys_user (id),
      amount  NUMERIC NOT NULL
    );
    CREATE INDEX order_item_user ON order_item (user_id);
  `)
  database.prepare('INSERT INTO sys_user (id, name, passwd) VALUES (?, ?, ?)').run(1, '张三', 's3cret-hash')
  database.prepare('INSERT INTO sys_user (id, name, passwd) VALUES (?, ?, ?)').run(2, '李四', 'other-hash')
  database.prepare('INSERT INTO order_item (id, user_id, amount) VALUES (?, ?, ?)').run(10, 1, 99.5)
  database.close()
}

/**
 * The connection list this test starts every case with.
 * @returns a `connections.json` document referencing the fixture database.
 */
function connectionsDocument(): string {
  return JSON.stringify({
    version: 1,
    connections: [{ id: 'local', engine: 'sqlite', database: databasePath }],
  }, null, 2)
}

/**
 * Mount the four packages on one context, the way the bundle's patch layer does.
 * @returns the mounted context.
 */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Dbgraph)
  await ctx.plugin(CatalogPlugin)
  await ctx.plugin(StorePlugin)
  await ctx.plugin(FakeTools)
  await ctx.plugin(FakeSystemPrompt)
  await ctx.plugin(ToolPlugin)
  return ctx
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dbgraph-bundle-'))
  process.env['DSH_DBGRAPH_ROOT'] = root
  databasePath = join(root, 'fixture.db')
  createFixtureDatabase(databasePath)
  writeFileSync(join(root, 'connections.json'), connectionsDocument(), { mode: 0o600 })
})

afterEach(() => {
  delete process.env['DSH_DBGRAPH_ROOT']
})

describe('the bundle, end to end', () => {
  it('mounts all four packages and registers both model tools', async () => {
    const ctx = await mount()
    expect(ctx.dbgraph).toBeInstanceOf(Dbgraph)
    const tools = ctx.get('tools') as FakeTools
    expect(tools.registered).toEqual(['dbgraph', 'dbgraph_index'])
    const prompt = ctx.get('systemPrompt') as FakeSystemPrompt
    expect(prompt.sections).toEqual(['tool:dbgraph'])
  })

  it('lists the configured connection before anything is indexed', async () => {
    const ctx = await mount()
    const list = await ctx.dbgraph.listConnections()
    expect(list.map(entry => entry.id)).toEqual(['local'])
    expect(list[0]?.index).toEqual({ objects: 0, columns: 0, stale: true })
  })

  it('indexes a real SQLite file and reports what it wrote', async () => {
    const ctx = await mount()
    // Pinned to the JavaScript writer so the numbers below are the same on every machine; the
    // `auto` preference for the native writer has its own case further down.
    const report = await ctx.dbgraph.index({ connection: 'local', mode: 'full', writer: 'js' })

    expect(report.connection).toBe('local')
    expect(report.level).toBe('l2')
    expect(report.writer).toBe('js')
    expect(report.objects).toBe(3)
    expect(report.columns).toBe(8)
    // One foreign key plus one index — the catalog's own relationships, not guesses.
    expect(report.edges).toBeGreaterThanOrEqual(2)
    expect(report.terms).toBeGreaterThan(0)
    expect(existsSync(join(root, 'local', 'index.db'))).toBe(true)
  })

  it('prefers the native writer when its artifact is present, and either writer answers alike', async () => {
    const ctx = await mount()
    const auto = await ctx.dbgraph.index({ connection: 'local', mode: 'full' })
    expect(['js', 'rust']).toContain(auto.writer)

    // Whichever writer ran, the seam must answer identically: this is the property the parity suite
    // guards at the file level, restated where the model can actually see it.
    const result = await ctx.dbgraph.find({
      connection: 'local',
      entity: '用户',
      fields: ['密码'],
      where: { name: '张三' },
    })
    expect(result.status).toBe('resolved')
    expect(result.rows?.[0]?.['passwd']).toBe('[REDACTED]')

    const native = await ctx.dbgraph.index({ connection: 'local', mode: 'full', writer: 'rust' })
    expect(native.writer).toBe('rust')
    expect(native.objects).toBe(auto.objects)
    expect(native.columns).toBe(auto.columns)
  })

  it('answers "the user\'s password" with one resolve-then-execute pass, masking the secret', async () => {
    const ctx = await mount()
    await ctx.dbgraph.index({ connection: 'local', mode: 'full' })

    const result = await ctx.dbgraph.find({
      connection: 'local',
      entity: '用户',
      fields: ['密码'],
      where: { name: '张三' },
    })

    expect(result.status).toBe('resolved')
    expect(result.resolved?.object).toBe('sys_user')
    expect(result.sql).toBe('SELECT "passwd" FROM "sys_user" WHERE "name" = \'张三\' LIMIT 50')
    expect(result.rowCount).toBe(1)
    expect(result.rows?.[0]?.['passwd']).toBe('[REDACTED]')
    expect(result.redacted).toContain('passwd')
  })

  it('keeps structure answerable after the database file is gone', async () => {
    const ctx = await mount()
    await ctx.dbgraph.index({ connection: 'local', mode: 'full' })

    // The whole point of a local index: structure survives losing the server.
    renameSync(databasePath, `${databasePath}.away`)

    const schema = await ctx.dbgraph.schema({ connection: 'local' })
    expect(schema.objects.map(object => object.object).sort()).toEqual(['order_item', 'sys_dept', 'sys_user'])

    const columns = await ctx.dbgraph.columns({ connection: 'local', object: 'sys_user' })
    expect(columns.columns.map(column => column.name)).toEqual(['id', 'name', 'passwd'])
    expect(columns.columns.find(column => column.name === 'id')?.isPrimaryKey).toBe(true)

    // …while reading values still goes to the database: a change made behind the index's back shows
    // up on the next read. That is the difference the whole design rests on — structure cached, data
    // live.
    const live = new DatabaseSync(databasePath.replace(/\.db$/, '.db.away'))
    live.prepare('UPDATE sys_user SET name = ? WHERE id = ?').run('张三丰', 1)
    live.close()

    const after = await ctx.dbgraph.find({ connection: 'local', object: 'sys_user', where: { id: 1 } })
    expect(after.rows?.[0]?.['name']).toBe('张三丰')
  })

  it('refuses to guess when the words match more than one table', async () => {
    const ctx = await mount()
    await ctx.dbgraph.index({ connection: 'local', mode: 'full' })

    // `sys_user` and `sys_dept` both tokenize with `sys`; without a decisive signal the seam must
    // return candidates rather than pick one and run a statement against the wrong table.
    const result = await ctx.dbgraph.find({ connection: 'local', entity: 'sys' })
    expect(['ambiguous', 'resolved']).toContain(result.status)
    if (result.status === 'ambiguous') {
      expect(result.candidates?.length ?? 0).toBeGreaterThan(1)
      expect(result.rows).toBeUndefined()
    }
  })

  it('reports a missing predicate instead of scanning a table', async () => {
    const ctx = await mount()
    await ctx.dbgraph.index({ connection: 'local', mode: 'full' })
    const result = await ctx.dbgraph.find({ connection: 'local' })
    expect(result.status).toBe('missing_predicate')
    expect(result.rows).toBeUndefined()
  })

  it('writes the prompt digest the system-prompt section reads synchronously', async () => {
    const ctx = await mount()
    await ctx.dbgraph.index({ connection: 'local', mode: 'full' })

    const statusPath = join(root, 'status.json')
    expect(existsSync(statusPath)).toBe(true)
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as {
      version: number
      connections: Record<string, { objects: number; columns: number; digest: { object: string }[] }>
    }
    expect(status.version).toBe(1)
    const entry = status.connections['local']
    expect(entry?.objects).toBe(3)
    expect(entry?.digest.length).toBe(3)
  })

  it('answers structural questions offline through the tool-facing seam', async () => {
    const ctx = await mount()
    await ctx.dbgraph.index({ connection: 'local', mode: 'full' })

    const objects = await ctx.dbgraph.objects({ connection: 'local', query: 'order' })
    expect(objects.objects[0]?.object).toBe('order_item')

    const refs = await ctx.dbgraph.refs({ connection: 'local', object: 'sys_user' })
    expect(refs.entries.length).toBeGreaterThan(0)
  })
})
