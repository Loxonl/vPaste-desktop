use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use lazy_static::lazy_static;
use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::clipboard;
use crate::clipboard::db::db;
use crate::clipboard::item::Item;
use crate::clipboard::{RichClipboardMeta, StoredItem};
use crate::secure_store;

pub const CAPACITY: usize = 100;
pub const UNDO_WINDOW_MS: u64 = 5_000;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
static REVISION: AtomicU64 = AtomicU64::new(0);
static ACTIVATION_EPOCH: AtomicU64 = AtomicU64::new(0);

lazy_static! {
    static ref LAST_ERROR: Mutex<Option<PasteQueueError>> = Mutex::new(None);
    static ref UNDO: Mutex<Option<UndoEntry>> = Mutex::new(None);
}

#[derive(Clone, Debug, Serialize)]
pub struct PasteQueueError {
    pub hash: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug)]
struct QueueRecord {
    stored: StoredItem,
    queued_at: u64,
}

#[derive(Clone, Debug)]
struct UndoEntry {
    record: QueueRecord,
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteQueueState {
    pub active: bool,
    pub busy: bool,
    pub capacity: usize,
    pub items: Vec<Item>,
    pub error: Option<PasteQueueError>,
    pub undo_hash: Option<String>,
    pub undo_expires_at: Option<u64>,
    pub revision: u64,
}

const QUEUE_RECORD_COLUMNS: &str = "
    0 AS id,
    item_type,
    hash,
    content,
    preview_content,
    source,
    app_source,
    app_icon_path,
    title_color,
    time,
    search_index,
    label,
    queued_at
";

fn now_ms() -> u64 {
    clipboard::current_timestamp_millis()
}

pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

pub fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
    ACTIVATION_EPOCH.fetch_add(1, Ordering::SeqCst);
    if !active {
        BUSY.store(false, Ordering::SeqCst);
        clear_undo();
    }
    bump_revision();
}

pub fn activation_epoch() -> u64 {
    ACTIVATION_EPOCH.load(Ordering::SeqCst)
}

pub fn set_busy(busy: bool) {
    BUSY.store(busy, Ordering::SeqCst);
    bump_revision();
}

pub fn set_error(hash: Option<String>, message: impl Into<String>) {
    *LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(PasteQueueError {
        hash,
        message: message.into(),
    });
    bump_revision();
}

