//! WinUI ownership of the existing auxiliary preview, not a second renderer.
use crate::{preview_motion::PreviewRect, ScreenBounds};
use std::sync::atomic::{AtomicU64, Ordering};
use windows::Win32::{
    Foundation::{HWND, RECT},
    UI::WindowsAndMessaging::{GetForegroundWindow, IsChild, IsIconic, IsWindowVisible},
};

static REQUESTS: crate::preview_motion::PreviewRequests =
    crate::preview_motion::PreviewRequests::new();
static NAVIGATION_SOURCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub(crate) struct Surface {
    pub(crate) bounds: ScreenBounds,
    rect: PreviewRect,
}

impl Surface {
    fn from_physical(work: RECT, panel: RECT, scale: f64) -> Option<Self> {
        if !scale.is_finite()
            || scale <= 0.0
            || work.right <= work.left
            || work.bottom <= work.top
            || panel.right <= panel.left
            || panel.bottom <= panel.top
        {
            return None;
        }
        Some(Self {
            bounds: ScreenBounds {
                x: f64::from(work.left) / scale,
                y: f64::from(work.top) / scale,
                width: f64::from(work.right - work.left) / scale,
                height: f64::from(work.bottom - work.top) / scale,
                scale_factor: scale,
            },
            rect: PreviewRect {
                x: f64::from(panel.left) / scale,
                y: f64::from(panel.top) / scale,
                width: f64::from(panel.right - panel.left) / scale,
                height: f64::from(panel.bottom - panel.top) / scale,
            },
        })
    }

    // A full-width docked strip leaves the usable region above it. Retain the
    // adjacent-region fallback for management views and unusually small screens.
    pub(crate) fn preview_area(self, gap: f64) -> ScreenBounds {
        let b = self.bounds;
        let right = b.x + b.width;
        let bottom = b.y + b.height;
        let left_edge = (self.rect.x - gap).clamp(b.x, right);
        let right_edge = (self.rect.x + self.rect.width + gap).clamp(b.x, right);
        let top_edge = (self.rect.y - gap).clamp(b.y, bottom);
        let bottom_edge = (self.rect.y + self.rect.height + gap).clamp(b.y, bottom);
        [
            ScreenBounds {
                width: left_edge - b.x,
                ..b
            },
            ScreenBounds {
                x: right_edge,
                width: right - right_edge,
                ..b
            },
            ScreenBounds {
                height: top_edge - b.y,
                ..b
            },
            ScreenBounds {
                y: bottom_edge,
                height: bottom - bottom_edge,
                ..b
            },
        ]
        .into_iter()
        .filter(|area| {
            area.width >= crate::PREVIEW_IMAGE_MIN_WIDTH
                && area.height >= crate::PREVIEW_IMAGE_MIN_HEIGHT
        })
        .max_by(|a, b| (a.width * a.height).total_cmp(&(b.width * b.height)))
        .unwrap_or(b)
    }
}

fn window() -> Option<HWND> {
    if !crate::main_panel_mode::winui() || !crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst) {
        return None;
    }
    let panel = super::api().ok()?;
    // SAFETY: the export only snapshots the HWND under the native state mutex.
    let window = HWND(unsafe { (panel.window_handle)() } as isize);
    // SAFETY: these APIs query a process-owned handle; a concurrently closed
    // window simply fails the visibility/geometry queries.
    (window.0 != 0 && unsafe { IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() })
        .then_some(window)
}

pub(crate) fn surface() -> Option<Surface> {
    let window = window()?;
    let (info, rect, scale) = super::layout::physical_geometry(window)?;
    Surface::from_physical(info.rcWork, rect, scale)
}

pub(crate) fn foreground() -> bool {
    window().is_some_and(|window| {
        // SAFETY: only compares/query handles, without activating another app.
        let foreground = unsafe { GetForegroundWindow() };
        window == foreground || unsafe { IsChild(window, foreground).as_bool() }
    })
}

pub(crate) fn cursor_inside() -> bool {
    surface()
        .zip(crate::cursor_physical_position())
        .is_some_and(|(surface, point)| {
            let r = surface.rect;
            crate::preview_focus::rect_contains_point(
                (r.x, r.y, r.width, r.height),
                surface.bounds.scale_factor,
                (point.x, point.y),
            )
        })
}

pub(crate) fn focus() -> Result<(), String> {
    if window().is_none() {
        return Ok(());
    }
    let panel = super::api()?;
    // SAFETY: the export marshals focus to the owning WinUI STA without waiting.
    super::check_hresult("preview focus return", unsafe { (panel.focus_history)() })
}

pub(super) fn reserve(source_request: u64, mode: crate::PreviewMode) -> u64 {
    let mut pending = crate::PREVIEW_PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let request = REQUESTS.begin();
    NAVIGATION_SOURCE.store(source_request, Ordering::Release);
    crate::PREVIEW_REQUESTS.begin();
    crate::PREVIEW_HOVER.store(mode == crate::PreviewMode::Hover, Ordering::SeqCst);
    crate::PREVIEW_HOVER_REQUEST.fetch_add(1, Ordering::SeqCst);
    *pending = None;
    request
}

