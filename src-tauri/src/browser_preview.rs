use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const LABEL: &str = "previewBrowser";
const KEY_HOST: &str = "keyboard.vpaste.invalid";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
}

impl Bounds {
    fn physical(self, width: u32, height: u32) -> Option<(i32, i32, u32, u32)> {
        let values = [
            self.x,
            self.y,
            self.width,
            self.height,
            self.viewport_width,
            self.viewport_height,
        ];
        if !values.iter().all(|value| value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.viewport_width <= 0.0
            || self.viewport_height <= 0.0
            || self.x + self.width > self.viewport_width + 1.0
            || self.y + self.height > self.viewport_height + 1.0
        {
            return None;
        }
        let sx = f64::from(width) / self.viewport_width;
        let sy = f64::from(height) / self.viewport_height;
        Some((
            (self.x * sx).round() as i32,
            (self.y * sy).round() as i32,
            (self.width * sx).round().max(1.0) as u32,
            (self.height * sy).round().max(1.0) as u32,
        ))
    }
}

#[derive(Default)]
struct Session {
    owner: Option<u64>,
    url: String,
    navigated: bool,
    bounds: Option<Bounds>,
}

impl Session {
    fn mark_navigated(&mut self, request: u64, url: &str) -> bool {
        if self.owner != Some(request) || self.url != url {
            return false;
        }
        self.navigated = true;
        true
    }

    fn clear_owner(&mut self, request: u64) -> bool {
        if self.owner != Some(request) {
            return false;
        }
        *self = Self::default();
        true
    }

    fn prepare(&mut self, request: u64, url: Option<String>) -> bool {
        let same_page = url.as_ref().is_some_and(|url| *url == self.url) && self.owner.is_some();
        self.owner = url.as_ref().map(|_| request);
        self.url = url.unwrap_or_default();
        if !same_page {
            self.navigated = false;
            self.bounds = None;
        }
        !same_page
    }
}

static SESSION: Mutex<Session> = Mutex::new(Session {
    owner: None,
    url: String::new(),
    navigated: false,
    bounds: None,
});

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewKey {
    key: String,
    ctrl_key: bool,
    shift_key: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Location {
    request_id: u64,
    url: String,
}

fn keyboard_signal(url: &reqwest::Url, token: &str) -> Option<PreviewKey> {
    if url.scheme() != "https" || url.host_str() != Some(KEY_HOST) {
        return None;
    }
    let parts: Vec<_> = url.path_segments()?.collect();
    if parts.len() != 4
        || parts[0] != token
        || !matches!(
            parts[1],
            "Escape" | "Space" | "ArrowLeft" | "ArrowRight" | "Tab"
        )
        || !matches!(parts[2], "0" | "1")
        || !matches!(parts[3], "0" | "1")
    {
        return None;
    }
    Some(PreviewKey {
        key: if parts[1] == "Space" {
            " ".into()
        } else {
            parts[1].into()
        },
        ctrl_key: parts[2] == "1",
        shift_key: parts[3] == "1",
    })
}

fn page_url(content: &str) -> Option<String> {
    let url = content.split("|||").next()?.trim();
    let url = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    crate::preview_http::is_previewable_domain_link(&url).then_some(url)
}

fn build(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let parent = app
        .get_webview_window("clipboardPreview")
        .ok_or("link_preview_network")?;
    let token = format!("{:032x}", rand::random::<u128>());
    let handle = app.clone();
    let builder = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("vPaste Web Preview")
    .visible(false)
    .focused(false)
    .decorations(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .resizable(false)
    .shadow(false)
    .inner_size(1.0, 1.0)
    .initialization_script_for_all_frames(
        include_str!("browser_preview_keys.js").replace("__TOKEN__", &token),
    )
    .on_navigation(move |url| {
        if url.host_str() == Some(KEY_HOST) {
            if let Some(key) = keyboard_signal(url, &token) {
                if SESSION
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .owner
                    .is_some()
                    && foreground(&handle, "webpage keyboard")
                {
                    let _ = handle.emit_to("clipboardPreview", "preview-browser-key", key);
                }
            }
            return false;
        }
        if url.as_str() == "about:blank" {
            return true;
        }
        if !crate::preview_http::is_previewable_domain_link(url.as_str()) {
            return false;
        }
        let owner = SESSION.lock().unwrap_or_else(|e| e.into_inner()).owner;
        if let Some(request_id) = owner {
            let _ = handle.emit_to(
                "clipboardPreview",
                "preview-browser-location",
                Location {
                    request_id,
                    url: url.to_string(),
                },
            );
            true
        } else {
            false
        }
    })
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny);
    #[cfg(target_os = "windows")]
    let builder = builder.owner(&parent).map_err(|_| "link_preview_network")?;
    #[cfg(target_os = "macos")]
    let builder = builder
        .parent(&parent)
        .map_err(|_| "link_preview_network")?;
    let window = builder.build().map_err(|error| {
        log::error!("Failed to create webpage preview: {error}");
        "link_preview_network"
    })?;
    #[cfg(target_os = "macos")]
    crate::set_macos_window_level(&window, 102);
    Ok(window)
}

pub(crate) fn prewarm(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = build(&handle);
    });
}

