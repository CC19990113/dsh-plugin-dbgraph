/**
 * Alias-table application: how one alias word is matched against a name or comment, which groups a
 * text names, and how a user's word is recognized as one of a group's words.
 *
 * The three matching shapes (exact ASCII token, CJK substring, folded multi-token word) exist because
 * one rule cannot serve `user` in `sys_user`, `用户` in `系统用户`, and `real_name` in `realname`.
 */

import { describe, expect, it } from 'vitest'
import type { AliasGroup } from 'dsh-plugin-dbgraph-service'
import { aliasGroupTokens, aliasGroupsIn, wordNamesGroup } from '../src/aliases.ts'

/** Chinese words matched as substrings, English ones as exact tokens. */
const USER: AliasGroup = { meaning: 'user', words: ['user', '用户', '登录账号'] }

describe('aliasGroupsIn', () => {
  it('matches an ASCII word only as a whole token', () => {
    expect(aliasGroupsIn(['sys_user'], [USER])).toEqual([USER])
    // `user` inside `superuser` is a different word; substring matching would answer the wrong table.
    expect(aliasGroupsIn(['user_group'], [USER])).toEqual([USER])
    expect(aliasGroupsIn(['superuser'], [USER])).toEqual([])
  })

  it('matches a CJK word as a substring', () => {
    expect(aliasGroupsIn(['系统用户'], [USER])).toEqual([USER])
    expect(aliasGroupsIn([undefined, '用户资料'], [USER])).toEqual([USER])
  })

  it('keeps groups in table order and ignores undefined parts', () => {
    const other: AliasGroup = { meaning: 'dept', words: ['dept', '部门'] }
    expect(aliasGroupsIn(['用户部门', undefined], [other, USER])).toEqual([other, USER])
  })

  it('returns nothing when every part is absent or empty', () => {
    expect(aliasGroupsIn([undefined, '', undefined], [USER])).toEqual([])
    expect(aliasGroupsIn([], [USER])).toEqual([])
  })

  it('ignores a group word that folds to nothing or tokenizes to nothing', () => {
    const unusable: AliasGroup = { meaning: 'nothing', words: ['   ', '!!!'] }
    expect(aliasGroupsIn(['sys_user'], [unusable])).toEqual([])
  })

  it('matches a multi-token word against its folded form', () => {
    const group: AliasGroup = { meaning: 'real name', words: ['real_name'] }
    // `realname` and `real_name` fold to the same identifier.
    expect(aliasGroupsIn(['realname'], [group])).toEqual([group])
    expect(aliasGroupsIn(['real_name'], [group])).toEqual([group])
    // Folded containment, not equality: `real` on its own is still a different word.
    expect(aliasGroupsIn(['real'], [group])).toEqual([])
  })
})

describe('aliasGroupTokens', () => {
  it('expands every word plus the meaning into deduplicated tokens', () => {
    const tokens = aliasGroupTokens({ meaning: 'password', words: ['密码', 'pwd'] })
    expect(tokens).toEqual(['密码', 'pwd', 'password'])
  })

  it('drops a token a second word repeats', () => {
    const tokens = aliasGroupTokens({ meaning: 'user', words: ['user', 'USER'] })
    expect(tokens).toEqual(['user'])
  })
})

describe('wordNamesGroup', () => {
  it('accepts the word in any casing or separator spelling', () => {
    expect(wordNamesGroup('用户', USER)).toBe(true)
    expect(wordNamesGroup('USER', USER)).toBe(true)
    expect(wordNamesGroup('登录-账号', USER)).toBe(true)
  })

  it('rejects a word the group does not list', () => {
    expect(wordNamesGroup('部门', USER)).toBe(false)
    expect(wordNamesGroup('superuser', USER)).toBe(false)
  })

  it('rejects a word that folds to nothing', () => {
    expect(wordNamesGroup('---', USER)).toBe(false)
  })
})
