/**
 * Model-facing `dbgraph` tool family over `ctx.dbgraph`.
 *
 * Two tools, deliberately separate. `dbgraph` is the read side, with the eight operations the seam
 * answers directly; `dbgraph_index` builds or refreshes the on-disk index on explicit request. They
 * are separate because `defineTool`'s `timeoutMs` is fixed per registration, not per call: a query
 * is milliseconds and an index build is minutes, so one budget cannot fit both.
 *
 * The plugin also owns the system-prompt section that carries the schema digest. That section's
 * `text` is a function, not a string: the host re-evaluates it on every assembly, which is what lets
 * the model learn which tables exist for free instead of spending a discovery round-trip. The
 * function reads a small JSON sidecar synchronously — opening SQLite, or reaching a server, from an
 * assembly would tax every request.
 *
 * The tools own every default the seam refuses to guess — result limits, prompt budgets, the
 * background-index threshold — so the seam's requests stay fully specified and a deployment can
 * retune the model's answer size without touching a store. The `/dbgraph` command attaches through
 * conditional injection instead, so a host without a command registry still gets the tool family.
 *
 * Namespace plugin (named exports, no default export).
 * @module dsh-plugin-dbgraph-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_INDEX_STALE_HOURS, DbgraphError } from 'dsh-plugin-dbgraph-service'
import type {
  ColumnView,
  ConnectionSummary,
  FindCandidate,
  FindRequest,
  ImpactRequest,
  IndexReport,
  IndexRequest,
  IndexState,
  ObjectView,
  RelationView,
  Row,
  SqlRequest,
} from 'dsh-plugin-dbgraph-service'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerCommands } from './command.ts'
import { DBGRAPH_PROMPT_TEXT, dbgraphPromptHint, DEFAULT_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_TABLES, readStatusFile } from './prompt.ts'
import { renderDbgraph, renderDbgraphIndex } from './render.ts'
import {
  DBGRAPH_INDEX_OUTPUT_SCHEMA,
  DBGRAPH_INDEX_PARAMETERS,
  DBGRAPH_OUTPUT_SCHEMA,
  DBGRAPH_PARAMETERS,
} from './schema.ts'
import type {
  DbgraphIndexToolArgs,
  DbgraphIndexToolValue,
  DbgraphToolArgs,
  DbgraphToolValue,
  DbgraphValueFor,
} from './schema.ts'

export { renderDbgraph, renderDbgraphIndex } from './render.ts'
export {
  DBGRAPH_INDEX_MODES,
  DBGRAPH_INDEX_OUTPUT_SCHEMA,
  DBGRAPH_INDEX_PARAMETERS,
  DBGRAPH_INDEX_WRITERS,
  DBGRAPH_OPERATIONS,
  DBGRAPH_OUTPUT_SCHEMA,
  DBGRAPH_PARAMETERS,
  type DbgraphIndexToolArgs,
  type DbgraphIndexToolValue,
  type DbgraphToolArgs,
  type DbgraphToolOperation,
  type DbgraphToolValue,
  type DbgraphValueFor,
} from './schema.ts'
export {
  COMMAND_DEFINITION_ID,
  COMMAND_DESCRIPTION,
  COMMAND_INPUT_HINT,
  COMMAND_NAME,
  COMMAND_USAGE,
  registerCommands,
} from './command.ts'
export type { CommandDefinition, CommandDefinitionId, CommandInvocation, CommandRegistry, CommandResult } from './command.ts'
export {
  DBGRAPH_PROMPT_TEXT,
  DEFAULT_MAX_PROMPT_CHARS,
  DEFAULT_MAX_PROMPT_TABLES,
  dbgraphPromptHint,
  dbgraphRoot,
  formatAge,
  readIndexDirectories,
  readStatusFile,
  renderStatusDigest,
} from './prompt.ts'
export type { DigestLimits, PromptHintOptions } from './prompt.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-dbgraph'

/** Services required by this plugin. */
export const inject = ['tools', 'dbgraph', 'systemPrompt']

/** Default tool-call timeout budget (ms) for the query-side `dbgraph` tool. */
export const DEFAULT_DBGRAPH_TOOL_TIMEOUT_MS = 30_000

