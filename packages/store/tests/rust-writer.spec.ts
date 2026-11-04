/**
 * The native writer, measured against the JavaScript writer on the same catalog and then read back
 * through the store the host actually mounts.
 *
 * Skipped when this machine has no artifact — a skipped test is honest, a green test against a fake
 * addon is not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { INDEX_META_KEYS } from 'dsh-plugin-dbgraph-service'
import type { RawCatalog } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { ADDON_ENV, resolveAddonPath } from '../src/rust-engine.ts'
import {
  RECENT_SAMPLE,
  SAMPLE,
  SQLITE_SAMPLE,
  makeRoot,
  openRawIndex,
  removeRoot,
} from './helpers.ts'
import { connectionId } from './helpers.ts'

const artifact = resolveAddonPath().path
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

function counts(path: string, connection: string): Record<string, number> {
  const db = openRawIndex(path, connection)
  try {
    const one = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    return {
      objects: one('objects'),
      columns: one('columns'),
      edges: one('edges'),
      terms: one('terms'),
      search: one('search'),
    }
  } finally {
    db.close()
  }
}

function metaOf(path: string, connection: string, key: string): string | undefined {
  const db = openRawIndex(path, connection)
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value
  } finally {
    db.close()
  }
}

describe.skipIf(artifact === undefined)('native writer', () => {
  it('is selected by auto and writes the same rows as the JavaScript writer', async () => {
    delete process.env[ADDON_ENV]
    const jsRoot = freshRoot()
    const rustRoot = freshRoot()
    const jsStore = createStore({ root: jsRoot })
    const rustStore = createStore({ root: rustRoot })
    stores.push(jsStore, rustStore)

    const jsReport = await jsStore.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
    const rustReport = await rustStore.write(connectionId('shop'), SAMPLE, { writer: 'auto', aliases: [] })

    expect(rustReport.writer).toBe('rust')
    expect(jsReport.writer).toBe('js')
    for (const key of ['objects', 'columns', 'edges', 'terms'] as const) {
      expect(rustReport[key], key).toBe(jsReport[key])
    }
    // The parity claim, measured on the files rather than on the reports.
    expect(counts(rustRoot, 'shop')).toEqual(counts(jsRoot, 'shop'))
    // The addon records its own identity; the store must not overwrite it.
    expect(metaOf(rustRoot, 'shop', INDEX_META_KEYS.writer)).toBe('rust')
    expect(metaOf(jsRoot, 'shop', INDEX_META_KEYS.writer)).toBe('js')
  })

  it('produces an index the existing reader serves', async () => {
    delete process.env[ADDON_ENV]
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(connectionId('shop'), RECENT_SAMPLE, { writer: 'rust', aliases: [] })
    expect(report.writer).toBe('rust')

    const state = await store.state('shop')
    expect(state).toMatchObject({
      objects: SAMPLE.objects.length,
      columns: 331,
      writer: 'rust',
      stale: false,
    })

    const schema = await store.schema({ connection: 'shop' })
    expect(schema.engine).toBe('mysql')
    expect(schema.database).toBe('shop')
    expect(schema.objects[0]?.object).toBe('wide_table')
    expect(schema.objects).toHaveLength(SAMPLE.objects.length)

    const columns = await store.columns({ connection: 'shop', object: 'sys_user' })
    expect(columns.columns.map(entry => entry.name)).toContain('password')

    const objects = await store.objects({ connection: 'shop', query: '用户' })
    expect(objects.objects.map(entry => entry.object)).toContain('sys_user')

    const refs = await store.refs({ connection: 'shop', object: 'sys_user' })
    expect(refs.entries.map(entry => entry.object)).toContain('orders')

    const resolution = await store.resolve({ connection: 'shop', entity: '头像' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('user_profile')
  })

  it('omits unknown meta keys instead of writing empty strings', async () => {
    delete process.env[ADDON_ENV]
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    await store.write(connectionId('lite'), SQLITE_SAMPLE, { writer: 'rust', aliases: [] })

    expect(metaOf(root, 'lite', INDEX_META_KEYS.serverVersion)).toBeUndefined()
    expect(metaOf(root, 'lite', INDEX_META_KEYS.l2IndexedAt)).toBeUndefined()
    expect(metaOf(root, 'lite', INDEX_META_KEYS.connection)).toBe('lite')
    const state = await store.state('lite')
    expect(state.l1IndexedAt).toBe(SQLITE_SAMPLE.fetchedAt)
    // Absent, not epoch zero: the reader must not describe this as enriched in 1970.
    expect(state.l2IndexedAt).toBeUndefined()
    expect(state.stale).toBe(true)
  })

  it('falls back to the JavaScript writer when an automatic native call rejects', async () => {
    delete process.env[ADDON_ENV]
    // Rust validates `ordinal` strictly; the JavaScript writer records whatever it is given. That
    // makes this the narrowest catalog that the native call rejects but the reference writer accepts.
    const strictOnly: RawCatalog = {
      ...SAMPLE,
      objects: SAMPLE.objects.map((object, objectIndex) =>
        objectIndex === 0
          ? {
              ...object,
              columns: object.columns.map((column, columnIndex) =>
                columnIndex === 0 ? { ...column, ordinal: 0 } : column),
            }
          : object),
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const root = freshRoot()
      const store = createStore({ root })
      stores.push(store)
      const report = await store.write(connectionId('shop'), strictOnly, { writer: 'auto', aliases: [] })
      expect(report.writer).toBe('js')
      expect(report.objects).toBe(SAMPLE.objects.length)
      expect(errors).toHaveBeenCalledTimes(1)
      expect(String(errors.mock.calls[0]?.[0])).toContain('native index writer is unavailable')
      expect(metaOf(root, 'shop', INDEX_META_KEYS.writer)).toBe('js')
    } finally {
      errors.mockRestore()
    }
  })

  it('still honours an explicit JavaScript request when the artifact is present', async () => {
    delete process.env[ADDON_ENV]
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
    expect(report.writer).toBe('js')
    expect(metaOf(root, 'shop', INDEX_META_KEYS.writer)).toBe('js')
  })
})
