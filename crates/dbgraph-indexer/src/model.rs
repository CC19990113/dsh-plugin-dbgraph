//! The index writer's input: the raw catalog a dialect produced, validated and resolved into
//! owned Rust values.
//!
//! Nothing here is napi-aware. The napi layer (`lib.rs`) hands the catalog over as a
//! `serde_json::Value` that it received from JS, and *this* module deserializes it on the worker
//! thread. Two consequences, both deliberate:
//!
//! - a malformed catalog rejects with a field-level message (`missing field \`objects\``,
//!   `invalid type: string, expected a sequence`) instead of a JS type error at the call site;
//! - the expensive part of parsing 15 000 columns happens off the event loop.
//!
//! The vocabulary is the seam's, verbatim: `RawCatalog` / `RawObject` / `RawColumn` / `RawEdge` /
//! `AliasGroup` in `packages/service/src/types.ts`. Field names are camelCase on the wire and
//! snake_case here, which `#[serde(rename_all = "camelCase")]` handles.

use std::path::PathBuf;

use serde::Deserialize;

/// How much of a connection's catalog a run covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexLevel {
    /// Structural snapshot: object and column names and declared types.
    L1,
    /// Enrichment merged onto the L1 snapshot: comments, foreign keys, indexes, enum samples.
    L2,
}

impl IndexLevel {
    /// The label stored in `meta.level`, matching the seam's `IndexLevel` union.
    pub fn as_str(self) -> &'static str {
        match self {
            IndexLevel::L1 => "l1",
            IndexLevel::L2 => "l2",
        }
    }
}

/// One dialect's answer for one level of indexing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCatalog {
    /// Which engine produced this.
    pub engine: String,
    /// Server version, when reported.
    #[serde(default)]
    pub server_version: Option<String>,
    /// Database this snapshot describes.
    pub database: String,
    /// Every object reachable with the configured privileges.
    pub objects: Vec<RawObject>,
    /// Epoch milliseconds when the snapshot was taken.
    ///
    /// `f64`, not `i64`: napi converts a JS number to `serde_json::Number`, and an epoch
    /// millisecond value (~1.7e12) does not fit `u32`, so it arrives as a `Float`. An `i64` field
    /// would therefore reject every real catalog with "invalid type: floating point".
    pub fetched_at: f64,
    /// Which level this snapshot covers.
    pub level: IndexLevel,
    /// Per-object failures the dialect chose to tolerate. Parsed so a payload carrying them is
    /// not rejected; the index itself records only structure.
    #[serde(default)]
    pub warnings: Option<Vec<String>>,
}

/// One raw column, as a dialect read it off the server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawColumn {
    /// Declared name, verbatim.
    pub name: String,
    /// One-based position within the object.
    pub ordinal: i64,
    /// Declared type, verbatim.
    #[serde(rename = "type")]
    pub declared_type: String,
    /// Whether the column admits NULL. Absent means "assume yes", which is what a missing
    /// NOT NULL constraint means.
    #[serde(default)]
    pub nullable: Option<bool>,
    /// Declared default, rendered as text.
    #[serde(default)]
    pub default_value: Option<String>,
    /// Column comment — the most valuable field for Chinese lookup.
    #[serde(default)]
    pub comment: Option<String>,
    /// Whether the column participates in the primary key.
    #[serde(default)]
    pub is_primary_key: Option<bool>,
    /// Whether a single-column unique constraint covers it.
    #[serde(default)]
    pub is_unique: Option<bool>,
    /// Distinct literals sampled by the enrichment pass.
    #[serde(default)]
    pub enum_values: Option<Vec<String>>,
}

/// One raw relationship, as a dialect read it off the server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEdge {
    /// Relationship category: `fk` | `index` | `view_ref` | `code_ref`.
    pub kind: String,
    /// Constraint or index name, when the server keeps one.
    #[serde(default)]
    pub name: Option<String>,
    /// Columns on the source object.
    #[serde(default)]
    pub columns: Vec<String>,
    /// Referenced object name, for `fk` and `view_ref`.
    #[serde(default)]
    pub ref_object: Option<String>,
    /// Referenced columns, for `fk`.
    #[serde(default)]
    pub ref_columns: Option<Vec<String>>,
    /// Whether the index this edge records is unique.
    #[serde(default)]
    pub unique: Option<bool>,
}

/// One raw object (table, view, collection, key pattern).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawObject {
    /// Node category. Open vocabulary: a newer dialect may write a kind this build does not know.
    pub kind: String,
    /// Namespace the object lives in, or absent when the engine has none.
    #[serde(default)]
    pub schema: Option<String>,
    /// Object name.
    pub name: String,
    /// Object comment.
    #[serde(default)]
    pub comment: Option<String>,
    /// Approximate row count from catalog statistics — never a `COUNT(*)`.
    #[serde(default)]
    pub row_estimate: Option<f64>,
    /// Columns in declared order.
    pub columns: Vec<RawColumn>,
    /// Relationships leaving this object.
    #[serde(default)]
    pub edges: Option<Vec<RawEdge>>,
}

