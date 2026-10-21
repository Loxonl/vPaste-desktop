use std::sync::{
    atomic::{AtomicBool, Ordering},
    RwLock, RwLockReadGuard,
};
use std::time::{Duration, Instant};

use log::{error, info};
use tauri::{AppHandle, Emitter};

use crate::{clipboard, config, ensure_history_ready};

const BATCH_SIZE: usize = 256;
const CHECK_INTERVAL: Duration = Duration::from_secs(5);
const AGE_SCAN_INTERVAL: Duration = Duration::from_secs(60 * 60);
static REQUESTED: AtomicBool = AtomicBool::new(true);
static ACTIVITY: RwLock<()> = RwLock::new(());

// Only the worker takes an exclusive lock, and only with try_write: nested
// activity guards never wait behind a queued writer. Capture includes file
// creation, database insertion and indexing in the same protected interval.
pub(crate) fn pause() -> RwLockReadGuard<'static, ()> {
    ACTIVITY.read().unwrap_or_else(|error| error.into_inner())
}

pub(crate) fn request() {
    REQUESTED.store(true, Ordering::SeqCst);
}

pub(crate) fn run_once() -> Result<Option<clipboard::CleanupEstimate>, String> {
    let Ok(_idle) = ACTIVITY.try_write() else {
        return Ok(None);
    };
    ensure_history_ready()?;
    let policy = config::get().auto_cleanup;
    policy.validate()?;
    clipboard::auto_cleanup_batch(policy, BATCH_SIZE).map(Some)
}

pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_scan = Instant::now();
        loop {
            // Startup, new records and changed rules are coalesced into batches.
            std::thread::sleep(CHECK_INTERVAL);
            if !REQUESTED.swap(false, Ordering::SeqCst) && last_scan.elapsed() < AGE_SCAN_INTERVAL {
                continue;
            }
            last_scan = Instant::now();
            match run_once() {
                Ok(Some(result)) => {
                    if result.items > 0 {
                        info!(
                            "Automatic history cleanup: items={} bytes={}",
                            result.items, result.bytes
                        );
                        let _ = app.emit("history-auto-cleaned", &result);
                        let _ = app.emit("listen_new_clipboard", "");
                    }
                    if result.items == BATCH_SIZE {
                        request();
                    }
                }
                Ok(None) => request(), // An import, capture or settings write is active.
                Err(cause) => error!("Automatic history cleanup failed: {cause}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AutoCleanupPolicy, Config};

    fn seed(count: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(dir.path().to_string_lossy().to_string());
        config::save(Config {
            storage_dir: dir.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        clipboard::db::init();
        crate::paste_queue::set_active(false);
        for index in 0..count {
            clipboard::db::db().execute(
                "INSERT INTO clipboard(hash, time, content, preview_content, item_type, search_index, title_color)
                 VALUES (?1, ?2, 'text', 'text', 'Text', 0, '')",
                rusqlite::params![format!("item-{index}"), index as i64 + 1],
            ).unwrap();
        }
        dir
    }

    fn count() -> usize {
        clipboard::db::db()
            .query_row("SELECT count(*) FROM clipboard", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn auto_cleanup_count_excludes_favorites_and_tags_and_keeps_recent_items() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _dir = seed(6);
        clipboard::set_favorite("item-0", true).unwrap();
        let tag = clipboard::create_tag("Keep").unwrap();
        clipboard::assign_tag("item-1", tag.id).unwrap();
        assert_eq!(run_once().unwrap().unwrap().items, 0);
        config::update(|c| c.auto_cleanup = AutoCleanupPolicy::Count(2));
        assert_eq!(
            clipboard::auto_cleanup_estimate(AutoCleanupPolicy::Count(2))
                .unwrap()
                .items,
            2
        );
        assert_eq!(count(), 6); // Estimation never deletes.
        assert_eq!(run_once().unwrap().unwrap().items, 2);
        for hash in ["item-0", "item-1", "item-4", "item-5"] {
            assert!(
                clipboard::try_get_by_hash(&hash.to_string()).is_some(),
                "{hash}"
            );
        }
        assert_eq!(count(), 4);
        config::save(Config::default());
    }

    #[test]
    fn auto_cleanup_age_respects_recency_and_protection_added_after_estimate() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _dir = seed(4);
        let policy = AutoCleanupPolicy::Days(30);
        assert_eq!(clipboard::auto_cleanup_estimate(policy).unwrap().items, 4);
        clipboard::touch("item-0").unwrap();
        clipboard::set_favorite("item-1", true).unwrap();
        let tag = clipboard::create_tag("Keep").unwrap();
        clipboard::assign_tag("item-2", tag.id).unwrap();
        config::update(|c| c.auto_cleanup = policy);
        assert_eq!(run_once().unwrap().unwrap().items, 1);
        assert_eq!(count(), 3);
        config::save(Config::default());
    }

    #[test]
    fn auto_cleanup_defers_during_activity_and_stops_between_batches_when_disabled() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _dir = seed(BATCH_SIZE + 4);
        config::update(|c| c.auto_cleanup = AutoCleanupPolicy::Count(2));
        {
            let _active = pause();
            assert!(run_once().unwrap().is_none());
            assert_eq!(count(), BATCH_SIZE + 4);
        }
        assert_eq!(run_once().unwrap().unwrap().items, BATCH_SIZE);
        assert_eq!(count(), 4);
        config::update(|c| c.auto_cleanup = AutoCleanupPolicy::Disabled);
        assert_eq!(run_once().unwrap().unwrap().items, 0);
        assert_eq!(count(), 4);
        config::save(Config::default());
    }

    #[test]
    fn auto_cleanup_preserves_queue_and_undo_attachments() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let dir = seed(3);
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        for index in 0..3 {
            let path = data.join(format!("item-{index}"));
            std::fs::write(&path, b"image fixture").unwrap();
            clipboard::db::db()
                .execute(
                    "UPDATE clipboard SET item_type = 'Image', content = ?1 WHERE hash = ?2",
                    rusqlite::params![path.to_string_lossy(), format!("item-{index}")],
                )
                .unwrap();
        }
        crate::paste_queue::set_active(true);
        crate::paste_queue::add_items(&["item-0".into(), "item-1".into()]).unwrap();
        crate::paste_queue::consume("item-0").unwrap();
        config::update(|c| c.auto_cleanup = AutoCleanupPolicy::Days(30));
        assert_eq!(run_once().unwrap().unwrap().items, 3);
        assert!(data.join("item-0").exists(), "undo attachment must survive");
        assert!(
            data.join("item-1").exists(),
            "queue attachment must survive"
        );
        assert!(
            !data.join("item-2").exists(),
            "unreferenced attachment must be removed"
        );
        assert!(crate::paste_queue::undo_consume().unwrap());
        assert_eq!(crate::paste_queue::ordered_hashes().unwrap().len(), 2);
        crate::paste_queue::set_active(false);
        config::save(Config::default());
    }
}
