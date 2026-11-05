import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  ColumnsResult,
  ConnectionSummary,
  Dbgraph,
  DbgraphService,
  FindResult,
  ImpactResult,
  IndexReport,
  IndexRequest,
  ObjectsResult,
  RefsResult,
  SchemaResult,
  SqlResult,
} from 'dsh-plugin-dbgraph-service'
import * as ToolDbgraph from '../src/index.ts'
import {
  callTitle,
  DEFAULT_BACKGROUND_INDEX_THRESHOLD,
  DEFAULT_MAX_TOOL_LIMIT,
  DEFAULT_TOOL_LIMIT,
  resolveConfig,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  delete process.env['DSH_DBGRAPH_ROOT']
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dbgraph-tool-'))
  roots.push(root)
  return root
}

async function rootWith(files: Record<string, string>): Promise<string> {
  const root = await tempRoot()
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

const NOW = Date.UTC(2026, 10, 4, 9, 30)

const CONNECTION: ConnectionSummary = {
  id: 'prod',
  engine: 'mysql',
  label: '生产库',
  host: 'mysql.internal',
  database: 'shop',
  credentialConfigured: true,
  index: {
    l1IndexedAt: NOW - 12 * 60_000,
    l2IndexedAt: NOW - 12 * 60_000,
    objects: 312,
    columns: 6840,
    stale: false,
    writer: 'js',
  },
}

const SCHEMA: SchemaResult = {
  connection: 'prod',
  engine: 'mysql',
  database: 'shop',
  objects: [{ object: 'sys_user', kind: 'table', comment: '系统用户', columnCount: 18, rowEstimate: 1200 }],
  truncated: false,
  index: CONNECTION.index,
  commentCoverage: 0.78,
}

const OBJECTS: ObjectsResult = {
  objects: [{ object: 'sys_user', kind: 'table', comment: '系统用户', columnCount: 18 }],
  truncated: false,
}

const COLUMNS: ColumnsResult = {
  object: 'sys_user',
  kind: 'table',
  comment: '系统用户',
  columns: [
    { name: 'id', type: 'bigint', nullable: false, isPrimaryKey: true, isUnique: true },
    { name: 'password', type: 'varchar(64)', nullable: true, isPrimaryKey: false, isUnique: false, comment: '密码' },
  ],
  truncated: false,
}

const FIND: FindResult = {
  status: 'resolved',
  reason: 'matched 用户 and 密码',
  resolved: {
    object: 'sys_user',
    kind: 'table',
    comment: '系统用户',
    score: 0.92,
    columns: [{ column: 'password', comment: '密码', matchedBy: 'synonym', term: '密码', score: 0.9 }],
  },
  confidence: 0.92,
  sql: 'SELECT `id`, `password` FROM `sys_user` LIMIT 50',
  rows: [{ id: 1, password: '***' }],
  rowCount: 1,
  truncated: false,
  redacted: ['password'],
  elapsedMs: 3,
}

const SQL: SqlResult = {
  columns: ['id', 'name'],
  rows: [{ id: 1, name: 'alice' }],
  rowCount: 1,
  truncated: false,
  redacted: [],
  elapsedMs: 4,
}

const IMPACT: ImpactResult = {
  object: 'sys_user',
  entries: [{ kind: 'fk', object: 'shop_order', column: 'user_id', refColumn: 'id', name: 'fk_user' }],
  truncated: false,
}

const REFS: RefsResult = {
  object: 'sys_user',
  entries: [],
  truncated: false,
}

const INDEX_REPORT: IndexReport = {
  connection: 'prod',
  level: 'l2',
  objects: 312,
  columns: 6840,
  edges: 44,
  terms: 900,
  writer: 'js',
  elapsedMs: 1234,
  warnings: [],
}

/** One recorded seam call. */
interface SeenCall {
  readonly method: string
  readonly request?: unknown
}

/** The stub seam and the calls it saw. */
interface SeamStub {
  readonly service: DbgraphService
  readonly seen: SeenCall[]
}

/**
 * Build a stub `ctx.dbgraph`.
 * @param index - overrides the index method, for the background-job paths.
 * @param indexMany - overrides the multi-connection method; when omitted it answers one report, or
 *   whatever the `index` override settles with, so a failure test drives both paths identically.
 * @returns the service and its call log.
 */
function seam(
  index?: (request: IndexRequest, signal?: AbortSignal) => Promise<IndexReport>,
  indexMany?: (request: IndexRequest, signal?: AbortSignal) => Promise<IndexReport[]>,
): SeamStub {
  const seen: SeenCall[] = []
  const record = (method: string, request?: unknown): void => {
    seen.push(request === undefined ? { method } : { method, request })
  }
  const service: DbgraphService = {
    listConnections: () => {
      record('listConnections')
      return Promise.resolve([CONNECTION])
    },
    schema: (request) => {
      record('schema', request)
      return Promise.resolve(SCHEMA)
    },
    objects: (request) => {
      record('objects', request)
      return Promise.resolve(OBJECTS)
    },
    columns: (request) => {
      record('columns', request)
      return Promise.resolve(COLUMNS)
    },
    find: (request) => {
      record('find', request)
      return Promise.resolve(FIND)
    },
    sql: (request) => {
      record('sql', request)
      return Promise.resolve(SQL)
    },
    impact: (request) => {
      record('impact', request)
      return Promise.resolve(IMPACT)
    },
    refs: (request) => {
      record('refs', request)
      return Promise.resolve(REFS)
    },
    index: (request, signal) => {
      record('index', request)
      return index === undefined ? Promise.resolve(INDEX_REPORT) : index(request, signal)
    },
    indexMany: (request, signal) => {
      record('indexMany', request)
      if (indexMany !== undefined) return indexMany(request, signal)
      if (index !== undefined) return index(request, signal).then(report => [report])
      return Promise.resolve([INDEX_REPORT])
    },
    recordIndex: (report) => {
      record('recordIndex', report)
      return Promise.resolve()
    },
  }
  return { service, seen }
}

/** The producer face a background job hands out, as the host's contract declares it. */
interface JobHandle {
  append(text: string): void
  updateProgress(line: string): void
}

/** One started job's settlement promise. */
interface JobOutcome {
  status: 'completed' | 'failed' | 'killed'
  detail?: string
  result?: string
}

/** The host's job registry, as this plugin uses it. */
interface JobSpecLike {
  owner?: string
  kind: string
  label: string
  run(handle: JobHandle): { cancel(reason?: string): void; done: Promise<JobOutcome> }
}

/** A fake job registry that records registrations and starts nothing on its own. */
function fakeJobs(): { registry: { start(spec: JobSpecLike): string }; started: JobSpecLike[] } {
  const started: JobSpecLike[] = []
  return {
    started,
    registry: {
      start(spec) {
        started.push(spec)
        return `job-${started.length}`
      },
    },
  }
}

/** Mount the plugin over a stub seam, the way a host composition would. */
async function mount(options: {
  config?: Config
  seamValue?: SeamStub
  jobs?: { start(spec: JobSpecLike): string }
} = {}): Promise<{ ctx: Context; stub: SeamStub }> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const stub = options.seamValue ?? seam()
  ctx.provide('dbgraph', stub.service as unknown as Dbgraph)
  if (options.jobs !== undefined) ctx.provide('jobs', options.jobs)
  await ctx.plugin(ToolDbgraph, options.config ?? {})
  return { ctx, stub }
}

