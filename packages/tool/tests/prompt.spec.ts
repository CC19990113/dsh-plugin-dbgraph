import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StatusFile } from 'dsh-plugin-dbgraph-service'
import {
  dbgraphPromptHint,
  dbgraphRoot,
  formatAge,
  readIndexDirectories,
  readStatusFile,
  renderStatusDigest,
} from '../src/prompt.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function rootWith(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dbgraph-prompt-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

/** One instant, so every age sentence is deterministic. */
const NOW = Date.UTC(2026, 10, 4, 9, 30)

const STATUS: StatusFile = {
  version: 1,
  updatedAt: NOW,
  connections: {
    prod: {
      engine: 'mysql',
      l1IndexedAt: NOW - 12 * 60_000,
      l2IndexedAt: NOW - 12 * 60_000,
      objects: 312,
      columns: 6840,
      commentCoverage: 0.78,
      digest: [
        { object: 'sys_user', comment: '系统用户', columns: 18 },
        { object: 'shop_order', comment: '订单主表', columns: 24 },
        { object: 'product', comment: '商品', columns: 31 },
      ],
      digestOmitted: 309,
    },
  },
}

describe('dbgraphRoot', () => {
  it('honours DSH_DBGRAPH_ROOT', () => {
    expect(dbgraphRoot({ DSH_DBGRAPH_ROOT: '/tmp/dbgraph-test' })).toBe('/tmp/dbgraph-test')
  })

  it('ignores a blank override and falls back to the harness home', () => {
    expect(dbgraphRoot({ DSH_DBGRAPH_ROOT: '   ' })).toMatch(/\.dsh\/dbgraph$/u)
  })

  it('has no override to honour in an empty environment', () => {
    expect(dbgraphRoot({})).toMatch(/\.dsh\/dbgraph$/u)
  })
})

