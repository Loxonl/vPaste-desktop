use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::{Chars, FromStr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose, Engine as _};
use chrono::{Local, Utc};
use lazy_static::lazy_static;
use log::{error, info};
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Error, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::hash::Hasher;
use twox_hash::XxHash64;

use crate::clipboard::db::db;
use crate::clipboard::item::{convert_type, Item, ItemTag, ItemType, Page};
use crate::{app_runtime_dir, history_storage_dir, search::engine, secure_store};

pub mod color;
pub(crate) mod db;
pub(crate) mod item;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[derive(serde::Serialize, Debug, Clone)]
pub struct CleanupEstimate {
    pub bytes: u64,
    pub items: usize,
}

#[derive(Serialize)]
pub struct AppSourceOption {
    pub source: String,
    pub icon_path: String,
}

#[derive(Serialize)]
pub struct LinkPreviewUpdate {
    pub url: String,
    pub title: String,
    pub image_path: String,
    pub image_kind: String,
}

struct CleanupCandidate {
    id: i64,
    hash: String,
    item_type: String,
    content: String,
    source: String,
}

const RICH_META_PREFIX: &str = "vpaste-rich:";

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct RichClipboardMeta {
    pub version: u8,
    pub html_path: String,
    pub rtf_path: String,
    pub png_path: String,
}

#[derive(Deserialize, Debug, Default)]
struct SearchFilter {
    mode: Option<String>,
    item_type: Option<String>,
    app_source: Option<String>,
    app_sources: Option<Vec<String>>,
    favorite: Option<bool>,
    tag_name: Option<String>,
    tag_names: Option<Vec<String>>,
    record_tag_ids: Option<Vec<i64>>,
    relative_amount: Option<u64>,
    relative_unit: Option<String>,
}

lazy_static! {
    static ref APP_ICON_COLOR_CACHE: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
    static ref LINK_PREVIEW_ATTEMPT_CACHE: Mutex<HashMap<String, LinkPreviewAttemptState>> =
        Mutex::new(HashMap::new());
    static ref RICH_HTML_CACHE: Mutex<HashMap<String, RichHtmlCacheEntry>> =
        Mutex::new(HashMap::new());
}

#[derive(Clone, Copy)]
struct LinkPreviewAttemptState {
    at: Instant,
    failed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct RichHtmlFileStamp {
    len: u64,
    modified_nanos: u128,
}

struct RichHtmlCacheEntry {
    stamp: RichHtmlFileStamp,
    html: String,
}

const LINK_PREVIEW_SUCCESS_COOLDOWN_SECS: u64 = 12 * 60 * 60;
const LINK_PREVIEW_FAILURE_COOLDOWN_SECS: u64 = 72 * 60 * 60;
const LINK_PREVIEW_CACHE_RETENTION_SECS: u64 = 96 * 60 * 60;
const LINK_PREVIEW_HISTORY_WINDOW_MILLIS: u64 = 7 * 24 * 60 * 60 * 1000;
const SEARCH_SCAN_BATCH_SIZE: usize = 256;
const RICH_HTML_CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;

pub fn try_get_by_hash(hash: &String) -> Option<Item> {
    let stored: rusqlite::Result<StoredItem> = db().query_row(
        "select * from clipboard where hash = ?1",
        [hash],
        read_stored_item,
    );
    stored.ok().map(materialize_item)
}

pub fn count_by_hash(hash: &String) -> i64 {
    db().query_row(
        "select count(*) from clipboard where hash = ?1",
        [hash],
        |row| {
            let count: i64 = row.get(0).unwrap();
            Ok(count)
        },
    )
    .unwrap()
}

pub fn migrate_history_encryption() -> Result<(), String> {
    let conn = db();
    let mut statement = conn
        .prepare("select id, content, preview_content, source, app_icon_path from clipboard")
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let history_app_icons = PathBuf::from(history_storage_dir()).join("app_icons");
    let runtime_app_icons = PathBuf::from(app_runtime_dir(&["app_icons"]));
    for (id, content, preview_content, source, app_icon_path) in rows {
        let plain_content = secure_store::decrypt_text(&content);
        let plain_preview = secure_store::decrypt_text(&preview_content);
        let plain_source = secure_store::decrypt_text(&source);
        let next_app_icon_path = if !app_icon_path.is_empty() {
            let path = PathBuf::from(&app_icon_path);
            if path.starts_with(&history_app_icons) {
                path.file_name()
                    .map(|name| runtime_app_icons.join(name).to_string_lossy().to_string())
                    .unwrap_or(app_icon_path)
            } else {
                app_icon_path
            }
        } else {
            app_icon_path
        };
        let next_app_icon_path = prefer_jumbo_app_icon(next_app_icon_path);
        conn.execute(
            "
            update clipboard
            set content = ?1,
                preview_content = ?2,
                source = ?3,
                app_icon_path = ?4
            where id = ?5
            ",
            rusqlite::params![
                secure_store::encrypt_text(&plain_content),
                secure_store::encrypt_text(&plain_preview),
                secure_store::encrypt_text(&plain_source),
                next_app_icon_path,
                id
            ],
        )
        .map_err(|err| err.to_string())?;
    }

    for dir in ["data", "rich_formats", "image_clipboard_cache"] {
        let root = PathBuf::from(history_storage_dir()).join(dir);
        if root.exists() {
            encrypt_files_recursive(&root)?;
        }
    }
    Ok(())
}

fn encrypt_files_recursive(root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            encrypt_files_recursive(&path)?;
        } else if path.is_file() {
            secure_store::ensure_file_encrypted(&path)?;
        }
    }
    Ok(())
}

struct StoredItem {
    id: usize,
    item_type: String,
    hash: String,
    content: String,
    preview_content: String,
    source: String,
    app_source: String,
    app_icon_path: String,
    title_color: String,
    time: u64,
    search_index: u8,
    label: u64,
}

fn read_stored_item(row: &Row) -> Result<StoredItem, Error> {
    Ok(StoredItem {
        id: row.get("id")?,
        item_type: row.get("item_type")?,
        hash: row.get("hash")?,
        content: row.get::<_, Option<String>>("content")?.unwrap_or_default(),
        preview_content: row
            .get::<_, Option<String>>("preview_content")?
            .unwrap_or_default(),
        source: row.get::<_, Option<String>>("source")?.unwrap_or_default(),
        app_source: row.get("app_source").unwrap_or_default(),
        app_icon_path: row.get("app_icon_path").unwrap_or_default(),
        title_color: row.get("title_color")?,
        time: row.get("time")?,
        search_index: row.get("search_index")?,
        label: row.get("label")?,
    })
}

fn materialize_item(stored: StoredItem) -> Item {
    let id = stored.id;
    let hash = stored.hash;
    let mut item_type = ItemType::from_str(stored.item_type.as_str()).unwrap();
    let mut content = secure_store::decrypt_text(&stored.content);
    let mut preview_content = secure_store::decrypt_text(&stored.preview_content);
    let source = secure_store::decrypt_text(&stored.source);
    let rich_html = rich_meta_from_source(&source)
        .and_then(|meta| read_rich_html_fragment(&meta.html_path))
        .unwrap_or_default();
    match &item_type {
        ItemType::Image => {
            let stored_preview = data_dir() + "/" + &hash;
            if !PathBuf::from(&stored_preview).exists() && PathBuf::from(&content).exists() {
                item_type = ItemType::File;
                content = serde_json::to_string(&vec![content]).unwrap_or_default();
                preview_content = content.clone();
            } else {
                preview_content = stored_preview;
            }
        }
        ItemType::TextFile => {
            preview_content = read_text_file_preview(&content, 1800).unwrap_or(preview_content);
        }
        ItemType::Text | ItemType::Link => {
            preview_content = content.clone();
        }
        ItemType::File => {
            preview_content = content.clone();
        }
        _ => {}
    }
    let app_icon_path = resolve_app_icon_path(&stored.app_source, stored.app_icon_path);
    let title_color = app_icon_dominant_color(&app_icon_path).unwrap_or(stored.title_color);

    Item {
        id,
        content,
        preview_content,
        text_content: if is_rich_meta_source(&source) {
            String::new()
        } else {
            source
        },
        rich_html,
        app_source: stored.app_source,
        app_icon_path,
        title_color,
        item_type,
        hash,
        time: stored.time,
        search_index: stored.search_index,
        label: stored.label,
        tags: tags_for_clipboard_id(id as i64).unwrap_or_default(),
    }
}

fn is_displayable_history_item(item: &Item) -> bool {
    item.item_type != ItemType::Text
        || !is_semantically_blank_text(&item.content)
        || rich_html_has_renderable_image(&item.rich_html)
}

fn rich_html_has_renderable_image(html: &str) -> bool {
    let html = html.to_ascii_lowercase();
    html.contains("data:image/")
        || html.contains("src=\"http://")
        || html.contains("src=\"https://")
        || html.contains("src='http://")
        || html.contains("src='https://")
}

