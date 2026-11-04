import { describe, expect, it } from 'vitest'
import { DbgraphError } from 'dsh-plugin-dbgraph-service'
import type { ConnectionConfig, ExecuteLimits } from 'dsh-plugin-dbgraph-service'
import {
  asFiniteNumber,
  asString,
  assertReadOnlyStatement,
  clampRowLimit,
  DBGRAPH_READ_ONLY_CODE,
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
    expect(asFiniteNumber('   ')).toBeUndefined()
    expect(asFiniteNumber('abc')).toBeUndefined()
    expect(asFiniteNumber(Number.NaN)).toBeUndefined()
  })
})
