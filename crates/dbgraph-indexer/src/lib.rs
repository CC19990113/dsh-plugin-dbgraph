//! Native index kernel for the dbgraph plugin, exposed to Node through napi-rs.
//!
//! One call: [`build_index`]. It takes the raw catalog a database dialect read off the remote
//! server plus the index table structure, and writes one SQLite file: normalization, the term
//! vocabulary, the alias expansion, and the whole insert.
//!
//! ## Why this exists
//!
//! `node:sqlite` is synchronous. Writing 15 000 column rows through it blocks the host's event loop
//! for the entire run, so a background job would still freeze the UI it was scheduled to keep
//! responsive. [`AsyncTask`] is therefore a hard requirement, not an optimization: `Task::compute`
//! runs on libuv's thread pool, the JavaScript thread gets a promise, and the measured numbers in
//! `README.md` are what keeps that honest.
//!
//! ## The JS shape
//!
//! `#[napi(object)]` maps a Rust `snake_case` field to a **camelCase** JS property, so the call is
//! `buildIndex({ dbPath, schemaDdl, catalog, aliases, schemaVersion, connection })` and the report is
//! `{ objects, columns, edges, terms, elapsedMs }`.
//!
//! `catalog` and `aliases` cross as real JS objects (`serde_json::Value`), not as strings: napi
//! converts the object graph once on the JavaScript thread (an `undefined` property becomes absent,
//! exactly like `JSON.stringify`), and the *worker* parses it with serde. A malformed catalog
//! therefore rejects with a field-level message (`missing field \`objects\``), which a string
//! payload could not do without inventing a second error format.
//!
//! ## Failure
//!
//! A panic is caught here and turned into a rejected promise. The process is never aborted, and no
//! error message is invented: every failure names what failed and where.

pub mod model;
pub mod normalize;
pub mod plan;
pub mod terms;
pub mod write;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use napi::{bindgen_prelude::AsyncTask, Env, Task};
use napi_derive::napi;

use model::{JsonPayload, ResolvedInput};

/// One index write's input, as the JavaScript side builds it.
#[napi(object)]
pub struct BuildIndexInput {
    /// Absolute path of the `.tmp` index file to write. The caller renames it into place.
    pub db_path: String,
    /// The `CREATE TABLE` statements, from `INDEX_SCHEMA_DDL`. Executed verbatim.
    pub schema_ddl: Vec<String>,
    /// The raw catalog (`RawCatalog`) the dialect produced, as a JS object.
    ///
    /// Either this or [`Self::catalog_json`] is required. The object form is the seam's own shape;
    /// it costs a napi conversion on the JavaScript thread (measured in `README.md`).
    pub catalog: Option<serde_json::Value>,
    /// The alias table (`AliasGroup[]`), as a JS object.
    pub aliases: Option<serde_json::Value>,
    /// `JSON.stringify(catalog)` — the same catalog as text.
    ///
    /// Takes precedence when present. `JSON.stringify` runs in ~1/6 the time napi needs to walk the
    /// same object graph, and the parse then happens on the worker thread instead of the event loop,
    /// so a caller that cares about loop latency should pass this. Semantics are identical:
    /// `JSON.stringify` drops `undefined` properties exactly as the napi conversion does.
    pub catalog_json: Option<String>,
    /// `JSON.stringify(aliases)` — the same alias table as text. Takes precedence when present.
    pub aliases_json: Option<String>,
    /// Value stored in `meta.schema_version`.
    pub schema_version: f64,
    /// Connection identity stored in `meta.connection`, when the caller has one.
    pub connection: Option<String>,
    /// Epoch milliseconds to stamp on every row and on `meta.written_at`.
    ///
    /// Omitted means "now". A caller that needs a reproducible file — a test, or the parity run that
    /// compares this writer with the JavaScript one — passes the same value to both.
    pub now: Option<f64>,
}

/// What one write produced. JS property names are camelCase.
#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct BuildReport {
    /// Objects written.
    pub objects: u32,
    /// Columns written.
    pub columns: u32,
    /// Edges written.
    pub edges: u32,
    /// Search terms written.
    pub terms: u32,
    /// Wall-clock duration of the whole call, milliseconds.
    pub elapsed_ms: f64,
}