fn tags_for_clipboard_id(clipboard_id: i64) -> Result<Vec<ItemTag>, Error> {
    let conn = db();
    let mut statement = conn.prepare(
        "select t.id, t.name
         from tags t
         join clipboard_tags ct on ct.tag_id = t.id
         where ct.clipboard_id = ?1
         order by lower(t.name), t.id",
    )?;
    let tags = statement
        .query_map([clipboard_id], |row| {
            Ok(ItemTag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect();
    tags
}

fn normalize_tag_name(name: &str) -> String {
    name.trim().chars().take(32).collect::<String>()
}

fn tag_names_from_filter(filter: &SearchFilter) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(tag_names) = filter.tag_names.as_ref() {
        names.extend(tag_names.iter().map(|name| normalize_tag_name(name)));
    }
    if let Some(tag_name) = filter.tag_name.as_ref() {
        names.push(normalize_tag_name(tag_name));
    }
    names
        .into_iter()
        .filter(|name| !name.is_empty())
        .fold(Vec::new(), |mut acc, name| {
            if !acc
                .iter()
                .any(|value: &String| value.eq_ignore_ascii_case(&name))
            {
                acc.push(name);
            }
            acc
        })
}

fn is_vpaste_source(app_source: &str) -> bool {
    app_source.to_ascii_lowercase().contains("vpaste")
}

fn bundled_app_source_icon(app_source: &str) -> Option<(&'static str, &'static [u8])> {
    let source = app_source.trim().to_ascii_lowercase();
    if source.contains("vpaste") {
        return Some((
            "vpaste-source-icon-v5.png",
            include_bytes!("../../icons/source/vpaste-app-icon-1024.png"),
        ));
    }
    let icon = match source.as_str() {
        "google chrome" | "chrome" => (
            "chrome.png",
            include_bytes!("../../icons/source/app-sources/chrome.png").as_slice(),
        ),
        "microsoft edge" | "edge" | "msedge" => (
            "edge.png",
            include_bytes!("../../icons/source/app-sources/edge.png").as_slice(),
        ),
        "microsoft word" | "word" | "winword" => (
            "word.png",
            include_bytes!("../../icons/source/app-sources/word.png").as_slice(),
        ),
        "microsoft excel" | "excel" => (
            "excel.png",
            include_bytes!("../../icons/source/app-sources/excel.png").as_slice(),
        ),
        "microsoft onenote" | "onenote" => (
            "onenote.png",
            include_bytes!("../../icons/source/app-sources/onenote.png").as_slice(),
        ),
        "figma" => (
            "figma.png",
            include_bytes!("../../icons/source/app-sources/figma.png").as_slice(),
        ),
        "notepad3" => (
            "notepad3.png",
            include_bytes!("../../icons/source/app-sources/notepad3.png").as_slice(),
        ),
        "pixpin" => (
            "pixpin.png",
            include_bytes!("../../icons/source/app-sources/pixpin.png").as_slice(),
        ),
        "obs studio" | "obs" | "obs64" => (
            "obs.png",
            include_bytes!("../../icons/source/app-sources/obs.png").as_slice(),
        ),
        "tabby" => (
            "tabby.png",
            include_bytes!("../../icons/source/app-sources/tabby.png").as_slice(),
        ),
        "qq" => (
            "qq.png",
            include_bytes!("../../icons/source/app-sources/qq.png").as_slice(),
        ),
        "wechat" | "weixin" | "wechatappex" => (
            "wechat.png",
            include_bytes!("../../icons/source/app-sources/wechat.png").as_slice(),
        ),
        "file explorer" | "explorer" => (
            "file-explorer.png",
            include_bytes!("../../icons/source/app-sources/file-explorer.png").as_slice(),
        ),
        _ => return None,
    };
    Some(icon)
}

fn bundled_app_source_icon_path(app_source: &str) -> Option<String> {
    let (file_name, bytes) = bundled_app_source_icon(app_source)?;
    let cache_dir = PathBuf::from(app_runtime_dir(&["app_icons"]));
    fs::create_dir_all(&cache_dir).ok()?;
    let icon_path = cache_dir.join(format!("bundled-{}", file_name));
    if !icon_path.exists() {
        fs::write(&icon_path, bytes).ok()?;
    }
    Some(icon_path.to_string_lossy().to_string())
}

fn resolve_app_icon_path(app_source: &str, stored_icon_path: String) -> String {
    if is_vpaste_source(app_source) {
        return vpaste_source_icon_path()
            .unwrap_or_else(|| prefer_jumbo_app_icon(stored_icon_path));
    }
    let stored_icon_path = prefer_jumbo_app_icon(stored_icon_path);
    if !stored_icon_path.is_empty() && Path::new(&stored_icon_path).is_file() {
        return stored_icon_path;
    }
    bundled_app_source_icon_path(app_source).unwrap_or(stored_icon_path)
}

fn app_icon_dominant_color(icon_path: &str) -> Option<String> {
    if icon_path.is_empty() {
        return None;
    }

    if let Some(color) = APP_ICON_COLOR_CACHE.lock().ok()?.get(icon_path).cloned() {
        return if color.is_empty() { None } else { Some(color) };
    }

    let color = calculate_dominant_color(icon_path).unwrap_or_default();
    if let Ok(mut cache) = APP_ICON_COLOR_CACHE.lock() {
        cache.insert(icon_path.to_string(), color.clone());
    }
    if color.is_empty() {
        None
    } else {
        Some(color)
    }
}

fn calculate_dominant_color(icon_path: &str) -> Option<String> {
    const MIN_COLOR_SHARE: f64 = 0.05;
    const MIN_SATURATION: f64 = 0.16;
    const CLOSE_AREA_RATIO: f64 = 0.8;

    let image = image::open(icon_path).ok()?.to_rgba8();
    let mut buckets: HashMap<(u8, u8, u8), (f64, f64, f64, f64, f64)> = HashMap::new();
    let mut visible_weight = 0.0;
    let mut color_weight = 0.0;

    for pixel in image.pixels() {
        let [red, green, blue, alpha] = pixel.0;
        if alpha < 40 {
            continue;
        }
        let alpha_weight = alpha as f64 / 255.0;
        visible_weight += alpha_weight;
        if red > 245 && green > 245 && blue > 245 {
            continue;
        }
        if red < 18 && green < 18 && blue < 18 {
            continue;
        }

        let max = red.max(green).max(blue) as f64;
        let min = red.min(green).min(blue) as f64;
        let saturation = if max <= 0.0 { 0.0 } else { (max - min) / max };
        if saturation < MIN_SATURATION {
            continue;
        }

        color_weight += alpha_weight;
        let key = (red / 24, green / 24, blue / 24);
        let bucket = buckets.entry(key).or_insert((0.0, 0.0, 0.0, 0.0, 0.0));
        bucket.0 += red as f64 * alpha_weight;
        bucket.1 += green as f64 * alpha_weight;
        bucket.2 += blue as f64 * alpha_weight;
        bucket.3 += alpha_weight;
        bucket.4 += saturation * alpha_weight;
    }

    if visible_weight <= 0.0 || color_weight / visible_weight < MIN_COLOR_SHARE {
        return None;
    }

    let mut candidates: Vec<_> = buckets
        .into_iter()
        .filter(|(_, bucket)| bucket.3 > 0.0)
        .collect();
    let largest_population = candidates
        .iter()
        .map(|(_, bucket)| bucket.3)
        .max_by(f64::total_cmp)?;
    candidates.retain(|(_, bucket)| bucket.3 >= largest_population * CLOSE_AREA_RATIO);
    candidates.sort_by(|(left_key, left), (right_key, right)| {
        let left_saturation = left.4 / left.3;
        let right_saturation = right.4 / right.3;
        right_saturation
            .total_cmp(&left_saturation)
            .then_with(|| right.3.total_cmp(&left.3))
            .then_with(|| left_key.cmp(right_key))
    });

    let (_, selected) = candidates.first()?;
    let (red, green, blue, population, _) = *selected;

    Some(format!(
        "rgb({}, {}, {})",
        (red / population).round() as u8,
        (green / population).round() as u8,
        (blue / population).round() as u8
    ))
}

pub fn vpaste_source_icon_path() -> Option<String> {
    bundled_app_source_icon_path("vPaste")
}

fn prefer_jumbo_app_icon(icon_path: String) -> String {
    if icon_path.is_empty() {
        return icon_path;
    }

    let path = PathBuf::from(&icon_path);
    if path.exists() && icon_path.contains("-jumbo.") {
        return icon_path;
    }

    let mut candidates = Vec::new();
    if icon_path.contains("-jumbo.") {
        candidates.push(icon_path.replace("-jumbo.", "-large."));
        candidates.push(icon_path.replace("-jumbo.", "."));
    } else if icon_path.contains("-large.") {
        candidates.push(icon_path.replace("-large.", "-jumbo."));
        candidates.push(icon_path.clone());
        candidates.push(icon_path.replace("-large.", "."));
    } else {
        candidates.push(icon_path.replace(".png", "-jumbo.png"));
        candidates.push(icon_path.replace(".png", "-large.png"));
        candidates.push(icon_path.clone());
    }

    for candidate in candidates {
        if PathBuf::from(&candidate).exists() {
            return candidate;
        }
    }

    String::new()
}

#[test]
fn missing_app_icon_path_is_not_exposed() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing-macos.png");

    assert_eq!(
        resolve_app_icon_path("Missing App", missing.to_string_lossy().to_string()),
        ""
    );
}

#[test]
pub fn test_type() {
    let files: serde_json::Result<Vec<String>> =
        serde_json::from_str("[\"/Users/example/Downloads/image.jpg\"]");
    let files = files.unwrap();
    if files.len() == 1 {
        let mime_type = infer::get_from_path(files[0].as_str());
        if mime_type.is_ok() {
            let mime_type = mime_type.unwrap();
            if mime_type.is_some() && mime_type.unwrap().matcher_type() == infer::MatcherType::Image
            {
                println!("is image");
            }
        }
    }
}
pub fn search(
    keywords: &str,
    mut last_id: u64,
    mut last_time: u64,
    limit: usize,
    label: &str,
) -> Result<Page<Item>, String> {
    let filter = parse_search_filter(label);
    if last_id == 0 {
        last_id = i64::MAX as u64;
    }
    if last_time == 0 {
        last_time = i64::MAX as u64;
    }
    let mut items = Vec::new();
    let mut next_cursor = None;
    let has_more;

    if keywords.trim().is_empty() {
        let (search_sql, params) = build_filter_query(&filter, last_id, last_time, limit);
        let stored_items = {
            let conn = db();
            let mut statement = conn.prepare(&search_sql).map_err(|err| err.to_string())?;
            let collected = statement
                .query_map(params_from_iter(params), read_stored_item)
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            collected
        };
        next_cursor = stored_items.last().map(|item| (item.id as u64, item.time));
        has_more = stored_items.len() == limit;
        items.extend(stored_items.into_iter().map(materialize_item));
    } else {
        let mut seen_hashes = HashSet::new();
        let scan_limit = limit.max(5000);
        let mut scanned = 0;
        while scanned < scan_limit && items.len() < limit {
            let batch_limit = (scan_limit - scanned).min(SEARCH_SCAN_BATCH_SIZE);
            let (cursor_id, cursor_time) = next_cursor.unwrap_or((last_id, last_time));
            let (search_sql, params) =
                build_filter_query(&filter, cursor_id, cursor_time, batch_limit);
            let stored_items = {
                let conn = db();
                let mut statement = conn.prepare(&search_sql).map_err(|err| err.to_string())?;
                let collected = statement
                    .query_map(params_from_iter(params), read_stored_item)
                    .map_err(|err| err.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|err| err.to_string())?;
                collected
            };
            let batch_len = stored_items.len();
            for stored in stored_items {
                scanned += 1;
                next_cursor = Some((stored.id as u64, stored.time));
                if stored_item_matches_keywords(&stored, keywords) {
                    let item = materialize_item(stored);
                    if seen_hashes.insert(item.hash.clone()) {
                        items.push(item);
                    }
                }
                if items.len() >= limit {
                    break;
                }
            }
            if batch_len < batch_limit {
                break;
            }
        }
        items.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.id.cmp(&a.id)));
        items.truncate(limit);
        has_more = items.len() == limit || scanned == scan_limit;
    }

    items.retain(is_displayable_history_item);
    let (next_id, next_time) = next_cursor.unwrap_or((0, 0));
    // let count = conn.query_row("select count(*) from clipboard", [], |row| row.get(0)).expect("count clipoard error");
    Ok(Page {
        list: items,
        consumed: 0,
        has_more,
        next_id,
        next_time,
    })
}

fn stored_item_matches_keywords(stored: &StoredItem, keywords: &str) -> bool {
    let keyword = keywords.trim().to_ascii_lowercase();
    if keyword.is_empty() {
        return true;
    }

    let content = secure_store::decrypt_text(&stored.content);
    let preview_content = secure_store::decrypt_text(&stored.preview_content);
    let source = secure_store::decrypt_text(&stored.source);

    if stored.item_type == ItemType::TextFile.to_string()
        && text_file_contains_keyword(&content, &keyword)
    {
        return true;
    }

    [
        content.as_str(),
        preview_content.as_str(),
        source.as_str(),
        stored.app_source.as_str(),
    ]
    .iter()
    .any(|value| value.to_ascii_lowercase().contains(&keyword))
}

fn text_file_contains_keyword(path: &str, keyword: &str) -> bool {
    secure_store::read_file(path)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|text| text.to_ascii_lowercase().contains(keyword))
        .unwrap_or(false)
}

fn parse_search_filter(label: &str) -> SearchFilter {
    if label == "个人收藏" || label == "__favorite" {
        return SearchFilter {
            mode: Some("favorite".to_string()),
            favorite: Some(true),
            ..Default::default()
        };
    }
    if let Some(json) = label.strip_prefix("__filter:") {
        return serde_json::from_str(json).unwrap_or_default();
    }
    SearchFilter {
        mode: Some("all".to_string()),
        ..Default::default()
    }
}

#[allow(dead_code)]
fn append_link_cache_search_results(
    items: &mut Vec<Item>,
    seen_hashes: &mut HashSet<String>,
    keywords: &str,
    last_id: u64,
    last_time: u64,
    limit: usize,
    filter: &SearchFilter,
) -> Result<(), String> {
    let pattern = format!("%{}%", keywords.trim());
    let stored_items = {
        let conn = db();
        let mut statement = conn
            .prepare(
                "select * from clipboard
                 where item_type = ?1
                   and content like ?2
                   and (time < ?3 or (time = ?4 and id < ?5))
                 order by time desc, id desc
                 limit ?6",
            )
            .map_err(|err| err.to_string())?;
        let collected = statement
            .query_map(
                rusqlite::params![
                    ItemType::Link.to_string(),
                    pattern,
                    last_time as i64,
                    last_time as i64,
                    last_id as i64,
                    limit as i64
                ],
                read_stored_item,
            )
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        collected
    };

    for stored in stored_items {
        let item = materialize_item(stored);
        if item_matches_filter(&item, filter) && seen_hashes.insert(item.hash.clone()) {
            items.push(item);
        }
    }
    Ok(())
}

fn relative_unit_millis(unit: &str) -> Option<u64> {
    match unit {
        "minute" | "minutes" => Some(60 * 1000),
        "hour" | "hours" => Some(60 * 60 * 1000),
        "day" | "days" => Some(24 * 60 * 60 * 1000),
        "week" | "weeks" => Some(7 * 24 * 60 * 60 * 1000),
        "month" | "months" => Some(30 * 24 * 60 * 60 * 1000),
        _ => None,
    }
}

