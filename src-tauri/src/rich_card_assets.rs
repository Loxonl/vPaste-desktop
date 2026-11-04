use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

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
    directory_at(Path::new(&crate::history_storage_dir()), source)
}

fn directory_at(root: &Path, source: &str) -> PathBuf {
    root.join("rich_preview_assets")
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
                let name = fs::metadata(&index)
                    .ok()
                    .filter(|meta| meta.len() < 100)
                    .and_then(|_| fs::read_to_string(&index).ok())
                    .filter(|name| {
                        PathBuf::from(name).file_name().and_then(|v| v.to_str())
                            == Some(name.as_str())
                    });
                let Some(bytes) = name.and_then(|name| {
                    let path = self.directory.join(name);
                    if fs::metadata(&path).ok()?.len() > IMAGE_BYTES as u64 {
                        self.over_budget = true;
                        return None;
                    }
                    fs::read(path).ok()
                }) else {
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

/// Imported HTML keeps its original temporary image URLs. Rebind their saved
/// source indices and render manifest without following archived absolute paths.
pub(crate) fn relocate(
    source: &str,
    target: &str,
    source_root: &Path,
    target_root: &Path,
) -> Result<usize, String> {
    let from = directory_at(source_root, source);
    let to = directory_at(target_root, target);
    if from == to || !from.is_dir() {
        return Ok(0);
    }
    let mut copied = 0;
    for entry in fs::read_dir(&from).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        if entry.file_name() == "render.json"
            || !entry.file_type().map_err(|err| err.to_string())?.is_file()
        {
            continue;
        }
        if crate::copy_history_file_with_progress(
            &entry.path(),
            &to.join(entry.file_name()),
            false,
            None,
        )? {
            copied += 1;
        }
    }
    let manifest_path = from.join("render.json");
    if !fs::metadata(&manifest_path).is_ok_and(|meta| meta.len() <= 2 * 1024 * 1024) {
        return Ok(copied);
    }
    let bytes = fs::read(manifest_path).map_err(|err| err.to_string())?;
    let Ok(mut saved) = serde_json::from_slice::<RenderManifest>(&bytes) else {
        return Ok(copied);
    };
    for resource in &mut saved.render.resources {
        let Some(name) = resource.token.strip_prefix("vpaste-rich-image:") else {
            return Ok(copied);
        };
        // Never follow a manifest's old absolute path, including on another OS.
        if name.is_empty()
            || name.contains(['/', '\\', ':'])
            || name == "."
            || name == ".."
            || resource.asset_path.rsplit(['/', '\\']).next() != Some(name)
        {
            return Ok(copied);
        }
        let path = to.join(name);
        if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_file()) {
            return Ok(copied);
        }
        resource.asset_path = path.to_string_lossy().into_owned();
    }
    let metadata = fs::metadata(target).map_err(|err| err.to_string())?;
    saved.source_len = metadata.len();
    saved.source_modified = metadata
        .modified()
        .map_err(|err| err.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_nanos();
    let bytes = serde_json::to_vec(&saved).map_err(|err| err.to_string())?;
    let manifest_path = to.join("render.json");
    if !fs::read(&manifest_path).is_ok_and(|old| old == bytes) {
        crate::publish_image_cache_file(&manifest_path, &bytes, |path| {
            fs::read(path).is_ok_and(|old| old == bytes)
        })?;
        copied += 1;
    }
    Ok(copied)
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
    let mut image_bytes = 0_u64;
    for resource in &saved.render.resources {
        let path = PathBuf::from(&resource.asset_path);
        if path.parent() != Some(dir.as_path())
            || resource.token != format!("vpaste-rich-image:{}", path.file_name()?.to_str()?)
        {
            return None;
        }
        let metadata = fs::metadata(path).ok()?;
        image_bytes = image_bytes.saturating_add(metadata.len());
        if !metadata.is_file()
            || metadata.len() > IMAGE_BYTES as u64
            || image_bytes > TOTAL_BYTES as u64
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
    fn imported_render_assets_cannot_bypass_existing_image_budgets() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        let mut accepted = Vec::new();
        for (source, count, size) in [
            ("oversized-image", 1, IMAGE_BYTES + 1),
            ("oversized-total", 5, IMAGE_BYTES),
        ] {
            let dir = directory(source);
            fs::create_dir_all(&dir).unwrap();
            let mut render = RichRenderPayload {
                html: "<p>Budget check</p>".into(),
                resources: Vec::new(),
            };
            for index in 0..count {
                let name = format!("{index}.png");
                let path = dir.join(&name);
                fs::write(&path, vec![0_u8; size]).unwrap();
                render.resources.push(RichImageResource {
                    token: format!("vpaste-rich-image:{name}"),
                    asset_path: path.to_string_lossy().into_owned(),
                    revision: index.to_string(),
                });
            }
            cache_render(source, 1, 2, &render).unwrap();
            accepted.push(cached_render(source, 1, 2).is_some());
        }
        assert_eq!(accepted, [false, false]);
    }

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
