use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use base64::{engine::general_purpose, Engine as _};
use chrono::Local;
use image::codecs::gif::{GifEncoder, Repeat};
use image::{Delay, Frame, ImageBuffer, ImageFormat, Rgba};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::clipboard;
use crate::clipboard::item::{Item, ItemType};

const CONFIG_SCHEMA_VERSION: u32 = 1;
const TEST_ROOM_DIR: &str = "debug";
const CONFIG_FILE: &str = "test-room-samples.json";
const MANIFEST_FILE: &str = "test-room-generated.json";
const CASE_HISTORY_MANIFEST_FILE: &str = "test-room-case-history.json";
const MAX_SAMPLE_TIME_OFFSET_MS: u64 = 5 * 60_000;
static CASE_RUN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleItem {
    id: String,
    name: String,
    item_type: String,
    value: String,
    #[serde(default)]
    preset_id: String,
    app_source: String,
    #[serde(default)]
    time_offset_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleGroup {
    id: String,
    name: String,
    built_in: bool,
    items: Vec<SampleItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRoomConfig {
    schema_version: u32,
    groups: Vec<SampleGroup>,
    #[serde(default)]
    deleted_built_in_group_ids: Vec<String>,
    #[serde(default)]
    deleted_built_in_item_ids: Vec<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedManifest {
    schema_version: u32,
    groups: HashMap<String, Vec<String>>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestCaseHistoryManifest {
    schema_version: u32,
    runs: Vec<TestCaseHistoryRun>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestCaseHistoryRun {
    local_date: String,
    created_at_ms: u64,
    hashes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRoomOperationResult {
    affected_items: usize,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCaseResult {
    passed: bool,
    message: String,
    duration_ms: u128,
}

fn ensure_enabled() -> Result<(), String> {
    if crate::get_developer_mode() {
        Ok(())
    } else {
        Err("测试间只在带 --dev-mode 参数的 Debug 构建中可用".to_string())
    }
}

fn test_room_path(file_name: &str) -> PathBuf {
    PathBuf::from(crate::get_app_data_dir())
        .join(TEST_ROOM_DIR)
        .join(file_name)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|err| format!("读取 {} 失败：{}", path.display(), err))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|err| format!("{} 内容已损坏，原文件已保留：{}", path.display(), err))
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "测试间配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut file = fs::File::create(&temp_path).map_err(|err| err.to_string())?;
        std::io::Write::write_all(&mut file, &bytes).map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
    }
    replace_file(&temp_path, path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!("保存 {} 失败：{}", path.display(), err)
    })
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|err| std::io::Error::other(err.to_string()))
    }
}

fn validate_config(config: &TestRoomConfig) -> Result<(), String> {
    if config.schema_version != CONFIG_SCHEMA_VERSION {
        return Err(format!("不支持的测试间配置版本：{}", config.schema_version));
    }
    let mut group_ids = HashSet::new();
    let mut item_ids = HashSet::new();
    for group in &config.groups {
        if group.id.trim().is_empty() || group.name.trim().is_empty() {
            return Err("分组 ID 和名称不能为空".to_string());
        }
        if !group_ids.insert(group.id.as_str()) {
            return Err(format!("分组 ID 重复：{}", group.id));
        }
        for item in &group.items {
            if item.id.trim().is_empty() {
                return Err(format!("分组 {} 中存在空白粘贴项 ID", group.name));
            }
            if !item_ids.insert(item.id.as_str()) {
                return Err(format!("粘贴项 ID 重复：{}", item.id));
            }
            if !matches!(
                item.item_type.as_str(),
                "Text" | "RichText" | "Excel" | "Color" | "Link" | "Image" | "File" | "TextFile"
            ) {
                return Err(format!("不支持的粘贴项类型：{}", item.item_type));
            }
            validate_sample_time_offset(item)?;
        }
    }
    Ok(())
}

fn validate_sample_time_offset(item: &SampleItem) -> Result<(), String> {
    if item
        .time_offset_ms
        .is_some_and(|offset| offset > MAX_SAMPLE_TIME_OFFSET_MS)
    {
        Err(format!(
            "粘贴项 {} 的时间需要在 0–300 秒内",
            sample_item_label(item)
        ))
    } else {
        Ok(())
    }
}

fn sample_item_label(item: &SampleItem) -> &str {
    if item.name.trim().is_empty() {
        item.item_type.as_str()
    } else {
        item.name.as_str()
    }
}

fn validate_loaded_config(config: &TestRoomConfig) -> Result<(), String> {
    if config.schema_version > CONFIG_SCHEMA_VERSION {
        return Err(format!("测试间配置来自更高版本：{}", config.schema_version));
    }
    let mut compatible = config.clone();
    compatible.schema_version = CONFIG_SCHEMA_VERSION;
    validate_config(&compatible)
}

#[tauri::command]
pub fn get_test_room_config() -> Result<Option<TestRoomConfig>, String> {
    ensure_enabled()?;
    let config = read_json::<TestRoomConfig>(&test_room_path(CONFIG_FILE))?;
    if let Some(config) = &config {
        validate_loaded_config(config)?;
    }
    Ok(config)
}

#[tauri::command]
pub fn save_test_room_config(config: TestRoomConfig) -> Result<(), String> {
    ensure_enabled()?;
    validate_config(&config)?;
    atomic_write_json(&test_room_path(CONFIG_FILE), &config)
}

fn generated_hash(group_id: &str, item_id: &str) -> String {
    clipboard::calculate_xxhash64(
        format!("vpaste-test-room:v1:{}:{}", group_id, item_id).as_bytes(),
    )
}

fn sample_time_offset_ms(index: usize) -> u64 {
    (index as u64)
        .saturating_mul(1_000)
        .min(MAX_SAMPLE_TIME_OFFSET_MS)
}

fn preset_value(item_type: &str, value: &str) -> Result<String, String> {
    let resolved = match (item_type, value) {
        ("RichText", "rich-launch") => "vPaste 让常用内容触手可及\n更快整理，更安心粘贴。",
        ("RichText", "rich-meeting") => "本周重点\n• 完成体验验证\n• 准备产品演示",
        ("RichText", "rich-release-en") => {
            "A calmer clipboard workflow\n• Local by default\n• Ready when you need it"
        }
        ("Color", "color-indigo") => "#5B67F1",
        ("Color", "color-mint") => "#4CBF9B",
        ("Color", "color-coral") => "#F47B62",
        ("Link", "link-vpaste") => "https://vpaste.app",
        ("Link", "link-example") => "https://example.com/product-demo",
        ("TextFile", "textfile-notes") => "vPaste Demo Release Notes\n\n- Smooth clipboard history\n- Safe local storage\n- Fast keyboard workflow\n",
        ("TextFile", "textfile-readme") => {
            "# vPaste Demo\n\nThis file contains non-sensitive sample content for screenshots.\n"
        }
        ("Image", "image-logo" | "image-gradient" | "image-grid") => value,
        ("File", "file-brief" | "file-assets") => value,
        (
            "Excel",
            "excel-sales" | "excel-projects" | "excel-budget" | "excel-inventory"
            | "excel-campaign",
        ) => return excel_preset(value).map(|preset| preset.0),
        ("Text" | "RichText" | "Color" | "Link" | "TextFile", value)
            if !value.trim().is_empty() =>
        {
            value
        }
        ("Excel", value) if !value.trim().is_empty() => {
            excel_table_html(value)?;
            value
        }
        _ => return Err(format!("{} 内容或预设无效", item_type)),
    };
    Ok(resolved.to_string())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn excel_table_html(plain: &str) -> Result<String, String> {
    let rows = plain
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let Some(headers) = rows.first() else {
        return Err("Excel 表格内容不能为空".to_string());
    };
    if headers.len() < 2 {
        return Err("Excel 表格至少需要两列，请使用 Tab 分隔".to_string());
    }
    let header_html = headers
        .iter()
        .map(|value| format!("<th>{}</th>", escape_html(value)))
        .collect::<String>();
    let rows_html = rows
        .iter()
        .skip(1)
        .map(|row| {
            let cells = row
                .iter()
                .map(|value| format!("<td>{}</td>", escape_html(value)))
                .collect::<String>();
            format!("<tr>{}</tr>", cells)
        })
        .collect::<String>();
    Ok(format!(
        "<table><thead><tr>{}</tr></thead><tbody>{}</tbody></table>",
        header_html, rows_html
    ))
}

fn rich_text_html(name: &str, value: &str) -> String {
    format!(
        "<div><h2>{}</h2><p>{}</p></div>",
        escape_html(name),
        escape_html(value).replace('\n', "<br>")
    )
}

fn excel_preset(preset: &str) -> Result<(String, String), String> {
    let (headers, rows): (&[&str], &[&[&str]]) = match preset {
        "excel-sales" => (
            &["产品", "区域", "销售额", "环比"],
            &[
                &["Workspace", "华东", "¥128,600", "+12.4%"],
                &["Starter", "华南", "¥86,240", "+8.1%"],
                &["Team", "华北", "¥64,900", "-2.3%"],
            ],
        ),
        "excel-projects" => (
            &["项目", "负责人", "状态", "截止日期"],
            &[
                &["桌面端演示", "林晓", "进行中", "2026-08-18"],
                &["素材整理", "陈雨", "已完成", "2026-08-12"],
                &["发布检查", "周宁", "待开始", "2026-08-22"],
            ],
        ),
        "excel-budget" => (
            &["类别", "预算", "实际", "差额"],
            &[
                &["设计", "¥20,000", "¥18,500", "+¥1,500"],
                &["制作", "¥35,000", "¥36,200", "-¥1,200"],
                &["投放", "¥50,000", "¥46,800", "+¥3,200"],
            ],
        ),
        "excel-inventory" => (
            &["SKU", "品名", "库存", "状态"],
            &[
                &["DEMO-101", "便携支架", "128", "充足"],
                &["DEMO-205", "收纳包", "34", "补货中"],
                &["DEMO-318", "数据线", "76", "正常"],
            ],
        ),
        "excel-campaign" => (
            &["Channel", "Impressions", "Clicks", "Conversion"],
            &[
                &["Search", "128,400", "6,320", "4.9%"],
                &["Social", "96,800", "4,210", "4.3%"],
                &["Newsletter", "42,600", "3,180", "7.5%"],
            ],
        ),
        _ => return Err(format!("未知 Excel 预设：{}", preset)),
    };
    let plain = std::iter::once(headers.join("\t"))
        .chain(rows.iter().map(|row| row.join("\t")))
        .collect::<Vec<_>>()
        .join("\n");
    let html = excel_table_html(&plain)?;
    Ok((plain, html))
}

fn basic_item(
    hash: String,
    content: String,
    item_type: ItemType,
    app_source: &str,
    time: u64,
) -> Item {
    Item {
        id: 0,
        preview_content: content.chars().take(50).collect(),
        text_content: String::new(),
        rich_html: String::new(),
        app_source: app_source.to_string(),
        app_icon_path: String::new(),
        hash,
        content,
        title_color: String::new(),
        item_type,
        time,
        search_index: 1,
        label: 0,
        tags: Vec::new(),
    }
}

fn image_bytes(preset: &str) -> Result<Vec<u8>, String> {
    if preset == "image-logo" {
        let logo =
            image::load_from_memory(include_bytes!("../icons/source/vpaste-app-icon-1024.png"))
                .map_err(|err| format!("无法读取产品 Logo：{err}"))?
                .resize_exact(256, 256, image::imageops::FilterType::Lanczos3)
                .to_rgba8();
        let mut image = ImageBuffer::from_pixel(256, 256, Rgba([255, 255, 255, 255]));
        image::imageops::overlay(&mut image, &logo, 0, 0);
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .map_err(|err| err.to_string())?;
        return Ok(bytes);
    }
    let mut image = ImageBuffer::from_fn(720, 420, |x, y| {
        if preset == "image-grid" {
            let cell = ((x / 90) + (y / 70)) % 2;
            if cell == 0 {
                Rgba([91, 103, 241, 255])
            } else {
                Rgba([76, 191, 155, 255])
            }
        } else {
            let ratio = x as f32 / 719.0;
            Rgba([
                (91.0 + 153.0 * ratio) as u8,
                (103.0 + 20.0 * ratio) as u8,
                (241.0 - 143.0 * ratio) as u8,
                255,
            ])
        }
    });
    for y in 130..290 {
        for x in 220..500 {
            if (x + y) % 7 != 0 {
                image.put_pixel(x, y, Rgba([255, 255, 255, 225]));
            }
        }
    }
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|err| err.to_string())?;
    Ok(bytes)
}

fn pdf_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

fn simple_pdf(text: &str) -> Vec<u8> {
    let mut stream = String::from("BT\n/F1 18 Tf\n");
    for (index, line) in text.lines().take(32).enumerate() {
        let font_size = if index == 0 { 18 } else { 11 };
        let y = 760_i32 - index as i32 * 22;
        stream.push_str(&format!(
            "/F1 {} Tf\n1 0 0 1 50 {} Tm\n({}) Tj\n",
            font_size,
            y,
            pdf_escape(line)
        ));
    }
    stream.push_str("ET\n");

    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{}endstream", stream.len(), stream),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref_offset = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        pdf.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            objects.len() + 1,
            xref_offset
        )
        .as_bytes(),
    );
    pdf
}

