use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use crate::{history_store, image_preview};

pub fn for_files(paths: &[PathBuf]) -> drag::Image {
    // The image is only the cursor preview; the session still carries the original files.
    let thumbnail = if paths.len() == 1 {
        thumbnail_png(&paths[0])
    } else {
        None
    };
    drag::Image::Raw(thumbnail.unwrap_or_else(|| include_bytes!("../icons/128x128.png").to_vec()))
}

pub fn for_drag(paths: &[PathBuf], card_png: Option<&[u8]>) -> Result<drag::Image, String> {
    let Some(png) = card_png else {
        return Ok(for_files(paths));
    };
    if png.len() > 1024 * 1024 {
        return Err("drag card snapshot exceeds its byte budget".into());
    }
    let reader = image::ImageReader::new(Cursor::new(png))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    if reader.format() != Some(image::ImageFormat::Png) {
        return Err("drag card snapshot must be a PNG".into());
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| error.to_string())?;
    if width == 0 || height == 0 || width > 1024 || height > 1024 {
        return Err("drag card snapshot exceeds its pixel budget".into());
    }
    image_preview::decode_card_image(png)?;
    Ok(drag::Image::Raw(png.to_vec()))
}

fn thumbnail_png(path: &Path) -> Option<Vec<u8>> {
    if history_store::file_len(path).ok()? > image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES {
        return None;
    }
    let image = if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        thumbnail_svg(path)?
    } else {
        let bytes = preview_bytes(path, image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES)?;
        let (width, height) = image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()?;
        if !dimensions_within_budget(width, height) {
            return None;
        }
        image_preview::decode_card_image(&bytes).ok()?
    };
    let thumbnail = image.thumbnail(image.width().min(128), image.height().min(128));
    let mut png = Vec::new();
    thumbnail
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(png)
}

