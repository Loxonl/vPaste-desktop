//! WinUI preview sessions, native reader routing and shared rich-content fallback.
use crate::{preview_motion::PreviewRect, ScreenBounds};
use std::sync::atomic::{AtomicU64, Ordering};
use windows::Win32::{
    Foundation::{HWND, RECT},
    UI::WindowsAndMessaging::{GetForegroundWindow, IsChild, IsIconic, IsWindowVisible},
};

static REQUESTS: crate::preview_motion::PreviewRequests =
    crate::preview_motion::PreviewRequests::new();
static NAVIGATION_SOURCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewAccelerator {
    Dismiss,
    Navigate {
        direction: i8,
        key: &'static str,
        ctrl_key: bool,
    },
}

fn preview_accelerator_route(
    key: u32,
    control: bool,
    shift: bool,
    alt: bool,
    repeated: bool,
    image_text_preview: bool,
    pdf_preview: bool,
) -> Option<PreviewAccelerator> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_ESCAPE, VK_LEFT, VK_RIGHT, VK_SPACE, VK_TAB,
    };
    if image_text_preview || alt {
        return None;
    }
    if key == u32::from(VK_ESCAPE.0) && !control && !shift {
        return (!repeated).then_some(PreviewAccelerator::Dismiss);
    }
    // 仅 PDF 内嵌阅读器不会向 React 外壳冒泡键盘事件；网页、HTML 与文本预览由自身逻辑处理。
    if !pdf_preview {
        return None;
    }
    if key == u32::from(VK_SPACE.0) && !control && !shift {
        return (!repeated).then_some(PreviewAccelerator::Dismiss);
    }
    if !control && !shift && (key == u32::from(VK_LEFT.0) || key == u32::from(VK_RIGHT.0)) {
        return Some(PreviewAccelerator::Navigate {
            direction: if key == u32::from(VK_LEFT.0) { -1 } else { 1 },
            key: if key == u32::from(VK_LEFT.0) {
                "ArrowLeft"
            } else {
                "ArrowRight"
            },
            ctrl_key: false,
        });
    }
    if key == u32::from(VK_TAB.0) {
        return Some(PreviewAccelerator::Navigate {
            direction: if shift { -1 } else { 1 },
            key: "Tab",
            ctrl_key: control,
        });
    }
    None
}

