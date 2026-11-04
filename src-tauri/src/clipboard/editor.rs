use super::*;
use rusqlite::TransactionBehavior;

#[derive(Serialize)]
pub struct TextDocument {
    pub id: usize,
    pub hash: String,
    pub revision: String,
    pub text: String,
    pub html: String,
}

#[derive(Deserialize)]
pub struct TextUpdate {
    pub id: usize,
    pub revision: String,
    pub text: String,
    pub html: String,
    pub rtf: String,
}

fn editable(stored: &StoredItem) -> bool {
    matches!(
        stored.item_type.as_str(),
        "Text" | "TextFile" | "Link" | "Color"
    )
}

fn revision(stored: &StoredItem) -> String {
    let content = if stored.item_type == "Link" {
        stored.content.split("|||").next().unwrap_or("")
    } else {
        &stored.content
    };
    let mut paths = Vec::new();
    if stored.item_type == "TextFile" {
        paths.push(stored.content.clone());
    }
    if let Some(meta) = rich_meta_from_source(&stored.source) {
        paths.extend([meta.html_path, meta.rtf_path]);
    }
    let stamps = paths
        .iter()
        .map(|path| rich_html_file_stamp(path).map(|stamp| (stamp.len, stamp.modified_nanos)))
        .collect::<Vec<_>>();
    let value = format!(
        "{:?}",
        (
            history_storage_dir(),
            stored.id,
            &stored.hash,
            content,
            &stored.source,
            &stored.item_type,
            stamps
        )
    );
    calculate_xxhash64(value.as_bytes())
}

