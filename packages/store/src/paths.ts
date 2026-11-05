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

import { randomUUID } from 'node:crypto'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  CONNECTIONS_FILE_NAME,
  INDEX_FILE_NAME,
  INDEX_ROOT_DIRNAME,
  STATUS_FILE_NAME,
} from 'dsh-plugin-dbgraph-service'

/** Environment variable that relocates the whole index root. */
export const ROOT_ENV = 'DSH_DBGRAPH_ROOT'

/**
 * How long a staging file may sit before a write treats it as abandoned.
 *
 * A run that dies between creating its staging file and renaming it leaves that file behind forever
 * (the path is per-run, so no later run reuses or removes it). One hour is far past any real build —
 * the measured worst case on a 10k-column catalog is seconds — and short enough that a directory does
 * not accumulate junk indefinitely.
 */
export const STALE_STAGING_MAX_AGE_MS = 60 * 60 * 1000

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
 * A staging path unique to one write.
 *
 * A plain `<index>.tmp` is not enough: two index runs for the same connection would share it, and one
 * run could delete or rename the other's half-written file. The nonce is per call, so a run only ever
 * cleans up and renames a file it created itself.
 * @param id - connection identity.
 * @param root - index root.
 * @returns `<index>.<pid>-<nonce>.tmp`, on the same filesystem so the rename is atomic.
 */
export function stagingIndexPath(id: string, root: string = indexRoot()): string {
  return `${indexPath(id, root)}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`
}

/**
 * Remove staging files a previous run abandoned beside one index.
 *
 * The per-run nonce fixes the original collision (two runs cannot share a staging file) but turns
 * each leak into a permanent one: a run killed between `open` and `rename` leaves
 * `<index>.<pid>-<nonce>.tmp` behind and no later run would ever reuse that name. Only files older
 * than {@link STALE_STAGING_MAX_AGE_MS} are removed, so a run that is merely slow — or a second run
 * holding its own fresh staging file — is never touched. Removal failures are ignored: the file is
 * junk, and a concurrent writer may remove it first.
 * @param indexFile - the connection's live index path (the staging files share its directory).
 * @param now - clock override, for tests.
 * @returns the paths that were removed.
 */
export function sweepStaleStaging(indexFile: string, now: number = Date.now()): string[] {
  const directory = dirname(indexFile)
  const prefix = `${basename(indexFile)}.`
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    // No directory yet: the write that called this is about to create it.
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const candidate = join(directory, name)
    try {
      if (now - statSync(candidate).mtimeMs <= STALE_STAGING_MAX_AGE_MS) continue
      rmSync(candidate, { force: true })
      removed.push(candidate)
    } catch {
      // The file vanished, or its directory is not readable; either way there is nothing to clean.
    }
  }
  return removed
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
