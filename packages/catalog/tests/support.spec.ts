import { describe, expect, it } from 'vitest'
import { DbgraphError } from 'dsh-plugin-dbgraph-service'
import type { ConnectionConfig, ExecuteLimits } from 'dsh-plugin-dbgraph-service'
import {
  asFiniteNumber,
  asString,
  assertReadOnlyStatement,
  clampRowLimit,
  DBGRAPH_READ_ONLY_CODE,
  describeWriteChannel,
  firstStatementKeyword,
  isReadStatement,
  isSensitiveName,
  MAX_BINARY_PREVIEW_BYTES,
  messageOf,
  normalizeRows,
  REDACTED_VALUE,
  renderBinary,
  toJsonSafe,
} from '../src/support.ts'

const READ_ONLY: ExecuteLimits = { maxRows: 10, timeoutMs: 1_000, readOnly: true }
const WRITABLE: ExecuteLimits = { maxRows: 10, timeoutMs: 1_000, readOnly: false }

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id: 'prod', engine: 'mysql', ...overrides }
}

function binary(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 256)
}

describe('firstStatementKeyword', () => {
  it('reads the first word, case-insensitively', () => {
    expect(firstStatementKeyword('select 1')).toBe('SELECT')
    expect(firstStatementKeyword('  \n\t SeLeCt 1')).toBe('SELECT')
    expect(firstStatementKeyword('SHOW TABLES')).toBe('SHOW')
  })

  it('skips line and block comments', () => {
    expect(firstStatementKeyword('-- a comment\nSELECT 1')).toBe('SELECT')
    expect(firstStatementKeyword('/* block */ UPDATE t SET a = 1')).toBe('UPDATE')
    expect(firstStatementKeyword('-- one\n/* two */ -- three\n DESCRIBE t')).toBe('DESCRIBE')
  })

  it('reports an empty or unterminated statement as undefined', () => {
    expect(firstStatementKeyword('')).toBeUndefined()
    expect(firstStatementKeyword('  \n ')).toBeUndefined()
    expect(firstStatementKeyword('-- only a comment')).toBeUndefined()
    expect(firstStatementKeyword('/* unterminated')).toBeUndefined()
    expect(firstStatementKeyword('  1 + 1')).toBeUndefined()
  })
})

describe('isReadStatement', () => {
  it('admits exactly the four read keywords', () => {
    for (const keyword of ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN']) {
      expect(isReadStatement(`${keyword} x`)).toBe(true)
    }
    for (const keyword of ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'PRAGMA', 'WITH']) {
      expect(isReadStatement(`${keyword} x`)).toBe(false)
    }
    expect(isReadStatement('')).toBe(false)
  })

  it('only looks at the first keyword: a disguised write is still "a read" to this predicate', () => {
    // `sqlite.ts` uses this predicate to choose between run() and iterate(), so it must keep its
    // narrow meaning; the write-channel refusal lives in `assertReadOnlyStatement`, not here.
    expect(isReadStatement('EXPLAIN ANALYZE UPDATE t SET a = 1')).toBe(true)
    expect(isReadStatement("SELECT 1 INTO OUTFILE '/tmp/x'")).toBe(true)
  })
})

