//! Debug-only, isolated profiling of the real clipboard window and commands.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
const MARKER: &str = ".vpaste-memory-profile";

pub fn directory() -> Option<&'static Path> {
    DIRECTORY.get().map(PathBuf::as_path)
}

pub fn driver_script() -> &'static str {
    if std::env::args().any(|arg| arg == "--memory-profile-parking-check") {
        include_str!("../../scripts/profile-main-window-parking.js")
    } else if std::env::args().any(|arg| arg == "--memory-profile-resource-check") {
        include_str!("../../scripts/profile-history-resources.js")
    } else if std::env::args().any(|arg| arg == "--memory-profile-first-page") {
        concat!(
            "window.__vpasteMemoryProfileFirstPage=true;\n",
            include_str!("../../scripts/profile-main-window-driver.js")
        )
    } else if std::env::args().any(|arg| arg == "--memory-profile-layers-diagnostics") {
        concat!(
            "window.__vpasteMemoryProfileLayers=true;\n",
            include_str!("../../scripts/profile-main-window-diagnostics.js")
        )
    } else if std::env::args().any(|arg| arg == "--memory-profile-shell-diagnostics") {
        "window.__vpasteMemoryProfileDiagnostics=true;"
    } else if std::env::args().any(|arg| arg == "--memory-profile-inspector") {
        "window.__vpasteMemoryProfileDiagnostics=true;performance.setResourceTimingBufferSize(10000);"
    } else if std::env::args().any(|arg| arg == "--memory-profile-cache-diagnostics") {
        concat!(
            "window.__vpasteMemoryProfileTrimCache=true;\n",
            include_str!("../../scripts/profile-main-window-diagnostics.js")
        )
    } else if std::env::args().any(|arg| arg == "--memory-profile-diagnostics") {
        include_str!("../../scripts/profile-main-window-diagnostics.js")
    } else {
        include_str!("../../scripts/profile-main-window-driver.js")
    }
}

#[tauri::command]
pub async fn memory_profile_parking_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    toggle: bool,
) -> Result<Value, String> {
    directory().ok_or("not an isolated memory-profile process")?;
    if window.label() != "clipboard" {
        return Err("invalid profiling caller".into());
    }
    if toggle {
        crate::toggle_clipboard_window(&app);
    }
    let position = window.outer_position().map_err(|err| err.to_string())?;
    let size = window.outer_size().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let rect = crate::ScreenBounds {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        scale_factor: scale,
    };
    let displays: Vec<_> = window
        .available_monitors()
        .map_err(|err| err.to_string())?
        .iter()
        .map(crate::screen_bounds_from_monitor)
        .collect();
    let outside = !displays.is_empty()
        && displays.iter().all(|screen| {
            rect.x + rect.width <= screen.x
                || rect.x >= screen.x + screen.width
                || rect.y + rect.height <= screen.y
                || rect.y >= screen.y + screen.height
        });
    Ok(
        json!({ "nativeVisible": window.is_visible().map_err(|err| err.to_string())?,
        "presented": crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst),
        "hiding": crate::CLIPBOARD_HIDING.load(std::sync::atomic::Ordering::SeqCst),
        "focused": window.is_focused().map_err(|err| err.to_string())?, "outsideDisplays": outside,
        "rect": [rect.x, rect.y, rect.width, rect.height], "displayCount": displays.len(),
        "reducedMotion": crate::system_reduces_motion() }),
    )
}