/** Default timeout budget (ms) for `dbgraph_index`. Building an index is a different order of work than a query. */
export const DEFAULT_DBGRAPH_INDEX_TIMEOUT_MS = 300_000

/** Objects per connection past which an index run moves to a background job under `backgroundIndex: 'auto'`. */
export const DEFAULT_BACKGROUND_INDEX_THRESHOLD = 500

/** Rows a `find` or `sql` call returns when the model names no `limit`. */
export const DEFAULT_TOOL_LIMIT = 50

/** Largest `limit` honored, whatever the model asks for. */
export const DEFAULT_MAX_TOOL_LIMIT = 200

/** Plugin configuration: the defaults and caps the seam requires the consumer to own. */
export interface Config {
  /** Rows returned when the model names no `limit` (default 50). */
  defaultLimit?: number
  /** Largest `limit` honored (default 200). */
  maxLimit?: number
  /** Objects the prompt digest lists at most, across all connections (default 40). */
  maxPromptTables?: number
  /** Characters the prompt digest may occupy (default 6000). */
  maxPromptChars?: number
  /** Hours after which the digest marks the index stale (default 6, the seam's default). */
  indexStaleHours?: number
  /** Whether to register the system-prompt section (default true). Off hides the digest, not the tools. */
  prompt?: boolean
  /**
   * Whether an index run moves to the host's background-job registry: `'auto'` (default) decides by
   * the connection's last indexed object count, `true` always uses a job when the host offers one,
   * and `false` always runs synchronously inside the tool call.
   */
  backgroundIndex?: 'auto' | boolean
  /** Objects the last index must have covered before `'auto'` uses a job (default 500). */
  backgroundIndexThreshold?: number
  /** Tool-call timeout budget in ms for the query-side `dbgraph` tool (default 30000). */
  timeoutMs?: number
  /** Tool-call timeout budget in ms for `dbgraph_index` (default 300000). */
  indexTimeoutMs?: number
}

/** Every configuration field with its default applied. */
export type ResolvedConfig = Required<Config>

/**
 * Apply every default and reject a value that would fail at call time instead.
 * @param config - the deployment's configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved: ResolvedConfig = {
    defaultLimit: config.defaultLimit ?? DEFAULT_TOOL_LIMIT,
    maxLimit: config.maxLimit ?? DEFAULT_MAX_TOOL_LIMIT,
    maxPromptTables: config.maxPromptTables ?? DEFAULT_MAX_PROMPT_TABLES,
    maxPromptChars: config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    indexStaleHours: config.indexStaleHours ?? DEFAULT_INDEX_STALE_HOURS,
    prompt: config.prompt ?? true,
    backgroundIndex: config.backgroundIndex ?? 'auto',
    backgroundIndexThreshold: config.backgroundIndexThreshold ?? DEFAULT_BACKGROUND_INDEX_THRESHOLD,
    timeoutMs: config.timeoutMs ?? DEFAULT_DBGRAPH_TOOL_TIMEOUT_MS,
    indexTimeoutMs: config.indexTimeoutMs ?? DEFAULT_DBGRAPH_INDEX_TIMEOUT_MS,
  }
  for (const field of [
    'defaultLimit', 'maxLimit', 'maxPromptTables', 'maxPromptChars', 'indexStaleHours', 'backgroundIndexThreshold',
  ] as const) {
    assertPositiveInteger(field, resolved[field])
  }
  assertTimer('timeoutMs', resolved.timeoutMs)
  assertTimer('indexTimeoutMs', resolved.indexTimeoutMs)
  return resolved
}

/**
 * Register the two model-facing tools, their system-prompt section, and the `/dbgraph` command.
 * @param ctx - the plugin context (must inject `tools`, `dbgraph`, `systemPrompt`).
 * @param config - the plugin configuration, or a partial one.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)

  // A function, not a string: the host re-evaluates it on every assembly, which is what lets the
  // model learn the configured tables for free. It is total by construction — `prompt.ts` turns
  // every filesystem and parse failure into a weaker sentence — so an assembly never fails here.
  if (resolved.prompt) {
    ctx.systemPrompt.section({
      name: 'tool:dbgraph',
      order: 112,
      text: () => [DBGRAPH_PROMPT_TEXT, dbgraphPromptHint({
        maxPromptTables: resolved.maxPromptTables,
        maxPromptChars: resolved.maxPromptChars,
        staleHours: resolved.indexStaleHours,
        // The store owns the index root; the environment variable is only the fallback for a
        // composition that mounts the tool without a store. Deriving it here independently would let
        // the digest describe a directory the index is not in.
        ...ctx.dbgraph.storeRoot === undefined ? {} : { root: ctx.dbgraph.storeRoot },
      })].filter(part => part !== '').join('\n\n'),
    })
  }

  ctx.tools.register(defineTool({
    name: 'dbgraph',
    description:
      'Query a pre-built index of the configured databases\' structure, and fetch data in one call. '
      + 'The system prompt already lists the indexed tables; use dbgraph find with a business word, '
      + 'column names, and a filter to resolve offline and execute ONE parameterized read. Use schema, '
      + 'objects, columns, impact, and refs for structure, and sql only when no resolution fits. '
      + 'Sensitive columns are masked in results.',
    parameters: DBGRAPH_PARAMETERS,
    output: {
      schema: DBGRAPH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDbgraph(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return run(ctx, resolved, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: callTitle(args),
      kind: 'search' as const,
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'dbgraph_index',
    description:
      'Build or refresh the dbgraph index for one connection, or every configured connection. '
      + 'Without a connection every configured connection is indexed and every report is returned. '
      + 'Indexing reads the database catalog and can take minutes, so this runs on its own timeout '
      + 'budget, separate from dbgraph\'s query operations. A database large enough to outlive the call '
      + 'is handed to a background job and answered immediately with that job\'s id; read its report with job_output.',
    parameters: DBGRAPH_INDEX_PARAMETERS,
    output: {
      schema: DBGRAPH_INDEX_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDbgraphIndex(value) }],
    },
    timeoutMs: resolved.indexTimeoutMs,
    async execute(args, exec) {
      return runIndex(ctx, resolved, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: args.connection === undefined ? 'dbgraph_index' : `dbgraph_index ${args.connection}`,
      kind: 'execute' as const,
      rawInput: args,
    }),
  }))

  registerCommands(ctx)
}

/**
 * The one-line label a pending call shows.
 * @param args - the validated tool arguments.
 * @returns the card title naming the operation and whichever subject the operation takes.
 */
