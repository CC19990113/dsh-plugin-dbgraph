/**
 * `connections.json` — the configured connection list.
 *
 * Deliberately boring, for a security reason: this file never holds a password, only the name of the
 * credential-seam entry that does (`credentialRef`). It is the one place a connection id arrives from
 * outside the process, and that id becomes a directory name, so **every** entry is validated against
 * `isValidConnectionId` before it may be used. A malformed file fails loudly rather than yielding a
 * list that a later path join would silently turn into a path traversal.
 *
 * The file is written atomically (staging file + rename) and with `0600`, because it lists hosts,
 * users, and database names even though it holds no secret.
 * @module dsh-plugin-dbgraph-store/connections
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DbgraphError, isValidConnectionId } from 'dsh-plugin-dbgraph-service'
import type { ConnectionsFile, StoredConnection } from 'dsh-plugin-dbgraph-service'
import { connectionsPath } from './paths.ts'

/** Format version this build writes and the only one it understands. */
export const CONNECTIONS_FORMAT_VERSION = 1

/**
 * One thrown value's message.
 * @param error - the thrown value.
 * @returns a non-empty message.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error) ?? 'unknown error'
}

/**
 * Read one entry out of a parsed document, validating everything that could later become a path or a
 * credential reference.
 * @param value - one entry of the parsed `connections` array.
 * @param position - its index, for the error message.
 * @returns the validated entry.
 */
function parseConnection(value: unknown, position: number): StoredConnection {
  if (typeof value !== 'object' || value === null) {
    throw new DbgraphError(
      `connections.json entry ${position} is not an object`,
      'DBGRAPH_MALFORMED_INDEX',
    )
  }
  const record = value as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || !isValidConnectionId(id)) {
    throw new DbgraphError(
      `connections.json entry ${position} has an unusable id: ${JSON.stringify(id)}`,
      'DBGRAPH_MALFORMED_INDEX',
    )
  }
  const engine = record.engine
  if (typeof engine !== 'string' || engine.trim() === '') {
    throw new DbgraphError(
      `connections.json entry "${id}" has no engine`,
      'DBGRAPH_MALFORMED_INDEX',
    )
  }
  const patterns = record.sensitivePatterns
  const sensitivePatterns = Array.isArray(patterns)
    ? patterns.filter((pattern): pattern is string => typeof pattern === 'string')
    : undefined
  return {
    id,
    engine,
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    ...(typeof record.database === 'string' ? { database: record.database } : {}),
    ...(typeof record.user === 'string' ? { user: record.user } : {}),
    ...(typeof record.credentialRef === 'string' ? { credentialRef: record.credentialRef } : {}),
    ...(typeof record.sensitiveColumns === 'string' ? { sensitiveColumns: record.sensitiveColumns } : {}),
    ...(sensitivePatterns === undefined ? {} : { sensitivePatterns }),
    ...(typeof record.addedAt === 'number' ? { addedAt: record.addedAt } : {}),
  }
}

/**
 * Read the connection list.
 *
 * A missing file is an empty list, not an error: a fresh installation has no connections yet, and
 * every read path must keep working while the user is still configuring their first one.
 * @param root - index root.
 * @returns the configured connections, in file order.
 */
export function readConnections(root: string): readonly StoredConnection[] {
  const path = connectionsPath(root)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new DbgraphError(`connections.json is unreadable: ${messageOf(error)}`, 'DBGRAPH_MALFORMED_INDEX', {
      cause: error,
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DbgraphError(`connections.json is not valid JSON: ${messageOf(error)}`, 'DBGRAPH_MALFORMED_INDEX', {
      cause: error,
    })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DbgraphError('connections.json is not an object', 'DBGRAPH_MALFORMED_INDEX')
  }
  const document = parsed as { version?: unknown; connections?: unknown }
  if (document.version !== CONNECTIONS_FORMAT_VERSION) {
    throw new DbgraphError(
      `connections.json is version ${JSON.stringify(document.version)}; this build writes and reads`
      + ` version ${CONNECTIONS_FORMAT_VERSION}`,
      'DBGRAPH_MALFORMED_INDEX',
    )
  }
  if (!Array.isArray(document.connections)) {
    throw new DbgraphError('connections.json has no connections array', 'DBGRAPH_MALFORMED_INDEX')
  }
  const seen = new Set<string>()
  const connections: StoredConnection[] = []
  for (let index = 0; index < document.connections.length; index += 1) {
    const entry = parseConnection(document.connections[index], index)
    if (seen.has(entry.id)) {
      throw new DbgraphError(`connections.json lists "${entry.id}" twice`, 'DBGRAPH_MALFORMED_INDEX')
    }
    seen.add(entry.id)
    connections.push(entry)
  }
  return connections
}

/**
 * Replace the connection list atomically.
 *
 * Round-tripping through the file (read → modify → write) is the supported way to add or remove one
 * connection; preserving order is the caller's business, not this function's.
 * @param connections - the full list to persist.
 * @param root - index root.
 */
export function writeConnections(connections: readonly StoredConnection[], root: string): void {
  const seen = new Set<string>()
  const document: ConnectionsFile = {
    version: CONNECTIONS_FORMAT_VERSION,
    connections: connections.map((connection, index) => {
      if (!isValidConnectionId(connection.id)) {
        throw new DbgraphError(
          `connection entry ${index} has an unusable id: "${connection.id}"`,
          'DBGRAPH_MALFORMED_INDEX',
        )
      }
      if (connection.engine.trim() === '') {
        throw new DbgraphError(`connection "${connection.id}" has no engine`, 'DBGRAPH_MALFORMED_INDEX')
      }
      if (seen.has(connection.id)) {
        throw new DbgraphError(`connection "${connection.id}" is listed twice`, 'DBGRAPH_MALFORMED_INDEX')
      }
      seen.add(connection.id)
      return { ...connection }
    }),
  }
  const target = connectionsPath(root)
  mkdirSync(dirname(target), { recursive: true })
  const staging = `${target}.tmp`
  writeFileSync(staging, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { force: true })
    throw new DbgraphError(`writing connections.json failed: ${messageOf(error)}`, 'DBGRAPH_WRITE_FAILED', {
      cause: error,
    })
  }
}

/**
 * The configured connection with this id, when there is one.
 * @param id - connection identity.
 * @param root - index root.
 * @returns the entry, or undefined.
 */
export function findConnection(id: string, root: string): StoredConnection | undefined {
  return readConnections(root).find(connection => connection.id === id)
}
