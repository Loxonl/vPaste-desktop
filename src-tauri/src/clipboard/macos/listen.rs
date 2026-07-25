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
use tauri::{Emitter, WebviewWindow};

const READ_ATTEMPTS: usize = 3;
const INITIAL_RETRY_DELAY_MS: u64 = 25;
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 500;

const HTML_PASTEBOARD_TYPES: &[&str] = &[
    "public.html",
    "Apple HTML pasteboard type",
    "NSHTMLPboardType",
];
const RTF_PASTEBOARD_TYPES: &[&str] =
    &["public.rtf", "Apple RTF pasteboard type", "NSRTFPboardType"];
const REMOTE_CLIPBOARD_TYPE: &str = "com.apple.is-remote-clipboard";

static APP_SOURCE_CACHE: OnceLock<Mutex<HashMap<String, AppSource>>> = OnceLock::new();

#[derive(Clone, Debug, Default)]
struct AppSource {
    name: String,
    icon_path: String,
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

        loop {
            // Cocoa returns autoreleased pasteboard, workspace, image, and data objects.
            // Drain them before this long-lived listener thread goes back to sleep.
            let should_emit = autoreleasepool(|| {
                poll_clipboard_once(&mut system_clipboard, &mut last_change_count)
            });
            if should_emit {
                emit_clipboard_event(&window);
            }

            thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS));
        }
    });
}

fn poll_clipboard_once(system_clipboard: &mut Clipboard, last_change_count: &mut isize) -> bool {
    if CLIPBOARD_IGNORE_NEXT_CHANGE.swap(false, Ordering::SeqCst) {
        info!("skip internal clipboard change");
        *last_change_count = pasteboard_change_count();
        return false;
    }

    let current_change_count = pasteboard_change_count();
    if current_change_count == *last_change_count {
        return false;
    }
    *last_change_count = current_change_count;

    if is_clipboard_history_paused() {
        info!("skip clipboard history while recording is paused");
        return false;
    }

    let start = Instant::now();
    if parse_with_retry(system_clipboard) {
        info!("clipboard parsed in {}ms", start.elapsed().as_millis());
        true
    } else {
        info!("clipboard ignored in {}ms", start.elapsed().as_millis());
        false
    }
}

fn parse_with_retry(system_clipboard: &mut Clipboard) -> bool {
    for attempt in 0..READ_ATTEMPTS {
        match parse(system_clipboard) {
            Ok(parsed) => return parsed,
            Err(err) => {
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
    false
}

fn parse(system_clipboard: &mut Clipboard) -> Result<bool, String> {
    let app_source = clipboard_app_source();
    if is_ignored_app_source(&app_source.name) {
        info!(
            "skip clipboard history from ignored app source: {}",
            app_source.name
        );
        return Ok(false);
    }

    if insert_file_if_present(&app_source) {
        return Ok(true);
    }

    let text_content = read_text_content(system_clipboard);
    let html = read_pasteboard_data(HTML_PASTEBOARD_TYPES);
    let rtf = read_pasteboard_data(RTF_PASTEBOARD_TYPES);

    if insert_rich_text_if_present(text_content.as_deref(), html, rtf, &app_source) {
        return Ok(true);
    }

    if let Some(text) = text_content {
        info!("New text clipboard content detected");
        clipboard::insert_text_from_app(text, &app_source.name, &app_source.icon_path);
        return Ok(true);
    }

    if insert_image_if_present(system_clipboard, &app_source)? {
        return Ok(true);
    }

    info!("clipboard format is not supported yet");
    Ok(false)
}

fn clipboard_app_source() -> AppSource {
    if pasteboard_contains_type(REMOTE_CLIPBOARD_TYPE) {
        info!("skip source app capture for remote synced clipboard item");
        return AppSource::default();
    }
    foreground_app_source().unwrap_or_default()
}

fn insert_file_if_present(app_source: &AppSource) -> bool {
    let Some(files) = read_file_paths_from_pasteboard() else {
        return false;
    };

    info!("New file clipboard content detected");
    clipboard::insert_file_from_app(&files, &app_source.name, &app_source.icon_path);
    true
}

fn read_text_content(system_clipboard: &mut Clipboard) -> Option<String> {
    system_clipboard
        .get_text()
        .ok()
        .filter(|text| !text.is_empty())
}

fn insert_rich_text_if_present(
    text_content: Option<&str>,
    html: Option<Vec<u8>>,
    rtf: Option<Vec<u8>>,
    app_source: &AppSource,
) -> bool {
    if html.is_none() && rtf.is_none() {
        return false;
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
        info!("New rich text clipboard content detected");
        clipboard::insert_rich_text_from_app(
            plain_text,
            html,
            rtf,
            None,
            &app_source.name,
            &app_source.icon_path,
        );
        return true;
    }

    false
}

fn insert_image_if_present(
    system_clipboard: &mut Clipboard,
    app_source: &AppSource,
) -> Result<bool, String> {
    let image = match system_clipboard.get_image() {
        Ok(image) => image,
        Err(_) => return Ok(false),
    };

    let width = image.width as u32;
    let height = image.height as u32;
    let raw_bytes = image.bytes.into_owned();
    let img_buffer =
        image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(width, height, raw_bytes)
            .ok_or_else(|| "image buffer size does not match dimensions".to_string())?;

    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    img_buffer
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|err| format!("encode image as PNG failed: {}", err))?;

    info!("New image clipboard content detected");
    clipboard::insert_image_with_text_and_app(&bytes, "", &app_source.name, &app_source.icon_path);
    Ok(true)
}

fn emit_clipboard_event(window: &WebviewWindow) {
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

        if let Some(cached) = APP_SOURCE_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .ok()
            .and_then(|cache| cache.get(&cache_key).cloned())
        {
            return Some(cached);
        }

        let source = AppSource {
            icon_path: save_running_app_icon_png(app, &cache_key).unwrap_or_default(),
            name,
        };

        if let Ok(mut cache) = APP_SOURCE_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
        {
            cache.insert(cache_key, source.clone());
        }

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
        let icon: id = msg_send![app, icon];
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

fn read_pasteboard_data(types: &[&str]) -> Option<Vec<u8>> {
    for pasteboard_type in types {
        if let Some(data) = read_pasteboard_data_for_type(pasteboard_type) {
            if !data.is_empty() {
                return Some(data);
            }
        }
    }
    None
}

fn read_pasteboard_data_for_type(pasteboard_type: &str) -> Option<Vec<u8>> {
    unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return None;
        }

        let ns_type = NSString::alloc(nil).init_str(pasteboard_type);
        let data: id = msg_send![pasteboard, dataForType: ns_type];
        let _: () = msg_send![ns_type, release];
        if data == nil {
            return None;
        }

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

    rtf.map(|bytes| String::from_utf8_lossy(bytes).to_string())
        .map(|text| {
            text.replace("\\par", "\n")
                .replace(['{', '}'], "")
                .split_whitespace()
                .take(80)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{pasteboard_file_value_to_path, push_file_path};

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
