//! Isolated native smoke check; does not initialize vPaste history or clipboard.
//! Run in Debug: cargo run --manifest-path src-tauri/Cargo.toml --example dev_memory_probe

#[cfg(debug_assertions)]
#[path = "../src/auxiliary_windows.rs"]
mod auxiliary_windows;
#[cfg(debug_assertions)]
#[path = "../src/dev_memory/mod.rs"]
mod dev_memory;

#[cfg(debug_assertions)]
fn build_auxiliary_window(
    app: &tauri::AppHandle,
    kind: auxiliary_windows::WindowKind,
) -> tauri::Result<tauri::WebviewWindow> {
    use tauri::Manager;
    if matches!(kind, auxiliary_windows::WindowKind::DevMemory) {
        let window = dev_memory::build_window(
            app,
            tauri::WebviewUrl::External("memory-probe://localhost/index.html".parse().unwrap()),
        )?;
        app.state::<auxiliary_windows::Readiness>()
            .signal(kind.label())
            .unwrap();
        return Ok(window);
    }
    tauri::WebviewWindowBuilder::new(
        app,
        kind.label(),
        tauri::WebviewUrl::External("memory-probe://localhost/index.html".parse().unwrap()),
    )
    .visible(false)
    .on_page_load(|webview, event| {
        if event.event() == tauri::webview::PageLoadEvent::Finished {
            let _ = webview
                .app_handle()
                .state::<auxiliary_windows::Readiness>()
                .signal(webview.label());
        }
    })
    .build()
}

