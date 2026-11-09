use image::RgbaImage;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

use super::super::OcrError;

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

pub(super) fn recognize(mut image: RgbaImage) -> Result<String, OcrError> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| OcrError::Failed)?;
    let _apartment = Apartment;
    // The WinRT factory returns E_POINTER when none of the user's languages
    // has an installed OCR pack. It is not a clipboard/paste permission error.
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|error| {
        match error.code().0 as u32 {
            0x8000_4003 => OcrError::LanguageUnavailable, // null recognizer
            0x8004_0154 => OcrError::Unsupported,         // class not registered
            _ => OcrError::Failed,
        }
    })?;
    let maximum = OcrEngine::MaxImageDimension().map_err(|_| OcrError::Failed)?;
    if image.width() > maximum || image.height() > maximum {
        image = image::imageops::thumbnail(&image, maximum, maximum);
    }
    for pixel in image.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    let run = || -> windows::core::Result<String> {
        let writer = DataWriter::new()?;
        writer.WriteBytes(image.as_raw())?;
        let buffer = writer.DetachBuffer()?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            image.width() as i32,
            image.height() as i32,
        )?;
        let result = engine.RecognizeAsync(&bitmap)?.get()?;
        let lines = result.Lines()?;
        let mut text = String::new();
        for index in 0..lines.Size()? {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&lines.GetAt(index)?.Text()?.to_string());
        }
        Ok(text)
    };
    run().map_err(|_| OcrError::Failed)
}
