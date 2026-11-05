/**
 * Read-path behaviour: the state contract (never throws), the listing shapes, relation traversal, and
 * the "a replaced index file is a different file" rule the pool exists for.
 */

import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { RawCatalog } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { indexPath } from '../src/paths.ts'
import {
  RECENT_SAMPLE,
  SAMPLE,
  column,
  connectionId,
  makeRoot,
  openRawIndex,
  removeRoot,
  seed,
  table,
} from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
})

async function freshRoot(): Promise<string> {
  const root = makeRoot()
  roots.push(root)
  return root
}

async function seeded(config: Parameters<typeof createStore>[0] = {}): Promise<string> {
  const root = await freshRoot()
  const { store } = await seed(root, 'shop', SAMPLE, config)
  stores.push(store)
  return root
}

describe('state', () => {
  it('reports empty and stale when no index exists, without throwing', async () => {
    const root = await freshRoot()
    const store = createStore({ root })
    stores.push(store)
    await expect(store.state('shop')).resolves.toEqual({ objects: 0, columns: 0, stale: true })
    // An unusable id is state's problem too, and state still answers.
    await expect(store.state('../escape')).resolves.toEqual({ objects: 0, columns: 0, stale: true })
  })

  it('reports counts, times, writer and freshness for a complete snapshot', async () => {
    const root = await freshRoot()
    const { store } = await seed(root, 'shop', RECENT_SAMPLE)
    stores.push(store)
    const state = await store.state('shop')
    expect(state).toMatchObject({
      objects: SAMPLE.objects.length,
      columns: 331,
      stale: false,
      writer: 'js',
    })
    expect(state.l1IndexedAt).toBe(RECENT_SAMPLE.fetchedAt)
    expect(state.l2IndexedAt).toBe(RECENT_SAMPLE.fetchedAt)
  })

  it('calls an L1-only snapshot stale because no enrichment has ever completed', async () => {
    const root = await freshRoot()
    const l1: RawCatalog = { ...SAMPLE, level: 'l1', fetchedAt: SAMPLE.fetchedAt + 5_000 }
    const { store } = await seed(root, 'shop', l1)
    stores.push(store)
    const state = await store.state('shop')
    expect(state.l1IndexedAt).toBe(l1.fetchedAt)
    expect(state.l2IndexedAt).toBeUndefined()
    expect(state.stale).toBe(true)
  })

  it('reports zeros for an index written for another schema version, while other reads fail loud', async () => {
    const root = await seeded()
    const db = new DatabaseSync(indexPath('shop', root))
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
    db.close()
    const store = createStore({ root })
    stores.push(store)
    await expect(store.state('shop')).resolves.toEqual({ objects: 0, columns: 0, stale: true })
    await expect(store.schema({ connection: 'shop' })).rejects.toMatchObject({
      code: 'DBGRAPH_MALFORMED_INDEX',
    })
  })

  it('reports zeros when the index file disappeared, while schema fails as unavailable', async () => {
    const root = await seeded()
    rmSync(indexPath('shop', root), { force: true })
    const store = createStore({ root })
    stores.push(store)
    await expect(store.state('shop')).resolves.toEqual({ objects: 0, columns: 0, stale: true })
    await expect(store.schema({ connection: 'shop' })).rejects.toMatchObject({ code: 'DBGRAPH_UNAVAILABLE' })
  })
})

describe('schema', () => {
  it('describes the connection and orders objects by width then name', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    const result = await store.schema({ connection: 'shop' })
    expect(result.connection).toBe('shop')
    expect(result.engine).toBe('mysql')
    expect(result.database).toBe('shop')
    expect(result.objects[0]).toMatchObject({ object: 'wide_table', columnCount: 300, comment: '宽表' })
    expect(result.objects[1]).toMatchObject({ object: 'sys_user', columnCount: 8, comment: '系统用户' })
    expect(result.objects).toHaveLength(SAMPLE.objects.length)
    expect(result.truncated).toBe(false)
    // 17 of the 331 columns carry a comment.
    expect(result.commentCoverage).toBeCloseTo(17 / 331, 10)
    expect(result.index.objects).toBe(SAMPLE.objects.length)
  })

  it('truncates the object list at the configured cap', async () => {
    const root = await seeded({ maxSchemaObjects: 2 })
    const store = createStore({ root, maxSchemaObjects: 2 })
    stores.push(store)
    const result = await store.schema({ connection: 'shop' })
    expect(result.objects).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })
})

describe('objects', () => {
  it('lists by width when the query is empty', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    const all = await store.objects({ connection: 'shop' })
    expect(all.objects[0]?.object).toBe('wide_table')
    expect(all.truncated).toBe(false)

    const limited = await store.objects({ connection: 'shop', limit: 2 })
    expect(limited.objects).toHaveLength(2)
    expect(limited.truncated).toBe(true)
  })

  it('finds Chinese object comments and Chinese column comments', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    const byComment = await store.objects({ connection: 'shop', query: '用户' })
    const names = byComment.objects.map(entry => entry.object)
    expect(names).toContain('sys_user')
    expect(names).toContain('user_profile')

    const byColumn = await store.objects({ connection: 'shop', query: '密码' })
    expect(byColumn.objects.map(entry => entry.object)).toContain('sys_user')
  })

  it('falls back to LIKE when the query holds no searchable token', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    const result = await store.objects({ connection: 'shop', query: '!!!' })
    expect(result.objects).toEqual([])
    expect(result.truncated).toBe(false)
  })
})