/// Separate diagnostic for the public in-memory cache API. Never called by the
/// acceptance driver, and never removes cookies, storage, databases or disk data.
#[tauri::command]
pub async fn memory_profile_trim_cache(window: tauri::WebviewWindow) -> Result<(), String> {
    directory().ok_or("not an isolated memory-profile process")?;
    if window.label() != "clipboard" {
        return Err("invalid profiling caller".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        window.with_webview(move |webview| unsafe {
            use cocoa::base::id;
            use objc::{class, msg_send, sel, sel_impl};
            unsafe extern "C" { static WKWebsiteDataTypeMemoryCache: id; }
            let configuration: id = msg_send![webview.inner().cast::<objc::runtime::Object>(), configuration];
            let store: id = msg_send![configuration, websiteDataStore];
            let types: id = msg_send![class!(NSSet), setWithObject:WKWebsiteDataTypeMemoryCache];
            let date: id = msg_send![class!(NSDate), distantPast];
            let completion = block::ConcreteBlock::new(move || { let _ = sender.send(()); }).copy();
            let _: () = msg_send![store, removeDataOfTypes:types modifiedSince:date completionHandler:&*completion];
        }).map_err(|error| error.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
            .await
            .map_err(|_| "cache diagnostic timed out".to_string())?
            .ok_or_else(|| "cache diagnostic ended without completion".to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("cache diagnostic is macOS only".into())
}

pub fn dev_origin() -> tauri::Url {
    let port = std::env::var("VPASTE_MEMORY_PROFILE_PORT").unwrap_or_else(|_| "1421".into());
    format!("http://127.0.0.1:{port}")
        .parse()
        .expect("profile port was validated before startup")
}

pub fn configure() -> Result<bool, String> {
    let args: Vec<_> = std::env::args().collect();
    let Some(index) = args.iter().position(|arg| arg == "--memory-profile-dir") else {
        return Ok(false);
    };
    if !args.iter().any(|arg| arg == "--dev-mode") {
        return Err("memory profiling requires --dev-mode".into());
    }
    if let Ok(port) = std::env::var("VPASTE_MEMORY_PROFILE_PORT") {
        if port.parse::<u16>().ok().is_none_or(|port| port < 1024) {
            return Err("profile port must be an unprivileged loopback port".into());
        }
    }
    let root = PathBuf::from(args.get(index + 1).ok_or("missing profile directory")?)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable.parent().ok_or("missing executable directory")?;
    validate_profile_location(&root, executable_dir)?;
    #[cfg(target_os = "windows")]
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", root.join("webview2"));
    DIRECTORY
        .set(root)
        .map_err(|_| "profile already configured")?;
    if args
        .iter()
        .any(|arg| arg == "--memory-profile-capture-check")
    {
        capture_thumbnail_check()?;
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--memory-profile-prepare") {
        prepare()?;
        return Ok(true);
    }
    if !directory().unwrap().join("fixture.json").is_file() {
        return Err("profile fixture is missing".into());
    }
    Ok(false)
}

fn validate_profile_location(root: &Path, executable_dir: &Path) -> Result<(), String> {
    if !root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("vpaste-memory-"))
        || fs::read(root.join(MARKER)).map_err(|error| error.to_string())? != b"vpaste-memory-v1\n"
    {
        return Err("profile directory must be an explicitly marked temporary profile".into());
    }
    if crate::runtime_mode::portable_data_directory_for(executable_dir).is_some() {
        return Err("isolated profiling cannot run next to portable.flag; copy the Debug executable to a separate temporary directory first".into());
    }
    Ok(())
}

/// Headless diagnostic through the actual capture/store and foreground resolver.
/// Uses only a fresh marked profile; never opens or changes the system clipboard.
fn capture_thumbnail_check() -> Result<(), String> {
    use crate::media_resources::{self, MediaIntent};
    use std::collections::BTreeMap;
    use std::time::{Instant, SystemTime};

    let root = directory().unwrap();
    if fs::read_dir(root).map_err(|e| e.to_string())?.count() != 1 {
        return Err("capture diagnostic requires a new empty marked directory".into());
    }
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.to_string_lossy().into_owned());
    let mut config = crate::config::Config::default();
    config.link_auto_preview = false;
    crate::config::save(config);
    crate::ensure_history_storage_dirs()?;
    crate::clipboard::db::try_init().map_err(|e| e.to_string())?;
    media_resources::set_capture_scale_factor(2.0);
    let cache_files = || -> Result<BTreeMap<PathBuf, SystemTime>, String> {
        let path = PathBuf::from(crate::app_runtime_dir(&["image_preview_cache"]));
        if !path.exists() {
            return Ok(BTreeMap::new());
        }
        fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
            .map(|entry| {
                Ok((
                    entry.path(),
                    entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .map_err(|e| e.to_string())?,
                ))
            })
            .collect()
    };
    let mut rows = Vec::new();
    for (name, remove_cache, as_file) in [
        ("image-cache-hit", false, false),
        ("image-cache-miss", true, false),
        ("image-file", false, true),
    ] {
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_fn(1920, 1080, |x, y| {
            image::Rgb([x as u8, y as u8, name.len() as u8])
        })
        .write_to(&mut encoded, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
        let bytes = encoded.into_inner();
        let before = cache_files()?;
        let started = Instant::now();
        let (hash, source) = if as_file {
            let source = root.join("copied.png");
            fs::write(&source, &bytes).map_err(|e| e.to_string())?;
            let source = source.to_string_lossy().into_owned();
            let hash = crate::clipboard::capture_file_from_app(
                &vec![source.clone()],
                "capture-diagnostic",
                "",
                false,
            )
            .ok_or("file capture was not stored")?;
            (hash, source)
        } else {
            let hash = crate::clipboard::capture_image_with_text_and_app(
                &bytes,
                "",
                "capture-diagnostic",
                "",
                false,
            )
            .ok_or("image capture was not stored")?;
            let source = crate::clipboard::try_get_by_hash(&hash)
                .ok_or("captured image is missing")?
                .content;
            (hash, source)
        };
        let capture_ms = started.elapsed().as_secs_f64() * 1000.0;
        let created = cache_files()?;
        let thumbnails: Vec<_> = created
            .keys()
            .filter(|path| !before.contains_key(*path))
            .cloned()
            .collect();
        if thumbnails.len() != 1 {
            return Err(format!(
                "{name}: capture did not create exactly one thumbnail"
            ));
        }
        let thumbnail = &thumbnails[0];
        let dimensions = image::image_dimensions(thumbnail).map_err(|e| e.to_string())?;
        if dimensions != (480, 270) {
            return Err(format!(
                "{name}: wrong thumbnail dimensions: {dimensions:?}"
            ));
        }
        if remove_cache {
            fs::remove_file(thumbnail).map_err(|e| e.to_string())?;
        }
        let started = Instant::now();
        let resource = tauri::async_runtime::block_on(media_resources::resolve_for_card_width(
            source.clone(),
            MediaIntent::Card,
            as_file,
            480,
        ))?;
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;
        let loaded_path = PathBuf::from(&resource.asset_path);
        if loaded_path != *thumbnail || !crate::valid_png_cache_file(&loaded_path) {
            return Err(format!(
                "{name}: foreground did not use the capture thumbnail path"
            ));
        }
        if !remove_cache
            && fs::metadata(&loaded_path)
                .and_then(|m| m.modified())
                .map_err(|e| e.to_string())?
                != created[thumbnail]
        {
            return Err(format!("{name}: foreground rewrote the existing thumbnail"));
        }
        if fs::read(&source).map_err(|e| e.to_string())? != bytes {
            return Err("original image changed".into());
        }
        rows.push(json!({"case":name,"hash":hash,"sourceBytes":bytes.len(),"captureMs":capture_ms,"foregroundMs":load_ms,"thumbnailBeforeForeground":true,"thumbnailSize":dimensions,"cacheReused":!remove_cache,"fallbackRebuilt":remove_cache,"originalUnchanged":true}));
    }
    let result = json!({"diagnostic":"capture-thumbnail","platform":std::env::consts::OS,"build":"debug","scaleFactor":2,"cardPixelWidth":480,"cases":rows});
    fs::write(
        root.join("capture-check.json"),
        serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn prepare() -> Result<(), String> {
    let root = directory().unwrap();
    if fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .count()
        != 1
    {
        return Err("fixture preparation requires a new empty marked directory".into());
    }
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.to_string_lossy().into_owned());
    let mut config = crate::config::Config::default();
    config.startup = false;
    config.display_tray_icon = false;
    config.link_auto_preview = false;
    config.update_check_enabled = false;
    config.onboarding_completed = true;
    config.retain_last_position = true;
    config.theme_mode = "light".into();
    crate::config::save(config);
    crate::ensure_history_storage_dirs()?;
    crate::clipboard::db::try_init().map_err(|error| error.to_string())?;
    let assets = root.join("fixtures");
    fs::create_dir_all(&assets).map_err(|error| error.to_string())?;
    let source_file = assets.join("sample.ts");
    fs::write(&source_file, "export const memoryProfileFixture = true;\n")
        .map_err(|error| error.to_string())?;
    let long_text = assets.join("long.txt");
    fs::write(
        &long_text,
        "Synthetic long-text fixture, not user clipboard content.\n".repeat(400),
    )
    .map_err(|error| error.to_string())?;
    let gif = assets.join("animated.gif");
    let mut encoder = image::codecs::gif::GifEncoder::new(
        fs::File::create(&gif).map_err(|error| error.to_string())?,
    );
    encoder
        .set_repeat(image::codecs::gif::Repeat::Infinite)
        .map_err(|error| error.to_string())?;
    for frame in 0..8 {
        let pixels = image::RgbaImage::from_fn(128, 96, |x, y| {
            image::Rgba([((x + frame * 17) % 256) as u8, (y * 2) as u8, 120, 255])
        });
        encoder
            .encode_frame(image::Frame::from_parts(
                pixels,
                0,
                0,
                image::Delay::from_numer_denom_ms(80, 1),
            ))
            .map_err(|error| error.to_string())?;
    }
    drop(encoder);
    let mut inline_png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_fn(96, 64, |x, y| {
        image::Rgba([x as u8, (y * 3) as u8, 160, 255])
    })
    .write_to(&mut inline_png, image::ImageFormat::Png)
    .map_err(|error| error.to_string())?;
    let inline_image = base64::engine::general_purpose::STANDARD.encode(inline_png.get_ref());
    let conn = crate::clipboard::db::db();
    for index in 0..500u64 {
        let hash = hex::encode(Sha256::digest(format!("vpaste-memory-v1-{index}")));
        let text = format!(
            "Synthetic profile item {index:03}. {}",
            "A reproducible clipboard memory fixture. ".repeat(20)
        );
        let (kind, content, preview, source) = match index % 10 {
            1 | 6 => {
                let image_path = root.join("data").join(&hash);
                image::RgbaImage::from_fn(720, 420, |x, y| {
                    image::Rgba([
                        ((x + index as u32) % 256) as u8,
                        ((y + index as u32) % 256) as u8,
                        ((x / 3 + y / 2) % 256) as u8,
                        255,
                    ])
                })
                .save_with_format(&image_path, image::ImageFormat::Png)
                .map_err(|error| error.to_string())?;
                (
                    "Image",
                    image_path.to_string_lossy().into_owned(),
                    String::new(),
                    String::new(),
                )
            }
            3 => (
                "File",
                json!([source_file]).to_string(),
                String::new(),
                String::new(),
            ),
            4 => (
                "Link",
                format!("https://example.invalid/profile/{index}|||"),
                String::new(),
                String::new(),
            ),
            5 => {
                let html_path = root.join("rich_formats").join(format!("{hash}.html"));
                fs::write(&html_path, format!("<p><b>{text}</b></p><img width=96 height=64 src=\"data:image/png;base64,{inline_image}\" />"))
                    .map_err(|error| error.to_string())?;
                let meta = json!({"version":1,"html_path":html_path,"rtf_path":"","png_path":""});
                (
                    "Text",
                    text.clone(),
                    text.clone(),
                    format!("vpaste-rich:{meta}"),
                )
            }
            7 => (
                "File",
                json!([gif]).to_string(),
                String::new(),
                String::new(),
            ),
            8 => (
                "TextFile",
                long_text.to_string_lossy().into_owned(),
                text.clone(),
                String::new(),
            ),
            _ => ("Text", text.clone(), text.clone(), String::new()),
        };
        conn.execute("INSERT INTO clipboard(hash,content,preview_content,time,title_color,item_type,icon,source,app_source,app_icon_path,search_index) VALUES(?1,?2,?3,?4,'#447788',?5,'',?6,'Memory fixture','',0)",
            rusqlite::params![hash, content, preview, 1_793_145_600_000u64 + index, kind, source]).map_err(|error| error.to_string())?;
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| error.to_string())?;
    let fixture = json!({"version":1,"count":500,"pattern":"text,image,text,file,link,rich,image,gif,textfile,text","imageSize":[720,420],"gifSize":[128,96],"gifFrames":8,"baseTime":1_793_145_600_000u64});
    fs::write(
        root.join("fixture.json"),
        serde_json::to_vec_pretty(&fixture).unwrap(),
    )
    .map_err(|error| error.to_string())
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory)
        .map_err(|error| error.to_string())?;
    crate::ensure_history_storage_dirs()?;
    crate::clipboard::db::try_init().map_err(|error| error.to_string())?;
    crate::rebuild_current_search_index()?;
    let window = crate::build_clipboard_window(app).map_err(|error| error.to_string())?;
    window
        .set_focusable(false)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
    crate::startup_panel::request_show(app)?;
    if std::env::args().any(|arg| arg == "--memory-profile-inspector") {
        window.open_devtools();
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    phase: String,
    elapsed_ms: f64,
    dom_count: usize,
    image_count: usize,
    scroll_left: f64,
    loaded_count: usize,
    viewport_width: f64,
    dpr: f64,
    svg_module_count: usize,
    misses: usize,
    error: Option<String>,
    #[serde(default)]
    diagnostics: Option<Value>,
}

#[cfg(target_os = "macos")]
async fn native_layer_tree(window: &tauri::WebviewWindow) -> Result<Value, String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSRect;
    use objc::{msg_send, sel, sel_impl};
    unsafe fn text(value: id) -> String {
        if value == nil {
            return String::new();
        }
        let bytes: *const std::ffi::c_char = msg_send![value, UTF8String];
        if bytes.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(bytes)
                .to_string_lossy()
                .into_owned()
        }
    }
    unsafe fn visit(layer: id, depth: usize, remaining: &mut usize) -> Value {
        if layer == nil || depth >= 64 || *remaining == 0 {
            return Value::Null;
        }
        *remaining -= 1;
        let bounds: NSRect = msg_send![layer, bounds];
        let scale: f64 = msg_send![layer, contentsScale];
        let rasterized: bool = msg_send![layer, shouldRasterize];
        let opaque: bool = msg_send![layer, isOpaque];
        let name: id = msg_send![layer, name];
        let contents: id = msg_send![layer, contents];
        let format: id = msg_send![layer, contentsFormat];
        let sublayers: id = msg_send![layer, sublayers];
        let count: usize = if sublayers == nil {
            0
        } else {
            msg_send![sublayers, count]
        };
        let mut children = Vec::new();
        for index in 0..count.min(*remaining) {
            let child: id = msg_send![sublayers, objectAtIndex:index];
            children.push(visit(child, depth + 1, remaining));
        }
        let contents_class = if contents == nil {
            ""
        } else {
            (*contents).class().name()
        };
        json!({"class":(*layer).class().name(),"name":text(name),"bounds":[bounds.origin.x,bounds.origin.y,bounds.size.width,bounds.size.height],"contentsScale":scale,"contentsFormat":text(format),"contentsClass":contents_class,"hasContents":contents != nil,"opaque":opaque,"rasterized":rasterized,"children":children})
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |view| unsafe {
            let layer: id = msg_send![view.inner().cast::<objc::runtime::Object>(), layer];
            let _ = sender.send(visit(layer, 0, &mut 2048));
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "native layer diagnostic timed out".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn memory_profile_record(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    metrics: Metrics,
) -> Result<(), String> {
    let root = directory().ok_or("not an isolated memory-profile process")?;
    if window.label() != "clipboard" || metrics.phase.len() > 32 {
        return Err("invalid profiling caller or phase".into());
    }
    if metrics.error.is_none() && app.webview_windows().len() != 1 {
        return Err("an auxiliary window contaminated the isolated profile".into());
    }
    if metrics.error.is_none() && metrics.phase == "s1" && metrics.loaded_count != 36 {
        return Err("first-page scenario must contain exactly 36 loaded records".into());
    }
    if (metrics.phase == "s1" || metrics.phase.starts_with("s2-"))
        && !window.is_visible().map_err(|error| error.to_string())?
    {
        return Err("main window is hidden during a visible profiling interval".into());
    }
    let mut diagnostics = metrics.diagnostics;
    diagnostics.get_or_insert_with(|| json!({}))["nativeViewCacheBytes"] =
        json!(crate::history_views::cache_bytes());
    #[cfg(target_os = "macos")]
    if metrics.phase == "diagnostic-layers" {
        diagnostics.get_or_insert_with(|| json!({}))["nativeLayers"] =
            native_layer_tree(&window).await?;
    }
    let report = serde_json::to_value(crate::dev_memory::report(&app, true).await)
        .map_err(|error| error.to_string())?;
    let sample = report["samples"]
        .as_array()
        .and_then(|samples| samples.last())
        .ok_or("memory sample unavailable")?;
    let peaks: Vec<Value> = sample["processes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|process| {
            let pid = process["pid"].as_u64()? as u32;
            Some(json!({"pid":pid,"bytes":lifetime_peak(pid)}))
        })
        .collect();
    let row = json!({"phase":metrics.phase,"elapsedMs":metrics.elapsed_ms,"domCount":metrics.dom_count,"imageCount":metrics.image_count,"scrollLeft":metrics.scroll_left,"loadedCount":metrics.loaded_count,"viewportWidth":metrics.viewport_width,"dpr":metrics.dpr,"svgModuleCount":metrics.svg_module_count,"misses":metrics.misses,"error":metrics.error,"sample":sample,"osLifetimePeaks":peaks,"diagnostics":diagnostics});
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("samples.jsonl"))
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, &row).map_err(|error| error.to_string())?;
    writeln!(file).map_err(|error| error.to_string())?;
    if metrics.phase == "complete" || metrics.error.is_some() {
        app.exit(if metrics.error.is_some() { 1 } else { 0 });
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn lifetime_peak(pid: u32) -> Option<u64> {
    // sys/resource.h rusage_info_v4: UUID followed by 35 uint64_t fields.
    #[repr(C)]
    struct Usage {
        uuid: [u8; 16],
        fields: [u64; 35],
    }
    unsafe extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut std::ffi::c_void) -> i32;
    }
    let mut usage = Usage {
        uuid: [0; 16],
        fields: [0; 35],
    };
    (unsafe { proc_pid_rusage(pid as i32, 4, (&mut usage as *mut Usage).cast()) } == 0)
        .then_some(usage.fields[28])
}

#[cfg(not(target_os = "macos"))]
fn lifetime_peak(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_installation_is_rejected_before_any_profile_or_personal_data_is_initialized() {
        let profile = tempfile::Builder::new()
            .prefix("vpaste-memory-")
            .tempdir()
            .unwrap();
        fs::write(profile.path().join(MARKER), b"vpaste-memory-v1\n").unwrap();
        let installation = tempfile::tempdir().unwrap();
        fs::write(installation.path().join("portable.flag"), b"portable").unwrap();
        fs::create_dir(installation.path().join("data")).unwrap();
        let personal = installation.path().join("data/vpaste.db");
        fs::write(&personal, b"personal database sentinel").unwrap();

        assert!(validate_profile_location(profile.path(), installation.path()).is_err());
        assert_eq!(fs::read(&personal).unwrap(), b"personal database sentinel");
        assert_eq!(fs::read_dir(profile.path()).unwrap().count(), 1);
        fs::remove_file(installation.path().join("portable.flag")).unwrap();
        assert!(validate_profile_location(profile.path(), installation.path()).is_ok());
    }
}
