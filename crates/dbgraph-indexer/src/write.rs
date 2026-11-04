//! Write the index with bundled SQLite (`rusqlite`).
//!
//! The whole index is one artifact built from nothing: the caller hands over a `.tmp` path, this
//! module deletes whatever was there, creates the schema the caller supplied, and inserts
//! everything inside **one transaction with prepared statements**. The rename that makes it the
//! live index belongs to the caller, so a failed run can never leave a half-built index in place.
//!
//! Three decisions worth knowing:
//!
//! - **The table structure comes from the caller.** `schemaDdl` is executed verbatim
//!   (`packages/service/src/schema.ts` owns it); this file creates no tables of its own. It does
//!   name the tables it writes (`objects`, `columns`, `edges`, `terms`, `search`, `meta`) — that
//!   vocabulary is the contract, not a second copy of the DDL.
//! - **FTS5 is verified before any real work.** A build of SQLite without the module must fail with
//!   one sentence the caller can act on, not with "no such module: fts5" 40 000 inserts in.
//! - **The journal lives in memory and fsync is off.** The target is a temp file that is deleted on
//!   any error and renamed only after `COMMIT`; paying for durability on it would buy nothing and
//!   cost a fsync per few hundred rows.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::model::ResolvedInput;
use crate::plan::Payload;

/// Longest statement echoed back in a schema error.
const MAX_STATEMENT_CHARS: usize = 400;

/// `meta` key holding the on-disk schema version the caller wrote.
const META_SCHEMA_VERSION: &str = "schema_version";
/// `meta` key holding the connection identity.
const META_CONNECTION: &str = "connection";
/// `meta` key holding the database family.
const META_ENGINE: &str = "engine";
/// `meta` key holding the database name.
const META_DATABASE: &str = "database";
/// `meta` key holding the server version, or empty.
const META_SERVER_VERSION: &str = "server_version";
/// `meta` key holding which level the snapshot covers.
const META_LEVEL: &str = "level";
/// `meta` key holding the snapshot's epoch milliseconds.
const META_FETCHED_AT: &str = "fetched_at";
/// `meta` key holding when the structural snapshot was taken.
const META_L1_INDEXED_AT: &str = "l1_indexed_at";
/// `meta` key holding when the enrichment pass completed, or empty.
const META_L2_INDEXED_AT: &str = "l2_indexed_at";
/// `meta` key holding which writer produced the file.
const META_WRITER: &str = "writer";
/// `meta` key holding when this file was written.
const META_WRITTEN_AT: &str = "written_at";

/// The value `meta.writer` carries for this writer.
pub const WRITER_KIND: &str = "rust";

/// Row counts the write produced, as the report carries them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteCounts {
    /// Objects written.
    pub objects: usize,
    /// Columns written.
    pub columns: usize,
    /// Edges written.
    pub edges: usize,
    /// Terms written.
    pub terms: usize,
}

/// Write the index at `input.db_path`, replacing any file already there.
///
/// # Errors
/// A message naming what failed: the FTS5 module, a specific `schemaDdl` statement, or a row
/// family's insert. On any failure the partial file is removed, so a caller that retries never
/// reads a truncated database.
pub fn write_index(
    input: &ResolvedInput,
    payload: &Payload,
    written_at: i64,
) -> Result<WriteCounts, String> {
    let path = input.db_path.as_path();
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    remove_database_files(path);

    let connection = open_writer(path)?;
    let outcome = (|| -> Result<(), String> {
        verify_fts5(&connection)?;
        create_schema(&connection, &input.schema_ddl)?;
        insert_all(&connection, input, payload, written_at)
    })();
    if let Err(error) = outcome {
        drop(connection);
        remove_database_files(path);
        return Err(error);
    }

    let counts = verify_counts(&connection, payload)?;
    drop(connection);
    Ok(counts)
}

/// Open the `.tmp` index with the pragmas a one-shot artifact wants.
fn open_writer(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("open {}: {error}", path.display()))?;
    connection
        .execute_batch(
            // The staging file is disposable until it is renamed: there is no reader to protect and
            // no transaction to replay, so durability would cost a fsync per few hundred rows and buy
            // nothing. `journal_mode = OFF` matches the JavaScript writer; the file is deleted on any
            // error, so a half-written database can never be mistaken for an index.
            "PRAGMA journal_mode = OFF;
             PRAGMA synchronous = OFF;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -65536;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|error| format!("pragmas on {}: {error}", path.display()))?;
    Ok(connection)
}

