/**
 * Row-level assertions for the JavaScript write path: the reported counts, the meta contract, the four
 * normalized tables, the FTS documents, and the atomic-replace protocol.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INDEX_META_KEYS,
  INDEX_SCHEMA_VERSION,
  searchMatchQuery,
} from 'dsh-plugin-dbgraph-service'
import type { RawCatalog } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { indexPath, statusPath } from '../src/paths.ts'
import {
  SAMPLE,
  column,
  connectionId,
  hasStagingFile,
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

async function seeded(): Promise<{ root: string; report: Awaited<ReturnType<typeof seed>>['report'] }> {
  const root = await freshRoot()
  const { store, report } = await seed(root)
  stores.push(store)
  return { root, report }
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value
}

describe('JavaScript write path', () => {
  it('reports the rows it actually wrote', async () => {
    const { report } = await seeded()
    expect(report).toMatchObject({
      connection: 'shop',
      level: 'l2',
      objects: SAMPLE.objects.length,
      columns: 331,
      edges: 8,
      writer: 'js',
    })
    expect(report.terms).toBeGreaterThan(1_000)
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(report.warnings).toEqual([])
  })

  it('records the meta contract the reader depends on', async () => {
    const { root } = await seeded()
    const db = openRawIndex(root)
    try {
      expect(metaValue(db, INDEX_META_KEYS.schemaVersion)).toBe(String(INDEX_SCHEMA_VERSION))
      expect(metaValue(db, INDEX_META_KEYS.connection)).toBe('shop')
      expect(metaValue(db, INDEX_META_KEYS.engine)).toBe('mysql')
      expect(metaValue(db, INDEX_META_KEYS.database)).toBe('shop')
      expect(metaValue(db, INDEX_META_KEYS.serverVersion)).toBe('8.0.36')
      expect(metaValue(db, INDEX_META_KEYS.level)).toBe('l2')
      expect(metaValue(db, INDEX_META_KEYS.fetchedAt)).toBe(String(SAMPLE.fetchedAt))
      expect(metaValue(db, INDEX_META_KEYS.l1IndexedAt)).toBe(String(SAMPLE.fetchedAt))
      expect(metaValue(db, INDEX_META_KEYS.l2IndexedAt)).toBe(String(SAMPLE.fetchedAt))
      expect(metaValue(db, INDEX_META_KEYS.writer)).toBe('js')
      expect(Number(metaValue(db, INDEX_META_KEYS.writtenAt))).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('stores objects and columns verbatim, with normalized evidence alongside', async () => {
    const { root } = await seeded()
    const db = openRawIndex(root)
    try {
      const user = db
        .prepare('SELECT id, kind, schema_name, name, comment, row_estimate FROM objects WHERE name = ?')
        .get('sys_user') as Record<string, unknown>
      expect(user).toMatchObject({
        kind: 'table',
        schema_name: '',
        name: 'sys_user',
        comment: '系统用户',
        row_estimate: 1200,
      })
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM objects').get() as { count: number }).count,
      ).toBe(SAMPLE.objects.length)

      const password = db
        .prepare(
          `SELECT ordinal, type, type_class, nullable, comment, is_primary_key, is_unique, enum_values_json
           FROM columns WHERE object_id = ? AND name = 'password'`,
        )
        .get(user.id) as Record<string, unknown>
      expect(password).toMatchObject({
        ordinal: 4,
        type: 'varchar(128)',
        type_class: 'string',
        nullable: 1,
        comment: '登录密码',
        is_primary_key: 0,
        is_unique: 0,
        enum_values_json: null,
      })

      const status = db
        .prepare('SELECT type_class, enum_values_json FROM columns WHERE object_id = ? AND name = ?')
        .get(user.id, 'status') as Record<string, unknown>
      expect(status.type_class).toBe('bool')
      expect(JSON.parse(status.enum_values_json as string)).toEqual(['1', '0'])

      const id = db
        .prepare('SELECT nullable, is_primary_key FROM columns WHERE object_id = ? AND name = ?')
        .get(user.id, 'id') as Record<string, unknown>
      expect(id).toMatchObject({ nullable: 0, is_primary_key: 1 })

      const amount = db
        .prepare(
          `SELECT c.type_class FROM columns c JOIN objects o ON o.id = c.object_id
           WHERE o.name = 'orders' AND c.name = 'amount'`,
        )
        .get() as Record<string, unknown>
      expect(amount.type_class).toBe('decimal')

      const createdAt = db
        .prepare(
          `SELECT c.type_class FROM columns c JOIN objects o ON o.id = c.object_id
           WHERE o.name = 'orders' AND c.name = 'created_at'`,
        )
        .get() as Record<string, unknown>
      expect(createdAt.type_class).toBe('datetime')

      const wide = db
        .prepare(
          `SELECT COUNT(*) AS count FROM columns c JOIN objects o ON o.id = c.object_id
           WHERE o.name = 'wide_table'`,
        )
        .get() as { count: number }
      expect(wide.count).toBe(300)
    } finally {
      db.close()
    }
  })

  it('stores edges with both endpoint ids resolved', async () => {
    const { root } = await seeded()
    const db = openRawIndex(root)
    try {
      const fk = db
        .prepare(
          `SELECT so.name AS src, sc.name AS src_column, dso.name AS dst, dsc.name AS dst_column, e.name
           FROM edges e
           JOIN objects so ON so.id = e.src_object
           JOIN objects dso ON dso.id = e.dst_object
           JOIN columns sc ON sc.id = e.src_column_id
           JOIN columns dsc ON dsc.id = e.dst_column_id
           WHERE e.name = 'fk_orders_user'`,
        )
        .get() as Record<string, unknown>
      expect(fk).toMatchObject({
        src: 'orders',
        src_column: 'user_id',
        dst: 'sys_user',
        dst_column: 'id',
      })

      const index = db
        .prepare(
          `SELECT e.kind, sc.name AS src_column, e.dst_object AS dst_object
           FROM edges e JOIN columns sc ON sc.id = e.src_column_id
           WHERE e.name = 'uniq_user_name'`,
        )
        .get() as Record<string, unknown>
      expect(index).toMatchObject({ kind: 'index', src_column: 'user_name', dst_object: null })

      const view = db
        .prepare(
          `SELECT e.kind, so.name AS src, dso.name AS dst
           FROM edges e JOIN objects so ON so.id = e.src_object JOIN objects dso ON dso.id = e.dst_object
           WHERE e.name = 'v_order_summary'`,
        )
        .get() as Record<string, unknown>
      expect(view).toMatchObject({ kind: 'view_ref', src: 'order_summary', dst: 'orders' })
    } finally {
      db.close()
    }
  })

  it('indexes name tokens, Chinese bigrams and alias expansions into terms', async () => {
    const { root } = await seeded()
    const db = openRawIndex(root)
    try {
      const user = db.prepare("SELECT id FROM objects WHERE name = 'sys_user'").get() as { id: number }
      const passwordId = (
        db.prepare("SELECT id FROM columns WHERE object_id = ? AND name = 'password'").get(user.id) as { id: number }
      ).id

      const rows = db
        .prepare('SELECT term, weight, object_id, column_id FROM terms WHERE column_id = ?')
        .all(passwordId) as { term: string; weight: number; object_id: number; column_id: number }[]
      const byTerm = new Map(rows.map(row => [row.term, row]))
      // The column's own name token: strongest column evidence.
      expect(byTerm.get('password')?.weight).toBe(0.9)
      // The alias table's own word wins over the weaker comment bigram of the same text.
      expect(byTerm.get('密码')?.weight).toBe(0.65)

      // A bigram no alias word covers keeps the plain comment weight.
      const deptName = db
        .prepare(
          `SELECT t.term, t.weight FROM terms t JOIN columns c ON c.id = t.column_id
           WHERE c.name = 'dept_name' AND t.term = '门名'`,
        )
        .get() as { weight: number } | undefined
      expect(deptName?.weight).toBe(0.5)
      // Alias expansion: the same word in loose spellings.
      expect(byTerm.get('pwd')?.weight).toBe(0.65)
      expect(byTerm.get('passwd')?.weight).toBe(0.65)
      // Column terms carry their object, so an entity can find the table through them.
      expect(byTerm.get('password')?.object_id).toBe(user.id)

      const objectTerm = db
        .prepare("SELECT weight FROM terms WHERE term = 'user' AND object_id = ? AND column_id IS NULL")
        .get(user.id) as { weight: number } | undefined
      expect(objectTerm?.weight).toBe(1)
    } finally {
      db.close()
    }
  })

  it('writes one search document per object and per column, with identity columns readable', async () => {
    const { root } = await seeded()
    const db = openRawIndex(root)
    try {
      const objects = db
        .prepare('SELECT COUNT(*) AS count FROM search WHERE object_id IS NOT NULL AND column_id IS NULL')
        .get() as { count: number }
      const columns = db
        .prepare('SELECT COUNT(*) AS count FROM search WHERE column_id IS NOT NULL AND object_id IS NULL')
        .get() as { count: number }
      expect(objects.count).toBe(SAMPLE.objects.length)
      expect(columns.count).toBe(331)

      // Stored text is the token stream, so a Chinese comment is findable by its bigram.
      const match = searchMatchQuery(['用户'])
      const hits = db
        .prepare(
          `SELECT o.name FROM search JOIN objects o ON o.id = search.object_id
           WHERE search.object_id IS NOT NULL AND search MATCH ? ORDER BY bm25(search)`,
        )
        .all(match) as { name: string }[]
      expect(hits.map(hit => hit.name)).toContain('sys_user')

      // A column-level document is reachable too.
      const columnHit = db
        .prepare(
          `SELECT c.name FROM search JOIN columns c ON c.id = search.column_id
           WHERE search.column_id IS NOT NULL AND search MATCH ? ORDER BY bm25(search) LIMIT 1`,
        )
        .all(searchMatchQuery(['密码'])) as { name: string }[]
      expect(columnHit[0]?.name).toBe('password')
    } finally {
      db.close()
    }
  })

  it('replaces the index atomically and leaves no staging file behind', async () => {
    const root = await freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const first = await store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
    expect(first.objects).toBe(SAMPLE.objects.length)
    expect(existsSync(indexPath('shop', root))).toBe(true)
    expect(hasStagingFile(root, 'shop')).toBe(false)

    const smaller: RawCatalog = {
      engine: 'mysql',
      database: 'shop',
      fetchedAt: SAMPLE.fetchedAt + 1,
      level: 'l1',
      objects: [table('only', [column('id', 1, 'int', { isPrimaryKey: true })])],
    }
    const second = await store.write(connectionId('shop'), smaller, { writer: 'js', aliases: [] })
    expect(second.objects).toBe(1)
    expect(second.level).toBe('l1')
    const db = openRawIndex(root)
    try {
      expect((db.prepare('SELECT COUNT(*) AS count FROM objects').get() as { count: number }).count).toBe(1)
      // An L1-only file records no L2 time.
      expect(metaValue(db, INDEX_META_KEYS.l2IndexedAt)).toBeUndefined()
    } finally {
      db.close()
    }
    // The sidecar was rewritten after the index, in the same run.
    expect(existsSync(statusPath(root))).toBe(true)
  })

  it('refuses an unusable connection id before touching the filesystem', async () => {
    const root = await freshRoot()
    const store = createStore({ root })
    stores.push(store)
    await expect(
      store.write(connectionId('../escape'), SAMPLE, { writer: 'js', aliases: [] }),
    ).rejects.toMatchObject({ code: 'DBGRAPH_UNKNOWN_CONNECTION' })
    expect(existsSync(indexPath('../escape', root))).toBe(false)
  })

  it('propagates catalog warnings onto the report', async () => {
    const root = await freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(
      connectionId('shop'),
      { ...SAMPLE, warnings: ['table foo could not be read'] },
      { writer: 'js', aliases: [] },
    )
    expect(report.warnings).toContain('table foo could not be read')
  })

  it('keeps the written index when the digest sidecar cannot be written', async () => {
    const root = await freshRoot()
    const store = createStore({ root })
    stores.push(store)
    // A directory where status.json belongs makes the sidecar rename fail; the index itself is
    // already durable, so the run must succeed and report the degraded prompt view instead.
    mkdirSync(statusPath(root), { recursive: true })
    const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
    expect(report.objects).toBe(SAMPLE.objects.length)
    expect(report.warnings.join('\n')).toMatch(/index was written but the prompt digest was not/)
    expect(existsSync(indexPath('shop', root))).toBe(true)
  })

  it('skips edges whose target object was not indexed, and says so', async () => {
    const root = await freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const snapshot: RawCatalog = {
      engine: 'mysql',
      database: 'shop',
      fetchedAt: 1,
      level: 'l1',
      objects: [
        table('child', [column('id', 1, 'int'), column('parent_id', 2, 'int')], {
          edges: [{ kind: 'fk', columns: ['parent_id'], refObject: 'unindexed_parent', refColumns: ['id'] }],
        }),
      ],
    }
    const report = await store.write(connectionId('shop'), snapshot, { writer: 'js', aliases: [] })
    expect(report.edges).toBe(0)
    expect(report.warnings.join('\n')).toMatch(/edge row\(s\) skipped/)
  })
})
