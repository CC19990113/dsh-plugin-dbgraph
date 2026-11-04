//! The tokenizer, the term weights, and the alias expansion — everything that turns a name, a
//! comment, or a word of Chinese into the vocabulary the resolver searches.
//!
//! Two files are the specification, and this module is a translation of them:
//! `packages/service/src/tokenize.ts` (the token stream, shared with the reader) and
//! `packages/store/src/terms.ts` + `aliases.ts` (the weights and the alias matching, shared with the
//! JavaScript writer). The JavaScript writer is the parity reference — `tools/parity.mjs` compares the
//! two indexes row by row — so where this file and that one disagree, that one wins.
//!
//! Why a tokenizer exists at all: FTS5's `unicode61` splits on non-alphanumerics, so a run of Chinese
//! becomes **one** token. Indexing `广告点击` verbatim and then asking for `广告` returns nothing
//! (verified on SQLite 3.50.4). `search.text` therefore holds this module's output — a space-joined
//! token stream — never the raw text.
//!
//! Terms are always tokenizer output, never raw words, which keeps one vocabulary: an alias word such
//! as `创建时间` contributes `创建`, `建时`, `时间`, so a user typing `时间` reaches a column whose
//! comment never mentions it.

use std::collections::{HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;

use crate::model::AliasGroup;
use crate::normalize::{has_cjk, is_ascii_token, is_cjk, normalize_identifier};

/// Weight of an ASCII token from the object's own name (the reference table's `objectNameAscii`).
pub const OBJECT_NAME_ASCII: f64 = 1.0;
/// Weight of a CJK bigram from the object's name — partial evidence by construction.
pub const OBJECT_NAME_CJK: f64 = 0.75;
/// Weight of an ASCII token from a table comment.
pub const OBJECT_COMMENT_ASCII: f64 = 0.75;
/// Weight of a CJK bigram from a table comment.
pub const OBJECT_COMMENT_CJK: f64 = 0.5;
/// Weight of an alias-group expansion on an object, whether the name or the comment selected it.
pub const OBJECT_ALIAS: f64 = 0.6;
/// Weight of an ASCII token from the column's own name.
pub const COLUMN_NAME_ASCII: f64 = 0.9;
/// Weight of a CJK bigram from the column's name.
pub const COLUMN_NAME_CJK: f64 = 0.75;
/// Weight of an ASCII token from a column comment.
pub const COLUMN_COMMENT_ASCII: f64 = 0.7;
/// Weight of a CJK bigram from a column comment.
pub const COLUMN_COMMENT_CJK: f64 = 0.5;
/// Weight of an alias-group expansion on a column.
pub const COLUMN_ALIAS: f64 = 0.65;

/// Weight for one token, by whether it is an ASCII identifier part or a CJK bigram.
pub fn weight_for(token: &str, ascii: f64, cjk: f64) -> f64 {
    if is_ascii_token(token) {
        ascii
    } else {
        cjk
    }
}

/// The character classes an ASCII identifier is split on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CharClass {
    Lower,
    Upper,
    Digit,
    Cjk,
    Other,
}

fn class_of(character: char) -> CharClass {
    if is_cjk(character) {
        CharClass::Cjk
    } else if character.is_ascii_lowercase() {
        CharClass::Lower
    } else if character.is_ascii_uppercase() {
        CharClass::Upper
    } else if character.is_ascii_digit() {
        CharClass::Digit
    } else {
        CharClass::Other
    }
}

/// Whether a new identifier part starts at `ch`.
///
/// One character of lookahead is what distinguishes `createdAt` (split before `A`, a lower-case
/// letter precedes an upper-case one) from `HTMLParser` (split before `P`, the last capital of an
/// acronym run). A per-character class-change rule gets the first case wrong and emits
/// `created`, `a`, `t`.
fn is_boundary(previous: char, ch: char, next: char) -> bool {
    let ch_class = class_of(ch);
    let previous_class = class_of(previous);
    if ch_class != previous_class {
        return match ch_class {
            CharClass::Digit => true,
            CharClass::Upper => {
                previous_class == CharClass::Lower || previous_class == CharClass::Digit
            }
            // A lower-case letter after an upper-case run does not begin a part by itself: the part
            // already began at the capital that precedes it.
            CharClass::Lower if previous_class == CharClass::Upper => false,
            _ => true,
        };
    }
    ch_class == CharClass::Upper && class_of(next) == CharClass::Lower
}

