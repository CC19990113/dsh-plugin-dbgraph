/**
 * Root resolution: the environment override is the one switch that keeps tests off the real
 * `~/.dsh/dbgraph`, and every derived path must come from the same root.
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionId, ZH_ALIASES } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import {
  ROOT_ENV,
  STALE_STAGING_MAX_AGE_MS,
  connectionsPath,
  indexPath,
  indexRoot,
  statusPath,
  stagingIndexPath,
  sweepStaleStaging,
} from '../src/paths.ts'
import { SAMPLE, makeRoot, removeRoot } from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []
const original = process.env[ROOT_ENV]

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
  if (original === undefined) delete process.env[ROOT_ENV]
  else process.env[ROOT_ENV] = original
})

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

describe('index root', () => {
  it('defaults to ~/.dsh/dbgraph', () => {
    delete process.env[ROOT_ENV]
    expect(indexRoot().endsWith(join('.dsh', 'dbgraph'))).toBe(true)
  })

  it('honours DSH_DBGRAPH_ROOT, including for a store built without a root', async () => {
    const root = freshRoot()
    process.env[ROOT_ENV] = root
    expect(indexRoot()).toBe(root)
    expect(indexPath('shop')).toBe(join(root, 'shop', 'index.db'))
    const staging = stagingIndexPath('shop')
    expect(staging.startsWith(join(root, 'shop', 'index.db') + '.')).toBe(true)
    expect(staging.endsWith('.tmp')).toBe(true)
    // Unique per call: a plain `index.db.tmp` is what let two runs clobber one another.
    expect(stagingIndexPath('shop')).not.toBe(staging)
    expect(connectionsPath()).toBe(join(root, 'connections.json'))
    expect(statusPath()).toBe(join(root, 'status.json'))

    const store = createStore()
    stores.push(store)
    await store.write(ConnectionId('shop'), SAMPLE, { writer: 'js', aliases: ZH_ALIASES })
    expect(existsSync(join(root, 'shop', 'index.db'))).toBe(true)
    expect(existsSync(join(root, 'status.json'))).toBe(true)
  })

  it('prefers an explicit root over the environment', () => {
    process.env[ROOT_ENV] = '/from/environment'
    expect(indexPath('shop', '/explicit')).toBe(join('/explicit', 'shop', 'index.db'))
    expect(indexPath('shop')).toBe(join('/from/environment', 'shop', 'index.db'))
  })
})

describe('store.write staging hygiene', () => {
  it('sweeps an abandoned staging file as part of the next write', async () => {
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const directory = join(root, 'shop')
    mkdirSync(directory, { recursive: true })
    const abandoned = join(directory, 'index.db.999-deadbeef.tmp')
    writeFileSync(abandoned, 'partial')
    const old = new Date(Date.now() - STALE_STAGING_MAX_AGE_MS - 60_000)
    utimesSync(abandoned, old, old)

    await store.write(ConnectionId('shop'), SAMPLE, { writer: 'js', aliases: ZH_ALIASES })
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(indexPath('shop', root))).toBe(true)
    expect(existsSync(statusPath(root))).toBe(true)
  })
})

describe('sweepStaleStaging', () => {
  /**
   * Write one file into a connection directory with a chosen mtime.
   * @param directory - the connection directory.
   * @param name - the file name.
   * @param mtime - epoch milliseconds recorded as the modification time.
   * @returns the path written.
   */
  function writeStaged(directory: string, name: string, mtime: number): string {
    const path = join(directory, name)
    writeFileSync(path, 'partial')
    utimesSync(path, new Date(mtime), new Date(mtime))
    return path
  }

  it('removes only abandoned staging files, and leaves the index and fresh runs alone', () => {
    const root = freshRoot()
    const directory = join(root, 'shop')
    mkdirSync(directory, { recursive: true })
    const live = indexPath('shop', root)
    const now = Date.now()
    const old = now - STALE_STAGING_MAX_AGE_MS - 60_000

    const abandoned = writeStaged(directory, 'index.db.123-deadbeef.tmp', old)
    const fresh = writeStaged(directory, 'index.db.456-feedface.tmp', now)
    const index = writeStaged(directory, 'index.db', old)
    const unrelated = writeStaged(directory, 'other.db.1-nonce.tmp', old)
    // A legacy plain `index.db.tmp` is a staging file too, and it is just as abandoned.
    const legacy = writeStaged(directory, 'index.db.tmp', old)

    expect(sweepStaleStaging(live, now).sort()).toEqual([abandoned, legacy].sort())
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(index)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(live)).toBe(true)
  })

  it('ignores a future mtime instead of treating it as ancient', () => {
    const root = freshRoot()
    const directory = join(root, 'shop')
    mkdirSync(directory, { recursive: true })
    const now = Date.now()
    const staged = writeStaged(directory, 'index.db.1-a.tmp', now + 60_000)
    expect(sweepStaleStaging(indexPath('shop', root), now)).toEqual([])
    expect(existsSync(staged)).toBe(true)
  })

  it('returns nothing when the connection directory does not exist yet', () => {
    const root = freshRoot()
    expect(sweepStaleStaging(indexPath('shop', root))).toEqual([])
  })
})