pub(crate) fn install_escape_handler(window: &tauri::WebviewWindow) {
    use tauri::Manager;
    use webview2_com::{
        AcceleratorKeyPressedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
            COREWEBVIEW2_PHYSICAL_KEY_STATUS,
        },
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };

    let app = window.app_handle().clone();
    let result = window.with_webview(move |view| {
        let app_for_handler = app.clone();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let image_text_preview = crate::WINUI_IMAGE_TEXT_PREVIEW.load(Ordering::SeqCst);
            let pdf_preview = crate::WINUI_PDF_PREVIEW.load(Ordering::SeqCst);
            let route = unsafe {
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                let mut key = 0;
                args.KeyEventKind(&mut kind)?;
                args.VirtualKey(&mut key)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                    return Ok(());
                }
                let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                args.PhysicalKeyStatus(&mut status)?;
                let control = GetKeyState(VK_CONTROL.0.into()) < 0;
                let shift = GetKeyState(VK_SHIFT.0.into()) < 0;
                let alt = GetKeyState(VK_MENU.0.into()) < 0;
                let win = GetKeyState(VK_LWIN.0.into()) < 0 || GetKeyState(VK_RWIN.0.into()) < 0;
                if win {
                    None
                } else {
                    preview_accelerator_route(
                        key,
                        control,
                        shift,
                        alt,
                        status.WasKeyDown.as_bool(),
                        image_text_preview,
                        pdf_preview,
                    )
                }
            };
            let Some(route) = route else {
                return Ok(());
            };
            if route != PreviewAccelerator::Dismiss
                && crate::browser_preview::foreground(&app_for_handler, "preview accelerator")
            {
                return Ok(());
            }
            unsafe {
                args.SetHandled(true)?;
            }
            // PDF's embedded viewer does not bubble keydown to the React shell.
            // Leave WebView2's synchronous accelerator callback before acting.
            let generation = crate::PREVIEW_WINDOW_GENERATION.load(Ordering::SeqCst);
            let app = app_for_handler.clone();
            match route {
                PreviewAccelerator::Dismiss => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) =
                            crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                                if crate::PREVIEW_WINDOW_GENERATION.load(Ordering::SeqCst)
                                    == generation
                                {
                                    crate::hide_preview_window(app)?;
                                }
                                Ok(())
                            })
                            .await
                        {
                            log::warn!(
                                "Failed to close WinUI preview with key accelerator: {error}"
                            );
                        }
                    });
                }
                PreviewAccelerator::Navigate {
                    direction,
                    key,
                    ctrl_key,
                } => {
                    let key_owned = key.to_string();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) =
                            crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                                if crate::PREVIEW_WINDOW_GENERATION.load(Ordering::SeqCst)
                                    == generation
                                {
                                    crate::preview_navigate_selection(
                                        app,
                                        direction,
                                        key_owned,
                                        Some(ctrl_key),
                                    )?;
                                }
                                Ok(())
                            })
                            .await
                        {
                            log::warn!(
                                "Failed to navigate WinUI preview with key accelerator: {error}"
                            );
                        }
                    });
                }
            }
            Ok(())
        }));
        // SAFETY: with_webview runs on the owning STA; the controller owns the
        // callback until the auxiliary WebView is destroyed.
        let mut token = 0;
        if let Err(error) = unsafe {
            view.controller()
                .add_AcceleratorKeyPressed(&handler, &mut token)
        } {
            log::warn!("Failed to install WinUI preview Escape handler: {error}");
        }
    });
    if let Err(error) = result {
        log::warn!("Failed to reach WinUI preview WebView: {error}");
    }
}

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
    window()?;
    let (info, rect, scale) = super::layout::panel_geometry()?;
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
    super::reader::begin(request);
    request
}

pub(crate) fn current(request: u64) -> bool {
    crate::main_panel_mode::winui()
        && crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
        && REQUESTS.current(request)
}

pub(crate) fn closed() -> u64 {
    NAVIGATION_SOURCE.store(0, Ordering::Release);
    let ticket = REQUESTS.cancel();
    super::reader::hide(ticket);
    ticket
}

pub(crate) fn release_closed_renderer(
    app: &tauri::AppHandle,
    window: tauri::WebviewWindow,
    closed: u64,
) {
    let owner = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Reservations share this lock. Retire this exact hidden instance only
        // if no new shared/native preview or pin has superseded its close.
        let _pending = crate::PREVIEW_PENDING
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if crate::PREVIEW_REQUESTS.inactive_version() != Some(closed)
            || crate::PREVIEW_PINNED.load(Ordering::SeqCst)
            || window.is_visible().unwrap_or(false)
        {
            return;
        }
        let result = crate::browser_preview::release(&owner)
            .and_then(|_| crate::auxiliary_windows::destroy(&window));
        match result {
            Ok(()) => log::info!("WinUI closed preview renderer released: generation={closed}"),
            Err(error) => log::warn!("Failed to release closed WinUI preview: {error}"),
        }
    });
}

pub(crate) fn reader_visible() -> bool {
    super::reader::visible()
}
pub(crate) fn reader_foreground() -> bool {
    super::reader::foreground()
}
pub(crate) fn reader_cursor_inside() -> bool {
    super::reader::cursor_inside()
}
pub(crate) fn focus_reader() {
    super::send_response(0, "nativeReaderFocus", Ok(serde_json::json!({})));
}
pub(crate) fn reader_handoff(shared_request: u64) -> Option<(bool, Option<RECT>)> {
    // Snapshot focus without hiding the old content. Retirement happens only
    // after the shared renderer has successfully shown its ready replacement.
    let _pending = crate::PREVIEW_PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !crate::PREVIEW_REQUESTS.current(shared_request) {
        return None;
    }
    let foreground = super::reader::foreground();
    Some((foreground, super::reader::visible_rect()))
}

