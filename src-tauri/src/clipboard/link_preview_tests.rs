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

fn seed_link(index: u64, time: u64, metadata: &str) -> LinkPreviewRecord {
    let url = format!("https://example.com/{index}");
    db().execute(
        "insert into clipboard(hash,time,content,item_type,search_index) values(?1,?2,?3,'Link',1)",
        params![format!("seed-{index}"), time as i64, format!("{url}{metadata}")],
    ).unwrap();
    find_link_record_for_preview(&url).unwrap().unwrap()
}

#[test]
fn on_demand_missing_old_links_are_eligible_but_old_successes_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let image = root.path().join("existing.png");
    fs::write(&image, include_bytes!("../../icons/32x32.png")).unwrap();
    let mut record = LinkPreviewRecord { id: 1, hash: "old".into(), time: 1, content: "https://example.com/old".into() };
    let now = LINK_PREVIEW_HISTORY_WINDOW_MILLIS * 2;
    assert!(link_preview_needs_refresh(&record, "2026-10-29", now, true));
    assert!(!link_preview_needs_refresh(&record, "2026-10-29", now, false));
    record.content = format!("https://example.com/old|||{}|||Old|||icon|||2026-10-01", image.display());
    assert!(!link_preview_needs_refresh(&record, "2026-10-29", now, true));
}

#[test]
fn failed_and_empty_title_attempts_are_persisted_and_not_requested_again_today() {
    let observed = {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = test_store();
        let failed = seed_link(1, 1, "");
        let empty = seed_link(2, 1, "");
        let failure_updates = refresh_link_records_with(vec![failed.clone()], true, &|| true, |_| Err("link_preview_timeout".into())).unwrap();
        let empty_updates = refresh_link_records_with(vec![empty.clone()], true, &|| true, |url| Ok(LinkPreviewUpdate { url: url.into(), title: String::new(), image_path: String::new(), image_kind: "default-icon".into() })).unwrap();
        let mut repeated = 0;
        let repeated_updates = refresh_link_records_with(vec![failed, empty], true, &|| true, |_| { repeated += 1; Err("unexpected repeat".into()) }).unwrap();
        let failed = find_link_record_for_preview("https://example.com/1").unwrap().unwrap();
        let empty = find_link_record_for_preview("https://example.com/2").unwrap().unwrap();
        let observed = (failure_updates.len(), empty_updates.len(), repeated, repeated_updates.len(), failed.content, empty.content);
        finish_store();
        observed
    };
    assert_eq!((observed.0, observed.1, observed.2, observed.3), (1, 1, 0, 0));
    assert!(observed.4.contains("|||example.com|||request-failed|||"));
    assert!(observed.5.contains("|||example.com|||default-icon|||"));
}

#[test]
fn cached_records_do_not_starve_later_work_and_lookup_uses_the_loaded_identity() {
    let observed = {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = test_store();
        let day = Local::now().format("%Y-%m-%d").to_string();
        let mut records = (0..10).map(|i| seed_link(i, 1, &format!("||||||example.com|||default-icon|||{day}"))).collect::<Vec<_>>();
        let target = seed_link(10, 1, "");
        records.push(target.clone());
        let mut calls = 0;
        let updates = refresh_link_records_with(records, true, &|| true, |url| { calls += 1; Ok(LinkPreviewUpdate { url: url.into(), title: "Found".into(), image_path: String::new(), image_kind: "default-icon".into() }) }).unwrap();
        let stored = find_link_record_for_preview("https://example.com/10").unwrap().unwrap();
        let observed = (calls, updates.len(), stored.time, stored.hash, stored.id, target.id);
        finish_store();
        observed
    };
    assert_eq!((observed.0, observed.1), (1, 1));
    assert_eq!(observed.2, 1, "repair must not move the item to the top of history");
    assert_eq!(observed.3, "seed-10");
    assert_eq!(observed.4, observed.5);
}

#[test]
fn cancellation_does_not_persist_failure_or_request_the_next_link() {
    let observed = {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _root = test_store();
        let records = vec![seed_link(1, 1, ""), seed_link(2, 1, "")];
        let current = std::cell::Cell::new(true);
        let mut calls = 0;
        let updates = refresh_link_records_with(records, true, &|| current.get(), |_| { calls += 1; current.set(false); Err("cancelled".into()) }).unwrap();
        let content = find_link_record_for_preview("https://example.com/1").unwrap().unwrap().content;
        finish_store();
        (calls, updates.len(), content)
    };
    assert_eq!((observed.0, observed.1), (1, 0));
    assert_eq!(observed.2, "https://example.com/1");
}