fn fixture_files(preset: &str) -> Result<Vec<PathBuf>, String> {
    let dir = test_room_path("fixtures");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let files: Vec<(&str, Vec<u8>)> = match preset {
        "file-brief" => vec![(
            "vPaste Intro.pdf",
            simple_pdf(include_str!("../fixtures/test-room/vpaste-intro.txt")),
        )],
        "file-assets" => vec![
            (
                "Campaign-Copy.txt",
                b"Create freely. Paste confidently.\n".to_vec(),
            ),
            (
                "Brand-Colors.txt",
                b"Indigo #5B67F1\nMint #4CBF9B\n".to_vec(),
            ),
        ],
        _ => return Err(format!("未知文件预设：{}", preset)),
    };
    let mut paths = Vec::new();
    for (name, bytes) in files {
        let path = dir.join(name);
        write_fixture(&path, &bytes)?;
        paths.push(path);
    }
    Ok(paths)
}

struct FileCaseFixtures {
    txt: PathBuf,
    png: PathBuf,
    psd: PathBuf,
    folder: PathBuf,
    missing: PathBuf,
}

fn simple_psd() -> Vec<u8> {
    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 64;
    let mut bytes = Vec::with_capacity(40 + (WIDTH * HEIGHT * 3) as usize);
    bytes.extend_from_slice(b"8BPS");
    bytes.extend_from_slice(&1_u16.to_be_bytes());
    bytes.extend_from_slice(&[0; 6]);
    bytes.extend_from_slice(&3_u16.to_be_bytes());
    bytes.extend_from_slice(&HEIGHT.to_be_bytes());
    bytes.extend_from_slice(&WIDTH.to_be_bytes());
    bytes.extend_from_slice(&8_u16.to_be_bytes());
    bytes.extend_from_slice(&3_u16.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&0_u16.to_be_bytes());
    for channel in [91_u8, 103, 241] {
        bytes.extend(vec![channel; (WIDTH * HEIGHT) as usize]);
    }
    bytes
}

fn write_fixture(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::read(path).ok().as_deref() != Some(bytes) {
        fs::write(path, bytes).map_err(|err| format!("写入 {} 失败：{}", path.display(), err))?;
    }
    Ok(())
}

fn file_case_fixtures() -> Result<FileCaseFixtures, String> {
    let dir = test_room_path("fixtures/file-cases");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let txt = dir.join("vPaste-Test.txt");
    let png = dir.join("vPaste-Preview.png");
    let psd = dir.join("vPaste-Design.psd");
    write_fixture(
        &txt,
        b"vPaste file test fixture\nSafe local content for clipboard testing.\n",
    )?;
    write_fixture(&png, &image_bytes("image-grid")?)?;
    write_fixture(&psd, &simple_psd())?;

    let folder = dir.join("vPaste-Test-Folder");
    fs::create_dir_all(&folder).map_err(|err| err.to_string())?;
    write_fixture(
        &folder.join("README.txt"),
        b"This folder is generated by the vPaste Debug Test Room.\n",
    )?;

    let missing = dir.join("Deleted-vPaste-File.txt");
    if missing.exists() {
        fs::remove_file(&missing).map_err(|err| err.to_string())?;
    }
    Ok(FileCaseFixtures {
        txt,
        png,
        psd,
        folder,
        missing,
    })
}

fn insert_file_paths(
    hash: &str,
    paths: &[PathBuf],
    name: &str,
    app_source: &str,
    time: u64,
) -> Result<(), String> {
    let content = serde_json::to_string(
        &paths
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
    )
    .map_err(|err| err.to_string())?;
    let mut history_item = basic_item(
        hash.to_string(),
        content.clone(),
        ItemType::File,
        app_source,
        time,
    );
    history_item.preview_content = content;
    clipboard::insert_with_source_and_app(&history_item, name, "", app_source, "");
    Ok(())
}

