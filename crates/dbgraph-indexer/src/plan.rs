//! The insert plan: the catalog turned into exactly the rows the writer will insert.
//!
//! The rules are the JavaScript writer's (`packages/store/src/writer-js.ts` and `terms.ts`), because
//! that writer is the parity reference: `tools/parity.mjs` builds the same catalog with both and
//! compares the four tables row by row. Where this file and that one could disagree — a primary key's
//! nullability, whether a dangling foreign key becomes a row, which weight a token earns — the
//! reference wins and the comment says why.
//!
//! Two properties matter beyond correctness:
//!
//! - **Every identifier is assigned here, deterministically.** `objects.id` is the catalog position
//!   plus one, `columns.id` is a global running number in catalog order. The two writers must agree
//!   on identity or no row comparison is possible.
//! - **Validation happens before a single byte is written.** A duplicate `(schema_name, name)`, a zero
//!   ordinal, or an empty name becomes a readable error naming the JSON path — instead of a SQLite
//!   constraint error several thousand rows into a transaction.
//!
//! The work is parallel because it is pure: each object's terms, edge targets and search document
//! depend only on immutable catalog data. The SQLite write stays single-threaded.

use std::collections::HashMap;

use rayon::prelude::*;

use crate::model::{AliasGroup, RawCatalog, RawObject};
use crate::normalize::{clean_comment, type_class};
use crate::terms::{
    merge_terms, search_document, tokenize_for_search, weight_for, AliasTable, COLUMN_ALIAS,
    COLUMN_COMMENT_ASCII, COLUMN_COMMENT_CJK, COLUMN_NAME_ASCII, COLUMN_NAME_CJK, OBJECT_ALIAS,
    OBJECT_COMMENT_ASCII, OBJECT_COMMENT_CJK, OBJECT_NAME_ASCII, OBJECT_NAME_CJK,
};

/// One row of `objects`.
#[derive(Debug, Clone)]
pub struct ObjectRow {
    /// Primary key; also the catalog position plus one.
    pub id: i64,
    /// Node category, verbatim from the dialect.
    pub kind: String,
    /// Namespace, or empty when the engine has none.
    pub schema: String,
    /// Object name.
    pub name: String,
    /// Cleaned comment.
    pub comment: Option<String>,
    /// Approximate row count, when the enrichment pass supplied one.
    pub row_estimate: Option<i64>,
    /// Epoch milliseconds of the write — the reference writer stamps the run, not the snapshot.
    pub updated_at: i64,
}

/// One row of `columns`.
#[derive(Debug, Clone)]
pub struct ColumnRow {
    /// Primary key; a global running number in catalog order.
    pub id: i64,
    /// Owning object.
    pub object_id: i64,
    /// One-based declared position.
    pub ordinal: i64,
    /// Column name, verbatim.
    pub name: String,
    /// Declared type, verbatim.
    pub type_name: String,
    /// Normalized type class.
    pub type_class: &'static str,
    /// Whether the column admits NULL. A primary-key column never does, whatever the catalog said.
    pub nullable: bool,
    /// Declared default, verbatim.
    pub default_value: Option<String>,
    /// Cleaned comment.
    pub comment: Option<String>,
    /// Whether the column participates in the primary key.
    pub is_primary_key: bool,
    /// Whether a single-column unique constraint covers it.
    pub is_unique: bool,
    /// Sampled distinct literals, as the JSON array string the schema stores.
    pub enum_values_json: Option<String>,
    /// Epoch milliseconds of the write.
    pub updated_at: i64,
}

/// One row of `edges`.
#[derive(Debug, Clone)]
pub struct EdgeRow {
    /// Object the relationship leaves.
    pub src_object: i64,
    /// Column on that side, when the edge names one.
    pub src_column: Option<i64>,
    /// Relationship category, verbatim.
    pub kind: String,
    /// Object the relationship reaches, when it is inside this catalog.
    pub dst_object: Option<i64>,
    /// Column on the far side, when the edge names one.
    pub dst_column: Option<i64>,
    /// Constraint or index name.
    pub name: Option<String>,
}

/// One row of `terms`.
#[derive(Debug, Clone)]
pub struct TermRow {
    /// The token.
    pub term: String,
    /// How strongly this token names the row it points at.
    pub weight: f64,
    /// Object the term describes.
    pub object_id: i64,
    /// Column the term describes, or `None` for an object-level term.
    pub column_id: Option<i64>,
}

