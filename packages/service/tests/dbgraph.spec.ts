import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Dbgraph, {
  DbgraphError,
  DEFAULT_INDEX_STALE_HOURS,
  HARD_MAX_ROWS,
  clampLimit,
  qualifiedName,
  quoteIdentifier,
  renderStatement,
} from '../src/index.ts'
import type {
  ColumnsResult,
  DatabaseDialect,
  DbgraphStore,
  DialectInput,
  DialectProbe,
  Engine,
  FindRequest,
  ImpactResult,
  IndexReport,
  IndexState,
  ObjectsResult,
  RawCatalog,
  RefsResult,
  Resolution,
  SchemaResult,
  SqlResult,
  StoredConnection,
  WriteOptions,
} from '../src/index.ts'

/** A probe that always succeeds, so a test never needs a server. */
const PROBE: DialectProbe = { ok: true, serverVersion: '8.0.0', elapsedMs: 1 }

/** A real Cordis service standing in for `@deepseek-ai/dsh-credentials`. */
class FakeCredentials extends Service {
  resolveImpl: (ref: string) => Promise<{ value: string; source: string } | undefined> = () => Promise.resolve(undefined)
  describeImpl: (ref: string) => Promise<{ configured: boolean; writable: boolean }> =
    () => Promise.resolve({ configured: false, writable: false })
  readonly asked: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    this.asked.push(ref)
    return this.resolveImpl(ref)
  }

  async describe(ref: string): Promise<{ configured: boolean; writable: boolean }> {
    this.asked.push(ref)
    return this.describeImpl(ref)
  }
}

/** Every statement a stub dialect was asked to run, in order. */
interface Recorded {
  readonly queries: string[]
  readonly inputs: string[]
}

/** A dialect that answers the minimum and records what it was asked. */
function stubDialect(recorded: Recorded, result?: SqlResult): DatabaseDialect {
  const empty: RawCatalog = { engine: 'mysql', database: 'shop', objects: [], fetchedAt: 0, level: 'l1' }
  return {
    engine: 'mysql',
    test: () => Promise.resolve(PROBE),
    fetchL1: () => Promise.resolve(empty),
    fetchL2: (_input, l1) => Promise.resolve({ ...l1, level: 'l2' }),
    execute: (_input, query, limits) => {
      recorded.queries.push(query)
      recorded.inputs.push(`${String(limits.maxRows)}:${String(limits.readOnly)}`)
      return Promise.resolve(result ?? {
        columns: ['name', 'passwd'],
        rows: [{ name: '张三', passwd: '[REDACTED]' }],
        rowCount: 1,
        truncated: false,
        redacted: ['passwd'],
        elapsedMs: 3,
      })
    },
  }
}

/** The connections a stub store reports. */
const CONNECTIONS: readonly StoredConnection[] = [
  { id: 'prod', engine: 'mysql', host: 'db.example', database: 'shop' },
]

/** A store that resolves whatever it was told to and records writes. */
function stubStore(options: { resolution?: Resolution; state?: IndexState } = {}): DbgraphStore {
  const resolution: Resolution = options.resolution ?? {
    status: 'resolved',
    reason: 'matched sys_user.passwd by synonym',
    confidence: 0.92,
    resolved: {
      object: 'sys_user',
      kind: 'table',
      comment: '系统用户',
      score: 0.92,
      columns: [{ column: 'passwd', matchedBy: 'synonym', term: '密码', score: 0.92 }],
    },
    predicate: { clause: 'WHERE `name` = ?', values: ['张三'] },
  }
  return {
    id: 'stub-store',
    connections: () => Promise.resolve(CONNECTIONS),
    state: () => Promise.resolve(options.state ?? { objects: 0, columns: 0, stale: true }),
    schema: () => Promise.resolve({
      connection: 'prod', engine: 'mysql', database: 'shop', objects: [], truncated: false,
      index: { objects: 0, columns: 0, stale: true }, commentCoverage: 0,
    } satisfies SchemaResult),
    objects: () => Promise.resolve({ objects: [], truncated: false } satisfies ObjectsResult),
    columns: () => Promise.resolve({
      object: 'sys_user', kind: 'table', columns: [], truncated: false,
    } satisfies ColumnsResult),
    resolve: () => Promise.resolve(resolution),
    impact: () => Promise.resolve({ object: 'sys_user', entries: [], truncated: false } satisfies ImpactResult),
    refs: () => Promise.resolve({ object: 'sys_user', entries: [], truncated: false } satisfies RefsResult),
    write: (_connection, _catalog, opts: WriteOptions) => Promise.resolve({
      connection: 'prod',
      level: 'l2',
      objects: 1,
      columns: 2,
      edges: 0,
      terms: 3,
      writer: opts.writer === 'auto' ? 'js' : opts.writer,
      elapsedMs: 1,
      warnings: [],
    } satisfies IndexReport),
  }
}

