/**
 * Offline semantic resolution: user words in, one table plus one parameterized `WHERE` out.
 *
 * The resolver is deliberately conservative in one direction and generous in the other: it accepts a
 * loose list of candidates (a wrong word in the alias table only costs one ranked alternative) but
 * refuses to answer when more than one table fits, when the best fit is below the confidence gate, or
 * when the request names no table, entity, or condition at all. The failure it must never produce is a
 * confident `SELECT *` over the wrong table.
 *
 * Scoring, in one sentence: a candidate's score is `0.85 × best evidence + 0.15 × concept coverage`,
 * where evidence is a term weight (a table's own name beats a comment, a column reached through an
 * alias is weighed again at 0.8 because it is weaker evidence about the *table*), and concepts are the
 * user's words after alias expansion. The two knobs a deployment may retune are the gate
 * (`minConfidence`, default 0.6) and the tie margin (`ambiguityGap`, default 0.15).
 * @module dsh-plugin-dbgraph-store/resolve
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  quoteIdentifier,
  searchMatchQuery,
  tokenizeForSearch,
} from 'dsh-plugin-dbgraph-service'
import type {
  AliasGroup,
  Engine,
  FindCandidate,
  FindRequest,
  MatchedColumn,
  MatchSource,
  PredicatePlan,
  Resolution,
} from 'dsh-plugin-dbgraph-service'
import { aliasGroupTokens, aliasGroupsIn } from './aliases.ts'
import { hasCjk, isAsciiToken, levenshteinWithin, normalizeIdentifier } from './normalize.ts'
import { displayName, ftsObjectIds, loadColumns, loadObjects, lookupObject } from './reader.ts'
import type { ColumnRecord, ObjectRecord } from './reader.ts'

/** How much a column hit counts as evidence about the table that owns it. */
export const COLUMN_EVIDENCE_FACTOR = 0.8

/** Weight of the single best evidence token in the score. */
export const BEST_WEIGHT_SHARE = 0.85

/** Weight of concept coverage in the score. */
export const COVERAGE_SHARE = 0.15

/** When only the FTS index recalls an object, its score starts here. */
export const FTS_FALLBACK_TOP = 0.62

/** Rank penalty per additional FTS-only candidate. */
export const FTS_FALLBACK_STEP = 0.02

/** Lowest score an FTS-only candidate is given. */
export const FTS_FALLBACK_FLOOR = 0.5

/** Largest number of distinct tokens one entity lookup will bind. */
const MAX_QUERY_TOKENS = 800

/** SQLite's usual variable bound is far above this, but chunking keeps the statement small. */
const TOKEN_CHUNK = 400

/** Columns shown in a "these are the available columns" explanation. */
const AVAILABLE_COLUMNS_SHOWN = 40

/** Columns summarised in a resolved reason. */
const REASON_COLUMNS_SHOWN = 8

/**
 * Shortest folded field a fuzzy match may act on.
 *
 * At four or five characters one substitution is another plausible column (`c0520`/`c0020`,
 * `flag`/`flat`), and answering with a column nobody asked for is the one failure the resolver must
 * not produce — a miss is recoverable, a silent substitution is not.
 */
const FUZZY_MIN_LENGTH = 6

/** How the resolver is tuned. */
export interface ResolveOptions {
  /** Alias table expanded into the query and used by the synonym tier. */
  readonly aliases: readonly AliasGroup[]
  /** Below this, the answer is `ambiguous` rather than `resolved`. Default 0.6. */
  readonly minConfidence: number
  /** A top-2 margin smaller than this is `ambiguous`. Default 0.15. */
  readonly ambiguityGap: number
  /** Candidates returned when resolution was not decisive. Default 5. */
  readonly maxCandidates: number
  /** Columns one object may expose to a match. Default 500. */
  readonly maxColumns: number
}

/** Default resolver tuning. */
export const DEFAULT_RESOLVE_OPTIONS: ResolveOptions = {
  aliases: [],
  minConfidence: 0.6,
  ambiguityGap: 0.15,
  maxCandidates: 5,
  maxColumns: 500,
}

/** One object with its score, before its row was read. */
interface ScoredObject {
  readonly objectId: number
  readonly score: number
}

