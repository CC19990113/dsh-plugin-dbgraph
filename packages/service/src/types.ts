/**
 * The dbgraph seam vocabulary: connection configuration, the raw catalog a dialect produces, the
 * normalized request and result unions `ctx.dbgraph` answers, and the two provider contracts (a
 * database dialect and the on-disk index store).
 *
 * Types only — {@link DbgraphError}, the branded id factories, and the `ENGINES` / `OBJECT_KINDS` /
 * `EDGE_KINDS` vocabulary arrays are runtime and live in `index.ts` and `brand.ts`.
 *
 * Two rules shape every shape below. First, **the index holds structure and never a business
 * value**: the only data-derived field anywhere is {@link RawColumn.enumValues}, a bounded sample of
 * distinct literals used to teach the model what `status = 'paid'` looks like. Second, **nothing here
 * reaches the network**: execution lives behind {@link DatabaseDialect.execute}, which the service
 * calls; the store is offline by construction.
 * @module dsh-plugin-dbgraph-service/types
 */

import type { ConnectionId } from './brand.ts'
import type { StoredConnection } from './schema.ts'

export type { StoredConnection } from './schema.ts'

/** The database families a dialect can serve. */
export const ENGINES = ['mysql', 'postgres', 'sqlite', 'mongodb', 'redis'] as const

/** One database family. */
export type Engine = (typeof ENGINES)[number]

/**
 * The node categories the index format defines. Open rather than closed for the same reason the
 * graph format is: a newer dialect may write a kind this build does not know, and a consumer must
 * still surface it as data.
 */
export const OBJECT_KINDS = ['table', 'view', 'collection', 'key_pattern'] as const

/** A node category. */
export type ObjectKind = (typeof OBJECT_KINDS)[number]

/**
 * The relationship categories the index format defines. `fk` and `view_ref` come from the server's
 * own catalog; `index` records a real index over one or more columns; `code_ref` is filled in later
 * by the codegraph bridge and is absent from a database-only index.
 */
export const EDGE_KINDS = ['fk', 'index', 'view_ref', 'code_ref'] as const

/** A relationship category. */
export type EdgeKind = (typeof EDGE_KINDS)[number]

/**
 * One configured connection, as it is persisted. Deliberately carries no secret: the password lives
 * in the host's credential seam under {@link ConnectionConfig.credentialRef}, and this record is what
 * a configuration surface may render.
 */
export interface ConnectionConfig {
  /** Stable identity; also the index directory name. See `isValidConnectionId`. */
  readonly id: string
  /** Database family. */
  readonly engine: Engine
  /** Human label shown in the prompt digest and in errors. */
  readonly label?: string
  /** Host name, absent for a local file (SQLite). */
  readonly host?: string
  /** TCP port, absent for a local file. */
  readonly port?: number
  /** Database name; for SQLite the file path; for Redis a logical database index. */
  readonly database?: string
  /** Login user, absent for SQLite. */
  readonly user?: string
  /**
   * The credential-seam reference holding this connection's password. Derived from the id by
   * `credentialRefName`, stored explicitly so a deployment may point it at its own variable.
   */
  readonly credentialRef?: string
  /** Whether sensitive columns are masked in results (default `redact`). */
  readonly sensitiveColumns?: SensitiveMode
  /** Extra column-name patterns masked in addition to the built-in list. */
  readonly sensitivePatterns?: readonly string[]
}

/** How a result renders a column whose name or comment matches a sensitive pattern. */
export type SensitiveMode = 'redact' | 'show'

/** Everything a dialect needs to reach one server for one operation. */
export interface DialectInput {
  /** The connection being served. */
  readonly connection: ConnectionConfig
  /**
   * The resolved plaintext password, when the seam supplied one. Re-resolved per operation by the
   * caller — a dialect must never cache it across calls.
   */
  readonly password?: string
  /** Distinct-value sample size used for {@link RawColumn.enumValues}. */
  readonly enumSampleLimit: number
  /** Per-statement timeout. */
  readonly queryTimeoutMs: number
  /** Aborts the operation. */
  readonly signal?: AbortSignal
}

