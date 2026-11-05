/**
 * The one tokenizer both index writers and the resolver must agree on.
 *
 * FTS5's `unicode61` tokenizer splits on non-alphanumerics, which means a run of Chinese becomes a
 * **single** token: store `广告点击` verbatim and `MATCH '广告'` returns nothing (verified on SQLite
 * 3.50.4). So the indexed text is not the raw name and comment — it is the token stream this module
 * produces, and the query side is the same function's output joined with `OR`.
 *
 * Two rules, deliberately few:
 *
 * - **ASCII identifiers** split on every change of character class, so `createdAt` → `created`, `at`
 *   and `password_hash` → `password`, `hash`; everything is lowercased.
 * - **CJK runs** split into overlapping bigrams (`广告点击` → `广告`, `告点`, `点击`). A run of one
 *   character is its own token.
 *
 * The native writer reimplements these two rules in Rust. `packages/store/tests/tokenize-parity.spec.ts`
 * is what keeps the two implementations honest: it asserts token-for-token equality on a fixture
 * corpus, so a change here that is not mirrored there fails the build rather than silently degrading
 * recall.
 * @module dsh-plugin-dbgraph-service/tokenize
 */

/** CJK ideographs and kana — the scripts whose tokens need bigram expansion. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** The character classes an ASCII identifier is split on. */
type CharClass = 'lower' | 'upper' | 'digit' | 'cjk' | 'other'

/**
 * Classify one character.
 * @param ch - the character.
 * @returns its class.
 */
function classOf(ch: string): CharClass {
  if (CJK.test(ch)) return 'cjk'
  if (ch >= 'a' && ch <= 'z') return 'lower'
  if (ch >= 'A' && ch <= 'Z') return 'upper'
  if (ch >= '0' && ch <= '9') return 'digit'
  return 'other'
}

/**
 * Split one identifier-ish run into its ASCII parts, at camel-case and letter/digit boundaries.
 *
 * The boundary needs one character of lookahead, which is why this walks indices instead of folding
 * over characters: `createdAt` splits before `A` (a lower-case letter precedes an upper-case one),
 * while `HTMLParser` splits before `P` (an upper-case run is followed by a lower-case letter). A
 * class-change-per-character rule gets the first one wrong, emitting `created` `a` `t`.
 * @param word - the run to split.
 * @returns lowercase parts, in order.
 */
function splitIdentifier(word: string): string[] {
  const chars = [...word]
  const parts: string[] = []
  let current = ''
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index] as string
    const previous = index === 0 ? '' : (chars[index - 1] as string)
    const next = index + 1 < chars.length ? (chars[index + 1] as string) : ''
    if (current !== '' && isBoundary(previous, ch, next)) {
      parts.push(current)
      current = ''
    }
    current += ch
  }
  // The only caller flushes a run it has already proven non-empty, so `current` is never empty here;
  // the guard exists so `splitIdentifier('')` cannot emit an empty part.
  /* v8 ignore next */
  if (current !== '') parts.push(current)
  return parts.map(part => part.toLowerCase())
}

/**
 * Whether a new part starts at `ch`.
 * @param previous - the character before `ch`, or `''` at the start of the run.
 * @param ch - the character being placed.
 * @param next - the character after `ch`, or `''` at the end of the run.
 * @returns true when `ch` begins a new part.
 */
function isBoundary(previous: string, ch: string, next: string): boolean {
  const chClass = classOf(ch)
  // `previous` is never empty at a real call: `current !== ''` short-circuits index 0, so a run is
  // always flushed with a character behind the one being placed. The alternative stays for the
  // helper's documented contract, not for a path any input can take.
  const previousClass = classOf(previous === '' ? /* v8 ignore next */ ' ' : previous)
  if (chClass !== previousClass) {
    if (chClass === 'digit') return true
    if (chClass === 'upper') return previousClass === 'lower' || previousClass === 'digit'
    // A lower-case letter after an upper-case run does not start a part by itself — the part already
    // started at the upper-case letter that precedes it (see the acronym rule below).
    if (chClass === 'lower' && previousClass === 'upper') return false
    return true
  }
  // Acronym boundary: inside a run of capitals, the last capital before a lower-case letter starts a
  // new part, so `HTMLParser` → `HTML` + `Parser` rather than one run.
  if (chClass === 'upper' && next !== '' && classOf(next) === 'lower') return true
  return false
}

/**
 * Expand a CJK run into overlapping bigrams. A single-character run is its own token.
 * @param run - the run, one or more CJK characters.
 * @returns bigrams, in order.
 */
function cjkBigrams(run: string): string[] {
  const chars = [...run]
  if (chars.length === 1) return chars
  const out: string[] = []
  for (let index = 0; index + 1 < chars.length; index += 1) {
    out.push(`${chars[index]}${chars[index + 1]}`)
  }
  return out
}

/**
 * The token stream indexed for one text field, and the vocabulary a query is built from.
 * @param input - a name, a comment, or a user's words.
 * @returns deduplicated tokens in first-seen order; empty when the input holds no usable token.
 */
export function tokenizeForSearch(input: string): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  const push = (token: string): void => {
    if (token === '' || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }

  const normalized = input.normalize('NFKC')
  let ascii = ''
  let cjk = ''

  const flushAscii = (): void => {
    if (ascii === '') return
    for (const part of splitIdentifier(ascii)) push(part)
    ascii = ''
  }
  const flushCjk = (): void => {
    if (cjk === '') return
    for (const bigram of cjkBigrams(cjk)) push(bigram)
    cjk = ''
  }

  for (const ch of normalized) {
    const cls = classOf(ch)
    if (cls === 'cjk') {
      flushAscii()
      cjk += ch
      continue
    }
    flushCjk()
    if (cls === 'other') {
      flushAscii()
      continue
    }
    ascii += ch
  }
  flushAscii()
  flushCjk()

  return tokens
}

/**
 * Build the `MATCH` expression for a set of user words.
 *
 * Each token is quoted, because a bare token that happens to be an FTS5 keyword (`or`, `not`, `near`)
 * is a syntax error. Tokens join with `OR`, not a space: in FTS5 a space means "same phrase, in
 * order", which is far stricter than "any of these words".
 * @param words - the user's words, already tokenized or not.
 * @param maxTokens - ceiling on terms in one expression (default 32).
 * @returns an FTS5 `MATCH` expression, or an empty string when the words hold no usable token.
 */
export function searchMatchQuery(words: readonly string[], maxTokens = 32): string {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const word of words) {
    for (const token of tokenizeForSearch(word)) {
      if (seen.has(token)) continue
      seen.add(token)
      tokens.push(token)
      if (tokens.length >= maxTokens) {
        return tokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ')
      }
    }
  }
  return tokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * The indexable text for one object or column: its name and its comment, tokenized and joined.
 * @param parts - the fields to fold in, in the order they should contribute tokens.
 * @returns a space-joined token stream, ready for the `search.text` column.
 */
export function searchDocument(parts: readonly (string | undefined)[]): string {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (part === undefined || part === '') continue
    for (const token of tokenizeForSearch(part)) {
      if (seen.has(token)) continue
      seen.add(token)
      tokens.push(token)
    }
  }
  return tokens.join(' ')
}