fn park(app: &tauri::AppHandle, owner: Option<u64>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if SESSION.lock().unwrap_or_else(|e| e.into_inner()).owner != owner {
            return;
        }
        if let Some(window) = handle.get_webview_window(LABEL) {
            let _ = window.hide();
            let _ = window.navigate("about:blank".parse().unwrap());
        }
    });
}

pub(crate) fn prepare(app: &tauri::AppHandle, request: u64, content: Option<&str>) {
    let url = content.and_then(page_url);
    let (reset, owner) = {
        let mut session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let reset = session.prepare(request, url);
        (reset, session.owner)
    };
    if reset {
        park(app, owner);
    }
}

pub(crate) fn clear(app: &tauri::AppHandle) {
    *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = Session::default();
    park(app, None);
}

pub(crate) fn foreground(app: &tauri::AppHandle, context: &str) -> bool {
    app.get_webview_window(LABEL).is_some_and(|window| {
        window.is_visible().unwrap_or(false)
            && (window.is_focused().unwrap_or(false)
                || crate::is_native_window_foreground(&window, context))
    })
}

fn focus_window_content(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.set_focus().map_err(|_| "link_preview_network")?;
    AsRef::<tauri::Webview>::as_ref(window)
        .set_focus()
        .map_err(|_| "link_preview_network".into())
}

pub(crate) fn focus_under_cursor(app: &tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(LABEL).filter(|window| {
        window.is_visible().unwrap_or(false) && crate::cursor_inside_window(window)
    }) {
        crate::activate_native_window(&window, "focus webpage preview");
        focus_window_content(&window)?;
        return Ok(true);
    }
    Ok(false)
}

pub(crate) fn follow_parent(app: &tauri::AppHandle) -> Result<(), String> {
    let bounds = SESSION.lock().unwrap_or_else(|e| e.into_inner()).bounds;
    let (Some(bounds), Some(parent), Some(browser)) = (
        bounds,
        app.get_webview_window("clipboardPreview"),
        app.get_webview_window(LABEL),
    ) else {
        return Ok(());
    };
    let size = parent.inner_size().map_err(|_| "link_preview_network")?;
    let position = parent
        .inner_position()
        .map_err(|_| "link_preview_network")?;
    let (x, y, width, height) = bounds
        .physical(size.width, size.height)
        .ok_or("link_preview_network")?;
    browser
        .set_position(tauri::PhysicalPosition::new(
            position.x.saturating_add(x),
            position.y.saturating_add(y),
        ))
        .map_err(|_| "link_preview_network")?;
    browser
        .set_size(tauri::PhysicalSize::new(width, height))
        .map_err(|_| "link_preview_network")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_preview_browser(
    webview: tauri::Webview,
    request_id: u64,
    url: String,
    bounds: Bounds,
) -> Result<bool, String> {
    if webview.label() != "clipboardPreview" {
        return Err("link_preview_blocked".into());
    }
    let url = page_url(&url).ok_or("link_preview_blocked")?;
    let app = webview.app_handle().clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let parent = handle
                .get_webview_window("clipboardPreview")
                .ok_or("link_preview_network")?;
            if !parent.is_visible().unwrap_or(false) {
                return Ok(false);
            }
            let navigate = {
                let mut session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
                if session.owner != Some(request_id) || session.url != url {
                    return Ok(false);
                }
                let size = parent.inner_size().map_err(|_| "link_preview_network")?;
                bounds
                    .physical(size.width, size.height)
                    .ok_or("link_preview_network")?;
                session.bounds = Some(bounds);
                !session.navigated
            };
            let should_focus = crate::app_window_is_foreground(
                &handle,
                "clipboardPreview",
                "webpage initial focus",
            );
            let clipboard_had_focus =
                crate::app_window_is_foreground(&handle, "clipboard", "webpage initial focus");
            let browser = build(&handle)?;
            follow_parent(&handle)?;
            if navigate {
                browser
                    .navigate(url.parse().map_err(|_| "link_preview_blocked")?)
                    .map_err(|_| "link_preview_network")?;
                if !SESSION
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .mark_navigated(request_id, &url)
                {
                    return Ok(false);
                }
            }
            if SESSION.lock().unwrap_or_else(|e| e.into_inner()).owner != Some(request_id) {
                return Ok(false);
            }
            let showing = !browser.is_visible().unwrap_or(false);
            if showing {
                browser
                    .set_focusable(should_focus)
                    .map_err(|_| "link_preview_network")?;
                browser.show().map_err(|_| "link_preview_network")?;
                browser
                    .set_focusable(true)
                    .map_err(|_| "link_preview_network")?;
            }
            let still_owns_page =
                SESSION.lock().unwrap_or_else(|e| e.into_inner()).owner == Some(request_id);
            if (navigate || showing)
                && still_owns_page
                && (crate::app_window_is_foreground(
                    &handle,
                    "clipboardPreview",
                    "webpage focus handoff",
                ) || crate::app_window_is_foreground(
                    &handle,
                    "clipboard",
                    "webpage focus handoff",
                ))
            {
                // A foreground native window does not imply its WebView has
                // keyboard focus. Restore the original owner after showing.
                if should_focus {
                    focus_window_content(&browser)?;
                } else if clipboard_had_focus {
                    if let Some(clipboard) = handle.get_webview_window("clipboard") {
                        focus_window_content(&clipboard)?;
                    }
                }
            }
            Ok(true)
        })();
        let _ = tx.send(result);
    })
    .map_err(|_| "link_preview_network")?;
    rx.await.map_err(|_| "link_preview_network".to_string())?
}