fn preview_bytes(path: &Path, limit: u64) -> Option<Vec<u8>> {
    if history_store::file_len(path).ok()? > limit {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn dimensions_within_budget(width: u32, height: u32) -> bool {
    width <= image_preview::CARD_PREVIEW_MAX_DIMENSION
        && height <= image_preview::CARD_PREVIEW_MAX_DIMENSION
        && u64::from(width) * u64::from(height) <= image_preview::CARD_PREVIEW_MAX_PIXELS
}

fn thumbnail_svg(path: &Path) -> Option<image::DynamicImage> {
    use resvg::usvg::{ImageHrefResolver, ImageKind, Options, Tree};
    let bytes = preview_bytes(path, image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES)?;
    // Compressed SVGs cannot be bounded by the on-disk byte count.
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return None;
    }
    let rejected = AtomicBool::new(false);
    let remaining_bytes =
        AtomicU64::new(image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES - bytes.len() as u64);
    let remaining_pixels = AtomicU64::new(image_preview::CARD_PREVIEW_MAX_PIXELS);
    let default_data = ImageHrefResolver::default_data_resolver();
    let resolve_data = |mime: &str, data: Arc<Vec<u8>>, options: &Options| {
        let result = (|| {
            if rejected.load(Ordering::Relaxed) || data.starts_with(&[0x1f, 0x8b]) {
                return None;
            }
            remaining_bytes
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |remaining| {
                    remaining.checked_sub(data.len() as u64)
                })
                .ok()?;
            let kind = default_data(mime, data, options)?;
            let (width, height) = match &kind {
                ImageKind::SVG(tree) => {
                    let size = tree.size().to_int_size();
                    (size.width(), size.height())
                }
                ImageKind::JPEG(bytes)
                | ImageKind::PNG(bytes)
                | ImageKind::GIF(bytes)
                | ImageKind::WEBP(bytes) => image::ImageReader::new(Cursor::new(bytes.as_slice()))
                    .with_guessed_format()
                    .ok()?
                    .into_dimensions()
                    .ok()?,
            };
            if !dimensions_within_budget(width, height) {
                return None;
            }
            remaining_pixels
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |remaining| {
                    remaining.checked_sub(u64::from(width) * u64::from(height))
                })
                .ok()?;
            Some(kind)
        })();
        if result.is_none() {
            rejected.store(true, Ordering::Relaxed);
        }
        result
    };
    let mut options = Options {
        resources_dir: path.parent().map(Path::to_path_buf),
        image_href_resolver: ImageHrefResolver {
            resolve_data: Box::new(&resolve_data),
            resolve_string: Box::new(|href, options| {
                if rejected.load(Ordering::Relaxed) {
                    return None;
                }
                let resource = options.get_abs_path(Path::new(href));
                let Some(data) = preview_bytes(&resource, remaining_bytes.load(Ordering::Relaxed))
                else {
                    rejected.store(true, Ordering::Relaxed);
                    return None;
                };
                let mime = if resource
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
                {
                    "image/svg+xml"
                } else {
                    crate::image_mime_from_bytes(&data)
                };
                resolve_data(mime, Arc::new(data), options)
            }),
        },
        ..Default::default()
    };
    options.fontdb_mut().load_system_fonts();
    let tree = Tree::from_data(&bytes, &options).ok()?;
    let size = tree.size().to_int_size();
    if rejected.load(Ordering::Relaxed) || !dimensions_within_budget(size.width(), size.height()) {
        return None;
    }
    let scale = (128.0 / size.width() as f32)
        .min(128.0 / size.height() as f32)
        .min(1.0);
    let width = (size.width() as f32 * scale).round().max(1.0) as u32;
    let height = (size.height() as f32 * scale).round().max(1.0) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let pixels = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    image::RgbaImage::from_raw(width, height, pixels).map(image::DynamicImage::ImageRgba8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, ImageFormat, Rgba, RgbaImage};

    fn preview_pixels(paths: &[PathBuf]) -> RgbaImage {
        match for_files(paths) {
            drag::Image::Raw(bytes) => image::load_from_memory(&bytes).unwrap().to_rgba8(),
            drag::Image::File(_) => panic!("expected a self-contained drag thumbnail"),
        }
    }

    #[test]
    fn native_drag_preserves_the_complete_card_png_including_its_header() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.png");
        RgbaImage::from_pixel(320, 160, Rgba([0, 128, 255, 255]))
            .save(&source)
            .unwrap();
        let card = RgbaImage::from_fn(132, 138, |_, y| {
            if y < 30 {
                Rgba([45, 55, 65, 255])
            } else {
                Rgba([0, 128, 255, 255])
            }
        });
        let mut png = Vec::new();
        card.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let drag::Image::Raw(bytes) = for_drag(&[source.clone()], Some(&png)).unwrap() else {
            panic!("expected card PNG");
        };
        let preview = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(preview.dimensions(), (132, 138));
        assert_eq!(*preview.get_pixel(66, 15), Rgba([45, 55, 65, 255]));
        assert_eq!(*preview.get_pixel(66, 80), Rgba([0, 128, 255, 255]));
        assert_eq!(image::open(source).unwrap().dimensions(), (320, 160));
    }

    #[test]
    fn native_drag_rejects_malformed_card_preview_bytes() {
        assert!(for_drag(&[], Some(b"not a PNG snapshot")).is_err());
    }

    #[test]
    fn image_drag_uses_source_pixels_with_bounded_size_and_transparency() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("drag-image.png");
        RgbaImage::from_pixel(320, 160, Rgba([12, 34, 56, 128]))
            .save(&path)
            .unwrap();

        let preview = preview_pixels(&[path.clone()]);
        assert_eq!(preview.dimensions(), (128, 64));
        assert_eq!(*preview.get_pixel(64, 32), Rgba([12, 34, 56, 128]));
        assert_eq!(image::open(path).unwrap().width(), 320);
    }

    #[test]
    fn image_files_without_an_extension_use_their_own_thumbnail() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history-image");
        RgbaImage::from_pixel(17, 9, Rgba([255, 0, 0, 255]))
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();

        let preview = preview_pixels(&[path]);
        assert_eq!(preview.dimensions(), (17, 9));
        assert_eq!(*preview.get_pixel(0, 0), Rgba([255, 0, 0, 255]));
    }

    #[test]
    fn gif_drag_uses_a_static_thumbnail_and_keeps_the_gif_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("drag-image.gif");
        RgbaImage::from_pixel(80, 160, Rgba([0, 128, 255, 255]))
            .save_with_format(&path, ImageFormat::Gif)
            .unwrap();
        let original = std::fs::read(&path).unwrap();

        let preview = preview_pixels(&[path.clone()]);
        assert_eq!(preview.dimensions(), (64, 128));
        assert_eq!(*preview.get_pixel(32, 64), Rgba([0, 128, 255, 255]));
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[test]
    fn single_svg_image_files_use_their_own_thumbnail() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("drawing.svg");
        std::fs::write(&path, r##"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#0080ff"/></svg>"##).unwrap();

        let preview = preview_pixels(&[path]);
        assert_eq!(preview.dimensions(), (128, 64));
        assert_eq!(*preview.get_pixel(64, 32), Rgba([0, 128, 255, 255]));
    }

    #[test]
    fn svg_drag_preserves_bounded_linked_and_embedded_images() {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let image = root.path().join("linked.png");
        RgbaImage::from_pixel(2, 2, Rgba([0, 128, 255, 255]))
            .save(&image)
            .unwrap();
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(std::fs::read(&image).unwrap());
        for href in [
            "linked.png".to_string(),
            format!("data:image/png;base64,{encoded}"),
        ] {
            let path = root.path().join("linked.svg");
            std::fs::write(&path, format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><image href="{href}" width="128" height="64" preserveAspectRatio="none"/></svg>"#)).unwrap();
            assert_eq!(
                *preview_pixels(&[path]).get_pixel(64, 32),
                Rgba([0, 128, 255, 255])
            );
        }
    }

    #[test]
    fn svg_drag_rejects_resources_outside_the_automatic_preview_budget() {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let image = root.path().join("large.png");
        let mut bytes = Vec::new();
        RgbaImage::from_pixel(1, 1, Rgba([0, 128, 255, 255]))
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        // A PNG header declaring too many pixels must be rejected before decoding.
        let mut oversized_pixels = bytes.clone();
        oversized_pixels[16..20].copy_from_slice(&8192_u32.to_be_bytes());
        oversized_pixels[20..24].copy_from_slice(&8192_u32.to_be_bytes());
        let crc = oversized_pixels[12..29].iter().fold(u32::MAX, |crc, byte| {
            (0..8).fold(crc ^ u32::from(*byte), |crc, _| {
                (crc >> 1) ^ if crc & 1 != 0 { 0xedb88320 } else { 0 }
            })
        }) ^ u32::MAX;
        oversized_pixels[29..33].copy_from_slice(&crc.to_be_bytes());
        assert_eq!(
            image::ImageReader::new(Cursor::new(&oversized_pixels))
                .with_guessed_format()
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (8192, 8192)
        );
        for resource in [oversized_pixels, {
            let mut oversized_bytes = bytes.clone();
            oversized_bytes.resize(image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES as usize + 1, 0);
            oversized_bytes
        }] {
            std::fs::write(&image, &resource).unwrap();
            let encoded = base64::engine::general_purpose::STANDARD.encode(&resource);
            for href in [
                "large.png".to_string(),
                format!("data:image/png;base64,{encoded}"),
            ] {
                let path = root.path().join("large.svg");
                std::fs::write(&path, format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><image href="{href}" width="128" height="64"/></svg>"#)).unwrap();
                match for_files(&[path]) {
                    drag::Image::Raw(bytes) => assert!(
                        bytes.as_slice() == include_bytes!("../icons/128x128.png"),
                        "oversized SVG resources must use the existing fallback"
                    ),
                    drag::Image::File(_) => {
                        panic!("expected fallback for an oversized SVG resource")
                    }
                }
            }
        }
    }

    #[test]
    fn materialized_history_images_keep_full_drop_contents_with_a_separate_thumbnail() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let previous = crate::GLOBAL_APP_DATA_DIR
            .lock()
            .unwrap()
            .replace(root.path().to_string_lossy().into_owned());
        for (name, format) in [
            ("history-png", ImageFormat::Png),
            ("history-gif", ImageFormat::Gif),
        ] {
            let source = root.path().join(name);
            RgbaImage::from_pixel(320, 160, Rgba([0, 128, 255, 255]))
                .save_with_format(&source, format)
                .unwrap();
            let preview = preview_pixels(&[source.clone()]);
            let payload = PathBuf::from(
                crate::materialize_native_drag_image(source.to_str().unwrap()).unwrap(),
            );
            let original = std::fs::read(&payload).unwrap();
            assert_eq!(preview.dimensions(), (128, 64));
            assert_eq!(*preview.get_pixel(64, 32), Rgba([0, 128, 255, 255]));
            assert_eq!(image::open(&payload).unwrap().width(), 320);
            assert_eq!(image::guess_format(&original).unwrap(), format);
            assert_eq!(std::fs::read(payload).unwrap(), original);
        }
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = previous;
    }

    #[test]
    fn appkit_accepts_the_thumbnail_at_its_bounded_logical_size() {
        use cocoa::appkit::NSImage;
        use cocoa::base::nil;
        use cocoa::foundation::{NSAutoreleasePool, NSData};

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("appkit-image.png");
        RgbaImage::from_pixel(320, 160, Rgba([255, 0, 0, 128]))
            .save(&path)
            .unwrap();
        let drag::Image::Raw(bytes) = for_files(&[path]) else {
            panic!("expected PNG thumbnail bytes");
        };
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let data =
                NSData::dataWithBytes_length_(nil, bytes.as_ptr().cast(), bytes.len() as u64);
            let image = NSImage::initWithData_(NSImage::alloc(nil), data);
            assert_ne!(
                image, nil,
                "AppKit must be able to decode the native drag preview"
            );
            let image = objc::rc::StrongPtr::new(image);
            let size = NSImage::size(*image);
            assert_eq!((size.width, size.height), (128.0, 64.0));
            drop(image);
            pool.drain();
        }
    }

    #[test]
    fn ordinary_files_and_multi_file_drags_keep_the_existing_fallback() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("clip.txt");
        std::fs::write(&path, b"clipboard text file").unwrap();
        let image = root.path().join("multi-file.png");
        RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]))
            .save(&image)
            .unwrap();
        for paths in [vec![path.clone()], vec![image, path], vec![]] {
            match for_files(&paths) {
                drag::Image::Raw(bytes) => {
                    assert_eq!(bytes, include_bytes!("../icons/128x128.png"))
                }
                drag::Image::File(_) => panic!("expected the existing fallback"),
            }
        }
    }
}
