use rusqlite::{Connection, Result, Row};
use serde::{Deserialize, Serialize};

/// Clipboard provenance is independent of whether the original app is known.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub is_remote: bool,
    pub bundle_id: String,
}

impl SourceMetadata {
    pub(crate) fn from_row(row: &Row<'_>) -> Self {
        Self {
            is_remote: row.get("source_is_remote").unwrap_or(false),
            bundle_id: row.get("source_bundle_id").unwrap_or_default(),
        }
    }
}

pub(super) fn init_schema(conn: &Connection) -> Result<()> {
    let transaction = conn.unchecked_transaction()?;
    for table in ["clipboard", "paste_queue"] {
        let columns = transaction
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>>>()?;
        for (name, declaration) in [
            ("source_is_remote", "INTEGER NOT NULL DEFAULT 0"),
            ("source_bundle_id", "TEXT NOT NULL DEFAULT ''"),
        ] {
            if !columns.iter().any(|column| column == name) {
                transaction.execute_batch(&format!(
                    "ALTER TABLE {table} ADD COLUMN {name} {declaration}"
                ))?;
            }
        }
    }
    transaction.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn universal_clipboard_additive_migration_preserves_legacy_rows_and_is_repeatable() {
        let conn = Connection::open_in_memory().unwrap();
        crate::clipboard::db::init_schema(&conn).unwrap();
        for table in ["clipboard", "paste_queue"] {
            conn.execute_batch(&format!(
                "ALTER TABLE {table} DROP COLUMN source_is_remote;
                ALTER TABLE {table} DROP COLUMN source_bundle_id;"
            ))
            .unwrap();
        }
        conn.execute_batch("INSERT INTO clipboard(id,hash,time,app_source) VALUES(1,'blank',0,'');
            INSERT INTO clipboard(id,hash,time,app_source) VALUES(2,'local',0,'Local Editor');
            INSERT INTO paste_queue(hash,position,queued_at,time,item_type) VALUES('old-queued-item',0,0,0,'Text');").unwrap();
        crate::clipboard::db::init_schema(&conn).unwrap();
        crate::clipboard::db::init_schema(&conn).unwrap();
        let mut statement = conn.prepare("SELECT * FROM clipboard ORDER BY id").unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>("app_source")?,
                    SourceMetadata::from_row(row),
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                (String::new(), SourceMetadata::default()),
                ("Local Editor".to_string(), SourceMetadata::default())
            ]
        );
        let queued = conn
            .query_row("SELECT * FROM paste_queue", [], |row| {
                Ok(SourceMetadata::from_row(row))
            })
            .unwrap();
        assert_eq!(queued, SourceMetadata::default());
    }

    #[test]
    fn universal_clipboard_metadata_survives_history_queue_and_duplicate_updates() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let previous_data = crate::GLOBAL_APP_DATA_DIR
            .lock()
            .unwrap()
            .replace(root.path().to_string_lossy().into_owned());
        let previous_config = crate::config::get();
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().into_owned(),
            ..Default::default()
        });
        crate::clipboard::db::init();
        crate::paste_queue::set_active(false);
        let capture = |app: &str, icon: &str, metadata: SourceMetadata, queue: bool| {
            crate::clipboard::capture_text_from_app(
                "same remote/local content".to_string(),
                app,
                icon,
                crate::clipboard::CaptureContext::from(queue).with_source(metadata),
            )
            .unwrap()
        };
        let local = SourceMetadata {
            is_remote: false,
            bundle_id: "com.example.editor".to_string(),
        };
        let hash = capture("Local Editor", "/missing/local.png", local.clone(), false);
        let original = crate::clipboard::try_get_by_hash(&hash).unwrap();
        crate::clipboard::db::db()
            .execute(
                "UPDATE clipboard SET label=1, title_color='stale-local-color' WHERE hash=?1",
                [&hash],
            )
            .unwrap();
        crate::clipboard::db::db()
            .execute(
                "INSERT INTO tags(id,name,created_at,updated_at) VALUES(1,'Keep',0,0)",
                [],
            )
            .unwrap();
        crate::clipboard::db::db()
            .execute("INSERT INTO clipboard_tags VALUES(?1,1,0)", [original.id])
            .unwrap();
        let remote = SourceMetadata {
            is_remote: true,
            bundle_id: String::new(),
        };
        assert_eq!(hash, capture("", "", remote.clone(), false));
        let item = crate::clipboard::try_get_by_hash(&hash).unwrap();
        assert_eq!(item.id, original.id);
        assert_eq!(item.label, 1);
        assert_eq!(item.tags[0].name, "Keep");
        assert_eq!(item.source_metadata, remote);
        assert!(item.app_source.is_empty());
        let stored = crate::clipboard::db::db()
            .query_row(
                "SELECT * FROM clipboard WHERE hash=?1",
                [&hash],
                crate::clipboard::read_stored_item,
            )
            .unwrap();
        assert!(stored.app_icon_path.is_empty());
        assert!(stored.title_color.is_empty());
        let refs = crate::clipboard::history_ref_page("", 0, 0, 36, "__all", || true)
            .unwrap()
            .unwrap();
        assert_eq!(refs.list[0].source_metadata, remote);
        let payload = serde_json::to_value(&item).unwrap();
        assert_eq!(payload["sourceMetadata"]["isRemote"], true);
        assert_eq!(hash, capture("Local Editor", "", local.clone(), false));
        let item = crate::clipboard::try_get_by_hash(&hash).unwrap();
        assert_eq!(item.app_source, "Local Editor");
        assert_eq!(item.source_metadata, local);
        crate::paste_queue::set_active(true);
        let identified_remote = SourceMetadata {
            is_remote: true,
            bundle_id: "com.example.remote".to_string(),
        };
        assert_eq!(
            hash,
            capture("Remote Editor", "", identified_remote.clone(), true)
        );
        assert_eq!(
            crate::paste_queue::item(&hash)
                .unwrap()
                .unwrap()
                .source_metadata,
            identified_remote
        );
        crate::paste_queue::reverse().unwrap();
        assert_eq!(
            crate::paste_queue::item(&hash)
                .unwrap()
                .unwrap()
                .source_metadata,
            identified_remote
        );
        assert_eq!(hash, capture("", "", remote.clone(), true));
        assert_eq!(
            crate::paste_queue::item(&hash)
                .unwrap()
                .unwrap()
                .source_metadata,
            remote
        );
        crate::paste_queue::set_active(false);
        crate::paste_queue::clear().unwrap();
        crate::search::engine::shutdown_runtime_for_tests();
        crate::config::save(previous_config);
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = previous_data;
    }
}
