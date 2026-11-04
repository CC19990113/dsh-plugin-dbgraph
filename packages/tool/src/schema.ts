/**
 * The two dbgraph tools' model-facing schemas: the parameter spec the model fills in, and the
 * canonical output union each tool returns.
 *
 * The output is a closed `oneOf` keyed on `operation`, not one loose object with every field
 * optional, so a Code Mode program that switches on `operation` gets exactly the fields that
 * operation produces and nothing it must test for. The build-side tool gets its own union, also
 * discriminated, because a background run has no report to report yet: "0 objects indexed" and
 * "not indexed yet" are different answers and must stay distinguishable.
 * @module dsh-plugin-dbgraph-tool/schema
 */

import type { InferArgs, InferValue } from '@deepseek-ai/dsh-tools'

/**
 * Operations the primary `dbgraph` tool accepts, one per `ctx.dbgraph` seam method.
 *
 * `index` is deliberately absent: building an index runs through the dedicated `dbgraph_index`
 * tool, which carries its own (much larger) timeout budget instead of this tool's query-sized one.
 * `connections` is the only operation that takes no `connection` argument — it is how the model
 * learns which connection ids exist.
 */
export const DBGRAPH_OPERATIONS = ['connections', 'schema', 'objects', 'columns', 'find', 'sql', 'impact', 'refs'] as const

/** One query-side operation name. */
export type DbgraphToolOperation = (typeof DBGRAPH_OPERATIONS)[number]

/** Modes the index tool accepts; `full` runs L1 then L2. */
export const DBGRAPH_INDEX_MODES = ['l1', 'l2', 'full'] as const

/** Which writer an index run may use. `js` is the parity reference and the fallback. */
export const DBGRAPH_INDEX_WRITERS = ['auto', 'js', 'rust'] as const

/** Column categories a resolver can match a user word against. */
const MATCH_SOURCES = ['name', 'name-part', 'comment', 'synonym', 'fuzzy'] as const

/** Why a `find` request produced the answer it did. */
const FIND_STATUSES = ['resolved', 'ambiguous', 'missing_predicate', 'not_found'] as const

/** One object's index state, as `ctx.dbgraph` reports it. */
const INDEX_STATE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    l1_indexed_at: { type: 'integer' },
    l2_indexed_at: { type: 'integer' },
    objects: { type: 'integer', required: true },
    columns: { type: 'integer', required: true },
    stale: { type: 'boolean', required: true },
    writer: { type: 'string' },
  },
} as const

/** One configured connection, secrets omitted. */
const CONNECTION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    engine: { type: 'string', required: true },
    label: { type: 'string' },
    host: { type: 'string' },
    database: { type: 'string' },
    credential_configured: { type: 'boolean', required: true },
    index: { ...INDEX_STATE, required: true },
  },
} as const

/** One object in a listing, without its columns. */
const OBJECT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    object: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    comment: { type: 'string' },
    column_count: { type: 'integer', required: true },
    row_estimate: { type: 'integer' },
  },
} as const

/** One column in a listing. */
const COLUMN = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    type: { type: 'string', required: true },
    nullable: { type: 'boolean', required: true },
    default_value: { type: 'string' },
    comment: { type: 'string' },
    is_primary_key: { type: 'boolean', required: true },
    is_unique: { type: 'boolean', required: true },
    enum_values: { type: 'array', items: { type: 'string' } },
  },
} as const

/** One column the resolver picked, with the evidence that picked it. */
const MATCHED_COLUMN = {
  type: 'object',
  additionalProperties: false,
  properties: {
    column: { type: 'string', required: true },
    comment: { type: 'string' },
    matched_by: { type: 'string', required: true, enum: [...MATCH_SOURCES] },
    term: { type: 'string' },
    score: { type: 'number', required: true },
  },
} as const

/** One object the resolver considered. */
const FIND_CANDIDATE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    object: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    comment: { type: 'string' },
    score: { type: 'number', required: true },
    columns: { type: 'array', required: true, items: MATCHED_COLUMN },
  },
} as const

/** One edge touching an object. */
const RELATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    object: { type: 'string', required: true },
    column: { type: 'string' },
    ref_column: { type: 'string' },
    name: { type: 'string' },
  },
} as const