fn insert_sample_item(group_id: &str, item: &SampleItem, time: u64) -> Result<String, String> {
    let hash = generated_hash(group_id, &item.id);
    let value = preset_value(&item.item_type, &item.value)?;
    let search_content;
    match item.item_type.as_str() {
        "Text" => {
            search_content = value.clone();
            let history_item =
                basic_item(hash.clone(), value, ItemType::Text, &item.app_source, time);
            clipboard::insert_with_source_and_app(
                &history_item,
                &search_content,
                "",
                &item.app_source,
                "",
            );
        }
        "Color" => {
            search_content = value.clone();
            let history_item =
                basic_item(hash.clone(), value, ItemType::Color, &item.app_source, time);
            clipboard::insert_with_source_and_app(
                &history_item,
                &search_content,
                "",
                &item.app_source,
                "",
            );
        }
        "Link" => {
            search_content = value.clone();
            let history_item =
                basic_item(hash.clone(), value, ItemType::Link, &item.app_source, time);
            clipboard::insert_with_source_and_app(
                &history_item,
                &search_content,
                "",
                &item.app_source,
                "",
            );
        }
        "RichText" => {
            let html = rich_text_html(&item.name, &value);
            clipboard::insert_test_room_rich_text(
                hash.clone(),
                value,
                html.into_bytes(),
                &item.app_source,
                time,
            );
        }
        "Excel" => {
            let html = excel_table_html(&value)?;
            clipboard::insert_test_room_rich_text(
                hash.clone(),
                value,
                html.into_bytes(),
                &item.app_source,
                time,
            );
        }
        "Image" => {
            let bytes = image_bytes(&value)?;
            let path = clipboard::save_to_disk(&bytes, &hash);
            if crate::history_store::read_file(&path).ok().as_deref() != Some(bytes.as_slice()) {
                crate::history_store::write_file(&path, &bytes)
                    .map_err(|err| format!("更新图片样板失败：{err}"))?;
            }
            let history_item =
                basic_item(hash.clone(), path, ItemType::Image, &item.app_source, time);
            clipboard::insert_with_source_and_app(&history_item, "", "", &item.app_source, "");
        }
        "File" => {
            let paths = fixture_files(&value)?;
            insert_file_paths(&hash, &paths, &item.name, &item.app_source, time)?;
        }
        "TextFile" => {
            let path = clipboard::save_to_disk(value.as_bytes(), &hash);
            let history_item = basic_item(
                hash.clone(),
                path,
                ItemType::TextFile,
                &item.app_source,
                time,
            );
            clipboard::insert_with_source_and_app(&history_item, &value, "", &item.app_source, "");
        }
        _ => unreachable!(),
    }
    if clipboard::count_by_hash(&hash) != 1 {
        return Err(format!("写入粘贴项 {} 失败", sample_item_label(item)));
    }
    Ok(hash)
}

fn load_manifest() -> Result<GeneratedManifest, String> {
    Ok(
        read_json(&test_room_path(MANIFEST_FILE))?.unwrap_or(GeneratedManifest {
            schema_version: CONFIG_SCHEMA_VERSION,
            groups: HashMap::new(),
        }),
    )
}

fn delete_hashes(hashes: &[String]) -> Result<usize, String> {
    hashes.iter().try_fold(0usize, |affected, hash| {
        clipboard::delete_by_hash(hash).map(|count| affected + count)
    })
}

fn current_local_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn load_case_history_manifest() -> Result<TestCaseHistoryManifest, String> {
    Ok(
        read_json(&test_room_path(CASE_HISTORY_MANIFEST_FILE))?.unwrap_or(
            TestCaseHistoryManifest {
                schema_version: CONFIG_SCHEMA_VERSION,
                runs: Vec::new(),
            },
        ),
    )
}

fn record_test_case_history_hashes(created_at_ms: u64, hashes: Vec<String>) -> Result<(), String> {
    let mut manifest = load_case_history_manifest()?;
    manifest.schema_version = CONFIG_SCHEMA_VERSION;
    manifest.runs.push(TestCaseHistoryRun {
        local_date: current_local_date(),
        created_at_ms,
        hashes,
    });
    atomic_write_json(&test_room_path(CASE_HISTORY_MANIFEST_FILE), &manifest)
}

fn record_test_case_history(created_at_ms: u64, hash: String) -> Result<(), String> {
    record_test_case_history_hashes(created_at_ms, vec![hash])
}

fn finalize_test_room_clipboard_history(
    created_at_ms: u64,
    hash: &str,
    copy_result: Result<(), String>,
) -> Result<(), String> {
    if let Err(copy_error) = copy_result {
        if let Err(cleanup_error) = clipboard::delete_by_hash(hash) {
            return Err(format!(
                "{}；回滚测试历史失败：{}",
                copy_error, cleanup_error
            ));
        }
        return Err(copy_error);
    }

    if let Err(manifest_error) = record_test_case_history(created_at_ms, hash.to_string()) {
        if let Err(cleanup_error) = clipboard::delete_by_hash(hash) {
            return Err(format!(
                "{}；回滚测试历史失败：{}",
                manifest_error, cleanup_error
            ));
        }
        return Err(manifest_error);
    }

    Ok(())
}

fn cleanup_test_case_history_for_date(local_date: &str) -> Result<usize, String> {
    let mut manifest = load_case_history_manifest()?;
    let (matched, retained): (Vec<_>, Vec<_>) = manifest
        .runs
        .into_iter()
        .partition(|run| run.local_date == local_date);
    let affected = matched.iter().try_fold(0usize, |count, run| {
        delete_hashes(&run.hashes).map(|deleted| count + deleted)
    })?;
    manifest.runs = retained;
    manifest.schema_version = CONFIG_SCHEMA_VERSION;
    atomic_write_json(&test_room_path(CASE_HISTORY_MANIFEST_FILE), &manifest)?;
    Ok(affected)
}

fn clipboard_case_sample(case_id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match case_id {
        "clipboard-text" | "text-roundtrip" => {
            Some(("Text", "vPaste test room roundtrip", "vPaste"))
        }
        "clipboard-rich-text" => Some(("RichText", "rich-launch", "vPaste")),
        "clipboard-color" => Some(("Color", "color-indigo", "vPaste")),
        "clipboard-link" => Some(("Link", "link-vpaste", "vPaste")),
        "clipboard-image" | "image-roundtrip" => Some(("Image", "image-grid", "vPaste")),
        "metadata-roundtrip" => Some(("Color", "color-indigo", "Microsoft Word")),
        _ => None,
    }
}

fn run_clipboard_case(case_id: &str) -> Result<String, String> {
    let (item_type, value, app_source) =
        clipboard_case_sample(case_id).ok_or_else(|| format!("未知基础粘贴用例：{}", case_id))?;
    let created_at_ms = clipboard::current_timestamp_millis();
    let run_id = CASE_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let group_id = format!("case-{}-{}-{}", case_id, created_at_ms, run_id);
    let item = SampleItem {
        id: "roundtrip".to_string(),
        name: format!("{} test case", item_type),
        item_type: item_type.to_string(),
        value: value.to_string(),
        preset_id: String::new(),
        app_source: app_source.to_string(),
        time_offset_ms: None,
    };
    let hash = generated_hash(&group_id, &item.id);
    insert_sample_item(&group_id, &item, created_at_ms)?;
    if let Err(err) = record_test_case_history(created_at_ms, hash.clone()) {
        let _ = clipboard::delete_by_hash(&hash);
        return Err(format!("测试历史登记失败：{}", err));
    }

    (|| {
        let stored = clipboard::try_get_by_hash(&hash)
            .ok_or_else(|| format!("{} 测试项未能从历史数据库读回", item_type))?;
        let expected_type = match item_type {
            "Text" | "RichText" => ItemType::Text,
            "Color" => ItemType::Color,
            "Link" => ItemType::Link,
            "Image" => ItemType::Image,
            "File" => ItemType::File,
            "TextFile" => ItemType::TextFile,
            _ => unreachable!(),
        };
        if stored.item_type != expected_type {
            return Err(format!("{} 测试项类型不一致", item_type));
        }
        if stored.app_source != app_source {
            return Err(format!("{} 测试项来源 App 不一致", item_type));
        }
        match item_type {
            "Text" if stored.content != value => Err("纯文本内容不一致".to_string()),
            "RichText"
                if stored.content.trim().is_empty() || stored.rich_html.trim().is_empty() =>
            {
                Err("富文本摘要或 HTML 内容为空".to_string())
            }
            "Color" if stored.content != "#5B67F1" => Err("颜色值不一致".to_string()),
            "Link" if stored.content != "https://vpaste.app" => Err("链接 URL 不一致".to_string()),
            "Image" => crate::history_store::read_file(&stored.content).and_then(|bytes| {
                if bytes.is_empty() {
                    Err("图片文件内容为空".to_string())
                } else {
                    Ok(())
                }
            }),
            "File" => {
                let paths: Vec<String> =
                    serde_json::from_str(&stored.content).map_err(|err| err.to_string())?;
                if paths.len() != 2 || paths.iter().any(|path| !Path::new(path).is_file()) {
                    Err("文件组合不完整".to_string())
                } else {
                    Ok(())
                }
            }
            "TextFile" => crate::history_store::read_file(&stored.content).and_then(|bytes| {
                if bytes.is_empty() {
                    Err("文本文件内容为空".to_string())
                } else {
                    Ok(())
                }
            }),
            _ => Ok(()),
        }
    })()?;

    Ok(format!(
        "{} 粘贴项写入并读回正常，测试历史已保留",
        item_type
    ))
}

fn case_history_identity(case_id: &str) -> (u64, String) {
    let created_at_ms = clipboard::current_timestamp_millis();
    let run_id = CASE_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let group_id = format!("case-{}-{}-{}", case_id, created_at_ms, run_id);
    (created_at_ms, generated_hash(&group_id, "roundtrip"))
}

fn register_case_history(created_at_ms: u64, hash: &str) -> Result<(), String> {
    if let Err(err) = record_test_case_history(created_at_ms, hash.to_string()) {
        let _ = clipboard::delete_by_hash(hash);
        return Err(format!("测试历史登记失败：{}", err));
    }
    Ok(())
}