pub(crate) fn current(request: u64) -> bool {
    crate::main_panel_mode::winui()
        && crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
        && REQUESTS.current(request)
}

pub(crate) fn closed() -> u64 {
    NAVIGATION_SOURCE.store(0, Ordering::Release);
    REQUESTS.cancel()
}

pub(crate) fn pinned() {
    // Pinning invalidates pending work but leaves the displayed reader open.
    REQUESTS.begin();
}

pub(super) fn open() -> bool {
    REQUESTS.active()
        || crate::PREVIEW_REQUESTS.active()
        || crate::PREVIEW_PINNED.load(Ordering::SeqCst)
}

pub(super) fn close(app: &tauri::AppHandle) {
    let ticket = closed();
    crate::cancel_preview_content();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if REQUESTS.version_current(ticket) && !crate::PREVIEW_REQUESTS.active() {
            let _ = crate::hide_preview_window(handle);
        }
    });
}

pub(super) fn cancel_hover(app: &tauri::AppHandle) {
    cancel_hover_request(app, None);
}

fn cancel_hover_request(app: &tauri::AppHandle, expected: Option<u64>) {
    let ticket = {
        // Reserve uses this same lock: an old failed preflight cannot close a
        // newer hover/manual request between checking and clearing its state.
        let mut pending = crate::PREVIEW_PENDING
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !crate::PREVIEW_HOVER.load(Ordering::SeqCst)
            || crate::PREVIEW_PINNED.load(Ordering::SeqCst)
            || expected.is_some_and(|request| !REQUESTS.current(request))
        {
            return;
        }
        let ticket = closed();
        crate::PREVIEW_HOVER.store(false, Ordering::SeqCst);
        crate::PREVIEW_HOVER_REQUEST.fetch_add(1, Ordering::SeqCst);
        crate::PREVIEW_REQUESTS.cancel();
        *pending = None;
        ticket
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if REQUESTS.version_current(ticket)
            && !crate::PREVIEW_REQUESTS.active()
            && !crate::PREVIEW_PINNED.load(Ordering::SeqCst)
        {
            let _ = crate::retain_preview_window(&handle);
        }
    });
}

pub(crate) fn pointer_changed(inside: bool) {
    if crate::PREVIEW_HOVER.load(Ordering::SeqCst) {
        super::send_response(0, "previewHover", Ok(serde_json::json!({"inside":inside})));
    }
}

fn hover_type_supported(item_type: &str) -> bool {
    matches!(item_type, "Text" | "TextFile" | "Image" | "Link")
}

fn hover_content_supported(item_type: &str, content: &str) -> Result<bool, String> {
    if !hover_type_supported(item_type) {
        return Ok(false);
    }
    // Match the shipping automatic-preview budget, without decoding pixels.
    if item_type == "Image" {
        return crate::history_image_metadata_for_path(content)
            .map(|metadata| !metadata.preview_limited);
    }
    Ok(true)
}

pub(super) fn owner_hidden() {
    let ticket = if crate::PREVIEW_PINNED.load(Ordering::SeqCst) {
        REQUESTS.begin()
    } else {
        closed()
    };
    crate::cancel_preview_content();
    let Some(app) = super::APP.get() else {
        return;
    };
    let handle = app.clone();
    // A visibility callback can run while Tauri waits for the native UI thread.
    // Queue the WebView hide instead of synchronously calling back into Tauri.
    let _ = app.run_on_main_thread(move || {
        if REQUESTS.version_current(ticket)
            && !crate::PREVIEW_REQUESTS.active()
            && !crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
            && !crate::PREVIEW_PINNED.load(Ordering::SeqCst)
        {
            let _ = crate::retain_preview_window(&handle);
        }
    });
}

