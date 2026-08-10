use std::collections::HashMap;
use std::fs;
use std::thread;
use std::time::{Duration, Instant};

use clipboard_win::formats;
use clipboard_win::formats::{CF_DIB, CF_DIBV5};
use clipboard_win::get_clipboard;
use clipboard_win::is_format_avail;
use clipboard_win::monitor::Monitor;
use log::{error, info};
use tauri::{Emitter, WebviewWindow};

use crate::clipboard;
use crate::clipboard::windows::image_convert;
use crate::config;
use crate::{
    app_runtime_dir, CLIPBOARD_HISTORY_PAUSED, CLIPBOARD_IGNORE_CHANGES_UNTIL,
    CLIPBOARD_IGNORE_NEXT_CHANGE, CLIPBOARD_INTERNAL_MARKER,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};

const INTERNAL_CLIPBOARD_MARKER_BYTES: usize = 16;

const READ_ATTEMPTS: usize = 10;
const INITIAL_RETRY_DELAY_MS: u64 = 40;
const MAX_RETRY_DELAY_MS: u64 = 250;
const CLIPBOARD_SETTLE_DELAY_MS: u64 = 120;
pub(crate) const VPASTE_INTERNAL_CLIPBOARD_FORMAT: &str = "vPaste Internal Clipboard";

static APP_SOURCE_CACHE: OnceLock<Mutex<HashMap<String, AppSource>>> = OnceLock::new();

#[derive(Clone, Debug, Default)]
struct AppSource {
    name: String,
    icon_path: String,
}

#[derive(Default)]
struct ClipboardSequenceDeduper {
    last_processed: Option<u32>,
}

impl ClipboardSequenceDeduper {
    fn should_process(&mut self, sequence: u32) -> bool {
        if sequence == 0 {
            return true;
        }
        if self.last_processed == Some(sequence) {
            return false;
        }
        self.last_processed = Some(sequence);
        true
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn should_skip_internal_clipboard_change() -> bool {
    CLIPBOARD_IGNORE_NEXT_CHANGE.swap(false, Ordering::SeqCst)
}

fn is_internal_clipboard_window_active() -> bool {
    now_millis() < CLIPBOARD_IGNORE_CHANGES_UNTIL.load(Ordering::SeqCst)
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
        let mut monitor = match Monitor::new() {
            Ok(monitor) => monitor,
            Err(err) => {
                error!("failed to start clipboard monitor: {:?}", err);
                return;
            }
        };
        let mut sequence_deduper = ClipboardSequenceDeduper::default();

        while matches!(monitor.recv(), Ok(true)) {
            if should_skip_internal_clipboard_change() {
                info!("skip internal clipboard change");
                continue;
            }
            if is_clipboard_history_paused() {
                info!("skip clipboard history while recording is paused");
                continue;
            }
            thread::sleep(Duration::from_millis(CLIPBOARD_SETTLE_DELAY_MS));
            let sequence = clipboard_sequence_number();
            if !sequence_deduper.should_process(sequence) {
                info!("skip duplicate clipboard sequence {}", sequence);
                continue;
            }
            let app_source = clipboard_app_source().unwrap_or_default();
            if is_ignored_app_source(&app_source.name) {
                info!(
                    "skip clipboard history from ignored app source: {}",
                    app_source.name
                );
                continue;
            }
            let start = Instant::now();
            if parse_with_retry(&app_source) {
                info!("clipboard parsed in {}ms", start.elapsed().as_millis());
                if let Err(err) = window.emit("listen_new_clipboard", "") {
                    error!("failed to emit clipboard refresh event: {:?}", err);
                }
            } else {
                info!("clipboard ignored in {}ms", start.elapsed().as_millis());
            }
        }
    });
}

