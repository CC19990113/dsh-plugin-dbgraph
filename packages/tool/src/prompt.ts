/**
 * The schema digest this plugin contributes to the system prompt on every request.
 *
 * A model that has to call `SHOW TABLES` and then `DESC` before every question spends tool
 * round-trips learning something the host already knows at assembly time. `ctx.systemPrompt.section`
 * takes a function for exactly this case, and it is called synchronously, so this module reads the
 * `status.json` sidecar an indexing run wrote rather than opening the index or reaching a server.
 *
 * Nothing here is authoritative: the file is a cache of one run's summary, the index is the truth. A
 * missing file therefore means "describing it would take a query" — never "there is no index".
 * @module dsh-plugin-dbgraph-tool/prompt
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CONNECTIONS_FILE_NAME,
  DEFAULT_INDEX_STALE_HOURS,
  INDEX_FILE_NAME,
  INDEX_ROOT_DIRNAME,
  STATUS_FILE_NAME,
} from 'dsh-plugin-dbgraph-service'
import type { StatusConnectionEntry, StatusDigestEntry, StatusFile } from 'dsh-plugin-dbgraph-service'

/** The stable system-prompt guidance positioning dbgraph against ad-hoc schema queries. */
export const DBGRAPH_PROMPT_TEXT =
  '用 dbgraph 回答数据库结构与取数问题：它读本地预建的索引，知道每个连接的库、表、列、注释、外键与样例值。'
  + '看上面的表清单就能直接点名表，不要先用 SHOW TABLES / DESC 摸底。最常用的是 dbgraph find —— 给它中文业务词、字段名和条件，'
  + '它离线把词定位到具体的表与列，再执行一次参数化查询，一次调用就出答案；只问结构用 dbgraph columns / objects / schema，'
  + '看依赖关系用 dbgraph impact / refs，必须自己写 SQL 时才用 dbgraph sql。索引缺失或过期时先调用 dbgraph_index（它有自己的长超时预算；'
  + '大库会转成后台 job，用 job_output 读报告）。查询结果里被判定为敏感的列会被遮蔽，这是预期行为。'

/** Objects the prompt never lists more than this many of, across all connections. */
export const DEFAULT_MAX_PROMPT_TABLES = 40

/** Characters the whole digest may occupy, so one huge database cannot crowd out the prompt. */
export const DEFAULT_MAX_PROMPT_CHARS = 6000

/** The sentence every digest ends with: how to ask for what is not on the list. */
const USAGE = '问字段用 dbgraph columns <表>；查值用 dbgraph find。'

/** The sentence appended when the newest index is past its freshness window. */
const STALE_USAGE = '索引已过期，运行 dbgraph_index 刷新。'

/**
 * The directory every dbgraph file lives under: `~/.dsh/dbgraph`, or `DSH_DBGRAPH_ROOT` when a
 * deployment (or a test) points somewhere else.
 * @param env - the environment to read; defaults to this process's.
 * @returns the absolute index root.
 */
export function dbgraphRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DSH_DBGRAPH_ROOT']
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), '.dsh', INDEX_ROOT_DIRNAME)
}

/**
 * Read an indexing run's persisted summary.
 *
 * A prompt line must never fail an assembly, so an absent, unreadable, or badly shaped file all
 * answer `undefined`; a single malformed connection entry is dropped rather than discarding the
 * whole digest, because the other connections are still worth naming.
 * @param root - the index root; defaults to {@link dbgraphRoot}.
 * @returns the validated summary, or `undefined` when there is none to trust.
 */
export function readStatusFile(root: string = dbgraphRoot()): StatusFile | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(root, STATUS_FILE_NAME), 'utf8'))
  } catch {
    // Absent, unreadable, or not JSON: all three mean "no summary to trust", which the caller
    // renders as the weaker sentence rather than as an error.
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const version = numberField(parsed, 'version')
  const updatedAt = numberField(parsed, 'updatedAt')
  const connections = parsed['connections']
  if (version === undefined || updatedAt === undefined || !isRecord(connections)) return undefined
  const entries: Record<string, StatusConnectionEntry> = {}
  for (const [id, raw] of Object.entries(connections)) {
    const entry = connectionEntry(raw)
    if (entry !== undefined) entries[id] = entry
  }
  return { version, updatedAt, connections: entries }
}

