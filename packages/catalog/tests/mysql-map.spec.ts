import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, RawColumn, RawObject } from 'dsh-plugin-dbgraph-service'
import {
  groupMysqlColumns,
  groupMysqlForeignKeys,
  groupMysqlIndexes,
  isStringishMysqlType,
  mergeMysqlObject,
  mysqlColumnComments,
  mysqlColumnKey,
  mysqlTableFacts,
  shouldSampleMysqlColumn,
} from '../src/mysql-map.ts'
import type {
  MysqlColumnRow,
  MysqlForeignKeyRow,
  MysqlIndexRow,
  MysqlTableRow,
} from '../src/mysql-map.ts'

const TABLE_ROWS: MysqlTableRow[] = [
  { TABLE_NAME: 'accounts', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '账户表', TABLE_ROWS: '42' },
  { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: null },
  { TABLE_NAME: 'v_users', TABLE_TYPE: 'VIEW', TABLE_COMMENT: 'VIEW', TABLE_ROWS: null },
]

const COLUMN_ROWS: MysqlColumnRow[] = [
  {
    TABLE_NAME: 'users',
    COLUMN_NAME: 'id',
    ORDINAL_POSITION: 1,
    COLUMN_TYPE: 'bigint(20) unsigned',
    IS_NULLABLE: 'NO',
    COLUMN_DEFAULT: null,
    COLUMN_KEY: 'PRI',
    COLUMN_COMMENT: '',
  },
  {
    TABLE_NAME: 'users',
    COLUMN_NAME: 'name',
    ORDINAL_POSITION: 2,
    COLUMN_TYPE: 'varchar(64)',
    IS_NULLABLE: 'NO',
    COLUMN_DEFAULT: '',
    COLUMN_KEY: '',
    COLUMN_COMMENT: '姓名',
  },
  {
    TABLE_NAME: 'users',
    COLUMN_NAME: 'email',
    ORDINAL_POSITION: 3,
    COLUMN_TYPE: 'varchar(255)',
    IS_NULLABLE: 'YES',
    COLUMN_DEFAULT: null,
    COLUMN_KEY: 'UNI',
    COLUMN_COMMENT: '邮箱',
  },
]

describe('mysqlTableFacts', () => {
  it('reads kind, a real comment and a row estimate', () => {
    expect(mysqlTableFacts(TABLE_ROWS[0] as MysqlTableRow)).toEqual({
      kind: 'table',
      comment: '账户表',
      rowEstimate: 42,
    })
  })

  it('drops an empty comment and an unknown row count', () => {
    expect(mysqlTableFacts(TABLE_ROWS[1] as MysqlTableRow)).toEqual({ kind: 'table' })
  })

  it('treats the synthetic VIEW comment as no comment at all', () => {
    expect(mysqlTableFacts(TABLE_ROWS[2] as MysqlTableRow)).toEqual({ kind: 'view' })
  })

  it('accepts a numeric row estimate as well as a string one', () => {
    expect(mysqlTableFacts({ TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 7 }).rowEstimate).toBe(7)
  })

  it('treats a row with no TABLE_TYPE as a base table and no comment', () => {
    expect(mysqlTableFacts({ TABLE_NAME: 'bare' })).toEqual({ kind: 'table' })
  })
})

describe('groupMysqlColumns', () => {
  it('groups by table in declared order with declared facts', () => {
    const grouped = groupMysqlColumns([...COLUMN_ROWS].reverse())
    const users = grouped.get('users')
    expect(users?.map(column => column.name)).toEqual(['id', 'name', 'email'])

    const id = users?.[0]
    expect(id).toMatchObject({
      ordinal: 1,
      type: 'bigint(20) unsigned',
      nullable: false,
      isPrimaryKey: true,
    })
    expect(id && 'defaultValue' in id).toBe(false)

    const name = users?.[1]
    expect(name).toMatchObject({ nullable: false, isPrimaryKey: false, defaultValue: '' })
  })

  it('does not claim a single-column unique from COLUMN_KEY UNI', () => {
    const email = groupMysqlColumns(COLUMN_ROWS).get('users')?.[2]
    expect(email && 'isUnique' in email).toBe(false)
  })

  it('falls back to defaults when a row omits its facts', () => {
    const grouped = groupMysqlColumns([
      { TABLE_NAME: 'sparse', COLUMN_NAME: 'c' },
    ])
    expect(grouped.get('sparse')).toEqual([
      { name: 'c', ordinal: 1, type: '', nullable: true, isPrimaryKey: false },
    ])
  })

  it('drops a row the driver returned without a table or column name', () => {
    const grouped = groupMysqlColumns([
      { COLUMN_NAME: 'orphan' },
      { TABLE_NAME: 'kept' },
      { TABLE_NAME: 'kept', COLUMN_NAME: 'c' },
    ])
    expect([...grouped.keys()]).toEqual(['kept'])
    expect(grouped.get('kept')?.map(column => column.name)).toEqual(['c'])
  })
})

