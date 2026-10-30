use std::hint::black_box;
use std::io::{Seek, SeekFrom, Write};
use std::time::Duration;

#[test]
fn automatic_pixel_budget_is_16_megapixels() {
    assert_eq!(crate::image_preview::CARD_PREVIEW_MAX_PIXELS, 16_000_000);
}

#[test]
fn automatic_animation_source_budget_is_10_mib() {
    assert_eq!(
        crate::image_preview::ANIMATED_PREVIEW_MAX_SOURCE_BYTES,
        10 * 1024 * 1024
    );
}

#[test]
fn rich_restoration_checks_the_combined_file_sizes_before_reading() {
    let root = tempfile::tempdir().unwrap();
    let html = root.path().join("body.html");
    let rtf = root.path().join("body.rtf");
    std::fs::File::create(&html)
        .unwrap()
        .set_len(16 * 1024 * 1024)
        .unwrap();
    std::fs::File::create(&rtf)
        .unwrap()
        .set_len(16 * 1024 * 1024)
        .unwrap();
    let meta = crate::clipboard::RichClipboardMeta {
        html_path: html.to_string_lossy().into_owned(),
        rtf_path: rtf.to_string_lossy().into_owned(),
        ..Default::default()
    };
    assert!(crate::validate_rich_restore_budget("", &meta).is_ok());
    assert!(crate::validate_rich_restore_budget("x", &meta).is_err());
}

#[test]
#[ignore = "isolated memory probe; run directly while sampling the test process"]
fn history_text_preview_memory_probe() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.txt");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(200 * 1024 * 1024)
        .unwrap();
    let preview = crate::clipboard_budget::read_text_preview(&path).unwrap();
    let text = preview.text;
    assert!(preview.truncated);
    println!("text_preview_bytes={}", text.len());
    black_box(&text);
    std::thread::sleep(Duration::from_millis(350));
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "isolated memory probe; synthetic bitmap only, no system clipboard"]
fn bitmap_conversion_memory_probe() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.dib");
    let width = 5000_i32;
    let height = 5000_i32;
    let mut header = vec![0_u8; 40];
    header[0..4].copy_from_slice(&40_u32.to_le_bytes());
    header[4..8].copy_from_slice(&width.to_le_bytes());
    header[8..12].copy_from_slice(&height.to_le_bytes());
    header[12..14].copy_from_slice(&1_u16.to_le_bytes());
    header[14..16].copy_from_slice(&32_u16.to_le_bytes());
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(&header).unwrap();
    file.seek(SeekFrom::Start(40 + width as u64 * height as u64 * 4 - 1))
        .unwrap();
    file.write_all(&[0]).unwrap();
    drop(file);
    let bytes = crate::history_store::read_file(&path).unwrap();
    let result = crate::clipboard::windows::image_convert::convert_bitmap_to_png(&bytes);
    println!("bitmap_bytes={} accepted={}", bytes.len(), result.is_ok());
    black_box((&bytes, &result));
    std::thread::sleep(Duration::from_millis(350));
}
