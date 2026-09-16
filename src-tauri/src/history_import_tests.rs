use super::*;

#[test]
fn custom_tab_import_merges_without_losing_local_filters() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("import.json");
    let target = root.path().join("local.json");
    let local = r#"[{"id":"local","name":"Local","filter":{}},{"id":"shared","name":"Local shared","filter":{"itemType":"Text"}}]"#;
    fs::write(&target, local).unwrap();
    assert!(!import_custom_tabs(&source, &target, None).unwrap());
    assert_eq!(fs::read_to_string(&target).unwrap(), local);
    fs::write(&source, "[]").unwrap();
    import_custom_tabs(&source, &target, None).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), local);
    fs::write(&source, r#"[{"id":"shared","name":"Imported conflict","filter":{}},{"id":"new","name":"New","filter":{"favorite":"yes"}}]"#).unwrap();
    assert!(import_custom_tabs(&source, &target, None).unwrap());
    let merged = fs::read_to_string(&target).unwrap();
    let tabs: serde_json::Value = serde_json::from_str(&merged).unwrap();
    assert_eq!(tabs.as_array().unwrap().len(), 3);
    assert_eq!(tabs[0]["id"], "local");
    assert_eq!(tabs[1]["name"], "Local shared");
    assert_eq!(tabs[1]["filter"]["itemType"], "Text");
    assert_eq!(tabs[2]["id"], "new");
    import_custom_tabs(&source, &target, None).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), merged);
}

#[test]
fn plain_text_import_preserves_literal_paths_and_hashes() {
    for old in [r"C:\old\history", "/old/history"] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        let text = format!(
            "Keep verbatim: {old}\nC:%5Cold%5Chistory /old/history-backup %2Fold%2Fhistory 中文"
        );
        let preview = format!("Preview: {old}");
        let db = rusqlite::Connection::open(source.join("vpaste.db")).unwrap();
        clipboard::db::init_schema(&db).unwrap();
        db.execute("insert into clipboard(hash,time,content,preview_content,item_type,source) values('text',1,?1,?2,'Text','')", rusqlite::params![text, preview]).unwrap();
        db.execute("insert into paste_queue(hash,position,queued_at,time,content,preview_content,item_type,source) values('text',0,1,1,?1,?2,'Text','')", rusqlite::params![text, preview]).unwrap();
        drop(db);
        assert_eq!(
            merge_clipboard_database(source.to_str().unwrap(), target.to_str().unwrap(), old)
                .unwrap(),
            (1, 0)
        );
        let db = rusqlite::Connection::open(target.join("vpaste.db")).unwrap();
        for table in ["clipboard", "paste_queue"] {
            let stored: (String, String, String) = db
                .query_row(
                    &format!("select content,preview_content,hash from {table}"),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(stored, (text.clone(), preview.clone(), "text".to_string()));
        }
    }
}

#[test]
fn custom_tab_import_handles_new_targets_and_rejects_invalid_data_without_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("import.json");
    let target = root.path().join("nested/local.json");
    let payload = r#"[{"id":"new","name":"First","filter":{}},{"id":"new","name":"Duplicate"}]"#;
    fs::write(&source, payload).unwrap();
    let mut progress =
        HistoryArchiveProgressState::new(None, "import", HistoryArchiveTotals::empty());
    assert!(import_custom_tabs(&source, &target, Some(&mut progress)).unwrap());
    assert_eq!(progress.processed_files, 1);
    assert_eq!(progress.processed_bytes, payload.len() as u64);
    let saved = fs::read(&target).unwrap();
    let tabs: Vec<serde_json::Value> = serde_json::from_slice(&saved).unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0]["name"], "First");
    for invalid in [
        "not json",
        "{}",
        r#"[{"id":"valid","name":"Valid"},{"name":"Missing ID"}]"#,
    ] {
        fs::write(&source, invalid).unwrap();
        assert!(import_custom_tabs(&source, &target, None).is_err());
        assert_eq!(fs::read(&target).unwrap(), saved);
    }
    fs::write(&source, payload).unwrap();
    fs::write(&target, "invalid local data").unwrap();
    assert!(import_custom_tabs(&source, &target, None).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "invalid local data");
}

