//! The kernel end to end: a catalog in, a real SQLite file out, read back row by row.
//!
//! These tests call [`dbgraph_indexer::build`] directly — no Node process — because the napi layer
//! is a thin transport and the behaviour worth testing is the payload the file holds. Two of them
//! are the ones that would otherwise rot silently:
//!
//! - `rebuilding_is_deterministic`: the same catalog written twice must produce identical rows. The
//!   plan is built on rayon and term merging goes through a `HashMap`, so this is what keeps the
//!   output from depending on thread scheduling or hash order. `updated_at` is excluded because it
//!   is the run's own wall clock — the one field a rebuild is *supposed* to change, exactly as the
//!   reference writer stamps it.
//! - `both_transports_produce_the_same_index`: the object transport and the `…Json` fast path must
//!   be indistinguishable in the file they write.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use dbgraph_indexer::{build, BuildIndexInput, BuildReport};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

/// Fixture directory, resolved at compile time so the tests run from any working directory.
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

fn read_fixture(name: &str) -> String {
    let path = fixtures().join(name);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// The shared contract as the fixture recorded it.
struct Fixture {
    schema_ddl: Vec<String>,
    schema_version: f64,
    catalog: Value,
    aliases: Value,
}

fn fixture() -> Fixture {
    let document: Value =
        serde_json::from_str(&read_fixture("catalog.json")).expect("catalog.json is valid JSON");
    let schema_ddl: Vec<String> = serde_json::from_str(&read_fixture("schema-ddl.json"))
        .expect("schema-ddl.json is a JSON array of strings");
    Fixture {
        schema_ddl,
        schema_version: document["contract"]["schemaVersion"]
            .as_f64()
            .expect("schemaVersion is a number"),
        catalog: document["catalog"].clone(),
        aliases: document["aliases"].clone(),
    }
}

/// A directory that removes itself, so a failing test leaves nothing behind.
struct TempDir {
    path: PathBuf,
}

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

impl TempDir {
    fn new(label: &str) -> Self {
        let unique = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "dbgraph-indexer-{}-{label}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create the test directory");
        Self { path }
    }

    fn index_path(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// The fixed write timestamp every test uses, so the files are reproducible and `updated_at` can be
/// compared like any other column.
const FIXED_NOW: f64 = 1_700_000_000_500.0;

/// Input carrying the fixture's catalog as a JS-object equivalent.
fn object_input(db_path: &Path, fixture: &Fixture) -> BuildIndexInput {
    BuildIndexInput {
        db_path: db_path.to_string_lossy().into_owned(),
        schema_ddl: fixture.schema_ddl.clone(),
        catalog: Some(fixture.catalog.clone()),
        aliases: Some(fixture.aliases.clone()),
        catalog_json: None,
        aliases_json: None,
        schema_version: fixture.schema_version,
        connection: Some("fixture".to_owned()),
        now: Some(FIXED_NOW),
    }
}

/// Input carrying the same catalog as JSON text.
fn json_input(db_path: &Path, fixture: &Fixture) -> BuildIndexInput {
    BuildIndexInput {
        db_path: db_path.to_string_lossy().into_owned(),
        schema_ddl: fixture.schema_ddl.clone(),
        catalog: None,
        aliases: None,
        catalog_json: Some(fixture.catalog.to_string()),
        aliases_json: Some(fixture.aliases.to_string()),
        schema_version: fixture.schema_version,
        connection: Some("fixture".to_owned()),
        now: Some(FIXED_NOW),
    }
}

fn build_report(mut input: BuildIndexInput) -> Result<BuildReport, String> {
    build(&mut input)
}

fn open(path: &Path) -> Connection {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap_or_else(|error| panic!("open {}: {error}", path.display()))
}

fn count(connection: &Connection, table: &str) -> i64 {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
        .expect("count rows")
}

/// Every row of the four comparable tables, as text, in a stable order.
///
/// Every column is compared, `updated_at` included: the tests pass a fixed `now`, so a rebuild over
/// the same catalog must reproduce it. `search` is left out: its rows carry FTS5 rowids, an
/// implementation detail of insertion order.
fn dump(connection: &Connection) -> BTreeMap<String, Vec<String>> {
    let mut tables: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (table, projection) in [
        (
            "objects",
            "id, kind, schema_name, name, comment, row_estimate, updated_at",
        ),
        (
            "columns",
            "id, object_id, ordinal, name, type, type_class, nullable, default_value, comment, \
             is_primary_key, is_unique, enum_values_json, updated_at",
        ),
        (
            "edges",
            "id, src_object, src_column_id, kind, dst_object, dst_column_id, name",
        ),
        ("terms", "term, weight, object_id, column_id"),
    ] {
        let order = if table == "terms" {
            "term, object_id, column_id"
        } else {
            "id"
        };
        let mut statement = connection
            .prepare(&format!("SELECT {projection} FROM {table} ORDER BY {order}"))
            .expect("prepare dump");
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                let mut cells: Vec<String> = Vec::with_capacity(columns);
                for index in 0..columns {
                    let value: rusqlite::types::Value = row.get(index)?;
                    cells.push(format!("{value:?}"));
                }
                Ok(cells.join("|"))
            })
            .expect("query dump")
            .collect::<Result<Vec<String>, _>>()
            .expect("read dump");
        tables.insert(table.to_owned(), rows);
    }
    tables
}

