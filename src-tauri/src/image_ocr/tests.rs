use super::*;

struct HistoryFixture(tempfile::TempDir);

impl HistoryFixture {
    fn path(&self) -> &std::path::Path {
        self.0.path()
    }
}

impl Drop for HistoryFixture {
    fn drop(&mut self) {
        engine::shutdown_runtime_for_tests();
    }
}

fn seed() -> HistoryFixture {
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().into_owned());
    config::save(config::Config::default());
    clipboard::db::init();
    HistoryFixture(root)
}

fn image(hash: &str) {
    clipboard::db::db().execute(
        "INSERT INTO clipboard(hash,time,content,preview_content,item_type,search_index,source,app_source,app_icon_path,title_color,label)
         VALUES(?1,1,'original-image.png','','Image',1,'original source','Browser','','',0)", [hash],
    ).unwrap();
}

fn job(hash: &str) -> Job {
    let mut connection = clipboard::db::db();
    enqueue(&mut connection, hash, true, false).unwrap();
    take_job(&mut connection, true).unwrap().unwrap()
}

#[test]
fn new_and_old_configurations_enable_automatic_recognition_by_default() {
    assert!(config::Config::default().image_ocr_enabled);
    let mut saved = serde_json::to_value(config::Config::default()).unwrap();
    saved.as_object_mut().unwrap().remove("image_ocr_enabled");
    assert!(
        serde_json::from_value::<config::Config>(saved)
            .unwrap()
            .image_ocr_enabled
    );
}

#[test]
fn existing_images_are_untouched_until_requested_and_disabled_auto_work_is_paused() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("old");
    image("new");
    let mut connection = clipboard::db::db();
    assert!(take_job(&mut connection, true).unwrap().is_none());
    enqueue(&mut connection, "new", false, false).unwrap();
    assert!(take_job(&mut connection, false).unwrap().is_none());
    enqueue(&mut connection, "old", true, false).unwrap();
    assert_eq!(
        take_job(&mut connection, false).unwrap().unwrap().hash,
        "old"
    );
    assert_eq!(
        take_job(&mut connection, true).unwrap().unwrap().hash,
        "new"
    );
}

#[test]
fn opening_a_paused_automatic_job_promotes_it_to_manual_without_duplicating_work() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("image");
    let mut connection = clipboard::db::db();
    enqueue(&mut connection, "image", false, false).unwrap();
    enqueue(&mut connection, "image", true, false).unwrap();
    let first = take_job(&mut connection, false).unwrap().unwrap();
    assert_eq!(
        enqueue(&mut connection, "image", true, true)
            .unwrap()
            .status,
        "running"
    );
    assert!(take_job(&mut connection, true).unwrap().is_none());
    finish(&first, Ok("recognized".into())).unwrap();
}