describe('mysqlColumnComments', () => {
  it('keys comments by table and column, dropping empties', () => {
    const comments = mysqlColumnComments(COLUMN_ROWS)
    expect(comments.get(mysqlColumnKey('users', 'name'))).toBe('姓名')
    expect(comments.get(mysqlColumnKey('users', 'email'))).toBe('邮箱')
    expect(comments.has(mysqlColumnKey('users', 'id'))).toBe(false)
    expect(comments.size).toBe(2)
  })

  it('never confuses two tables that share a column name', () => {
    const comments = mysqlColumnComments([
      { TABLE_NAME: 'a', COLUMN_NAME: 'id', COLUMN_COMMENT: 'A' },
      { TABLE_NAME: 'b', COLUMN_NAME: 'id', COLUMN_COMMENT: 'B' },
    ])
    expect(comments.get(mysqlColumnKey('a', 'id'))).toBe('A')
    expect(comments.get(mysqlColumnKey('b', 'id'))).toBe('B')
  })
})

describe('groupMysqlForeignKeys', () => {
  it('groups one constraint into one edge, ordered by ordinal', () => {
    const roots: MysqlForeignKeyRow[] = [
      {
        TABLE_NAME: 'order_items',
        CONSTRAINT_NAME: 'fk_item_tenant',
        COLUMN_NAME: 'user_id',
        ORDINAL_POSITION: 2,
        REFERENCED_TABLE_NAME: 'tenants',
        REFERENCED_COLUMN_NAME: 'user_id',
      },
      {
        TABLE_NAME: 'order_items',
        CONSTRAINT_NAME: 'fk_item_tenant',
        COLUMN_NAME: 'tenant',
        ORDINAL_POSITION: 1,
        REFERENCED_TABLE_NAME: 'tenants',
        REFERENCED_COLUMN_NAME: 'tenant',
      },
      {
        TABLE_NAME: 'orders',
        CONSTRAINT_NAME: 'fk_order_user',
        COLUMN_NAME: 'user_id',
        ORDINAL_POSITION: 1,
        REFERENCED_TABLE_NAME: 'users',
        REFERENCED_COLUMN_NAME: 'id',
      },
    ]

    const edges = groupMysqlForeignKeys(roots)
    const itemEdges = edges.get('order_items')
    expect(itemEdges).toHaveLength(1)
    expect(itemEdges?.[0]).toMatchObject({
      kind: 'fk',
      name: 'fk_item_tenant',
      columns: ['tenant', 'user_id'],
      refObject: 'tenants',
      refColumns: ['tenant', 'user_id'],
    })

    expect(edges.get('orders')?.[0]).toMatchObject({
      columns: ['user_id'],
      refObject: 'users',
      refColumns: ['id'],
    })
  })

  it('ignores rows without a referenced table', () => {
    const edges = groupMysqlForeignKeys([
      {
        TABLE_NAME: 'users',
        CONSTRAINT_NAME: 'PRIMARY',
        COLUMN_NAME: 'id',
        ORDINAL_POSITION: 1,
        REFERENCED_TABLE_NAME: null,
        REFERENCED_COLUMN_NAME: null,
      },
    ])
    expect(edges.size).toBe(0)
  })

  it('records a constraint the server did not name, ordered by its fallback position', () => {
    const edges = groupMysqlForeignKeys([
      { TABLE_NAME: 'child', COLUMN_NAME: 'b', REFERENCED_TABLE_NAME: 'parent', REFERENCED_COLUMN_NAME: 'y' },
      { TABLE_NAME: 'child', COLUMN_NAME: 'a', REFERENCED_TABLE_NAME: 'parent', REFERENCED_COLUMN_NAME: 'x' },
    ])
    const childEdges = edges.get('child')
    expect(childEdges).toHaveLength(1)
    // No ordinals were reported, so rows keep their arrival order.
    expect(childEdges?.[0]).toMatchObject({
      kind: 'fk',
      columns: ['b', 'a'],
      refObject: 'parent',
      refColumns: ['y', 'x'],
    })
    const unnamed = childEdges?.[0]
    expect(unnamed !== undefined && 'name' in unnamed).toBe(false)
  })

  it('drops a row the driver returned without a table, column or referenced side', () => {
    const edges = groupMysqlForeignKeys([
      { COLUMN_NAME: 'orphan', REFERENCED_TABLE_NAME: 'p', REFERENCED_COLUMN_NAME: 'id' },
      { TABLE_NAME: 'child', REFERENCED_TABLE_NAME: 'p', REFERENCED_COLUMN_NAME: 'id' },
      { TABLE_NAME: 'child', COLUMN_NAME: 'c', REFERENCED_COLUMN_NAME: 'id' },
      { TABLE_NAME: 'child', COLUMN_NAME: 'c', REFERENCED_TABLE_NAME: 'p' },
    ])
    expect(edges.size).toBe(0)
  })
})

