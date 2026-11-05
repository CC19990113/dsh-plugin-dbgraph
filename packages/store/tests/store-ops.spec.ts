/**
 * Store-level operations that no other spec owns: persisting the connection list, the `meta.engine`
 * gate on `resolve`, and the display label the digest carries — including the rule that a malformed
 * `connections.json` must not stop an index write.
 */

import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { INDEX_META_KEYS } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { connectionsPath, indexPath } from '../src/paths.ts'
import { readStatusFile } from '../src/status.ts'
import { writeConnections } from '../src/connections.ts'
import { SAMPLE, connectionId, makeRoot, removeRoot, seed } from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
})

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

describe('connection list through the store', () => {
  it('round-trips saveConnections and connections', async () => {
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    expect(await store.connections()).toEqual([])
    await store.saveConnections([{ id: 'shop', engine: 'mysql', label: '生产' }])
    expect(await store.connections()).toEqual([{ id: 'shop', engine: 'mysql', label: '生产' }])
  })
})

describe('resolve on an index without meta.engine', () => {
  it('fails loudly instead of resolving against an unknown dialect', async () => {
    const root = freshRoot()
    const { store } = await seed(root)
    stores.push(store)
    const db = new DatabaseSync(indexPath('shop', root))
    db.prepare('DELETE FROM meta WHERE key = ?').run(INDEX_META_KEYS.engine)
    db.close()
    await expect(store.resolve({ connection: 'shop', object: 'sys_user' })).rejects.toMatchObject({
      code: 'DBGRAPH_MALFORMED_INDEX',
    })
  })
})

describe('the digest label', () => {
  it('carries the configured label into the sidecar', async () => {
    const root = freshRoot()
    writeConnections([{ id: 'shop', engine: 'mysql', label: '生产' }], root)
    const store = createStore({ root })
    stores.push(store)
    await store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
    expect(readStatusFile(root)?.connections.shop?.label).toBe('生产')
  })

  it('still writes the index when connections.json cannot be read', async () => {
    const root = freshRoot()
    writeFileSync(connectionsPath(root), '{ not json', 'utf8')
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
    expect(report.objects).toBe(SAMPLE.objects.length)
    // The label is decoration; losing it must not fail the write.
    expect(readStatusFile(root)?.connections.shop?.label).toBeUndefined()
  })
})
