//! Query presentation at the Windows-native bridge boundary.

pub(super) fn resolve(query: &str, label: String) -> (String, String) {
    // The text field has no tag grammar. Only the separate controls set the filter label.
    (
        query.split_whitespace().collect::<Vec<_>>().join(" "),
        label,
    )
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_text_does_not_override_explicit_windows_native_filters() {
        for label in [
            "__all",
            "__favorite",
            r#"__filter:{"mode":"custom","tag_name":"Pinned","favorite":false}"#,
        ] {
            let text = r#"hello TAG:Work tag:"设计 资料""#;
            let (keywords, resolved_label) = resolve(text, label.into());
            assert_eq!(keywords, text);
            assert_eq!(resolved_label, label);
        }
    }

    #[test]
    fn repeated_whitespace_keeps_its_previous_search_meaning() {
        let (keywords, _) = resolve("  alpha \t beta   tag:Work\n", "__all".into());
        assert_eq!(keywords, "alpha beta tag:Work");
    }

    #[test]
    fn highlight_terms_preserve_literal_tag_text_and_utf16_order() {
        let (keywords, _) = resolve("hello tag:Work hello 😀", "__all".into());
        assert_eq!(highlight_terms(&keywords), vec!["tag:Work", "hello", "😀"]);
        assert_eq!(
            highlight_terms("a abc ab ABC 😀"),
            vec!["abc", "ABC", "ab", "😀", "a"]
        );
        assert_eq!(highlight_terms("a b c d e f g h i").len(), 8);
    }
}
