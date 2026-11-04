/**
 * The semantic layer of the index: `terms` rows and the FTS `search` documents.
 *
 * Two lookups answer the same question from opposite directions:
 *
 * - `terms` is the resolver's table — one row per (word, object[, column]) with a weight that says how
 *   strong the evidence is: a column's name token beats its comment, an alias expansion beats neither,
 *   a Chinese bigram beats nothing at all, it is partial evidence by construction.
 * - `search` is the FTS5 document — the tokenizer's output for an object's name and comment (one row)
 *   and for each column's name and comment (one row per column), used for free-text listing and as a
 *   recall net behind the resolver.
 *
 * Weights live in one exported table so the resolver's expectations and the writer's output cannot
 * drift apart silently.
 * @module dsh-plugin-dbgraph-store/terms
 */

import { searchDocument, tokenizeForSearch } from 'dsh-plugin-dbgraph-service'
import type { AliasGroup, RawCatalog } from 'dsh-plugin-dbgraph-service'
import { aliasGroupTokens, aliasGroupsIn } from './aliases.ts'
import { isAsciiToken, normalizeComment } from './normalize.ts'

/**
 * Evidence weight per token source. A column-level row is finally weighed again by the resolver
 * (a column hit is weaker evidence about the *table* than the table's own name), so these numbers are
 * "how much does this word describe the name it was found in", not final confidence.
 */
export const TERM_WEIGHTS = {
  /** A token of the object's own name. */
  objectNameAscii: 1,
  /** A CJK bigram of the object's name — partial by nature. */
  objectNameCjk: 0.75,
  /** An ASCII token of the object's comment. */
  objectCommentAscii: 0.75,
  /** A CJK bigram of the object's comment. */
  objectCommentCjk: 0.5,
  /** An alias-group expansion on an object's name or comment. */
  objectAlias: 0.6,
  /** An ASCII token of the column's own name. */
  columnNameAscii: 0.9,
  /** A CJK bigram of the column's name. */
  columnNameCjk: 0.75,
  /** An ASCII token of the column's comment. */
  columnCommentAscii: 0.7,
  /** A CJK bigram of the column's comment. */
  columnCommentCjk: 0.5,
  /** An alias-group expansion on a column's name or comment. */
  columnAlias: 0.65,
} as const

/** Object ids assigned in catalog order, and per-object column ids assigned in a global sequence. */
export interface CatalogIds {
  /** One one-based SQLite rowid per object, in catalog order. */
  readonly objects: readonly number[]
  /** Per object (same order), the one-based ids of its columns. */
  readonly columns: readonly (readonly number[])[]
}

/**
 * Assign the ids the writer will use, so terms and rows cannot disagree about identity.
 * @param catalog - the snapshot being written.
 * @returns object ids by position and column ids by object/column position.
 */
export function assignCatalogIds(catalog: RawCatalog): CatalogIds {
  const objects: number[] = []
  const columns: number[][] = []
  let nextColumnId = 1
  for (let objectIndex = 0; objectIndex < catalog.objects.length; objectIndex += 1) {
    const object = catalog.objects[objectIndex]
    objects.push(objectIndex + 1)
    const ids: number[] = []
    for (let columnIndex = 0; columnIndex < (object?.columns.length ?? 0); columnIndex += 1) {
      ids.push(nextColumnId)
      nextColumnId += 1
    }
    columns.push(ids)
  }
  return { objects, columns }
}

/** One row of the `terms` table. */
export interface TermRow {
  /** The token, as the service tokenizer emits it. */
  readonly term: string
  /** Evidence strength 0..1; see {@link TERM_WEIGHTS}. */
  readonly weight: number
  /** Object this term describes, when it describes one. */
  readonly objectId: number | null
  /** Column this term describes, when it describes one. */
  readonly columnId: number | null
}

/** One row of the `search` table (FTS5). */
export interface SearchRow {
  /** Pre-tokenized document, space-joined. */
  readonly text: string
  /** Object identity for an object document; null for a column document. */
  readonly objectId: number | null
  /** Column identity for a column document; null for an object document. */
  readonly columnId: number | null
}

