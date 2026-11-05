/**
 * Edge-resolution and schema-qualification cases the JavaScript writer's happy path does not reach:
 * two objects sharing a bare name, a reference written without its schema, a reference whose case
 * disagrees with the stored name, a foreign-key column that names nothing, and the failure path that
 * keeps a broken catalog from replacing a good index.
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionIdType, RawCatalog, RawEdge } from 'dsh-plugin-dbgraph-service'
import { writeIndexJs } from '../src/writer-js.ts'
import { indexPath } from '../src/paths.ts'
import {
  makeRoot,
  openRawIndex,
  removeRoot,
  seed,
  column,
  table,
  connectionId,
} from './helpers.ts'

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

/** One schema-qualified snapshot whose edges exercise every reference-resolution tier. */
const SCOPED: RawCatalog = {
  engine: 'postgres',
  database: 'app',
  fetchedAt: 1_700_000_000_000,
  level: 'l1',
  objects: [
    table('account', [column('id', 1, 'int', { isPrimaryKey: true })], { schema: 'public' }),
    table('profile', [
      column('id', 1, 'int', { isPrimaryKey: true }),
      column('account_id', 2, 'int', { nullable: false }),
      column('note', 3, 'text', { defaultValue: "''" }),
    ], {
      schema: 'public',
      edges: [
        // Bare reference to the only object with that name: the by-name tier.
        { kind: 'fk', name: 'fk_profile_account', columns: ['account_id'], refObject: 'account', refColumns: ['id'] },
        // Case-disagreeing display name: only the lower-cased scan can resolve it.
        { kind: 'fk', name: 'fk_profile_account_upper', columns: ['ACCOUNT_ID'], refObject: 'PUBLIC.ACCOUNT', refColumns: ['ID'] },
        // A source column that names nothing on this object is dropped, not written half-resolved.
        { kind: 'index', name: 'idx_ghost', columns: ['ghost'] },
        // An edge with neither a name nor a target: both columns are NULL, which is legal.
        { kind: 'index', columns: ['id'] },
      ] satisfies RawEdge[],
    }),
  ],
}

describe('reference resolution', () => {
  it('resolves a bare and a case-disagreeing reference to their objects and columns', async () => {
    const root = freshRoot()
    const { store } = await seed(root, 'shop', SCOPED)
    stores.push(store)
    const db = openRawIndex(root)
    try {
      const rows = db
        .prepare(
          `SELECT e.name, so.name AS src, dso.name AS dst, sc.name AS src_column, dsc.name AS dst_column
           FROM edges e
           JOIN objects so ON so.id = e.src_object
           LEFT JOIN objects dso ON dso.id = e.dst_object
           LEFT JOIN columns sc ON sc.id = e.src_column_id
           LEFT JOIN columns dsc ON dsc.id = e.dst_column_id
           ORDER BY e.id`,
        )
        .all() as Record<string, unknown>[]
      expect(rows[0]).toMatchObject({
        name: 'fk_profile_account',
        src: 'profile',
        dst: 'account',
        src_column: 'account_id',
        dst_column: 'id',
      })
      // The upper-cased reference resolved too, including its upper-cased column name.
      expect(rows[1]).toMatchObject({
        name: 'fk_profile_account_upper',
        dst: 'account',
        src_column: 'account_id',
        dst_column: 'id',
      })
      // The ghost source column produced no edge; no-name edge has NULLs.
      expect(rows).toHaveLength(3)
      expect(rows[2]).toMatchObject({ name: null, dst: null })
    } finally {
      db.close()
    }
  })

  it('keeps two objects that share a bare name apart and skips an ambiguous reference', async () => {
    const snapshot: RawCatalog = {
      engine: 'mysql',
      database: 'shop',
      fetchedAt: 1,
      level: 'l1',
      objects: [
        table('account', [column('id', 1, 'int', { isPrimaryKey: true })], { schema: 'public' }),
        table('account', [column('id', 1, 'int', { isPrimaryKey: true })], { schema: 'archive' }),
        table('tag', [column('id', 1, 'int'), column('account_id', 2, 'int')], {
          edges: [{ kind: 'fk', columns: ['account_id'], refObject: 'account' }],
        }),
      ],
    }
    const root = freshRoot()
    const { store, report } = await seed(root, 'shop', snapshot)
    stores.push(store)
    // `account` names two objects, so the edge is skipped rather than pointed at either.
    expect(report.edges).toBe(0)
    expect(report.warnings.join('\n')).toMatch(/edge row\(s\) skipped/)
    const db = openRawIndex(root)
    try {
      expect((db.prepare('SELECT COUNT(*) AS count FROM objects').get() as { count: number }).count).toBe(3)
    } finally {
      db.close()
    }
  })

  it('records a nullable-false column the way the reader expects', async () => {
    const root = freshRoot()
    const { store } = await seed(root, 'shop', SCOPED)
    stores.push(store)
    const db = openRawIndex(root)
    try {
      const row = db
        .prepare(
          `SELECT c.nullable, c.is_primary_key, c.default_value, c.enum_values_json
           FROM columns c JOIN objects o ON o.id = c.object_id
           WHERE o.name = 'profile' AND c.name = 'account_id'`,
        )
        .get() as Record<string, unknown>
      expect(row).toMatchObject({ nullable: 0, is_primary_key: 0 })
      const note = db
        .prepare(
          `SELECT c.default_value FROM columns c JOIN objects o ON o.id = c.object_id
           WHERE o.name = 'profile' AND c.name = 'note'`,
        )
        .get() as Record<string, unknown>
      expect(note.default_value).toBe("''")
    } finally {
      db.close()
    }
  })
})

describe('failure paths', () => {
  it('refuses an unusable connection id before writing anything', () => {
    const root = freshRoot()
    expect(() =>
      writeIndexJs({
        connection: '../escape' as ConnectionIdType,
        catalog: SCOPED,
        aliases: [],
        root,
      }),
    ).toThrow(expect.objectContaining({ code: 'DBGRAPH_INVALID_PROVIDER' }))
    expect(existsSync(indexPath('../escape', root))).toBe(false)
  })

  it('reports a catalog that cannot be written and keeps the previous index', async () => {
    const root = freshRoot()
    const { store } = await seed(root, 'shop', SCOPED)
    stores.push(store)
    // Two objects with the same schema and name violate `objects_identity` mid-transaction.
    const duplicated: RawCatalog = {
      engine: 'mysql',
      database: 'shop',
      fetchedAt: 2,
      level: 'l1',
      objects: [table('dup', [column('id', 1, 'int')]), table('dup', [column('id', 1, 'int')])],
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        writeIndexJs({ connection: connectionId('shop'), catalog: duplicated, aliases: [], root }),
      ).toThrow(expect.objectContaining({ code: 'DBGRAPH_WRITE_FAILED' }))
    } finally {
      errors.mockRestore()
    }
    // The previous index is still there and still readable; the staging file is gone.
    const db = new DatabaseSync(indexPath('shop', root), { readOnly: true })
    try {
      expect((db.prepare('SELECT COUNT(*) AS count FROM objects').get() as { count: number }).count).toBe(2)
    } finally {
      db.close()
    }
  })
})