/** The answer to a connection test. */
export interface DialectProbe {
  /** Whether a round-trip succeeded. */
  readonly ok: boolean
  /** Server version string, when the engine reports one. */
  readonly serverVersion?: string
  /** Failure detail, when `ok` is false. */
  readonly error?: string
  /** Round-trip time in milliseconds. */
  readonly elapsedMs: number
}

/** Limits the service imposes on one execution, whichever dialect runs it. */
export interface ExecuteLimits {
  /** Rows returned before truncation. */
  readonly maxRows: number
  /** Statement timeout. */
  readonly timeoutMs: number
  /** Whether to run the statement at all when it is not obviously a read. */
  readonly readOnly: boolean
}

/** One raw column, as a dialect read it off the server. */
export interface RawColumn {
  /** Declared name, verbatim. */
  readonly name: string
  /** One-based position within the object. */
  readonly ordinal: number
  /** Declared type, verbatim — normalization is the writer's job, not the dialect's. */
  readonly type: string
  /** Whether the column admits NULL. */
  readonly nullable?: boolean
  /** Declared default, rendered as text. */
  readonly defaultValue?: string
  /** Column comment, when the server keeps one. The single most valuable field for Chinese lookup. */
  readonly comment?: string
  /** Whether the column participates in the primary key. */
  readonly isPrimaryKey?: boolean
  /** Whether a single-column unique constraint covers it. */
  readonly isUnique?: boolean
  /** At most {@link DialectInput.enumSampleLimit} distinct literals, when sampling was requested. */
  readonly enumValues?: readonly string[]
}

/** One raw relationship, as a dialect read it off the server. */
export interface RawEdge {
  /** Relationship category. */
  readonly kind: EdgeKind
  /** Constraint or index name, when the server keeps one. */
  readonly name?: string
  /** Columns on the source object. */
  readonly columns: readonly string[]
  /** Referenced object name, for `fk` and `view_ref`. */
  readonly refObject?: string
  /** Referenced columns, for `fk`. */
  readonly refColumns?: readonly string[]
  /** Whether the index this edge records is unique. */
  readonly unique?: boolean
}

/** One raw object (table, view, collection, key pattern). */
export interface RawObject {
  /** Node category. */
  readonly kind: ObjectKind
  /** Namespace the object lives in (schema, or absent when the engine has none). */
  readonly schema?: string
  /** Object name. */
  readonly name: string
  /** Object comment. */
  readonly comment?: string
  /** Approximate row count from catalog statistics — never a `COUNT(*)`. */
  readonly rowEstimate?: number
  /** Columns in declared order. */
  readonly columns: readonly RawColumn[]
  /** Relationships leaving this object. */
  readonly edges?: readonly RawEdge[]
}

/** One dialect's answer for one level of indexing. */
export interface RawCatalog {
  /** Which engine produced this. Must equal the connection's engine. */
  readonly engine: Engine
  /** Server version, when reported. */
  readonly serverVersion?: string
  /** Database this snapshot describes. */
  readonly database: string
  /** Every object reachable with the configured privileges. */
  readonly objects: readonly RawObject[]
  /** Epoch milliseconds when the snapshot was taken. */
  readonly fetchedAt: number
  /** Which level this snapshot covers, so the writer never mistakes L1 for a complete catalog. */
  readonly level: IndexLevel
  /** Per-object failures the dialect chose to tolerate rather than abort the whole run. */
  readonly warnings?: readonly string[]
}

/** How much of a connection's catalog a run covers. */
export type IndexLevel = 'l1' | 'l2'

