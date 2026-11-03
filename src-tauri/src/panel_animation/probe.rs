//! Debug-only probe of the real show/hide path in an isolated memory profile.
//! Run with --dev-mode --memory-profile-dir <fixture> --panel-animation-check
//! --memory-profile-shell-diagnostics. It never uses ordinary application data.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Listener, Manager};

pub(crate) static FORCE_REDUCED: AtomicBool = AtomicBool::new(false);

async fn capture(panel: &tauri::WebviewWindow) -> Result<Value, String> {
    let owned = panel.clone();
    crate::auxiliary_windows::on_main_thread(panel.app_handle().clone(), move || {
        let position = owned.outer_position().map_err(|error| error.to_string())?;
        let size = owned.inner_size().map_err(|error| error.to_string())?;
        let scale = owned.scale_factor().map_err(|error| error.to_string())?;
        let mut record = json!({"visible":crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst),
            "hiding":crate::CLIPBOARD_HIDING.load(Ordering::SeqCst),
            "generation":crate::CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst),
            "hostX":position.x,"hostY":position.y,"width":size.width,"height":size.height,"dpi":scale});
        #[cfg(target_os = "macos")]
        {
            let frame = super::macos::content_frame(&owned)?;
            record["fraction"] = json!(super::macos::current_fraction(&owned)?);
            record["modelY"] = json!(frame.origin.y);
            record["contentHeight"] = json!(frame.size.height);
            record["nativeGeometry"] = super::macos::debug_geometry(&owned)?;
        }
        Ok(record)
    }).await
}