#[tauri::command]
pub(crate) fn hide_preview_browser(webview: tauri::Webview, request_id: u64) -> Result<(), String> {
    if webview.label() != "clipboardPreview" {
        return Err("link_preview_blocked".into());
    }
    let cleared = SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear_owner(request_id);
    if cleared {
        park(webview.app_handle(), None);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webpage_session_reuses_same_page_but_resets_changed_or_non_link_content() {
        let mut session = Session::default();
        assert!(session.prepare(1, Some("https://example.com/".into())));
        session.navigated = true;
        assert!(!session.prepare(2, Some("https://example.com/".into())));
        assert_eq!(session.owner, Some(2));
        assert!(!session.clear_owner(1));
        assert_eq!(session.owner, Some(2));
        assert!(session.navigated);
        assert!(session.prepare(3, Some("https://example.org/".into())));
        assert!(!session.navigated);
        assert!(!session.mark_navigated(2, "https://example.com/"));
        assert!(!session.navigated);
        assert!(session.mark_navigated(3, "https://example.org/"));
        assert!(session.prepare(4, None));
        assert_eq!(session.owner, None);
    }

    #[test]
    fn webpage_keyboard_signal_requires_private_token_and_fixed_key_whitelist() {
        let signal = |path: &str| {
            keyboard_signal(
                &format!("https://{KEY_HOST}/{path}").parse().unwrap(),
                "secret",
            )
        };
        assert!(signal("wrong/Escape/0/0").is_none());
        assert!(signal("secret/read_history/0/0").is_none());
        assert!(signal("secret/Escape/9/0").is_none());
        let key = signal("secret/Tab/1/1").unwrap();
        assert_eq!(key.key, "Tab");
        assert!(key.ctrl_key && key.shift_key);
    }

    #[test]
    fn webpage_bounds_follow_parent_pixels_without_double_scaling() {
        let bounds = Bounds {
            x: 20.0,
            y: 80.0,
            width: 600.0,
            height: 400.0,
            viewport_width: 640.0,
            viewport_height: 500.0,
        };
        assert_eq!(bounds.physical(1280, 1000), Some((40, 160, 1200, 800)));
        assert!(Bounds {
            width: f64::NAN,
            ..bounds
        }
        .physical(1280, 1000)
        .is_none());
        assert!(Bounds { x: -1.0, ..bounds }.physical(1280, 1000).is_none());
        assert!(Bounds {
            width: 800.0,
            ..bounds
        }
        .physical(1280, 1000)
        .is_none());
    }

    #[test]
    fn webpage_urls_preserve_the_existing_entry_policy() {
        assert_eq!(
            page_url("example.com/page|||cached"),
            Some("https://example.com/page".into())
        );
        for url in [
            "file:///private",
            "javascript:alert(1)",
            "https://127.0.0.1",
            "https://tauri.localhost",
            "http://example.com",
        ] {
            assert!(page_url(url).is_none());
        }
    }
}
