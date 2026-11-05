import { describe, expect, it } from 'vitest'
import { describeIndexState, renderDbgraph, renderDbgraphIndex } from '../src/render.ts'
import type { DbgraphIndexToolValue, DbgraphToolValue, DbgraphValueFor } from '../src/schema.ts'

const CONNECTION: DbgraphValueFor<'connections'>['connections'][number] = {
  id: 'prod',
  engine: 'mysql',
  label: '生产库',
  host: 'mysql.internal',
  database: 'shop',
  credential_configured: true,
  index: { l1_indexed_at: 1, l2_indexed_at: 2, objects: 312, columns: 6840, stale: false, writer: 'js' },
}

const OBJECT: DbgraphValueFor<'schema'>['objects'][number] = {
  object: 'sys_user',
  kind: 'table',
  comment: '系统用户',
  column_count: 18,
  row_estimate: 1200,
}

const COLUMN: DbgraphValueFor<'columns'>['columns'][number] = {
  name: 'id',
  type: 'bigint',
  nullable: false,
  default_value: '0',
  comment: '主键',
  is_primary_key: true,
  is_unique: true,
  enum_values: ['1', '2'],
}

/** One `find` value with every field a resolved answer can carry. */
function resolvedFind(): DbgraphValueFor<'find'> {
  return {
    operation: 'find',
    connection: 'prod',
    status: 'resolved',
    reason: 'matched 用户/密码 by comment and synonym',
    confidence: 0.92,
    resolved: {
      object: 'sys_user',
      kind: 'table',
      comment: '系统用户',
      score: 0.92,
      columns: [{ column: 'password', comment: '密码', matched_by: 'synonym', term: '密码', score: 0.9 }],
    },
    sql: 'SELECT `name`, `password` FROM `sys_user` LIMIT 50',
    rows: [{ name: 'alice', password: '***' }],
    row_count: 1,
    truncated: false,
    redacted: ['password'],
    elapsed_ms: 3,
  }
}

describe('describeIndexState', () => {
  it('names an index that was never built', () => {
    expect(describeIndexState({ objects: 0, columns: 0, stale: true })).toBe('not indexed')
  })

  it('reports size and age, and marks a stale index', () => {
    const fresh = describeIndexState({ l1_indexed_at: Date.now() - 60_000, objects: 3, columns: 9, stale: false })
    expect(fresh).toBe('3 表 / 9 列, 索引 1 分钟前')
    const stale = describeIndexState({ l1_indexed_at: Date.now() - 2 * 3_600_000, objects: 3, columns: 9, stale: true })
    expect(stale).toBe('3 表 / 9 列, 索引 2 小时前, 已过期')
  })

  it('reports a size with no recorded timestamp', () => {
    expect(describeIndexState({ objects: 3, columns: 9, stale: true })).toBe('3 表 / 9 列, 索引时间未记录')
    expect(describeIndexState({ objects: 3, columns: 9, stale: false })).toBe('3 表 / 9 列')
  })
})

