//! Present the shipping onboarding flow in the existing native dock.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(0);
static GUIDE: Mutex<Option<Guide>> = Mutex::new(None);

struct Filter {
    id: &'static str,
    item_type: &'static str,
    emoji: &'static str,
    zh: &'static str,
    en: &'static str,
}

// Keep in sync with clipboardTutorial.ts; the existing IDs and tab schema
// are also consumed by the React surface and importer.
const FILTERS: [Filter; 5] = [
    Filter {
        id: "text",
        item_type: "Text",
        emoji: "📝",
        zh: "文本",
        en: "Text",
    },
    Filter {
        id: "image",
        item_type: "Image",
        emoji: "🖼️",
        zh: "图片",
        en: "Image",
    },
    Filter {
        id: "link",
        item_type: "Link",
        emoji: "🔗",
        zh: "链接",
        en: "Link",
    },
    Filter {
        id: "file",
        item_type: "File",
        emoji: "📁",
        zh: "文件",
        en: "File",
    },
    Filter {
        id: "color",
        item_type: "Color",
        emoji: "🎨",
        zh: "颜色",
        en: "Color",
    },
];

struct Guide {
    session: u64,
    preview: bool,
    mac: bool,
    english: bool,
    shortcut: String,
    tabs: Vec<Value>,
    loaded: bool,
}

impl Filter {
    fn tab_id(&self) -> String {
        format!("tutorial-filter-{}", self.id)
    }

    fn name(&self, english: bool) -> String {
        format!("{} {}", self.emoji, if english { self.en } else { self.zh })
    }

    fn apply(&self, tabs: &mut Vec<Value>, enabled: bool, english: bool) {
        let id = self.tab_id();
        match (enabled, tabs.iter().any(|tab| tab["id"] == id)) {
            (true, false) => tabs.push(json!({
                "id":id, "name":self.name(english),
                "filter":{"itemType":self.item_type,"appSource":"","appSources":[],
                    "favorite":"any","relativeAmount":"","relativeUnit":"day"}
            })),
            (false, true) => tabs.retain(|tab| tab["id"] != id),
            _ => {}
        }
    }
}

fn initial_tabs(
    mut tabs: Vec<Value>,
    first_run: bool,
    already_saved: bool,
    english: bool,
) -> (Vec<Value>, bool) {
    let initialize = first_run && !already_saved && tabs.is_empty();
    if initialize {
        for filter in FILTERS.iter().filter(|filter| filter.id != "color") {
            filter.apply(&mut tabs, true, english);
        }
    }
    (tabs, initialize)
}