/// Split one ASCII run at camel-case and letter/digit boundaries, lowercased.
fn split_identifier(word: &str) -> Vec<String> {
    let characters: Vec<char> = word.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for (index, ch) in characters.iter().copied().enumerate() {
        let previous = if index == 0 {
            ' '
        } else {
            characters[index - 1]
        };
        let next = characters.get(index + 1).copied().unwrap_or(' ');
        if !current.is_empty() && is_boundary(previous, ch, next) {
            parts.push(std::mem::take(&mut current));
        }
        current.push(ch);
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts.into_iter().map(|part| part.to_lowercase()).collect()
}

/// Expand a CJK run into overlapping bigrams; a single-character run is its own token.
fn cjk_bigrams(run: &str) -> Vec<String> {
    let characters: Vec<char> = run.chars().collect();
    if characters.len() == 1 {
        return vec![characters[0].to_string()];
    }
    (0..characters.len().saturating_sub(1))
        .map(|index| {
            let mut token = String::with_capacity(8);
            token.push(characters[index]);
            token.push(characters[index + 1]);
            token
        })
        .collect()
}

fn push_token(token: String, tokens: &mut Vec<String>, seen: &mut HashSet<String>) {
    if token.is_empty() || !seen.insert(token.clone()) {
        return;
    }
    tokens.push(token);
}

fn flush_ascii(ascii: &mut String, tokens: &mut Vec<String>, seen: &mut HashSet<String>) {
    if ascii.is_empty() {
        return;
    }
    let run = std::mem::take(ascii);
    for part in split_identifier(&run) {
        push_token(part, tokens, seen);
    }
}

fn flush_cjk(cjk: &mut String, tokens: &mut Vec<String>, seen: &mut HashSet<String>) {
    if cjk.is_empty() {
        return;
    }
    let run = std::mem::take(cjk);
    for bigram in cjk_bigrams(&run) {
        push_token(bigram, tokens, seen);
    }
}

/// Tokenize one name, comment, or user word into the search vocabulary.
///
/// Deduplicated, first-seen order, NFKC-normalized first. This is `tokenizeForSearch` in
/// `packages/service/src/tokenize.ts`; the two implementations are compared token for token by the
/// store's parity test, so a rule change belongs there first.
pub fn tokenize_for_search(input: &str) -> Vec<String> {
    let normalized: String = input.nfkc().collect();
    let characters: Vec<char> = normalized.chars().collect();
    let mut tokens: Vec<String> = Vec::with_capacity(characters.len() / 2 + 1);
    let mut seen: HashSet<String> = HashSet::with_capacity(tokens.capacity());
    let mut ascii = String::new();
    let mut cjk = String::new();

    for ch in characters {
        let class = class_of(ch);
        if class == CharClass::Cjk {
            flush_ascii(&mut ascii, &mut tokens, &mut seen);
            cjk.push(ch);
            continue;
        }
        flush_cjk(&mut cjk, &mut tokens, &mut seen);
        if class == CharClass::Other {
            flush_ascii(&mut ascii, &mut tokens, &mut seen);
            continue;
        }
        ascii.push(ch);
    }
    flush_ascii(&mut ascii, &mut tokens, &mut seen);
    flush_cjk(&mut cjk, &mut tokens, &mut seen);
    tokens
}

/// The token set of one text, for "is this word present" questions.
pub fn token_set(input: &str) -> HashSet<String> {
    tokenize_for_search(input).into_iter().collect()
}

/// The indexable text for one object or column: the folded parts' tokens, deduplicated across parts,
/// joined by a space — ready for `search.text`.
///
/// This is `searchDocument` in `tokenize.ts`; absent and empty parts contribute nothing.
pub fn search_document(parts: &[Option<&str>]) -> String {
    let mut tokens: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for part in parts {
        let Some(text) = part else { continue };
        if text.is_empty() {
            continue;
        }
        for token in tokenize_for_search(text) {
            if seen.insert(token.clone()) {
                tokens.push(token);
            }
        }
    }
    tokens.join(" ")
}

/// One alias word, with everything the match needs precomputed.
///
/// The words are prepared once when the table is built. Doing this per column instead — normalizing
/// and tokenizing 300 words for each of 10 000 columns — made the whole write twice as slow when it
/// was first ported, which is exactly the kind of cost a "faithful translation" hides.
struct PreparedWord {
    /// The word as written, after NFKC + lowercase + trim — the form a CJK substring test uses.
    normalized: String,
    /// Its tokens, for the exact-token test.
    tokens: Vec<String>,
    /// Its folded form, for the multi-token test.
    folded: String,
    /// Whether the word holds CJK, which selects the substring rule.
    cjk: bool,
}

impl PreparedWord {
    /// Prepare one word.
    fn new(word: &str) -> Self {
        let normalized: String = word.nfkc().collect::<String>().trim().to_lowercase();
        let tokens = tokenize_for_search(&normalized);
        let folded = normalize_identifier(&normalized);
        let cjk = has_cjk(&normalized);
        Self {
            normalized,
            tokens,
            folded,
            cjk,
        }
    }

    /// Whether this word occurs in the text.
    ///
    /// Three shapes, because one rule cannot fit all three (the same three the JavaScript writer
    /// uses): a single ASCII token matches an exact token (`user` in `sys_user`) and never a
    /// substring, so `no` does not match `notification`; a CJK word matches as a substring (`用户` in
    /// `系统用户`), because Chinese has no separators; a multi-token word (`real_name`) matches the
    /// folded form, which keeps `real_name` and `realname` interchangeable.
    fn occurs_in(&self, text_lower: &str, tokens: &HashSet<String>, folded: &str) -> bool {
        if self.normalized.is_empty() || self.tokens.is_empty() {
            return false;
        }
        if self.cjk {
            return text_lower.contains(&self.normalized);
        }
        if self.tokens.len() == 1 {
            let first = self.tokens[0].as_str();
            if is_ascii_token(first) {
                return tokens.contains(first);
            }
        }
        !self.folded.is_empty() && folded.contains(&self.folded)
    }
}

/// One alias group, prepared for matching.
struct AliasEntry {
    /// The words, prepared for the three-shape match.
    words: Vec<PreparedWord>,
    /// Every token of every word plus the canonical meaning, deduplicated in first-seen order —
    /// `aliasGroupTokens`'s output.
    tokens: Vec<String>,
}

/// The alias table, indexed for "does this name or comment name any of these meanings".
///
/// Built from the JSON the caller supplies — this crate holds no copy of the vocabulary. A group is
/// selected when one of its words occurs in the concatenated name and comment text, which is exactly
/// the reference implementation's rule.
pub struct AliasTable {
    entries: Vec<AliasEntry>,
}

impl AliasTable {
    /// Index the caller's alias table. An empty table is valid: it simply expands nothing.
    pub fn new(aliases: &[AliasGroup]) -> Self {
        let entries = aliases
            .iter()
            .map(|group| {
                let mut tokens: Vec<String> = Vec::new();
                let mut seen: HashSet<String> = HashSet::new();
                for word in group.words.iter().map(String::as_str).chain(std::iter::once(group.meaning.as_str())) {
                    for token in tokenize_for_search(word) {
                        if seen.insert(token.clone()) {
                            tokens.push(token);
                        }
                    }
                }
                AliasEntry {
                    words: group.words.iter().map(|word| PreparedWord::new(word)).collect(),
                    tokens,
                }
            })
            .collect();
        Self { entries }
    }

    /// Every token the groups present in `parts` contribute, deduplicated in first-seen order.
    ///
    /// `parts` is the name and the cleaned comment; an empty or absent part contributes nothing.
    pub fn expand(&self, parts: &[Option<&str>]) -> Vec<String> {
        let text = parts
            .iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<&str>>()
            .join(" ");
        if text.is_empty() {
            return Vec::new();
        }
        let tokens: HashSet<String> = tokenize_for_search(&text).into_iter().collect();
        let folded = normalize_identifier(&text);
        let text_lower = text.to_lowercase();

        let mut expanded: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for entry in &self.entries {
            let matched = entry
                .words
                .iter()
                .any(|word| word.occurs_in(&text_lower, &tokens, &folded));
            if !matched {
                continue;
            }
            for token in &entry.tokens {
                if seen.insert(token.clone()) {
                    expanded.push(token.clone());
                }
            }
        }
        expanded
    }
}

/// Merge `(term, weight)` pairs keeping the highest weight per term, then order the result by term so
/// the same catalog always produces the same rows in the same order.
pub fn merge_terms(pairs: impl IntoIterator<Item = (String, f64)>) -> Vec<(String, f64)> {
    let mut merged: HashMap<String, f64> = HashMap::new();
    for (term, weight) in pairs {
        if term.is_empty() {
            continue;
        }
        merged
            .entry(term)
            .and_modify(|existing| {
                if weight > *existing {
                    *existing = weight;
                }
            })
            .or_insert(weight);
    }
    let mut rows: Vec<(String, f64)> = merged.into_iter().collect();
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    rows
}

#[cfg(test)]
mod tests {
    use super::{
        merge_terms, search_document, tokenize_for_search, weight_for, AliasTable,
        COLUMN_COMMENT_CJK, COLUMN_NAME_ASCII, COLUMN_NAME_CJK,
    };
    use crate::model::AliasGroup;

    fn tokens(input: &str) -> Vec<String> {
        tokenize_for_search(input)
    }

    #[test]
    fn splits_camel_case_like_the_ts_implementation() {
        assert_eq!(tokens("createdAt"), vec!["created", "at"]);
        assert_eq!(tokens("created_at"), vec!["created", "at"]);
        assert_eq!(tokens("HTMLParser"), vec!["html", "parser"]);
        assert_eq!(tokens("userID"), vec!["user", "id"]);
        assert_eq!(tokens("passwordHash"), vec!["password", "hash"]);
    }

    #[test]
    fn splits_letter_digit_boundaries_both_ways() {
        assert_eq!(tokens("v2"), vec!["v", "2"]);
        assert_eq!(tokens("id2name"), vec!["id", "2", "name"]);
        assert_eq!(tokens("col1"), vec!["col", "1"]);
    }

    #[test]
    fn expands_chinese_runs_to_overlapping_bigrams() {
        assert_eq!(tokens("广告点击"), vec!["广告", "告点", "点击"]);
        assert_eq!(tokens("广告"), vec!["广告"]);
        assert_eq!(tokens("广"), vec!["广"]);
    }

    #[test]
    fn keeps_documents_in_first_seen_order_without_duplicates() {
        assert_eq!(tokens("user_name user"), vec!["user", "name"]);
        assert_eq!(tokens("广告SDK"), vec!["广告", "sdk"]);
        assert_eq!(tokens("我 今天 在改 广告"), vec!["我", "今天", "在改", "广告"]);
    }

    #[test]
    fn normalizes_nfkc_before_splitting() {
        // Full-width characters are a real catalog hazard: a comment typed in an IME.
        assert_eq!(tokens("ＰＡＳＳＷＯＲＤ"), vec!["password"]);
        assert_eq!(tokens("１２３"), vec!["123"]);
    }

    #[test]
    fn drops_separators_and_empty_input() {
        assert_eq!(tokens(""), Vec::<String>::new());
        assert_eq!(tokens("  ,。!? \t\n"), Vec::<String>::new());
        assert_eq!(tokens("--广告--"), vec!["广告"]);
    }

    #[test]
    fn folds_name_and_comment_into_one_document() {
        assert_eq!(
            search_document(&[Some("sys_user"), Some("系统用户"), None, Some("")]),
            "sys user 系统 统用 用户"
        );
        assert_eq!(search_document(&[]), "");
    }

    #[test]
    fn weights_ascii_tokens_above_cjk_bigrams() {
        assert_eq!(weight_for("user", COLUMN_NAME_ASCII, COLUMN_NAME_CJK), 0.9);
        assert_eq!(weight_for("用户", COLUMN_NAME_ASCII, COLUMN_NAME_CJK), 0.75);
    }

    #[test]
    fn alias_group_matches_whole_ascii_tokens_only() {
        let table = AliasTable::new(&[AliasGroup {
            meaning: "code".to_owned(),
            words: vec!["编号".to_owned(), "no".to_owned(), "code".to_owned()],
        }]);
        // `order_no` has the token `no` → the whole group expands.
        assert!(table
            .expand(&[Some("order_no"), None])
            .iter()
            .any(|term| term == "编号"));
        // `notification` contains the *substring* `no` but not the token → no expansion.
        assert!(table.expand(&[Some("notification"), None]).is_empty());
    }

    #[test]
    fn alias_group_matches_cjk_words_as_substrings() {
        let table = AliasTable::new(&[AliasGroup {
            meaning: "password".to_owned(),
            words: vec!["密码".to_owned(), "pwd".to_owned()],
        }]);
        // `登录密码` contains `密码` — Chinese has no separators, so a substring is the right test.
        let expanded = table.expand(&[Some("login_pwd"), Some("登录密码")]);
        assert!(expanded.contains(&"password".to_owned()));
        assert!(expanded.contains(&"密码".to_owned()));
        assert!(!expanded.contains(&"login".to_owned()), "only the matched group expands");
    }

    #[test]
    fn alias_group_matches_multi_token_words_by_their_folded_form() {
        let table = AliasTable::new(&[AliasGroup {
            meaning: "name".to_owned(),
            words: vec!["real_name".to_owned(), "姓名".to_owned()],
        }]);
        // `realname` and `real_name` fold to the same form.
        assert!(!table.expand(&[Some("realname"), None]).is_empty());
        assert!(!table.expand(&[Some("real_name"), None]).is_empty());
    }

    #[test]
    fn terms_keep_the_highest_weight_and_sort_by_term() {
        let merged = merge_terms(vec![
            ("user".to_owned(), COLUMN_COMMENT_CJK),
            ("user".to_owned(), COLUMN_NAME_ASCII),
            ("id".to_owned(), 0.65),
            ("".to_owned(), 1.0),
        ]);
        assert_eq!(
            merged,
            vec![("id".to_owned(), 0.65), ("user".to_owned(), COLUMN_NAME_ASCII)]
        );
    }
}
