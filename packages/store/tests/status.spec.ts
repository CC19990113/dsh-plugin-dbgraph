/**
 * `status.json`: the prompt digest's shape, its cap, its merge behaviour across connections, and the
 * rule that an out-of-process run is recorded from the index itself.
 */

import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_STATUS_DIGEST_OBJECTS } from 'dsh-plugin-dbgraph-service'

import { statusPath } from '../src/paths.ts'
import { buildStatusEntry, readStatusFile } from '../src/status.ts'
import {
  SAMPLE,
  SQLITE_SAMPLE,
  column,
  makeRoot,
  removeRoot,
  seed,
  table,
} from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
})

async function freshRoot(): Promise<string> {
  const root = makeRoot()
  roots.push(root)
  return root
}

describe('status sidecar', () => {
  it('describes a complete snapshot, largest objects first', async () => {
    const root = await freshRoot()
    const { store } = await seed(root, 'shop', SAMPLE)
    stores.push(store)
    const file = readStatusFile(root)
    expect(file?.version).toBe(1)
    expect(file?.updatedAt).toBeGreaterThan(0)
    const entry = file?.connections.shop
    expect(entry).toMatchObject({
      engine: 'mysql',
      objects: SAMPLE.objects.length,
      columns: 331,
      l1IndexedAt: SAMPLE.fetchedAt,
      l2IndexedAt: SAMPLE.fetchedAt,
      digestOmitted: 0,
    })
    expect(entry?.label).toBeUndefined()
    expect(entry?.commentCoverage).toBeCloseTo(17 / 331, 10)
    expect(entry?.digest).toHaveLength(SAMPLE.objects.length)
    expect(entry?.digest[0]).toMatchObject({ object: 'wide_table', comment: '宽表', columns: 300 })
    expect(entry?.digest[1]).toMatchObject({ object: 'sys_user', comment: '系统用户', columns: 8 })
  })

  it('carries an L1-only snapshot without an L2 timestamp', async () => {
    const root = await freshRoot()
    const { store } = await seed(root, 'lite', SQLITE_SAMPLE)
    stores.push(store)
    const entry = readStatusFile(root)?.connections.lite
    expect(entry).toMatchObject({ engine: 'sqlite', objects: 1, columns: 3 })
    expect(entry?.l2IndexedAt).toBeUndefined()
  })

  it('caps the digest and reports how many objects were left out', async () => {
    const root = await freshRoot()
    const { store } = await seed(root, 'shop', SAMPLE, { maxDigestObjects: 2 })
    stores.push(store)
    const entry = readStatusFile(root)?.connections.shop
    expect(entry?.digest).toHaveLength(2)
    expect(entry?.digestOmitted).toBe(SAMPLE.objects.length - 2)
    expect(DEFAULT_STATUS_DIGEST_OBJECTS).toBe(120)
  })

  it('preserves another connection when one is rewritten', async () => {
    const root = await freshRoot()
    const first = await seed(root, 'shop', SAMPLE)
    stores.push(first.store)
    const second = await seed(root, 'lite', SQLITE_SAMPLE)
    stores.push(second.store)
    const file = readStatusFile(root)
    expect(Object.keys(file?.connections ?? {}).sort()).toEqual(['lite', 'shop'])
    expect(file?.connections.shop?.objects).toBe(SAMPLE.objects.length)
  })

  it('treats a corrupt sidecar as absent and rewrites it', async () => {
    const root = await freshRoot()
    const { store } = await seed(root, 'shop', SAMPLE)
    stores.push(store)
    writeFileSync(statusPath(root), 'not json', 'utf8')
    expect(readStatusFile(root)).toBeUndefined()
    const again = await seed(root, 'shop', SAMPLE)
    stores.push(again.store)
    expect(readStatusFile(root)?.connections.shop?.objects).toBe(SAMPLE.objects.length)
  })

  it('replaces a document written for another format version instead of merging it', async () => {
    const root = await freshRoot()
    writeFileSync(
      statusPath(root),
      JSON.stringify({
        version: 99,
        updatedAt: 1,
        connections: { ghost: { engine: 'mysql', objects: 1, columns: 1, commentCoverage: 0, digest: [], digestOmitted: 0 } },
      }),
      'utf8',
    )
    const { store } = await seed(root, 'shop', SAMPLE)
    stores.push(store)
    const file = readStatusFile(root)
    expect(file?.version).toBe(1)
    expect(Object.keys(file?.connections ?? {})).toEqual(['shop'])
  })
})

describe('buildStatusEntry', () => {
  it('applies the default digest cap and reports an uncommented, empty snapshot', () => {
    const entry = buildStatusEntry({
      engine: 'mysql',
      level: 'l1',
      fetchedAt: 42,
      objects: [],
      columnCount: 0,
    })
    expect(entry).toEqual({
      engine: 'mysql',
      l1IndexedAt: 42,
      objects: 0,
      columns: 0,
      commentCoverage: 0,
      digest: [],
      digestOmitted: 0,
    })
    expect(DEFAULT_STATUS_DIGEST_OBJECTS).toBe(120)
  })

  it('carries a configured label and ranks equally wide objects by name', () => {
    const narrowA = table('alpha', [column('id', 1, 'int')], { comment: 'A' })
    const narrowB = table('beta', [column('id', 1, 'int')])
    const entry = buildStatusEntry({
      engine: 'mysql',
      label: '生产',
      level: 'l2',
      fetchedAt: 7,
      objects: [narrowB, narrowA],
      columnCount: 2,
      maxDigestObjects: 5,
    })
    expect(entry.label).toBe('生产')
    expect(entry.l2IndexedAt).toBe(7)
    // Same column count: the width tie-break cannot separate them, so the name decides.
    expect(entry.digest.map(entry => entry.object)).toEqual(['alpha', 'beta'])
    expect(entry.digest[0]).toEqual({ object: 'alpha', comment: 'A', columns: 1 })
  })
})

describe('readStatusFile validation', () => {
  function withDocument(document: string): string {
    const root = makeRoot()
    roots.push(root)
    writeFileSync(statusPath(root), document, 'utf8')
    return root
  }

  it('treats a non-object document as absent', () => {
    expect(readStatusFile(withDocument('null'))).toBeUndefined()
    expect(readStatusFile(withDocument('42'))).toBeUndefined()
    expect(readStatusFile(withDocument('"status"'))).toBeUndefined()
  })

  it('treats a missing or non-numeric version as absent', () => {
    expect(readStatusFile(withDocument(JSON.stringify({ connections: {} })))).toBeUndefined()
    expect(readStatusFile(withDocument(JSON.stringify({ version: '1', connections: {} })))).toBeUndefined()
  })

  it('treats a missing or non-object connection map as absent', () => {
    expect(readStatusFile(withDocument(JSON.stringify({ version: 1 })))).toBeUndefined()
    expect(readStatusFile(withDocument(JSON.stringify({ version: 1, connections: null })))).toBeUndefined()
  })

  it('defaults a missing updatedAt to zero and keeps the entries it can read', () => {
    const root = withDocument(JSON.stringify({ version: 1, connections: { shop: { engine: 'mysql' } } }))
    expect(readStatusFile(root)).toEqual({
      version: 1,
      updatedAt: 0,
      connections: { shop: { engine: 'mysql' } },
    })
  })
})