fn format_shortcut(shortcut: &str, mac: bool) -> String {
    shortcut
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "control" | "ctrl" => "Ctrl".into(),
            "alt" => if mac { "Option" } else { "Alt" }.into(),
            "shift" => "Shift".into(),
            "command" | "meta" | "cmd" | "super" | "win" | "windows" => {
                if mac { "Command" } else { "Win" }.into()
            }
            "enter" | "return" => "Enter".into(),
            "escape" | "esc" => "Esc".into(),
            _ => {
                let mut chars = part.chars();
                chars.next().map_or_else(String::new, |first| {
                    first.to_uppercase().to_string() + &chars.as_str().to_lowercase()
                })
            }
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

fn read_tabs() -> Result<Vec<Value>, String> {
    crate::get_custom_tabs().map(|tabs| tabs.as_array().cloned().unwrap_or_default())
}

impl Guide {
    fn load(&mut self) -> Result<(), String> {
        let _store = super::filters::STORE_ACCESS
            .lock()
            .map_err(|error| error.to_string())?;
        let (tabs, initialize) = initial_tabs(
            read_tabs()?,
            !self.preview && !crate::config::get().onboarding_completed,
            crate::custom_tabs_path().exists(),
            self.english,
        );
        if initialize {
            crate::save_custom_tabs(json!(tabs))?;
        }
        self.loaded = true;
        self.tabs = tabs;
        Ok(())
    }

    fn toggle(&mut self, filter: &Filter, enabled: bool) -> Result<(), String> {
        if self.preview {
            filter.apply(&mut self.tabs, enabled, self.english);
            return Ok(());
        }
        let _store = super::filters::STORE_ACCESS
            .lock()
            .map_err(|error| error.to_string())?;
        let mut tabs = read_tabs()?;
        filter.apply(&mut tabs, enabled, self.english);
        crate::save_custom_tabs(json!(tabs))?;
        self.tabs = tabs;
        Ok(())
    }

    fn state(&self, error: Option<String>) -> Value {
        let filters: Vec<_> = FILTERS
            .iter()
            .map(|filter| {
                json!({
                    "id":filter.id, "name":filter.name(self.english),
                    "enabled":self.tabs.iter().any(|tab| tab["id"] == filter.tab_id())
                })
            })
            .collect();
        json!({
            "session":self.session, "ready":self.loaded, "preview":self.preview, "mac":self.mac,
            "english":self.english, "shortcut":self.shortcut, "items":self.tabs,"filters":filters,
            "permissions":self.mac.then(crate::get_onboarding_permission_status),
            "error":error.unwrap_or_default()
        })
    }

    fn set_language(&mut self, english: bool) -> bool {
        if self.english == english {
            return false;
        }
        self.english = english;
        if !self.loaded {
            return true;
        }
        // 同步更新当前导览已启用预设筛选标签的名称，避免语言切换后保留旧语言标签名。
        let update_tab_names = |tabs: &mut Vec<Value>| {
            for tab in tabs.iter_mut() {
                if let Some(filter) = FILTERS.iter().find(|f| tab["id"] == f.tab_id()) {
                    tab["name"] = json!(filter.name(english));
                }
            }
        };
        if self.preview {
            update_tab_names(&mut self.tabs);
            return true;
        }
        if let Ok(_store) = super::filters::STORE_ACCESS.lock() {
            if let Ok(mut tabs) = read_tabs() {
                update_tab_names(&mut tabs);
                if crate::save_custom_tabs(json!(tabs)).is_ok() {
                    self.tabs = tabs;
                    return true;
                }
            }
        }
        update_tab_names(&mut self.tabs);
        true
    }
}

pub(crate) fn refresh_language(app: &AppHandle, english: bool) {
    let payload = {
        let Ok(mut active) = GUIDE.lock() else {
            return;
        };
        let Some(guide) = active.as_mut() else {
            return;
        };
        if !guide.set_language(english) {
            return;
        }
        publish_real_tabs(app, guide);
        guide.state(None)
    };
    super::send_response(0, "nativeTutorialState", Ok(payload));
}

fn publish_real_tabs(app: &AppHandle, guide: &Guide) {
    if guide.loaded && !guide.preview {
        let _ = app.emit("custom-tabs-changed", json!({"tabs":guide.tabs}));
    }
}

fn start(app: &AppHandle, preview: Option<Value>) -> Result<(), String> {
    let mut active = GUIDE.lock().map_err(|error| error.to_string())?;
    if active.as_ref().is_some_and(|guide| !guide.preview) && preview.is_some() {
        return Err("Finish the active tutorial before opening a Debug preview".into());
    }
    super::layout::before_show(app)?;
    super::apply_behavior()?;
    super::apply_theme()?;
    let config = crate::config::get();
    let variant = preview
        .as_ref()
        .is_some_and(|payload| payload["platform"] == "mac");
    let shortcut = config
        .shortcut_keys
        .main_window
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Alt+V".into());
    let language = preview
        .as_ref()
        .and_then(|payload| payload["languageCode"].as_str())
        .unwrap_or(&config.multilingual);
    let mut guide = Guide {
        session: NEXT_SESSION.fetch_add(1, Ordering::Relaxed) + 1,
        preview: preview.is_some(),
        mac: variant,
        english: language.to_ascii_lowercase().starts_with("en"),
        shortcut: format_shortcut(&shortcut, variant),
        tabs: Vec::new(),
        loaded: false,
    };
    let error = guide.load().err();
    publish_real_tabs(app, &guide);
    *active = Some(guide);
    super::send_response(
        0,
        "nativeTutorialOpen",
        Ok(active.as_ref().unwrap().state(error)),
    );
    Ok(())
}

pub(crate) fn open(app: AppHandle) {
    if let Some(result) = show_if_active(&app) {
        if let Err(error) = result {
            log::error!("Failed to restore tutorial: {error}");
        }
        return;
    }
    crate::ONBOARDING_ACTIVE.store(true, Ordering::SeqCst);
    crate::set_onboarding_shortcut_demo_enabled(false);
    let owner = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = start(&owner, None) {
            crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
            log::error!("Failed to open native tutorial: {error}");
            let _ = super::show(owner);
        }
    }) {
        crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
        log::error!("Failed to schedule native tutorial: {error}");
    }
}