fn file_case_path_groups(case_id: &str) -> Result<Vec<Vec<PathBuf>>, String> {
    let fixtures = file_case_fixtures()?;
    match case_id {
        "file-single-types" => Ok(vec![
            vec![fixtures.txt],
            vec![fixtures.png],
            vec![fixtures.psd],
        ]),
        "file-multiple" => Ok(vec![vec![fixtures.txt, fixtures.png, fixtures.psd]]),
        "file-folder" => Ok(vec![vec![fixtures.folder]]),
        "file-folder-and-file" => Ok(vec![vec![fixtures.folder, fixtures.txt]]),
        "file-missing" => Ok(vec![vec![fixtures.missing]]),
        _ => Err(format!("未知文件测试用例：{}", case_id)),
    }
}

fn validate_file_case(
    case_id: &str,
    hashes: &[String],
    expected_paths: &[Vec<PathBuf>],
) -> Result<(), String> {
    if hashes.len() != expected_paths.len() {
        return Err("文件测试写入数量不正确".to_string());
    }
    for (hash, paths) in hashes.iter().zip(expected_paths) {
        let stored = clipboard::try_get_by_hash(hash)
            .ok_or_else(|| "文件测试项未能从历史数据库读回".to_string())?;
        if stored.item_type != ItemType::File {
            return Err("文件测试项类型不正确".to_string());
        }
        let stored_paths: Vec<String> =
            serde_json::from_str(&stored.content).map_err(|err| err.to_string())?;
        let expected = paths
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        if stored_paths != expected {
            return Err("文件测试项路径不一致".to_string());
        }
    }

    match case_id {
        "file-single-types" => {
            let extensions = expected_paths
                .iter()
                .map(|paths| {
                    paths[0]
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_ascii_lowercase()
                })
                .collect::<Vec<_>>();
            if extensions != ["txt", "png", "psd"]
                || expected_paths.iter().any(|paths| !paths[0].is_file())
            {
                return Err("TXT、PNG、PSD 单文件测试项不完整".to_string());
            }
        }
        "file-multiple" => {
            if expected_paths[0].len() != 3 || expected_paths[0].iter().any(|path| !path.is_file())
            {
                return Err("TXT、PNG、PSD 多文件测试项不完整".to_string());
            }
        }
        "file-folder" if !expected_paths[0][0].is_dir() => {
            return Err("单文件夹测试项不完整".to_string());
        }
        "file-folder-and-file" => {
            if expected_paths[0].len() != 2
                || !expected_paths[0].iter().any(|path| path.is_dir())
                || !expected_paths[0].iter().any(|path| path.is_file())
            {
                return Err("文件夹与文件测试项不完整".to_string());
            }
        }
        "file-missing" if expected_paths[0][0].exists() => {
            return Err("已删除文件路径仍然存在".to_string());
        }
        _ => {}
    }
    Ok(())
}

fn run_file_case(case_id: &str) -> Result<String, String> {
    let path_groups = file_case_path_groups(case_id)?;
    let created_at_ms = clipboard::current_timestamp_millis();
    let run_id = CASE_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let run_scope = format!("case-{}-{}-{}", case_id, created_at_ms, run_id);
    let mut hashes = Vec::with_capacity(path_groups.len());
    for (index, paths) in path_groups.iter().enumerate() {
        let hash = generated_hash(&run_scope, &format!("file-{}", index));
        insert_file_paths(
            &hash,
            paths,
            &format!("{} file test", case_id),
            "File Explorer",
            created_at_ms.saturating_sub(index as u64),
        )?;
        hashes.push(hash.clone());
        if clipboard::count_by_hash(&hash) != 1 {
            let _ = delete_hashes(&hashes);
            return Err("文件测试项写入失败".to_string());
        }
    }
    if let Err(err) = record_test_case_history_hashes(created_at_ms, hashes.clone()) {
        let _ = delete_hashes(&hashes);
        return Err(format!("测试历史登记失败：{}", err));
    }
    validate_file_case(case_id, &hashes, &path_groups)?;

    let message = match case_id {
        "file-single-types" => "TXT、PNG、PSD 已依次写入为三个粘贴项",
        "file-multiple" => "TXT、PNG、PSD 已写入为一个多文件粘贴项",
        "file-folder" => "单文件夹粘贴项已写入",
        "file-folder-and-file" => "文件夹与文件已写入为一个粘贴项",
        "file-missing" => "已删除文件粘贴项已写入并保持失效状态",
        _ => unreachable!(),
    };
    Ok(format!("{}，测试历史已保留", message))
}

fn run_long_text_boundary_case() -> Result<String, String> {
    let created_at_ms = clipboard::current_timestamp_millis();
    let run_id = CASE_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let run_scope = format!("boundary-long-text-{}-{}", created_at_ms, run_id);
    let mut hashes = Vec::with_capacity(1);

    let result = (|| {
        let long_text = format!(
            "vPaste 边界测试 · 长普通文本 · {}\n{}",
            run_scope,
            "这是一段用于验证卡片摘要、搜索和完整粘贴的普通文本。\n".repeat(1_200),
        );
        let plain_hash = clipboard::calculate_xxhash64(long_text.as_bytes());
        clipboard::insert_text_from_app(long_text.clone(), "vPaste Test Room", "");
        if clipboard::count_by_hash(&plain_hash) != 1 {
            return Err("长普通文本测试项写入失败".to_string());
        }
        hashes.push(plain_hash.clone());
        let plain_item = clipboard::try_get_by_hash(&plain_hash)
            .ok_or_else(|| "长普通文本测试项无法读回".to_string())?;
        if plain_item.item_type != ItemType::TextFile
            || plain_item.preview_content.chars().count() > 1_800
            || clipboard::plain_text_content(&plain_hash)? != long_text
        {
            return Err("长普通文本未按受控摘要和完整正文分层保存".to_string());
        }

        record_test_case_history_hashes(created_at_ms, hashes.clone())
            .map_err(|err| format!("测试历史登记失败：{}", err))?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = delete_hashes(&hashes);
        return Err(err);
    }

    Ok("超长文本已写入；主面板应显示受控摘要，粘贴仍保留完整内容".to_string())
}

fn run_large_image_boundary_case() -> Result<String, String> {
    let created_at_ms = clipboard::current_timestamp_millis();
    let run_id = CASE_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let run_scope = format!("boundary-large-image-{}-{}", created_at_ms, run_id);
    let mut hashes = Vec::with_capacity(1);

    let result = (|| {
        let mut large_image = image_bytes("image-grid")?;
        large_image.resize(
            crate::image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES as usize + 1,
            0,
        );
        large_image.extend_from_slice(run_scope.as_bytes());
        let image_hash = clipboard::calculate_xxhash64(&large_image);
        clipboard::insert_image_with_text_and_app(
            &large_image,
            "vPaste 边界测试 · 超大图片",
            "vPaste Test Room",
            "",
        );
        if clipboard::count_by_hash(&image_hash) != 1 {
            return Err("超大图片测试项写入失败".to_string());
        }
        hashes.push(image_hash.clone());
        let image_item = clipboard::try_get_by_hash(&image_hash)
            .ok_or_else(|| "超大图片测试项无法读回".to_string())?;
        let metadata = crate::image_preview::metadata_for_path(&image_item.content)?;
        if image_item.item_type != ItemType::Image
            || !metadata.preview_limited
            || metadata.source_bytes <= crate::image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES
        {
            return Err("超大图片未进入受控预览降级路径".to_string());
        }

        record_test_case_history_hashes(created_at_ms, hashes.clone())
            .map_err(|err| format!("测试历史登记失败：{}", err))?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = delete_hashes(&hashes);
        return Err(err);
    }

    Ok("超大图片已写入；主面板应显示稳定的预览受限占位".to_string())
}

fn run_large_gif_boundary_case() -> Result<String, String> {
    let created_at_ms = clipboard::current_timestamp_millis();
    let run_id = CASE_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let run_scope = format!("boundary-large-gif-{}-{}", created_at_ms, run_id);
    let mut hashes = Vec::with_capacity(1);

    let result = (|| {
        let mut large_gif = animated_gif_bytes()?;
        large_gif.resize(
            crate::image_preview::ANIMATED_PREVIEW_MAX_SOURCE_BYTES as usize + 1,
            0,
        );
        large_gif.extend_from_slice(run_scope.as_bytes());
        let gif_hash = clipboard::calculate_xxhash64(&large_gif);
        clipboard::insert_image_with_text_and_app(
            &large_gif,
            "vPaste 边界测试 · 大型 GIF",
            "vPaste Test Room",
            "",
        );
        if clipboard::count_by_hash(&gif_hash) != 1 {
            return Err("大型 GIF 测试项写入失败".to_string());
        }
        hashes.push(gif_hash.clone());
        let gif_item = clipboard::try_get_by_hash(&gif_hash)
            .ok_or_else(|| "大型 GIF 测试项无法读回".to_string())?;
        let metadata = crate::image_preview::metadata_for_path(&gif_item.content)?;
        if gif_item.item_type != ItemType::Image
            || !metadata.is_gif
            || !metadata.animation_limited
            || metadata.preview_limited
            || metadata.source_bytes <= crate::image_preview::ANIMATED_PREVIEW_MAX_SOURCE_BYTES
            || metadata.source_bytes > crate::image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES
        {
            return Err("大型 GIF 未进入静态预览、禁止自动播放的降级路径".to_string());
        }

        record_test_case_history_hashes(created_at_ms, hashes.clone())
            .map_err(|err| format!("测试历史登记失败：{}", err))?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = delete_hashes(&hashes);
        return Err(err);
    }

    Ok("大型 GIF 已写入；主面板应显示静态首帧，不应自动播放".to_string())
}

fn png_data_url(preset: &str) -> Result<String, String> {
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(image_bytes(preset)?)
    ))
}

fn run_excel_chart_case() -> Result<String, String> {
    let (created_at_ms, hash) = case_history_identity("excel-chart");
    let (plain, table) = excel_preset("excel-sales")?;
    let chart = png_data_url("image-gradient")?;
    let html = format!(
        "<div>{}<p>季度趋势</p><img src=\"{}\" alt=\"季度趋势图\"></div>",
        table, chart
    );
    clipboard::insert_test_room_rich_text(
        hash.clone(),
        plain,
        html.into_bytes(),
        "Microsoft Excel",
        created_at_ms,
    );
    register_case_history(created_at_ms, &hash)?;
    let stored = clipboard::try_get_by_hash(&hash)
        .ok_or_else(|| "Excel 测试项未能从历史数据库读回".to_string())?;
    if stored.app_source != "Microsoft Excel"
        || !Path::new(&stored.app_icon_path).is_file()
        || !stored.rich_html.contains("<table")
        || stored.rich_html.matches("<img").count() != 1
    {
        return Err("Excel 表格、图表或来源 App 不完整".to_string());
    }
    Ok("Excel 表格与图表已写入，测试历史已保留".to_string())
}

fn run_qq_two_images_case() -> Result<String, String> {
    let (created_at_ms, hash) = case_history_identity("qq-two-images");
    let first = png_data_url("image-gradient")?;
    let second = png_data_url("image-grid")?;
    let html = format!(
        "<div><p>本周样片，请查看两张预览。</p><img src=\"{}\" alt=\"预览一\"><img src=\"{}\" alt=\"预览二\"></div>",
        first, second
    );
    clipboard::insert_test_room_rich_text(
        hash.clone(),
        "本周样片，请查看两张预览。".to_string(),
        html.into_bytes(),
        "QQ",
        created_at_ms,
    );
    register_case_history(created_at_ms, &hash)?;
    let stored = clipboard::try_get_by_hash(&hash)
        .ok_or_else(|| "QQ 双图测试项未能从历史数据库读回".to_string())?;
    if stored.app_source != "QQ"
        || !Path::new(&stored.app_icon_path).is_file()
        || stored.rich_html.matches("<img").count() != 2
    {
        return Err("QQ 单条消息未保留两张图片".to_string());
    }
    Ok("QQ 单条双图消息已写入，测试历史已保留".to_string())
}

fn animated_gif_bytes() -> Result<Vec<u8>, String> {
    let first = ImageBuffer::from_pixel(96, 64, Rgba([91_u8, 103, 241, 255]));
    let second = ImageBuffer::from_pixel(96, 64, Rgba([76_u8, 191, 155, 255]));
    let frames = [
        Frame::from_parts(first, 0, 0, Delay::from_numer_denom_ms(180, 1)),
        Frame::from_parts(second, 0, 0, Delay::from_numer_denom_ms(180, 1)),
    ];
    let mut bytes = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut bytes);
        encoder
            .set_repeat(Repeat::Infinite)
            .map_err(|err| err.to_string())?;
        encoder
            .encode_frames(frames)
            .map_err(|err| err.to_string())?;
    }
    Ok(bytes)
}

