/**
 * Engine-neutral plumbing every dialect in this package shares.
 *
 * Four decisions live here so each dialect follows them rather than restating them:
 *
 * - **A read-only execution refuses anything that is not obviously a read.** The first keyword is
 *   parsed after stripping leading whitespace and SQL comments; `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`
 *   are admitted, everything else throws {@link DBGRAPH_READ_ONLY_CODE} when the caller asked for a
 *   read-only run. Keyword filtering is a policy gate, not a sandbox — a dialect that can open its
 *   store read-only (SQLite) does so as well, because a keyword list cannot see inside a function
 *   call.
 * - **Rows leave a dialect already JSON-safe.** `Date` becomes ISO text, binary becomes the hex
 *   marker {@link renderBinary} builds, `bigint` becomes text, and a nested object is normalized
 *   recursively. A transcript that persists a tool result must never choke on a value the driver
 *   handed back.
 * - **Sensitive columns are masked inside `execute`**, not by the caller: the dialect is the only
 *   layer that sees both the result column names and the connection's masking configuration, and a
 *   masking rule that depends on a caller remembering to apply it is not a safety rule.
 * - **A dialect owns a warm handle per connection id** (see `pool.ts`); the plugin's disposal closes
 *   them, so nothing here keeps a socket or a file descriptor past unload.
 * @module dsh-plugin-dbgraph-catalog/support
 */

import { DbgraphError, isSensitiveColumn } from 'dsh-plugin-dbgraph-service'
import type { ConnectionConfig, DatabaseDialect, ExecuteLimits, Row } from 'dsh-plugin-dbgraph-service'

/**
 * Code on the error thrown when a non-read statement is refused because the execution asked for
 * read-only. The seam documents no code for this case; `DBGRAPH_UNAVAILABLE` would misreport a
 * reachable database as unreachable, so the refusal gets its own name instead.
 */
export const DBGRAPH_READ_ONLY_CODE = 'DBGRAPH_READ_ONLY'

/**
 * Code on the error thrown when a statement the dialect did send was rejected by the engine (bad
 * syntax, missing privilege, a timeout). Distinct from {@link DBGRAPH_READ_ONLY_CODE}, which is this
 * package refusing to send at all.
 */
export const DBGRAPH_QUERY_FAILED_CODE = 'DBGRAPH_QUERY_FAILED'

/** What a masked value becomes. */
export const REDACTED_VALUE = '[REDACTED]'

/** Bytes of a binary value rendered as hex before the marker abbreviates the rest. */
export const MAX_BINARY_PREVIEW_BYTES = 32

/** A dialect plus the lifecycle the plugin needs to release its warm handles. */
export interface ManagedDialect extends DatabaseDialect {
  /** Close every cached connection or pool. Safe to call twice; called on plugin disposal. */
  close(): Promise<void>
}

/**
 * One thrown value's message, for embedding in a warning or a wrapper error.
 * @param error - the thrown value, of any shape.
 * @returns a non-empty, single-line-ish description.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    const serialized = JSON.stringify(error)
    if (serialized !== undefined) return serialized
  } catch {
    // A value JSON cannot represent still has to produce a message; fall through to String.
  }
  return String(error)
}

/** Statement keywords treated as an obvious read for the read-only gate. */
const READ_STATEMENT_KEYWORDS: ReadonlySet<string> = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'])

/**
 * The first SQL keyword of a statement, with leading whitespace and `--` / block comments skipped.
 * Deliberately lexical: it is the same cheap check every dialect applies, and it never rewrites the
 * statement it inspects.
 * @param query - the statement text.
 * @returns the upper-cased first keyword, or `undefined` for an empty/comment-only statement.
 */
export function firstStatementKeyword(query: string): string | undefined {
  let index = 0
  while (index < query.length) {
    if (query.startsWith('--', index)) {
      const end = query.indexOf('\n', index + 2)
      if (end === -1) return undefined
      index = end + 1
      continue
    }
    if (query.startsWith('/*', index)) {
      const end = query.indexOf('*/', index + 2)
      if (end === -1) return undefined
      index = end + 2
      continue
    }
    const char = query.charAt(index)
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    const match = /^[A-Za-z]+/.exec(query.slice(index))
    return match?.[0]?.toUpperCase()
  }
  return undefined
}

/**
 * Whether a statement begins with one of the keywords the read-only gate admits.
 * @param query - the statement text.
 * @returns true when the first keyword is a read keyword.
 */
export function isReadStatement(query: string): boolean {
  const keyword = firstStatementKeyword(query)
  return keyword !== undefined && READ_STATEMENT_KEYWORDS.has(keyword)
}

/**
 * Enforce the read-only execution contract: when the caller asked for a read-only run, a statement
 * that is not obviously a read is refused before it reaches the engine.
 * @param query - the statement text.
 * @param limits - the caller's execution limits.
 * @throws DbgraphError with {@link DBGRAPH_READ_ONLY_CODE} when the statement is refused.
 */