/** One alias-expanded unit of the entity a user typed. */
interface Concept {
  readonly tokens: ReadonlySet<string>
}

/** One `terms` row with the owning object resolved. */
interface TermEvidence {
  readonly term: string
  readonly weight: number
  readonly objectId: number
  readonly columnId: number | null
}

/**
 * Round to the precision the resolver's margin comparisons assume.
 * @param value - a 0..1 score.
 * @returns the score to three decimals.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * The result when the request names nothing that could identify a table.
 * @returns the `missing_predicate` resolution.
 */
function missingPredicate(): Resolution {
  return {
    status: 'missing_predicate',
    reason: '缺少定位条件：没有 object（表名）、entity（业务实体）或 where（字段条件）。'
      + '不会生成全表查询；请补充其中一项。',
    confidence: 0,
  }
}

/**
 * Whether a user's word occurs in the entity text.
 * @param entity - the raw entity string.
 * @param foldedEntity - `normalizeIdentifier(entity)`.
 * @param entityTokens - `tokenizeForSearch(entity)` as a set.
 * @param word - one alias word.
 * @returns true when the entity mentions the word.
 */
function entityMentionsWord(
  entity: string,
  foldedEntity: string,
  entityTokens: ReadonlySet<string>,
  word: string,
): boolean {
  const normalizedWord = word.normalize('NFKC').toLowerCase().trim()
  if (normalizedWord === '') return false
  const wordTokens = tokenizeForSearch(normalizedWord)
  if (wordTokens.length === 0) return false
  if (hasCjk(normalizedWord)) return entity.normalize('NFKC').toLowerCase().includes(normalizedWord)
  if (wordTokens.length === 1 && isAsciiToken(wordTokens[0] as string)) {
    return entityTokens.has(wordTokens[0] as string)
  }
  return foldedEntity.includes(normalizeIdentifier(normalizedWord))
}

/**
 * Split an entity into its CJK runs, which is the only segmentation available without a dictionary.
 * @param text - the entity.
 * @returns contiguous CJK runs, in order.
 */
function cjkRuns(text: string): string[] {
  const runs: string[] = []
  let current = ''
  for (const character of text.normalize('NFKC')) {
    if (hasCjk(character)) {
      current += character
      continue
    }
    if (current !== '') {
      runs.push(current)
      current = ''
    }
  }
  if (current !== '') runs.push(current)
  return runs
}

/**
 * Turn the user's entity into the concepts the score is averaged over.
 *
 * A matched alias group is one concept (its whole vocabulary is the evidence), and the words the group
 * did not account for keep their own concepts, so `系统用户` is "user" plus whatever `系统` contributes.
 * @param entity - what the user typed.
 * @param aliases - the alias table.
 * @returns concepts, in a stable order.
 */
export function buildEntityConcepts(entity: string, aliases: readonly AliasGroup[]): Concept[] {
  const entityTokens = tokenizeForSearch(entity)
  const entityTokenSet = new Set(entityTokens)
  const foldedEntity = normalizeIdentifier(entity)
  const matchedGroups: AliasGroup[] = []
  for (const group of aliases) {
    if (group.words.some(word => entityMentionsWord(entity, foldedEntity, entityTokenSet, word))) {
      matchedGroups.push(group)
    }
  }

  const concepts: Concept[] = []
  const consumed = new Set<string>()
  for (const group of matchedGroups) {
    const tokens = new Set(aliasGroupTokens(group))
    concepts.push({ tokens })
    for (const token of tokens) {
      if (entityTokenSet.has(token)) consumed.add(token)
    }
  }

  for (const token of entityTokens) {
    if (isAsciiToken(token) && !consumed.has(token)) concepts.push({ tokens: new Set([token]) })
  }
  for (const run of cjkRuns(entity)) {
    const leftover = tokenizeForSearch(run).filter(token => !consumed.has(token))
    if (leftover.length > 0) concepts.push({ tokens: new Set(leftover) })
  }
  return concepts
}

/**
 * Load the `terms` rows behind a set of tokens, resolving a column row's object even when the writer
 * left `object_id` NULL.
 * @param db - the open index.
 * @param tokens - query tokens.
 * @returns evidence rows.
 */
