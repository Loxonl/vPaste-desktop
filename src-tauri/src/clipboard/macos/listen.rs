use crate::clipboard::source_metadata::SourceMetadata;
use crate::{
    app_runtime_dir, clipboard, config, CLIPBOARD_HISTORY_PAUSED, CLIPBOARD_IGNORE_NEXT_CHANGE,
};
use arboard::Clipboard;
use cocoa::base::{id, nil};
use cocoa::foundation::NSString;
use log::{error, info};
use objc::rc::autoreleasepool;
use objc::{class, msg_send, sel, sel_impl};
use scraper::Html;
use std::collections::HashMap;
use std::ffi::CStr;
use std::fs;
use std::hash::{Hash, Hasher};
use std::os::raw::c_char;
use std::path::PathBuf;
use std::slice;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};

const READ_ATTEMPTS: usize = 3;
const INITIAL_RETRY_DELAY_MS: u64 = 25;
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 500;
const PASTE_QUEUE_CLIPBOARD_POLL_INTERVAL_MS: u64 = 100;

const HTML_PASTEBOARD_TYPES: &[&str] = &[
    "public.html",
    "Apple HTML pasteboard type",
    "NSHTMLPboardType",
];
const RTF_PASTEBOARD_TYPES: &[&str] =
    &["public.rtf", "Apple RTF pasteboard type", "NSRTFPboardType"];
const SOURCE_PASTEBOARD_TYPE: &str = "org.nspasteboard.source";
const SOURCE_METADATA_LIMIT: usize = 1024;
const REMOTE_CLIPBOARD_TYPE: &str = "com.apple.is-remote-clipboard";
const SENSITIVE_PASTEBOARD_TYPES: &[&str] = &[
    "org.nspasteboard.ConcealedType",
    "org.nspasteboard.TransientType",
];

static APP_SOURCE_CACHE: OnceLock<Mutex<HashMap<String, AppSource>>> = OnceLock::new();

#[derive(Clone, Debug, Default)]
struct AppSource {
    name: String,
    icon_path: String,
    metadata: SourceMetadata,
}

impl AppSource {
    fn capture_request(&self, queue_only: bool) -> clipboard::CaptureRequest {
        clipboard::CaptureContext::from(queue_only).with_source(self.metadata.clone())
    }
}

fn is_clipboard_history_paused() -> bool {
    CLIPBOARD_HISTORY_PAUSED.load(Ordering::SeqCst)
}

fn is_ignored_app_source(app_source: &str) -> bool {
    !app_source.is_empty()
        && config::get()
            .ignored_app_sources
            .iter()
            .any(|source| source == app_source)
}

pub fn start(window: WebviewWindow) {
    thread::spawn(move || {
        let mut system_clipboard = match autoreleasepool(Clipboard::new) {
            Ok(c) => c,
            Err(e) => {
                error!("Failed to initialize clipboard: {}", e);
                return;
            }
        };

        let mut last_change_count = autoreleasepool(pasteboard_change_count);
        let mut last_queue_state_emit: Option<Instant> = None;

        loop {
            // Cocoa returns autoreleased pasteboard, workspace, image, and data objects.
            // Drain them before this long-lived listener thread goes back to sleep.
            let captured = autoreleasepool(|| {
                poll_clipboard_once(&window, &mut system_clipboard, &mut last_change_count)
            });
            if let Some((hash, queue_only)) = captured {
                emit_clipboard_event(&window, queue_only);
                if queue_only {
                    last_queue_state_emit = Some(Instant::now());
                }
                info!("captured clipboard hash: {hash}");
            } else if crate::paste_queue::is_active()
                && last_queue_state_emit.map_or(true, |last| {
                    last.elapsed() >= Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS)
                })
            {
                crate::paste_queue::emit_state(window.app_handle());
                last_queue_state_emit = Some(Instant::now());
            }

            let poll_interval_ms = if crate::paste_queue::is_active() {
                PASTE_QUEUE_CLIPBOARD_POLL_INTERVAL_MS
            } else {
                CLIPBOARD_POLL_INTERVAL_MS
            };
            thread::sleep(Duration::from_millis(poll_interval_ms));
        }
    });
}

