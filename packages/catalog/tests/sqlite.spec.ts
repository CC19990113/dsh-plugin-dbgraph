import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbgraphError } from 'dsh-plugin-dbgraph-service'
import type {
  ConnectionConfig,
  DialectInput,
  ExecuteLimits,
  RawCatalog,
  RawColumn,
  RawObject,
} from 'dsh-plugin-dbgraph-service'
import { DBGRAPH_QUERY_FAILED_CODE, DBGRAPH_READ_ONLY_CODE, REDACTED_VALUE } from '../src/support.ts'
import type { ManagedDialect } from '../src/support.ts'
import { createSqliteDialect, SQLITE_TIMEOUT_WARNING } from '../src/sqlite.ts'

/** The fixture's wide table has this many columns; the test asserts every one survives. */
const WIDE_COLUMN_COUNT = 300

const READ_ONLY_LIMITS: ExecuteLimits = { maxRows: 50, timeoutMs: 5_000, readOnly: true }

/**
 * Build the `wide_300` column list: odd ordinals are TEXT, even ordinals are INTEGER.
 * @returns the body of the CREATE TABLE statement.
 */
function wideColumns(): string {
  return Array.from({ length: WIDE_COLUMN_COUNT }, (_, index) => {
    const name = `c${String(index + 1).padStart(3, '0')}`
    const type = (index + 1) % 2 === 1 ? 'TEXT' : 'INTEGER'
    return `${name} ${type}`
  }).join(',\n  ')
}

/**
 * The fixture schema: several tables, a composite primary key, foreign keys, single- and
 * multi-column unique indexes, a plain index, a view, a sensitive-column table, and a 300-column
 * wide table. No comments exist anywhere — SQLite has no comment mechanism.
 */
const FIXTURE_SQL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  password TEXT,
  status TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  avatar BLOB
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  amount REAL NOT NULL DEFAULT 0,
  status TEXT,
  created_at TEXT
);

CREATE TABLE order_items (
  order_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, line_no),
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  tenant TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_accounts_email ON accounts (email);
CREATE UNIQUE INDEX uq_accounts_tenant_email ON accounts (tenant, email);

CREATE INDEX idx_orders_user ON orders (user_id);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  token TEXT,
  secret TEXT,
  label TEXT
);

CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE VIEW v_user_names AS SELECT id, name FROM users;

