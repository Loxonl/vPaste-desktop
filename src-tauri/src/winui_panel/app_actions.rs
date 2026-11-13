//! Existing app services exposed to the native toolbar, never a main WebView.
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Debug, PartialEq, Eq)]
enum Tool {
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
    Ok(json!({
        "developerMode": crate::get_developer_mode(),
        "update": crate::app_updater::get_update_state(app),
    }))
}

pub(super) async fn open_tool(app: AppHandle, argument: &str) -> Result<Value, String> {
    match Tool::parse(argument, crate::get_developer_mode())? {
        Tool::Memory => {
            let config = crate::config::get();
            let theme = match config.theme_mode.as_str() {
                "dark" => "dark",
                "light" => "light",
                _ => {
                    use windows::UI::ViewManagement::{UIColorType, UISettings};
                    let color = UISettings::new()
                        .and_then(|settings| settings.GetColorValue(UIColorType::Background))
                        .map_err(|error| error.to_string())?;
                    if u32::from(color.R) + u32::from(color.G) + u32::from(color.B) < 384 {
                        "dark"
                    } else {
                        "light"
                    }
                }
            };
            crate::open_dev_memory_window_from_source(app, None, config.multilingual, theme.into())
                .await?;
        }
        Tool::TestRoom => crate::open_test_room_window_from_source(app, None).await?,
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
    Ok(json!({}))
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
            ("memory", Tool::Memory),
            ("testRoom", Tool::TestRoom),
            ("uiLab", Tool::UiLab),
        ] {
            assert!(Tool::parse(name, false).is_err());
            assert_eq!(Tool::parse(name, true).unwrap(), tool);
        }
        for name in ["", "settings", "native", "https://example.com"] {
            assert!(Tool::parse(name, true).is_err());
        }
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
