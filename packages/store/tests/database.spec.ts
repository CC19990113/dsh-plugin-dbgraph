/**
 * Opening an index file: the format gate, the tolerance a foreign-written file needs, and the bounded
 * LRU pool whose whole point is noticing that a writer replaced the file under it.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INDEX_META_KEYS } from 'dsh-plugin-dbgraph-service'
import { IndexPool, openIndex } from '../src/database.ts'
import { indexPath } from '../src/paths.ts'
import { SAMPLE, SQLITE_SAMPLE, makeRoot, removeRoot, seed } from './helpers.ts'

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

/** Seed one connection and return its root. */
async function seeded(id = 'shop'): Promise<string> {
  const root = freshRoot()
  const { store } = await seed(root, id, id === 'shop' ? SAMPLE : SQLITE_SAMPLE)
  stores.push(store)
  return root
}

describe('openIndex', () => {
  it('reports a missing index as unavailable', () => {
    const root = freshRoot()
    expect(() => openIndex(indexPath('shop', root))).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_UNAVAILABLE' }),
    )
  })

  it('refuses a file that is not a SQLite database at all', () => {
    const root = freshRoot()
    const path = indexPath('shop', root)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'this is not a database file', 'utf8')
    expect(() => openIndex(path)).toThrow(expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }))
  })

  it('refuses an index that records no schema version', () => {
    const root = freshRoot()
    const path = indexPath('shop', root)
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(INDEX_META_KEYS.connection, 'shop')
    db.close()
    expect(() => openIndex(path)).toThrow(expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }))
  })

  it('refuses an index written for another schema version', async () => {
    const root = await seeded()
    const path = indexPath('shop', root)
    const db = new DatabaseSync(path)
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('999', INDEX_META_KEYS.schemaVersion)
    db.close()
    expect(() => openIndex(path)).toThrow(expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }))
  })

  it('skips a meta row whose value is not text instead of failing the open', async () => {
    const root = await seeded()
    const path = indexPath('shop', root)
    const db = new DatabaseSync(path)
    // A foreign writer can leave a BLOB in `value`; TEXT affinity does not convert it.
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('foreign_blob', new Uint8Array([1, 2, 3]))
    db.close()
    const opened = openIndex(path)
    try {
      expect(opened.meta.get('foreign_blob')).toBeUndefined()
      expect(opened.meta.get(INDEX_META_KEYS.engine)).toBe('mysql')
    } finally {
      opened.db.close()
    }
  })

  it('reports the meta rows it read', async () => {
    const root = await seeded()
    const opened = openIndex(indexPath('shop', root))
    try {
      expect(opened.meta.get(INDEX_META_KEYS.schemaVersion)).toBe('1')
      expect(opened.meta.get(INDEX_META_KEYS.connection)).toBe('shop')
    } finally {
      opened.db.close()
    }
  })
})

describe('IndexPool', () => {
  it('refuses a pool size that is not a positive integer', () => {
    expect(() => new IndexPool(0)).toThrow(/positive integer/)
    expect(() => new IndexPool(1.5)).toThrow(/positive integer/)
    expect(() => new IndexPool(Number.NaN)).toThrow(/positive integer/)
  })

  it('reports a disposed pool as unavailable', async () => {
    const root = await seeded()
    const pool = new IndexPool(2)
    const opened = pool.acquire(indexPath('shop', root))
    expect(opened.meta.size).toBeGreaterThan(0)
    pool.close()
    expect(() => pool.acquire(indexPath('shop', root))).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_UNAVAILABLE' }),
    )
  })

  it('serves a cached handle while the file identity is unchanged', async () => {
    const root = await seeded()
    const pool = new IndexPool(2)
    const first = pool.acquire(indexPath('shop', root))
    const second = pool.acquire(indexPath('shop', root))
    expect(second).toBe(first)
    pool.close()
  })

  it('reopens when a writer replaced the file', async () => {
    const root = await seeded()
    const pool = new IndexPool(2)
    const before = pool.acquire(indexPath('shop', root))
    const smaller = { ...SAMPLE, objects: SAMPLE.objects.slice(0, 1) }
    const { store } = await seed(root, 'shop', smaller)
    stores.push(store)
    const after = pool.acquire(indexPath('shop', root))
    expect(after).not.toBe(before)
    expect(after.db.prepare('SELECT COUNT(*) AS count FROM objects').get()).toEqual({ count: 1 })
    pool.close()
  })

  it('evicts the least recently used handle at the configured bound', async () => {
    const root = await seeded()
    const lite = await seeded('lite')
    const pool = new IndexPool(1)
    const shopHandle = pool.acquire(indexPath('shop', root))
    const liteHandle = pool.acquire(indexPath('lite', lite))
    // The shop handle was closed by the eviction, so the retained connection is gone.
    expect(() => shopHandle.db.prepare('SELECT 1')).toThrow()
    expect(liteHandle.db.prepare('SELECT COUNT(*) AS count FROM objects').get()).toEqual({ count: 1 })
    pool.close()
  })

  it('evicts the entry with the oldest use, not merely the first in insertion order', async () => {
    const root = await seeded()
    const lite = await seeded('lite')
    const other = await seeded('other')
    const pool = new IndexPool(2)
    pool.acquire(indexPath('shop', root))
    const liteHandle = pool.acquire(indexPath('lite', lite))
    // Touch the first entry so the second becomes the least recently used one.
    pool.acquire(indexPath('shop', root))
    pool.acquire(indexPath('other', other))
    expect(() => liteHandle.db.prepare('SELECT 1')).toThrow()
    pool.close()
  })

  it('closes a handle it already lost, and says so instead of throwing', async () => {
    const root = await seeded()
    const pool = new IndexPool(2)
    const opened = pool.acquire(indexPath('shop', root))
    // Simulate a handle that died underneath the pool.
    opened.db.close()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => pool.close()).not.toThrow()
      expect(String(errors.mock.calls[0]?.[0])).toContain('closing a cached index handle failed')
    } finally {
      errors.mockRestore()
    }
  })
})
