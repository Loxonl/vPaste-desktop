//! Only a projection of existing settings; the native panel owns no new store.
use serde_json::{json, Value};

pub(super) fn from_config(config: &crate::config::Config) -> Value {
    json!({"retainSearch":config.retain_search_history,
        "retainCategory":config.retain_tab_position,
        "retainPosition":config.retain_last_position,
        "quickInput":config.quick_input_enabled,
        "tabSelection":config.tab_quick_select_enabled,
        "hoverPreview":config.hover_preview_enabled,
        "plainShortcut":config.shortcut_keys.paste_into_plain_text.as_deref()
            .filter(|shortcut| !shortcut.is_empty()).unwrap_or("Shift+Enter")})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_match_existing_show_and_keyboard_preferences() {
        assert_eq!(
            from_config(&crate::config::Config::default()),
            json!({
            "retainSearch":false, "retainCategory":false, "retainPosition":false, "quickInput":true,
            "tabSelection":true, "hoverPreview":false, "plainShortcut":"Shift+Enter"})
        );
    }
    #[test]
    fn existing_saved_values_are_projected_without_changing_them() {
        let mut config = crate::config::Config::default();
        config.retain_search_history = true;
        config.retain_tab_position = true;
        config.quick_input_enabled = false;
        config.tab_quick_select_enabled = false;
        config.hover_preview_enabled = true;
        config.shortcut_keys.paste_into_plain_text = Some("Control+Shift+V".into());
        assert_eq!(
            from_config(&config),
            json!({"retainSearch":true, "retainCategory":true, "retainPosition":false,
            "quickInput":false, "tabSelection":false, "hoverPreview":true, "plainShortcut":"Control+Shift+V"})
        );
        for shortcut in [None, Some(String::new())] {
            config.shortcut_keys.paste_into_plain_text = shortcut;
            assert_eq!(from_config(&config)["plainShortcut"], "Shift+Enter");
        }
    }

    #[test]
    fn position_retention_uses_the_existing_setting() {
        let mut config = crate::config::Config::default();
        assert_eq!(from_config(&config)["retainPosition"], false);
        config.retain_last_position = true;
        assert_eq!(from_config(&config)["retainPosition"], true);
    }
}
