/**
 * One in-flight writer per connection: the guard, and the wiring that refuses a second index run.
 */

import { describe, expect, it } from 'vitest'
import { createStore, WriteGuard } from '../src/index.ts'
import { SAMPLE, connectionId, makeRoot, removeRoot } from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []

function freshStore(): ReturnType<typeof createStore> {
  const root = makeRoot()
  roots.push(root)
  const store = createStore({ root })
  stores.push(store)
  return store
}

describe('WriteGuard', () => {
  it('admits one run per connection and releases the slot on both outcomes', async () => {
    const guard = new WriteGuard()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = guard.run('shop', async () => {
      await held
      return 'first'
    })
    await expect(guard.run('shop', async () => 'second')).rejects.toMatchObject({ code: 'DBGRAPH_CONFLICT' })
    expect(guard.has('shop')).toBe(true)
    // A different connection is untouched.
    await expect(guard.run('other', async () => 'parallel')).resolves.toBe('parallel')
    release()
    await expect(first).resolves.toBe('first')
    expect(guard.has('shop')).toBe(false)
    await expect(guard.run('shop', async () => 'again')).resolves.toBe('again')
    await expect(guard.run('shop', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(guard.has('shop')).toBe(false)
  })
})

describe('store.write', () => {
  it('refuses a second write for the same connection while the first is in flight', async () => {
    const store = freshStore()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const heldRun = store.writes.run('shop', async () => {
      await held
    })
    await expect(store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] }))
      .rejects.toMatchObject({ code: 'DBGRAPH_CONFLICT' })
    release()
    await heldRun
    // The slot is free again, so the same write now succeeds and leaves no staging file behind.
    await expect(store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] }))
      .resolves.toMatchObject({ writer: 'js' })
  })
})