fn parse_with_retry(app_source: &AppSource) -> bool {
    for attempt in 0..READ_ATTEMPTS {
        match parse(attempt + 1 < READ_ATTEMPTS, app_source) {
            Ok(parsed) => return parsed,
            Err(err) => {
                let delay = (INITIAL_RETRY_DELAY_MS * (attempt as u64 + 1)).min(MAX_RETRY_DELAY_MS);
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

fn parse(should_retry_file_hint: bool, app_source: &AppSource) -> Result<bool, String> {
    if has_internal_clipboard_marker() {
        info!("skip vPaste internal clipboard payload");
        return Ok(false);
    }

    if is_internal_clipboard_window_active() && is_vpaste_app_source(&app_source.name) {
        info!("skip vPaste foreground clipboard payload during internal window");
        return Ok(false);
    }

    if is_internal_clipboard_window_active() {
        info!("internal clipboard window active without vPaste marker; parsing clipboard payload");
    }

    if config::get().sensitive_content_protection && has_sensitive_clipboard_marker() {
        info!("skip clipboard history item marked as sensitive by system clipboard formats");
        return Ok(false);
    }

    let text_content: Option<String> = if is_format_avail(formats::Unicode.into()) {
        get_clipboard::<String, _>(formats::Unicode).ok()
    } else {
        None
    }
    .filter(|text| !looks_like_cf_html_header_text(text));
    let html = read_registered_raw_format("HTML Format");
    let rtf = read_registered_raw_format("Rich Text Format");
    let png = read_registered_raw_format("PNG");
    let gif = read_registered_raw_format("GIF").or_else(|| read_registered_raw_format("image/gif"));

    if let Some(gif) = gif {
        if is_gif_bytes(&gif) {
            clipboard::insert_image_with_text_and_app(
                &gif,
                text_content.as_deref().unwrap_or(""),
                &app_source.name,
                &app_source.icon_path,
            );
            return Ok(true);
        }
    }

    if should_ignore_excel_blank_bitmap_phase(
        &app_source.name,
        text_content.as_deref(),
        html.is_some(),
        rtf.is_some(),
        png.is_some(),
    ) {
        info!("ignore transient blank Excel bitmap payload");
        return Ok(false);
    }

    if html.is_some() || rtf.is_some() {
        let html_text = rich_preview_text(html.as_deref(), None);
        let rtf_text = rich_preview_text(None, rtf.as_deref());
        let clipboard_text = text_content
            .clone()
            .filter(|text: &String| !text.trim().is_empty());
        let plain_text =
            preferred_rich_plain_text(clipboard_text.clone(), html_text.clone(), rtf_text.clone());
        let local_images = html
            .as_deref()
            .map(local_images_from_html)
            .unwrap_or_default();
        let remote_gif_images = html
            .as_deref()
            .map(remote_gif_images_from_html)
            .unwrap_or_default();
        let has_meaningful_text = html_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
            || rtf_text
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
            || (!local_images.is_empty()
                && clipboard_text
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty()));
        let local_gif_candidate = if local_images.len() == 1
            && !has_meaningful_text
            && local_images[0]
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("gif"))
        {
            Some(fs::read(&local_images[0]))
        } else {
            None
        };
        let has_local_gif = local_gif_candidate
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .is_some_and(|bytes| is_gif_bytes(bytes));

        if should_ignore_empty_rich_content(
            text_content.as_deref(),
            html_text.as_deref(),
            rtf_text.as_deref(),
            local_images.len(),
            remote_gif_images.len(),
            png.is_some(),
        ) {
            info!("ignore empty rich clipboard payload");
            return Ok(false);
        }

        if should_prefer_bitmap_for_rich_content(
            text_content.as_deref(),
            local_images.len(),
            has_local_gif,
        ) {
            if is_format_avail(CF_DIBV5) {
                return read_bitmap(CF_DIBV5, "CF_DIBV5", None, app_source);
            }
            if is_format_avail(CF_DIB) {
                return read_bitmap(CF_DIB, "CF_DIB", None, app_source);
            }
            if let Some(png) = png.as_ref() {
                clipboard::insert_image_with_text_and_app(
                    png,
                    "",
                    &app_source.name,
                    &app_source.icon_path,
                );
                return Ok(true);
            }
        }

        if local_images.len() == 1 && !has_meaningful_text {
            let image_bytes = local_gif_candidate
                .unwrap_or_else(|| fs::read(&local_images[0]))
                .map_err(|err| format!("read local html image failed: {}", err))?;
            image::load_from_memory(&image_bytes)
                .map_err(|err| format!("decode local html image failed: {}", err))?;
            if has_local_gif {
                info!("preserve local GIF clipboard image before bitmap fallback");
            }
            clipboard::insert_image_with_text_and_app(
                &image_bytes,
                "",
                &app_source.name,
                &app_source.icon_path,
            );
            return Ok(true);
        }

        if remote_gif_images.len() == 1 && !has_meaningful_text {
            if let Some(image_bytes) = fetch_remote_gif_bytes(&remote_gif_images[0]) {
                clipboard::insert_image_with_text_and_app(
                    &image_bytes,
                    "",
                    &app_source.name,
                    &app_source.icon_path,
                );
                return Ok(true);
            }
        }

        if has_meaningful_text || !local_images.is_empty() {
            clipboard::insert_rich_text_from_app(
                if has_meaningful_text {
                    plain_text
                } else {
                    "Rich text".to_string()
                },
                html,
                rtf,
                png,
                &app_source.name,
                &app_source.icon_path,
            );
            return Ok(true);
        }
    }

    if is_format_avail(CF_DIBV5.into()) {
        return read_bitmap(CF_DIBV5, "CF_DIBV5", text_content.as_deref(), &app_source);
    }

    if is_format_avail(CF_DIB.into()) {
        return read_bitmap(CF_DIB, "CF_DIB", text_content.as_deref(), &app_source);
    }

    if let Some(png) = png {
        clipboard::insert_image_with_text_and_app(
            &png,
            text_content.as_deref().unwrap_or(""),
            &app_source.name,
            &app_source.icon_path,
        );
        return Ok(true);
    }

    if is_format_avail(formats::FileList.into()) {
        let files = get_clipboard(formats::FileList)
            .map_err(|err| format!("read file list failed: {:?}", err))?;
        clipboard::insert_file_from_app(&files, &app_source.name, &app_source.icon_path);
        return Ok(true);
    }

    if is_format_avail(formats::Unicode.into()) {
        let text: String = text_content
            .map(Ok)
            .unwrap_or_else(|| get_clipboard(formats::Unicode))
            .map_err(|err| format!("read unicode text failed: {:?}", err))?;
        if !has_visible_text(Some(&text)) {
            return Ok(false);
        }
        if should_retry_file_hint && is_probable_file_clipboard_placeholder(&text) {
            return Err("file list format is not ready yet".to_string());
        }
        clipboard::insert_text_from_app(text, &app_source.name, &app_source.icon_path);
        return Ok(true);
    }

    info!("clipboard format is not supported yet");
    Ok(false)
}

fn registered_format_code(name: &str) -> Option<u32> {
    clipboard_win::raw::register_format(name).map(|code| code.get())
}

fn read_registered_raw_format(name: &str) -> Option<Vec<u8>> {
    let format = registered_format_code(name)?;
    if !is_format_avail(format) {
        return None;
    }
    get_clipboard(formats::RawData(format))
        .ok()
        .filter(|bytes: &Vec<u8>| !bytes.is_empty())
}

fn has_registered_format(name: &str) -> bool {
    registered_format_code(name)
        .map(|format| is_format_avail(format))
        .unwrap_or(false)
}

fn has_internal_clipboard_marker() -> bool {
    let Some(bytes) = read_registered_raw_format(VPASTE_INTERNAL_CLIPBOARD_FORMAT) else {
        return false;
    };
    if bytes.len() != INTERNAL_CLIPBOARD_MARKER_BYTES {
        return false;
    }

    CLIPBOARD_INTERNAL_MARKER
        .lock()
        .map(|marker| bytes.as_slice() == marker.as_slice())
        .unwrap_or(false)
}

fn has_sensitive_clipboard_marker() -> bool {
    if has_registered_format("Clipboard Viewer Ignore") {
        return true;
    }

    if has_registered_format("ExcludeClipboardContentFromMonitorProcessing") {
        return true;
    }

    if !has_registered_format("CanIncludeInClipboardHistory") {
        return false;
    }

    match read_registered_raw_format("CanIncludeInClipboardHistory") {
        Some(bytes) => serialized_dword_is_zero(&bytes),
        None => {
            info!("CanIncludeInClipboardHistory is present but unreadable; skipping for privacy");
            true
        }
    }
}

fn serialized_dword_is_zero(bytes: &[u8]) -> bool {
    if bytes.len() >= 4 {
        return u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) == 0;
    }

    !bytes.is_empty() && bytes.iter().all(|byte| *byte == 0)
}

fn rich_preview_text(html: Option<&[u8]>, rtf: Option<&[u8]>) -> Option<String> {
    if let Some(html) = html {
        let fragment = cf_html_fragment(html);
        let document = scraper::Html::parse_fragment(&fragment);
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

    rtf.and_then(rtf_plain_text)
}

fn preferred_rich_plain_text(
    clipboard_text: Option<String>,
    html_text: Option<String>,
    rtf_text: Option<String>,
) -> String {
    clipboard_text
        .filter(|text| !text.trim().is_empty())
        .or_else(|| html_text.filter(|text| !text.trim().is_empty()))
        .or_else(|| rtf_text.filter(|text| !text.trim().is_empty()))
        .unwrap_or_default()
}

fn has_visible_text(text: Option<&str>) -> bool {
    text.is_some_and(|text| !clipboard::is_semantically_blank_text(text))
}

fn should_ignore_excel_blank_bitmap_phase(
    app_source: &str,
    clipboard_text: Option<&str>,
    has_html: bool,
    has_rtf: bool,
    has_png: bool,
) -> bool {
    app_source.eq_ignore_ascii_case("EXCEL")
        && clipboard_text.is_none_or(clipboard::is_semantically_blank_text)
        && !has_html
        && !has_rtf
        && !has_png
}

fn should_ignore_empty_rich_content(
    clipboard_text: Option<&str>,
    html_text: Option<&str>,
    rtf_text: Option<&str>,
    local_image_count: usize,
    remote_gif_count: usize,
    has_png: bool,
) -> bool {
    !has_visible_text(clipboard_text)
        && !has_visible_text(html_text)
        && !has_visible_text(rtf_text)
        && local_image_count == 0
        && remote_gif_count == 0
        && !has_png
}

fn should_prefer_bitmap_for_rich_content(
    clipboard_text: Option<&str>,
    local_image_count: usize,
    has_local_gif: bool,
) -> bool {
    !has_local_gif
        && local_image_count > 0
        && clipboard_text.is_none_or(|text| text.trim().is_empty())
}

fn rtf_plain_text(bytes: &[u8]) -> Option<String> {
    #[derive(Clone, Copy)]
    struct State {
        skip_destination: bool,
        unicode_fallback_len: usize,
    }

    fn is_destination(word: &str) -> bool {
        matches!(
            word,
            "fonttbl"
                | "colortbl"
                | "stylesheet"
                | "info"
                | "pict"
                | "object"
                | "header"
                | "footer"
                | "footnote"
                | "annotation"
                | "xmlnstbl"
                | "generator"
                | "datastore"
                | "themedata"
                | "colorschememapping"
                | "listtable"
                | "listoverridetable"
        )
    }

    let mut states = vec![State {
        skip_destination: false,
        unicode_fallback_len: 1,
    }];
    let mut output = String::new();
    let mut index = 0;
    let mut unicode_fallback_remaining = 0;

    while index < bytes.len() {
        if output.len() >= 8 * 1024 {
            break;
        }
        match bytes[index] {
            b'{' => {
                states.push(*states.last().unwrap());
                index += 1;
            }
            b'}' => {
                if states.len() > 1 {
                    states.pop();
                }
                index += 1;
            }
            b'\\' => {
                index += 1;
                if index >= bytes.len() {
                    break;
                }
                let state = states.last_mut().unwrap();
                match bytes[index] {
                    b'\\' | b'{' | b'}' => {
                        if !state.skip_destination {
                            if unicode_fallback_remaining > 0 {
                                unicode_fallback_remaining -= 1;
                            } else {
                                output.push(bytes[index] as char);
                            }
                        }
                        index += 1;
                    }
                    b'\'' if index + 2 < bytes.len() => {
                        if !state.skip_destination {
                            if unicode_fallback_remaining > 0 {
                                unicode_fallback_remaining -= 1;
                            } else if let Ok(hex) =
                                std::str::from_utf8(&bytes[index + 1..index + 3])
                            {
                                if let Ok(value) = u8::from_str_radix(hex, 16) {
                                    output.push(value as char);
                                }
                            }
                        }
                        index += 3;
                    }
                    b'*' => {
                        state.skip_destination = true;
                        index += 1;
                    }
                    symbol if !symbol.is_ascii_alphabetic() => {
                        if !state.skip_destination && unicode_fallback_remaining == 0 {
                            match symbol {
                                b'~' => output.push(' '),
                                b'_' => output.push('-'),
                                _ => {}
                            }
                        }
                        index += 1;
                    }
                    _ => {
                        let word_start = index;
                        while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                            index += 1;
                        }
                        let word = std::str::from_utf8(&bytes[word_start..index]).unwrap_or("");
                        let negative = index < bytes.len() && bytes[index] == b'-';
                        if negative {
                            index += 1;
                        }
                        let number_start = index;
                        while index < bytes.len() && bytes[index].is_ascii_digit() {
                            index += 1;
                        }
                        let number = std::str::from_utf8(&bytes[number_start..index])
                            .ok()
                            .and_then(|value| value.parse::<i32>().ok())
                            .map(|value| if negative { -value } else { value });
                        if index < bytes.len() && bytes[index] == b' ' {
                            index += 1;
                        }

                        if is_destination(word) {
                            state.skip_destination = true;
                            continue;
                        }
                        if state.skip_destination {
                            continue;
                        }
                        match word {
                            "uc" => {
                                state.unicode_fallback_len = number.unwrap_or(1).max(0) as usize;
                            }
                            "u" => {
                                if let Some(value) = number {
                                    let code_point = (value as i16 as u16) as u32;
                                    if let Some(character) = char::from_u32(code_point) {
                                        output.push(character);
                                    }
                                    unicode_fallback_remaining = state.unicode_fallback_len;
                                }
                            }
                            "par" | "line" => output.push('\n'),
                            "tab" | "cell" => output.push('\t'),
                            "emdash" => output.push('—'),
                            "endash" => output.push('–'),
                            "bullet" => output.push('•'),
                            _ => {}
                        }
                    }
                }
            }
            b'\r' | b'\n' => index += 1,
            byte => {
                let state = states.last().unwrap();
                if !state.skip_destination {
                    if unicode_fallback_remaining > 0 {
                        unicode_fallback_remaining -= 1;
                    } else {
                        output.push(byte as char);
                    }
                }
                index += 1;
            }
        }
    }

    let normalized = output
        .split_whitespace()
        .take(80)
        .collect::<Vec<_>>()
        .join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

fn local_images_from_html(html: &[u8]) -> Vec<PathBuf> {
    let fragment = cf_html_fragment(html);
    let document = scraper::Html::parse_fragment(&fragment);
    let Ok(selector) = scraper::Selector::parse("img") else {
        return Vec::new();
    };
    document
        .select(&selector)
        .filter_map(|element| element.value().attr("src"))
        .filter_map(file_url_to_path)
        .collect()
}

fn remote_gif_images_from_html(html: &[u8]) -> Vec<String> {
    let fragment = cf_html_fragment(html);
    let document = scraper::Html::parse_fragment(&fragment);
    let Ok(selector) = scraper::Selector::parse("img") else {
        return Vec::new();
    };
    document
        .select(&selector)
        .filter_map(|element| element.value().attr("src"))
        .map(str::trim)
        .filter(|src| is_likely_remote_gif_url(src))
        .map(ToString::to_string)
        .collect()
}

fn is_likely_remote_gif_url(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return false;
    }
    lower.contains(".gif")
}

fn is_gif_bytes(bytes: &[u8]) -> bool {
    infer::get(bytes)
        .map(|kind| kind.mime_type() == "image/gif")
        .unwrap_or_else(|| bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
}

fn fetch_remote_gif_bytes(url: &str) -> Option<Vec<u8>> {
    const MAX_GIF_BYTES: u64 = 25 * 1024 * 1024;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1800))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .ok()?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/gif,image/*,*/*;q=0.8")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_GIF_BYTES)
    {
        return None;
    }
    let final_url = response.url().clone();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = response.bytes().ok()?.to_vec();
    if bytes.len() as u64 > MAX_GIF_BYTES {
        return None;
    }
    let final_path = final_url.path().to_ascii_lowercase();
    if is_gif_bytes(&bytes) || content_type.contains("gif") || final_path.contains(".gif") {
        info!("fetched remote gif clipboard image: {} bytes", bytes.len());
        return Some(bytes);
    }
    None
}