/**
 * The connection directories under the index root that actually hold an index file.
 *
 * Used only to tell "an index exists but its summary is missing" apart from "nothing has ever been
 * indexed" — collapsing those two would invite rebuilding an index that is already there. One
 * synchronous directory listing is cheap enough for assembly; a query is not.
 * @param root - the index root; defaults to {@link dbgraphRoot}.
 * @returns the connection directory names that contain an index, sorted.
 */
export function readIndexDirectories(root: string = dbgraphRoot()): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(root, entry.name, INDEX_FILE_NAME))) found.push(entry.name)
  }
  return found.sort()
}

/**
 * Render an elapsed span the way a model reads it: one unit, no arithmetic left to do.
 * @param elapsedMs - milliseconds since the event; a negative value reads as `刚刚`.
 * @returns a short Chinese age phrase.
 */
export function formatAge(elapsedMs: number): string {
  if (elapsedMs < 60_000) return '刚刚'
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** Bounds one digest render; every field is overridable so a deployment can retune the prompt. */
export interface DigestLimits {
  /** Objects listed at most across all connections (default {@link DEFAULT_MAX_PROMPT_TABLES}). */
  readonly maxPromptTables?: number
  /** Characters the digest may occupy (default {@link DEFAULT_MAX_PROMPT_CHARS}). */
  readonly maxPromptChars?: number
  /** Hours after which the newest index is marked stale (default 6, the seam's default). */
  readonly staleHours?: number
  /** "Now" for the age sentence; defaults to `Date.now()`, and exists so a test is deterministic. */
  readonly now?: number
}

/**
 * Render one connection's digest header: engine, label, age, size, comment coverage, staleness.
 * @param id - the connection id, which is also the argument the model passes to every tool.
 * @param entry - the connection's indexed summary.
 * @param staleHours - the freshness window.
 * @param now - the moment the sentence describes.
 * @returns the bracket-headed line.
 */
function connectionHeader(id: string, entry: StatusConnectionEntry, staleHours: number, now: number): string {
  const parts: string[] = [entry.engine]
  if (entry.label !== undefined && entry.label !== '') parts.push(entry.label)
  const newest = newestIndexedAt(entry)
  parts.push(`索引 ${newest === undefined ? '未记录' : formatAge(now - newest)}`)
  if (newest !== undefined && now - newest > staleHours * 3_600_000) parts.push('已过期')
  parts.push(`${entry.objects} 表 / ${entry.columns} 列`)
  if (entry.columns > 0) parts.push(`注释覆盖 ${Math.round(entry.commentCoverage * 100)}%`)
  return `[dbgraph] ${id} (${parts.join(', ')})`
}

/**
 * The newest indexed timestamp an entry carries, across the two index levels.
 * @param entry - the connection's summary.
 * @returns the epoch milliseconds, or `undefined` when the entry records neither level.
 */
function newestIndexedAt(entry: StatusConnectionEntry): number | undefined {
  const candidates: number[] = []
  if (entry.l2IndexedAt !== undefined) candidates.push(entry.l2IndexedAt)
  if (entry.l1IndexedAt !== undefined) candidates.push(entry.l1IndexedAt)
  return candidates.length === 0 ? undefined : Math.max(...candidates)
}

/** One object's table token, e.g. `sys_user 系统用户(18)`. */
function tableToken(entry: StatusDigestEntry): string {
  const comment = entry.comment === undefined || entry.comment === '' ? '' : ` ${entry.comment}`
  return `${entry.object}${comment}(${entry.columns})`
}

/**
 * Render the whole digest: one header per connection, one line of its largest tables, and the
 * sentence that says how to ask for what is not listed.
 *
 * The budget is applied in the order it protects the prompt: first at most
 * {@link DigestLimits.maxPromptTables} objects across every connection, largest first, so the
 * tables a question is most likely about survive; then characters, dropping the smallest remaining
 * tables until the block fits. Every dropped table is counted into the `还有 N 张未列出` note, and
 * `digestOmitted` from the sidecar is added to it, so the count is always the complete truth.
 * @param status - the summary an indexing run wrote.
 * @param limits - the budget and the moment to describe.
 * @returns the digest text, ending with the usage sentence.
 */
export function renderStatusDigest(status: StatusFile, limits: DigestLimits = {}): string {
  const maxTables = Math.max(1, Math.trunc(limits.maxPromptTables ?? DEFAULT_MAX_PROMPT_TABLES))
  const maxChars = Math.max(1, Math.trunc(limits.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS))
  const staleHours = limits.staleHours ?? DEFAULT_INDEX_STALE_HOURS
  const now = limits.now ?? Date.now()

  const ids = Object.keys(status.connections)
  if (ids.length === 0) return `[dbgraph] 还没有配置连接\n${USAGE}`

  const headers = ids.map(id => connectionHeader(id, status.connections[id] as StatusConnectionEntry, staleHours, now))
  const anyStale = ids.some((id) => {
    const newest = newestIndexedAt(status.connections[id] as StatusConnectionEntry)
    return newest !== undefined && now - newest > staleHours * 3_600_000
  })
  const usage = anyStale ? `${USAGE}${STALE_USAGE}` : USAGE

  // Every object across every connection, largest first. A global sort is what makes the table cap
  // keep the tables a question is most likely about, whichever connection they belong to.
  const pooled = ids.flatMap(id => (status.connections[id] as StatusConnectionEntry).digest.map(entry => ({ id, entry })))
  const sorted = [...pooled].sort((left, right) =>
    right.entry.columns - left.entry.columns
    || left.id.localeCompare(right.id)
    || left.entry.object.localeCompare(right.entry.object))

  let kept = sorted.slice(0, maxTables)
  let text = assembleDigest(ids, headers, kept, status, usage)
  // Character budget second: drop the smallest remaining tables until the block fits. The count of
  // dropped tables lands in the same note, so a shortened list never reads as a complete one.
  while (kept.length > 0 && text.length > maxChars) {
    kept = kept.slice(0, -1)
    text = assembleDigest(ids, headers, kept, status, usage)
  }
  return text
}

/**
 * Assemble headers, per-connection table lines, and the usage sentence for one kept set.
 * @param ids - connection ids in configuration order.
 * @param headers - one rendered header per id, in the same order.
 * @param kept - the surviving objects, largest first.
 * @param status - the summary the omitted counts come from.
 * @param usage - the closing sentence.
 * @returns the digest text.
 */
function assembleDigest(
  ids: readonly string[],
  headers: readonly string[],
  kept: readonly { readonly id: string; readonly entry: StatusDigestEntry }[],
  status: StatusFile,
  usage: string,
): string {
  const lines: string[] = []
  const multi = ids.length > 1
  for (const [index, id] of ids.entries()) {
    // Header then its own tables: with several connections, interleaving is what keeps a reader
    // from attributing one database's table list to another.
    lines.push(headers[index] as string)
    const entry = status.connections[id] as StatusConnectionEntry
    const shown = kept.filter(candidate => candidate.id === id)
    const omitted = entry.digestOmitted + (entry.digest.length - shown.length)
    const prefix = multi ? `${id}: ` : ''
    const tokens = shown.map(candidate => tableToken(candidate.entry))
    if (tokens.length === 0) {
      lines.push(omitted > 0 ? `${prefix}（还有 ${omitted} 张未列出）` : `${prefix}（没有可列出的对象）`)
      continue
    }
    const note = omitted > 0 ? `（还有 ${omitted} 张未列出）` : ''
    lines.push(`${prefix}${tokens.join(' | ')}${note}`)
  }
  lines.push(usage)
  return lines.join('\n')
}

/** What the caller of {@link dbgraphPromptHint} may override: where to look, and the budget. */
export interface PromptHintOptions extends DigestLimits {
  /** Index root override; defaults to {@link dbgraphRoot}. */
  readonly root?: string
}

/**
 * The state of the configured connections, phrased for a system prompt.
 *
 * Three outcomes, deliberately distinguished: a summary to render, an index that exists without a
 * summary (built by an older run, or before the sidecar was introduced), and no index at all.
 * Collapsing the middle case into "no index" would invite rebuilding an index that is already there.
 * @param options - the index root and the digest budget.
 * @returns the digest, or one sentence naming the state and how to change it.
 */
export function dbgraphPromptHint(options: PromptHintOptions = {}): string {
  const root = options.root ?? dbgraphRoot()
  const status = readStatusFile(root)
  if (status !== undefined) {
    if (Object.keys(status.connections).length > 0) return renderStatusDigest(status, options)
    return `[dbgraph] 索引根目录存在，但还没有配置任何连接：在 ${join(root, CONNECTIONS_FILE_NAME)} 里添加连接，再运行 dbgraph_index。`
  }
  const directories = readIndexDirectories(root)
  if (directories.length > 0) {
    return `已建立 dbgraph 索引（${directories.length} 个连接目录：${directories.join(', ')}），但缺少 ${STATUS_FILE_NAME} 摘要`
      + ' —— 运行 dbgraph_index 刷新一次即可恢复表清单；结构查询本身已经可用。'
  }
  return '还没有建立数据库索引：先运行 dbgraph_index（或 /dbgraph index）建立索引，之后这里会自动列出表清单。'
}

/**
 * One numeric field of a parsed object, or `undefined` when it is absent or not a finite number.
 * @param record - the parsed object.
 * @param field - the field name to read.
 * @returns the number, or `undefined`.
 */
function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Narrow a parsed JSON value to a plain object.
 * @param value - the parsed value.
 * @returns whether it is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one connection entry of `status.json`.
 * @param raw - the parsed entry.
 * @returns the typed entry, or `undefined` when a required field is missing or mistyped.
 */
function connectionEntry(raw: unknown): StatusConnectionEntry | undefined {
  if (!isRecord(raw)) return undefined
  const engine = raw['engine']
  const objects = numberField(raw, 'objects')
  const columns = numberField(raw, 'columns')
  const commentCoverage = numberField(raw, 'commentCoverage')
  const digestOmitted = numberField(raw, 'digestOmitted')
  const digestRaw = raw['digest']
  if (typeof engine !== 'string' || objects === undefined || columns === undefined
    || commentCoverage === undefined || digestOmitted === undefined || !Array.isArray(digestRaw)) return undefined
  const digest: StatusDigestEntry[] = []
  for (const item of digestRaw) {
    const entry = digestEntry(item)
    if (entry !== undefined) digest.push(entry)
  }
  const label = stringField(raw, 'label')
  const l1IndexedAt = numberField(raw, 'l1IndexedAt')
  const l2IndexedAt = numberField(raw, 'l2IndexedAt')
  return {
    engine,
    ...label === undefined ? {} : { label },
    ...l1IndexedAt === undefined ? {} : { l1IndexedAt },
    ...l2IndexedAt === undefined ? {} : { l2IndexedAt },
    objects,
    columns,
    commentCoverage,
    digest,
    digestOmitted,
  }
}

/**
 * Validate one object of a connection's digest list.
 * @param raw - the parsed entry.
 * @returns the typed entry, or `undefined` when it cannot be named.
 */
function digestEntry(raw: unknown): StatusDigestEntry | undefined {
  if (!isRecord(raw)) return undefined
  const object = raw['object']
  const columns = numberField(raw, 'columns')
  if (typeof object !== 'string' || object === '' || columns === undefined) return undefined
  const comment = stringField(raw, 'comment')
  return { object, ...comment === undefined ? {} : { comment }, columns }
}

/**
 * One optional string field of a parsed object.
 * @param record - the parsed object.
 * @param field - the field name to read.
 * @returns the string, or `undefined` when it is absent or empty.
 */
function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}
