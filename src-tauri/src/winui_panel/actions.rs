//! Type-specific card actions reuse the shipping Rust commands, not UI payloads.
use crate::clipboard::item::{Item, ItemType};
use serde_json::{json, Value};

fn image_source(item: &Item) -> Option<String> {
    match item.item_type {
        ItemType::Image => (!item.preview_content.is_empty()).then(|| item.preview_content.clone()),
        ItemType::File => {
            let paths: Vec<String> = serde_json::from_str(&item.content).ok()?;
            if paths.len() != 1 {
                return None;
            }
            let path = &paths[0];
            let extension = std::path::Path::new(path)
                .extension()?
                .to_str()?
                .to_ascii_lowercase();
            [
                "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "svg",
            ]
            .contains(&extension.as_str())
            .then(|| path.clone())
        }
        _ => None,
    }
}

fn color_value(item: &Item, format: &str) -> Result<String, String> {
    if item.item_type != ItemType::Color {
        return Err("Not a color record / 不是颜色记录".into());
    }
    crate::clipboard::color::color_variants(&item.content)
        .into_iter()
        .find(|variant| variant.format == format)
        .map(|variant| variant.value)
        .ok_or_else(|| "Invalid color format / 无效的颜色格式".into())
}

pub(super) fn metadata(item: &Item) -> Value {
    json!({"canExportImage":image_source(item).is_some(),
        "colorFormats": if item.item_type == ItemType::Color {
            crate::clipboard::color::color_variants(&item.content)
        } else { Vec::new() }})
}

fn checked_image_source(item: &Item) -> Result<String, String> {
    let source = image_source(item).ok_or("Not a single image / 不是单张图片")?;
    if !std::path::Path::new(&source).is_file() {
        return Err("Source image is missing / 原图片文件已不存在".into());
    }
    Ok(source)
}

fn clear_tags(hash: String) -> Result<Value, String> {
    // The lightweight copy/paste projection deliberately omits tags.
    let item = crate::clipboard::try_get_by_hash(&hash)
        .ok_or("Clipboard item was not found / 剪贴项已不存在")?;
    for tag in item.tags {
        crate::clipboard::remove_tag(&hash, tag.id)?;
    }
    Ok(json!({"message":"Tags removed / 已移除全部标签"}))
}