#[cfg(debug_assertions)]
pub(crate) async fn open_preview(app: AppHandle, payload: Value) -> Result<(), String> {
    let owner = app.clone();
    crate::auxiliary_windows::on_main_thread(app, move || {
        start(&owner, Some(payload))?;
        crate::ONBOARDING_ACTIVE.store(true, Ordering::SeqCst);
        crate::set_onboarding_shortcut_demo_enabled(false);
        Ok(())
    })
    .await
}

#[derive(Debug, PartialEq, Eq)]
enum ShortcutAction {
    MainPanel,
    ShowGuide,
    HideGuide,
}

fn shortcut_action(active: bool, demo: bool, visible: bool) -> ShortcutAction {
    if !active {
        ShortcutAction::MainPanel
    } else if demo && visible {
        ShortcutAction::HideGuide
    } else {
        ShortcutAction::ShowGuide
    }
}

pub(crate) fn show_if_active(app: &AppHandle) -> Option<Result<(), String>> {
    if !crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst) {
        return None;
    }
    // The scheduled open owns first visibility until the XAML subtree exists.
    Some(if GUIDE.lock().is_ok_and(|guide| guide.is_some()) {
        super::show(app.clone())
    } else {
        Ok(())
    })
}

pub(crate) fn toggle_if_active(app: &AppHandle) -> bool {
    let result = match shortcut_action(
        crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst),
        crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.load(Ordering::SeqCst),
        crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst),
    ) {
        ShortcutAction::MainPanel => return false,
        ShortcutAction::ShowGuide => show_if_active(app).unwrap_or(Ok(())),
        ShortcutAction::HideGuide => super::hide(),
    };
    if let Err(error) = result {
        log::error!("Failed to toggle native tutorial: {error}");
    }
    true
}

fn retire(active: &mut Option<Guide>) {
    if let Some(guide) = active.take() {
        crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
        crate::set_onboarding_shortcut_demo_enabled(false);
        super::send_response(
            0,
            "nativeTutorialClose",
            Ok(json!({"session":guide.session})),
        );
    }
}

pub(crate) fn close(_app: &AppHandle) -> Result<(), String> {
    let mut active = GUIDE.lock().map_err(|error| error.to_string())?;
    retire(&mut active);
    Ok(())
}

#[cfg(debug_assertions)]
pub(crate) fn close_preview(_app: &AppHandle) -> Result<(), String> {
    let mut active = GUIDE.lock().map_err(|error| error.to_string())?;
    if active.as_ref().is_some_and(|guide| guide.preview) {
        retire(&mut active);
    }
    Ok(())
}

