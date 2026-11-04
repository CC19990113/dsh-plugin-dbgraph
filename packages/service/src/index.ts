/**
 * Service Definition for the database-graph capability seam (`ctx.dbgraph`).
 *
 * Three registries, each with a different arity rule, because they answer different questions:
 *
 * - **dialects** — one per {@link Engine}. A second dialect for the same engine is a configuration
 *   error, not a preference, so registration rejects it (`DBGRAPH_CONFLICT`).
 * - **the store** — exactly one. Connections are data (rows in `connections.json`), not plugins, so
 *   nothing needs per-connection routing; a second store would only be ambiguous.
 * - **connections** — zero or more, read from configuration on demand. Several connections being
 *   live at once is the normal case, which is the one place this seam deliberately differs from
 *   `ctx.codegraph`'s "exactly one claimant per root".
 *
 * The seam itself does no network I/O and no SQLite: dialects reach servers, the store reads the
 * index, and {@link Dbgraph.find} is the only method that composes both — resolve offline, then
 * execute once.
 * @module dsh-plugin-dbgraph-service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ConnectionId, credentialRefName, isValidConnectionId } from './brand.ts'
import { DEFAULT_ENUM_SAMPLE_LIMIT, DEFAULT_INDEX_STALE_HOURS } from './schema.ts'
import { ZH_ALIASES } from './zh-aliases.ts'
import { ENGINES } from './types.ts'
import type {
  ColumnsRequest,
  ColumnsResult,
  ConnectionConfig,
  ConnectionSummary,
  DatabaseDialect,
  DbgraphService,
  DbgraphStore,
  DialectInput,
  Engine,
  FindRequest,
  FindResult,
  ImpactRequest,
  ImpactResult,
  IndexReport,
  IndexRequest,
  IndexState,
  ObjectsRequest,
  ObjectsResult,
  RefsRequest,
  RefsResult,
  SchemaRequest,
  SchemaResult,
  SqlRequest,
  SqlResult,
  StoredConnection,
} from './types.ts'

export { assertNever } from './assert.ts'
export { ConnectionId, credentialRefName, isValidConnectionId } from './brand.ts'
export type { ConnectionId as ConnectionIdType } from './brand.ts'
export {
  CONNECTIONS_FILE_NAME,
  DEFAULT_ENUM_SAMPLE_LIMIT,
  DEFAULT_INDEX_STALE_HOURS,
  DEFAULT_STATUS_DIGEST_OBJECTS,
  INDEX_FILE_NAME,
  INDEX_ROOT_DIRNAME,
  INDEX_META_KEYS,
  INDEX_SCHEMA_DDL,
  INDEX_SCHEMA_VERSION,
  STATUS_FILE_NAME,
} from './schema.ts'
export type {
  ConnectionsFile,
  StatusConnectionEntry,
  StatusDigestEntry,
  StatusFile,
  StoredConnection,
} from './schema.ts'
export { SENSITIVE_COLUMN_PATTERNS, ZH_ALIASES, isSensitiveColumn } from './zh-aliases.ts'
export { searchDocument, searchMatchQuery, tokenizeForSearch } from './tokenize.ts'
export { ENGINES, OBJECT_KINDS, EDGE_KINDS } from './types.ts'
export type {
  AliasGroup,
  ColumnView,
  ColumnsRequest,
  ColumnsResult,
  ConnectionConfig,
  ConnectionSummary,
  DatabaseDialect,
  DbgraphService,
  DbgraphStore,
  DialectInput,
  DialectProbe,
  EdgeKind,
  Engine,
  ExecuteLimits,
  FindCandidate,
  FindRequest,
  FindResult,
  FindStatus,
  ImpactRequest,
  ImpactResult,
  IndexLevel,
  IndexReport,
  IndexRequest,
  IndexState,
  IndexWriterKind,
  MatchedColumn,
  MatchSource,
  ObjectKind,
  ObjectView,
  ObjectsRequest,
  ObjectsResult,
  PredicatePlan,
  RawCatalog,
  RawColumn,
  RawEdge,
  RawObject,
  RefsRequest,
  RefsResult,
  RelationView,
  Resolution,
  Row,
  SchemaRequest,
  SchemaResult,
  SensitiveMode,
  SqlRequest,
  SqlResult,
  WriteOptions,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dbgraph: Dbgraph
  }
}

/**
 * Structured database-graph failure. Extends {@link HarnessError} with a stable `code` that callers
 * route on instead of parsing `message`:
 *
 * `DBGRAPH_INVALID_PROVIDER`, `DBGRAPH_INVALID_REQUEST`, `DBGRAPH_CONFLICT`, `DBGRAPH_NO_STORE`,
 * `DBGRAPH_NO_DIALECT`, `DBGRAPH_DRIVER_MISSING`, `DBGRAPH_UNKNOWN_CONNECTION`, `DBGRAPH_UNKNOWN_OBJECT`,
 * `DBGRAPH_UNAVAILABLE`, `DBGRAPH_MALFORMED_INDEX`, `DBGRAPH_QUERY_FAILED`, `DBGRAPH_WRITE_FAILED`,
 * `DBGRAPH_READ_ONLY`, `DBGRAPH_ABORTED`.
 *
 * Three of those are worth telling apart at a call site: `UNAVAILABLE` means the thing is not there
 * (no index file, no server), `MALFORMED_INDEX` means it is there and this build cannot read it, and
 * `READ_ONLY` means the request was refused rather than failing.
 */
