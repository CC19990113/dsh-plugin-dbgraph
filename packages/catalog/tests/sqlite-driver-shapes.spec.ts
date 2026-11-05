import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbgraphError } from 'dsh-plugin-dbgraph-service'
import type { DialectInput, ExecuteLimits, RawCatalog, RawObject } from 'dsh-plugin-dbgraph-service'
import { createSqliteDialect } from '../src/sqlite.ts'
import type { SqliteModule } from '../src/sqlite.ts'

/**
 * Driver shapes the real `node:sqlite` cannot produce on demand.
 *
 * The dialect takes its module as an argument (`createSqliteDialect(module)`) precisely so a Node
 * build without the builtin can disable this dialect instead of crashing the package. This file
 * uses that same seam the other way: a module wrapper that either opens the real binding with
 * `readBigInts` (a real driver option this dialect never sets itself) or scripts one statement's
 * result, so the row-shape and failure paths are exercised against real SQLite semantics instead of
 * a hand-written catalog. Every assertion is still made through the dialect's public methods.
 */

/** One statement stub, shaped like the `node:sqlite` surface the dialect calls. */
interface ScriptedStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint }
}

/** What a script answers for one SQL text: a stub, an error to throw, or nothing (delegate). */
type SqlScript = (sql: string) => ScriptedStatement | Error | undefined

/**
 * A statement stub returning fixed rows.
 * @param rows - rows for `all`/`get`.
 * @param changes - `run` changes count.
 * @returns the stub.
 */
function rowsStatement(rows: readonly unknown[], changes: number | bigint = 0): ScriptedStatement {
  return {
    all: () => [...rows],
    get: () => rows[0],
    run: () => ({ changes }),
  }
}

/**
 * A module whose `DatabaseSync` delegates to the real binding, optionally with extra options, and
 * whose `prepare` can answer one statement from a script first.
 * @param script - per-statement override, when a scenario needs one.
 * @param forceOptions - options forced onto the real handle regardless of the dialect's own.
 * @returns the injectable module.
 */
function wrappedModule(script: SqlScript = () => undefined, forceOptions: Record<string, unknown> = {}): SqliteModule {
  class WrappedDatabase {
    private readonly inner: DatabaseSync

    constructor(target: string, options?: Record<string, unknown>) {
      this.inner = new DatabaseSync(target, { ...options, ...forceOptions } as never)
    }

    prepare(sql: string): unknown {
      const scripted = script(sql)
      if (scripted instanceof Error) throw scripted
      if (scripted !== undefined) return scripted
      return this.inner.prepare(sql)
    }

    close(): void {
      this.inner.close()
    }
  }
  return { DatabaseSync: WrappedDatabase } as unknown as SqliteModule
}

let directory: string
let databasePath: string
let input: DialectInput

const READ_ONLY_LIMITS: ExecuteLimits = { maxRows: 50, timeoutMs: 5_000, readOnly: true }

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'dbgraph-catalog-sqlite-shapes-'))
  databasePath = join(directory, 'shapes.db')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      CREATE TABLE real_table (
        id INTEGER PRIMARY KEY,
        label TEXT,
        amount "SET"
      );
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      INSERT INTO real_table (id, label, amount) VALUES (1, 'alpha', 1), (2, 'beta', 2);
      INSERT INTO parent (id) VALUES (1);
    `)
  } finally {
    database.close()
  }
  input = {
    connection: { id: 'sqlite-shapes', engine: 'sqlite', database: databasePath },
    enumSampleLimit: 10,
    queryTimeoutMs: 5_000,
  }
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('sqlite fetchL1 — malformed driver rows', () => {
  it('drops master rows and column rows the query shape does not admit', async () => {
    const module = wrappedModule((sql) => {
      if (sql.includes('FROM sqlite_master')) {
        return rowsStatement([
          { type: 'table', name: 'real_table' },
          { type: 'table' },
          { name: 'missing_type' },
          { type: 'index', name: 'index_noise' },
        ])
      }
      if (sql.startsWith('PRAGMA table_info(')) {
        return rowsStatement([
          { name: undefined, type: undefined, notnull: undefined, dflt_value: null, pk: undefined },
        ])
      }
      return undefined
    })
    const dialect = createSqliteDialect(module)

    const catalog = await dialect.fetchL1(input)
    await dialect.close()

    expect(catalog.objects).toHaveLength(1)
    const [object] = catalog.objects
    expect(object?.name).toBe('real_table')
    // Every declared fact was absent: the column still appears with its positional defaults.
    expect(object?.columns).toEqual([
      { name: '', ordinal: 1, type: '', nullable: true, isPrimaryKey: false },
    ])
  })

  it('reports a catalog query the server refused as a query failure', async () => {
    const module = wrappedModule((sql) => (
      sql.includes('FROM sqlite_master') ? new Error('catalog exploded') : undefined
    ))
    const dialect = createSqliteDialect(module)

    await expect(dialect.fetchL1(input)).rejects.toMatchObject({
      code: 'DBGRAPH_QUERY_FAILED',
      message: expect.stringContaining('SQLite catalog query failed: catalog exploded'),
    })
    await dialect.close()
  })

  it('tolerates one broken object and keeps the snapshot', async () => {
    const brokenDirectory = mkdtempSync(join(tmpdir(), 'dbgraph-catalog-sqlite-broken-'))
    const brokenPath = join(brokenDirectory, 'broken.db')
    const database = new DatabaseSync(brokenPath)
    try {
      database.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE VIEW v_broken AS SELECT id FROM parent;
        DROP TABLE parent;
      `)
    } finally {
      database.close()
    }
    const dialect = createSqliteDialect({ DatabaseSync })

    try {
      const catalog = await dialect.fetchL1({ ...input, connection: { ...input.connection, database: brokenPath } })
      expect(catalog.objects).toEqual([])
      expect(catalog.warnings).toEqual([
        expect.stringContaining('sqlite: skipped "v_broken": SQLite catalog query failed'),
      ])
    } finally {
      await dialect.close()
      rmSync(brokenDirectory, { recursive: true, force: true })
    }
  })

  it('omits the server version when the version probe fails', async () => {
    const module = wrappedModule((sql) => (
      sql.includes('sqlite_version()') ? new Error('no version') : undefined
    ))
    const dialect = createSqliteDialect(module)

    const catalog = await dialect.fetchL1(input)
    await dialect.close()

    expect(catalog.serverVersion).toBeUndefined()
    expect(catalog.objects.map(object => object.name)).toEqual(['parent', 'real_table'])
  })
})

