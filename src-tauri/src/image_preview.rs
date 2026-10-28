use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{app_runtime_dir, history_store};

pub const CARD_PREVIEW_MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
pub const CARD_PREVIEW_MAX_PIXELS: u64 = 40_000_000;
pub const ANIMATED_PREVIEW_MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const CARD_PREVIEW_MAX_DIMENSION: u32 = 16_384;
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
        .or_else(|image_error| {
            if let Some(dimensions) = iso_image_dimensions(bytes) {
                return Ok(dimensions);
            }
            if !is_svg_bytes(bytes) {
                return Err(image_error);
            }
            // Metadata must not resolve referenced files or nested image payloads.
            let options = resvg::usvg::Options {
                image_href_resolver: resvg::usvg::ImageHrefResolver {
                    resolve_data: Box::new(|_, _, _| None),
                    resolve_string: Box::new(|_, _| None),
                },
                ..Default::default()
            };
            let tree = resvg::usvg::Tree::from_data(bytes, &options).map_err(|_| image_error)?;
            let size = tree.size().to_int_size();
            Ok((size.width(), size.height()))
        })
}

pub(crate) fn is_svg_bytes(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes)
        .map(|text| {
            let text = text.trim_start_matches('\u{feff}').trim_start();
            text.starts_with('<') && text.contains("<svg")
        })
        .unwrap_or(false)
}

pub(crate) fn read_card_source(path: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(CARD_PREVIEW_MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > CARD_PREVIEW_MAX_SOURCE_BYTES {
        return Err("image source exceeds automatic preview budget".into());
    }
    Ok(bytes)
}

// AVIF/HEIF spatial extents are readable without a native pixel decoder.
fn iso_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(4..8)? != b"ftyp" {
        return None;
    }
    let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let brands = bytes.get(8..length)?;
    if !brands.chunks_exact(4).any(|brand| {
        matches!(
            brand,
            b"avif" | b"avis" | b"heic" | b"heix" | b"mif1" | b"msf1"
        )
    }) {
        return None;
    }
    fn walk(mut bytes: &[u8], depth: usize, properties: bool, best: &mut Option<(u32, u32)>) {
        if depth > 8 {
            return;
        }
        while bytes.len() >= 8 {
            let raw = u32::from_be_bytes(bytes[..4].try_into().unwrap());
            let (length, header) = if raw == 1 && bytes.len() >= 16 {
                let extended = u64::from_be_bytes(bytes[8..16].try_into().unwrap());
                let Ok(length) = usize::try_from(extended) else {
                    return;
                };
                (length, 16)
            } else if raw == 0 {
                (bytes.len(), 8)
            } else {
                (raw as usize, 8)
            };
            if length < header || length > bytes.len() {
                return;
            }
            let kind = &bytes[4..8];
            let payload = &bytes[header..length];
            match kind {
                b"meta" => {
                    if let Some(children) = payload.get(4..) {
                        walk(children, depth + 1, false, best);
                    }
                }
                b"iprp" => walk(payload, depth + 1, false, best),
                b"ipco" => walk(payload, depth + 1, true, best),
                b"ispe" if properties && payload.len() >= 12 => {
                    let width = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                    let height = u32::from_be_bytes(payload[8..12].try_into().unwrap());
                    if width > 0 && height > 0 {
                        let oversized = width > CARD_PREVIEW_MAX_DIMENSION
                            || height > CARD_PREVIEW_MAX_DIMENSION
                            || u64::from(width) * u64::from(height) > CARD_PREVIEW_MAX_PIXELS;
                        let previous_oversized = best.is_some_and(|(w, h)| {
                            w > CARD_PREVIEW_MAX_DIMENSION
                                || h > CARD_PREVIEW_MAX_DIMENSION
                                || u64::from(w) * u64::from(h) > CARD_PREVIEW_MAX_PIXELS
                        });
                        if !previous_oversized
                            && (oversized
                                || best.is_none_or(|(w, h)| {
                                    u64::from(width) * u64::from(height)
                                        > u64::from(w) * u64::from(h)
                                }))
                        {
                            *best = Some((width, height));
                        }
                    }
                }
                _ => {}
            }
            bytes = &bytes[length..];
        }
    }
    let mut dimensions = None;
    walk(bytes, 0, false, &mut dimensions);
    dimensions
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
    let cache_path = metadata_cache_path(path);
    if let Some(cached) = cache_path
        .as_ref()
        .and_then(|path| read_metadata_cache(path))
    {
        let normalized = apply_limits(HistoryImageMetadata {
            source_bytes,
            ..cached
        });
        if normalized != cached {
            if let Some(path) = &cache_path {
                write_metadata_cache(path, normalized);
            }
        }
        return Ok(normalized);
    }
    let metadata = if source_bytes > CARD_PREVIEW_MAX_SOURCE_BYTES {
        apply_limits(HistoryImageMetadata {
            width: 0,
            height: 0,
            is_gif: false,
            source_bytes,
            preview_limited: true,
            animation_limited: false,
        })
    } else if let Ok((width, height)) = image::image_dimensions(path) {
        // Ordinary formats need only header reads; file cards never decode pixels here.
        let mut header = [0_u8; 6];
        let read = fs::File::open(path)
            .map_err(|error| error.to_string())?
            .read(&mut header)
            .map_err(|error| error.to_string())?;
        apply_limits(HistoryImageMetadata {
            width,
            height,
            is_gif: read == 6 && matches!(&header, b"GIF87a" | b"GIF89a"),
            source_bytes,
            preview_limited: false,
            animation_limited: false,
        })
    } else {
        let bytes = read_card_source(path)?;
        return metadata_from_bytes(path, &bytes);
    };
    if let Some(path) = &cache_path {
        write_metadata_cache(path, metadata);
    }
    Ok(metadata)
}

