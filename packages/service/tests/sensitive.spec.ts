/**
 * Sensitive-column matching: every word the alias table treats as a password must be masked, and a
 * short ambiguous word must not redact an unrelated column.
 */

import { describe, expect, it } from 'vitest'
import {
  SENSITIVE_CJK_WORDS,
  SENSITIVE_COLUMN_PATTERNS,
  SENSITIVE_COLUMN_TOKENS,
  ZH_ALIASES,
  isSensitiveColumn,
} from '../src/index.ts'

const passwordWords = ZH_ALIASES.find(group => group.meaning === 'password')?.words ?? []

describe('sensitive column matching', () => {
  it('masks every word the password alias group treats as a password', () => {
    expect(passwordWords.length).toBeGreaterThan(0)
    for (const word of passwordWords) expect(isSensitiveColumn(word), word).toBe(true)
  })

  it('masks the spellings the resolver actually picks for those words', () => {
    for (const name of [
      'user_pass',
      'pass_hash',
      'user_passwd',
      'PassCode',
      'passphrase',
      'user_password',
      'pwd_hash',
      'id_card',
      'bank_card',
      '密码',
      '登录密码',
      '口令',
      '密钥',
    ]) {
      expect(isSensitiveColumn(name), name).toBe(true)
    }
  })

  it('does not redact unrelated words that merely contain "pass"', () => {
    for (const name of ['passenger', 'bypass', 'compass', 'passage']) {
      expect(isSensitiveColumn(name), name).toBe(false)
    }
  })

  it('masks secret only as a whole token, plural included', () => {
    // The miss this pins: `secret` as a substring redacted `secretary`, but the fix must not lose
    // the spellings that are genuinely a secret. Both directions are asserted here.
    for (const name of ['secret', 'secrets', 'client_secret', 'client_secrets', 'clientSecret']) {
      expect(isSensitiveColumn(name), name).toBe(true)
    }
    for (const name of ['secretary', 'secretaries', 'secretary_id']) {
      expect(isSensitiveColumn(name), name).toBe(false)
    }
  })

  it('masks api_key / apikey and the userpass spelling', () => {
    for (const name of ['api_key', 'apikey', 'apiKey', 'api_keys', 'userpass', 'user_pass']) {
      expect(isSensitiveColumn(name), name).toBe(true)
    }
    for (const name of ['api_keeper', 'apikeepers_canary']) {
      expect(isSensitiveColumn(name), name).toBe(false)
    }
  })

  it('keeps honouring configured extra patterns', () => {
    expect(isSensitiveColumn('session_key', ['session'])).toBe(true)
    expect(isSensitiveColumn('session_key')).toBe(false)
  })

  it('exposes the vocabulary it matched', () => {
    for (const word of SENSITIVE_CJK_WORDS) expect(isSensitiveColumn(`user_${word}`), word).toBe(true)
    for (const token of SENSITIVE_COLUMN_TOKENS) expect(isSensitiveColumn(token), token).toBe(true)
    expect(SENSITIVE_COLUMN_PATTERNS).toContain('password')
    expect(SENSITIVE_COLUMN_PATTERNS).toContain('apikey')
    // `secret` must live in the token table: as a substring it redacts `secretary`.
    expect(SENSITIVE_COLUMN_PATTERNS).not.toContain('secret')
    expect(SENSITIVE_COLUMN_TOKENS).toEqual(expect.arrayContaining(['pass', 'secret', 'userpass']))
  })
})
