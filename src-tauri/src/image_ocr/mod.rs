use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{sync_channel, SyncSender},
    Mutex, MutexGuard, OnceLock,
};
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{clipboard, config, search::engine};

#[cfg(test)]
mod tests;
pub(crate) mod worker;

static WAKE: OnceLock<SyncSender<()>> = OnceLock::new();
static THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static STOPPED: AtomicBool = AtomicBool::new(false);
static STORAGE: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OcrError {
    LanguageUnavailable,
    Unsupported,
    ResourceLimit,
    Timeout,
    Failed,
}

#[derive(Debug, Serialize)]
pub(crate) struct OcrRecord {
    pub status: String,
    pub text: String,
    pub error: Option<OcrError>,
}

struct Job {
    database: String,
    hash: String,
    id: i64,
    path: String,
    request_id: i64,
}

pub(crate) fn storage_guard() -> MutexGuard<'static, ()> {
    STORAGE.lock().unwrap_or_else(|error| error.into_inner())
}

pub(crate) fn init_schema(connection: &Connection) -> rusqlite::Result<()> {
    // A derived cache, independent of the supported history payload format.
    // The trigger also covers old clients and every existing cleanup path;
    // SQLite foreign-key enforcement is not enabled on all pooled connections.
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS image_ocr (
            hash TEXT PRIMARY KEY NOT NULL,
            clipboard_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            error TEXT,
            manual INTEGER NOT NULL DEFAULT 0,
            requested_at INTEGER NOT NULL,
            request_id INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS delete_image_ocr AFTER DELETE ON clipboard
        BEGIN DELETE FROM image_ocr WHERE hash = OLD.hash; END;
        CREATE INDEX IF NOT EXISTS image_ocr_pending ON image_ocr(status, manual, requested_at);",
    )
}