function loadTermEvidence(db: DatabaseSync, tokens: readonly string[]): TermEvidence[] {
  const unique = [...new Set(tokens)].slice(0, MAX_QUERY_TOKENS)
  const evidence: TermEvidence[] = []
  for (let offset = 0; offset < unique.length; offset += TOKEN_CHUNK) {
    const chunk = unique.slice(offset, offset + TOKEN_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT t.term AS term, t.weight AS weight, t.object_id AS object_id, t.column_id AS column_id,
                COALESCE(t.object_id, c.object_id) AS resolved_object
         FROM terms t LEFT JOIN columns c ON c.id = t.column_id
         WHERE t.term IN (${placeholders})`,
      )
      .all(...chunk)
    for (const row of rows) {
      const term = typeof row.term === 'string' ? row.term : undefined
      const weight = typeof row.weight === 'number' ? row.weight : undefined
      const objectId = typeof row.resolved_object === 'number' ? row.resolved_object : undefined
      if (term === undefined || weight === undefined || objectId === undefined) continue
      evidence.push({
        term,
        weight,
        objectId,
        columnId: typeof row.column_id === 'number' ? row.column_id : null,
      })
    }
  }
  return evidence
}

/**
 * Score every object the entity's concepts touch.
 * @param db - the open index.
 * @param entity - what the user typed.
 * @param options - resolver tuning.
 * @returns scored objects, unsorted.
 */
function scoreByEntity(db: DatabaseSync, entity: string, options: ResolveOptions): ScoredObject[] {
  const concepts = buildEntityConcepts(entity, options.aliases)
  if (concepts.length === 0) return []
  const evidence = loadTermEvidence(db, concepts.flatMap(concept => [...concept.tokens]))
  const bestPerConcept = new Map<number, number[]>()
  for (const row of evidence) {
    const effective = row.columnId === null ? row.weight : row.weight * COLUMN_EVIDENCE_FACTOR
    let best = bestPerConcept.get(row.objectId)
    if (best === undefined) {
      best = new Array<number>(concepts.length).fill(0)
      bestPerConcept.set(row.objectId, best)
    }
    for (let index = 0; index < concepts.length; index += 1) {
      if ((concepts[index] as Concept).tokens.has(row.term) && effective > (best[index] as number)) {
        best[index] = effective
      }
    }
  }
  const scored: ScoredObject[] = []
  for (const [objectId, best] of bestPerConcept) {
    const strongest = Math.max(...best)
    if (strongest <= 0) continue
    const covered = best.filter(value => value > 0).length / concepts.length
    scored.push({ objectId, score: round3(BEST_WEIGHT_SHARE * strongest + COVERAGE_SHARE * covered) })
  }
  if (scored.length > 0) return scored

  // No term evidence at all: the FTS index is the recall net. Its candidates enter below the top of
  // the gate range, so a single hit can resolve and two near-equal hits stay ambiguous.
  const expression = searchMatchQuery([entity])
  if (expression === '') return []
  return ftsObjectIds(db, expression, 20).map((objectId, rank) => ({
    objectId,
    score: round3(Math.max(FTS_FALLBACK_FLOOR, FTS_FALLBACK_TOP - rank * FTS_FALLBACK_STEP)),
  }))
}

/**
 * The all-columns match list used when the request names no fields.
 * @param columns - the object's columns.
 * @returns one `name` match per column, in declared order.
 */
function allColumnsAsMatches(columns: readonly ColumnRecord[]): MatchedColumn[] {
  return columns.map(column => ({
    column: column.name,
    ...(column.comment === undefined ? {} : { comment: column.comment }),
    matchedBy: 'name',
    score: 1,
  }))
}

/**
 * Build one matched-column entry.
 * @param column - the column.
 * @param matchedBy - which rule chose it.
 * @param score - its 0..1 score.
 * @param term - the user's word, when one produced the hit.
 * @returns the entry.
 */
function columnMatch(
  column: ColumnRecord,
  matchedBy: MatchSource,
  score: number,
  term: string,
): MatchedColumn {
  return {
    column: column.name,
    ...(column.comment === undefined ? {} : { comment: column.comment }),
    matchedBy,
    term,
    score,
  }
}

/**
 * Whether a comment carries every token of a field.
 * @param comment - the column comment.
 * @param fieldTokens - the field's tokens.
 * @returns true when the comment contains them all.
 */
function commentHasTokens(comment: string | undefined, fieldTokens: readonly string[]): boolean {
  if (comment === undefined || fieldTokens.length === 0) return false
  const tokens = new Set(tokenizeForSearch(comment))
  return fieldTokens.every(token => tokens.has(token))
}

/**
 * Match one requested field to one column, trying the rules in the order the contract fixes.
 * @param columns - the object's columns.
 * @param field - the user's word.
 * @param aliases - the alias table.
 * @returns the match, or undefined when no tier fits.
 */
function matchField(
  columns: readonly ColumnRecord[],
  field: string,
  aliases: readonly AliasGroup[],
): MatchedColumn | undefined {
  const folded = normalizeIdentifier(field)
  const fieldTokens = tokenizeForSearch(field)
  if (folded === '') return undefined

  // 1. exact column name, separator-insensitive.
  const exact = columns.find(column => normalizeIdentifier(column.name) === folded)
  if (exact !== undefined) return columnMatch(exact, 'name', 1, field)

  // 2. a token of the column name (user_name ← "name").
  const namePart = columns.find(column => {
    const tokens = new Set(tokenizeForSearch(column.name))
    return fieldTokens.length > 0 && fieldTokens.every(token => tokens.has(token))
  })
  if (namePart !== undefined) return columnMatch(namePart, 'name-part', 0.9, field)

  // 3. the column comment contains the field.
  const commentHit = columns.find(column => commentHasTokens(column.comment, fieldTokens))
  if (commentHit !== undefined) return columnMatch(commentHit, 'comment', 0.8, field)

  // 4. the field is a synonym of something in the column's name or comment.
  const groups = aliasGroupsIn([field], aliases)
  if (groups.length > 0) {
    for (const column of columns) {
      const tokens = new Set([...tokenizeForSearch(column.name), ...tokenizeForSearch(column.comment ?? '')])
      for (const group of groups) {
        if (aliasGroupTokens(group).some(token => tokens.has(token))) {
          return columnMatch(column, 'synonym', 0.75, field)
        }
      }
    }
  }

  // 5. one edit away from a long-enough column name or name token, and the single best candidate.
  //    A short identifier is excluded (see FUZZY_MIN_LENGTH) and a tie is refused: a substitution
  //    that silently answers with another column is worse than saying the field is not there. The
  //    floor applies to both sides: a 5-character column one edit away from a 6-character field is
  //    exactly the kind of near-miss a loose floor would answer with.
  if (folded.length >= FUZZY_MIN_LENGTH) {
    let best: { column: ColumnRecord; distance: number } | undefined
    let bestCount = 0
    for (const column of columns) {
      const candidates = [normalizeIdentifier(column.name), ...tokenizeForSearch(column.name).map(normalizeIdentifier)]
      let columnBest = Number.POSITIVE_INFINITY
      for (const candidate of candidates) {
        if (candidate.length < FUZZY_MIN_LENGTH) continue
        const distance = levenshteinWithin(folded, candidate, 1)
        if (distance <= 1 && distance < columnBest) columnBest = distance
      }
      if (columnBest === Number.POSITIVE_INFINITY) continue
      if (best === undefined || columnBest < best.distance) {
        best = { column, distance: columnBest }
        bestCount = 1
      } else if (columnBest === best.distance) {
        bestCount += 1
      }
    }
    if (best !== undefined && bestCount === 1) {
      return columnMatch(best.column, 'fuzzy', 0.55, field)
    }
  }
  return undefined
}

/**
 * Match every requested field, preserving the request's order.
 * @param columns - the object's columns.
 * @param fields - the requested words.
 * @param aliases - the alias table.
 * @returns the matches, the words that did not resolve, and the columns.
 */
function matchRequestedFields(
  columns: readonly ColumnRecord[],
  fields: readonly string[],
  aliases: readonly AliasGroup[],
): { matches: MatchedColumn[]; missing: string[] } {
  const matches: MatchedColumn[] = []
  const missing: string[] = []
  for (const field of fields) {
    const hit = matchField(columns, field, aliases)
    if (hit === undefined) missing.push(field)
    else matches.push(hit)
  }
  return { matches, missing }
}

/**
 * Resolve a `where` key to a column.
 * @param columns - the object's columns.
 * @param key - the caller's column name.
 * @returns the column, when the name really exists on the object.
 */
function findWhereColumn(columns: readonly ColumnRecord[], key: string): ColumnRecord | undefined {
  const folded = normalizeIdentifier(key)
  if (folded === '') return undefined
  return columns.find(column => normalizeIdentifier(column.name) === folded)
}

/**
 * Render the available column names for a refusal reason.
 * @param columns - the object's columns.
 * @param limit - how many names to show.
 * @returns a comma-separated list with a truncation note.
 */
function availableColumnsText(columns: readonly ColumnRecord[], limit = AVAILABLE_COLUMNS_SHOWN): string {
  const names = columns.slice(0, limit).map(column => column.name)
  const suffix = columns.length > limit ? ` 等 ${columns.length} 列` : ''
  return names.length === 0 ? '（无）' : `${names.join('、')}${suffix}`
}

/**
 * Render the matched columns for a resolved reason, truncated so a 300-column table cannot flood it.
 * @param matches - the matched columns.
 * @returns the summary.
 */
function summarizeMatches(matches: readonly MatchedColumn[]): string {
  const shown = matches.slice(0, REASON_COLUMNS_SHOWN).map(match => {
    const source = match.term === undefined ? match.matchedBy : `${match.matchedBy}←${match.term}`
    return `${match.column}(${source})`
  })
  const suffix = matches.length > REASON_COLUMNS_SHOWN ? ` 等 ${matches.length} 列` : ''
  return shown.length === 0 ? '（无）' : `${shown.join('、')}${suffix}`
}

/**
 * Build a `FindCandidate`.
 * @param record - the object.
 * @param score - its 0..1 score.
 * @param columns - the matched columns to surface.
 * @returns the candidate.
 */
function makeCandidate(record: ObjectRecord, score: number, columns: readonly MatchedColumn[]): FindCandidate {
  return {
    object: displayName(record),
    kind: record.kind,
    ...(record.comment === undefined ? {} : { comment: record.comment }),
    score,
    columns,
  }
}

/**
 * The predicate a resolved request needs.
 * @param engine - the connection's engine, which decides identifier quoting.
 * @param where - resolved (column, value) pairs in request order.
 * @returns the plan, or undefined when there is no condition.
 */
function buildPredicate(
  engine: string,
  where: readonly { column: ColumnRecord; value: unknown }[],
): PredicatePlan | undefined {
  if (where.length === 0) return undefined
  const clause = `WHERE ${where
    .map(entry => `${quoteIdentifier(engine as Engine, entry.column.name)} = ?`)
    .join(' AND ')}`
  return { clause, values: where.map(entry => entry.value) }
}

/**
 * Assemble the final resolution for an object that was selected.
 *
 * Field and `where` validation happen here rather than at each call site, because every selection path
 * (name, entity, `where`-only) must end in the same rules.
 * @param db - the open index.
 * @param engine - engine name from the index's meta.
 * @param record - the selected object.
 * @param confidence - the object-level confidence.
 * @param lead - how the object was selected, prefixed to the reason.
 * @param fields - requested fields.
 * @param whereEntries - requested predicate entries, in order.
 * @param options - resolver tuning.
 * @returns the resolution.
 */
function buildResolved(
  db: DatabaseSync,
  engine: string,
  record: ObjectRecord,
  confidence: number,
  lead: string,
  fields: readonly string[],
  whereEntries: readonly (readonly [string, unknown])[],
  options: ResolveOptions,
): Resolution {
  const loaded = loadColumns(db, record.id, options.maxColumns + 1)
  const columns = loaded.slice(0, options.maxColumns)
  // Saying "no such column" about a column that exists but fell outside the cap would be a wrong
  // answer, so the refusal names the bound whenever it applied.
  const bound = loaded.length > options.maxColumns
    ? `（只检查了前 ${options.maxColumns} 列，该表还有更多列未参与匹配）`
    : ''
  const display = displayName(record)
  const where: { column: ColumnRecord; value: unknown }[] = []
  for (const [key, value] of whereEntries) {
    const column = findWhereColumn(columns, key)
    if (column === undefined) {
      return {
        status: 'not_found',
        reason: `表 ${display} 没有字段“${key}”（where 条件用）；可用列：${availableColumnsText(columns)}${bound}。`,
        confidence: 0,
        resolved: makeCandidate(record, confidence, []),
      }
    }
    where.push({ column, value })
  }

  let matches: MatchedColumn[]
  if (fields.length === 0) {
    matches = allColumnsAsMatches(columns)
  } else {
    const outcome = matchRequestedFields(columns, fields, options.aliases)
    if (outcome.missing.length > 0) {
      return {
        status: 'not_found',
        reason: `表 ${display} 没有字段${outcome.missing.map(word => `“${word}”`).join('、')}；`
          + `可用列：${availableColumnsText(columns)}${bound}。`,
        confidence: 0,
        resolved: makeCandidate(record, confidence, outcome.matches),
      }
    }
    matches = outcome.matches
  }

  const predicate = buildPredicate(engine, where)
  const reason = `${lead}${display}${record.comment === undefined ? '' : `（${record.comment}）`}`
    + `；字段：${summarizeMatches(matches)}`
    + (predicate === undefined ? '' : `；条件：${predicate.clause}`)
  return {
    status: 'resolved',
    reason,
    confidence,
    resolved: makeCandidate(record, confidence, matches),
    ...(predicate === undefined ? {} : { predicate }),
  }
}

/**
 * Columns matched for a candidate listing, without the strictness of a final resolution.
 * @param db - the open index.
 * @param record - the candidate object.
 * @param fields - requested fields.
 * @param options - resolver tuning.
 * @returns matched columns; empty when no fields were requested.
 */
function candidateMatches(
  db: DatabaseSync,
  record: ObjectRecord,
  fields: readonly string[],
  options: ResolveOptions,
): MatchedColumn[] {
  if (fields.length === 0) return []
  const columns = loadColumns(db, record.id, options.maxColumns + 1).slice(0, options.maxColumns)
  return matchRequestedFields(columns, fields, options.aliases).matches
}

/**
 * The suffix a `not_found` reason uses to point at near-miss tables.
 * @param db - the open index.
 * @param words - what the caller typed.
 * @returns a sentence fragment ending in a full stop.
 */
function suggestionsFor(db: DatabaseSync, words: readonly string[]): string {
  const suggestions = lookupObjectSuggestions(db, words)
  return suggestions.length === 0
    ? '。可先用 dbgraph objects 列出表名。'
    : `。相近的表：${suggestions.map(displayName).join('、')}。`
}

/**
 * Suggest objects for a refusal reason.
 * @param db - the open index.
 * @param words - what the caller typed.
 * @returns near matches, best first.
 */
function lookupObjectSuggestions(db: DatabaseSync, words: readonly string[]): readonly ObjectRecord[] {
  // Kept separate from `suggestObjects` only so the reason's wording lives beside its call site.
  const expression = searchMatchQuery(words)
  if (expression !== '') {
    const ids = ftsObjectIds(db, expression, 5)
    if (ids.length > 0) {
      const found = loadObjects(db, ids)
      return ids.map(id => found.get(id)).filter((record): record is ObjectRecord => record !== undefined)
    }
  }
  return lookupObject(db, words.find(word => word !== '') ?? '').suggestions
}

/**
 * Resolve a request that names its table outright.
 * @param db - the open index.
 * @param engine - engine name from meta.
 * @param request - the request.
 * @param fields - requested fields.
 * @param whereEntries - requested predicate entries.
 * @param options - resolver tuning.
 * @returns the resolution; confidence is 1 by contract once the name is unique.
 */
function resolveByObjectName(
  db: DatabaseSync,
  engine: string,
  request: FindRequest,
  fields: readonly string[],
  whereEntries: readonly (readonly [string, unknown])[],
  options: ResolveOptions,
): Resolution {
  const objectName = (request.object ?? '').trim()
  const lookup = lookupObject(db, objectName)
  if (lookup.matches.length > 1) {
    const candidates = lookup.matches
      .slice(0, options.maxCandidates)
      .map(record => makeCandidate(record, 1, candidateMatches(db, record, fields, options)))
    return {
      status: 'ambiguous',
      reason: `“${objectName}” 同时匹配 ${lookup.matches.length} 张表：`
        + `${candidates.map(candidate => candidate.object).join('、')}；请用 schema 限定名称。`,
      confidence: 1,
      candidates,
    }
  }
  if (lookup.record === undefined) {
    return {
      status: 'not_found',
      reason: `没有名为“${objectName}”的表${suggestionsFor(db, [objectName])}`,
      confidence: 0,
    }
  }
  return buildResolved(db, engine, lookup.record, 1, '按表名定位 ', fields, whereEntries, options)
}

/**
 * Resolve a request whose table must be inferred from the entity words.
 * @param db - the open index.
 * @param engine - engine name from meta.
 * @param request - the request.
 * @param fields - requested fields.
 * @param whereEntries - requested predicate entries.
 * @param options - resolver tuning.
 * @returns the resolution.
 */
function resolveByEntity(
  db: DatabaseSync,
  engine: string,
  request: FindRequest,
  fields: readonly string[],
  whereEntries: readonly (readonly [string, unknown])[],
  options: ResolveOptions,
): Resolution {
  const entity = (request.entity ?? '').trim()
  const scored = scoreByEntity(db, entity, options)
  if (scored.length === 0) {
    return {
      status: 'not_found',
      reason: `没有匹配“${entity}”的表${suggestionsFor(db, [entity])}`,
      confidence: 0,
    }
  }
  const records = loadObjects(db, scored.map(entry => entry.objectId))
  const ranked = scored
    .map(entry => ({ entry, record: records.get(entry.objectId) }))
    .filter((pair): pair is { entry: ScoredObject; record: ObjectRecord } => pair.record !== undefined)
    .sort((left, right) => {
      const byScore = right.entry.score - left.entry.score
      if (byScore !== 0) return byScore
      const leftName = displayName(left.record)
      const rightName = displayName(right.record)
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
    })
  const top = ranked[0]
  if (top === undefined) {
    return {
      status: 'not_found',
      reason: `没有匹配“${entity}”的表${suggestionsFor(db, [entity])}`,
      confidence: 0,
    }
  }
  // An entity that folds to a table's full name is that table, however the token scoring ranked it:
  // shared prefixes (`sys_user` / `sys_dept`) are exactly what the token score cannot separate.
  const foldedEntity = normalizeIdentifier(entity)
  if (foldedEntity !== '') {
    const exact = ranked.filter(pair =>
      normalizeIdentifier(displayName(pair.record)) === foldedEntity
      || normalizeIdentifier(pair.record.name) === foldedEntity)
    if (exact.length === 1) {
      const only = exact[0] as { entry: ScoredObject; record: ObjectRecord }
      return buildResolved(db, engine, only.record, 1, '表名精确匹配 ', fields, whereEntries, options)
    }
  }
  const second = ranked[1]
  const undecided = top.entry.score < options.minConfidence
    || (second !== undefined && top.entry.score - second.entry.score < options.ambiguityGap)
  if (undecided) {
    const candidates = ranked
      .slice(0, options.maxCandidates)
      .map(pair => makeCandidate(pair.record, pair.entry.score, candidateMatches(db, pair.record, fields, options)))
    return {
      status: 'ambiguous',
      reason: `“${entity}” 不是唯一匹配：`
        + `${candidates.map(candidate => `${candidate.object}(${candidate.score.toFixed(2)})`).join('、')}`
        + '；请用 object 指定表名，或补充 where 条件。',
      confidence: top.entry.score,
      candidates,
    }
  }
  return buildResolved(
    db,
    engine,
    top.record,
    top.entry.score,
    `“${entity}” 命中 `,
    fields,
    whereEntries,
    options,
  )
}

/**
 * Resolve a request that gives only `where` conditions: the tables containing all of those columns.
 * @param db - the open index.
 * @param engine - engine name from meta.
 * @param request - the request.
 * @param fields - requested fields.
 * @param whereEntries - requested predicate entries.
 * @param options - resolver tuning.
 * @returns the resolution.
 */
function resolveByWhere(
  db: DatabaseSync,
  engine: string,
  fields: readonly string[],
  whereEntries: readonly (readonly [string, unknown])[],
  options: ResolveOptions,
): Resolution {
  const keys = whereEntries.map(([key]) => key)
  const rows = db.prepare('SELECT object_id AS object_id, name AS name FROM columns').all()
  const byName = new Map<string, Set<number>>()
  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name : undefined
    const objectId = typeof row.object_id === 'number' ? row.object_id : undefined
    if (name === undefined || objectId === undefined) continue
    const folded = normalizeIdentifier(name)
    if (folded === '') continue
    const bucket = byName.get(folded)
    if (bucket === undefined) byName.set(folded, new Set([objectId]))
    else bucket.add(objectId)
  }
  const missing = keys.filter(key => !byName.has(normalizeIdentifier(key)))
  if (missing.length > 0) {
    return {
      status: 'not_found',
      reason: `没有任何表有字段${missing.map(key => `“${key}”`).join('、')}；`
        + '用 dbgraph columns <表> 查看某张表的可用字段。',
      confidence: 0,
    }
  }
  let candidates: Set<number> | undefined
  for (const key of keys) {
    const bucket = byName.get(normalizeIdentifier(key)) as Set<number>
    if (candidates === undefined) candidates = new Set(bucket)
    else {
      for (const id of candidates) if (!bucket.has(id)) candidates.delete(id)
    }
  }
  const objects = loadObjects(db, [...(candidates ?? [])])
  if (objects.size === 0) {
    return {
      status: 'not_found',
      reason: `没有一张表同时包含字段${keys.map(key => `“${key}”`).join('、')}。`,
      confidence: 0,
    }
  }
  const ranked = [...objects.values()].sort((left, right) => {
    const leftName = displayName(left)
    const rightName = displayName(right)
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
  })
  const makeWhereMatches = (record: ObjectRecord): MatchedColumn[] => {
    const columns = loadColumns(db, record.id, options.maxColumns + 1).slice(0, options.maxColumns)
    const matches: MatchedColumn[] = []
    for (const key of keys) {
      const column = findWhereColumn(columns, key)
      if (column !== undefined) matches.push(columnMatch(column, 'name', 1, key))
    }
    return matches
  }
  if (ranked.length > 1) {
    return {
      status: 'ambiguous',
      reason: `有 ${ranked.length} 张表同时包含${keys.map(key => `“${key}”`).join('、')}：`
        + `${ranked.slice(0, options.maxCandidates).map(displayName).join('、')}；请用 object 指定表名。`,
      confidence: 0.7,
      candidates: ranked
        .slice(0, options.maxCandidates)
        .map(record => makeCandidate(record, 0.7, makeWhereMatches(record))),
    }
  }
  const only = ranked[0] as ObjectRecord
  return buildResolved(
    db,
    engine,
    only,
    0.7,
    `仅有表 `,
    fields,
    whereEntries,
    options,
  )
}

/**
 * Resolve a `find` request to an object, its columns, and a parameterized predicate — all offline.
 * @param db - the open read-only index.
 * @param engine - the connection's engine, read from the index's `meta`.
 * @param request - the request to resolve.
 * @param options - resolver tuning.
 * @returns the resolution; the caller executes it only when the status is `resolved`.
 */
export function resolveFind(
  db: DatabaseSync,
  engine: string,
  request: FindRequest,
  options: ResolveOptions,
): Resolution {
  const objectName = (request.object ?? '').trim()
  const entity = (request.entity ?? '').trim()
  const fields = (request.fields ?? []).map(field => field.trim()).filter(field => field !== '')
  const whereEntries = Object.entries(request.where ?? {}) as (readonly [string, unknown])[]
  if (objectName === '' && entity === '' && whereEntries.length === 0) return missingPredicate()
  if (objectName !== '') {
    return resolveByObjectName(db, engine, request, fields, whereEntries, options)
  }
  if (entity !== '') return resolveByEntity(db, engine, request, fields, whereEntries, options)
  return resolveByWhere(db, engine, fields, whereEntries, options)
}
