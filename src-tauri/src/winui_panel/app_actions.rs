//! Existing app services exposed to the native toolbar, never a main WebView.
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// Session-only previews, like ClipboardHeader. Never persist Debug appearance.
static PREVIEW: Mutex<Option<(String, String)>> = Mutex::new(None);

pub(super) fn appearance(language: String, theme: String) -> (String, String) {
    PREVIEW
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
        .unwrap_or((language, theme))
}

pub(super) fn reset_preview() {
    *PREVIEW.lock().unwrap_or_else(|err| err.into_inner()) = None;
}

fn effective_appearance() -> Result<(String, String), String> {
    let config = crate::config::get();
    let (language, mut theme) = appearance(config.multilingual, config.theme_mode);
    if !matches!(theme.as_str(), "light" | "dark") {
        use windows::UI::ViewManagement::{UIColorType, UISettings};
        let color = UISettings::new()
            .and_then(|settings| settings.GetColorValue(UIColorType::Background))
            .map_err(|error| error.to_string())?;
        theme = if u32::from(color.R) + u32::from(color.G) + u32::from(color.B) < 384 {
            "dark"
        } else {
            "light"
        }
        .into();
    }
    Ok((language, theme))
}

#[derive(Debug, PartialEq, Eq)]
enum Tool {
    TutorialWindows,
    TutorialMac,
    Language,
    Theme,
    Memory,
    TestRoom,
    UiLab,
}

impl Tool {
    fn parse(name: &str, developer: bool) -> Result<Self, String> {
        if !developer {
            return Err("Developer tools require Debug + --dev-mode".into());
        }
        match name {
            "tutorial-windows" => Ok(Self::TutorialWindows),
            "tutorial-mac" => Ok(Self::TutorialMac),
            "language" => Ok(Self::Language),
            "theme" => Ok(Self::Theme),
            "memory" => Ok(Self::Memory),
            "testRoom" => Ok(Self::TestRoom),
            "uiLab" => Ok(Self::UiLab),
            _ => Err("Unknown developer tool".into()),
        }
    }
}

fn ui_lab_url(origin: Option<&reqwest::Url>) -> Result<String, String> {
    let origin = origin.ok_or("UI Lab requires the Vite development server")?;
    if !matches!(origin.scheme(), "http" | "https") {
        return Err("Unsupported UI Lab origin".into());
    }
    origin
        .join("/__ui-lab")
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

pub(super) fn snapshot(app: AppHandle) -> Result<Value, String> {
    let (language, theme) = effective_appearance()?;
    Ok(json!({
        "developerMode": crate::get_developer_mode(),
        "languageCode": language,
        "themePreview": theme,
        "update": crate::app_updater::get_update_state(app),
    }))
}

pub(super) async fn open_tool(app: AppHandle, argument: &str) -> Result<Value, String> {
    let (language, theme) = effective_appearance()?;
    match Tool::parse(argument, crate::get_developer_mode())? {
        Tool::Language | Tool::Theme => {
            let (language, theme) = toggled_appearance(argument, &language, &theme);
            *PREVIEW.lock().unwrap_or_else(|err| err.into_inner()) =
                Some((language.clone(), theme.clone()));
            super::apply_language()?;
            super::apply_theme()?;
            if let Some(memory) = app.get_webview_window("devMemory") {
                let _ = memory.emit(
                    "dev-memory-open",
                    json!({"languageCode":language,"themePreview":theme}),
                );
            }
        }
        Tool::TutorialWindows | Tool::TutorialMac => {
            #[cfg(debug_assertions)]
            {
                let window = crate::auxiliary_windows::ensure(
                    &app,
                    crate::auxiliary_windows::WindowKind::DevTutorial,
                )
                .await?;
                let platform = if argument == "tutorial-mac" {
                    "mac"
                } else {
                    "windows"
                };
                let payload = json!({"platform":platform,"languageCode":language,"themePreview":theme,
                    "shortcut":crate::config::get().shortcut_keys.main_window.unwrap_or_else(|| "Alt+V".into())});
                super::hide_on_ui_thread()?;
                let tutorial_app = app.clone();
                crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                    if !crate::auxiliary_windows::is_open(&window) {
                        return Err("Tutorial preview closed while opening".into());
                    }
                    crate::center_window_on_monitor(
                        &window,
                        crate::main_panel_monitor(&tutorial_app),
                    )?;
                    window
                        .emit("dev-tutorial-open", payload)
                        .map_err(|err| err.to_string())?;
                    window.show().map_err(|err| err.to_string())?;
                    crate::activate_native_window(&window, "developer tutorial preview");
                    window.set_focus().map_err(|err| err.to_string())
                })
                .await?;
            }
        }
        Tool::Memory => {
            crate::open_dev_memory_window_from_source(app.clone(), None, language, theme).await?;
        }
        Tool::TestRoom => crate::open_test_room_window_from_source(app.clone(), None).await?,
        Tool::UiLab => {
            let url = ui_lab_url(app.config().build.dev_url.as_ref())?;
            // Native mode uses embedded auxiliary pages and intentionally does
            // not keep Vite running. Avoid opening a dead browser tab.
            reqwest::Client::new()
                .get(&url)
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|_| "UI Lab needs Vite: run npm run dev in the experimental checkout, then retry / 请先在实验工作区运行 npm run dev，再打开样板间".to_string())?;
            crate::open_url_in_browser(url)?;
        }
    }
    snapshot(app)
}