pub fn load(hash: &str) -> Result<TextDocument, String> {
    let _cleanup = crate::auto_cleanup::pause();
    let stored = db()
        .query_row(
            "SELECT * FROM clipboard WHERE hash = ?1",
            [hash],
            read_stored_item,
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or("editor.missing")?;
    if !editable(&stored) {
        return Err("editor.unsupported".into());
    }
    let expected_revision = revision(&stored);
    let text = plain_text_from_stored_item(&stored)?;
    let html = match rich_meta_from_source(&stored.source) {
        None => String::new(),
        Some(meta) => {
            crate::validate_rich_restore_budget(&text, &meta)?;
            if !meta.html_path.is_empty() {
                read_rich_html_fragment_with_limit(&meta.html_path, MAX_EDITOR_CONTENT_BYTES as u64)
                    .ok_or("editor.richUnavailable")?
            } else if !meta.rtf_path.is_empty() {
                rtf_to_html(
                    &crate::clipboard_budget::read_file_limited(
                        &meta.rtf_path,
                        MAX_EDITOR_CONTENT_BYTES,
                    )?,
                    &text,
                )?
            } else {
                return Err("editor.richUnavailable".into());
            }
        }
    };
    if expected_revision != revision(&stored) {
        return Err("editor.changed".into());
    }
    Ok(TextDocument {
        id: stored.id,
        hash: stored.hash.clone(),
        revision: expected_revision,
        text,
        html,
    })
}

// Prepare unique files so queued and undo snapshots never observe edited bytes.
#[derive(Default)]
struct PreparedFiles(HashSet<PathBuf>);

impl PreparedFiles {
    fn write(&mut self, key: &str, extension: &str, bytes: &[u8]) -> Result<String, String> {
        let path = data_dir().join(format!("{key}.{extension}"));
        fs::create_dir_all(data_dir()).map_err(|err| err.to_string())?;
        self.0.insert(path.clone());
        history_store::write_file(&path, bytes)?;
        Ok(native_path_string(&path))
    }
}

impl Drop for PreparedFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

pub fn save(update: TextUpdate) -> Result<Item, String> {
    let _cleanup = crate::auto_cleanup::pause();
    if is_semantically_blank_text(&update.text) {
        return Err("editor.blank".into());
    }
    if update.text.len() > crate::clipboard_budget::TEXT_CAPTURE_BYTES
        || update
            .text
            .len()
            .saturating_add(update.html.len())
            .saturating_add(update.rtf.len())
            > MAX_EDITOR_CONTENT_BYTES
    {
        return Err("editor.tooLarge".into());
    }
    let mut conn = db();
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let stored = transaction
        .query_row(
            "SELECT * FROM clipboard WHERE id = ?1",
            [update.id],
            read_stored_item,
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or("editor.missing")?;
    if !editable(&stored) {
        return Err("editor.unsupported".into());
    }
    if revision(&stored) != update.revision {
        return Err("editor.changed".into());
    }
    let rich = !update.html.trim().is_empty();
    if is_rich_meta_source(&stored.source) && (!rich || !update.rtf.starts_with("{\\rtf")) {
        return Err("editor.richUnavailable".into());
    }
    let hash = if rich {
        rich_text_history_hash(
            &update.text,
            Some(update.html.as_bytes()),
            Some(update.rtf.as_bytes()),
            None,
        )
    } else {
        calculate_xxhash64(update.text.as_bytes())
    };
    let duplicate: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM clipboard WHERE hash = ?1 AND id <> ?2)",
            rusqlite::params![hash, update.id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if duplicate {
        return Err("editor.duplicate".into());
    }

    let key = format!("{hash}.edit.{:016x}", rand::random::<u64>());
    let mut files = PreparedFiles::default();
    let source = if rich {
        let html_bytes = native_html_payload(&update.html);
        let mut rtf_bytes = update.rtf.as_bytes().to_vec();
        if cfg!(target_os = "windows") {
            rtf_bytes.push(0);
        }
        if update
            .text
            .len()
            .saturating_add(html_bytes.len())
            .saturating_add(rtf_bytes.len())
            > MAX_EDITOR_CONTENT_BYTES
        {
            return Err("editor.tooLarge".into());
        }
        let meta = RichClipboardMeta {
            version: 1,
            html_path: files.write(&key, "cf_html", &html_bytes)?,
            rtf_path: files.write(&key, "rtf", &rtf_bytes)?,
            png_path: String::new(),
        };
        format!(
            "{}{}",
            RICH_META_PREFIX,
            serde_json::to_string(&meta).map_err(|err| err.to_string())?
        )
    } else {
        String::new()
    };
    let (content, item_type) = if update.text.len() > LARGE_TEXT_THRESHOLD_BYTES {
        (
            files.write(&key, "txt", update.text.as_bytes())?,
            ItemType::TextFile,
        )
    } else {
        (update.text.clone(), convert_type(&update.text))
    };
    let preview: String = update.text.chars().take(CARD_TEXT_PREVIEW_CHARS).collect();
    let time = current_timestamp_millis();
    transaction
        .execute(
            "UPDATE clipboard SET hash = ?1, content = ?2, preview_content = ?3,
            source = ?4, item_type = ?5, time = ?6, search_index = 0 WHERE id = ?7",
            rusqlite::params![
                hash,
                content,
                preview,
                source,
                item_type.to_string(),
                time,
                update.id
            ],
        )
        .map_err(|err| err.to_string())?;
    transaction.commit().map_err(|err| err.to_string())?;
    files.0.clear();
    drop(conn);
    if hash != stored.hash {
        engine::delete(&stored.hash);
    }
    let mut edited = stored.clone();
    edited.hash = hash.clone();
    edited.content = content;
    edited.preview_content = preview;
    edited.source = source.clone();
    edited.item_type = item_type.to_string();
    edited.time = time;
    edited.search_index = 0;
    let item = materialize_item(edited);
    engine::insert(
        &captured_item_search_content(&item, &update.text, &source, &stored.app_source),
        &hash,
        &(update.id as u64),
        time,
    );
    let old_paths = internal_paths_for_stored_item(&stored);
    // Keep old attachments if reference inspection fails; queued snapshots own them too.
    if let Ok(retained) = internal_paths_referenced_by_survivors(&[], &old_paths) {
        for path in old_paths {
            if !retained.contains(&path) && path.is_file() && is_path_inside_history_storage(&path)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(item)
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn native_html_payload(html: &str) -> Vec<u8> {
    #[cfg(not(target_os = "windows"))]
    {
        html.as_bytes().to_vec()
    }
    #[cfg(target_os = "windows")]
    {
        // CF_HTML offsets count UTF-8 bytes, including the fixed-width header.
        let header = |start: usize, end: usize, fragment_start: usize, fragment_end: usize| {
            format!("Version:1.0\r\nStartHTML:{start:010}\r\nEndHTML:{end:010}\r\nStartFragment:{fragment_start:010}\r\nEndFragment:{fragment_end:010}\r\n")
        };
        let prefix = "<html><body><!--StartFragment-->";
        let suffix = "<!--EndFragment--></body></html>";
        let start = header(0, 0, 0, 0).len();
        let fragment_start = start + prefix.len();
        let fragment_end = fragment_start + html.len();
        let end = fragment_end + suffix.len();
        let mut bytes = format!(
            "{}{}{}{}",
            header(start, end, fragment_start, fragment_end),
            prefix,
            html,
            suffix
        )
        .into_bytes();
        bytes.push(0);
        bytes
    }
}

fn rtf_to_html(bytes: &[u8], expected_text: &str) -> Result<String, String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "editor.richUnavailable")?;
    let document = rtf_parser::RtfDocument::try_from(raw.trim_matches('\0'))
        .map_err(|_| "editor.richUnavailable")?;
    if document
        .get_text()
        .replace("\r\n", "\n")
        .trim_end_matches('\n')
        != expected_text.replace("\r\n", "\n").trim_end_matches('\n')
    {
        return Err("editor.richUnavailable".into());
    }
    let mut html = String::new();
    for block in &document.body {
        let painter = &block.painter;
        let mut style = format!("font-size:{}pt;white-space:pre-wrap;", painter.font_size);
        if painter.bold {
            style.push_str("font-weight:bold;");
        }
        if painter.italic {
            style.push_str("font-style:italic;");
        }
        if painter.underline || painter.strike {
            style.push_str(&format!(
                "text-decoration:{} {};",
                if painter.underline { "underline" } else { "" },
                if painter.strike { "line-through" } else { "" }
            ));
        }
        if let Some(color) = document.header.color_table.get(&painter.color_ref) {
            style.push_str(&format!(
                "color:rgb({},{},{});",
                color.red, color.green, color.blue
            ));
        }
        if let Some(font) = document.header.font_table.get(&painter.font_ref) {
            style.push_str(&format!(
                "font-family:{};",
                font.name.replace([';', '"', '\''], "")
            ));
        }
        html.push_str(&format!(
            "<span style=\"{}\">{}</span>",
            html_escape(&style),
            html_escape(&block.text)
        ));
    }
    Ok(html)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStorage {
        _root: tempfile::TempDir,
        previous: Option<String>,
    }
    impl Drop for TestStorage {
        fn drop(&mut self) {
            engine::shutdown_runtime_for_tests();
            *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = self.previous.take();
        }
    }
    fn setup() -> TestStorage {
        let root = tempfile::tempdir().unwrap();
        let previous = crate::GLOBAL_APP_DATA_DIR.lock().unwrap().clone();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        crate::config::save(crate::config::Config::default());
        super::super::db::init();
        TestStorage {
            _root: root,
            previous,
        }
    }
    fn update(document: &TextDocument, text: &str) -> TextUpdate {
        TextUpdate {
            id: document.id,
            revision: document.revision.clone(),
            text: text.into(),
            html: String::new(),
            rtf: String::new(),
        }
    }
    fn capture(text: &str) -> String {
        capture_text_from_app(text.into(), "Browser", "", false).unwrap()
    }

    #[test]
    fn editing_preserves_identity_latest_favorite_and_tags_and_refreshes_search() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = setup();
        engine::rebuild(Vec::new()).unwrap();
        let hash = capture("original needle");
        db().execute("UPDATE clipboard SET time = 1 WHERE hash = ?1", [&hash])
            .unwrap();
        let document = load(&hash).unwrap();
        touch(&hash).unwrap();
        set_favorite(&hash, true).unwrap();
        let tag = create_tag("Keep").unwrap();
        assign_tag(&hash, tag.id).unwrap();
        let edited = save(update(&document, "edited replacement")).unwrap();
        assert_eq!(edited.id, document.id);
        assert_eq!(edited.label, 1);
        assert_eq!(edited.tags[0].id, tag.id);
        assert_eq!(edited.app_source, "Browser");
        assert!(edited.time > 1);
        assert!(try_get_by_hash(&hash).is_none());
        assert_eq!(
            plain_text_content(&edited.hash).unwrap(),
            "edited replacement"
        );
        assert_eq!(load(&edited.hash).unwrap().text, "edited replacement");
        assert!(engine::search_page("original", 0, 10)
            .unwrap()
            .hashes
            .is_empty());
        assert_eq!(
            engine::search_page("replacement", 0, 10).unwrap().hashes,
            vec![edited.hash]
        );
    }

    #[test]
    fn duplicates_blank_conflicts_and_deleted_records_never_overwrite_history() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = setup();
        let hash = capture("original");
        let document = load(&hash).unwrap();
        capture("already exists");
        assert_eq!(
            save(update(&document, "already exists")).err().unwrap(),
            "editor.duplicate"
        );
        assert_eq!(
            save(update(&document, " \n\t")).err().unwrap(),
            "editor.blank"
        );
        db().execute(
            "UPDATE clipboard SET content = 'changed externally' WHERE hash = ?1",
            [&hash],
        )
        .unwrap();
        assert_eq!(
            save(update(&document, "changed")).err().unwrap(),
            "editor.changed"
        );
        assert_eq!(plain_text_content(&hash).unwrap(), "changed externally");
        delete_by_hash(&hash).unwrap();
        assert_eq!(
            save(update(&document, "changed")).err().unwrap(),
            "editor.missing"
        );
    }

    #[test]
    fn long_text_edit_retains_the_independent_queued_snapshot() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = setup();
        let original = "原文 ".repeat(5_000);
        let hash = capture(&original);
        let document = load(&hash).unwrap();
        assert_eq!(document.text, original);
        let previous = try_get_by_hash(&hash).unwrap().content;
        crate::paste_queue::add_items(&[hash.clone()]).unwrap();
        let replacement = "  new text\n".repeat(5_000);
        let edited = save(update(&document, &replacement)).unwrap();
        assert_eq!(edited.item_type, ItemType::TextFile);
        assert_ne!(edited.content, previous);
        assert_eq!(plain_text_content(&edited.hash).unwrap(), replacement);
        assert_eq!(
            history_store::read_file(&previous).unwrap(),
            original.as_bytes()
        );
        assert_eq!(crate::paste_queue::state().unwrap().items[0].hash, hash);
    }

    #[test]
    fn rich_edit_replaces_all_formats_and_keeps_queued_attachments_unchanged() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = setup();
        let hash = capture_rich_text_from_app(
            "old".into(),
            Some(b"<b>old</b>".to_vec()),
            Some(br"{\rtf1 old}".to_vec()),
            None,
            "Browser",
            "",
            false,
        )
        .unwrap();
        let document = load(&hash).unwrap();
        assert!(document.html.contains("<b>old</b>"));
        let old_meta = rich_clipboard_meta(&hash).unwrap();
        crate::paste_queue::add_items(&[hash.clone()]).unwrap();
        let mut request = update(&document, "new");
        request.html = "<b style=\"color:red\">new</b>".into();
        request.rtf = r"{\rtf1\b new}".into();
        let edited = save(request).unwrap();
        let meta = rich_clipboard_meta(&edited.hash).unwrap();
        assert_ne!(meta.rtf_path, old_meta.rtf_path);
        assert!(edited.rich_html.contains("new"));
        let rtf = history_store::read_file(&meta.rtf_path).unwrap();
        assert_eq!(rtf.strip_suffix(&[0]).unwrap_or(&rtf), br"{\rtf1\b new}");
        assert_eq!(
            history_store::read_file(&old_meta.rtf_path).unwrap(),
            br"{\rtf1 old}"
        );
        assert_eq!(
            history_store::read_file(&old_meta.html_path).unwrap(),
            b"<b>old</b>"
        );
        assert!(meta.png_path.is_empty());
    }

    #[test]
    fn rich_items_cannot_silently_be_saved_as_plain_text() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = setup();
        let hash = capture_rich_text_from_app(
            "old".into(),
            Some(b"<b>old</b>".to_vec()),
            None,
            None,
            "Browser",
            "",
            false,
        )
        .unwrap();
        let document = load(&hash).unwrap();
        assert_eq!(
            save(update(&document, "new")).err().unwrap(),
            "editor.richUnavailable"
        );
        assert_eq!(plain_text_content(&hash).unwrap(), "old");
    }

    #[test]
    fn basic_rtf_only_items_keep_styles_and_failed_conversion_is_explicit() {
        let html = rtf_to_html(
            br"{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\colortbl;\red255\green0\blue0;}\f0\cf1\b hello}",
            "hello",
        )
        .unwrap();
        assert!(html.contains("font-weight:bold"));
        assert!(html.contains("color:rgb(255,0,0)"));
        assert_eq!(
            rtf_to_html(br"{\rtf1 wrong}", "full original").unwrap_err(),
            "editor.richUnavailable"
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn edited_cf_html_has_correct_utf8_fragment_and_context_offsets() {
        let fragment = "<b>更新中文😀</b>";
        let bytes = native_html_payload(fragment);
        let raw = std::str::from_utf8(&bytes).unwrap();
        let start = cf_html_offset(raw, "StartFragment:").unwrap();
        let end = cf_html_offset(raw, "EndFragment:").unwrap();
        assert_eq!(&bytes[start..end], fragment.as_bytes());
        let html_start = cf_html_offset(raw, "StartHTML:").unwrap();
        let html_end = cf_html_offset(raw, "EndHTML:").unwrap();
        assert!(raw[html_start..html_end].starts_with("<html><body>"));
        assert!(raw[html_start..html_end].ends_with("</body></html>"));
        assert_eq!(bytes[html_end], 0);
    }

    #[test]
    fn edited_links_and_colors_reclassify_as_their_new_text() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = setup();
        let hash = capture("https://example.com/");
        let edited = save(update(&load(&hash).unwrap(), "#123456")).unwrap();
        assert_eq!(edited.item_type, ItemType::Color);
        let edited = save(update(&load(&edited.hash).unwrap(), "  plain\ntext  ")).unwrap();
        assert_eq!(edited.item_type, ItemType::Text);
        assert_eq!(plain_text_content(&edited.hash).unwrap(), "  plain\ntext  ");
    }

    #[test]
    fn oversized_edits_leave_the_original_item_unchanged() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = setup();
        let hash = capture("original");
        let document = load(&hash).unwrap();
        assert!(save(update(
            &document,
            &"x".repeat(crate::clipboard_budget::TEXT_CAPTURE_BYTES + 1)
        ))
        .is_err());
        let mut rich_update = update(&document, "valid text");
        rich_update.html = "x".repeat(crate::clipboard_budget::RICH_CAPTURE_BYTES);
        assert!(save(rich_update).is_err());
        assert_eq!(load(&hash).unwrap().text, "original");
    }
}
