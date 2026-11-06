//! Resolve optional source artwork without changing the recorded process identity.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use sha2::{Digest, Sha256};

use super::listen::extract_process_icon_png_at;

const NEUTRAL_ICON: &str = "neutral-source-v1.png";
static GENERIC_REFERENCES: LazyLock<Mutex<HashMap<PathBuf, Option<Arc<image::RgbaImage>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static GENERIC_ICONS: LazyLock<Mutex<HashMap<PathBuf, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PRODUCT_ICONS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PREPARE_ICON: Mutex<()> = Mutex::new(());

pub(super) fn for_executable(exe: &Path, source: &str) -> String {
    let cache = PathBuf::from(crate::app_runtime_dir(&["app_icons"]));
    let extracted = extract_process_icon_png_at(exe, &cache, false);
    if let Some(path) = extracted
        .as_ref()
        .filter(|path| !is_generic_icon(Path::new(path), &cache))
    {
        return path.clone();
    }
    if let Some(icon) = doubao_root(exe).and_then(|root| product_icon(&root, &cache)) {
        if let Ok(mut icons) = PRODUCT_ICONS.lock() {
            icons.insert(process_icon_cache_key(exe), icon.clone());
        }
        return icon;
    }
    fallback(source, &cache)
}

pub(crate) fn for_history(source: &str, path: String) -> String {
    let cache = PathBuf::from(crate::app_runtime_dir(&["app_icons"]));
    if path.is_empty() {
        return fallback(source, &cache);
    }
    if !is_generic_icon(Path::new(&path), &cache) {
        return path;
    }
    if source.eq_ignore_ascii_case("ImeService") {
        if let Some(key) = legacy_cache_key(Path::new(&path)) {
            if let Some(icon) = remembered_product_icon(&key) {
                return icon;
            }
            // Scan known installation roots once, not once per card or clipboard event.
            static DISCOVERED: OnceLock<()> = OnceLock::new();
            DISCOVERED.get_or_init(|| {
                for variable in [
                    "ProgramFiles",
                    "ProgramW6432",
                    "ProgramFiles(x86)",
                    "LOCALAPPDATA",
                ] {
                    if let Some(base) = std::env::var_os(variable) {
                        let found =
                            installed_product_icons(&PathBuf::from(base).join("DoubaoIME"), &cache);
                        if let Ok(mut icons) = PRODUCT_ICONS.lock() {
                            icons.extend(found);
                        }
                    }
                }
            });
            if let Some(icon) = remembered_product_icon(&key) {
                return icon;
            }
        }
    }
    fallback(source, &cache)
}

fn fallback(source: &str, cache: &Path) -> String {
    crate::clipboard::bundled_app_source_icon_path(source)
        .or_else(|| neutral_icon(cache))
        .unwrap_or_default()
}

fn neutral_icon(cache: &Path) -> Option<String> {
    let _preparing = PREPARE_ICON.lock().ok()?;
    let path = cache.join(NEUTRAL_ICON);
    if !path.is_file() {
        let svg = include_str!("../../../icons/source/neutral-source.svg");
        let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default()).ok()?;
        let mut pixmap = resvg::tiny_skia::Pixmap::new(64, 64)?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::identity(),
            &mut pixmap.as_mut(),
        );
        fs::create_dir_all(cache).ok()?;
        pixmap.save_png(&path).ok()?;
    }
    Some(path.to_string_lossy().into_owned())
}

fn doubao_root(exe: &Path) -> Option<PathBuf> {
    if !exe
        .file_name()?
        .to_str()?
        .eq_ignore_ascii_case("ImeService.exe")
    {
        return None;
    }
    let versions = exe.parent()?.parent()?;
    let root = versions.parent()?;
    (versions
        .file_name()?
        .to_str()?
        .eq_ignore_ascii_case("versions")
        && root
            .file_name()?
            .to_str()?
            .eq_ignore_ascii_case("DoubaoIME"))
    .then(|| root.to_path_buf())
}

fn product_icon(root: &Path, cache: &Path) -> Option<String> {
    let _preparing = PREPARE_ICON.lock().ok()?;
    let logo = root.join("doubao_logo.ico");
    let output = cache.join(format!(
        "product-doubao-ime-{}-jumbo.png",
        process_icon_cache_key(&logo)
    ));
    if !output.is_file() {
        let image = bounded_icon(&logo)?;
        fs::create_dir_all(cache).ok()?;
        image.save(&output).ok()?;
    }
    Some(output.to_string_lossy().into_owned())
}

fn installed_product_icons(root: &Path, cache: &Path) -> HashMap<String, String> {
    let mut icons = HashMap::new();
    let Some(icon) = product_icon(root, cache) else {
        return icons;
    };
    let Ok(versions) = fs::read_dir(root.join("versions")) else {
        return icons;
    };
    for version in versions.flatten() {
        let exe = version.path().join("ImeService.exe");
        if exe.is_file() && doubao_root(&exe).as_deref() == Some(root) {
            icons.insert(process_icon_cache_key(&exe), icon.clone());
        }
    }
    icons
}

