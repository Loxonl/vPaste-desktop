use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use image::ImageDecoder;
use serde::Serialize;

pub const MIB: usize = 1024 * 1024;
pub const TEXT_CAPTURE_BYTES: usize = 8 * MIB;
pub const RICH_CAPTURE_BYTES: usize = 32 * MIB;
pub const IMAGE_SOURCE_BYTES: usize = 32 * MIB;
pub const BITMAP_CAPTURE_BYTES: usize = 64 * MIB;
pub const SNAPSHOT_BYTES: usize = 128 * MIB;
pub const BUFFERED_BYTES: usize = 128 * MIB;
pub const TEXT_PREVIEW_BYTES: usize = 256 * 1024;
pub const AUTOMATIC_PIXELS: u64 = 16_000_000;
pub const AUTOMATIC_ALLOCATION: u64 = 96 * MIB as u64;
pub const ANIMATION_SOURCE_BYTES: u64 = 10 * MIB as u64;
pub const ANIMATION_FRAMES: u64 = 200;
pub const ANIMATION_PIXELS: u64 = 64_000_000;
pub const MAX_DIMENSION: u32 = 16_384;

#[derive(Clone, Copy)]
pub enum ImageOperation {
    Automatic,
    Restore,
}

impl ImageOperation {
    pub fn pixels(self) -> u64 {
        match self {
            Self::Automatic => AUTOMATIC_PIXELS,
            Self::Restore => 32_000_000,
        }
    }

    pub fn allocation(self) -> u64 {
        match self {
            Self::Automatic => AUTOMATIC_ALLOCATION,
            Self::Restore => 192 * MIB as u64,
        }
    }
}

pub fn limit_error() -> String {
    "内容超过安全大小限制，无法处理".to_string()
}

pub fn is_limit_error(error: &str) -> bool {
    error.contains("安全大小限制")
}

pub fn validate_dimensions(
    width: u32,
    height: u32,
    operation: ImageOperation,
) -> Result<(), String> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || pixels > operation.pixels()
    {
        return Err(limit_error());
    }
    Ok(())
}

pub fn read_file_limited(path: impl AsRef<Path>, limit: usize) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if size > limit as u64 {
        return Err(limit_error());
    }
    let mut bytes = Vec::with_capacity(size as usize + 1);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err(limit_error());
    }
    Ok(bytes)
}

#[derive(Serialize)]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
}

pub fn text_preview(mut bytes: Vec<u8>) -> Result<TextPreview, String> {
    let truncated = bytes.len() > TEXT_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(TEXT_PREVIEW_BYTES);
        if let Err(error) = std::str::from_utf8(&bytes) {
            if error.error_len().is_some() {
                return Err(error.to_string());
            }
            bytes.truncate(error.valid_up_to());
        }
    }
    Ok(TextPreview {
        text: String::from_utf8(bytes).map_err(|error| error.to_string())?,
        truncated,
    })
}

pub fn read_text_preview(path: impl AsRef<Path>) -> Result<TextPreview, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let mut bytes = Vec::with_capacity(size.min(TEXT_PREVIEW_BYTES as u64) as usize + 1);
    file.take(TEXT_PREVIEW_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    text_preview(bytes)
}

pub struct ImageWriter(pub Vec<u8>);

impl Write for ImageWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > IMAGE_SOURCE_BYTES {
            return Err(std::io::Error::other(limit_error()));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl std::io::Seek for ImageWriter {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        match position {
            std::io::SeekFrom::Current(0) | std::io::SeekFrom::End(0) => Ok(self.0.len() as u64),
            std::io::SeekFrom::Start(offset) if offset == self.0.len() as u64 => Ok(offset),
            _ => Err(std::io::Error::other(
                "image encoder attempted non-sequential output",
            )),
        }
    }
}

pub fn decode_image(
    bytes: &[u8],
    operation: ImageOperation,
) -> Result<image::DynamicImage, String> {
    if bytes.len() > IMAGE_SOURCE_BYTES {
        return Err(limit_error());
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(operation.allocation());
    reader.limits(limits);
    let image_error = |error: image::ImageError| match error {
        image::ImageError::Limits(_) => limit_error(),
        other => other.to_string(),
    };
    let decoder = reader.into_decoder().map_err(image_error)?;
    let (width, height) = decoder.dimensions();
    validate_dimensions(width, height, operation)?;
    image::DynamicImage::from_decoder(decoder).map_err(image_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_budgets_preserve_4k_and_tall_images_but_bound_total_pixels() {
        assert!(validate_dimensions(3840, 2160, ImageOperation::Automatic).is_ok());
        assert!(validate_dimensions(1000, 16_000, ImageOperation::Automatic).is_ok());
        assert!(validate_dimensions(4000, 4000, ImageOperation::Automatic).is_ok());
        assert!(validate_dimensions(4001, 4000, ImageOperation::Automatic).is_err());
        assert!(validate_dimensions(4001, 4000, ImageOperation::Restore).is_ok());
        assert!(validate_dimensions(8001, 4000, ImageOperation::Restore).is_err());
        assert!(validate_dimensions(u32::MAX, u32::MAX, ImageOperation::Restore).is_err());
    }

    #[test]
    fn text_preview_keeps_utf8_boundaries_and_does_not_change_the_source() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("text.txt");
        let text = "中".repeat(TEXT_PREVIEW_BYTES / 3 + 2);
        std::fs::write(&path, text.as_bytes()).unwrap();
        let preview = read_text_preview(&path).unwrap();
        assert!(preview.truncated);
        assert!(preview.text.len() <= TEXT_PREVIEW_BYTES);
        assert!(text.starts_with(&preview.text));
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        let exact = text_preview(vec![b'a'; TEXT_PREVIEW_BYTES]).unwrap();
        assert!(!exact.truncated);
        assert!(text_preview(vec![0xff]).is_err());
    }

    #[test]
    fn bounded_reads_reject_a_large_file_before_reading_the_body() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("large");
        File::create(&path)
            .unwrap()
            .set_len(200 * MIB as u64)
            .unwrap();
        assert!(read_file_limited(&path, IMAGE_SOURCE_BYTES).is_err());
        let preview = read_text_preview(path).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.text.len(), TEXT_PREVIEW_BYTES);
    }
}