fn record(connection: &Connection, hash: &str) -> Result<OcrRecord, String> {
    connection
        .query_row(
            "SELECT o.status, o.text, o.error FROM clipboard c LEFT JOIN image_ocr o
         ON o.hash = c.hash AND o.clipboard_id = c.id WHERE c.hash = ?1 AND c.item_type = 'Image'",
            [hash],
            |row| {
                let error: Option<String> = row.get(2)?;
                Ok(OcrRecord {
                    status: row
                        .get::<_, Option<String>>(0)?
                        .unwrap_or_else(|| "unrecognized".into()),
                    text: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    error: error.and_then(|value| serde_json::from_str(&value).ok()),
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "image_missing".to_string())
}

fn enqueue(
    connection: &mut Connection,
    hash: &str,
    manual: bool,
    force: bool,
) -> Result<OcrRecord, String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let id: i64 = transaction
        .query_row(
            "SELECT id FROM clipboard WHERE hash = ?1 AND item_type = 'Image'",
            [hash],
            |row| row.get(0),
        )
        .map_err(|_| "image_missing".to_string())?;
    let current = record(&transaction, hash)?;
    if current.status == "unrecognized"
        || (force && !matches!(current.status.as_str(), "pending" | "running"))
    {
        transaction.execute(
            "INSERT INTO image_ocr(hash,clipboard_id,status,manual,requested_at,request_id)
             VALUES(?1,?2,'pending',?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET
             clipboard_id=excluded.clipboard_id,status='pending',error=NULL,
             manual=excluded.manual,requested_at=excluded.requested_at,request_id=excluded.request_id",
            params![hash,id,manual,chrono::Utc::now().timestamp_millis(),rand::random::<i64>()],
        ).map_err(|error| error.to_string())?;
    } else if manual && current.status == "pending" {
        transaction
            .execute("UPDATE image_ocr SET manual = 1 WHERE hash = ?1", [hash])
            .map_err(|error| error.to_string())?;
    }
    let result = record(&transaction, hash)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

pub(crate) fn cached_text(hash: &str) -> String {
    let result = clipboard::db::db().query_row(
        "SELECT o.text FROM image_ocr o JOIN clipboard c ON c.id=o.clipboard_id AND c.hash=o.hash WHERE o.hash=?1 AND c.item_type='Image'",
        [hash], |row| row.get(0),
    ).optional();
    match result {
        Ok(text) => text.unwrap_or_default(),
        Err(error) => {
            log::warn!("Failed to read image OCR search text: {error}");
            String::new()
        }
    }
}

pub(crate) fn wake() {
    if let Some(sender) = WAKE.get() {
        let _ = sender.try_send(());
    }
}

pub(crate) fn resume_requested_jobs() {
    // A previous process or storage switch may have interrupted these jobs.
    // Untouched historical images have no cache row and are never enqueued.
    if let Err(error) = clipboard::db::db().execute(
        "UPDATE image_ocr SET status='pending' WHERE status='running'",
        [],
    ) {
        log::warn!("Failed to resume image OCR: {error}");
    }
    wake();
}

pub(crate) fn captured(hash: &str) {
    if !config::get().image_ocr_enabled {
        return;
    }
    let result = {
        let _storage = storage_guard();
        enqueue(&mut clipboard::db::db(), hash, false, false)
    };
    if let Err(error) = result {
        log::warn!("Failed to queue image OCR: {error}");
    }
    wake();
}

#[tauri::command]
pub(crate) async fn get_image_ocr(hash: String) -> Result<OcrRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _storage = storage_guard();
        record(&clipboard::db::db(), &hash)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn recognize_image_text(hash: String, force: bool) -> Result<OcrRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = {
            let _storage = storage_guard();
            enqueue(&mut clipboard::db::db(), &hash, true, force)
        };
        wake();
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

fn take_job(connection: &mut Connection, automatic: bool) -> Result<Option<Job>, String> {
    let database = connection.path().unwrap_or_default().to_string();
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let job = transaction
        .query_row(
            "SELECT c.id,c.hash,c.content,o.request_id FROM image_ocr o
         JOIN clipboard c ON c.hash=o.hash AND c.id=o.clipboard_id AND c.item_type='Image'
         WHERE o.status='pending' AND (?1 OR o.manual=1)
         ORDER BY o.manual DESC,o.requested_at,c.id LIMIT 1",
            [automatic],
            |row| {
                Ok(Job {
                    database,
                    id: row.get(0)?,
                    hash: row.get(1)?,
                    path: row.get(2)?,
                    request_id: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(job) = &job {
        transaction
            .execute(
                "UPDATE image_ocr SET status='running' WHERE hash=?1 AND request_id=?2",
                params![job.hash, job.request_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(job)
}

fn finish(job: &Job, result: Result<String, OcrError>) -> Result<bool, String> {
    let _storage = storage_guard();
    let mut connection = clipboard::db::db();
    if connection.path() != Some(job.database.as_str()) {
        return Ok(false);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (status, text, error) = match result {
        Ok(text) if text.len() <= worker::MAX_TEXT_BYTES => {
            let text = text.trim().to_string();
            (
                if text.is_empty() { "empty" } else { "complete" },
                Some(text),
                None,
            )
        }
        Ok(_) => ("failed", None, Some(OcrError::ResourceLimit)),
        Err(error) => ("failed", None, Some(error)),
    };
    let changed = transaction.execute(
        "UPDATE image_ocr SET status=?1,text=COALESCE(?2,text),error=?3
         WHERE hash=?4 AND clipboard_id=?5 AND request_id=?6 AND status='running'
         AND EXISTS(SELECT 1 FROM clipboard WHERE hash=?4 AND id=?5 AND content=?7 AND item_type='Image')",
        params![status,text,error.map(|error| serde_json::to_string(&error).unwrap()),job.hash,job.id,job.request_id,job.path],
    ).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Ok(false);
    }
    transaction
        .execute(
            "UPDATE clipboard SET search_index=0 WHERE hash=?1 AND id=?2",
            params![job.hash, job.id],
        )
        .map_err(|error| error.to_string())?;
    let stored = transaction
        .query_row(
            "SELECT * FROM clipboard WHERE hash=?1",
            [&job.hash],
            clipboard::read_stored_item,
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    drop(connection);
    engine::insert(
        &clipboard::stored_item_search_content(&stored),
        &stored.hash,
        &(stored.id as u64),
        stored.time,
    );
    Ok(true)
}

pub(crate) fn start(app: AppHandle) {
    let (sender, receiver) = sync_channel(1);
    if WAKE.set(sender).is_err() {
        return;
    }
    let thread = std::thread::spawn(move || {
        resume_requested_jobs();
        while !STOPPED.load(Ordering::Acquire) {
            let next = {
                let _storage = storage_guard();
                take_job(&mut clipboard::db::db(), config::get().image_ocr_enabled)
            };
            match next {
                Ok(Some(job)) => {
                    let started = Instant::now();
                    let result = worker::run(&job.path, &STOPPED);
                    log::info!(
                        "Image OCR completed elapsed_ms={} success={}",
                        started.elapsed().as_millis(),
                        result.is_ok()
                    );
                    if STOPPED.load(Ordering::Acquire) {
                        break;
                    }
                    match finish(&job, result) {
                        Ok(true) => {
                            let _ = app.emit("image-ocr-updated", &job.hash);
                        }
                        Ok(false) => {}
                        Err(error) => log::warn!("Failed to save image OCR: {error}"),
                    }
                }
                Ok(None) => {
                    if receiver.recv().is_err() {
                        break;
                    }
                }
                Err(error) => {
                    log::warn!("Image OCR queue failed: {error}");
                    if receiver
                        .recv_timeout(std::time::Duration::from_secs(1))
                        .is_err()
                    {
                        continue;
                    }
                }
            }
        }
    });
    *THREAD.lock().unwrap() = Some(thread);
}

pub(crate) fn stop() {
    STOPPED.store(true, Ordering::Release);
    wake();
    if let Some(thread) = THREAD.lock().unwrap().take() {
        let _ = thread.join();
    }
}