describe('groupMysqlIndexes', () => {
  const rows: MysqlIndexRow[] = [
    { TABLE_NAME: 'users', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id' },
    { TABLE_NAME: 'users', INDEX_NAME: 'uq_email', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'email' },
    { TABLE_NAME: 'users', INDEX_NAME: 'uq_tenant_email', NON_UNIQUE: '0', SEQ_IN_INDEX: 2, COLUMN_NAME: 'email' },
    { TABLE_NAME: 'users', INDEX_NAME: 'uq_tenant_email', NON_UNIQUE: '0', SEQ_IN_INDEX: 1, COLUMN_NAME: 'tenant' },
    { TABLE_NAME: 'users', INDEX_NAME: 'idx_name', NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'name' },
    { TABLE_NAME: 'users', INDEX_NAME: 'idx_expression', NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: null },
    { TABLE_NAME: 'users', INDEX_NAME: 'idx_expression', NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'id' },
  ]

  it('groups rows into index edges with columns in index order', () => {
    const facts = groupMysqlIndexes(rows)
    const edges = facts.edges.get('users') ?? []
    expect(edges.map(edge => edge.name)).toEqual(['PRIMARY', 'uq_email', 'uq_tenant_email', 'idx_name'])

    const composite = edges.find(edge => edge.name === 'uq_tenant_email')
    expect(composite).toMatchObject({ columns: ['tenant', 'email'], unique: true })
    expect(edges.find(edge => edge.name === 'idx_name')).toMatchObject({ unique: false })
  })

  it('skips a functional index that has no column names', () => {
    const edges = groupMysqlIndexes(rows).edges.get('users') ?? []
    expect(edges.some(edge => edge.name === 'idx_expression')).toBe(false)
  })

  it('reports only single-column unique indexes as column uniqueness', () => {
    const facts = groupMysqlIndexes(rows)
    expect([...(facts.singleUnique.get('users') ?? [])].sort()).toEqual(['email', 'id'])
  })

  it('orders parts by a fallback position when SEQ_IN_INDEX is missing', () => {
    const facts = groupMysqlIndexes([
      { TABLE_NAME: 't', INDEX_NAME: 'idx', NON_UNIQUE: 1, COLUMN_NAME: 'b' },
      { TABLE_NAME: 't', INDEX_NAME: 'idx', NON_UNIQUE: 1, COLUMN_NAME: 'a' },
    ])
    expect(facts.edges.get('t')?.[0]).toMatchObject({ name: 'idx', columns: ['b', 'a'] })
  })

  it('drops a row the driver returned without a table or index name', () => {
    const facts = groupMysqlIndexes([
      { INDEX_NAME: 'orphan', NON_UNIQUE: 1, COLUMN_NAME: 'a' },
      { TABLE_NAME: 't', NON_UNIQUE: 1, COLUMN_NAME: 'a' },
      { TABLE_NAME: 't', INDEX_NAME: 'idx', NON_UNIQUE: 1, COLUMN_NAME: 'a' },
    ])
    expect([...facts.edges.keys()]).toEqual(['t'])
    expect(facts.edges.get('t')?.map(edge => edge.name)).toEqual(['idx'])
  })
})

describe('isStringishMysqlType', () => {
  it('accepts character, text, enum and set types', () => {
    for (const type of ['char(1)', 'varchar(64)', 'nchar(2)', 'tinytext', 'text', 'mediumtext', 'longtext', "enum('a','b')", "set('x','y')"]) {
      expect(isStringishMysqlType(type)).toBe(true)
    }
  })

  it('rejects numeric, temporal, binary and JSON types', () => {
    for (const type of ['int(11)', 'bigint(20) unsigned', 'decimal(10,2)', 'datetime', 'json', 'varbinary(8)', 'blob', 'tinyint(1)']) {
      expect(isStringishMysqlType(type)).toBe(false)
    }
  })
})

describe('shouldSampleMysqlColumn', () => {
  const connection: ConnectionConfig = { id: 'prod', engine: 'mysql' }
  const column = (name: string, type: string): RawColumn => ({ name, ordinal: 1, type })

  it('samples a string column on a base table', () => {
    expect(shouldSampleMysqlColumn('table', connection, column('status', 'varchar(16)'))).toBe(true)
    expect(shouldSampleMysqlColumn('table', connection, column('kind', "enum('a','b')"))).toBe(true)
  })

  it('skips non-string columns, views and sensitive columns', () => {
    expect(shouldSampleMysqlColumn('table', connection, column('amount', 'decimal(10,2)'))).toBe(false)
    expect(shouldSampleMysqlColumn('view', connection, column('status', 'varchar(16)'))).toBe(false)
    expect(shouldSampleMysqlColumn('table', connection, column('password', 'varchar(64)'))).toBe(false)
    expect(shouldSampleMysqlColumn('table', connection, column('api_token', 'varchar(64)'))).toBe(false)
  })

  it('honours extra sensitive patterns', () => {
    const custom: ConnectionConfig = { id: 'prod', engine: 'mysql', sensitivePatterns: ['status'] }
    expect(shouldSampleMysqlColumn('table', custom, column('status', 'varchar(16)'))).toBe(false)
  })
})

describe('mergeMysqlObject', () => {
  const object: RawObject = {
    kind: 'table',
    schema: 'shop',
    name: 'users',
    columns: [
      { name: 'id', ordinal: 1, type: 'bigint(20)' },
      { name: 'password', ordinal: 2, type: 'varchar(64)' },
    ],
  }

  it('merges facts, comments, uniqueness, edges and samples onto a copy', () => {
    const merged = mergeMysqlObject(
      object,
      { kind: 'table', comment: '系统用户', rowEstimate: 42 },
      new Map([[mysqlColumnKey('users', 'password'), '密码']]),
      new Set(['id']),
      [{ kind: 'index', name: 'PRIMARY', columns: ['id'], unique: true }],
      new Map([['password', ['a', 'b']]]),
    )

    expect(merged.comment).toBe('系统用户')
    expect(merged.rowEstimate).toBe(42)
    expect(merged.edges).toHaveLength(1)
    expect(merged.columns[0]).toMatchObject({ name: 'id', isUnique: true })
    expect(merged.columns[1]).toMatchObject({
      name: 'password',
      isUnique: false,
      comment: '密码',
      enumValues: ['a', 'b'],
    })

    // The input is a snapshot; enrichment must not rewrite what L1 produced.
    expect('comment' in object).toBe(false)
    expect(object.edges).toBeUndefined()
    expect('isUnique' in (object.columns[1] as object)).toBe(false)
  })

  it('produces an L2 copy without facts or edges cleanly', () => {
    const merged = mergeMysqlObject(object, undefined, new Map(), undefined, [], new Map())
    expect('comment' in merged).toBe(false)
    expect('rowEstimate' in merged).toBe(false)
    expect(merged.edges).toBeUndefined()
    expect(merged.columns.every(column => column.isUnique === false)).toBe(true)
  })
})