/** Everything the semantic layer produces for one write. */
export interface TermBuild {
  /** Deduplicated `terms` rows. */
  readonly terms: readonly TermRow[]
  /** One object document per object, one column document per column. */
  readonly search: readonly SearchRow[]
}

/**
 * Pick the weight for one token given whether it is an ASCII identifier part or a CJK bigram.
 * @param token - the token.
 * @param ascii - weight for an ASCII token.
 * @param cjk - weight for a CJK token.
 * @returns the chosen weight.
 */
function weightFor(token: string, ascii: number, cjk: number): number {
  return isAsciiToken(token) ? ascii : cjk
}

/**
 * Build every `terms` row and both `search` documents for one catalog.
 * @param catalog - the snapshot being written.
 * @param ids - ids from {@link assignCatalogIds}.
 * @param aliases - the alias table handed in by the caller.
 * @returns deduplicated term rows and search documents.
 */
export function buildTerms(catalog: RawCatalog, ids: CatalogIds, aliases: readonly AliasGroup[]): TermBuild {
  const terms = new Map<string, TermRow>()
  const search: SearchRow[] = []

  const add = (term: string, weight: number, objectId: number, columnId: number | null): void => {
    if (term === '') return
    const key = `${term}\u0000${objectId}\u0000${columnId ?? ''}`
    const existing = terms.get(key)
    if (existing !== undefined && existing.weight >= weight) return
    terms.set(key, { term, weight, objectId, columnId })
  }

  const addTokens = (
    tokens: readonly string[],
    asciiWeight: number,
    cjkWeight: number,
    objectId: number,
    columnId: number | null,
  ): void => {
    for (const token of tokens) add(token, weightFor(token, asciiWeight, cjkWeight), objectId, columnId)
  }

  for (let objectIndex = 0; objectIndex < catalog.objects.length; objectIndex += 1) {
    const object = catalog.objects[objectIndex]
    const objectId = ids.objects[objectIndex]
    if (object === undefined || objectId === undefined) continue
    const comment = normalizeComment(object.comment)

    addTokens(tokenizeForSearch(object.name), TERM_WEIGHTS.objectNameAscii, TERM_WEIGHTS.objectNameCjk, objectId, null)
    if (comment !== undefined) {
      addTokens(
        tokenizeForSearch(comment),
        TERM_WEIGHTS.objectCommentAscii,
        TERM_WEIGHTS.objectCommentCjk,
        objectId,
        null,
      )
    }
    for (const group of aliasGroupsIn([object.name, comment], aliases)) {
      for (const token of aliasGroupTokens(group)) {
        add(token, TERM_WEIGHTS.objectAlias, objectId, null)
      }
    }
    search.push({
      text: searchDocument([object.name, comment]),
      objectId,
      columnId: null,
    })

    const columnIds = ids.columns[objectIndex] ?? []
    for (let columnIndex = 0; columnIndex < object.columns.length; columnIndex += 1) {
      const column = object.columns[columnIndex]
      const columnId = columnIds[columnIndex]
      if (column === undefined || columnId === undefined) continue
      const columnComment = normalizeComment(column.comment)
      addTokens(
        tokenizeForSearch(column.name),
        TERM_WEIGHTS.columnNameAscii,
        TERM_WEIGHTS.columnNameCjk,
        objectId,
        columnId,
      )
      if (columnComment !== undefined) {
        addTokens(
          tokenizeForSearch(columnComment),
          TERM_WEIGHTS.columnCommentAscii,
          TERM_WEIGHTS.columnCommentCjk,
          objectId,
          columnId,
        )
      }
      for (const group of aliasGroupsIn([column.name, columnComment], aliases)) {
        for (const token of aliasGroupTokens(group)) {
          add(token, TERM_WEIGHTS.columnAlias, objectId, columnId)
        }
      }
      search.push({
        text: searchDocument([column.name, columnComment]),
        objectId: null,
        columnId,
      })
    }
  }

  return { terms: [...terms.values()], search }
}
