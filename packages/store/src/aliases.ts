/**
 * Alias-table matching, shared by the writer (which expands a column's name and comment into sibling
 * words) and the resolver (which expands a user's word back into the columns it could mean).
 *
 * The table itself lives in `dsh-plugin-dbgraph-service` (`ZH_ALIASES`) and crosses into the native
 * writer as JSON, so this module only ever *applies* a caller-supplied table — it never owns a copy of
 * the vocabulary.
 * @module dsh-plugin-dbgraph-store/aliases
 */

import { tokenizeForSearch } from 'dsh-plugin-dbgraph-service'
import type { AliasGroup } from 'dsh-plugin-dbgraph-service'
import { hasCjk, isAsciiToken, normalizeIdentifier } from './normalize.ts'

/**
 * Whether one alias word occurs in a text.
 *
 * Three shapes, because one rule cannot fit all three:
 * - a single ASCII token matches an exact token (`user` in `sys_user`), never a substring — otherwise
 *   `order` would match `border_id`;
 * - a CJK word matches as a substring (`用户` in `系统用户`) because Chinese has no separators;
 * - a multi-token ASCII word (`real_name`) matches its folded form, which keeps `real_name` and
 *   `realname` interchangeable.
 * @param word - one word from an alias group.
 * @param text - the name or comment being tested.
 * @param tokens - `tokenizeForSearch(text)`, already computed by the caller.
 * @param folded - `normalizeIdentifier(text)`, already computed by the caller.
 * @returns true when the word is present.
 */
function wordOccursIn(word: string, text: string, tokens: ReadonlySet<string>, folded: string): boolean {
  const normalizedWord = word.normalize('NFKC').toLowerCase().trim()
  if (normalizedWord === '') return false
  const wordTokens = tokenizeForSearch(normalizedWord)
  if (wordTokens.length === 0) return false
  if (hasCjk(normalizedWord)) return normalizedWord !== '' && text.toLowerCase().includes(normalizedWord)
  if (wordTokens.length === 1 && isAsciiToken(wordTokens[0] as string)) return tokens.has(wordTokens[0] as string)
  return folded.includes(normalizeIdentifier(normalizedWord))
}

/**
 * The alias groups whose vocabulary appears in a text.
 * @param parts - name and comment, in any order; undefined and empty entries are ignored.
 * @param aliases - the alias table.
 * @returns matched groups, in table order; empty when the text names nothing from the table.
 */
export function aliasGroupsIn(
  parts: readonly (string | undefined)[],
  aliases: readonly AliasGroup[],
): readonly AliasGroup[] {
  const text = parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
  if (text === '') return []
  const tokens = new Set(tokenizeForSearch(text))
  const folded = normalizeIdentifier(text)
  const matched: AliasGroup[] = []
  for (const group of aliases) {
    if (group.words.some(word => wordOccursIn(word, text, tokens, folded))) matched.push(group)
  }
  return matched
}

/**
 * The tokens a group contributes once it matched: every sibling word plus the canonical meaning.
 * Tokens — not raw words — because the index stores the tokenizer's output, and a word the tokenizer
 * would split (`real_name`) has to be looked up by its parts.
 * @param group - the matched alias group.
 * @returns deduplicated tokens, in first-seen order.
 */
export function aliasGroupTokens(group: AliasGroup): readonly string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const word of [...group.words, group.meaning]) {
    for (const token of tokenizeForSearch(word)) {
      if (seen.has(token)) continue
      seen.add(token)
      tokens.push(token)
    }
  }
  return tokens
}

/**
 * Whether a user's word is one of a group's words (exact, case-insensitive, separator-insensitive).
 * The resolver uses this to decide which groups a free-text entity mentions.
 * @param word - the user's word.
 * @param group - the candidate group.
 * @returns true when the word names the group.
 */
export function wordNamesGroup(word: string, group: AliasGroup): boolean {
  const folded = normalizeIdentifier(word)
  if (folded === '') return false
  return group.words.some(candidate => normalizeIdentifier(candidate) === folded)
}
