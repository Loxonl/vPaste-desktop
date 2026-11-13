//! macOS DEV AppKit panel. The optional --main-ui=native route uses it without
//! creating a main WebView. Owns one bounded history view, separately from Main.
mod history;
pub(crate) mod preview;
pub(crate) mod queue_selection;
mod rich_text;

use crate::{
    clipboard::{self, item::ItemType},
    history_views::{self, HistoryQuery},
    media_resources::{self, MediaIntent},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, OnceLock,
};
use tauri::{AppHandle, Emitter, Listener, Manager};

#[repr(C)]
struct Callbacks {
    abi_version: u32,
    request: unsafe extern "C" fn(*const u8, usize),
    set_key: extern "C" fn(bool),
}
extern "C" {
    fn vpaste_native_panel_show(callbacks: *const Callbacks, config: *const u8, length: usize);
    fn vpaste_native_panel_receive(response: *const u8, length: usize);
    fn vpaste_native_panel_close(animated: bool);
    fn vpaste_native_panel_activate(toggle: bool) -> bool;
}
static CALLBACKS: Callbacks = Callbacks {
    abi_version: 1,
    request,
    set_key,
};
static APP: OnceLock<AppHandle> = OnceLock::new();
static SESSION: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static KEY: AtomicBool = AtomicBool::new(false);
static LISTENERS: Mutex<Vec<tauri::EventId>> = Mutex::new(Vec::new());
static ACTION: AtomicBool = AtomicBool::new(false);
static TAG_EDITOR_TARGET: Mutex<Option<(u64, String)>> = Mutex::new(None);
static WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static CLOSED: tokio::sync::Notify = tokio::sync::Notify::const_new();

extern "C" fn set_key(key: bool) {
    KEY.store(key, Ordering::Release);
    if key && preview::active() {
        if let Some(app) = APP.get() {
            crate::ensure_focus_watch(app);
        }
    }
}
pub(crate) fn is_key_window() -> bool {
    KEY.load(Ordering::Acquire)
}
fn current(session: u64) -> bool {
    ACTIVE.load(Ordering::Acquire) && SESSION.load(Ordering::Acquire) == session
}
fn dispose() {
    *TAG_EDITOR_TARGET
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    ACTIVE.store(false, Ordering::Release);
    KEY.store(false, Ordering::Release);
    preview::dispose(APP.get());
    SESSION.fetch_add(1, Ordering::AcqRel);
    history::suspend();
    CLOSED.notify_waiters();
    if let Some(app) = APP.get() {
        if let Some(queue) = app.get_webview_window("pasteQueue") {
            crate::set_macos_window_level(&queue, 102);
        }
        for id in LISTENERS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            app.unlisten(id);
        }
    }
    if std::env::args().any(|arg| arg == "--native-panel-check") {
        eprintln!(
            "[native-panel] disposed nativeViews={} listeners={}",
            history_views::native_view_count(),
            LISTENERS.lock().unwrap_or_else(|e| e.into_inner()).len()
        );
    }
}

// Called only inside show's AppKit-thread closure. Cocoa coordinates avoid
// monitor-origin / DPI conversion and retain the main panel's horizontal bleed.
fn main_docked_frame(app: &AppHandle) -> Option<Value> {
    use cocoa::{base::id, foundation::NSRect};
    use objc::{msg_send, sel, sel_impl};

    if !crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
        || crate::CLIPBOARD_HIDING.load(Ordering::SeqCst)
    {
        return None;
    }
    let window = app.get_webview_window("clipboard")?;
    let native = window.ns_window().ok()? as id;
    // SAFETY: main thread; Tauri owns the live NSWindow for this scope.
    let frame: NSRect = unsafe { msg_send![native, frame] };
    Some(json!({"x":frame.origin.x,"y":frame.origin.y,
        "width":frame.size.width,"height":frame.size.height}))
}

pub(crate) fn show(app: AppHandle, language: String, theme: String) -> Result<(), String> {
    present(app, language, theme, false)
}

pub(crate) fn show_default(app: AppHandle) -> Result<(), String> {
    let config = crate::config::get();
    present(app, config.multilingual, config.theme_mode, false)
}

pub(crate) fn toggle(app: AppHandle) -> Result<(), String> {
    let config = crate::config::get();
    present(app, config.multilingual, config.theme_mode, true)
}

pub(crate) fn close_preview(app: &AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        // SAFETY: AppKit thread; a size preview closes without stealing focus.
        unsafe { vpaste_native_panel_close(false) };
    })
    .map_err(|error| error.to_string())
}

fn present(app: AppHandle, language: String, theme: String, toggle: bool) -> Result<(), String> {
    if !crate::get_developer_mode() {
        return Err("Native panel requires --dev-mode".into());
    }
    APP.get_or_init(|| app.clone());
    history::watch(&app);
    app.clone()
        .run_on_main_thread(move || {
            let preview = crate::panel_size::is_previewing();
            // SAFETY: AppKit owns the controller. A normal wake focuses the
            // current surface; a shortcut toggles it. Size changes recreate it.
            if !preview && unsafe { vpaste_native_panel_activate(toggle) } {
                return;
            }
            dispose();
            crate::record_foreground_app_before_clipboard();
            let session = SESSION.fetch_add(1, Ordering::AcqRel) + 1;
            ACTIVE.store(true, Ordering::Release);
            for name in [
                "item-tags-changed",
                "tab-order-changed",
                "paste-queue-state-changed",
                "native-paste-queue-selection-changed",
            ] {
                let id = app.listen_any(name, move |event| {
                    if name == "native-paste-queue-selection-changed" {
                        if let Ok(mut payload) =
                            serde_json::from_str::<serde_json::Map<String, Value>>(event.payload())
                        {
                            payload.insert("event".into(), json!("paste-queue-state"));
                            deliver(session, Value::Object(payload));
                        }
                        return;
                    }
                    if name == "paste-queue-state-changed" {
                        deliver(session, paste_queue_toolbar_event());
                        return;
                    }
                    if name == "tab-order-changed" {
                        deliver(session, json!({"event":"tab-order-changed"}));
                        return;
                    }
                    if name == "item-tags-changed" {
                        notify_tabs_changed(session, event.payload());
                        return;
                    }
                });
                LISTENERS.lock().unwrap_or_else(|e| e.into_inner()).push(id);
            }
            let config = crate::config::get();
            let monitor = crate::target_main_monitor(&app);
            crate::panel_size::use_configured_size(monitor.as_ref());
            if let Some(monitor) = monitor.as_ref() {
                media_resources::set_capture_scale_factor(monitor.scale_factor());
            }
            let scale = crate::panel_size::scale();
            let bounds = monitor
                .as_ref()
                .map(crate::screen_bounds_from_monitor)
                .unwrap_or_else(crate::default_screen_bounds);
            preview::prepare(bounds, crate::CLIPBOARD_WINDOW_HEIGHT * scale, !preview);
            if crate::paste_queue::is_active() {
                if let Some(queue) = app.get_webview_window("pasteQueue") {
                    if let Err(error) = crate::show_paste_queue_window(&app, &queue) {
                        log::error!("Failed to position paste queue above native panel: {error}");
                    }
                }
            }
            let bytes = serde_json::to_vec(&json!({
                "session": session,
                "pasteQueue": queue_selection::snapshot(),
                "sizePreview": preview,
                "language": language,
                "theme": theme,
                "scale": scale,
                "mousePasteMode": config.mouse_paste_mode,
                "hoverPreviewEnabled": config.hover_preview_enabled,
                "tabQuickSelectEnabled": config.tab_quick_select_enabled,
                "dockedFrame": main_docked_frame(&app),
                "panelHeight": crate::CLIPBOARD_WINDOW_HEIGHT * scale,
                "horizontalBleed": 0.0,
                "showDuration": crate::panel_animation::model::SHOW_DURATION_MS,
                "hideDuration": crate::panel_animation::model::HIDE_DURATION_MS,
                "showCurve": crate::panel_animation::model::Animation::Show.easing(),
                "hideCurve": crate::panel_animation::model::Animation::Hide.easing(),
            }))
            .unwrap_or_default();
            // SAFETY: AppKit thread; both borrowed buffers are copied by Swift.
            unsafe { vpaste_native_panel_show(&CALLBACKS, bytes.as_ptr(), bytes.len()) };
            if std::env::args().any(|arg| arg == "--native-panel-check") {
                let mut labels = app.webview_windows().into_keys().collect::<Vec<_>>();
                labels.sort();
                eprintln!(
                    "[native-panel] nativeDefault={} webviews={labels:?}",
                    crate::main_panel_mode::native()
                );
            }
        })
        .map_err(|e| e.to_string())
}

