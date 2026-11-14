//! DEV actions reuse app services; none creates the clipboard WebView.
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

static PREVIEW: Mutex<Option<(String, String)>> = Mutex::new(None);

pub(super) fn appearance(language: String, theme: String) -> (String, String) {
    PREVIEW
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
        .unwrap_or((language, theme))
}

fn validate(action: &str, developer: bool, language: &str, theme: &str) -> Result<(), String> {
    if !developer {
        return Err("Developer tools require Debug + --dev-mode".into());
    }
    if !matches!(
        action,
        "tutorial-windows"
            | "tutorial-mac"
            | "language"
            | "theme"
            | "test-room"
            | "memory"
            | "native-panel"
            | "native-window"
            | "ui-lab"
    ) {
        return Err("Unknown developer tool".into());
    }
    if language.is_empty() || language.len() > 128 || !matches!(theme, "light" | "dark") {
        return Err("Unsupported developer preview appearance".into());
    }
    Ok(())
}

pub(super) async fn open(
    app: AppHandle,
    action: &str,
    language: &str,
    theme: &str,
) -> Result<Value, String> {
    validate(action, crate::get_developer_mode(), language, theme)?;
    match action {
        "language" | "theme" => {
            let next_language = if action == "language" {
                if language == "Chinese" || language.starts_with("zh") {
                    "English"
                } else {
                    "Chinese"
                }
            } else {
                language
            };
            let next_theme = if action == "theme" {
                if theme == "dark" {
                    "light"
                } else {
                    "dark"
                }
            } else {
                theme
            };
            *PREVIEW.lock().unwrap_or_else(|err| err.into_inner()) =
                Some((next_language.into(), next_theme.into()));
            if let Some(memory) = app.get_webview_window("devMemory") {
                let _ = memory.emit(
                    "dev-memory-open",
                    json!({"languageCode":next_language,"themePreview":next_theme}),
                );
            }
            super::present(app, next_language.into(), next_theme.into(), false, true)?;
        }
        "memory" => {
            crate::open_dev_memory_window_from_source(app, None, language.into(), theme.into())
                .await?
        }
        "test-room" => crate::open_test_room_window_from_source(app, None).await?,
        "native-panel" => super::show(app, language.into(), theme.into())?,
        "native-window" => crate::open_native_demo_window(app)?,
        "ui-lab" => {
            let url = app
                .config()
                .build
                .dev_url
                .as_ref()
                .filter(|origin| matches!(origin.scheme(), "http" | "https"))
                .ok_or("UI Lab requires the Vite development server: npm run dev")?
                .join("/__ui-lab")
                .map_err(|err| err.to_string())?;
            reqwest::Client::new()
                .get(url.clone())
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|_| {
                    "UI Lab requires the Vite development server: npm run dev".to_string()
                })?;
            crate::open_url_in_browser(url.into())?;
        }
        "tutorial-windows" | "tutorial-mac" => {
            let window = crate::auxiliary_windows::ensure(
                &app,
                crate::auxiliary_windows::WindowKind::DevTutorial,
            )
            .await?;
            let platform = if action == "tutorial-mac" {
                "mac"
            } else {
                "windows"
            };
            let payload = json!({"platform":platform,"languageCode":language,"themePreview":theme,
                "shortcut": crate::config::get().shortcut_keys.main_window.unwrap_or_else(|| "Alt+V".into())});
            // The real tutorial requires a main WebView. Preview only its existing
            // component here; filter/onboarding preferences remain untouched.
            super::close_for_action(&app).await?;
            crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                if !crate::auxiliary_windows::is_open(&window) {
                    return Err("Tutorial preview closed while opening".into());
                }
                crate::center_window_on_monitor(&window, crate::main_panel_monitor(&app))?;
                crate::set_macos_window_level(&window, 103);
                window
                    .emit("dev-tutorial-open", payload)
                    .map_err(|err| err.to_string())?;
                window.show().map_err(|err| err.to_string())?;
                crate::activate_native_window(&window, "developer tutorial preview");
                window.set_focus().map_err(|err| err.to_string())
            })
            .await?;
        }
        _ => unreachable!("validated developer action"),
    }
    Ok(json!(null))
}

pub(crate) fn build_tutorial_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let scale = crate::ui_text_scale::current();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "devTutorial",
        tauri::WebviewUrl::App("__dev-tutorial".into()),
    )
    .title("vPaste · Tutorial preview")
    .visible(false)
    .focused(false)
    .decorations(true)
    .resizable(true)
    .always_on_top(true)
    .inner_size(1120.0 * scale, 440.0 * scale)
    .min_inner_size(860.0 * scale, 360.0 * scale)
    .build()?;
    crate::ui_text_scale::remember(&window, scale);
    crate::apply_vpaste_window_icon(&window);
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn developer_tools_validate_mode_action_and_preview_without_main_webview() {
        for action in [
            "tutorial-windows",
            "tutorial-mac",
            "language",
            "theme",
            "test-room",
            "memory",
            "native-panel",
            "native-window",
            "ui-lab",
        ] {
            assert!(validate(action, true, "Chinese", "light").is_ok());
            assert!(validate(action, false, "Chinese", "light").is_err());
        }
        assert!(validate("unknown", true, "Chinese", "light").is_err());
        assert!(validate("memory", true, "Chinese", "system").is_err());
        assert_ne!(
            crate::auxiliary_windows::WindowKind::DevTutorial.label(),
            "clipboard"
        );
    }
}