async fn sample(panel: &tauri::WebviewWindow, milliseconds: u64) -> Result<Vec<Value>, String> {
    let started = Instant::now();
    let mut records = vec![];
    while started.elapsed() < Duration::from_millis(milliseconds) {
        let mut record = capture(panel).await?;
        record["elapsedMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        records.push(record);
        tokio::time::sleep(Duration::from_millis(8)).await;
    }
    Ok(records)
}

async fn change(panel: &tauri::WebviewWindow, show: bool) -> Result<(), String> {
    let owned = panel.clone();
    crate::auxiliary_windows::on_main_thread(panel.app_handle().clone(), move || {
        if show {
            crate::show_clipboard_window(&owned);
        } else {
            crate::hide_clipboard_window(&owned);
        }
        Ok(())
    })
    .await
}

fn settled(record: &Value, visible: bool) -> bool {
    record["visible"] == visible
        && record["hiding"] == false
        && record
            .get("fraction")
            .is_none_or(|fraction| fraction.as_f64().is_some_and(|v| v.abs() < 0.005))
}

async fn run(app: tauri::AppHandle) -> Result<Value, String> {
    tokio::time::sleep(Duration::from_millis(650)).await;
    let panel = app
        .get_webview_window("clipboard")
        .ok_or("Main panel is missing")?;
    // Consume the idempotent startup request before timing manual transitions.
    // A cold Vite load can acknowledge readiness after this probe starts.
    crate::startup_panel::clipboard_window_ready(panel.clone())?;
    tokio::time::sleep(Duration::from_millis(220)).await;
    let stale = Arc::new(AtomicUsize::new(0));
    let recorded = stale.clone();
    let listener = panel.listen("window-show-complete", move |_| {
        if !crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst) {
            recorded.fetch_add(1, Ordering::SeqCst);
        }
    });
    let mut cases = vec![];
    let mut ok = true;
    for size in [
        crate::panel_size::PanelSize::Large,
        crate::panel_size::PanelSize::Small,
        crate::panel_size::PanelSize::Medium,
    ] {
        let owned = panel.clone();
        crate::auxiliary_windows::on_main_thread(app.clone(), move || {
            crate::finish_hide_window(&owned)?;
            crate::config::try_update(|config| config.clipboard_panel_size = Some(size))?;
            Ok(())
        })
        .await?;
        change(&panel, true).await?;
        let opening = sample(&panel, 250).await?;
        let opened = capture(&panel).await?;
        let active: Vec<_> = opening.iter().filter(|r| r["visible"] == true).collect();
        #[cfg(target_os = "macos")]
        {
            ok &= active.windows(2).all(|p| p[0]["hostY"] == p[1]["hostY"]);
            ok &= active
                .iter()
                .any(|r| r["fraction"].as_f64().is_some_and(|v| v > 0.01 && v < 0.99));
        }
        #[cfg(target_os = "windows")]
        {
            ok &= active.windows(2).any(|p| p[0]["hostY"] != p[1]["hostY"]);
        }
        #[cfg(target_os = "macos")]
        let dom = crate::panel_size::layout_check::dom(&panel).await?;
        #[cfg(not(target_os = "macos"))]
        let dom = Value::Null;
        if let Some(card) = dom.get("boxes").and_then(|b| b.get("clipboard-card")) {
            ok &= card["height"]
                .as_f64()
                .is_some_and(|height| (height - 230.0).abs() < 1.0);
            ok &= card["bottom"]
                .as_f64()
                .zip(dom["visualHeight"].as_f64())
                .is_some_and(|(bottom, viewport)| bottom < viewport - 7.0);
        }
        ok &= settled(&opened, true);
        change(&panel, false).await?;
        let closing = sample(&panel, 280).await?;
        let closed = capture(&panel).await?;
        ok &= settled(&closed, false);
        cases.push(json!({"size":size,"opening":opening,"opened":opened,"dom":dom,"closing":closing,"closed":closed}));
    }
    change(&panel, true).await?;
    tokio::time::sleep(Duration::from_millis(35)).await;
    change(&panel, false).await?;
    let reversed_before = sample(&panel, 45).await?;
    change(&panel, true).await?;
    let reversed_after = sample(&panel, 260).await?;
    let reopened = capture(&panel).await?;
    ok &= settled(&reopened, true);

    // A direct hide must invalidate a running show's completion as well.
    change(&panel, false).await?;
    tokio::time::sleep(Duration::from_millis(25)).await;
    change(&panel, true).await?;
    let owned = panel.clone();
    crate::auxiliary_windows::on_main_thread(app.clone(), move || {
        crate::finish_hide_window(&owned)
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(230)).await;
    let cancelled = capture(&panel).await?;
    ok &= settled(&cancelled, false);

    FORCE_REDUCED.store(true, Ordering::SeqCst);
    change(&panel, true).await?;
    let reduced_show = sample(&panel, 70).await?;
    change(&panel, false).await?;
    let reduced_hide = sample(&panel, 90).await?;
    let reduced_closed = capture(&panel).await?;
    ok &= settled(&reduced_closed, false);
    #[cfg(target_os = "macos")]
    {
        ok &= reduced_show
            .iter()
            .all(|r| r["fraction"].as_f64().is_some_and(|v| v.abs() < 0.005));
    }
    FORCE_REDUCED.store(false, Ordering::SeqCst);
    panel.unlisten(listener);
    ok &= stale.load(Ordering::SeqCst) == 0;
    Ok(
        json!({"ok":ok,"platform":std::env::consts::OS,"cases":cases,
        "reversal":{"before":reversed_before,"after":reversed_after,"settled":reopened},
        "directHide":cancelled,"reduced":{"show":reduced_show,"hide":reduced_hide,"closed":reduced_closed},
        "staleShowCompletions":stale.load(Ordering::SeqCst)}),
    )
}

pub(crate) fn start(app: tauri::AppHandle) {
    if crate::memory_profile::directory().is_none()
        || !std::env::args().any(|arg| arg == "--panel-animation-check")
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let report = run(app.clone())
            .await
            .unwrap_or_else(|error| json!({"ok":false,"error":error}));
        if let Some(root) = crate::memory_profile::directory() {
            let _ = std::fs::write(
                root.join("panel-animation.json"),
                serde_json::to_vec_pretty(&report).unwrap(),
            );
        }
        app.exit(if report["ok"] == true { 0 } else { 1 });
    });
}
