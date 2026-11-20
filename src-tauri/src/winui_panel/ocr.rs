//! Native presentation for the existing image-recognition and history commands.
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;

pub(super) async fn open(
    app: tauri::AppHandle,
    hash: String,
    generation: u64,
) -> Result<Value, String> {
    if !super::preview::current(generation) {
        return Ok(json!({}));
    }
    let Some(surface) = super::preview::surface() else {
        super::preview::close(&app);
        return Err("The clipboard panel is unavailable".into());
    };
    let size = crate::preview_window_size("ImageText", &hash, "", "", "", surface.bounds);
    super::reader::show(
        &app,
        json!({
            "kind":"ocr", "rect":super::reader::geometry(size, surface.bounds),
            "durationMs":0, "easing":[0.22,1,0.36,1]
        }),
        generation,
        crate::PreviewMode::Manual,
    );
    if !super::reader::current(generation) {
        return Ok(json!({}));
    }

    let image_hash = hash.clone();
    tauri::async_runtime::spawn(async move {
        let source = tauri::async_runtime::spawn_blocking(move || {
            crate::image_text_preview_source(&image_hash)
        })
        .await
        .unwrap_or_default();
        if !super::reader::current(generation) {
            return;
        }
        let path = if source.is_empty() {
            String::new()
        } else {
            crate::resolve_history_media(
                source,
                crate::media_resources::MediaIntent::Preview,
                None,
                None,
            )
            .await
            .map(|media| media.asset_path)
            .unwrap_or_default()
        };
        if super::reader::current(generation) {
            super::send_response(
                0,
                "nativeOcrImage",
                Ok(json!({"generation":generation, "path":path})),
            );
        }
    });
    tauri::async_runtime::spawn(poll(hash, generation));
    Ok(json!({}))
}

async fn poll(hash: String, generation: u64) {
    let mut record = crate::image_ocr::recognize_image_text(hash.clone(), false).await;
    while super::reader::current(generation) {
        let (state, busy) = match record {
            Ok(record) => {
                let busy = matches!(record.status.as_str(), "pending" | "running");
                (json!({"generation":generation, "record":record}), busy)
            }
            Err(error) => (json!({"generation":generation, "loadError":error}), false),
        };
        super::send_response(0, "nativeOcrState", Ok(state));
        if !busy {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !super::reader::current(generation) {
            break;
        }
        record = crate::image_ocr::get_image_ocr(hash.clone()).await;
    }
}

pub(super) async fn copy(app: tauri::AppHandle, mut payload: Value) -> Result<Value, String> {
    let generation = payload["argument"]
        .as_str()
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    if !super::reader::current(generation) {
        return Ok(Value::Null);
    }
    let text = match payload["documentText"].take() {
        Value::String(text) if !text.is_empty() => text,
        _ => return Err("Missing image text".into()),
    };
    if text.len() > crate::clipboard_budget::TEXT_CAPTURE_BYTES {
        return Err(crate::clipboard_budget::limit_error());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::copy(app.clone(), text.clone(), "Text".into(), None)?;
        crate::record_text_history(text);
        // Keep both renderers' existing history notifications intact.
        let _ = app.emit_to("clipboard", "listen_new_clipboard", "");
        super::refresh();
        Ok(json!({"generation":generation}))
    })
    .await
    .map_err(|error| error.to_string())?
}