#[test]
fn writes_the_fixture_and_reports_its_counts() {
    let fixture = fixture();
    let directory = TempDir::new("counts");
    let path = directory.index_path("index.db");

    let report = build_report(object_input(&path, &fixture)).expect("build the fixture");

    // 7 objects; columns 6 + 6 + 4 + 2 + 2 + 11 + 300.
    assert_eq!(report.objects, 7);
    assert_eq!(report.columns, 331);
    // sys_user's unique index (1) + order's fk and two-column index (1 + 2) + order_item's composite
    // fk (2) + the view's object-level reference (1). `order`'s fk to `region` is dropped: the target
    // is not in this snapshot, and a row with no usable target is what the reference writer refuses.
    assert_eq!(report.edges, 7);
    assert!(report.terms > 0, "terms are written");
    assert!(report.elapsed_ms > 0.0, "elapsed time is measured");

    let connection = open(&path);
    assert_eq!(count(&connection, "objects"), 7);
    assert_eq!(count(&connection, "columns"), 331);
    assert_eq!(count(&connection, "edges"), 7);
    assert_eq!(count(&connection, "terms") as u32, report.terms);
    // One document per object and one per column, whether or not the document holds a token.
    assert_eq!(count(&connection, "search"), 7 + 331);
}

#[test]
fn writes_the_contract_rows() {
    let fixture = fixture();
    let directory = TempDir::new("rows");
    let path = directory.index_path("index.db");
    build_report(object_input(&path, &fixture)).expect("build the fixture");
    let connection = open(&path);

    // Objects: ids follow catalog order; a missing schema is stored as an empty string.
    let (kind, schema, name, comment, rows): (String, String, String, Option<String>, Option<i64>) =
        connection
            .query_row(
                "SELECT kind, schema_name, name, comment, row_estimate FROM objects WHERE id = 3",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("object 3");
    assert_eq!(kind, "table");
    assert_eq!(schema, "");
    assert_eq!(name, "order_item");
    assert_eq!(comment, None);
    assert_eq!(rows, None);

    // `updated_at` is the write's own timestamp — the same value `meta.written_at` carries, so the
    // two can never disagree — and a caller-supplied `now` is what it carries.
    let (updated_at, written_at): (i64, String) = connection
        .query_row(
            "SELECT (SELECT updated_at FROM objects WHERE id = 1), \
                    (SELECT value FROM meta WHERE key = 'written_at')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("timestamps");
    assert_eq!(updated_at.to_string(), written_at);
    assert_eq!(updated_at, FIXED_NOW as i64, "the caller's `now` is what is stamped");

    let comment: Option<String> = connection
        .query_row("SELECT comment FROM objects WHERE id = 1", [], |row| row.get(0))
        .expect("object 1 comment");
    assert_eq!(comment.as_deref(), Some("系统用户"));

    // Type classes, one per family the fixture names.
    let classes: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT name, type_class FROM columns WHERE object_id = 6 ORDER BY ordinal")
            .expect("prepare type classes");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query type classes")
            .collect::<Result<Vec<_>, _>>()
            .expect("read type classes")
    };
    assert_eq!(
        classes,
        vec![
            ("c_int".to_owned(), "integer".to_owned()),
            ("c_bool".to_owned(), "bool".to_owned()),
            ("c_decimal".to_owned(), "decimal".to_owned()),
            ("c_string".to_owned(), "string".to_owned()),
            ("c_text".to_owned(), "text".to_owned()),
            ("c_datetime".to_owned(), "datetime".to_owned()),
            ("c_json".to_owned(), "json".to_owned()),
            ("c_binary".to_owned(), "binary".to_owned()),
            ("c_array".to_owned(), "integer".to_owned()),
            ("c_custom".to_owned(), "unknown".to_owned()),
            ("c_empty".to_owned(), "unknown".to_owned()),
        ]
    );

    // A primary-key column is recorded as NOT NULL, and the declared type survives verbatim.
    let (nullable, is_primary_key, declared): (i64, i64, String) = connection
        .query_row(
            "SELECT nullable, is_primary_key, type FROM columns WHERE object_id = 1 AND name = 'id'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("sys_user.id");
    assert_eq!(nullable, 0);
    assert_eq!(is_primary_key, 1);
    assert_eq!(declared, "bigint unsigned");

    // The wide table holds every column at its declared ordinal.
    let wide: (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), MAX(ordinal) FROM columns WHERE object_id = 7",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("wide_row");
    assert_eq!(wide, (300, 300));

    // Enum samples are stored as the JSON array string the contract asks for.
    let enum_values: Option<String> = connection
        .query_row(
            "SELECT enum_values_json FROM columns WHERE object_id = 2 AND name = 'status'",
            [],
            |row| row.get(0),
        )
        .expect("order.status");
    assert_eq!(
        enum_values.as_deref(),
        Some("[\"paid\",\"pending\",\"refunded\"]")
    );

    // A composite foreign key becomes one row per column pair, paired by position.
    let mut statement = connection
        .prepare(
            "SELECT src_column_id, dst_object, dst_column_id FROM edges
              WHERE name = 'fk_item_order' ORDER BY src_column_id",
        )
        .expect("prepare composite fk");
    let pairs: Vec<(Option<i64>, Option<i64>, Option<i64>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query composite fk")
        .collect::<Result<Vec<_>, _>>()
        .expect("read composite fk");
    assert_eq!(pairs.len(), 2, "one row per column pair");
    for (source, target, target_column) in pairs {
        assert!(source.is_some(), "the source column exists in the catalog");
        assert_eq!(target, Some(2), "shop.order is object 2");
        assert_eq!(target_column, Some(7), "order.id is column id 7");
    }

    // An edge into a table outside this snapshot is dropped, matching the reference writer.
    let dangling: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM edges WHERE name = 'fk_order_region'",
            [],
            |row| row.get(0),
        )
        .expect("dangling edge count");
    assert_eq!(dangling, 0);

    // An object-level `view_ref` names no column on either side but does resolve its target.
    let view: (Option<i64>, Option<i64>, String) = connection
        .query_row(
            "SELECT src_column_id, dst_object, kind FROM edges WHERE kind = 'view_ref'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("view reference");
    assert_eq!(view, (None, Some(2), "view_ref".to_owned()));
}

#[test]
fn writes_the_contract_meta_keys() {
    let fixture = fixture();
    let directory = TempDir::new("meta");
    let path = directory.index_path("index.db");
    build_report(object_input(&path, &fixture)).expect("build the fixture");
    let connection = open(&path);

    let mut statement = connection
        .prepare("SELECT key, value FROM meta ORDER BY key")
        .expect("prepare meta");
    let meta: BTreeMap<String, String> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query meta")
        .collect::<Result<_, _>>()
        .expect("read meta");

    assert_eq!(meta.get("schema_version").map(String::as_str), Some("1"));
    assert_eq!(meta.get("connection").map(String::as_str), Some("fixture"));
    assert_eq!(meta.get("engine").map(String::as_str), Some("mysql"));
    assert_eq!(meta.get("database").map(String::as_str), Some("shop"));
    assert_eq!(meta.get("server_version").map(String::as_str), Some("8.0.36"));
    assert_eq!(meta.get("level").map(String::as_str), Some("l2"));
    assert_eq!(meta.get("fetched_at").map(String::as_str), Some("1700000000000"));
    assert_eq!(
        meta.get("l1_indexed_at").map(String::as_str),
        Some("1700000000000")
    );
    // An L2 run records the enrichment time as the snapshot's own.
    assert_eq!(
        meta.get("l2_indexed_at").map(String::as_str),
        Some("1700000000000")
    );
    assert_eq!(meta.get("writer").map(String::as_str), Some("rust"));
    assert!(
        meta.get("written_at").is_some_and(|value| !value.is_empty()),
        "written_at is always recorded"
    );

    // An L1 run must not claim an enrichment pass happened: the key is absent, not empty.
    let mut l1_catalog = fixture.catalog.clone();
    l1_catalog["level"] = json!("l1");
    let l1_path = directory.index_path("l1.db");
    let mut input = object_input(&l1_path, &fixture);
    input.catalog = Some(l1_catalog);
    build_report(input).expect("build an l1 index");
    let l1_connection = open(&l1_path);
    let l2: Option<String> = l1_connection
        .query_row("SELECT value FROM meta WHERE key = 'l2_indexed_at'", [], |row| {
            row.get(0)
        })
        .optional()
        .expect("l2_indexed_at lookup on an l1 file");
    assert_eq!(
        l2, None,
        "an l1 file omits l2_indexed_at instead of writing an empty value"
    );
}

#[test]
fn token_streams_are_queryable_through_fts5() {
    let fixture = fixture();
    let directory = TempDir::new("search");
    let path = directory.index_path("index.db");
    build_report(object_input(&path, &fixture)).expect("build the fixture");
    let connection = open(&path);

    // The object document is the tokenizer's output, name first, comment second.
    let document: String = connection
        .query_row(
            "SELECT text FROM search WHERE object_id = 1 AND column_id IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("sys_user document");
    assert_eq!(document, "sys user 系统 统用 用户");

    // A CJK bigram from the comment reaches the row — the whole reason the text is pre-tokenized.
    let hits: i64 = connection
        .query_row(
            r#"SELECT COUNT(*) FROM search WHERE search MATCH '"用户"'"#,
            [],
            |row| row.get(0),
        )
        .expect("FTS match 用户");
    assert!(hits >= 1, "the bigram 用户 matches at least one row");

    // A column document carries only its column id, as the reference writer writes it.
    let (object_id, column_id): (Option<i64>, Option<i64>) = connection
        .query_row(
            r#"SELECT object_id, column_id FROM search WHERE search MATCH '"密码"'"#,
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("FTS match 密码");
    assert_eq!(object_id, None, "a column document carries no object id");
    assert_eq!(column_id, Some(3), "login_pwd is the third column of sys_user");
}

#[test]
fn terms_carry_the_alias_vocabulary() {
    let fixture = fixture();
    let directory = TempDir::new("terms");
    let path = directory.index_path("index.db");
    build_report(object_input(&path, &fixture)).expect("build the fixture");
    let connection = open(&path);

    // `login_pwd` — the name tokens `login` and `pwd` select two alias groups, so every word of both
    // enters at the column-alias weight (0.65), which is below an ASCII name token (0.9) and above a
    // CJK comment bigram (0.5).
    let mut statement = connection
        .prepare(
            "SELECT term, weight FROM terms
              WHERE object_id = 1 AND column_id = 3 AND term IN ('pwd', '密码', 'password', '登录')",
        )
        .expect("prepare terms");
    let terms: BTreeMap<String, f64> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query terms")
        .collect::<Result<_, _>>()
        .expect("read terms");
    assert_eq!(terms.get("pwd"), Some(&0.9), "the name token itself");
    assert_eq!(terms.get("密码"), Some(&0.65), "an alias word");
    assert_eq!(terms.get("password"), Some(&0.65), "every word of the group enters");
    assert_eq!(
        terms.get("登录"),
        Some(&0.65),
        "the login group is selected by the name token `login`"
    );

    // Object-level terms have no column id; the name weighs 1.0 and an alias expansion 0.6.
    let object_terms: BTreeMap<String, f64> = {
        let mut statement = connection
            .prepare("SELECT term, weight FROM terms WHERE object_id = 3 AND column_id IS NULL")
            .expect("prepare object terms");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query object terms")
            .collect::<Result<_, _>>()
            .expect("read object terms")
    };
    assert_eq!(object_terms.get("order"), Some(&1.0));
    assert_eq!(object_terms.get("item"), Some(&1.0));
    assert_eq!(object_terms.get("订单"), Some(&0.6), "an alias word on the object");

    // No term row is written twice for the same target.
    let duplicates: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM (
               SELECT term, object_id, IFNULL(column_id, -1) AS column_id, COUNT(*) AS n
                 FROM terms GROUP BY term, object_id, IFNULL(column_id, -1) HAVING n > 1)",
            [],
            |row| row.get(0),
        )
        .expect("duplicate check");
    assert_eq!(duplicates, 0);
}

#[test]
fn rebuilding_is_deterministic() {
    let fixture = fixture();
    let directory = TempDir::new("deterministic");
    let first = directory.index_path("first.db");
    let second = directory.index_path("second.db");

    let first_report = build_report(object_input(&first, &fixture)).expect("first build");
    let second_report = build_report(object_input(&second, &fixture)).expect("second build");
    assert_eq!(first_report.objects, second_report.objects);
    assert_eq!(first_report.columns, second_report.columns);
    assert_eq!(first_report.edges, second_report.edges);
    assert_eq!(first_report.terms, second_report.terms);

    let first_dump = dump(&open(&first));
    let second_dump = dump(&open(&second));
    assert_eq!(
        first_dump, second_dump,
        "the same catalog produces the same rows (apart from the write timestamp)"
    );
}

#[test]
fn both_transports_produce_the_same_index() {
    let fixture = fixture();
    let directory = TempDir::new("transports");
    let from_object = directory.index_path("object.db");
    let from_json = directory.index_path("json.db");

    let object_report = build_report(object_input(&from_object, &fixture)).expect("object input");
    let json_report = build_report(json_input(&from_json, &fixture)).expect("json input");
    assert_eq!(object_report.objects, json_report.objects);
    assert_eq!(object_report.columns, json_report.columns);
    assert_eq!(object_report.edges, json_report.edges);
    assert_eq!(object_report.terms, json_report.terms);
    assert_eq!(dump(&open(&from_object)), dump(&open(&from_json)));
}

#[test]
fn rejects_bad_input_with_a_readable_message() {
    let fixture = fixture();
    let directory = TempDir::new("errors");
    let path = directory.index_path("index.db");

    let empty_path = build_report({
        let mut input = object_input(&path, &fixture);
        input.db_path = "   ".to_owned();
        input
    })
    .expect_err("an empty dbPath is rejected");
    assert!(empty_path.contains("dbPath is required"), "{empty_path}");

    let empty_ddl = build_report({
        let mut input = object_input(&path, &fixture);
        input.schema_ddl = Vec::new();
        input
    })
    .expect_err("an empty schemaDdl is rejected");
    assert!(empty_ddl.contains("schemaDdl is empty"), "{empty_ddl}");

    let missing_catalog = build_report({
        let mut input = object_input(&path, &fixture);
        input.catalog = None;
        input
    })
    .expect_err("a missing catalog is rejected");
    assert!(
        missing_catalog.contains("catalog is required") && missing_catalog.contains("catalogJson"),
        "{missing_catalog}"
    );

    let broken_json = build_report({
        let mut input = json_input(&path, &fixture);
        input.catalog_json = Some("{\"engine\": \"mysql\"".to_owned());
        input
    })
    .expect_err("malformed catalog JSON is rejected");
    assert!(
        broken_json.contains("catalog is not a valid payload"),
        "{broken_json}"
    );

    let missing_fields = build_report({
        let mut input = object_input(&path, &fixture);
        input.catalog = Some(json!({ "engine": "mysql" }));
        input
    })
    .expect_err("an incomplete catalog is rejected");
    assert!(
        missing_fields.contains("missing field")
            && missing_fields.contains("catalog is not a valid payload"),
        "{missing_fields}"
    );

    let bad_ordinal = build_report({
        let mut input = object_input(&path, &fixture);
        let mut catalog = fixture.catalog.clone();
        catalog["objects"][0]["columns"][0]["ordinal"] = json!(0);
        input.catalog = Some(catalog);
        input
    })
    .expect_err("a zero ordinal is rejected");
    assert!(
        bad_ordinal.contains("catalog.objects[0].columns[0].ordinal"),
        "{bad_ordinal}"
    );

    // Nothing was written for any of those failures.
    assert!(!path.exists(), "a rejected input leaves no file behind");
}

#[test]
fn removes_the_partial_file_when_the_ddl_is_wrong() {
    let fixture = fixture();
    let directory = TempDir::new("bad-ddl");
    let path = directory.index_path("index.db");

    let error = build_report({
        let mut input = object_input(&path, &fixture);
        input.schema_ddl = vec!["CREATE TABLE objects (id INTEGER PRIMARY KEY)".to_owned()];
        input
    })
    .expect_err("a DDL without the writer's tables cannot be written to");
    assert!(error.contains("no such table"), "{error}");
    assert!(!path.exists(), "the half-written file is removed");

    let syntax = build_report({
        let mut input = object_input(&path, &fixture);
        input.schema_ddl = vec!["CREATE TABLE".to_owned()];
        input
    })
    .expect_err("a syntactically invalid statement is rejected");
    assert!(syntax.contains("schemaDdl[0] failed"), "{syntax}");
    assert!(!path.exists(), "the half-written file is removed");
}

#[test]
fn an_empty_catalog_still_produces_a_valid_index() {
    let fixture = fixture();
    let directory = TempDir::new("empty");
    let path = directory.index_path("index.db");

    let report = build_report({
        let mut input = object_input(&path, &fixture);
        input.catalog = Some(json!({
            "engine": "mysql",
            "database": "empty_db",
            "objects": [],
            "fetchedAt": 1_700_000_000_000_u64,
            "level": "l1"
        }));
        input
    })
    .expect("an empty catalog is valid");

    assert_eq!(
        (report.objects, report.columns, report.edges, report.terms),
        (0, 0, 0, 0)
    );
    let connection = open(&path);
    assert_eq!(count(&connection, "objects"), 0);
    let engine: String = connection
        .query_row("SELECT value FROM meta WHERE key = 'engine'", [], |row| {
            row.get(0)
        })
        .expect("engine meta");
    assert_eq!(engine, "mysql");
}

#[test]
fn replaces_a_previous_file() {
    let fixture = fixture();
    let directory = TempDir::new("replace");
    let path = directory.index_path("index.db");

    build_report(object_input(&path, &fixture)).expect("first build");
    let before = fs::read(&path).expect("read the first file");
    assert!(!before.is_empty());

    // A second run over a *smaller* catalog must not leave the first run's rows behind.
    let smaller = build_report({
        let mut input = object_input(&path, &fixture);
        let mut catalog = fixture.catalog.clone();
        catalog["objects"] = json!([catalog["objects"][0].clone()]);
        input.catalog = Some(catalog);
        input
    })
    .expect("second build");

    assert_eq!(smaller.objects, 1);
    let connection = open(&path);
    assert_eq!(count(&connection, "objects"), 1);
    assert_eq!(count(&connection, "columns"), 6);
}