fn remembered_product_icon(key: &str) -> Option<String> {
    PRODUCT_ICONS
        .lock()
        .ok()?
        .get(key)
        .filter(|path| Path::new(path).is_file())
        .cloned()
}

pub(super) fn process_icon_cache_key(exe: &Path) -> String {
    let mut hash = Sha256::new();
    hash.update(exe.to_string_lossy().as_bytes());
    // Keep the existing fingerprint so old records can be matched without a DB migration.
    hash.update(b":hq-icon-v2:");
    if let Ok(metadata) = fs::metadata(exe) {
        if let Ok(modified) = metadata.modified() {
            if let Ok(elapsed) = modified.duration_since(std::time::UNIX_EPOCH) {
                hash.update(elapsed.as_millis().to_string().as_bytes());
            }
        }
        hash.update(metadata.len().to_string().as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn legacy_cache_key(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let key = stem.trim_end_matches("-jumbo").trim_end_matches("-large");
    (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| key.to_owned())
}

fn bounded_icon(path: &Path) -> Option<image::RgbaImage> {
    if fs::metadata(path).ok()?.len() > 1024 * 1024 {
        return None;
    }
    let mut reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(512);
    limits.max_image_height = Some(512);
    limits.max_alloc = Some(4 * 1024 * 1024);
    reader.limits(limits);
    Some(reader.decode().ok()?.to_rgba8())
}

fn is_generic_icon(path: &Path, cache: &Path) -> bool {
    if let Some(generic) = GENERIC_ICONS
        .lock()
        .ok()
        .and_then(|icons| icons.get(path).copied())
    {
        return generic;
    }
    let reference = {
        let mut references = match GENERIC_REFERENCES.lock() {
            Ok(references) => references,
            Err(_) => return false,
        };
        references
            .entry(cache.to_path_buf())
            .or_insert_with(|| {
                let reference =
                    extract_process_icon_png_at(Path::new("generic-source.exe"), cache, true)?;
                bounded_icon(Path::new(&reference)).map(Arc::new)
            })
            .clone()
    };
    // If Windows cannot supply a reference, do not guess and overwrite real artwork.
    let Some(reference) = reference else {
        return false;
    };
    let generic = bounded_icon(path).is_some_and(|image| {
        image.dimensions() == reference.dimensions()
            && image
                .pixels()
                .zip(reference.pixels())
                .all(|(pixel, expected)| {
                    // Shell rendering can round translucent edge colours by one level.
                    // Keep alpha and opaque artwork exact so real icons are not replaced.
                    pixel == expected
                        || (pixel[3] == expected[3]
                            && (1..255).contains(&pixel[3])
                            && pixel.0[..3]
                                .iter()
                                .zip(&expected.0[..3])
                                .all(|(left, right)| left.abs_diff(*right) <= 1))
                })
    });
    if let Ok(mut icons) = GENERIC_ICONS.lock() {
        icons.insert(path.to_path_buf(), generic);
    }
    generic
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_icon_allows_only_rounding_on_translucent_edges() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path();
        let mut reference = image::RgbaImage::from_pixel(32, 32, image::Rgba([120, 140, 180, 255]));
        for x in 0..26 {
            reference.put_pixel(x, 0, image::Rgba([119, 119, 116, 175]));
        }
        reference.put_pixel(31, 31, image::Rgba([0, 0, 0, 0]));
        reference
            .save(cache.join("system-generic-executable-v1-jumbo.png"))
            .unwrap();
        let mut rounded = reference.clone();
        for x in 0..26 {
            rounded.get_pixel_mut(x, 0).0[0] += 1;
        }
        let path = cache.join("rounded-edges.png");
        rounded.save(&path).unwrap();
        assert!(
            is_generic_icon(&path, cache),
            "one-level RGB rounding on identical translucent edges is still generic artwork"
        );

        for (name, x, y, channel, delta) in [
            ("opaque-colour.png", 3, 3, 0, 1),
            ("edge-colour.png", 0, 0, 0, 2),
            ("alpha.png", 0, 0, 3, 1),
            ("transparent-colour.png", 31, 31, 0, 1),
        ] {
            let mut different = reference.clone();
            different.get_pixel_mut(x, y).0[channel] += delta;
            let path = cache.join(name);
            different.save(&path).unwrap();
            assert!(!is_generic_icon(&path, cache), "preserve {name}");
        }
        let path = cache.join("different-size.png");
        image::RgbaImage::new(33, 32).save(&path).unwrap();
        assert!(!is_generic_icon(&path, cache));
        let path = cache.join("corrupt.png");
        fs::write(&path, b"not an icon").unwrap();
        assert!(!is_generic_icon(&path, cache));
    }

    #[test]
    fn source_icon_product_matching_requires_the_full_directory_structure() {
        let root = Path::new("C:/Apps/DoubaoIME");
        assert_eq!(
            doubao_root(&root.join("versions/v1.2.3/ImeService.exe")),
            Some(root.to_path_buf())
        );
        for path in [
            "C:/Apps/Other/ImeService.exe",
            "C:/Apps/DoubaoIME-copy/versions/v1/ImeService.exe",
            "C:/Apps/DoubaoIME/bootstrap/ImeService.exe",
            "C:/Apps/DoubaoIME/versions/v1/Other.exe",
        ] {
            assert!(doubao_root(Path::new(path)).is_none(), "{path}");
        }
    }

    #[test]
    fn source_icon_history_catalog_matches_fingerprints_without_a_new_capture() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("DoubaoIME");
        let cache = temporary.path().join("icons");
        for version in ["v0.9", "v1.0"] {
            let exe = root.join("versions").join(version).join("ImeService.exe");
            fs::create_dir_all(exe.parent().unwrap()).unwrap();
            fs::write(exe, version).unwrap();
        }
        let logo = image::RgbaImage::from_pixel(16, 16, image::Rgba([210, 30, 70, 255]));
        logo.save_with_format(root.join("doubao_logo.ico"), image::ImageFormat::Ico)
            .unwrap();
        let catalog = installed_product_icons(&root, &cache);
        assert_eq!(catalog.len(), 2);
        for version in ["v0.9", "v1.0"] {
            let exe = root.join("versions").join(version).join("ImeService.exe");
            let icon = catalog.get(&process_icon_cache_key(&exe)).unwrap();
            assert!(image::open(icon).unwrap().to_rgba8() == logo);
            assert_eq!(
                legacy_cache_key(
                    &cache.join(format!("{}-jumbo.png", process_icon_cache_key(&exe)))
                )
                .as_deref(),
                Some(process_icon_cache_key(&exe).as_str())
            );
        }
        assert!(legacy_cache_key(Path::new("ImeService-jumbo.png")).is_none());
    }

    #[test]
    fn source_icon_missing_or_corrupt_product_logo_falls_back_without_branding() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("DoubaoIME");
        fs::create_dir_all(root.join("versions/v1")).unwrap();
        let cache = temporary.path().join("icons");
        assert!(installed_product_icons(&root, &cache).is_empty());
        fs::write(root.join("doubao_logo.ico"), b"not an icon").unwrap();
        assert!(product_icon(&root, &cache).is_none());
        let neutral = neutral_icon(&cache).unwrap();
        let image = bounded_icon(Path::new(&neutral)).unwrap();
        assert_eq!(image.dimensions(), (64, 64));
        assert!(image
            .pixels()
            .filter(|pixel| pixel[3] != 0)
            .all(|pixel| pixel[0] == pixel[1] && pixel[1] == pixel[2]));
    }

    #[test]
    fn source_icon_product_decoding_is_bounded() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("oversized.png");
        image::RgbaImage::new(513, 1).save(&path).unwrap();
        assert!(bounded_icon(&path).is_none());
    }

    #[test]
    #[ignore = "requires a local installed input method and a fresh Windows Shell runtime"]
    fn source_icon_native_installed_product_probe() {
        let exe = PathBuf::from(
            std::env::var_os("VPASTE_SOURCE_ICON_PROBE_EXE")
                .expect("set an installed ImeService.exe path"),
        );
        let _runtime = tauri::Builder::<tauri::Wry>::new()
            .any_thread()
            .build(tauri::generate_context!())
            .expect("initialize an isolated runtime, without windows or plugins");
        let temporary = tempfile::tempdir().unwrap();
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(temporary.path().to_string_lossy().into_owned());
        // Match the real capture/materialization workers, not just the COM-initialized UI thread.
        std::thread::spawn(move || {
            let cache = PathBuf::from(crate::app_runtime_dir(&["app_icons"]));
            fs::create_dir_all(&cache).unwrap();
            if let Some(reference) = std::env::var_os("VPASTE_SOURCE_ICON_PROBE_GENERIC_PNG") {
                fs::copy(reference, cache.join("system-generic-executable-v1-jumbo.png")).unwrap();
            }
            if let Some(legacy) = std::env::var_os("VPASTE_SOURCE_ICON_PROBE_LEGACY_PNG") {
                fs::copy(legacy, cache.join(format!("{}-jumbo.png", process_icon_cache_key(&exe)))).unwrap();
            }
            let native = extract_process_icon_png_at(&exe, &cache, false).expect("extract the real writer's icon");
            assert!(is_generic_icon(Path::new(&native), &cache), "the installed service has the system default artwork");
            let legacy = std::env::var("VPASTE_SOURCE_ICON_PROBE_LEGACY_PNG").unwrap_or(native);
            let started = std::time::Instant::now();
            let repaired = for_history("ImeService", legacy);
            let legacy_us = started.elapsed().as_micros();
            assert!(Path::new(&repaired).file_name().unwrap().to_string_lossy().starts_with("product-doubao-ime-"), "upgrade existing history before any new capture");
            let started = std::time::Instant::now();
            let captured = for_executable(&exe, "ImeService");
            let capture_us = started.elapsed().as_micros();
            assert_eq!(repaired, captured);
            assert!(!is_generic_icon(Path::new(&captured), &cache));
            assert!(bounded_icon(Path::new(&captured)).is_some());
            eprintln!("native source-icon probe passed on background worker: old history upgraded before capture; legacy_us={legacy_us}, capture_us={capture_us}");
        }).join().expect("native worker completed");
    }
}