/** Rows as the seam returns them: JSON-safe scalars, objects, arrays — never a provider handle. */
const ROWS = { type: 'array', required: true, items: { type: 'json' } } as const

/**
 * Build one `oneOf` member for a fixed operation name.
 *
 * Both type parameters are `const` so the member keeps its literal types: without them the helper
 * would widen `operation` to the whole union and erase each member's own fields, and `InferValue`
 * would produce one shapeless object instead of a discriminated union.
 * @param operation - the literal `operation` value discriminating this member.
 * @param properties - the fields this operation returns beyond `operation`.
 * @returns the member's value schema.
 */
function member<const O extends DbgraphToolOperation, const P extends Record<string, unknown>>(
  operation: O,
  properties: P,
) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', required: true, const: operation },
      ...properties,
    },
  } as const
}

/** The canonical value every `dbgraph` call returns, discriminated by `operation`. */
export const DBGRAPH_OUTPUT_SCHEMA = {
  oneOf: [
    member('connections', {
      connections: { type: 'array', required: true, items: CONNECTION },
    }),
    member('schema', {
      connection: { type: 'string', required: true },
      engine: { type: 'string', required: true },
      database: { type: 'string', required: true },
      objects: { type: 'array', required: true, items: OBJECT },
      truncated: { type: 'boolean', required: true },
      comment_coverage: { type: 'number', required: true },
      index: { ...INDEX_STATE, required: true },
    }),
    member('objects', {
      connection: { type: 'string', required: true },
      objects: { type: 'array', required: true, items: OBJECT },
      truncated: { type: 'boolean', required: true },
    }),
    member('columns', {
      connection: { type: 'string', required: true },
      object: { type: 'string', required: true },
      kind: { type: 'string', required: true },
      comment: { type: 'string' },
      columns: { type: 'array', required: true, items: COLUMN },
      truncated: { type: 'boolean', required: true },
    }),
    member('find', {
      connection: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: [...FIND_STATUSES] },
      reason: { type: 'string', required: true },
      confidence: { type: 'number', required: true },
      resolved: FIND_CANDIDATE,
      candidates: { type: 'array', items: FIND_CANDIDATE },
      sql: { type: 'string' },
      rows: { type: 'array', items: { type: 'json' } },
      row_count: { type: 'integer' },
      truncated: { type: 'boolean' },
      redacted: { type: 'array', items: { type: 'string' } },
      elapsed_ms: { type: 'integer', required: true },
    }),
    member('sql', {
      connection: { type: 'string', required: true },
      columns: { type: 'array', required: true, items: { type: 'string' } },
      rows: ROWS,
      row_count: { type: 'integer', required: true },
      truncated: { type: 'boolean', required: true },
      redacted: { type: 'array', required: true, items: { type: 'string' } },
      affected_rows: { type: 'integer' },
      elapsed_ms: { type: 'integer', required: true },
      warnings: { type: 'array', items: { type: 'string' } },
    }),
    member('impact', {
      connection: { type: 'string', required: true },
      object: { type: 'string', required: true },
      entries: { type: 'array', required: true, items: RELATION },
      truncated: { type: 'boolean', required: true },
    }),
    member('refs', {
      connection: { type: 'string', required: true },
      object: { type: 'string', required: true },
      entries: { type: 'array', required: true, items: RELATION },
      truncated: { type: 'boolean', required: true },
    }),
  ],
} as const

/** The parameters the model fills in for `dbgraph`. Which ones apply depends on `operation`. */
export const DBGRAPH_PARAMETERS = {
  operation: {
    type: 'string',
    required: true,
    enum: [...DBGRAPH_OPERATIONS],
    description:
      'connections (list configured connections with their index state), schema (one connection\'s structural overview), objects (find tables by word, ranked), columns (one table\'s columns), find (resolve words to a table and columns, then execute ONE parameterized read — the fast path), sql (execute one statement verbatim), impact (what a table\'s change reaches), refs (what references a table). To build or refresh an index, call the dbgraph_index tool instead.',
  },
  connection: {
    type: 'string',
    description: 'Connection id, as listed by operation "connections". Required by every operation except "connections".',
  },
  query: {
    type: 'string',
    description: 'Search text for objects (a table name or comment word), or the statement for sql.',
  },
  object: {
    type: 'string',
    description: 'Table or view name for columns, impact, and refs. For find, names the table outright and skips object resolution.',
  },
  entity: {
    type: 'string',
    description: 'What the user is talking about for find, e.g. 用户 or 订单. Matched against table names, comments, and Chinese aliases.',
  },
  fields: {
    type: 'array',
    items: { type: 'string' },
    description: 'Columns the caller wants for find, e.g. ["密码"]. Omit for every column.',
  },
  where: {
    type: 'json',
    description: 'Filter for find: a JSON object mapping a column name to a value, e.g. {"id": 7}. A column that does not exist fails with the available column list.',
  },
  limit: {
    type: 'number',
    description: 'Largest number of rows or objects to return.',
  },
} as const