fn run_gif_history_case() -> Result<String, String> {
    let (created_at_ms, hash) = case_history_identity("gif-history");
    let gif = animated_gif_bytes()?;
    let path = clipboard::save_to_disk(&gif, &hash);
    let item = basic_item(hash.clone(), path, ItemType::Image, "QQ", created_at_ms);
    clipboard::insert_with_source_and_app(&item, "GIF 动画样片", "GIF 动画样片", "QQ", "");
    register_case_history(created_at_ms, &hash)?;
    let stored = clipboard::try_get_by_hash(&hash)
        .ok_or_else(|| "GIF 测试项未能从历史数据库读回".to_string())?;
    let bytes = crate::history_store::read_file(&stored.content)?;
    if stored.item_type != ItemType::Image
        || !Path::new(&stored.app_icon_path).is_file()
        || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
    {
        return Err("GIF 格式或历史类型不正确".to_string());
    }
    Ok("双帧 GIF 已写入，测试历史已保留".to_string())
}

fn write_test_room_groups_to_history(groups: Vec<SampleGroup>) -> Result<usize, String> {
    for group in &groups {
        for item in &group.items {
            validate_sample_time_offset(item)?;
        }
    }
    let mut manifest = load_manifest()?;
    let now = clipboard::current_timestamp_millis();
    let mut written = 0;
    for group in groups {
        if group.id.trim().is_empty() {
            return Err("分组 ID 不能为空".to_string());
        }
        if let Some(existing) = manifest.groups.get(&group.id) {
            delete_hashes(existing)?;
        }
        manifest.groups.remove(&group.id);
        atomic_write_json(&test_room_path(MANIFEST_FILE), &manifest)?;
        let mut hashes = Vec::new();
        for (index, item) in group.items.iter().enumerate() {
            let time_offset_ms = item
                .time_offset_ms
                .unwrap_or_else(|| sample_time_offset_ms(index));
            let inserted = insert_sample_item(&group.id, item, now.saturating_sub(time_offset_ms));
            let hash = match inserted {
                Ok(hash) => hash,
                Err(err) => {
                    let _ = delete_hashes(&hashes);
                    return Err(err);
                }
            };
            hashes.push(hash);
            written += 1;
        }
        manifest.groups.insert(group.id, hashes);
        manifest.schema_version = CONFIG_SCHEMA_VERSION;
        atomic_write_json(&test_room_path(MANIFEST_FILE), &manifest)?;
    }
    Ok(written)
}

#[tauri::command]
pub fn write_test_room_groups(
    app: tauri::AppHandle,
    groups: Vec<SampleGroup>,
) -> Result<TestRoomOperationResult, String> {
    ensure_enabled()?;
    let written = write_test_room_groups_to_history(groups)?;
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.emit("listen_new_clipboard", ());
    }
    Ok(TestRoomOperationResult {
        affected_items: written,
        message: format!("已写入 {} 个安全样板", written),
    })
}

#[tauri::command]
pub fn copy_test_room_item_to_clipboard(
    app: tauri::AppHandle,
    item: SampleItem,
) -> Result<TestRoomOperationResult, String> {
    ensure_enabled()?;
    let created_at_ms = clipboard::current_timestamp_millis();
    let sequence = CASE_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let group_id = format!("clipboard-{}-{}", created_at_ms, sequence);
    let hash = insert_sample_item(&group_id, &item, created_at_ms)?;
    let result = (|| {
        let stored = clipboard::try_get_by_hash(&hash)
            .ok_or_else(|| "样板未能写入临时剪贴板记录".to_string())?;
        let (content, item_type, rich_meta) = match item.item_type.as_str() {
            "RichText" | "Excel" => (
                stored.content,
                "Text".to_string(),
                clipboard::rich_clipboard_meta(&hash),
            ),
            "Image" => (stored.content, "Image".to_string(), None),
            "File" => (stored.content, "File".to_string(), None),
            "TextFile" => (
                preset_value("TextFile", &item.value)?,
                "Text".to_string(),
                None,
            ),
            _ => (stored.content, "Text".to_string(), None),
        };
        crate::copy_with_rich_meta(app.clone(), content, item_type, rich_meta)
    })();
    finalize_test_room_clipboard_history(created_at_ms, &hash, result)?;
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.emit("listen_new_clipboard", ());
    }
    Ok(TestRoomOperationResult {
        affected_items: 1,
        message: "已写入当前剪贴板".to_string(),
    })
}

#[tauri::command]
pub fn cleanup_test_room_groups(
    app: tauri::AppHandle,
    group_ids: Option<Vec<String>>,
) -> Result<TestRoomOperationResult, String> {
    ensure_enabled()?;
    let mut manifest = load_manifest()?;
    let ids = group_ids.unwrap_or_else(|| manifest.groups.keys().cloned().collect());
    let mut affected = 0;
    for group_id in ids {
        if let Some(hashes) = manifest.groups.remove(&group_id) {
            affected += delete_hashes(&hashes)?;
        }
    }
    atomic_write_json(&test_room_path(MANIFEST_FILE), &manifest)?;
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.emit("listen_new_clipboard", ());
    }
    Ok(TestRoomOperationResult {
        affected_items: affected,
        message: format!("已清理 {} 个测试间粘贴项", affected),
    })
}