export class DbgraphError extends HarnessError {}

/** Default rows returned by a `find` or `sql` call when the caller names no limit. */
export const DEFAULT_MAX_ROWS = 50

/** Hard ceiling on rows any one call returns, whatever the caller asks for. */
export const HARD_MAX_ROWS = 500

/** Default per-statement timeout, in milliseconds. */
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000

/**
 * A resolved-or-not credential lookup. Declared structurally instead of importing
 * `@deepseek-ai/dsh-credentials`, for the same reason every optional host service is: the seam is
 * optional, and a host version without it must degrade rather than fail to load.
 */
interface CredentialSeam {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>
}

/** Plugin configuration: only the bounds a deployment may retune. */
export interface Config {
  /** Hours after which an L2 snapshot counts as stale. */
  indexStaleHours?: number
  /** Statement timeout in milliseconds. */
  queryTimeoutMs?: number
  /** Rows returned when a caller names no limit. */
  defaultMaxRows?: number
  /** Distinct-value sample size requested from a dialect. */
  enumSampleLimit?: number
}

/**
 * `ctx.dbgraph`. Holds the dialect registry and the single store reservation; every read goes
 * through whatever is registered at call time, so a store that unloads mid-session stops serving
 * without leaving a stale route behind.
 */
export class Dbgraph extends Service implements DbgraphService {
  private readonly dialects = new Map<Engine, DatabaseDialect>()
  private store: DbgraphStore | undefined
  private readonly config: Config

  /**
   * @param ctx - Cordis context.
   * @param config - deployment bounds.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'dbgraph')
    this.config = config
  }

  /** Hours after which an L2 snapshot is reported stale. */
  get indexStaleHours(): number {
    return this.config.indexStaleHours ?? DEFAULT_INDEX_STALE_HOURS
  }

  /** Rows a call returns when the caller names no limit. */
  get defaultMaxRows(): number {
    return this.config.defaultMaxRows ?? DEFAULT_MAX_ROWS
  }

  /** Statement timeout in milliseconds. */
  get queryTimeoutMs(): number {
    return this.config.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
  }

  /** Distinct-value sample size requested from a dialect. */
  get enumSampleLimit(): number {
    return this.config.enumSampleLimit ?? DEFAULT_ENUM_SAMPLE_LIMIT
  }

  /**
   * Register one engine's dialect.
   * @param dialect - the dialect to serve.
   * @returns the disposer that unregisters it.
   */
  registerDialect(dialect: DatabaseDialect): () => void {
    const engine = dialect.engine
    if (!ENGINES.includes(engine)) {
      throw new DbgraphError(`"${String(engine)}" is not a known database engine`, 'DBGRAPH_INVALID_PROVIDER')
    }
    if (this.dialects.has(engine)) {
      throw new DbgraphError(`a dialect for "${engine}" is already registered`, 'DBGRAPH_CONFLICT')
    }
    const dispose = this.ctx.effect(function* (this: Dbgraph) {
      this.dialects.set(engine, dialect)
      yield () => {
        this.dialects.delete(engine)
      }
    }.bind(this), 'dbgraph.registerDialect()')
    return () => void dispose()
  }