/**
 * The parameters the dedicated `dbgraph_index` tool takes. It needs no `operation` — building an
 * index is the only thing it does — and none of the query-side fields, which an index run has no
 * use for.
 */
export const DBGRAPH_INDEX_PARAMETERS = {
  connection: {
    type: 'string',
    description: 'Connection id to index. Omitted indexes every configured connection.',
  },
  mode: {
    type: 'string',
    enum: [...DBGRAPH_INDEX_MODES],
    description: 'How deep to build: l1 (structure only, fast), l2 (enrichment only, needs an L1 index), full (L1 then L2, the default).',
  },
  writer: {
    type: 'string',
    enum: [...DBGRAPH_INDEX_WRITERS],
    description: 'Which writer to prefer: auto (native when available, JS otherwise), js, or rust.',
  },
} as const

/** One finished indexing run, as the model sees it. */
const INDEX_REPORT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    connection: { type: 'string', required: true },
    level: { type: 'string', required: true, enum: ['l1', 'l2'] },
    objects: { type: 'integer', required: true },
    columns: { type: 'integer', required: true },
    edges: { type: 'integer', required: true },
    terms: { type: 'integer', required: true },
    writer: { type: 'string', required: true, enum: ['js', 'rust'] },
    elapsed_ms: { type: 'integer', required: true },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const

/**
 * One `oneOf` member of the index tool's output. Its discriminator is `status`, not `operation`:
 * a started run and a finished run are both answers to the same call.
 * @param status - the literal `status` value discriminating this member.
 * @param properties - the fields this member returns beyond `status`.
 * @returns the member's value schema.
 */
function indexMember<const S extends 'started' | 'completed', const P extends Record<string, unknown>>(
  status: S,
  properties: P,
) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, const: status },
      ...properties,
    },
  } as const
}

/** The canonical value every `dbgraph_index` call returns, discriminated by `status`. */
export const DBGRAPH_INDEX_OUTPUT_SCHEMA = {
  oneOf: [
    indexMember('started', {
      job_id: { type: 'string', required: true },
      connection: { type: 'string' },
      mode: { type: 'string', required: true, enum: [...DBGRAPH_INDEX_MODES] },
    }),
    indexMember('completed', {
      // One entry per indexed connection: a run over several connections must not report only the
      // first, or the model reads the others as never indexed and asks again.
      reports: { type: 'array', required: true, items: INDEX_REPORT },
    }),
  ],
} as const

/** The canonical value, inferred from {@link DBGRAPH_OUTPUT_SCHEMA} so the two cannot drift. */
export type DbgraphToolValue = InferValue<typeof DBGRAPH_OUTPUT_SCHEMA>

/** The validated arguments, inferred from {@link DBGRAPH_PARAMETERS}. */
export type DbgraphToolArgs = InferArgs<typeof DBGRAPH_PARAMETERS>

/** The canonical value, inferred from {@link DBGRAPH_INDEX_OUTPUT_SCHEMA}. */
export type DbgraphIndexToolValue = InferValue<typeof DBGRAPH_INDEX_OUTPUT_SCHEMA>

/** The validated arguments, inferred from {@link DBGRAPH_INDEX_PARAMETERS}. */
export type DbgraphIndexToolArgs = InferArgs<typeof DBGRAPH_INDEX_PARAMETERS>

/** The canonical value for one operation. */
export type DbgraphValueFor<O extends DbgraphToolOperation> = Extract<DbgraphToolValue, { operation: O }>