/** A dialect implements exactly one engine: probe, two fetch levels, and one execute. */
export interface DatabaseDialect {
  /** The engine this dialect serves. Registration rejects a second dialect for the same engine. */
  readonly engine: Engine
  /** Round-trip check, used before the first index and by the connection list. */
  test(input: DialectInput): Promise<DialectProbe>
  /** Structural snapshot: object and column names and declared types. Fast enough to run inline. */
  fetchL1(input: DialectInput): Promise<RawCatalog>
  /**
   * Enrichment: comments, foreign keys, indexes, row estimates and enum samples, merged onto the L1
   * snapshot. Slow enough to belong in a background job.
   */
  fetchL2(input: DialectInput, l1: RawCatalog): Promise<RawCatalog>
  /**
   * The only networked read the seam performs after indexing.
   *
   * `parameters` binds the statement's `?` placeholders in order. It is a separate argument rather
   * than something folded into the statement string because the resolver produces a parameterized
   * predicate and the seam must never inline a value the user typed.
   */
  execute(
    input: DialectInput,
    query: string,
    limits: ExecuteLimits,
    parameters?: readonly unknown[],
  ): Promise<SqlResult>
}

/** A row as a dialect returns it. Values are already JSON-safe scalars or strings. */
export type Row = Readonly<Record<string, unknown>>

/** The result of one executed statement. */
export interface SqlResult {
  /** Column names in result order. */
  readonly columns: readonly string[]
  /** Returned rows. */
  readonly rows: readonly Row[]
  /** Rows returned, after truncation. */
  readonly rowCount: number
  /** Whether {@link ExecuteLimits.maxRows} clipped the answer. */
  readonly truncated: boolean
  /** Columns masked because they matched a sensitive pattern. */
  readonly redacted: readonly string[]
  /** Server-reported affected rows, for a non-SELECT statement. */
  readonly affectedRows?: number
  /** Wall-clock time of the round trip. */
  readonly elapsedMs: number
  /** Non-fatal warnings the server or the executor attached. */
  readonly warnings?: readonly string[]
}

/** The on-disk index state of one connection, as a configuration surface renders it. */
export interface IndexState {
  /** Epoch milliseconds of the last structural snapshot, absent when never indexed. */
  readonly l1IndexedAt?: number
  /** Epoch milliseconds of the last enrichment pass, absent when never completed. */
  readonly l2IndexedAt?: number
  /** Objects in the index. */
  readonly objects: number
  /** Columns in the index. */
  readonly columns: number
  /** Whether {@link l2IndexedAt} is older than the configured freshness window. */
  readonly stale: boolean
  /** Which writer produced the current index. */
  readonly writer?: IndexWriterKind
}

/** Which implementation wrote the index. `js` is the parity reference and fallback. */
export type IndexWriterKind = 'js' | 'rust'

/** One entry of the connection list. Never carries a secret. */
export interface ConnectionSummary {
  /** The connection identity. */
  readonly id: string
  /** Database family. */
  readonly engine: Engine
  /** Human label, when configured. */
  readonly label?: string
  /** Host, when the connection is a server. */
  readonly host?: string
  /** Database name, when configured. */
  readonly database?: string
  /** Whether the credential seam currently resolves this connection's password. */
  readonly credentialConfigured: boolean
  /** Index state, or the reason it could not be read. */
  readonly index: IndexState
}

/** One object in a listing, without its columns. */
export interface ObjectView {
  /** Object name, qualified by schema when the engine has one. */
  readonly object: string
  /** Node category. */
  readonly kind: string
  /** Object comment. */
  readonly comment?: string
  /** Number of indexed columns. */
  readonly columnCount: number
  /** Approximate row count. */
  readonly rowEstimate?: number
}

/** One column in a listing. */
export interface ColumnView {
  /** Column name. */
  readonly name: string
  /** Declared type, verbatim. */
  readonly type: string
  /** Whether the column admits NULL. */
  readonly nullable: boolean
  /** Declared default, rendered as text. */
  readonly defaultValue?: string
  /** Column comment. */
  readonly comment?: string
  /** Whether the column participates in the primary key. */
  readonly isPrimaryKey: boolean
  /** Whether a single-column unique constraint covers it. */
  readonly isUnique: boolean
  /** Sampled distinct literals, when the enrichment pass captured them. */
  readonly enumValues?: readonly string[]
}