export function callTitle(args: DbgraphToolArgs): string {
  const subject = args.entity ?? args.object ?? args.query ?? args.connection
  return subject === undefined ? `dbgraph ${args.operation}` : `dbgraph ${args.operation} ${subject}`
}

/** One connection as the model-facing value sees it. */
type ConnectionValue = DbgraphValueFor<'connections'>['connections'][number]

/** One object as the model-facing value sees it. */
type ObjectValue = DbgraphValueFor<'schema'>['objects'][number]

/** One column as the model-facing value sees it. */
type ColumnValue = DbgraphValueFor<'columns'>['columns'][number]

/** One edge as the model-facing value sees it. */
type RelationValue = DbgraphValueFor<'refs'>['entries'][number]

/** One resolver candidate as the model-facing value sees it. */
type CandidateValue = NonNullable<DbgraphValueFor<'find'>['resolved']>

/** One matched column as the model-facing value sees it. */
type MatchedColumnValue = CandidateValue['columns'][number]

/**
 * The seam guarantees JSON-safe row values (its dialects serialize Dates and Buffers before
 * returning them); this one cast records that guarantee instead of re-checking every cell.
 * @param rows - the seam's rows.
 * @returns the same rows, typed as the lossless JSON the output schema declares.
 */
function jsonRows(rows: readonly Row[]): JsonValue[] {
  return rows as unknown as JsonValue[]
}

/** Project one index state onto the model-facing field names. */
function indexStateValue(state: IndexState): ConnectionValue['index'] {
  return {
    ...state.l1IndexedAt === undefined ? {} : { l1_indexed_at: state.l1IndexedAt },
    ...state.l2IndexedAt === undefined ? {} : { l2_indexed_at: state.l2IndexedAt },
    objects: state.objects,
    columns: state.columns,
    stale: state.stale,
    ...state.writer === undefined ? {} : { writer: state.writer },
  }
}

