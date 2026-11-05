/**
 * The human `/dbgraph` slash command.
 *
 * The model-facing tools answer the same questions, but a person at the composer should not have to
 * spend a model turn asking "what is indexed?". This command runs directly against `ctx.dbgraph` in
 * the UI's command plane: nothing it returns becomes a model message or a token.
 *
 * Registered through conditional injection (`ctx.inject(['commands'], …)`) for the same reason the
 * model-facing tools are not: the command registry is a host composition choice, and its absence
 * must not hide the tools this plugin also registers. `@deepseek-ai/dsh-commands` is deliberately
 * not imported — the service may be absent, so its public shape is mirrored structurally here.
 * @module dsh-plugin-dbgraph-tool/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionSummary } from 'dsh-plugin-dbgraph-service'
import { DBGRAPH_INDEX_MODES, DBGRAPH_INDEX_WRITERS } from './schema.ts'
import { dbgraphRoot } from './prompt.ts'
import { describeIndexState } from './render.ts'

/** Command name, without the leading slash. */
export const COMMAND_NAME = 'dbgraph'

/** One-line discovery copy the UI shows in its command list. */
export const COMMAND_DESCRIPTION = '查看或重建本地数据库结构索引（status / index / connections）'

/** Input syntax the UI shows after the command name. */
export const COMMAND_INPUT_HINT = '[status|index [--connection <id>] [--mode l1|l2|full]|connections]'

/** The usage line every rejection repeats, so one screen never offers half an answer. */
export const COMMAND_USAGE = `用法：/${COMMAND_NAME} ${COMMAND_INPUT_HINT}`

/**
 * Branded identity of this definition, mirroring `CommandDefinitionId` from
 * `@deepseek-ai/dsh-commands/brand` without importing it.
 *
 * The registry treats the value as an opaque string; the local brand only keeps a plain string from
 * being passed where a stable definition identity is meant.
 */
export type CommandDefinitionId = string & { readonly __commandDefinitionId: 'CommandDefinitionId' }

/** Brand one plugin-namespaced command identity. */
function commandDefinitionId(value: string): CommandDefinitionId {
  return value as CommandDefinitionId
}

/** Stable identity, independent of the display name or the UI's per-run id. */
export const COMMAND_DEFINITION_ID = commandDefinitionId('dsh-plugin-dbgraph/command/dbgraph')

/** What a handler settles with; mirrors the registry's `success | error` result. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * The invocation face a command handler receives, declared structurally — only the members this
 * command reads.
 */
export interface CommandInvocation {
  /** Everything after the command name, including its leading separator whitespace. */
  readonly rawInput: string
  /** UI request cancellation, forwarded to every seam call. */
  readonly signal?: AbortSignal
}

/** One command registration, as the registry's `register` takes it. */
export interface CommandDefinition {
  /** Stable plugin-namespaced identity. */
  readonly definitionId: CommandDefinitionId
  /** Lowercase command name, without the slash. */
  readonly name: string
  /** Discovery copy, shown in the UI's command list. */
  readonly description: string
  /** Input syntax shown after the name. */
  readonly input: { readonly hint: string }
  /**
   * Run the command.
   * @param invocation - the accepted command line and its context.
   * @returns the settled result the UI renders.
   */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** The command registry's registration surface, declared structurally. */
export interface CommandRegistry {
  /**
   * Register one command definition.
   * @param definition - discovery metadata and handler.
   * @returns the disposer unregistering it.
   */
  register(definition: CommandDefinition): () => void
}

/**
 * Register the `/dbgraph` command when the host composition provides a command registry.
 * @param ctx - the plugin context (must carry `dbgraph`; `commands` is optional).
 */
export function registerCommands(ctx: Context): void {
  try {
    ctx.inject(['commands'], child => {
      const commands = (child as Context & { commands: CommandRegistry }).commands
      child.effect(
        () => commands.register({
          definitionId: COMMAND_DEFINITION_ID,
          name: COMMAND_NAME,
          description: COMMAND_DESCRIPTION,
          input: { hint: COMMAND_INPUT_HINT },
          handler: invocation => runCommand(ctx, invocation),
        }),
        'dbgraph: slash command',
      )
    })
  } catch (error) {
    console.warn('[dbgraph] commands service unavailable; /dbgraph is not registered:', error)
  }
}

/**
 * Parse and dispatch one invocation.
 *
 * A handler that throws makes the registry settle the command as an error from the thrown value
 * instead of from a result, so every expected failure is returned as `kind: 'error'` here; only a
 * defect escapes, and it still surfaces as the command's error.
 * @param ctx - the plugin context carrying `dbgraph`.
 * @param invocation - the accepted command line and its context.
 * @returns the settled result.
 */
async function runCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const words = invocation.rawInput.trim() === '' ? [] : invocation.rawInput.trim().split(/\s+/u)
  const [subcommand = 'status', ...rest] = words
  try {
    switch (subcommand) {
      case 'status':
        return await statusCommand(ctx)
      case 'connections':
        return await connectionsCommand(ctx)
      case 'index':
        return await indexCommand(ctx, rest, invocation.signal)
      default:
        return { kind: 'error', text: `未知的子命令 "${subcommand}"。${COMMAND_USAGE}` }
    }
  } catch (error) {
    return { kind: 'error', text: String(error) }
  }
}