/// One row of `search`.
#[derive(Debug, Clone)]
pub struct SearchRow {
    /// The token stream: `search_document`'s output, never raw text.
    pub text: String,
    /// Object this row describes on an object row, and `None` on a column row — the reference writer
    /// keys a column document by `column_id` alone.
    pub object_id: Option<i64>,
    /// Column this row describes, or `None` for an object-level row.
    pub column_id: Option<i64>,
}

/// Everything one write inserts, in insert order.
#[derive(Debug, Default)]
pub struct Payload {
    /// Rows for `objects`, in id order.
    pub objects: Vec<ObjectRow>,
    /// Rows for `columns`, in id order.
    pub columns: Vec<ColumnRow>,
    /// Rows for `edges`.
    pub edges: Vec<EdgeRow>,
    /// Rows for `terms`, ordered by term.
    pub terms: Vec<TermRow>,
    /// Rows for `search`.
    pub search: Vec<SearchRow>,
}

/// One object's contribution to the plan.
struct PreparedObject {
    object: ObjectRow,
    columns: Vec<ColumnRow>,
    edges: Vec<EdgeRow>,
    terms: Vec<TermRow>,
    search: Vec<SearchRow>,
}

impl Payload {
    /// Append one object's rows, keeping the global order stable.
    fn absorb(&mut self, prepared: PreparedObject) {
        self.objects.push(prepared.object);
        self.columns.extend(prepared.columns);
        self.edges.extend(prepared.edges);
        self.terms.extend(prepared.terms);
        self.search.extend(prepared.search);
    }
}

/// Lookups an object needs: its own identity, and every other object's.
struct ObjectIndex {
    /// `(schema, name)` → object id, for references that name a schema.
    identity: HashMap<(String, String), i64>,
    /// Name → object ids, for references that name only a table.
    by_name: HashMap<String, Vec<i64>>,
    /// Per object (indexed by id - 1): column name → column id.
    columns: Vec<HashMap<String, i64>>,
    /// Per object (indexed by id - 1): the id its first column got.
    column_offsets: Vec<i64>,
    /// Total columns across the catalog.
    column_count: i64,
}

impl ObjectIndex {
    /// Validate the catalog's identities and assign every id.
    fn build(catalog: &RawCatalog) -> Result<Self, String> {
        let object_count = catalog.objects.len();
        let mut identity: HashMap<(String, String), i64> = HashMap::with_capacity(object_count);
        let mut by_name: HashMap<String, Vec<i64>> = HashMap::with_capacity(object_count);
        let mut columns: Vec<HashMap<String, i64>> = Vec::with_capacity(object_count);
        let mut column_offsets: Vec<i64> = Vec::with_capacity(object_count);
        let mut next_column_id: i64 = 1;

        for (index, object) in catalog.objects.iter().enumerate() {
            let id = index as i64 + 1;
            let path = format!("catalog.objects[{index}]");
            if object.kind.trim().is_empty() {
                return Err(format!("{path}.kind must not be empty"));
            }
            if object.name.trim().is_empty() {
                return Err(format!("{path}.name must not be empty"));
            }
            let schema = object.schema.as_deref().unwrap_or("").trim().to_owned();
            if let Some(previous) = identity.insert((schema.clone(), object.name.clone()), id) {
                return Err(format!(
                    "{path} repeats `{}`, already written as catalog.objects[{}]; \
                     (schemaName, name) must be unique",
                    qualified(&schema, &object.name),
                    previous - 1
                ));
            }
            by_name.entry(object.name.clone()).or_default().push(id);
            column_offsets.push(next_column_id);

            let mut names: HashMap<String, i64> = HashMap::with_capacity(object.columns.len());
            for (column_index, column) in object.columns.iter().enumerate() {
                let column_path = format!("{path}.columns[{column_index}]");
                if column.name.trim().is_empty() {
                    return Err(format!("{column_path}.name must not be empty"));
                }
                if column.ordinal < 1 {
                    return Err(format!(
                        "{column_path}.ordinal must be a positive one-based position, received {}",
                        column.ordinal
                    ));
                }
                if let Some(previous) = names.insert(column.name.clone(), next_column_id) {
                    return Err(format!(
                        "{column_path} repeats the column `{}` (already column id {previous}); \
                         a column name must be unique inside its object",
                        column.name
                    ));
                }
                next_column_id += 1;
            }
            columns.push(names);
        }

        Ok(Self {
            identity,
            by_name,
            columns,
            column_offsets,
            column_count: next_column_id - 1,
        })
    }

