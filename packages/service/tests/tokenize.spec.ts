import { describe, expect, it } from 'vitest'
import { searchDocument, searchMatchQuery, tokenizeForSearch } from '../src/index.ts'

/**
 * The tokenizer is a cross-language contract: the Rust writer reimplements these rules, and
 * `packages/store/tests/tokenize-parity.spec.ts` compares the two implementations token for token.
 * Every case here is therefore a case the native side must reproduce exactly — not a nice-to-have.
 */
describe('tokenizeForSearch', () => {
  it('splits camel case at the lower-to-upper boundary', () => {
    expect(tokenizeForSearch('createdAt')).toEqual(['created', 'at'])
    expect(tokenizeForSearch('orderId')).toEqual(['order', 'id'])
    expect(tokenizeForSearch('userIdList')).toEqual(['user', 'id', 'list'])
  })

  it('splits an acronym run before its last capital', () => {
    expect(tokenizeForSearch('HTMLParser')).toEqual(['html', 'parser'])
    expect(tokenizeForSearch('XMLHttpRequest')).toEqual(['xml', 'http', 'request'])
  })

  it('splits on digits and separators', () => {
    expect(tokenizeForSearch('password_hash')).toEqual(['password', 'hash'])
    expect(tokenizeForSearch('v2')).toEqual(['v', '2'])
    expect(tokenizeForSearch('order-item.code')).toEqual(['order', 'item', 'code'])
  })

  it('lowercases and normalizes width', () => {
    expect(tokenizeForSearch('PASSWORD')).toEqual(['password'])
    expect(tokenizeForSearch('ＡＢＣ')).toEqual(['abc'])
  })

  it('expands a Chinese run into overlapping bigrams', () => {
    expect(tokenizeForSearch('广告点击')).toEqual(['广告', '告点', '点击'])
    expect(tokenizeForSearch('用户密码')).toEqual(['用户', '户密', '密码'])
    expect(tokenizeForSearch('张三')).toEqual(['张三'])
  })

  it('keeps a single Chinese character as its own token', () => {
    expect(tokenizeForSearch('码')).toEqual(['码'])
  })

  it('keeps scripts apart instead of joining them', () => {
    expect(tokenizeForSearch('user用户')).toEqual(['user', '用户'])
  })

  it('deduplicates and preserves first-seen order', () => {
    expect(tokenizeForSearch('user user_name user')).toEqual(['user', 'name'])
  })

  it('returns nothing for input with no usable token', () => {
    expect(tokenizeForSearch('')).toEqual([])
    expect(tokenizeForSearch('   --- ...  ')).toEqual([])
  })
})

describe('searchDocument', () => {
  it('folds a name and a comment into one token stream', () => {
    expect(searchDocument(['sys_user', '系统 用户 密码'])).toBe('sys user 系统 用户 密码')
  })

  it('skips absent and empty parts', () => {
    expect(searchDocument(['order', undefined, '', 'order'])).toBe('order')
  })

  it('produces an empty string when nothing is indexable', () => {
    expect(searchDocument([undefined, ''])).toBe('')
  })
})

describe('searchMatchQuery', () => {
  it('quotes tokens and joins them with OR', () => {
    expect(searchMatchQuery(['密码', '姓名'])).toBe('"密码" OR "姓名"')
  })

  it('quotes a token that would otherwise be FTS5 syntax', () => {
    expect(searchMatchQuery(['or'])).toBe('"or"')
  })

  it('deduplicates across words', () => {
    expect(searchMatchQuery(['password', 'passwd', 'password'])).toBe('"password" OR "passwd"')
  })

  it('caps the expression at the token ceiling', () => {
    const words = Array.from({ length: 40 }, (_, index) => `w${String(index)}`)
    expect(searchMatchQuery(words, 3).split(' OR ')).toHaveLength(3)
  })

  it('returns an empty expression when no word holds a token', () => {
    expect(searchMatchQuery(['', '   ', '---'])).toBe('')
  })
})
