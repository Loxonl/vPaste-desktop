//! The lightweight reader is private to the Windows WinUI experiment.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GetForegroundWindow, IsChild, IsWindowVisible},
};

static EPOCH: AtomicU64 = AtomicU64::new(0);
static NATIVE: AtomicU64 = AtomicU64::new(0);
static FOCUS_MAIN: AtomicU64 = AtomicU64::new(0);

fn native_body(item_type: &str, rich_html: &str, text_bytes: usize) -> bool {
    matches!(item_type, "Text" | "TextFile" | "Image" | "Color" | "File")
        && rich_html.trim().is_empty()
        && (item_type != "Text" || text_bytes <= 2 * 1024 * 1024)
}

fn geometry(size: crate::PreviewWindowSize, area: crate::ScreenBounds) -> Value {
    let fit = (area.width / size.width)
        .min(area.height / size.height)
        .min(1.0);
    let width = size.width * fit;
    let height = size.height * fit;
    json!({
        "x": ((area.x + (area.width - width) / 2.0) * area.scale_factor).round(),
        "y": ((area.y + (area.height - height) / 2.0) * area.scale_factor).round(),
        "width": (width * area.scale_factor).round().max(1.0),
        "height": (height * area.scale_factor).round().max(1.0)
    })
}

pub(super) fn prepare(hash: &str, area: crate::ScreenBounds) -> Result<Option<Value>, String> {
    let card = crate::clipboard::history_card_payload(hash, false)?;
    let item = card.item;
    let rich_html = card
        .rich_render
        .as_ref()
        .map_or("", |render| render.html.as_str());
    let item_type = item.item_type.to_string();
    if !native_body(
        &item_type,
        rich_html,
        item.content.len().max(item.text_content.len()),
    ) {
        return Ok(None);
    }
    let mut body = match item_type.as_str() {
        "Text" | "TextFile" => {
            let text = crate::clipboard::plain_text_preview(hash)?;
            json!({"kind":"text", "text":text.text, "truncated":text.truncated})
        }
        "Image" => {
            let source = if item.content.is_empty() {
                &item.preview_content
            } else {
                &item.content
            };
            let asset = crate::image_preview_asset_path(source)?;
            json!({"kind":"image", "imagePath":asset})
        }
        "Color" => {
            let Some(color) = super::native_color(&item.content) else {
                return Ok(None);
            };
            json!({"kind":"color", "text":item.content, "color":color})
        }
        "File" => {
            let info = crate::build_file_preview_info(item.content.clone())?;
            let file_name = std::path::Path::new(&info.display_path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_string();
            match info.kind.as_str() {
                "pdf-preview" => return Ok(None),
                "text-preview" => {
                    let text = crate::read_preview_text_file(info.display_path.clone())?;
                    json!({"kind":"text", "text":text.text, "truncated":text.truncated,
                        "caption": file_name, "detail":info.display_path})
                }
                "single-preview" if !info.preview_path.is_empty() => {
                    let asset = crate::image_preview_asset_path(&info.preview_path)?;
                    json!({"kind":"image", "imagePath":asset,
                        "caption": file_name, "detail":info.display_path})
                }
                _ => json!({"kind":"files", "text":info.paths.join("\n"),
                    "caption":file_name, "missing":!info.exists,
                    "count":info.paths.len(), "directory":info.contains_directories}),
            }
        }
        _ => return Ok(None),
    };
    // A pathological string can expand when JSON-escaped; keep the private
    // bridge's 4 MiB limit and use the existing reader for larger payloads.
    if serde_json::to_vec(&body)
        .map_err(|error| error.to_string())?
        .len()
        > 3 * 1024 * 1024
    {
        return Ok(None);
    }
    let asset = body["imagePath"].as_str().unwrap_or("");
    let size = crate::preview_window_size(
        &item_type,
        &item.content,
        &item.preview_content,
        asset,
        "",
        area,
    );
    body["rect"] = geometry(size, area);
    let tokens: Value = serde_json::from_str(include_str!("../../../src/ui/motion/tokens.json"))
        .expect("checked shared motion tokens");
    body["durationMs"] = json!(tokens["duration"]["standard"].as_f64().expect("duration") * 1000.0);
    body["easing"] = tokens["easing"]["enter"].clone();
    body["itemType"] = json!(item_type);
    Ok(Some(body))
}

pub(super) fn begin(request: u64) {
    crate::PREVIEW_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    EPOCH.store(request, Ordering::Release);
    NATIVE.store(0, Ordering::Release);
    super::send_response(0, "nativeReaderBegin", Ok(json!({"generation":request})));
}

pub(super) fn show(mut body: Value, request: u64, mode: crate::PreviewMode) {
    // The same lock serializes reservations and closure. A worker that loses
    // its generation cannot overwrite the newer renderer or its ready callback.
    let mut pending = crate::PREVIEW_PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !super::preview::current(request) {
        return;
    }
    crate::PREVIEW_REQUESTS.cancel();
    *pending = None;
    if mode.takes_focus() {
        crate::PREVIEW_PINNED.store(false, Ordering::SeqCst);
        crate::begin_preview_focus_handoff();
    }
    NATIVE.store(request, Ordering::Release);
    body["generation"] = json!(request);
    let rect = &body["rect"];
    let cursor_inside = crate::cursor_physical_position().is_some_and(|point| {
        let (x, y) = (f64::from(point.x), f64::from(point.y));
        let left = rect["x"].as_f64().unwrap_or(0.0);
        let top = rect["y"].as_f64().unwrap_or(0.0);
        x >= left
            && y >= top
            && x < left + rect["width"].as_f64().unwrap_or(0.0)
            && y < top + rect["height"].as_f64().unwrap_or(0.0)
    });
    let focus = crate::preview_focus::commit_focus_target(mode.takes_focus(), cursor_inside, false);
    FOCUS_MAIN.store(
        if focus == Some(crate::preview_focus::FocusTarget::Clipboard) {
            request
        } else {
            0
        },
        Ordering::Release,
    );
    body["takesFocus"] = json!(focus == Some(crate::preview_focus::FocusTarget::Preview));
    body["hover"] = json!(mode == crate::PreviewMode::Hover);
    super::send_response(0, "nativeReader", Ok(body));
}

pub(super) fn hide(request: u64) {
    crate::PREVIEW_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    EPOCH.store(request, Ordering::Release);
    NATIVE.store(0, Ordering::Release);
    super::send_response(0, "nativeReaderHide", Ok(json!({"generation":request})));
}

pub(super) fn retire() {
    crate::PREVIEW_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    NATIVE.store(0, Ordering::Release);
    super::send_response(
        0,
        "nativeReaderHide",
        Ok(json!({"generation":EPOCH.load(Ordering::Acquire)})),
    );
}

fn window() -> Option<HWND> {
    if !crate::main_panel_mode::winui() {
        return None;
    }
    let panel = super::api().ok()?;
    // SAFETY: this export only snapshots an atomic, process-owned HWND.
    let window = HWND(unsafe { (panel.reader_handle)() } as isize);
    (window.0 != 0 && unsafe { IsWindowVisible(window).as_bool() }).then_some(window)
}

pub(super) fn visible() -> bool {
    window().is_some()
}

pub(super) fn foreground() -> bool {
    window().is_some_and(|window| {
        let foreground = unsafe { GetForegroundWindow() };
        window == foreground || unsafe { IsChild(window, foreground).as_bool() }
    })
}

pub(super) fn cursor_inside() -> bool {
    window()
        .zip(crate::cursor_physical_position())
        .is_some_and(|(window, point)| {
            super::layout::physical_geometry(window).is_some_and(|(_, bounds, _)| {
                point.x >= bounds.left
                    && point.x < bounds.right
                    && point.y >= bounds.top
                    && point.y < bounds.bottom
            })
        })
}

pub(super) fn handle(app: &tauri::AppHandle, operation: &str, argument: &str) -> bool {
    if !matches!(
        operation,
        "nativeReaderEnter"
            | "nativeReaderLeave"
            | "nativeReaderBlur"
            | "nativeReaderCancelled"
            | "nativeReaderPin"
            | "nativeReaderUnpin"
            | "nativeReaderReady"
    ) {
        return false;
    }
    let Ok(request) = argument.parse::<u64>() else {
        return true;
    };
    if request == 0 || EPOCH.load(Ordering::Acquire) != request {
        return true;
    }
    match operation {
        "nativeReaderEnter" => super::preview::pointer_changed(true),
        "nativeReaderLeave" => super::preview::pointer_changed(false),
        "nativeReaderBlur" => crate::handle_preview_focus_lost(app.clone()),
        "nativeReaderCancelled" if NATIVE.load(Ordering::Acquire) == request => {
            super::preview::cancel_hover(app);
        }
        "nativeReaderPin" | "nativeReaderUnpin" if NATIVE.load(Ordering::Acquire) == request => {
            let pinned = operation == "nativeReaderPin";
            crate::PREVIEW_PINNED.store(pinned, Ordering::SeqCst);
            if pinned {
                super::preview::pinned();
                crate::cancel_preview_content();
                crate::PREVIEW_HOVER.store(false, Ordering::SeqCst);
                crate::PREVIEW_HOVER_REQUEST.fetch_add(1, Ordering::SeqCst);
            }
        }
        "nativeReaderReady" if NATIVE.load(Ordering::Acquire) == request => {
            let app = app.clone();
            let owned = app.clone();
            // Never synchronously query Tauri while it might be waiting for
            // this WinUI callback. Only retire the old renderer after commit.
            let _ = app.run_on_main_thread(move || {
                if NATIVE.load(Ordering::Acquire) != request {
                    return;
                }
                if let Some(window) = tauri::Manager::get_webview_window(&owned, "clipboardPreview")
                {
                    let transfer_focus = window.is_focused().unwrap_or(false)
                        || crate::is_native_window_foreground(&window, "native reader handoff");
                    // The native show already invalidated old shared work
                    // under PREVIEW_PENDING. Do not cancel again here: a newer
                    // request can be preparing on a worker while this runs.
                    crate::browser_preview::clear(&owned);
                    let _ = window.emit("preview-clear", ());
                    let _ = window.hide();
                    if transfer_focus
                        && !crate::PREVIEW_HOVER.load(Ordering::SeqCst)
                        && FOCUS_MAIN.load(Ordering::Acquire) != request
                    {
                        crate::begin_preview_focus_handoff();
                        super::preview::focus_reader();
                    }
                }
                if FOCUS_MAIN.load(Ordering::Acquire) == request {
                    crate::move_focus_to_clipboard(&owned, "native preview committed");
                }
            });
        }
        _ => {}
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_payloads_use_real_history_and_preserve_text_media_and_fallback_budgets() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _cleanup = crate::auto_cleanup::pause();
        let directory = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(directory.path().to_string_lossy().into_owned());
        crate::config::save(crate::config::Config::default());
        crate::clipboard::db::init();
        let area = crate::ScreenBounds {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 778.0,
            scale_factor: 1.5,
        };
        let store = |kind: &str, content: &str| {
            let hash =
                crate::clipboard::insert_text_from_app(content.into(), "Native reader fixture", "")
                    .unwrap();
            crate::clipboard::db::db()
                .execute(
                    "update clipboard set item_type=?1, content=?2, source='' where hash=?3",
                    rusqlite::params![kind, content, hash],
                )
                .unwrap();
            hash
        };
        let plain = store("Text", "Native text / 原生文本");
        let body = prepare(&plain, area).unwrap().unwrap();
        assert_eq!(body["kind"], "text");
        assert_eq!(body["text"], "Native text / 原生文本");
        assert_eq!(body["durationMs"], 240.0);
        assert_eq!(body["easing"], json!([0.22, 1, 0.36, 1]));
        let raw_text = store(
            "Text",
            &"a".repeat(crate::clipboard_budget::TEXT_PREVIEW_BYTES + 100),
        );
        let raw_body = prepare(&raw_text, area).unwrap().unwrap();
        assert_eq!(raw_body["truncated"], true);
        assert!(
            raw_body["text"].as_str().unwrap().len() <= crate::clipboard_budget::TEXT_PREVIEW_BYTES
        );
        let large_path = directory.path().join("bounded-text.txt");
        std::fs::write(&large_path, "较长的文本\n".repeat(200_000)).unwrap();
        let large = store("TextFile", large_path.to_str().unwrap());
        let bounded = prepare(&large, area).unwrap().unwrap();
        assert_eq!(bounded["kind"], "text");
        assert_eq!(bounded["truncated"], true);
        assert!(
            bounded["text"].as_str().unwrap().len() <= crate::clipboard_budget::TEXT_PREVIEW_BYTES
        );
        let file = store("File", &json!([large_path]).to_string());
        let file_body = prepare(&file, area).unwrap().unwrap();
        assert_eq!(file_body["caption"], "bounded-text.txt");
        assert_eq!(file_body["kind"], "text");
        let picture_path = directory.path().join("图片 #100%.png");
        std::fs::write(
            &picture_path,
            include_bytes!("../../../tests/fixtures/office/picture-a.png"),
        )
        .unwrap();
        let picture = store("File", &json!([picture_path]).to_string());
        let image = prepare(&picture, area).unwrap().unwrap();
        assert_eq!(image["kind"], "image");
        assert_eq!(image["caption"], "图片 #100%.png");
        assert!(std::path::Path::new(image["imagePath"].as_str().unwrap()).is_file());
        let multi = store("File", &json!([large_path, picture_path]).to_string());
        let files = prepare(&multi, area).unwrap().unwrap();
        assert_eq!(files["kind"], "files");
        assert_eq!(files["count"], 2);
        assert!(files["text"].as_str().unwrap().contains("图片 #100%.png"));
        let pdf_path = directory.path().join("document.pdf");
        std::fs::write(&pdf_path, b"%PDF-1.4\n").unwrap();
        let pdf = store("File", &json!([pdf_path]).to_string());
        assert!(prepare(&pdf, area).unwrap().is_none());
        let link = store("Link", "https://example.com");
        assert!(prepare(&link, area).unwrap().is_none());
        assert!(prepare("missing-native-reader-fixture", area).is_err());
    }

    #[test]
    fn ordinary_content_uses_native_controls_without_discarding_rich_or_web_content() {
        for item_type in ["Text", "TextFile", "Image", "Color", "File"] {
            assert!(native_body(item_type, "", 512), "{item_type}");
        }
        for item_type in ["Link", "ImageText", "unknown"] {
            assert!(!native_body(item_type, "", 512));
        }
        assert!(!native_body(
            "Text",
            "<table><tr><td>rich</td></tr></table>",
            512
        ));
        assert!(!native_body("Text", "", 3 * 1024 * 1024));
        // TextFile is read through its existing bounded preview API.
        assert!(native_body("TextFile", "", 3 * 1024 * 1024));
    }

    #[test]
    fn native_geometry_fits_above_the_owner_on_scaled_negative_monitors() {
        for scale in [1.0, 1.5, 2.0] {
            let area = crate::ScreenBounds {
                x: -1920.0,
                y: -200.0,
                width: 1920.0,
                height: 778.0,
                scale_factor: scale,
            };
            let rect = geometry(
                crate::PreviewWindowSize {
                    width: 760.0,
                    height: 900.0,
                },
                area,
            );
            assert!(rect["x"].as_f64().unwrap() >= area.x * scale);
            assert!(rect["y"].as_f64().unwrap() >= area.y * scale);
            assert!(
                rect["y"].as_f64().unwrap() + rect["height"].as_f64().unwrap()
                    <= (area.y + area.height) * scale + 1.0
            );
        }
    }
}