#[cfg(debug_assertions)]
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[cfg(debug_assertions)]
fn main() {
    use tauri::Manager;
    fn create(app: &tauri::AppHandle, label: &str) -> tauri::Result<tauri::WebviewWindow> {
        tauri::WebviewWindowBuilder::new(
            app,
            label,
            tauri::WebviewUrl::External("memory-probe://localhost/index.html".parse().unwrap()),
        )
        .visible(false)
        .build()
    }
    async fn snapshot(app: &tauri::AppHandle, count: usize) -> Result<serde_json::Value, String> {
        for _ in 0..30 {
            let report = serde_json::to_value(dev_memory::report(app, true).await).unwrap();
            let latest = report["samples"].as_array().unwrap().last().unwrap();
            let windows = latest["windows"].as_array().unwrap();
            if windows.len() == count
                && windows
                    .iter()
                    .all(|window| !window["rendererPids"].as_array().unwrap().is_empty())
            {
                if latest["totalResidentBytes"].as_u64().unwrap_or(0) == 0
                    || latest["partial"].as_bool() == Some(true)
                {
                    return Err(format!("native counters unavailable: {latest}"));
                }
                return Ok(latest.clone());
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Err(format!(
            "native windows did not become measurable: {}",
            serde_json::to_value(dev_memory::report(app, false).await).unwrap()
        ))
    }
    tauri::Builder::default()
    .register_uri_scheme_protocol("memory-probe", |_, _| tauri::http::Response::builder()
        .header("Content-Type", "text/html").body(b"<!doctype html><html><body>Memory probe</body></html>".to_vec()).unwrap())
    .manage(dev_memory::Monitor::default())
    .manage(auxiliary_windows::Readiness::default()).setup(|app| {
        create(app.handle(), "probeMain")?;
        create(app.handle(), "probeAux")?;
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let opened = snapshot(&handle, 2).await?;
                auxiliary_windows::destroy(&handle.get_webview_window("probeAux").unwrap())?;
                let closed = snapshot(&handle, 1).await?;
                let build_handle = handle.clone();
                tauri::async_runtime::spawn_blocking(move || create(&build_handle, "probeAux"))
                    .await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
                let recreated = snapshot(&handle, 2).await?;
                let old = auxiliary_windows::ensure(&handle, auxiliary_windows::WindowKind::Config).await?;
                auxiliary_windows::destroy(&old)?;
                // Reopen immediately, while destroy() may still be queued.
                let reopened = auxiliary_windows::ensure(&handle, auxiliary_windows::WindowKind::Config).await?;
                if auxiliary_windows::is_open(&old) || !auxiliary_windows::is_open(&reopened) {
                    return Err("immediate reopen reused a closing native instance".into());
                }
                auxiliary_windows::destroy(&old)?;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if !auxiliary_windows::is_open(&reopened) || handle.get_webview_window("config").is_none() {
                    return Err("old delayed close affected the recreated window".into());
                }
                let monitor = auxiliary_windows::ensure(&handle, auxiliary_windows::WindowKind::DevMemory).await?;
                let duplicate = auxiliary_windows::ensure(&handle, auxiliary_windows::WindowKind::DevMemory).await?;
                if !auxiliary_windows::is_open(&duplicate) { return Err("monitor was not reused".into()); }
                let pinned = monitor.clone();
                auxiliary_windows::on_main_thread(handle.clone(), move || {
                    dev_memory::keep_on_top(&pinned)?;
                    pinned.show().map_err(|error| error.to_string())?;
                    pinned.set_focus().map_err(|error| error.to_string())?;
                    Ok(())
                }).await?;
                let other = reopened.clone();
                auxiliary_windows::on_main_thread(handle.clone(), move || {
                    other.show().map_err(|error| error.to_string())?;
                    other.set_focus().map_err(|error| error.to_string())
                }).await?;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if !monitor.is_visible().map_err(|error| error.to_string())? {
                    return Err("monitor disappeared when another window took focus".into());
                }
                #[cfg(target_os = "macos")]
                {
                    use cocoa::base::id;
                    use objc::{msg_send, sel, sel_impl};
                    let pinned = monitor.clone();
                    auxiliary_windows::on_main_thread(handle.clone(), move || {
                        let native = pinned.ns_window().map_err(|error| error.to_string())?;
                        let level: isize = unsafe { msg_send![native as id, level] };
                        if level != 103 { return Err(format!("monitor level is {level}, expected 103")); }
                        Ok(())
                    }).await?;
                }
                #[cfg(target_os = "windows")]
                if !monitor.is_always_on_top().map_err(|error| error.to_string())? { return Err("monitor is not topmost".into()); }
                let with_monitor = snapshot(&handle, 4).await?;
                if !with_monitor["windows"].as_array().unwrap().iter().any(|window| window["label"] == "devMemory") {
                    return Err("monitor was not included in its own accounting".into());
                }
                monitor.hide().map_err(|error| error.to_string())?;
                dev_memory::set_monitoring(handle.clone(), true).await;
                tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                let running = serde_json::to_value(dev_memory::report(&handle, false).await).unwrap();
                let latest = running["samples"].as_array().unwrap().last().unwrap()["timestamp"].clone();
                if latest.as_u64().unwrap() <= with_monitor["timestamp"].as_u64().unwrap() {
                    return Err("hidden-window background sampling did not advance".into());
                }
                dev_memory::set_monitoring(handle.clone(), false).await;
                tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                let stopped = serde_json::to_value(dev_memory::report(&handle, false).await).unwrap();
                if stopped["samples"].as_array().unwrap().last().unwrap()["timestamp"] != latest {
                    return Err("sampling continued after stop".into());
                }
                auxiliary_windows::destroy(&monitor)?;
                let reopened_monitor = auxiliary_windows::ensure(&handle, auxiliary_windows::WindowKind::DevMemory).await?;
                if auxiliary_windows::is_open(&monitor) || !auxiliary_windows::is_open(&reopened_monitor) { return Err("monitor close/reopen lifecycle failed".into()); }
                println!("{}", serde_json::json!({ "opened": opened, "closed": closed, "recreated": recreated, "withMonitor": with_monitor }));
                Ok::<_, String>(())
            }.await;
            match result { Ok(()) => handle.exit(0), Err(error) => { eprintln!("{error}"); handle.exit(1); } }
        });
        Ok(())
    }).run(tauri::generate_context!()).expect("native probe runtime");
}

#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("The memory probe requires a Debug build.");
}