#[tauri::command]
pub fn cleanup_today_test_room_case_history(
    app: tauri::AppHandle,
) -> Result<TestRoomOperationResult, String> {
    ensure_enabled()?;
    let affected = cleanup_test_case_history_for_date(&current_local_date())?;
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.emit("listen_new_clipboard", ());
    }
    Ok(TestRoomOperationResult {
        affected_items: affected,
        message: format!("已清理今日 {} 条测试历史", affected),
    })
}

fn cleanup_test_room_history_records() -> Result<usize, String> {
    let mut manifest = load_manifest()?;
    let sample_hashes = manifest
        .groups
        .values()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    let mut affected = delete_hashes(&sample_hashes)?;
    manifest.groups.clear();
    manifest.schema_version = CONFIG_SCHEMA_VERSION;
    atomic_write_json(&test_room_path(MANIFEST_FILE), &manifest)?;
    affected += cleanup_test_case_history_for_date(&current_local_date())?;
    Ok(affected)
}

#[tauri::command]
pub fn cleanup_test_room_history(app: tauri::AppHandle) -> Result<TestRoomOperationResult, String> {
    ensure_enabled()?;
    let affected = cleanup_test_room_history_records()?;
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.emit("listen_new_clipboard", ());
    }
    Ok(TestRoomOperationResult {
        affected_items: affected,
        message: format!("已清理 {} 条测试历史", affected),
    })
}

fn run_case(app: &tauri::AppHandle, case_id: &str) -> Result<String, String> {
    if clipboard_case_sample(case_id).is_some() {
        return run_clipboard_case(case_id);
    }
    match case_id {
        "developer-gate" => {
            ensure_enabled()?;
            Ok("Debug 构建与 --dev-mode 双重门禁有效".to_string())
        }
        "sample-config" => {
            if let Some(config) = read_json::<TestRoomConfig>(&test_room_path(CONFIG_FILE))? {
                validate_config(&config)?;
            }
            Ok("样板配置可读取且结构有效".to_string())
        }
        "preset-contract" => {
            for (item_type, preset) in [
                ("RichText", "rich-launch"),
                ("Excel", "excel-sales"),
                ("Color", "color-indigo"),
                ("Link", "link-vpaste"),
                ("Image", "image-gradient"),
                ("File", "file-assets"),
                ("TextFile", "textfile-notes"),
            ] {
                preset_value(item_type, preset)?;
            }
            Ok("全部粘贴类型均映射到固定安全预设".to_string())
        }
        "excel-chart" => run_excel_chart_case(),
        "qq-two-images" => run_qq_two_images_case(),
        "gif-history" => run_gif_history_case(),
        "boundary-long-text" => run_long_text_boundary_case(),
        "boundary-large-image" => run_large_image_boundary_case(),
        "boundary-large-gif" => run_large_gif_boundary_case(),
        "file-single-types"
        | "file-multiple"
        | "file-folder"
        | "file-folder-and-file"
        | "file-missing" => run_file_case(case_id),
        "main-window-cycle" => {
            let window = app
                .get_webview_window("clipboard")
                .ok_or_else(|| "主面板窗口不存在".to_string())?;
            crate::show_main_panel_for_app(app)?;
            crate::finish_hide_window(&window)?;
            crate::show_main_panel_for_app(app)?;
            crate::finish_hide_window(&window)?;
            crate::show_main_panel_for_app(app)?;
            Ok("主面板已完成隐藏、重开和连续重开，并保持显示".to_string())
        }
        "time-sequence" => {
            let offsets = (0..14).map(sample_time_offset_ms).collect::<Vec<_>>();
            if offsets.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err("最近时间序列不是严格递增".to_string());
            }
            Ok("最近时间序列按 1 秒递增并保持在 5 分钟内".to_string())
        }
        "image-fixtures" => {
            let mut transparent = ImageBuffer::from_pixel(8, 8, Rgba([91_u8, 103, 241, 0]));
            transparent.put_pixel(4, 4, Rgba([91_u8, 103, 241, 255]));
            let mut png = Vec::new();
            transparent
                .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
                .map_err(|err| err.to_string())?;
            let decoded = image::load_from_memory(&png)
                .map_err(|err| err.to_string())?
                .to_rgba8();
            if decoded.get_pixel(0, 0).0[3] != 0 {
                return Err("透明图 alpha 通道丢失".to_string());
            }

            Ok("透明 PNG alpha 通道正常".to_string())
        }
        _ => Err(format!("未知测试用例：{}", case_id)),
    }
}