describe('renderDbgraph', () => {
  it('names the way to configure a first connection', () => {
    const value: DbgraphValueFor<'connections'> = { operation: 'connections', connections: [] }
    expect(renderDbgraph(value)).toContain('No database connection is configured')
  })

  it('lists connections with their target, index state, and credential state', () => {
    const value: DbgraphValueFor<'connections'> = {
      operation: 'connections',
      connections: [CONNECTION, {
        id: 'local', engine: 'sqlite', database: '/tmp/app.db', credential_configured: false,
        index: { objects: 0, columns: 0, stale: true },
      }],
    }
    const text = renderDbgraph(value)
    expect(text).toContain('Connections (2):')
    expect(text).toContain('prod "生产库" (mysql) mysql.internal / shop')
    expect(text).toContain('312 表 / 6840 列')
    // A local file has no account to authenticate with, so the credential state is not reported at all.
    expect(text).toContain('local (sqlite) /tmp/app.db — not indexed')
    expect(text).not.toContain('credential missing')
  })

  it('says a schema list is empty and how to build it', () => {
    const value: DbgraphValueFor<'schema'> = {
      operation: 'schema', connection: 'prod', engine: 'mysql', database: 'shop',
      objects: [], truncated: false, comment_coverage: 0,
      index: { objects: 0, columns: 0, stale: true },
    }
    expect(renderDbgraph(value)).toContain('No object is indexed for prod')
  })

  it('renders a connection whose only target is a host', () => {
    const value: DbgraphValueFor<'connections'> = {
      operation: 'connections',
      connections: [{
        id: 'analytics', engine: 'postgres', host: 'pg.internal', credential_configured: true,
        index: { objects: 1, columns: 2, stale: false },
      }],
    }
    expect(renderDbgraph(value)).toContain('analytics (postgres) pg.internal — 1 表 / 2 列, credential configured')
  })

  it('reports a missing credential for a server connection that has none', () => {
    // A server needs an account; saying nothing would read as "nothing to configure", which is the
    // one thing a connection list must not imply.
    const value: DbgraphValueFor<'connections'> = {
      operation: 'connections',
      connections: [{
        id: 'reporting', engine: 'mysql', host: 'mysql.internal', credential_configured: false,
        index: { objects: 0, columns: 0, stale: true },
      }],
    }
    expect(renderDbgraph(value))
      .toContain('reporting (mysql) mysql.internal — not indexed, credential missing')
  })

  it('renders an object line with no comment and no row estimate', () => {
    const value: DbgraphValueFor<'objects'> = {
      operation: 'objects', connection: 'prod', truncated: false,
      objects: [{ object: 'bare', kind: 'table', column_count: 3 }],
    }
    expect(renderDbgraph(value)).toContain('bare  [table]  3 列')
  })

  it('renders a schema overview with coverage and a truncation mark', () => {
    const value: DbgraphValueFor<'schema'> = {
      operation: 'schema', connection: 'prod', engine: 'mysql', database: 'shop',
      objects: [OBJECT], truncated: true, comment_coverage: 0.78,
      index: { l1_indexed_at: Date.now() - 60_000, objects: 312, columns: 6840, stale: false },
    }
    const text = renderDbgraph(value)
    expect(text).toContain('Schema for prod (mysql / shop)')
    expect(text).toContain('注释覆盖 78%')
    expect(text).toContain('sys_user  系统用户  [table]  18 列  行数≈1200')
    expect(text).toContain('(list truncated by the object cap)')
  })

  it('renders an object listing and its empty case', () => {
    expect(renderDbgraph({ operation: 'objects', connection: 'prod', objects: [], truncated: false }))
      .toContain('No object in prod matches.')
    const text = renderDbgraph({ operation: 'objects', connection: 'prod', objects: [OBJECT], truncated: false })
    expect(text).toContain('Objects in prod (1):')
    expect(text).toContain('sys_user')
  })

  it('renders a column list with flags, default, sample values, and truncation', () => {
    const value: DbgraphValueFor<'columns'> = {
      operation: 'columns', connection: 'prod', object: 'sys_user', kind: 'table', comment: '系统用户',
      columns: [COLUMN, { name: 'nickname', type: 'varchar(64)', nullable: true, is_primary_key: false, is_unique: false }],
      truncated: true,
    }
    const text = renderDbgraph(value)
    expect(text).toContain('sys_user  系统用户  [table]  2 列:')
    expect(text).toContain('id  bigint = 0 PK NOT NULL UNIQUE  -- 主键  例: 1|2')
    expect(text).toContain('nickname  varchar(64)')
    expect(text).toContain('(list truncated by the column cap)')
  })

  it('renders an object with no indexed column', () => {
    expect(renderDbgraph({
      operation: 'columns', connection: 'prod', object: 'empty', kind: 'table', columns: [], truncated: false,
    })).toContain('(no column is indexed)')
  })

  it('renders a resolved find as a row table with the statement and the mask', () => {
    const text = renderDbgraph(resolvedFind())
    expect(text).toContain('find → sys_user 系统用户  (confidence 0.92')
    expect(text).toContain('Columns: password 密码 [synonym]')
    expect(text).toContain('SQL: SELECT `name`, `password` FROM `sys_user` LIMIT 50')
    expect(text).toContain('1 row:')
    expect(text).toContain('  name | password')
    expect(text).toContain('  "alice"')
    expect(text).toContain('Masked: password')
  })

  it('renders a resolved find that carries no target, statement, or rows', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'resolved', reason: 'the store answered', confidence: 1, elapsed_ms: 1,
    }
    expect(renderDbgraph(value)).toBe('find → prod  (confidence 1.00, 1 ms)')
  })

  it('renders a resolved find whose target matched no column and whose rows are blank', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find',
      connection: 'prod',
      status: 'resolved',
      reason: 'the table was named outright',
      confidence: 1,
      resolved: { object: 'sys_user', kind: 'table', score: 1, columns: [] },
      rows: [{}],
      elapsed_ms: 2,
    }
    const text = renderDbgraph(value)
    expect(text).not.toContain('Columns:')
    expect(text).toContain('(no rows) — 0 returned')
  })

  it('falls back to the resolved candidate when a non-resolved answer lists none', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'not_found', reason: 'no predicate', confidence: 0.4,
      resolved: { object: 'sys_user', kind: 'table', score: 0.4, columns: [] }, elapsed_ms: 1,
    }
    const text = renderDbgraph(value)
    expect(text).toContain('Candidates (1):')
    expect(text).toContain('  sys_user  (0.40)')
  })

  it('renders a candidate comment when the resolver recorded one', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'ambiguous', reason: 'close call', confidence: 0.5,
      candidates: [{ object: 'sys_user', kind: 'table', comment: '系统用户', score: 0.5, columns: [] }],
      elapsed_ms: 1,
    }
    expect(renderDbgraph(value)).toContain('sys_user 系统用户  (0.50)')
  })

  it('renders a non-resolved find with no candidate at all', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'not_found', reason: 'no match', confidence: 0, elapsed_ms: 1,
    }
    const text = renderDbgraph(value)
    expect(text).not.toContain('Candidates')
  })

  it('renders a resolved find with no rows honestly', () => {
    const value: DbgraphValueFor<'find'> = {
      ...resolvedFind(), rows: [], row_count: 0, redacted: [],
    }
    expect(renderDbgraph(value)).toContain('(no rows) — 0 returned')
  })

  it('renders an ambiguous find with its candidates and how to settle it', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'ambiguous', reason: 'top two are close', confidence: 0.5,
      candidates: [
        { object: 'sys_user', kind: 'table', score: 0.5, columns: [{ column: 'name', matched_by: 'name', score: 0.5 }] },
        { object: 'app_user', kind: 'table', score: 0.48, columns: [] },
      ],
      elapsed_ms: 2,
    }
    const text = renderDbgraph(value)
    expect(text).toContain('find did not execute: ambiguous  (top two are close)')
    expect(text).toContain('sys_user  (0.50)  columns: name')
    expect(text).toContain('Pick one with the object argument')
  })

  it('tells the caller what a missing predicate needs', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'missing_predicate', reason: 'no condition', confidence: 0, elapsed_ms: 1,
    }
    const text = renderDbgraph(value)
    expect(text).toContain('find did not execute: missing_predicate')
    expect(text).toContain('Pass entity (a word for the table')
  })

  it('renders a not-found find with its reason', () => {
    const value: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'not_found', reason: 'column nope does not exist', confidence: 0, elapsed_ms: 1,
    }
    expect(renderDbgraph(value)).toContain('column nope does not exist')
  })

  it('renders SQL results with affected rows, warnings, and clipping', () => {
    const value: DbgraphValueFor<'sql'> = {
      operation: 'sql', connection: 'prod', columns: ['id', 'note', 'missing'],
      rows: [{ id: 1, note: 'x'.repeat(200), missing: null }],
      row_count: 1, truncated: true, redacted: ['password'], affected_rows: 0, elapsed_ms: 4,
      warnings: ['read-only session'],
    }
    const text = renderDbgraph(value)
    expect(text).toContain('SQL on prod: 1 行, 4 ms')
    expect(text).toContain('1 row (truncated by the row cap):')
    expect(text).toContain('…')
    expect(text).toContain('NULL')
    expect(text).toContain('Affected rows: 0')
    expect(text).toContain('Masked: password')
    expect(text).toContain('Warning: read-only session')
  })

  it('uses a plural row count for more than one row', () => {
    const value: DbgraphValueFor<'sql'> = {
      operation: 'sql', connection: 'prod', columns: ['id'],
      rows: [{ id: 1 }, { id: 2 }], row_count: 2, truncated: false, redacted: [], elapsed_ms: 1,
    }
    expect(renderDbgraph(value)).toContain('2 rows:')
  })

  it('renders a row that is not an object, and a row set whose first element is null', () => {
    const scalarRow: DbgraphValueFor<'sql'> = {
      operation: 'sql', connection: 'prod', columns: ['id'], rows: [7], row_count: 1, truncated: false, redacted: [], elapsed_ms: 1,
    }
    expect(renderDbgraph(scalarRow)).toContain('NULL')
    const nullRow: DbgraphValueFor<'find'> = {
      operation: 'find', connection: 'prod', status: 'resolved', reason: 'named outright', confidence: 1,
      resolved: { object: 'sys_user', kind: 'table', score: 1, columns: [] },
      rows: [null], row_count: 1, elapsed_ms: 1,
    }
    expect(renderDbgraph(nullRow)).toBe(
      'find → sys_user  (confidence 1.00, 1 ms)\n(no rows) — 1 returned',
    )
  })

  it('renders cells that are booleans, arrays, and objects', () => {
    const value: DbgraphValueFor<'sql'> = {
      operation: 'sql', connection: 'prod', columns: ['ok', 'tags', 'meta'],
      rows: [{ ok: true, tags: ['a', 'b'], meta: { a: 1 } }],
      row_count: 1, truncated: false, redacted: [], elapsed_ms: 1,
    }
    const text = renderDbgraph(value)
    expect(text).toContain('true')
    expect(text).toContain('["a","b"]')
    expect(text).toContain('{"a":1}')
  })

  it('renders an empty SQL result', () => {
    const value: DbgraphValueFor<'sql'> = {
      operation: 'sql', connection: 'prod', columns: ['id'], rows: [], row_count: 0, truncated: false, redacted: [], elapsed_ms: 1,
    }
    expect(renderDbgraph(value)).toContain('(no rows returned)')
  })

  it('renders impact and refs in both directions, including the empty case', () => {
    const entries: DbgraphValueFor<'refs'>['entries'] = [
      { kind: 'fk', object: 'shop_order', column: 'user_id', ref_column: 'id', name: 'fk_user' },
      { kind: 'index', object: 'shop_order' },
    ]
    expect(renderDbgraph({ operation: 'refs', connection: 'prod', object: 'sys_user', entries: [], truncated: false }))
      .toBe('Objects referencing sys_user: none recorded in the index.')
    const refs = renderDbgraph({ operation: 'refs', connection: 'prod', object: 'sys_user', entries, truncated: false })
    expect(refs).toContain('Objects referencing sys_user (2):')
    expect(refs).toContain('[fk] shop_order.user_id → id  [fk_user]')
    const impact = renderDbgraph({ operation: 'impact', connection: 'prod', object: 'sys_user', entries, truncated: true })
    expect(impact).toContain('A change to sys_user (2 of 2 shown):')
  })
})