describe('readStatusFile', () => {
  it('reads a well-formed summary', async () => {
    const root = await rootWith({ 'status.json': JSON.stringify(STATUS) })
    expect(readStatusFile(root)).toEqual(STATUS)
  })

  it('answers undefined when the file is absent', async () => {
    expect(readStatusFile(await rootWith())).toBeUndefined()
  })

  it.each<[string, string]>([
    ['a body that is not JSON', 'not json'],
    ['JSON null', 'null'],
    ['a JSON primitive', '42'],
    ['a JSON array', '[1,2,3]'],
    ['an object without connections', JSON.stringify({ version: 1, updatedAt: NOW })],
    ['a version that is not a number', JSON.stringify({ ...STATUS, version: '1' })],
    ['an updatedAt that is not a number', JSON.stringify({ ...STATUS, updatedAt: null })],
  ])('answers undefined for %s', async (_label, body) => {
    const root = await rootWith({ 'status.json': body })
    expect(readStatusFile(root)).toBeUndefined()
  })

  it('drops one malformed connection and keeps the rest', async () => {
    const body = JSON.stringify({
      ...STATUS,
      connections: {
        prod: STATUS.connections['prod'],
        broken: { engine: 'mysql' },
      },
    })
    const root = await rootWith({ 'status.json': body })
    const status = readStatusFile(root)
    expect(Object.keys(status?.connections ?? {})).toEqual(['prod'])
  })

  it('drops one malformed digest entry rather than the whole connection', async () => {
    const body = JSON.stringify({
      ...STATUS,
      connections: {
        prod: {
          ...STATUS.connections['prod'],
          digest: [{ object: 'sys_user', columns: 18 }, { columns: 3 }, { object: '' , columns: 1 }, 42, 'nope'],
        },
      },
    })
    const root = await rootWith({ 'status.json': body })
    expect(readStatusFile(root)?.connections['prod']?.digest).toEqual([{ object: 'sys_user', columns: 18 }])
  })

  it('drops a connection entry that is not an object', async () => {
    const body = JSON.stringify({ ...STATUS, connections: { prod: 5, other: STATUS.connections['prod'] } })
    const root = await rootWith({ 'status.json': body })
    expect(Object.keys(readStatusFile(root)?.connections ?? {})).toEqual(['other'])
  })

  it('keeps a non-empty label', async () => {
    const body = JSON.stringify({
      version: 1,
      updatedAt: NOW,
      connections: {
        prod: {
          engine: 'mysql', label: '生产库', objects: 0, columns: 0, commentCoverage: 0, digest: [], digestOmitted: 0,
        },
      },
    })
    const root = await rootWith({ 'status.json': body })
    expect(readStatusFile(root)?.connections['prod']?.label).toBe('生产库')
  })

  it('treats an empty label as absent', async () => {
    const body = JSON.stringify({
      version: 1,
      updatedAt: NOW,
      connections: {
        prod: {
          engine: 'mysql', label: '', objects: 0, columns: 0, commentCoverage: 0, digest: [], digestOmitted: 0,
        },
      },
    })
    const root = await rootWith({ 'status.json': body })
    expect(readStatusFile(root)?.connections['prod']).not.toHaveProperty('label')
  })

  it('keeps an entry that carries only the required fields', async () => {
    const body = JSON.stringify({
      version: 1,
      updatedAt: NOW,
      connections: { bare: { engine: 'sqlite', objects: 0, columns: 0, commentCoverage: 0, digest: [], digestOmitted: 0 } },
    })
    const root = await rootWith({ 'status.json': body })
    expect(readStatusFile(root)?.connections).toEqual({
      bare: { engine: 'sqlite', objects: 0, columns: 0, commentCoverage: 0, digest: [], digestOmitted: 0 },
    })
  })

  it('ignores an optional field of the wrong type instead of failing', async () => {
    const body = JSON.stringify({
      version: 1,
      updatedAt: NOW,
      connections: {
        prod: {
          engine: 'mysql', objects: 1, columns: 2, commentCoverage: 0, digest: [], digestOmitted: 0,
          label: 7, l1IndexedAt: 'yesterday',
        },
      },
    })
    const root = await rootWith({ 'status.json': body })
    expect(readStatusFile(root)?.connections['prod']).not.toHaveProperty('label')
    expect(readStatusFile(root)?.connections['prod']).not.toHaveProperty('l1IndexedAt')
  })
})

describe('readIndexDirectories', () => {
  it('lists the connection directories that hold an index', async () => {
    const root = await rootWith({ 'prod/index.db': '', 'local/index.db': '', 'empty/notes.txt': '' })
    expect(readIndexDirectories(root)).toEqual(['local', 'prod'])
  })

  it('answers an empty list when the root does not exist', async () => {
    expect(readIndexDirectories(join(tmpdir(), 'dsh-dbgraph-does-not-exist-xyz'))).toEqual([])
  })

  it('ignores a stray file at the root', async () => {
    const root = await rootWith({ 'connections.json': '{}' })
    expect(readIndexDirectories(root)).toEqual([])
  })
})

describe('formatAge', () => {
  it.each<[number, string]>([
    [0, '刚刚'],
    [59_999, '刚刚'],
    [60_000, '1 分钟前'],
    [59 * 60_000, '59 分钟前'],
    [60 * 60_000, '1 小时前'],
    [23 * 3_600_000, '23 小时前'],
    [24 * 3_600_000, '1 天前'],
    [-5_000, '刚刚'],
  ])('renders %i ms as %s', (elapsed, expected) => {
    expect(formatAge(elapsed)).toBe(expected)
  })
})