    /// The id a column of `object_id` got, when that name exists there.
    fn column_id(&self, object_id: i64, name: &str) -> Option<i64> {
        let index = usize::try_from(object_id - 1).ok()?;
        self.columns.get(index)?.get(name).copied()
    }

    /// Resolve a reference such as `users`, `public.users`, or `db.public.users` to an object id.
    ///
    /// A missing or ambiguous target yields `None` instead of a guess — and the caller then drops the
    /// edge, exactly as the reference writer does: a NULL target is a row no reader can use, and a
    /// *wrong* target is worse than a missing edge.
    fn resolve(&self, current_schema: &str, reference: &str) -> Option<i64> {
        let reference = reference.trim();
        if reference.is_empty() {
            return None;
        }
        if let Some(id) = self
            .identity
            .get(&(current_schema.to_owned(), reference.to_owned()))
        {
            return Some(*id);
        }
        if let Some((schema, name)) = reference.split_once('.') {
            if let Some(id) = self.identity.get(&(schema.to_owned(), name.to_owned())) {
                return Some(*id);
            }
        }
        match self.by_name.get(reference) {
            Some(ids) if ids.len() == 1 => Some(ids[0]),
            _ => None,
        }
    }
}

/// `schema.name`, or just `name` when the engine has no schema.
fn qualified(schema: &str, name: &str) -> String {
    if schema.is_empty() {
        name.to_owned()
    } else {
        format!("{schema}.{name}")
    }
}

/// Turn a catalog into the insert plan.
///
/// `written_at` is the epoch milliseconds stamped on every row's `updated_at` and on `meta.written_at`
/// — one value for the whole run, so the two can never disagree.
///
/// # Errors
/// The first validation failure, in catalog order, naming the JSON path that carries it.
pub fn build_payload(
    catalog: &RawCatalog,
    aliases: &[AliasGroup],
    written_at: i64,
) -> Result<Payload, String> {
    let index = ObjectIndex::build(catalog)?;
    let alias_table = AliasTable::new(aliases);

    let prepared: Vec<Result<PreparedObject, String>> = (0..catalog.objects.len())
        .into_par_iter()
        .map(|position| {
            prepare_object(
                position,
                &catalog.objects[position],
                &index,
                &alias_table,
                written_at,
            )
        })
        .collect();

    let mut payload = Payload {
        objects: Vec::with_capacity(catalog.objects.len()),
        columns: Vec::with_capacity(usize::try_from(index.column_count).unwrap_or(0)),
        edges: Vec::new(),
        terms: Vec::new(),
        search: Vec::new(),
    };
    for object in prepared {
        payload.absorb(object?);
    }
    // Terms are ordered by (term, object_id, column_id) so the file is reproducible and a diff
    // between two runs is meaningful. The reference writer keeps insertion order instead; terms have
    // no identity column, so the two orders hold the same rows and `tools/parity.mjs` compares them
    // sorted.
    payload.terms.sort_by(|left, right| {
        left.term
            .cmp(&right.term)
            .then(left.object_id.cmp(&right.object_id))
            .then(left.column_id.cmp(&right.column_id))
    });
    Ok(payload)
}