export function assertReadOnlyStatement(query: string, limits: ExecuteLimits): void {
  if (!limits.readOnly) return
  if (isReadStatement(query)) return
  const keyword = firstStatementKeyword(query)
  const described = keyword === undefined
    ? 'an empty or comment-only statement'
    : `a "${keyword}" statement`
  throw new DbgraphError(
    `read-only execution refused ${described}; only SELECT, SHOW, DESCRIBE and EXPLAIN are admitted`,
    DBGRAPH_READ_ONLY_CODE,
  )
}

/**
 * Clamp a requested row cap into a usable integer.
 * @param requested - the caller's value; NaN, negative and infinite values are corrected, not trusted.
 * @returns a whole number of rows, never negative.
 */
export function clampRowLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested < 0) return 0
  return Math.floor(requested)
}

/**
 * Throw when a call was aborted. Every dialect checks this before opening a connection, between
 * objects while walking a catalog, and before it starts a statement.
 * @param signal - the caller's abort signal, when one was supplied.
 * @throws DbgraphError with `DBGRAPH_ABORTED` when the signal is already aborted.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DbgraphError('the call was aborted', 'DBGRAPH_ABORTED')
  }
}

/**
 * Render a binary value as a bounded hex marker. The length is always reported, so a truncated
 * preview never masquerades as the whole value.
 *
 * Example: `0x00010203… (40 bytes)`.
 * @param bytes - the binary value the driver returned.
 * @returns a JSON-safe string.
 */
export function renderBinary(bytes: Uint8Array): string {
  const head = bytes.subarray(0, MAX_BINARY_PREVIEW_BYTES)
  const hex = Array.from(head, byte => byte.toString(16).padStart(2, '0')).join('')
  const abbreviated = bytes.byteLength > head.byteLength ? '…' : ''
  return `0x${hex}${abbreviated} (${bytes.byteLength} bytes)`
}

/**
 * Convert one driver value into something `JSON.stringify` represents without loss or surprise.
 * `undefined` becomes `null` because a missing key and an explicit JSON `null` must not be two ways
 * to say the same thing in a tool result; non-finite numbers become their text form (`NaN`,
 * `Infinity`) instead of silently serializing as `null`.
 * @param value - any value a row can hold.
 * @returns a JSON-safe value.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      return String(value)
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  }
  if (value instanceof Uint8Array) return renderBinary(value)
  if (Array.isArray(value)) return value.map(item => toJsonSafe(item))
  const record: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    record[key] = toJsonSafe(item)
  }
  return record
}

/**
 * Whether a column name matches the sensitive-column rule for a connection.
 *
 * Shared by result masking and by enum sampling: a literal sampled from a `password` or `token`
 * column would be written into the on-disk index and could surface in a `columns` listing, which is
 * exactly what the masking rule exists to prevent. Sampling skips these columns regardless of the
 * connection's `sensitiveColumns` mode, because the mode governs query results, not the persistent
 * index.
 * @param connection - the connection whose masking configuration applies.
 * @param column - the column name.
 * @returns true when the column should never carry sampled values.
 */
export function isSensitiveName(connection: ConnectionConfig, column: string): boolean {
  return isSensitiveColumn(column, connection.sensitivePatterns ?? [])
}

/**
 * Normalize one statement's rows: mask sensitive columns, then make every remaining value JSON-safe.
 *
 * Masking happens before conversion on purpose — a masked column's value must never be inspected,
 * let alone copied, even into a preview.
 * @param columns - result column names, in result order.
 * @param rows - raw driver rows keyed by column name.
 * @param connection - the connection whose masking configuration applies.
 * @returns the normalized rows and the names of columns that were masked, in result order.
 */
export function normalizeRows(
  columns: readonly string[],
  rows: readonly Readonly<Record<string, unknown>>[],
  connection: ConnectionConfig,
): { readonly rows: readonly Row[]; readonly redacted: readonly string[] } {
  const redacting = connection.sensitiveColumns !== 'show'
  const masked = redacting
    ? [...new Set(columns.filter(name => isSensitiveName(connection, name)))]
    : []
  const maskedNames = new Set(masked)
  const normalized: Row[] = rows.map(row => {
    const value: Record<string, unknown> = {}
    for (const name of columns) {
      value[name] = maskedNames.has(name) ? REDACTED_VALUE : toJsonSafe(row[name])
    }
    return value
  })
  return { rows: normalized, redacted: masked }
}

/**
 * Read a string field from an untyped driver row (information_schema columns come back as `any`).
 * @param value - the field value.
 * @returns the string, or `undefined` when the value is not a string.
 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a numeric field from an untyped driver row. MySQL hands `BIGINT` columns back as a number or
 * a decimal string depending on configuration, so both are accepted; anything not finite is
 * `undefined` rather than `NaN`.
 * @param value - the field value.
 * @returns a finite number, or `undefined`.
 */
export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'bigint') {
    const converted = Number(value)
    return Number.isFinite(converted) ? converted : undefined
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const converted = Number(value)
    return Number.isFinite(converted) ? converted : undefined
  }
  return undefined
}