/** A seam with one dialect and one store already mounted. */
async function seam(recorded?: Recorded, result?: SqlResult): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Dbgraph)
  ctx.dbgraph.registerDialect(stubDialect(recorded ?? { queries: [], inputs: [] }, result))
  ctx.dbgraph.registerStore(stubStore())
  return ctx
}

describe('dbgraph seam', () => {
  it('publishes ctx.dbgraph and starts with no store and no dialect', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    expect(ctx.dbgraph).toBeInstanceOf(Dbgraph)
    await expect(ctx.dbgraph.schema({ connection: 'prod' })).rejects.toMatchObject({ code: 'DBGRAPH_NO_STORE' })
  })

  it('rejects a second dialect for the same engine', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerDialect(stubDialect({ queries: [], inputs: [] }))
    expect(() => ctx.dbgraph.registerDialect(stubDialect({ queries: [], inputs: [] })))
      .toThrowError(DbgraphError)
    expect(() => ctx.dbgraph.registerDialect(stubDialect({ queries: [], inputs: [] })))
      .toThrowError(/already registered/)
  })

  it('rejects a second store', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerStore(stubStore())
    expect(() => ctx.dbgraph.registerStore(stubStore())).toThrowError(/already registered/)
  })

  it('releases both registrations through their disposers', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    const disposeStore = ctx.dbgraph.registerStore(stubStore())
    const disposeDialect = ctx.dbgraph.registerDialect(stubDialect({ queries: [], inputs: [] }))
    disposeStore()
    disposeDialect()
    await expect(ctx.dbgraph.schema({ connection: 'prod' })).rejects.toMatchObject({ code: 'DBGRAPH_NO_STORE' })
    ctx.dbgraph.registerStore(stubStore())
    await expect(ctx.dbgraph.find({ connection: 'prod', entity: '用户' }))
      .rejects.toMatchObject({ code: 'DBGRAPH_NO_DIALECT' })
  })

  it('rejects an unknown connection id before touching a dialect', async () => {
    const ctx = await seam()
    await expect(ctx.dbgraph.find({ connection: 'nope', entity: '用户' }))
      .rejects.toMatchObject({ code: 'DBGRAPH_UNKNOWN_CONNECTION' })
  })

  it('executes exactly one statement for a resolved find', async () => {
    const recorded: Recorded = { queries: [], inputs: [] }
    const ctx = await seam(recorded)
    const result = await ctx.dbgraph.find({ connection: 'prod', entity: '用户', fields: ['密码'], where: { name: '张三' } })

    expect(recorded.queries).toHaveLength(1)
    expect(recorded.queries[0]).toBe('SELECT `passwd` FROM `sys_user` WHERE `name` = ? LIMIT 50')
    expect(recorded.inputs[0]).toBe('50:true')
    expect(result.status).toBe('resolved')
    expect(result.sql).toBe("SELECT `passwd` FROM `sys_user` WHERE `name` = '张三' LIMIT 50")
    expect(result.rows).toEqual([{ name: '张三', passwd: '[REDACTED]' }])
    expect(result.redacted).toEqual(['passwd'])
  })

  it('returns the resolution unchanged without executing when it is not decisive', async () => {
    const recorded: Recorded = { queries: [], inputs: [] }
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerDialect(stubDialect(recorded))
    ctx.dbgraph.registerStore(stubStore({
      resolution: {
        status: 'ambiguous',
        reason: 'two tables scored within 0.15',
        confidence: 0.51,
        candidates: [{ object: 'sys_user', kind: 'table', score: 0.51, columns: [] }],
      },
    }))

    const result = await ctx.dbgraph.find({ connection: 'prod', entity: '用户' })
    expect(result.status).toBe('ambiguous')
    expect(result.candidates).toHaveLength(1)
    expect(result.rows).toBeUndefined()
    expect(recorded.queries).toEqual([])
  })

  it('passes the requested limit through and clamps it to the hard ceiling', async () => {
    const recorded: Recorded = { queries: [], inputs: [] }
    const ctx = await seam(recorded)
    await ctx.dbgraph.find({ connection: 'prod', object: 'sys_user', limit: 9_999 })
    expect(recorded.queries[0]).toMatch(/LIMIT 500$/)
    expect(recorded.inputs[0]).toBe(`${String(HARD_MAX_ROWS)}:true`)
  })

  it('marks an execute read-only unless the connection opted out of masking', async () => {
    const recorded: Recorded = { queries: [], inputs: [] }
    const ctx = await seam(recorded, {
      columns: [], rows: [], rowCount: 0, truncated: false, redacted: [], elapsedMs: 1,
    })
    await ctx.dbgraph.sql({ connection: 'prod', query: 'SELECT 1' })
    expect(recorded.inputs[0]).toBe('50:true')
  })

  it('reports a connection as unconfigured when no credential seam is mounted', async () => {
    const ctx = await seam()
    const list = await ctx.dbgraph.listConnections()
    expect(list).toHaveLength(1)
    expect(list[0]?.credentialConfigured).toBe(false)
    expect(list[0]?.index).toEqual({ objects: 0, columns: 0, stale: true })
  })

  it('resolves a password through the host credential seam when one is mounted', async () => {
    const ctx = await seam()
    await ctx.plugin(FakeCredentials)
    const credentials = ctx.get('credentials') as FakeCredentials
    credentials.resolveImpl = () => Promise.resolve({ value: 's3cret', source: 'file' })
    credentials.describeImpl = () => Promise.resolve({ configured: true, writable: true })

    const list = await ctx.dbgraph.listConnections()
    expect(list[0]?.credentialConfigured).toBe(true)
    expect(credentials.asked).toEqual(['DBGRAPH_PROD_PASSWORD'])
    expect(await ctx.dbgraph.passwordOf(CONNECTIONS[0]!)).toBe('s3cret')
  })

  it('survives a credential provider that throws while listing', async () => {
    const ctx = await seam()
    await ctx.plugin(FakeCredentials)
    const credentials = ctx.get('credentials') as FakeCredentials
    credentials.resolveImpl = () => Promise.reject(new Error('boom'))
    credentials.describeImpl = () => Promise.reject(new Error('boom'))

    const list = await ctx.dbgraph.listConnections()
    expect(list[0]?.credentialConfigured).toBe(false)
    await expect(ctx.dbgraph.passwordOf(CONNECTIONS[0]!)).rejects.toThrowError('boom')
  })

  it('runs L1 then L2 for a full index and reports the writer that ran', async () => {
    const ctx = await seam()
    const report = await ctx.dbgraph.index({ connection: 'prod', mode: 'full' })
    expect(report.level).toBe('l2')
    expect(report.writer).toBe('js')
    expect(report.connection).toBe('prod')
  })

  it('keeps an L1 snapshot when enrichment throws', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    const dialect = stubDialect({ queries: [], inputs: [] })
    ctx.dbgraph.registerDialect({
      ...dialect,
      fetchL2: () => Promise.reject(new Error('comment column unavailable on this server')),
    })
    ctx.dbgraph.registerStore(stubStore())
    const report = await ctx.dbgraph.index({ connection: 'prod', mode: 'full' })
    expect(report.level).toBe('l2')
    expect(report.warnings.join('\n')).toMatch(/comment column unavailable/)
  })

  it('indexes every configured connection when none is named', async () => {
    const ctx = await seam()
    const reports = await ctx.dbgraph.indexMany({ mode: 'l1' })
    expect(reports.map(report => report.connection)).toEqual(['prod'])
  })

  it('refuses to index when nothing is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerDialect(stubDialect({ queries: [], inputs: [] }))
    ctx.dbgraph.registerStore({ ...stubStore(), connections: () => Promise.resolve([]) })
    await expect(ctx.dbgraph.index({ mode: 'full' })).rejects.toMatchObject({ code: 'DBGRAPH_UNKNOWN_CONNECTION' })
  })

  it('aborts a call whose signal is already set', async () => {
    const ctx = await seam()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.dbgraph.schema({ connection: 'prod' }, controller.signal))
      .rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
  })

  it('rejects a request for an engine with no dialect', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerStore({
      ...stubStore(),
      connections: () => Promise.resolve([{ id: 'pg', engine: 'postgres', database: 'shop' }]),
    })
    await expect(ctx.dbgraph.sql({ connection: 'pg', query: 'SELECT 1' }))
      .rejects.toMatchObject({ code: 'DBGRAPH_NO_DIALECT' })
  })
})