fn cf_html_fragment(html: &[u8]) -> String {
    let raw = String::from_utf8_lossy(html).trim_matches('\0').to_string();
    match (
        cf_html_offset(&raw, "StartFragment:"),
        cf_html_offset(&raw, "EndFragment:"),
    ) {
        (Some(start), Some(end)) if start < end && end <= html.len() => {
            String::from_utf8_lossy(&html[start..end])
                .replace("<!--StartFragment-->", "")
                .replace("<!--EndFragment-->", "")
                .trim()
                .to_string()
        }
        _ => raw,
    }
}

fn cf_html_offset(raw: &str, key: &str) -> Option<usize> {
    raw.lines().find_map(|line| {
        line.strip_prefix(key)
            .and_then(|value| value.trim().parse::<usize>().ok())
    })
}

fn looks_like_cf_html_header_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("Version:")
        && trimmed.contains("StartHTML:")
        && trimmed.contains("StartFragment:")
}

fn file_url_to_path(src: &str) -> Option<PathBuf> {
    let src = src.trim();
    let lower = src.to_ascii_lowercase();
    if !lower.starts_with("file:") {
        return None;
    }

    let mut path = if lower.starts_with("file:///") {
        src[8..].to_string()
    } else if lower.starts_with("file://") {
        src[7..].to_string()
    } else {
        src[5..].to_string()
    };

    path = percent_decode(&path);
    if path.len() >= 3
        && path.as_bytes()[0] == b'/'
        && path.as_bytes()[2] == b':'
        && path.as_bytes()[1].is_ascii_alphabetic()
    {
        path.remove(0);
    }
    Some(PathBuf::from(path.replace('/', "\\")))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                output.push(hex);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn is_probable_file_clipboard_placeholder(text: &str) -> bool {
    matches!(text.trim(), "文件" | "File" | "Files" | "Folder" | "文件夹")
}

fn read_bitmap(
    format: u32,
    name: &str,
    text_content: Option<&str>,
    app_source: &AppSource,
) -> Result<bool, String> {
    let raw = get_clipboard(formats::RawData(format))
        .map_err(|err| format!("read {} bitmap failed: {:?}", name, err))?;
    let png = image_convert::convert_bitmap_to_png(raw.as_slice())
        .map_err(|err| format!("convert {} bitmap failed: {}", name, err))?;

    clipboard::insert_image_with_text_and_app(
        &png,
        text_content.unwrap_or(""),
        &app_source.name,
        &app_source.icon_path,
    );
    Ok(true)
}

#[cfg(target_os = "windows")]
fn clipboard_sequence_number() -> u32 {
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
    }

    unsafe { GetClipboardSequenceNumber() }
}