/** Why a `find` request did or did not produce a row set. */
export type FindStatus = 'resolved' | 'ambiguous' | 'missing_predicate' | 'not_found'

/** How one column was matched to the user's words. */
export type MatchSource = 'name' | 'name-part' | 'comment' | 'synonym' | 'fuzzy'

/** One column the resolver chose, with the evidence that chose it. */
export interface MatchedColumn {
  /** Column name. */
  readonly column: string
  /** Column comment, when indexed. */
  readonly comment?: string
  /** What made this column a hit. */
  readonly matchedBy: MatchSource
  /** Which user word produced the hit, when the request named one. */
  readonly term?: string
  /** Resolver score, 0..1. */
  readonly score: number
}

/** One object the resolver considered. */
export interface FindCandidate {
  /** Object name, qualified by schema when the engine has one. */
  readonly object: string
  /** Node category. */
  readonly kind: string
  /** Object comment. */
  readonly comment?: string
  /** Resolver score for the object, 0..1. */
  readonly score: number
  /** Columns that matched inside this object. */
  readonly columns: readonly MatchedColumn[]
}

/** The `find` request: words in, one parameterized statement out. */
export interface FindRequest {
  /** Connection identity. */
  readonly connection: string
  /** What the user is talking about, e.g. `用户`. Optional when `object` names a table outright. */
  readonly entity?: string
  /** What the user asked for, e.g. `[密码]`. Omitted means every column. */
  readonly fields?: readonly string[]
  /** Predicate values, keyed by the column name the caller believes exists. */
  readonly where?: Readonly<Record<string, unknown>>
  /** Table to use directly, skipping object resolution. */
  readonly object?: string
  /** Rows requested (default 50, capped by the tool's configuration). */
  readonly limit?: number
}

/** The `find` result. */
export interface FindResult {
  /** Why this answer is what it is. */
  readonly status: FindStatus
  /** Causal explanation of the status, shown to the model verbatim. */
  readonly reason: string
  /** The chosen object, when one was chosen. */
  readonly resolved?: FindCandidate
  /** 0..1 confidence in {@link resolved}. */
  readonly confidence: number
  /** Ranked alternatives, present whenever resolution was not decisive. */
  readonly candidates?: readonly FindCandidate[]
  /** The statement that was run, parameter placeholders included. Never includes literal values. */
  readonly sql?: string
  /** Rows returned. */
  readonly rows?: readonly Row[]
  /** Rows returned, after truncation. */
  readonly rowCount?: number
  /** Whether the row cap clipped the answer. */
  readonly truncated?: boolean
  /** Columns masked by the sensitive rule. */
  readonly redacted?: readonly string[]
  /** Wall-clock time, including the networked execution. */
  readonly elapsedMs: number
}

/** Why one indexing run produced what it produced. */
export interface IndexReport {
  /** Connection identity. */
  readonly connection: string
  /** Level this run covered. */
  readonly level: IndexLevel
  /** Objects written. */
  readonly objects: number
  /** Columns written. */
  readonly columns: number
  /** Edges written. */
  readonly edges: number
  /** Search terms written. */
  readonly terms: number
  /** Which writer ran. */
  readonly writer: IndexWriterKind
  /** Wall-clock time of the whole run. */
  readonly elapsedMs: number
  /** Non-fatal problems: a per-object failure, a skipped enrichment, a missing driver capability. */
  readonly warnings: readonly string[]
}