describe('describeWriteChannel', () => {
  it('reports nothing for a statement that cannot write', () => {
    expect(describeWriteChannel('SELECT 1')).toBeUndefined()
    expect(describeWriteChannel('  -- comment\nSHOW TABLES')).toBeUndefined()
    expect(describeWriteChannel('EXPLAIN SELECT * FROM users')).toBeUndefined()
    expect(describeWriteChannel('-- c\nEXPLAIN /* x */ SELECT 1')).toBeUndefined()
    expect(describeWriteChannel('')).toBeUndefined()
  })

  it('names EXPLAIN of anything but a SELECT, because EXPLAIN ANALYZE executes it', () => {
    expect(describeWriteChannel('EXPLAIN ANALYZE UPDATE t SET a = 1')).toContain('EXPLAIN ANALYZE')
    expect(describeWriteChannel('explain analyze delete from t')).toContain('EXPLAIN ANALYZE')
    expect(describeWriteChannel('EXPLAIN QUERY PLAN SELECT 1')).toContain('EXPLAIN QUERY')
    expect(describeWriteChannel('EXPLAIN')).toContain('EXPLAIN')
  })

  it('names INTO OUTFILE / INTO DUMPFILE anywhere in the statement', () => {
    expect(describeWriteChannel("SELECT * FROM t INTO OUTFILE '/tmp/leak.txt'")).toContain('INTO OUTFILE')
    expect(describeWriteChannel("select * from t into dumpfile '/tmp/x'")).toContain('INTO DUMPFILE')
    expect(describeWriteChannel("SELECT id\nFROM t\nINTO/**/OUTFILE '/tmp/x'")).toContain('INTO OUTFILE')
  })

  it('strips comments first, so a channel cannot be hidden behind one', () => {
    expect(describeWriteChannel('SELECT /* into outfile */ 1')).toBeUndefined()
    expect(describeWriteChannel('SELECT 1 -- into outfile')).toBeUndefined()
    expect(describeWriteChannel("SELECT -- note\n * FROM t INTO OUTFILE '/x'")).toContain('INTO OUTFILE')
  })

  it('keeps quoted text, so a phrase in a literal errs toward refusing', () => {
    expect(describeWriteChannel("SELECT 'INTO OUTFILE' AS label")).toContain('INTO OUTFILE')
    // A `--` inside a literal is not a comment: it must not swallow the real clause that follows.
    expect(describeWriteChannel("SELECT '--' INTO OUTFILE '/tmp/x'")).toContain('INTO OUTFILE')
  })

  it('respects both spellings of an escaped quote inside a literal', () => {
    // MySQL doubles a quote inside a string AND accepts a backslash escape; either must keep the
    // scan inside the literal, so a `--` after it is not mistaken for a comment.
    expect(describeWriteChannel("SELECT 'it''s' AS label")).toBeUndefined()
    expect(describeWriteChannel("SELECT 'a\\'b' AS label")).toBeUndefined()
    expect(describeWriteChannel("SELECT 'it''s -- harmless' AS label")).toBeUndefined()
  })

  it('does not treat a backslash inside a backtick identifier as an escape', () => {
    // MySQL only recognizes the backslash escape in string literals, not in quoted identifiers.
    expect(describeWriteChannel('SELECT `a\\b` FROM t')).toBeUndefined()
    expect(describeWriteChannel('SELECT `a\\` -- not a comment')).toBeUndefined()
  })

  it('treats an unterminated quote as running to the end of the statement', () => {
    expect(describeWriteChannel("SELECT 'unterminated")).toBeUndefined()
  })

  it('stops scanning at an unterminated block comment', () => {
    expect(describeWriteChannel('SELECT 1 /* unterminated')).toBeUndefined()
  })
})

describe('assertReadOnlyStatement', () => {
  it('admits an obvious read under a read-only execution', () => {
    expect(() => assertReadOnlyStatement('SELECT 1', READ_ONLY)).not.toThrow()
    expect(() => assertReadOnlyStatement('-- c\nSHOW TABLES', READ_ONLY)).not.toThrow()
  })

  it('refuses a non-read under a read-only execution', () => {
    try {
      assertReadOnlyStatement('INSERT INTO users (name) VALUES (?)', READ_ONLY)
      expect.unreachable('the statement should have been refused')
    } catch (error) {
      expect(error).toBeInstanceOf(DbgraphError)
      expect((error as DbgraphError).code).toBe(DBGRAPH_READ_ONLY_CODE)
      expect((error as DbgraphError).message).toContain('INSERT')
    }
  })

  it('refuses an empty statement under a read-only execution', () => {
    expect(() => assertReadOnlyStatement('   -- nothing', READ_ONLY)).toThrow(/empty or comment-only/)
  })

  it('does not gate anything when the caller allowed writes', () => {
    expect(() => assertReadOnlyStatement('UPDATE t SET a = 1', WRITABLE)).not.toThrow()
    expect(() => assertReadOnlyStatement('EXPLAIN ANALYZE UPDATE t SET a = 1', WRITABLE)).not.toThrow()
    expect(() => assertReadOnlyStatement("SELECT 1 INTO OUTFILE '/tmp/x'", WRITABLE)).not.toThrow()
  })
})