pub fn clear_error() {
    *LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn bump_revision() -> u64 {
    REVISION.fetch_add(1, Ordering::SeqCst) + 1
}

fn read_queue_record(row: &Row<'_>) -> rusqlite::Result<QueueRecord> {
    Ok(QueueRecord {
        stored: clipboard::read_stored_item(row)?,
        queued_at: row.get("queued_at")?,
    })
}

fn ordered_records_with_conn(conn: &rusqlite::Connection) -> Result<Vec<QueueRecord>, String> {
    let sql = format!("SELECT {QUEUE_RECORD_COLUMNS} FROM paste_queue ORDER BY position ASC");
    let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let records = statement
        .query_map([], read_queue_record)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(records)
}

fn record_with_conn(
    conn: &rusqlite::Connection,
    hash: &str,
) -> Result<Option<QueueRecord>, String> {
    let sql = format!("SELECT {QUEUE_RECORD_COLUMNS} FROM paste_queue WHERE hash = ?1");
    conn.query_row(&sql, [hash], read_queue_record)
        .optional()
        .map_err(|err| err.to_string())
}

fn history_record_with_conn(
    conn: &rusqlite::Connection,
    hash: &str,
) -> Result<Option<QueueRecord>, String> {
    conn.query_row(
        "SELECT * FROM clipboard WHERE hash = ?1",
        [hash],
        clipboard::read_stored_item,
    )
    .optional()
    .map(|stored| {
        stored.map(|stored| QueueRecord {
            stored,
            queued_at: now_ms(),
        })
    })
    .map_err(|err| err.to_string())
}

fn record_from_capture(item: &Item, source: &str) -> QueueRecord {
    QueueRecord {
        stored: StoredItem {
            id: 0,
            item_type: item.item_type.to_string(),
            hash: item.hash.clone(),
            content: secure_store::encrypt_text(&item.content),
            preview_content: secure_store::encrypt_text(&item.preview_content),
            source: secure_store::encrypt_text(source),
            app_source: item.app_source.clone(),
            app_icon_path: item.app_icon_path.clone(),
            title_color: item.title_color.clone(),
            time: item.time,
            search_index: item.search_index,
            label: item.label,
        },
        queued_at: now_ms(),
    }
}

fn insert_record(
    transaction: &Transaction<'_>,
    record: &QueueRecord,
    position: usize,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO paste_queue(
                hash, position, queued_at, time, content, preview_content, item_type,
                search_index, source, app_source, app_icon_path, title_color, label
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
             )",
            params![
                record.stored.hash,
                position as i64,
                record.queued_at,
                record.stored.time,
                record.stored.content,
                record.stored.preview_content,
                record.stored.item_type,
                record.stored.search_index,
                record.stored.source,
                record.stored.app_source,
                record.stored.app_icon_path,
                record.stored.title_color,
                record.stored.label,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn rewrite_records(transaction: &Transaction<'_>, records: &[QueueRecord]) -> Result<(), String> {
    transaction
        .execute("DELETE FROM paste_queue", [])
        .map_err(|err| err.to_string())?;
    for (position, record) in records.iter().enumerate() {
        insert_record(transaction, record, position)?;
    }
    Ok(())
}

fn normalized_requested_hashes(hashes: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    hashes
        .iter()
        .filter(|hash| seen.insert((*hash).clone()))
        .cloned()
        .collect()
}

fn merged_queue_order(current: &[String], requested: &[String]) -> Result<Vec<String>, String> {
    let requested = normalized_requested_hashes(requested);
    let current_set = current.iter().cloned().collect::<HashSet<_>>();
    let requested_set = requested.iter().cloned().collect::<HashSet<_>>();
    let new_count = requested
        .iter()
        .filter(|hash| !current_set.contains(*hash))
        .count();
    if current.len().saturating_add(new_count) > CAPACITY {
        return Err(format!("粘贴队列最多保留 {CAPACITY} 项"));
    }
    let mut next = requested
        .iter()
        .filter(|hash| current_set.contains(*hash))
        .cloned()
        .collect::<Vec<_>>();
    next.extend(
        current
            .iter()
            .filter(|hash| !requested_set.contains(*hash))
            .cloned(),
    );
    next.extend(
        requested
            .into_iter()
            .filter(|hash| !current_set.contains(hash)),
    );
    Ok(next)
}

fn restored_undo_order(current: &[String], hash: &str) -> Result<Vec<String>, String> {
    let mut next = current
        .iter()
        .filter(|candidate| candidate.as_str() != hash)
        .cloned()
        .collect::<Vec<_>>();
    if next.len() >= CAPACITY {
        return Err(format!("粘贴队列最多保留 {CAPACITY} 项"));
    }
    next.insert(0, hash.to_string());
    Ok(next)
}

fn reorder_records(records: Vec<QueueRecord>, hashes: &[String]) -> Vec<QueueRecord> {
    let mut by_hash = records
        .into_iter()
        .map(|record| (record.stored.hash.clone(), record))
        .collect::<HashMap<_, _>>();
    hashes
        .iter()
        .filter_map(|hash| by_hash.remove(hash))
        .collect()
}

pub fn ordered_hashes() -> Result<Vec<String>, String> {
    Ok(ordered_records_with_conn(&db())?
        .into_iter()
        .map(|record| record.stored.hash)
        .collect())
}

pub fn can_accept(hash: &str) -> Result<bool, String> {
    let conn = db();
    if record_with_conn(&conn, hash)?.is_some() {
        return Ok(true);
    }
    let count = conn
        .query_row("SELECT count(*) FROM paste_queue", [], |row| {
            row.get::<_, usize>(0)
        })
        .map_err(|err| err.to_string())?;
    Ok(count < CAPACITY)
}

pub fn add_items(hashes: &[String]) -> Result<(), String> {
    let requested = normalized_requested_hashes(hashes);
    if requested.is_empty() {
        return Ok(());
    }
    let mut conn = db();
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    let current = ordered_records_with_conn(&transaction)?;
    let current_hashes = current
        .iter()
        .map(|record| record.stored.hash.clone())
        .collect::<Vec<_>>();
    let next_hashes = merged_queue_order(&current_hashes, &requested)?;
    let current_set = current_hashes.iter().cloned().collect::<HashSet<_>>();
    let mut records = current;
    for hash in requested
        .iter()
        .filter(|hash| !current_set.contains(hash.as_str()))
    {
        let record = history_record_with_conn(&transaction, hash)?
            .ok_or_else(|| format!("粘贴项不存在：{hash}"))?;
        records.push(record);
    }
    let next = reorder_records(records, &next_hashes);
    rewrite_records(&transaction, &next)?;
    transaction.commit().map_err(|err| err.to_string())?;
    clear_error();
    bump_revision();
    Ok(())
}

pub fn capture_item(item: &Item, source: &str) -> Result<(), String> {
    let incoming = record_from_capture(item, source);
    let result = (|| {
        if !is_active() {
            return Err("粘贴队列未开启".to_string());
        }
        let mut conn = db();
        let transaction = conn.transaction().map_err(|err| err.to_string())?;
        let current = ordered_records_with_conn(&transaction)?;
        let replaced = current
            .iter()
            .find(|record| record.stored.hash == item.hash)
            .cloned();
        let current_hashes = current
            .iter()
            .map(|record| record.stored.hash.clone())
            .collect::<Vec<_>>();
        let next_hashes = merged_queue_order(&current_hashes, &[item.hash.clone()])?;
        let mut records = current
            .into_iter()
            .filter(|record| record.stored.hash != item.hash)
            .collect::<Vec<_>>();
        records.push(incoming.clone());
        let next = reorder_records(records, &next_hashes);
        rewrite_records(&transaction, &next)?;
        transaction.commit().map_err(|err| err.to_string())?;
        if let Some(replaced) = replaced {
            cleanup_records(&[replaced]);
        }
        clear_error();
        bump_revision();
        Ok(())
    })();
    if result.is_err() {
        cleanup_records(&[incoming]);
    }
    result
}

fn record_paths(record: &QueueRecord) -> HashSet<std::path::PathBuf> {
    clipboard::internal_paths_for_stored_item(&record.stored)
}

fn cleanup_records(records: &[QueueRecord]) {
    let paths = records
        .iter()
        .flat_map(record_paths)
        .collect::<HashSet<_>>();
    clipboard::delete_unreferenced_internal_paths(paths);
}

pub fn remove_item(hash: &str) -> Result<(), String> {
    let mut conn = db();
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    let records = ordered_records_with_conn(&transaction)?;
    let removed = records
        .iter()
        .find(|record| record.stored.hash == hash)
        .cloned();
    let remaining = records
        .into_iter()
        .filter(|record| record.stored.hash != hash)
        .collect::<Vec<_>>();
    rewrite_records(&transaction, &remaining)?;
    transaction.commit().map_err(|err| err.to_string())?;
    if let Some(record) = removed {
        cleanup_records(&[record]);
    }
    clear_error();
    bump_revision();
    Ok(())
}

pub fn clear() -> Result<(), String> {
    let mut conn = db();
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    let records = ordered_records_with_conn(&transaction)?;
    transaction
        .execute("DELETE FROM paste_queue", [])
        .map_err(|err| err.to_string())?;
    transaction.commit().map_err(|err| err.to_string())?;
    clear_error();
    clear_undo();
    cleanup_records(&records);
    bump_revision();
    Ok(())
}

pub fn reverse() -> Result<(), String> {
    let mut conn = db();
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    let mut records = ordered_records_with_conn(&transaction)?;
    records.reverse();
    rewrite_records(&transaction, &records)?;
    transaction.commit().map_err(|err| err.to_string())?;
    clear_error();
    bump_revision();
    Ok(())
}

pub fn reorder(hashes: &[String]) -> Result<(), String> {
    let requested = normalized_requested_hashes(hashes);
    let mut conn = db();
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    let current = ordered_records_with_conn(&transaction)?;
    let current_hashes = current
        .iter()
        .map(|record| record.stored.hash.clone())
        .collect::<Vec<_>>();
    if requested.len() != current_hashes.len()
        || requested.iter().cloned().collect::<HashSet<_>>()
            != current_hashes.iter().cloned().collect::<HashSet<_>>()
    {
        return Err("队列顺序已变化，请刷新后重试".to_string());
    }
    let next = reorder_records(current, &requested);
    rewrite_records(&transaction, &next)?;
    transaction.commit().map_err(|err| err.to_string())?;
    clear_error();
    bump_revision();
    Ok(())
}

pub fn paste_target(requested_hash: Option<&str>) -> Result<Option<String>, String> {
    let hashes = ordered_hashes()?;
    match requested_hash {
        Some(hash) if hashes.iter().any(|candidate| candidate == hash) => {
            Ok(Some(hash.to_string()))
        }
        Some(_) => Err("该项目已不在粘贴队列中".to_string()),
        None => Ok(hashes.first().cloned()),
    }
}

pub fn item(hash: &str) -> Result<Option<Item>, String> {
    Ok(record_with_conn(&db(), hash)?.map(|record| clipboard::materialize_item(record.stored)))
}

pub fn plain_text_content(hash: &str) -> Result<String, String> {
    let record = record_with_conn(&db(), hash)?.ok_or_else(|| "粘贴项不存在".to_string())?;
    clipboard::plain_text_from_stored_item(&record.stored)
}

pub fn rich_clipboard_meta(hash: &str) -> Option<RichClipboardMeta> {
    let record = record_with_conn(&db(), hash).ok().flatten()?;
    clipboard::rich_clipboard_meta_from_stored_source(&record.stored.source)
}

pub fn touch(hash: &str) -> Result<usize, String> {
    db().execute(
        "UPDATE paste_queue SET time = ?1 WHERE hash = ?2",
        params![now_ms(), hash],
    )
    .map_err(|err| err.to_string())
}

fn set_undo(record: QueueRecord) {
    let replacement_paths = record_paths(&record);
    let previous = UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .replace(UndoEntry {
            record,
            expires_at: now_ms().saturating_add(UNDO_WINDOW_MS),
        });
    if let Some(previous) = previous {
        let stale_paths = record_paths(&previous.record)
            .difference(&replacement_paths)
            .cloned()
            .collect();
        clipboard::delete_unreferenced_internal_paths(stale_paths);
    }
    bump_revision();
}

pub fn clear_undo() {
    let removed = UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(undo) = removed {
        cleanup_records(&[undo.record]);
    }
}

fn live_undo() -> Option<UndoEntry> {
    let expired = {
        let guard = UNDO.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .is_some_and(|undo| undo.expires_at <= now_ms())
    };
    if expired {
        clear_undo();
    }
    UNDO.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

pub fn consume(hash: &str) -> Result<(), String> {
    let mut conn = db();
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    let records = ordered_records_with_conn(&transaction)?;
    let record = records
        .iter()
        .find(|record| record.stored.hash == hash)
        .cloned()
        .ok_or_else(|| "该项目已不在粘贴队列中".to_string())?;
    let remaining = records
        .into_iter()
        .filter(|record| record.stored.hash != hash)
        .collect::<Vec<_>>();
    rewrite_records(&transaction, &remaining)?;
    transaction.commit().map_err(|err| err.to_string())?;
    set_undo(record);
    clear_error();
    Ok(())
}

pub fn undo_consume() -> Result<bool, String> {
    let Some(undo) = live_undo() else {
        return Ok(false);
    };
    let mut conn = db();
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    let current = ordered_records_with_conn(&transaction)?;
    let current_hashes = current
        .iter()
        .map(|record| record.stored.hash.clone())
        .collect::<Vec<_>>();
    let hashes = restored_undo_order(&current_hashes, &undo.record.stored.hash)?;
    let mut records = current
        .into_iter()
        .filter(|record| record.stored.hash != undo.record.stored.hash)
        .collect::<Vec<_>>();
    records.push(undo.record.clone());
    let next = reorder_records(records, &hashes);
    rewrite_records(&transaction, &next)?;
    transaction.commit().map_err(|err| err.to_string())?;
    clear_error();
    UNDO.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    bump_revision();
    Ok(true)
}

pub fn state() -> Result<PasteQueueState, String> {
    let items = ordered_records_with_conn(&db())?
        .into_iter()
        .map(|record| clipboard::materialize_item(record.stored))
        .collect();
    let undo = live_undo();
    Ok(PasteQueueState {
        active: is_active(),
        busy: BUSY.load(Ordering::SeqCst),
        capacity: CAPACITY,
        items,
        error: LAST_ERROR
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
        undo_hash: undo.as_ref().map(|entry| entry.record.stored.hash.clone()),
        undo_expires_at: undo.map(|entry| entry.expires_at),
        revision: REVISION.load(Ordering::SeqCst),
    })
}

pub fn emit_state(app: &AppHandle) {
    match state() {
        Ok(state) => {
            if let Ok(payload) = serde_json::to_value(state) {
                let _ = app.emit("paste-queue-state-changed", payload);
            }
        }
        Err(err) => log::error!("failed to publish paste queue state: {err}"),
    }
}

pub fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pasteQueue") {
        let _ = window.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_test_database(test: impl FnOnce()) {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let previous = {
            let mut data_dir = crate::GLOBAL_APP_DATA_DIR.lock().unwrap();
            data_dir.replace(root.path().to_string_lossy().to_string())
        };
        crate::clipboard::db::init();
        clear().unwrap();
        set_active(false);

        test();

        clear().unwrap();
        set_active(false);
        let mut data_dir = crate::GLOBAL_APP_DATA_DIR.lock().unwrap();
        *data_dir = previous;
    }

    fn seed_history(hashes: &[String]) {
        let mut conn = db();
        let transaction = conn.transaction().unwrap();
        for (index, hash) in hashes.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO clipboard(
                        hash, time, content, preview_content, item_type, search_index, source,
                        app_source, app_icon_path, title_color, icon, label
                     ) VALUES(?1, ?2, ?1, ?1, 'Text', 1, '', '', '', '', '', 0)",
                    params![hash, index as u64],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
    }

    #[test]
    fn requested_hashes_are_deduplicated_in_first_seen_order() {
        assert_eq!(
            normalized_requested_hashes(&["b".into(), "a".into(), "b".into()]),
            vec!["b".to_string(), "a".to_string()]
        );
    }

    #[test]
    fn existing_items_move_to_the_front_and_new_items_append() {
        let current = vec!["a".into(), "b".into(), "c".into()];
        let requested = vec!["b".into(), "d".into()];
        assert_eq!(
            merged_queue_order(&current, &requested).unwrap(),
            vec!["b", "a", "c", "d"]
        );
    }

    #[test]
    fn new_items_preserve_fifo_order() {
        assert_eq!(
            merged_queue_order(&[], &["a".into(), "b".into(), "c".into()]).unwrap(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn capacity_rejects_the_entire_batch() {
        let current = (0..CAPACITY)
            .map(|index| format!("h{index}"))
            .collect::<Vec<_>>();
        assert!(merged_queue_order(&current, &["new".into()]).is_err());
        assert_eq!(
            merged_queue_order(&current, &["h9".into()]).unwrap().len(),
            CAPACITY
        );
    }

    #[test]
    fn persisted_operations_keep_payload_after_history_is_deleted() {
        with_test_database(|| {
            let hashes = vec!["a".to_string(), "b".to_string(), "c".to_string()];
            seed_history(&hashes);

            add_items(&hashes).unwrap();
            crate::clipboard::delete_by_hash("b").unwrap();
            assert_eq!(ordered_hashes().unwrap(), hashes);
            assert_eq!(item("b").unwrap().unwrap().content, "b");

            reverse().unwrap();
            assert_eq!(ordered_hashes().unwrap(), vec!["c", "b", "a"]);
            reorder(&["b".into(), "a".into(), "c".into()]).unwrap();
            assert_eq!(ordered_hashes().unwrap(), vec!["b", "a", "c"]);
        });
    }

    #[test]
    fn persisted_capacity_rejection_leaves_the_whole_queue_unchanged() {
        with_test_database(|| {
            let hashes = (0..=CAPACITY)
                .map(|index| format!("h{index}"))
                .collect::<Vec<_>>();
            seed_history(&hashes);
            add_items(&hashes[..CAPACITY]).unwrap();
            let before = ordered_hashes().unwrap();

            assert!(add_items(&[hashes[4].clone(), hashes[CAPACITY].clone()]).is_err());
            assert_eq!(ordered_hashes().unwrap(), before);
        });
    }

    #[test]
    fn undo_restores_the_consumed_snapshot_without_history() {
        with_test_database(|| {
            seed_history(&["saved".to_string()]);
            add_items(&["saved".to_string()]).unwrap();
            crate::clipboard::delete_by_hash("saved").unwrap();

            consume("saved").unwrap();
            assert!(ordered_hashes().unwrap().is_empty());
            assert!(undo_consume().unwrap());
            assert_eq!(item("saved").unwrap().unwrap().content, "saved");
        });
    }

    #[test]
    fn queue_only_image_and_rich_text_keep_their_payload_formats() {
        with_test_database(|| {
            set_active(true);
            let image_bytes = include_bytes!("../icons/32x32.png").to_vec();
            let image_hash =
                clipboard::capture_image_with_text_and_app(&image_bytes, "", "ImageApp", "", true)
                    .unwrap();
            let rich_hash = clipboard::capture_rich_text_from_app(
                "formatted text".to_string(),
                Some(b"<b>formatted text</b>".to_vec()),
                Some(b"{\\rtf1 formatted text}".to_vec()),
                None,
                "RichApp",
                "",
                true,
            )
            .unwrap();

            assert!(clipboard::try_get_by_hash(&image_hash).is_none());
            assert!(clipboard::try_get_by_hash(&rich_hash).is_none());
            assert_eq!(
                item(&image_hash).unwrap().unwrap().item_type.to_string(),
                "Image"
            );
            assert!(std::path::Path::new(&item(&image_hash).unwrap().unwrap().content).is_file());
            assert_eq!(plain_text_content(&rich_hash).unwrap(), "formatted text");
            let meta = rich_clipboard_meta(&rich_hash).unwrap();
            assert!(std::path::Path::new(&meta.html_path).is_file());
            assert!(std::path::Path::new(&meta.rtf_path).is_file());
        });
    }

    #[test]
    fn queue_rich_capture_does_not_reuse_same_hash_history_formats() {
        with_test_database(|| {
            let plain_text = "→".to_string();
            let history_html = b"<b>history</b>".to_vec();
            let queue_html = b"<i>queue</i>".to_vec();
            let hash = clipboard::insert_rich_text_from_app(
                plain_text.clone(),
                Some(history_html.clone()),
                None,
                None,
                "HistoryApp",
                "",
            )
            .unwrap();
            let history_meta = clipboard::rich_clipboard_meta(&hash).unwrap();

            set_active(true);
            assert_eq!(
                clipboard::capture_rich_text_from_app(
                    plain_text,
                    Some(queue_html.clone()),
                    None,
                    None,
                    "QueueApp",
                    "",
                    true,
                ),
                Some(hash.clone())
            );
            let queue_meta = rich_clipboard_meta(&hash).unwrap();

            assert_ne!(queue_meta.html_path, history_meta.html_path);
            assert_eq!(
                crate::secure_store::read_file(&history_meta.html_path).unwrap(),
                history_html
            );
            assert_eq!(
                crate::secure_store::read_file(&queue_meta.html_path).unwrap(),
                queue_html
            );

            let replacement_html = b"<u>replacement</u>".to_vec();
            assert_eq!(
                clipboard::capture_rich_text_from_app(
                    "→".to_string(),
                    Some(replacement_html.clone()),
                    None,
                    None,
                    "QueueApp",
                    "",
                    true,
                ),
                Some(hash.clone())
            );
            let replacement_meta = rich_clipboard_meta(&hash).unwrap();
            assert!(!std::path::Path::new(&queue_meta.html_path).exists());
            assert_eq!(
                crate::secure_store::read_file(&replacement_meta.html_path).unwrap(),
                replacement_html
            );
            assert_eq!(
                crate::secure_store::read_file(&history_meta.html_path).unwrap(),
                history_html
            );
        });
    }

    #[test]
    fn full_queue_rejects_capture_without_creating_history() {
        with_test_database(|| {
            let hashes = (0..CAPACITY)
                .map(|index| format!("full-{index}"))
                .collect::<Vec<_>>();
            seed_history(&hashes);
            add_items(&hashes).unwrap();
            set_active(true);

            let rejected = clipboard::capture_text_from_app(
                "must not fall back to history".to_string(),
                "FullQueueApp",
                "",
                true,
            );
            let rejected_hash = clipboard::calculate_xxhash64(b"must not fall back to history");

            assert!(rejected.is_none());
            assert!(clipboard::try_get_by_hash(&rejected_hash).is_none());
            assert_eq!(ordered_hashes().unwrap().len(), CAPACITY);
        });
    }

    #[test]
    fn shared_image_resource_survives_history_delete_until_queue_delete() {
        with_test_database(|| {
            let image_bytes = include_bytes!("../icons/32x32.png").to_vec();
            let hash = clipboard::insert_image_with_text_and_app(&image_bytes, "", "ImageApp", "")
                .unwrap();
            add_items(&[hash.clone()]).unwrap();
            let image_path = std::path::PathBuf::from(item(&hash).unwrap().unwrap().content);

            clipboard::delete_by_hash(&hash).unwrap();
            assert!(image_path.is_file());
            assert!(item(&hash).unwrap().is_some());

            remove_item(&hash).unwrap();
            assert!(!image_path.exists());
        });
    }
}
