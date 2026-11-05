/**
 * Model-facing text for each tool's canonical value.
 *
 * Two rules, both learned from what a model does with an answer: a capped list always says it is
 * capped (a list that reads as complete is worse than a short one, because the model stops asking),
 * and a row set is rendered as rows — never as JSON, which buries the same bytes in punctuation.
 * @module dsh-plugin-dbgraph-tool/render
 */

import { assertNever } from 'dsh-plugin-dbgraph-service'
import { formatAge } from './prompt.ts'
import type { DbgraphIndexToolValue, DbgraphToolValue } from './schema.ts'

/** Characters a single table cell may occupy before it is clipped. */
const MAX_CELL_CHARS = 80

/** The `N shown of M` suffix a truncatable list carries. */
function counted(shown: number, total: number, truncated: boolean): string {
  return truncated ? ` (${shown} of ${total} shown)` : ` (${total})`
}

/** A JSON-safe value as one table cell: quoted strings, `NULL`, clipped to {@link MAX_CELL_CHARS}. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  // The canonical value was validated as lossless JSON before this ran, so `stringify` cannot
  // return `undefined` here and no fallback branch is needed.
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = text.replaceAll('\r', ' ').replaceAll('\n', ' ')
  const clipped = flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 1)}…` : flat
  return typeof value === 'string' ? `"${clipped}"` : clipped.replaceAll('|', '\\|')
}

/**
 * A row set as an aligned pipe table, headed by the columns the caller actually received.
 * @param headers - column names in result order.
 * @param rows - the rows, values already JSON-safe.
 * @param truncated - whether a row cap clipped the answer.
 * @returns the rendered block, or a plain `(no rows)` note.
 */
function renderRows(headers: readonly string[], rows: readonly unknown[], truncated: boolean): string {
  if (rows.length === 0) return '(no rows returned)'
  const title = `${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? ' (truncated by the row cap)' : ''}:`
  const lines = [title, `  ${headers.join(' | ')}`]
  for (const row of rows) {
    const record = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
    lines.push(`  ${headers.map(header => cell(record[header])).join(' | ')}`)
  }
  return lines.join('\n')
}

/**
 * One connection's index state, phrased for a model deciding whether to reindex.
 * @param index - the seam's index state.
 * @returns a short clause, never empty.
 */
export function describeIndexState(index: {
  readonly l1_indexed_at?: number
  readonly l2_indexed_at?: number
  readonly objects: number
  readonly columns: number
  readonly stale: boolean
}): string {
  const newest = index.l2_indexed_at ?? index.l1_indexed_at
  if (newest === undefined && index.objects === 0) return 'not indexed'
  const size = `${index.objects} 表 / ${index.columns} 列`
  if (newest === undefined) return index.stale ? `${size}, 索引时间未记录` : size
  const age = formatAge(Date.now() - newest)
  return index.stale ? `${size}, 索引 ${age}, 已过期` : `${size}, 索引 ${age}`
}

/** Where a connection points, as one clause. */
function connectionTarget(connection: {
  readonly host?: string
  readonly database?: string
}): string {
  const parts: string[] = []
  if (connection.host !== undefined) parts.push(connection.host)
  if (connection.database !== undefined) parts.push(connection.database)
  return parts.length === 0 ? 'no target recorded' : parts.join(' / ')
}

/** One object line: name, comment, kind, size, row estimate. */
function objectLine(object: {
  readonly object: string
  readonly kind: string
  readonly comment?: string
  readonly column_count: number
  readonly row_estimate?: number
}): string {
  const comment = object.comment === undefined ? '' : `  ${object.comment}`
  const rows = object.row_estimate === undefined ? '' : `  行数≈${object.row_estimate}`
  return `${object.object}${comment}  [${object.kind}]  ${object.column_count} 列${rows}`
}