fn build_filter_query(
    filter: &SearchFilter,
    last_id: u64,
    last_time: u64,
    limit: usize,
) -> (String, Vec<Value>) {
    let mut clauses = vec!["(time < ? or (time = ? and id < ?))".to_string()];
    let mut params = vec![
        Value::Integer(last_time as i64),
        Value::Integer(last_time as i64),
        Value::Integer(last_id as i64),
    ];

    apply_filter_clauses(filter, &mut clauses, &mut params);
    params.push(Value::Integer(limit as i64));

    let sql = format!(
        "select * from clipboard where {} order by time desc, id desc limit ?",
        clauses.join(" and ")
    );
    (sql, params)
}

fn filter_app_sources(filter: &SearchFilter) -> Vec<String> {
    if let Some(app_sources) = filter.app_sources.as_ref() {
        let sources: Vec<String> = app_sources
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        if !sources.is_empty() {
            return sources;
        }
    }

    filter
        .app_source
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| vec![value.to_string()])
        .unwrap_or_default()
}

fn apply_filter_clauses(filter: &SearchFilter, clauses: &mut Vec<String>, params: &mut Vec<Value>) {
    let mode = filter.mode.as_deref().unwrap_or("");
    if mode == "favorite" || filter.favorite == Some(true) {
        clauses.push("label = ?".to_string());
        params.push(Value::Integer(1));
    } else if filter.favorite == Some(false) {
        clauses.push("label <> ?".to_string());
        params.push(Value::Integer(1));
    }

    if let Some(item_type) = filter
        .item_type
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if item_type == "File" {
            clauses.push("(item_type = ? or item_type = ?)".to_string());
            params.push(Value::Text("File".to_string()));
            params.push(Value::Text("TextFile".to_string()));
        } else if item_type == "Text" {
            clauses.push("(item_type = ? or item_type = ?)".to_string());
            params.push(Value::Text("Text".to_string()));
            params.push(Value::Text("TextFile".to_string()));
        } else {
            clauses.push("item_type = ?".to_string());
            params.push(Value::Text(item_type.to_string()));
        }
    }

    let app_sources = filter_app_sources(filter);
    if app_sources.len() == 1 {
        clauses.push("app_source = ?".to_string());
        params.push(Value::Text(app_sources[0].clone()));
    } else if app_sources.len() > 1 {
        clauses.push(format!(
            "app_source in ({})",
            vec!["?"; app_sources.len()].join(", ")
        ));
        params.extend(app_sources.into_iter().map(Value::Text));
    }

    if let (Some(amount), Some(unit)) = (filter.relative_amount, filter.relative_unit.as_deref()) {
        if amount > 0 {
            if let Some(unit_ms) = relative_unit_millis(unit) {
                let cutoff = Utc::now().timestamp_millis() as u64 - amount.saturating_mul(unit_ms);
                clauses.push("time >= ?".to_string());
                params.push(Value::Integer(cutoff as i64));
            }
        }
    }

    for tag_name in tag_names_from_filter(filter) {
        clauses.push(
            "exists (
                select 1
                from clipboard_tags ct
                join tags t on t.id = ct.tag_id
                where ct.clipboard_id = clipboard.id and t.name = ? collate nocase
            )"
            .to_string(),
        );
        params.push(Value::Text(tag_name));
    }

    if let Some(tag_ids) = filter.record_tag_ids.as_ref() {
        for tag_id in tag_ids.iter().copied().filter(|id| *id > 0) {
            clauses.push(
                "exists (
                    select 1
                    from clipboard_tags ct
                    where ct.clipboard_id = clipboard.id and ct.tag_id = ?
                )"
                .to_string(),
            );
            params.push(Value::Integer(tag_id));
        }
    }
}

#[allow(dead_code)]
fn item_matches_filter(item: &Item, filter: &SearchFilter) -> bool {
    if filter.mode.as_deref() == Some("favorite") || filter.favorite == Some(true) {
        if item.label != 1 {
            return false;
        }
    } else if filter.favorite == Some(false) && item.label == 1 {
        return false;
    }

    if let Some(item_type) = filter
        .item_type
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let current = item.item_type.to_string();
        if item_type == "File" {
            if current != "File" && current != "TextFile" {
                return false;
            }
        } else if current != item_type {
            return false;
        }
    }

    let app_sources = filter_app_sources(filter);
    if !app_sources.is_empty() && !app_sources.iter().any(|source| item.app_source == *source) {
        return false;
    }

    if let (Some(amount), Some(unit)) = (filter.relative_amount, filter.relative_unit.as_deref()) {
        if amount > 0 {
            if let Some(unit_ms) = relative_unit_millis(unit) {
                let cutoff = Utc::now().timestamp_millis() as u64 - amount.saturating_mul(unit_ms);
                if item.time < cutoff {
                    return false;
                }
            }
        }
    }

    let tag_names = tag_names_from_filter(filter);
    if !tag_names.is_empty()
        && !tag_names.iter().all(|tag_name| {
            item.tags
                .iter()
                .any(|tag| tag.name.eq_ignore_ascii_case(tag_name))
        })
    {
        return false;
    }

    if let Some(tag_ids) = filter.record_tag_ids.as_ref() {
        if !tag_ids
            .iter()
            .copied()
            .filter(|id| *id > 0)
            .all(|tag_id| item.tags.iter().any(|tag| tag.id == tag_id))
        {
            return false;
        }
    }

    true
}

pub fn set_favorite(hash: &str, favorite: bool) -> Result<usize, Error> {
    let label = if favorite { 1_u64 } else { 0_u64 };
    db().execute(
        "update clipboard set label = ?1 where hash = ?2",
        rusqlite::params![label, hash],
    )
}