fn poll_clipboard_once(
    window: &WebviewWindow,
    system_clipboard: &mut Clipboard,
    last_change_count: &mut isize,
) -> Option<(String, bool)> {
    if CLIPBOARD_IGNORE_NEXT_CHANGE.swap(false, Ordering::SeqCst) {
        info!("skip internal clipboard change");
        *last_change_count = pasteboard_change_count();
        return None;
    }

    let current_change_count = pasteboard_change_count();
    if current_change_count == *last_change_count {
        return None;
    }
    *last_change_count = current_change_count;

    if is_clipboard_history_paused() {
        info!("skip clipboard history while recording is paused");
        return None;
    }

    let start = Instant::now();
    let queue_only = crate::paste_queue::is_active();
    if let Some(hash) = parse_with_retry(window, system_clipboard, queue_only) {
        info!("clipboard parsed in {}ms", start.elapsed().as_millis());
        Some((hash, queue_only))
    } else {
        info!("clipboard ignored in {}ms", start.elapsed().as_millis());
        None
    }
}

fn parse_with_retry(
    window: &WebviewWindow,
    system_clipboard: &mut Clipboard,
    queue_only: bool,
) -> Option<String> {
    for attempt in 0..READ_ATTEMPTS {
        match parse(system_clipboard, queue_only) {
            Ok(hash) => return hash,
            Err(err) => {
                if crate::clipboard_budget::is_limit_error(&err) {
                    error!("clipboard capture rejected: {err}");
                    let _ = window.emit("clipboard-capture-rejected", ());
                    if queue_only {
                        crate::paste_queue::set_error(None, err);
                        crate::paste_queue::emit_state(window.app_handle());
                    }
                    return None;
                }
                let delay = INITIAL_RETRY_DELAY_MS * (attempt as u64 + 1);
                info!(
                    "clipboard read failed on attempt {}/{}: {}; retrying in {}ms",
                    attempt + 1,
                    READ_ATTEMPTS,
                    err,
                    delay
                );
                thread::sleep(Duration::from_millis(delay));
            }
        }
    }

    error!("clipboard read failed after {} attempts", READ_ATTEMPTS);
    None
}

fn parse(_system_clipboard: &mut Clipboard, queue_only: bool) -> Result<Option<String>, String> {
    let app_source = clipboard_app_source();
    if config::get().sensitive_content_protection
        && SENSITIVE_PASTEBOARD_TYPES
            .iter()
            .any(|pasteboard_type| pasteboard_contains_type(pasteboard_type))
    {
        info!("skip clipboard history item marked as sensitive or transient");
        return Ok(None);
    }
    if is_ignored_app_source(&app_source.name) {
        info!(
            "skip clipboard history from ignored app source: {}",
            app_source.name
        );
        return Ok(None);
    }

    let has_rich_or_text = HTML_PASTEBOARD_TYPES
        .iter()
        .chain(RTF_PASTEBOARD_TYPES.iter())
        .any(|pasteboard_type| pasteboard_contains_type(pasteboard_type))
        || pasteboard_contains_type("public.utf8-plain-text")
        || pasteboard_contains_type("public.utf16-external-plain-text");
    if should_capture_raster_image_before_file(
        &app_source.name,
        pasteboard_contains_type("public.file-url"),
        pasteboard_contains_type("public.png") || pasteboard_contains_type("public.tiff"),
        has_rich_or_text,
    ) {
        if let Some(hash) = insert_image_if_present(&app_source, queue_only)? {
            return Ok(Some(hash));
        }
    }

    if let Some(hash) = insert_file_if_present(&app_source, queue_only) {
        return Ok(Some(hash));
    }

    let text_content = read_text_content()?;
    let mut remaining =
        crate::clipboard_budget::RICH_CAPTURE_BYTES - text_content.as_ref().map_or(0, String::len);
    let html = read_pasteboard_data(HTML_PASTEBOARD_TYPES, remaining)?;
    remaining -= html.as_ref().map_or(0, Vec::len);
    let rtf = read_pasteboard_data(RTF_PASTEBOARD_TYPES, remaining)?;

    if let Some(hash) =
        insert_rich_text_if_present(text_content.as_deref(), html, rtf, &app_source, queue_only)?
    {
        return Ok(Some(hash));
    }

    if let Some(text) = text_content {
        info!("New text clipboard content detected");
        return Ok(clipboard::capture_text_from_app(
            text,
            &app_source.name,
            &app_source.icon_path,
            app_source.capture_request(queue_only),
        ));
    }

    if let Some(hash) = insert_image_if_present(&app_source, queue_only)? {
        return Ok(Some(hash));
    }

    info!("clipboard format is not supported yet");
    Ok(None)
}

