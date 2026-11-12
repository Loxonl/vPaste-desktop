//! macOS DEV AppKit panel. The optional --main-ui=native route uses it without
//! creating a main WebView. Owns one bounded history view, separately from Main.
pub(crate) mod preview;
mod rich_text;

use crate::{
    clipboard::{self, item::ItemType},
    history_views::{self, HistoryQuery, ViewOwner},
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
// The panel's own delete already updates its list locally; ignore the
// "changed" notification that the same action emits.
static SUPPRESS_CHANGED: AtomicBool = AtomicBool::new(false);
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
    ACTIVE.store(false, Ordering::Release);
    KEY.store(false, Ordering::Release);
    preview::dispose(APP.get());
    SESSION.fetch_add(1, Ordering::AcqRel);
    history_views::close_native();
    CLOSED.notify_waiters();
    if let Some(app) = APP.get() {
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
                "listen_new_clipboard",
                "clipboard-item-edited",
                "item-tags-changed",
                "clipboard-resources-updated",
            ] {
                let id = app.listen(name, move |_| {
                    if name == "listen_new_clipboard"
                        && SUPPRESS_CHANGED.swap(false, Ordering::AcqRel)
                    {
                        return;
                    }
                    deliver(session, json!({"event":"changed"}));
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
            let bytes = serde_json::to_vec(&json!({
                "session": session,
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
    hash: String,
    #[serde(default)]
    plain: bool,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    tag_id: i64,
    #[serde(default)]
    tag_ids: Vec<i64>,
    #[serde(default)]
    name: String,
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
    let open = if req.op == "open" {
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
            let page = blocking(move || {
                history_views::open_for_owner(query, 0, open, ViewOwner::NativeExperiment)
            })
            .await?;
            if !current(r.session) {
                history_views::close(&page.token.view_id);
                return Err("panel closed".into());
            }
            serde_json::to_value(page).map_err(|e| e.to_string())
        }
        "page" => {
            let (id, revision, page) = (r.view_id.clone(), r.revision, r.page);
            let page = blocking(move || history_views::read_page(&id, revision, page)).await?;
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
            blocking(move || {
                crate::delete_clipboard_item(worker_app, hash)?;
                history_views::invalidate_native_cache();
                Ok(())
            })
            .await?;
            SUPPRESS_CHANGED.store(true, Ordering::Release);
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
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
        "tag-create" => {
            let name = r.name.trim().to_string();
            if name.is_empty() {
                return Err("Tag name is empty".into());
            }
            let tag = blocking(move || {
                let tag = clipboard::create_tag(&name)?;
                clipboard::assign_tag(&hash, tag.id)?;
                Ok(tag)
            })
            .await?;
            app.emit("listen_new_clipboard", ())
                .map_err(|e| e.to_string())?;
            serde_json::to_value(tag).map_err(|e| e.to_string())
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
        assert_eq!(export_image_source(&ItemType::File, r#"["/tmp/a.txt"]"#, ""), "");
        assert_eq!(export_image_source(&ItemType::File, "not json", ""), "");
        assert_eq!(export_image_source(&ItemType::Text, "/tmp/a.png", ""), "");
    }

    #[test]
    fn drag_link_html_escapes_attribute_characters() {
        assert_eq!(
            drag_link_html("https://example.com/?a=1&b=\"2\"<"),
            "https://example.com/?a=1&amp;b=&quot;2&quot;&lt;"
        );
    }
}
