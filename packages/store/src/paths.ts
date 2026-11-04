/**
 * Where dbgraph keeps its files, and the one switch that relocates them.
 *
 * Everything lives under a single root (`~/.dsh/dbgraph` by default):
 *
 * - `<root>/connections.json` — the connection list,
 * - `<root>/<connection>/index.db` — one SQLite index per connection,
 * - `<root>/status.json` — the prompt digest read synchronously on every prompt assembly.
 *
 * `DSH_DBGRAPH_ROOT` overrides the root so a test (or a deployment that keeps profile state somewhere
 * else) never touches the real harness home. A store instance resolves the root once at construction;
 * the free functions take an explicit root and fall back to the environment so a lone caller (a
 * config surface, a test of `connections.json`) does not need a store first.
 * @module dsh-plugin-dbgraph-store/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CONNECTIONS_FILE_NAME,
  INDEX_FILE_NAME,
  INDEX_ROOT_DIRNAME,
  STATUS_FILE_NAME,
} from 'dsh-plugin-dbgraph-service'

/** Environment variable that relocates the whole index root. */
export const ROOT_ENV = 'DSH_DBGRAPH_ROOT'

/**
 * The index root: `DSH_DBGRAPH_ROOT` when set and non-empty, else `~/.dsh/dbgraph`.
 * @returns an absolute directory path (an override may be relative; callers treat it as-is).
 */
export function indexRoot(): string {
  const override = process.env[ROOT_ENV]?.trim()
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.dsh', INDEX_ROOT_DIRNAME)
}

/**
 * One connection's private directory.
 * @param id - connection identity (already validated by the caller).
 * @param root - index root; defaults to {@link indexRoot}.
 * @returns the directory path, whether or not it exists.
 */
export function connectionDir(id: string, root: string = indexRoot()): string {
  return join(root, id)
}

/**
 * One connection's index file.
 * @param id - connection identity.
 * @param root - index root.
 * @returns the path, whether or not the file exists.
 */
export function indexPath(id: string, root: string = indexRoot()): string {
  return join(connectionDir(id, root), INDEX_FILE_NAME)
}

/**
 * The staging path a writer fills before renaming it over the index.
 * @param id - connection identity.
 * @param root - index root.
 * @returns `<index>.tmp`, on the same filesystem so the rename is atomic.
 */
export function tempIndexPath(id: string, root: string = indexRoot()): string {
  return `${indexPath(id, root)}.tmp`
}

/**
 * The connection list.
 * @param root - index root.
 * @returns `<root>/connections.json`.
 */
export function connectionsPath(root: string = indexRoot()): string {
  return join(root, CONNECTIONS_FILE_NAME)
}

/**
 * The prompt digest sidecar.
 * @param root - index root.
 * @returns `<root>/status.json`.
 */
export function statusPath(root: string = indexRoot()): string {
  return join(root, STATUS_FILE_NAME)
}
