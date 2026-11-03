use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{WebviewUrl, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
use windows_dev::core::Interface;

use super::windows_text_scale::FACTOR;
use std::sync::atomic::Ordering;

fn set_probe_zoom(window: &tauri::WebviewWindow, zoom: f64) -> Result<f64, String> {
    let dpi = window.scale_factor().map_err(|error| error.to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |view| {
            let result = (|| -> windows_dev::core::Result<f64> {
                unsafe {
                    let controller = view.controller();
                    let raster = controller.cast::<ICoreWebView2Controller3>()?;
                    let mut scale = 0.0;
                    raster.RasterizationScale(&mut scale)?;
                    controller.SetZoomFactor(zoom)?;
                    Ok(scale * zoom / dpi)
                }
            })()
            .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|error| error.to_string())?
}

fn check_layout(
    window: &tauri::WebviewWindow,
    receiver: &mpsc::Receiver<serde_json::Value>,
    case: usize,
    tray: bool,
    expected_height: f64,
) -> Result<serde_json::Value, String> {
    let (css, html, selector) = if tray {
        (
            include_str!("../../../src/tray/TrayMenu.module.css"),
            "<div class='tray-menu-frame'><nav class='tray-menu-shell'><div class='tray-menu-list'><div class='tray-status-card'>Recording</div><div class='tray-menu-item'>Show</div><div class='tray-menu-item'>Settings</div><div class='tray-menu-item' id='quit'>Quit</div></div></nav></div>",
            "#quit",
        )
    } else {
        (
            include_str!("../../../src/clipboard/Clipboard.module.css"),
            "<div class='clipboard-container'><header class='clipboard-header'>Header</header><div class='cards-container'><div class='cards-results-stack'><div class='cards-grid'><div class='card-motion-item'><article class='clipboard-card'>Card</article></div></div></div></div></div>",
            ".clipboard-card",
        )
    };
    let script = format!(
        "(()=>{{document.head.innerHTML='';const style=document.createElement('style');style.textContent={css};document.head.append(style);document.body.innerHTML={html};const report=n=>{{if({scroll_to_end}){{const box=document.querySelector({scroll_selector});box.scrollTop=box.scrollHeight;}}const rect=document.querySelector({selector}).getBoundingClientRect();document.title='scale-probe:'+JSON.stringify({{case:{case},height:innerHeight,bottom:rect.bottom,dpr:devicePixelRatio}});if(n)requestAnimationFrame(()=>report(n-1));}};requestAnimationFrame(()=>report(8));}})()",
        css = serde_json::to_string(css).unwrap(),
        html = serde_json::to_string(html).unwrap(),
        selector = serde_json::to_string(selector).unwrap(),
        scroll_to_end = expected_height < if tray { 170.0 } else { crate::CLIPBOARD_WINDOW_HEIGHT } - 1.0,
        scroll_selector = serde_json::to_string(if tray { ".tray-menu-frame" } else { ".cards-container" }).unwrap(),
    );
    window.show().map_err(|error| error.to_string())?;
    window.eval(script).map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last = None;
    while Instant::now() < deadline {
        let value = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| format!("probe metrics: {error}; last={last:?}"))?;
        if value["case"].as_u64() != Some(case as u64) {
            continue;
        }
        if (value["height"].as_f64().unwrap() - expected_height).abs() <= 1.0
            && value["bottom"].as_f64().unwrap() <= value["height"].as_f64().unwrap() + 1.0
        {
            return Ok(value);
        }
        last = Some(value);
    }
    Err(format!("content was clipped: {last:?}"))
}

#[test]
#[ignore = "requires a local interactive Windows desktop and WebView2; never changes OS text size"]
fn native_webview_preserves_cards_quit_and_bounds_with_enlarged_text() {
    let profile = tempfile::tempdir().unwrap();
    let result = Arc::new(Mutex::new(None::<Result<(), String>>));
    let output = result.clone();
    let data_dir = profile.path().to_path_buf();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.loxonl.vpaste.text-scale-test".into();
    let app = tauri::Builder::default()
        .any_thread()
        .plugin(super::plugin())
        .setup(move |app| {
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let original = FACTOR.load(Ordering::SeqCst);
                let checked = (|| -> Result<(), String> {
                    let (sender, receiver) = mpsc::channel();
                    let probe = WebviewWindowBuilder::new(&app, "scaleProbe", WebviewUrl::External("about:blank".parse().unwrap()))
                        .title("vPaste — isolated text-size test")
                        .data_directory(data_dir.clone())
                        .visible(false).focused(false).skip_taskbar(true)
                        .decorations(false).resizable(false).shadow(crate::CLIPBOARD_WINDOW_SHADOW)
                        .inner_size(500.0, 302.0)
                        .on_document_title_changed(move |_, title| {
                            if let Some(json) = title.strip_prefix("scale-probe:") {
                                if let Ok(value) = serde_json::from_str(json) { let _ = sender.send(value); }
                            }
                        })
                        .build().map_err(|error| error.to_string())?;
                    let _ = window_vibrancy::apply_acrylic(&probe, Some((232, 235, 229, 30)));
                    crate::refresh_clipboard_window_frame(&AsRef::<tauri::Webview>::as_ref(&probe).window()).map_err(|error| error.to_string())?;
                    let dpi = probe.scale_factor().map_err(|error| error.to_string())?;
                    for (index, zoom) in [1.0, 1.25, 1.5, 2.0].into_iter().enumerate() {
                        // Simulate extra content magnification in this disposable WebView only.
                        let text_scale = set_probe_zoom(&probe, zoom)?;
                        FACTOR.store(text_scale.to_bits(), Ordering::SeqCst);
                        let bounds = crate::screen_bounds(&probe);
                        let layout = crate::clipboard_window_layout(bounds);
                        crate::set_window_size_for_scale(&probe, 500.0 * text_scale, layout.height, dpi)?;
                        let expected = layout.height / text_scale;
                        let metrics = check_layout(&probe, &receiver, index * 2, false, expected)?;
                        if (metrics["height"].as_f64().unwrap() - expected).abs() > 1.0 {
                            return Err(format!("wrong CSS viewport at zoom {zoom}: {metrics}"));
                        }
                        crate::resize_tray_menu(probe.clone(), 216, 170)?;
                        let tray_height = probe.inner_size().map_err(|error| error.to_string())?.height as f64 / (dpi * text_scale);
                        let tray = check_layout(&probe, &receiver, index * 2 + 1, true, tray_height)?;
                        eprintln!("native text-size case zoom={zoom}, dpi={dpi}, cards={metrics}, tray={tray}");
                    }
                    probe.hide().map_err(|error| error.to_string())?;

                    let scale = super::current();
                    let settings = WebviewWindowBuilder::new(&app, "config", WebviewUrl::External("about:blank".parse().unwrap()))
                        .data_directory(data_dir).visible(false).focused(false).decorations(false).shadow(false)
                        .inner_size(720.0 * scale, 700.0 * scale)
                        .build().map_err(|error| error.to_string())?;
                    super::remember(&settings, scale);
                    crate::fit_content_window_to_work_area(&settings)?;
                    let work = settings.current_monitor().map_err(|error| error.to_string())?.unwrap().work_area().clone();
                    let size = settings.outer_size().map_err(|error| error.to_string())?;
                    if size.width > work.size.width || size.height > work.size.height {
                        return Err(format!("settings escaped work area: {size:?}, {work:?}"));
                    }
                    let before = settings.inner_size().map_err(|error| error.to_string())?;
                    let (done, finished) = mpsc::channel();
                    let handle = app.clone();
                    app.run_on_main_thread(move || { crate::apply_ui_text_scale_change(&handle, scale); let _ = done.send(()); })
                        .map_err(|error| error.to_string())?;
                    finished.recv_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
                    if settings.inner_size().map_err(|error| error.to_string())? != before {
                        return Err("an already-scaled new window was scaled twice".into());
                    }

                    // Hidden settings must regain their minimum size when text returns to 100%.
                    FACTOR.store(1.0_f64.to_bits(), Ordering::SeqCst);
                    let (done, finished) = mpsc::channel();
                    let handle = app.clone();
                    app.run_on_main_thread(move || { crate::apply_ui_text_scale_change(&handle, 1.0); let _ = done.send(()); })
                        .map_err(|error| error.to_string())?;
                    finished.recv_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
                    let mut constraints = windows::Win32::UI::WindowsAndMessaging::MINMAXINFO::default();
                    unsafe {
                        use windows::Win32::{Foundation::{HWND, LPARAM, WPARAM}, UI::WindowsAndMessaging::{SendMessageW, WM_GETMINMAXINFO}};
                        SendMessageW(HWND(settings.hwnd().map_err(|error| error.to_string())?.0 as isize), WM_GETMINMAXINFO,
                            WPARAM(0), LPARAM(&mut constraints as *mut _ as isize));
                    }
                    if constraints.ptMinTrackSize.x < (640.0 * dpi).round().min(work.size.width as f64) as i32
                        || constraints.ptMinTrackSize.y < (520.0 * dpi).round().min(work.size.height as f64) as i32 {
                        return Err(format!("hidden settings lost minimum size: {:?}", constraints.ptMinTrackSize));
                    }
                    Ok(())
                })();
                FACTOR.store(original, Ordering::SeqCst);
                *output.lock().unwrap() = Some(checked);
                app.exit(0);
            });
            Ok(())
        })
        .build(context).unwrap();
    let exit_code = app.run_return(|_, _| {});
    assert_eq!(exit_code, 0);
    result
        .lock()
        .unwrap()
        .take()
        .expect("native probe completed")
        .unwrap();
}
