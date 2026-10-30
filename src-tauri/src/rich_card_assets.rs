use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const IMAGE_BYTES: usize = 1024 * 1024;
const TOTAL_BYTES: usize = 4 * IMAGE_BYTES;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichRenderPayload {
    pub(crate) html: String,
    pub(crate) resources: Vec<RichImageResource>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichImageResource {
    pub(crate) token: String,
    pub(crate) asset_path: String,
    pub(crate) revision: String,
}

pub(crate) struct Images {
    directory: PathBuf,
    resources: Vec<RichImageResource>,
    seen: HashSet<String>,
    bytes: usize,
    pub(crate) over_budget: bool,
    pub(crate) missing_local: bool,
}

fn directory(source: &str) -> PathBuf {
    PathBuf::from(crate::history_storage_dir())
        .join("rich_preview_assets")
        .join(hex::encode(Sha256::digest(source.as_bytes())))
}

impl Images {
    pub(crate) fn new(source: &str) -> Self {
        Self {
            directory: directory(source),
            resources: Vec::new(),
            seen: HashSet::new(),
            bytes: 0,
            over_budget: false,
            missing_local: false,
        }
    }

    pub(crate) fn resolve(&mut self, src: &str) -> Option<String> {
        let (bytes, extension, source_index) = if src.to_ascii_lowercase().starts_with("file:") {
            let path = crate::clipboard::file_url_to_path(src)?;
            let index = self.directory.join(format!(
                "source-{}",
                hex::encode(Sha256::digest(src.as_bytes()))
            ));
            let bytes = if path.is_file() {
                if fs::metadata(&path).ok()?.len() > IMAGE_BYTES as u64 {
                    self.over_budget = true;
                    return None;
                }
                fs::read(&path).ok()?
            } else {
                let name = fs::read_to_string(&index).ok().filter(|name| {
                    name.len() < 100
                        && PathBuf::from(name).file_name().and_then(|v| v.to_str())
                            == Some(name.as_str())
                });
                let Some(bytes) = name.and_then(|name| fs::read(self.directory.join(name)).ok())
                else {
                    self.missing_local = true;
                    return None;
                };
                bytes
            };
            // Keep the existing local-file rich-image validation and MIME behavior.
            image::load_from_memory(&bytes).ok()?;
            let extension = infer::get(&bytes)
                .map(|kind| kind.extension())
                .unwrap_or("png");
            (bytes, extension.to_string(), Some(index))
        } else {
            let (header, body) = src.split_once(',')?;
            let extension = match header.to_ascii_lowercase().as_str() {
                "data:image/png;base64" => "png",
                "data:image/jpeg;base64" => "jpg",
                "data:image/gif;base64" => "gif",
                "data:image/webp;base64" => "webp",
                "data:image/bmp;base64" => "bmp",
                "data:image/avif;base64" => "avif",
                "data:image/x-icon;base64" => "ico",
                _ => return None,
            };
            if body.len() > IMAGE_BYTES.div_ceil(3) * 4 {
                self.over_budget = true;
                return None;
            }
            (
                general_purpose::STANDARD.decode(body).ok()?,
                extension.to_string(),
                None,
            )
        };
        self.bytes = self.bytes.saturating_add(bytes.len());
        if bytes.len() > IMAGE_BYTES || self.bytes > TOTAL_BYTES {
            self.over_budget = true;
            return None;
        }
        let revision = hex::encode(Sha256::digest(&bytes));
        let file_name = format!("{revision}.{extension}");
        let target = self.directory.join(&file_name);
        crate::publish_image_cache_file(&target, &bytes, |path| {
            fs::metadata(path).is_ok_and(|meta| meta.len() == bytes.len() as u64)
        })
        .ok()?;
        if let Some(index) = source_index {
            crate::publish_image_cache_file(&index, file_name.as_bytes(), |path| {
                fs::read_to_string(path).is_ok_and(|name| name == file_name)
            })
            .ok()?;
        }
        let token = format!("vpaste-rich-image:{revision}.{extension}");
        if self.seen.insert(token.clone()) {
            self.resources.push(RichImageResource {
                token: token.clone(),
                asset_path: target.to_string_lossy().into_owned(),
                revision,
            });
        }
        Some(token)
    }

    pub(crate) fn finish(self, html: String) -> Option<RichRenderPayload> {
        (!self.over_budget).then_some(RichRenderPayload {
            html,
            resources: self.resources,
        })
    }
}

impl RichRenderPayload {
    /// Browser drag MIME keeps its old inline fragment semantics, separately from rendering.
    pub(crate) fn drag_html(&self) -> String {
        let mut html = self.html.clone();
        for resource in &self.resources {
            if let Ok(bytes) = fs::read(&resource.asset_path) {
                let mime = crate::image_mime_from_bytes(&bytes);
                html = html.replace(
                    &resource.token,
                    &format!(
                        "data:{mime};base64,{}",
                        general_purpose::STANDARD.encode(bytes)
                    ),
                );
            }
        }
        html
    }
}

pub(crate) fn files_for_source(source: &str) -> Vec<PathBuf> {
    fs::read_dir(directory(source))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect()
}

#[derive(Serialize, Deserialize)]
struct RenderManifest {
    source_len: u64,
    source_modified: u128,
    render: RichRenderPayload,
}

pub(crate) fn cached_render(source: &str, len: u64, modified: u128) -> Option<RichRenderPayload> {
    let dir = directory(source);
    let path = dir.join("render.json");
    if fs::metadata(&path).ok()?.len() > 2 * 1024 * 1024 {
        return None;
    }
    let saved: RenderManifest = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if saved.source_len != len || saved.source_modified != modified {
        return None;
    }
    for resource in &saved.render.resources {
        let path = PathBuf::from(&resource.asset_path);
        if path.parent() != Some(dir.as_path())
            || !path.is_file()
            || resource.token != format!("vpaste-rich-image:{}", path.file_name()?.to_str()?)
        {
            return None;
        }
    }
    Some(saved.render)
}

pub(crate) fn cache_render(
    source: &str,
    len: u64,
    modified: u128,
    render: &RichRenderPayload,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(&RenderManifest {
        source_len: len,
        source_modified: modified,
        render: render.clone(),
    })
    .map_err(|err| err.to_string())?;
    crate::publish_image_cache_file(&directory(source).join("render.json"), &bytes, |path| {
        fs::read(path).is_ok_and(|old| old == bytes)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_images_are_files_and_drag_mime_remains_inline() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        let mut images = Images::new("rich-source");
        let token = images.resolve("data:image/png;base64,AA==").unwrap();
        let payload = images.finish(format!("<img src=\"{token}\">")).unwrap();
        assert!(!payload.html.contains("base64"));
        assert!(PathBuf::from(&payload.resources[0].asset_path).is_file());
        assert!(payload.drag_html().contains("data:image/png;base64,AA=="));
    }

    #[test]
    fn local_images_survive_source_removal_without_resident_bytes() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        let source = root.path().join("temporary.png");
        image::RgbImage::new(2, 2).save(&source).unwrap();
        let url = reqwest::Url::from_file_path(&source).unwrap().to_string();
        let first = Images::new("document").resolve(&url).unwrap();
        fs::remove_file(&source).unwrap();
        assert_eq!(Images::new("document").resolve(&url).unwrap(), first);
    }
}
