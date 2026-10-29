use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, OnceCell, Semaphore};

use crate::{history_store, image_preview};
use image_preview::HistoryImageMetadata;

const CACHE_LIMIT: usize = 96;
type SharedLoad = Arc<OnceCell<Result<MediaResource, String>>>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaIntent {
    Card,
    Animated,
    Preview,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaResource {
    pub(crate) asset_path: String,
    pub(crate) metadata: HistoryImageMetadata,
}

struct Entry {
    load: SharedLoad,
    refresh: bool,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(String, MediaIntent), Entry>,
    order: VecDeque<(String, MediaIntent)>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));
static CHANGED: Notify = Notify::const_new();
static MEDIA_WORK: Semaphore = Semaphore::const_new(2);

pub(crate) async fn resolve(
    path: String,
    intent: MediaIntent,
    refresh: bool,
) -> Result<MediaResource, String> {
    let fingerprint = image_preview::source_cache_key(&path)
        .ok_or_else(|| "image source is missing".to_string())?;
    let key = (fingerprint, intent);
    loop {
        let notified = CHANGED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let candidate = {
            let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
            if refresh
                && cache
                    .entries
                    .get(&key)
                    .is_some_and(|entry| entry.load.get().is_some())
            {
                cache.entries.remove(&key);
                cache.order.retain(|old| old != &key);
            }
            if let Some(entry) = cache.entries.get(&key) {
                Some((entry.load.clone(), refresh && !entry.refresh))
            } else {
                if cache.entries.len() >= CACHE_LIMIT {
                    if let Some(old) = cache
                        .order
                        .iter()
                        .find(|old| {
                            cache
                                .entries
                                .get(*old)
                                .is_some_and(|entry| entry.load.get().is_some())
                        })
                        .cloned()
                    {
                        cache.entries.remove(&old);
                        cache.order.retain(|key| key != &old);
                    }
                }
                if cache.entries.len() < CACHE_LIMIT {
                    let load = Arc::new(OnceCell::new());
                    cache.entries.insert(
                        key.clone(),
                        Entry {
                            load: load.clone(),
                            refresh,
                        },
                    );
                    cache.order.push_back(key.clone());
                    Some((load, false))
                } else {
                    None
                }
            }
        };
        let Some((load, refresh_after_pending)) = candidate else {
            notified.await;
            continue;
        };
        let source = path.clone();
        let result = load
            .get_or_init(|| async move {
                let _permit = MEDIA_WORK
                    .acquire()
                    .await
                    .map_err(|error| error.to_string())?;
                tauri::async_runtime::spawn_blocking(move || build(&source, intent, refresh))
                    .await
                    .map_err(|error| error.to_string())?
            })
            .await
            .clone();
        if result.is_err() {
            let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
            if cache
                .entries
                .get(&key)
                .is_some_and(|entry| Arc::ptr_eq(&entry.load, &load))
            {
                cache.entries.remove(&key);
                cache.order.retain(|old| old != &key);
            }
        }
        CHANGED.notify_waiters();
        if refresh_after_pending {
            continue;
        }
        return result;
    }
}

pub(crate) fn build(
    path: &str,
    intent: MediaIntent,
    refresh: bool,
) -> Result<MediaResource, String> {
    let source_bytes = history_store::file_len(path)?;
    if refresh {
        if let Some(old) = image_preview::metadata_cache_path(path) {
            let _ = std::fs::remove_file(old);
        }
        if let Ok(old) = image_preview::card_preview_cache_path(path) {
            let _ = std::fs::remove_file(old);
        }
    }
    if source_bytes > image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES {
        return Ok(MediaResource {
            asset_path: String::new(),
            metadata: HistoryImageMetadata {
                width: 0,
                height: 0,
                is_gif: false,
                source_bytes,
                preview_limited: true,
                animation_limited: false,
            },
        });
    }
    let fresh_bytes = if refresh {
        Some(image_preview::read_card_source(path)?)
    } else {
        None
    };
    let metadata = if let Some(bytes) = fresh_bytes.as_ref() {
        image_preview::metadata_from_bytes(path, bytes)?
    } else {
        image_preview::metadata_for_path(path)?
    };
    if metadata.preview_limited {
        return Ok(MediaResource {
            asset_path: String::new(),
            metadata,
        });
    }
    let original_allowed = (intent == MediaIntent::Preview
        || (intent == MediaIntent::Animated && metadata.is_gif))
        && !metadata.animation_limited;
    let original = || -> Result<String, String> {
        let publish = |bytes: &[u8]| {
            let actual = image_preview::metadata_from_bytes(path, bytes)?;
            if actual.preview_limited || actual.animation_limited {
                return Err(crate::clipboard_budget::limit_error());
            }
            crate::image_preview_asset_from_bytes(path, bytes)
        };
        if let Some(bytes) = fresh_bytes.as_ref() {
            publish(bytes)
        } else {
            let bytes = image_preview::read_card_source(path)?;
            publish(&bytes)
        }
    };
    let asset_path = if original_allowed {
        original()?
    } else {
        match card_asset(path, fresh_bytes.as_deref()) {
            Ok(asset) => asset,
            Err(error)
                if metadata.animation_limited
                    || error.contains(&crate::clipboard_budget::limit_error()) =>
            {
                return Ok(MediaResource {
                    asset_path: String::new(),
                    metadata: HistoryImageMetadata {
                        preview_limited: true,
                        ..metadata
                    },
                });
            }
            Err(_) => original()?,
        }
    };
    Ok(MediaResource {
        asset_path,
        metadata,
    })
}

