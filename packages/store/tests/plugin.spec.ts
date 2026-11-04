/**
 * The plugin as a composition, not a unit: a real Cordis context, the real `ctx.dbgraph` service, the
 * real seam delegation, and a stub dialect so `find` composes resolve + execute end to end.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Dbgraph, { ConnectionId, ZH_ALIASES } from 'dsh-plugin-dbgraph-service'
import type { DatabaseDialect, DialectInput, RawCatalog, SqlResult } from 'dsh-plugin-dbgraph-service'
import * as StorePlugin from '../src/index.ts'
import { createStore } from '../src/index.ts'
import { writeConnections } from '../src/connections.ts'
import { RECENT_SAMPLE, SAMPLE, makeRoot, removeRoot } from './helpers.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
})

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

/** Write the sample index and the connection list for one root. */
async function seedRoot(root: string): Promise<void> {
  const writer = createStore({ root })
  await writer.write(ConnectionId('shop'), RECENT_SAMPLE, { writer: 'js', aliases: ZH_ALIASES })
  writer.dispose()
  writeConnections([{ id: 'shop', engine: 'mysql', label: '生产', host: 'db.internal', database: 'shop' }], root)
}

/** Mount the service and the store over one root. */
async function mount(root: string): Promise<Context> {
  const context = new Context()
  await context.plugin(Dbgraph)
  await context.plugin(StorePlugin, { root })
  contexts.push(context)
  return context
}

describe('plugin composition', () => {
  it('registers the store and answers every read through ctx.dbgraph', async () => {
    const root = freshRoot()
    await seedRoot(root)
    const context = await mount(root)

    const connections = await context.dbgraph.listConnections()
    expect(connections).toHaveLength(1)
    expect(connections[0]).toMatchObject({
      id: 'shop',
      engine: 'mysql',
      label: '生产',
      credentialConfigured: false,
      index: { objects: SAMPLE.objects.length, columns: 331, stale: false, writer: 'js' },
    })

    const schema = await context.dbgraph.schema({ connection: 'shop' })
    expect(schema.engine).toBe('mysql')
    expect(schema.objects[0]?.object).toBe('wide_table')

    const objects = await context.dbgraph.objects({ connection: 'shop', query: '用户' })
    expect(objects.objects.map(entry => entry.object)).toContain('sys_user')

    const columns = await context.dbgraph.columns({ connection: 'shop', object: 'sys_user' })
    expect(columns.columns.find(entry => entry.name === 'password')?.comment).toBe('登录密码')

    const refs = await context.dbgraph.refs({ connection: 'shop', object: 'sys_user' })
    expect(refs.entries.map(entry => entry.object)).toContain('orders')
  })

  it('composes resolve + one dialect execution for find', async () => {
    const root = freshRoot()
    await seedRoot(root)
    const context = await mount(root)
    const executed: string[] = []
    const dialect: DatabaseDialect = {
      engine: 'mysql',
      test: async () => ({ ok: true, elapsedMs: 1 }),
      fetchL1: async (_input: DialectInput): Promise<RawCatalog> => SAMPLE,
      fetchL2: async (_input: DialectInput, l1: RawCatalog): Promise<RawCatalog> => l1,
      execute: async (_input: DialectInput, query: string): Promise<SqlResult> => {
        executed.push(query)
        return {
          columns: ['dept_name'],
          rows: [{ dept_name: '研发' }],
          rowCount: 1,
          truncated: false,
          redacted: [],
          elapsedMs: 1,
        }
      },
    }
    context.dbgraph.registerDialect(dialect)

    const result = await context.dbgraph.find({
      connection: 'shop',
      entity: '部门',
      fields: ['dept_name'],
      where: { dept_name: '研发' },
    })
    expect(result.status).toBe('resolved')
    expect(result.resolved?.object).toBe('sys_dept')
    expect(result.rows).toEqual([{ dept_name: '研发' }])
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatch(/^SELECT `dept_name` FROM `sys_dept` WHERE `dept_name` = \? LIMIT 50$/)
    expect(result.sql).toContain("'研发'")
    expect(result.sql).toContain('LIMIT 50')
  })

  it('removes the store when the plugin disposes', async () => {
    const root = freshRoot()
    await seedRoot(root)
    const context = await mount(root)
    await expect(context.dbgraph.schema({ connection: 'shop' })).resolves.toBeDefined()
    await context.fiber.dispose()
    contexts.splice(contexts.indexOf(context), 1)
    // Teardown unregisters the store along with the service instance the context owned.
    expect(context.dbgraph).toBeUndefined()
  })

  it('fails as DBGRAPH_NO_STORE when only the service is mounted', async () => {
    const context = new Context()
    await context.plugin(Dbgraph)
    contexts.push(context)
    await expect(context.dbgraph.schema({ connection: 'shop' })).rejects.toMatchObject({
      code: 'DBGRAPH_NO_STORE',
    })
  })
})