let callCounter = 0

/** Execute one tool through the registry, the way the agent loop does. */
function call(
  ctx: Context,
  name: 'dbgraph' | 'dbgraph_index',
  args: Record<string, unknown>,
  options: { agent?: boolean; signal?: AbortSignal } = {},
): Promise<ToolExecutionResult> {
  callCounter += 1
  return ctx.tools.execute({
    signal: options.signal ?? new AbortController().signal,
    callId: CallId(`dbgraph-test-${callCounter}`),
    name,
    arguments: args,
    ...options.agent === true
      ? { agent: { id: 'session-1', session: { header: { cwd: '/tmp/dbgraph-session' } } } }
      : {},
  } as unknown as ToolExecutionInput)
}

/** The model-facing text of one settled call. */
function textOf(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('plugin wiring', () => {
  it('registers both tools with separate, fixed timeout budgets', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('dbgraph')?.timeoutMs).toBe(30_000)
    expect(ctx.tools.get('dbgraph_index')?.timeoutMs).toBe(300_000)
  })

  it('honours a deployment override of either budget', async () => {
    const { ctx } = await mount({ config: { timeoutMs: 5_000, indexTimeoutMs: 600_000 } })
    expect(ctx.tools.get('dbgraph')?.timeoutMs).toBe(5_000)
    expect(ctx.tools.get('dbgraph_index')?.timeoutMs).toBe(600_000)
  })

  it('registers the ordered prompt section whose text reads the sidecar', async () => {
    // The section reads the wall clock (that is the point), so this fixture is relative to it.
    const now = Date.now()
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: now,
        connections: {
          prod: {
            engine: 'mysql', l1IndexedAt: now - 60_000, l2IndexedAt: now - 60_000,
            objects: 2, columns: 9, commentCoverage: 0.5,
            digest: [{ object: 'sys_user', comment: '系统用户', columns: 4 }], digestOmitted: 0,
          },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const { ctx } = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === 'tool:dbgraph')
    expect(section?.text).toContain('用 dbgraph 回答数据库结构')
    expect(section?.text).toContain('[dbgraph] prod (mysql, 索引 1 分钟前, 2 表 / 9 列, 注释覆盖 50%)')
    expect(section?.text).toContain('sys_user 系统用户(4)')
  })

  it('keeps the digest section off when a deployment disables it, but not the tools', async () => {
    const { ctx } = await mount({ config: { prompt: false } })
    expect(ctx.tools.get('dbgraph')).toBeDefined()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(entry => entry.name === 'tool:dbgraph')).toBe(false)
  })

  it('rejects a misconfigured budget before serving a call', async () => {
    await expect(mount({ config: { defaultLimit: 0 } })).rejects.toThrow('defaultLimit')
    await expect(mount({ config: { timeoutMs: MAX_TIMER_DELAY_MS + 1 } })).rejects.toThrow('timeoutMs')
  })

  it('presents each call with a short title', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('dbgraph')?.presentCall?.({ operation: 'find', entity: '用户' })).toMatchObject({
      card: 'generic', title: 'dbgraph find 用户', kind: 'search',
    })
    expect(ctx.tools.get('dbgraph_index')?.presentCall?.({})).toMatchObject({ title: 'dbgraph_index' })
    expect(ctx.tools.get('dbgraph_index')?.presentCall?.({ connection: 'prod' }))
      .toMatchObject({ title: 'dbgraph_index prod', kind: 'execute' })
    expect(callTitle({ operation: 'connections' })).toBe('dbgraph connections')
    expect(callTitle({ operation: 'objects', connection: 'prod', query: '订单' })).toBe('dbgraph objects 订单')
  })
})