fn card_asset(path: &str, fresh_bytes: Option<&[u8]>) -> Result<String, String> {
    let target = if let Some(bytes) = fresh_bytes {
        // Content identity covers same-size, same-timestamp replacements.
        let key = format!("fresh-card-{}", hex::encode(Sha256::digest(bytes)));
        image_preview::card_preview_cache_path_for_key(&key)?
    } else {
        image_preview::card_preview_cache_path(path)?
    };
    if crate::valid_png_cache_file(&target) {
        return Ok(target.to_string_lossy().into_owned());
    }
    let _guard = image_preview::decode_lock()?;
    if crate::valid_png_cache_file(&target) {
        return Ok(target.to_string_lossy().into_owned());
    }
    let owned_bytes = if fresh_bytes.is_none() {
        Some(image_preview::read_card_source(path)?)
    } else {
        None
    };
    let bytes = fresh_bytes.or(owned_bytes.as_deref()).unwrap();
    let image = image_preview::decode_card_image(bytes)?;
    let mut png = Cursor::new(Vec::new());
    image
        .thumbnail(720, 420)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| format!("encode card preview for {path}: {error}"))?;
    crate::publish_image_cache_file(&target, png.get_ref(), crate::valid_png_cache_file)?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_preserves_original_resolution_and_limited_gif_uses_a_static_frame() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        let path = root.path().join("wide.png");
        image::RgbImage::new(1200, 600).save(&path).unwrap();
        let preview = build(path.to_str().unwrap(), MediaIntent::Preview, false).unwrap();
        assert_eq!(
            image::image_dimensions(&preview.asset_path).unwrap(),
            (1200, 600)
        );

        let gif = root.path().join("large.gif");
        let file = std::fs::File::create(&gif).unwrap();
        let mut encoder = image::codecs::gif::GifEncoder::new(file);
        encoder
            .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
            .unwrap();
        drop(encoder);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&gif)
            .unwrap()
            .set_len(crate::clipboard_budget::ANIMATION_SOURCE_BYTES + 1)
            .unwrap();
        let source_bytes = std::fs::read(&gif).unwrap();
        let preview = build(gif.to_str().unwrap(), MediaIntent::Preview, false).unwrap();
        assert!(preview.metadata.animation_limited);
        assert_eq!(
            image::ImageReader::open(&preview.asset_path)
                .unwrap()
                .with_guessed_format()
                .unwrap()
                .format(),
            Some(image::ImageFormat::Png)
        );
        assert_eq!(std::fs::read(&gif).unwrap(), source_bytes);
    }

    #[test]
    fn oversized_source_returns_metadata_without_materializing_an_original_asset() {
        let source = tempfile::NamedTempFile::new().unwrap();
        source.as_file().set_len(33 * 1024 * 1024).unwrap();
        let resource = build(
            source.path().to_str().unwrap(),
            MediaIntent::Animated,
            false,
        )
        .unwrap();
        assert!(resource.metadata.preview_limited);
        assert_eq!(resource.metadata.source_bytes, 33 * 1024 * 1024);
        assert!(resource.asset_path.is_empty());
    }

    #[test]
    fn original_preview_rechecks_bytes_when_cached_dimensions_are_stale() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        let source = root.path().join("drawing.svg");
        let svg =
            |width| format!("<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='1'/>");
        std::fs::write(&source, svg("00001")).unwrap();
        let stamp = std::fs::metadata(&source).unwrap().modified().unwrap();
        let path = source.to_str().unwrap();
        assert_eq!(image_preview::metadata_for_path(path).unwrap().width, 1);
        std::fs::write(&source, svg("20000")).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(stamp))
            .unwrap();
        assert_eq!(image_preview::metadata_for_path(path).unwrap().width, 1);
        let Err(error) = build(path, MediaIntent::Preview, false) else {
            panic!("stale metadata must not bypass the source budget");
        };
        assert!(crate::clipboard_budget::is_limit_error(&error));
    }

    #[test]
    fn explicit_refresh_rekeys_same_size_same_timestamp_replacements() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        let source = root.path().join("drawing.bmp");
        image::RgbImage::from_pixel(16, 16, image::Rgb([255, 0, 0]))
            .save(&source)
            .unwrap();
        let original = std::fs::metadata(&source).unwrap();
        let path = source.to_string_lossy().into_owned();
        let red = tauri::async_runtime::block_on(resolve(path.clone(), MediaIntent::Card, false))
            .unwrap();
        image::RgbImage::from_pixel(16, 16, image::Rgb([0, 0, 255]))
            .save(&source)
            .unwrap();
        assert_eq!(std::fs::metadata(&source).unwrap().len(), original.len());
        std::fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original.modified().unwrap()))
            .unwrap();
        let blue = tauri::async_runtime::block_on(resolve(path, MediaIntent::Card, true)).unwrap();
        assert_ne!(red.asset_path, blue.asset_path);
        assert_eq!(
            image::open(&blue.asset_path)
                .unwrap()
                .to_rgb8()
                .get_pixel(0, 0)
                .0,
            [0, 0, 255]
        );
    }
}