pub(super) async fn dispatch(
    app: tauri::AppHandle,
    operation: String,
    hash: String,
    argument: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _cleanup = crate::auto_cleanup::pause();
        if operation == "clearTags" {
            return clear_tags(hash);
        }
        let item = crate::clipboard::history_action_item(&hash)?;
        match operation.as_str() {
            "openFolder" => {
                if item.item_type != ItemType::File {
                    return Err("Not a file record".into());
                }
                crate::open_containing_folder(item.content)?;
                Ok(json!({"message":"Folder opened / 已打开所在目录"}))
            }
            "copyFolder" | "copyColor" => {
                let _action = super::ClipboardActionGuard::acquire()?;
                let text = if operation == "copyColor" {
                    color_value(&item, &argument)?
                } else {
                    if item.item_type != ItemType::File {
                        return Err("Not a file record".into());
                    }
                    crate::containing_folder_path(item.content)?
                };
                crate::copy(app, text.clone(), "Text".into(), None)?;
                crate::record_text_history(text);
                Ok(json!({"message":"Copied / 已复制"}))
            }
            "exportPrepare" => {
                checked_image_source(&item)?;
                let millis = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_millis();
                Ok(json!({"fileName":format!("vpaste-image-{millis}.png")}))
            }
            "exportImage" => {
                let source = checked_image_source(&item)?;
                let destination = std::path::Path::new(&argument);
                let extension = destination
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !destination.is_absolute()
                    || !["png", "jpg", "jpeg", "webp", "bmp"].contains(&extension.as_str())
                {
                    return Err("Choose PNG, JPEG, WebP or BMP / 请选择受支持的图片格式".into());
                }
                crate::export_image_item(source, argument.clone())?;
                let reveal_error = crate::reveal_file_in_folder(argument).err();
                let hide_error = super::hide_on_ui_thread().err();
                let warning = reveal_error.or(hide_error);
                Ok(json!({"message":"Image exported / 图片已导出", "warning":warning}))
            }
            _ => Err("Unknown card action".into()),
        }
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
    fn export_source_matches_image_and_single_image_file_semantics() {
        let mut image = item(ItemType::Image, "not the source");
        image.preview_content = "C:\\cache\\image.png".into();
        assert_eq!(
            image_source(&image).as_deref(),
            Some("C:\\cache\\image.png")
        );
        for extension in [
            "PNG", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "svg",
        ] {
            let path = format!("C:\\图片 #1.{extension}");
            let content = serde_json::to_string(&[&path]).unwrap();
            assert_eq!(image_source(&item(ItemType::File, &content)), Some(path));
        }
        for content in [
            "[]",
            "invalid",
            r#"["C:\\a.png","C:\\b.png"]"#,
            r#"["C:\\a.txt"]"#,
        ] {
            assert_eq!(image_source(&item(ItemType::File, content)), None);
        }
        assert_eq!(image_source(&item(ItemType::Text, "C:\\a.png")), None);
    }

    #[test]
    fn converted_color_is_resolved_from_history_not_supplied_text() {
        let color = item(ItemType::Color, "#0B86FF");
        assert_eq!(color_value(&color, "RGB").unwrap(), "rgb(11, 134, 255)");
        assert!(color_value(&color, "HSL").unwrap().starts_with("hsl("));
        assert!(color_value(&color, "arbitrary text").is_err());
        assert!(color_value(&item(ItemType::Text, "#0B86FF"), "HEX").is_err());
        assert!(color_value(&item(ItemType::Color, "invalid"), "HEX").is_err());
    }

    #[test]
    fn metadata_and_export_recheck_current_files_without_modifying_them() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("图片 #1.png");
        std::fs::write(&path, "original").unwrap();
        let mut image = item(ItemType::Image, "");
        image.preview_content = path.to_string_lossy().into_owned();
        assert_eq!(metadata(&image)["canExportImage"], true);
        assert!(checked_image_source(&image).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
        std::fs::remove_file(&path).unwrap();
        assert!(checked_image_source(&image).is_err());
        assert_eq!(
            metadata(&item(ItemType::File, r#"["C:\\report.pdf"]"#))["canExportImage"],
            false
        );
        assert_eq!(
            metadata(&item(ItemType::Text, "plain"))["colorFormats"],
            json!([])
        );
        let variants = metadata(&item(ItemType::Color, "rgba(11, 134, 255, 0.5)"));
        assert_eq!(variants["colorFormats"].as_array().unwrap().len(), 3);
        assert_eq!(variants["colorFormats"][0]["format"], "HEX");
    }

    #[test]
    fn clearing_assigned_tags_reads_real_membership_and_keeps_other_records_and_tags() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _cleanup = crate::auto_cleanup::pause();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        crate::config::save(crate::config::Config::default());
        crate::clipboard::db::init();
        let target = crate::clipboard::insert_text_from_app("target".into(), "Test", "").unwrap();
        let other = crate::clipboard::insert_text_from_app("other".into(), "Test", "").unwrap();
        let work = crate::clipboard::create_tag("Work").unwrap();
        let notes = crate::clipboard::create_tag("Notes").unwrap();
        crate::clipboard::assign_tag(&target, work.id).unwrap();
        crate::clipboard::assign_tag(&target, notes.id).unwrap();
        crate::clipboard::assign_tag(&other, work.id).unwrap();
        crate::clipboard::set_favorite(&target, true).unwrap();
        clear_tags(target.clone()).unwrap();
        let item = crate::clipboard::try_get_by_hash(&target).unwrap();
        assert!(item.tags.is_empty());
        assert_eq!(item.content, "target");
        assert_eq!(item.label & 1, 1);
        assert_eq!(
            crate::clipboard::try_get_by_hash(&other).unwrap().tags[0].id,
            work.id
        );
        assert_eq!(crate::clipboard::list_tags().unwrap().len(), 2);
        assert!(clear_tags("missing".into()).is_err());
    }
}