describe('renderStatusDigest', () => {
  it('renders header, largest-first table list, and the usage sentence', () => {
    expect(renderStatusDigest(STATUS, { now: NOW })).toBe([
      '[dbgraph] prod (mysql, 索引 12 分钟前, 312 表 / 6840 列, 注释覆盖 78%)',
      'product 商品(31) | shop_order 订单主表(24) | sys_user 系统用户(18)（还有 309 张未列出）',
      '问字段用 dbgraph columns <表>；查值用 dbgraph find。',
    ].join('\n'))
  })

  it('shows a configured label inside the header', () => {
    const labelled: StatusFile = {
      ...STATUS,
      connections: { prod: { ...STATUS.connections['prod'], label: '生产库' } },
    }
    expect(renderStatusDigest(labelled, { now: NOW }).split('\n')[0])
      .toBe('[dbgraph] prod (mysql, 生产库, 索引 12 分钟前, 312 表 / 6840 列, 注释覆盖 78%)')
  })

  it('marks an index past its freshness window and says how to refresh it', () => {
    const stale: StatusFile = {
      ...STATUS,
      connections: {
        prod: { ...STATUS.connections['prod'], l1IndexedAt: NOW - 8 * 3_600_000, l2IndexedAt: NOW - 8 * 3_600_000 },
      },
    }
    const text = renderStatusDigest(stale, { now: NOW })
    expect(text).toContain('索引 8 小时前, 已过期')
    expect(text).toContain('索引已过期，运行 dbgraph_index 刷新。')
  })

  it('keeps the configured freshness window authoritative', () => {
    const twoHours: StatusFile = {
      ...STATUS,
      connections: {
        prod: { ...STATUS.connections['prod'], l1IndexedAt: NOW - 2 * 3_600_000, l2IndexedAt: NOW - 2 * 3_600_000 },
      },
    }
    expect(renderStatusDigest(twoHours, { now: NOW })).not.toContain('已过期')
    expect(renderStatusDigest(twoHours, { now: NOW, staleHours: 1 })).toContain('已过期')
  })

  it('says so when no connection is configured', () => {
    expect(renderStatusDigest({ version: 1, updatedAt: NOW, connections: {} }, { now: NOW }))
      .toBe('[dbgraph] 还没有配置连接\n问字段用 dbgraph columns <表>；查值用 dbgraph find。')
  })

  it('omits comment coverage for a connection with no columns', () => {
    const empty: StatusFile = {
      version: 1,
      updatedAt: NOW,
      connections: {
        scratch: {
          engine: 'sqlite', objects: 0, columns: 0, commentCoverage: 0, digest: [], digestOmitted: 0,
        },
      },
    }
    const text = renderStatusDigest(empty, { now: NOW })
    expect(text).toContain('[dbgraph] scratch (sqlite, 索引 未记录, 0 表 / 0 列)')
    expect(text).not.toContain('注释覆盖')
    expect(text).toContain('（没有可列出的对象）')
  })

  it('lists only the largest tables the table budget allows and counts the rest', () => {
    const many: StatusFile = {
      version: 1,
      updatedAt: NOW,
      connections: {
        prod: {
          engine: 'mysql', objects: 5, columns: 50, commentCoverage: 0, digestOmitted: 0,
          digest: [
            { object: 'a', columns: 1 },
            { object: 'b', columns: 9 },
            { object: 'c', columns: 3 },
            { object: 'd', columns: 7 },
            { object: 'e', columns: 5 },
          ],
        },
      },
    }
    const line = renderStatusDigest(many, { now: NOW, maxPromptTables: 2 }).split('\n')[1]
    expect(line).toBe('b(9) | d(7)（还有 3 张未列出）')
    expect(renderStatusDigest(many, { now: NOW, maxPromptTables: 10 }).split('\n')[1]).not.toContain('未列出')
  })

  it('drops tables until the character budget fits and keeps counting them', () => {
    const longComment = '很长的表注释'.repeat(10)
    const wide: StatusFile = {
      version: 1,
      updatedAt: NOW,
      connections: {
        prod: {
          engine: 'mysql', objects: 4, columns: 40, commentCoverage: 0, digestOmitted: 0,
          digest: [
            { object: 'alpha', comment: longComment, columns: 40 },
            { object: 'beta', comment: longComment, columns: 30 },
            { object: 'gamma', comment: longComment, columns: 20 },
          ],
        },
      },
    }
    const full = renderStatusDigest(wide, { now: NOW })
    const capped = renderStatusDigest(wide, { now: NOW, maxPromptChars: 120 })
    expect(full.length).toBeGreaterThan(120)
    expect(capped.length).toBeLessThanOrEqual(120)
    expect(capped).toContain('未列出')
  })

  it('breaks a tie by connection id, then by object name', () => {
    const tied: StatusFile = {
      version: 1,
      updatedAt: NOW,
      connections: {
        beta: {
          engine: 'sqlite', objects: 1, columns: 5, commentCoverage: 0, digestOmitted: 0,
          digest: [{ object: 'z', columns: 5 }],
        },
        alpha: {
          engine: 'sqlite', objects: 2, columns: 10, commentCoverage: 0, digestOmitted: 0,
          digest: [{ object: 'z', columns: 5 }, { object: 'a', columns: 5 }],
        },
      },
    }
    const lines = renderStatusDigest(tied, { now: NOW, maxPromptTables: 1 }).split('\n')
    // The cap keeps one table; the tie-break is id first, so `alpha` beats `beta`.
    expect(lines[1]).toBe('beta: （还有 1 张未列出）')
    expect(lines[3]).toBe('alpha: a(5)（还有 1 张未列出）')
  })

  it('groups two connections and prefixes their table lines with the id', () => {
    const two: StatusFile = {
      version: 1,
      updatedAt: NOW,
      connections: {
        prod: STATUS.connections['prod'],
        local: {
          engine: 'sqlite', objects: 2, columns: 9, commentCoverage: 0.5,
          digest: [{ object: 'note', columns: 4 }], digestOmitted: 1,
        },
      },
    }
    const lines = renderStatusDigest(two, { now: NOW }).split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('[dbgraph] prod')
    expect(lines[1]).toBe('prod: product 商品(31) | shop_order 订单主表(24) | sys_user 系统用户(18)（还有 309 张未列出）')
    expect(lines[2]).toBe('[dbgraph] local (sqlite, 索引 未记录, 2 表 / 9 列, 注释覆盖 50%)')
    expect(lines[3]).toBe('local: note(4)（还有 1 张未列出）')
    expect(lines[4]).toBe('问字段用 dbgraph columns <表>；查值用 dbgraph find。')
  })
})