/// One group of words that mean the same column. Supplied by JS from `zh-aliases.ts`; this crate
/// never carries a second copy of that vocabulary.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasGroup {
    /// Canonical meaning, e.g. `password`.
    pub meaning: String,
    /// Words a user may type, e.g. `['密码', '口令', 'passwd', 'pwd']`.
    pub words: Vec<String>,
}

/// Everything one write needs, validated.
pub struct ResolvedInput {
    /// Absolute path of the `.tmp` index file to write. The rename is the caller's job.
    pub db_path: PathBuf,
    /// The `CREATE TABLE` statements, supplied by JS. Executed verbatim — the table structure
    /// lives in exactly one place (`packages/service/src/schema.ts`), never here.
    pub schema_ddl: Vec<String>,
    /// Value stored in `meta.schema_version`.
    pub schema_version: i64,
    /// Connection identity stored in `meta.connection`, or empty when the caller omitted it.
    pub connection: String,
    /// The catalog to index.
    pub catalog: RawCatalog,
    /// The alias table handed to the writer.
    pub aliases: Vec<AliasGroup>,
}

/// Longest error message detail kept from a serialization failure.
const MAX_DETAIL_CHARS: usize = 600;

/// One payload on its way into the writer, in either transport the caller may choose.
///
/// Both exist because the two costs land in different places. A JS **object** converts to
/// `serde_json::Value` on the JavaScript thread — measured at ~48 ms for 15 000 columns, because
/// napi walks every property. A **JSON string** costs `JSON.stringify` on the JavaScript thread
/// (~7.5 ms for the same catalog) and the parse here on the worker thread, where blocking costs
/// nothing. The contract keeps the object form because it is what the seam's types say; the string
/// form is the fast path a caller may opt into.
pub enum JsonPayload {
    /// A value napi already converted from a JS object.
    Value(serde_json::Value),
    /// A JSON document the caller serialized, parsed here on the worker thread.
    Text(String),
}

impl JsonPayload {
    /// Deserialize into the contract type, naming the field on failure.
    fn parse<T: serde::de::DeserializeOwned>(self, field: &str) -> Result<T, String> {
        match self {
            JsonPayload::Value(value) => serde_json::from_value(value),
            JsonPayload::Text(text) => serde_json::from_str(&text),
        }
        .map_err(|error| describe(field, error))
    }
}

/// Read an optional string field, treating an empty/whitespace-only value as absent.
pub fn non_empty(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

impl ResolvedInput {
    /// Validate the napi input and parse its JSON payloads.
    ///
    /// `catalog` and `aliases` are consumed, not cloned: a 15 000-column catalog is hundreds of
    /// thousands of `serde_json` nodes, and copying it would cost more than the whole write.
    ///
    /// # Errors
    /// A readable message naming the offending field — never a panic, and never a message a caller
    /// cannot act on.
    pub fn parse(
        db_path: &str,
        schema_ddl: &[String],
        catalog: JsonPayload,
        aliases: JsonPayload,
        schema_version: f64,
        connection: Option<&str>,
    ) -> Result<Self, String> {
        let trimmed = db_path.trim();
        if trimmed.is_empty() {
            return Err("dbPath is required (the `.tmp` index file to write)".to_owned());
        }
        if schema_ddl.is_empty() {
            return Err(
                "schemaDdl is empty: the index table structure is supplied by the caller and this \
                 writer creates no tables of its own"
                    .to_owned(),
            );
        }
        if !(schema_version.is_finite() && schema_version >= 1.0) {
            return Err(format!(
                "schemaVersion must be a positive integer, received {schema_version}"
            ));
        }
        if schema_version.fract() != 0.0 || schema_version > i32::MAX as f64 {
            return Err(format!(
                "schemaVersion must be a small positive integer, received {schema_version}"
            ));
        }

        let catalog: RawCatalog = catalog.parse("catalog")?;
        let aliases: Vec<AliasGroup> = aliases.parse("aliases")?;

        if catalog.engine.trim().is_empty() {
            return Err("catalog.engine must not be empty".to_owned());
        }
        if catalog.database.trim().is_empty() {
            return Err("catalog.database must not be empty".to_owned());
        }
        if !catalog.fetched_at.is_finite() || catalog.fetched_at < 0.0 {
            return Err(format!(
                "catalog.fetchedAt must be a non-negative epoch-millisecond number, received {}",
                catalog.fetched_at
            ));
        }

        Ok(Self {
            db_path: PathBuf::from(trimmed),
            schema_ddl: schema_ddl.to_vec(),
            schema_version: schema_version as i64,
            connection: connection.unwrap_or("").trim().to_owned(),
            catalog,
            aliases,
        })
    }
}

/// A serialization failure, prefixed with which payload failed and bounded in length.
fn describe(field: &str, error: serde_json::Error) -> String {
    let text = error.to_string();
    let bounded: String = text.chars().take(MAX_DETAIL_CHARS).collect();
    format!("{field} is not a valid payload: {bounded}")
}