#[cfg(not(target_os = "windows"))]
fn clipboard_sequence_number() -> u32 {
    0
}

#[cfg(target_os = "windows")]
fn clipboard_app_source() -> Option<AppSource> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    type Hwnd = *mut c_void;
    type Handle = *mut c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardOwner() -> Hwnd;
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: u32,
            exe_name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    let clipboard_owner = unsafe { GetClipboardOwner() };
    let hwnd = if clipboard_owner.is_null() {
        unsafe { GetForegroundWindow() }
    } else {
        clipboard_owner
    };
    if hwnd.is_null() {
        return None;
    }

    let mut pid = 0_u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid as *mut u32);
    }
    if pid == 0 {
        return None;
    }

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }

    let mut buffer = [0_u16; 1024];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) } != 0;
    unsafe {
        CloseHandle(process);
    }
    if !ok || size == 0 {
        return None;
    }

    let exe_path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..size as usize]));
    let exe_key = exe_path.to_string_lossy().to_string();
    if let Some(cached) = APP_SOURCE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .get(&exe_key)
                .filter(|source| {
                    source.icon_path.is_empty() || PathBuf::from(&source.icon_path).is_file()
                })
                .cloned()
        })
    {
        return Some(cached);
    }

    let app_name = exe_path
        .file_stem()
        .and_then(|name| name.to_str())
        .map(clean_app_source)
        .filter(|name| !name.is_empty());
    let source = app_name.map(|name| AppSource {
        icon_path: extract_process_icon_png(&exe_path).unwrap_or_default(),
        name,
    });
    if let Some(source) = source.clone() {
        if let Ok(mut cache) = APP_SOURCE_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
        {
            cache.insert(exe_key, source);
        }
    }
    source
}