describe('dbgraphPromptHint', () => {
  it('renders the digest when a summary is readable', async () => {
    const root = await rootWith({ 'status.json': JSON.stringify(STATUS) })
    expect(dbgraphPromptHint({ root, now: NOW }).split('\n')[0]).toContain('[dbgraph] prod (mysql,')
  })

  it('names the connections file when the summary has no connections', async () => {
    const root = await rootWith({ 'status.json': JSON.stringify({ version: 1, updatedAt: NOW, connections: {} }) })
    expect(dbgraphPromptHint({ root })).toContain('还没有配置任何连接')
    expect(dbgraphPromptHint({ root })).toContain('connections.json')
  })

  it('distinguishes an index without a summary from no index at all', async () => {
    const root = await rootWith({ 'prod/index.db': '' })
    const hint = dbgraphPromptHint({ root })
    expect(hint).toContain('已建立 dbgraph 索引（1 个连接目录：prod）')
    expect(hint).toContain('缺少 status.json 摘要')
  })

  it('says so plainly when nothing has been indexed', async () => {
    expect(dbgraphPromptHint({ root: await rootWith() })).toContain('还没有建立数据库索引')
  })

  it('reads the root from DSH_DBGRAPH_ROOT when none is passed', async () => {
    const root = await rootWith({ 'status.json': JSON.stringify(STATUS) })
    const previous = process.env['DSH_DBGRAPH_ROOT']
    process.env['DSH_DBGRAPH_ROOT'] = root
    try {
      expect(dbgraphPromptHint({ now: NOW })).toContain('[dbgraph] prod')
    } finally {
      if (previous === undefined) delete process.env['DSH_DBGRAPH_ROOT']
      else process.env['DSH_DBGRAPH_ROOT'] = previous
    }
  })
})