  /**
   * Register the offline index store.
   * @param store - the store to serve every read and write.
   * @returns the disposer that unregisters it.
   */
  registerStore(store: DbgraphStore): () => void {
    if (this.store !== undefined && this.store !== store) {
      throw new DbgraphError(`a database-graph store ("${this.store.id}") is already registered`, 'DBGRAPH_CONFLICT')
    }
    const dispose = this.ctx.effect(function* (this: Dbgraph) {
      this.store = store
      yield () => {
        if (this.store === store) this.store = undefined
      }
    }.bind(this), 'dbgraph.registerStore()')
    return () => void dispose()
  }

  /**
   * Every configured connection with its index state.
   * @returns one entry per connection, secrets omitted.
   */
  async listConnections(): Promise<readonly ConnectionSummary[]> {
    const stored = await this.readConnections()
    const credentials = this.credentialSeam()
    const summaries: ConnectionSummary[] = []
    for (const entry of stored) {
      summaries.push({
        id: entry.id,
        engine: entry.engine as Engine,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.host === undefined ? {} : { host: entry.host }),
        ...(entry.database === undefined ? {} : { database: entry.database }),
        credentialConfigured: await this.describeCredential(credentials, entry),
        index: await this.indexStateOf(entry.id),
      })
    }
    return summaries
  }

  /**
   * Structural overview of one connection, from the index.
   * @param request - the connection to describe.
   * @param signal - aborts the read.
   * @returns the overview.
   */
  async schema(request: SchemaRequest, signal?: AbortSignal): Promise<SchemaResult> {
    throwIfAborted(signal)
    return (await this.requireStore()).schema(request)
  }

  /**
   * Ranked object listing for one connection, from the index.
   * @param request - the listing request.
   * @param signal - aborts the read.
   * @returns the listing.
   */
  async objects(request: ObjectsRequest, signal?: AbortSignal): Promise<ObjectsResult> {
    throwIfAborted(signal)
    return (await this.requireStore()).objects(request)
  }

  /**
   * One object's columns, from the index.
   * @param request - the columns request.
   * @param signal - aborts the read.
   * @returns the column list.
   */
  async columns(request: ColumnsRequest, signal?: AbortSignal): Promise<ColumnsResult> {
    throwIfAborted(signal)
    return (await this.requireStore()).columns(request)
  }

  /**
   * Resolve words to an object and columns offline, then execute one parameterized read.
   *
   * This is the method the plugin exists for: zero round-trips learning the schema, exactly one
   * round-trip fetching the answer.
   * @param request - what the user asked about.
   * @param signal - aborts both the resolution and the execution.
   * @returns the rows, or why there are none.
   */
  async find(request: FindRequest, signal?: AbortSignal): Promise<FindResult> {
    const started = Date.now()
    throwIfAborted(signal)
    const store = await this.requireStore()
    const resolution = await store.resolve(request)
    const failed: FindResult = {
      status: resolution.status,
      reason: resolution.reason,
      confidence: resolution.confidence,
      ...(resolution.candidates === undefined ? {} : { candidates: resolution.candidates }),
      ...(resolution.resolved === undefined ? {} : { resolved: resolution.resolved }),
      elapsedMs: Date.now() - started,
    }
    if (resolution.status !== 'resolved' || resolution.resolved === undefined) return failed

    const stored = await this.requireConnection(request.connection)
    const engine = stored.engine as Engine
    const dialect = await this.requireDialect(engine)
    const limit = clampLimit(request.limit, this.defaultMaxRows)
    const columns = resolution.resolved.columns.map(column => quoteIdentifier(engine, column.column))
    const clause = resolution.predicate === undefined || resolution.predicate.clause === ''
      ? ''
      : ` ${resolution.predicate.clause}`
    const sql = `SELECT ${columns.length === 0 ? '*' : columns.join(', ')}`
      + ` FROM ${qualifiedName(engine, resolution.resolved.object)}${clause} LIMIT ${limit}`

    const executed = await dialect.execute(
      this.dialectInput(stored, await this.passwordOf(stored), signal),
      sql,
      { maxRows: limit, timeoutMs: this.queryTimeoutMs, readOnly: true },
      resolution.predicate?.values ?? [],
    )

    return {
      status: 'resolved',
      reason: resolution.reason,
      resolved: resolution.resolved,
      confidence: resolution.confidence,
      sql: renderStatement(sql, resolution.predicate?.values ?? []),
      rows: executed.rows,
      rowCount: executed.rowCount,
      truncated: executed.truncated,
      redacted: executed.redacted,
      elapsedMs: Date.now() - started,
    }
  }

  /**
   * Execute one statement against the server, with no semantic resolution.
   * @param request - the statement and its limits.
   * @param signal - aborts the execution.
   * @returns the result set.
   */
  async sql(request: SqlRequest, signal?: AbortSignal): Promise<SqlResult> {
    throwIfAborted(signal)
    const stored = await this.requireConnection(request.connection)
    const engine = stored.engine as Engine
    const dialect = await this.requireDialect(engine)
    return dialect.execute(
      this.dialectInput(stored, await this.passwordOf(stored), signal),
      request.query,
      {
        maxRows: clampLimit(request.limit, this.defaultMaxRows),
        timeoutMs: request.timeoutMs ?? this.queryTimeoutMs,
        readOnly: stored.sensitiveColumns !== 'show',
      },
    )
  }

  /**
   * Objects a change to one object reaches, from the index.
   * @param request - the object to trace.
   * @param signal - aborts the read.
   * @returns the affected objects.
   */
  async impact(request: ImpactRequest, signal?: AbortSignal): Promise<ImpactResult> {
    throwIfAborted(signal)
    return (await this.requireStore()).impact(request)
  }

  /**
   * Objects referencing one object, from the index.
   * @param request - the object to trace.
   * @param signal - aborts the read.
   * @returns the referencing objects.
   */
  async refs(request: RefsRequest, signal?: AbortSignal): Promise<RefsResult> {
    throwIfAborted(signal)
    return (await this.requireStore()).refs(request)
  }

  /**
   * Build or refresh an index. With no `connection`, every configured connection is indexed and the
   * first report is returned; use {@link indexMany} when the caller needs all of them.
   * @param request - which connection and how deep.
   * @param signal - aborts the run.
   * @returns the first connection's report.
   */
  async index(request: IndexRequest, signal?: AbortSignal): Promise<IndexReport> {
    const reports = await this.indexMany(request, signal)
    const first = reports[0]
    if (first === undefined) {
      throw new DbgraphError('no connection was configured to index', 'DBGRAPH_UNKNOWN_CONNECTION')
    }
    return first
  }

  /**
   * Index every target connection in one call.
   * @param request - which connections and how deep.
   * @param signal - aborts the run.
   * @returns one report per connection, in configuration order.
   */
  async indexMany(request: IndexRequest, signal?: AbortSignal): Promise<IndexReport[]> {
    const store = await this.requireStore()
    const targets = request.connection === undefined
      ? await this.readConnections()
      : [await this.requireConnection(request.connection)]
    const reports: IndexReport[] = []
    for (const target of targets) {
      throwIfAborted(signal)
      reports.push(await this.indexOne(store, target, request, signal))
    }
    return reports
  }

  /**
   * Record a report produced out of process, so the digest sidecar tracks the file on disk.
   * @param report - the finished run's report.
   * @returns nothing; the report is already durable in the index.
   */
  async recordIndex(report: IndexReport): Promise<void> {
    const store = await this.requireStore()
    if (store.record !== undefined) await store.record(report)
  }

  /**
   * Resolve one connection's password through the host credential seam.
   * @param connection - the connection to resolve for.
   * @returns the plaintext password, or undefined when the seam is absent or the ref is unconfigured.
   */
  async passwordOf(connection: StoredConnection): Promise<string | undefined> {
    const credentials = this.credentialSeam()
    if (credentials === undefined) return undefined
    const ref = connection.credentialRef ?? credentialRefName(ConnectionId(connection.id))
    return (await credentials.resolve(ref))?.value
  }

  /**
   * The configured connections, as the store's configuration file lists them.
   * @returns the connection list in configuration order.
   */
  async readConnections(): Promise<readonly StoredConnection[]> {
    return (await this.requireStore()).connections()
  }

  private async indexOne(
    store: DbgraphStore,
    connection: StoredConnection,
    request: IndexRequest,
    signal?: AbortSignal,
  ): Promise<IndexReport> {
    const dialect = await this.requireDialect(connection.engine as Engine)
    const input = await this.dialectInputFor(connection, signal)
    const started = Date.now()
    const warnings: string[] = []

    const l1 = await dialect.fetchL1(input)
    let catalog = l1
    if (request.mode !== 'l1') {
      try {
        catalog = await dialect.fetchL2(input, l1)
      } catch (error) {
        // An enrichment failure must not throw away the structural snapshot already in hand: an L1
        // index answers "which columns exist", which is most of the value. Record why and continue.
        warnings.push(`enrichment failed, index stays at L1: ${messageOf(error)}`)
      }
    }

    const report = await store.write(ConnectionId(connection.id), catalog, {
      writer: request.writer ?? 'auto',
      aliases: ZH_ALIASES,
    })

    return { ...report, elapsedMs: Date.now() - started, warnings: [...report.warnings, ...warnings] }
  }

  private async dialectInputFor(
    connection: StoredConnection,
    signal: AbortSignal | undefined,
  ): Promise<DialectInput> {
    const config: ConnectionConfig = {
      id: connection.id,
      engine: connection.engine as Engine,
      ...(connection.label === undefined ? {} : { label: connection.label }),
      ...(connection.host === undefined ? {} : { host: connection.host }),
      ...(connection.port === undefined ? {} : { port: connection.port }),
      ...(connection.database === undefined ? {} : { database: connection.database }),
      ...(connection.user === undefined ? {} : { user: connection.user }),
      ...(connection.credentialRef === undefined ? {} : { credentialRef: connection.credentialRef }),
      ...(connection.sensitiveColumns === 'show' ? { sensitiveColumns: 'show' as const } : {}),
      ...(connection.sensitivePatterns === undefined ? {} : { sensitivePatterns: connection.sensitivePatterns }),
    }
    const password = await this.passwordOf(connection)
    return {
      connection: config,
      ...(password === undefined ? {} : { password }),
      enumSampleLimit: this.enumSampleLimit,
      queryTimeoutMs: this.queryTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }
  }

  private dialectInput(
    connection: StoredConnection,
    password: string | undefined,
    signal: AbortSignal | undefined,
  ): DialectInput {
    const config: ConnectionConfig = {
      id: connection.id,
      engine: connection.engine as Engine,
      ...(connection.label === undefined ? {} : { label: connection.label }),
      ...(connection.host === undefined ? {} : { host: connection.host }),
      ...(connection.port === undefined ? {} : { port: connection.port }),
      ...(connection.database === undefined ? {} : { database: connection.database }),
      ...(connection.user === undefined ? {} : { user: connection.user }),
      ...(connection.credentialRef === undefined ? {} : { credentialRef: connection.credentialRef }),
      ...(connection.sensitiveColumns === 'show' ? { sensitiveColumns: 'show' as const } : {}),
      ...(connection.sensitivePatterns === undefined ? {} : { sensitivePatterns: connection.sensitivePatterns }),
    }
    return {
      connection: config,
      ...(password === undefined ? {} : { password }),
      enumSampleLimit: this.enumSampleLimit,
      queryTimeoutMs: this.queryTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }
  }

  private async indexStateOf(id: string): Promise<IndexState> {
    const store = this.store
    if (store === undefined) return { objects: 0, columns: 0, stale: true }
    return store.state(id)
  }

  private async describeCredential(
    credentials: CredentialSeam | undefined,
    connection: StoredConnection,
  ): Promise<boolean> {
    if (credentials === undefined) return false
    const ref = connection.credentialRef ?? credentialRefName(ConnectionId(connection.id))
    try {
      return (await credentials.describe(ref)).configured
    } catch {
      // A provider that throws is "not configured" for a listing: a status line must never fail.
      return false
    }
  }

  /**
   * The host's credential seam, when this composition has one. Looked up per call rather than
   * captured, so a profile that mounts it later starts working without a restart.
   * @returns the seam, or undefined.
   */
  private credentialSeam(): CredentialSeam | undefined {
    const lookup = (this.ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof lookup !== 'function') return undefined
    const seam = lookup.call(this.ctx, 'credentials')
    return seam === undefined ? undefined : (seam as CredentialSeam)
  }

  private async requireStore(): Promise<DbgraphStore> {
    if (this.store === undefined) {
      throw new DbgraphError(
        'no database-graph store is registered; mount dsh-plugin-dbgraph-store',
        'DBGRAPH_NO_STORE',
      )
    }
    return this.store
  }

  private async requireDialect(engine: Engine): Promise<DatabaseDialect> {
    const dialect = this.dialects.get(engine)
    if (dialect === undefined) {
      throw new DbgraphError(
        `no dialect for "${engine}" is registered; mount a catalog package that provides it`,
        'DBGRAPH_NO_DIALECT',
      )
    }
    return dialect
  }

  private async requireConnection(id: string): Promise<StoredConnection> {
    if (!isValidConnectionId(id)) {
      throw new DbgraphError(`"${id}" is not a usable connection id`, 'DBGRAPH_UNKNOWN_CONNECTION')
    }
    const all = await this.readConnections()
    const found = all.find(entry => entry.id === id)
    if (found === undefined) {
      throw new DbgraphError(
        `no connection "${id}" is configured (known: ${all.map(entry => entry.id).join(', ') || 'none'})`,
        'DBGRAPH_UNKNOWN_CONNECTION',
      )
    }
    return found
  }
}