describe('sqlite fetchL2 — malformed driver rows', () => {
  /**
   * Build a small L1 snapshot by hand, so a scripted L2 only has to answer the PRAGMAs it means to.
   * @returns the catalog to enrich.
   */
  function shapeL1(): RawCatalog {
    const object: RawObject = {
      kind: 'table',
      name: 'real_table',
      columns: [
        { name: 'id', ordinal: 1, type: 'INTEGER', isPrimaryKey: true },
        { name: 'label', ordinal: 2, type: 'TEXT' },
      ],
    }
    return {
      engine: 'sqlite',
      serverVersion: '3.0.0',
      database: databasePath,
      objects: [object],
      fetchedAt: 1,
      level: 'l1',
    }
  }

  it('drops foreign-key and index rows without the identifiers a PRAGMA always reports', async () => {
    const module = wrappedModule((sql) => {
      if (sql.startsWith('PRAGMA foreign_key_list(')) {
        return rowsStatement([
          { id: 1, seq: 1, table: 'parent', from: 'b', to: 'y' },
          { id: 1, seq: 0, table: 'parent', from: 'a', to: 'x' },
          { seq: 0, table: 'parent', from: 'no_id', to: 'x' },
          { id: 2, table: 'parent', from: 'no_seq', to: 'x' },
          { id: 3, seq: 0, from: 'no_table', to: 'x' },
          { id: 4, seq: 0, table: 'parent', from: 'no_ref_column' },
        ])
      }
      if (sql.startsWith('PRAGMA index_list(')) {
        return rowsStatement([
          { seq: 0, name: 'idx_scripted', unique: 1, origin: 'c' },
          { seq: 1, unique: 1, origin: 'c' },
        ])
      }
      if (sql.startsWith('PRAGMA index_info(')) {
        return rowsStatement([{ seqno: 0, name: null }])
      }
      return undefined
    })
    const dialect = createSqliteDialect(module)

    const catalog = await dialect.fetchL2(input, shapeL1())
    await dialect.close()

    const edges = catalog.objects[0]?.edges ?? []
    const composite = edges.find(edge => edge.columns.length === 2)
    expect(composite).toMatchObject({
      kind: 'fk',
      columns: ['a', 'b'],
      refObject: 'parent',
      refColumns: ['x', 'y'],
    })
    const unnamedRef = edges.find(edge => edge.columns[0] === 'no_ref_column')
    expect(unnamedRef).toMatchObject({ kind: 'fk', refObject: 'parent' })
    expect(unnamedRef !== undefined && 'refColumns' in unnamedRef).toBe(false)
    // A row without a `seq` still participates, ordered first; rows missing an id/table are dropped.
    const defaulted = edges.find(edge => edge.columns[0] === 'no_seq')
    expect(defaulted).toMatchObject({ kind: 'fk', refObject: 'parent', refColumns: ['x'] })
    expect(edges.some(edge => edge.columns.includes('no_id'))).toBe(false)
    expect(edges.some(edge => edge.columns.includes('no_table'))).toBe(false)
    // The scripted index has an expression-only column list, so no index edge is recorded.
    expect(edges.some(edge => edge.kind === 'index')).toBe(false)
  })

  it('keeps an object at L1 shape when its enrichment fails', async () => {
    const module = wrappedModule((sql) => (
      sql.startsWith('PRAGMA foreign_key_list(') ? new Error('locked for enrichment') : undefined
    ))
    const dialect = createSqliteDialect(module)

    const catalog = await dialect.fetchL2(input, shapeL1())
    await dialect.close()

    expect(catalog.warnings).toEqual([
      expect.stringContaining('sqlite: enrichment failed for "real_table": SQLite catalog query failed: locked for enrichment'),
    ])
    expect(catalog.objects[0]?.edges).toBeUndefined()
    expect(catalog.objects[0]?.columns.map(column => 'isUnique' in column)).toEqual([false, false])
  })
})

