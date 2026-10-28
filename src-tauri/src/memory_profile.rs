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

pub fn configure() -> Result<bool, String> {
    let args: Vec<_> = std::env::args().collect();
    let Some(index) = args.iter().position(|arg| arg == "--memory-profile-dir") else {
        return Ok(false);
    };
    if !args.iter().any(|arg| arg == "--dev-mode") {
        return Err("memory profiling requires --dev-mode".into());
    }
    let root = PathBuf::from(args.get(index + 1).ok_or("missing profile directory")?)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("vpaste-memory-"))
        || fs::read(root.join(MARKER)).map_err(|error| error.to_string())? != b"vpaste-memory-v1\n"
    {
        return Err("profile directory must be an explicitly marked temporary profile".into());
    }
    DIRECTORY
        .set(root)
        .map_err(|_| "profile already configured")?;
    if args.iter().any(|arg| arg == "--memory-profile-prepare") {
        prepare()?;
        return Ok(true);
    }
    if !directory().unwrap().join("fixture.json").is_file() {
        return Err("profile fixture is missing".into());
    }
    Ok(false)
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
    let row = json!({"phase":metrics.phase,"elapsedMs":metrics.elapsed_ms,"domCount":metrics.dom_count,"imageCount":metrics.image_count,"scrollLeft":metrics.scroll_left,"loadedCount":metrics.loaded_count,"viewportWidth":metrics.viewport_width,"dpr":metrics.dpr,"svgModuleCount":metrics.svg_module_count,"misses":metrics.misses,"error":metrics.error,"sample":sample,"osLifetimePeaks":peaks});
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
