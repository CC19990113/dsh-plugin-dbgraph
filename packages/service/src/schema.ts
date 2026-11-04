/**
 * The on-disk index format: where the files live, the schema version, the DDL, and the sidecar the
 * system prompt reads synchronously.
 *
 * Three files, all under the global index root (`~/.dsh/dbgraph`):
 *
 * - `connections.json` — the connection list. Structure and host facts only; every secret lives in
 *   the host's credential seam, referenced by name.
 * - `<connection>/index.db` — one SQLite file per connection, replaced wholesale on every run. That
 *   single decision removes a whole class of bugs: no incremental diffing, no deletes, no
 *   half-updated index. A run writes `<connection>/index.db.tmp` and renames it into place.
 * - `status.json` — a digest of every connection's index state plus its object list, small enough to
 *   read synchronously on every prompt assembly. It exists so the model learns the schema without
 *   spending a tool call, and so nothing opens SQLite during assembly.
 *
 * The index holds structure and never a business value. The one data-derived field anywhere is
 * `columns.enum_values_json`, a bounded sample of distinct literals (see `DEFAULT_ENUM_SAMPLE_LIMIT`).
 * @module dsh-plugin-dbgraph-service/schema
 */

/** Directory name under the harness home that holds every dbgraph file. */
export const INDEX_ROOT_DIRNAME = 'dbgraph'

/** File name of one connection's index, inside its own directory. */
export const INDEX_FILE_NAME = 'index.db'

/** The connection list, inside the index root. */
export const CONNECTIONS_FILE_NAME = 'connections.json'

/** The prompt digest sidecar, inside the index root. */
export const STATUS_FILE_NAME = 'status.json'

/** Schema version stored in `meta.schema_version`. A store refuses a file it does not know. */
export const INDEX_SCHEMA_VERSION = 1

/** Default number of distinct literals sampled per column for `columns.enum_values_json`. */
export const DEFAULT_ENUM_SAMPLE_LIMIT = 10

/**
 * Default object count carried in `status.json` for the prompt digest. A connection with more
 * objects than this lists the largest ones and says how many were left out.
 */
export const DEFAULT_STATUS_DIGEST_OBJECTS = 120

/** Default hours after which an L2 snapshot is called stale in the prompt. */
export const DEFAULT_INDEX_STALE_HOURS = 6

/**
 * The statements that create a fresh index. Applied in order inside one transaction; the writer
 * executes them against a `.tmp` file that only becomes the index after the rename.
 *
 * `search` is FTS5 *contentless*: the index is replaced wholesale on every run, so nothing is ever
 * deleted, and a contentless table stores only what is needed to rank — roughly 40% smaller than the
 * same rows with their text. Ranking is the only thing it is used for; the readable text lives in
 * `objects` and `columns`.
 */