/** Project one connection onto the model-facing field names. */
function connectionValue(connection: ConnectionSummary): ConnectionValue {
  return {
    id: connection.id,
    engine: connection.engine,
    ...connection.label === undefined ? {} : { label: connection.label },
    ...connection.host === undefined ? {} : { host: connection.host },
    ...connection.database === undefined ? {} : { database: connection.database },
    credential_configured: connection.credentialConfigured,
    index: indexStateValue(connection.index),
  }
}

/** Project one object onto the model-facing field names. */
function objectValue(object: ObjectView): ObjectValue {
  return {
    object: object.object,
    kind: object.kind,
    ...object.comment === undefined ? {} : { comment: object.comment },
    column_count: object.columnCount,
    ...object.rowEstimate === undefined ? {} : { row_estimate: object.rowEstimate },
  }
}

/** Project one column onto the model-facing field names. */
function columnValue(column: ColumnView): ColumnValue {
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    ...column.defaultValue === undefined ? {} : { default_value: column.defaultValue },
    ...column.comment === undefined ? {} : { comment: column.comment },
    is_primary_key: column.isPrimaryKey,
    is_unique: column.isUnique,
    ...column.enumValues === undefined ? {} : { enum_values: [...column.enumValues] },
  }
}

/** Project one edge onto the model-facing field names. */
function relationValue(entry: RelationView): RelationValue {
  return {
    kind: entry.kind,
    object: entry.object,
    ...entry.column === undefined ? {} : { column: entry.column },
    ...entry.refColumn === undefined ? {} : { ref_column: entry.refColumn },
    ...entry.name === undefined ? {} : { name: entry.name },
  }
}

/** Project one matched column onto the model-facing field names. */
function matchedColumnValue(column: FindCandidate['columns'][number]): MatchedColumnValue {
  return {
    column: column.column,
    ...column.comment === undefined ? {} : { comment: column.comment },
    matched_by: column.matchedBy,
    ...column.term === undefined ? {} : { term: column.term },
    score: column.score,
  }
}

/** Project one resolver candidate onto the model-facing field names. */
function candidateValue(candidate: FindCandidate): CandidateValue {
  return {
    object: candidate.object,
    kind: candidate.kind,
    ...candidate.comment === undefined ? {} : { comment: candidate.comment },
    score: candidate.score,
    columns: candidate.columns.map(matchedColumnValue),
  }
}

/** Project every finished index run onto the model-facing field names. */
export function completedIndexValue(reports: readonly IndexReport[]): DbgraphIndexToolValue {
  return {
    status: 'completed',
    reports: reports.map(report => ({
      connection: report.connection,
      level: report.level,
      objects: report.objects,
      columns: report.columns,
      edges: report.edges,
      terms: report.terms,
      writer: report.writer,
      elapsed_ms: report.elapsedMs,
      ...report.warnings.length === 0 ? {} : { warnings: [...report.warnings] },
    })),
  }
}

/** Read a required string argument, rejecting an absent or blank value. */
function required(args: DbgraphToolArgs, field: 'connection' | 'object' | 'query'): string {
  const value = args[field]
  if (value === undefined || value.trim() === '') {
    throw new DbgraphError(
      `the dbgraph "${args.operation}" operation requires a non-empty "${field}"`,
      'DBGRAPH_INVALID_REQUEST',
    )
  }
  return value
}

/** Clamp a model-supplied bound into the configured range. */
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(value)))
}

/**
 * The validated `where` object of a `find` request, or `undefined` when none was supplied.
 * @param value - the model's JSON value.
 * @returns the object, typed for the seam's request.
 */
function predicateValues(value: JsonValue | undefined): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DbgraphError(
      'the dbgraph "find" operation requires "where" to be a JSON object mapping a column to a value',
      'DBGRAPH_INVALID_REQUEST',
    )
  }
  return value as Readonly<Record<string, unknown>>
}

/**
 * Answer one query-side tool call.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context.
 * @returns the canonical value for the requested operation.
 */