pub(super) async fn show(
    app: tauri::AppHandle,
    hash: String,
    mode: crate::PreviewMode,
    direction: i8,
    request: u64,
) -> Result<serde_json::Value, String> {
    if !current(request) {
        return Ok(serde_json::Value::Null);
    }
    // Hover guards run before history hydration in the shared reader. Supply
    // the actual stored type instead of trusting native display metadata.
    let item_type = if mode == crate::PreviewMode::Hover {
        let hash = hash.clone();
        let preflight = tauri::async_runtime::spawn_blocking(move || {
            let item = crate::clipboard::try_get_by_hash(&hash)
                .ok_or_else(|| "clipboard item is no longer available".to_string())?;
            let item_type = item.item_type.to_string();
            let path = if item.content.is_empty() {
                &item.preview_content
            } else {
                &item.content
            };
            hover_content_supported(&item_type, path)
                .map(|supported| supported.then_some(item_type))
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        if !current(request) {
            return Ok(serde_json::Value::Null);
        }
        match preflight {
            Ok(Some(item_type)) => item_type,
            result => {
                cancel_hover_request(&app, Some(request));
                return result.map(|_| serde_json::Value::Null);
            }
        }
    } else {
        String::new()
    };
    let result = crate::prepare_preview_window(
        app.clone(),
        item_type,
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        Some(mode),
        (mode == crate::PreviewMode::Hover)
            .then(|| crate::PREVIEW_HOVER_REQUEST.load(Ordering::SeqCst)),
        Some(direction),
        None,
        Some(hash),
        None,
        Some(request),
    )
    .await;
    if mode == crate::PreviewMode::Hover && current(request) && result.is_err() {
        cancel_hover_request(&app, Some(request));
    }
    result?;
    Ok(serde_json::Value::Null)
}

pub(crate) fn navigate(direction: i8, key: &str, ctrl_key: bool) {
    // The auxiliary WebView can finish a key event after the preview has been
    // dismissed. Never let that late event move the hidden native selection.
    if !open() {
        return;
    }
    let source_request = NAVIGATION_SOURCE.load(Ordering::Acquire);
    if source_request == 0 {
        return;
    }
    super::send_response(
        0,
        "previewNavigation",
        Ok(serde_json::json!({
            "direction": direction, "key": key, "ctrlKey": ctrl_key,
            "sourceRequest": source_request,
        })),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn hover_uses_the_same_supported_types_and_never_replaces_manual_or_pinned_readers() {
        for item_type in ["Text", "TextFile", "Image", "Link"] {
            assert!(hover_type_supported(item_type));
        }
        for item_type in ["File", "Color", "ImageText", "", "unknown"] {
            assert!(!hover_type_supported(item_type));
        }
        assert!(!crate::PreviewMode::Hover.allows(true, false, false));
        assert!(!crate::PreviewMode::Hover.allows(true, true, true));
    }

    #[test]
    fn automatic_images_keep_the_shipping_budget_and_missing_file_guard() {
        let directory = tempfile::tempdir().unwrap();
        for (name, width, height, allowed) in [
            ("small.svg", 80, 60, true),
            ("oversized.svg", 12_000, 5_000, false),
        ] {
            let path = directory.path().join(name);
            std::fs::write(
                &path,
                format!(
                    r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"/>"#
                ),
            )
            .unwrap();
            assert_eq!(
                hover_content_supported("Image", path.to_str().unwrap()).unwrap(),
                allowed
            );
        }
        let missing = directory.path().join("missing.png");
        assert!(hover_content_supported("Image", missing.to_str().unwrap()).is_err());
        assert!(hover_content_supported("Text", "Plain text").unwrap());
        assert!(!hover_content_supported("File", missing.to_str().unwrap()).unwrap());
    }

    #[test]
    fn placement_uses_the_owner_monitor_work_area_and_physical_dpi() {
        for scale in [1.0, 1.5, 2.0] {
            let physical = |value: f64| (value * scale) as i32;
            let surface = Surface::from_physical(
                rect(physical(-1920.0), physical(-200.0), 0, physical(840.0)),
                rect(
                    physical(-1000.0),
                    physical(0.0),
                    physical(-20.0),
                    physical(600.0),
                ),
                scale,
            )
            .unwrap();
            assert_eq!(surface.bounds.x, -1920.0);
            assert_eq!(surface.bounds.height, 1040.0);
            let area = surface.preview_area(16.0);
            assert_eq!(area.x + area.width + 16.0, surface.rect.x);
            assert_eq!(area.scale_factor, scale);
        }
    }

    #[test]
    fn small_screens_fall_back_to_the_work_area_not_an_unusable_strip() {
        let surface =
            Surface::from_physical(rect(0, 0, 1280, 760), rect(150, 80, 1130, 680), 1.0).unwrap();
        let area = surface.preview_area(16.0);
        assert_eq!(
            (area.x, area.y, area.width, area.height),
            (0.0, 0.0, 1280.0, 760.0)
        );
        assert!(Surface::from_physical(rect(0, 0, 1280, 760), rect(0, 0, 0, 600), 1.0).is_none());
        assert!(Surface::from_physical(rect(0, 0, 1280, 760), rect(0, 0, 980, 600), 0.0).is_none());
    }

    #[test]
    fn bottom_docked_panel_keeps_space_preview_above_the_actual_native_edge() {
        for scale in [1.0, 1.5, 2.0] {
            let physical = |value: f64| (value * scale).round() as i32;
            let surface = Surface::from_physical(
                rect(physical(-1920.0), physical(-200.0), 0, physical(840.0)),
                rect(physical(-1920.0), physical(578.0), 0, physical(880.0)),
                scale,
            )
            .unwrap();
            let area = surface.preview_area(16.0);
            assert_eq!((area.x, area.y, area.width), (-1920.0, -200.0, 1920.0));
            assert_eq!(area.y + area.height, surface.rect.y - 16.0);
        }
    }
}