/// One pending write, executed on libuv's thread pool.
///
/// The body used to be the obvious `#[napi]` function; that is the one shape that cannot be used
/// here. A synchronous native call holds the JavaScript thread for its whole duration, so a write
/// scheduled through the host's job registry would still freeze the UI it was meant to keep free.
pub struct BuildIndexTask {
    input: BuildIndexInput,
}

impl Task for BuildIndexTask {
    type Output = BuildReport;
    type JsValue = BuildReport;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // A panic in the worker would otherwise abort the Node process; napi cannot turn that into
        // a rejected promise on its own, so the whole body runs inside catch_unwind.
        match catch_unwind(AssertUnwindSafe(|| build(&mut self.input))) {
            Ok(Ok(report)) => Ok(report),
            Ok(Err(message)) => Err(napi::Error::new(napi::Status::GenericFailure, message)),
            Err(panic) => Err(napi::Error::new(
                napi::Status::GenericFailure,
                format!("dbgraph indexer panicked: {}", panic_message(&panic)),
            )),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Build one connection's index, off the JavaScript thread.
///
/// Resolves to `{ objects, columns, edges, terms, elapsedMs }`; rejects with a readable message when
/// the catalog is malformed, the schema DDL does not apply, or the write fails.
#[napi(js_name = "buildIndex")]
pub fn build_index(input: BuildIndexInput) -> AsyncTask<BuildIndexTask> {
    AsyncTask::new(BuildIndexTask { input })
}

/// The kernel itself, with no napi in sight, so the crate's own tests can call it.
///
/// The payloads are *taken* out of `input` rather than cloned: a 15 000-column catalog is hundreds
/// of thousands of `serde_json` nodes, and a clone would rival the cost of the write.
///
/// # Errors
/// The first problem found, named after the field that carries it.
pub fn build(input: &mut BuildIndexInput) -> Result<BuildReport, String> {
    let started = Instant::now();
    let catalog = take_payload(&mut input.catalog_json, &mut input.catalog, "catalog")?;
    let aliases = take_payload(&mut input.aliases_json, &mut input.aliases, "aliases")?;
    let resolved = ResolvedInput::parse(
        &input.db_path,
        &input.schema_ddl,
        catalog,
        aliases,
        input.schema_version,
        input.connection.as_deref(),
    )?;
    // One timestamp for the whole run: `objects.updated_at`, `columns.updated_at` and
    // `meta.written_at` all carry it, so they can never disagree. A caller-supplied value makes the
    // file reproducible, which is what the parity run against the JavaScript writer needs.
    let written_at = input
        .now
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.floor() as i64)
        .unwrap_or_else(write::now_ms);
    let payload = plan::build_payload(&resolved.catalog, &resolved.aliases, written_at)?;
    let counts = write::write_index(&resolved, &payload, written_at)?;
    Ok(BuildReport {
        objects: clamp_u32(counts.objects),
        columns: clamp_u32(counts.columns),
        edges: clamp_u32(counts.edges),
        terms: clamp_u32(counts.terms),
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Take whichever transport the caller supplied for one payload.
///
/// An empty `…Json` string is treated as absent rather than as a parse error: a caller that
/// serializes conditionally should not have to branch at the call site.
fn take_payload(
    text: &mut Option<String>,
    value: &mut Option<serde_json::Value>,
    field: &str,
) -> Result<JsonPayload, String> {
    if let Some(text) = text.take() {
        if !text.trim().is_empty() {
            return Ok(JsonPayload::Text(text));
        }
    }
    match value.take() {
        Some(value) => Ok(JsonPayload::Value(value)),
        None => Err(format!(
            "{field} is required: pass `{field}` as an object or `{field}Json` as a JSON string"
        )),
    }
}

/// A row count as a JS `number`. A schema index cannot exceed this; the clamp only makes the
/// conversion total instead of fallible.
fn clamp_u32(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".to_string()
    }
}