async function run(
  ctx: Context,
  config: ResolvedConfig,
  args: DbgraphToolArgs,
  exec: ToolRunContext,
): Promise<DbgraphToolValue> {
  const signal = exec.signal
  const limit = bounded(args.limit, config.defaultLimit, config.maxLimit)

  switch (args.operation) {
    case 'connections': {
      const connections = await ctx.dbgraph.listConnections()
      return { operation: 'connections', connections: connections.map(connectionValue) }
    }
    case 'schema': {
      const connection = required(args, 'connection')
      const result = await ctx.dbgraph.schema({ connection }, signal)
      return {
        operation: 'schema',
        connection: result.connection,
        engine: result.engine,
        database: result.database,
        objects: result.objects.map(objectValue),
        truncated: result.truncated,
        comment_coverage: result.commentCoverage,
        index: indexStateValue(result.index),
      }
    }
    case 'objects': {
      const connection = required(args, 'connection')
      const query = args.query?.trim()
      const result = await ctx.dbgraph.objects({
        connection,
        ...query === undefined || query === '' ? {} : { query },
        limit,
      }, signal)
      return {
        operation: 'objects',
        connection,
        objects: result.objects.map(objectValue),
        truncated: result.truncated,
      }
    }
    case 'columns': {
      const connection = required(args, 'connection')
      const result = await ctx.dbgraph.columns({ connection, object: required(args, 'object') }, signal)
      return {
        operation: 'columns',
        connection,
        object: result.object,
        kind: result.kind,
        ...result.comment === undefined ? {} : { comment: result.comment },
        columns: result.columns.map(columnValue),
        truncated: result.truncated,
      }
    }
    case 'find': {
      const connection = required(args, 'connection')
      const where = predicateValues(args.where)
      const entity = args.entity?.trim()
      const object = args.object?.trim()
      const request: FindRequest = {
        connection,
        ...entity === undefined || entity === '' ? {} : { entity },
        ...args.fields === undefined || args.fields.length === 0 ? {} : { fields: args.fields },
        ...where === undefined ? {} : { where },
        ...object === undefined || object === '' ? {} : { object },
        limit,
      }
      const result = await ctx.dbgraph.find(request, signal)
      return {
        operation: 'find',
        connection,
        status: result.status,
        reason: result.reason,
        confidence: result.confidence,
        ...result.resolved === undefined ? {} : { resolved: candidateValue(result.resolved) },
        ...result.candidates === undefined ? {} : { candidates: result.candidates.map(candidateValue) },
        ...result.sql === undefined ? {} : { sql: result.sql },
        ...result.rows === undefined ? {} : { rows: jsonRows(result.rows) },
        ...result.rowCount === undefined ? {} : { row_count: result.rowCount },
        ...result.truncated === undefined ? {} : { truncated: result.truncated },
        ...result.redacted === undefined ? {} : { redacted: [...result.redacted] },
        elapsed_ms: result.elapsedMs,
      }
    }
    case 'sql': {
      const connection = required(args, 'connection')
      const request: SqlRequest = { connection, query: required(args, 'query'), limit }
      const result = await ctx.dbgraph.sql(request, signal)
      return {
        operation: 'sql',
        connection,
        columns: [...result.columns],
        rows: jsonRows(result.rows),
        row_count: result.rowCount,
        truncated: result.truncated,
        redacted: [...result.redacted],
        ...result.affectedRows === undefined ? {} : { affected_rows: result.affectedRows },
        elapsed_ms: result.elapsedMs,
        ...result.warnings === undefined ? {} : { warnings: [...result.warnings] },
      }
    }
    case 'impact':
    case 'refs': {
      const connection = required(args, 'connection')
      const request: ImpactRequest = { connection, object: required(args, 'object') }
      if (args.operation === 'refs') {
        const result = await ctx.dbgraph.refs(request, signal)
        return {
          operation: 'refs',
          connection,
          object: result.object,
          entries: result.entries.map(relationValue),
          truncated: result.truncated,
        }
      }
      const result = await ctx.dbgraph.impact(request, signal)
      return {
        operation: 'impact',
        connection,
        object: result.object,
        entries: result.entries.map(relationValue),
        truncated: result.truncated,
      }
    }
    /* v8 ignore next -- exhaustive over the parameter schema's closed operation enum; unreachable. */
    default:
      throw new DbgraphError(`unsupported operation "${String(args.operation)}"`, 'DBGRAPH_INVALID_REQUEST')
  }
}