/// Normalize one object and its columns into rows.
fn prepare_object(
    position: usize,
    object: &RawObject,
    index: &ObjectIndex,
    aliases: &AliasTable,
    written_at: i64,
) -> Result<PreparedObject, String> {
    let object_id = position as i64 + 1;
    let schema = object.schema.as_deref().unwrap_or("").trim().to_owned();
    let comment = clean_comment(object.comment.as_deref().unwrap_or(""));

    let mut object_pairs: Vec<(String, f64)> = Vec::new();
    for token in tokenize_for_search(&object.name) {
        let weight = weight_for(&token, OBJECT_NAME_ASCII, OBJECT_NAME_CJK);
        object_pairs.push((token, weight));
    }
    if let Some(comment) = comment.as_deref() {
        for token in tokenize_for_search(comment) {
            let weight = weight_for(&token, OBJECT_COMMENT_ASCII, OBJECT_COMMENT_CJK);
            object_pairs.push((token, weight));
        }
    }
    for token in aliases.expand(&[Some(object.name.as_str()), comment.as_deref()]) {
        object_pairs.push((token, OBJECT_ALIAS));
    }
    let object_terms = merge_terms(object_pairs);

    let row = ObjectRow {
        id: object_id,
        kind: object.kind.trim().to_owned(),
        schema: schema.clone(),
        name: object.name.clone(),
        comment: comment.clone(),
        row_estimate: object
            .row_estimate
            .filter(|value| value.is_finite())
            .map(|value| value.trunc() as i64),
        updated_at: written_at,
    };

    let mut columns: Vec<ColumnRow> = Vec::with_capacity(object.columns.len());
    let mut terms: Vec<TermRow> = Vec::with_capacity(object_terms.len() + object.columns.len() * 8);
    let mut search: Vec<SearchRow> = Vec::with_capacity(object.columns.len() + 1);

    for (term, weight) in object_terms {
        terms.push(TermRow {
            term,
            weight,
            object_id,
            column_id: None,
        });
    }
    // The reference writer pushes one document per object and per column even when it holds no
    // token, so a reader that counts documents counts objects.
    search.push(SearchRow {
        text: search_document(&[Some(object.name.as_str()), comment.as_deref()]),
        object_id: Some(object_id),
        column_id: None,
    });

    let offset = index
        .column_offsets
        .get(position)
        .copied()
        .ok_or_else(|| format!("catalog.objects[{position}]: missing column offset"))?;

    for (column_position, column) in object.columns.iter().enumerate() {
        let column_id = offset + column_position as i64;
        let column_comment = clean_comment(column.comment.as_deref().unwrap_or(""));

        let mut pairs: Vec<(String, f64)> = Vec::new();
        for token in tokenize_for_search(&column.name) {
            let weight = weight_for(&token, COLUMN_NAME_ASCII, COLUMN_NAME_CJK);
            pairs.push((token, weight));
        }
        if let Some(comment) = column_comment.as_deref() {
            for token in tokenize_for_search(comment) {
                let weight = weight_for(&token, COLUMN_COMMENT_ASCII, COLUMN_COMMENT_CJK);
                pairs.push((token, weight));
            }
        }
        for token in aliases.expand(&[Some(column.name.as_str()), column_comment.as_deref()]) {
            pairs.push((token, COLUMN_ALIAS));
        }
        for (term, weight) in merge_terms(pairs) {
            terms.push(TermRow {
                term,
                weight,
                object_id,
                column_id: Some(column_id),
            });
        }

        search.push(SearchRow {
            text: search_document(&[Some(column.name.as_str()), column_comment.as_deref()]),
            object_id: None,
            column_id: Some(column_id),
        });

        let enum_values_json = match column.enum_values.as_ref() {
            Some(values) if !values.is_empty() => {
                Some(serde_json::to_string(values).map_err(|error| {
                    format!(
                        "catalog.objects[{position}].columns[{column_position}].enumValues: {error}"
                    )
                })?)
            }
            _ => None,
        };

        let is_primary_key = column.is_primary_key.unwrap_or(false);
        columns.push(ColumnRow {
            id: column_id,
            object_id,
            ordinal: column.ordinal,
            name: column.name.clone(),
            type_name: column.declared_type.clone(),
            type_class: type_class(&column.declared_type),
            // A primary-key column cannot hold NULL, whatever the catalog claimed — the reference
            // writer applies the same correction rather than recording a self-contradiction.
            nullable: if is_primary_key {
                false
            } else {
                column.nullable.unwrap_or(true)
            },
            default_value: column.default_value.clone(),
            comment: column_comment,
            is_primary_key,
            is_unique: column.is_unique.unwrap_or(false),
            enum_values_json,
            updated_at: written_at,
        });
    }

    let edges = prepare_edges(position, object, object_id, &schema, index)?;

    Ok(PreparedObject {
        object: row,
        columns,
        edges,
        terms,
        search,
    })
}

