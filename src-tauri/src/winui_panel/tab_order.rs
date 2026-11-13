//! Native drops use the same atomic database move as WebView and macOS.
use serde::Deserialize;
use serde_json::{json, Value};

fn load_from(
    conn: &rusqlite::Connection,
    legacy_path: &std::path::Path,
) -> Result<Vec<String>, String> {
    let order = crate::clipboard::db::read_tab_order(conn).map_err(|error| error.to_string())?;
    if !order.is_empty() || !legacy_path.exists() {
        return Ok(order);
    }
    // Preserve an unsubmitted Windows experiment's order only when the shared
    // database has none. Never write the old file or override macOS/WebView data.
    let legacy: Vec<String> =
        serde_json::from_slice(&crate::history_store::read_file(legacy_path)?)
            .map_err(|error| error.to_string())?;
    crate::clipboard::db::write_tab_order(conn, &legacy).map_err(|error| error.to_string())?;
    crate::clipboard::db::read_tab_order(conn).map_err(|error| error.to_string())
}

pub(super) fn load() -> Result<Value, String> {
    let path = std::path::PathBuf::from(crate::history_storage_dir()).join("ui-tab-order.json");
    load_from(&crate::clipboard::db::db(), &path).map(|order| json!({"order": order}))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabMove {
    source_id: String,
    target_id: String,
    before: bool,
}

pub(super) fn reorder(app: tauri::AppHandle, payload: Value) -> Result<Value, String> {
    let request: TabMove = serde_json::from_value(payload).map_err(|error| error.to_string())?;
    crate::reorder_tab(app, request.source_id, request.target_id, request.before)
        .map(|order| json!({"order": order}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_database_order_wins_and_legacy_native_order_is_only_imported_when_empty() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::clipboard::db::init_schema(&conn).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ui-tab-order.json");
        assert!(load_from(&conn, &path).unwrap().is_empty());
        assert!(!path.exists());
        std::fs::write(&path, br#"["record:7","images","record:7"," "]"#).unwrap();
        assert_eq!(load_from(&conn, &path).unwrap(), ["record:7", "images"]);
        crate::clipboard::db::write_tab_order(&conn, &["from-main".into()]).unwrap();
        std::fs::write(&path, "invalid obsolete file").unwrap();
        assert_eq!(load_from(&conn, &path).unwrap(), ["from-main"]);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "invalid obsolete file"
        );
    }

    #[test]
    fn native_moves_keep_new_database_tabs_and_mixed_record_filter_order() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::clipboard::db::init_schema(&conn).unwrap();
        crate::clipboard::db::write_tab_order(
            &conn,
            &["record:7".into(), "notes".into(), "images".into()],
        )
        .unwrap();
        let known = ["images", "notes", "record:7", "new-from-another-window"].map(String::from);
        let request: TabMove = serde_json::from_value(json!({
            "sourceId": "images", "targetId": "record:7", "before": true
        }))
        .unwrap();
        let order = crate::clipboard::db::reorder_tab_order(
            &conn,
            &known,
            &request.source_id,
            &request.target_id,
            request.before,
        )
        .unwrap();
        assert_eq!(
            order,
            ["images", "record:7", "notes", "new-from-another-window"]
        );
        assert_eq!(crate::clipboard::db::read_tab_order(&conn).unwrap(), order);
    }

    #[test]
    fn native_moves_require_both_ids_and_explicit_placement_not_a_stale_full_order() {
        for payload in [
            json!({"order": ["images", "record:7"], "revision": 11}),
            json!({"sourceId": "images", "before": true}),
            json!({"sourceId": "images", "targetId": "record:7"}),
        ] {
            assert!(serde_json::from_value::<TabMove>(payload).is_err());
        }
    }
}