/** The connection target clause: host and database, when the connection names them. */
function targetOf(connection: ConnectionSummary): string {
  const parts: string[] = []
  if (connection.host !== undefined) parts.push(connection.host)
  if (connection.database !== undefined) parts.push(connection.database)
  return parts.length === 0 ? '' : ` ${parts.join('/')}`
}

/** One connection as a line: id, label, engine, target, index state, credential state. */
function connectionLine(connection: ConnectionSummary): string {
  const label = connection.label === undefined ? '' : ` "${connection.label}"`
  const credential = connection.credentialConfigured ? '' : '（凭据未配置）'
  return `${connection.id}${label} (${connection.engine})${targetOf(connection)} — `
    + `${describeIndexState(connection.index)}${credential}`
}

/** Report every configured connection's index at a glance. */
async function statusCommand(ctx: Context): Promise<CommandResult> {
  const root = ctx.dbgraph.storeRoot ?? dbgraphRoot()
  const connections = await ctx.dbgraph.listConnections()
  if (connections.length === 0) {
    return {
      kind: 'success',
      text: `还没有配置连接。索引根：${root}\n在 ${root}/connections.json 里添加连接后运行 /${COMMAND_NAME} index。`,
    }
  }
  const lines = [`索引根：${root}`, ...connections.map(connectionLine)]
  return { kind: 'success', text: lines.join('\n') }
}

/** List the connections without their index state — what the model passes as `--connection`. */
async function connectionsCommand(ctx: Context): Promise<CommandResult> {
  const connections = await ctx.dbgraph.listConnections()
  if (connections.length === 0) return { kind: 'success', text: '还没有配置连接。' }
  const lines = connections.map(connection => `${connection.id} (${connection.engine})${targetOf(connection)}`)
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Build or refresh an index right now.
 *
 * Unlike the model-facing tool this never moves to a background job: a human ran a command and is
 * waiting for its answer, and the command plane has no `job_output` equivalent to read later.
 * @param ctx - the plugin context carrying `dbgraph`.
 * @param words - the subcommand's arguments.
 * @param signal - stops the run.
 * @returns the completed run's summary, or why the arguments are unusable.
 */
async function indexCommand(ctx: Context, words: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  const parsed = parseIndexFlags(words)
  if ('error' in parsed) return { kind: 'error', text: `${parsed.error}。${COMMAND_USAGE}` }
  const report = await ctx.dbgraph.index(parsed.request, signal)
  const lines = [
    `已索引 ${report.connection}（${report.level}）：${report.objects} 对象 / ${report.columns} 列 / `
    + `${report.edges} 关系，${report.terms} 检索词，writer ${report.writer}，${report.elapsedMs} ms。`,
  ]
  if (report.warnings.length > 0) lines.push(...report.warnings.map(warning => `警告：${warning}`))
  return { kind: 'success', text: lines.join('\n') }
}

/** What `index`'s flags resolved to. */
type ParsedIndexFlags =
  | { readonly request: { readonly connection?: string; readonly mode: 'l1' | 'l2' | 'full'; readonly writer?: 'auto' | 'js' | 'rust' } }
  | { readonly error: string }

/**
 * Parse `index`'s flags.
 * @param words - the argument words after `index`.
 * @returns the request, or one message naming the unusable argument.
 */
function parseIndexFlags(words: readonly string[]): ParsedIndexFlags {
  let connection: string | undefined
  let mode: 'l1' | 'l2' | 'full' = 'full'
  let writer: 'auto' | 'js' | 'rust' | undefined
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string
    const next = words[index + 1]
    switch (word) {
      case '--connection':
        if (next === undefined || next.trim() === '') return { error: '--connection 需要一个连接 id' }
        connection = next
        index += 1
        break
      case '--mode':
        if (next === undefined || !(DBGRAPH_INDEX_MODES as readonly string[]).includes(next)) {
          return { error: `--mode 只能是 ${DBGRAPH_INDEX_MODES.join(' / ')}` }
        }
        mode = next as 'l1' | 'l2' | 'full'
        index += 1
        break
      case '--writer':
        if (next === undefined || !(DBGRAPH_INDEX_WRITERS as readonly string[]).includes(next)) {
          return { error: `--writer 只能是 ${DBGRAPH_INDEX_WRITERS.join(' / ')}` }
        }
        writer = next as 'auto' | 'js' | 'rust'
        index += 1
        break
      default:
        return { error: `未知参数 "${word}"` }
    }
  }
  return {
    request: {
      ...connection === undefined ? {} : { connection },
      mode,
      ...writer === undefined ? {} : { writer },
    },
  }
}
