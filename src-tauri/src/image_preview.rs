use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{app_runtime_dir, history_store};

pub const CARD_PREVIEW_MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
pub const CARD_PREVIEW_MAX_PIXELS: u64 = 40_000_000;
pub const ANIMATED_PREVIEW_MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
const CARD_PREVIEW_MAX_DIMENSION: u32 = 16_384;
const CARD_PREVIEW_MAX_ALLOCATION_BYTES: u64 = 192 * 1024 * 1024;
const CARD_PREVIEW_CACHE_VERSION: &str = "card-preview-v5";

static IMAGE_DECODE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImageMetadata {
    pub width: u32,
    pub height: u32,
    pub is_gif: bool,
    #[serde(default)]
    pub source_bytes: u64,
    #[serde(default)]
    pub preview_limited: bool,
    #[serde(default)]
    pub animation_limited: bool,
}

fn image_dimensions_from_bytes(bytes: &[u8]) -> Result<(u32, u32), String> {
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| err.to_string())?
        .into_dimensions()
        .map_err(|err| err.to_string())
}

fn apply_limits(mut metadata: HistoryImageMetadata) -> HistoryImageMetadata {
    let pixels = u64::from(metadata.width).saturating_mul(u64::from(metadata.height));
    metadata.preview_limited = metadata.source_bytes > CARD_PREVIEW_MAX_SOURCE_BYTES
        || pixels > CARD_PREVIEW_MAX_PIXELS
        || metadata.width > CARD_PREVIEW_MAX_DIMENSION
        || metadata.height > CARD_PREVIEW_MAX_DIMENSION;
    metadata.animation_limited = metadata.is_gif
        && (metadata.source_bytes > ANIMATED_PREVIEW_MAX_SOURCE_BYTES || metadata.preview_limited);
    metadata
}

pub fn source_cache_key(path: &str) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    Some(hex::encode(hasher.finalize()))
}

pub(crate) fn metadata_cache_path(path: &str) -> Option<PathBuf> {
    source_cache_key(path).map(|key| {
        PathBuf::from(app_runtime_dir(&["image_preview_cache"]))
            .join(format!("{key}.metadata.json"))
    })
}

fn read_metadata_cache(path: &Path) -> Option<HistoryImageMetadata> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn write_metadata_cache(path: &Path, metadata: HistoryImageMetadata) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    if let Ok(content) = serde_json::to_string(&metadata) {
        let _ = fs::write(path, content);
    }
}

pub fn metadata_from_bytes(path: &str, bytes: &[u8]) -> Result<HistoryImageMetadata, String> {
    let (width, height) = image_dimensions_from_bytes(bytes)?;
    let metadata = apply_limits(HistoryImageMetadata {
        width,
        height,
        is_gif: bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        source_bytes: bytes.len() as u64,
        preview_limited: false,
        animation_limited: false,
    });
    if let Some(cache_path) = metadata_cache_path(path) {
        write_metadata_cache(&cache_path, metadata);
    }
    Ok(metadata)
}

pub fn metadata_for_path(path: &str) -> Result<HistoryImageMetadata, String> {
    let source_bytes = history_store::file_len(path)?;
    if let Some(cache_path) = metadata_cache_path(path) {
        if let Some(cached) = read_metadata_cache(&cache_path) {
            let normalized = apply_limits(HistoryImageMetadata {
                source_bytes,
                ..cached
            });
            if normalized != cached {
                write_metadata_cache(&cache_path, normalized);
            }
            return Ok(normalized);
        }

        if source_bytes > CARD_PREVIEW_MAX_SOURCE_BYTES {
            let limited = apply_limits(HistoryImageMetadata {
                width: 0,
                height: 0,
                is_gif: false,
                source_bytes,
                preview_limited: true,
                animation_limited: false,
            });
            write_metadata_cache(&cache_path, limited);
            return Ok(limited);
        }
    }

    let bytes = history_store::read_file(path)?;
    metadata_from_bytes(path, &bytes)
}

pub fn card_preview_cache_path(path: &str) -> Result<PathBuf, String> {
    let source_key = source_cache_key(path).ok_or_else(|| "image source is missing".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(CARD_PREVIEW_CACHE_VERSION.as_bytes());
    hasher.update(source_key.as_bytes());
    let cache_dir = PathBuf::from(app_runtime_dir(&["image_preview_cache"]));
    fs::create_dir_all(&cache_dir).map_err(|err| err.to_string())?;
    Ok(cache_dir.join(format!("{}.png", hex::encode(hasher.finalize()))))
}

pub fn decode_lock() -> Result<MutexGuard<'static, ()>, String> {
    IMAGE_DECODE_LOCK
        .lock()
        .map_err(|_| "image preview decode lock is poisoned".to_string())
}

pub fn decode_card_image(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| err.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(CARD_PREVIEW_MAX_DIMENSION);
    limits.max_image_height = Some(CARD_PREVIEW_MAX_DIMENSION);
    limits.max_alloc = Some(CARD_PREVIEW_MAX_ALLOCATION_BYTES);
    reader.limits(limits);
    reader.decode().map_err(|err| err.to_string())
}
