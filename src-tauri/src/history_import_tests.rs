use super::*;

use base64::Engine as _;
use sha2::{Digest, Sha256};

fn persisted_rich_image_roundtrip(inline: bool, copy_all_files: bool) -> usize {
    let _guard = TEST_APP_DATA_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    let runtime = workspace.path().join("runtime");
    let source = workspace.path().join("source");
    let target = workspace.path().join("target");
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir_all(&target).unwrap();
    *GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(runtime.to_string_lossy().into_owned());
    config::save(config::Config {
        storage_dir: source.to_string_lossy().into_owned(),
        ..Default::default()
    });
    ensure_history_storage_dirs().unwrap();
    clipboard::db::init();
    let picture = workspace.path().join("word-temporary-image.png");
    image::RgbImage::from_pixel(8, 8, image::Rgb([50, 120, 210]))
        .save(&picture)
        .unwrap();
    let image_src = if inline {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(fs::read(&picture).unwrap())
        )
    } else {
        reqwest::Url::from_file_path(&picture).unwrap().to_string()
    };
    let hash = clipboard::capture_rich_text_from_app(
        "audit rich record".into(),
        Some(format!("<p>audit rich record<img src=\"{image_src}\"></p>").into_bytes()),
        None,
        None,
        "synthetic-audit",
        "",
        false,
    )
    .unwrap();
    let before = clipboard::rich_render_for_hash(&hash).unwrap();
    assert_eq!(
        before.resources.len(),
        1,
        "test setup must persist an actual image"
    );
    assert!(Path::new(&before.resources[0].asset_path).is_file());
    fs::remove_file(&picture).unwrap();
    assert_eq!(
        clipboard::rich_render_for_hash(&hash)
            .unwrap()
            .resources
            .len(),
        1,
        "the source history must still display the image after the temporary source is gone"
    );

    let mut archived_assets = false;
    if copy_all_files {
        let _: (i64, i64, i64) = clipboard::db::db()
            .query_row("PRAGMA wal_checkpoint(full)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        for directory in ["data", "rich_formats", "rich_preview_assets"] {
            copy_history_dir_contents_recursive(&source.join(directory), &target.join(directory))
                .unwrap();
        }
        assert!(target.join("rich_preview_assets").is_dir());
        assert_eq!(
            merge_clipboard_database(
                source.to_str().unwrap(),
                target.to_str().unwrap(),
                source.to_str().unwrap()
            )
            .unwrap(),
            (1, 0, 3)
        );
    } else {
        let archive = workspace.path().join("history.vpaste");
        export_history_archive_impl(None, archive.to_string_lossy().into_owned()).unwrap();
        let mut reader = File::open(&archive).unwrap();
        let (_, entries) = read_history_archive_header(&mut reader).unwrap();
        for _ in 0..entries {
            let (name, size) = read_history_archive_entry_header(&mut reader).unwrap();
            archived_assets |= name.starts_with("rich_preview_assets/");
            reader.seek(SeekFrom::Current(size as i64)).unwrap();
        }
        let mut progress =
            HistoryArchiveProgressState::new(None, "import", HistoryArchiveTotals::empty());
        let (extracted, old_root) = prepare_history_import(
            archive.to_str().unwrap(),
            target.to_str().unwrap(),
            &mut progress,
        )
        .unwrap();
        for directory in HISTORY_IMPORT_COPY_DIRS {
            copy_history_dir_contents_recursive(
                &extracted.path().join(directory),
                &target.join(directory),
            )
            .unwrap();
        }
        assert_eq!(
            merge_clipboard_database(
                extracted.path().to_str().unwrap(),
                target.to_str().unwrap(),
                &old_root
            )
            .unwrap(),
            (1, 0, if inline { 2 } else { 3 })
        );
        let old_directory = Path::new(&before.resources[0].asset_path)
            .parent()
            .unwrap()
            .file_name()
            .unwrap();
        assert!(
            !target
                .join("rich_preview_assets")
                .join(old_directory)
                .exists(),
            "import must not leave an unreferenced old-path image directory"
        );
    }
    config::save(config::Config {
        storage_dir: target.to_string_lossy().into_owned(),
        ..Default::default()
    });
    clipboard::db::init();
    let after = clipboard::rich_render_for_hash(&hash).unwrap();
    println!("inline={inline} copy_all_files={copy_all_files} before_images=1 archive_has_rich_assets={archived_assets} after_images={} retained_text={}", after.resources.len(), after.html.contains("audit rich record"));
    let count = after.resources.len();
    if let Some(resource) = after.resources.first() {
        assert_eq!(
            fs::read(&resource.asset_path).unwrap(),
            fs::read(&before.resources[0].asset_path).unwrap()
        );
    }
    assert!(after.html.contains("audit rich record"));
    config::save(config::Config::default());
    count
}

#[test]
fn inline_image_archive_roundtrip_control() {
    assert_eq!(persisted_rich_image_roundtrip(true, false), 1);
}