#[cfg(not(target_os = "windows"))]
fn clipboard_app_source() -> Option<AppSource> {
    None
}

fn is_vpaste_app_source(name: &str) -> bool {
    name.eq_ignore_ascii_case("vPaste") || name.eq_ignore_ascii_case("vpaste")
}

fn clean_app_source(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(name)
        .trim()
        .trim_end_matches(".exe")
        .to_string()
}

#[cfg(target_os = "windows")]
fn extract_process_icon_png(exe_path: &Path) -> Option<String> {
    use image::{imageops, ImageBuffer, Rgba};
    use sha2::{Digest, Sha256};
    use std::ffi::{c_void, OsStr};
    use std::fs;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    type Handle = *mut c_void;
    type Hicon = *mut c_void;
    type Hbitmap = *mut c_void;
    type Hdc = *mut c_void;
    type Hresult = i32;

    #[repr(C)]
    struct IconInfo {
        f_icon: i32,
        x_hotspot: u32,
        y_hotspot: u32,
        hbm_mask: Hbitmap,
        hbm_color: Hbitmap,
    }

    #[repr(C)]
    struct Bitmap {
        bm_type: i32,
        bm_width: i32,
        bm_height: i32,
        bm_width_bytes: i32,
        bm_planes: u16,
        bm_bits_pixel: u16,
        bm_bits: *mut c_void,
    }

    #[repr(C)]
    struct BitmapInfoHeader {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_x_pels_per_meter: i32,
        bi_y_pels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }

    #[repr(C)]
    struct RgbQuad {
        rgb_blue: u8,
        rgb_green: u8,
        rgb_red: u8,
        rgb_reserved: u8,
    }

    #[repr(C)]
    struct BitmapInfo {
        bmi_header: BitmapInfoHeader,
        bmi_colors: [RgbQuad; 1],
    }

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    #[repr(C)]
    struct ShFileInfoW {
        h_icon: Hicon,
        i_icon: i32,
        dw_attributes: u32,
        sz_display_name: [u16; 260],
        sz_type_name: [u16; 80],
    }

    #[repr(C)]
    struct IImageList {
        vtbl: *const IImageListVtbl,
    }

    #[repr(C)]
    struct IImageListVtbl {
        query_interface: usize,
        add_ref: usize,
        release: unsafe extern "system" fn(this: *mut IImageList) -> u32,
        add: usize,
        replace_icon: usize,
        set_overlay_image: usize,
        replace: usize,
        add_masked: usize,
        draw: usize,
        remove: usize,
        get_icon: unsafe extern "system" fn(
            this: *mut IImageList,
            index: i32,
            flags: u32,
            icon: *mut Hicon,
        ) -> Hresult,
    }

    const BI_RGB: u32 = 0;
    const DIB_RGB_COLORS: u32 = 0;
    const SHGFI_SYSICONINDEX: u32 = 0x000004000;
    const SHIL_EXTRALARGE: i32 = 0x2;
    const SHIL_JUMBO: i32 = 0x4;
    const ILD_TRANSPARENT: u32 = 0x00000001;
    const IID_IIMAGELIST: Guid = Guid {
        data1: 0x46EB5926,
        data2: 0x582E,
        data3: 0x4017,
        data4: [0x9F, 0xDF, 0xE8, 0x99, 0x8D, 0xAA, 0x09, 0x50],
    };

    #[link(name = "shell32")]
    extern "system" {
        fn ExtractIconExW(
            file: *const u16,
            icon_index: i32,
            large_icon: *mut Hicon,
            small_icon: *mut Hicon,
            icons: u32,
        ) -> u32;
        fn SHGetFileInfoW(
            path: *const u16,
            file_attributes: u32,
            file_info: *mut ShFileInfoW,
            file_info_size: u32,
            flags: u32,
        ) -> usize;
        fn SHGetImageList(image_list: i32, riid: *const Guid, ppv: *mut *mut c_void) -> Hresult;
    }

    #[link(name = "user32")]
    extern "system" {
        fn DestroyIcon(icon: Hicon) -> i32;
        fn GetIconInfo(icon: Hicon, icon_info: *mut IconInfo) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn DeleteDC(hdc: Hdc) -> i32;
        fn DeleteObject(object: Handle) -> i32;
        fn GetObjectW(object: Handle, count: i32, object_data: *mut c_void) -> i32;
        fn GetDIBits(
            hdc: Hdc,
            bitmap: Hbitmap,
            start: u32,
            lines: u32,
            bits: *mut c_void,
            bitmap_info: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
    }

    let exe_string = exe_path.to_string_lossy();
    let mut hasher = Sha256::new();
    hasher.update(exe_string.as_bytes());
    hasher.update(b":hq-icon-v2:");
    if let Ok(metadata) = fs::metadata(exe_path) {
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(duration.as_millis().to_string().as_bytes());
            }
        }
        hasher.update(metadata.len().to_string().as_bytes());
    }
    let hash = format!("{:x}", hasher.finalize());
    let cache_dir = PathBuf::from(app_runtime_dir(&["app_icons"]));
    let _ = fs::create_dir_all(&cache_dir);

    if is_vpaste_exe(exe_path) {
        let icon_path = cache_dir.join("vpaste-source-icon-v5.png");
        if !icon_path.exists() {
            fs::write(
                &icon_path,
                include_bytes!("../../../icons/source/vpaste-app-icon-1024.png"),
            )
            .ok()?;
        }
        return Some(icon_path.to_string_lossy().to_string());
    }

    let icon_path = cache_dir.join(format!("{hash}-jumbo.png"));
    if icon_path.exists() {
        return Some(icon_path.to_string_lossy().to_string());
    }

    let mut wide_path = OsStr::new(exe_path.as_os_str())
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();

    unsafe fn save_hicon_to_png(
        icon: Hicon,
        icon_path: &Path,
        create_compatible_dc: unsafe extern "system" fn(Hdc) -> Hdc,
        delete_dc: unsafe extern "system" fn(Hdc) -> i32,
        delete_object: unsafe extern "system" fn(Handle) -> i32,
        get_object_w: unsafe extern "system" fn(Handle, i32, *mut c_void) -> i32,
        get_dibits: unsafe extern "system" fn(
            Hdc,
            Hbitmap,
            u32,
            u32,
            *mut c_void,
            *mut BitmapInfo,
            u32,
        ) -> i32,
        get_icon_info: unsafe extern "system" fn(Hicon, *mut IconInfo) -> i32,
    ) -> Option<String> {
        let mut icon_info: IconInfo = zeroed();
        let extraction_result = if get_icon_info(icon, &mut icon_info as *mut IconInfo) == 0
            || icon_info.hbm_color.is_null()
        {
            None
        } else {
            let mut bitmap: Bitmap = zeroed();
            if get_object_w(
                icon_info.hbm_color as Handle,
                size_of::<Bitmap>() as i32,
                &mut bitmap as *mut Bitmap as *mut c_void,
            ) == 0
            {
                None
            } else {
                let width = bitmap.bm_width.max(1) as u32;
                let height = bitmap.bm_height.max(1) as u32;
                let mut bitmap_info = BitmapInfo {
                    bmi_header: BitmapInfoHeader {
                        bi_size: size_of::<BitmapInfoHeader>() as u32,
                        bi_width: width as i32,
                        bi_height: -(height as i32),
                        bi_planes: 1,
                        bi_bit_count: 32,
                        bi_compression: BI_RGB,
                        bi_size_image: width * height * 4,
                        bi_x_pels_per_meter: 0,
                        bi_y_pels_per_meter: 0,
                        bi_clr_used: 0,
                        bi_clr_important: 0,
                    },
                    bmi_colors: [RgbQuad {
                        rgb_blue: 0,
                        rgb_green: 0,
                        rgb_red: 0,
                        rgb_reserved: 0,
                    }],
                };
                let mut bgra = vec![0_u8; (width * height * 4) as usize];
                let hdc = create_compatible_dc(null_mut());
                let lines = get_dibits(
                    hdc,
                    icon_info.hbm_color,
                    0,
                    height,
                    bgra.as_mut_ptr() as *mut c_void,
                    &mut bitmap_info as *mut BitmapInfo,
                    DIB_RGB_COLORS,
                );
                if !hdc.is_null() {
                    delete_dc(hdc);
                }
                if lines == 0 {
                    None
                } else {
                    for pixel in bgra.chunks_exact_mut(4) {
                        pixel.swap(0, 2);
                    }
                    ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, bgra)
                        .and_then(|image| {
                            let mut bounds: Option<(u32, u32, u32, u32)> = None;
                            for (x, y, pixel) in image.enumerate_pixels() {
                                if pixel[3] > 8 {
                                    bounds = Some(match bounds {
                                        Some((min_x, min_y, max_x, max_y)) => {
                                            (min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y))
                                        }
                                        None => (x, y, x, y),
                                    });
                                }
                            }

                            let image_to_save = if let Some((min_x, min_y, max_x, max_y)) = bounds {
                                imageops::crop_imm(
                                    &image,
                                    min_x,
                                    min_y,
                                    max_x - min_x + 1,
                                    max_y - min_y + 1,
                                )
                                .to_image()
                            } else {
                                image
                            };

                            image_to_save.save(icon_path).ok().map(|_| ())
                        })
                        .map(|_| icon_path.to_string_lossy().to_string())
                }
            }
        };

        if !icon_info.hbm_color.is_null() {
            delete_object(icon_info.hbm_color as Handle);
        }
        if !icon_info.hbm_mask.is_null() {
            delete_object(icon_info.hbm_mask as Handle);
        }
        extraction_result
    }

    let shell_icon = unsafe {
        let mut file_info: ShFileInfoW = zeroed();
        let file_result = SHGetFileInfoW(
            wide_path.as_ptr(),
            0,
            &mut file_info as *mut ShFileInfoW,
            size_of::<ShFileInfoW>() as u32,
            SHGFI_SYSICONINDEX,
        );
        if file_result == 0 {
            None
        } else {
            let mut result = None;
            for image_list_size in [SHIL_JUMBO, SHIL_EXTRALARGE] {
                let mut image_list_ptr: *mut c_void = null_mut();
                if SHGetImageList(
                    image_list_size,
                    &IID_IIMAGELIST as *const Guid,
                    &mut image_list_ptr as *mut *mut c_void,
                ) < 0
                    || image_list_ptr.is_null()
                {
                    continue;
                }
                let image_list = image_list_ptr as *mut IImageList;
                let mut icon: Hicon = null_mut();
                let get_icon_result = ((*(*image_list).vtbl).get_icon)(
                    image_list,
                    file_info.i_icon,
                    ILD_TRANSPARENT,
                    &mut icon as *mut Hicon,
                );
                ((*(*image_list).vtbl).release)(image_list);
                if get_icon_result >= 0 && !icon.is_null() {
                    result = save_hicon_to_png(
                        icon,
                        &icon_path,
                        CreateCompatibleDC,
                        DeleteDC,
                        DeleteObject,
                        GetObjectW,
                        GetDIBits,
                        GetIconInfo,
                    );
                    DestroyIcon(icon);
                    if result.is_some() {
                        break;
                    }
                }
            }
            result
        }
    };
    if shell_icon.is_some() {
        return shell_icon;
    }

    let mut small_icon: Hicon = null_mut();
    let mut large_icon: Hicon = null_mut();
    let extracted = unsafe {
        ExtractIconExW(
            wide_path.as_mut_ptr(),
            0,
            &mut large_icon as *mut Hicon,
            &mut small_icon as *mut Hicon,
            1,
        )
    };
    if extracted == 0 {
        return None;
    }
    let icon = if !large_icon.is_null() {
        large_icon
    } else {
        small_icon
    };
    if icon.is_null() {
        if !large_icon.is_null() {
            unsafe {
                DestroyIcon(large_icon);
            }
        }
        return None;
    }

    let result = unsafe {
        save_hicon_to_png(
            icon,
            &icon_path,
            CreateCompatibleDC,
            DeleteDC,
            DeleteObject,
            GetObjectW,
            GetDIBits,
            GetIconInfo,
        )
    };

    unsafe {
        if !small_icon.is_null() {
            DestroyIcon(small_icon);
        }
        if !large_icon.is_null() && large_icon != small_icon {
            DestroyIcon(large_icon);
        }
    }
    result
}

