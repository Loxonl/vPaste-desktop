//! Native plain-text editing uses the existing validated clipboard transaction.
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};
use tauri::Manager;
use tokio::sync::Mutex;

use crate::clipboard::editor;

struct Session {
    generation: u64,
    document: Option<Identity>,
}

struct Identity {
    id: usize,
    hash: String,
    revision: String,
}

static SESSION: Mutex<Option<Session>> = Mutex::const_new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CURRENT: AtomicU64 = AtomicU64::new(0);

pub(super) fn focused() -> bool {
    CURRENT.load(Ordering::Acquire) != 0 && crate::TEXT_EDITOR_FOCUSED.load(Ordering::Acquire)
}

pub(super) fn is_open() -> bool {
    CURRENT.load(Ordering::Acquire) != 0
}

pub(super) fn raise_if_open() {
    let generation = CURRENT.load(Ordering::Acquire);
    if generation != 0 {
        super::send_response(
            0,
            "nativeEditorRaise",
            Ok(json!({ "generation": generation })),
        );
    }
}

pub(super) fn focus_changed(op: &str, argument: &str) -> bool {
    if !matches!(op, "nativeEditorFocusIn" | "nativeEditorFocusOut") {
        return false;
    }
    if let Ok(generation) = argument.parse::<u64>() {
        if generation != 0 && CURRENT.load(Ordering::Acquire) == generation {
            crate::TEXT_EDITOR_FOCUSED.store(op == "nativeEditorFocusIn", Ordering::Release);
        }
    }
    true
}

pub(super) async fn open(app: tauri::AppHandle, hash: String) -> Result<Value, String> {
    let mut session = SESSION.lock().await;
    if let Some(active) = session.as_ref() {
        super::send_response(
            0,
            "nativeEditorRaise",
            Ok(json!({"generation":active.generation})),
        );
        return Ok(json!({}));
    }
    if app.get_webview_window("textEditor").is_some() {
        crate::open_text_editor_window(app, hash).await?;
        return Ok(json!({}));
    }
    let area = super::preview::surface()
        .ok_or("The clipboard panel is unavailable")?
        .bounds;
    let history_hash = hash.clone();
    let document =
        tauri::async_runtime::spawn_blocking(move || crate::clipboard::editor::load(&history_hash))
            .await
            .map_err(|error| error.to_string())?;
    // Don't convert HTML to plain text to force a migration.
    if document.as_ref().is_ok_and(|entry| !entry.html.is_empty())
        || document
            .as_ref()
            .is_err_and(|error| error == "editor.richUnavailable")
    {
        crate::show_text_editor_window(app, hash, Some(document)).await?;
        return Ok(json!({}));
    }
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let (document, text, error) = match document {
        Ok(entry) => (
            Some(Identity {
                id: entry.id,
                hash: entry.hash,
                revision: entry.revision,
            }),
            entry.text,
            String::new(),
        ),
        Err(error) => (None, String::new(), error),
    };
    let (width, height) =
        crate::ui_text_scale::content_size(596.0, 476.0, crate::ui_text_scale::current());
    let rect = super::reader::geometry(crate::PreviewWindowSize { width, height }, area);
    *session = Some(Session {
        generation,
        document,
    });
    CURRENT.store(generation, Ordering::Release);
    super::send_response(
        0,
        "nativeEditorOpen",
        Ok(json!({
            "generation":generation, "kind":"editor", "rect":rect, "text":text, "error":error,
            "takesFocus":true, "durationMs":0, "easing":[0,0,1,1]
        })),
    );
    Ok(json!({}))
}

pub(super) async fn save(app: tauri::AppHandle, mut payload: Value) -> Result<Value, String> {
    let generation = payload["argument"]
        .as_str()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut session = SESSION.lock().await;
    let Some(active) = session
        .as_ref()
        .filter(|active| active.generation == generation)
    else {
        return Ok(Value::Null);
    };
    let entry = active.document.as_ref().ok_or("editor.missing")?;
    let text = match payload["documentText"].take() {
        Value::String(text) => text,
        _ => return Err("editor.blank".into()),
    };
    crate::save_clipboard_text_for_hash(
        app,
        Some(entry.hash.clone()),
        editor::TextUpdate {
            id: entry.id,
            revision: entry.revision.clone(),
            text,
            html: String::new(),
            rtf: String::new(),
        },
    )
    .await?;
    finish(&mut session, generation);
    Ok(Value::Null)
}

pub(super) async fn close(argument: &str) -> Result<Value, String> {
    if let Ok(generation) = argument.parse::<u64>() {
        let mut session = SESSION.lock().await;
        if session
            .as_ref()
            .is_some_and(|active| active.generation == generation)
        {
            finish(&mut session, generation);
        }
    }
    Ok(json!({}))
}

fn finish(session: &mut Option<Session>, generation: u64) {
    *session = None;
    CURRENT.store(0, Ordering::Release);
    crate::TEXT_EDITOR_FOCUSED.store(false, Ordering::Release);
    crate::begin_preview_focus_handoff();
    super::send_response(
        0,
        "nativeEditorClosed",
        Ok(json!({"generation":generation})),
    );
}