/** One edge line, direction-neutral: both `impact` and `refs` return the other end. */
function relationLine(entry: {
  readonly kind: string
  readonly object: string
  readonly column?: string
  readonly ref_column?: string
  readonly name?: string
}): string {
  const column = entry.column === undefined ? '' : `.${entry.column}`
  const ref = entry.ref_column === undefined ? '' : ` → ${entry.ref_column}`
  const name = entry.name === undefined ? '' : `  [${entry.name}]`
  return `[${entry.kind}] ${entry.object}${column}${ref}${name}`
}

/**
 * Render one query-side result as the text the model reads.
 * @param value - the canonical value the operation returned.
 * @returns the rendered text.
 */
export function renderDbgraph(value: DbgraphToolValue): string {
  switch (value.operation) {
    case 'connections': {
      if (value.connections.length === 0) {
        return 'No database connection is configured. Add one to connections.json under the dbgraph index root, then run dbgraph_index.'
      }
      const lines = [`Connections${counted(value.connections.length, value.connections.length, false)}:`]
      for (const connection of value.connections) {
        const label = connection.label === undefined ? '' : ` "${connection.label}"`
        // SQLite is a file, not a server: there is no account to authenticate with, so reporting a
        // missing credential for it describes a requirement that does not exist.
        const credential = connection.engine === 'sqlite'
          ? ''
          : `, ${connection.credential_configured ? 'credential configured' : 'credential missing'}`
        lines.push(
          `  ${connection.id}${label} (${connection.engine}) ${connectionTarget(connection)}`
          + ` — ${describeIndexState(connection.index)}${credential}`,
        )
      }
      return lines.join('\n')
    }
    case 'schema': {
      const engine = `${value.engine} / ${value.database}`
      if (value.objects.length === 0) return `No object is indexed for ${value.connection} (${engine}). Run dbgraph_index to build the index.`
      const header = `Schema for ${value.connection} (${engine}): ${value.index.objects} 表 / ${value.index.columns} 列, `
        + `注释覆盖 ${Math.round(value.comment_coverage * 100)}%, ${describeIndexState(value.index)}`
      const lines = [header]
      lines.push(...value.objects.map(object => `  ${objectLine(object)}`))
      if (value.truncated) lines.push('  (list truncated by the object cap)')
      return lines.join('\n')
    }
    case 'objects': {
      if (value.objects.length === 0) return `No object in ${value.connection} matches.`
      const lines = [`Objects in ${value.connection}${counted(value.objects.length, value.objects.length, value.truncated)}:`]
      lines.push(...value.objects.map(object => `  ${objectLine(object)}`))
      return lines.join('\n')
    }
    case 'columns': {
      const comment = value.comment === undefined ? '' : `  ${value.comment}`
      const header = `${value.object}${comment}  [${value.kind}]  ${value.columns.length} 列:`
      if (value.columns.length === 0) return `${header} (no column is indexed)`
      const lines = [header]
      for (const column of value.columns) {
        const flags: string[] = []
        if (column.is_primary_key) flags.push('PK')
        if (!column.nullable) flags.push('NOT NULL')
        if (column.is_unique) flags.push('UNIQUE')
        const definition = column.default_value === undefined ? '' : ` = ${column.default_value}`
        const comment = column.comment === undefined ? '' : `  -- ${column.comment}`
        const sample = column.enum_values === undefined || column.enum_values.length === 0
          ? ''
          : `  例: ${column.enum_values.join('|')}`
        lines.push(`  ${column.name}  ${column.type}${definition}${flags.length === 0 ? '' : ` ${flags.join(' ')}`}${comment}${sample}`)
      }
      if (value.truncated) lines.push('  (list truncated by the column cap)')
      return lines.join('\n')
    }
    case 'find': {
      const lines: string[] = []
      if (value.status === 'resolved') {
        const target = value.resolved
        const name = target === undefined
          ? value.connection
          : `${target.object}${target.comment === undefined ? '' : ` ${target.comment}`}`
        lines.push(`find → ${name}  (confidence ${value.confidence.toFixed(2)}, ${value.elapsed_ms} ms)`)
        if (target !== undefined && target.columns.length > 0) {
          const matched = target.columns.map((column) => {
            const comment = column.comment === undefined ? '' : ` ${column.comment}`
            return `${column.column}${comment} [${column.matched_by}]`
          })
          lines.push(`Columns: ${matched.join(', ')}`)
        }
        if (value.sql !== undefined) lines.push(`SQL: ${value.sql}`)
        if (value.rows !== undefined) {
          const headers = value.rows.length === 0 ? [] : Object.keys((value.rows[0] ?? {}) as Record<string, unknown>)
          lines.push(headers.length === 0 ? `(no rows) — ${value.row_count ?? 0} returned` : renderRows(headers, value.rows, value.truncated === true))
        }
        if (value.redacted !== undefined && value.redacted.length > 0) {
          lines.push(`Masked: ${value.redacted.join(', ')} (matched the sensitive-column rule)`)
        }
        return lines.join('\n')
      }
      lines.push(`find did not execute: ${value.status}  (${value.reason})`)
      const candidates = value.candidates ?? (value.resolved === undefined ? [] : [value.resolved])
      if (candidates.length > 0) {
        lines.push(`Candidates${counted(candidates.length, candidates.length, false)}:`)
        for (const candidate of candidates) {
          const comment = candidate.comment === undefined ? '' : ` ${candidate.comment}`
          const columns = candidate.columns.length === 0
            ? ''
            : `  columns: ${candidate.columns.map(column => column.column).join(', ')}`
          lines.push(`  ${candidate.object}${comment}  (${candidate.score.toFixed(2)})${columns}`)
        }
        lines.push('Pick one with the object argument (and where for a filter), or ask the user which table they mean.')
      }
      if (value.status === 'missing_predicate') {
        lines.push('Pass entity (a word for the table, e.g. 用户) or object (an exact table name), plus where when a filter is wanted.')
      }
      return lines.join('\n')
    }
    case 'sql': {
      const lines = [`SQL on ${value.connection}: ${value.row_count} 行, ${value.elapsed_ms} ms`]
      lines.push(renderRows(value.columns, value.rows, value.truncated))
      if (value.affected_rows !== undefined) lines.push(`Affected rows: ${value.affected_rows}`)
      if (value.redacted.length > 0) lines.push(`Masked: ${value.redacted.join(', ')} (matched the sensitive-column rule)`)
      if (value.warnings !== undefined && value.warnings.length > 0) {
        lines.push(...value.warnings.map(warning => `Warning: ${warning}`))
      }
      return lines.join('\n')
    }
    case 'impact':
    case 'refs': {
      const direction = value.operation === 'impact' ? 'A change to' : 'Objects referencing'
      if (value.entries.length === 0) return `${direction} ${value.object}: none recorded in the index.`
      const lines = [`${direction} ${value.object}${counted(value.entries.length, value.entries.length, value.truncated)}:`]
      lines.push(...value.entries.map(entry => `  ${relationLine(entry)}`))
      return lines.join('\n')
    }
    /* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
    default:
      return assertNever(value, 'tool-dbgraph output')
  }
}

/**
 * Render one build-side result as the text the model reads.
 * @param value - the canonical value the index tool returned.
 * @returns the rendered text.
 */
export function renderDbgraphIndex(value: DbgraphIndexToolValue): string {
  if (value.status === 'started') {
    const target = value.connection ?? 'every configured connection'
    return `Indexing ${target} (${value.mode}) in the background as job ${value.job_id}. The run outlives this call — `
      + `read its report with job_output ${value.job_id}, or stop it with job_kill.`
  }
  if (value.reports.length === 0) return 'No connection was configured to index.'
  const lines: string[] = []
  for (const report of value.reports) {
    lines.push(
      `Indexed ${report.connection} (${report.level}): ${report.objects} 对象 / ${report.columns} 列 / ${report.edges} 关系`
      + `, ${report.terms} 检索词, writer ${report.writer}, ${report.elapsed_ms} ms.`,
    )
    if (report.warnings !== undefined && report.warnings.length > 0) {
      lines.push(...report.warnings.map(warning => `Warning: ${warning}`))
    }
  }
  return lines.join('\n')
}