#[cfg(target_os = "windows")]
fn is_vpaste_exe(exe_path: &Path) -> bool {
    if std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok())
        == exe_path.canonicalize().ok()
    {
        return true;
    }

    exe_path
        .file_stem()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().contains("vpaste"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        preferred_rich_plain_text, rtf_plain_text, should_ignore_empty_rich_content,
        should_ignore_excel_blank_bitmap_phase, should_prefer_bitmap_for_rich_content,
        ClipboardSequenceDeduper,
    };

    #[test]
    fn repeated_stable_clipboard_sequence_is_processed_once() {
        let mut deduper = ClipboardSequenceDeduper::default();

        assert!(deduper.should_process(41));
        assert!(!deduper.should_process(41));
        assert!(deduper.should_process(42));
        assert!(deduper.should_process(0));
        assert!(deduper.should_process(0));
    }

    #[test]
    fn image_only_excel_rich_content_prefers_bitmap_storage() {
        assert!(should_prefer_bitmap_for_rich_content(None, 2, false));
        assert!(should_prefer_bitmap_for_rich_content(
            Some("\r\n"),
            1,
            false,
        ));
        assert!(!should_prefer_bitmap_for_rich_content(
            Some("cell text"),
            1,
            false,
        ));
        assert!(!should_prefer_bitmap_for_rich_content(None, 0, false));
    }

    #[test]
    fn image_only_rich_gif_prefers_original_animation() {
        assert!(!should_prefer_bitmap_for_rich_content(None, 1, true));
    }

    #[test]
    fn empty_excel_rich_content_is_ignored_even_when_dib_is_available() {
        assert!(should_ignore_empty_rich_content(
            Some("\r\n"),
            Some("\u{3000}"),
            None,
            0,
            0,
            false,
        ));
        assert!(!should_ignore_empty_rich_content(
            Some("\r\n"),
            Some("\u{3000}"),
            None,
            1,
            0,
            false,
        ));
        assert!(!should_ignore_empty_rich_content(
            Some("cell text"),
            None,
            None,
            0,
            0,
            false,
        ));
        assert!(!should_ignore_empty_rich_content(
            None, None, None, 0, 0, true,
        ));
    }

    #[test]
    fn transient_excel_blank_bitmap_phase_is_ignored() {
        assert!(should_ignore_excel_blank_bitmap_phase(
            "EXCEL",
            Some("\r\n"),
            false,
            false,
            false,
        ));
        assert!(should_ignore_excel_blank_bitmap_phase(
            "excel", None, false, false, false,
        ));
        assert!(!should_ignore_excel_blank_bitmap_phase(
            "EXCEL",
            Some("cell text"),
            false,
            false,
            false,
        ));
        assert!(!should_ignore_excel_blank_bitmap_phase(
            "EXCEL",
            Some("\r\n"),
            true,
            false,
            false,
        ));
        assert!(!should_ignore_excel_blank_bitmap_phase(
            "PixPin",
            Some("\r\n"),
            false,
            false,
            false,
        ));
    }

    #[test]
    fn blank_clipboard_text_uses_visible_rtf_text() {
        let rtf = br#"{\rtf1\ansi{\fonttbl{\f0 Arial;}}\uc1\u20320?\u22909?\cell} "#;
        let visible_rtf = rtf_plain_text(rtf);

        assert_eq!(visible_rtf.as_deref(), Some("你好"));
        assert_eq!(
            preferred_rich_plain_text(Some("\r\n".to_string()), None, visible_rtf),
            "你好"
        );
    }

    #[test]
    fn non_blank_clipboard_text_remains_preferred() {
        assert_eq!(
            preferred_rich_plain_text(
                Some("Excel cell".to_string()),
                Some("HTML text".to_string()),
                Some("RTF text".to_string()),
            ),
            "Excel cell"
        );
    }

    #[test]
    fn rtf_metadata_without_document_text_is_ignored() {
        let rtf = br#"{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\*\generator Excel;}}"#;

        assert_eq!(rtf_plain_text(rtf), None);
    }
}