#[tauri::command]
pub fn run_test_room_case(
    app: tauri::AppHandle,
    case_id: String,
) -> Result<TestCaseResult, String> {
    ensure_enabled()?;
    let started = Instant::now();
    let result = match run_case(&app, &case_id) {
        Ok(message) => Ok(TestCaseResult {
            passed: true,
            message,
            duration_ms: started.elapsed().as_millis(),
        }),
        Err(message) => Ok(TestCaseResult {
            passed: false,
            message,
            duration_ms: started.elapsed().as_millis(),
        }),
    };
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.emit("listen_new_clipboard", ());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_clipboard_test_cases_cover_non_file_history_types() {
        let cases = [
            ("clipboard-text", "Text"),
            ("clipboard-rich-text", "RichText"),
            ("clipboard-color", "Color"),
            ("clipboard-link", "Link"),
            ("clipboard-image", "Image"),
        ];
        for (case_id, expected_type) in cases {
            assert_eq!(
                clipboard_case_sample(case_id).map(|sample| sample.0),
                Some(expected_type)
            );
        }
    }

    #[test]
    fn file_test_cases_write_the_five_expected_history_shapes() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let cases = [
            ("file-single-types", 3),
            ("file-multiple", 1),
            ("file-folder", 1),
            ("file-folder-and-file", 1),
            ("file-missing", 1),
        ];
        let mut all_hashes = Vec::new();
        for (case_id, expected_items) in cases {
            run_file_case(case_id).unwrap();
            let manifest = load_case_history_manifest().unwrap();
            let run = manifest.runs.last().unwrap();
            assert_eq!(run.hashes.len(), expected_items);
            let stored = run
                .hashes
                .iter()
                .map(|hash| clipboard::try_get_by_hash(hash).unwrap())
                .collect::<Vec<_>>();
            assert!(stored.iter().all(|item| item.item_type == ItemType::File));
            let paths = stored
                .iter()
                .map(|item| serde_json::from_str::<Vec<String>>(&item.content).unwrap())
                .collect::<Vec<_>>();

            match case_id {
                "file-single-types" => {
                    assert_eq!(
                        paths.iter().map(Vec::len).collect::<Vec<_>>(),
                        vec![1, 1, 1]
                    );
                    assert_eq!(
                        paths
                            .iter()
                            .map(|path| Path::new(&path[0]).extension().unwrap().to_string_lossy())
                            .collect::<Vec<_>>(),
                        vec!["txt", "png", "psd"]
                    );
                    assert!(fs::read(&paths[1][0])
                        .unwrap()
                        .starts_with(b"\x89PNG\r\n\x1a\n"));
                    assert!(fs::read(&paths[2][0]).unwrap().starts_with(b"8BPS"));
                }
                "file-multiple" => assert_eq!(paths[0].len(), 3),
                "file-folder" => {
                    assert_eq!(paths[0].len(), 1);
                    assert!(Path::new(&paths[0][0]).is_dir());
                }
                "file-folder-and-file" => {
                    assert_eq!(paths[0].len(), 2);
                    assert!(paths[0].iter().any(|path| Path::new(path).is_dir()));
                    assert!(paths[0].iter().any(|path| Path::new(path).is_file()));
                }
                "file-missing" => {
                    assert_eq!(paths[0].len(), 1);
                    assert!(!Path::new(&paths[0][0]).exists());
                }
                _ => unreachable!(),
            }
            all_hashes.extend(run.hashes.clone());
        }

        assert_eq!(all_hashes.len(), 7);
        assert_eq!(delete_hashes(&all_hashes).unwrap(), 7);
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn boundary_cases_each_write_one_budgeted_history_item() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        run_long_text_boundary_case().unwrap();
        run_large_image_boundary_case().unwrap();
        run_large_gif_boundary_case().unwrap();

        let manifest = load_case_history_manifest().unwrap();
        let runs = &manifest.runs[manifest.runs.len() - 3..];
        assert!(runs.iter().all(|run| run.hashes.len() == 1));
        let hashes = runs
            .iter()
            .flat_map(|run| run.hashes.iter())
            .collect::<Vec<_>>();
        let items = hashes
            .iter()
            .map(|hash| clipboard::try_get_by_hash(hash).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(items[0].item_type, ItemType::TextFile);
        assert_eq!(items[1].item_type, ItemType::Image);
        assert_eq!(items[2].item_type, ItemType::Image);
        assert!(
            crate::image_preview::metadata_for_path(&items[1].content)
                .unwrap()
                .preview_limited
        );
        let gif_metadata = crate::image_preview::metadata_for_path(&items[2].content).unwrap();
        assert!(gif_metadata.is_gif);
        assert!(gif_metadata.animation_limited);
        assert!(!gif_metadata.preview_limited);
        let gif_preview = crate::image_card_preview_asset_path(&items[2].content).unwrap();
        assert!(image::image_dimensions(gif_preview).is_ok());

        assert_eq!(
            cleanup_test_case_history_for_date(&current_local_date()).unwrap(),
            3
        );
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn clipboard_test_cases_stay_visible_until_their_day_is_cleaned() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let real_hash = "real-history-outside-test-room".to_string();
        let real_item = basic_item(
            real_hash.clone(),
            "keep me".to_string(),
            ItemType::Text,
            "",
            clipboard::current_timestamp_millis(),
        );
        clipboard::insert_with_source_and_app(&real_item, &real_item.content, "", "", "");

        for case_id in [
            "clipboard-text",
            "clipboard-rich-text",
            "clipboard-color",
            "clipboard-link",
            "clipboard-image",
            "metadata-roundtrip",
        ] {
            run_clipboard_case(case_id).unwrap();
        }
        for case_id in [
            "file-single-types",
            "file-multiple",
            "file-folder",
            "file-folder-and-file",
            "file-missing",
        ] {
            run_file_case(case_id).unwrap();
        }
        run_excel_chart_case().unwrap();
        run_qq_two_images_case().unwrap();
        run_gif_history_case().unwrap();

        let today = current_local_date();
        let mut manifest = load_case_history_manifest().unwrap();
        let previous_hash = manifest.runs[0].hashes[0].clone();
        manifest.runs[0].local_date = "2000-01-01".to_string();
        atomic_write_json(&test_room_path(CASE_HISTORY_MANIFEST_FILE), &manifest).unwrap();
        let today_hashes = manifest
            .runs
            .iter()
            .filter(|run| run.local_date == today)
            .flat_map(|run| run.hashes.iter())
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(today_hashes.len(), 15);
        assert!(today_hashes
            .iter()
            .all(|hash| clipboard::count_by_hash(hash) == 1));

        assert_eq!(cleanup_test_case_history_for_date(&today).unwrap(), 15);
        assert!(today_hashes
            .iter()
            .all(|hash| clipboard::count_by_hash(hash) == 0));
        assert_eq!(clipboard::count_by_hash(&previous_hash), 1);
        assert_eq!(clipboard::count_by_hash(&real_hash), 1);

        assert_eq!(cleanup_test_case_history_for_date("2000-01-01").unwrap(), 1);
        assert_eq!(clipboard::count_by_hash(&previous_hash), 0);
        assert_eq!(clipboard::count_by_hash(&real_hash), 1);
        clipboard::delete_by_hash(&real_hash).unwrap();
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn repository_fixtures_provide_the_product_logo_and_intro_pdf() {
        let logo = image_bytes("image-logo").unwrap();
        assert_eq!(&logo[..8], b"\x89PNG\r\n\x1a\n");
        let logo = image::load_from_memory(&logo).unwrap().to_rgba8();
        assert_eq!((logo.width(), logo.height()), (256, 256));
        for (x, y) in [(0, 0), (255, 0), (0, 255), (255, 255)] {
            assert_eq!(logo.get_pixel(x, y).0, [255, 255, 255, 255]);
        }

        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        let paths = fixture_files("file-brief").unwrap();
        assert_eq!(paths[0].file_name().unwrap(), "vPaste Intro.pdf");
        let pdf = fs::read(&paths[0]).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(String::from_utf8_lossy(&pdf).contains("vPaste Intro"));
    }

    #[test]
    fn rewriting_a_logo_sample_replaces_the_legacy_1024px_data_file() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let sample = SampleItem {
            id: "logo".to_string(),
            name: String::new(),
            item_type: "Image".to_string(),
            value: "image-logo".to_string(),
            preset_id: "image-logo".to_string(),
            app_source: "vPaste".to_string(),
            time_offset_ms: None,
        };
        let hash = generated_hash("legacy-logo-group", &sample.id);
        let path = clipboard::save_to_disk(
            include_bytes!("../icons/source/vpaste-app-icon-1024.png"),
            &hash,
        );
        let legacy = crate::history_store::read_file(&path).unwrap();
        assert_eq!(image::load_from_memory(&legacy).unwrap().width(), 1024);

        insert_sample_item("legacy-logo-group", &sample, 1).unwrap();

        let rewritten = crate::history_store::read_file(&path).unwrap();
        let rewritten = image::load_from_memory(&rewritten).unwrap().to_rgba8();
        assert_eq!(rewritten.dimensions(), (256, 256));
        assert_eq!(rewritten.get_pixel(0, 0).0, [255, 255, 255, 255]);

        clipboard::delete_by_hash(&hash).unwrap();
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn logo_sample_history_is_a_pure_image_without_text_metadata() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let sample = SampleItem {
            id: "logo-only".to_string(),
            name: String::new(),
            item_type: "Image".to_string(),
            value: "image-logo".to_string(),
            preset_id: String::new(),
            app_source: "vPaste".to_string(),
            time_offset_ms: None,
        };
        let hash = insert_sample_item("logo-group", &sample, 1).unwrap();
        let stored = clipboard::try_get_by_hash(&hash).unwrap();

        assert_eq!(stored.item_type, ItemType::Image);
        assert!(stored.text_content.is_empty());
        assert!(stored.rich_html.is_empty());

        clipboard::delete_by_hash(&hash).unwrap();
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn config_allows_blank_item_names_but_still_requires_item_ids() {
        let item = SampleItem {
            id: "image".to_string(),
            name: String::new(),
            item_type: "Image".to_string(),
            value: "image-logo".to_string(),
            preset_id: "image-logo".to_string(),
            app_source: "vPaste".to_string(),
            time_offset_ms: None,
        };
        let mut config = TestRoomConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            groups: vec![SampleGroup {
                id: "group".to_string(),
                name: "Group".to_string(),
                built_in: false,
                items: vec![item],
            }],
            deleted_built_in_group_ids: Vec::new(),
            deleted_built_in_item_ids: Vec::new(),
        };

        assert!(validate_config(&config).is_ok());
        config.groups[0].items[0].id.clear();
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn group_writer_persists_every_item_after_the_fifth_position() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();
        let items = [
            ("text", "Text", "Safe text"),
            ("rich", "RichText", "Rich sample"),
            ("excel", "Excel", "Name\tStatus\nvPaste\tReady"),
            ("color", "Color", "#5B67F1"),
            ("image", "Image", "image-logo"),
            ("link", "Link", "https://vpaste.app"),
            ("file", "File", "file-brief"),
            ("text-file", "TextFile", "Release notes"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (id, item_type, value))| SampleItem {
            id: id.to_string(),
            name: id.to_string(),
            item_type: item_type.to_string(),
            value: value.to_string(),
            preset_id: String::new(),
            app_source: "vPaste".to_string(),
            time_offset_ms: Some(index as u64 * 1_000),
        })
        .collect::<Vec<_>>();
        let group = SampleGroup {
            id: "complete-group".to_string(),
            name: "Complete group".to_string(),
            built_in: false,
            items,
        };

        assert_eq!(write_test_room_groups_to_history(vec![group]).unwrap(), 8);
        let hashes = load_manifest().unwrap().groups["complete-group"].clone();
        assert_eq!(hashes.len(), 8);
        assert!(hashes
            .iter()
            .all(|hash| clipboard::count_by_hash(hash) == 1));
        let times = hashes
            .iter()
            .map(|hash| clipboard::try_get_by_hash(hash).unwrap().time)
            .collect::<Vec<_>>();
        assert!(times.windows(2).all(|pair| pair[0] - pair[1] == 1_000));

        let invalid = SampleItem {
            id: "invalid-time".to_string(),
            name: "Invalid time".to_string(),
            item_type: "Text".to_string(),
            value: "must not replace existing history".to_string(),
            preset_id: String::new(),
            app_source: "vPaste".to_string(),
            time_offset_ms: Some(MAX_SAMPLE_TIME_OFFSET_MS + 1),
        };
        assert!(write_test_room_groups_to_history(vec![SampleGroup {
            id: "complete-group".to_string(),
            name: "Complete group".to_string(),
            built_in: false,
            items: vec![invalid],
        }])
        .unwrap_err()
        .contains("0–300 秒"));
        assert_eq!(load_manifest().unwrap().groups["complete-group"], hashes);
        assert!(hashes
            .iter()
            .all(|hash| clipboard::count_by_hash(hash) == 1));
        assert_eq!(delete_hashes(&hashes).unwrap(), 8);
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn global_cleanup_removes_samples_and_today_cases_but_keeps_real_history() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let real_hash = "real-history-global-cleanup".to_string();
        let real_item = basic_item(
            real_hash.clone(),
            "keep me".to_string(),
            ItemType::Text,
            "",
            clipboard::current_timestamp_millis(),
        );
        clipboard::insert_with_source_and_app(&real_item, &real_item.content, "", "", "");
        let sample = SampleItem {
            id: "sample".to_string(),
            name: "Sample".to_string(),
            item_type: "Text".to_string(),
            value: "safe sample".to_string(),
            preset_id: String::new(),
            app_source: "vPaste".to_string(),
            time_offset_ms: None,
        };
        write_test_room_groups_to_history(vec![SampleGroup {
            id: "sample-group".to_string(),
            name: "Sample group".to_string(),
            built_in: false,
            items: vec![sample],
        }])
        .unwrap();
        let sample_hash = load_manifest().unwrap().groups["sample-group"][0].clone();
        run_clipboard_case("clipboard-text").unwrap();
        let case_hash = load_case_history_manifest().unwrap().runs[0].hashes[0].clone();

        assert_eq!(cleanup_test_room_history_records().unwrap(), 2);
        assert_eq!(clipboard::count_by_hash(&sample_hash), 0);
        assert_eq!(clipboard::count_by_hash(&case_hash), 0);
        assert_eq!(clipboard::count_by_hash(&real_hash), 1);
        assert!(load_manifest().unwrap().groups.is_empty());
        clipboard::delete_by_hash(&real_hash).unwrap();
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn copied_sample_stays_in_history_until_today_cleanup() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let created_at_ms = clipboard::current_timestamp_millis();
        let sample = SampleItem {
            id: "copied-sample".to_string(),
            name: "Copied sample".to_string(),
            item_type: "Text".to_string(),
            value: "safe copied content".to_string(),
            preset_id: String::new(),
            app_source: "vPaste".to_string(),
            time_offset_ms: None,
        };
        let hash = insert_sample_item("copied-group", &sample, created_at_ms).unwrap();

        finalize_test_room_clipboard_history(created_at_ms, &hash, Ok(())).unwrap();

        assert_eq!(clipboard::count_by_hash(&hash), 1);
        assert!(load_case_history_manifest()
            .unwrap()
            .runs
            .iter()
            .any(|run| run.hashes.contains(&hash)));
        assert_eq!(cleanup_test_room_history_records().unwrap(), 1);
        assert_eq!(clipboard::count_by_hash(&hash), 0);
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn failed_sample_clipboard_write_rolls_back_its_history() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let created_at_ms = clipboard::current_timestamp_millis();
        let sample = SampleItem {
            id: "failed-copy".to_string(),
            name: "Failed copy".to_string(),
            item_type: "Text".to_string(),
            value: "safe copied content".to_string(),
            preset_id: String::new(),
            app_source: "vPaste".to_string(),
            time_offset_ms: None,
        };
        let hash = insert_sample_item("failed-group", &sample, created_at_ms).unwrap();

        let error = finalize_test_room_clipboard_history(
            created_at_ms,
            &hash,
            Err("system clipboard unavailable".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "system clipboard unavailable");
        assert_eq!(clipboard::count_by_hash(&hash), 0);
        assert!(load_case_history_manifest().unwrap().runs.is_empty());
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn generated_hashes_are_stable_and_scoped_to_the_group() {
        assert_eq!(
            generated_hash("group-a", "item"),
            generated_hash("group-a", "item")
        );
        assert_ne!(
            generated_hash("group-a", "item"),
            generated_hash("group-b", "item")
        );
    }

    #[test]
    fn time_offsets_match_the_debug_sample_contract() {
        assert_eq!(sample_time_offset_ms(0), 0);
        assert_eq!(sample_time_offset_ms(11), 11_000);
        assert_eq!(sample_time_offset_ms(300), 300_000);
        assert_eq!(sample_time_offset_ms(301), 300_000);
    }

    #[test]
    fn validation_rejects_duplicate_item_ids() {
        let item = SampleItem {
            id: "same".to_string(),
            name: "Sample".to_string(),
            item_type: "Text".to_string(),
            value: "value".to_string(),
            preset_id: String::new(),
            app_source: String::new(),
            time_offset_ms: None,
        };
        let config = TestRoomConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            groups: vec![SampleGroup {
                id: "group".to_string(),
                name: "Group".to_string(),
                built_in: false,
                items: vec![item.clone(), item],
            }],
            deleted_built_in_group_ids: Vec::new(),
            deleted_built_in_item_ids: Vec::new(),
        };
        assert!(validate_config(&config)
            .unwrap_err()
            .contains("粘贴项 ID 重复"));
    }

    #[test]
    fn excel_samples_are_valid_and_all_presets_resolve() {
        let item = SampleItem {
            id: "excel".to_string(),
            name: "Sales overview".to_string(),
            item_type: "Excel".to_string(),
            value: "excel-sales".to_string(),
            preset_id: "excel-sales".to_string(),
            app_source: "Microsoft Excel".to_string(),
            time_offset_ms: Some(90_000),
        };
        let config = TestRoomConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            groups: vec![SampleGroup {
                id: "group".to_string(),
                name: "Group".to_string(),
                built_in: false,
                items: vec![item],
            }],
            deleted_built_in_group_ids: Vec::new(),
            deleted_built_in_item_ids: Vec::new(),
        };

        assert!(validate_config(&config).is_ok());
        let serialized = serde_json::to_value(&config).unwrap();
        assert_eq!(
            serialized["groups"][0]["items"][0]["presetId"],
            "excel-sales"
        );
        assert_eq!(serialized["groups"][0]["items"][0]["timeOffsetMs"], 90_000);
        for preset in [
            "excel-sales",
            "excel-projects",
            "excel-budget",
            "excel-inventory",
            "excel-campaign",
        ] {
            let (plain, html) = excel_preset(preset).unwrap();
            assert!(!plain.is_empty());
            assert!(html.contains("<table"));
        }
        let custom = excel_table_html("名称\t备注\n样板\t<script>alert(1)</script>").unwrap();
        assert!(custom.contains("&lt;script&gt;"));
        assert!(!custom.contains("<script>"));
        let rich = rich_text_html("<标题>", "<script>alert(1)</script>");
        assert!(rich.contains("&lt;标题&gt;"));
        assert!(!rich.contains("<script>"));
    }

    #[test]
    fn excel_sample_writer_creates_rich_table_history() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();
        let item = SampleItem {
            id: "excel".to_string(),
            name: "Sales overview".to_string(),
            item_type: "Excel".to_string(),
            value: "产品\t区域\t销售额\nWorkspace\t华东\t¥138,000".to_string(),
            preset_id: String::new(),
            app_source: "Microsoft Excel".to_string(),
            time_offset_ms: None,
        };

        let hash = insert_sample_item("excel-group", &item, 1).unwrap();
        let stored = clipboard::try_get_by_hash(&hash).unwrap();

        assert_eq!(stored.item_type, ItemType::Text);
        assert_eq!(stored.app_source, "Microsoft Excel");
        assert!(stored.rich_html.contains("<table"));
        assert!(Path::new(&stored.app_icon_path).is_file());
        clipboard::delete_by_hash(&hash).unwrap();
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn older_configs_are_accepted_for_frontend_migration_but_future_configs_are_rejected() {
        let config = TestRoomConfig {
            schema_version: 0,
            groups: Vec::new(),
            deleted_built_in_group_ids: Vec::new(),
            deleted_built_in_item_ids: Vec::new(),
        };
        assert!(validate_loaded_config(&config).is_ok());

        let future = TestRoomConfig {
            schema_version: 2,
            ..config
        };
        assert!(validate_loaded_config(&future)
            .unwrap_err()
            .contains("更高版本"));
    }

    #[test]
    fn atomic_config_write_replaces_complete_json_and_preserves_invalid_input_on_read() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test-room.json");
        let first = GeneratedManifest {
            schema_version: 1,
            groups: HashMap::from([("first".to_string(), vec!["hash-a".to_string()])]),
        };
        let second = GeneratedManifest {
            schema_version: 1,
            groups: HashMap::from([("second".to_string(), vec!["hash-b".to_string()])]),
        };
        atomic_write_json(&path, &first).unwrap();
        atomic_write_json(&path, &second).unwrap();
        let loaded = read_json::<GeneratedManifest>(&path).unwrap().unwrap();
        assert!(loaded.groups.contains_key("second"));
        assert!(!loaded.groups.contains_key("first"));

        fs::write(&path, b"{broken-json").unwrap();
        assert!(read_json::<GeneratedManifest>(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken-json");
    }

    #[test]
    fn generated_cleanup_does_not_remove_untracked_history() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().to_string());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().to_string(),
            ..Default::default()
        });
        crate::clipboard::db::init();

        let real_hash = "real-history-item".to_string();
        let real_item = basic_item(
            real_hash.clone(),
            "real content".to_string(),
            ItemType::Text,
            "",
            clipboard::current_timestamp_millis(),
        );
        clipboard::insert_with_source_and_app(&real_item, &real_item.content, "", "", "");

        let sample = SampleItem {
            id: "sample".to_string(),
            name: "Sample".to_string(),
            item_type: "Text".to_string(),
            value: "safe sample".to_string(),
            preset_id: String::new(),
            app_source: "vPaste".to_string(),
            time_offset_ms: None,
        };
        let sample_hash =
            insert_sample_item("test-group", &sample, clipboard::current_timestamp_millis())
                .unwrap();

        assert_eq!(delete_hashes(&[sample_hash.clone()]).unwrap(), 1);
        assert_eq!(clipboard::count_by_hash(&sample_hash), 0);
        assert_eq!(clipboard::count_by_hash(&real_hash), 1);
        crate::config::save(crate::config::Config::default());
    }
}