describe('resolveConfig', () => {
  it('applies every default', () => {
    expect(resolveConfig()).toEqual({
      defaultLimit: DEFAULT_TOOL_LIMIT,
      maxLimit: DEFAULT_MAX_TOOL_LIMIT,
      maxPromptTables: 40,
      maxPromptChars: 6000,
      indexStaleHours: 6,
      prompt: true,
      backgroundIndex: 'auto',
      backgroundIndexThreshold: DEFAULT_BACKGROUND_INDEX_THRESHOLD,
      timeoutMs: 30_000,
      indexTimeoutMs: 300_000,
    })
  })

  it.each<[Config]>([
    [{ defaultLimit: 0 }],
    [{ maxPromptTables: 0 }],
    [{ maxPromptChars: -1 }],
    [{ indexStaleHours: 0 }],
    [{ backgroundIndexThreshold: 0 }],
    [{ timeoutMs: 0 }],
    [{ indexTimeoutMs: 1.5 }],
  ])('rejects %j', (config) => {
    expect(() => resolveConfig(config)).toThrow(/tool-dbgraph/u)
  })
})

describe('the eight query operations forward to the seam', () => {
  it('connections', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'connections' })
    expect(result.isError).toBe(false)
    expect(stub.seen).toEqual([{ method: 'listConnections' }])
    expect(textOf(result)).toContain('prod "生产库" (mysql) mysql.internal / shop')
    expect(result.isError === false && result.value).toMatchObject({ operation: 'connections' })
  })

  it('projects a connection that records no label, target, or index level', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        listConnections: () => Promise.resolve([{
          id: 'local', engine: 'sqlite', credentialConfigured: false,
          index: { objects: 0, columns: 0, stale: true },
        }]),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'connections' })
    expect(result.isError === false && result.value).toMatchObject({
      connections: [{ id: 'local', engine: 'sqlite', credential_configured: false, index: { objects: 0, columns: 0, stale: true } }],
    })
    expect(textOf(result)).toContain('local (sqlite) no target recorded — not indexed')
  })

  it('schema', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'schema', connection: 'prod' })
    expect(stub.seen).toEqual([{ method: 'schema', request: { connection: 'prod' } }])
    expect(textOf(result)).toContain('Schema for prod (mysql / shop)')
    expect(textOf(result)).toContain('注释覆盖 78%')
  })

  it('objects with a query and the configured limit', async () => {
    const { ctx, stub } = await mount({ config: { defaultLimit: 7 } })
    const result = await call(ctx, 'dbgraph', { operation: 'objects', connection: 'prod', query: '用户' })
    expect(stub.seen).toEqual([{ method: 'objects', request: { connection: 'prod', query: '用户', limit: 7 } }])
    expect(textOf(result)).toContain('sys_user  系统用户')
  })

  it('objects with no query', async () => {
    const { ctx, stub } = await mount()
    await call(ctx, 'dbgraph', { operation: 'objects', connection: 'prod' })
    expect(stub.seen).toEqual([{ method: 'objects', request: { connection: 'prod', limit: DEFAULT_TOOL_LIMIT } }])
  })

  it('columns', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'columns', connection: 'prod', object: 'sys_user' })
    expect(stub.seen).toEqual([{ method: 'columns', request: { connection: 'prod', object: 'sys_user' } }])
    expect(textOf(result)).toContain('sys_user  系统用户  [table]  2 列:')
  })

  it('find with entity, fields, where, and a limit', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', {
      operation: 'find',
      connection: 'prod',
      entity: '用户',
      fields: ['密码'],
      where: { id: 7 },
      limit: 3,
    })
    expect(stub.seen).toEqual([{
      method: 'find',
      request: { connection: 'prod', entity: '用户', fields: ['密码'], where: { id: 7 }, limit: 3 },
    }])
    expect(textOf(result)).toContain('find → sys_user 系统用户')
    expect(textOf(result)).toContain('Masked: password')
    expect(result.isError === false && result.value).toMatchObject({ operation: 'find', status: 'resolved' })
  })

  it('drops a blank entity instead of forwarding it', async () => {
    const { ctx, stub } = await mount()
    await call(ctx, 'dbgraph', { operation: 'find', connection: 'prod', entity: '   ', object: 'sys_user' })
    expect(stub.seen).toEqual([{
      method: 'find', request: { connection: 'prod', object: 'sys_user', limit: DEFAULT_TOOL_LIMIT },
    }])
  })

  it('find with an explicit object and no other word', async () => {
    const { ctx, stub } = await mount()
    await call(ctx, 'dbgraph', { operation: 'find', connection: 'prod', object: 'sys_user' })
    expect(stub.seen).toEqual([{
      method: 'find', request: { connection: 'prod', object: 'sys_user', limit: DEFAULT_TOOL_LIMIT },
    }])
  })

  it('projects an object with no comment or row estimate', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        objects: () => Promise.resolve({ objects: [{ object: 'bare', kind: 'table', columnCount: 3 }], truncated: false }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'objects', connection: 'prod' })
    expect(result.isError === false && result.value).toMatchObject({ objects: [{ object: 'bare', column_count: 3 }] })
    expect(textOf(result)).toContain('bare  [table]  3 列')
  })

  it('projects a column with a default and sampled values, and a table with no comment', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        columns: () => Promise.resolve({
          object: 'sys_user',
          kind: 'table',
          columns: [
            { name: 'status', type: 'varchar(16)', nullable: false, defaultValue: "'new'", isPrimaryKey: false, isUnique: false, enumValues: ['new', 'paid'] },
          ],
          truncated: false,
        }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'columns', connection: 'prod', object: 'sys_user' })
    expect(result.isError === false && result.value).toMatchObject({
      columns: [{ name: 'status', default_value: "'new'", enum_values: ['new', 'paid'] }],
    })
  })

  it('projects a relation that records no column, referenced column, or constraint name', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        refs: () => Promise.resolve({ object: 'sys_user', entries: [{ kind: 'index', object: 'shop_order' }], truncated: false }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'refs', connection: 'prod', object: 'sys_user' })
    expect(result.isError === false && result.value).toMatchObject({ entries: [{ kind: 'index', object: 'shop_order' }] })
    expect(textOf(result)).toContain('[index] shop_order')
  })

  it('sql', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'sql', connection: 'prod', query: 'SELECT 1' })
    expect(stub.seen).toEqual([{ method: 'sql', request: { connection: 'prod', query: 'SELECT 1', limit: DEFAULT_TOOL_LIMIT } }])
    expect(textOf(result)).toContain('SQL on prod: 1 行')
  })

  it('projects an ambiguous find with its ranked candidates', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        find: () => Promise.resolve({
          status: 'ambiguous',
          reason: 'top two are close',
          confidence: 0.5,
          candidates: [
            { object: 'sys_user', kind: 'table', comment: '系统用户', score: 0.5, columns: [] },
            { object: 'app_user', kind: 'table', score: 0.48, columns: [] },
          ],
          elapsedMs: 2,
        }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'find', connection: 'prod', entity: '用户' })
    expect(result.isError === false && result.value).toMatchObject({
      candidates: [{ object: 'sys_user', comment: '系统用户' }, { object: 'app_user' }],
    })
    expect(textOf(result)).toContain('Candidates (2):')
  })

  it('projects a find answer that carries none of its optional fields', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        find: () => Promise.resolve({ status: 'not_found', reason: 'no table matched', confidence: 0, elapsedMs: 1 }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'find', connection: 'prod', entity: '涂鸦墙' })
    expect(result.isError).toBe(false)
    expect(result.isError === false && result.value).toEqual({
      operation: 'find', connection: 'prod', status: 'not_found', reason: 'no table matched', confidence: 0, elapsed_ms: 1,
    })
    expect(textOf(result)).toContain('no table matched')
  })

  it('projects a statement that reports affected rows and warnings', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        sql: () => Promise.resolve({ ...SQL, affectedRows: 3, warnings: ['read-only session'] }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'sql', connection: 'prod', query: 'UPDATE x' })
    expect(result.isError === false && result.value).toMatchObject({ affected_rows: 3, warnings: ['read-only session'] })
  })

  it('impact', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'impact', connection: 'prod', object: 'sys_user' })
    expect(stub.seen).toEqual([{ method: 'impact', request: { connection: 'prod', object: 'sys_user' } }])
    expect(textOf(result)).toContain('A change to sys_user (1):')
    expect(textOf(result)).toContain('[fk] shop_order.user_id → id  [fk_user]')
  })

  it('refs', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'refs', connection: 'prod', object: 'sys_user' })
    expect(stub.seen).toEqual([{ method: 'refs', request: { connection: 'prod', object: 'sys_user' } }])
    expect(textOf(result)).toContain('Objects referencing sys_user: none recorded in the index.')
  })
})