pub fn list_tags() -> Result<Vec<ItemTag>, String> {
    let conn = db();
    let mut statement = conn
        .prepare("select id, name from tags order by lower(name), id")
        .map_err(|err| err.to_string())?;
    let tags = statement
        .query_map([], |row| {
            Ok(ItemTag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string());
    tags
}

pub fn create_tag(name: &str) -> Result<ItemTag, String> {
    let name = normalize_tag_name(name);
    if name.is_empty() {
        return Err("标签名称不能为空".to_string());
    }
    let now = current_timestamp_millis() as i64;
    let conn = db();
    conn.execute(
        "insert or ignore into tags(name, created_at, updated_at) values(?1, ?2, ?3)",
        rusqlite::params![name, now, now],
    )
    .map_err(|err| err.to_string())?;
    tag_by_name(&name)?.ok_or_else(|| "标签创建失败".to_string())
}

pub fn rename_tag(id: i64, name: &str) -> Result<ItemTag, String> {
    let name = normalize_tag_name(name);
    if name.is_empty() {
        return Err("标签名称不能为空".to_string());
    }
    let affected = db()
        .execute(
            "update tags set name = ?1, updated_at = ?2 where id = ?3",
            rusqlite::params![name, current_timestamp_millis() as i64, id],
        )
        .map_err(|err| err.to_string())?;
    if affected == 0 {
        return Err("标签不存在".to_string());
    }
    tag_by_id(id)?.ok_or_else(|| "标签不存在".to_string())
}

pub fn delete_tag(id: i64) -> Result<usize, String> {
    let conn = db();
    conn.execute("delete from clipboard_tags where tag_id = ?1", [id])
        .map_err(|err| err.to_string())?;
    conn.execute("delete from tags where id = ?1", [id])
        .map_err(|err| err.to_string())
}

pub fn assign_tag(hash: &str, tag_id: i64) -> Result<(), String> {
    let conn = db();
    if tag_by_id(tag_id)?.is_none() {
        return Err("标签不存在".to_string());
    }
    let clipboard_id = clipboard_id_by_hash(hash)?.ok_or_else(|| "粘贴项不存在".to_string())?;
    let now = current_timestamp_millis() as i64;
    conn.execute(
        "insert or ignore into clipboard_tags(clipboard_id, tag_id, created_at) values(?1, ?2, ?3)",
        rusqlite::params![clipboard_id, tag_id, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn remove_tag(hash: &str, tag_id: i64) -> Result<(), String> {
    let clipboard_id = clipboard_id_by_hash(hash)?.ok_or_else(|| "粘贴项不存在".to_string())?;
    db().execute(
        "delete from clipboard_tags where clipboard_id = ?1 and tag_id = ?2",
        rusqlite::params![clipboard_id, tag_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn clipboard_id_by_hash(hash: &str) -> Result<Option<i64>, String> {
    db().query_row("select id from clipboard where hash = ?1", [hash], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|err| err.to_string())
}

fn tag_by_id(id: i64) -> Result<Option<ItemTag>, String> {
    db().query_row("select id, name from tags where id = ?1", [id], |row| {
        Ok(ItemTag {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    })
    .optional()
    .map_err(|err| err.to_string())
}

fn tag_by_name(name: &str) -> Result<Option<ItemTag>, String> {
    db().query_row(
        "select id, name from tags where name = ?1 collate nocase",
        [name],
        |row| {
            Ok(ItemTag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

pub fn recent_app_sources(days: u64) -> Result<Vec<String>, String> {
    let cutoff =
        Utc::now().timestamp_millis() as u64 - days.max(1).saturating_mul(24 * 60 * 60 * 1000);
    let conn = db();
    let mut statement = conn
        .prepare(
            "
                select app_source
                from clipboard
                where app_source <> '' and time >= ?1
                group by app_source
                order by max(time) desc
            ",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([cutoff as i64], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    let mut sources = Vec::new();
    for row in rows {
        sources.push(row.map_err(|err| err.to_string())?);
    }
    Ok(sources)
}

pub fn recent_app_source_options(days: u64) -> Result<Vec<AppSourceOption>, String> {
    let cutoff =
        Utc::now().timestamp_millis() as u64 - days.max(1).saturating_mul(24 * 60 * 60 * 1000);
    let conn = db();
    let mut statement = conn
        .prepare(
            "
                select app_source,
                       coalesce(
                           (
                               select c2.app_icon_path
                               from clipboard c2
                               where c2.app_source = clipboard.app_source
                                 and c2.app_icon_path <> ''
                               order by c2.time desc
                               limit 1
                           ),
                           ''
                       ) as app_icon_path
                from clipboard
                where app_source <> '' and time >= ?1
                group by app_source
                order by max(time) desc
            ",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([cutoff as i64], |row| {
            Ok(AppSourceOption {
                source: row.get::<_, String>(0)?,
                icon_path: row.get::<_, String>(1)?,
            })
        })
        .map_err(|err| err.to_string())?;
    let mut options = Vec::new();
    for row in rows {
        let mut option = row.map_err(|err| err.to_string())?;
        option.icon_path = resolve_app_icon_path(&option.source, option.icon_path);
        options.push(option);
    }
    Ok(options)
}

fn is_rich_meta_source(source: &str) -> bool {
    source.starts_with(RICH_META_PREFIX)
}

fn rich_meta_from_source(source: &str) -> Option<RichClipboardMeta> {
    source
        .strip_prefix(RICH_META_PREFIX)
        .and_then(|json| serde_json::from_str::<RichClipboardMeta>(json).ok())
}

fn cf_html_offset(raw: &str, key: &str) -> Option<usize> {
    raw.lines().find_map(|line| {
        line.strip_prefix(key)
            .and_then(|value| value.trim().parse::<usize>().ok())
    })
}

fn find_case_insensitive(haystack: &str, needle: &str, start: usize) -> Option<usize> {
    haystack
        .get(start..)?
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
        .map(|index| start + index)
}

fn extract_style_blocks(raw: &str) -> String {
    let mut cursor = 0_usize;
    let mut styles = Vec::new();
    while let Some(start) = find_case_insensitive(raw, "<style", cursor) {
        let Some(end) = find_case_insensitive(raw, "</style>", start) else {
            break;
        };
        let end = end + "</style>".len();
        if let Some(block) = raw.get(start..end) {
            styles.push(block.to_string());
        }
        cursor = end;
    }
    styles.join("\n")
}

fn body_inner_html(raw: &str) -> String {
    let Some(body_start) = find_case_insensitive(raw, "<body", 0) else {
        return raw.to_string();
    };
    let Some(content_start) = raw.get(body_start..).and_then(|body| body.find('>')) else {
        return raw.to_string();
    };
    let content_start = body_start + content_start + 1;
    let content_end = find_case_insensitive(raw, "</body>", content_start).unwrap_or(raw.len());
    raw.get(content_start..content_end)
        .unwrap_or(raw)
        .to_string()
}

fn wrap_excel_table_fragment(fragment: String) -> String {
    let lower = fragment.to_ascii_lowercase();
    if lower.contains("<table") {
        return fragment;
    }
    if lower.contains("<td") || lower.contains("<th") {
        if lower.contains("<tr") {
            return format!("<table><tbody>{}</tbody></table>", fragment);
        }
        return format!("<table><tbody><tr>{}</tr></tbody></table>", fragment);
    }
    fragment
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

fn escape_attr_value(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn local_file_image_data_url(src: &str) -> Option<String> {
    let path = file_url_to_path(src)?;
    let bytes = fs::read(path).ok()?;
    image::load_from_memory(&bytes).ok()?;
    let mime = infer::get(&bytes)
        .map(|kind| kind.mime_type())
        .unwrap_or("image/png");
    Some(format!(
        "data:{};base64,{}",
        mime,
        general_purpose::STANDARD.encode(bytes)
    ))
}

fn inline_local_file_images(html: &str) -> String {
    let Ok(selector) = scraper::Selector::parse("img") else {
        return html.to_string();
    };
    let document = scraper::Html::parse_fragment(html);
    let mut output = html.to_string();
    let replacements = document
        .select(&selector)
        .filter_map(|element| element.value().attr("src"))
        .filter(|src| src.to_ascii_lowercase().starts_with("file:"))
        .filter_map(|src| {
            local_file_image_data_url(src).map(|data_url| (src.to_string(), data_url))
        })
        .collect::<Vec<_>>();

    for (src, data_url) in replacements {
        output = output
            .replace(
                &format!("src=\"{}\"", src),
                &format!("src=\"{}\"", data_url),
            )
            .replace(&format!("src='{}'", src), &format!("src=\"{}\"", data_url))
            .replace(
                &format!("src={}", src),
                &format!("src=\"{}\"", escape_attr_value(&data_url)),
            );
    }
    output
}

fn rich_html_file_stamp(path: &str) -> Option<RichHtmlFileStamp> {
    let metadata = fs::metadata(path).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(RichHtmlFileStamp {
        len: metadata.len(),
        modified_nanos,
    })
}

fn cached_rich_html(path: &str, stamp: RichHtmlFileStamp) -> Option<String> {
    RICH_HTML_CACHE
        .lock()
        .ok()?
        .get(path)
        .filter(|entry| entry.stamp == stamp)
        .map(|entry| entry.html.clone())
}

fn cache_rich_html(path: &str, stamp: RichHtmlFileStamp, html: &str) {
    if html.len() > RICH_HTML_CACHE_MAX_BYTES {
        return;
    }
    let Ok(mut cache) = RICH_HTML_CACHE.lock() else {
        return;
    };
    let current_bytes = cache.values().map(|entry| entry.html.len()).sum::<usize>();
    let replaced_bytes = cache.get(path).map(|entry| entry.html.len()).unwrap_or(0);
    if current_bytes - replaced_bytes + html.len() > RICH_HTML_CACHE_MAX_BYTES {
        cache.clear();
    }
    cache.insert(
        path.to_string(),
        RichHtmlCacheEntry {
            stamp,
            html: html.to_string(),
        },
    );
}

fn read_rich_html_fragment(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let stamp = rich_html_file_stamp(path);
    if let Some(cached) = stamp.and_then(|stamp| cached_rich_html(path, stamp)) {
        return Some(cached);
    }
    let bytes = secure_store::read_file(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let raw = String::from_utf8_lossy(&bytes)
        .trim_matches('\0')
        .to_string();
    let style_blocks = extract_style_blocks(&raw);
    let fragment = match (
        cf_html_offset(&raw, "StartFragment:"),
        cf_html_offset(&raw, "EndFragment:"),
    ) {
        (Some(start), Some(end)) if start < end && end <= bytes.len() => {
            String::from_utf8_lossy(&bytes[start..end]).to_string()
        }
        _ => body_inner_html(&raw),
    };
    let fragment = fragment
        .replace("<!--StartFragment-->", "")
        .replace("<!--EndFragment-->", "")
        .trim()
        .to_string();
    let fragment = wrap_excel_table_fragment(inline_local_file_images(&fragment));
    let html = if style_blocks.is_empty() {
        fragment
    } else {
        format!("{}\n{}", style_blocks, fragment)
    };
    let html = html.trim().to_string();
    if html.is_empty() {
        return None;
    }
    if let Some(stamp) = stamp {
        cache_rich_html(path, stamp, &html);
    }
    Some(html)
}

pub fn rich_clipboard_meta(hash: &str) -> Option<RichClipboardMeta> {
    let source: String = db()
        .query_row(
            "select source from clipboard where hash = ?1",
            [hash],
            |row| row.get(0),
        )
        .ok()?;
    rich_meta_from_source(&secure_store::decrypt_text(&source))
}

pub fn delete_by_hash(hash: &str) -> Result<usize, String> {
    let conn = db();
    let candidate = conn
        .query_row(
            "SELECT id, hash, item_type, content, source FROM clipboard WHERE hash = ?1",
            [hash],
            |row| {
                Ok(CleanupCandidate {
                    id: row.get(0)?,
                    hash: row.get(1)?,
                    item_type: row.get(2)?,
                    content: secure_store::decrypt_text(
                        &row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    ),
                    source: secure_store::decrypt_text(
                        &row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    ),
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let Some(candidate) = candidate else {
        return Ok(0);
    };

    let candidates = std::slice::from_ref(&candidate);
    let paths_to_delete = internal_paths_for_candidates(candidates);
    let retained_paths = internal_paths_referenced_by_survivors(candidates, &paths_to_delete)?;

    engine::delete(&candidate.hash);
    conn.execute(
        "DELETE FROM clipboard_tags WHERE clipboard_id = ?1",
        [candidate.id],
    )
    .map_err(|err| err.to_string())?;

    let affected = conn
        .execute("DELETE FROM clipboard WHERE id = ?1", [candidate.id])
        .map_err(|err| err.to_string())?;

    for path in paths_to_delete {
        if !retained_paths.contains(&path)
            && path.is_file()
            && is_path_inside_history_storage(&path)
        {
            let _ = fs::remove_file(path);
        }
    }

    Ok(affected)
}

pub fn touch(hash: &str) -> Result<usize, Error> {
    db().execute(
        "update clipboard set time = ?1 where hash = ?2",
        rusqlite::params![current_timestamp_millis(), hash],
    )
}

fn cleanup_cutoff(days: u64) -> u64 {
    current_timestamp_millis().saturating_sub(days.saturating_mul(24 * 60 * 60 * 1000))
}

fn is_path_inside_history_storage(path: &Path) -> bool {
    let Ok(history_dir) = PathBuf::from(history_storage_dir()).canonicalize() else {
        return false;
    };
    path.canonicalize()
        .map(|candidate| candidate.starts_with(history_dir))
        .unwrap_or(false)
}

fn internal_paths_for_cleanup(
    item_type: &str,
    hash: &str,
    content: &str,
    source: &str,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if matches!(item_type, "Image" | "TextFile") {
        paths.push(PathBuf::from(data_dir()).join(hash));
        let content_path = PathBuf::from(content);
        if content_path.exists() && is_path_inside_history_storage(&content_path) {
            paths.push(content_path);
        }
    }

    if item_type == "Link" {
        if let Some(path) = content.split("|||").nth(1) {
            let path = PathBuf::from(path);
            if path.exists() && is_path_inside_history_storage(&path) {
                paths.push(path);
            }
        }
    }

    if let Some(meta) = rich_meta_from_source(source) {
        for path in [meta.html_path, meta.rtf_path, meta.png_path] {
            let path = PathBuf::from(path);
            if path.exists() && is_path_inside_history_storage(&path) {
                paths.push(path);
            }
        }
    }

    paths
}

fn cleanup_candidates(days: u64) -> Result<Vec<CleanupCandidate>, String> {
    let conn = db();
    let query = if days == 0 {
        "SELECT id, hash, item_type, content, source FROM clipboard".to_string()
    } else {
        "SELECT id, hash, item_type, content, source FROM clipboard WHERE time < ?1".to_string()
    };
    let mut statement = conn.prepare(&query).map_err(|err| err.to_string())?;
    let map_row = |row: &Row<'_>| {
        Ok(CleanupCandidate {
            id: row.get(0)?,
            hash: row.get(1)?,
            item_type: row.get(2)?,
            content: secure_store::decrypt_text(
                &row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ),
            source: secure_store::decrypt_text(
                &row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            ),
        })
    };
    let candidates = if days == 0 {
        statement.query_map([], map_row)
    } else {
        let cutoff = cleanup_cutoff(days);
        statement.query_map([cutoff], map_row)
    }
    .map_err(|err| err.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| err.to_string())?;
    Ok(candidates)
}

fn internal_paths_for_candidates(candidates: &[CleanupCandidate]) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    for candidate in candidates {
        paths.extend(internal_paths_for_cleanup(
            &candidate.item_type,
            &candidate.hash,
            &candidate.content,
            &candidate.source,
        ));
    }
    paths
}

fn internal_paths_referenced_by_survivors(
    candidates: &[CleanupCandidate],
    paths_to_check: &HashSet<PathBuf>,
) -> Result<HashSet<PathBuf>, String> {
    if paths_to_check.is_empty() {
        return Ok(HashSet::new());
    }
    let candidate_ids = candidates
        .iter()
        .map(|candidate| candidate.id)
        .collect::<HashSet<_>>();
    let mut retained_paths = HashSet::new();
    for candidate in cleanup_candidates(0)? {
        if candidate_ids.contains(&candidate.id) {
            continue;
        }
        for path in internal_paths_for_cleanup(
            &candidate.item_type,
            &candidate.hash,
            &candidate.content,
            &candidate.source,
        ) {
            if paths_to_check.contains(&path) {
                retained_paths.insert(path);
            }
        }
        if retained_paths.len() == paths_to_check.len() {
            break;
        }
    }
    Ok(retained_paths)
}

fn cleanup_estimate_for_candidates(
    candidates: &[CleanupCandidate],
    paths: &HashSet<PathBuf>,
    retained_paths: &HashSet<PathBuf>,
) -> CleanupEstimate {
    let bytes = paths
        .iter()
        .filter(|path| !retained_paths.contains(*path))
        .fold(0_u64, |total, path| {
            total.saturating_add(
                fs::metadata(path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0),
            )
        });
    CleanupEstimate {
        bytes,
        items: candidates.len(),
    }
}

pub fn cleanup_estimate(days: u64) -> Result<CleanupEstimate, String> {
    let candidates = cleanup_candidates(days)?;
    let paths = internal_paths_for_candidates(&candidates);
    let retained_paths = internal_paths_referenced_by_survivors(&candidates, &paths)?;
    Ok(cleanup_estimate_for_candidates(
        &candidates,
        &paths,
        &retained_paths,
    ))
}

pub fn cleanup_older_than(days: u64) -> Result<CleanupEstimate, String> {
    let candidates = cleanup_candidates(days)?;
    let paths_to_delete = internal_paths_for_candidates(&candidates);
    let retained_paths = internal_paths_referenced_by_survivors(&candidates, &paths_to_delete)?;
    let estimate = cleanup_estimate_for_candidates(&candidates, &paths_to_delete, &retained_paths);
    if candidates.is_empty() {
        return Ok(estimate);
    }

    for candidate in &candidates {
        engine::delete(&candidate.hash);
    }

    let ids = candidates
        .iter()
        .map(|candidate| candidate.id.to_string())
        .collect::<Vec<_>>();
    let conn = db();
    conn.execute(
        format!(
            "DELETE FROM clipboard_tags WHERE clipboard_id IN ({})",
            ids.join(",")
        )
        .as_str(),
        [],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        format!("DELETE FROM clipboard WHERE id IN ({})", ids.join(",")).as_str(),
        [],
    )
    .map_err(|err| err.to_string())?;

    for path in paths_to_delete {
        if !retained_paths.contains(&path)
            && path.is_file()
            && is_path_inside_history_storage(&path)
        {
            let _ = fs::remove_file(path);
        }
    }

    Ok(estimate)
}

pub fn plain_text_content(hash: &str) -> Result<String, String> {
    let hash = hash.to_string();
    let item = try_get_by_hash(&hash).ok_or_else(|| "粘贴项不存在".to_string())?;
    if !item.text_content.is_empty() {
        return Ok(item.text_content);
    }

    match item.item_type {
        ItemType::TextFile => secure_store::read_file(&item.content)
            .and_then(|bytes| String::from_utf8(bytes).map_err(|err| err.to_string()))
            .map_err(|err| format!("读取文本内容失败：{}", err)),
        ItemType::Link => Ok(item.content.split("|||").next().unwrap_or("").to_string()),
        _ => Ok(item.content),
    }
}

fn read_text_file_preview(path: &str, max_chars: usize) -> Option<String> {
    let bytes = secure_store::read_file(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Some(text.chars().take(max_chars).collect())
}

pub fn insert(item: &Item, search_content: &str) {
    insert_with_source_and_app(item, search_content, "", "", "")
}

pub fn insert_with_source(item: &Item, search_content: &str, source: &str) {
    insert_with_source_and_app(item, search_content, source, "", "")
}

pub fn insert_with_source_and_app(
    item: &Item,
    search_content: &str,
    source: &str,
    app_source: &str,
    app_icon_path: &str,
) {
    if count_by_hash(&item.hash) > 0 {
        let conn = db();
        let encrypted_source = secure_store::encrypt_text(source);
        let encrypted_content = secure_store::encrypt_text(&item.content);
        let encrypted_preview_content = secure_store::encrypt_text(&item.preview_content);
        let state = conn.execute(
            "update clipboard
                set time = ?1,
                    app_source = case when ?2 <> '' then ?2 else app_source end,
                    app_icon_path = case when ?3 <> '' then ?3 else app_icon_path end,
                    source = case when ?5 = 'Image' then ?4 when ?4 <> '' then ?4 else source end,
                    content = case when ?5 = 'Link' then content else ?7 end,
                    preview_content = case when ?5 = 'Link' then preview_content else ?8 end
              where hash = ?6",
            rusqlite::params![
                item.time.to_string(),
                app_source,
                app_icon_path,
                encrypted_source,
                item.item_type.to_string(),
                item.hash,
                encrypted_content,
                encrypted_preview_content
            ],
        );
        if let Err(err) = state {
            error!("update clipboard item time failed {:?} {:?}", item, err);
        }
        return;
    }
    let start = Instant::now();

    let insert_sql = "
                        insert into clipboard(hash,content,preview_content,time,title_color,item_type,icon,source,app_source,app_icon_path,search_index)
                                      values(:hash,:content,:preview_content,:time,:title_color,:item_type,:icon,:source,:app_source,:app_icon_path,:search_index)
                            ";
    let conn = db();
    let encrypted_content = secure_store::encrypt_text(&item.content);
    let encrypted_preview_content = secure_store::encrypt_text(&item.preview_content);
    let encrypted_source = secure_store::encrypt_text(source);
    let state = {
        let mut statement = conn.prepare(insert_sql).unwrap();
        statement.execute(&[
            (":hash", &item.hash),
            (":content", &encrypted_content),
            (":preview_content", &encrypted_preview_content),
            (":time", &item.time.to_string()),
            (":title_color", &item.title_color),
            (":item_type", &item.item_type.to_string()),
            (":icon", &"".to_string()),
            (":source", &encrypted_source),
            (":app_source", &app_source.to_string()),
            (":app_icon_path", &app_icon_path.to_string()),
            (":search_index", &"1".to_string()),
        ])
    };
    if state.is_err() {
        error!("{:?} {:?}", item, state.err());
    }
    let row_id = conn.last_insert_rowid() as u64;

    engine::insert(search_content, &item.hash, &row_id);
    info!("insert item all :{}", start.elapsed().as_millis());
}

pub fn calculate_xxhash64(input: &[u8]) -> String {
    let mut hasher = XxHash64::with_seed(0);
    hasher.write(input);
    format!("{:016x}", hasher.finish())
}

pub(crate) fn is_semantically_blank_text(content: &str) -> bool {
    content.chars().all(|character| {
        character.is_whitespace() || matches!(character, '\0' | '\u{200B}' | '\u{FEFF}')
    })
}

fn should_hash_rich_text_by_plain_text(plain_text: &str) -> bool {
    let trimmed = plain_text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let mut visible_chars = 0;
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            continue;
        }
        visible_chars += 1;
        if visible_chars > 8 || ch.is_alphanumeric() {
            return false;
        }
    }

    visible_chars > 0
}

fn rich_text_history_hash(
    plain_text: &str,
    html: Option<&[u8]>,
    rtf: Option<&[u8]>,
    png: Option<&[u8]>,
) -> String {
    if should_hash_rich_text_by_plain_text(plain_text) {
        return calculate_xxhash64(plain_text.trim().as_bytes());
    }

    let mut hash_input = plain_text.as_bytes().to_vec();
    for bytes in [html, rtf, png].into_iter().flatten() {
        hash_input.extend(bytes);
    }
    calculate_xxhash64(&hash_input)
}

pub fn insert_text(content: String) {
    insert_text_from_app(content, "", "");
}

pub fn insert_text_from_app(content: String, app_source: &str, app_icon_path: &str) {
    insert_text_from_app_impl(content, app_source, app_icon_path);
}

pub fn insert_rich_text_from_app(
    plain_text: String,
    html: Option<Vec<u8>>,
    rtf: Option<Vec<u8>>,
    png: Option<Vec<u8>>,
    app_source: &str,
    app_icon_path: &str,
) {
    let normalized_plain_text = plain_text.trim().to_string();
    if !normalized_plain_text.is_empty() && convert_type(&normalized_plain_text) == ItemType::Link {
        insert_text_from_app_impl(normalized_plain_text, app_source, app_icon_path);
        return;
    }

    let hash = rich_text_history_hash(&plain_text, html.as_deref(), rtf.as_deref(), png.as_deref());
    let meta = RichClipboardMeta {
        version: 1,
        html_path: html
            .as_ref()
            .map(|bytes| save_rich_format_to_disk(bytes, &hash, "cf_html"))
            .unwrap_or_default(),
        rtf_path: rtf
            .as_ref()
            .map(|bytes| save_rich_format_to_disk(bytes, &hash, "rtf"))
            .unwrap_or_default(),
        png_path: png
            .as_ref()
            .map(|bytes| save_rich_format_to_disk(bytes, &hash, "png"))
            .unwrap_or_default(),
    };
    let source = format!(
        "{}{}",
        RICH_META_PREFIX,
        serde_json::to_string(&meta).unwrap_or_default()
    );
    let preview_content = if plain_text.len() > 50 {
        plain_text.chars().take(50).collect()
    } else {
        String::new()
    };
    let item = Item {
        id: 0,
        content: plain_text.clone(),
        preview_content,
        text_content: String::new(),
        rich_html: String::new(),
        app_source: app_source.to_string(),
        app_icon_path: app_icon_path.to_string(),
        hash,
        title_color: String::new(),
        item_type: convert_type(&plain_text),
        time: Utc::now().timestamp_millis() as u64,
        search_index: 1,
        label: 0,
        tags: Vec::new(),
    };
    insert_with_source_and_app(&item, &plain_text, &source, app_source, app_icon_path);
}

pub(crate) fn insert_test_room_rich_text(
    hash: String,
    plain_text: String,
    html: Vec<u8>,
    app_source: &str,
    time: u64,
) {
    let meta = RichClipboardMeta {
        version: 1,
        html_path: save_rich_format_to_disk(&html, &hash, "html"),
        rtf_path: String::new(),
        png_path: String::new(),
    };
    let source = format!(
        "{}{}",
        RICH_META_PREFIX,
        serde_json::to_string(&meta).unwrap_or_default()
    );
    let item = Item {
        id: 0,
        content: plain_text.clone(),
        preview_content: plain_text.chars().take(50).collect(),
        text_content: String::new(),
        rich_html: String::new(),
        app_source: app_source.to_string(),
        app_icon_path: String::new(),
        hash,
        title_color: String::new(),
        item_type: ItemType::Text,
        time,
        search_index: 1,
        label: 0,
        tags: Vec::new(),
    };
    insert_with_source_and_app(&item, &plain_text, &source, app_source, "");
}

fn insert_text_from_app_impl(mut content: String, app_source: &str, app_icon_path: &str) {
    if is_semantically_blank_text(&content) {
        return;
    }
    let item_type;
    let hash = calculate_xxhash64(&content.clone().into_bytes());
    let search_content = content.clone();
    let content_charts: Chars = content.chars();
    let mut preview_content: String = "".to_string();

    if content.len() > 50 {
        preview_content = content_charts.take(50).collect();
    }

    if content.len() > 10000 {
        content = save_to_disk(content.as_bytes(), &hash);
        item_type = ItemType::TextFile;
    } else {
        item_type = convert_type(&content);
    }

    let item = Item {
        id: 0,
        content,
        preview_content,
        text_content: String::from(""),
        rich_html: String::new(),
        app_source: app_source.to_string(),
        app_icon_path: app_icon_path.to_string(),
        hash,
        title_color: String::from(""),
        item_type,
        time: Utc::now().timestamp_millis() as u64,
        search_index: 1,
        label: 0,
        tags: Vec::new(),
    };
    insert_with_source_and_app(&item, &search_content, "", app_source, app_icon_path);
}

#[allow(dead_code)]
pub fn insert_image(content: &Vec<u8>) {
    insert_image_with_text(content, "");
}

#[allow(dead_code)]
pub fn insert_image_with_text(content: &Vec<u8>, text_content: &str) {
    insert_image_with_text_and_app(content, text_content, "", "");
}

#[allow(dead_code)]
pub fn insert_image_with_text_and_app(
    content: &Vec<u8>,
    text_content: &str,
    app_source: &str,
    app_icon_path: &str,
) {
    let hash = calculate_xxhash64(content);
    let path = save_to_disk(content, &hash);
    let item = Item {
        id: 0,
        content: path,
        preview_content: String::from(""),
        text_content: text_content.to_string(),
        rich_html: String::new(),
        app_source: app_source.to_string(),
        app_icon_path: app_icon_path.to_string(),
        hash,
        title_color: String::from(""),
        item_type: ItemType::Image,
        time: Utc::now().timestamp_millis() as u64,
        search_index: 1,
        label: 0,
        tags: Vec::new(),
    };
    insert_with_source_and_app(&item, text_content, text_content, app_source, app_icon_path);
}

#[allow(dead_code)]
pub fn insert_file(content: &Vec<String>) {
    insert_file_from_app(content, "", "");
}

#[allow(dead_code)]
pub fn insert_file_from_app(content: &Vec<String>, app_source: &str, app_icon_path: &str) {
    let content = serde_json::to_string(content).unwrap();
    let hash = calculate_xxhash64(&content.clone().into_bytes());

    let item = Item {
        id: 0,
        content: content.clone(),
        hash,
        preview_content: content.clone(),
        text_content: String::from(""),
        rich_html: String::new(),
        app_source: app_source.to_string(),
        app_icon_path: app_icon_path.to_string(),
        title_color: "".to_string(),
        item_type: ItemType::File,
        time: Utc::now().timestamp_millis() as u64,
        search_index: 1,
        label: 0,
        tags: Vec::new(),
    };
    insert_with_source_and_app(&item, &content, "", app_source, app_icon_path);
}
fn data_dir() -> String {
    history_storage_dir() + "/data"
}

fn rich_formats_dir() -> String {
    history_storage_dir() + "/rich_formats"
}

fn save_rich_format_to_disk(data: &[u8], hash: &str, extension: &str) -> String {
    let dir = rich_formats_dir();
    let path = Path::new(&dir);
    if !path.exists() {
        if let Err(e) = fs::create_dir_all(path) {
            error!("创建富格式文件夹时出错: {}", e);
        }
    }
    let file_path = Path::new(&dir).join(format!("{}.{}", hash, extension));
    if !file_path.exists() {
        if let Err(e) = secure_store::write_file(&file_path, data) {
            error!("写入富格式文件时出错: {}", e);
        }
    }
    file_path.to_string_lossy().to_string()
}

fn is_previewable_domain_link(url: &str) -> bool {
    let parsed = match reqwest::Url::parse(url.trim()) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    host.contains('.')
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
}

fn meta_content(document: &scraper::Html, selector: &str) -> String {
    scraper::Selector::parse(selector)
        .ok()
        .and_then(|selector| {
            document
                .select(&selector)
                .next()
                .and_then(|element| element.value().attr("content"))
                .map(|value| value.trim().to_string())
        })
        .unwrap_or_default()
}

fn title_from_html(document: &scraper::Html) -> String {
    let meta_title = meta_content(document, "meta[property='og:title']")
        .or_else_non_empty(|| meta_content(document, "meta[name='twitter:title']"));
    if !meta_title.is_empty() {
        return meta_title;
    }

    let selector = match scraper::Selector::parse("title") {
        Ok(selector) => selector,
        Err(_) => return String::new(),
    };
    document
        .select(&selector)
        .next()
        .map(|element| element.text().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn icon_hrefs_from_html(document: &scraper::Html) -> Vec<String> {
    let selector = match scraper::Selector::parse("link[rel][href]") {
        Ok(selector) => selector,
        Err(_) => return Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut apple_icons = Vec::new();
    let mut regular_icons = Vec::new();
    for element in document.select(&selector) {
        let rel = element
            .value()
            .attr("rel")
            .unwrap_or("")
            .to_ascii_lowercase();
        if !rel.contains("icon") {
            continue;
        }
        let href = element.value().attr("href").unwrap_or("").trim();
        if href.is_empty() {
            continue;
        }
        if rel.contains("apple-touch-icon") {
            if seen.insert(href.to_string()) {
                apple_icons.push(href.to_string());
            }
            continue;
        }
        if seen.insert(href.to_string()) {
            regular_icons.push(href.to_string());
        }
    }
    regular_icons.extend(apple_icons);
    regular_icons
}

fn fetch_preview_image(
    client: &reqwest::blocking::Client,
    base_url: &reqwest::Url,
    image_url: &str,
) -> String {
    if image_url.trim().is_empty() {
        return String::new();
    }
    let Ok(resolved_image_url) = base_url.join(image_url.trim()) else {
        return String::new();
    };
    if !matches!(resolved_image_url.scheme(), "https" | "http") {
        return String::new();
    }
    let Ok(image_response) = client
        .get(resolved_image_url)
        .header(
            reqwest::header::ACCEPT,
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header(reqwest::header::REFERER, base_url.as_str())
        .send()
    else {
        return String::new();
    };
    if !image_response.status().is_success() {
        return String::new();
    }
    let image_url_path = image_response.url().path().to_ascii_lowercase();
    let content_type_image = image_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            let value = value.to_ascii_lowercase();
            value.starts_with("image/")
                || value.contains("icon")
                || value.contains("x-icon")
                || value.contains("octet-stream")
        })
        .unwrap_or(true);
    let Ok(bytes) = image_response.bytes() else {
        return String::new();
    };
    if bytes.is_empty() || bytes.len() > 5 * 1024 * 1024 {
        return String::new();
    }
    let bytes = bytes.to_vec();
    let inferred_image = infer::get(&bytes)
        .map(|kind| kind.mime_type().starts_with("image/"))
        .unwrap_or_else(|| bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]));
    let extension_image = [
        ".ico", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif",
    ]
    .iter()
    .any(|extension| image_url_path.ends_with(extension));
    let svg_text = std::str::from_utf8(&bytes)
        .map(|text| text.trim_start().starts_with("<svg"))
        .unwrap_or(false);
    let webp_bytes = bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP");
    let html_text = std::str::from_utf8(&bytes)
        .map(|text| {
            let text = text.trim_start().to_ascii_lowercase();
            text.starts_with("<!doctype html") || text.starts_with("<html")
        })
        .unwrap_or(false);
    if html_text {
        return String::new();
    }
    if !content_type_image && !inferred_image && !extension_image && !svg_text && !webp_bytes {
        return String::new();
    }
    let img_hash = calculate_xxhash64(&bytes);
    save_to_disk(&bytes, &img_hash)
}

fn is_icon_url(url: &str) -> bool {
    let lower = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    lower.ends_with(".ico")
        || lower.ends_with("/favicon.png")
        || lower.ends_with("/favicon.svg")
        || lower.ends_with("/favicon-16x16.png")
        || lower.ends_with("/favicon-32x32.png")
        || lower.ends_with("/apple-touch-icon.png")
        || lower.ends_with("/apple-touch-icon-180x180.png")
        || lower.ends_with("/apple-touch-icon-precomposed.png")
}

fn fallback_title_from_url(url: &reqwest::Url) -> String {
    url.host_str().unwrap_or(url.as_str()).to_string()
}

fn root_domain_from_host(host: &str) -> Option<String> {
    let parts = host.split('.').collect::<Vec<_>>();
    if parts.len() < 3 {
        return None;
    }
    Some(parts[parts.len().saturating_sub(2)..].join("."))
}

fn fallback_icon_candidates(url: &reqwest::Url) -> Vec<String> {
    let Some(host) = url.host_str() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for base in [
        format!("{}://{}", url.scheme(), host),
        root_domain_from_host(host)
            .map(|domain| format!("{}://{}", url.scheme(), domain))
            .unwrap_or_default(),
        root_domain_from_host(host)
            .map(|domain| format!("{}://www.{}", url.scheme(), domain))
            .unwrap_or_default(),
    ] {
        if base.is_empty() || !seen.insert(base.clone()) {
            continue;
        }
        for path in [
            "/favicon.ico",
            "/favicon.png",
            "/favicon.svg",
            "/favicon-32x32.png",
            "/favicon-16x16.png",
            "/apple-touch-icon.png",
            "/apple-touch-icon-180x180.png",
            "/apple-touch-icon-152x152.png",
            "/apple-touch-icon-precomposed.png",
            "/mstile-150x150.png",
        ] {
            candidates.push(format!("{}{}", base, path));
        }
    }
    candidates
}

fn fallback_link_preview(
    client: &reqwest::blocking::Client,
    url: &reqwest::Url,
    title: &str,
) -> LinkPreviewUpdate {
    let mut image_path = String::new();
    let mut image_kind = String::new();
    for icon_url in fallback_icon_candidates(url) {
        image_path = fetch_preview_image(client, url, &icon_url);
        if !image_path.is_empty() {
            image_kind = "icon".to_string();
            break;
        }
    }
    if image_path.is_empty() {
        image_kind = "default-icon".to_string();
    }
    LinkPreviewUpdate {
        url: url.as_str().to_string(),
        title: if title.trim().is_empty() {
            fallback_title_from_url(url)
        } else {
            title.trim().to_string()
        },
        image_path,
        image_kind,
    }
}

trait NonEmptyOr {
    fn or_else_non_empty<F: FnOnce() -> String>(self, fallback: F) -> String;
}

impl NonEmptyOr for String {
    fn or_else_non_empty<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

fn fetch_link_preview(url: &str) -> Result<LinkPreviewUpdate, String> {
    if !is_previewable_domain_link(url) {
        return Err("unsupported link".to_string());
    }
    let preview_url = reqwest::Url::parse(url.trim()).map_err(|err| err.to_string())?;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(10))
        .cookie_store(true)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 vPaste/1.1")
        .build()
        .map_err(|err| err.to_string())?;

    let response = match client
        .get(preview_url.clone())
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
    {
        Ok(response) => response,
        Err(err) => {
            let fallback = fallback_link_preview(&client, &preview_url, "");
            info!(
                "link preview fetch fell back to local icon for {}: {}",
                url, err
            );
            return Ok(fallback);
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let fallback = fallback_link_preview(&client, &preview_url, "");
        info!(
            "link preview fetch fell back to local icon for {}: http status {}",
            url, status
        );
        return Ok(fallback);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.starts_with("text/html")
        && !content_type.starts_with("application/xhtml+xml")
    {
        let fallback = fallback_link_preview(&client, &preview_url, "");
        info!(
            "link preview fetch fell back to local icon for {}: non-html response {}",
            url, content_type
        );
        return Ok(fallback);
    }
    let final_url = response.url().clone();
    let html = response.text().map_err(|err| err.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let title = title_from_html(&document);
    let image_url = meta_content(&document, "meta[property='og:image']")
        .or_else_non_empty(|| meta_content(&document, "meta[property='og:image:secure_url']"))
        .or_else_non_empty(|| meta_content(&document, "meta[name='twitter:image']"))
        .or_else_non_empty(|| meta_content(&document, "meta[name='twitter:image:src']"));

    let mut image_kind = String::new();
    let mut image_path = fetch_preview_image(&client, &final_url, &image_url);
    if !image_path.is_empty() {
        image_kind = if is_icon_url(&image_url) {
            "icon".to_string()
        } else {
            "preview".to_string()
        };
    } else {
        let icon_candidates = icon_hrefs_from_html(&document)
            .into_iter()
            .chain([
                "/favicon.ico".to_string(),
                "/favicon.png".to_string(),
                "/favicon.svg".to_string(),
                "/favicon-32x32.png".to_string(),
                "/favicon-16x16.png".to_string(),
                "/apple-touch-icon.png".to_string(),
                "/apple-touch-icon-180x180.png".to_string(),
                "/apple-touch-icon-152x152.png".to_string(),
                "/apple-touch-icon-precomposed.png".to_string(),
                "/mstile-150x150.png".to_string(),
            ])
            .collect::<Vec<_>>();
        for icon_url in icon_candidates {
            image_path = fetch_preview_image(&client, &final_url, &icon_url);
            if !image_path.is_empty() {
                break;
            }
        }
        if !image_path.is_empty() {
            image_kind = "icon".to_string();
        }
        if image_path.is_empty() {
            image_kind = "default-icon".to_string();
        }
    }

    Ok(LinkPreviewUpdate {
        url: url.to_string(),
        title,
        image_path,
        image_kind,
    })
}

fn should_skip_link_preview_refresh(url: &str) -> bool {
    let Ok(mut cache) = LINK_PREVIEW_ATTEMPT_CACHE.lock() else {
        return false;
    };
    cache.retain(|_, state| {
        state.at.elapsed() < Duration::from_secs(LINK_PREVIEW_CACHE_RETENTION_SECS)
    });
    cache
        .get(url)
        .map(|state| {
            let cooldown = if state.failed {
                LINK_PREVIEW_FAILURE_COOLDOWN_SECS
            } else {
                LINK_PREVIEW_SUCCESS_COOLDOWN_SECS
            };
            state.at.elapsed() < Duration::from_secs(cooldown)
        })
        .unwrap_or(false)
}

fn remember_link_preview_attempt(url: &str, failed: bool) {
    if let Ok(mut cache) = LINK_PREVIEW_ATTEMPT_CACHE.lock() {
        cache.insert(
            url.to_string(),
            LinkPreviewAttemptState {
                at: Instant::now(),
                failed,
            },
        );
    }
}

#[derive(Clone)]
struct LinkPreviewRecord {
    id: u64,
    hash: String,
    time: u64,
    content: String,
}

fn link_url_from_content(content: &str) -> String {
    content.split("|||").next().unwrap_or("").trim().to_string()
}

fn find_link_record_for_preview(url: &str) -> Result<Option<LinkPreviewRecord>, String> {
    let conn = db();
    let mut statement = conn
        .prepare(
            "select id, hash, cast(time as integer), content
             from clipboard
             where item_type = ?1
             order by time desc, id desc
             limit 500",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([ItemType::Link.to_string()], |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|err| err.to_string())?;

    for row in rows {
        let (id, hash, time, encrypted_content) = row.map_err(|err| err.to_string())?;
        let content = secure_store::decrypt_text(&encrypted_content);
        if link_url_from_content(&content) == url {
            return Ok(Some(LinkPreviewRecord {
                id,
                hash,
                time: time.max(0) as u64,
                content,
            }));
        }
    }
    Ok(None)
}

fn link_record_cached_image_path(record: &LinkPreviewRecord) -> String {
    record
        .content
        .split("|||")
        .nth(1)
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn link_record_cached_image_kind(record: &LinkPreviewRecord) -> String {
    record
        .content
        .split("|||")
        .nth(3)
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn link_record_cached_refresh_day(record: &LinkPreviewRecord) -> String {
    record
        .content
        .split("|||")
        .nth(4)
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn cached_link_image_is_usable(path: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    let Ok(bytes) = secure_store::read_file(path) else {
        return false;
    };
    if bytes.is_empty() {
        return false;
    }
    let html_text = std::str::from_utf8(&bytes)
        .map(|text| {
            let text = text.trim_start().to_ascii_lowercase();
            text.starts_with("<!doctype html") || text.starts_with("<html")
        })
        .unwrap_or(false);
    if html_text {
        return false;
    }
    infer::get(&bytes)
        .map(|kind| kind.mime_type().starts_with("image/"))
        .unwrap_or_else(|| {
            bytes.starts_with(&[0x00, 0x00, 0x01, 0x00])
                || bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
                || std::str::from_utf8(&bytes)
                    .map(|text| text.trim_start().starts_with("<svg"))
                    .unwrap_or(false)
        })
}

fn link_preview_is_fresh_for_day(record: &LinkPreviewRecord, local_day: &str) -> bool {
    if local_day.is_empty() || link_record_cached_refresh_day(record) != local_day {
        return false;
    }
    link_record_cached_image_kind(record) == "default-icon"
        || cached_link_image_is_usable(&link_record_cached_image_path(record))
}

pub fn refresh_link_previews(urls: Vec<String>) -> Result<Vec<LinkPreviewUpdate>, String> {
    let mut updates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let local_day = Local::now().format("%Y-%m-%d").to_string();
    for raw_url in urls.into_iter().take(10) {
        let url = raw_url.trim().to_string();
        if url.is_empty() || !seen.insert(url.clone()) || !is_previewable_domain_link(&url) {
            continue;
        }
        let Some(record) = find_link_record_for_preview(&url)? else {
            continue;
        };
        let cutoff = current_timestamp_millis().saturating_sub(LINK_PREVIEW_HISTORY_WINDOW_MILLIS);
        if record.time < cutoff {
            continue;
        }
        let cached_image_path = link_record_cached_image_path(&record);
        let cached_image_kind = link_record_cached_image_kind(&record);
        let has_legacy_generated_icon =
            cached_image_kind == "generated-icon" || cached_image_kind == "brand-icon";
        let cached_refresh_day = link_record_cached_refresh_day(&record);
        if !has_legacy_generated_icon {
            if link_preview_is_fresh_for_day(&record, &local_day) {
                continue;
            }
            if cached_refresh_day.is_empty()
                && should_skip_link_preview_refresh(&url)
                && (cached_image_kind == "default-icon"
                    || cached_link_image_is_usable(&cached_image_path))
            {
                continue;
            }
        }

        let update = match fetch_link_preview(&url) {
            Ok(update) => {
                remember_link_preview_attempt(&url, false);
                update
            }
            Err(err) => {
                remember_link_preview_attempt(&url, true);
                info!("link preview fetch skipped for {}: {}", url, err);
                continue;
            }
        };
        let sanitized_title = update.title.replace("|||", " ").trim().to_string();
        let sanitized_image_path = update.image_path.replace("|||", " ");
        let sanitized_image_kind = update.image_kind.replace("|||", " ");
        if sanitized_title.is_empty() && sanitized_image_path.is_empty() {
            continue;
        }

        let next_content = format!(
            "{}|||{}|||{}|||{}|||{}",
            url, sanitized_image_path, sanitized_title, sanitized_image_kind, local_day
        );
        if record.content == next_content {
            continue;
        }
        let encrypted_next_content = secure_store::encrypt_text(&next_content);

        db().execute(
            "update clipboard set content = ?1 where hash = ?2 and item_type = ?3",
            [
                &encrypted_next_content,
                &record.hash,
                &ItemType::Link.to_string(),
            ],
        )
        .map_err(|err| err.to_string())?;
        engine::delete(&record.hash);
        engine::insert(
            format!("{} {}", url, sanitized_title).trim(),
            &record.hash,
            &record.id,
        );

        updates.push(LinkPreviewUpdate {
            url,
            title: sanitized_title,
            image_path: sanitized_image_path,
            image_kind: sanitized_image_kind,
        });
    }
    Ok(updates)
}

pub fn save_to_disk(data: &[u8], hash: &String) -> String {
    let path_str = data_dir();
    let path = Path::new(&path_str);
    if !path.exists() {
        match fs::create_dir_all(path) {
            Ok(_) => info!("文件夹创建成功"),
            Err(e) => error!("创建文件夹时出错: {}", e),
        }
    }
    let file_path = path_str + "/" + hash;

    if !Path::new(&file_path).exists() {
        if let Err(e) = secure_store::write_file(&file_path, data) {
            error!("写入加密文件时出错: {}", e);
        }
    } else {
        return file_path;
    }
    file_path
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn dominant_color_for_test_image(image: image::RgbaImage) -> Option<String> {
        let root = tempfile::tempdir().unwrap();
        let icon_path = root.path().join("app-icon.png");
        image.save(&icon_path).unwrap();
        calculate_dominant_color(icon_path.to_str().unwrap())
    }

    fn seed_shared_link_preview(app_data: &tempfile::TempDir, old_time: u64) -> PathBuf {
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(app_data.path().to_string_lossy().to_string());
        let config = crate::config::Config {
            storage_dir: app_data.path().to_string_lossy().to_string(),
            ..Default::default()
        };
        crate::config::save(config);
        crate::clipboard::db::init();

        let preview_path = PathBuf::from(data_dir()).join("shared-link-preview");
        secure_store::write_file(&preview_path, b"shared preview").unwrap();
        let conn = db();
        for (hash, time, url) in [
            ("old-link", old_time, "https://example.com/old"),
            (
                "new-link",
                current_timestamp_millis(),
                "https://example.com/new",
            ),
        ] {
            let content = format!("{url}|||{}|||Example|||icon", preview_path.display());
            conn.execute(
                "insert into clipboard(
                    hash, time, content, preview_content, item_type, search_index, source,
                    app_source, app_icon_path, title_color, icon, label
                 ) values(?1, ?2, ?3, ?3, 'Link', 1, '', '', '', '', '', 0)",
                params![hash, time as i64, secure_store::encrypt_text(&content)],
            )
            .unwrap();
        }
        preview_path
    }

    fn reset_test_storage_config() {
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn dominant_color_prefers_a_large_representative_area_over_a_small_vivid_accent() {
        let mut image = image::RgbaImage::from_pixel(40, 40, image::Rgba([210, 210, 210, 255]));
        for pixel in image.pixels_mut().take(400) {
            *pixel = image::Rgba([168, 223, 233, 255]);
        }
        for pixel in image.pixels_mut().skip(400).take(120) {
            *pixel = image::Rgba([239, 190, 10, 255]);
        }

        assert_eq!(
            dominant_color_for_test_image(image),
            Some("rgb(168, 223, 233)".to_string())
        );
    }

    #[test]
    fn dominant_color_prefers_saturation_when_the_top_areas_are_within_eighty_percent() {
        let mut image = image::RgbaImage::from_pixel(40, 40, image::Rgba([210, 210, 210, 255]));
        for pixel in image.pixels_mut().take(800) {
            *pixel = image::Rgba([179, 209, 250, 255]);
        }
        for pixel in image.pixels_mut().skip(800).take(720) {
            *pixel = image::Rgba([51, 136, 255, 255]);
        }

        assert_eq!(
            dominant_color_for_test_image(image),
            Some("rgb(51, 136, 255)".to_string())
        );
    }

    #[test]
    fn dominant_color_is_stable_when_multiple_top_areas_are_equal() {
        let mut image = image::RgbaImage::from_pixel(40, 40, image::Rgba([210, 210, 210, 255]));
        for pixel in image.pixels_mut().take(400) {
            *pixel = image::Rgba([135, 79, 255, 255]);
        }
        for pixel in image.pixels_mut().skip(400).take(400) {
            *pixel = image::Rgba([255, 114, 55, 255]);
        }
        for pixel in image.pixels_mut().skip(800).take(400) {
            *pixel = image::Rgba([255, 55, 55, 255]);
        }

        for _ in 0..64 {
            assert_eq!(
                dominant_color_for_test_image(image.clone()),
                Some("rgb(255, 55, 55)".to_string())
            );
        }
    }

    #[test]
    fn dominant_color_ignores_a_tiny_accent_on_an_otherwise_neutral_icon() {
        let mut image = image::RgbaImage::from_pixel(40, 40, image::Rgba([210, 210, 210, 255]));
        for pixel in image.pixels_mut().take(20) {
            *pixel = image::Rgba([230, 20, 40, 255]);
        }

        assert_eq!(dominant_color_for_test_image(image), None);
    }

    #[test]
    fn dominant_color_preserves_solid_app_brand_colors() {
        for (color, expected) in [
            ([6, 199, 98, 255], "rgb(6, 199, 98)"),
            ([255, 207, 73, 255], "rgb(255, 207, 73)"),
        ] {
            let image = image::RgbaImage::from_pixel(20, 20, image::Rgba(color));
            assert_eq!(
                dominant_color_for_test_image(image),
                Some(expected.to_string())
            );
        }
    }

    fn seed_search_history(total: usize, content_for_index: impl Fn(usize) -> String) {
        crate::clipboard::db::init();
        let mut conn = db();
        let transaction = conn.transaction().unwrap();
        {
            let mut statement = transaction
                .prepare(
                    "
                    insert into clipboard(
                        hash, time, content, preview_content, item_type, search_index, source,
                        app_source, app_icon_path, title_color, icon, label
                    )
                    values(?1, ?2, ?3, ?3, ?4, 1, ?3, '', '', '', '', 0)
                    ",
                )
                .unwrap();
            for index in 0..total {
                statement
                    .execute(params![
                        format!("search-test-{index}"),
                        (total - index) as i64,
                        content_for_index(index),
                        ItemType::Text.to_string(),
                    ])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();
    }

    #[test]
    fn rich_text_symbol_hash_ignores_volatile_payload() {
        let first_html = b"<span data-copy-id=\"1\">&#10067;</span>".to_vec();
        let second_html = b"<span data-copy-id=\"2\">&#10067;</span>".to_vec();
        let first_png = vec![1, 2, 3, 4];
        let second_png = vec![4, 3, 2, 1];

        let first = rich_text_history_hash("❓", Some(&first_html), None, Some(&first_png));
        let second = rich_text_history_hash("❓", Some(&second_html), None, Some(&second_png));

        assert_eq!(first, second);
    }

    #[test]
    fn rich_text_word_hash_preserves_format_payload() {
        let first_html = b"<b>OK</b>".to_vec();
        let second_html = b"<i>OK</i>".to_vec();

        let first = rich_text_history_hash("OK", Some(&first_html), None, None);
        let second = rich_text_history_hash("OK", Some(&second_html), None, None);

        assert_ne!(first, second);
    }

    #[test]
    fn rich_html_cache_keeps_inlined_local_image_after_source_is_removed() {
        let root = tempfile::tempdir().unwrap();
        let image_path = root.path().join("excel-temp.png");
        fs::write(&image_path, include_bytes!("../../icons/32x32.png")).unwrap();
        let image_url = format!(
            "file:///{}",
            image_path.to_string_lossy().replace('\\', "/")
        );
        let html = format!(
            "<html><body><!--StartFragment--><img src=\"{}\"><!--EndFragment--></body></html>",
            image_url
        );
        let rich_path = root.path().join("excel.cf_html");
        secure_store::write_file(&rich_path, html.as_bytes()).unwrap();

        let first = read_rich_html_fragment(rich_path.to_str().unwrap()).unwrap();
        assert!(first.contains("data:image/png;base64,"));
        fs::remove_file(image_path).unwrap();

        let second = read_rich_html_fragment(rich_path.to_str().unwrap()).unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn only_renderable_rich_images_keep_blank_text_history_visible() {
        assert!(rich_html_has_renderable_image(
            r#"<img src="data:image/png;base64,AA==">"#,
        ));
        assert!(rich_html_has_renderable_image(
            r#"<img src='https://example.com/image.png'>"#,
        ));
        assert!(!rich_html_has_renderable_image(
            r#"<img src="file:///C:/Temp/deleted-excel-image.png">"#,
        ));
    }

    #[test]
    fn materialized_item_uses_app_icon_color_when_stored_color_is_empty() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(app_data.path().to_string_lossy().to_string());
        let config = crate::config::Config {
            storage_dir: app_data.path().to_string_lossy().to_string(),
            ..Default::default()
        };
        crate::config::save(config);
        crate::clipboard::db::init();

        let icon_path = app_data.path().join("source-app.png");
        fs::write(&icon_path, include_bytes!("../../icons/32x32.png")).unwrap();
        let item = materialize_item(StoredItem {
            id: 0,
            item_type: ItemType::Text.to_string(),
            hash: "app-icon-color-test".to_string(),
            content: secure_store::encrypt_text("text"),
            preview_content: secure_store::encrypt_text("text"),
            source: secure_store::encrypt_text("text"),
            app_source: "Test App".to_string(),
            app_icon_path: icon_path.to_string_lossy().to_string(),
            title_color: String::new(),
            time: 1,
            search_index: 1,
            label: 0,
        });
        reset_test_storage_config();

        assert!(item.title_color.starts_with("rgb("));
    }

    #[test]
    fn test_room_app_sources_have_bundled_cross_platform_icons() {
        for source in [
            "Google Chrome",
            "Microsoft Edge",
            "Microsoft Word",
            "Microsoft Excel",
            "Microsoft OneNote",
            "Figma",
            "Notepad3",
            "PixPin",
            "OBS Studio",
            "Tabby",
            "QQ",
            "WeChat",
            "File Explorer",
            "vPaste",
        ] {
            let (name, bytes) = bundled_app_source_icon(source)
                .unwrap_or_else(|| panic!("missing bundled icon for {source}"));
            assert!(name.ends_with(".png"));
            assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            let icon = image::load_from_memory(bytes)
                .unwrap_or_else(|err| panic!("invalid bundled icon for {source}: {err}"));
            assert!(icon.width() > 0 && icon.height() > 0);
        }
        assert!(bundled_app_source_icon("Notion").is_none());
        assert!(bundled_app_source_icon("Cursor").is_none());
    }

    #[test]
    fn blank_plain_text_does_not_touch_existing_rich_history_item() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(app_data.path().to_string_lossy().to_string());
        let config = crate::config::Config {
            storage_dir: app_data.path().to_string_lossy().to_string(),
            ..Default::default()
        };
        crate::config::save(config);
        crate::clipboard::db::init();

        let content = "\r\n";
        let hash = calculate_xxhash64(content.as_bytes());
        let original_source = "vpaste-rich-v1:{\"html_path\":\"missing.cf_html\"}";
        db().execute(
            "insert into clipboard(
                hash, time, content, preview_content, item_type, search_index, source,
                app_source, app_icon_path, title_color, icon, label
             ) values(?1, 1, ?2, '', 'Text', 1, ?3, 'EXCEL', '', '', '', 0)",
            params![
                hash,
                secure_store::encrypt_text(content),
                secure_store::encrypt_text(original_source),
            ],
        )
        .unwrap();

        insert_text_from_app(content.to_string(), "EXCEL", "");

        let (time, source): (u64, String) = db()
            .query_row(
                "select time, source from clipboard where hash = ?1",
                [&hash],
                |row| {
                    Ok((
                        row.get(0)?,
                        secure_store::decrypt_text(&row.get::<_, String>(1)?),
                    ))
                },
            )
            .unwrap();
        let visible_items = search("", 0, 0, 10, "__all").unwrap().list;
        reset_test_storage_config();

        assert_eq!(time, 1);
        assert_eq!(source, original_source);
        assert!(visible_items.is_empty());
    }

    #[test]
    fn repeated_link_copy_preserves_cached_preview_content() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(app_data.path().to_string_lossy().to_string());
        let config = crate::config::Config {
            storage_dir: app_data.path().to_string_lossy().to_string(),
            ..Default::default()
        };
        crate::config::save(config);
        crate::clipboard::db::init();

        let url = "https://example.com/article";
        let hash = calculate_xxhash64(url.as_bytes());
        insert_text_from_app(url.to_string(), "Browser", "");
        let cached_content =
            format!("{url}|||C:\\preview.png|||Example article|||preview|||2026-08-06");
        db().execute(
            "update clipboard set content = ?1, preview_content = ?1 where hash = ?2",
            params![secure_store::encrypt_text(&cached_content), hash],
        )
        .unwrap();

        insert_text_from_app(url.to_string(), "Browser", "");

        let stored_content: String = db()
            .query_row(
                "select content from clipboard where hash = ?1",
                [&hash],
                |row| row.get(0),
            )
            .map(|content: String| secure_store::decrypt_text(&content))
            .unwrap();
        reset_test_storage_config();

        assert_eq!(stored_content, cached_content);
    }

    #[test]
    fn link_preview_cache_is_fresh_only_on_its_recorded_local_day() {
        let root = tempfile::tempdir().unwrap();
        let image_path = root.path().join("preview.png");
        fs::write(&image_path, include_bytes!("../../icons/32x32.png")).unwrap();
        let record = LinkPreviewRecord {
            id: 1,
            hash: "link-preview-day".to_string(),
            time: 1,
            content: format!(
                "https://example.com|||{}|||Example|||preview|||2026-08-06",
                image_path.display()
            ),
        };

        assert!(link_preview_is_fresh_for_day(&record, "2026-08-06"));
        assert!(!link_preview_is_fresh_for_day(&record, "2026-08-07"));

        let no_image_record = LinkPreviewRecord {
            content: "https://example.com||||||Example|||default-icon|||2026-08-06".to_string(),
            ..record
        };
        assert!(link_preview_is_fresh_for_day(
            &no_image_record,
            "2026-08-06"
        ));
    }

    #[test]
    fn item_tags_assign_filter_and_delete_cleanly() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(app_data.path().to_string_lossy().to_string());
        crate::clipboard::db::init();

        let hash = "tag-test-hash";
        db().execute(
            "
            insert into clipboard(
                hash, time, content, preview_content, item_type, search_index, source,
                app_source, app_icon_path, title_color, icon, label
            )
            values(?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, '', '', '', 0)
            ",
            params![
                hash,
                current_timestamp_millis() as i64,
                secure_store::encrypt_text("tagged body"),
                secure_store::encrypt_text("tagged body"),
                ItemType::Text.to_string(),
                secure_store::encrypt_text("tagged body"),
                "Code"
            ],
        )
        .unwrap();

        let work = create_tag("Work").unwrap();
        let urgent = create_tag("Urgent").unwrap();
        assign_tag(hash, work.id).unwrap();
        assign_tag(hash, urgent.id).unwrap();

        let filtered = search("", 0, 0, 10, r#"__filter:{"tag_names":["Work"]}"#).unwrap();
        assert_eq!(filtered.list.len(), 1);
        assert_eq!(filtered.list[0].tags.len(), 2);

        let filtered_by_id = search(
            "",
            0,
            0,
            10,
            format!(r#"__filter:{{"record_tag_ids":[{}]}}"#, work.id).as_str(),
        )
        .unwrap();
        assert_eq!(filtered_by_id.list.len(), 1);

        let missing = search("", 0, 0, 10, r#"__filter:{"tag_names":["Missing"]}"#).unwrap();
        assert!(missing.list.is_empty());

        remove_tag(hash, work.id).unwrap();
        let work_removed = search("", 0, 0, 10, r#"__filter:{"tag_names":["Work"]}"#).unwrap();
        assert!(work_removed.list.is_empty());

        let urgent_filtered = search("", 0, 0, 10, r#"__filter:{"tag_names":["Urgent"]}"#).unwrap();
        assert_eq!(urgent_filtered.list.len(), 1);

        delete_tag(urgent.id).unwrap();
        assert!(assign_tag(hash, urgent.id).is_err());
        let tags_after_delete = search("", 0, 0, 10, "__all").unwrap().list[0].tags.clone();
        assert!(tags_after_delete.is_empty());
    }

    #[test]
    fn deleting_link_keeps_preview_file_referenced_by_another_item() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let preview_path = seed_shared_link_preview(&app_data, 1);

        delete_by_hash("old-link").unwrap();
        let shared_file_preserved = preview_path.exists();
        let retained_item_exists = try_get_by_hash(&"new-link".to_string()).is_some();

        delete_by_hash("new-link").unwrap();
        let final_owner_removed_file = !preview_path.exists();
        reset_test_storage_config();

        assert!(shared_file_preserved);
        assert!(retained_item_exists);
        assert!(final_owner_removed_file);
    }

    #[test]
    fn cleanup_keeps_preview_file_referenced_by_retained_item() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let preview_path = seed_shared_link_preview(&app_data, 1);

        let first_cleanup = cleanup_older_than(30).unwrap();
        let shared_file_preserved = preview_path.exists();
        let old_item_removed = try_get_by_hash(&"old-link".to_string()).is_none();
        let retained_item_exists = try_get_by_hash(&"new-link".to_string()).is_some();

        cleanup_older_than(0).unwrap();
        let final_owner_removed_file = !preview_path.exists();
        reset_test_storage_config();

        assert_eq!(first_cleanup.items, 1);
        assert_eq!(first_cleanup.bytes, 0);
        assert!(shared_file_preserved);
        assert!(old_item_removed);
        assert!(retained_item_exists);
        assert!(final_owner_removed_file);
    }

    #[test]
    fn keyword_search_scans_beyond_first_candidate_batch() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(app_data.path().to_string_lossy().to_string());
        seed_search_history(5001, |index| {
            if index == 5000 {
                "old needle".to_string()
            } else {
                "other".to_string()
            }
        });

        let first_batch = search("needle", 0, 0, 36, "__all").unwrap();
        assert!(first_batch.list.is_empty());
        assert!(first_batch.has_more);
        assert_ne!((first_batch.next_id, first_batch.next_time), (0, 0));

        let page = search(
            "needle",
            first_batch.next_id,
            first_batch.next_time,
            36,
            "__all",
        )
        .unwrap();

        assert_eq!(page.list.len(), 1);
        assert_eq!(page.list[0].content, "old needle");
        assert!(!page.has_more);
    }

    #[test]
    fn keyword_search_paginates_without_skipping_matches() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(app_data.path().to_string_lossy().to_string());
        seed_search_history(5040, |index| {
            if index >= 5000 {
                format!("needle-{index}")
            } else {
                "other".to_string()
            }
        });

        let scan = search("needle", 0, 0, 36, "__all").unwrap();
        assert!(scan.list.is_empty());
        assert!(scan.has_more);
        let first = search("needle", scan.next_id, scan.next_time, 36, "__all").unwrap();
        assert_eq!(first.list.len(), 36);
        assert!(first.has_more);
        let second = search("needle", first.next_id, first.next_time, 36, "__all").unwrap();

        assert_eq!(second.list.len(), 4);
        assert!(!second.has_more);
        let first_hashes = first
            .list
            .iter()
            .map(|item| item.hash.as_str())
            .collect::<HashSet<_>>();
        assert!(second
            .list
            .iter()
            .all(|item| !first_hashes.contains(item.hash.as_str())));
    }

    #[test]
    fn filter_query_owns_dynamic_sql() {
        let filter = SearchFilter {
            app_sources: Some(vec!["Code".to_string(), "Terminal".to_string()]),
            ..Default::default()
        };

        let (sql, params) = build_filter_query(&filter, i64::MAX as u64, i64::MAX as u64, 36);

        let _: &String = &sql;
        assert!(sql.contains("app_source in (?, ?)"));
        assert_eq!(params.len(), 6);
    }
}

#[allow(dead_code)]
pub fn get_on_disk(_path: String) -> Vec<u8> {
    Vec::new()
}

#[allow(dead_code)]
pub fn get_text_preview_on_disk(path: String, search_word: String) -> String {
    let bytes =
        secure_store::read_file(&path).unwrap_or_else(|_| fs::read(&path).unwrap_or_default());
    let content = String::from_utf8_lossy(&bytes).to_string();
    if search_word.is_empty() {
        return content;
    }
    content
        .find(search_word.as_str())
        .map(|index| content[index..].chars().take(4096).collect())
        .unwrap_or_else(|| content.chars().take(4096).collect())
}

#[allow(dead_code)]
pub fn current_timestamp_millis() -> u64 {
    Utc::now().timestamp_millis() as u64
}
