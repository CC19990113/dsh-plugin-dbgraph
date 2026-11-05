/**
 * Reading an index this repository did not write.
 *
 * The writer's own output always satisfies the schema's constraints, so the tolerance the reader
 * needs — `NULL` where the DDL says `NOT NULL`, an enum sample that is not a JSON array, a meta key
 * that is empty, an edge with no name, a search row pointing at an object that is gone — is only
 * reachable through a hand-built file. That is a real scenario (`CLAUDE.md`: keep the store able to
 * read a graph it did not write), so these tests build one and read it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { INDEX_META_KEYS } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { ftsObjectIds, lookupObject, suggestObjects } from '../src/reader.ts'
import { foreignIndex, makeRoot, removeRoot } from './helpers.ts'

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

/** A store over the root, disposed after the test. */
function storeOver(root: string): ReturnType<typeof createStore> {
  const store = createStore({ root })
  stores.push(store)
  return store
}

describe('rows that violate the writer\'s own guarantees', () => {
  it('renders an object whose name, schema, kind and comment are all NULL', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.exec(
      `INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
       VALUES (1, NULL, NULL, NULL, NULL, NULL, 1),
              (2, 'table', 'public', 'scoped', '注释', 1200, 1)`,
    )
    db.close()
    const store = storeOver(root)

    // schema() maps the row itself, without the NULL-tolerant record helper.
    const schema = await store.schema({ connection: 'shop' })
    expect(schema.objects).toHaveLength(2)
    expect(schema.objects.find(entry => entry.object === 'public.scoped')).toEqual({
      object: 'public.scoped',
      kind: 'table',
      comment: '注释',
      columnCount: 0,
      rowEstimate: 1200,
    })
    expect(schema.objects.find(entry => entry.object === '')).toEqual({
      object: '',
      kind: '',
      columnCount: 0,
    })
    const listing = await store.objects({ connection: 'shop' })
    expect(listing.objects.find(entry => entry.object === '')).toEqual({
      object: '',
      kind: '',
      columnCount: 0,
    })
  })

  it('renders a column whose name and type are NULL, and survives any enum sample', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.exec(
      `INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
       VALUES (2, 'table', '', 'weird', NULL, NULL, 1)`,
    )
    const insertColumn = db.prepare(
      `INSERT INTO columns (id, object_id, ordinal, name, type, type_class, nullable, default_value,
         comment, is_primary_key, is_unique, enum_values_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // A JSON object, an empty array, and unparsable text: none of the three is an enum sample.
    insertColumn.run(10, 2, 1, null, null, 'unknown', 1, null, null, 0, 0, '{"a":1}', 1)
    insertColumn.run(11, 2, 2, null, null, 'unknown', 1, null, null, 0, 0, '[]', 1)
    insertColumn.run(12, 2, 3, null, null, 'unknown', 1, null, null, 0, 0, 'oops', 1)
    insertColumn.run(13, 2, 4, 'note', 'text', 'text', 1, "'x'", null, 0, 0, null, 1)
    db.close()
    const store = storeOver(root)

    const listing = await store.columns({ connection: 'shop', object: 'weird' })
    expect(listing.object).toBe('weird')
    expect(listing.columns.map(column => column.name)).toEqual(['', '', '', 'note'])
    expect(listing.columns.slice(0, 3).every(column => column.enumValues === undefined)).toBe(true)
    expect(listing.columns[3]?.defaultValue).toBe("'x'")
    expect(listing.columns.every(column => column.type !== undefined)).toBe(true)
  })

  it('renders an edge whose kind and name are NULL, from an unnamed source object', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.exec(
      `INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
       VALUES (1, NULL, NULL, NULL, NULL, NULL, 1), (2, 'table', '', 'target', NULL, NULL, 1)`,
    )
    db.exec('INSERT INTO edges (src_object, kind, dst_object) VALUES (1, NULL, 2)')
    db.close()
    const store = storeOver(root)

    const refs = await store.refs({ connection: 'shop', object: 'target' })
    expect(refs.entries).toEqual([{ kind: 'fk', object: '' }])
    expect(refs.truncated).toBe(false)
  })

  it('falls back for absent, empty and non-numeric meta timestamps and an unknown writer', async () => {
    const root = freshRoot()
    const db = foreignIndex(root, {
      [INDEX_META_KEYS.fetchedAt]: '1700000000000',
      [INDEX_META_KEYS.l1IndexedAt]: '',
      [INDEX_META_KEYS.l2IndexedAt]: 'not-a-number',
      [INDEX_META_KEYS.level]: 'l2',
      [INDEX_META_KEYS.writer]: 'go',
    })
    db.close()
    const store = storeOver(root)

    const state = await store.state('shop')
    // Empty l1 falls back to fetched_at; a non-numeric l2 falls back to fetched_at because level is l2.
    expect(state.l1IndexedAt).toBe(1_700_000_000_000)
    expect(state.l2IndexedAt).toBe(1_700_000_000_000)
    // An unrecognized writer is reported as unknown, not echoed.
    expect(state.writer).toBeUndefined()
  })

  it('refuses a schema call when a required meta key is missing', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.prepare('DELETE FROM meta WHERE key = ?').run(INDEX_META_KEYS.engine)
    db.close()
    const store = storeOver(root)
    await expect(store.schema({ connection: 'shop' })).rejects.toMatchObject({
      code: 'DBGRAPH_MALFORMED_INDEX',
    })

    const other = freshRoot()
    const second = foreignIndex(other)
    second.prepare('DELETE FROM meta WHERE key = ?').run(INDEX_META_KEYS.database)
    second.close()
    await expect(storeOver(other).schema({ connection: 'shop' })).rejects.toMatchObject({
      code: 'DBGRAPH_MALFORMED_INDEX',
    })
  })
})

describe('an empty index', () => {
  it('reports zero coverage and no objects rather than failing', async () => {
    const root = freshRoot()
    foreignIndex(root).close()
    const store = storeOver(root)
    const schema = await store.schema({ connection: 'shop' })
    expect(schema.objects).toEqual([])
    expect(schema.commentCoverage).toBe(0)
    expect(schema.truncated).toBe(false)
    expect((await store.objects({ connection: 'shop' })).objects).toEqual([])
  })
})

describe('lookup tolerances', () => {
  it('answers a blank lookup with no matches instead of scanning', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    expect(lookupObject(db, '   ')).toEqual({ matches: [], suggestions: [] })
    // No usable word at all: the LIKE fallback has nothing to look for.
    expect(suggestObjects(db, [])).toEqual([])
    dlose: {
      db.close()
    }
    const store = storeOver(root)
    await expect(store.columns({ connection: 'shop', object: 'zzzz' })).rejects.toMatchObject({
      code: 'DBGRAPH_UNKNOWN_OBJECT',
      message: expect.stringContaining('similar: none'),
    })
  })

  it('reports ambiguity for a bare name two schemas share', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.exec(
      `INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
       VALUES (30, 'table', 'public', 'account', NULL, NULL, 1),
              (31, 'table', 'other', 'account', NULL, NULL, 1)`,
    )
    const lookup = lookupObject(db, 'account')
    expect(lookup.record).toBeUndefined()
    expect(lookup.matches.map(match => `${match.schema}.${match.name}`)).toEqual([
      'public.account',
      'other.account',
    ])
    db.close()
    const store = storeOver(root)
    await expect(store.columns({ connection: 'shop', object: 'account' })).rejects.toMatchObject({
      code: 'DBGRAPH_UNKNOWN_OBJECT',
      message: expect.stringContaining('matches: public.account, other.account'),
    })
    // Relation traversal refuses an ambiguous name the same way.
    await expect(store.refs({ connection: 'shop', object: 'account' })).rejects.toMatchObject({
      code: 'DBGRAPH_UNKNOWN_OBJECT',
      message: expect.stringContaining('matches: public.account, other.account'),
    })
  })

  it('treats an FTS-hostile word as a LIKE-only query', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.exec(
      `INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
       VALUES (40, 'table', '', 'alpha_beta', NULL, NULL, 1),
              (41, 'table', '', 'gamma_delta', '注释', 900, 1)`,
    )
    expect(suggestObjects(db, ['!!!'])).toEqual([])
    db.close()
    const store = storeOver(root)
    // `_` tokenizes to nothing, so only the LIKE scan can answer.
    const listing = await store.objects({ connection: 'shop', query: '_' })
    expect(listing.objects.map(entry => entry.object)).toEqual(['alpha_beta', 'gamma_delta'])
    expect(listing.objects.find(entry => entry.object === 'gamma_delta')).toMatchObject({
      comment: '注释',
      rowEstimate: 900,
    })
  })
})

describe('the FTS rank merge', () => {
  it('keeps the best rank per object, whichever document kind provides it', () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.exec(
      `INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
       VALUES (40, 'table', '', 'forty', NULL, NULL, 1), (41, 'table', '', 'fortyone', NULL, NULL, 1)`,
    )
    const insertColumn = db.prepare(
      `INSERT INTO columns (id, object_id, ordinal, name, type, type_class, nullable, default_value,
         comment, is_primary_key, is_unique, enum_values_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insertColumn.run(50, 40, 1, 'member', 'text', 'text', 1, null, null, 0, 0, null, 1)
    insertColumn.run(51, 41, 1, 'member', 'text', 'text', 1, null, null, 0, 0, null, 1)
    // A column whose object is unknown: the join yields no object id, so the hit is dropped.
    insertColumn.run(52, null, 1, 'member', 'text', 'text', 1, null, null, 0, 0, null, 1)
    db.exec(
      `INSERT INTO search (text, object_id, column_id) VALUES
         ('member member member', 40, NULL),
         ('member', NULL, 50),
         ('member', 41, NULL),
         ('member member member', NULL, 51),
         ('member', NULL, 52),
         ('member', 999, NULL)`,
    )
    // Object 40's column document ranks better than its long object document (lower is better);
    // object 41 is the reverse. Both merge directions must survive.
    const ids = ftsObjectIds(db, 'member', 10)
    expect([...ids].sort((left, right) => left - right)).toEqual([40, 41, 999])
    db.close()

    // A hit whose object row is gone is dropped from the listing instead of crashing it.
    const store = storeOver(root)
    return store.objects({ connection: 'shop', query: 'member' }).then(listing => {
      expect([...listing.objects.map(entry => entry.object)].sort()).toEqual(['forty', 'fortyone'])
    })
  })
})

describe('FTS failures', () => {
  it('falls back to a LIKE answer when SQLite rejects the MATCH expression', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A bare boolean operator is a MATCH syntax error, the one failure a listing may survive.
      expect(ftsObjectIds(db, 'AND', 5)).toEqual([])
      expect(String(errors.mock.calls[0]?.[0])).toContain('rejected the query')
    } finally {
      errors.mockRestore()
      db.close()
    }
  })

  it('rethrows a real fault instead of reporting no hits', () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    db.exec('DROP TABLE search')
    try {
      expect(() => ftsObjectIds(db, 'member', 5)).toThrow()
    } finally {
      db.close()
    }
  })
})