/// Resolve one object's relationships into rows.
///
/// The reference writer's three rules, adopted verbatim:
///
/// 1. an edge whose `refObject` is not in this snapshot is **dropped** (it would be a row with no
///    usable target);
/// 2. an edge naming a source column that does not exist in this object drops that row;
/// 3. referenced columns pair **by position** with the source columns — no broadcasting a single
///    target column across a composite key, because that would claim a relationship the server never
///    declared.
fn prepare_edges(
    position: usize,
    object: &RawObject,
    object_id: i64,
    schema: &str,
    index: &ObjectIndex,
) -> Result<Vec<EdgeRow>, String> {
    let mut rows: Vec<EdgeRow> = Vec::new();
    let Some(edges) = object.edges.as_ref() else {
        return Ok(rows);
    };
    for (edge_position, edge) in edges.iter().enumerate() {
        let kind = edge.kind.trim();
        if kind.is_empty() {
            return Err(format!(
                "catalog.objects[{position}].edges[{edge_position}].kind must not be empty"
            ));
        }
        let destination = match edge.ref_object.as_deref() {
            Some(reference) => match index.resolve(schema, reference) {
                Some(target) => Some(target),
                None => continue,
            },
            None => None,
        };
        let row_count = edge.columns.len().max(1);
        for offset in 0..row_count {
            let source_name = edge.columns.get(offset);
            let source_id = match source_name {
                Some(name) => match index.column_id(object_id, name) {
                    Some(id) => Some(id),
                    None => continue,
                },
                None => None,
            };
            let target_name = edge
                .ref_columns
                .as_ref()
                .and_then(|columns| columns.get(offset));
            let target_id = match (destination, target_name) {
                (Some(target), Some(name)) => index.column_id(target, name),
                _ => None,
            };
            rows.push(EdgeRow {
                src_object: object_id,
                src_column: source_id,
                kind: kind.to_owned(),
                dst_object: destination,
                dst_column: target_id,
                name: edge.name.clone(),
            });
        }
    }
    Ok(rows)
}

