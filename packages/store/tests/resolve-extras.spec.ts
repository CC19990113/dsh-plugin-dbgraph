/**
 * Resolver paths the six contract rules do not reach on their own: concept construction from a mixed
 * entity, refusals with and without suggestions, candidate columns on an ambiguous answer, the column
 * cap inside a `where`-only match, and the fuzzy tier's no-improvement case.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { AliasGroup, RawCatalog } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { buildEntityConcepts } from '../src/resolve.ts'
import {
  SAMPLE,
  column,
  foreignIndex,
  makeRoot,
  removeRoot,
  seed,
  table,
  wideTable,
} from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []
const ALIASES: readonly AliasGroup[] = [
  { meaning: 'user', words: ['user', '用户'] },
  // Two words no entity can mention: one folds to nothing, the other tokenizes to nothing.
  { meaning: 'nothing', words: ['   ', '!!!'] },
]

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
})

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

async function seeded(snapshot: RawCatalog = SAMPLE): Promise<ReturnType<typeof createStore>> {
  const root = freshRoot()
  const { store } = await seed(root, 'shop', snapshot)
  stores.push(store)
  return store
}

describe('buildEntityConcepts', () => {
  it('turns a matched alias group into one concept and keeps the uncovered CJK run', () => {
    const concepts = buildEntityConcepts('系统用户', ALIASES)
    expect(concepts.map(concept => [...concept.tokens])).toEqual([
      ['user', '用户'],
      ['系统', '统用'],
    ])
  })

  it('keeps an ASCII word the alias group did not account for', () => {
    const concepts = buildEntityConcepts('user abc', ALIASES)
    expect(concepts.map(concept => [...concept.tokens])).toEqual([['user', '用户'], ['abc']])
  })

  it('produces nothing for an entity with no usable word', () => {
    expect(buildEntityConcepts('!!!', ALIASES)).toEqual([])
    expect(buildEntityConcepts('', ALIASES)).toEqual([])
  })

  it('leaves no leftover concept when the group covers the whole entity', () => {
    expect(buildEntityConcepts('用户', ALIASES).map(concept => [...concept.tokens])).toEqual([['user', '用户']])
  })
})

describe('refusals', () => {
  it('answers an unknown entity without inventing a suggestion', async () => {
    const store = await seeded()
    const resolution = await store.resolve({ connection: 'shop', entity: 'qqqvvv' })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('可先用 dbgraph objects')
  })

  it('answers an unknown object name the same way, including one with no tokens', async () => {
    const store = await seeded()
    for (const object of ['zzzz', '!!!']) {
      const resolution = await store.resolve({ connection: 'shop', object })
      expect(resolution.status, object).toBe('not_found')
      expect(resolution.reason, object).toContain('可先用 dbgraph objects')
    }
  })

  it('answers not_found for a field and a where key that fold to nothing', async () => {
    const store = await seeded()
    const field = await store.resolve({ connection: 'shop', object: 'sys_user', fields: ['!!'] })
    expect(field.status).toBe('not_found')
    const where = await store.resolve({ connection: 'shop', object: 'sys_user', where: { '!!': 1 } })
    expect(where.status).toBe('not_found')
    expect(where.reason).toContain('where 条件用')
  })

  it('names the column cap when refusing a field on a wide table', async () => {
    const store = await seeded()
    const resolution = await store.resolve({ connection: 'shop', object: 'wide_table', fields: ['nope'] })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('等 300 列')
  })
})

describe('candidate columns', () => {
  it('shows matched columns on an ambiguous entity answer', async () => {
    const store = await seeded()
    const resolution = await store.resolve({ connection: 'shop', entity: '用户', fields: ['id'] })
    expect(resolution.status).toBe('ambiguous')
    expect(resolution.candidates?.every(candidate => candidate.columns.length > 0)).toBe(true)
  })
})

describe('objects with no columns', () => {
  it('resolves an empty table with an explicit "no columns" reason', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: 1,
      level: 'l1',
      objects: [table('empty', [])],
    })
    const resolved = await store.resolve({ connection: 'shop', object: 'empty' })
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolved?.columns).toEqual([])
    expect(resolved.reason).toContain('字段：（无）')

    const refused = await store.resolve({ connection: 'shop', object: 'empty', fields: ['x'] })
    expect(refused.status).toBe('not_found')
    expect(refused.reason).toContain('可用列：（无）')
  })
})

describe('fuzzy tier', () => {
  it('keeps the strictly better candidate and does not count a worse one as a tie', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: 1,
      level: 'l2',
      objects: [table('accounts', [
        column('user_flurbox', 1, 'varchar(64)'),
        column('flurboxy', 2, 'varchar(64)'),
      ])],
    })
    // `flur_box` folds to `flurbox`, which is a name *token* of the first column but not its name, so
    // only the fuzzy tier can see it — and the second column's one-edit miss must not count as a tie.
    const resolution = await store.resolve({ connection: 'shop', object: 'accounts', fields: ['flur_box'] })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.columns[0]).toMatchObject({ column: 'user_flurbox', matchedBy: 'fuzzy' })
  })
})

describe('where-only matching at the column cap', () => {
  it('matches what the cap exposes and reports the tables it cannot fully check', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: 1,
      level: 'l1',
      objects: [wideTable('big', 520), table('small', [column('c520', 1, 'int')])],
    })
    const resolution = await store.resolve({ connection: 'shop', where: { c520: 1 } })
    expect(resolution.status).toBe('ambiguous')
    const byObject = new Map((resolution.candidates ?? []).map(candidate => [candidate.object, candidate]))
    expect(byObject.get('small')?.columns.map(match => match.column)).toEqual(['c520'])
    // The wide table owns the column, but the 500-column cap hides it from the match list.
    expect(byObject.get('big')?.columns).toEqual([])
  })
})

describe('ambiguity and reason rendering', () => {
  it('refuses a bare object name two schemas share, listing both', async () => {
    const store = await seeded({
      engine: 'postgres',
      database: 'app',
      fetchedAt: 1,
      level: 'l1',
      objects: [
        table('account', [column('id', 1, 'int')], { schema: 'public' }),
        table('account', [column('id', 1, 'int')], { schema: 'other' }),
      ],
    })
    const resolution = await store.resolve({ connection: 'shop', object: 'account' })
    expect(resolution.status).toBe('ambiguous')
    expect(resolution.candidates?.map(candidate => candidate.object)).toEqual([
      'public.account',
      'other.account',
    ])
    expect(resolution.reason).toContain('schema 限定名称')
  })

  it('summarises a resolved answer with many matched columns', async () => {
    const store = await seeded()
    const resolution = await store.resolve({ connection: 'shop', object: 'wide_table' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.reason).toContain('等 300 列')
  })

  it('keeps the tables whose where-key buckets overlap', async () => {
    const store = await seeded()
    const resolution = await store.resolve({ connection: 'shop', where: { id: 1, user_id: 2 } })
    expect(resolution.status).toBe('ambiguous')
    expect(resolution.candidates?.map(candidate => candidate.object)).toEqual(
      expect.arrayContaining(['audit_log', 'orders']),
    )
  })
})

describe('entity concepts across scripts', () => {
  it('splits a CJK/ASCII entity into runs and keeps each uncovered run', () => {
    expect(buildEntityConcepts('用户abc订单', ALIASES).map(concept => [...concept.tokens])).toEqual([
      ['user', '用户'],
      ['abc'],
      ['订单'],
    ])
  })
})

describe('a foreign index the resolver must still read', () => {
  /** Insert the minimal rows a resolver query walks, with NULLs the writer never produces. */
  function seedForeign(root: string): void {
    const db = foreignIndex(root)
    db.exec(
      `INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
       VALUES (2, 'table', '', 'named', NULL, NULL, 1)`,
    )
    const insertColumn = db.prepare(
      `INSERT INTO columns (id, object_id, ordinal, name, type, type_class, nullable, default_value,
         comment, is_primary_key, is_unique, enum_values_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insertColumn.run(10, 2, 1, null, 'text', 'text', 1, null, null, 0, 0, null, 1)
    insertColumn.run(11, null, 2, 'orphan', 'text', 'text', 1, null, null, 0, 0, null, 1)
    insertColumn.run(12, 2, 3, '---', 'text', 'text', 1, null, null, 0, 0, null, 1)
    db.close()
  }

  it('answers an entity with no usable word without touching the index', async () => {
    const store = await seeded()
    const resolution = await store.resolve({ connection: 'shop', entity: '!!!' })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('可先用')
  })

  it('skips term rows whose weight or object cannot be read', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    const insert = db.prepare('INSERT INTO terms (term, weight, object_id, column_id) VALUES (?, ?, ?, ?)')
    insert.run('member', null, 999, null)
    insert.run('memberq', 1, null, null)
    db.close()
    const store = createStore({ root })
    stores.push(store)
    const resolution = await store.resolve({ connection: 'shop', entity: 'member memberq' })
    expect(resolution.status).toBe('not_found')
  })

  it('walks columns with NULL names and object ids without failing', async () => {
    const root = freshRoot()
    seedForeign(root)
    const store = createStore({ root })
    stores.push(store)
    const resolution = await store.resolve({ connection: 'shop', where: { absent: 1 } })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('absent')
  })

  it('falls through zero weight evidence to the FTS recall net, then refuses a dangling hit', async () => {
    const root = freshRoot()
    const db = foreignIndex(root)
    // Weight 0 is weaker evidence than nothing: the term tier scores it away.
    db.prepare('INSERT INTO terms (term, weight, object_id, column_id) VALUES (?, ?, ?, ?)')
      .run('member', 0, 999, null)
    // The FTS index still recalls an object, but that object's row is gone.
    db.prepare('INSERT INTO search (text, object_id, column_id) VALUES (?, ?, ?)').run('member', 999, null)
    db.close()
    const store = createStore({ root })
    stores.push(store)
    const resolution = await store.resolve({ connection: 'shop', entity: 'member' })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('member')
  })
})
