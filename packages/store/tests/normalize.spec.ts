/**
 * The shared normalizations: declared-type classification, comment hygiene, identifier folding, and
 * the bounded edit distance. These are pure functions with a large decision table, so the table is
 * pinned rule by rule rather than through whichever query happens to exercise it.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_COMMENT_LENGTH,
  hasCjk,
  isAsciiToken,
  levenshteinWithin,
  normalizeComment,
  normalizeIdentifier,
  typeClassOf,
} from '../src/normalize.ts'

describe('typeClassOf', () => {
  it('answers unknown for an empty or decoration-only declaration', () => {
    expect(typeClassOf('')).toBe('unknown')
    expect(typeClassOf('   ')).toBe('unknown')
    // Nothing is left once the storage modifiers are stripped.
    expect(typeClassOf('unsigned')).toBe('unknown')
  })

  it('classifies booleans, including MySQL tinyint(1)', () => {
    expect(typeClassOf('tinyint(1)')).toBe('bool')
    expect(typeClassOf('BOOLEAN')).toBe('bool')
    expect(typeClassOf('bit(1)')).toBe('bool')
    // Once the display width is gone it is a plain integer again.
    expect(typeClassOf('tinyint(4)')).toBe('integer')
  })

  it('classifies integers across dialect spellings', () => {
    for (const declared of ['int', 'integer', 'bigint', 'smallint', 'mediumint', 'serial', 'rowid', 'INT UNSIGNED']) {
      expect(typeClassOf(declared), declared).toBe('integer')
    }
  })

  it('classifies decimals', () => {
    for (const declared of ['decimal(12,2)', 'numeric', 'number', 'money', 'float', 'double', 'real']) {
      expect(typeClassOf(declared), declared).toBe('decimal')
    }
  })

  it('classifies json', () => {
    expect(typeClassOf('json')).toBe('json')
    expect(typeClassOf('JSONB')).toBe('json')
  })

  it('classifies datetimes', () => {
    for (const declared of ['timestamp', 'timestamptz', 'datetime', 'date', 'time', 'year', 'interval']) {
      expect(typeClassOf(declared), declared).toBe('datetime')
    }
  })

  it('classifies binary payloads', () => {
    for (const declared of ['blob', 'binary(16)', 'varbinary(255)', 'bytea', 'image', 'raw', 'longblob']) {
      expect(typeClassOf(declared), declared).toBe('binary')
    }
  })

  it('classifies text and string families', () => {
    expect(typeClassOf('text')).toBe('text')
    expect(typeClassOf('mediumtext')).toBe('text')
    expect(typeClassOf('clob')).toBe('text')
    expect(typeClassOf('varchar(64)')).toBe('string')
    expect(typeClassOf('character varying(32)')).toBe('string')
    expect(typeClassOf('enum(\'a\',\'b\')')).toBe('string')
    expect(typeClassOf('uuid')).toBe('string')
    // A type whose name is the family itself.
    expect(typeClassOf('string')).toBe('string')
    expect(typeClassOf('symbol')).toBe('string')
    // Containment, not only a prefix: a dialect may qualify the name.
    expect(typeClassOf('national char(8)')).toBe('string')
    expect(typeClassOf('long varchar')).toBe('string')
  })

  it('answers unknown for a declaration it does not recognize', () => {
    expect(typeClassOf('geometry')).toBe('unknown')
    expect(typeClassOf('point(10,10)')).toBe('unknown')
  })
})

describe('normalizeComment', () => {
  it('keeps undefined undefined', () => {
    expect(normalizeComment(undefined)).toBeUndefined()
  })

  it('folds whitespace, control characters and compatibility forms', () => {
    expect(normalizeComment('  用户名\u0000\t登录\n名  ')).toBe('用户名 登录 名')
    expect(normalizeComment('ＡＢＣ')).toBe('ABC')
  })

  it('reports nothing usable for blank input', () => {
    expect(normalizeComment('   ')).toBeUndefined()
    expect(normalizeComment('\u0007')).toBeUndefined()
  })

  it('caps a long comment', () => {
    const long = 'x'.repeat(MAX_COMMENT_LENGTH + 500)
    const capped = normalizeComment(long)
    expect(capped).toHaveLength(MAX_COMMENT_LENGTH)
  })
})

describe('normalizeIdentifier', () => {
  it('folds case, compatibility forms and separators', () => {
    expect(normalizeIdentifier('USER_ID')).toBe('userid')
    expect(normalizeIdentifier('userId')).toBe('userid')
    expect(normalizeIdentifier('user-id')).toBe('userid')
    expect(normalizeIdentifier('ｕｓｅｒ')).toBe('user')
  })

  it('keeps non-Latin letters', () => {
    expect(normalizeIdentifier('Имя')).toBe('имя')
    expect(normalizeIdentifier('用户名')).toBe('用户名')
  })

  it('folds punctuation-only input to the empty string', () => {
    expect(normalizeIdentifier('---')).toBe('')
  })
})

describe('token predicates', () => {
  it('separates ASCII identifier parts from CJK bigrams', () => {
    expect(isAsciiToken('userid')).toBe(true)
    expect(isAsciiToken('用户名')).toBe(false)
    expect(isAsciiToken('User')).toBe(false)
  })

  it('detects CJK characters', () => {
    expect(hasCjk('系统用户')).toBe(true)
    expect(hasCjk('sys_user')).toBe(false)
    expect(hasCjk('ｼｽﾃﾑ')).toBe(false)
  })
})

describe('levenshteinWithin', () => {
  it('is zero for equal input', () => {
    expect(levenshteinWithin('password', 'password', 2)).toBe(0)
  })

  it('reports one substitution', () => {
    expect(levenshteinWithin('password', 'pasword', 2)).toBe(1)
  })

  it('abandons a pair whose lengths already differ by more than max', () => {
    expect(levenshteinWithin('abc', 'abcdef', 1)).toBe(2)
  })

  it('measures against an empty side within the bound', () => {
    expect(levenshteinWithin('', 'ab', 5)).toBe(2)
    expect(levenshteinWithin('ab', '', 5)).toBe(2)
  })

  it('abandons an empty side whose length exceeds max, before measuring it', () => {
    expect(levenshteinWithin('', 'abcdef', 2)).toBe(3)
    expect(levenshteinWithin('abcdef', '', 2)).toBe(3)
  })

  it('truncates identifiers longer than the fuzzy bound before comparing', () => {
    const long = 'x'.repeat(70)
    expect(levenshteinWithin(long, long, 0)).toBe(0)
    expect(levenshteinWithin('y'.repeat(64), `${'y'.repeat(63)}z`, 2)).toBe(1)
  })

  it('reports max + 1 when the distance ends over the bound', () => {
    expect(levenshteinWithin('abc', 'abd', 0)).toBe(1)
    expect(levenshteinWithin('kitten', 'sitting', 2)).toBe(3)
  })
})