fn should_capture_raster_image_before_file(
    app_source: &str,
    has_file_url: bool,
    has_raster_image: bool,
    has_rich_or_text: bool,
) -> bool {
    !app_source.eq_ignore_ascii_case("Finder")
        && has_file_url
        && has_raster_image
        && !has_rich_or_text
}

fn clipboard_app_source() -> AppSource {
    let declared = unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        declared_app_source(pasteboard)
    };
    clipboard_app_source_for(
        pasteboard_contains_type(REMOTE_CLIPBOARD_TYPE),
        declared.as_deref(),
    )
}

fn clipboard_app_source_for(remote: bool, declared: Option<&str>) -> AppSource {
    let mut source = match declared {
        Some("") => AppSource::default(),
        Some(bundle_id) => source_for_bundle_id(bundle_id),
        None if remote => AppSource::default(),
        None => foreground_app_source().unwrap_or_default(),
    };
    source.metadata.is_remote = remote;
    source
}

// A present but empty/invalid declaration means unknown; it must never fall back
// to the receiving Mac's frontmost application. Metadata cannot reject content.
fn declared_app_source(pasteboard: id) -> Option<String> {
    unsafe {
        if pasteboard == nil {
            return None;
        }
        let ns_type = NSString::alloc(nil).init_str(SOURCE_PASTEBOARD_TYPE);
        let result = (|| {
            if nsstring_array_contains(msg_send![pasteboard, types], SOURCE_PASTEBOARD_TYPE) {
                return Some(source_declaration_value(pasteboard, ns_type));
            }
            let items: id = msg_send![pasteboard, pasteboardItems];
            if items != nil {
                let count: usize = msg_send![items, count];
                for index in 0..count {
                    let item: id = msg_send![items, objectAtIndex:index];
                    if item != nil
                        && nsstring_array_contains(msg_send![item, types], SOURCE_PASTEBOARD_TYPE)
                    {
                        return Some(source_declaration_value(item, ns_type));
                    }
                }
            }
            None
        })();
        let _: () = msg_send![ns_type, release];
        result
    }
}

fn source_declaration_value(object: id, ns_type: id) -> String {
    unsafe {
        let data: id = msg_send![object, dataForType:ns_type];
        if data == nil {
            return String::new();
        }
        let len: usize = msg_send![data, length];
        if len == 0 || len > SOURCE_METADATA_LIMIT {
            return String::new();
        }
        let bytes: *const u8 = msg_send![data, bytes];
        if bytes.is_null() {
            return String::new();
        }
        parse_source_declaration(slice::from_raw_parts(bytes, len))
    }
}

fn parse_source_declaration(bytes: &[u8]) -> String {
    if bytes.len() > SOURCE_METADATA_LIMIT {
        return String::new();
    }
    let value = std::str::from_utf8(bytes)
        .unwrap_or_default()
        .trim()
        .trim_end_matches('\0');
    if !value.contains('.')
        || value.split('.').any(str::is_empty)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
    {
        return String::new();
    }
    value.to_string()
}

fn source_for_bundle_id(bundle_id: &str) -> AppSource {
    if let Some(source) = cached_app_source(bundle_id) {
        return source;
    }
    let mut source = AppSource {
        name: bundle_id.to_string(),
        metadata: SourceMetadata {
            bundle_id: bundle_id.to_string(),
            ..Default::default()
        },
        ..Default::default()
    };
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace == nil {
            return source;
        }
        let ns_id = NSString::alloc(nil).init_str(bundle_id);
        let url: id = msg_send![workspace, URLForApplicationWithBundleIdentifier:ns_id];
        let _: () = msg_send![ns_id, release];
        if url == nil {
            return source;
        }
        let path: id = msg_send![url, path];
        if path == nil {
            return source;
        }
        let bundle: id = msg_send![class!(NSBundle), bundleWithURL:url];
        if bundle != nil {
            for key in ["CFBundleDisplayName", "CFBundleName"] {
                let ns_key = NSString::alloc(nil).init_str(key);
                let name: id = msg_send![bundle, objectForInfoDictionaryKey:ns_key];
                let _: () = msg_send![ns_key, release];
                if let Some(name) = nsstring_to_string(name)
                    .map(|name| clean_app_source(&name))
                    .filter(|name| !name.is_empty())
                {
                    source.name = name;
                    break;
                }
            }
        }
        let icon: id = msg_send![workspace, iconForFile:path];
        source.icon_path = save_app_icon_png(icon, bundle_id).unwrap_or_default();
    }
    cache_app_source(bundle_id.to_string(), source.clone());
    source
}