/**
 * Build or refresh one index. A run large enough to outlive the call moves to the host's
 * background-job registry, where it keeps its own timeout-free lifetime and reports through that job
 * instead of this value. Everything that cannot start a job — no registry in the composition, no
 * owning agent, a database still small, a refusal from the registry — falls through to the
 * synchronous run, so the answer never depends on a host feature being present.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param args - the index tool's validated arguments.
 * @param exec - the tool-execution context.
 * @returns the index tool's canonical value: a started job, or every finished run's report.
 */
async function runIndex(
  ctx: Context,
  config: ResolvedConfig,
  args: DbgraphIndexToolArgs,
  exec: ToolRunContext,
): Promise<DbgraphIndexToolValue> {
  const connection = args.connection?.trim()
  const mode = args.mode ?? 'full'
  const request: IndexRequest = {
    mode,
    ...connection === undefined || connection === '' ? {} : { connection },
    ...args.writer === undefined ? {} : { writer: args.writer },
  }
  const target = request.connection
  const jobId = startBackgroundIndex(ctx, config, request, exec)
  if (jobId !== undefined) {
    return { status: 'started', job_id: jobId, ...target === undefined ? {} : { connection: target }, mode }
  }
  // A named connection answers with its own report; an unnamed run must name every connection it
  // indexed, or the model reads the unnamed ones as never indexed and asks again.
  const reports = target === undefined
    ? await ctx.dbgraph.indexMany(request, exec.signal)
    : [await ctx.dbgraph.index(request, exec.signal)]
  return completedIndexValue(reports)
}

/**
 * Hand one index run to the host's background-job registry, when the host offers one and the run
 * looks large enough to outlive the call.
 *
 * Every reason not to start a job falls back to the synchronous run rather than failing the call: a
 * composition without a job controller is a normal deployment, not an error, and the tool's contract
 * has always been "index it now".
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param request - the seam request to run.
 * @param exec - the tool-execution context; its agent owns the job.
 * @returns the started job's id, or `undefined` when this call must index synchronously.
 */
function startBackgroundIndex(
  ctx: Context,
  config: ResolvedConfig,
  request: IndexRequest,
  exec: ToolRunContext,
): string | undefined {
  const owner = exec.agent
  if (owner === undefined) return undefined
  // `ctx.get` rather than an `inject` entry: `jobs` is a host composition choice, and requiring it in
  // `inject` would hide this entire tool family from a profile that runs no background jobs.
  const jobs = ctx.get('jobs') as BackgroundJobRegistry | undefined
  if (jobs === undefined) return undefined
  if (!backgroundRunWanted(config, request, ctx.dbgraph.storeRoot)) return undefined
  try {
    return jobs.start({
      // The registry keys a job by its owning *session id*, not the agent object: it resolves the
      // live agent from that id and hangs the job's teardown (and therefore its cancellation) off it.
      owner: owner.id,
      kind: 'dbgraph-index',
      label: `dbgraph index ${request.connection ?? 'all connections'}`,
      run: handle => runIndexJob(ctx, request, handle),
    })
  } catch {
    // No controller serves this agent, or the owner already holds its maximum number of jobs: both
    // mean "do the work here instead", never "fail the model's call".
    return undefined
  }
}

/**
 * Whether this run is large enough — or configured — to belong in a background job.
 *
 * `'auto'` reads the previous run's object count from the digest sidecar, which is the only size
 * signal available before a run starts and exactly the case a job exists for. A connection with no
 * summary has never been indexed by this plugin, so there is no evidence it is large; it runs
 * synchronously and writes the summary the next call decides from.
 * @param config - the resolved plugin configuration.
 * @param request - the seam request about to run.
 * @returns whether the caller should try to start a job.
 */
function backgroundRunWanted(config: ResolvedConfig, request: IndexRequest, root: string | undefined): boolean {
  if (config.backgroundIndex === false) return false
  if (config.backgroundIndex === true) return true
  const status = root === undefined ? readStatusFile() : readStatusFile(root)
  if (status === undefined) return false
  const target = request.connection
  const entries = target === undefined
    ? Object.values(status.connections)
    : (() => {
        const entry = status.connections[target]
        return entry === undefined ? [] : [entry]
      })()
  return entries.some(entry => entry.objects >= config.backgroundIndexThreshold)
}

