//! Type and comment normalization, ported from `packages/store/src/normalize.ts`.
//!
//! That file is the specification: the JavaScript writer is the parity reference the native writer is
//! measured against, so every rule here — the type-class order, the comment cap, the identifier fold —
//! is a translation rather than a new opinion. Two rules are load-bearing enough to spell out:
//!
//! - **`tinyint(1)` is checked before the integer family**, because that is how MySQL spells a
//!   boolean. Classifying it as a number makes every flag column look like something to sum.
//! - **Anything unrecognized is `unknown`**, never a guess. A wrong class makes a numeric filter look
//!   safe when it is not.
//!
//! Identifier *splitting* lives in `terms.rs`: the words a term is built from must be the tokenizer's
//! output, or the writer would search for words no query can produce.

use unicode_normalization::UnicodeNormalization;

/// Longest comment the index keeps, in UTF-16 code units — the same bound the JavaScript writer
/// applies. A comment is a hint, not a document.
pub const MAX_COMMENT_LENGTH: usize = 2000;

/// CJK ideographs and kana: the scripts that stay one character per unit in an identifier fold.
pub fn is_cjk(character: char) -> bool {
    matches!(
        character as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
    )
}

/// What a word-boundary test treats as a word character.
///
/// JavaScript's `\b` without the `u` flag means `[A-Za-z0-9_]`, so a CJK character *is* a boundary
/// there — which is why `用户int` still starts a word at `int` on both sides.
fn is_word_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// Whether `needle` occurs in `haystack` with word boundaries on both sides.
fn contains_word(haystack: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = haystack[start..].find(needle) {
        let absolute = start + offset;
        let before = haystack[..absolute]
            .chars()
            .next_back()
            .map(|character| !is_word_char(character))
            .unwrap_or(true);
        let after = haystack[absolute + needle.len()..]
            .chars()
            .next()
            .map(|character| !is_word_char(character))
            .unwrap_or(true);
        if before && after {
            return true;
        }
        start = absolute + needle.len().max(1);
    }
    false
}

/// Whether `base` starts with `word` followed by a non-word character (or the end).
fn starts_word(base: &str, word: &str) -> bool {
    match base.strip_prefix(word) {
        Some(rest) => rest
            .chars()
            .next()
            .map(|character| !is_word_char(character))
            .unwrap_or(true),
        None => false,
    }
}

fn starts_any(base: &str, words: &[&str]) -> bool {
    words.iter().any(|word| starts_word(base, word))
}

fn contains_any_word(haystack: &str, words: &[&str]) -> bool {
    words.iter().any(|word| contains_word(haystack, word))
}