describe('sqlite execute — driver failures', () => {
  it('rethrows a DbgraphError from the driver instead of wrapping it twice', async () => {
    const original = new DbgraphError('driver said no', 'DBGRAPH_QUERY_FAILED')
    const module = wrappedModule((sql) => (sql.startsWith('SELECT') ? original : undefined))
    const dialect = createSqliteDialect(module)

    await expect(dialect.execute(input, 'SELECT 1', READ_ONLY_LIMITS)).rejects.toBe(original)
    await dialect.close()
  })
})

describe('sqlite probe — version shapes', () => {
  it('reports success without a version when the server returns no version column', async () => {
    const module = wrappedModule((sql) => (
      sql.includes('sqlite_version()') ? rowsStatement([{}]) : undefined
    ))
    const dialect = createSqliteDialect(module)

    const probe = await dialect.test(input)
    await dialect.close()

    expect(probe.ok).toBe(true)
    expect(probe.serverVersion).toBeUndefined()
  })
})

describe('sqlite bigint reads', () => {
  it('reads a catalog and a write result when the driver reports integers as bigint', async () => {
    const module = wrappedModule(() => undefined, { readBigInts: true })
    const dialect = createSqliteDialect(module)

    try {
      const l1 = await dialect.fetchL1(input)
      const l2 = await dialect.fetchL2(input, l1)
      const updated = await dialect.execute(
        input,
        "UPDATE parent SET id = 2 WHERE id = 1",
        { ...READ_ONLY_LIMITS, readOnly: false },
      )
      const rows = await dialect.execute(input, 'SELECT id FROM parent', READ_ONLY_LIMITS)

      expect(l1.objects.map(object => object.name)).toEqual(['parent', 'real_table'])
      expect(l1.objects[1]?.columns.map(column => column.ordinal)).toEqual([1, 2, 3])
      expect(l1.objects[1]?.columns[0]?.isPrimaryKey).toBe(true)
      // A declared `SET` column keeps NUMERIC affinity, so the sampled literals are bigints here.
      expect([...(l2.objects[1]?.columns[2]?.enumValues ?? [])].sort()).toEqual(['1', '2'])
      expect(updated.affectedRows).toBe(1)
      expect(rows.rows).toEqual([{ id: '2' }])
    } finally {
      await dialect.close()
    }
  })

  it('falls back to the row position when a PRAGMA field is not a usable integer', async () => {
    const module = wrappedModule((sql) => {
      if (sql.startsWith('PRAGMA table_info(')) {
        return rowsStatement([
          { cid: 0, name: 'a', type: 'TEXT', notnull: 1.5, dflt_value: null, pk: 'x' },
          { cid: 2n ** 64n, name: 'b', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
        ])
      }
      return undefined
    })
    const dialect = createSqliteDialect(module)

    const catalog = await dialect.fetchL1(input)
    await dialect.close()

    const columns = catalog.objects[0]?.columns ?? []
    // An unsafe bigint and a non-integer number both fail to convert; the ordinal is positional.
    expect(columns[0]).toMatchObject({ name: 'a', ordinal: 1, nullable: true, isPrimaryKey: false })
    expect(columns[1]).toMatchObject({ name: 'b', ordinal: 2, nullable: false, isPrimaryKey: true })
  })
})

describe('sqlite enum sampling — values the driver can return', () => {
  it('deduplicates values that stringify the same', async () => {
    const module = wrappedModule((sql) => {
      if (sql.startsWith('SELECT DISTINCT')) {
        return rowsStatement([
          { value: 'same' },
          { value: 'same' },
          { value: 7 },
          { value: 7n },
          { value: Uint8Array.from([0]) },
          { value: null },
        ])
      }
      return undefined
    })
    const dialect = createSqliteDialect(module)

    const catalog = await dialect.fetchL2(input, {
      engine: 'sqlite',
      database: databasePath,
      objects: [{ kind: 'table', name: 'real_table', columns: [{ name: 'label', ordinal: 2, type: 'TEXT' }] }],
      fetchedAt: 1,
      level: 'l1',
    })
    await dialect.close()

    expect(catalog.objects[0]?.columns[0]?.enumValues).toEqual(['same', '7'])
  })
})