fn cached_app_source(key: &str) -> Option<AppSource> {
    APP_SOURCE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .get(key)
                .filter(|source| {
                    source.icon_path.is_empty() || PathBuf::from(&source.icon_path).is_file()
                })
                .cloned()
        })
}

fn cache_app_source(key: String, source: AppSource) {
    if let Ok(mut cache) = APP_SOURCE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(key, source);
    }
}

fn insert_file_if_present(app_source: &AppSource, queue_only: bool) -> Option<String> {
    let Some(files) = read_file_paths_from_pasteboard() else {
        return None;
    };

    info!("New file clipboard content detected");
    clipboard::capture_file_from_app(
        &files,
        &app_source.name,
        &app_source.icon_path,
        app_source.capture_request(queue_only),
    )
}

fn read_text_content() -> Result<Option<String>, String> {
    let limit = crate::clipboard_budget::TEXT_CAPTURE_BYTES;
    let text = if let Some(bytes) =
        read_pasteboard_data(&["public.utf8-plain-text", "NSStringPboardType"], limit)?
    {
        String::from_utf8(bytes).map_err(|error| error.to_string())?
    } else if let Some(bytes) =
        read_pasteboard_data(&["public.utf16-external-plain-text"], limit * 2 + 2)?
    {
        let big_endian = bytes.starts_with(&[0xfe, 0xff]);
        let start = if bytes.starts_with(&[0xff, 0xfe]) || big_endian {
            2
        } else {
            0
        };
        let units: Vec<_> = bytes[start..]
            .chunks_exact(2)
            .map(|pair| {
                if big_endian {
                    u16::from_be_bytes([pair[0], pair[1]])
                } else {
                    u16::from_le_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|error| error.to_string())?
    } else {
        return Ok(None);
    };
    if text.len() > limit {
        return Err(crate::clipboard_budget::limit_error());
    }
    Ok((!text.is_empty()).then_some(text))
}

fn insert_rich_text_if_present(
    text_content: Option<&str>,
    html: Option<Vec<u8>>,
    rtf: Option<Vec<u8>>,
    app_source: &AppSource,
    queue_only: bool,
) -> Result<Option<String>, String> {
    if html.is_none() && rtf.is_none() {
        return Ok(None);
    }

    let html_text = rich_preview_text(html.as_deref(), None);
    let rtf_text = rich_preview_text(None, rtf.as_deref());
    let clipboard_text = text_content
        .filter(|text| !text.is_empty())
        .map(ToString::to_string);
    let plain_text = clipboard_text
        .clone()
        .or_else(|| html_text.clone())
        .or_else(|| rtf_text.clone())
        .unwrap_or_else(|| "Rich text".to_string());
    let has_meaningful_text = html_text
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty())
        || rtf_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
        || clipboard_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty());

    if has_meaningful_text || rtf.is_some() {
        if plain_text.len() > crate::clipboard_budget::TEXT_CAPTURE_BYTES
            || plain_text
                .len()
                .saturating_add(html.as_ref().map_or(0, Vec::len))
                .saturating_add(rtf.as_ref().map_or(0, Vec::len))
                > crate::clipboard_budget::RICH_CAPTURE_BYTES
        {
            return Err(crate::clipboard_budget::limit_error());
        }
        info!("New rich text clipboard content detected");
        return Ok(clipboard::capture_rich_text_from_app(
            plain_text,
            html,
            rtf,
            None,
            &app_source.name,
            &app_source.icon_path,
            app_source.capture_request(queue_only),
        ));
    }

    Ok(None)
}

fn insert_image_if_present(
    app_source: &AppSource,
    queue_only: bool,
) -> Result<Option<String>, String> {
    // Check NSData length before copying; do not ask arboard to decode an unbounded raster.
    let Some(bytes) = read_pasteboard_data(
        &[
            "com.compuserve.gif",
            "public.png",
            "public.tiff",
            "public.jpeg",
        ],
        crate::clipboard_budget::IMAGE_SOURCE_BYTES,
    )?
    else {
        return Ok(None);
    };
    crate::image_preview::metadata_from_bytes("", &bytes)?;

    info!("New image clipboard content detected");
    Ok(clipboard::capture_image_with_text_and_app(
        &bytes,
        "",
        &app_source.name,
        &app_source.icon_path,
        app_source.capture_request(queue_only),
    ))
}

