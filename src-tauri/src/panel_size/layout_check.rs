//! Isolated macOS regression probe for native page zoom and full card bounds.
//! Use a prepared memory-profile fixture with --dev-mode --memory-profile-dir,
//! --memory-profile-shell-diagnostics and --panel-size-layout-check. The report
//! is written inside that isolated profile; regular app data is never used.
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

pub(crate) async fn dom(window: &tauri::WebviewWindow) -> Result<Value, String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{msg_send, sel, sel_impl};
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    window.with_webview(move |view| unsafe {
        let script = NSString::alloc(nil).init_str("JSON.stringify({innerHeight,documentHeight:document.documentElement.clientHeight,visualHeight:visualViewport?.height,dpr:devicePixelRatio,boxes:Object.fromEntries(['clipboard-container','clipboard-header','cards-container','cards-results-stack','cards-grid','virtual-list-track','clipboard-card'].map(name=>{const e=document.querySelector('[class*=\\\"'+name+'\\\"]');if(!e)return[name,null];const r=e.getBoundingClientRect(),s=getComputedStyle(e);return[name,{y:r.y,height:r.height,bottom:r.bottom,cssHeight:s.height,minHeight:s.minHeight}]}))})");
        let callback = block::ConcreteBlock::new(move |value: id, error: id| {
            let result = if error != nil || value == nil { Err("DOM query failed".into()) } else {
                let bytes: *const std::ffi::c_char = msg_send![value, UTF8String];
                if bytes.is_null() { Err("Empty DOM query".into()) } else { serde_json::from_slice(std::ffi::CStr::from_ptr(bytes).to_bytes()).map_err(|e|e.to_string()) }
            };
            let _ = sender.send(result);
        }).copy();
        let _: () = msg_send![view.inner() as id, evaluateJavaScript:script completionHandler:&*callback];
        let _: () = msg_send![script, release];
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .map_err(|e| e.to_string())?
        .ok_or("DOM callback closed")?
}

async fn run(app: tauri::AppHandle) -> Result<Value, String> {
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let panel = app.get_webview_window("clipboard").ok_or("missing panel")?;
    crate::open_config_window(app.clone(), panel.clone(), None).await?;
    let settings = app.get_webview_window("config").ok_or("missing settings")?;
    let mut records = vec![];
    for size in [
        super::PanelSize::Large,
        super::PanelSize::Small,
        super::PanelSize::Medium,
        super::PanelSize::Large,
    ] {
        for preview in [true, false] {
            let handle = app.clone();
            let source = settings.clone();
            crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                if preview {
                    let panel = super::apply_preview(&handle, &source, size)?
                        .ok_or("The WebView layout probe requires --main-ui=webview")?;
                    crate::CLIPBOARD_VISIBLE.store(true, std::sync::atomic::Ordering::SeqCst);
                    crate::background_resources::set_visible(&handle, true);
                    let _ = panel.emit("window-show", Option::<Value>::None);
                    let _ = panel.emit("window-show-complete", ());
                } else {
                    let panel = handle
                        .get_webview_window("clipboard")
                        .ok_or("missing panel")?;
                    crate::finish_hide_window(&panel)?;
                    super::restore_normal_order(&panel);
                    crate::config::try_update(|config| config.clipboard_panel_size = Some(size))?;
                    crate::show_clipboard_window(&panel);
                }
                Ok(())
            })
            .await?;
            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
            let layout = dom(&panel).await?;
            let handle = app.clone();
            let layer = crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                use cocoa::base::{id, BOOL, NO};
                use objc::{msg_send, sel, sel_impl};
                let panel = handle
                    .get_webview_window("clipboard")
                    .ok_or("missing panel")?;
                let settings = handle
                    .get_webview_window("config")
                    .ok_or("missing settings")?;
                let native = panel.ns_window().map_err(|error| error.to_string())? as id;
                let source = settings.ns_window().map_err(|error| error.to_string())? as id;
                let (level, settings_level, click_through) = unsafe {
                    let level: isize = msg_send![native, level];
                    let settings_level: isize = msg_send![source, level];
                    let ignored: BOOL = msg_send![native, ignoresMouseEvents];
                    (level, settings_level, ignored != NO)
                };
                Ok(json!({ "level": level, "settingsLevel": settings_level,
                    "focused": panel.is_focused().map_err(|error| error.to_string())?,
                    "clickThrough": click_through }))
            })
            .await?;
            records.push(
                json!({"size":size,"phase":if preview {"preview"} else {"normal"},"layout":layout,"native":layer}),
            );
        }
    }
    let ok = records.iter().all(|record| {
        let layout = &record["layout"];
        let card = &layout["boxes"]["clipboard-card"];
        let viewport = layout["visualHeight"].as_f64().unwrap_or(0.0);
        let header = layout["boxes"]["clipboard-header"]["bottom"]
            .as_f64()
            .unwrap_or(0.0);
        let native = &record["native"];
        let layer_ok = if record["phase"] == "preview" {
            native["level"].as_i64().is_some_and(|level| {
                level >= 104 && level > native["settingsLevel"].as_i64().unwrap_or(i64::MAX)
            }) && native["focused"] == false
                && native["clickThrough"] == true
        } else {
            native["level"] == 101
        };
        layer_ok
            && card["bottom"]
                .as_f64()
                .is_some_and(|bottom| bottom <= viewport - 8.0)
            && card["y"].as_f64().is_some_and(|top| top >= header + 8.0)
            && card["height"]
                .as_f64()
                .is_some_and(|height| (height - 230.0).abs() < 1.0)
    });
    Ok(json!({"ok":ok,"records":records}))
}

pub fn start(app: tauri::AppHandle) {
    if crate::memory_profile::directory().is_none()
        || !std::env::args().any(|a| a == "--panel-size-layout-check")
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let report = run(app.clone())
            .await
            .unwrap_or_else(|error| json!({"ok":false,"error":error}));
        if let Some(root) = crate::memory_profile::directory() {
            let _ = std::fs::write(
                root.join("panel-size-layout.json"),
                serde_json::to_vec_pretty(&report).unwrap(),
            );
        }
        app.exit(if report["ok"] == true { 0 } else { 1 });
    });
}