#[test]
fn rich_import_relocates_only_packaged_attachments() {
    for old in [r"C:\Users\old\History", "/Users/old/History"] {
        let root = tempfile::tempdir().unwrap();
        let extracted = root.path().join("extracted");
        let target = root.path().join("target");
        fs::create_dir_all(extracted.join("rich_formats")).unwrap();
        fs::create_dir_all(target.join("rich_formats")).unwrap();
        let separator = if old.contains('\\') { "\\" } else { "/" };
        let old_path = |suffix: &str| format!("{old}{separator}{}", suffix.replace('/', separator));
        let text = format!("Keep this text: {old}/rich_formats/example");
        let db = rusqlite::Connection::open(extracted.join("vpaste.db")).unwrap();
        clipboard::db::init_schema(&db).unwrap();
        for (index, paths) in [
            [
                old_path("rich_formats/a.html"),
                old_path("rich_formats/a.rtf"),
                old_path("rich_formats/a.png"),
            ],
            [
                format!("{old}-external{separator}a.html"),
                old_path("rich_formats/missing.rtf"),
                old_path("rich_formats/../outside.png"),
            ],
        ]
        .into_iter()
        .enumerate()
        {
            let meta = serde_json::json!({"version": 1, "html_path": paths[0], "rtf_path": paths[1], "png_path": paths[2]});
            let source = format!("vpaste-rich:{meta}");
            let hash = format!("rich-{index}");
            db.execute("insert into clipboard(hash,time,content,preview_content,item_type,source) values(?1,1,?2,?2,'Text',?3)", rusqlite::params![hash, text, source]).unwrap();
            db.execute("insert into paste_queue(hash,position,queued_at,time,content,preview_content,item_type,source) values(?1,?2,1,1,?3,?3,'Text',?4)", rusqlite::params![hash, index, text, source]).unwrap();
        }
        for name in ["a.html", "a.rtf", "a.png"] {
            fs::write(extracted.join("rich_formats").join(name), name.as_bytes()).unwrap();
        }
        copy_history_dir_contents_recursive_with_progress(
            &extracted.join("rich_formats"),
            &target.join("rich_formats"),
            None,
        )
        .unwrap();
        drop(db);
        assert_eq!(
            merge_clipboard_database(extracted.to_str().unwrap(), target.to_str().unwrap(), old)
                .unwrap(),
            (2, 0)
        );
        let db = rusqlite::Connection::open(target.join("vpaste.db")).unwrap();
        for table in ["clipboard", "paste_queue"] {
            let (content, preview, source): (String, String, String) = db
                .query_row(
                    &format!(
                        "select content,preview_content,source from {table} where hash='rich-0'"
                    ),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            let meta: clipboard::RichClipboardMeta =
                serde_json::from_str(source.strip_prefix("vpaste-rich:").unwrap()).unwrap();
            for (path, name) in [
                (meta.html_path, "a.html"),
                (meta.rtf_path, "a.rtf"),
                (meta.png_path, "a.png"),
            ] {
                assert_eq!(Path::new(&path), target.join("rich_formats").join(name));
                assert_eq!(fs::read(path).unwrap(), name.as_bytes());
            }
            assert_eq!(content, text);
            assert_eq!(preview, text);
            let source: String = db
                .query_row(
                    &format!("select source from {table} where hash='rich-1'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let meta: clipboard::RichClipboardMeta =
                serde_json::from_str(source.strip_prefix("vpaste-rich:").unwrap()).unwrap();
            assert_eq!(meta.html_path, format!("{old}-external{separator}a.html"));
            assert_eq!(meta.rtf_path, old_path("rich_formats/missing.rtf"));
            assert_eq!(meta.png_path, old_path("rich_formats/../outside.png"));
        }
    }
}

#[test]
fn rich_import_preserves_unknown_fields_and_unpackaged_paths() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    fs::create_dir_all(target.join("rich_formats")).unwrap();
    fs::write(target.join("rich_formats/existing.html"), b"existing").unwrap();
    let source = r#"vpaste-rich:{"version":1,"html_path":"C:\\old\\rich_formats\\existing.html","rtf_path":"D:\\external.rtf","png_path":"","extra":"C:\\old\\do not change"}"#;
    let result = relocate_imported_rich_source(
        source.to_string(),
        root.path().to_str().unwrap(),
        r"C:\old",
        target.to_str().unwrap(),
    );
    let before: serde_json::Value =
        serde_json::from_str(source.strip_prefix("vpaste-rich:").unwrap()).unwrap();
    let after: serde_json::Value =
        serde_json::from_str(result.strip_prefix("vpaste-rich:").unwrap()).unwrap();
    assert_eq!(before, after);
    let invalid = "vpaste-rich:not-json";
    assert_eq!(
        relocate_imported_rich_source(invalid.to_string(), "", r"C:\old", "new"),
        invalid
    );
}

#[test]
fn ordinary_image_and_textfile_import_paths_still_relocate() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let db = rusqlite::Connection::open(source.join("vpaste.db")).unwrap();
    clipboard::db::init_schema(&db).unwrap();
    for kind in ["Image", "TextFile"] {
        db.execute("insert into clipboard(hash,time,content,preview_content,item_type,source) values(?1,1,'/old/data/item','preview',?1,'')", [kind]).unwrap();
    }
    drop(db);
    assert_eq!(
        merge_clipboard_database(source.to_str().unwrap(), target.to_str().unwrap(), "/old")
            .unwrap(),
        (2, 0)
    );
    let db = rusqlite::Connection::open(target.join("vpaste.db")).unwrap();
    for kind in ["Image", "TextFile"] {
        let content: String = db
            .query_row(
                "select content from clipboard where hash=?1",
                [kind],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(Path::new(&content), target.join("data/item"));
    }
}