describe('renderDbgraphIndex', () => {
  it('names the job and how to read it', () => {
    const value: DbgraphIndexToolValue = { status: 'started', job_id: 'job-7', connection: 'prod', mode: 'full' }
    expect(renderDbgraphIndex(value)).toBe(
      'Indexing prod (full) in the background as job job-7. The run outlives this call — '
      + 'read its report with job_output job-7, or stop it with job_kill.',
    )
  })

  it('names every connection when the run was not narrowed', () => {
    expect(renderDbgraphIndex({ status: 'started', job_id: 'job-1', mode: 'l1' }))
      .toContain('Indexing every configured connection (l1)')
  })

  it('renders a finished run with its counts', () => {
    const value: DbgraphIndexToolValue = {
      status: 'completed',
      reports: [{
        connection: 'prod', level: 'l2', objects: 312, columns: 6840, edges: 44, terms: 900,
        writer: 'rust', elapsed_ms: 1234,
      }],
    }
    expect(renderDbgraphIndex(value)).toBe(
      'Indexed prod (l2): 312 对象 / 6840 列 / 44 关系, 900 检索词, writer rust, 1234 ms.',
    )
  })

  it('renders one line per connection a run covered', () => {
    const value: DbgraphIndexToolValue = {
      status: 'completed',
      reports: [
        { connection: 'prod', level: 'l2', objects: 312, columns: 6840, edges: 44, terms: 900, writer: 'js', elapsed_ms: 1234 },
        { connection: 'local', level: 'l2', objects: 3, columns: 9, edges: 1, terms: 20, writer: 'js', elapsed_ms: 5 },
      ],
    }
    expect(renderDbgraphIndex(value).split('\n')).toEqual([
      'Indexed prod (l2): 312 对象 / 6840 列 / 44 关系, 900 检索词, writer js, 1234 ms.',
      'Indexed local (l2): 3 对象 / 9 列 / 1 关系, 20 检索词, writer js, 5 ms.',
    ])
  })

  it('says so when a run had no connection to index', () => {
    expect(renderDbgraphIndex({ status: 'completed', reports: [] })).toBe('No connection was configured to index.')
  })

  it('appends warnings a finished run reported', () => {
    const value: DbgraphIndexToolValue = {
      status: 'completed',
      reports: [{
        connection: 'prod', level: 'l1', objects: 1, columns: 2, edges: 0, terms: 3,
        writer: 'js', elapsed_ms: 5, warnings: ['enum sampling skipped'],
      }],
    }
    expect(renderDbgraphIndex(value)).toContain('Warning: enum sampling skipped')
  })
})

describe('renderDbgraph over a tool value', () => {
  it('renders every member of the union without throwing', () => {
    const values: DbgraphToolValue[] = [
      { operation: 'connections', connections: [CONNECTION] },
      {
        operation: 'schema', connection: 'prod', engine: 'mysql', database: 'shop', objects: [OBJECT],
        truncated: false, comment_coverage: 0.5, index: CONNECTION.index,
      },
      { operation: 'objects', connection: 'prod', objects: [OBJECT], truncated: false },
      { operation: 'columns', connection: 'prod', object: 'sys_user', kind: 'table', columns: [COLUMN], truncated: false },
      resolvedFind(),
      { operation: 'sql', connection: 'prod', columns: [], rows: [], row_count: 0, truncated: false, redacted: [], elapsed_ms: 0 },
      { operation: 'impact', connection: 'prod', object: 'sys_user', entries: [], truncated: false },
      { operation: 'refs', connection: 'prod', object: 'sys_user', entries: [], truncated: false },
    ]
    for (const value of values) expect(renderDbgraph(value)).not.toBe('')
  })
})