#[test]
fn local_image_archive_roundtrip_retains_persisted_picture() {
    assert_eq!(
        persisted_rich_image_roundtrip(false, false),
        1,
        "export/import lost the only persisted picture after its temporary source was removed"
    );
}

#[test]
fn local_image_relocation_with_all_asset_files_retains_picture() {
    assert_eq!(
        persisted_rich_image_roundtrip(false, true),
        1,
        "copying every asset still loses lookup when the rich-source absolute path changes"
    );
}

#[test]
fn rich_images_rebind_windows_and_macos_sources_without_following_manifest_paths() {
    let _guard = TEST_APP_DATA_LOCK.lock().unwrap();
    for old in [r"C:\Users\old\History", "/Users/old/History"] {
        let workspace = tempfile::tempdir().unwrap();
        let extracted = workspace.path().join("extracted");
        let target = workspace.path().join("target");
        fs::create_dir_all(extracted.join("rich_formats")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(workspace.path().join("runtime")).unwrap();
        *GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(
            workspace
                .path()
                .join("runtime")
                .to_string_lossy()
                .into_owned(),
        );
        config::save(config::Config {
            storage_dir: extracted.to_string_lossy().into_owned(),
            ..Default::default()
        });
        let separator = if old.contains('\\') { "\\" } else { "/" };
        let old_path = format!("{old}{separator}rich_formats{separator}picture.html");
        let picture = workspace.path().join("temporary.png");
        image::RgbImage::from_pixel(8, 8, image::Rgb([50, 120, 210]))
            .save(&picture)
            .unwrap();
        let picture_bytes = fs::read(&picture).unwrap();
        let temporary_url = reqwest::Url::from_file_path(&picture).unwrap().to_string();
        let url = if old.contains('\\') {
            "file:///C:/Users/old/AppData/Local/Temp/vpaste-test-picture.png"
        } else {
            "file:///var/folders/vpaste-test-picture.png"
        };
        let html = format!("<p>Imported picture<img src=\"{url}\"></p>");
        fs::write(extracted.join("rich_formats/picture.html"), &html).unwrap();
        let mut images = rich_card_assets::Images::new(&old_path);
        let token = images.resolve(&temporary_url).unwrap();
        let mut render = images
            .finish(format!("<p>Imported picture<img src=\"{token}\"></p>"))
            .unwrap();
        let asset_dir = Path::new(&render.resources[0].asset_path).parent().unwrap();
        let index_name =
            |value: &str| format!("source-{}", hex::encode(Sha256::digest(value.as_bytes())));
        // Model an archive created on the source OS, whose temporary file URL
        // might not even be convertible to a filesystem path on this OS.
        fs::rename(
            asset_dir.join(index_name(&temporary_url)),
            asset_dir.join(index_name(url)),
        )
        .unwrap();
        // Even a manifest naming an unrelated absolute file must only use the
        // actual packaged attachment, never that absolute path's contents.
        let outside = workspace.path().join(
            Path::new(&render.resources[0].asset_path)
                .file_name()
                .unwrap(),
        );
        fs::write(&outside, b"not the packaged picture").unwrap();
        render.resources[0].asset_path = outside.to_string_lossy().into_owned();
        rich_card_assets::cache_render(&old_path, 0, 0, &render).unwrap();
        fs::remove_file(picture).unwrap();
        let meta = serde_json::json!({"version": 1, "html_path": old_path, "rtf_path": "", "png_path": ""});
        let source = format!("vpaste-rich:{meta}");
        let db = rusqlite::Connection::open(extracted.join("vpaste.db")).unwrap();
        clipboard::db::init_schema(&db).unwrap();
        db.execute("insert into clipboard(hash,time,content,preview_content,item_type,source) values('picture',1,'Imported picture','Imported picture','Text',?1)", [&source]).unwrap();
        db.execute("insert into paste_queue(hash,position,queued_at,time,content,preview_content,item_type,source) values('picture',0,1,1,'Imported picture','Imported picture','Text',?1)", [&source]).unwrap();
        drop(db);
        for name in ["data", "rich_formats", "rich_preview_assets"] {
            copy_history_dir_contents_recursive(&extracted.join(name), &target.join(name)).unwrap();
        }
        assert_eq!(
            merge_clipboard_database(extracted.to_str().unwrap(), target.to_str().unwrap(), old)
                .unwrap(),
            (1, 0, 3)
        );
        config::save(config::Config {
            storage_dir: target.to_string_lossy().into_owned(),
            ..Default::default()
        });
        clipboard::db::init();
        let imported = clipboard::rich_render_for_hash("picture").unwrap();
        assert_eq!(imported.resources.len(), 1);
        let asset = Path::new(&imported.resources[0].asset_path);
        assert!(asset.starts_with(&target));
        assert_eq!(fs::read(asset).unwrap(), picture_bytes);
        // Check the relocated source index too, not just the rebased manifest.
        fs::remove_file(asset.parent().unwrap().join("render.json")).unwrap();
        assert_eq!(
            clipboard::rich_render_for_hash("picture")
                .unwrap()
                .resources
                .len(),
            1
        );
        assert_eq!(
            merge_clipboard_database(extracted.to_str().unwrap(), target.to_str().unwrap(), old)
                .unwrap(),
            (0, 1, 0)
        );
        let queue_source: String = clipboard::db::db()
            .query_row(
                "select source from paste_queue where hash='picture'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let queue_meta: clipboard::RichClipboardMeta =
            serde_json::from_str(queue_source.strip_prefix("vpaste-rich:").unwrap()).unwrap();
        assert!(Path::new(&queue_meta.html_path).starts_with(&target));
        assert_eq!(
            clipboard::rich_render_from_path(&queue_meta.html_path)
                .unwrap()
                .resources
                .len(),
            1
        );
        config::save(config::Config::default());
    }
}

#[test]
fn rich_resource_archive_paths_keep_traversal_restrictions() {
    assert!(validate_archive_entry_name("rich_preview_assets/record/picture.png").is_ok());
    for name in [
        "rich_preview_assets/../outside",
        "rich_preview_assets/record/../../outside",
        "rich_preview_assets\\record\\picture.png",
        "/rich_preview_assets/picture.png",
    ] {
        assert!(
            validate_archive_entry_name(name).is_err(),
            "accepted {name}"
        );
    }
}

#[test]
fn unsupported_import_database_is_rejected_before_creating_destination() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let source_path = source.join("vpaste.db");
    let connection = rusqlite::Connection::open(&source_path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE clipboard(content TEXT);
         INSERT INTO clipboard VALUES('untouched');",
        )
        .unwrap();
    drop(connection);
    let before = fs::read(&source_path).unwrap();
    assert!(merge_clipboard_database(
        source.to_str().unwrap(),
        target.to_str().unwrap(),
        "/source"
    )
    .is_err());
    assert!(!target.join("vpaste.db").exists());
    assert_eq!(fs::read(source_path).unwrap(), before);
}

#[test]
fn managed_import_paths_follow_destination_not_source_separators() {
    assert_eq!(
        rewrite_internal_storage_paths(r"C:\old\data\item".into(), r"C:\old", "/Users/new/history"),
        "/Users/new/history/data/item"
    );
    assert_eq!(
        rewrite_internal_storage_paths("/old/data/item".into(), "/old", r"D:\new"),
        "D:/new/data/item"
    );
    assert_eq!(
        rewrite_internal_storage_paths(r"C:\old\rich_formats\a.html".into(), r"C:\old", "/new"),
        "/new/rich_formats/a.html"
    );
}

#[test]
fn cross_platform_image_and_textfile_merge_preserves_readable_payloads_and_external_files() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(target.join("data")).unwrap();
    fs::write(target.join("data/item"), b"payload").unwrap();
    let db = rusqlite::Connection::open(source.join("vpaste.db")).unwrap();
    clipboard::db::init_schema(&db).unwrap();
    let external = r#"["C:/old/data/user-file.txt"]"#;
    for (position, kind) in ["Image", "TextFile", "File"].into_iter().enumerate() {
        let content = if kind == "File" {
            external
        } else {
            r"C:\old\data\item"
        };
        db.execute("insert into clipboard(hash,time,content,preview_content,item_type,source) values(?1,1,?2,?2,?1,'')", rusqlite::params![kind, content]).unwrap();
        db.execute("insert into paste_queue(hash,position,queued_at,time,content,preview_content,item_type,source) values(?1,?3,1,1,?2,?2,?1,'')", rusqlite::params![kind, content, position]).unwrap();
    }
    drop(db);
    merge_clipboard_database(
        source.to_str().unwrap(),
        target.to_str().unwrap(),
        r"C:\old",
    )
    .unwrap();
    let db = rusqlite::Connection::open(target.join("vpaste.db")).unwrap();
    for table in ["clipboard", "paste_queue"] {
        for kind in ["Image", "TextFile", "File"] {
            let content: String = db
                .query_row(
                    &format!("select content from {table} where hash=?1"),
                    [kind],
                    |row| row.get(0),
                )
                .unwrap();
            if kind == "File" {
                assert_eq!(content, external);
            } else {
                assert_eq!(fs::read(content).unwrap(), b"payload");
            }
        }
    }
}

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
            (1, 0, 0)
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
            (2, 0, 0)
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
    )
    .unwrap()
    .0;
    let before: serde_json::Value =
        serde_json::from_str(source.strip_prefix("vpaste-rich:").unwrap()).unwrap();
    let after: serde_json::Value =
        serde_json::from_str(result.strip_prefix("vpaste-rich:").unwrap()).unwrap();
    assert_eq!(before, after);
    let invalid = "vpaste-rich:not-json";
    assert_eq!(
        relocate_imported_rich_source(invalid.to_string(), "", r"C:\old", "new")
            .unwrap()
            .0,
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
        (2, 0, 0)
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