/**
 * Quote an identifier the way an engine expects.
 * @param engine - which dialect's quoting rules to apply.
 * @param name - the identifier.
 * @returns the quoted identifier.
 */
export function quoteIdentifier(engine: Engine, name: string): string {
  if (engine === 'mysql') return `\`${name.replace(/`/g, '``')}\``
  if (engine === 'mongodb' || engine === 'redis') return name
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Render a fully qualified object name.
 * @param engine - which dialect's quoting rules to apply.
 * @param object - name, possibly schema-qualified.
 * @returns the quoted, dotted name.
 */
export function qualifiedName(engine: Engine, object: string): string {
  return object.split('.').map(part => quoteIdentifier(engine, part)).join('.')
}

/**
 * Render a statement with its bound values substituted, for display only.
 *
 * The result is never executed: it exists so a model reading the answer can see what condition was
 * applied without guessing. Every value is rendered as a quoted literal.
 * @param sql - the statement with `?` placeholders.
 * @param values - the bound values, in placeholder order.
 * @returns the statement with literals substituted.
 */
export function renderStatement(sql: string, values: readonly unknown[]): string {
  let index = 0
  return sql.replace(/\?/g, () => {
    const value = values[index]
    index += 1
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') return String(value)
    return `'${String(value).replace(/'/g, "''")}'`
  })
}

/**
 * Clamp a caller's row limit into the configured ceiling.
 * @param requested - the caller's value, when one was named.
 * @param fallback - the configured default.
 * @returns a limit between 1 and {@link HARD_MAX_ROWS}.
 */
export function clampLimit(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback
  if (!Number.isFinite(value) || value < 1) return Math.min(fallback, HARD_MAX_ROWS)
  return Math.min(Math.floor(value), HARD_MAX_ROWS)
}

/**
 * Throw when a call was aborted before it started.
 * @param signal - the caller's abort signal, when one was supplied.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DbgraphError('the call was aborted', 'DBGRAPH_ABORTED')
  }
}

/**
 * One error's message, for appending to a warning list.
 * @param error - the thrown value.
 * @returns a non-empty message.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error) ?? 'unknown error'
}

/** Re-exported so a dialect package can name the branded id without importing `brand.ts`. */
export type { Branded } from '@deepseek-ai/dsh-brand'

export default Dbgraph