describe('argument validation and clamping', () => {
  it('rejects the index operation on the query tool', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'index' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('operation')
    expect(stub.seen).toEqual([])
  })

  it('rejects an operation that needs a connection without one', async () => {
    const { ctx } = await mount()
    for (const operation of ['schema', 'objects', 'columns', 'find', 'sql', 'impact', 'refs']) {
      const result = await call(ctx, 'dbgraph', { operation, connection: '  ' })
      expect(result.isError, operation).toBe(true)
      expect(textOf(result)).toContain('connection')
    }
  })

  it('rejects a find "where" that is not a JSON object', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph', { operation: 'find', connection: 'prod', where: ['id', 7] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('where')
    expect(stub.seen).toEqual([])
  })

  it('clamps a model limit into the configured range', async () => {
    const { ctx, stub } = await mount({ config: { defaultLimit: 5, maxLimit: 9 } })
    await call(ctx, 'dbgraph', { operation: 'sql', connection: 'prod', query: 'SELECT 1', limit: 1000 })
    await call(ctx, 'dbgraph', { operation: 'sql', connection: 'prod', query: 'SELECT 1', limit: 0 })
    const requests = stub.seen.filter(entry => entry.method === 'sql').map(entry => entry.request)
    expect(requests).toEqual([
      { connection: 'prod', query: 'SELECT 1', limit: 9 },
      { connection: 'prod', query: 'SELECT 1', limit: 1 },
    ])
  })

  it('projects a candidate that carries no comment or matched term', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        find: () => Promise.resolve({
          ...FIND,
          resolved: {
            object: 'sys_user', kind: 'table', score: 1,
            columns: [{ column: 'id', matchedBy: 'name', score: 1 }],
          },
        }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'find', connection: 'prod', object: 'sys_user' })
    expect(textOf(result)).toContain('Columns: id [name]')
    expect(result.isError === false && result.value).toMatchObject({
      resolved: { columns: [{ column: 'id', matched_by: 'name', score: 1 }] },
    })
  })

  it('forwards the caller signal to the seam and lets cancellation win', async () => {
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        sql: (_request, signal) => {
          observed = signal
          // Arrive mid-call, the way a timeout policy does: the body has started, so the registry
          // replaces its successful outcome with the canonical aborted failure rather than dropping it.
          controller.abort()
          return Promise.resolve(SQL)
        },
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph', { operation: 'sql', connection: 'prod', query: 'SELECT 1' }, {
      signal: controller.signal,
    })
    expect(observed?.aborted).toBe(true)
    expect(result.isError).toBe(true)
  })
})

