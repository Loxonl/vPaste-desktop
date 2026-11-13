//! Gesture-time preparation only. WinUI, not Rust or a WebView, owns this drag.
use crate::clipboard::item::{Item, ItemType};
use serde::Serialize;
use serde_json::Value;

// Leave room for the existing 4 MiB bridge response envelope. Do not truncate.
const MAX_DRAG_JSON_BYTES: usize = 4 * 1024 * 1024 - 1024;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    text: String,
    html: String,
    url: String,
    files: Vec<DragFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DragFile {
    path: String,
    is_directory: bool,
}

fn files(paths: Vec<String>, is_image: bool) -> Result<Vec<DragFile>, String> {
    if paths.is_empty() || (is_image && paths.len() != 1) {
        return Err("No valid drag source files".into());
    }
    let mut result = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical = std::path::PathBuf::from(&path)
            .canonicalize()
            .map_err(|error| format!("Source is unavailable: {path}: {error}"))?;
        let metadata = canonical.metadata().map_err(|error| error.to_string())?;
        let path = canonical.to_str().ok_or("Drag path is not valid Unicode")?;
        let mut path = crate::shell_compatible_windows_path(path);
        if is_image {
            // Reuse the proven PNG/GIF exporter; never drag an extensionless
            // thumbnail or substitute image text/URI data for a real file.
            path = crate::materialize_native_drag_image(&path)?;
        }
        result.push(DragFile {
            path,
            is_directory: metadata.is_dir(),
        });
    }
    Ok(result)
}

fn from_item(item: Item, html: String, full_text: Option<String>) -> Result<Value, String> {
    let mut payload = Payload::default();
    match item.item_type {
        ItemType::File => {
            payload.files = files(crate::parse_file_clipboard_content(&item.content)?, false)?
        }
        ItemType::Image => payload.files = files(vec![item.preview_content], true)?,
        ItemType::Link => {
            payload.text = item
                .content
                .split("|||")
                .next()
                .unwrap_or_default()
                .to_string();
            payload.url = reqwest::Url::parse(&payload.text)
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https"))
                .map(|url| url.to_string())
                .unwrap_or_default();
        }
        ItemType::TextFile => payload.text = full_text.ok_or("Full text is unavailable")?,
        ItemType::Text | ItemType::Color => {
            payload.text = if item.text_content.is_empty() {
                item.content
            } else {
                item.text_content
            };
            if item.item_type == ItemType::Text {
                payload.html = html;
            }
        }
    }
    if payload.files.is_empty() && payload.text.is_empty() && payload.html.is_empty() {
        return Err("Nothing to drag".into());
    }
    let value = serde_json::to_value(payload).map_err(|error| error.to_string())?;
    if serde_json::to_vec(&value)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_DRAG_JSON_BYTES
    {
        return Err("Content exceeds the native drag limit; use Copy instead / 内容超出原生拖拽限制，请改用复制".into());
    }
    Ok(value)
}

pub(super) async fn prepare(hash: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _cleanup = crate::auto_cleanup::pause();
        let item = crate::clipboard::history_action_item(&hash)?;
        let html = if item.item_type == ItemType::Text {
            crate::clipboard::rich_render_for_hash(&hash)
                .map(|render| render.drag_html())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let full_text = if item.item_type == ItemType::TextFile {
            Some(crate::clipboard::plain_text_content(&hash)?)
        } else {
            None
        };
        from_item(item, html, full_text)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(item_type: ItemType, content: &str) -> Item {
        Item {
            id: 0,
            hash: "synthetic".into(),
            item_type,
            content: content.into(),
            preview_content: String::new(),
            text_content: String::new(),
            rich_html: String::new(),
            app_source: String::new(),
            app_icon_path: String::new(),
            source_metadata: Default::default(),
            title_color: String::new(),
            time: 0,
            search_index: 0,
            label: 0,
            tags: Vec::new(),
        }
    }

    #[test]
    fn text_color_and_link_keep_their_real_data_formats() {
        let rich = from_item(item(ItemType::Text, "原文😀"), "<b>原文😀</b>".into(), None).unwrap();
        assert_eq!(rich["text"], "原文😀");
        assert_eq!(rich["html"], "<b>原文😀</b>");
        assert_eq!(rich["files"], serde_json::json!([]));
        let color = from_item(item(ItemType::Color, "#0B86FF"), String::new(), None).unwrap();
        assert_eq!(color["text"], "#0B86FF");
        let link = from_item(
            item(
                ItemType::Link,
                "https://example.com/a|||C:\\cover.png|||Page",
            ),
            String::new(),
            None,
        )
        .unwrap();
        assert_eq!(link["text"], "https://example.com/a");
        assert_eq!(link["url"], "https://example.com/a");
        assert_eq!(link["html"], "");
        let malformed = from_item(
            item(ItemType::Link, "javascript:bad()"),
            String::new(),
            None,
        )
        .unwrap();
        assert_eq!(malformed["url"], "");
    }

    #[test]
    fn long_text_uses_full_content_and_never_silently_truncates() {
        let value = from_item(
            item(ItemType::TextFile, "C:\\note.txt"),
            String::new(),
            Some("full content".into()),
        )
        .unwrap();
        assert_eq!(value["text"], "full content");
        assert!(from_item(item(ItemType::TextFile, "path"), String::new(), None).is_err());
        assert!(from_item(
            item(ItemType::Text, &"x".repeat(MAX_DRAG_JSON_BYTES)),
            String::new(),
            None
        )
        .is_err());
        assert!(from_item(item(ItemType::Text, ""), String::new(), None).is_err());
    }

    #[test]
    fn multi_file_and_folder_payloads_are_complete_and_read_only_inputs_are_untouched() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("文件 #100%.txt");
        std::fs::write(&path, "original").unwrap();
        let paths = vec![
            path.to_string_lossy().into_owned(),
            folder.path().to_string_lossy().into_owned(),
        ];
        let value = from_item(
            item(ItemType::File, &serde_json::to_string(&paths).unwrap()),
            String::new(),
            None,
        )
        .unwrap();
        assert_eq!(value["files"].as_array().unwrap().len(), 2);
        assert_eq!(value["files"][0]["isDirectory"], false);
        assert_eq!(value["files"][1]["isDirectory"], true);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(value["text"], "");
        let missing = folder.path().join("missing.txt");
        let invalid =
            serde_json::to_string(&[paths[0].clone(), missing.to_string_lossy().into_owned()])
                .unwrap();
        assert!(from_item(item(ItemType::File, &invalid), String::new(), None).is_err());
        assert!(files(Vec::new(), false).is_err());
        assert!(files(paths, true).is_err());
    }
}