/// Read the plan's counts, for the report.
pub fn counts(payload: &Payload) -> (usize, usize, usize, usize) {
    (
        payload.objects.len(),
        payload.columns.len(),
        payload.edges.len(),
        payload.terms.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::build_payload;
    use crate::model::{AliasGroup, IndexLevel, RawCatalog, RawColumn, RawEdge, RawObject};
    use crate::normalize::clean_comment;

    const WRITTEN_AT: i64 = 1_700_000_000_500;

    fn column(name: &str, ordinal: i64, declared_type: &str) -> RawColumn {
        RawColumn {
            name: name.to_owned(),
            ordinal,
            declared_type: declared_type.to_owned(),
            nullable: Some(true),
            default_value: None,
            comment: None,
            is_primary_key: Some(false),
            is_unique: Some(false),
            enum_values: None,
        }
    }

    fn catalog(objects: Vec<RawObject>) -> RawCatalog {
        RawCatalog {
            engine: "mysql".to_owned(),
            server_version: None,
            database: "shop".to_owned(),
            objects,
            fetched_at: 1_700_000_000_000.0,
            level: IndexLevel::L2,
            warnings: None,
        }
    }

    fn aliases() -> Vec<AliasGroup> {
        vec![
            AliasGroup {
                meaning: "password".to_owned(),
                words: vec!["密码".to_owned(), "pwd".to_owned(), "password".to_owned()],
            },
            AliasGroup {
                meaning: "user".to_owned(),
                words: vec!["用户".to_owned(), "member".to_owned(), "user".to_owned()],
            },
        ]
    }

    #[test]
    fn assigns_ids_in_catalog_order() {
        let payload = build_payload(
            &catalog(vec![
                RawObject {
                    kind: "table".to_owned(),
                    schema: Some("shop".to_owned()),
                    name: "sys_user".to_owned(),
                    comment: Some("系统用户".to_owned()),
                    row_estimate: Some(12.0),
                    columns: vec![
                        column("id", 1, "bigint"),
                        column("user_pwd", 2, "varchar(64)"),
                    ],
                    edges: None,
                },
                RawObject {
                    kind: "table".to_owned(),
                    schema: None,
                    name: "orders".to_owned(),
                    comment: None,
                    row_estimate: None,
                    columns: vec![column("id", 1, "bigint")],
                    edges: None,
                },
            ]),
            &aliases(),
            WRITTEN_AT,
        )
        .expect("payload");

        assert_eq!(payload.objects.len(), 2);
        assert_eq!(payload.objects[0].id, 1);
        assert_eq!(payload.objects[0].comment.as_deref(), Some("系统用户"));
        assert_eq!(payload.objects[0].row_estimate, Some(12));
        assert_eq!(payload.objects[1].schema, "");
        // Column ids are global: object 2's only column is id 3.
        assert_eq!(
            payload.columns.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(payload.columns[1].type_class, "string");
        // `updated_at` is the run's own timestamp, not the snapshot's.
        assert!(payload.objects.iter().all(|row| row.updated_at == WRITTEN_AT));
        assert!(payload.columns.iter().all(|row| row.updated_at == WRITTEN_AT));
    }

    #[test]
    fn writes_object_and_column_terms_with_the_reference_weights() {
        let payload = build_payload(
            &catalog(vec![RawObject {
                kind: "table".to_owned(),
                schema: None,
                name: "sys_user".to_owned(),
                comment: Some("系统用户".to_owned()),
                row_estimate: None,
                columns: vec![RawColumn {
                    comment: Some("登录密码".to_owned()),
                    ..column("order_pwd", 1, "varchar(64)")
                }],
                edges: None,
            }]),
            &aliases(),
            WRITTEN_AT,
        )
        .expect("payload");

        let find = |term: &str, column_id: Option<i64>| {
            payload
                .terms
                .iter()
                .find(|row| row.term == term && row.column_id == column_id)
                .map(|row| row.weight)
        };

        // Object level: an ASCII name token weighs 1.0, a CJK name bigram 0.75, a comment token
        // 0.75/0.5 by script, and an alias expansion 0.6 regardless of which field selected it.
        assert_eq!(find("sys", None), Some(1.0));
        assert_eq!(find("系统", None), Some(0.5));
        assert_eq!(find("用户", None), Some(0.6), "alias expansion");

        // Column level: ASCII name token 0.9, CJK name bigram 0.75, comment 0.7/0.5, alias 0.65.
        assert_eq!(find("pwd", Some(1)), Some(0.9));
        assert_eq!(
            find("密码", Some(1)),
            Some(0.65),
            "the alias word beats the comment bigram (0.5)"
        );
        assert_eq!(find("登录", Some(1)), Some(0.5));

        // Terms are ordered by term, so the file is reproducible.
        let mut sorted: Vec<&str> = payload.terms.iter().map(|row| row.term.as_str()).collect();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            payload
                .terms
                .iter()
                .map(|row| row.term.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_primary_key_column_is_never_nullable() {
        let payload = build_payload(
            &catalog(vec![RawObject {
                kind: "table".to_owned(),
                schema: None,
                name: "t".to_owned(),
                comment: None,
                row_estimate: None,
                columns: vec![RawColumn {
                    is_primary_key: Some(true),
                    nullable: Some(true),
                    ..column("id", 1, "bigint")
                }],
                edges: None,
            }]),
            &[],
            WRITTEN_AT,
        )
        .expect("payload");
        assert!(!payload.columns[0].nullable);
        assert!(payload.columns[0].is_primary_key);
    }

    #[test]
    fn pairs_foreign_key_columns_by_position_and_drops_dangling_edges() {
        let fk = |name: &str, columns: Vec<&str>, target: &str, ref_columns: Vec<&str>| RawEdge {
            kind: "fk".to_owned(),
            name: Some(name.to_owned()),
            columns: columns.into_iter().map(str::to_owned).collect(),
            ref_object: Some(target.to_owned()),
            ref_columns: Some(ref_columns.into_iter().map(str::to_owned).collect()),
            unique: Some(false),
        };
        let payload = build_payload(
            &catalog(vec![
                RawObject {
                    kind: "table".to_owned(),
                    schema: None,
                    name: "sys_user".to_owned(),
                    comment: None,
                    row_estimate: None,
                    columns: vec![column("id", 1, "bigint"), column("tenant", 2, "bigint")],
                    edges: None,
                },
                RawObject {
                    kind: "table".to_owned(),
                    schema: None,
                    name: "orders".to_owned(),
                    comment: None,
                    row_estimate: None,
                    columns: vec![
                        column("id", 1, "bigint"),
                        column("user_id", 2, "bigint"),
                        column("tenant_id", 3, "bigint"),
                    ],
                    edges: Some(vec![
                        fk(
                            "fk_orders_user",
                            vec!["user_id", "tenant_id"],
                            "sys_user",
                            vec!["id", "tenant"],
                        ),
                        fk("fk_orders_ghost", vec!["user_id"], "missing_table", vec!["id"]),
                    ]),
                },
            ]),
            &aliases(),
            WRITTEN_AT,
        )
        .expect("payload");

        let resolved: Vec<&super::EdgeRow> = payload
            .edges
            .iter()
            .filter(|row| row.name.as_deref() == Some("fk_orders_user"))
            .collect();
        assert_eq!(resolved.len(), 2, "one row per column pair");
        assert_eq!(resolved[0].src_column, Some(4));
        assert_eq!(resolved[0].dst_object, Some(1));
        assert_eq!(resolved[0].dst_column, Some(1));
        assert_eq!(resolved[1].src_column, Some(5));
        assert_eq!(resolved[1].dst_column, Some(2));

        assert!(
            payload
                .edges
                .iter()
                .all(|row| row.name.as_deref() != Some("fk_orders_ghost")),
            "an edge into a table outside the snapshot is dropped, as the reference writer does"
        );
    }

    #[test]
    fn rejects_duplicate_object_identities_and_bad_ordinals() {
        let duplicate = build_payload(
            &catalog(vec![
                RawObject {
                    kind: "table".to_owned(),
                    schema: None,
                    name: "t".to_owned(),
                    comment: None,
                    row_estimate: None,
                    columns: vec![],
                    edges: None,
                },
                RawObject {
                    kind: "table".to_owned(),
                    schema: None,
                    name: "t".to_owned(),
                    comment: None,
                    row_estimate: None,
                    columns: vec![],
                    edges: None,
                },
            ]),
            &[],
            WRITTEN_AT,
        )
        .expect_err("duplicate identity");
        assert!(
            duplicate.contains("catalog.objects[1] repeats"),
            "{duplicate}"
        );

        let bad_ordinal = build_payload(
            &catalog(vec![RawObject {
                kind: "table".to_owned(),
                schema: None,
                name: "t".to_owned(),
                comment: None,
                row_estimate: None,
                columns: vec![column("id", 0, "int")],
                edges: None,
            }]),
            &[],
            WRITTEN_AT,
        )
        .expect_err("zero ordinal");
        assert!(
            bad_ordinal.contains("catalog.objects[0].columns[0].ordinal"),
            "{bad_ordinal}"
        );
    }

    #[test]
    fn writes_one_search_document_per_row_even_when_it_holds_no_token() {
        let payload = build_payload(
            &catalog(vec![RawObject {
                kind: "table".to_owned(),
                schema: None,
                name: "__".to_owned(),
                comment: None,
                row_estimate: None,
                columns: vec![column("__", 1, "int")],
                edges: None,
            }]),
            &[],
            WRITTEN_AT,
        )
        .expect("payload");
        assert_eq!(payload.search.len(), 2, "the object and its one column");
        assert!(payload.search.iter().all(|row| row.text.is_empty()));
    }

    #[test]
    fn keeps_enum_samples_as_a_json_array_and_cleans_comments() {
        let payload = build_payload(
            &catalog(vec![RawObject {
                kind: "table".to_owned(),
                schema: None,
                name: "orders".to_owned(),
                comment: Some("  订单\n主表 ".to_owned()),
                row_estimate: None,
                columns: vec![RawColumn {
                    enum_values: Some(vec!["paid".to_owned(), "refunded".to_owned()]),
                    comment: Some("状态".to_owned()),
                    ..column("status", 1, "varchar(16)")
                }],
                edges: None,
            }]),
            &[],
            WRITTEN_AT,
        )
        .expect("payload");
        assert_eq!(
            payload.columns[0].enum_values_json.as_deref(),
            Some("[\"paid\",\"refunded\"]")
        );
        assert_eq!(payload.objects[0].comment, clean_comment("  订单\n主表 "));
    }
}