fn emit_clipboard_event(window: &WebviewWindow, queue_only: bool) {
    if queue_only {
        crate::paste_queue::emit_state(window.app_handle());
    }
    if let Err(e) = window.emit("listen_new_clipboard", ()) {
        error!("Failed to emit event: {}", e);
    }
}

fn pasteboard_change_count() -> isize {
    unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return -1;
        }
        msg_send![pasteboard, changeCount]
    }
}

fn pasteboard_contains_type(target_type: &str) -> bool {
    unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return false;
        }

        if nsstring_array_contains(msg_send![pasteboard, types], target_type) {
            return true;
        }

        let items: id = msg_send![pasteboard, pasteboardItems];
        if items == nil {
            return false;
        }

        let count: usize = msg_send![items, count];
        for index in 0..count {
            let item: id = msg_send![items, objectAtIndex:index];
            if item == nil {
                continue;
            }
            if nsstring_array_contains(msg_send![item, types], target_type) {
                return true;
            }
        }
    }
    false
}

fn foreground_app_source() -> Option<AppSource> {
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace == nil {
            return None;
        }

        let app: id = msg_send![workspace, frontmostApplication];
        if app == nil {
            return None;
        }

        let pid: i32 = msg_send![app, processIdentifier];
        if pid == std::process::id() as i32 {
            return None;
        }

        let raw_name: id = msg_send![app, localizedName];
        let name = nsstring_to_string(raw_name)
            .map(|name| clean_app_source(&name))
            .filter(|name| !name.is_empty())?;

        let bundle_identifier: id = msg_send![app, bundleIdentifier];
        let bundle_identifier = nsstring_to_string(bundle_identifier).unwrap_or_default();
        let bundle_path = running_app_bundle_path(app).unwrap_or_default();
        let cache_key = if !bundle_identifier.is_empty() {
            bundle_identifier.clone()
        } else if !bundle_path.is_empty() {
            bundle_path.clone()
        } else {
            name.clone()
        };

        if let Some(cached) = cached_app_source(&cache_key) {
            return Some(cached);
        }
        let source = AppSource {
            icon_path: save_running_app_icon_png(app, &cache_key).unwrap_or_default(),
            name,
            metadata: SourceMetadata {
                is_remote: false,
                bundle_id: bundle_identifier,
            },
        };
        cache_app_source(cache_key, source.clone());

        Some(source)
    }
}

fn running_app_bundle_path(app: id) -> Option<String> {
    unsafe {
        let bundle_url: id = msg_send![app, bundleURL];
        if bundle_url == nil {
            return None;
        }
        let path: id = msg_send![bundle_url, path];
        nsstring_to_string(path)
    }
}

fn save_running_app_icon_png(app: id, cache_key: &str) -> Option<String> {
    unsafe {
        let icon: id = msg_send![app, icon];
        save_app_icon_png(icon, cache_key)
    }
}

fn save_app_icon_png(icon: id, cache_key: &str) -> Option<String> {
    let hash = stable_hash(cache_key);
    let cache_dir = PathBuf::from(app_runtime_dir(&["app_icons"]));
    if fs::create_dir_all(&cache_dir).is_err() {
        return None;
    }

    let icon_path = cache_dir.join(format!("{hash}-macos.png"));
    if icon_path.exists() {
        return Some(icon_path.to_string_lossy().to_string());
    }

    let png = unsafe {
        if icon == nil {
            return None;
        }

        let tiff_data: id = msg_send![icon, TIFFRepresentation];
        if tiff_data == nil {
            return None;
        }

        let bitmap: id = msg_send![class!(NSBitmapImageRep), imageRepWithData:tiff_data];
        if bitmap == nil {
            return None;
        }

        let properties: id = msg_send![class!(NSDictionary), dictionary];
        let png_data: id = msg_send![bitmap, representationUsingType:4usize properties:properties];
        nsdata_to_bytes(png_data)?
    };

    fs::write(&icon_path, png).ok()?;
    Some(icon_path.to_string_lossy().to_string())
}

fn stable_hash(value: &str) -> u64 {
    let mut hasher = twox_hash::XxHash64::with_seed(0);
    value.hash(&mut hasher);
    hasher.finish()
}

fn clean_app_source(name: &str) -> String {
    name.trim()
        .trim_end_matches(".app")
        .trim_matches('\0')
        .to_string()
}

