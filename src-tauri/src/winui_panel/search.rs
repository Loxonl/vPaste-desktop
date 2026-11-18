//! Match the existing WebView tag-token grammar before using the shared query.
use serde_json::{json, Value};
use std::sync::OnceLock;

pub(super) fn highlight_terms(keywords: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for term in keywords.split_whitespace() {
        if !terms.iter().any(|existing| existing == term) {
            terms.push(term.to_owned());
        }
    }
    terms.sort_by_key(|term| std::cmp::Reverse(term.encode_utf16().count()));
    terms.truncate(8);
    terms
}

pub(super) fn resolve(query: &str, label: String) -> (String, String) {
    static TOKENS: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = TOKENS.get_or_init(|| {
        regex::Regex::new(r#"(?i)(?:^|\s)tag:("[^"]+"|\S+)"#).expect("fixed tag token pattern")
    });
    let mut tags = Vec::<String>::new();
    let keywords = pattern.replace_all(query, |captures: &regex::Captures<'_>| {
        let raw = &captures[1];
        let name = raw
            .strip_prefix('"')
            .and_then(|name| name.strip_suffix('"'))
            .unwrap_or(raw)
            .trim();
        if !name.is_empty()
            && !tags
                .iter()
                .any(|tag| tag.to_lowercase() == name.to_lowercase())
        {
            tags.push(name.to_string());
        }
        " "
    });
    let keywords = keywords.split_whitespace().collect::<Vec<_>>().join(" ");
    if tags.is_empty() {
        return (keywords, label);
    }
    let mut filter = label
        .strip_prefix("__filter:")
        .and_then(|label| serde_json::from_str::<Value>(label).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| {
            if label == "__favorite" {
                json!({"mode":"favorite", "favorite":true})
            } else {
                json!({"mode":"all"})
            }
        });
    let mut names: Vec<String> = filter["tag_names"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    for tag in tags {
        if !names
            .iter()
            .any(|name| name.to_lowercase() == tag.to_lowercase())
        {
            names.push(tag);
        }
    }
    filter["tag_names"] = json!(names);
    (keywords, format!("__filter:{filter}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlight_terms_follow_the_accepted_keyword_grammar_and_utf16_order() {
        let (keywords, _) = resolve(
            "hello TAG:Work tag:\"设计 资料\" world hello 😀",
            "__all".into(),
        );
        assert_eq!(highlight_terms(&keywords), vec!["hello", "world", "😀"]);
        assert_eq!(
            highlight_terms("a abc ab ABC 😀"),
            vec!["abc", "ABC", "ab", "😀", "a"]
        );
        assert_eq!(highlight_terms("a b c d e f g h i").len(), 8);
        let (keywords, _) = resolve("tag:Only", "__all".into());
        assert!(highlight_terms(&keywords).is_empty());
    }

    fn filter(label: &str) -> Value {
        serde_json::from_str(label.strip_prefix("__filter:").unwrap()).unwrap()
    }

    #[test]
    fn tag_search_extracts_quoted_names_and_deduplicates_without_losing_keywords() {
        let (keywords, label) = resolve(
            "  hello TAG:Work  tag:\"设计 资料\" tag:work world ",
            "__all".into(),
        );
        assert_eq!(keywords, "hello world");
        assert_eq!(filter(&label)["tag_names"], json!(["Work", "设计 资料"]));
    }

    #[test]
    fn tag_search_preserves_custom_category_favorite_and_explicit_tag_filters() {
        let original = json!({"mode":"custom", "item_type":"Image", "favorite":false,
            "app_sources":["Code"], "relative_amount":2, "relative_unit":"week",
            "tag_name":"Pinned", "tag_names":["Research"]});
        let (_, label) = resolve("tag:research tag:New", format!("__filter:{original}"));
        let mut expected = original;
        expected["tag_names"] = json!(["Research", "New"]);
        assert_eq!(filter(&label), expected);
        let (keywords, label) = resolve("tag:Work", "__favorite".into());
        assert!(keywords.is_empty());
        assert_eq!(filter(&label)["favorite"], true);
    }

    #[test]
    fn non_tokens_and_unfiltered_search_keep_shipping_behavior() {
        let query = "xxtag:Work tag: ";
        assert_eq!(
            resolve(query, "__all".into()),
            ("xxtag:Work tag:".into(), "__all".into())
        );
        let (keywords, label) = resolve("tag:Work tag:Notes", "__all".into());
        assert!(keywords.is_empty());
        assert_eq!(filter(&label)["tag_names"], json!(["Work", "Notes"]));
        let (_, label) = resolve("tag:ends\" tag:\"unfinished", "__all".into());
        assert_eq!(
            filter(&label)["tag_names"],
            json!(["ends\"", "\"unfinished"])
        );
    }
}
