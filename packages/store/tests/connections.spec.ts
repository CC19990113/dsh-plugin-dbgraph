/**
 * `connections.json`: absent ≠ broken, ids are validated before they can become paths, writes are
 * atomic, and the round-trip preserves what a configuration surface needs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

describe('readConnections validation', () => {
  function withDocument(document: string): string {
    const root = freshRoot()
    writeFileSync(connectionsPath(root), document, 'utf8')
    return root
  }

  it('rejects an entry that is not an object', () => {
    const root = withDocument(JSON.stringify({ version: 1, connections: [42] }))
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX', message: expect.stringContaining('is not an object') }),
    )
  })

  it('rejects an entry without an engine', () => {
    const root = withDocument(JSON.stringify({ version: 1, connections: [{ id: 'shop' }] }))
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX', message: expect.stringContaining('has no engine') }),
    )
  })

  it('rejects a document that is not an object', () => {
    expect(() => readConnections(withDocument('null'))).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX', message: expect.stringContaining('not an object') }),
    )
  })

  it('rejects a document written for another format version', () => {
    const root = withDocument(JSON.stringify({ version: 2, connections: [] }))
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX', message: expect.stringContaining('version 2') }),
    )
  })

  it('rejects a document without a connections array', () => {
    const root = withDocument(JSON.stringify({ version: 1, connections: {} }))
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX', message: expect.stringContaining('connections array') }),
    )
  })

  it('reports an unreadable file rather than pretending there are no connections', () => {
    const root = freshRoot()
    // A directory where the file belongs: existsSync succeeds and the read fails.
    mkdirSync(connectionsPath(root), { recursive: true })
    expect(() => readConnections(root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX', message: expect.stringContaining('unreadable') }),
    )
  })
})

describe('writeConnections failure paths', () => {
  it('rejects an entry with a blank engine before touching the file', () => {
    const root = freshRoot()
    expect(() => writeConnections([{ id: 'shop', engine: '   ' }], root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_MALFORMED_INDEX', message: expect.stringContaining('has no engine') }),
    )
    expect(existsSync(connectionsPath(root))).toBe(false)
  })

  it('reports a rename failure and removes its staging file', () => {
    const root = freshRoot()
    // A directory where connections.json belongs makes the final rename impossible.
    mkdirSync(connectionsPath(root), { recursive: true })
    expect(() => writeConnections([{ id: 'shop', engine: 'mysql' }], root)).toThrow(
      expect.objectContaining({ code: 'DBGRAPH_WRITE_FAILED' }),
    )
    expect(existsSync(`${connectionsPath(root)}.tmp`)).toBe(false)
  })
})