fn read_file_paths_from_pasteboard() -> Option<Vec<String>> {
    let mut paths = Vec::new();
    read_file_paths_from_pasteboard_items(&mut paths);
    read_file_paths_from_legacy_filenames(&mut paths);
    if paths.is_empty() {
        None
    } else {
        Some(paths)
    }
}

fn read_file_paths_from_pasteboard_items(paths: &mut Vec<String>) {
    unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return;
        }

        let items: id = msg_send![pasteboard, pasteboardItems];
        if items == nil {
            return;
        }

        let count: usize = msg_send![items, count];
        for index in 0..count {
            let item: id = msg_send![items, objectAtIndex:index];
            if item == nil {
                continue;
            }

            for pasteboard_type in [
                "public.file-url",
                "com.apple.pasteboard.promised-file-url",
                "public.url",
            ] {
                let ns_type = NSString::alloc(nil).init_str(pasteboard_type);
                let value: id = msg_send![item, stringForType:ns_type];
                if let Some(raw) = nsstring_to_string(value) {
                    push_file_path(paths, &raw);
                }

                let data: id = msg_send![item, dataForType:ns_type];
                if let Some(raw) = nsdata_to_string(data) {
                    push_file_path(paths, &raw);
                }
                let _: () = msg_send![ns_type, release];
            }
        }
    }
}

fn read_file_paths_from_legacy_filenames(paths: &mut Vec<String>) {
    unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return;
        }

        let ns_type = NSString::alloc(nil).init_str("NSFilenamesPboardType");
        let property_list: id = msg_send![pasteboard, propertyListForType:ns_type];
        let _: () = msg_send![ns_type, release];
        if property_list == nil {
            return;
        }

        let count: usize = msg_send![property_list, count];
        for index in 0..count {
            let value: id = msg_send![property_list, objectAtIndex:index];
            if let Some(raw) = nsstring_to_string(value) {
                push_file_path(paths, &raw);
            }
        }
    }
}

