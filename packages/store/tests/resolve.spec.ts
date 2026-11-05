/**
 * The resolver: the six contract rules, every status, and each column-match tier.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from '../src/index.ts'
import { DEFAULT_RESOLVE_OPTIONS } from '../src/resolve.ts'
import type { RawCatalog } from 'dsh-plugin-dbgraph-service'
import {
  SAMPLE,
  SQLITE_SAMPLE,
  column,
  makeRoot,
  removeRoot,
  seed,
  table,
  wideTable,
} from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
})

async function shop(config: Parameters<typeof createStore>[0] = {}): Promise<ReturnType<typeof createStore>> {
  const root = makeRoot()
  roots.push(root)
  const { store } = await seed(root, 'shop', SAMPLE, config)
  stores.push(store)
  return store
}

async function lite(): Promise<ReturnType<typeof createStore>> {
  const root = makeRoot()
  roots.push(root)
  const { store } = await seed(root, 'lite', SQLITE_SAMPLE)
  stores.push(store)
  return store
}

describe('defaults', () => {
  it('ships the contracted confidence gate and tie margin', () => {
    expect(DEFAULT_RESOLVE_OPTIONS.minConfidence).toBe(0.6)
    expect(DEFAULT_RESOLVE_OPTIONS.ambiguityGap).toBe(0.15)
    expect(DEFAULT_RESOLVE_OPTIONS.maxCandidates).toBe(5)
  })
})

describe('rule 1 — object names a table outright', () => {
  it('resolves with confidence 1 and builds an engine-quoted predicate', async () => {
    const store = await shop()
    const resolution = await store.resolve({
      connection: 'shop',
      object: 'sys_user',
      fields: ['password', 'phone'],
      where: { status: '1', user_name: '张三' },
    })
    expect(resolution.status).toBe('resolved')
    expect(resolution.confidence).toBe(1)
    expect(resolution.resolved?.object).toBe('sys_user')
    expect(resolution.resolved?.columns.map(entry => entry.column)).toEqual(['password', 'phone'])
    expect(resolution.resolved?.columns.every(entry => entry.matchedBy === 'name')).toBe(true)
    expect(resolution.predicate).toEqual({
      clause: 'WHERE `status` = ? AND `user_name` = ?',
      values: ['1', '张三'],
    })
    expect(resolution.reason).toContain('sys_user')
    expect(resolution.reason).toContain('条件：WHERE')
  })

  it('matches the table name case-insensitively', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', object: 'SYS_USER' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('sys_user')
  })

  it('quotes predicate identifiers the way the engine expects', async () => {
    const store = await lite()
    const resolution = await store.resolve({ connection: 'lite', object: 'note', where: { status: 'draft' } })
    expect(resolution.predicate).toEqual({ clause: 'WHERE "status" = ?', values: ['draft'] })
  })

  it('reports not_found with suggestions when the table does not exist', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', object: 'sys_userr' })
    expect(resolution.status).toBe('not_found')
    expect(resolution.confidence).toBe(0)
    expect(resolution.reason).toContain('没有名为')
    expect(resolution.reason).toContain('sys_user')
  })
})

describe('rule 2 — entity and fields resolve through names, comments, aliases, fuzzy', () => {
  it('finds the table from a Chinese word through the alias table and a column name', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', entity: '密码' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('sys_user')
    expect(resolution.confidence).toBeGreaterThanOrEqual(0.6)
    // Fields were not requested, so every column is part of the answer.
    expect(resolution.resolved?.columns).toHaveLength(8)
  })

  it('resolves an entity that folds to the exact table name', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', entity: 'sys_user' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('sys_user')
    expect(resolution.confidence).toBe(1)
    expect(resolution.reason).toContain('表名精确匹配')
  })

  it('finds the table from a Chinese comment word', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', entity: '部门' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('sys_dept')
  })

  it('finds the table from a Chinese word only its column carries', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', entity: '头像' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('user_profile')
    expect(resolution.confidence).toBeGreaterThan(0.6)
  })

  it('finds the same table from the English spelling', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', entity: 'avatar' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('user_profile')
  })

  it('records how each field matched', async () => {
    const store = await shop()
    const cases = [
      { field: 'password', column: 'password', matchedBy: 'name' },
      { field: 'name', column: 'user_name', matchedBy: 'name-part' },
      { field: '登录密码', column: 'password', matchedBy: 'comment' },
      { field: '电话', column: 'phone', matchedBy: 'synonym' },
      { field: 'pasword', column: 'password', matchedBy: 'fuzzy' },
    ] as const
    for (const expected of cases) {
      const resolution = await store.resolve({
        connection: 'shop',
        object: 'sys_user',
        fields: [expected.field],
      })
      expect(resolution.status, expected.field).toBe('resolved')
      const match = resolution.resolved?.columns[0]
      expect(match?.column, expected.field).toBe(expected.column)
      expect(match?.matchedBy, expected.field).toBe(expected.matchedBy)
      expect(match?.term, expected.field).toBe(expected.field)
    }
  })

  it('refuses a field the table does not have, and lists what it does have', async () => {
    const store = await shop()
    const resolution = await store.resolve({
      connection: 'shop',
      object: 'sys_user',
      fields: ['password', 'nonexistent_field'],
    })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('nonexistent_field')
    expect(resolution.reason).toContain('可用列')
    expect(resolution.reason).toContain('user_name')
    // The object that was identified is still reported, so the caller can correct one word.
    expect(resolution.resolved?.object).toBe('sys_user')
  })
})

describe('rule 3 — ambiguity is reported, never guessed', () => {
  it('refuses to choose between two tables the entity names equally', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', entity: '用户' })
    expect(resolution.status).toBe('ambiguous')
    expect(resolution.predicate).toBeUndefined()
    expect(resolution.resolved).toBeUndefined()
    const names = resolution.candidates?.map(entry => entry.object) ?? []
    expect(names).toContain('sys_user')
    expect(names).toContain('user_profile')
    expect(names.length).toBeLessThanOrEqual(5)
    expect(resolution.reason).toContain('不是唯一匹配')
  })

  it('returns ambiguous when the best candidate is below the gate', async () => {
    const store = await shop({ minConfidence: 0.95 })
    const resolution = await store.resolve({ connection: 'shop', entity: '密码' })
    expect(resolution.status).toBe('ambiguous')
    expect(resolution.confidence).toBeLessThan(0.95)
    expect(resolution.candidates?.[0]?.object).toBe('sys_user')
  })

  it('refuses between two tables when the top-two margin is under the gap', async () => {
    // Both tables have a user_id column and neither name matches; the tie is by definition under 0.15.
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', where: { user_id: 1 } })
    expect(resolution.status).toBe('ambiguous')
    expect(resolution.candidates?.length).toBeGreaterThan(1)
  })
})

describe('rule 4 — where keys must really exist', () => {
  it('refuses an unknown key and lists the available columns', async () => {
    const store = await shop()
    const resolution = await store.resolve({
      connection: 'shop',
      object: 'sys_user',
      where: { nope: 'x' },
    })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('nope')
    expect(resolution.reason).toContain('可用列')
    expect(resolution.reason).toContain('password')
    expect(resolution.predicate).toBeUndefined()
  })

  it('validates where keys after an entity resolution too', async () => {
    const store = await shop()
    const resolution = await store.resolve({
      connection: 'shop',
      entity: '部门',
      where: { none_such: 1 },
    })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('sys_dept')
  })

  it('accepts a key whose spelling differs by case and separators', async () => {
    const store = await shop()
    const resolution = await store.resolve({
      connection: 'shop',
      object: 'sys_user',
      where: { USER_NAME: '李四' },
    })
    expect(resolution.status).toBe('resolved')
    expect(resolution.predicate).toEqual({ clause: 'WHERE `user_name` = ?', values: ['李四'] })
  })
})

describe('rule 5 — nothing identifies a table', () => {
  it('answers missing_predicate rather than scanning', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop' })
    expect(resolution.status).toBe('missing_predicate')
    expect(resolution.confidence).toBe(0)
    expect(resolution.predicate).toBeUndefined()
    expect(resolution.reason).toContain('不会生成全表查询')
  })

  it('treats blank entity and empty where the same way', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', entity: '   ', where: {}, fields: ['id'] })
    expect(resolution.status).toBe('missing_predicate')
  })
})

describe('where-only resolution', () => {
  it('resolves when exactly one table has every named column', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', where: { amount: '100' } })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.object).toBe('orders')
    expect(resolution.confidence).toBe(0.7)
    expect(resolution.predicate).toEqual({ clause: 'WHERE `amount` = ?', values: ['100'] })
  })

  it('stays ambiguous when several tables qualify', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', where: { user_id: 1 } })
    expect(resolution.status).toBe('ambiguous')
    expect(resolution.predicate).toBeUndefined()
    expect(resolution.candidates?.map(entry => entry.object)).toEqual(
      expect.arrayContaining(['audit_log', 'orders', 'user_profile']),
    )
  })

  it('answers not_found when no table has all the keys', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', where: { amount: 1, nickname: 'a' } })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('没有一张表同时包含')
  })

  it('answers not_found when no table has the key at all', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', where: { totally_absent: 1 } })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('totally_absent')
  })
})

describe('predicate shape', () => {
  it('binds values in request order and never inlines them into the clause', async () => {
    const store = await shop()
    const resolution = await store.resolve({
      connection: 'shop',
      object: 'orders',
      where: { status: 'paid', amount: 12.5 },
    })
    expect(resolution.predicate).toEqual({
      clause: 'WHERE `status` = ? AND `amount` = ?',
      values: ['paid', 12.5],
    })
    expect(resolution.predicate?.clause).not.toContain('paid')
  })

  it('omits the predicate when there is no condition', async () => {
    const store = await shop()
    const resolution = await store.resolve({ connection: 'shop', object: 'orders' })
    expect(resolution.status).toBe('resolved')
    expect(resolution.predicate).toBeUndefined()
  })
})

describe('registry errors', () => {
  it('reports an unindexed connection as not found rather than empty', async () => {
    const store = await shop()
    await expect(store.resolve({ connection: 'never_indexed', object: 'sys_user' })).rejects.toMatchObject({
      code: 'DBGRAPH_UNAVAILABLE',
    })
  })
})

describe('rule 2 — column bounds, fuzzy bounds, and non-Latin identifiers', () => {
  async function seeded(snapshot: RawCatalog): Promise<ReturnType<typeof createStore>> {
    const root = makeRoot()
    roots.push(root)
    const { store } = await seed(root, 'shop', snapshot)
    stores.push(store)
    return store
  }

  it('refuses a short field one edit away from a real column', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: Date.now(),
      level: 'l2',
      objects: [table('metrics', [
        column('id', 1, 'bigint', { isPrimaryKey: true }),
        column('flat', 2, 'int'),
      ])],
    })
    // `flag` is one substitution from `flat`; answering with `flat` would be a silent wrong column.
    const resolution = await store.resolve({ connection: 'shop', object: 'metrics', fields: ['flag'] })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('flag')
  })

  it('refuses when a short column name is one edit from the field', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: Date.now(),
      level: 'l2',
      objects: [table('accounts', [
        column('passw', 1, 'varchar(64)'),
      ])],
    })
    // `passw` is one edit from `passwd`, but a 5-character ident is under the fuzzy floor: answering
    // with it would be exactly the near-miss the floor exists to refuse.
    const resolution = await store.resolve({ connection: 'shop', object: 'accounts', fields: ['passwd'] })
    expect(resolution.status).toBe('not_found')
    expect(resolution.reason).toContain('passwd')
  })

  it('still resolves a long-enough column one edit from the field', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: Date.now(),
      level: 'l2',
      objects: [table('accounts', [
        column('passwrd', 1, 'varchar(64)'),
      ])],
    })
    // The floor applies to the candidate, not to the whole rule: a 7-character column still matches.
    const resolution = await store.resolve({ connection: 'shop', object: 'accounts', fields: ['passwd'] })
    expect(resolution.status).toBe('resolved')
    expect(resolution.resolved?.columns[0]?.column).toBe('passwrd')
    expect(resolution.resolved?.columns[0]?.matchedBy).toBe('fuzzy')
  })

  it('refuses when two long names are one edit from the field', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: Date.now(),
      level: 'l2',
      objects: [table('accounts', [
        column('passward', 1, 'varchar(64)'),
        column('pasaword', 2, 'varchar(64)'),
      ])],
    })
    const resolution = await store.resolve({ connection: 'shop', object: 'accounts', fields: ['password'] })
    expect(resolution.status).toBe('not_found')
  })

  it('names the column cap instead of claiming a wide table has no such field', async () => {
    const store = await seeded({ ...SAMPLE, objects: [wideTable('big', 520)] })
    const missing = await store.resolve({ connection: 'shop', object: 'big', fields: ['c520'] })
    expect(missing.status).toBe('not_found')
    expect(missing.reason).toContain('只检查了前 500 列')
    const inside = await store.resolve({ connection: 'shop', object: 'big', fields: ['c500'] })
    expect(inside.status).toBe('resolved')
    expect(inside.resolved?.columns[0]?.column).toBe('c500')
  })

  it('resolves fields and a predicate on Cyrillic identifiers', async () => {
    const store = await seeded({
      engine: 'mysql',
      database: 'shop',
      fetchedAt: Date.now(),
      level: 'l2',
      objects: [table('клиенты', [
        column('id', 1, 'bigint', { isPrimaryKey: true }),
        column('имя', 2, 'varchar(64)', { comment: 'имя клиента' }),
      ])],
    })
    const byField = await store.resolve({ connection: 'shop', object: 'клиенты', fields: ['имя'] })
    expect(byField.status).toBe('resolved')
    expect(byField.resolved?.columns[0]?.column).toBe('имя')
    expect(byField.resolved?.columns[0]?.matchedBy).toBe('name')
    const byWhere = await store.resolve({ connection: 'shop', object: 'клиенты', where: { 'имя': 'Иван' } })
    expect(byWhere.status).toBe('resolved')
    expect(byWhere.predicate).toEqual({ clause: 'WHERE `имя` = ?', values: ['Иван'] })
  })
})