fn paste_queue_toolbar_event() -> Value {
    // Queue events are signals; read live metadata so a delayed full-state
    // payload cannot restore a queue session that has already closed.
    let mut payload = queue_selection::snapshot();
    payload["event"] = json!("paste-queue-state");
    payload
}

// The tab editor saved filter tabs (the record-tag editor reports through the
// item-tags-changed listener instead).
pub(crate) fn tabs_changed(payload: &Value) {
    if ACTIVE.load(Ordering::Acquire) {
        notify_tabs_changed(SESSION.load(Ordering::Acquire), &payload.to_string());
    }
}

// Give focus back to the native panel after an auxiliary window closes.
pub(crate) fn tab_editor_closed(app: &AppHandle) -> bool {
    *TAG_EDITOR_TARGET
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    if !ACTIVE.load(Ordering::Acquire) {
        return false;
    }
    let _ = app.run_on_main_thread(|| {
        // SAFETY: dispatched to AppKit, which owns the controller.
        unsafe { vpaste_native_panel_activate(false) };
    });
    true
}

fn take_created_tag_assignment(
    target: &mut Option<(u64, String)>,
    session: u64,
    event: &Value,
) -> Option<(String, i64)> {
    if target.as_ref()?.0 != session {
        return None;
    }
    let tag_id = event["tag"]["id"].as_i64().filter(|id| *id > 0)?;
    if event["activeId"].as_str()? != format!("record:{tag_id}") {
        return None;
    }
    Some((target.take()?.1, tag_id))
}

fn notify_tabs_changed(session: u64, raw: &str) {
    let mut event = tab_change_event(raw);
    let assignment = {
        let mut target = TAG_EDITOR_TARGET
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        take_created_tag_assignment(&mut target, session, &event)
    };
    if let Some((hash, tag_id)) = assignment {
        match clipboard::assign_tag(&hash, tag_id) {
            Ok(()) => {
                if let Some(app) = APP.get() {
                    let _ = app.emit("listen_new_clipboard", ());
                }
            }
            Err(error) => {
                event["assignmentError"] = json!(error);
            }
        }
    }
    // Like the WebView, a newly created tab goes to the end of the order.
    if let Some(id) = event["activeId"]
        .as_str()
        .filter(|_| event["mode"] != "edit")
    {
        let append = || -> Result<(), String> {
            let custom = crate::get_custom_tabs()?;
            let tags = clipboard::list_tags()?;
            let known_ids = dynamic_tabs(&custom, &tags, &[])
                .into_iter()
                .map(|tab| tab.id)
                .collect::<Vec<_>>();
            clipboard::db::append_tab_order(&clipboard::db::db(), id, &known_ids)
                .map_err(|error| error.to_string())
        };
        if let Err(err) = append() {
            log::error!("Failed to store the new tab's position: {err}");
        }
    }
    deliver(session, event);
}

// Editor payload ({activeId, tag?, tabs?}) to the panel event. Tauri may
// deliver it as a JSON string that itself contains JSON.
fn tab_change_event(raw: &str) -> Value {
    let mut payload = serde_json::from_str::<Value>(raw).unwrap_or(Value::Null);
    if let Value::String(inner) = &payload {
        payload = serde_json::from_str(inner).unwrap_or(Value::Null);
    }
    let mut event = json!({
        "event": "tabs-changed",
        "activeId": payload.get("activeId").cloned().unwrap_or(Value::Null),
        "tag": payload.get("tag").cloned().unwrap_or(Value::Null),
    });
    if let Some(mode) = payload.get("mode") {
        event["mode"] = mode.clone();
    }
    event
}

// Mirrors the WebView screenAnchoredPositionFromClick: right of the anchor by
// the 6px menu gap, bottom-aligned with it, kept inside the screen.
fn tab_editor_origin(
    anchor: [f64; 2],
    size: (f64, f64),
    screen: (f64, f64, f64, f64),
) -> (f64, f64) {
    let clamp = |value: f64, extent: f64, start: f64, length: f64| {
        value.min(start + length - extent).max(start)
    };
    (
        clamp(anchor[0] + 6.0, size.0, screen.0, screen.2),
        clamp(anchor[1] - size.1, size.1, screen.1, screen.3),
    )
}