fn push_file_path(paths: &mut Vec<String>, raw: &str) {
    let Some(path) = pasteboard_file_value_to_path(raw) else {
        return;
    };
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn pasteboard_file_value_to_path(raw: &str) -> Option<String> {
    let value = raw.trim().trim_matches('\0').trim();
    if value.is_empty() {
        return None;
    }

    if value.to_ascii_lowercase().starts_with("file:") {
        return file_url_to_path_with_nsurl(value)
            .or_else(|| {
                reqwest::Url::parse(value)
                    .ok()
                    .and_then(|url| url.to_file_path().ok())
                    .map(path_to_string)
            })
            .filter(|path| !is_macos_file_reference_path(path))
            .or_else(|| file_url_to_path_fallback(value).map(path_to_string))
            .filter(|path| !is_macos_file_reference_path(path));
    }

    PathBuf::from(value)
        .is_absolute()
        .then(|| value.to_string())
        .filter(|path| !is_macos_file_reference_path(path))
}

fn file_url_to_path_with_nsurl(value: &str) -> Option<String> {
    unsafe {
        let ns_value = NSString::alloc(nil).init_str(value);
        let url: id = msg_send![class!(NSURL), URLWithString:ns_value];
        let _: () = msg_send![ns_value, release];
        if url == nil {
            return None;
        }

        let is_file_url: bool = msg_send![url, isFileURL];
        if !is_file_url {
            return None;
        }

        let file_path_url: id = msg_send![url, filePathURL];
        if file_path_url == nil {
            return None;
        }

        let path: id = msg_send![file_path_url, path];
        nsstring_to_string(path)
            .map(|path| path.trim().trim_matches('\0').to_string())
            .filter(|path| PathBuf::from(path).is_absolute())
    }
}

fn is_macos_file_reference_path(path: &str) -> bool {
    path == "/.file" || path.starts_with("/.file/")
}

fn file_url_to_path_fallback(value: &str) -> Option<PathBuf> {
    let without_scheme = value
        .strip_prefix("file://localhost")
        .or_else(|| value.strip_prefix("file://"))
        .or_else(|| value.strip_prefix("file:"))?;
    Some(PathBuf::from(percent_decode(without_scheme)))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn nsdata_to_string(data: id) -> Option<String> {
    if data == nil {
        return None;
    }
    unsafe {
        let len: usize = msg_send![data, length];
        if len == 0 {
            return None;
        }
        let bytes: *const u8 = msg_send![data, bytes];
        if bytes.is_null() {
            return None;
        }
        Some(
            String::from_utf8_lossy(slice::from_raw_parts(bytes, len))
                .trim_matches('\0')
                .to_string(),
        )
    }
}

fn nsdata_to_bytes(data: id) -> Option<Vec<u8>> {
    if data == nil {
        return None;
    }
    unsafe {
        let len: usize = msg_send![data, length];
        if len == 0 {
            return None;
        }
        let bytes: *const u8 = msg_send![data, bytes];
        if bytes.is_null() {
            return None;
        }
        Some(slice::from_raw_parts(bytes, len).to_vec())
    }
}

fn nsstring_array_contains(array: id, target: &str) -> bool {
    if array == nil {
        return false;
    }
    unsafe {
        let count: usize = msg_send![array, count];
        for index in 0..count {
            let value: id = msg_send![array, objectAtIndex:index];
            if nsstring_to_string(value).as_deref() == Some(target) {
                return true;
            }
        }
    }
    false
}

fn nsstring_to_string(value: id) -> Option<String> {
    if value == nil {
        return None;
    }
    unsafe {
        let ptr: *const c_char = msg_send![value, UTF8String];
        if ptr.is_null() {
            return None;
        }
        Some(CStr::from_ptr(ptr).to_string_lossy().to_string())
    }
}

fn read_pasteboard_data(types: &[&str], limit: usize) -> Result<Option<Vec<u8>>, String> {
    for pasteboard_type in types {
        if let Some(data) = read_pasteboard_data_for_type(pasteboard_type, limit)? {
            if !data.is_empty() {
                return Ok(Some(data));
            }
        }
    }
    Ok(None)
}

fn read_pasteboard_data_for_type(
    pasteboard_type: &str,
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return Ok(None);
        }

        let ns_type = NSString::alloc(nil).init_str(pasteboard_type);
        let data: id = msg_send![pasteboard, dataForType: ns_type];
        let _: () = msg_send![ns_type, release];
        if data == nil {
            return Ok(None);
        }

        let len: usize = msg_send![data, length];
        if len == 0 {
            return Ok(None);
        }
        if len > limit {
            return Err(crate::clipboard_budget::limit_error());
        }
        let bytes: *const u8 = msg_send![data, bytes];
        if bytes.is_null() {
            return Ok(None);
        }
        Ok(Some(slice::from_raw_parts(bytes, len).to_vec()))
    }
}