export const INDEX_SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS objects (
     id           INTEGER PRIMARY KEY,
     kind         TEXT    NOT NULL,
     schema_name  TEXT    NOT NULL DEFAULT '',
     name         TEXT    NOT NULL,
     comment      TEXT,
     row_estimate INTEGER,
     updated_at   INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS objects_identity ON objects (schema_name, name)`,

  `CREATE TABLE IF NOT EXISTS columns (
     id               INTEGER PRIMARY KEY,
     object_id        INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
     ordinal          INTEGER NOT NULL,
     name             TEXT    NOT NULL,
     type             TEXT    NOT NULL,
     type_class       TEXT    NOT NULL,
     nullable         INTEGER NOT NULL DEFAULT 1,
     default_value    TEXT,
     comment          TEXT,
     is_primary_key   INTEGER NOT NULL DEFAULT 0,
     is_unique        INTEGER NOT NULL DEFAULT 0,
     enum_values_json TEXT,
     updated_at       INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS columns_identity ON columns (object_id, name)`,

  `CREATE TABLE IF NOT EXISTS edges (
     id             INTEGER PRIMARY KEY,
     src_object     INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
     src_column_id  INTEGER REFERENCES columns (id) ON DELETE CASCADE,
     kind           TEXT    NOT NULL,
     dst_object     INTEGER REFERENCES objects (id) ON DELETE CASCADE,
     dst_column_id  INTEGER REFERENCES columns (id) ON DELETE CASCADE,
     name           TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS edges_src ON edges (src_object)`,
  `CREATE INDEX IF NOT EXISTS edges_dst ON edges (dst_object)`,

  `CREATE TABLE IF NOT EXISTS terms (
     term      TEXT    NOT NULL,
     weight    REAL    NOT NULL,
     object_id INTEGER REFERENCES objects (id) ON DELETE CASCADE,
     column_id INTEGER REFERENCES columns (id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS terms_term ON terms (term)`,

  // FTS5, contentful, with the two identity columns declared UNINDEXED.
  //
  // Two facts were measured on node v22.21.0 / SQLite 3.50.4 rather than assumed, and they pick this
  // shape over the alternatives:
  //
  // 1. A **contentless** table (`content = ''`) answers with rowid and rank only — every declared
  //    column, UNINDEXED ones included, reads back as NULL. Storing `object_id`/`column_id` there is
  //    useless, so a contentless design has to smuggle identity through rowid.
  // 2. A **contentful** table with `object_id UNINDEXED` returns those columns verbatim
  //    (`{rowid: 7, object_id: 3, column_id: 42}`). UNINDEXED means "stored but not tokenized", not
  //    "stored but unreadable".
  //
  // So: one table, readable ids, no rowid arithmetic. The size a contentless table would save does not
  // pay for that.
  //
  // Note the FTS5 column grammar while adding a column: `column-name [UNINDEXED]`. A type name in
  // front of UNINDEXED is a parse error (`parse error in "object_id INTEGER UNINDEXED"`).
  //
  // `text` is **not** the raw name and comment — it is the token stream {@link tokenizeForSearch}
  // produces, because unicode61 treats a run of CJK as one token: store `广告点击` verbatim and a
  // search for `广告` matches nothing. Verified.
  `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (
     text,
     object_id UNINDEXED,
     column_id UNINDEXED,
     tokenize = 'unicode61'
   )`,
]

/**
 * The `meta` keys every writer writes and every reader looks up. One list, so the JavaScript and the
 * native writer cannot drift: the reader treats an absent key as unknown rather than as a default.
 */
export const INDEX_META_KEYS = {
  /** {@link INDEX_SCHEMA_VERSION} the file was written for. */
  schemaVersion: 'schema_version',
  /** Connection id the file describes. */
  connection: 'connection',
  /** Database family. */
  engine: 'engine',
  /** Database name, or file path. */
  database: 'database',
  /** Server version string, when the server reported one. */
  serverVersion: 'server_version',
  /** `l1` or `l2` — which level the snapshot covers. */
  level: 'level',
  /** Epoch milliseconds when the snapshot was taken off the server. */
  fetchedAt: 'fetched_at',
  /** Epoch milliseconds of the last structural snapshot. */
  l1IndexedAt: 'l1_indexed_at',
  /** Epoch milliseconds of the last enrichment pass; absent on an L1-only file. */
  l2IndexedAt: 'l2_indexed_at',
  /** `js` or `rust` — which writer produced this file. */
  writer: 'writer',
  /** Epoch milliseconds when the file was written. */
  writtenAt: 'written_at',
} as const

/** One entry of the prompt digest: everything needed to name a table without a query. */
export interface StatusDigestEntry {
  /** Object name, schema-qualified when the engine has a schema. */
  readonly object: string
  /** Object comment, when indexed. */
  readonly comment?: string
  /** Column count. */
  readonly columns: number
}

/** One connection's state as the prompt sees it. */
export interface StatusConnectionEntry {
  /** Database family, for the sentence's parenthetical. */
  readonly engine: string
  /** Human label, when configured. */
  readonly label?: string
  /** Epoch milliseconds of the last structural snapshot. */
  readonly l1IndexedAt?: number
  /** Epoch milliseconds of the last enrichment pass. */
  readonly l2IndexedAt?: number
  /** Objects in the index. */
  readonly objects: number
  /** Columns in the index. */
  readonly columns: number
  /** Fraction of columns carrying a comment, 0..1. */
  readonly commentCoverage: number
  /** Largest objects, capped at `DEFAULT_STATUS_DIGEST_OBJECTS`. */
  readonly digest: readonly StatusDigestEntry[]
  /** Objects left out of {@link digest}. */
  readonly digestOmitted: number
}

/**
 * The sidecar `status.json` holds. Written after the index rename, so a reader never describes an
 * index that is not there yet.
 */
export interface StatusFile {
  /** Format version. A reader that sees a newer one falls back to the weaker sentence. */
  readonly version: number
  /** Epoch milliseconds of the last write. */
  readonly updatedAt: number
  /** Per-connection entries, keyed by connection id. */
  readonly connections: Readonly<Record<string, StatusConnectionEntry>>
}

/** One persisted connection, as `connections.json` stores it. Never carries a secret. */
export interface StoredConnection {
  /** Connection identity. */
  readonly id: string
  /** Database family. */
  readonly engine: string
  /** Human label. */
  readonly label?: string
  /** Host. */
  readonly host?: string
  /** Port. */
  readonly port?: number
  /** Database name, file path, or Redis database index. */
  readonly database?: string
  /** Login user. */
  readonly user?: string
  /** Credential-seam reference holding the password. */
  readonly credentialRef?: string
  /** Sensitive-column handling for this connection. */
  readonly sensitiveColumns?: string
  /** Extra sensitive column patterns. */
  readonly sensitivePatterns?: readonly string[]
  /** Epoch milliseconds when the connection was added. */
  readonly addedAt?: number
}

/** The `connections.json` document. */
export interface ConnectionsFile {
  /** Format version. */
  readonly version: number
  /** Configured connections, in the order the user arranged them. */
  readonly connections: readonly StoredConnection[]
}