fn deliver(session: u64, mut value: Value) {
    let Some(app) = APP.get() else {
        return;
    };
    value["session"] = json!(session);
    let Ok(bytes) = serde_json::to_vec(&value) else {
        return;
    };
    let _ = app.run_on_main_thread(move || {
        if current(session) {
            // SAFETY: main thread, Swift copies this borrowed slice before return.
            unsafe { vpaste_native_panel_receive(bytes.as_ptr(), bytes.len()) };
        }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    session: u64,
    op: String,
    #[serde(default)]
    keywords: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    view_id: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    page: usize,
    #[serde(default)]
    start: usize,
    #[serde(default)]
    end: usize,
    #[serde(default)]
    hashes: Vec<String>,
    #[serde(default)]
    checkpoint: history::Checkpoint,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    activation_epoch: u64,
    #[serde(default)]
    plain: bool,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    tag_id: i64,
    #[serde(default)]
    tag_ids: Vec<i64>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    tab_id: String,
    #[serde(default)]
    target_id: String,
    #[serde(default)]
    before: bool,
    #[serde(default)]
    point: Option<[f64; 2]>,
    #[serde(default)]
    target: String,
    #[serde(default)]
    text: String,
    #[serde(default = "card_width")]
    width: u32,
    #[serde(default)]
    item_type: String,
    #[serde(default)]
    mode: crate::PreviewMode,
    #[serde(default)]
    hover_request: Option<u64>,
    #[serde(default)]
    navigation_direction: i8,
    #[serde(default)]
    frame: Option<[f64; 4]>,
    #[serde(skip)]
    preview_request: Option<u64>,
}
fn card_width() -> u32 {
    480
}

unsafe extern "C" fn request(bytes: *const u8, length: usize) {
    if bytes.is_null() || length == 0 || length > 64 * 1024 {
        return;
    }
    // SAFETY: caller owns this byte slice until this callback returns.
    let Ok(mut req) =
        serde_json::from_slice::<Request>(unsafe { std::slice::from_raw_parts(bytes, length) })
    else {
        return;
    };
    if !crate::get_developer_mode() || !current(req.session) {
        return;
    }
    if req.op == "close" {
        dispose();
        return;
    }
    let Some(app) = APP.get().cloned() else {
        return;
    };
    match req.op.as_str() {
        "history-checkpoint" => {
            history::checkpoint(&req.view_id, req.checkpoint);
            return;
        }
        "paste-queue-select" => {
            let result = queue_selection::toggle(&req.hash, req.activation_epoch);
            let response = match result {
                Ok(data) => json!({"id":req.id,"data":data}),
                Err(error) => json!({"id":req.id,"error":error}),
            };
            deliver(req.session, response);
            return;
        }
        "surface" => {
            if let Some(frame) = req.frame {
                preview::publish(frame);
            }
            return;
        }
        "blur" => {
            crate::handle_main_panel_focus_lost(app);
            return;
        }
        "hover-dismiss" => {
            let _ = preview::dismiss_hover(&app, req.hover_request);
            return;
        }
        "preview-close" => {
            let _ = crate::retain_preview_window(&app);
            return;
        }
        "preview-toggle" => {
            let _ = preview::dismiss_hover(&app, None);
            if crate::is_preview_window_visible(app.clone()) {
                let _ = crate::retain_preview_window(&app);
                deliver(req.session, json!({"id":req.id,"data":null}));
                return;
            }
            req.op = "preview".into();
        }
        _ => {}
    }
    if req.op == "preview" {
        if (req.mode == crate::PreviewMode::Hover && !crate::config::get().hover_preview_enabled)
            || !req.mode.allows(
                crate::is_preview_window_visible(app.clone()),
                crate::PREVIEW_HOVER.load(Ordering::SeqCst),
                crate::PREVIEW_PINNED.load(Ordering::SeqCst),
            )
        {
            deliver(req.session, json!({"id":req.id,"data":null}));
            return;
        }
        req.preview_request = Some(preview::reserve(req.mode));
    }
    let open = if matches!(req.op.as_str(), "open" | "history-resume") {
        history_views::reserve_native_open()
    } else {
        0
    };
    let Some(app) = APP.get().cloned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let Ok(_permit) = WORK.acquire().await else {
            return;
        };
        if !current(req.session) {
            return;
        }
        let result = dispatch(&app, &req, open).await;
        if result.is_err() && req.preview_request.is_some_and(preview::current) {
            let _ = preview::close_owned(&app);
        }
        match result {
            Ok(data) => deliver(req.session, json!({"id":req.id,"op":req.op,"data":data})),
            Err(error) => deliver(req.session, json!({"id":req.id,"op":req.op,"error":error})),
        }
    });
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}
async fn begin_close(app: &AppHandle) -> Result<(), String> {
    crate::auxiliary_windows::on_main_thread(app.clone(), || {
        // SAFETY: dispatched to AppKit. Completion disposes the native query.
        unsafe { vpaste_native_panel_close(true) };
        Ok(())
    })
    .await
}

async fn close_for_action(app: &AppHandle) -> Result<(), String> {
    let session = SESSION.load(Ordering::Acquire);
    // Register before scheduling the close; reduced motion can finish in that
    // same main-thread turn. Auxiliary windows open after the panel is gone.
    let closed = CLOSED.notified();
    tokio::pin!(closed);
    closed.as_mut().enable();
    begin_close(app).await?;
    if current(session) {
        tokio::time::timeout(std::time::Duration::from_secs(2), closed)
            .await
            .map_err(|_| "Native panel did not finish closing".to_string())?;
    }
    Ok(())
}

