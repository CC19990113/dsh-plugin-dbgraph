/**
 * The small normalizations the writer and the resolver share: comment hygiene, identifier folding,
 * declared-type classification, and a bounded edit distance for the resolver's last-tier match.
 *
 * Tokenization is deliberately *not* here — the one tokenizer lives in
 * `dsh-plugin-dbgraph-service` (`tokenizeForSearch`) because the native writer reimplements it in
 * Rust and the two must agree token for token.
 * @module dsh-plugin-dbgraph-store/normalize
 */

/** The coarse type families the index stores in `columns.type_class`. */
export type TypeClass =
  | 'integer'
  | 'decimal'
  | 'string'
  | 'text'
  | 'bool'
  | 'datetime'
  | 'json'
  | 'binary'
  | 'unknown'

/** Longest comment the index keeps. A comment is a hint, not a document. */
export const MAX_COMMENT_LENGTH = 2000

/** Longest identifier a fuzzy match will compare. */
const MAX_FUZZY_LENGTH = 64

/** CJK ideographs and kana, the characters `normalizeIdentifier` keeps. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * Normalize a declared type onto a {@link TypeClass}. Order matters: `tinyint(1)` is MySQL's boolean
 * spelling and is classified before the integer rule sees it.
 * @param type - the declared type, verbatim from the server.
 * @returns the coarse family; `unknown` for an empty or unrecognized declaration.
 */
export function typeClassOf(type: string): TypeClass {
  const normalized = type.normalize('NFKC').toLowerCase().trim()
  if (normalized === '') return 'unknown'
  const base = normalized.replace(/\((?:[^)]*)\)/g, '').replace(/\bunsigned\b|\bzerofill\b/g, '').trim()
  if (base === '') return 'unknown'
  if (/^tinyint\(1\)/.test(normalized) || /\bbool(ean)?\b/.test(base) || /^bit\b/.test(base)) return 'bool'
  if (
    /^(big|small|medium|tiny)?int(eger)?\b/.test(base)
    || /^(u?int(2|4|8)|int[0-9]|serial|bigserial|smallserial)\b/.test(base)
    || /^rowid$/.test(base)
    || /\binteger\b/.test(base)
  ) {
    return 'integer'
  }
  if (
    /^(decimal|numeric|number|dec|fixed|money|smallmoney)\b/.test(base)
    || /^(float|double|real)\b/.test(base)
    || /^float[48]\b/.test(base)
    || /^double\b/.test(base)
  ) {
    return 'decimal'
  }
  if (/^(json|jsonb)\b/.test(base)) return 'json'
  if (/^(timestamp|timestamptz|datetime|date|time|timetz|year|interval)\b/.test(base)) return 'datetime'
  if (/^(blob|binary|varbinary|bytea|image|raw|bfile|long\s*blob|medium\s*blob|tiny\s*blob)\b/.test(base)) {
    return 'binary'
  }
  if (/^(tiny|medium|long)?text\b|^ntext\b|^clob\b|^nclob\b/.test(base)) return 'text'
  if (/^(n?char|character|varchar|nvarchar|varchar2|n?varchar2|enum|set|uuid|uniqueidentifier|citext)\b/.test(base)) {
    return 'string'
  }
  if (/^(string|name|symbol)\b/.test(base)) return 'string'
  if (/\bchar\b/.test(base) || /\bvarchar\b/.test(base)) return 'string'
  return 'unknown'
}

/**
 * Clean a comment for storage and indexing: NFKC, control characters collapsed to spaces, runs of
 * whitespace folded, trimmed, and capped at {@link MAX_COMMENT_LENGTH}.
 * @param comment - the comment the server reported, if any.
 * @returns the cleaned comment, or undefined when nothing usable remains.
 */
export function normalizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined
  const cleaned = comment
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return undefined
  return cleaned.length > MAX_COMMENT_LENGTH ? cleaned.slice(0, MAX_COMMENT_LENGTH) : cleaned
}

/**
 * Fold an identifier for exact and fuzzy comparison: NFKC, lower-case, and every separator removed, so
 * `user_id`, `userId` and `USER-ID` all become `userid`.
 * @param name - the identifier (or a user's word).
 * @returns the folded form; empty when the input holds no letter or digit.
 */
export function normalizeIdentifier(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    // Every Unicode letter and number survives, not just ASCII and CJK: folding a Cyrillic or
    // accented identifier to '' would make it unmatchable, and `find` would then answer "no such
    // column" about a column that exists. `\p{Alphabetic}\p{N}` is the set the Rust twin's
    // `char::is_alphanumeric` reports, so the two writers keep folding to the same form.
    .replace(/[^\p{Alphabetic}\p{N}]/gu, '')
}

/**
 * Whether a token the service tokenizer emitted is pure ASCII (an identifier part) rather than a CJK
 * bigram. The writer weights the two differently, because a bigram is partial evidence by nature.
 * @param token - one token from `tokenizeForSearch`.
 * @returns true for `[a-z0-9]+`.
 */
export function isAsciiToken(token: string): boolean {
  return /^[a-z0-9]+$/.test(token)
}

/**
 * Whether a string contains a CJK character.
 * @param text - the text to inspect.
 * @returns true when at least one CJK character is present.
 */
export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

/**
 * Levenshtein distance, abandoned as soon as it is known to exceed `max`.
 *
 * The resolver's fuzzy tier is bounded at two edits on short identifiers, so the full quadratic table
 * is never needed; the early exit also keeps a long column name from costing anything.
 * @param left - first string, already folded.
 * @param right - second string, already folded.
 * @param max - the largest distance worth reporting.
 * @returns the distance when it is at most `max`, else `max + 1`.
 */
export function levenshteinWithin(left: string, right: string, max: number): number {
  const a = left.length > MAX_FUZZY_LENGTH ? left.slice(0, MAX_FUZZY_LENGTH) : left
  const b = right.length > MAX_FUZZY_LENGTH ? right.slice(0, MAX_FUZZY_LENGTH) : right
  if (a === b) return 0
  // The length guard above already proves the answer for an empty side is within the bound.
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a === '') return b.length
  if (b === '') return a.length

  let previous = new Array<number>(b.length + 1)
  let current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let rowBest = i
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const deletion = (previous[j] as number) + 1
      const insertion = (current[j - 1] as number) + 1
      const value = Math.min(substitution, deletion, insertion)
      current[j] = value
      if (value < rowBest) rowBest = value
    }
    if (rowBest > max) return max + 1
    const swap = previous
    previous = current
    current = swap
  }
  const distance = previous[b.length] as number
  return distance <= max ? distance : max + 1
}
