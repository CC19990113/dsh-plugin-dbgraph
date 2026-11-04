/**
 * Writer selection when the native kernel is **not** available.
 *
 * The environment override (`DSH_DBGRAPH_RUST_ADDON`) points at a path that does not exist, which is
 * the only way to exercise "artifact missing" on a machine where it was built. For the real thing see
 * `rust-writer.spec.ts`.
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../src/index.ts'
import { indexPath, tempIndexPath } from '../src/paths.ts'
import { ADDON_ENV, parseRustReport } from '../src/rust-engine.ts'
import { SAMPLE, connectionId, makeRoot, removeRoot } from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []
const originalAddon = process.env[ADDON_ENV]

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
  if (originalAddon === undefined) delete process.env[ADDON_ENV]
  else process.env[ADDON_ENV] = originalAddon
})

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

describe('writer selection without the native kernel', () => {
  beforeEach(() => {
    process.env[ADDON_ENV] = join(tmpdir(), 'dbgraph-no-such-addon', 'dbgraph-indexer.node')
  })

  it("'auto' falls back to the JavaScript writer and reports it once", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const root = freshRoot()
      const store = createStore({ root })
      const other = createStore({ root })
      stores.push(store, other)
      const first = await store.write(connectionId('shop'), SAMPLE, { writer: 'auto', aliases: [] })
      // A second store instance must not repeat the explanation: one line per process.
      const second = await other.write(connectionId('shop'), SAMPLE, { writer: 'auto', aliases: [] })
      expect(first.writer).toBe('js')
      expect(second.writer).toBe('js')
      expect(first.objects).toBe(SAMPLE.objects.length)
      expect(errors).toHaveBeenCalledTimes(1)
      expect(String(errors.mock.calls[0]?.[0])).toContain('native index writer is unavailable')
      expect(existsSync(indexPath('shop', root))).toBe(true)
      expect(existsSync(tempIndexPath('shop', root))).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })

  it("'rust' fails loudly and leaves no index behind", async () => {
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    await expect(
      store.write(connectionId('shop'), SAMPLE, { writer: 'rust', aliases: [] }),
    ).rejects.toMatchObject({ code: 'DBGRAPH_UNAVAILABLE' })
    expect(existsSync(indexPath('shop', root))).toBe(false)
    expect(existsSync(tempIndexPath('shop', root))).toBe(false)
  })

  it("'js' never consults the addon at all", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const root = freshRoot()
      const store = createStore({ root })
      stores.push(store)
      const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'js', aliases: [] })
      expect(report.writer).toBe('js')
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})

describe('parseRustReport', () => {
  it('accepts a well-formed report', () => {
    expect(parseRustReport({ objects: 2, columns: 3, edges: 1, terms: 4, elapsedMs: 5 })).toEqual({
      objects: 2,
      columns: 3,
      edges: 1,
      terms: 4,
      elapsedMs: 5,
    })
  })

  it('rejects anything that could not have come from a real write', () => {
    expect(parseRustReport(undefined)).toBeUndefined()
    expect(parseRustReport(null)).toBeUndefined()
    expect(parseRustReport('ok')).toBeUndefined()
    expect(parseRustReport({ objects: 1, columns: 1, edges: 1, terms: 1 })).toBeUndefined()
    expect(parseRustReport({ objects: -1, columns: 1, edges: 1, terms: 1, elapsedMs: 1 })).toBeUndefined()
    expect(parseRustReport({ objects: 1.5, columns: 1, edges: 1, terms: 1, elapsedMs: 1 })).toBeUndefined()
    expect(parseRustReport({ objects: 1, columns: 1, edges: 1, terms: 1, elapsedMs: Number.NaN })).toBeUndefined()
  })
})