/**
 * The producer body of one background indexing job.
 *
 * Both outcomes are reported twice on purpose: the appended line is the live log while the job is
 * recent, and the returned outcome carries the terminal status plus the report a later `job_output`
 * delivers even after the log ring is trimmed. Neither may throw — a rejected `done` breaks the
 * registry's producer contract, which it can only log, leaving the job to look stuck.
 *
 * The run goes through `ctx.dbgraph.index`, the same in-process path a synchronous call uses, whose
 * store writes the digest sidecar itself after renaming the index into place; there is nothing extra
 * for `recordIndex` to fold in.
 * @param ctx - the plugin context.
 * @param request - the seam request to run.
 * @param handle - the job's producer face.
 * @returns the job's cancellation hook and settlement promise.
 */
function runIndexJob(ctx: Context, request: IndexRequest, handle: BackgroundJobHandle): BackgroundJobHooks {
  const controller = new AbortController()
  const target = request.connection ?? 'all connections'
  // Called while the registry is still building the job record, so it seeds the registered
  // projection instead of racing an update against a job that does not exist yet.
  handle.updateProgress(`indexing ${target}`)
  const done = (async (): Promise<BackgroundJobOutcome> => {
    try {
      // `indexMany` with one connection answers exactly one report, so the producer has a single
      // path and the job's final result always carries the complete set.
      const reports = await ctx.dbgraph.indexMany(request, controller.signal)
      for (const report of reports) handle.append(`${indexSummaryLine(report)}\n`)
      return { status: 'completed', result: renderDbgraphIndex(completedIndexValue(reports)) }
    } catch (error) {
      const message = failureMessage(error)
      handle.append(`dbgraph index failed for ${target}: ${message}\n`)
      return { status: 'failed', detail: message }
    }
  })()
  return { cancel: () => controller.abort(), done }
}

/**
 * One line of the counts a finished run wrote, for a job's live log.
 * @param report - the store's report.
 * @returns the summary line.
 */
function indexSummaryLine(report: IndexReport): string {
  return `Indexed ${report.connection}: ${report.objects} 对象 / ${report.columns} 列 / ${report.edges} 关系.`
}

/**
 * The text a failed job reports.
 * @param error - whatever the store threw.
 * @returns the error's own message when it has one, else its string form.
 */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The slice of the host's background-job registry this plugin calls, declared structurally.
 *
 * `@deepseek-ai/dsh-jobs` is deliberately not a dependency: the service may be absent, which is what
 * the optional lookup tolerates, and importing its types would tie this package's install to a host
 * package it is written to live without. The shape below is the seam's public contract — a job is
 * registered with one owner, one label, and a producer whose settlement promise the registry watches.
 */
interface BackgroundJobRegistry {
  /**
   * Register a job and return its id immediately.
   * @param spec - the job's owner, label, and producer body.
   * @returns the new job's id.
   */
  start(spec: BackgroundJobSpec): string
}

/** One job registration. */
interface BackgroundJobSpec {
  /** Session id of the agent that owns the job; its disposal cancels the work. */
  owner?: string
  /** Stable kind, used for retention and diagnostics (`dbgraph-index`). */
  kind: string
  /** Human-readable label shown in job listings and completion notices. */
  label: string
  /** The producer body, invoked once while the registration is still being built. */
  run(handle: BackgroundJobHandle): BackgroundJobHooks
}

/** What a producer may write while its job runs. */
interface BackgroundJobHandle {
  /**
   * Append one chunk of output to the job's log.
   * @param text - the text to append, verbatim.
   */
  append(text: string): void
  /**
   * Replace the job's live progress line.
   * @param line - the new progress line.
   */
  updateProgress(line: string): void
}

/** What a producer hands back so the registry can stop and await it. */
interface BackgroundJobHooks {
  /**
   * Stop the work.
   * @param reason - why the job was stopped, when the caller has a reason.
   */
  cancel(reason?: string): void
  /** Settles once the producer is done, carrying the job's terminal outcome. */
  done: Promise<BackgroundJobOutcome>
}

/** The terminal report a producer settles with. */
interface BackgroundJobOutcome {
  /** Terminal status the registry records. */
  status: 'completed' | 'failed' | 'killed'
  /** Failure detail, when the job failed. */
  detail?: string
  /** The result a `job_output` read delivers, when the job completed. */
  result?: string
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-dbgraph: ${field} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-dbgraph: ${field} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