CREATE TABLE wide_300 (
  ${wideColumns()}
);
`

/** A 40-byte binary value: long enough that the execute preview must abbreviate it. */
function blob(): Uint8Array {
  return Uint8Array.from({ length: 40 }, (_, index) => index)
}

/**
 * Create the fixture database file and insert rows that make enum sampling observable.
 * @param path - the database file to create.
 */
function buildDatabase(path: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(FIXTURE_SQL)
    const users = database.prepare('INSERT INTO users (id, name, password, status, avatar) VALUES (?, ?, ?, ?, ?)')
    users.run(1, 'alice', 's3cret', 'active', blob())
    users.run(2, 'bob', 'hunter2', 'disabled', null)
    const orders = database.prepare('INSERT INTO orders (id, user_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)')
    orders.run(10, 1, 99.5, 'paid', '2024-01-01')
    orders.run(11, 2, 10, 'pending', null)
    const items = database.prepare('INSERT INTO order_items (order_id, line_no, sku, qty) VALUES (?, ?, ?, ?)')
    items.run(10, 1, 'sku-a', 2)
    items.run(10, 2, 'sku-b', 1)
    items.run(11, 1, 'sku-c', 3)
    const accounts = database.prepare('INSERT INTO accounts (id, email, tenant) VALUES (?, ?, ?)')
    accounts.run(1, 'a@example.com', 't1')
    accounts.run(2, 'b@example.com', 't2')
    const keys = database.prepare('INSERT INTO api_keys (id, token, secret, label) VALUES (?, ?, ?, ?)')
    keys.run(1, 'tok_live_1', 'sec_1', 'primary')
    keys.run(2, 'tok_live_2', 'sec_2', 'backup')
    const people = database.prepare('INSERT INTO people (id, name) VALUES (?, ?)')
    people.run(1, '张三')
    people.run(2, '李四')
    database.prepare('INSERT INTO wide_300 (c001, c002) VALUES (?, ?)').run('alpha', 7)
  } finally {
    database.close()
  }
}

let directory: string
let databasePath: string
let dialect: ManagedDialect
let input: DialectInput
let l1: RawCatalog
let l2: RawCatalog

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'dbgraph-catalog-sqlite-'))
  databasePath = join(directory, 'fixture.db')
  buildDatabase(databasePath)
  dialect = createSqliteDialect({ DatabaseSync })
  input = {
    connection: { id: 'sqlite-fixture', engine: 'sqlite', database: databasePath },
    enumSampleLimit: 10,
    queryTimeoutMs: 5_000,
  }
  l1 = await dialect.fetchL1(input)
  l2 = await dialect.fetchL2(input, l1)
})

afterAll(async () => {
  await dialect.close()
  rmSync(directory, { recursive: true, force: true })
})

/**
 * A differently configured connection over the same fixture file.
 * @param overrides - connection fields to replace.
 * @returns the dialect input.
 */
function inputWith(overrides: Partial<ConnectionConfig>): DialectInput {
  return { ...input, connection: { ...input.connection, ...overrides } }
}

/**
 * Locate one object in a catalog.
 * @param catalog - the catalog to search.
 * @param name - the object name.
 * @returns the object.
 */
function objectNamed(catalog: RawCatalog, name: string): RawObject {
  const found = catalog.objects.find(object => object.name === name)
  if (found === undefined) throw new Error(`catalog has no object named "${name}"`)
  return found
}

/**
 * Locate one column of an object.
 * @param object - the object to search.
 * @param name - the column name.
 * @returns the column.
 */
function columnNamed(object: RawObject, name: string): RawColumn {
  const found = object.columns.find(column => column.name === name)
  if (found === undefined) throw new Error(`object "${object.name}" has no column named "${name}"`)
  return found
}

describe('sqlite fetchL1', () => {
  it('reports the snapshot it is', () => {
    expect(l1.engine).toBe('sqlite')
    expect(l1.level).toBe('l1')
    expect(l1.database).toBe(databasePath)
    expect(l1.fetchedAt).toBeGreaterThan(0)
    expect(l1.serverVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('lists user tables and views, sorted, without SQLite bookkeeping tables', () => {
    // Prove the exclusion is real rather than vacuous: AUTOINCREMENT creates sqlite_sequence.
    const probe = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const internal = probe.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").all()
      expect(internal).toHaveLength(1)
    } finally {
      probe.close()
    }

    expect(l1.objects.map(object => object.name)).toEqual([
      'accounts',
      'api_keys',
      'order_items',
      'orders',
      'people',
      'users',
      'v_user_names',
      'wide_300',
    ])
    expect(objectNamed(l1, 'users').kind).toBe('table')
    expect(objectNamed(l1, 'v_user_names').kind).toBe('view')
    expect(l1.objects.map(object => object.name)).not.toContain('sqlite_sequence')
  })

  it('reads declared columns in declaration order', () => {
    const users = objectNamed(l1, 'users')
    expect(users.columns.map(column => column.name)).toEqual([
      'id',
      'name',
      'password',
      'status',
      'created_at',
      'avatar',
    ])
    expect(users.columns.map(column => column.ordinal)).toEqual([1, 2, 3, 4, 5, 6])
    expect(columnNamed(users, 'name')).toMatchObject({ type: 'TEXT', nullable: false })
    expect(columnNamed(users, 'avatar').type).toBe('BLOB')
    expect(columnNamed(users, 'created_at').defaultValue).toBe('CURRENT_TIMESTAMP')
    expect('defaultValue' in columnNamed(users, 'status')).toBe(false)
    expect(columnNamed(users, 'id').isPrimaryKey).toBe(true)
    expect(columnNamed(users, 'name').isPrimaryKey).toBe(false)
  })

  it('marks every column of a composite primary key', () => {
    const items = objectNamed(l1, 'order_items')
    expect(columnNamed(items, 'order_id').isPrimaryKey).toBe(true)
    expect(columnNamed(items, 'line_no').isPrimaryKey).toBe(true)
    expect(columnNamed(items, 'sku').isPrimaryKey).toBe(false)
  })

  it('keeps a view\'s output columns', () => {
    const view = objectNamed(l1, 'v_user_names')
    expect(view.columns.map(column => column.name)).toEqual(['id', 'name'])
  })

  it('reads all 300 columns of the wide table', () => {
    const wide = objectNamed(l1, 'wide_300')
    expect(wide.columns).toHaveLength(WIDE_COLUMN_COUNT)
    expect(wide.columns[0]?.name).toBe('c001')
    expect(wide.columns[WIDE_COLUMN_COUNT - 1]?.name).toBe('c300')
    expect(wide.columns[WIDE_COLUMN_COUNT - 1]?.ordinal).toBe(WIDE_COLUMN_COUNT)
    expect(columnNamed(wide, 'c001').type).toBe('TEXT')
    expect(columnNamed(wide, 'c002').type).toBe('INTEGER')
  })

  it('never invents a comment and does no enrichment yet', () => {
    for (const object of l1.objects) {
      expect('comment' in object).toBe(false)
      expect(object.edges).toBeUndefined()
      for (const column of object.columns) {
        expect('comment' in column).toBe(false)
        expect('enumValues' in column).toBe(false)
      }
    }
  })
})

describe('sqlite fetchL2', () => {
  it('is an L2 snapshot of the same objects', () => {
    expect(l2.engine).toBe('sqlite')
    expect(l2.level).toBe('l2')
    expect(l2.database).toBe(databasePath)
    expect(l2.objects.map(object => object.name)).toEqual(l1.objects.map(object => object.name))
    expect(l2.warnings).toBeUndefined()
  })

  it('does not mutate the L1 catalog it started from', () => {
    expect(l1.level).toBe('l1')
    expect(objectNamed(l1, 'orders').edges).toBeUndefined()
    expect(columnNamed(objectNamed(l1, 'users'), 'status')).not.toHaveProperty('enumValues')
    expect(columnNamed(objectNamed(l1, 'accounts'), 'email')).not.toHaveProperty('isUnique')
  })

  it('records a foreign key as one edge with both sides', () => {
    const orders = objectNamed(l2, 'orders')
    const foreignKeys = (orders.edges ?? []).filter(edge => edge.kind === 'fk')
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]).toMatchObject({
      kind: 'fk',
      columns: ['user_id'],
      refObject: 'users',
      refColumns: ['id'],
    })
  })

  it('records a composite primary key index as a unique multi-column edge', () => {
    const items = objectNamed(l2, 'order_items')
    const indexes = (items.edges ?? []).filter(edge => edge.kind === 'index')
    expect(indexes).toHaveLength(1)
    expect(indexes[0]).toMatchObject({
      kind: 'index',
      name: 'sqlite_autoindex_order_items_1',
      columns: ['order_id', 'line_no'],
      unique: true,
    })
  })

  it('records plain and unique indexes', () => {
    const orders = objectNamed(l2, 'orders')
    const ordersIndex = (orders.edges ?? []).find(edge => edge.kind === 'index')
    expect(ordersIndex).toMatchObject({ name: 'idx_orders_user', columns: ['user_id'], unique: false })

    const accountsIndexes = (objectNamed(l2, 'accounts').edges ?? []).filter(edge => edge.kind === 'index')
    expect(accountsIndexes.map(edge => edge.name).sort()).toEqual(['uq_accounts_email', 'uq_accounts_tenant_email'])
  })

  it('marks a column unique only when a single-column unique index or primary key covers it', () => {
    const accounts = objectNamed(l2, 'accounts')
    expect(columnNamed(accounts, 'email').isUnique).toBe(true)
    // The composite unique index does not make either column unique on its own.
    expect(columnNamed(accounts, 'tenant').isUnique).toBe(false)
    expect(columnNamed(accounts, 'id').isUnique).toBe(true)

    // A single-column primary key is a unique constraint even without an index of its own.
    expect(columnNamed(objectNamed(l2, 'users'), 'id').isUnique).toBe(true)

    // Neither column of a composite primary key is unique on its own.
    const items = objectNamed(l2, 'order_items')
    expect(columnNamed(items, 'order_id').isUnique).toBe(false)
    expect(columnNamed(items, 'line_no').isUnique).toBe(false)
  })

  it('samples enum values for text columns only', () => {
    const users = objectNamed(l2, 'users')
    expect(new Set(columnNamed(users, 'status').enumValues)).toEqual(new Set(['active', 'disabled']))
    expect(columnNamed(users, 'id')).not.toHaveProperty('enumValues')
    expect(columnNamed(objectNamed(l2, 'orders'), 'amount')).not.toHaveProperty('enumValues')
    expect(columnNamed(objectNamed(l2, 'orders'), 'status').enumValues).toEqual(
      expect.arrayContaining(['paid', 'pending']),
    )
    // Chinese literals survive the round trip into the catalog, not just the result path.
    expect(new Set(columnNamed(objectNamed(l2, 'people'), 'name').enumValues)).toEqual(
      new Set(['张三', '李四']),
    )
  })

  it('never samples a sensitive column, whatever its type', () => {
    const keys = objectNamed(l2, 'api_keys')
    expect(columnNamed(keys, 'token')).not.toHaveProperty('enumValues')
    expect(columnNamed(keys, 'secret')).not.toHaveProperty('enumValues')
    expect(columnNamed(keys, 'label').enumValues).toEqual(expect.arrayContaining(['primary', 'backup']))
    expect(columnNamed(objectNamed(l2, 'users'), 'password')).not.toHaveProperty('enumValues')
  })

  it('respects enumSampleLimit', async () => {
    const limited = await dialect.fetchL2({ ...input, enumSampleLimit: 1 }, l1)
    const status = columnNamed(objectNamed(limited, 'users'), 'status')
    expect(status.enumValues).toHaveLength(1)
  })

  it('samples a view\'s rows for nothing and leaves its edges empty', () => {
    const view = objectNamed(l2, 'v_user_names')
    expect(view.edges).toBeUndefined()
    expect(columnNamed(view, 'name')).not.toHaveProperty('enumValues')
  })

  it('leaves an unpopulated text column without enum values', () => {
    expect(columnNamed(objectNamed(l2, 'wide_300'), 'c001').enumValues).toEqual(['alpha'])
    expect(columnNamed(objectNamed(l2, 'wide_300'), 'c003')).not.toHaveProperty('enumValues')
  })

  it('still has no comments anywhere', () => {
    for (const object of l2.objects) {
      expect('comment' in object).toBe(false)
      for (const column of object.columns) {
        expect('comment' in column).toBe(false)
      }
    }
  })

  it('records a warning for an object that vanished and keeps enriching the rest', async () => {
    const ghost: RawObject = {
      kind: 'table',
      name: 'ghost_table',
      columns: [{ name: 'ghost_col', ordinal: 1, type: 'TEXT' }],
    }
    const enriched = await dialect.fetchL2(input, { ...l1, objects: [...l1.objects, ghost] })

    expect(enriched.level).toBe('l2')
    expect(enriched.warnings?.some(warning => warning.includes('ghost_table'))).toBe(true)
    const ghostAfter = enriched.objects.find(object => object.name === 'ghost_table')
    expect(ghostAfter?.columns.map(column => column.name)).toEqual(['ghost_col'])
    expect(ghostAfter?.columns[0]?.isUnique).toBe(false)
    expect((objectNamed(enriched, 'orders').edges ?? []).length).toBeGreaterThan(0)
  })
})

describe('sqlite execute', () => {
  it('returns columns, JSON-safe rows and a row count', async () => {
    const result = await dialect.execute(input, 'SELECT id, name FROM users ORDER BY id', READ_ONLY_LIMITS)
    expect(result.columns).toEqual(['id', 'name'])
    expect(result.rows).toEqual([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ])
    expect(result.rowCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.redacted).toEqual([])
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('masks a sensitive column and names it in redacted', async () => {
    const result = await dialect.execute(input, 'SELECT id, password FROM users ORDER BY id', READ_ONLY_LIMITS)
    expect(result.redacted).toEqual(['password'])
    expect(result.rows.map(row => row['password'])).toEqual([REDACTED_VALUE, REDACTED_VALUE])
  })

  it('shows sensitive values when the connection opts out', async () => {
    const result = await dialect.execute(
      inputWith({ sensitiveColumns: 'show' }),
      'SELECT password FROM users ORDER BY id',
      READ_ONLY_LIMITS,
    )
    expect(result.redacted).toEqual([])
    expect(result.rows.map(row => row['password'])).toEqual(['s3cret', 'hunter2'])
  })

  it('masks configured extra patterns', async () => {
    const result = await dialect.execute(
      inputWith({ sensitivePatterns: ['name'] }),
      'SELECT name FROM users ORDER BY id',
      READ_ONLY_LIMITS,
    )
    expect(result.redacted).toEqual(['name'])
    expect(result.rows[0]?.['name']).toBe(REDACTED_VALUE)
  })

  it('renders a binary value as a bounded hex marker', async () => {
    const result = await dialect.execute(input, 'SELECT avatar FROM users WHERE id = 1', READ_ONLY_LIMITS)
    const avatar = result.rows[0]?.['avatar']
    expect(typeof avatar).toBe('string')
    expect(avatar).toMatch(/^0x0001020304/)
    expect(avatar).toContain('…')
    expect(avatar).toContain('(40 bytes)')
  })

  it('truncates at maxRows and says so', async () => {
    const result = await dialect.execute(
      input,
      'SELECT id FROM users ORDER BY id',
      { ...READ_ONLY_LIMITS, maxRows: 1 },
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rowCount).toBe(1)
    expect(result.truncated).toBe(true)
  })

  it('does not call an exactly-fitting result truncated', async () => {
    const result = await dialect.execute(
      input,
      'SELECT id FROM users ORDER BY id',
      { ...READ_ONLY_LIMITS, maxRows: 2 },
    )
    expect(result.rowCount).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('keeps column names even when no row matches', async () => {
    const result = await dialect.execute(input, 'SELECT id, name FROM users WHERE 0', READ_ONLY_LIMITS)
    expect(result.columns).toEqual(['id', 'name'])
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('refuses a write before it reaches the engine', async () => {
    try {
      await dialect.execute(input, "INSERT INTO users (name) VALUES ('mallory')", READ_ONLY_LIMITS)
      expect.unreachable('the write should have been refused')
    } catch (error) {
      expect(error).toBeInstanceOf(DbgraphError)
      expect((error as DbgraphError).code).toBe(DBGRAPH_READ_ONLY_CODE)
    }
    const count = await dialect.execute(input, 'SELECT COUNT(*) AS total FROM users', READ_ONLY_LIMITS)
    expect(count.rows[0]?.['total']).toBe(2)
  })

  it('writes through a read-write handle when the caller allows it', async () => {
    // The bug this pins: the handle was always opened read-only, so `allowWrites` reached the engine
    // and failed there. A writable call must actually write, and switching back to read-only must
    // close the writable handle first (the fingerprint carries the mode), not open a second one.
    const inserted = await dialect.execute(
      input,
      "INSERT INTO people (id, name) VALUES (3, 'mallory')",
      { ...READ_ONLY_LIMITS, readOnly: false },
    )
    expect(inserted.affectedRows).toBe(1)
    expect(inserted.warnings).toEqual([SQLITE_TIMEOUT_WARNING])

    const after = await dialect.execute(input, 'SELECT COUNT(*) AS total FROM people', READ_ONLY_LIMITS)
    expect(after.rows[0]?.['total']).toBe(3)

    // The read-only mode is back in force: a write is refused by the keyword gate, before the engine.
    await expect(dialect.execute(
      input,
      "INSERT INTO people (id, name) VALUES (4, 'eve')",
      READ_ONLY_LIMITS,
    )).rejects.toMatchObject({ code: DBGRAPH_READ_ONLY_CODE })

    // And a writable call after a read-only one still reaches the writable handle, so it is not a
    // one-way switch.
    const deleted = await dialect.execute(
      input,
      "DELETE FROM people WHERE name = 'mallory'",
      { ...READ_ONLY_LIMITS, readOnly: false },
    )
    expect(deleted.affectedRows).toBe(1)
    const restored = await dialect.execute(input, 'SELECT COUNT(*) AS total FROM people', READ_ONLY_LIMITS)
    expect(restored.rows[0]?.['total']).toBe(2)
  })

  it('accepts a read behind leading comments', async () => {
    const result = await dialect.execute(
      input,
      '-- explain the point\n/* and again */ SELECT 1 AS one',
      READ_ONLY_LIMITS,
    )
    expect(result.rows).toEqual([{ one: 1 }])
  })

  it('never runs a second statement smuggled behind a read', async () => {
    // node:sqlite compiles only the first statement; the point of this test is that a trailing
    // destructive statement is neither executed nor allowed to change what came back.
    const result = await dialect.execute(input, 'SELECT 1 AS one; DELETE FROM users', READ_ONLY_LIMITS)
    expect(result.rows).toEqual([{ one: 1 }])
    const count = await dialect.execute(input, 'SELECT COUNT(*) AS total FROM users', READ_ONLY_LIMITS)
    expect(count.rows[0]?.['total']).toBe(2)
  })

  it('reports a bad statement as a query failure', async () => {
    try {
      await dialect.execute(input, 'SELECT * FROM no_such_table', READ_ONLY_LIMITS)
      expect.unreachable('the statement should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(DbgraphError)
      expect((error as DbgraphError).code).toBe(DBGRAPH_QUERY_FAILED_CODE)
    }
  })
})

describe('sqlite execute parameter binding', () => {
  it('binds a positional parameter and returns the matching row', async () => {
    const result = await dialect.execute(
      input,
      'SELECT id, name FROM people WHERE name = ?',
      READ_ONLY_LIMITS,
      ['张三'],
    )
    expect(result.columns).toEqual(['id', 'name'])
    expect(result.rows).toEqual([{ id: 1, name: '张三' }])
    expect(result.rowCount).toBe(1)
  })

  it('matches nothing when the same statement is executed without parameters', async () => {
    // The bug this suite was written for: an unbound `?` binds as NULL, so `name = ?` becomes
    // `name = NULL` and quietly matches zero rows instead of failing loudly.
    const result = await dialect.execute(input, 'SELECT id, name FROM people WHERE name = ?', READ_ONLY_LIMITS)
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(0)
  })

  it('binds in positional order, not by guessing from the values', async () => {
    const ordered = await dialect.execute(
      input,
      'SELECT id, name FROM people WHERE name = ? AND id = ?',
      READ_ONLY_LIMITS,
      ['张三', 1],
    )
    expect(ordered.rows).toEqual([{ id: 1, name: '张三' }])

    const swapped = await dialect.execute(
      input,
      'SELECT id, name FROM people WHERE name = ? AND id = ?',
      READ_ONLY_LIMITS,
      [1, '张三'],
    )
    expect(swapped.rows).toEqual([])
  })

  it('binds several placeholders including non-text scalars', async () => {
    const result = await dialect.execute(input, 'SELECT ? AS word, ? AS n', READ_ONLY_LIMITS, ['x', 7])
    expect(result.rows).toEqual([{ word: 'x', n: 7 }])
  })

  it('normalizes booleans and dates into SQLite values', async () => {
    const result = await dialect.execute(
      input,
      'SELECT ? AS flag, ? AS stamp',
      READ_ONLY_LIMITS,
      [true, new Date('2024-01-02T03:04:05.000Z')],
    )
    expect(result.rows).toEqual([{ flag: 1, stamp: '2024-01-02T03:04:05.000Z' }])
  })

  it('refuses a value SQLite cannot represent instead of silently binding something else', async () => {
    try {
      await dialect.execute(input, 'SELECT ? AS value', READ_ONLY_LIMITS, [{ nested: true }])
      expect.unreachable('the value should have been refused')
    } catch (error) {
      expect(error).toBeInstanceOf(DbgraphError)
      expect((error as DbgraphError).code).toBe(DBGRAPH_QUERY_FAILED_CODE)
    }
  })

  it('keeps masking and the row cap when parameters are used', async () => {
    const masked = await dialect.execute(
      input,
      'SELECT name, password FROM users WHERE status = ?',
      { ...READ_ONLY_LIMITS, maxRows: 1 },
      ['active'],
    )
    expect(masked.redacted).toEqual(['password'])
    expect(masked.rows).toEqual([{ name: 'alice', password: REDACTED_VALUE }])
    expect(masked.truncated).toBe(false)
  })

  it('still refuses a write that carries parameters', async () => {
    try {
      await dialect.execute(input, 'DELETE FROM people WHERE id = ?', READ_ONLY_LIMITS, [1])
      expect.unreachable('the write should have been refused')
    } catch (error) {
      expect((error as DbgraphError).code).toBe(DBGRAPH_READ_ONLY_CODE)
    }
  })
})

describe('sqlite test', () => {
  it('reports a working database with its version', async () => {
    const probe = await dialect.test(input)
    expect(probe.ok).toBe(true)
    expect(probe.serverVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

describe('sqlite configuration and abort handling', () => {
  it('refuses a connection with no file path', async () => {
    await expect(dialect.fetchL1({
      connection: { id: 'no-path', engine: 'sqlite' },
      enumSampleLimit: 10,
      queryTimeoutMs: 1_000,
    })).rejects.toMatchObject({ code: 'DBGRAPH_UNAVAILABLE' })
  })

  it('fails a missing file instead of creating one', async () => {
    const missing = join(directory, 'nested', 'missing.db')
    await expect(dialect.fetchL1({
      connection: { id: 'missing-file', engine: 'sqlite', database: missing },
      enumSampleLimit: 10,
      queryTimeoutMs: 1_000,
    })).rejects.toMatchObject({ code: 'DBGRAPH_UNAVAILABLE' })
    expect(existsSync(missing)).toBe(false)
  })

  it('turns a missing database into a failed probe rather than a throw', async () => {
    const probe = await dialect.test({
      connection: { id: 'missing-file', engine: 'sqlite', database: join(directory, 'gone.db') },
      enumSampleLimit: 10,
      queryTimeoutMs: 1_000,
    })
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/cannot open SQLite database/)
  })

  it('honours an abort signal before opening anything', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(dialect.fetchL1({ ...input, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'DBGRAPH_ABORTED' })
  })
})

describe('sqlite timeout capability', () => {
  it('reports that timeoutMs was not enforced', async () => {
    // node:sqlite has no statement interrupt, so the seam's timeout is accepted and ignored. A result
    // that never said so read exactly like a query that finished inside its budget.
    const result = await dialect.execute(input, 'SELECT 1 AS one', READ_ONLY_LIMITS)
    expect(result.warnings).toEqual([SQLITE_TIMEOUT_WARNING])
  })
})