describe('assertReadOnlyStatement — write channels behind a read keyword', () => {
  /**
   * Run one refused statement and report its code plus message.
   * @param query - the statement to refuse.
   * @returns the thrown error's code and message.
   */
  function refusal(query: string): { code: string; message: string } {
    try {
      assertReadOnlyStatement(query, READ_ONLY)
    } catch (error) {
      expect(error).toBeInstanceOf(DbgraphError)
      const dbgraph = error as DbgraphError
      return { code: dbgraph.code, message: dbgraph.message }
    }
    expect.unreachable(`the statement should have been refused: ${query}`)
  }

  it('refuses EXPLAIN ANALYZE and says it executes the statement', () => {
    const refused = refusal('EXPLAIN ANALYZE UPDATE users SET password = NULL')
    expect(refused.code).toBe(DBGRAPH_READ_ONLY_CODE)
    expect(refused.message).toContain('EXPLAIN ANALYZE')
    expect(refused.message).toContain('executes')
  })

  it('refuses SELECT ... INTO OUTFILE and SELECT ... INTO DUMPFILE', () => {
    for (const query of [
      "SELECT * FROM users INTO OUTFILE '/tmp/users.txt'",
      "SELECT * FROM users INTO DUMPFILE '/tmp/users.bin'",
    ]) {
      const refused = refusal(query)
      expect(refused.code).toBe(DBGRAPH_READ_ONLY_CODE)
      expect(refused.message).toContain('writes a file on the server')
    }
  })

  it('still admits EXPLAIN of a SELECT', () => {
    expect(() => assertReadOnlyStatement('EXPLAIN SELECT * FROM users', READ_ONLY)).not.toThrow()
  })

  it('keeps refusing keywords that are never reads', () => {
    expect(refusal('PRAGMA table_info(users)').message).toContain('PRAGMA')
    expect(refusal("ATTACH DATABASE '/tmp/evil.db' AS evil").message).toContain('ATTACH')
  })

  it('admits a read with a second statement behind it: the engine compiles only the first', () => {
    // node:sqlite ignores everything after the first statement, and mysql2 refuses it without
    // multipleStatements. The gate deliberately does not try to parse the tail.
    expect(() => assertReadOnlyStatement('SELECT 1; DROP TABLE users', READ_ONLY)).not.toThrow()
  })
})

