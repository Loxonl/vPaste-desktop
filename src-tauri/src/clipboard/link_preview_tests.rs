use super::*;
use rusqlite::params;

fn test_store() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().into_owned());
    crate::config::save(crate::config::Config {
        storage_dir: root.path().to_string_lossy().into_owned(),
        ..Default::default()
    });
    db::init();
    root
}

fn finish_store() {
    engine::shutdown_runtime_for_tests();
    crate::config::save(crate::config::Config::default());
}

#[test]
fn inline_png_icon_is_cached_without_a_network_request() {
    let (path, bytes) = {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = test_store();
        let client = preview_http_client("inline-icon-test", 1, false).unwrap();
        let source = include_bytes!("../../icons/32x32.png");
        let uri = format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(source)
        );
        let path = fetch_preview_image(
            &client,
            &reqwest::Url::parse("https://example.com/login").unwrap(),
            &uri,
        );
        let bytes = fs::read(&path).unwrap_or_default();
        finish_store();
        (path, bytes)
    };
    assert!(
        !path.is_empty(),
        "a valid embedded favicon must not be discarded as a non-HTTPS URL"
    );
    assert_eq!(bytes, include_bytes!("../../icons/32x32.png"));
}

#[test]
fn inline_icon_rejects_html_svg_invalid_and_mislabeled_payloads() {
    let client = preview_http_client("inline-icon-test", 1, false).unwrap();
    let base = reqwest::Url::parse("https://example.com/").unwrap();
    for uri in [
        "data:text/html;base64,PGh0bWw+PC9odG1sPg==".to_string(),
        "data:image/png;base64,PGh0bWw+PC9odG1sPg==".to_string(),
        "data:image/svg+xml;base64,PHN2Zy8+".to_string(),
        "data:image/png;base64,not-base64!".to_string(),
        format!(
            "data:image/jpeg;base64,{}",
            general_purpose::STANDARD.encode(include_bytes!("../../icons/32x32.png"))
        ),
        format!("data:image/png;base64,{}", "A".repeat(8 * 1024 * 1024)),
    ] {
        assert!(fetch_preview_image(&client, &base, &uri).is_empty());
    }
}

#[test]
fn a_failed_attempt_is_also_fresh_for_its_recorded_day() {
    let record = LinkPreviewRecord {
        id: 1,
        hash: "failed-preview".into(),
        time: 1,
        content: "https://example.com||||||example.com|||request-failed|||2026-10-29".into(),
    };
    assert!(link_preview_is_fresh_for_day(&record, "2026-10-29"));
    assert!(!link_preview_is_fresh_for_day(&record, "2026-10-30"));
}

#[test]
fn lookup_can_find_a_link_behind_five_hundred_newer_records() {
    let found = {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = test_store();
        for index in 0..=501 {
            db().execute(
                "insert into clipboard(hash,time,content,item_type,search_index) values(?1,?2,?3,'Link',1)",
                params![format!("link-{index}"), index + 1, format!("https://example.com/{index}")],
            ).unwrap();
        }
        let found = find_link_record_for_preview("https://example.com/0")
            .unwrap()
            .map(|record| record.id);
        finish_store();
        found
    };
    assert_eq!(
        found,
        Some(1),
        "a loaded old link must not be hidden by a recent-500 scan"
    );
}
