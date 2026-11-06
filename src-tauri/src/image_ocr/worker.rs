use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use image::RgbaImage;

use super::OcrError;

#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod native;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod native;

const WORKER_ARG: &str = "--vpaste-image-ocr-worker";
pub(super) const MAX_TEXT_BYTES: usize = 128 * 1024;
const MAX_OCR_SIDE: u32 = 3200;
const MAX_OCR_PIXELS: u64 = 4_000_000;
const TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn prepare_image(path: &Path) -> Result<RgbaImage, OcrError> {
    let bytes = crate::clipboard_budget::read_file_limited(
        path,
        crate::clipboard_budget::IMAGE_SOURCE_BYTES,
    )
    .map_err(|error| {
        if crate::clipboard_budget::is_limit_error(&error) {
            OcrError::ResourceLimit
        } else {
            OcrError::Failed
        }
    })?;
    let source = crate::clipboard_budget::decode_image(
        &bytes,
        crate::clipboard_budget::ImageOperation::Automatic,
    )
    .map_err(|error| {
        if crate::clipboard_budget::is_limit_error(&error) {
            OcrError::ResourceLimit
        } else {
            OcrError::Failed
        }
    })?;
    drop(bytes);
    let (width, height) = recognition_dimensions(source.width(), source.height());
    let mut image = if (width, height) == (source.width(), source.height()) {
        source.into_rgba8()
    } else {
        source
            .resize_exact(width, height, image::imageops::FilterType::Triangle)
            .into_rgba8()
    };
    // Transparent screenshots need a visible canvas for both native engines.
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha)) / 255) as u8;
        }
        pixel[3] = 255;
    }
    Ok(image)
}

fn recognition_dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = (MAX_OCR_SIDE as f64 / width.max(height) as f64)
        .min((MAX_OCR_PIXELS as f64 / (width as f64 * height as f64)).sqrt())
        .min(1.0);
    (
        ((width as f64 * scale).floor() as u32).max(1),
        ((height as f64 * scale).floor() as u32).max(1),
    )
}

pub(crate) fn run_if_requested() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(WORKER_ARG)) {
        return false;
    }
    let (Some(source), Some(output)) = (args.next(), args.next()) else {
        std::process::exit(2);
    };
    let result = recognize(Path::new(&source)).and_then(recognized_text);
    let saved = serde_json::to_vec(&result)
        .ok()
        .and_then(|bytes| std::fs::write(output, bytes).ok());
    std::process::exit(if saved.is_some() { 0 } else { 2 });
}

fn recognized_text(text: String) -> Result<String, OcrError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(OcrError::ResourceLimit);
    }
    let cjk = |ch: char| matches!(ch as u32, 0x3400..=0x9fff | 0x20000..=0x3134f | 0x3040..=0x30ff | 0xf900..=0xfaff);
    let mut output = String::with_capacity(text.len());
    let mut characters = text.trim().chars().peekable();
    while let Some(ch) = characters.next() {
        // WinRT inserts spaces between detected words, including individual
        // Han characters. Keep paragraphs and English spacing intact.
        if matches!(ch, ' ' | '\t') && output.chars().next_back().is_some_and(cjk) {
            let mut gap = String::from(ch);
            while characters
                .peek()
                .is_some_and(|next| matches!(next, ' ' | '\t'))
            {
                gap.push(characters.next().unwrap());
            }
            if !characters.peek().copied().is_some_and(cjk) {
                output.push_str(&gap);
            }
        } else {
            output.push(ch);
        }
    }
    Ok(output)
}

fn recognize(path: &Path) -> Result<String, OcrError> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    return native::recognize(prepare_image(path)?);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        Err(OcrError::Unsupported)
    }
}

struct WorkerChild(Child);

impl Drop for WorkerChild {
    fn drop(&mut self) {
        // Also reap the process on timeout, shutdown, or a failed wait.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_for_child(
    child: &mut Child,
    timeout: Duration,
    stopped: &AtomicBool,
) -> Result<(), OcrError> {
    let started = Instant::now();
    loop {
        if stopped.load(Ordering::Acquire) {
            return Err(OcrError::Failed);
        }
        if let Some(status) = child.try_wait().map_err(|_| OcrError::Failed)? {
            return if status.success() {
                Ok(())
            } else {
                Err(OcrError::Failed)
            };
        }
        if started.elapsed() >= timeout {
            return Err(OcrError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub(super) fn run(path: &str, stopped: &AtomicBool) -> Result<String, OcrError> {
    let result_file = tempfile::NamedTempFile::new().map_err(|_| OcrError::Failed)?;
    let mut command = Command::new(std::env::current_exe().map_err(|_| OcrError::Failed)?);
    command
        .arg(WORKER_ARG)
        .arg(path)
        .arg(result_file.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = WorkerChild(command.spawn().map_err(|_| OcrError::Failed)?);
    wait_for_child(&mut child.0, TIMEOUT, stopped)?;
    let bytes =
        crate::clipboard_budget::read_file_limited(result_file.path(), MAX_TEXT_BYTES * 6 + 1024)
            .map_err(|_| OcrError::Failed)?;
    let result: Result<String, OcrError> =
        serde_json::from_slice(&bytes).map_err(|_| OcrError::Failed)?;
    result.and_then(|text| {
        if text.len() <= MAX_TEXT_BYTES {
            Ok(text)
        } else {
            Err(OcrError::ResourceLimit)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_cjk_word_spaces_do_not_break_chinese_search_or_english_word_boundaries() {
        assert_eq!(
            recognized_text(" 图 片 文 字 invoice 2048\n第 二 行 800 元 ".into()).unwrap(),
            "图片文字 invoice 2048\n第二行 800 元"
        );
    }

    #[test]
    fn recognition_dimensions_keep_small_text_images_and_bound_large_images() {
        assert_eq!(recognition_dimensions(1920, 1080), (1920, 1080));
        for (width, height) in [(3840, 2160), (1000, 16000), (4000, 4000)] {
            let (w, h) = recognition_dimensions(width, height);
            assert!(w <= MAX_OCR_SIDE && h <= MAX_OCR_SIDE);
            assert!(u64::from(w) * u64::from(h) <= MAX_OCR_PIXELS);
            assert!((w as f64 / h as f64 - width as f64 / height as f64).abs() < 0.01);
        }
    }

    #[test]
    fn image_preparation_flattens_transparency_without_using_card_thumbnails() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transparent.png");
        RgbaImage::from_pixel(300, 100, image::Rgba([0, 0, 0, 0]))
            .save(&path)
            .unwrap();
        let prepared = prepare_image(&path).unwrap();
        assert_eq!(prepared.dimensions(), (300, 100));
        assert_eq!(prepared.get_pixel(0, 0).0, [255, 255, 255, 255]);
    }

    #[test]
    fn oversized_sources_are_rejected_before_decoding() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("oversized.png");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(crate::clipboard_budget::IMAGE_SOURCE_BYTES as u64 + 1)
            .unwrap();
        assert!(matches!(prepare_image(&path), Err(OcrError::ResourceLimit)));
    }

    #[test]
    fn timed_out_workers_are_killed_and_reaped() {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sleep");
            command.arg("30");
            command
        };
        let mut child = WorkerChild(
            command
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        assert!(matches!(
            wait_for_child(
                &mut child.0,
                Duration::from_millis(50),
                &AtomicBool::new(false)
            ),
            Err(OcrError::Timeout)
        ));
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
    }
}
