//! Token-for-token parity with the shared tokenizer corpus.
//!
//! `packages/store/tests/fixtures/tokens.json` is written from the JavaScript implementation
//! (`tokenizeForSearch` in `packages/service/src/tokenize.ts`), and the store's own test asserts it
//! against the TypeScript function. This test asserts the *same file* against the Rust port, so a
//! rule that changes on one side and not the other fails here as well as there — the two writers
//! cannot silently index different vocabularies.
//!
//! The corpus is read from the repository rather than copied: one fixture, two readers.

use std::fs;
use std::path::Path;

use dbgraph_indexer::terms::{search_document, tokenize_for_search};
use serde_json::Value;

/// The shared corpus, resolved at compile time so the test runs from any working directory.
fn corpus_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("store")
        .join("tests")
        .join("fixtures")
        .join("tokens.json")
}

#[test]
fn tokenizes_the_shared_corpus_like_the_typescript_implementation() {
    let path = corpus_path();
    let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let cases: Value = serde_json::from_str(&text).expect("tokens.json is a JSON array");
    let cases = cases.as_array().expect("tokens.json holds an array");
    assert!(!cases.is_empty(), "the corpus is not empty");

    let mut failures: Vec<String> = Vec::new();
    for case in cases {
        let input = case["text"].as_str().expect("each case has a text");
        let expected: Vec<String> = case["tokens"]
            .as_array()
            .expect("each case has tokens")
            .iter()
            .map(|token| token.as_str().expect("tokens are strings").to_owned())
            .collect();
        let got = tokenize_for_search(input);
        if got != expected {
            failures.push(format!("{input:?}: expected {expected:?}, got {got:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "tokenizer parity failed for {} of {} cases:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn documents_are_the_folded_tokens_of_their_parts() {
    // `searchDocument` folds parts in order and deduplicates across them; this is the property the
    // `search.text` column relies on, expressed without the corpus.
    assert_eq!(
        search_document(&[Some("order_item"), Some("订单明细")]),
        "order item 订单 单明 明细"
    );
    assert_eq!(search_document(&[Some("user"), Some("user")]), "user");
}