pub(crate) fn retire_reader(shared_request: u64) {
    let _pending = crate::PREVIEW_PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if crate::PREVIEW_REQUESTS.current(shared_request) {
        super::reader::retire();
    }
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
    let Some(owner) = surface() else {
        return Ok(serde_json::Value::Null);
    };
    let area = owner.preview_area(crate::PREVIEW_CLIPBOARD_GAP);
    let owned_hash = hash.clone();
    let body =
        tauri::async_runtime::spawn_blocking(move || super::reader::prepare(&owned_hash, area))
            .await
            .map_err(|error| error.to_string())?;
    if !current(request) {
        return Ok(serde_json::Value::Null);
    }
    if mode == crate::PreviewMode::Hover
        && (!crate::config::get().hover_preview_enabled
            || !(foreground()
                || (crate::PREVIEW_HOVER.load(Ordering::SeqCst)
                    && crate::app_window_is_foreground(
                        &app,
                        "clipboardPreview",
                        "native hover guard",
                    ))))
    {
        cancel_hover_request(&app, Some(request));
        return Ok(serde_json::Value::Null);
    }
    if !mode.allows(
        open(),
        crate::PREVIEW_HOVER.load(Ordering::SeqCst),
        crate::preview_protected_from_replacement(),
    ) {
        return Ok(serde_json::Value::Null);
    }
    match body {
        Ok(Some(body)) => {
            super::reader::show(&app, body, request, mode);
            return Ok(serde_json::Value::Null);
        }
        Ok(None) => {}
        Err(error) => {
            // Preserve the existing renderer's unsupported/missing-content
            // behavior when a native source cannot be prepared.
            log::debug!("Native preview preparation fell back to the shared reader: {error}");
        }
    }
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

    #[test]
    fn winui_regression_pdf_preview_forwards_space_and_arrows_outside_ocr_input() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            VK_ESCAPE, VK_LEFT, VK_RIGHT, VK_SPACE, VK_TAB,
        };
        // PDF 预览内嵌 viewer 不冒泡按键：仅在 PDF 状态下转发 Space 关闭与左右/Tab 切换。
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_SPACE.0),
                false,
                false,
                false,
                false,
                false,
                true
            ),
            Some(super::PreviewAccelerator::Dismiss)
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_LEFT.0),
                false,
                false,
                false,
                false,
                false,
                true
            ),
            Some(super::PreviewAccelerator::Navigate {
                direction: -1,
                key: "ArrowLeft",
                ctrl_key: false,
            })
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_RIGHT.0),
                false,
                false,
                false,
                false,
                false,
                true
            ),
            Some(super::PreviewAccelerator::Navigate {
                direction: 1,
                key: "ArrowRight",
                ctrl_key: false,
            })
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_TAB.0),
                true,
                true,
                false,
                false,
                false,
                true
            ),
            Some(super::PreviewAccelerator::Navigate {
                direction: -1,
                key: "Tab",
                ctrl_key: true,
            })
        );
        // 网页 / HTML / 普通非 PDF 预览不得在 WebView2 加速器阶段拦截空格或方向键，避免网页输入框无法输入空格。
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_SPACE.0),
                false,
                false,
                false,
                false,
                false,
                false
            ),
            None
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_LEFT.0),
                false,
                false,
                false,
                false,
                false,
                false
            ),
            None
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_TAB.0),
                false,
                false,
                false,
                false,
                false,
                false
            ),
            None
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_ESCAPE.0),
                false,
                false,
                false,
                false,
                false,
                false
            ),
            Some(super::PreviewAccelerator::Dismiss)
        );
        // OCR 图片文本输入状态下保持全量放行（含 Escape/IME 与空格/左右箭头），交由 OCR 自身处理。
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_SPACE.0),
                false,
                false,
                false,
                false,
                true,
                false
            ),
            None
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_LEFT.0),
                false,
                false,
                false,
                false,
                true,
                false
            ),
            None
        );
        assert_eq!(
            super::preview_accelerator_route(
                u32::from(VK_ESCAPE.0),
                false,
                false,
                false,
                false,
                true,
                false
            ),
            None
        );
    }
}