/** What `ctx.dbgraph` exposes to a consumer. */
export interface DbgraphService {
  /** Every configured connection with its index state, secrets omitted. */
  listConnections(): Promise<readonly ConnectionSummary[]>
  /** One connection's structural overview, from the index. */
  schema(request: SchemaRequest, signal?: AbortSignal): Promise<SchemaResult>
  /** Objects matching a query, ranked. */
  objects(request: ObjectsRequest, signal?: AbortSignal): Promise<ObjectsResult>
  /** One object's columns. */
  columns(request: ColumnsRequest, signal?: AbortSignal): Promise<ColumnsResult>
  /** Resolve words to an object and columns, then execute one parameterized read. */
  find(request: FindRequest, signal?: AbortSignal): Promise<FindResult>
  /** Execute one statement against the server, with no semantic resolution. */
  sql(request: SqlRequest, signal?: AbortSignal): Promise<SqlResult>
  /** Which objects a change to this one reaches. */
  impact(request: ImpactRequest, signal?: AbortSignal): Promise<ImpactResult>
  /** Which objects reference this one. */
  refs(request: RefsRequest, signal?: AbortSignal): Promise<RefsResult>
  /** Build or refresh an index, returning the first target's report. Prefer {@link indexMany}. */
  index(request: IndexRequest, signal?: AbortSignal): Promise<IndexReport>
  /**
   * Build or refresh every target connection, one report each. With no `connection`, that is every
   * configured connection — the shape a tool needs to tell the model what actually happened, rather
   * than the first of several runs.
   */
  indexMany(request: IndexRequest, signal?: AbortSignal): Promise<IndexReport[]>
}

/** `schema` request. */
export interface SchemaRequest {
  /** Connection identity. */
  readonly connection: string
}

/** `schema` result. */
export interface SchemaResult {
  /** Connection identity. */
  readonly connection: string
  /** Database family. */
  readonly engine: Engine
  /** Database name. */
  readonly database: string
  /** Objects in the index, ranked by size then name. */
  readonly objects: readonly ObjectView[]
  /** Whether the object list was clipped. */
  readonly truncated: boolean
  /** Index state. */
  readonly index: IndexState
  /** Fraction of columns carrying a comment, 0..1 — tells the model how much to trust name matching. */
  readonly commentCoverage: number
}

/** `objects` request. */
export interface ObjectsRequest {
  /** Connection identity. */
  readonly connection: string
  /** Free-text query over names and comments; omitted lists the largest objects. */
  readonly query?: string
  /** Maximum objects returned. */
  readonly limit?: number
}

/** `objects` result. */
export interface ObjectsResult {
  /** Ranked matches. */
  readonly objects: readonly ObjectView[]
  /** Whether the cap clipped the list. */
  readonly truncated: boolean
}

/** `columns` request. */
export interface ColumnsRequest {
  /** Connection identity. */
  readonly connection: string
  /** Object name, as listed by `objects`. */
  readonly object: string
}

/** `columns` result. */
export interface ColumnsResult {
  /** Object name. */
  readonly object: string
  /** Node category. */
  readonly kind: string
  /** Object comment. */
  readonly comment?: string
  /** Columns in declared order. */
  readonly columns: readonly ColumnView[]
  /** Whether a column cap clipped the list. */
  readonly truncated: boolean
}

/** `sql` request. */
export interface SqlRequest {
  /** Connection identity. */
  readonly connection: string
  /** The statement. Executed with the configured row cap and timeout. */
  readonly query: string
  /** Rows requested, overriding the tool default. */
  readonly limit?: number
  /** Statement timeout in milliseconds. */
  readonly timeoutMs?: number
}

/** `impact` / `refs` request. */
export interface ImpactRequest {
  /** Connection identity. */
  readonly connection: string
  /** Object name. */
  readonly object: string
}

/** `refs` request. */
export interface RefsRequest {
  /** Connection identity. */
  readonly connection: string
  /** Object name. */
  readonly object: string
}

/** One edge touching the object a request named. */
export interface RelationView {
  /** Relationship category. */
  readonly kind: EdgeKind
  /** The object on the other end. */
  readonly object: string
  /** Column on this side. */
  readonly column?: string
  /** Column on the other side. */
  readonly refColumn?: string
  /** Constraint or index name. */
  readonly name?: string
}