describe('dbgraph_index', () => {
  it('runs synchronously and reports the written counts', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph_index', { connection: 'prod', mode: 'l2' }, { agent: true })
    expect(result.isError).toBe(false)
    expect(stub.seen).toEqual([{ method: 'index', request: { mode: 'l2', connection: 'prod' } }])
    expect(textOf(result)).toBe(
      'Indexed prod (l2): 312 对象 / 6840 列 / 44 关系, 900 检索词, writer js, 1234 ms.',
    )
  })

  it('defaults to a full build over every configured connection', async () => {
    const { ctx, stub } = await mount()
    await call(ctx, 'dbgraph_index', {})
    expect(stub.seen).toEqual([{ method: 'indexMany', request: { mode: 'full' } }])
  })

  it('names every connection it indexed when none was named', async () => {
    const base = seam(undefined, () => Promise.resolve([
      INDEX_REPORT,
      { ...INDEX_REPORT, connection: 'local', writer: 'rust', objects: 12, columns: 40, warnings: ['enum sampling skipped'] },
    ]))
    const { ctx } = await mount({ seamValue: base })
    const result = await call(ctx, 'dbgraph_index', { mode: 'full' })
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text.split('\n').filter(line => line.startsWith('Indexed '))).toHaveLength(2)
    expect(text).toContain('Indexed prod (l2): 312 对象 / 6840 列 / 44 关系, 900 检索词, writer js, 1234 ms.')
    expect(text).toContain('Indexed local (l2): 12 对象 / 40 列 / 44 关系, 900 检索词, writer rust, 1234 ms.')
    expect(text).toContain('Warning: enum sampling skipped')
    expect(result.isError === false && result.value).toMatchObject({
      status: 'completed',
      reports: [{ connection: 'prod' }, { connection: 'local', writer: 'rust' }],
    })
  })

  it('forwards an explicit writer', async () => {
    const { ctx, stub } = await mount()
    await call(ctx, 'dbgraph_index', { connection: 'prod', mode: 'l1', writer: 'rust' })
    expect(stub.seen).toEqual([{ method: 'index', request: { mode: 'l1', connection: 'prod', writer: 'rust' } }])
  })

  it('drops a blank connection so the run covers every configured connection', async () => {
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph_index', { connection: '   ' })
    expect(stub.seen).toEqual([{ method: 'indexMany', request: { mode: 'full' } }])
    expect(textOf(result)).toContain('Indexed prod')
  })

  it('reports the warnings a finished run produced', async () => {
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        index: () => Promise.resolve({ ...INDEX_REPORT, warnings: ['enum sampling skipped'] }),
      },
    }
    const { ctx } = await mount({ seamValue: stub })
    const result = await call(ctx, 'dbgraph_index', { connection: 'prod' })
    expect(textOf(result)).toContain('Warning: enum sampling skipped')
  })

  it('hands a large database to a background job and answers with its id', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry })
    const result = await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('in the background as job job-1')
    const spec = jobs.started[0]
    expect(spec?.owner).toBe('session-1')
    expect(spec?.kind).toBe('dbgraph-index')
    expect(spec?.label).toBe('dbgraph index prod')
  })

  it('produces a job whose hooks satisfy the host contract and report the run', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry })
    await call(ctx, 'dbgraph_index', { connection: 'prod', mode: 'full' }, { agent: true })
    const spec = jobs.started[0]
    if (spec === undefined) throw new Error('the job was not started')
    const handle = { append: vi.fn(), updateProgress: vi.fn() }
    const hooks = spec.run(handle)
    expect(typeof hooks.cancel).toBe('function')
    const outcome = await hooks.done
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toContain('Indexed prod (l2)')
    expect(handle.updateProgress).toHaveBeenCalledWith('indexing prod')
    expect(handle.append).toHaveBeenCalledWith('Indexed prod: 312 对象 / 6840 列 / 44 关系.\n')
  })

  it('reports a failed job as a failure instead of throwing out of the producer', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({
      jobs: jobs.registry,
      seamValue: seam(() => Promise.reject(new Error('dialect refused'))),
    })
    await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    const spec = jobs.started[0]
    if (spec === undefined) throw new Error('the job was not started')
    const outcome = await spec.run({ append: vi.fn(), updateProgress: vi.fn() }).done
    expect(outcome).toEqual({ status: 'failed', detail: 'dialect refused' })
  })

  it('reports a non-Error rejection as its string form', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({
      jobs: jobs.registry,
      seamValue: seam(() => Promise.reject('the driver is missing')),
    })
    await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    const spec = jobs.started[0]
    if (spec === undefined) throw new Error('the job was not started')
    const outcome = await spec.run({ append: vi.fn(), updateProgress: vi.fn() }).done
    expect(outcome).toEqual({ status: 'failed', detail: 'the driver is missing' })
  })

  it('cancels the job by aborting the signal it owns', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    let observed: AbortSignal | undefined
    const base = seam()
    const stub: SeamStub = {
      seen: base.seen,
      service: {
        ...base.service,
        indexMany: (request, signal) => {
          observed = signal
          return Promise.resolve([INDEX_REPORT])
        },
      },
    }
    const { ctx } = await mount({ jobs: jobs.registry, seamValue: stub })
    await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    const spec = jobs.started[0]
    if (spec === undefined) throw new Error('the job was not started')
    const hooks = spec.run({ append: vi.fn(), updateProgress: vi.fn() })
    hooks.cancel('the user stopped it')
    await hooks.done
    expect(observed?.aborted).toBe(true)
  })

  it('stays synchronous for a database below the threshold', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 499, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx, stub } = await mount({ jobs: jobs.registry })
    const result = await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    expect(jobs.started).toEqual([])
    expect(textOf(result)).toContain('Indexed prod')
    expect(stub.seen).toEqual([{ method: 'index', request: { mode: 'full', connection: 'prod' } }])
  })

  it('stays synchronous when the summary lists another connection', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          other: { engine: 'mysql', objects: 9000, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry })
    await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    expect(jobs.started).toEqual([])
  })

  it('decides an all-connections run from every entry in the summary', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 9000, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry })
    const result = await call(ctx, 'dbgraph_index', {}, { agent: true })
    expect(jobs.started).toHaveLength(1)
    expect(jobs.started[0]?.label).toBe('dbgraph index all connections')
    expect(textOf(result)).toContain('job job-1')
    const spec = jobs.started[0]
    if (spec === undefined) throw new Error('the job was not started')
    const handle = { append: vi.fn(), updateProgress: vi.fn() }
    const outcome = await spec.run(handle).done
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toContain('Indexed prod')
    expect(handle.updateProgress).toHaveBeenCalledWith('indexing all connections')
  })

  it('stays synchronous when no summary has ever been written', async () => {
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry })
    await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    expect(jobs.started).toEqual([])
  })

  it('stays synchronous when the host has no job registry', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const { ctx, stub } = await mount()
    const result = await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    expect(textOf(result)).toContain('Indexed prod')
    expect(stub.seen).toEqual([{ method: 'index', request: { mode: 'full', connection: 'prod' } }])
  })

  it('stays synchronous when the call has no owning agent', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry })
    await call(ctx, 'dbgraph_index', { connection: 'prod' })
    expect(jobs.started).toEqual([])
  })

  it('stays synchronous when the deployment turns background runs off', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry, config: { backgroundIndex: false } })
    await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    expect(jobs.started).toEqual([])
  })

  it('always uses a job when the deployment asks for one', async () => {
    const jobs = fakeJobs()
    const { ctx } = await mount({ jobs: jobs.registry, config: { backgroundIndex: true } })
    const result = await call(ctx, 'dbgraph_index', {}, { agent: true })
    expect(jobs.started).toHaveLength(1)
    expect(jobs.started[0]?.label).toBe('dbgraph index all connections')
    expect(textOf(result)).toContain('Indexing every configured connection')
  })

  it('falls back to a synchronous run when the registry refuses to start a job', async () => {
    const root = await rootWith({
      'status.json': JSON.stringify({
        version: 1,
        updatedAt: NOW,
        connections: {
          prod: { engine: 'mysql', objects: 600, columns: 9000, commentCoverage: 0, digest: [], digestOmitted: 0 },
        },
      }),
    })
    process.env['DSH_DBGRAPH_ROOT'] = root
    const { ctx, stub } = await mount({
      jobs: { start() { throw new Error('the owner already holds its maximum number of jobs') } },
    })
    const result = await call(ctx, 'dbgraph_index', { connection: 'prod' }, { agent: true })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('Indexed prod')
    expect(stub.seen).toEqual([{ method: 'index', request: { mode: 'full', connection: 'prod' } }])
  })
})