pub(super) fn handle(app: &AppHandle, id: u64, op: &str, payload: &Value) -> bool {
    if !matches!(
        op,
        "tutorialToggle" | "tutorialDemo" | "tutorialFinish" | "tutorialRetry" | "tutorialCancel"
    ) {
        return false;
    }
    // Post in the native callback's order. Finishing must not pass an earlier
    // toggle's write; never wait for the Tauri thread from the WinUI callback.
    let owner = app.clone();
    let op = op.to_owned();
    let payload = payload.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Ok(mut active) = GUIDE.lock() else {
            return;
        };
        let Some(guide) = active
            .as_mut()
            .filter(|guide| payload["session"] == guide.session)
        else {
            return;
        };
        if op == "tutorialDemo" {
            crate::set_onboarding_shortcut_demo_enabled(payload["enabled"] == true);
            return;
        }
        if (op == "tutorialFinish" && guide.loaded) || (op == "tutorialCancel" && guide.preview) {
            if !guide.preview {
                crate::mark_onboarding_completed(&owner);
            }
            retire(&mut active);
            return;
        }
        let result = if op == "tutorialRetry" {
            guide.load()
        } else if op == "tutorialToggle" && guide.loaded {
            FILTERS
                .iter()
                .find(|filter| payload["filter"] == filter.id)
                .ok_or_else(|| "Unknown tutorial filter".to_owned())
                .and_then(|filter| guide.toggle(filter, payload["enabled"] == true))
        } else {
            return;
        };
        if result.is_ok() {
            publish_real_tabs(&owner, guide);
        }
        super::send_response(id, "nativeTutorialState", Ok(guide.state(result.err())));
    }) {
        log::error!("Could not dispatch tutorial interaction: {error}");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_practice_can_hide_and_reopen_without_losing_its_owner() {
        assert_eq!(shortcut_action(true, true, true), ShortcutAction::HideGuide);
        assert_eq!(
            shortcut_action(true, true, false),
            ShortcutAction::ShowGuide
        );
        assert_eq!(
            shortcut_action(true, false, true),
            ShortcutAction::ShowGuide
        );
        assert_eq!(
            shortcut_action(false, true, false),
            ShortcutAction::MainPanel
        );
        assert_eq!(format_shortcut("Super+Alt+v", false), "Win + Alt + V");
        assert_eq!(format_shortcut("Super+Alt+v", true), "Command + Option + V");
    }

    #[test]
    fn first_run_defaults_match_shipping_and_do_not_replace_saved_empty_filters() {
        let (tabs, initialize) = initial_tabs(vec![], true, false, true);
        assert!(initialize);
        let ids: Vec<_> = tabs.iter().map(|tab| tab["id"].as_str().unwrap()).collect();
        assert_eq!(
            ids,
            [
                "tutorial-filter-text",
                "tutorial-filter-image",
                "tutorial-filter-link",
                "tutorial-filter-file"
            ]
        );
        assert!(initial_tabs(vec![], true, true, true).0.is_empty());
        assert!(initial_tabs(vec![], false, false, true).0.is_empty());
    }

    #[test]
    fn toggling_one_filter_preserves_unrelated_order_and_is_idempotent() {
        let custom = json!({"id":"custom","name":"Mine","extra":"keep"});
        let mut tabs = vec![custom.clone()];
        FILTERS[1].apply(&mut tabs, true, false);
        FILTERS[4].apply(&mut tabs, true, false);
        FILTERS[1].apply(&mut tabs, true, false);
        FILTERS[1].apply(&mut tabs, false, false);
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0], custom);
        assert_eq!(tabs[1]["name"], "🎨 颜色");
        assert_eq!(
            tabs[1]["filter"],
            json!({"itemType":"Color","appSource":"","appSources":[],
            "favorite":"any","relativeAmount":"","relativeUnit":"day"})
        );
    }

    #[test]
    fn winui_regression_onboarding_language_update_refreshes_filter_labels() {
        let mut tabs = Vec::new();
        FILTERS[0].apply(&mut tabs, true, false);
        let mut guide = Guide {
            session: 1,
            preview: true,
            mac: false,
            english: false,
            shortcut: "Alt + V".into(),
            tabs,
            loaded: true,
        };
        assert_eq!(guide.state(None)["english"], false);
        assert!(guide.set_language(true));
        let updated = guide.state(None);
        assert_eq!(updated["english"], true);
        assert_eq!(updated["filters"][0]["name"], "📝 Text");
        assert!(!guide.set_language(true));
    }
}