#[test]
fn ocr_is_searchable_in_all_and_image_filters_and_survives_rebuild_without_changing_original() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("image");
    clipboard::set_favorite("image", true).unwrap();
    let tag = clipboard::create_tag("Keep").unwrap();
    clipboard::assign_tag("image", tag.id).unwrap();
    clipboard::rebuild_search_index().unwrap();
    let job = job("image");
    assert!(finish(&job, Ok("发票编号 invoice 2048".into())).unwrap());
    let current = record(&clipboard::db::db(), "image").unwrap();
    assert_eq!(current.status, "complete");
    for filter in ["__all", r#"__filter:{"item_type":"Image"}"#] {
        let results = clipboard::search("invoice", 0, 0, 36, filter).unwrap();
        assert_eq!(results.list.len(), 1);
        assert_eq!(results.list[0].item_type, clipboard::item::ItemType::Image);
        assert_eq!(results.list[0].content, "original-image.png");
        assert_eq!(results.list[0].time, 1);
        assert_eq!(results.list[0].label, 1);
        assert_eq!(results.list[0].tags[0].name, "Keep");
    }
    assert!(
        clipboard::search("invoice", 0, 0, 36, r#"__filter:{"item_type":"Text"}"#)
            .unwrap()
            .list
            .is_empty()
    );
    clipboard::rebuild_search_index().unwrap();
    assert_eq!(
        clipboard::search("发票", 0, 0, 36, "__all")
            .unwrap()
            .list
            .len(),
        1
    );
    assert_eq!(
        clipboard::db::db()
            .query_row("SELECT count(*) FROM clipboard", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn copying_an_already_recognized_image_reuses_cache_and_keeps_ocr_in_search() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = seed();
    let path = root.path().join("sample.png");
    image::RgbaImage::from_pixel(100, 60, image::Rgba([255, 255, 255, 255]))
        .save(&path)
        .unwrap();
    let bytes = std::fs::read(path).unwrap();
    let hash =
        clipboard::capture_image_with_text_and_app(&bytes, "", "Browser", "", false).unwrap();
    clipboard::rebuild_search_index().unwrap();
    let job = job(&hash);
    assert!(finish(&job, Ok("cached needle".into())).unwrap());
    assert_eq!(
        clipboard::capture_image_with_text_and_app(&bytes, "", "Browser", "", false).unwrap(),
        hash
    );
    assert_eq!(
        record(&clipboard::db::db(), &hash).unwrap().status,
        "complete"
    );
    assert!(take_job(&mut clipboard::db::db(), true).unwrap().is_none());
    assert_eq!(
        clipboard::search("cached needle", 0, 0, 36, "__all")
            .unwrap()
            .list
            .len(),
        1
    );
}

#[test]
fn capture_with_automatic_recognition_disabled_still_saves_images_and_allows_manual_ocr() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = seed();
    config::update(|config| config.image_ocr_enabled = false);
    let path = root.path().join("sample.png");
    image::RgbaImage::from_pixel(100, 60, image::Rgba([255, 255, 255, 255]))
        .save(&path)
        .unwrap();
    let bytes = std::fs::read(path).unwrap();
    let hash =
        clipboard::capture_image_with_text_and_app(&bytes, "", "Browser", "", false).unwrap();
    let mut connection = clipboard::db::db();
    assert_eq!(record(&connection, &hash).unwrap().status, "unrecognized");
    assert!(take_job(&mut connection, true).unwrap().is_none());
    enqueue(&mut connection, &hash, true, false).unwrap();
    assert_eq!(
        take_job(&mut connection, false).unwrap().unwrap().hash,
        hash
    );
    config::save(config::Config::default());
}

#[test]
fn deletion_during_recognition_cannot_resurrect_ocr_or_a_recreated_image() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("image");
    let old_job = job("image");
    clipboard::delete_by_hash("image").unwrap();
    assert_eq!(
        clipboard::db::db()
            .query_row("SELECT count(*) FROM image_ocr", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    image("image");
    let new_job = job("image");
    assert!(!finish(&old_job, Ok("stale".into())).unwrap());
    assert!(finish(&new_job, Ok("current".into())).unwrap());
    assert_eq!(cached_text("image"), "current");
}

#[test]
fn retry_updates_search_and_failure_preserves_previous_text_for_copy_and_search() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("image");
    clipboard::rebuild_search_index().unwrap();
    finish(&job("image"), Ok("before needle".into())).unwrap();
    let mut connection = clipboard::db::db();
    enqueue(&mut connection, "image", true, true).unwrap();
    let retry = take_job(&mut connection, true).unwrap().unwrap();
    drop(connection);
    finish(&retry, Ok("after replacement".into())).unwrap();
    assert!(clipboard::search("before", 0, 0, 36, "__all")
        .unwrap()
        .list
        .is_empty());
    assert_eq!(
        clipboard::search("replacement", 0, 0, 36, "__all")
            .unwrap()
            .list
            .len(),
        1
    );
    let mut connection = clipboard::db::db();
    enqueue(&mut connection, "image", true, true).unwrap();
    let retry = take_job(&mut connection, true).unwrap().unwrap();
    drop(connection);
    finish(&retry, Err(OcrError::LanguageUnavailable)).unwrap();
    let current = record(&clipboard::db::db(), "image").unwrap();
    assert_eq!(current.error, Some(OcrError::LanguageUnavailable));
    assert_eq!(current.text, "after replacement");
}

#[test]
fn empty_results_and_errors_are_cached_without_automatic_retry_loops() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("empty");
    image("failed");
    finish(&job("empty"), Ok(" \n".into())).unwrap();
    finish(&job("failed"), Err(OcrError::Timeout)).unwrap();
    let mut connection = clipboard::db::db();
    assert_eq!(
        enqueue(&mut connection, "empty", false, false)
            .unwrap()
            .status,
        "empty"
    );
    assert_eq!(
        enqueue(&mut connection, "failed", false, false)
            .unwrap()
            .error,
        Some(OcrError::Timeout)
    );
    assert!(take_job(&mut connection, true).unwrap().is_none());
}