pub fn card_preview_cache_path(path: &str) -> Result<PathBuf, String> {
    let source_key = source_cache_key(path).ok_or_else(|| "image source is missing".to_string())?;
    card_preview_cache_path_for_key(&source_key)
}

pub(crate) fn card_preview_cache_path_for_key(source_key: &str) -> Result<PathBuf, String> {
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

#[cfg(test)]
mod svg_metadata_tests {
    use super::*;

    #[test]
    fn svg_dimensions_participate_in_the_existing_pixel_budget() {
        let (width, height) = image_dimensions_from_bytes(br#"<svg xmlns="http://www.w3.org/2000/svg" width="12000" height="5000"><rect width="100%" height="100%"/></svg>"#).unwrap();
        let metadata = apply_limits(HistoryImageMetadata {
            width,
            height,
            is_gif: false,
            source_bytes: 128,
            preview_limited: false,
            animation_limited: false,
        });
        assert_eq!((width, height), (12_000, 5_000));
        assert!(metadata.preview_limited);
    }
    fn image_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(body);
        bytes
    }

    fn avif_header(width: u32, height: u32) -> Vec<u8> {
        let mut spatial = vec![0; 4];
        spatial.extend(width.to_be_bytes());
        spatial.extend(height.to_be_bytes());
        let properties = image_box(b"iprp", &image_box(b"ipco", &image_box(b"ispe", &spatial)));
        let mut meta = vec![0; 4];
        meta.extend(properties);
        let mut bytes = image_box(b"ftyp", b"avif\0\0\0\0avif");
        bytes.extend(image_box(b"meta", &meta));
        bytes
    }

    #[test]
    fn browser_supported_avif_keeps_dimensions_without_a_native_pixel_decoder() {
        assert_eq!(
            image_dimensions_from_bytes(&avif_header(320, 180)).unwrap(),
            (320, 180)
        );
        assert_eq!(iso_image_dimensions(b"\0\0\0\x04ftyp"), None);
    }

    #[test]
    fn avif_spatial_properties_obey_dimension_limits() {
        let (width, height) = image_dimensions_from_bytes(&avif_header(20_000, 1)).unwrap();
        let metadata = apply_limits(HistoryImageMetadata {
            width,
            height,
            is_gif: false,
            source_bytes: 68,
            preview_limited: false,
            animation_limited: false,
        });
        assert!(metadata.preview_limited);
    }
}