describe('dbgraph helpers', () => {
  it('quotes identifiers per engine', () => {
    expect(quoteIdentifier('mysql', 'order')).toBe('`order`')
    expect(quoteIdentifier('postgres', 'order')).toBe('"order"')
    expect(quoteIdentifier('mysql', 'we`ird')).toBe('`we``ird`')
    expect(quoteIdentifier('postgres', 'we"ird')).toBe('"we""ird"')
    expect(quoteIdentifier('redis', 'user:1:profile')).toBe('user:1:profile')
  })

  it('qualifies a dotted name part by part', () => {
    expect(qualifiedName('mysql', 'shop.sys_user')).toBe('`shop`.`sys_user`')
    expect(qualifiedName('postgres', 'sys_user')).toBe('"sys_user"')
  })

  it('renders bound values for display only', () => {
    expect(renderStatement('WHERE a = ? AND b = ? AND c = ?', [1, "O'Neil", null]))
      .toBe("WHERE a = 1 AND b = 'O''Neil' AND c = NULL")
  })

  it('clamps limits into the configured window', () => {
    const fallback = 50
    expect(clampLimit(undefined, fallback)).toBe(50)
    expect(clampLimit(10, fallback)).toBe(10)
    expect(clampLimit(0, fallback)).toBe(50)
    expect(clampLimit(Number.NaN, fallback)).toBe(50)
    expect(clampLimit(10_000, fallback)).toBe(HARD_MAX_ROWS)
  })
})