#[test]
fn storage_switch_discards_inflight_results_and_clear_images_removes_ocr() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = seed();
    image("image");
    let old_job = job("image");
    let other = root.path().join("other");
    std::fs::create_dir(&other).unwrap();
    config::update(|config| config.storage_dir = other.to_string_lossy().into_owned());
    clipboard::db::init();
    image("image");
    let new_job = job("image");
    assert!(!finish(&old_job, Ok("wrong storage".into())).unwrap());
    assert!(finish(&new_job, Ok("right storage".into())).unwrap());
    clipboard::db::clear_images().unwrap();
    assert_eq!(
        clipboard::db::db()
            .query_row("SELECT count(*) FROM image_ocr", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    config::save(config::Config::default());
    resume_requested_jobs();
    assert_eq!(
        record(&clipboard::db::db(), "image").unwrap().status,
        "pending"
    );
    let resumed = take_job(&mut clipboard::db::db(), true).unwrap().unwrap();
    assert!(finish(&resumed, Ok("resumed original storage".into())).unwrap());
    assert_eq!(cached_text("image"), "resumed original storage");
}

#[test]
fn text_items_and_unknown_hashes_cannot_be_submitted_for_image_recognition() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    clipboard::db::db()
        .execute(
            "INSERT INTO clipboard(hash,time,content,item_type) VALUES('text',1,'body','Text')",
            [],
        )
        .unwrap();
    let mut connection = clipboard::db::db();
    assert!(enqueue(&mut connection, "text", true, false).is_err());
    assert!(enqueue(&mut connection, "missing", true, false).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_ocr_refreshes_legacy_results_lazily_and_reuses_corrected_results() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("legacy");
    image("untouched");
    let mut connection = clipboard::db::db();
    connection.execute(
        "INSERT INTO image_ocr(hash,clipboard_id,status,text,manual,requested_at,request_id)
         SELECT hash,id,'complete','old fast-model output',0,1,1 FROM clipboard WHERE hash='legacy'",
        [],
    ).unwrap();
    assert_eq!(
        record(&connection, "legacy").unwrap().status,
        "unrecognized"
    );
    let requested = enqueue(&mut connection, "legacy", true, false).unwrap();
    assert_eq!(requested.status, "pending");
    assert!(requested.text.is_empty());
    let corrected = take_job(&mut connection, false).unwrap().unwrap();
    drop(connection);
    assert!(finish(&corrected, Ok("图片文字识别 Invoice 2048".into())).unwrap());
    let mut connection = clipboard::db::db();
    assert_eq!(
        enqueue(&mut connection, "legacy", true, false)
            .unwrap()
            .status,
        "complete"
    );
    assert!(take_job(&mut connection, true).unwrap().is_none());
    assert_eq!(
        record(&connection, "untouched").unwrap().status,
        "unrecognized"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM image_ocr", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn macos_ocr_cache_version_migration_preserves_existing_rows_and_is_idempotent() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(
        "CREATE TABLE clipboard(id INTEGER PRIMARY KEY,hash TEXT);
         CREATE TABLE image_ocr(hash TEXT PRIMARY KEY NOT NULL,clipboard_id INTEGER NOT NULL,
         status TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',error TEXT,
         manual INTEGER NOT NULL DEFAULT 0,requested_at INTEGER NOT NULL,request_id INTEGER NOT NULL) STRICT;
         INSERT INTO image_ocr VALUES('legacy',1,'complete','original cache',NULL,0,1,1);",
    ).unwrap();
    init_schema(&connection).unwrap();
    init_schema(&connection).unwrap();
    let row = connection
        .query_row(
            "SELECT text,engine_version,status FROM image_ocr WHERE hash='legacy'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(row, ("original cache".into(), 0, "complete".into()));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_ocr_resumes_pending_legacy_jobs_with_the_new_engine_version() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let _root = seed();
    image("pending");
    let mut connection = clipboard::db::db();
    connection
        .execute(
            "INSERT INTO image_ocr(hash,clipboard_id,status,text,manual,requested_at,request_id)
         SELECT hash,id,'pending','legacy text',0,1,1 FROM clipboard WHERE hash='pending'",
            [],
        )
        .unwrap();
    let pending = take_job(&mut connection, true).unwrap().unwrap();
    let running = record(&connection, "pending").unwrap();
    assert_eq!(running.status, "running");
    assert!(running.text.is_empty());
    drop(connection);
    assert!(finish(&pending, Ok("重新识别完成".into())).unwrap());
    assert_eq!(
        record(&clipboard::db::db(), "pending").unwrap().text,
        "重新识别完成"
    );
}