/// Fail early and specifically when this SQLite build cannot make an FTS5 table.
///
/// A probe table rather than a `SELECT fts5(?)`: the probe exercises what the writer actually
/// needs — creating the virtual table — and its error text names the real problem.
fn verify_fts5(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("CREATE VIRTUAL TABLE fts5_probe USING fts5 (x);")
        .map_err(|error| {
            format!(
                "this SQLite build cannot create an FTS5 table, so the search index cannot be \
                 written: {error}"
            )
        })?;
    connection
        .execute_batch("DROP TABLE fts5_probe;")
        .map_err(|error| format!("drop the FTS5 probe table: {error}"))
}

/// Create every table the caller's schema declares, in the order given.
fn create_schema(connection: &Connection, schema_ddl: &[String]) -> Result<(), String> {
    for (index, statement) in schema_ddl.iter().enumerate() {
        connection.execute_batch(statement).map_err(|error| {
            let bounded: String = statement.chars().take(MAX_STATEMENT_CHARS).collect();
            format!("schemaDdl[{index}] failed: {error}\nstatement: {bounded}")
        })?;
    }
    Ok(())
}

/// Insert everything inside one transaction.
fn insert_all(
    connection: &Connection,
    input: &ResolvedInput,
    payload: &Payload,
    written_at: i64,
) -> Result<(), String> {
    connection
        .execute_batch("BEGIN IMMEDIATE;")
        .map_err(|error| format!("begin transaction: {error}"))?;
    let outcome = insert_rows(connection, input, payload, written_at);
    match outcome {
        Ok(()) => connection
            .execute_batch("COMMIT;")
            .map_err(|error| format!("commit: {error}")),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

/// The transactional half of [`insert_all`].
fn insert_rows(
    connection: &Connection,
    input: &ResolvedInput,
    payload: &Payload,
    written_at: i64,
) -> Result<(), String> {
    let level = input.catalog.level.as_str();
    // Both timestamps are the snapshot's own time: that is when the structure in this file was read
    // off the server, which is what the reference writer records too. `l2_indexed_at` exists only
    // after an enrichment pass.
    let fetched_at_text = snapshot_text(input.catalog.fetched_at);

    // A key whose value the run does not know is **omitted**, not written empty: the store's reader
    // treats an absent key as unknown, while `''` would coerce to epoch zero and read as "indexed in
    // 1970". `schema.ts` documents exactly this ("absent on an L1-only file"). `connection` is the
    // exception — it is always present, as the reference writer writes it, empty when the caller did
    // not name one.
    let mut entries: Vec<(&str, String)> = vec![
        (META_SCHEMA_VERSION, input.schema_version.to_string()),
        (META_CONNECTION, input.connection.clone()),
        (META_ENGINE, input.catalog.engine.clone()),
        (META_DATABASE, input.catalog.database.clone()),
        (META_LEVEL, level.to_owned()),
        (META_FETCHED_AT, fetched_at_text.clone()),
        (META_L1_INDEXED_AT, fetched_at_text.clone()),
        (META_WRITER, WRITER_KIND.to_owned()),
        (META_WRITTEN_AT, written_at.to_string()),
    ];
    if let Some(version) = crate::model::non_empty(&input.catalog.server_version) {
        entries.push((META_SERVER_VERSION, version.to_owned()));
    }
    if level == "l2" {
        entries.push((META_L2_INDEXED_AT, fetched_at_text));
    }

    let mut insert_meta = connection
        .prepare("INSERT INTO meta (key, value) VALUES (?1, ?2)")
        .map_err(database_error)?;
    for (key, value) in entries {
        insert_meta
            .execute(params![key, value])
            .map_err(|error| format!("meta `{key}`: {error}"))?;
    }

    let mut insert_object = connection
        .prepare(
            "INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(database_error)?;
    for row in &payload.objects {
        insert_object
            .execute(params![
                row.id,
                row.kind,
                row.schema,
                row.name,
                row.comment,
                row.row_estimate,
                row.updated_at,
            ])
            .map_err(|error| format!("object `{}`: {error}", row.name))?;
    }

    let mut insert_column = connection
        .prepare(
            "INSERT INTO columns
               (id, object_id, ordinal, name, type, type_class, nullable, default_value, comment,
                is_primary_key, is_unique, enum_values_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )
        .map_err(database_error)?;
    for row in &payload.columns {
        insert_column
            .execute(params![
                row.id,
                row.object_id,
                row.ordinal,
                row.name,
                row.type_name,
                row.type_class,
                if row.nullable { 1 } else { 0 },
                row.default_value,
                row.comment,
                if row.is_primary_key { 1 } else { 0 },
                if row.is_unique { 1 } else { 0 },
                row.enum_values_json,
                row.updated_at,
            ])
            .map_err(|error| format!("column `{}` of object {}: {error}", row.name, row.object_id))?;
    }

    let mut insert_edge = connection
        .prepare(
            "INSERT INTO edges (src_object, src_column_id, kind, dst_object, dst_column_id, name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(database_error)?;
    for row in &payload.edges {
        insert_edge
            .execute(params![
                row.src_object,
                row.src_column,
                row.kind,
                row.dst_object,
                row.dst_column,
                row.name,
            ])
            .map_err(|error| format!("edge from object {}: {error}", row.src_object))?;
    }

    let mut insert_term = connection
        .prepare("INSERT INTO terms (term, weight, object_id, column_id) VALUES (?1, ?2, ?3, ?4)")
        .map_err(database_error)?;
    for row in &payload.terms {
        insert_term
            .execute(params![row.term, row.weight, row.object_id, row.column_id])
            .map_err(|error| format!("term `{}`: {error}", row.term))?;
    }

    // Keyset-ordered inserts: `search` is a plain FTS5 table, and the two `UNINDEXED` columns are
    // the row's identity — `content = ''` would read them back as NULL, which is exactly why the
    // shared schema does not use a contentless table.
    let mut insert_search = connection
        .prepare("INSERT INTO search (text, object_id, column_id) VALUES (?1, ?2, ?3)")
        .map_err(database_error)?;
    for row in &payload.search {
        insert_search
            .execute(params![row.text, row.object_id, row.column_id])
            .map_err(|error| {
                format!(
                    "search row for object {:?} column {:?}: {error}",
                    row.object_id, row.column_id
                )
            })?;
    }
    Ok(())
}

/// Count what actually landed and compare it with the plan.
///
/// The counts come back from the database rather than from the plan, so the report describes the
/// file that exists. A mismatch is a bug in this writer, not in the input, and says so.
fn verify_counts(connection: &Connection, payload: &Payload) -> Result<WriteCounts, String> {
    let objects = count(connection, "SELECT COUNT(*) FROM objects")?;
    let columns = count(connection, "SELECT COUNT(*) FROM columns")?;
    let edges = count(connection, "SELECT COUNT(*) FROM edges")?;
    let terms = count(connection, "SELECT COUNT(*) FROM terms")?;
    let search = count(connection, "SELECT COUNT(*) FROM search")?;

    compare("objects", objects, payload.objects.len())?;
    compare("columns", columns, payload.columns.len())?;
    compare("edges", edges, payload.edges.len())?;
    compare("terms", terms, payload.terms.len())?;
    compare("search", search, payload.search.len())?;

    Ok(WriteCounts {
        objects: objects as usize,
        columns: columns as usize,
        edges: edges as usize,
        terms: terms as usize,
    })
}

fn compare(table: &str, written: i64, planned: usize) -> Result<(), String> {
    if written as usize != planned {
        return Err(format!(
            "index integrity: planned {planned} rows in `{table}` but the file holds {written}"
        ));
    }
    Ok(())
}

fn count(connection: &Connection, sql: &str) -> Result<i64, String> {
    connection
        .query_row(sql, [], |row| row.get(0))
        .map_err(database_error)
}

/// The snapshot's epoch milliseconds as `meta` stores them, or empty when it is not a number.
fn snapshot_text(fetched_at: f64) -> String {
    if fetched_at.is_finite() && fetched_at >= 0.0 {
        (fetched_at.floor() as i64).to_string()
    } else {
        String::new()
    }
}

/// Epoch milliseconds now. One call per run, so every timestamp in the file agrees.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Remove a database file and any journal sibling a previous failed run left behind.
fn remove_database_files(path: &Path) {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let mut target = path.as_os_str().to_os_string();
        target.push(suffix);
        let _ = fs::remove_file(target);
    }
}

fn database_error(error: rusqlite::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::verify_fts5;

    #[test]
    fn bundled_sqlite_has_fts5() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory database");
        verify_fts5(&connection).expect("FTS5 is compiled into the bundled SQLite");
    }
}