/** A connection carrying every optional field, so one call reaches each conditional spread. */
const RICH_CONNECTION: StoredConnection = {
  id: 'rich',
  engine: 'mysql',
  label: '丰富连接',
  host: 'db.example',
  port: 3307,
  database: 'shop',
  user: 'reader',
  credentialRef: 'DBGRAPH_RICH_PASSWORD',
  sensitiveColumns: 'show',
  sensitivePatterns: ['session'],
}

/** A dialect that keeps the input it was handed, so a test can assert what crossed the seam. */
function capturingDialect(captured: DialectInput[]): DatabaseDialect {
  const base = stubDialect({ queries: [], inputs: [] })
  return {
    ...base,
    fetchL1: input => {
      captured.push(input)
      return base.fetchL1(input)
    },
    execute: (input, query, limits, parameters) => {
      captured.push(input)
      return base.execute(input, query, limits, parameters)
    },
  }
}

describe('dbgraph seam edges', () => {
  it('reports the configured index staleness window, and the default when unset', async () => {
    const configured = new Context()
    await configured.plugin(Dbgraph, { indexStaleHours: 2 })
    expect(configured.dbgraph.indexStaleHours).toBe(2)

    const bare = new Context()
    await bare.plugin(Dbgraph)
    expect(bare.dbgraph.indexStaleHours).toBe(DEFAULT_INDEX_STALE_HOURS)
  })

  it('rejects a dialect whose engine is outside the known set', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    const unknown = { ...stubDialect({ queries: [], inputs: [] }), engine: 'oracle' as Engine }
    expect(() => ctx.dbgraph.registerDialect(unknown)).toThrowError(/"oracle" is not a known database engine/)
    expect(() => ctx.dbgraph.registerDialect(unknown)).toThrowError(DbgraphError)
  })

  it('serves impact from the store, and refuses a call whose signal is already aborted', async () => {
    const ctx = await seam()
    await expect(ctx.dbgraph.impact({ connection: 'prod', object: 'sys_user' }))
      .resolves.toMatchObject({ object: 'sys_user', entries: [] })

    const controller = new AbortController()
    controller.abort()
    await expect(ctx.dbgraph.impact({ connection: 'prod', object: 'sys_user' }, controller.signal))
      .rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
  })

  it('leaves the store slot alone when a duplicate registration is disposed after the first', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    const store = stubStore()
    const first = ctx.dbgraph.registerStore(store)
    const second = ctx.dbgraph.registerStore(store)
    first()
    // The slot is empty now, so the second disposer must not resurrect or clear anything.
    second()
    await expect(ctx.dbgraph.schema({ connection: 'prod' })).rejects.toMatchObject({ code: 'DBGRAPH_NO_STORE' })
  })

  it('omits a connection target the configuration does not record', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerStore({
      ...stubStore(),
      connections: () => Promise.resolve([{ id: 'plain', engine: 'mysql' }]),
    })
    const list = await ctx.dbgraph.listConnections()
    expect(list[0]).toEqual({
      id: 'plain',
      engine: 'mysql',
      credentialConfigured: false,
      index: { objects: 0, columns: 0, stale: true },
    })
  })

  it('reports an empty index row when the store unloads while the list is being built', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    let disposeStore: () => void = () => {}
    disposeStore = ctx.dbgraph.registerStore({
      ...stubStore(),
      connections: () => {
        disposeStore()
        return Promise.resolve(CONNECTIONS)
      },
    })
    const list = await ctx.dbgraph.listConnections()
    expect(list[0]?.id).toBe('prod')
    expect(list[0]?.index).toEqual({ objects: 0, columns: 0, stale: true })
  })

  it('selects every column and binds nothing when the resolver names no column or condition', async () => {
    const recorded: Recorded = { queries: [], inputs: [] }
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerDialect(stubDialect(recorded))
    ctx.dbgraph.registerStore(stubStore({
      resolution: {
        status: 'resolved',
        reason: 'matched sys_user by name',
        confidence: 0.8,
        resolved: { object: 'sys_user', kind: 'table', score: 0.8, columns: [] },
      },
    }))

    const result = await ctx.dbgraph.find({ connection: 'prod', object: 'sys_user' })
    expect(recorded.queries[0]).toBe('SELECT * FROM `sys_user` LIMIT 50')
    expect(result.sql).toBe('SELECT * FROM `sys_user` LIMIT 50')
  })

  it('names "none" when no connection is configured but one is requested', async () => {
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerDialect(stubDialect({ queries: [], inputs: [] }))
    ctx.dbgraph.registerStore({ ...stubStore(), connections: () => Promise.resolve([]) })
    await expect(ctx.dbgraph.sql({ connection: 'prod', query: 'SELECT 1' }))
      .rejects.toThrowError(/no connection "prod" is configured \(known: none\)/)
  })

  it('refuses a connection id that could not name a directory', async () => {
    const ctx = await seam()
    await expect(ctx.dbgraph.sql({ connection: 'PROD!', query: 'SELECT 1' }))
      .rejects.toThrowError(/"PROD!" is not a usable connection id/)
  })

  it('forwards every optional connection field, the password and a live signal', async () => {
    const captured: DialectInput[] = []
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerDialect(capturingDialect(captured))
    ctx.dbgraph.registerStore({ ...stubStore(), connections: () => Promise.resolve([RICH_CONNECTION]) })
    await ctx.plugin(FakeCredentials)
    const credentials = ctx.get('credentials') as FakeCredentials
    credentials.resolveImpl = () => Promise.resolve({ value: 's3cret', source: 'file' })
    const signal = new AbortController().signal

    await ctx.dbgraph.index({ connection: 'rich', mode: 'l1' }, signal)
    await ctx.dbgraph.find({ connection: 'rich', object: 'sys_user' }, signal)
    await ctx.dbgraph.sql({ connection: 'rich', query: 'SELECT 1' }, signal)

    expect(captured).toHaveLength(3)
    for (const input of captured) {
      expect(input.connection).toEqual({
        id: 'rich',
        engine: 'mysql',
        label: '丰富连接',
        host: 'db.example',
        port: 3307,
        database: 'shop',
        user: 'reader',
        credentialRef: 'DBGRAPH_RICH_PASSWORD',
        sensitiveColumns: 'show',
        sensitivePatterns: ['session'],
      })
      expect(input.password).toBe('s3cret')
      expect(input.signal).toBe(signal)
    }
  })

  it('omits the target fields the configuration does not record', async () => {
    const captured: DialectInput[] = []
    const ctx = new Context()
    await ctx.plugin(Dbgraph)
    ctx.dbgraph.registerDialect(capturingDialect(captured))
    ctx.dbgraph.registerStore({
      ...stubStore(),
      connections: () => Promise.resolve([{ id: 'bare', engine: 'mysql' }]),
    })

    await ctx.dbgraph.index({ connection: 'bare', mode: 'l1' })
    await ctx.dbgraph.sql({ connection: 'bare', query: 'SELECT 1' })

    expect(captured.map(input => input.connection)).toEqual([
      { id: 'bare', engine: 'mysql' },
      { id: 'bare', engine: 'mysql' },
    ])
    expect(captured.map(input => input.password)).toEqual([undefined, undefined])
    expect(captured.map(input => input.signal)).toEqual([undefined, undefined])
  })

  it('records why enrichment failed whatever the dialect threw', async () => {
    const thrown: readonly [unknown, string][] = [
      ['comment column unavailable', 'comment column unavailable'],
      [{ reason: 'no comment column' }, '{"reason":"no comment column"}'],
      [undefined, 'unknown error'],
    ]
    for (const [error, message] of thrown) {
      const ctx = new Context()
      await ctx.plugin(Dbgraph)
      const dialect = stubDialect({ queries: [], inputs: [] })
      ctx.dbgraph.registerDialect({ ...dialect, fetchL2: () => Promise.reject(error) })
      ctx.dbgraph.registerStore(stubStore())
      const report = await ctx.dbgraph.index({ connection: 'prod', mode: 'full' })
      expect(report.warnings.join('\n')).toContain(`enrichment failed, index stays at L1: ${message}`)
    }
  })

  it('treats a context with no service lookup as having no credential seam', async () => {
    // A composition whose context does not implement `get` is a host this seam must survive, not a
    // crash: both the listing and the password lookup answer "no credential" instead.
    const ctx = await seam()
    Object.defineProperty(ctx, 'get', { value: undefined, configurable: true })

    expect(await ctx.dbgraph.passwordOf(CONNECTIONS[0]!)).toBeUndefined()
    expect((await ctx.dbgraph.listConnections())[0]?.credentialConfigured).toBe(false)
  })
})