fn toggled_appearance(action: &str, language: &str, theme: &str) -> (String, String) {
    let language = if action == "language" {
        if language == "Chinese" || language.starts_with("zh") {
            "English"
        } else {
            "Chinese"
        }
    } else {
        language
    };
    let theme = if action == "theme" {
        if theme == "dark" {
            "light"
        } else {
            "dark"
        }
    } else {
        theme
    };
    (language.into(), theme.into())
}

/// A stale confirmation must never install a different version than it showed.
fn validate_install(state: &Value, version: &str) -> Result<(), String> {
    if version.is_empty()
        || state["status"] != "ready"
        || state["portable"] != false
        || state["source"] != "direct"
        || state["availableVersion"].as_str() != Some(version)
    {
        return Err("Update changed; reopen the confirmation / 更新状态已变化，请重新确认".into());
    }
    Ok(())
}

pub(super) async fn install(app: AppHandle, version: &str) -> Result<Value, String> {
    let state = serde_json::to_value(crate::app_updater::get_update_state(app.clone()))
        .map_err(|error| error.to_string())?;
    validate_install(&state, version)?;
    crate::app_updater::install_confirmed_update(app, Some(version)).await?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_require_developer_mode_and_known_actions() {
        for (name, tool) in [
            ("tutorial-windows", Tool::TutorialWindows),
            ("tutorial-mac", Tool::TutorialMac),
            ("language", Tool::Language),
            ("theme", Tool::Theme),
            ("memory", Tool::Memory),
            ("testRoom", Tool::TestRoom),
            ("uiLab", Tool::UiLab),
        ] {
            assert!(Tool::parse(name, false).is_err());
            assert_eq!(Tool::parse(name, true).unwrap(), tool);
        }
        for name in [
            "",
            "settings",
            "native",
            "native-window",
            "https://example.com",
        ] {
            assert!(Tool::parse(name, true).is_err());
        }
    }

    #[test]
    fn appearance_toggles_only_the_requested_preview_dimension() {
        assert_eq!(
            toggled_appearance("language", "Chinese", "dark"),
            ("English".into(), "dark".into())
        );
        assert_eq!(
            toggled_appearance("language", "en-US", "light"),
            ("Chinese".into(), "light".into())
        );
        assert_eq!(
            toggled_appearance("theme", "Chinese", "light"),
            ("Chinese".into(), "dark".into())
        );
        assert_eq!(
            toggled_appearance("theme", "English", "dark"),
            ("English".into(), "light".into())
        );
    }

    #[test]
    fn ui_lab_uses_configured_origin_without_creating_a_webview() {
        let origin = reqwest::Url::parse("http://localhost:1530/app/").unwrap();
        assert_eq!(
            ui_lab_url(Some(&origin)).unwrap(),
            "http://localhost:1530/__ui-lab"
        );
        assert!(ui_lab_url(None).is_err());
        assert!(ui_lab_url(Some(&reqwest::Url::parse("file:///app").unwrap())).is_err());
    }

    #[test]
    fn install_accepts_only_the_confirmed_ready_version() {
        let ready = json!({"status":"ready", "portable":false, "source":"direct", "availableVersion":"1.7.1"});
        assert!(validate_install(&ready, "1.7.1").is_ok());
        for version in ["", "1.7.0", "1.7.2"] {
            assert!(validate_install(&ready, version).is_err());
        }
        for status in [
            "disabled",
            "available",
            "downloading",
            "installing",
            "failed",
        ] {
            let mut state = ready.clone();
            state["status"] = json!(status);
            assert!(validate_install(&state, "1.7.1").is_err());
        }
        for (field, value) in [("portable", json!(true)), ("source", json!("macAppStore"))] {
            let mut state = ready.clone();
            state[field] = value;
            assert!(validate_install(&state, "1.7.1").is_err());
        }
    }
}