async fn dispatch(app: &AppHandle, r: &Request, open: u64) -> Result<Value, String> {
    let hash = r.hash.clone();
    match r.op.as_str() {
        "open" => {
            let query = HistoryQuery {
                keywords: r.keywords.clone(),
                label: r.label.clone(),
            };
            let tab = r.tab_id.clone();
            blocking(move || history::open(query, tab, open)).await
        }
        "history-resume" => blocking(move || history::resume(panel_tabs()?, open)).await,
        "history-sync" => {
            if r.hashes.len() > 216 {
                return Err("too many retained refs".into());
            }
            history::checkpoint(&r.view_id, r.checkpoint.clone());
            let (id, revision, known) = (r.view_id.clone(), r.revision, r.hashes.clone());
            blocking(move || history::synchronize(&id, revision, &known)).await
        }
        "page" => {
            let (id, revision, page) = (r.view_id.clone(), r.revision, r.page);
            let page = blocking(move || history_views::read_page(&id, revision, page)).await?;
            history::page_sent(&page);
            serde_json::to_value(page).map_err(|e| e.to_string())
        }
        "cards" => {
            history_views::validate_native(&r.view_id, r.revision)?;
            if r.hashes.len() > 24 {
                return Err("too many cards".into());
            }
            let mut cards = Vec::new();
            for hash in &r.hashes {
                if !current(r.session) {
                    break;
                }
                history_views::validate_native(&r.view_id, r.revision)?;
                let hash = hash.clone();
                let width = r.width;
                if let Ok(card) = blocking(move || display_card(&hash, width)).await {
                    cards.push(card);
                }
            }
            Ok(json!({"cards":cards}))
        }
        "viewport" => {
            let (id, revision, start, end) = (r.view_id.clone(), r.revision, r.start, r.end);
            blocking(move || history_views::set_viewport(&id, revision, start, end)).await?;
            Ok(Value::Null)
        }
        "copy" | "paste" => {
            // A queue shortcut may beat its UI notification. Select before any
            // clipboard side effect; explicit plain-text menu paste is retained.
            if queue_selection::intercepts_paste(&r.op, r.plain, crate::paste_queue::is_active()) {
                let status =
                    queue_selection::toggle(&hash, crate::paste_queue::activation_epoch())?;
                let _ = app.emit("native-paste-queue-selection-changed", &status);
                return Ok(status);
            }
            if ACTION.swap(true, Ordering::AcqRel) {
                return Err("Another clipboard action is running".into());
            }
            struct Reset;
            impl Drop for Reset {
                fn drop(&mut self) {
                    ACTION.store(false, Ordering::Release);
                }
            }
            let _reset = Reset;
            let info = crate::history_item_action_info(hash.clone()).await?;
            if !info.missing_paths.is_empty() {
                return Err(format!("Source file missing: {}", info.missing_paths[0]));
            }
            crate::copy_history_record(app.clone(), hash.clone(), r.plain).await?;
            if r.op == "paste" {
                let allowed = crate::check_paste_accessibility_permission().granted;
                // As in the original main panel, focus restoration/paste runs
                // alongside the hide animation instead of adding its duration.
                begin_close(app).await?;
                let handle = app.clone();
                crate::auxiliary_windows::on_main_thread(handle.clone(), move || {
                    if let Some(window) = handle.get_webview_window("clipboard") {
                        crate::hide_clipboard_window(&window);
                    }
                    Ok(())
                })
                .await?;
                if allowed {
                    let result = blocking(move || crate::paste(&hash, None, None)).await;
                    if result.is_err() {
                        let _ = crate::show_paste_fallback_notice(app.clone()).await;
                    }
                    result?;
                } else {
                    crate::restore_foreground_app();
                    let _ = crate::show_paste_fallback_notice(app.clone()).await;
                }
            }
            Ok(json!({"copied":true}))
        }
        "favorite" => {
            let favorite = r.favorite;
            blocking(move || crate::set_item_favorite(hash, favorite)).await?;
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "delete" => {
            let worker_app = app.clone();
            blocking(move || crate::delete_clipboard_item(worker_app, hash)).await?;
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "tabs" => {
            let tabs = blocking(panel_tabs).await?;
            serde_json::to_value(tabs).map_err(|e| e.to_string())
        }
        "tags" => {
            let tags = blocking(clipboard::list_tags).await?;
            serde_json::to_value(tags).map_err(|e| e.to_string())
        }
        "color-options" => {
            let options = blocking(move || {
                let item = clipboard::history_action_item(&hash)?;
                Ok(clipboard::color::color_variants(&item.content))
            })
            .await?;
            serde_json::to_value(options).map_err(|e| e.to_string())
        }
        "tag-assign" => {
            let tag_id = r.tag_id;
            blocking(move || clipboard::assign_tag(&hash, tag_id)).await?;
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "tag-remove" => {
            let tag_ids = r.tag_ids.clone();
            blocking(move || {
                tag_ids
                    .iter()
                    .try_for_each(|tag_id| clipboard::remove_tag(&hash, *tag_id))
            })
            .await?;
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "tab-editor" => {
            // The WebView tab editor window owns both tag forms and saves them.
            let record = r.kind == "record";
            let tab_id = r.tab_id.clone();
            let payload = blocking(move || {
                let custom = crate::get_custom_tabs()?;
                let tags = clipboard::list_tags()?;
                tab_editor_payload(custom, &tags, &tab_id, record)
            })
            .await?;
            let record = payload["kind"] == "record";
            let anchor = r
                .point
                .filter(|point| point.iter().all(|value| value.is_finite()))
                .ok_or("Missing or invalid tab editor anchor")?;
            let source = match app.get_webview_window("clipboard") {
                Some(window) => window,
                // Native-only mode has no clipboard WebView. The shared editor
                // uses the published native surface for its screen bounds.
                None => {
                    crate::auxiliary_windows::ensure(
                        app,
                        crate::auxiliary_windows::WindowKind::TabEditor,
                    )
                    .await?
                }
            };
            let size = (286.0, if record { 178.0 } else { 398.0 });
            let bounds = crate::clipboard_screen_bounds(app, &source);
            let (x, y) = tab_editor_origin(
                anchor,
                size,
                (bounds.x, bounds.y, bounds.width, bounds.height),
            );
            if !current(r.session) {
                return Ok(Value::Null);
            }
            *TAG_EDITOR_TARGET
                .lock()
                .unwrap_or_else(|error| error.into_inner()) =
                (record && payload["mode"] == "add" && !hash.is_empty()).then(|| (r.session, hash));
            let result = crate::open_tab_editor_window(
                app.clone(),
                source,
                x,
                y,
                Some(size.0),
                Some(size.1),
                payload.to_string(),
                None,
                None,
            )
            .await;
            if result.is_err() {
                *TAG_EDITOR_TARGET
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
            }
            result?;
            Ok(Value::Null)
        }
        "tab-reorder" => {
            let app = app.clone();
            let source = r.tab_id.clone();
            let target = r.target_id.clone();
            let before = r.before;
            blocking(move || crate::reorder_tab(app, source, target, before)).await?;
            Ok(Value::Null)
        }
        "tab-delete" => {
            let id = r.tab_id.clone();
            let result = blocking(move || delete_tab(&id)).await;
            // A storage error may follow a completed deletion; refresh either way.
            tabs_changed(&json!({}));
            let (custom, record) = result?;
            if record {
                app.emit("item-tags-changed", json!({}))
                    .map_err(|error| error.to_string())?;
                app.emit("listen_new_clipboard", ())
                    .map_err(|error| error.to_string())?;
            } else if let Some(window) = app.get_webview_window("clipboard") {
                window
                    .emit("custom-tabs-changed", json!({"tabs": custom}))
                    .map_err(|error| error.to_string())?;
            }
            Ok(Value::Null)
        }
        "export-image" => {
            let target = r.target.clone();
            if target.is_empty() {
                return Err("Export target is empty".into());
            }
            let source = blocking(move || {
                let item = clipboard::history_action_item(&hash)?;
                Ok(export_image_source(
                    &item.item_type,
                    &item.content,
                    &item.preview_content,
                ))
            })
            .await?;
            if source.is_empty() {
                return Err("Image cache is missing".into());
            }
            let revealed = target.clone();
            blocking(move || crate::export_image_item(source, target)).await?;
            crate::reveal_file_in_folder(revealed)?;
            begin_close(app).await?;
            Ok(Value::Null)
        }
        "open-folder" => {
            blocking(move || {
                let item = clipboard::history_action_item(&hash)?;
                crate::open_containing_folder(item.content)
            })
            .await?;
            Ok(Value::Null)
        }
        "copy-folder" => {
            let path = blocking(move || {
                let item = clipboard::history_action_item(&hash)?;
                crate::containing_folder_path(item.content)
            })
            .await?;
            let worker_app = app.clone();
            blocking(move || copy_generated_text(&worker_app, path)).await?;
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "copy-text" => {
            if r.text.is_empty() {
                return Err("Nothing to copy".into());
            }
            let (worker_app, text) = (app.clone(), r.text.clone());
            blocking(move || copy_generated_text(&worker_app, text)).await?;
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "paste-queue-status" => Ok(queue_selection::snapshot()),
        "paste-queue-add" => {
            let submission = queue_selection::begin(r.activation_epoch)?;
            let (hashes, epoch) = (submission.hashes.clone(), r.activation_epoch);
            let result = blocking(move || {
                crate::paste_queue::run_user_operation(|| {
                    if crate::paste_queue::activation_epoch() != epoch {
                        return Err("Paste queue selection expired".into());
                    }
                    crate::paste_queue::add_items(&hashes)
                })
            })
            .await;
            // Complete in Rust even when the submitting native controller closed.
            let mut status = queue_selection::complete(&submission, result.is_ok());
            match result {
                Ok(()) => crate::paste_queue::emit_state(app),
                Err(error) if status["activationEpoch"].as_u64() == Some(r.activation_epoch) => {
                    status["error"] = json!(error);
                }
                Err(_) => {}
            }
            // A newly opened controller must receive failure/finished state too.
            let _ = app.emit("native-paste-queue-selection-changed", &status);
            Ok(status)
        }
        "paste-queue-toggle" => {
            let request = crate::PASTE_QUEUE_ACTIVATION
                .lock()
                .unwrap()
                .toggle(crate::paste_queue::is_active());
            crate::apply_paste_queue_activation(app, request).await?;
            Ok(Value::Null)
        }
        "settings" => {
            let source = app.get_webview_window("clipboard");
            close_for_action(app).await?;
            crate::open_config_window_from_source(app.clone(), source, None).await?;
            Ok(Value::Null)
        }
        "preview" => {
            let request = r.preview_request.ok_or("Native preview request expired")?;
            if !preview::current(request) {
                return Ok(Value::Null);
            }
            if r.item_type == "Image" {
                let image_hash = hash.clone();
                let path = blocking(move || {
                    clipboard::history_action_item(&image_hash).map(|item| item.content)
                })
                .await?;
                if crate::history_image_metadata(path).await?.preview_limited {
                    return Err("This image exceeds the preview resource limit".into());
                }
                if !preview::current(request) {
                    return Ok(Value::Null);
                }
            }
            crate::prepare_preview_window(
                app.clone(),
                r.item_type.clone(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                Some(r.mode),
                r.hover_request,
                Some(r.navigation_direction),
                None,
                Some(hash),
                None,
                Some(request),
            )
            .await?;
            Ok(Value::Null)
        }
        "edit" => {
            close_for_action(app).await?;
            crate::open_text_editor_window(app.clone(), hash).await?;
            Ok(Value::Null)
        }
        "ocr" => {
            close_for_action(app).await?;
            crate::show_image_text_window(app.clone(), hash).await?;
            Ok(Value::Null)
        }
        "drag" => {
            let value = blocking(move || {
                let item = clipboard::history_action_item(&hash)?;
                let paths = if matches!(item.item_type, ItemType::File | ItemType::Image) {
                    crate::history_drag_paths(&hash)?
                } else {
                    Vec::new()
                };
                let text_file_content = if item.item_type == ItemType::TextFile {
                    clipboard::plain_text_content(&hash)?
                } else {
                    String::new()
                };
                let text = drag_plain_text(
                    &item.item_type,
                    &item.text_content,
                    &item.content,
                    &text_file_content,
                );
                let url = if item.item_type == ItemType::Link {
                    text.clone()
                } else {
                    String::new()
                };
                let mut html = clipboard::history_card_payload(&hash, true)?.item.rich_html;
                if item.item_type == ItemType::Link && !url.is_empty() {
                    let escaped = drag_link_html(&url);
                    html = format!("<a href=\"{escaped}\">{escaped}</a>");
                }
                Ok(json!({"paths":paths,"text":text,"html":html,"url":url}))
            })
            .await?;
            Ok(value)
        }
        _ => Err("Unknown native panel action".into()),
    }
}

// Match the WebView's itemPlainText: text_content is empty for plain Text and
// Link records, so fall back to the stored content.
fn drag_plain_text(
    item_type: &ItemType,
    text_content: &str,
    content: &str,
    text_file_content: &str,
) -> String {
    match item_type {
        ItemType::TextFile => text_file_content.to_string(),
        ItemType::Link => content.split("|||").next().unwrap_or("").trim().to_string(),
        ItemType::File | ItemType::Image => String::new(),
        _ => {
            if text_content.is_empty() {
                content.to_string()
            } else {
                text_content.to_string()
            }
        }
    }
}

fn drag_link_html(url: &str) -> String {
    url.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Card {
    hash: String,
    item_type: String,
    text: String,
    source: String,
    source_icon: String,
    remote: bool,
    time: u64,
    color: String,
    favorite: bool,
    tags: Vec<clipboard::item::ItemTag>,
    asset_path: String,
    animation_path: String,
    dimensions: String,
    media_width: u32,
    media_height: u32,
    display_title: String,
    display_subtitle: String,
    display_symbol: String,
    file_format: String,
    is_gif: bool,
    rich: Vec<rich_text::Block>,
    export_image: bool,
}
fn bounded(s: &str) -> String {
    s.chars().take(16_384).collect()
}
fn display_card(hash: &str, width: u32) -> Result<Card, String> {
    let payload = clipboard::history_card_payload(hash, false)?;
    let item = payload.item;
    let mut asset_path = String::new();
    let mut animation_path = String::new();
    let mut dimensions = String::new();
    let mut is_gif = false;
    let mut media_width = 0;
    let mut media_height = 0;
    let file_info = if item.item_type == ItemType::File {
        crate::build_file_preview_info(item.content.clone()).ok()
    } else {
        None
    };
    let link: Vec<_> = if item.item_type == ItemType::Link {
        item.content.split("|||").collect()
    } else {
        Vec::new()
    };
    let path = match item.item_type {
        ItemType::Image => Some(item.preview_content.clone()),
        ItemType::File => file_info
            .as_ref()
            .filter(|v| v.kind == "single-preview")
            .map(|v| v.preview_path.clone()),
        ItemType::Link => link
            .get(1)
            .filter(|path| std::path::Path::new(**path).is_absolute())
            .map(|path| path.to_string()),
        _ => None,
    };
    if let Some(path) = path.filter(|s| !s.is_empty()) {
        // This worker uses the same Rust disk thumbnails as the main WebView.
        let media = tauri::async_runtime::block_on(media_resources::resolve_for_card_width(
            path.clone(),
            MediaIntent::Card,
            false,
            width,
        ));
        if let Ok(media) = media {
            dimensions = format!("{} × {}", media.metadata.width, media.metadata.height);
            media_width = media.metadata.width;
            media_height = media.metadata.height;
            asset_path = media.asset_path;
            is_gif = media.metadata.is_gif;
            if media.metadata.is_gif && !media.metadata.animation_limited {
                animation_path = path;
            }
        }
    }
    let text = match item.item_type {
        ItemType::TextFile => clipboard::plain_text_preview(hash)
            .map(|p| p.text)
            .unwrap_or_default(),
        ItemType::File => crate::parse_file_clipboard_content(&item.content)
            .unwrap_or_default()
            .join("\n"),
        ItemType::Link => item.content.replace("|||", "\n"),
        _ => {
            if item.text_content.is_empty() {
                item.content.clone()
            } else {
                item.text_content.clone()
            }
        }
    };
    let (display_title, display_subtitle, display_symbol, file_format) =
        if let Some(info) = &file_info {
            let name = info
                .paths
                .first()
                .and_then(|path| std::path::Path::new(path).file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| info.display_path.clone());
            (
                name,
                info.display_path.clone(),
                if info.paths.len() > 1 {
                    "doc.on.doc"
                } else if info.contains_directories {
                    "folder.fill"
                } else {
                    "doc.fill"
                }
                .to_string(),
                info.extension
                    .chars()
                    .take(8)
                    .collect::<String>()
                    .to_uppercase(),
            )
        } else if item.item_type == ItemType::Link {
            let url = link.first().copied().unwrap_or_default();
            let title = link
                .get(2)
                .filter(|title| !title.is_empty())
                .map(|title| title.to_string())
                .unwrap_or_else(|| {
                    tauri::Url::parse(url)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_string))
                        .unwrap_or_else(|| url.to_string())
                });
            (title, url.to_string(), "link".to_string(), String::new())
        } else {
            (String::new(), String::new(), String::new(), String::new())
        };
    let rich = payload
        .rich_render
        .as_ref()
        .map(rich_text::convert)
        .unwrap_or_default();
    Ok(Card {
        hash: item.hash,
        item_type: item.item_type.to_string(),
        text: bounded(&text),
        source: item.app_source,
        source_icon: item.app_icon_path,
        remote: item.source_metadata.is_remote,
        time: item.time,
        color: item.title_color,
        favorite: item.label & 1 != 0,
        tags: item.tags,
        asset_path,
        animation_path,
        dimensions,
        media_width,
        media_height,
        display_title: bounded(&display_title),
        display_subtitle: bounded(&display_subtitle),
        display_symbol,
        file_format,
        is_gif,
        rich,
        export_image: !export_image_source(&item.item_type, &item.content, &item.preview_content)
            .is_empty(),
    })
}

// One dynamic toolbar tab after the fixed All and Favorites tabs: a filter tab
// (custom tabs file) or a record tag, with the history query label it selects.
#[derive(Clone, Serialize, Debug, PartialEq)]
struct PanelTab {
    id: String,
    name: String,
    label: String,
    record: bool,
}

enum TabTarget<'a> {
    Filter(&'a Value),
    Record(&'a clipboard::item::ItemTag),
}

fn tab_target<'a>(
    id: &str,
    custom: &'a Value,
    tags: &'a [clipboard::item::ItemTag],
) -> Result<TabTarget<'a>, String> {
    if id.is_empty() || matches!(id, "all" | "favorite") {
        return Err("Only dynamic tabs can be edited or deleted".into());
    }
    if id.starts_with("record:") {
        tags.iter()
            .find(|tag| format!("record:{}", tag.id) == id)
            .map(TabTarget::Record)
    } else {
        custom.as_array().and_then(|tabs| {
            tabs.iter()
                .find(|tab| tab["id"].as_str() == Some(id))
                .map(TabTarget::Filter)
        })
    }
    .ok_or_else(|| "Tab no longer exists".into())
}

fn tab_editor_payload(
    custom: Value,
    tags: &[clipboard::item::ItemTag],
    id: &str,
    record: bool,
) -> Result<Value, String> {
    let mut payload = if id.is_empty() {
        json!({"mode": "add", "kind": if record { "record" } else { "filter" }})
    } else {
        match tab_target(id, &custom, tags)? {
            TabTarget::Filter(tab) => json!({"mode": "edit", "kind": "filter", "tab": tab}),
            TabTarget::Record(tag) => json!({"mode": "edit", "kind": "record", "recordTag": tag}),
        }
    };
    payload["tabs"] = custom;
    Ok(payload)
}

fn delete_tab(id: &str) -> Result<(Value, bool), String> {
    let mut custom = crate::get_custom_tabs()?;
    let tags = clipboard::list_tags()?;
    let mut order =
        clipboard::db::read_tab_order(&clipboard::db::db()).map_err(|error| error.to_string())?;
    let record = match tab_target(id, &custom, &tags)? {
        TabTarget::Record(tag) => {
            crate::delete_item_tag(tag.id)?;
            true
        }
        TabTarget::Filter(_) => {
            custom
                .as_array_mut()
                .unwrap()
                .retain(|tab| tab["id"].as_str() != Some(id));
            crate::save_custom_tabs(custom.clone())?;
            false
        }
    };
    order.retain(|tab| tab != id);
    clipboard::db::write_tab_order(&clipboard::db::db(), &order)
        .map_err(|error| error.to_string())?;
    Ok((custom, record))
}

fn panel_tabs() -> Result<Vec<PanelTab>, String> {
    let custom = crate::get_custom_tabs()?;
    let tags = clipboard::list_tags()?;
    let order =
        clipboard::db::read_tab_order(&clipboard::db::db()).map_err(|err| err.to_string())?;
    Ok(dynamic_tabs(&custom, &tags, &order))
}

// Mirrors the WebView orderedDynamicTabs: ids in the stored order first, then
// the remaining filter tabs, then the remaining record tags.
fn dynamic_tabs(
    custom: &Value,
    tags: &[clipboard::item::ItemTag],
    order: &[String],
) -> Vec<PanelTab> {
    let mut tabs: Vec<Option<PanelTab>> = custom
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tab| {
            Some(PanelTab {
                id: tab.get("id")?.as_str()?.to_string(),
                name: tab.get("name")?.as_str()?.to_string(),
                label: custom_tab_label(tab.get("filter").unwrap_or(&Value::Null)),
                record: false,
            })
        })
        .chain(tags.iter().map(|tag| PanelTab {
            id: format!("record:{}", tag.id),
            name: tag.name.clone(),
            label: format!(
                "__filter:{}",
                json!({"mode": "record-tag", "record_tag_ids": [tag.id]})
            ),
            record: true,
        }))
        .map(Some)
        .collect();
    let mut ordered = Vec::with_capacity(tabs.len());
    for id in order {
        let found = tabs
            .iter_mut()
            .find(|tab| tab.as_ref().is_some_and(|tab| &tab.id == id));
        if let Some(tab) = found.and_then(Option::take) {
            ordered.push(tab);
        }
    }
    ordered.extend(tabs.into_iter().flatten());
    ordered
}

// Mirrors the WebView customTabFilterPayload, including its filter defaults.
fn custom_tab_label(filter: &Value) -> String {
    let text = |key: &str| {
        filter
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let mut payload = serde_json::Map::new();
    payload.insert("mode".into(), json!("custom"));
    if let Some(item_type) = text("itemType") {
        payload.insert("item_type".into(), json!(item_type));
    }
    let sources: Vec<&str> = match filter.get("appSources").and_then(Value::as_array) {
        Some(sources) => sources
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|source| !source.is_empty())
            .collect(),
        None => text("appSource").into_iter().collect(),
    };
    if !sources.is_empty() {
        payload.insert("app_sources".into(), json!(sources));
    }
    match text("favorite") {
        Some("yes") => payload.insert("favorite".into(), json!(true)),
        Some("no") => payload.insert("favorite".into(), json!(false)),
        _ => None,
    };
    let amount = match filter.get("relativeAmount") {
        Some(Value::String(amount)) => amount.trim().parse::<f64>().ok(),
        Some(amount) => amount.as_f64(),
        None => None,
    };
    if let Some(amount) = amount.filter(|amount| amount.is_finite() && *amount > 0.0) {
        // The backend reads an integer; keep whole numbers integral as JS does.
        let value = if amount.fract() == 0.0 {
            json!(amount as u64)
        } else {
            json!(amount)
        };
        payload.insert("relative_amount".into(), value);
        payload.insert(
            "relative_unit".into(),
            json!(text("relativeUnit").unwrap_or("day")),
        );
    }
    format!("__filter:{}", Value::Object(payload))
}

// Mirrors the WebView imageExportSourcePath: an Image exports its cached
// preview; a File exports only when it holds exactly one image path.
fn export_image_source(item_type: &ItemType, content: &str, preview_content: &str) -> String {
    match item_type {
        ItemType::Image => preview_content.to_string(),
        ItemType::File => match crate::parse_file_clipboard_content(content) {
            Ok(paths) if paths.len() == 1 && is_image_path(&paths[0]) => paths[0].clone(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

// Same extensions as the WebView isImagePath.
fn is_image_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tif" | "tiff" | "svg"
            )
        })
}

// Copy text produced by a menu action and record it as vPaste history, as the
// WebView does for converted colors and containing-folder paths.
fn copy_generated_text(app: &AppHandle, text: String) -> Result<(), String> {
    crate::copy(app.clone(), text.clone(), "Text".into(), None)?;
    crate::record_text_history(text);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_toolbar_event_forwards_only_live_metadata_not_queue_content() {
        let event = paste_queue_toolbar_event();
        assert_eq!(event["event"], "paste-queue-state");
        assert!(event["active"].is_boolean());
        assert!(event["activationEpoch"].is_u64());
        assert!(event["selectedHashes"].is_array());
        assert_eq!(event.as_object().unwrap().len(), 7);
        assert!(event.get("items").is_none());
        assert!(event.get("cards").is_none());
    }

    #[test]
    fn drag_text_falls_back_to_content() {
        assert_eq!(drag_plain_text(&ItemType::Text, "", "hello", ""), "hello");
        assert_eq!(
            drag_plain_text(&ItemType::Text, "rich text", "content", ""),
            "rich text"
        );
        assert_eq!(
            drag_plain_text(&ItemType::Color, "", "#ff0000", ""),
            "#ff0000"
        );
    }

    #[test]
    fn drag_text_matches_the_item_type() {
        assert_eq!(
            drag_plain_text(&ItemType::Link, "", "https://example.com|||Title", ""),
            "https://example.com"
        );
        assert_eq!(
            drag_plain_text(&ItemType::TextFile, "", "/tmp/a.txt", "body"),
            "body"
        );
        assert_eq!(drag_plain_text(&ItemType::File, "", "[]", ""), "");
        assert_eq!(drag_plain_text(&ItemType::Image, "", "/tmp/a.png", ""), "");
    }

    #[test]
    fn export_image_source_matches_the_webview() {
        assert_eq!(
            export_image_source(&ItemType::Image, "ignored", "/cache/a.png"),
            "/cache/a.png"
        );
        assert_eq!(
            export_image_source(&ItemType::File, r#"["/tmp/a.JPEG"]"#, ""),
            "/tmp/a.JPEG"
        );
        assert_eq!(
            export_image_source(&ItemType::File, r#"["/tmp/a.svg"]"#, ""),
            "/tmp/a.svg"
        );
        assert_eq!(
            export_image_source(&ItemType::File, r#"["/tmp/a.png","/tmp/b.png"]"#, ""),
            ""
        );
        assert_eq!(
            export_image_source(&ItemType::File, r#"["/tmp/a.txt"]"#, ""),
            ""
        );
        assert_eq!(export_image_source(&ItemType::File, "not json", ""), "");
        assert_eq!(export_image_source(&ItemType::Text, "/tmp/a.png", ""), "");
    }

    fn tag(id: i64, name: &str) -> clipboard::item::ItemTag {
        clipboard::item::ItemTag {
            id,
            name: name.to_string(),
        }
    }

    #[test]
    fn dynamic_tabs_follow_the_stored_order_then_filter_tabs_then_record_tags() {
        let custom = json!([
            {"id": "tab-1", "name": "📝 Text", "filter": {"itemType": "Text"}},
            {"id": "tab-2", "name": "Recent", "filter": {}},
            {"id": 7, "name": "invalid id"},
            {"id": "tab-3"}
        ]);
        let tags = [tag(5, "Work"), tag(9, "Home")];
        let order = ["record:9", "missing", "tab-2", "record:9"].map(String::from);
        let tabs = dynamic_tabs(&custom, &tags, &order);
        assert_eq!(
            tabs.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
            ["record:9", "tab-2", "tab-1", "record:5"]
        );
        assert_eq!(
            tabs.iter().map(|tab| tab.name.as_str()).collect::<Vec<_>>(),
            ["Home", "Recent", "📝 Text", "Work"]
        );
        assert_eq!(
            tabs.iter().map(|tab| tab.record).collect::<Vec<_>>(),
            [true, false, false, true]
        );
        let record: Value =
            serde_json::from_str(tabs[0].label.strip_prefix("__filter:").unwrap()).unwrap();
        assert_eq!(record, json!({"mode": "record-tag", "record_tag_ids": [9]}));
    }

    #[test]
    fn custom_tab_label_matches_the_webview_filter_payload() {
        let label = |filter: Value| -> Value {
            serde_json::from_str(custom_tab_label(&filter).strip_prefix("__filter:").unwrap())
                .unwrap()
        };
        assert_eq!(label(json!({})), json!({"mode": "custom"}));
        assert_eq!(
            label(json!({
                "itemType": "Image",
                "appSource": "ignored",
                "appSources": [" Safari ", "", 3, "Notes"],
                "favorite": "yes",
                "relativeAmount": "3",
                "relativeUnit": "week"
            })),
            json!({
                "mode": "custom",
                "item_type": "Image",
                "app_sources": ["Safari", "Notes"],
                "favorite": true,
                "relative_amount": 3,
                "relative_unit": "week"
            })
        );
        // Legacy single source, "no" favorite, numeric amount, default unit.
        assert_eq!(
            label(json!({"appSource": " Xcode ", "favorite": "no", "relativeAmount": 2})),
            json!({
                "mode": "custom",
                "app_sources": ["Xcode"],
                "favorite": false,
                "relative_amount": 2,
                "relative_unit": "day"
            })
        );
        // "any" favorite and an empty or non-positive amount add nothing.
        assert_eq!(
            label(json!({"favorite": "any", "relativeAmount": "", "itemType": ""})),
            json!({"mode": "custom"})
        );
        assert_eq!(
            label(json!({"relativeAmount": "0"})),
            json!({"mode": "custom"})
        );
        // The backend reads relative_amount as an integer.
        assert!(
            custom_tab_label(&json!({"relativeAmount": "3"})).contains("\"relative_amount\":3,")
        );
    }

    #[test]
    fn tab_editor_edit_payload_keeps_identity_filters_and_record_tag_data() {
        let custom = json!([
            {"id":"tab-1","name":"Recent", "filter":{"itemType":"Image","appSources":["Safari"],"relativeAmount":"2","relativeUnit":"day"}},
            {"id":"tab-2","name":"Other","filter":{}}
        ]);
        let tags = [clipboard::item::ItemTag {
            id: 9,
            name: "Home".into(),
        }];
        let filter = tab_editor_payload(custom.clone(), &tags, "tab-1", true).unwrap();
        assert_eq!(filter["mode"], "edit");
        assert_eq!(filter["kind"], "filter");
        assert_eq!(filter["tab"], custom[0]);
        assert_eq!(filter["tabs"], custom);
        let record = tab_editor_payload(custom.clone(), &tags, "record:9", false).unwrap();
        assert_eq!(record["kind"], "record");
        assert_eq!(record["mode"], "edit");
        assert_eq!(record["recordTag"], json!({"id":9,"name":"Home"}));
        assert_eq!(record["tabs"], custom);
        for (kind, name) in [(false, "filter"), (true, "record")] {
            let added = tab_editor_payload(custom.clone(), &tags, "", kind).unwrap();
            assert_eq!(added["mode"], "add");
            assert_eq!(added["kind"], name);
            assert!(added.get("tab").is_none());
            assert!(added.get("recordTag").is_none());
        }
    }

    #[test]
    fn tab_target_protects_fixed_tabs_and_rejects_missing_ids_for_edit_and_delete() {
        let custom = json!([
            {"id":"all","name":"Invalid fixed tab"},
            {"id":"tab-2","name":"Other"}
        ]);
        let tags = [clipboard::item::ItemTag {
            id: 9,
            name: "Home".into(),
        }];
        for id in [
            "",
            "all",
            "favorite",
            "tab-removed",
            "record:0",
            "record:8",
            "record:no",
        ] {
            assert!(tab_target(id, &custom, &tags).is_err(), "{id}");
        }
        assert!(matches!(
            tab_target("tab-2", &custom, &tags),
            Ok(TabTarget::Filter(_))
        ));
        assert!(
            matches!(tab_target("record:9", &custom, &tags), Ok(TabTarget::Record(tag)) if tag.id == 9)
        );
    }

    #[test]
    fn tab_editor_opens_beside_the_anchor_and_stays_on_screen() {
        let screen = (0.0, 0.0, 1440.0, 900.0);
        // Right of the anchor by the 6px gap, bottom-aligned with it.
        assert_eq!(
            tab_editor_origin([400.0, 700.0], (286.0, 398.0), screen),
            (406.0, 302.0)
        );
        // Clamped at the right and top edges, and on a secondary screen.
        assert_eq!(
            tab_editor_origin([1400.0, 100.0], (286.0, 398.0), screen),
            (1154.0, 0.0)
        );
        assert_eq!(
            tab_editor_origin(
                [-1000.0, 500.0],
                (286.0, 178.0),
                (-1920.0, 0.0, 1920.0, 1080.0)
            ),
            (-994.0, 322.0)
        );
    }

    #[test]
    fn shared_record_editor_assigns_only_the_created_tag_to_its_original_item_once() {
        let created = json!({"activeId":"record:7", "tag":{"id":7,"name":"Work"}});
        let mut target = Some((4, "original-item".to_string()));
        assert_eq!(take_created_tag_assignment(&mut target, 3, &created), None);
        assert!(
            target.is_some(),
            "A stale panel event must not consume the current target"
        );
        assert_eq!(
            take_created_tag_assignment(&mut target, 4, &json!({"tag":{"id":7,"name":"Renamed"}})),
            None
        );
        assert!(
            target.is_some(),
            "Renaming a tag must not assign it to the item"
        );
        assert_eq!(
            take_created_tag_assignment(&mut target, 4, &created),
            Some(("original-item".to_string(), 7))
        );
        assert_eq!(take_created_tag_assignment(&mut target, 4, &created), None);
        // Toolbar creation and a cancelled editor have no item target.
        assert_eq!(take_created_tag_assignment(&mut None, 4, &created), None);
    }

    #[test]
    fn edited_filter_notification_retains_the_mode_and_selection_without_becoming_a_new_tab() {
        let payload = json!({"mode":"edit", "activeId":"tab-1", "tabs":[]});
        let event = tab_change_event(&payload.to_string());
        assert_eq!(event["mode"], "edit");
        assert_eq!(event["activeId"], "tab-1");
        let wrapped = Value::String(payload.to_string());
        assert_eq!(tab_change_event(&wrapped.to_string()), event);
    }

    #[test]
    fn tab_change_event_carries_the_new_tab_and_unwraps_string_payloads() {
        let direct = json!({"activeId": "record:7", "tag": {"id": 7, "name": "Work"}});
        assert_eq!(
            tab_change_event(&direct.to_string()),
            json!({"event": "tabs-changed", "activeId": "record:7", "tag": {"id": 7, "name": "Work"}})
        );
        // Tauri can deliver the payload as a JSON string containing JSON.
        let wrapped = Value::String(json!({"activeId": "tab-9", "tabs": []}).to_string());
        assert_eq!(
            tab_change_event(&wrapped.to_string()),
            json!({"event": "tabs-changed", "activeId": "tab-9", "tag": null})
        );
        assert_eq!(
            tab_change_event("not json"),
            json!({"event": "tabs-changed", "activeId": null, "tag": null})
        );
    }

    #[test]
    fn drag_link_html_escapes_attribute_characters() {
        assert_eq!(
            drag_link_html("https://example.com/?a=1&b=\"2\"<"),
            "https://example.com/?a=1&amp;b=&quot;2&quot;&lt;"
        );
    }
}
