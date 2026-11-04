/**
 * `connections.json`: absent ≠ broken, ids are validated before they can become paths, writes are
 * atomic, and the round-trip preserves what a configuration surface needs.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionsPath } from '../src/paths.ts'
import { findConnection, readConnections, writeConnections } from '../src/connections.ts'
import { createStore } from '../src/index.ts'
import { makeRoot, removeRoot } from './helpers.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

describe('readConnections', () => {
  it('returns an empty list when the file does not exist', () => {
    expect(readConnections(freshRoot())).toEqual([])
  })

  it('fails loudly on invalid JSON', () => {
    const root = freshRoot()
    const store = createStore({ root })
    writeFileSync(connectionsPath(root), '{ not json', 'utf8')
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }),
    )
    store.dispose()
  })

  it('rejects an entry whose id could escape its directory', () => {
    const root = freshRoot()
    writeFileSync(
      connectionsPath(root),
      JSON.stringify({ version: 1, connections: [{ id: '../../etc', engine: 'mysql' }] }),
      'utf8',
    )
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }),
    )
  })

  it('rejects a duplicate id', () => {
    const root = freshRoot()
    writeFileSync(
      connectionsPath(root),
      JSON.stringify({
        version: 1,
        connections: [
          { id: 'shop', engine: 'mysql' },
          { id: 'shop', engine: 'mysql' },
        ],
      }),
      'utf8',
    )
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }),
    )
  })
})

describe('writeConnections', () => {
  it('round-trips every field a configuration surface may set', () => {
    const root = freshRoot()
    writeConnections(
      [
        {
          id: 'shop',
          engine: 'mysql',
          label: '生产',
          host: 'db.internal',
          port: 3306,
          database: 'shop',
          user: 'reader',
          credentialRef: 'DBGRAPH_SHOP_PASSWORD',
          sensitiveColumns: 'redact',
          sensitivePatterns: ['phone'],
          addedAt: 1_700_000_000_000,
        },
        { id: 'lite', engine: 'sqlite', database: '/tmp/example.db' },
      ],
      root,
    )
    const parsed = JSON.parse(readFileSync(connectionsPath(root), 'utf8')) as {
      version: number
      connections: unknown[]
    }
    expect(parsed.version).toBe(1)
    expect(parsed.connections).toHaveLength(2)
    expect(existsSync(`${connectionsPath(root)}.tmp`)).toBe(false)
    expect(readConnections(root)).toHaveLength(2)
    expect(findConnection('shop', root)?.label).toBe('生产')
    expect(findConnection('missing', root)).toBeUndefined()
  })

  it('refuses to write an unusable id or a duplicate before touching the file', () => {
    const root = freshRoot()
    expect(() => writeConnections([{ id: '../escape', engine: 'mysql' }], root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }),
    )
    expect(() =>
      writeConnections(
        [
          { id: 'shop', engine: 'mysql' },
          { id: 'shop', engine: 'mysql' },
        ],
        root,
      ),
    ).toThrow(expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX' }))
    expect(existsSync(connectionsPath(root))).toBe(false)
  })
})