describe('clampRowLimit', () => {
  it('floors, and corrects values no query could use', () => {
    expect(clampRowLimit(5)).toBe(5)
    expect(clampRowLimit(2.9)).toBe(2)
    expect(clampRowLimit(0)).toBe(0)
    expect(clampRowLimit(-3)).toBe(0)
    expect(clampRowLimit(Number.NaN)).toBe(0)
    expect(clampRowLimit(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('messageOf', () => {
  it('describes every thrown shape', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain')).toBe('plain')
    expect(messageOf({ code: 7 })).toBe('{"code":7}')
    expect(messageOf(undefined)).toBe('undefined')
  })
})

describe('renderBinary', () => {
  it('renders the whole value when it fits the preview', () => {
    expect(renderBinary(new Uint8Array([0, 1, 2]))).toBe('0x000102 (3 bytes)')
    expect(renderBinary(binary(MAX_BINARY_PREVIEW_BYTES))).not.toContain('…')
  })

  it('abbreviates past the preview budget and always reports the true length', () => {
    const rendered = renderBinary(binary(MAX_BINARY_PREVIEW_BYTES + 1))
    expect(rendered.startsWith('0x')).toBe(true)
    expect(rendered).toContain('…')
    expect(rendered.endsWith(`(${MAX_BINARY_PREVIEW_BYTES + 1} bytes)`)).toBe(true)
  })
})

describe('toJsonSafe', () => {
  it('converts driver-only values into JSON-safe ones', () => {
    expect(toJsonSafe(null)).toBeNull()
    expect(toJsonSafe(undefined)).toBeNull()
    expect(toJsonSafe('text')).toBe('text')
    expect(toJsonSafe(true)).toBe(true)
    expect(toJsonSafe(42)).toBe(42)
    expect(toJsonSafe(Number.NaN)).toBe('NaN')
    expect(toJsonSafe(Number.NEGATIVE_INFINITY)).toBe('-Infinity')
    expect(toJsonSafe(9_007_199_254_740_993n)).toBe('9007199254740993')
  })

  it('renders dates as ISO text', () => {
    expect(toJsonSafe(new Date('2024-01-02T03:04:05.000Z'))).toBe('2024-01-02T03:04:05.000Z')
    expect(toJsonSafe(new Date(Number.NaN))).toBe('Invalid Date')
  })

  it('renders binary through the shared marker', () => {
    expect(toJsonSafe(new Uint8Array([255, 0]))).toBe('0xff00 (2 bytes)')
  })

  it('stringifies a value no JSON branch recognizes', () => {
    expect(toJsonSafe(Symbol('tag'))).toBe('Symbol(tag)')
  })

  it('recurses into arrays and plain objects', () => {
    expect(toJsonSafe({
      list: [1, undefined, new Date(0)],
      nested: { flag: false },
    })).toEqual({
      list: [1, null, '1970-01-01T00:00:00.000Z'],
      nested: { flag: false },
    })
  })
})

describe('normalizeRows', () => {
  it('masks sensitive columns by default and converts the rest', () => {
    const normalized = normalizeRows(
      ['id', 'password', 'created_at'],
      [{ id: 1, password: 's3cret', created_at: new Date(0) }],
      connection(),
    )
    expect(normalized.redacted).toEqual(['password'])
    expect(normalized.rows).toEqual([
      { id: 1, password: REDACTED_VALUE, created_at: '1970-01-01T00:00:00.000Z' },
    ])
  })

  it('does not mask when the connection says show', () => {
    const normalized = normalizeRows(
      ['id', 'password'],
      [{ id: 1, password: 's3cret' }],
      connection({ sensitiveColumns: 'show' }),
    )
    expect(normalized.redacted).toEqual([])
    expect(normalized.rows[0]?.['password']).toBe('s3cret')
  })

  it('masks configured extra patterns too', () => {
    const normalized = normalizeRows(
      ['id', 'customer_uid'],
      [{ id: 1, customer_uid: 'u-1' }],
      connection({ sensitivePatterns: ['customer_uid'] }),
    )
    expect(normalized.redacted).toEqual(['customer_uid'])
    expect(normalized.rows[0]?.['customer_uid']).toBe(REDACTED_VALUE)
  })

  it('reports a missing value as null rather than a hole', () => {
    const normalized = normalizeRows(['id'], [{}], connection({ sensitiveColumns: 'show' }))
    expect(normalized.rows[0]).toEqual({ id: null })
  })
})

describe('isSensitiveName', () => {
  it('matches the built-in and configured patterns without regard to separators', () => {
    expect(isSensitiveName(connection(), 'password')).toBe(true)
    expect(isSensitiveName(connection(), 'user_passwd_hash')).toBe(true)
    expect(isSensitiveName(connection(), 'apiToken')).toBe(true)
    expect(isSensitiveName(connection(), 'display_name')).toBe(false)
    expect(isSensitiveName(connection({ sensitivePatterns: ['display'] }), 'display_name')).toBe(true)
  })
})

describe('asString / asFiniteNumber', () => {
  it('narrows driver values without inventing them', () => {
    expect(asString('x')).toBe('x')
    expect(asString(undefined)).toBeUndefined()
    expect(asString(7)).toBeUndefined()
    expect(asFiniteNumber(7)).toBe(7)
    expect(asFiniteNumber('7')).toBe(7)
    expect(asFiniteNumber(7n)).toBe(7)
    // A bigint too large for a finite double converts to Infinity, which is not a usable count.
    expect(asFiniteNumber(2n ** 1024n)).toBeUndefined()
    expect(asFiniteNumber('   ')).toBeUndefined()
    expect(asFiniteNumber('abc')).toBeUndefined()
    expect(asFiniteNumber(Number.NaN)).toBeUndefined()
  })
})