/// Remove every parenthesized group, the way the JavaScript writer's `/\((?:[^)]*)\)/g` does.
fn strip_parenthesized(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('(') {
        out.push_str(&rest[..open]);
        match rest[open..].find(')') {
            Some(close) => rest = &rest[open + close + 1..],
            None => {
                // An unbalanced `(`: keep it rather than silently truncating the type.
                out.push_str(&rest[open..]);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Remove `unsigned`/`zerofill` where they stand as words, then trim.
fn strip_numeric_attributes(text: &str) -> String {
    let mut current = text.to_owned();
    loop {
        let mut changed = false;
        for attribute in ["unsigned", "zerofill"] {
            if let Some(offset) = find_word(&current, attribute) {
                let mut next = String::with_capacity(current.len());
                next.push_str(&current[..offset]);
                next.push_str(&current[offset + attribute.len()..]);
                current = next;
                changed = true;
                break;
            }
        }
        if !changed {
            return current.trim().to_owned();
        }
    }
}

/// Where `needle` occurs with word boundaries, if it does.
fn find_word(haystack: &str, needle: &str) -> Option<usize> {
    let mut start = 0;
    while let Some(offset) = haystack[start..].find(needle) {
        let absolute = start + offset;
        let before = haystack[..absolute]
            .chars()
            .next_back()
            .map(|character| !is_word_char(character))
            .unwrap_or(true);
        let after = haystack[absolute + needle.len()..]
            .chars()
            .next()
            .map(|character| !is_word_char(character))
            .unwrap_or(true);
        if before && after {
            return Some(absolute);
        }
        start = absolute + needle.len().max(1);
    }
    None
}

/// `longblob`, `long blob`, `mediumblob`, `tiny blob`, … — the size-prefixed blob spellings.
fn starts_size_prefixed_blob(base: &str) -> bool {
    for size in ["long", "medium", "tiny"] {
        if let Some(rest) = base.strip_prefix(size) {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix("blob") {
                return rest
                    .chars()
                    .next()
                    .map(|character| !is_word_char(character))
                    .unwrap_or(true);
            }
        }
    }
    false
}

/// `\bwith(time|out)?\b` … `\btime\s*zone\b`, in that order.
fn mentions_time_zone_qualifier(base: &str) -> bool {
    let marker = match (find_word(base, "without"), find_word(base, "with")) {
        (Some(index), _) => index,
        (None, Some(index)) => index,
        (None, None) => return false,
    };
    match base[marker..].find("time") {
        Some(offset) => {
            let tail = base[marker + offset..].trim_start_matches("time").trim_start();
            tail.starts_with("zone")
        }
        None => false,
    }
}

/// The coarse type families the index stores in `columns.type_class`.
///
/// A translation of `typeClassOf` in `packages/store/src/normalize.ts`, including the order of the
/// tests: `^bit\b` answers `bool` before the binary family ever sees it, `year` answers `datetime`,
/// and `geometry` answers `unknown` because no rule names it.
pub fn type_class(declared: &str) -> &'static str {
    let normalized: String = declared.nfkc().collect::<String>().to_lowercase();
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return "unknown";
    }
    let base = strip_numeric_attributes(&strip_parenthesized(normalized));
    if base.is_empty() {
        return "unknown";
    }

    // MySQL's boolean spelling, tested on the *unstripped* form: the `(1)` is the evidence.
    if normalized.starts_with("tinyint(1)") {
        return "bool";
    }
    if contains_any_word(&base, &["bool", "boolean"]) {
        return "bool";
    }
    if starts_word(&base, "bit") {
        return "bool";
    }

    if starts_any(
        &base,
        &[
            "int", "integer", "bigint", "smallint", "mediumint", "tinyint", "int2", "int4", "int8",
            "uint2", "uint4", "uint8", "serial", "bigserial", "smallserial",
        ],
    ) || base == "rowid"
        || contains_word(&base, "integer")
    {
        return "integer";
    }

    if starts_any(
        &base,
        &[
            "decimal", "numeric", "number", "dec", "fixed", "money", "smallmoney", "float",
            "double", "real",
        ],
    ) {
        return "decimal";
    }

    if starts_any(&base, &["json", "jsonb"]) {
        return "json";
    }

    if starts_any(
        &base,
        &[
            "timestamp",
            "timestamptz",
            "datetime",
            "date",
            "time",
            "timetz",
            "year",
            "interval",
        ],
    ) || mentions_time_zone_qualifier(&base)
    {
        return "datetime";
    }

    if starts_any(
        &base,
        &["blob", "binary", "varbinary", "bytea", "image", "raw", "bfile"],
    ) || starts_size_prefixed_blob(&base)
    {
        return "binary";
    }

    if starts_any(&base, &["text", "tinytext", "mediumtext", "longtext", "ntext", "clob", "nclob"]) {
        return "text";
    }

    if starts_any(
        &base,
        &[
            "char",
            "nchar",
            "character",
            "varchar",
            "nvarchar",
            "varchar2",
            "nvarchar2",
            "enum",
            "set",
            "uuid",
            "uniqueidentifier",
            "citext",
            "string",
            "name",
            "symbol",
        ],
    ) || contains_any_word(&base, &["char", "varchar"])
    {
        return "string";
    }

    "unknown"
}

/// Fold an identifier for exact comparison: NFKC, lower-case, and every separator removed, so
/// `user_id`, `userId` and `USER-ID` all become `userid`.
pub fn normalize_identifier(name: &str) -> String {
    name.nfkc()
        .collect::<String>()
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || is_cjk(*character))
        .collect()
}

/// Whether a token is an ASCII identifier part rather than a CJK bigram.
///
/// The writers weight the two differently: a bigram is partial evidence by construction, so it can
/// never carry the weight of a whole word.
pub fn is_ascii_token(token: &str) -> bool {
    !token.is_empty() && token.chars().all(|character| character.is_ascii_alphanumeric())
}

/// Whether any character of the text is CJK.
pub fn has_cjk(text: &str) -> bool {
    text.chars().any(is_cjk)
}

/// Normalize a comment for storage: NFKC, control characters folded to spaces, whitespace runs
/// collapsed, trimmed, and capped at [`MAX_COMMENT_LENGTH`].
///
/// Ported from `normalizeComment`, including the cap: an unbounded comment would let one server's
/// documentation blob dominate both the index and every rendering of it.
pub fn clean_comment(raw: &str) -> Option<String> {
    let normalized: String = raw.nfkc().collect();
    let mut out = String::with_capacity(normalized.len().min(MAX_COMMENT_LENGTH * 4));
    let mut pending_space = false;
    for character in normalized.chars() {
        // `\s` plus the C0/C1 controls the JavaScript side replaces with a space. U+FEFF is
        // whitespace to `\s` and not to `char::is_whitespace`, so it is named explicitly.
        let blank = character.is_whitespace() || character.is_ascii_control() || character == '\u{feff}';
        if blank {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(character);
    }
    if out.is_empty() {
        return None;
    }
    Some(cap_utf16(&out, MAX_COMMENT_LENGTH))
}

/// Truncate to `limit` UTF-16 code units, never splitting a character.
///
/// The JavaScript `slice` counts UTF-16 code units, so the cap is expressed in the same unit; the one
/// difference is that a cut through a surrogate pair is impossible here, and stops one character
/// earlier instead of producing half of one.
fn cap_utf16(text: &str, limit: usize) -> String {
    let mut units = 0usize;
    for (index, character) in text.char_indices() {
        let next = units + character.len_utf16();
        if next > limit {
            return text[..index].to_owned();
        }
        units = next;
    }
    text.to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        clean_comment, has_cjk, is_ascii_token, normalize_identifier, type_class, MAX_COMMENT_LENGTH,
    };

    #[test]
    fn classifies_boolean_spellings_before_the_integer_family() {
        assert_eq!(type_class("tinyint(1)"), "bool");
        assert_eq!(type_class("tinyint(1) unsigned"), "bool");
        assert_eq!(type_class("boolean"), "bool");
        assert_eq!(type_class("bool"), "bool");
        // `^bit\b` answers bool before the binary family: that is the reference behaviour.
        assert_eq!(type_class("bit"), "bool");
        assert_eq!(type_class("bit(8)"), "bool");
        // A wide tinyint is a number, not a flag.
        assert_eq!(type_class("tinyint(4)"), "integer");
    }

    #[test]
    fn classifies_the_integer_family() {
        for declared in [
            "int",
            "INT UNSIGNED",
            "bigint(20)",
            "smallint",
            "mediumint",
            "integer",
            "int8",
            "int2",
            "serial",
            "bigserial",
            "rowid",
            "bigint unsigned zerofill",
        ] {
            assert_eq!(type_class(declared), "integer", "{declared}");
        }
    }

    #[test]
    fn classifies_decimal_json_datetime_binary_text_and_string() {
        assert_eq!(type_class("decimal(10,2)"), "decimal");
        assert_eq!(type_class("numeric(10,2)"), "decimal");
        assert_eq!(type_class("double precision"), "decimal");
        assert_eq!(type_class("float unsigned"), "decimal");
        assert_eq!(type_class("number(10,2)"), "decimal");
        assert_eq!(type_class("json"), "json");
        assert_eq!(type_class("jsonb"), "json");
        assert_eq!(type_class("datetime"), "datetime");
        assert_eq!(type_class("timestamp(6)"), "datetime");
        assert_eq!(type_class("timestamptz"), "datetime");
        assert_eq!(type_class("time"), "datetime");
        // `year` is a datetime in the reference implementation, not an integer.
        assert_eq!(type_class("year(4)"), "datetime");
        assert_eq!(type_class("timestamp without time zone"), "datetime");
        assert_eq!(type_class("varbinary(16)"), "binary");
        assert_eq!(type_class("blob"), "binary");
        assert_eq!(type_class("longblob"), "binary");
        assert_eq!(type_class("bytea"), "binary");
        assert_eq!(type_class("varchar(255)"), "string");
        assert_eq!(type_class("character varying(64)"), "string");
        assert_eq!(type_class("nvarchar(max)"), "string");
        assert_eq!(type_class("uuid"), "string");
        assert_eq!(type_class("enum('a','b')"), "string");
        assert_eq!(type_class("text"), "text");
        assert_eq!(type_class("longtext"), "text");
        assert_eq!(type_class("clob"), "text");
        assert_eq!(type_class("integer[]"), "integer");
        assert_eq!(type_class("numeric(10,2)[]"), "decimal");
    }

    #[test]
    fn unknown_is_earned_not_guessed() {
        assert_eq!(type_class(""), "unknown");
        assert_eq!(type_class("   "), "unknown");
        assert_eq!(type_class("some_custom_type"), "unknown");
        // No rule names a spatial type, so the reference implementation answers unknown.
        assert_eq!(type_class("geometry"), "unknown");
        assert_eq!(type_class("point"), "unknown");
        assert_eq!(type_class("sql_variant"), "unknown");
        assert_eq!(type_class("xml"), "unknown");
    }

    #[test]
    fn folds_identifiers_to_one_form() {
        assert_eq!(normalize_identifier("user_id"), "userid");
        assert_eq!(normalize_identifier("userId"), "userid");
        assert_eq!(normalize_identifier("USER-ID"), "userid");
        assert_eq!(normalize_identifier("用户 ID"), "用户id");
        assert_eq!(normalize_identifier("、、"), "");
    }

    #[test]
    fn distinguishes_ascii_tokens_from_cjk_bigrams() {
        assert!(is_ascii_token("user"));
        assert!(is_ascii_token("v2"));
        assert!(!is_ascii_token("用户"));
        assert!(!is_ascii_token(""));
        assert!(has_cjk("登录密码"));
        assert!(!has_cjk("login"));
    }

    #[test]
    fn cleans_comments_to_one_line() {
        assert_eq!(
            clean_comment("  用户  \n\t 登录密码 "),
            Some("用户 登录密码".to_owned())
        );
        assert_eq!(clean_comment("多行\n注释"), Some("多行 注释".to_owned()));
        assert_eq!(clean_comment("\u{feff}隐藏\u{feff}"), Some("隐藏".to_owned()));
        // Full-width characters are NFKC-normalized, as the JavaScript writer does.
        assert_eq!(clean_comment("ＰＡＳＳ"), Some("PASS".to_owned()));
        assert_eq!(clean_comment("   \n\t "), None);
        assert_eq!(clean_comment(""), None);
    }

    #[test]
    fn caps_a_long_comment() {
        let long = "字".repeat(MAX_COMMENT_LENGTH + 500);
        let cleaned = clean_comment(&long).expect("a long comment is still a comment");
        assert_eq!(cleaned.chars().count(), MAX_COMMENT_LENGTH);
    }
}