fn rich_preview_text(html: Option<&[u8]>, rtf: Option<&[u8]>) -> Option<String> {
    if let Some(html) = html {
        let raw = String::from_utf8_lossy(html).trim_matches('\0').to_string();
        let document = Html::parse_fragment(&raw);
        let text = document
            .root_element()
            .text()
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !text.is_empty() {
            return Some(text);
        }
    }

    rtf.and_then(|bytes| unsafe {
        let data: id = msg_send![class!(NSData), dataWithBytes:bytes.as_ptr() length:bytes.len()];
        let attributed: id = msg_send![class!(NSAttributedString), alloc];
        let attributed: id =
            msg_send![attributed, initWithRTF:data documentAttributes:std::ptr::null_mut::<id>()];
        if attributed == nil {
            return None;
        }
        let value: id = msg_send![attributed, string];
        let result = nsstring_to_string(value).filter(|text| !text.trim().is_empty());
        let _: () = msg_send![attributed, release];
        result
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn universal_clipboard_resolves_an_explicit_remote_source_app() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let previous = crate::GLOBAL_APP_DATA_DIR
            .lock()
            .unwrap()
            .replace(root.path().to_string_lossy().into_owned());
        objc::rc::autoreleasepool(|| {
            let source = super::clipboard_app_source_for(true, Some("com.apple.finder"));
            assert!(
                !source.name.is_empty(),
                "the remote source declaration was discarded"
            );
            assert!(
                !source.icon_path.is_empty(),
                "the installed source app has no icon"
            );
            assert!(source.metadata.is_remote);
            assert_eq!(source.metadata.bundle_id, "com.apple.finder");
            assert!(std::path::Path::new(&source.icon_path).starts_with(root.path()));
            // The cached application identity must not leak the remote flag.
            let local = super::clipboard_app_source_for(false, Some("com.apple.finder"));
            assert!(!local.metadata.is_remote);
        });
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = previous;
    }

    #[test]
    fn universal_clipboard_unknown_source_never_uses_the_receivers_foreground_app() {
        for declared in [None, Some("")] {
            let source = super::clipboard_app_source_for(true, declared);
            assert!(source.metadata.is_remote);
            assert!(source.name.is_empty());
            assert!(source.icon_path.is_empty());
            assert!(source.metadata.bundle_id.is_empty());
        }
        let unknown_local = super::clipboard_app_source_for(false, Some(""));
        assert!(unknown_local.name.is_empty());
        assert!(!unknown_local.metadata.is_remote);
    }

    #[test]
    fn universal_clipboard_reads_declared_source_from_a_native_pasteboard() {
        objc::rc::autoreleasepool(|| unsafe {
            use cocoa::base::{id, nil};
            use cocoa::foundation::NSString;
            use objc::{class, msg_send, sel, sel_impl};
            let board: id = msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
            assert_ne!(board, nil);
            assert_eq!(super::declared_app_source(board), None);
            let ns_type = NSString::alloc(nil).init_str(super::SOURCE_PASTEBOARD_TYPE);
            let types: id = msg_send![class!(NSArray), arrayWithObject:ns_type];
            for bytes in [
                b"com.apple.finder".as_slice(),
                b"",
                b"/Applications/Unsafe.app",
                &[0xff],
                &vec![b'x'; 2048],
            ] {
                let _: isize = msg_send![board, declareTypes:types owner:nil];
                let data: id =
                    msg_send![class!(NSData), dataWithBytes:bytes.as_ptr() length:bytes.len()];
                let ok: bool = msg_send![board, setData:data forType:ns_type];
                assert!(ok);
                let expected = if bytes == b"com.apple.finder" {
                    "com.apple.finder"
                } else {
                    ""
                };
                assert_eq!(super::declared_app_source(board).as_deref(), Some(expected));
            }
            let _: () = msg_send![ns_type, release];
            let _: () = msg_send![board, releaseGlobally];
        });
    }

    use super::{
        pasteboard_file_value_to_path, push_file_path, rich_preview_text,
        should_capture_raster_image_before_file,
    };

    #[test]
    fn raster_image_with_temporary_file_is_captured_as_image() {
        assert!(should_capture_raster_image_before_file(
            "Microsoft Word",
            true,
            true,
            false,
        ));
        assert!(should_capture_raster_image_before_file(
            "Word", true, true, false,
        ));
        assert!(should_capture_raster_image_before_file(
            "Universal Control",
            true,
            true,
            false,
        ));
        assert!(!should_capture_raster_image_before_file(
            "Finder", true, true, false,
        ));
        assert!(!should_capture_raster_image_before_file(
            "Microsoft Word",
            true,
            false,
            false,
        ));
        assert!(!should_capture_raster_image_before_file(
            "Microsoft Word",
            true,
            true,
            true,
        ));
    }

    #[test]
    fn rtf_only_preview_contains_readable_text_without_control_words() {
        let rtf = br"{\rtf1\ansi\deff0{\fonttbl{\f0 Helvetica;}}\f0\fs24 Hello\par world}";
        assert_eq!(
            rich_preview_text(None, Some(rtf)),
            Some("Hello\nworld".into())
        );
    }

    #[test]
    fn converts_file_url_to_path() {
        assert_eq!(
            pasteboard_file_value_to_path("file:///Users/test/My%20File.md").as_deref(),
            Some("/Users/test/My File.md")
        );
    }

    #[test]
    fn keeps_absolute_path_from_legacy_filename_list() {
        assert_eq!(
            pasteboard_file_value_to_path("/Users/test/archive.zip").as_deref(),
            Some("/Users/test/archive.zip")
        );
    }

    #[test]
    fn ignores_non_file_urls() {
        assert!(pasteboard_file_value_to_path("https://example.com/file.txt").is_none());
    }

    #[test]
    fn does_not_store_macos_file_reference_url_as_path() {
        if let Some(path) = pasteboard_file_value_to_path("file:///.file/id=6571367.38881807") {
            assert!(!path.starts_with("/.file/"));
        }
    }

    #[test]
    fn deduplicates_paths_from_multiple_pasteboard_formats() {
        let mut paths = Vec::new();
        push_file_path(&mut paths, "file:///Users/test/demo.txt");
        push_file_path(&mut paths, "/Users/test/demo.txt");
        assert_eq!(paths, vec!["/Users/test/demo.txt"]);
    }
}
