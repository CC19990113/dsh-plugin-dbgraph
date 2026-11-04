/**
 * Root resolution: the environment override is the one switch that keeps tests off the real
 * `~/.dsh/dbgraph`, and every derived path must come from the same root.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionId, ZH_ALIASES } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import {
  ROOT_ENV,
  connectionsPath,
  indexPath,
  indexRoot,
  statusPath,
  tempIndexPath,
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
    expect(tempIndexPath('shop')).toBe(join(root, 'shop', 'index.db.tmp'))
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