/** `impact` result. */
export interface ImpactResult {
  /** Object named in the request. */
  readonly object: string
  /** Objects a change to it reaches. */
  readonly entries: readonly RelationView[]
  /** Whether the cap clipped the list. */
  readonly truncated: boolean
}

/** `refs` result. */
export interface RefsResult {
  /** Object named in the request. */
  readonly object: string
  /** Objects referencing it, from the database catalog. */
  readonly entries: readonly RelationView[]
  /** Whether the cap clipped the list. */
  readonly truncated: boolean
}

/** `index` request. */
export interface IndexRequest {
  /** Connection identity, or every configured connection when omitted. */
  readonly connection?: string
  /** Which level to build. `full` runs L1 then L2. */
  readonly mode: 'l1' | 'l2' | 'full'
  /** Sample size for enum values; the connection's own configuration wins when larger. */
  readonly enumSampleLimit?: number
  /** Force the JavaScript writer even when the native one is available. */
  readonly writer?: IndexWriterKind | 'auto'
}

/** The offline half of the seam: read the index, and write it. */
export interface DbgraphStore {
  /** Store identity, for diagnostics and conflict messages. */
  readonly id: string
  /**
   * Absolute directory this store keeps its files under, when it has one. Read by the tool so the
   * prompt digest and the index resolve the same root instead of each deriving its own.
   */
  readonly root?: string
  /** The connections this store's configuration file lists. */
  connections(): Promise<readonly StoredConnection[]>
  /** State of one connection's index. */
  state(connection: string): Promise<IndexState>
  /** Structural overview. */
  schema(request: SchemaRequest): Promise<SchemaResult>
  /** Object listing. */
  objects(request: ObjectsRequest): Promise<ObjectsResult>
  /** Column listing. */
  columns(request: ColumnsRequest): Promise<ColumnsResult>
  /** Resolve a request to a candidate and a `WHERE` plan, without touching the network. */
  resolve(request: FindRequest): Promise<Resolution>
  /** Objects a change reaches. */
  impact(request: ImpactRequest): Promise<ImpactResult>
  /** Objects referencing this one. */
  refs(request: RefsRequest): Promise<RefsResult>
  /** Write a snapshot. Replaces the connection's index atomically. */
  write(connection: ConnectionId, catalog: RawCatalog, options: WriteOptions): Promise<IndexReport>
}

/** What the store needs beyond the catalog itself. */
export interface WriteOptions {
  /** Which writer to prefer. */
  readonly writer: IndexWriterKind | 'auto'
  /** Alias table handed to the writer, so the word table exists in exactly one place. */
  readonly aliases: readonly AliasGroup[]
}

/** The offline answer to a `find` request. */
export interface Resolution {
  /** Why resolution ended where it did. */
  readonly status: FindStatus
  /** Human-readable explanation, forwarded verbatim. */
  readonly reason: string
  /** The chosen candidate, when one was chosen. */
  readonly resolved?: FindCandidate
  /** 0..1 confidence. */
  readonly confidence: number
  /** Ranked alternatives. */
  readonly candidates?: readonly FindCandidate[]
  /** The `WHERE` clause the caller must execute, with `?` placeholders. */
  readonly predicate?: PredicatePlan
}

/** A parameterized predicate the executor binds. */
export interface PredicatePlan {
  /** SQL fragment, starting with `WHERE`, or empty when there is no condition. */
  readonly clause: string
  /** Values bound in placeholder order. */
  readonly values: readonly unknown[]
}

/**
 * One group of words that mean the same column. The table crosses into the native writer as JSON so
 * the vocabulary exists once, in `zh-aliases.ts`, rather than again in Rust.
 */
export interface AliasGroup {
  /** Canonical meaning, e.g. `password`. */
  readonly meaning: string
  /** Words a user may type, e.g. `['密码', '口令', 'passwd', 'pwd']`. */
  readonly words: readonly string[]
}