describe('columns', () => {
  it('lists declared order with enum samples and defaults', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    const result = await store.columns({ connection: 'shop', object: 'sys_user' })
    expect(result.object).toBe('sys_user')
    expect(result.kind).toBe('table')
    expect(result.comment).toBe('系统用户')
    expect(result.columns.map(entry => entry.name)).toEqual([
      'id',
      'user_name',
      'real_name',
      'password',
      'phone',
      'status',
      'dept_id',
      'created_at',
    ])
    const status = result.columns.find(entry => entry.name === 'status')
    expect(status).toMatchObject({
      type: 'tinyint(1)',
      nullable: true,
      comment: '状态',
      isPrimaryKey: false,
      isUnique: false,
    })
    expect(status?.enumValues).toEqual(['1', '0'])
  })

  it('refuses an unknown object with a suggestion', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    await expect(store.columns({ connection: 'shop', object: 'sys_userr' })).rejects.toMatchObject({
      code: 'DBGRAPH_UNKNOWN_OBJECT',
    })
  })

  it('resolves a schema-qualified name when the engine has schemas', async () => {
    const root = await freshRoot()
    const scoped: RawCatalog = {
      engine: 'postgres',
      database: 'app',
      fetchedAt: 1,
      level: 'l1',
      objects: [
        { kind: 'table', schema: 'public', name: 'account', columns: [column('id', 1, 'int')] },
      ],
    }
    const { store } = await seed(root, 'pg', scoped)
    stores.push(store)
    const bare = await store.columns({ connection: 'pg', object: 'account' })
    expect(bare.object).toBe('public.account')
    const qualified = await store.columns({ connection: 'pg', object: 'public.account' })
    expect(qualified.columns).toHaveLength(1)
  })
})

describe('relations', () => {
  it('reports direct referencing objects for refs', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    const refs = await store.refs({ connection: 'shop', object: 'sys_user' })
    expect(refs.object).toBe('sys_user')
    expect(refs.entries.map(entry => entry.object).sort()).toEqual(['audit_log', 'orders', 'user_profile'])
    const orders = refs.entries.find(entry => entry.object === 'orders')
    expect(orders).toMatchObject({ kind: 'fk', column: 'id', refColumn: 'user_id', name: 'fk_orders_user' })
  })

  it('walks the inbound closure for impact, nearest first', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    const impact = await store.impact({ connection: 'shop', object: 'sys_user' })
    const names = impact.entries.map(entry => entry.object)
    expect(names).toContain('orders')
    expect(names).toContain('user_profile')
    expect(names).toContain('audit_log')
    // Depth two: the view over orders is reachable.
    expect(names).toContain('order_summary')
    expect(impact.entries.find(entry => entry.object === 'order_summary')?.kind).toBe('view_ref')
    expect(impact.truncated).toBe(false)
  })

  it('honours the configured impact depth', async () => {
    const root = await seeded({ impactDepth: 1 })
    const store = createStore({ root, impactDepth: 1 })
    stores.push(store)
    const impact = await store.impact({ connection: 'shop', object: 'sys_user' })
    expect(impact.entries.map(entry => entry.object).sort()).toEqual(['audit_log', 'orders', 'user_profile'])
    expect(impact.entries.some(entry => entry.object === 'order_summary')).toBe(false)
  })

  it('refuses an unknown object for relation traversal', async () => {
    const root = await seeded()
    const store = createStore({ root })
    stores.push(store)
    await expect(store.refs({ connection: 'shop', object: 'nope' })).rejects.toMatchObject({
      code: 'DBGRAPH_UNKNOWN_OBJECT',
    })
    await expect(store.impact({ connection: 'shop', object: 'nope' })).rejects.toMatchObject({
      code: 'DBGRAPH_UNKNOWN_OBJECT',
    })
  })
})

describe('replacement', () => {
  it('reopens when a writer replaces the index file under a cached connection', async () => {
    const root = await freshRoot()
    const store = createStore({ root })
    stores.push(store)
    await store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
    expect((await store.schema({ connection: 'shop' })).objects).toHaveLength(SAMPLE.objects.length)

    const replacement: RawCatalog = {
      engine: 'mysql',
      database: 'shop',
      fetchedAt: SAMPLE.fetchedAt + 1,
      level: 'l1',
      objects: [table('only_table', [column('id', 1, 'int')])],
    }
    await store.write(connectionId('shop'), replacement, { writer: 'js', aliases: [] })
    const after = await store.schema({ connection: 'shop' })
    expect(after.objects).toHaveLength(1)
    expect(after.objects[0]?.object).toBe('only_table')
    // The cached handle for the old inode is closed by the pool before the reopen.
    expect(() => openRawIndex(root).prepare('SELECT 1')).not.toThrow()
  })
})

describe('a corrupt search index', () => {
  it('fails a free-text listing instead of pretending there are no hits', async () => {
    const root = await freshRoot()
    const { store } = await seed(root, 'shop', SAMPLE)
    stores.push(store)
    const database = new DatabaseSync(indexPath('shop', root))
    database.exec('DROP TABLE search')
    database.close()
    // Falling back to LIKE here would report "nothing matched" for an index that is broken.
    await expect(store.objects({ connection: 'shop', query: '用户' })).rejects.toThrow()
  })
})
