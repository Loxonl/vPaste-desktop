// Prevents an extra console window for the Windows desktop app.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

extern crate backtrace;
#[cfg(test)]
#[macro_use]
extern crate ctor;
#[macro_use]
extern crate tantivy;

use std::collections::HashSet;
use std::fs;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicPtr;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use image::{ImageBuffer, Rgba};
use lazy_static::lazy_static;
use log::{error, info, LevelFilter};
#[cfg(any(test, target_os = "windows"))]
use rand::RngCore;
use serde::Serialize;
use tauri::image::Image as TauriImage;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri::utils::TitleBarStyle;

use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};
use WebviewUrl::App;

#[cfg(target_os = "macos")]
#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

// ...

#[cfg(target_os = "macos")]
use crate::clipboard::macos::listen;
#[cfg(target_os = "windows")]
use crate::clipboard::windows::listen;
use crate::config::Config;

mod app_updater;
mod clipboard;
mod config;
mod history_store;
mod image_preview;
mod maintenance;
mod paste_queue;
mod runtime_mode;
mod search;
mod test_room;

#[cfg(test)]
#[ctor]
fn global_init() {
    env_logger::Builder::new()
        .filter_level(LevelFilter::Info) // 设置全局最小日志级别为 Info
        .init();
}

lazy_static! {
    pub static ref GLOBAL_APP_DATA_DIR: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    static ref PASTE_QUEUE_REQUEST_SENDER: Mutex<Option<std::sync::mpsc::Sender<PasteQueueRequest>>> =
        Mutex::new(None);
}

#[derive(Debug)]
struct PasteQueueRequest {
    hash: Option<String>,
    activation_epoch: u64,
    origin: PasteQueueRequestOrigin,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PasteQueueRequestOrigin {
    Shortcut,
    QueueWindow,
}

static CLIPBOARD_VISIBLE: AtomicBool = AtomicBool::new(false);
static CLIPBOARD_HIDING: AtomicBool = AtomicBool::new(false);
static CLIPBOARD_WINDOW_TRANSITION_LOCK: Mutex<()> = Mutex::new(());
static IMAGE_PREVIEW_CACHE_PUBLISH_LOCK: Mutex<()> = Mutex::new(());
static SEARCH_COMMAND_LOCK: Mutex<()> = Mutex::new(());
static SEARCH_COMMAND_GENERATION: AtomicU64 = AtomicU64::new(0);
static IMAGE_PREVIEW_CACHE_TEMP_ID: AtomicU64 = AtomicU64::new(0);
pub(crate) static CLIPBOARD_IGNORE_NEXT_CHANGE: AtomicBool = AtomicBool::new(false);
pub(crate) static CLIPBOARD_HISTORY_PAUSED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
pub(crate) static CLIPBOARD_IGNORE_CHANGES_UNTIL: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
pub(crate) static CLIPBOARD_INTERNAL_MARKER: Mutex<[u8; 16]> = Mutex::new([0; 16]);
static CLIPBOARD_WINDOW_GENERATION: AtomicU64 = AtomicU64::new(0);
static LAST_CLIPBOARD_MONITOR_CENTER: Mutex<Option<(f64, f64)>> = Mutex::new(None);
#[cfg(target_os = "windows")]
static CLIPBOARD_RESTORE_FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);
static LEGACY_HISTORY_BLOCKED: AtomicBool = AtomicBool::new(false);
static PREVIEW_PINNED: AtomicBool = AtomicBool::new(false);
static PREVIEW_IGNORE_BLUR_UNTIL: AtomicU64 = AtomicU64::new(0);
static CLIPBOARD_SUPPRESS_BLUR_HIDE_UNTIL: AtomicU64 = AtomicU64::new(0);
static ONBOARDING_ACTIVE: AtomicBool = AtomicBool::new(false);
static ONBOARDING_SHORTCUT_DEMO_ENABLED: AtomicBool = AtomicBool::new(false);
static TRAY_MENU_WATCHING: AtomicBool = AtomicBool::new(false);
static TRAY_ICON_VISIBLE: AtomicBool = AtomicBool::new(false);
static PERMISSION_GUIDE_RETURN_TO_CONFIG: AtomicBool = AtomicBool::new(false);
static PASTE_FALLBACK_NOTICE_GENERATION: AtomicU64 = AtomicU64::new(0);
static PASTE_QUEUE_INTERCEPTOR_READY: AtomicBool = AtomicBool::new(false);
static PASTE_QUEUE_INTERCEPTOR_STARTING: AtomicBool = AtomicBool::new(false);
static PASTE_QUEUE_INTERNAL_PASTE: AtomicBool = AtomicBool::new(false);
static PASTE_QUEUE_MENU_OPEN: AtomicBool = AtomicBool::new(false);
static PASTE_QUEUE_MENU_GENERATION: AtomicU64 = AtomicU64::new(0);
static PASTE_QUEUE_POINTER_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static PASTE_QUEUE_MAC_EVENT_TAP: AtomicPtr<std::ffi::c_void> =
    AtomicPtr::new(std::ptr::null_mut());
#[cfg(all(target_os = "macos", debug_assertions))]
static DEBUG_BACKGROUND_AGENT_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static LAST_FOREGROUND_HWND_BEFORE_CLIPBOARD: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
static LAST_FOCUSED_HWND_BEFORE_CLIPBOARD: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static LAST_FOREGROUND_APP_PID: Mutex<Option<i32>> = Mutex::new(None);
#[cfg(test)]
pub static TEST_APP_DATA_LOCK: Mutex<()> = Mutex::new(());
const CLIPBOARD_WINDOW_HEIGHT: f64 = 302.0;
const CLIPBOARD_WINDOW_SHADOW: bool = cfg!(target_os = "windows");
const CLIPBOARD_SHOW_ANIMATION_MS: u64 = 170;
const CLIPBOARD_HIDE_ANIMATION_MS: u64 = 140;
const CLIPBOARD_ANIMATION_FRAME_MS: u64 = 8;
const CLIPBOARD_HORIZONTAL_BLEED: f64 = 12.0;
const PASTE_FALLBACK_NOTICE_WIDTH: f64 = 560.0;
const PASTE_FALLBACK_NOTICE_HEIGHT: f64 = 76.0;
const PASTE_QUEUE_WINDOW_WIDTH: f64 = 360.0;
const PASTE_QUEUE_WINDOW_HEIGHT: f64 = 448.0;
#[cfg(target_os = "macos")]
const PASTE_QUEUE_MAC_EVENT_MARKER: i64 = 0x5650_4153_5445_5155;
const PASTE_FALLBACK_NOTICE_TOP_INSET: f64 = 18.0;
const PASTE_FALLBACK_NOTICE_DURATION_MS: u64 = 4_000;
const AUXILIARY_WINDOW_GUTTER: f64 = 8.0;
const TRAY_MENU_WIDTH: i32 = 216;
const TRAY_MENU_HEIGHT: i32 = 184;
const TAB_EDITOR_CONTENT_WIDTH: f64 = 286.0;
const TAB_EDITOR_DEFAULT_CONTENT_HEIGHT: f64 = 400.0;
const EMOJI_PICKER_CONTENT_WIDTH: f64 = 262.0;
const EMOJI_PICKER_CONTENT_HEIGHT: f64 = 148.0;
#[cfg(not(target_os = "macos"))]
const TRAY_MENU_CURSOR_GAP: i32 = 8;
const TRAY_ICON_ID: &str = "vpaste-tray";
const DEVELOPER_MODE_ARG: &str = "--dev-mode";
const PREVIEW_WINDOW_WIDTH: f64 = 760.0;
const PREVIEW_WINDOW_HEIGHT: f64 = 560.0;
const PREVIEW_IMAGE_MIN_WIDTH: f64 = 420.0;
#[cfg(target_os = "macos")]
const ROUNDED_WINDOW_RADIUS: f64 = 12.0;

fn developer_mode_enabled_for_args<I, S>(args: I, debug_build: bool) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    debug_build
        && args
            .into_iter()
            .any(|arg| arg.as_ref() == DEVELOPER_MODE_ARG)
}

#[tauri::command]
fn get_developer_mode() -> bool {
    developer_mode_enabled_for_args(std::env::args(), cfg!(debug_assertions))
}

fn test_room_window_open_error(developer_mode: bool, window_exists: bool) -> Option<&'static str> {
    if !developer_mode {
        Some("测试间只在带 --dev-mode 参数的 Debug 构建中可用")
    } else if !window_exists {
        Some("测试间窗口尚未完成初始化，请稍后重试")
    } else {
        None
    }
}

#[cfg(test)]
mod developer_mode_tests {
    use super::{developer_mode_enabled_for_args, test_room_window_open_error};

    #[test]
    fn developer_mode_requires_exact_argument_in_debug_build() {
        assert!(developer_mode_enabled_for_args(
            ["vpaste", "--dev-mode"],
            true
        ));
        assert!(!developer_mode_enabled_for_args(["vpaste"], true));
        assert!(!developer_mode_enabled_for_args(
            ["vpaste", "--dev-mode=true"],
            true
        ));
        assert!(!developer_mode_enabled_for_args(
            ["vpaste", "--dev-mode-extra"],
            true
        ));
    }

    #[test]
    fn developer_mode_is_disabled_in_release_builds() {
        assert!(!developer_mode_enabled_for_args(
            ["vpaste", "--dev-mode"],
            false
        ));
    }

    #[test]
    fn test_room_open_requires_developer_mode_and_a_prebuilt_window() {
        assert!(test_room_window_open_error(false, false).is_some());
        assert!(test_room_window_open_error(true, false).is_some());
        assert!(test_room_window_open_error(true, true).is_none());
    }
}
const PREVIEW_IMAGE_MIN_HEIGHT: f64 = 320.0;
const PREVIEW_IMAGE_PADDING: f64 = 72.0;
const PREVIEW_CLIPBOARD_GAP: f64 = 16.0;
const DEFAULT_SCREEN_HEIGHT: f64 = 1080.0;
const DEFAULT_SCREEN_WIDTH: f64 = 1920.0;
const DAY_MILLIS: u64 = 24 * 60 * 60 * 1000;
const IMAGE_PREVIEW_CACHE_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const IMAGE_CLIPBOARD_CACHE_MAX_BYTES: u64 = 1024 * 1024 * 1024;
#[cfg(target_os = "windows")]
const INTERNAL_CLIPBOARD_IGNORE_WINDOW_MS: u64 = 2_000;

#[derive(Clone, Copy)]
struct ScreenBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[derive(Clone, Copy)]
struct ClipboardWindowLayout {
    x: f64,
    target_y: f64,
    hidden_y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[derive(Clone, Serialize)]
struct FilePreviewInfo {
    kind: String,
    paths: Vec<String>,
    exists: bool,
    missing_paths: Vec<String>,
    display_path: String,
    secondary_text: String,
    extension: String,
    preview_path: String,
    contains_directories: bool,
    image_width: Option<u32>,
    image_height: Option<u32>,
}

use crate::image_preview::HistoryImageMetadata;

#[derive(Clone, Copy, Serialize)]
struct PasteAccessibilityPermissionStatus {
    granted: bool,
    needs_settings: bool,
}

#[derive(Serialize)]
struct OnboardingPermissionStatus {
    background: OnboardingPermissionItemStatus,
    paste: OnboardingPermissionItemStatus,
}

#[derive(Serialize)]
struct OnboardingPermissionItemStatus {
    done: bool,
    needs_settings: bool,
    error: Option<String>,
}

#[cfg(any(all(target_os = "macos", not(debug_assertions)), test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacosServiceStatus {
    NotRegistered,
    Enabled,
    RequiresApproval,
    NotFound,
}

#[derive(Clone, Copy, Serialize)]
struct ClipboardHistoryPausePayload {
    paused: bool,
}

#[derive(Clone, Serialize)]
struct PreviewPayload {
    item_type: String,
    content: String,
    preview_content: String,
    preview_asset_path: String,
    text_content: String,
    rich_html: String,
    app_source: String,
}

#[derive(Clone, Copy)]
struct PreviewWindowSize {
    width: f64,
    height: f64,
}

#[derive(Serialize)]
struct LinkPreviewDocument {
    url: String,
    html: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn should_block_clipboard_hide(onboarding_active: bool) -> bool {
    onboarding_active
}

fn should_block_clipboard_hide_for_shortcut_demo(
    onboarding_active: bool,
    shortcut_demo_enabled: bool,
) -> bool {
    onboarding_active && !shortcut_demo_enabled
}

fn should_commit_clipboard_hide(
    onboarding_active: bool,
    allow_onboarding_shortcut_demo: bool,
) -> bool {
    !should_block_clipboard_hide_for_shortcut_demo(
        onboarding_active,
        allow_onboarding_shortcut_demo,
    )
}

fn clipboard_hide_blocked() -> bool {
    should_block_clipboard_hide(ONBOARDING_ACTIVE.load(Ordering::SeqCst))
}

fn should_finish_clipboard_hide(
    generation: u64,
    current_generation: u64,
    onboarding_active: bool,
    allow_onboarding_shortcut_demo: bool,
) -> bool {
    generation == current_generation
        && !should_block_clipboard_hide_for_shortcut_demo(
            onboarding_active,
            allow_onboarding_shortcut_demo,
        )
}

fn clipboard_blur_hide_suppressed() -> bool {
    clipboard_hide_blocked()
        || now_millis() < CLIPBOARD_SUPPRESS_BLUR_HIDE_UNTIL.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_clipboard_blur_hide_suppressed(suppressed: bool) {
    let until = if suppressed {
        now_millis().saturating_add(30 * 60 * 1000)
    } else {
        now_millis().saturating_add(800)
    };
    CLIPBOARD_SUPPRESS_BLUR_HIDE_UNTIL.store(until, Ordering::SeqCst);
}

#[derive(Serialize)]
struct StoragePaths {
    app_data_dir: String,
    config_path: String,
    history_storage_dir: String,
    database_path: String,
    internal_data_dir: String,
    search_index_dir: String,
    logs_dir: String,
    file_previews_dir: String,
    image_clipboard_cache_dir: String,
}

#[derive(Serialize)]
struct StorageCleanupInfo {
    bytes: u64,
    items: usize,
}

#[derive(Clone, Copy, Serialize)]
struct ShortcutRegistrationInfo {
    registered: bool,
    conflict: bool,
}

#[derive(Serialize)]
struct StorageMigrationInfo {
    migrated: bool,
    source_dir: String,
    target_dir: String,
    merged_items: usize,
    skipped_items: usize,
    copied_files: usize,
    backup_dir: String,
    message: String,
    shortcut_conflict: bool,
}

#[derive(Serialize)]
struct LanguagePackFile {
    code: String,
    name: String,
    native_name: String,
    translations: serde_json::Value,
}

#[derive(Serialize)]
struct HistoryArchiveInfo {
    archive_path: String,
    merged_items: usize,
    skipped_items: usize,
    copied_files: usize,
    message: String,
}

#[derive(Clone, Copy, Debug)]
struct HistoryArchiveTotals {
    total_files: usize,
    total_bytes: u64,
}

#[derive(Clone, Serialize)]
struct HistoryArchiveProgressPayload {
    operation: String,
    stage: String,
    processed_files: usize,
    total_files: usize,
    processed_bytes: u64,
    total_bytes: u64,
}

struct HistoryArchiveProgressState {
    app: Option<tauri::AppHandle>,
    operation: &'static str,
    stage: &'static str,
    processed_files: usize,
    total_files: usize,
    processed_bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
struct AppVersionInfo {
    version: String,
}

fn screen_bounds_from_monitor(monitor: &tauri::Monitor) -> ScreenBounds {
    let scale_factor = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    ScreenBounds {
        x: position.x as f64 / scale_factor,
        y: position.y as f64 / scale_factor,
        width: size.width as f64 / scale_factor,
        height: size.height as f64 / scale_factor,
        scale_factor,
    }
}

fn default_screen_bounds() -> ScreenBounds {
    ScreenBounds {
        x: 0.0,
        y: 0.0,
        width: DEFAULT_SCREEN_WIDTH,
        height: DEFAULT_SCREEN_HEIGHT,
        scale_factor: 1.0,
    }
}

fn select_clipboard_monitor<T>(
    cursor_is_over_desktop: bool,
    focused_window_monitor: Option<T>,
    cursor_monitor: Option<T>,
    primary_monitor: Option<T>,
) -> Option<T> {
    if cursor_is_over_desktop {
        cursor_monitor
            .or(focused_window_monitor)
            .or(primary_monitor)
    } else {
        focused_window_monitor
            .or(cursor_monitor)
            .or(primary_monitor)
    }
}

fn is_windows_desktop_window_class(class_name: &str) -> bool {
    matches!(class_name, "Progman" | "WorkerW")
}

#[cfg(target_os = "windows")]
fn cursor_is_over_windows_desktop(position: tauri::PhysicalPosition<i32>) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetShellWindow, WindowFromPoint, GA_ROOT,
    };

    let hit_window = unsafe {
        WindowFromPoint(POINT {
            x: position.x,
            y: position.y,
        })
    };
    if hit_window.0 == 0 {
        return false;
    }

    let root_window = unsafe { GetAncestor(hit_window, GA_ROOT) };
    let candidate = if root_window.0 == 0 {
        hit_window
    } else {
        root_window
    };
    if candidate == unsafe { GetShellWindow() } {
        return true;
    }

    let mut class_name = [0_u16; 256];
    let length = unsafe { GetClassNameW(candidate, &mut class_name) };
    length > 0
        && is_windows_desktop_window_class(&String::from_utf16_lossy(
            &class_name[..length as usize],
        ))
}

#[cfg(target_os = "windows")]
fn native_window_monitor(
    window: &tauri::WebviewWindow,
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<tauri::Monitor> {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.0 == 0 {
        return None;
    }

    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut monitor_info) }.as_bool() {
        return None;
    }

    let monitor_rect = monitor_info.rcMonitor;
    let center_x = monitor_rect.left as f64 + (monitor_rect.right - monitor_rect.left) as f64 / 2.0;
    let center_y = monitor_rect.top as f64 + (monitor_rect.bottom - monitor_rect.top) as f64 / 2.0;
    window
        .app_handle()
        .monitor_from_point(center_x, center_y)
        .ok()
        .flatten()
}

#[cfg(target_os = "windows")]
fn focused_window_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0 == 0 {
        return None;
    }
    native_window_monitor(window, foreground)
}

#[cfg(target_os = "windows")]
fn target_clipboard_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    let focused = focused_window_monitor(window);
    let cursor_position = cursor_physical_position();
    let cursor_is_over_desktop = cursor_position
        .map(cursor_is_over_windows_desktop)
        .unwrap_or(false);
    let cursor = cursor_position.and_then(|position| {
        window
            .app_handle()
            .monitor_from_point(position.x as f64, position.y as f64)
            .ok()
            .flatten()
    });
    let primary = window.primary_monitor().ok().flatten();
    select_clipboard_monitor(cursor_is_over_desktop, focused, cursor, primary)
}

#[cfg(not(target_os = "windows"))]
fn target_clipboard_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    cursor_physical_position()
        .and_then(|position| {
            window
                .app_handle()
                .monitor_from_point(position.x as f64, position.y as f64)
                .ok()
                .flatten()
        })
        .or_else(|| window.primary_monitor().ok().flatten())
}

fn screen_bounds(window: &tauri::WebviewWindow) -> ScreenBounds {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .as_ref()
        .map(screen_bounds_from_monitor)
        .unwrap_or_else(default_screen_bounds)
}

fn target_clipboard_screen_bounds(window: &tauri::WebviewWindow) -> ScreenBounds {
    target_clipboard_monitor(window)
        .as_ref()
        .map(screen_bounds_from_monitor)
        .unwrap_or_else(default_screen_bounds)
}

fn clipboard_window_layout(bounds: ScreenBounds) -> ClipboardWindowLayout {
    ClipboardWindowLayout {
        x: bounds.x - CLIPBOARD_HORIZONTAL_BLEED,
        target_y: bounds.y + bounds.height - CLIPBOARD_WINDOW_HEIGHT,
        hidden_y: bounds.y + bounds.height,
        width: bounds.width + CLIPBOARD_HORIZONTAL_BLEED * 2.0,
        height: CLIPBOARD_WINDOW_HEIGHT,
        scale_factor: bounds.scale_factor,
    }
}

fn clipboard_window_physical_size(layout: ClipboardWindowLayout) -> (u32, u32) {
    (
        (layout.width * layout.scale_factor).round() as u32,
        (layout.height * layout.scale_factor).round() as u32,
    )
}

fn should_restore_foreground_after_hide(generation: u64, marked_generation: u64) -> bool {
    generation != 0 && generation == marked_generation
}

fn should_reapply_clipboard_size_after_scale_change(label: &str, visible: bool) -> bool {
    label == "clipboard" && visible
}

fn centered_window_position_in_work_area(
    work_area: (i32, i32, u32, u32),
    logical_window_size: (f64, f64),
    target_scale_factor: f64,
) -> (i32, i32) {
    let (work_x, work_y, work_width, work_height) = work_area;
    let window_width = (logical_window_size.0 * target_scale_factor).round() as i64;
    let window_height = (logical_window_size.1 * target_scale_factor).round() as i64;
    let x = work_x as i64 + (work_width as i64 - window_width).max(0) / 2;
    let y = work_y as i64 + (work_height as i64 - window_height).max(0) / 2;
    (x as i32, y as i32)
}

fn physical_window_center(position: (i32, i32), size: (u32, u32)) -> (f64, f64) {
    (
        position.0 as f64 + size.0 as f64 / 2.0,
        position.1 as f64 + size.1 as f64 / 2.0,
    )
}

fn source_window_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        let native_hwnd = windows::Win32::Foundation::HWND(hwnd.0 as isize);
        if let Some(monitor) = native_window_monitor(window, native_hwnd) {
            return Some(monitor);
        }
    }

    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let (center_x, center_y) =
        physical_window_center((position.x, position.y), (size.width, size.height));
    window.monitor_from_point(center_x, center_y).ok().flatten()
}

fn remember_clipboard_monitor(window: &tauri::WebviewWindow) {
    let monitor = source_window_monitor(window)
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| target_clipboard_monitor(window));
    let Some(monitor) = monitor else {
        return;
    };
    let position = monitor.position();
    let size = monitor.size();
    let center = physical_window_center((position.x, position.y), (size.width, size.height));
    if let Ok(mut stored_center) = LAST_CLIPBOARD_MONITOR_CENTER.lock() {
        *stored_center = Some(center);
    }
}

fn last_clipboard_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    let center = *LAST_CLIPBOARD_MONITOR_CENTER.lock().ok()?;
    let (x, y) = center?;
    window.monitor_from_point(x, y).ok().flatten()
}

fn select_auxiliary_monitor<T>(
    use_last_clipboard_monitor: bool,
    last_clipboard_monitor: Option<T>,
    source_monitor: Option<T>,
    fallback_monitor: Option<T>,
) -> Option<T> {
    if use_last_clipboard_monitor {
        last_clipboard_monitor
            .or(source_monitor)
            .or(fallback_monitor)
    } else {
        source_monitor.or(fallback_monitor)
    }
}

fn center_window_on_source_monitor(
    window: &tauri::WebviewWindow,
    source_window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let source_monitor = source_window_monitor(source_window)
        .or_else(|| source_window.current_monitor().ok().flatten());
    let use_last_clipboard_monitor =
        source_window.label() == "clipboard" && !source_window.is_visible().unwrap_or(false);
    let last_clipboard_monitor = if use_last_clipboard_monitor {
        last_clipboard_monitor(source_window)
    } else {
        None
    };
    let Some(monitor) = select_auxiliary_monitor(
        use_last_clipboard_monitor,
        last_clipboard_monitor,
        source_monitor,
        target_clipboard_monitor(source_window),
    ) else {
        return window.center().map_err(|err| err.to_string());
    };
    let current_scale_factor = window.scale_factor().map_err(|err| err.to_string())?;
    let outer_size = window.outer_size().map_err(|err| err.to_string())?;
    let logical_window_size = (
        outer_size.width as f64 / current_scale_factor,
        outer_size.height as f64 / current_scale_factor,
    );
    let work_area = monitor.work_area();
    let (x, y) = centered_window_position_in_work_area(
        (
            work_area.position.x,
            work_area.position.y,
            work_area.size.width,
            work_area.size.height,
        ),
        logical_window_size,
        monitor.scale_factor(),
    );
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|err| err.to_string())
}

fn clipboard_screen_bounds(
    app: &tauri::AppHandle,
    fallback_window: &tauri::WebviewWindow,
) -> ScreenBounds {
    app.get_webview_window("clipboard")
        .as_ref()
        .map(screen_bounds)
        .unwrap_or_else(|| screen_bounds(fallback_window))
}

#[cfg(test)]
mod clipboard_monitor_selection_tests {
    use super::{
        centered_window_position_in_work_area, clipboard_window_layout,
        clipboard_window_physical_size, is_windows_desktop_window_class, physical_window_center,
        select_auxiliary_monitor, select_clipboard_monitor,
        should_reapply_clipboard_size_after_scale_change, should_restore_foreground_after_hide,
        ScreenBounds,
    };

    #[test]
    fn focused_window_monitor_takes_priority() {
        assert_eq!(
            select_clipboard_monitor(false, Some("focused"), Some("cursor"), Some("primary"),),
            Some("focused")
        );
    }

    #[test]
    fn falls_back_to_cursor_then_primary_monitor() {
        assert_eq!(
            select_clipboard_monitor(false, None, Some("cursor"), Some("primary")),
            Some("cursor")
        );
        assert_eq!(
            select_clipboard_monitor(false, None, None, Some("primary")),
            Some("primary")
        );
    }

    #[test]
    fn desktop_under_cursor_takes_priority_over_a_stale_focused_window() {
        assert_eq!(
            select_clipboard_monitor(true, Some("focused"), Some("cursor"), Some("primary"),),
            Some("cursor")
        );
    }

    #[test]
    fn only_shell_desktop_window_classes_count_as_the_desktop() {
        assert!(is_windows_desktop_window_class("Progman"));
        assert!(is_windows_desktop_window_class("WorkerW"));
        assert!(!is_windows_desktop_window_class("CabinetWClass"));
        assert!(!is_windows_desktop_window_class("Chrome_WidgetWin_1"));
    }

    #[test]
    fn clipboard_layout_fills_and_docks_to_a_scaled_target_screen() {
        let bounds = ScreenBounds {
            x: 0.0,
            y: 0.0,
            width: 2048.0,
            height: 1280.0,
            scale_factor: 1.25,
        };

        let layout = clipboard_window_layout(bounds);

        assert_eq!(layout.x, -12.0);
        assert_eq!(layout.width, 2072.0);
        assert_eq!(layout.target_y, 978.0);
        assert_eq!(layout.hidden_y, 1280.0);
        assert_eq!(layout.scale_factor, 1.25);
        assert_eq!(clipboard_window_physical_size(layout), (2590, 378));
    }

    #[test]
    fn only_the_matching_hide_generation_restores_the_previous_foreground() {
        assert!(should_restore_foreground_after_hide(7, 7));
        assert!(!should_restore_foreground_after_hide(7, 0));
        assert!(!should_restore_foreground_after_hide(7, 6));
    }

    #[test]
    fn only_a_visible_clipboard_window_reapplies_size_after_a_dpi_change() {
        assert!(should_reapply_clipboard_size_after_scale_change(
            "clipboard",
            true
        ));
        assert!(!should_reapply_clipboard_size_after_scale_change(
            "clipboard",
            false
        ));
        assert!(!should_reapply_clipboard_size_after_scale_change(
            "clipboardPreview",
            true
        ));
    }

    #[test]
    fn centers_auxiliary_windows_in_each_monitors_physical_work_area() {
        assert_eq!(
            centered_window_position_in_work_area((-3840, 0, 3840, 2088), (720.0, 700.0), 1.5,),
            (-2460, 519)
        );
        assert_eq!(
            centered_window_position_in_work_area((0, 0, 2560, 1532), (1080.0, 760.0), 1.25),
            (605, 291)
        );
    }

    #[test]
    fn source_monitor_uses_the_center_of_a_window_that_bleeds_across_a_screen_edge() {
        assert_eq!(
            physical_window_center((-7, 1223), (2592, 380)),
            (1289.0, 1413.0)
        );
    }

    #[test]
    fn hidden_clipboard_uses_its_last_visible_monitor_for_auxiliary_windows() {
        assert_eq!(
            select_auxiliary_monitor(true, Some("last-visible"), Some("hidden"), Some("fallback")),
            Some("last-visible")
        );
        assert_eq!(
            select_auxiliary_monitor(
                false,
                Some("last-visible"),
                Some("source"),
                Some("fallback")
            ),
            Some("source")
        );
    }
}

#[cfg(target_os = "windows")]
fn system_reduces_motion() -> bool {
    use std::ffi::c_void;
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    let mut animations_enabled = 1_i32;
    unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut animations_enabled as *mut i32 as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
            && animations_enabled == 0
    }
}

#[cfg(target_os = "macos")]
fn system_reduces_motion() -> bool {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace == nil {
            return false;
        }
        let reduce_motion: bool = msg_send![workspace, accessibilityDisplayShouldReduceMotion];
        reduce_motion
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn system_reduces_motion() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn cursor_physical_position() -> Option<tauri::PhysicalPosition<i32>> {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
    }

    let mut point = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point as *mut Point) } == 0 {
        None
    } else {
        Some(tauri::PhysicalPosition {
            x: point.x,
            y: point.y,
        })
    }
}

#[cfg(target_os = "macos")]
fn cursor_physical_position() -> Option<tauri::PhysicalPosition<i32>> {
    use cocoa::appkit::{NSEvent, NSScreen};
    use cocoa::base::nil;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let location = NSEvent::mouseLocation(nil);
        let screens = NSScreen::screens(nil);
        if screens == nil {
            return None;
        }
        let main_screen = NSScreen::mainScreen(nil);
        if main_screen == nil {
            return None;
        }
        let main_frame = main_screen.frame();
        let screen_count: usize = msg_send![screens, count];
        for index in 0..screen_count {
            let screen: cocoa::base::id = msg_send![screens, objectAtIndex:index];
            if screen == nil {
                continue;
            }
            let frame = screen.frame();
            if location.x >= frame.origin.x
                && location.x <= frame.origin.x + frame.size.width
                && location.y >= frame.origin.y
                && location.y <= frame.origin.y + frame.size.height
            {
                let scale = screen.backingScaleFactor();
                return Some(tauri::PhysicalPosition {
                    x: ((location.x - frame.origin.x) * scale + frame.origin.x * scale).round()
                        as i32,
                    y: ((main_frame.size.height - location.y) * scale).round() as i32,
                });
            }
        }
    }
    None
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn cursor_physical_position() -> Option<tauri::PhysicalPosition<i32>> {
    None
}

#[cfg(target_os = "windows")]
fn record_foreground_app_before_clipboard() {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, attach: i32) -> i32;
        fn GetCurrentThreadId() -> u32;
        fn GetFocus() -> Hwnd;
        fn GetForegroundWindow() -> Hwnd;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
    }

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        LAST_FOCUSED_HWND_BEFORE_CLIPBOARD.store(0, Ordering::SeqCst);
        return;
    }

    let mut process_id = 0_u32;
    let target_thread = unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
    if process_id == std::process::id() {
        info!("Skip foreground record: vPaste owns the current window");
        return;
    }
    let current_thread = unsafe { GetCurrentThreadId() };
    let attached = target_thread != 0
        && target_thread != current_thread
        && unsafe { AttachThreadInput(current_thread, target_thread, 1) } != 0;
    let focused_hwnd = unsafe { GetFocus() };
    if attached {
        unsafe {
            let _ = AttachThreadInput(current_thread, target_thread, 0);
        }
    }

    LAST_FOREGROUND_HWND_BEFORE_CLIPBOARD.store(hwnd as u64, Ordering::SeqCst);
    if !focused_hwnd.is_null() && unsafe { IsWindow(focused_hwnd) } != 0 {
        LAST_FOCUSED_HWND_BEFORE_CLIPBOARD.store(focused_hwnd as u64, Ordering::SeqCst);
    } else {
        LAST_FOCUSED_HWND_BEFORE_CLIPBOARD.store(0, Ordering::SeqCst);
    }
    info!(
        "Recorded foreground before clipboard: hwnd={:?}, focus={:?}, attached={}",
        hwnd, focused_hwnd, attached
    );
}

#[cfg(target_os = "macos")]
fn record_foreground_app_before_clipboard() {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace == nil {
            return;
        }
        let app: id = msg_send![workspace, frontmostApplication];
        if app == nil {
            return;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        if pid != std::process::id() as i32 {
            if let Ok(mut last_pid) = LAST_FOREGROUND_APP_PID.lock() {
                *last_pid = Some(pid);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn restore_foreground_app_before_paste() {
    use std::ffi::c_void;
    use std::time::{Duration, Instant};

    type Hwnd = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, attach: i32) -> i32;
        fn BringWindowToTop(hwnd: Hwnd) -> i32;
        fn GetCurrentThreadId() -> u32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn SetActiveWindow(hwnd: Hwnd) -> Hwnd;
        fn SetFocus(hwnd: Hwnd) -> Hwnd;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, cmd_show: i32) -> i32;
    }

    const SW_RESTORE: i32 = 9;

    let hwnd = LAST_FOREGROUND_HWND_BEFORE_CLIPBOARD.load(Ordering::SeqCst) as Hwnd;
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        info!("Skip foreground restore: no valid previous window");
        return;
    }
    let focused_hwnd = LAST_FOCUSED_HWND_BEFORE_CLIPBOARD.load(Ordering::SeqCst) as Hwnd;

    unsafe {
        if IsIconic(hwnd) != 0 {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let current_thread = GetCurrentThreadId();
        let target_thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
        let attached = target_thread != 0
            && target_thread != current_thread
            && AttachThreadInput(current_thread, target_thread, 1) != 0;

        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetActiveWindow(hwnd);
        let focus_restore_attempted = if !focused_hwnd.is_null() && IsWindow(focused_hwnd) != 0 {
            let _ = SetFocus(focused_hwnd);
            true
        } else {
            false
        };
        info!(
            "Restoring foreground before paste: target={:?}, focus={:?}, focus_restore_attempted={}, attached={}",
            hwnd, focused_hwnd, focus_restore_attempted, attached
        );

        if attached {
            let _ = AttachThreadInput(current_thread, target_thread, 0);
        }
    }

    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(350) {
        let foreground = unsafe { GetForegroundWindow() };
        if foreground == hwnd {
            info!("Restored foreground window before paste: {:?}", hwnd);
            return;
        }
        std::thread::sleep(Duration::from_millis(15));
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }
    }

    let foreground = unsafe { GetForegroundWindow() };
    info!(
        "Foreground restore timed out before paste: target={:?}, foreground={:?}",
        hwnd, foreground
    );
}

#[cfg(target_os = "macos")]
fn restore_foreground_app_before_paste() {
    use cocoa::appkit::{NSApplicationActivateIgnoringOtherApps, NSRunningApplication};
    use cocoa::base::{id, nil};

    let pid = LAST_FOREGROUND_APP_PID.lock().ok().and_then(|pid| *pid);
    let Some(pid) = pid else {
        return;
    };

    unsafe {
        let app = id::runningApplicationWithProcessIdentifier(nil, pid);
        if app != nil {
            let _ = app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps);
        }
    }
}

#[derive(Clone, Copy)]
enum ClipboardWindowAnimation {
    Show,
    Hide,
}

#[derive(Clone, Copy)]
struct ClipboardWindowMotion {
    x: f64,
    from_y: f64,
    to_y: f64,
    scale_factor: f64,
}

fn clipboard_window_animation_progress(progress: f64, animation: ClipboardWindowAnimation) -> f64 {
    let progress = progress.clamp(0.0, 1.0);
    match animation {
        ClipboardWindowAnimation::Show => 1.0 - (1.0 - progress).powi(3),
        ClipboardWindowAnimation::Hide => progress.powi(3),
    }
}

fn current_window_logical_y(
    window: &tauri::WebviewWindow,
    target_scale_factor: f64,
) -> Option<f64> {
    let position = window.outer_position().ok()?;
    Some(position.y as f64 / target_scale_factor)
}

#[cfg(target_os = "windows")]
fn set_window_position_for_scale(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    scale_factor: f64,
) -> Result<(), String> {
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: (x * scale_factor).round() as i32,
            y: (y * scale_factor).round() as i32,
        }))
        .map_err(|err| err.to_string())
}

#[cfg(not(target_os = "windows"))]
fn set_window_position_for_scale(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    _scale_factor: f64,
) -> Result<(), String> {
    window
        .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn set_window_size_for_scale(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
    scale_factor: f64,
) -> Result<(), String> {
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: (width * scale_factor).round() as u32,
            height: (height * scale_factor).round() as u32,
        }))
        .map_err(|err| err.to_string())
}

#[cfg(not(target_os = "windows"))]
fn set_window_size_for_scale(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
    _scale_factor: f64,
) -> Result<(), String> {
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn reapply_clipboard_size_after_scale_change(window: &tauri::WebviewWindow, scale_factor: f64) {
    let bounds = screen_bounds(window);
    let monitor_physical_width = bounds.width * bounds.scale_factor;
    let logical_width = monitor_physical_width / scale_factor + CLIPBOARD_HORIZONTAL_BLEED * 2.0;
    if let Err(err) =
        set_window_size_for_scale(window, logical_width, CLIPBOARD_WINDOW_HEIGHT, scale_factor)
    {
        error!("Failed to reapply clipboard size after DPI change: {}", err);
    }
}

#[cfg(not(target_os = "macos"))]
fn animate_clipboard_window_y(
    window: &tauri::WebviewWindow,
    motion: ClipboardWindowMotion,
    duration_ms: u64,
    generation: u64,
    animation: ClipboardWindowAnimation,
) -> Result<bool, String> {
    if system_reduces_motion() || (motion.from_y - motion.to_y).abs() < 0.5 {
        if CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) != generation {
            return Ok(false);
        }
        set_window_position_for_scale(window, motion.x, motion.to_y, motion.scale_factor)?;
        return Ok(true);
    }

    let started = Instant::now();
    let duration = std::time::Duration::from_millis(duration_ms);
    loop {
        if CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) != generation {
            return Ok(false);
        }

        let progress = (started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
        let eased = clipboard_window_animation_progress(progress, animation);
        let y = motion.from_y + (motion.to_y - motion.from_y) * eased;
        set_window_position_for_scale(window, motion.x, y, motion.scale_factor)?;

        if progress >= 1.0 {
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(
            CLIPBOARD_ANIMATION_FRAME_MS,
        ));
    }
}

#[cfg(target_os = "macos")]
fn set_macos_clipboard_window_position(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let animation_window = window.clone();
    let (positioned_tx, positioned_rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = animation_window
                .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
                .map_err(|err| err.to_string());
            let _ = positioned_tx.send(result);
        })
        .map_err(|err| err.to_string())?;

    positioned_rx
        .recv()
        .map_err(|err| format!("failed to update macOS clipboard window position: {err}"))?
}

#[cfg(target_os = "macos")]
fn animate_clipboard_window_y(
    window: &tauri::WebviewWindow,
    motion: ClipboardWindowMotion,
    duration_ms: u64,
    generation: u64,
    animation: ClipboardWindowAnimation,
) -> Result<bool, String> {
    if system_reduces_motion() || (motion.from_y - motion.to_y).abs() < 0.5 {
        if CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) != generation {
            return Ok(false);
        }
        window
            .set_position(tauri::Position::Logical(tauri::LogicalPosition {
                x: motion.x,
                y: motion.to_y,
            }))
            .map_err(|err| err.to_string())?;
        return Ok(true);
    }

    let started = Instant::now();
    let duration = std::time::Duration::from_millis(duration_ms);
    loop {
        if CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) != generation {
            return Ok(false);
        }

        let progress = (started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
        let eased = clipboard_window_animation_progress(progress, animation);
        let y = motion.from_y + (motion.to_y - motion.from_y) * eased;
        set_macos_clipboard_window_position(window, motion.x, y)?;

        if progress >= 1.0 {
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(
            CLIPBOARD_ANIMATION_FRAME_MS,
        ));
    }
}

fn finish_hide_window_locked(
    window: &tauri::WebviewWindow,
    allow_onboarding_shortcut_demo: bool,
) -> Result<(), String> {
    if !should_commit_clipboard_hide(
        ONBOARDING_ACTIVE.load(Ordering::SeqCst),
        allow_onboarding_shortcut_demo,
    ) {
        CLIPBOARD_HIDING.store(false, Ordering::SeqCst);
        return Ok(());
    }
    let bounds = screen_bounds(window);
    let _ = set_window_position_for_scale(
        window,
        bounds.x - CLIPBOARD_HORIZONTAL_BLEED,
        bounds.y + bounds.height,
        bounds.scale_factor,
    );
    window.hide().map_err(|err| err.to_string())?;
    CLIPBOARD_VISIBLE.store(false, Ordering::SeqCst);
    CLIPBOARD_HIDING.store(false, Ordering::SeqCst);
    CLIPBOARD_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    let _ = window.emit("window-hidden", ());
    #[cfg(target_os = "macos")]
    maybe_hide_macos_dock_icon();
    Ok(())
}

fn finish_hide_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _transition = CLIPBOARD_WINDOW_TRANSITION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    finish_hide_window_locked(window, false)
}

fn finish_animated_hide_window(
    window: &tauri::WebviewWindow,
    generation: u64,
    allow_onboarding_shortcut_demo: bool,
) -> Result<(), String> {
    if generation == 0 {
        return Ok(());
    }

    let bounds = screen_bounds(window);
    let x = bounds.x - CLIPBOARD_HORIZONTAL_BLEED;
    let target_y = bounds.y + bounds.height;
    let start_y = current_window_logical_y(window, bounds.scale_factor)
        .unwrap_or(bounds.y + bounds.height - CLIPBOARD_WINDOW_HEIGHT);
    let animation_result = animate_clipboard_window_y(
        window,
        ClipboardWindowMotion {
            x,
            from_y: start_y,
            to_y: target_y,
            scale_factor: bounds.scale_factor,
        },
        CLIPBOARD_HIDE_ANIMATION_MS,
        generation,
        ClipboardWindowAnimation::Hide,
    );

    let _transition = CLIPBOARD_WINDOW_TRANSITION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !should_finish_clipboard_hide(
        generation,
        CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst),
        ONBOARDING_ACTIVE.load(Ordering::SeqCst),
        allow_onboarding_shortcut_demo,
    ) {
        if clipboard_hide_blocked() {
            CLIPBOARD_HIDING.store(false, Ordering::SeqCst);
        }
        return Ok(());
    }
    if let Err(err) = animation_result {
        error!("Failed to animate clipboard window down: {}", err);
    }
    finish_hide_window_locked(window, allow_onboarding_shortcut_demo)?;
    drop(_transition);
    restore_foreground_after_hide(generation);
    Ok(())
}

#[cfg(test)]
mod clipboard_window_animation_tests {
    use super::{
        clipboard_window_animation_progress, should_block_clipboard_hide,
        should_block_clipboard_hide_for_shortcut_demo, should_commit_clipboard_hide,
        should_finish_clipboard_hide, ClipboardWindowAnimation,
    };

    #[test]
    fn show_and_hide_curves_keep_exact_endpoints() {
        for animation in [
            ClipboardWindowAnimation::Show,
            ClipboardWindowAnimation::Hide,
        ] {
            assert_eq!(clipboard_window_animation_progress(0.0, animation), 0.0);
            assert_eq!(clipboard_window_animation_progress(1.0, animation), 1.0);
        }
    }

    #[test]
    fn onboarding_blocks_new_and_in_flight_clipboard_hides() {
        assert!(!should_block_clipboard_hide(false));
        assert!(should_block_clipboard_hide(true));
        assert!(should_finish_clipboard_hide(7, 7, false, false));
        assert!(!should_finish_clipboard_hide(7, 7, true, false));
        assert!(should_finish_clipboard_hide(7, 7, true, true));
        assert!(!should_finish_clipboard_hide(7, 8, false, false));
    }

    #[test]
    fn onboarding_only_allows_hide_for_the_explicit_shortcut_demo() {
        assert!(should_block_clipboard_hide_for_shortcut_demo(true, false));
        assert!(!should_block_clipboard_hide_for_shortcut_demo(true, true));
        assert!(!should_block_clipboard_hide_for_shortcut_demo(false, false));
        assert!(!should_commit_clipboard_hide(true, false));
        assert!(should_commit_clipboard_hide(true, true));
        assert!(should_commit_clipboard_hide(false, false));
    }

    #[test]
    fn show_arrives_quickly_and_hide_leaves_quickly() {
        assert!(clipboard_window_animation_progress(0.5, ClipboardWindowAnimation::Show) > 0.5);
        assert!(clipboard_window_animation_progress(0.5, ClipboardWindowAnimation::Hide) < 0.5);
    }
}

#[cfg(target_os = "windows")]
fn is_native_window_foreground(window: &tauri::WebviewWindow, _context: &str) -> bool {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> Hwnd;
    }

    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let foreground = unsafe { GetForegroundWindow() };
    foreground == hwnd.0
}

#[cfg(not(target_os = "windows"))]
fn is_native_window_foreground(window: &tauri::WebviewWindow, _context: &str) -> bool {
    window.is_focused().unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn mark_foreground_restore_for_hide(window: &tauri::WebviewWindow, generation: u64) {
    let restore_generation = if is_native_window_foreground(window, "clipboard hide") {
        generation
    } else {
        0
    };
    CLIPBOARD_RESTORE_FOCUS_GENERATION.store(restore_generation, Ordering::SeqCst);
}

#[cfg(not(target_os = "windows"))]
fn mark_foreground_restore_for_hide(_window: &tauri::WebviewWindow, _generation: u64) {}

#[cfg(target_os = "windows")]
fn restore_foreground_after_hide(generation: u64) {
    let marked_generation = CLIPBOARD_RESTORE_FOCUS_GENERATION.load(Ordering::SeqCst);
    if should_restore_foreground_after_hide(generation, marked_generation)
        && CLIPBOARD_RESTORE_FOCUS_GENERATION
            .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        restore_foreground_app_before_paste();
    }
}

#[cfg(not(target_os = "windows"))]
fn restore_foreground_after_hide(_generation: u64) {}

#[cfg(target_os = "windows")]
fn activate_native_window(window: &tauri::WebviewWindow, _context: &str) {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        fn BringWindowToTop(hwnd: Hwnd) -> i32;
        fn SetActiveWindow(hwnd: Hwnd) -> Hwnd;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn SetFocus(hwnd: Hwnd) -> Hwnd;
    }

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = SetActiveWindow(hwnd.0);
            let _ = BringWindowToTop(hwnd.0);
            let _ = SetForegroundWindow(hwnd.0);
            if let Some(child_hwnd) = find_webview_child_window(hwnd.0) {
                let _ = SetFocus(child_hwnd);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn find_webview_child_window(parent: *mut std::ffi::c_void) -> Option<*mut std::ffi::c_void> {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;

    struct SearchState {
        candidate: Hwnd,
        candidate_priority: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumChildWindows(
            hwnd_parent: Hwnd,
            enum_func: extern "system" fn(Hwnd, isize) -> i32,
            lparam: isize,
        ) -> i32;
        fn GetClassNameW(hwnd: Hwnd, class_name: *mut u16, max_count: i32) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
    }

    extern "system" fn enum_child(hwnd: Hwnd, lparam: isize) -> i32 {
        let state = unsafe { &mut *(lparam as *mut SearchState) };
        let mut buffer = [0_u16; 256];
        let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len <= 0 {
            return 1;
        }

        let class_name = String::from_utf16_lossy(&buffer[..len as usize]);
        let visible = unsafe { IsWindowVisible(hwnd) } != 0;

        let priority = if class_name == "WRY_WEBVIEW" {
            50
        } else if class_name == "Chrome_WidgetWin_1" {
            40
        } else if class_name == "Chrome_WidgetWin_0" {
            30
        } else if class_name.contains("WebView") {
            20
        } else if class_name.contains("Chrome_RenderWidgetHostHWND") {
            10
        } else {
            0
        };

        if visible && priority > state.candidate_priority {
            state.candidate = hwnd;
            state.candidate_priority = priority;
        }
        1
    }

    let mut state = SearchState {
        candidate: std::ptr::null_mut(),
        candidate_priority: 0,
    };
    unsafe {
        EnumChildWindows(parent, enum_child, &mut state as *mut SearchState as isize);
    }

    if state.candidate.is_null() {
        None
    } else {
        Some(state.candidate)
    }
}

#[cfg(target_os = "macos")]
fn activate_native_window(window: &tauri::WebviewWindow, context: &str) {
    use cocoa::appkit::{NSApplication, NSWindow};
    use cocoa::base::{id, nil, YES};

    let window_clone = window.clone();
    let context_for_thread = context.to_string();
    if let Err(err) = window.run_on_main_thread(move || unsafe {
        let app = NSApplication::sharedApplication(nil);
        if app != nil {
            app.activateIgnoringOtherApps_(YES);
        }

        match window_clone.ns_window() {
            Ok(ns_window) => {
                let ns_window = ns_window as id;
                if ns_window != nil {
                    ns_window.orderFrontRegardless();
                    ns_window.makeKeyAndOrderFront_(nil);
                }
            }
            Err(err) => error!(
                "Failed to get macOS native window for {}: {:?}",
                context_for_thread, err
            ),
        }
    }) {
        error!(
            "Failed to dispatch macOS window activation for {}: {:?}",
            context, err
        );
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn activate_native_window(_window: &tauri::WebviewWindow, _context: &str) {}

fn focus_clipboard_window(window: &tauri::WebviewWindow, context: &str) {
    if !CLIPBOARD_VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    activate_native_window(window, context);
    if let Err(err) = window.set_focus() {
        error!("Failed to focus clipboard window: {:?}", err);
    }
    if let Err(err) = AsRef::<tauri::Webview>::as_ref(window).set_focus() {
        error!("Failed to focus clipboard webview: {:?}", err);
    }
}

fn hide_clipboard_window(window: &tauri::WebviewWindow) {
    hide_clipboard_window_with_onboarding_policy(window, false);
}

fn hide_clipboard_window_with_onboarding_policy(
    window: &tauri::WebviewWindow,
    allow_onboarding_shortcut_demo: bool,
) {
    if should_block_clipboard_hide_for_shortcut_demo(
        ONBOARDING_ACTIVE.load(Ordering::SeqCst),
        allow_onboarding_shortcut_demo,
    ) {
        return;
    }
    remember_clipboard_monitor(window);
    let generation = {
        let _transition = CLIPBOARD_WINDOW_TRANSITION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if should_block_clipboard_hide_for_shortcut_demo(
            ONBOARDING_ACTIVE.load(Ordering::SeqCst),
            allow_onboarding_shortcut_demo,
        ) {
            return;
        }
        if !CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
            || CLIPBOARD_HIDING.swap(true, Ordering::SeqCst)
        {
            return;
        }
        CLIPBOARD_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
    };
    mark_foreground_restore_for_hide(window, generation);

    if let Err(err) = window.emit("window-hide", ()) {
        error!("Failed to emit window-hide event: {:?}", err);
    }

    let window = window.clone();
    std::thread::spawn(move || {
        if let Err(err) =
            finish_animated_hide_window(&window, generation, allow_onboarding_shortcut_demo)
        {
            error!("Failed to hide clipboard window: {:?}", err);
        }
    });
}

fn show_clipboard_window(window: &tauri::WebviewWindow) {
    let bounds = target_clipboard_screen_bounds(window);
    let layout = clipboard_window_layout(bounds);
    let x = layout.x;
    let target_y = layout.target_y;
    let hidden_y = layout.hidden_y;
    let generation;
    let start_y;

    {
        let _transition = CLIPBOARD_WINDOW_TRANSITION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if CLIPBOARD_VISIBLE.load(Ordering::SeqCst) && !CLIPBOARD_HIDING.load(Ordering::SeqCst) {
            return;
        }

        let was_visible = window.is_visible().unwrap_or(false);
        if !was_visible {
            record_foreground_app_before_clipboard();
        }
        generation = CLIPBOARD_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

        start_y = if was_visible {
            current_window_logical_y(window, layout.scale_factor).unwrap_or(hidden_y)
        } else {
            hidden_y
        };
        let _ = set_window_position_for_scale(window, x, start_y, layout.scale_factor);
        let _ = set_window_size_for_scale(window, layout.width, layout.height, layout.scale_factor);
        let _ = set_window_position_for_scale(window, x, start_y, layout.scale_factor);

        if !was_visible {
            if let Err(err) = window.show() {
                error!("Failed to show clipboard window: {:?}", err);
                return;
            }
        }

        CLIPBOARD_VISIBLE.store(true, Ordering::SeqCst);
        CLIPBOARD_HIDING.store(false, Ordering::SeqCst);
    }

    let cursor = cursor_physical_position().and_then(|cursor| {
        let scale_factor = layout.scale_factor;
        let target_x = (x * scale_factor).round() as i32;
        let target_y = (target_y * scale_factor).round() as i32;
        let (width, height) = clipboard_window_physical_size(layout);
        let width = width as i32;
        let height = height as i32;
        let cursor_x = (cursor.x - target_x) as f64 / scale_factor;
        let cursor_y = (cursor.y - target_y) as f64 / scale_factor;
        if cursor_x >= 0.0
            && cursor_y >= 0.0
            && cursor.x <= target_x + width
            && cursor.y <= target_y + height
        {
            Some(serde_json::json!({ "x": cursor_x, "y": cursor_y }))
        } else {
            None
        }
    });
    if let Err(err) = window.emit("window-show", cursor) {
        error!("Failed to emit window-show event: {:?}", err);
    }

    focus_clipboard_window(window, "show clipboard");

    let animation_window = window.clone();
    std::thread::spawn(move || {
        match animate_clipboard_window_y(
            &animation_window,
            ClipboardWindowMotion {
                x,
                from_y: start_y,
                to_y: target_y,
                scale_factor: layout.scale_factor,
            },
            CLIPBOARD_SHOW_ANIMATION_MS,
            generation,
            ClipboardWindowAnimation::Show,
        ) {
            Ok(true) => {
                let _ = animation_window.emit("window-show-complete", ());
            }
            Ok(false) => info!("Skip stale clipboard show generation {}", generation),
            Err(err) => {
                error!("Failed to animate clipboard window up: {}", err);
                if CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) == generation {
                    let _ = set_window_position_for_scale(
                        &animation_window,
                        x,
                        target_y,
                        layout.scale_factor,
                    );
                    let _ = animation_window.emit("window-show-complete", ());
                }
            }
        }
    });
}

#[tauri::command]
fn begin_hide_clipboard_window(window: tauri::WebviewWindow) -> u64 {
    if clipboard_hide_blocked() {
        return 0;
    }
    remember_clipboard_monitor(&window);
    let generation = {
        let _transition = CLIPBOARD_WINDOW_TRANSITION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if clipboard_hide_blocked() {
            return 0;
        }
        if !CLIPBOARD_VISIBLE.load(Ordering::SeqCst) {
            return 0;
        }
        CLIPBOARD_HIDING.store(true, Ordering::SeqCst);
        CLIPBOARD_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
    };
    mark_foreground_restore_for_hide(&window, generation);
    let _ = window.emit("window-hide", ());
    generation
}

#[tauri::command]
async fn finish_hide_clipboard_window(
    window: tauri::WebviewWindow,
    generation: u64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        finish_animated_hide_window(&window, generation, false)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn hide_clipboard_if_inactive(window: tauri::WebviewWindow) {
    if clipboard_blur_hide_suppressed() {
        return;
    }
    let app = window.app_handle();
    if preview_window_active(&app) || tab_editor_window_active(&app) {
        return;
    }
    if CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
        && !window.is_focused().unwrap_or(false)
        && !is_native_window_foreground(&window, "frontend blur hide guard")
    {
        hide_clipboard_window(&window);
    }
}

#[tauri::command]
fn open_config_window(
    app: tauri::AppHandle,
    source_window: tauri::WebviewWindow,
    target: Option<String>,
) -> Result<(), String> {
    info!("Opening config window");
    let window = app
        .get_webview_window("config")
        .ok_or_else(|| "config window not found".to_string())?;
    let target = target.unwrap_or_default();
    let _ = window.unminimize();
    let _ = window.set_always_on_top(false);
    let _ = window.set_title("vPaste设置");
    apply_vpaste_window_icon(&window);
    center_window_on_source_monitor(&window, &source_window)?;
    if let Some(clipboard_window) = app.get_webview_window("clipboard") {
        let _ = finish_hide_window(&clipboard_window);
    }
    window.show().map_err(|err| err.to_string())?;
    activate_native_window(&window, "config open");
    window.set_focus().map_err(|err| err.to_string())?;
    let _ = AsRef::<tauri::Webview>::as_ref(&window).set_focus();
    let _ = window.emit("config-opened", target);
    Ok(())
}

#[tauri::command]
fn open_test_room_window(
    app: tauri::AppHandle,
    source_window: tauri::WebviewWindow,
) -> Result<(), String> {
    let window = app.get_webview_window("testRoom");
    if let Some(message) = test_room_window_open_error(get_developer_mode(), window.is_some()) {
        return Err(message.to_string());
    }
    let window = window.expect("test room window existence was checked above");
    let _ = window.unminimize();
    let was_maximized = window.is_maximized().unwrap_or(false);
    if was_maximized {
        let _ = window.unmaximize();
    }
    center_window_on_source_monitor(&window, &source_window)?;
    window.show().map_err(|err| err.to_string())?;
    if was_maximized {
        let _ = window.maximize();
    }
    activate_native_window(&window, "test room show");
    window.set_focus().map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_test_room_window(app: tauri::AppHandle) -> Result<(), String> {
    if !get_developer_mode() {
        return Err("测试间只在带 --dev-mode 参数的 Debug 构建中可用".to_string());
    }
    if let Some(window) = app.get_webview_window("testRoom") {
        window.hide().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_paste_fallback_notice(app: tauri::AppHandle) -> Result<(), String> {
    let clipboard_window = app
        .get_webview_window("clipboard")
        .ok_or_else(|| "clipboard window not found".to_string())?;
    let notice_window = app
        .get_webview_window("pasteFallbackNotice")
        .ok_or_else(|| "paste fallback notice window not found".to_string())?;
    let bounds = screen_bounds(&clipboard_window);
    let x = bounds.x + (bounds.width - PASTE_FALLBACK_NOTICE_WIDTH) / 2.0;
    let y = bounds.y + bounds.height - CLIPBOARD_WINDOW_HEIGHT + PASTE_FALLBACK_NOTICE_TOP_INSET;

    set_window_size_for_scale(
        &notice_window,
        PASTE_FALLBACK_NOTICE_WIDTH,
        PASTE_FALLBACK_NOTICE_HEIGHT,
        bounds.scale_factor,
    )?;
    set_window_position_for_scale(&notice_window, x, y, bounds.scale_factor)?;
    let generation = PASTE_FALLBACK_NOTICE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    notice_window.show().map_err(|err| err.to_string())?;
    let app_for_timer = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            PASTE_FALLBACK_NOTICE_DURATION_MS,
        ));
        if PASTE_FALLBACK_NOTICE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(window) = app_for_timer.get_webview_window("pasteFallbackNotice") {
            let _ = window.hide();
        }
    });
    Ok(())
}

#[tauri::command]
fn hide_paste_fallback_notice(app: tauri::AppHandle) -> Result<(), String> {
    PASTE_FALLBACK_NOTICE_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("pasteFallbackNotice") {
        window.hide().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn restore_foreground_app() {
    restore_foreground_app_before_paste();
}

#[tauri::command]
fn minimize_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|err| err.to_string())
}

fn apply_vpaste_window_icon(window: &tauri::WebviewWindow) {
    match build_vpaste_window_icon() {
        Ok(icon) => {
            if let Err(err) = window.set_icon(icon) {
                error!("Failed to set window icon: {:?}", err);
            }
        }
        Err(err) => error!("Failed to load window icon: {:?}", err),
    }
}

fn build_vpaste_window_icon() -> Result<TauriImage<'static>, image::ImageError> {
    #[cfg(target_os = "windows")]
    {
        const ICON_SIZE: u32 = 32;
        const ICON_INSET: u32 = 2;
        let logo =
            image::load_from_memory(include_bytes!("../icons/source/vpaste-app-icon-1024.png"))?
                .resize_exact(
                    ICON_SIZE - ICON_INSET * 2,
                    ICON_SIZE - ICON_INSET * 2,
                    image::imageops::FilterType::Lanczos3,
                )
                .to_rgba8();
        let mut icon = ImageBuffer::from_pixel(ICON_SIZE, ICON_SIZE, Rgba([0, 0, 0, 0]));
        image::imageops::overlay(&mut icon, &logo, ICON_INSET.into(), ICON_INSET.into());
        return Ok(TauriImage::new_owned(icon.into_raw(), ICON_SIZE, ICON_SIZE));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let icon = image::load_from_memory(include_bytes!("../icons/icon.png"))?.to_rgba8();
        let (width, height) = icon.dimensions();
        Ok(TauriImage::new_owned(icon.into_raw(), width, height))
    }
}

#[cfg(all(test, target_os = "windows"))]
mod window_icon_tests {
    use super::build_vpaste_window_icon;

    #[test]
    fn small_windows_icon_has_fully_transparent_corners() {
        let icon = build_vpaste_window_icon().expect("build the window icon");
        assert_eq!((icon.width(), icon.height()), (32, 32));
        let max_x = icon.width() - 1;
        let max_y = icon.height() - 1;
        let bytes = icon.rgba();

        for (x, y) in [(0, 0), (max_x, 0), (0, max_y), (max_x, max_y)] {
            let alpha = bytes[((y * icon.width() + x) * 4 + 3) as usize];
            assert_eq!(alpha, 0, "corner ({x}, {y})");
        }
    }
}

fn mark_onboarding_completed(app: &tauri::AppHandle) {
    let mut config = config::get();
    if !config.onboarding_completed {
        config.onboarding_completed = true;
        config::save(config);
        let _ = app.emit("onboarding-completed", ());
    }
}

fn begin_onboarding_impl(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = app
        .get_webview_window("clipboard")
        .ok_or_else(|| "clipboard window not found".to_string())?;
    ONBOARDING_ACTIVE.store(true, Ordering::SeqCst);
    ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
    show_clipboard_window(&window);
    Ok(window)
}

#[tauri::command]
fn begin_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    begin_onboarding_impl(&app).map(|_| ())
}

fn show_onboarding_window(app: &tauri::AppHandle) -> Result<(), String> {
    info!("Opening tutorial in main panel");
    let window = begin_onboarding_impl(app)?;
    let _ = window.emit("tutorial-started", ());
    Ok(())
}

#[tauri::command]
fn open_onboarding_window(app: tauri::AppHandle) -> Result<(), String> {
    show_onboarding_window(&app)
}

fn restore_parent_after_permission_guide(app: &tauri::AppHandle) {
    if PERMISSION_GUIDE_RETURN_TO_CONFIG.swap(false, Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window("config") {
            let _ = window.unminimize();
            let _ = window.show();
            activate_native_window(&window, "permission guide closed to config");
            let _ = window.set_focus();
            let _ = AsRef::<tauri::Webview>::as_ref(&window).set_focus();
            return;
        }
    }
    if let Some(window) = app.get_webview_window("clipboard") {
        show_clipboard_window(&window);
        focus_clipboard_window(&window, "permission guide closed");
    }
}

#[tauri::command]
fn open_onboarding_permission_window(
    app: tauri::AppHandle,
    source_window: tauri::WebviewWindow,
    permission: String,
    language_code: Option<String>,
    theme_preview: Option<String>,
) -> Result<(), String> {
    if !matches!(permission.as_str(), "background" | "paste") {
        return Err(format!("unsupported onboarding permission: {}", permission));
    }
    let theme_preview = match theme_preview.as_deref() {
        None => None,
        Some("light") => Some("light"),
        Some("dark") => Some("dark"),
        Some(value) => return Err(format!("unsupported theme preview: {}", value)),
    };
    PERMISSION_GUIDE_RETURN_TO_CONFIG.store(source_window.label() == "config", Ordering::SeqCst);

    let window = app
        .get_webview_window("onboardingPermission")
        .ok_or_else(|| "onboarding permission window not found".to_string())?;
    let _ = window.unminimize();
    center_window_on_source_monitor(&window, &source_window)?;
    let _ = window.set_shadow(false);
    window
        .set_always_on_top(true)
        .map_err(|err| err.to_string())?;
    #[cfg(target_os = "macos")]
    set_macos_window_level(&window, 102);
    window.show().map_err(|err| err.to_string())?;
    activate_native_window(&window, "onboarding permission open");
    window.set_focus().map_err(|err| err.to_string())?;
    let _ = AsRef::<tauri::Webview>::as_ref(&window).set_focus();
    #[cfg(target_os = "macos")]
    configure_macos_transparent_window(&window);
    window
        .emit(
            "onboarding-permission-open",
            serde_json::json!({
                "permission": permission,
                "languageCode": language_code.unwrap_or_default(),
                "themePreview": theme_preview,
            }),
        )
        .map_err(|err| err.to_string())?;

    Ok(())
}

#[tauri::command]
fn hide_onboarding_permission_window(
    app: tauri::AppHandle,
    restore_parent: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("onboardingPermission") {
        window.hide().map_err(|err| err.to_string())?;
    }
    if restore_parent {
        restore_parent_after_permission_guide(&app);
    }
    Ok(())
}

#[tauri::command]
fn notify_onboarding_permission_status_changed(
    app: tauri::AppHandle,
    permission: String,
) -> Result<(), String> {
    if !matches!(permission.as_str(), "background" | "paste") {
        return Err(format!("unsupported onboarding permission: {}", permission));
    }
    app.emit("onboarding-permission-status-changed", permission)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn complete_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    mark_onboarding_completed(&app);
    ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
    ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.emit("tutorial-completed", ());
    }
    Ok(())
}

#[tauri::command]
fn set_onboarding_shortcut_demo_enabled(enabled: bool) {
    let active = ONBOARDING_ACTIVE.load(Ordering::SeqCst);
    ONBOARDING_SHORTCUT_DEMO_ENABLED.store(enabled && active, Ordering::SeqCst);
}

fn get_or_create_preview_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("clipboardPreview") {
        return Ok(window);
    }

    WebviewWindowBuilder::new(app, "clipboardPreview", App("clipboard/preview".into()))
        .title("vPaste Preview")
        .visible(false)
        .focused(false)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(true)
        .shadow(false)
        .inner_size(PREVIEW_WINDOW_WIDTH, PREVIEW_WINDOW_HEIGHT)
        .build()
        .inspect(|window| {
            let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            let _ = window.set_shadow(false);
            apply_vpaste_window_icon(window);
            #[cfg(target_os = "macos")]
            set_macos_window_level(window, 102); // Above NSPopUpMenuWindowLevel
        })
        .map_err(|err| err.to_string())
}

fn preview_window_active(app: &tauri::AppHandle) -> bool {
    if PREVIEW_PINNED.load(Ordering::SeqCst)
        || now_millis() < PREVIEW_IGNORE_BLUR_UNTIL.load(Ordering::SeqCst)
    {
        return preview_window_visible(app);
    }
    app.get_webview_window("clipboardPreview")
        .map(|window| {
            window.is_visible().unwrap_or(false)
                && (window.is_focused().unwrap_or(false)
                    || is_native_window_foreground(&window, "preview active guard"))
        })
        .unwrap_or(false)
}

fn preview_window_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("clipboardPreview")
        .map(|window| window.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

fn app_window_is_foreground(app: &tauri::AppHandle, label: &str, context: &str) -> bool {
    app.get_webview_window(label)
        .map(|window| is_native_window_foreground(&window, context))
        .unwrap_or(false)
}

fn hide_preview_and_clipboard(app: &tauri::AppHandle, context: &str) {
    info!("Hide preview and clipboard: {}", context);
    PREVIEW_PINNED.store(false, Ordering::SeqCst);
    if let Some(preview_window) = app.get_webview_window("clipboardPreview") {
        let _ = preview_window.emit("preview-clear", ());
        let _ = preview_window.hide();
    }
    if let Some(clipboard_window) = app.get_webview_window("clipboard") {
        hide_clipboard_window(&clipboard_window);
    }
}

fn handle_config_focus_lost(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(35));
        let Some(config_window) = app.get_webview_window("config") else {
            return;
        };
        let config_focused = config_window.is_focused().unwrap_or(false);
        let config_foreground =
            is_native_window_foreground(&config_window, "config blur self guard");
        if config_focused || config_foreground {
            return;
        }

        if let Some(clipboard_window) = app.get_webview_window("clipboard") {
            let clipboard_focused = clipboard_window.is_focused().unwrap_or(false);
            let clipboard_foreground =
                is_native_window_foreground(&clipboard_window, "config blur clipboard guard");
            if !clipboard_focused && !clipboard_foreground {
                let _ = finish_hide_window(&clipboard_window);
            }
        }
    });
}

fn cursor_inside_window(window: &tauri::WebviewWindow) -> bool {
    let Some(cursor) = cursor_physical_position() else {
        return false;
    };
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let x = cursor.x;
    let y = cursor.y;
    let left = position.x;
    let top = position.y;
    let right = left.saturating_add(size.width as i32);
    let bottom = top.saturating_add(size.height as i32);
    x >= left && x <= right && y >= top && y <= bottom
}

fn cursor_inside_app_windows(app: &tauri::AppHandle) -> bool {
    ["clipboard", "clipboardPreview", "tabEditor", "emojiPicker"]
        .iter()
        .any(|label| {
            app.get_webview_window(label)
                .map(|window| window.is_visible().unwrap_or(false) && cursor_inside_window(&window))
                .unwrap_or(false)
        })
}

fn tab_editor_window_active(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("tabEditor")
        .map(|window| {
            window.is_visible().unwrap_or(false)
                && (window.is_focused().unwrap_or(false)
                    || is_native_window_foreground(&window, "tab editor active guard"))
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn mouse_button_pressed() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(virtual_key: i32) -> i16;
    }

    const VK_LBUTTON: i32 = 0x01;
    const VK_RBUTTON: i32 = 0x02;
    const VK_MBUTTON: i32 = 0x04;
    unsafe {
        GetAsyncKeyState(VK_LBUTTON) < 0
            || GetAsyncKeyState(VK_RBUTTON) < 0
            || GetAsyncKeyState(VK_MBUTTON) < 0
    }
}

#[cfg(target_os = "macos")]
fn mouse_button_pressed() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: u32, button: u32) -> bool;
    }

    const COMBINED_SESSION_STATE: u32 = 0;
    const LEFT_BUTTON: u32 = 0;
    const RIGHT_BUTTON: u32 = 1;
    const CENTER_BUTTON: u32 = 2;
    unsafe {
        CGEventSourceButtonState(COMBINED_SESSION_STATE, LEFT_BUTTON)
            || CGEventSourceButtonState(COMBINED_SESSION_STATE, RIGHT_BUTTON)
            || CGEventSourceButtonState(COMBINED_SESSION_STATE, CENTER_BUTTON)
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn mouse_button_pressed() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn virtual_key_pressed(virtual_key: i32) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(virtual_key: i32) -> i16;
    }

    unsafe { GetAsyncKeyState(virtual_key) < 0 }
}

#[cfg(target_os = "windows")]
fn quick_input_trigger_virtual_key(trigger_key: &str) -> Option<i32> {
    match trigger_key.trim().to_ascii_uppercase().as_str() {
        "0" => Some(0x30),
        "1" => Some(0x31),
        "2" => Some(0x32),
        "3" => Some(0x33),
        "4" => Some(0x34),
        "5" => Some(0x35),
        "6" => Some(0x36),
        "7" => Some(0x37),
        "8" => Some(0x38),
        "9" => Some(0x39),
        "A" => Some(0x41),
        "F" => Some(0x46),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn is_alt_key_pressed() -> bool {
    const VK_MENU: i32 = 0x12;
    const VK_LMENU: i32 = 0xA4;
    const VK_RMENU: i32 = 0xA5;
    virtual_key_pressed(VK_MENU) || virtual_key_pressed(VK_LMENU) || virtual_key_pressed(VK_RMENU)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn is_quick_input_modifier_pressed(trigger_key: String) -> bool {
    is_alt_key_pressed()
        || quick_input_trigger_virtual_key(&trigger_key)
            .map(virtual_key_pressed)
            .unwrap_or(false)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn is_alt_key_pressed() -> bool {
    use core_graphics::event::CGEventFlags;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state_id: u32) -> CGEventFlags;
    }

    const COMBINED_SESSION_STATE: u32 = 0;
    unsafe {
        CGEventSourceFlagsState(COMBINED_SESSION_STATE).contains(CGEventFlags::CGEventFlagAlternate)
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn is_quick_input_modifier_pressed(_trigger_key: String) -> bool {
    is_alt_key_pressed()
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
#[tauri::command]
fn is_alt_key_pressed() -> bool {
    false
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
#[tauri::command]
fn is_quick_input_modifier_pressed(_trigger_key: String) -> bool {
    false
}

fn watch_tray_menu_outside_click(app: tauri::AppHandle) {
    if TRAY_MENU_WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(160));
        loop {
            let Some(window) = app.get_webview_window("trayMenu") else {
                break;
            };
            if !window.is_visible().unwrap_or(false) {
                break;
            }
            if mouse_button_pressed() && !cursor_inside_window(&window) {
                let _ = window.hide();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        TRAY_MENU_WATCHING.store(false, Ordering::SeqCst);
    });
}

fn should_dismiss_paste_queue_menu(
    menu_open: bool,
    mouse_pressed: bool,
    cursor_inside: bool,
) -> bool {
    menu_open && mouse_pressed && !cursor_inside
}

fn watch_paste_queue_menu_outside_click(app: tauri::AppHandle, generation: u64) {
    std::thread::spawn(move || loop {
        if PASTE_QUEUE_MENU_GENERATION.load(Ordering::SeqCst) != generation
            || !PASTE_QUEUE_MENU_OPEN.load(Ordering::SeqCst)
        {
            break;
        }
        let Some(window) = app.get_webview_window("pasteQueue") else {
            break;
        };
        if !window.is_visible().unwrap_or(false) {
            break;
        }
        if should_dismiss_paste_queue_menu(
            true,
            mouse_button_pressed(),
            cursor_inside_window(&window),
        ) {
            if PASTE_QUEUE_MENU_GENERATION.load(Ordering::SeqCst) == generation
                && PASTE_QUEUE_MENU_OPEN.swap(false, Ordering::SeqCst)
            {
                PASTE_QUEUE_MENU_GENERATION.fetch_add(1, Ordering::SeqCst);
                let _ = window.emit("paste-queue-dismiss-menu", ());
            }
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(12));
    });
}

#[derive(Clone, Copy, Serialize)]
struct PasteQueuePointerPosition {
    x: f64,
    y: f64,
    inside: bool,
}

fn paste_queue_pointer_position(
    window: &tauri::WebviewWindow,
) -> Option<(PasteQueuePointerPosition, (i32, i32, bool))> {
    let cursor = window.cursor_position().ok()?;
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().ok()?;
    let physical_x = cursor.x - position.x as f64;
    let physical_y = cursor.y - position.y as f64;
    let inside = physical_x >= 0.0
        && physical_y >= 0.0
        && physical_x <= size.width as f64
        && physical_y <= size.height as f64;
    let payload = PasteQueuePointerPosition {
        x: physical_x / scale,
        y: physical_y / scale,
        inside,
    };
    let identity = if inside {
        (cursor.x.round() as i32, cursor.y.round() as i32, true)
    } else {
        (0, 0, false)
    };
    Some((payload, identity))
}

fn watch_paste_queue_pointer(app: tauri::AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let mut last_position = None;
        let mut last_foreground_recorded_at = Instant::now()
            .checked_sub(std::time::Duration::from_millis(100))
            .unwrap_or_else(Instant::now);
        loop {
            if PASTE_QUEUE_POINTER_GENERATION.load(Ordering::SeqCst) != generation
                || !paste_queue::is_active()
            {
                break;
            }
            let Some(window) = app.get_webview_window("pasteQueue") else {
                break;
            };
            if !window.is_visible().unwrap_or(false) {
                break;
            }
            if let Some((payload, identity)) = paste_queue_pointer_position(&window) {
                if last_position != Some(identity) {
                    let _ = window.emit("paste-queue-pointer-position", payload);
                    last_position = Some(identity);
                }
            }
            if should_track_paste_queue_foreground_target(
                paste_queue::is_active(),
                CLIPBOARD_VISIBLE.load(Ordering::SeqCst),
            ) && last_foreground_recorded_at.elapsed() >= std::time::Duration::from_millis(100)
            {
                record_foreground_app_before_clipboard();
                last_foreground_recorded_at = Instant::now();
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        if let Some(window) = app.get_webview_window("pasteQueue") {
            let _ = window.emit(
                "paste-queue-pointer-position",
                PasteQueuePointerPosition {
                    x: -1.0,
                    y: -1.0,
                    inside: false,
                },
            );
        }
    });
}

fn should_track_paste_queue_foreground_target(active: bool, clipboard_visible: bool) -> bool {
    active && !clipboard_visible
}

#[cfg(test)]
mod paste_queue_menu_tests {
    use super::{
        should_dismiss_paste_queue_menu, should_prepare_paste_queue_click_target,
        should_refresh_paste_queue_click_target, should_track_paste_queue_foreground_target,
        PasteQueueRequestOrigin,
    };

    #[test]
    fn only_an_outside_mouse_press_dismisses_an_open_menu() {
        assert!(should_dismiss_paste_queue_menu(true, true, false));
        assert!(!should_dismiss_paste_queue_menu(true, true, true));
        assert!(!should_dismiss_paste_queue_menu(true, false, false));
        assert!(!should_dismiss_paste_queue_menu(false, true, false));
    }

    #[test]
    fn every_queue_window_click_restores_the_previous_target() {
        assert!(should_prepare_paste_queue_click_target(
            PasteQueueRequestOrigin::QueueWindow,
            true,
        ));
        assert!(should_prepare_paste_queue_click_target(
            PasteQueueRequestOrigin::QueueWindow,
            false,
        ));
        assert!(!should_prepare_paste_queue_click_target(
            PasteQueueRequestOrigin::Shortcut,
            true,
        ));
    }

    #[test]
    fn queue_click_refreshes_the_target_when_the_main_panel_is_hidden() {
        assert!(should_refresh_paste_queue_click_target(
            PasteQueueRequestOrigin::QueueWindow,
            false,
        ));
        assert!(!should_refresh_paste_queue_click_target(
            PasteQueueRequestOrigin::QueueWindow,
            true,
        ));
        assert!(!should_refresh_paste_queue_click_target(
            PasteQueueRequestOrigin::Shortcut,
            false,
        ));
    }

    #[test]
    fn active_queue_tracks_external_foreground_while_main_panel_is_hidden() {
        assert!(should_track_paste_queue_foreground_target(true, false));
        assert!(!should_track_paste_queue_foreground_target(false, false));
        assert!(!should_track_paste_queue_foreground_target(true, true));
    }
}

fn handle_preview_focus_lost(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(35));

        let now = now_millis();
        let ignore_until = PREVIEW_IGNORE_BLUR_UNTIL.load(Ordering::SeqCst);
        let pinned = PREVIEW_PINNED.load(Ordering::SeqCst);
        let cursor_inside_app = cursor_inside_app_windows(&app);
        let preview_foreground =
            app_window_is_foreground(&app, "clipboardPreview", "preview blur guard");
        let clipboard_foreground =
            app_window_is_foreground(&app, "clipboard", "preview blur guard clipboard");

        if pinned {
            info!("Skip preview blur hide: pinned");
            return;
        }

        if preview_foreground {
            info!("Skip preview blur hide: preview is foreground");
            return;
        }

        if !cursor_inside_app && !clipboard_foreground {
            hide_preview_and_clipboard(&app, "preview blur cursor outside app");
            return;
        }

        if clipboard_foreground {
            info!("Hide preview on blur to clipboard");
            if let Some(preview_window) = app.get_webview_window("clipboardPreview") {
                let _ = preview_window.hide();
            }
            if let Some(clipboard_window) = app.get_webview_window("clipboard") {
                focus_clipboard_window(&clipboard_window, "preview blur to clipboard");
            }
            return;
        }

        if now < ignore_until {
            info!(
                "Preview blur during open grace, will recheck, now={}, ignore_until={}",
                now, ignore_until
            );
            std::thread::sleep(std::time::Duration::from_millis(120));
            if !preview_window_visible(&app) || PREVIEW_PINNED.load(Ordering::SeqCst) {
                return;
            }
            let cursor_inside_app = cursor_inside_app_windows(&app);
            let preview_foreground =
                app_window_is_foreground(&app, "clipboardPreview", "preview grace recheck");
            let clipboard_foreground =
                app_window_is_foreground(&app, "clipboard", "preview grace recheck clipboard");
            if preview_foreground {
                info!("Skip preview grace recheck: preview is foreground");
                return;
            }
            if clipboard_foreground {
                info!("Hide preview on grace recheck to clipboard");
                if let Some(preview_window) = app.get_webview_window("clipboardPreview") {
                    let _ = preview_window.hide();
                }
                if let Some(clipboard_window) = app.get_webview_window("clipboard") {
                    focus_clipboard_window(&clipboard_window, "preview grace recheck to clipboard");
                }
                return;
            }
            if cursor_inside_app {
                info!("Skip preview grace recheck: cursor inside app windows");
                return;
            }
            hide_preview_and_clipboard(&app, "preview grace recheck outside app");
            return;
        }

        hide_preview_and_clipboard(&app, "preview blur outside app");
    });
}

fn preview_size_for_image(width: u32, height: u32, bounds: ScreenBounds) -> PreviewWindowSize {
    let max_width = (bounds.width * 0.86).max(240.0);
    let max_height = (bounds.height * 0.84).max(180.0);
    let min_width = PREVIEW_IMAGE_MIN_WIDTH.min(max_width);
    let min_height = PREVIEW_IMAGE_MIN_HEIGHT.min(max_height);
    let image_width = width as f64;
    let image_height = height as f64;
    let upscale = if image_width > 0.0 && image_height > 0.0 {
        (360.0 / image_width)
            .min(280.0 / image_height)
            .clamp(1.0, 2.2)
    } else {
        1.0
    };
    let natural_width = image_width * upscale + PREVIEW_IMAGE_PADDING;
    let natural_height = image_height * upscale + PREVIEW_IMAGE_PADDING;
    let scale = (max_width / natural_width)
        .min(max_height / natural_height)
        .min(1.0);
    PreviewWindowSize {
        width: (natural_width * scale).clamp(min_width, max_width).round(),
        height: (natural_height * scale)
            .clamp(min_height, max_height)
            .round(),
    }
}

fn preview_window_size(
    item_type: &str,
    content: &str,
    preview_content: &str,
    preview_asset_path: &str,
    rich_html: &str,
    bounds: ScreenBounds,
) -> PreviewWindowSize {
    if item_type == "Image" {
        let path = if preview_content.is_empty() {
            content
        } else {
            preview_content
        };
        if let Ok((width, height)) = (!preview_asset_path.is_empty())
            .then(|| image::image_dimensions(preview_asset_path).map_err(|err| err.to_string()))
            .unwrap_or_else(|| Err("no preview asset".to_string()))
            .or_else(|_| image_dimensions_secure(path))
            .or_else(|_| image::image_dimensions(path).map_err(|err| err.to_string()))
        {
            return preview_size_for_image(width, height, bounds);
        }
        return PreviewWindowSize {
            width: 900.0_f64.min(bounds.width * 0.82).round(),
            height: 680.0_f64.min(bounds.height * 0.82).round(),
        };
    }

    if item_type == "File" {
        if let Ok(info) = build_file_preview_info(content.to_string()) {
            if info.kind == "pdf-preview" {
                return PreviewWindowSize {
                    width: (bounds.width * 0.8).round(),
                    height: (bounds.height * 0.8).round(),
                };
            }
            if info.kind == "text-preview" {
                return PreviewWindowSize {
                    width: PREVIEW_WINDOW_WIDTH.min(bounds.width * 0.8).round(),
                    height: PREVIEW_WINDOW_HEIGHT.min(bounds.height * 0.8).round(),
                };
            }
            if info.kind == "single-preview" && !info.preview_path.is_empty() {
                if let Ok((width, height)) = image::image_dimensions(&info.preview_path) {
                    let mut size = preview_size_for_image(width, height, bounds);
                    size.height = (size.height + 54.0).min(bounds.height * 0.8).round();
                    return size;
                }
            }
        }
    }

    if item_type == "Color" {
        return PreviewWindowSize {
            width: 460.0,
            height: 360.0,
        };
    }

    if item_type == "Link" {
        return PreviewWindowSize {
            width: 980.0_f64.min(bounds.width * 0.84).round(),
            height: 700.0_f64.min(bounds.height * 0.84).round(),
        };
    }

    if !rich_html.trim().is_empty() {
        return PreviewWindowSize {
            width: 840.0_f64.min(bounds.width * 0.8).round(),
            height: 620.0_f64.min(bounds.height * 0.8).round(),
        };
    }

    PreviewWindowSize {
        width: PREVIEW_WINDOW_WIDTH.min(bounds.width * 0.8).round(),
        height: PREVIEW_WINDOW_HEIGHT.min(bounds.height * 0.8).round(),
    }
}

fn preview_position_avoiding_clipboard(
    app: &tauri::AppHandle,
    bounds: ScreenBounds,
    size: PreviewWindowSize,
) -> LogicalPosition<f64> {
    let fallback = LogicalPosition {
        x: bounds.x + (bounds.width - size.width) / 2.0,
        y: bounds.y + (bounds.height - size.height) / 2.0,
    };

    let Some(clipboard_window) = app.get_webview_window("clipboard") else {
        return fallback;
    };
    if !clipboard_window.is_visible().unwrap_or(false) {
        return fallback;
    }

    let Ok(clipboard_position) = clipboard_window.outer_position() else {
        return fallback;
    };
    let Ok(scale_factor) = clipboard_window.scale_factor() else {
        return fallback;
    };

    let clipboard_top = clipboard_position.y as f64 / scale_factor;
    let available_height = (clipboard_top - bounds.y - PREVIEW_CLIPBOARD_GAP).max(0.0);
    let x = (bounds.x + (bounds.width - size.width) / 2.0)
        .clamp(bounds.x, bounds.x + (bounds.width - size.width).max(0.0));

    if available_height >= size.height {
        LogicalPosition {
            x,
            y: bounds.y + (available_height - size.height) / 2.0,
        }
    } else {
        LogicalPosition {
            x,
            y: bounds.y + PREVIEW_CLIPBOARD_GAP,
        }
    }
}

fn preview_bounds_avoiding_clipboard(app: &tauri::AppHandle, bounds: ScreenBounds) -> ScreenBounds {
    let Some(clipboard_window) = app.get_webview_window("clipboard") else {
        return bounds;
    };
    if !clipboard_window.is_visible().unwrap_or(false) {
        return bounds;
    }

    let Ok(clipboard_position) = clipboard_window.outer_position() else {
        return bounds;
    };
    let Ok(scale_factor) = clipboard_window.scale_factor() else {
        return bounds;
    };

    let clipboard_top = clipboard_position.y as f64 / scale_factor;
    let available_height = (clipboard_top - bounds.y - PREVIEW_CLIPBOARD_GAP).max(0.0);
    if available_height <= 0.0 {
        return bounds;
    }

    ScreenBounds {
        height: available_height.min(bounds.height),
        ..bounds
    }
}

#[tauri::command]
fn show_preview_window(
    app: tauri::AppHandle,
    item_type: String,
    content: String,
    preview_content: String,
    text_content: String,
    rich_html: String,
    app_source: String,
) -> Result<(), String> {
    let window = get_or_create_preview_window(&app)?;
    let bounds = clipboard_screen_bounds(&app, &window);
    let source_image_path = if preview_content.is_empty() {
        content.as_str()
    } else {
        preview_content.as_str()
    };
    let preview_asset_path = if item_type == "Image" {
        image_preview_asset_path(source_image_path).unwrap_or_default()
    } else {
        String::new()
    };
    let preview_bounds = preview_bounds_avoiding_clipboard(&app, bounds);
    let size = preview_window_size(
        &item_type,
        &content,
        &preview_content,
        &preview_asset_path,
        &rich_html,
        preview_bounds,
    );
    PREVIEW_PINNED.store(false, Ordering::SeqCst);
    PREVIEW_IGNORE_BLUR_UNTIL.store(now_millis().saturating_add(1800), Ordering::SeqCst);
    let position = preview_position_avoiding_clipboard(&app, bounds, size);
    set_window_position_for_scale(&window, position.x, position.y, bounds.scale_factor)?;
    set_window_size_for_scale(&window, size.width, size.height, bounds.scale_factor)?;
    let _ = window.emit("preview-clear", ());
    window
        .emit(
            "preview-item",
            PreviewPayload {
                item_type,
                content,
                preview_content,
                preview_asset_path,
                text_content,
                rich_html,
                app_source,
            },
        )
        .map_err(|err| err.to_string())?;
    window.show().map_err(|err| err.to_string())?;
    let _ = window.set_always_on_top(true);
    #[cfg(target_os = "macos")]
    set_macos_window_level(&window, 102);
    focus_clipboard_window(&window, "preview show");
    window.set_focus().map_err(|err| err.to_string())?;
    AsRef::<tauri::Webview>::as_ref(&window)
        .set_focus()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn resize_preview_image_window(
    app: tauri::AppHandle,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("clipboardPreview") else {
        return Ok(());
    };
    let bounds = clipboard_screen_bounds(&app, &window);
    let preview_bounds = preview_bounds_avoiding_clipboard(&app, bounds);
    let size = preview_size_for_image(width, height, preview_bounds);
    set_window_size_for_scale(&window, size.width, size.height, bounds.scale_factor)?;
    let position = preview_position_avoiding_clipboard(&app, bounds, size);
    set_window_position_for_scale(&window, position.x, position.y, bounds.scale_factor)
}

#[tauri::command]
async fn fetch_link_preview_document(url: String) -> Result<LinkPreviewDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = reqwest::Url::parse(url.trim()).map_err(|err| err.to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("unsupported url scheme".to_string());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::limited(6))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 vPaste/1.0")
            .build()
            .map_err(|err| err.to_string())?;
        let response = client
            .get(parsed.clone())
            .send()
            .map_err(|err| err.to_string())?
            .error_for_status()
            .map_err(|err| err.to_string())?;
        let final_url = response.url().clone();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.is_empty() && !content_type.contains("text/html") {
            return Err("preview only supports html pages".to_string());
        }
        let mut html = response.text().map_err(|err| err.to_string())?;
        let base = format!(r#"<base href="{}">"#, final_url);
        if html.to_ascii_lowercase().contains("<head") {
            html = html.replacen("<head>", &format!("<head>{}", base), 1);
            html = html.replacen("<HEAD>", &format!("<HEAD>{}", base), 1);
        } else {
            html = format!("<head>{}</head>{}", base, html);
        }
        Ok(LinkPreviewDocument {
            url: final_url.to_string(),
            html,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn is_preview_window_visible(app: tauri::AppHandle) -> bool {
    preview_window_visible(&app)
}

#[tauri::command]
fn set_preview_pinned(pinned: bool) {
    PREVIEW_PINNED.store(pinned, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
fn set_macos_window_level(window: &tauri::WebviewWindow, level: isize) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    let window_clone = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns_window) = window_clone.ns_window() {
            unsafe {
                if !ns_window.is_null() {
                    let id = ns_window as id;
                    let _: () = msg_send![id, setLevel:level];
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn configure_macos_transparent_window(window: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSColor, NSWindow};
    use cocoa::base::{id, nil, NO};

    let window_clone = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns_window) = window_clone.ns_window() {
            unsafe {
                if !ns_window.is_null() {
                    let ns_window = ns_window as id;
                    ns_window.setOpaque_(NO);
                    ns_window.setBackgroundColor_(NSColor::clearColor(nil));
                    ns_window.setHasShadow_(NO);
                    ns_window.invalidateShadow();
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn enable_macos_mouse_moved_events(window: &tauri::WebviewWindow) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    let window_clone = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns_window) = window_clone.ns_window() {
            unsafe {
                if !ns_window.is_null() {
                    let id = ns_window as id;
                    let _: () = msg_send![id, setAcceptsMouseMovedEvents:true];
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn hide_macos_dock_icon() {
    use cocoa::base::id;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy:1_i64];
    }
}

#[cfg(target_os = "macos")]
fn maybe_hide_macos_dock_icon() {
    if CLIPBOARD_VISIBLE.load(Ordering::SeqCst) {
        return;
    }

    hide_macos_dock_icon();
}

#[tauri::command]
fn hide_preview_window(app: tauri::AppHandle) -> Result<(), String> {
    PREVIEW_PINNED.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("clipboardPreview") {
        let _ = window.emit("preview-clear", ());
        window.hide().map_err(|err| err.to_string())?;
    }
    if let Some(clipboard_window) = app.get_webview_window("clipboard") {
        focus_clipboard_window(&clipboard_window, "preview closed");
    }
    Ok(())
}

fn show_main_panel_for_app(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("clipboard")
        .ok_or_else(|| "clipboard window not found".to_string())?;
    show_clipboard_window(&window);
    Ok(())
}

#[tauri::command]
fn show_main_panel(app: tauri::AppHandle) -> Result<(), String> {
    show_main_panel_for_app(&app)
}

#[tauri::command]
fn hide_tray_menu(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
fn resize_tray_menu(window: tauri::WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    window
        .set_size(tauri::Size::Logical(LogicalSize {
            width: width as f64,
            height: height as f64,
        }))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn open_tab_editor_window(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    payload: String,
) -> Result<(), String> {
    let window = app
        .get_webview_window("tabEditor")
        .ok_or_else(|| "tab editor window not found".to_string())?;
    let content_width = width.unwrap_or(TAB_EDITOR_CONTENT_WIDTH);
    let content_height = height.unwrap_or(TAB_EDITOR_DEFAULT_CONTENT_HEIGHT);
    let bounds = clipboard_screen_bounds(&app, &window);
    let _ = window.set_size(tauri::Size::Logical(LogicalSize {
        width: content_width + AUXILIARY_WINDOW_GUTTER * 2.0,
        height: content_height + AUXILIARY_WINDOW_GUTTER * 2.0,
    }));
    set_window_position_for_scale(
        &window,
        x - AUXILIARY_WINDOW_GUTTER,
        y - AUXILIARY_WINDOW_GUTTER,
        bounds.scale_factor,
    )?;
    window.show().map_err(|err| err.to_string())?;
    let _ = activate_native_window(&window, "tab editor open");
    window.set_focus().map_err(|err| err.to_string())?;
    window
        .emit("tab-editor-open", payload)
        .map_err(|err| err.to_string())
}

fn popup_position_above_or_below(
    anchor: (f64, f64, f64, f64),
    popup_size: (f64, f64),
    gap: f64,
    bounds: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (anchor_left, anchor_top, anchor_right, anchor_bottom) = anchor;
    let (popup_width, popup_height) = popup_size;
    let (min_x, min_y, max_x, max_y) = bounds;
    let anchor_center_x = (anchor_left + anchor_right) / 2_f64;
    let x = (anchor_center_x - popup_width / 2_f64).clamp(min_x, max_x.max(min_x));
    let above_y = anchor_top - popup_height - gap;
    let below_y = anchor_bottom + gap;
    let y = if above_y >= min_y {
        above_y
    } else if below_y <= max_y {
        below_y
    } else {
        above_y.clamp(min_y, max_y.max(min_y))
    };
    (x, y)
}

#[tauri::command]
fn open_emoji_picker_window(
    app: tauri::AppHandle,
    anchor_left: f64,
    anchor_top: f64,
    anchor_right: f64,
    anchor_bottom: f64,
    payload: String,
) -> Result<(), String> {
    const PICKER_GAP: f64 = 5_f64;
    const SCREEN_MARGIN: f64 = 8_f64;

    let editor = app
        .get_webview_window("tabEditor")
        .ok_or_else(|| "tab editor window not found".to_string())?;
    let window = app
        .get_webview_window("emojiPicker")
        .ok_or_else(|| "emoji picker window not found".to_string())?;

    let editor_position = editor.outer_position().map_err(|err| err.to_string())?;
    let scale_factor = editor.scale_factor().map_err(|err| err.to_string())?;
    let picker_width = EMOJI_PICKER_CONTENT_WIDTH * scale_factor;
    let picker_height = EMOJI_PICKER_CONTENT_HEIGHT * scale_factor;
    let window_gutter = AUXILIARY_WINDOW_GUTTER * scale_factor;
    let gap = PICKER_GAP * scale_factor;
    let margin = SCREEN_MARGIN * scale_factor;
    let button_left = editor_position.x as f64 + anchor_left * scale_factor;
    let button_top = editor_position.y as f64 + anchor_top * scale_factor;
    let button_right = editor_position.x as f64 + anchor_right * scale_factor;
    let button_bottom = editor_position.y as f64 + anchor_bottom * scale_factor;

    let monitor = editor
        .current_monitor()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "tab editor monitor not found".to_string())?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let min_x = monitor_position.x as f64 + margin;
    let min_y = monitor_position.y as f64 + margin;
    let max_x = monitor_position.x as f64 + monitor_size.width as f64 - picker_width - margin;
    let max_y = monitor_position.y as f64 + monitor_size.height as f64 - picker_height - margin;

    let (x, y) = popup_position_above_or_below(
        (button_left, button_top, button_right, button_bottom),
        (picker_width, picker_height),
        gap,
        (min_x, min_y, max_x, max_y),
    );

    let _ = window.set_size(tauri::Size::Logical(LogicalSize {
        width: EMOJI_PICKER_CONTENT_WIDTH + AUXILIARY_WINDOW_GUTTER * 2.0,
        height: EMOJI_PICKER_CONTENT_HEIGHT + AUXILIARY_WINDOW_GUTTER * 2.0,
    }));
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: (x - window_gutter).round() as i32,
            y: (y - window_gutter).round() as i32,
        }))
        .map_err(|err| err.to_string())?;
    window.show().map_err(|err| err.to_string())?;
    let _ = activate_native_window(&window, "emoji picker open");
    window.set_focus().map_err(|err| err.to_string())?;
    window
        .emit("emoji-picker-open", payload)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod popup_position_tests {
    use super::popup_position_above_or_below;

    #[test]
    fn places_popup_above_the_anchor_when_space_is_available() {
        let position = popup_position_above_or_below(
            (200.0, 300.0, 240.0, 332.0),
            (100.0, 80.0),
            5.0,
            (8.0, 8.0, 892.0, 712.0),
        );

        assert_eq!(position, (170.0, 215.0));
    }

    #[test]
    fn falls_back_below_the_anchor_near_the_top_edge() {
        let position = popup_position_above_or_below(
            (200.0, 40.0, 240.0, 72.0),
            (100.0, 80.0),
            5.0,
            (8.0, 8.0, 892.0, 712.0),
        );

        assert_eq!(position, (170.0, 77.0));
    }

    #[test]
    fn keeps_popup_inside_the_horizontal_monitor_bounds() {
        let position = popup_position_above_or_below(
            (6.0, 300.0, 38.0, 332.0),
            (100.0, 80.0),
            5.0,
            (8.0, 8.0, 892.0, 712.0),
        );

        assert_eq!(position, (8.0, 215.0));
    }
}

#[tauri::command]
fn hide_emoji_picker_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("emojiPicker") {
        window.hide().map_err(|err| err.to_string())?;
    }
    if let Some(tab_editor_window) = app.get_webview_window("tabEditor") {
        let _ = tab_editor_window.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn hide_tab_editor_window(window: tauri::WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    if let Some(emoji_picker_window) = app.get_webview_window("emojiPicker") {
        let _ = emoji_picker_window.hide();
    }
    window.hide().map_err(|err| err.to_string())?;
    if let Some(clipboard_window) = app.get_webview_window("clipboard") {
        focus_clipboard_window(&clipboard_window, "tab editor closed");
    }
    Ok(())
}

#[tauri::command]
fn apply_custom_tabs_from_editor(
    app: tauri::AppHandle,
    payload: serde_json::Value,
) -> Result<(), String> {
    app.emit_to("clipboard", "custom-tabs-changed", payload)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "windows")]
fn shell_compatible_windows_path(path: &str) -> String {
    if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else if let Some(path) = path.strip_prefix(r"\\?\") {
        path.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(target_os = "windows")]
unsafe fn create_shell_file_data_object(
    paths: &[String],
) -> Result<windows::Win32::System::Com::IDataObject, String> {
    use windows::Win32::System::Com::IBindCtx;
    use windows::Win32::UI::Shell::BHID_DataObject;

    let items = create_shell_file_item_array(paths)?;
    items
        .BindToHandler(None::<&IBindCtx>, &BHID_DataObject)
        .map_err(|err| format!("create Shell file data object failed: {err}"))
}

#[cfg(target_os = "windows")]
unsafe fn create_shell_file_item_array(
    paths: &[String],
) -> Result<windows::Win32::UI::Shell::IShellItemArray, String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists};

    if paths.is_empty() {
        return Err("native drag requires at least one file".to_string());
    }

    let mut pidls = Vec::with_capacity(paths.len());
    for path in paths {
        let path = HSTRING::from(path);
        let pidl = ILCreateFromPathW(&path);
        if pidl.is_null() {
            for pidl in pidls {
                ILFree(Some(pidl));
            }
            return Err("create Shell drag item failed".to_string());
        }
        pidls.push(pidl);
    }

    let pidl_refs = pidls
        .iter()
        .map(|pidl| *pidl as *const _)
        .collect::<Vec<_>>();
    let result = SHCreateShellItemArrayFromIDLists(&pidl_refs)
        .map_err(|err| format!("create Shell drag item array failed: {err}"));

    for pidl in pidls {
        ILFree(Some(pidl));
    }
    result
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn materialize_native_drag_image(path: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let source_bytes = history_store::read_file(path)?;
    let is_gif = image_mime_from_bytes(&source_bytes) == "image/gif";
    let (extension, drag_bytes) = if is_gif {
        ("gif", source_bytes)
    } else {
        let png_bytes = png_clipboard_bytes_from_image_bytes(source_bytes)
            .ok_or_else(|| "convert dragged image to PNG failed".to_string())?;
        ("png", png_bytes)
    };

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(&drag_bytes);
    let cache_path = PathBuf::from(app_runtime_dir(&["image_clipboard_cache"])).join(format!(
        "{}.{}",
        hex::encode(hasher.finalize()),
        extension
    ));
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    if !cache_path.exists() {
        fs::write(&cache_path, drag_bytes)
            .map_err(|err| format!("write native drag image failed: {err}"))?;
    }
    Ok(cache_path.to_string_lossy().to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod native_file_drag_tests {
    use super::{
        create_shell_file_data_object, create_shell_file_item_array, shell_compatible_windows_path,
    };

    #[test]
    fn removes_the_verbatim_prefix_from_local_paths_for_the_shell() {
        assert_eq!(
            shell_compatible_windows_path(r"\\?\D:\Clipboard\photo.png"),
            r"D:\Clipboard\photo.png"
        );
    }

    #[test]
    fn converts_verbatim_unc_paths_to_regular_unc_paths_for_the_shell() {
        assert_eq!(
            shell_compatible_windows_path(r"\\?\UNC\server\share\file.txt"),
            r"\\server\share\file.txt"
        );
    }

    #[test]
    fn preserves_paths_that_are_already_shell_compatible() {
        assert_eq!(
            shell_compatible_windows_path(r"C:\Clipboard\file.txt"),
            r"C:\Clipboard\file.txt"
        );
    }

    #[test]
    fn shell_file_data_object_exposes_every_file_through_cf_hdrop() {
        use std::fs;
        use std::ptr;
        use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
        use windows::Win32::System::Ole::{OleInitialize, OleUninitialize, CF_HDROP};

        let first_path = std::env::temp_dir().join(format!(
            "vpaste-native-drag-test-{}-first.txt",
            std::process::id()
        ));
        let second_path = std::env::temp_dir().join(format!(
            "vpaste-native-drag-test-{}-second.txt",
            std::process::id()
        ));
        fs::write(&first_path, b"vPaste native drag test one")
            .expect("create first native drag test file");
        fs::write(&second_path, b"vPaste native drag test two")
            .expect("create second native drag test file");
        let paths = vec![
            first_path.to_string_lossy().to_string(),
            second_path.to_string_lossy().to_string(),
        ];

        unsafe {
            OleInitialize(None).expect("initialize OLE for native drag test");
            let item_array =
                create_shell_file_item_array(&paths).expect("create Shell file item array");
            assert_eq!(item_array.GetCount().expect("count Shell file items"), 2);
            let data_object =
                create_shell_file_data_object(&paths).expect("create Shell file data object");
            let format = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };

            assert!(data_object.QueryGetData(&format).is_ok());
            drop(data_object);
            drop(item_array);
            OleUninitialize();
        }

        fs::remove_file(first_path).expect("remove first native drag test file");
        fs::remove_file(second_path).expect("remove second native drag test file");
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn native_drag_file(paths: Vec<String>, is_image: bool) -> Result<bool, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Ole::{
        IDropSource, OleInitialize, OleUninitialize, DROPEFFECT_COPY, DROPEFFECT_NONE,
    };
    use windows::Win32::UI::Shell::SHDoDragDrop;

    if paths.is_empty() {
        return Err("native drag requires at least one file".to_string());
    }
    if is_image && paths.len() != 1 {
        return Err("image drag requires exactly one source file".to_string());
    }
    info!(
        "[native-file-drag] stage=command-received is_image={is_image} count={}",
        paths.len()
    );
    let mut paths = paths
        .into_iter()
        .map(|path| {
            let path = PathBuf::from(path).canonicalize().map_err(|err| {
                error!("[native-file-drag] stage=canonicalize-failed error={err}");
                format!("resolve drag file path failed: {err}")
            })?;
            let path = path
                .to_str()
                .ok_or_else(|| "drag file path is not valid unicode".to_string())?;
            Ok(shell_compatible_windows_path(path))
        })
        .collect::<Result<Vec<_>, String>>()?;
    info!(
        "[native-file-drag] stage=canonicalized count={}",
        paths.len()
    );
    if is_image {
        paths[0] = materialize_native_drag_image(&paths[0]).map_err(|err| {
            error!("[native-file-drag] stage=image-materialize-failed error={err}");
            err
        })?;
        info!("[native-file-drag] stage=image-materialized");
    }
    info!("[native-file-drag] stage=shell-path-ready");

    unsafe {
        OleInitialize(None).map_err(|err| {
            error!("[native-file-drag] stage=ole-initialize-failed error={err}");
            format!("initialize Windows OLE failed: {err}")
        })?;
        info!("[native-file-drag] stage=ole-initialized");
        let result = (|| {
            let data_object = create_shell_file_data_object(&paths).map_err(|err| {
                error!("[native-file-drag] stage=data-object-create-failed error={err}");
                err
            })?;
            info!("[native-file-drag] stage=data-object-created format=shell-item");
            info!("[native-file-drag] stage=shell-drag-starting");
            let effect = SHDoDragDrop(HWND(0), &data_object, None::<&IDropSource>, DROPEFFECT_COPY)
                .map_err(|err| {
                    error!("[native-file-drag] stage=shell-drag-failed error={err}");
                    format!("native drag failed: {err}")
                })?;
            info!(
                "[native-file-drag] stage=shell-drag-finished effect={}",
                effect.0
            );
            Ok(effect != DROPEFFECT_NONE)
        })();
        OleUninitialize();
        info!("[native-file-drag] stage=ole-uninitialized result={result:?}");
        result
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn native_drag_file(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    is_image: bool,
) -> Result<bool, String> {
    use drag::{DragItem, DragResult, Image, Options};

    if paths.is_empty() {
        return Err("native drag requires at least one file".to_string());
    }
    if is_image && paths.len() != 1 {
        return Err("image drag requires exactly one source file".to_string());
    }
    info!(
        "[native-file-drag] stage=command-received platform=macos is_image={is_image} count={}",
        paths.len()
    );
    let mut paths = paths
        .into_iter()
        .map(|path| {
            PathBuf::from(path)
                .canonicalize()
                .map_err(|err| format!("resolve drag file path failed: {err}"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if is_image {
        let path = paths[0]
            .to_str()
            .ok_or_else(|| "drag file path is not valid unicode".to_string())?;
        paths[0] = PathBuf::from(materialize_native_drag_image(path)?);
        info!("[native-file-drag] stage=image-materialized platform=macos");
    }

    let app = window.app_handle().clone();
    let (result_tx, mut result_rx) = tokio::sync::mpsc::unbounded_channel::<Result<bool, String>>();
    app.run_on_main_thread(move || {
        let drop_tx = result_tx.clone();
        let start_result = drag::start_drag(
            &window,
            DragItem::Files(paths),
            Image::Raw(include_bytes!("../icons/128x128.png").to_vec()),
            move |result, _cursor_position| {
                let dropped = matches!(result, DragResult::Dropped);
                let _ = drop_tx.send(Ok(dropped));
            },
            Options::default(),
        );
        if let Err(err) = start_result {
            let _ = result_tx.send(Err(format!("native macOS drag failed: {err}")));
        }
    })
    .map_err(|err| format!("schedule native macOS drag failed: {err}"))?;

    let result = result_rx
        .recv()
        .await
        .ok_or_else(|| "native macOS drag ended without a result".to_string())?;
    info!("[native-file-drag] stage=drag-finished platform=macos result={result:?}");
    result
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
fn native_drag_file(_paths: Vec<String>, _is_image: bool) -> Result<(), String> {
    Err("native file drag is only implemented on Windows and macOS".to_string())
}

fn parse_file_clipboard_content(content: &str) -> Result<Vec<String>, String> {
    serde_json::from_str::<Vec<String>>(content)
        .map_err(|err| format!("parse file clipboard content failed: {}", err))
}

fn file_extension(path: &str) -> String {
    PathBuf::from(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_uppercase())
        .unwrap_or_else(|| "FILE".to_string())
}

fn is_plain_text_preview_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "txt"
            | "md"
            | "markdown"
            | "json"
            | "jsonl"
            | "log"
            | "csv"
            | "tsv"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "rs"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "css"
            | "scss"
            | "html"
            | "htm"
            | "py"
            | "java"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "cs"
            | "go"
            | "sql"
            | "sh"
            | "bat"
            | "ps1"
    )
}

fn is_image_preview_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tif" | "tiff" | "svg"
    )
}

#[tauri::command]
fn read_preview_text_file(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|err| format!("读取文件信息失败：{}", err))?;
    if metadata.len() > 1024 * 1024 {
        return Err("文本文件超过 1 MB，暂不预览".to_string());
    }
    history_store::read_file(&path)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|err| err.to_string()))
        .map_err(|err| format!("读取文本失败：{}", err))
}

#[tauri::command]
fn validate_file_item(content: String) -> Result<Vec<String>, String> {
    let paths = parse_file_clipboard_content(&content)?;
    Ok(paths
        .into_iter()
        .filter(|path| !PathBuf::from(path).exists())
        .collect())
}

fn containing_folder_from_file_content(content: &str) -> Result<PathBuf, String> {
    let paths = parse_file_clipboard_content(content)?;
    let first_path = paths.first().ok_or_else(|| "文件路径为空".to_string())?;
    let path = PathBuf::from(first_path);
    path.parent()
        .map(|parent| parent.to_path_buf())
        .ok_or_else(|| "无法解析所在路径".to_string())
}

#[tauri::command]
fn containing_folder_path(content: String) -> Result<String, String> {
    Ok(containing_folder_from_file_content(&content)?
        .to_string_lossy()
        .to_string())
}

#[cfg(target_os = "windows")]
fn open_folder_with_default_handler(folder: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let folder = folder
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            None,
            None,
            PCWSTR(folder.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    let result_code = result.0 as isize;
    if result_code > 32 {
        Ok(())
    } else {
        Err(format!("系统文件夹处理器返回错误码：{}", result_code))
    }
}

#[tauri::command]
fn open_containing_folder(content: String) -> Result<(), String> {
    let folder = containing_folder_from_file_content(&content)?;
    if !folder.exists() {
        return Err(format!("所在路径不存在：{}", folder.to_string_lossy()));
    }

    #[cfg(target_os = "windows")]
    {
        open_folder_with_default_handler(&folder)
            .map_err(|err| format!("打开所在路径失败：{}", err))
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        command.arg(&folder);
        command
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("打开所在路径失败：{}", err))
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(&folder);
        command
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("打开所在路径失败：{}", err))
    }
}

#[tauri::command]
fn reveal_file_in_folder(path: String) -> Result<(), String> {
    let file_path = PathBuf::from(path);
    if !file_path.exists() {
        return Err(format!("文件不存在：{}", file_path.to_string_lossy()));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(format!("/select,{}", file_path.to_string_lossy()));
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(&file_path);
        command
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let folder = file_path
            .parent()
            .ok_or_else(|| "无法解析所在路径".to_string())?;
        let mut command = std::process::Command::new("xdg-open");
        command.arg(folder);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("定位导出文件失败：{}", err))
}

#[tauri::command]
fn open_url_in_browser(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|err| err.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持打开 http/https 链接".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(parsed.as_str());
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(parsed.as_str());
        command
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(parsed.as_str());
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("打开链接失败：{}", err))
}

#[cfg(target_os = "macos")]
fn is_process_trusted_with_prompt(prompt: bool) -> bool {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    type CFDictionaryRef = *const std::ffi::c_void;
    type Boolean = u8;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> Boolean;
    }

    unsafe {
        let options: id = msg_send![class!(NSMutableDictionary), dictionary];
        if options != nil {
            let key = NSString::alloc(nil).init_str("AXTrustedCheckOptionPrompt");
            let value: id = if prompt {
                msg_send![class!(NSNumber), numberWithBool: true]
            } else {
                msg_send![class!(NSNumber), numberWithBool: false]
            };
            let _: () = msg_send![options, setObject: value forKey: key];
        }

        AXIsProcessTrustedWithOptions(options as CFDictionaryRef) != 0
    }
}

#[cfg(not(target_os = "macos"))]
fn is_process_trusted_with_prompt(_prompt: bool) -> bool {
    true
}

fn lower_onboarding_permission_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("onboardingPermission") {
        let _ = window.set_always_on_top(false);
        #[cfg(target_os = "macos")]
        set_macos_window_level(&window, 0);
    }
}

#[tauri::command]
fn ensure_paste_accessibility_permission(
    _app: tauri::AppHandle,
) -> PasteAccessibilityPermissionStatus {
    let granted = is_process_trusted_with_prompt(true);
    PasteAccessibilityPermissionStatus {
        granted,
        needs_settings: !granted,
    }
}

#[tauri::command]
fn check_paste_accessibility_permission() -> PasteAccessibilityPermissionStatus {
    let granted = is_process_trusted_with_prompt(false);
    PasteAccessibilityPermissionStatus {
        granted,
        needs_settings: !granted,
    }
}

#[tauri::command]
fn get_onboarding_permission_status() -> OnboardingPermissionStatus {
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    let background = match macos_background_agent_status() {
        Some(status) => OnboardingPermissionItemStatus {
            done: status == MacosServiceStatus::Enabled,
            needs_settings: status == MacosServiceStatus::RequiresApproval,
            error: None,
        },
        None => OnboardingPermissionItemStatus {
            done: false,
            needs_settings: false,
            error: Some("macOS background service is unavailable".to_string()),
        },
    };
    #[cfg(all(target_os = "macos", debug_assertions))]
    let background = OnboardingPermissionItemStatus {
        done: DEBUG_BACKGROUND_AGENT_ENABLED.load(Ordering::SeqCst),
        needs_settings: !DEBUG_BACKGROUND_AGENT_ENABLED.load(Ordering::SeqCst),
        error: None,
    };
    #[cfg(not(target_os = "macos"))]
    let background = OnboardingPermissionItemStatus {
        done: true,
        needs_settings: false,
        error: None,
    };
    let paste_done = is_process_trusted_with_prompt(false);

    OnboardingPermissionStatus {
        background,
        paste: OnboardingPermissionItemStatus {
            done: paste_done,
            needs_settings: !paste_done,
            error: None,
        },
    }
}

#[tauri::command]
fn enable_onboarding_background_service(
    app: tauri::AppHandle,
) -> Result<OnboardingPermissionItemStatus, String> {
    #[cfg(target_os = "macos")]
    {
        #[cfg(debug_assertions)]
        {
            DEBUG_BACKGROUND_AGENT_ENABLED.store(true, Ordering::SeqCst);
            let _ = app.emit("onboarding-permission-status-changed", "background");
            lower_onboarding_permission_window(&app);
            open_login_items_settings()?;
            return Ok(OnboardingPermissionItemStatus {
                done: true,
                needs_settings: false,
                error: None,
            });
        }

        #[cfg(not(debug_assertions))]
        {
            let enabled = sync_macos_background_agent(true)
                .ok_or_else(|| "macOS background service is unavailable".to_string())??;
            let status = macos_background_agent_status().unwrap_or(MacosServiceStatus::NotFound);
            let needs_settings = status == MacosServiceStatus::RequiresApproval;
            let _ = app.emit("onboarding-permission-status-changed", "background");

            lower_onboarding_permission_window(&app);
            open_login_items_settings()?;

            Ok(OnboardingPermissionItemStatus {
                done: enabled,
                needs_settings,
                error: None,
            })
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("background service permission is only available on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
fn open_macos_settings_candidates(candidates: &[&str]) -> Result<(), String> {
    for candidate in candidates {
        let status = std::process::Command::new("open")
            .arg(candidate)
            .status()
            .map_err(|err| format!("打开系统设置失败：{}", err))?;
        if status.success() {
            return Ok(());
        }
    }

    let fallback = std::process::Command::new("open")
        .arg("-b")
        .arg("com.apple.systempreferences")
        .status()
        .map_err(|err| format!("打开系统设置失败：{}", err))?;
    if fallback.success() {
        Ok(())
    } else {
        Err("无法打开系统设置".to_string())
    }
}

#[cfg(target_os = "macos")]
fn open_login_items_settings() -> Result<(), String> {
    if let Some(service_class) = objc::runtime::Class::get("SMAppService") {
        unsafe {
            use objc::{msg_send, sel, sel_impl};
            let _: () = msg_send![service_class, openSystemSettingsLoginItems];
        }
        return Ok(());
    }
    open_macos_settings_candidates(&[
        "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        "x-apple.systempreferences:com.apple.preference.users?LoginItems",
        "x-apple.systempreferences:com.apple.preference.users",
    ])
}

#[tauri::command]
fn open_accessibility_settings(app: tauri::AppHandle) -> Result<(), String> {
    lower_onboarding_permission_window(&app);
    #[cfg(target_os = "macos")]
    {
        open_macos_settings_candidates(&[
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            "x-apple.systempreferences:com.apple.Settings.PrivacySecurity.extension?Privacy_Accessibility",
            "x-apple.systempreferences:com.apple.preference.security",
        ])
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
fn get_app_version() -> AppVersionInfo {
    AppVersionInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
fn set_item_favorite(hash: String, favorite: bool) -> Result<(), String> {
    ensure_history_ready()?;
    let affected = clipboard::set_favorite(&hash, favorite).map_err(|err| err.to_string())?;
    if affected == 0 {
        Err("粘贴项不存在".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn list_item_tags() -> Result<Vec<clipboard::item::ItemTag>, String> {
    clipboard::list_tags()
}

#[tauri::command]
fn create_item_tag(name: String) -> Result<clipboard::item::ItemTag, String> {
    clipboard::create_tag(&name)
}

#[tauri::command]
fn rename_item_tag(id: i64, name: String) -> Result<clipboard::item::ItemTag, String> {
    clipboard::rename_tag(id, &name)
}

#[tauri::command]
fn delete_item_tag(id: i64) -> Result<(), String> {
    let affected = clipboard::delete_tag(id)?;
    if affected == 0 {
        Err("标签不存在".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn assign_item_tag(hash: String, tag_id: i64) -> Result<(), String> {
    ensure_history_ready()?;
    clipboard::assign_tag(&hash, tag_id)
}

#[tauri::command]
fn remove_item_tag(hash: String, tag_id: i64) -> Result<(), String> {
    ensure_history_ready()?;
    clipboard::remove_tag(&hash, tag_id)
}

#[tauri::command]
fn list_recent_app_sources(days: u64) -> Result<Vec<String>, String> {
    ensure_history_ready()?;
    clipboard::recent_app_sources(days)
}

#[tauri::command]
fn list_recent_app_source_options(days: u64) -> Result<Vec<clipboard::AppSourceOption>, String> {
    ensure_history_ready()?;
    clipboard::recent_app_source_options(days)
}

#[tauri::command]
async fn refresh_link_previews(
    urls: Vec<String>,
) -> Result<Vec<clipboard::LinkPreviewUpdate>, String> {
    ensure_history_ready()?;
    tauri::async_runtime::spawn_blocking(move || clipboard::refresh_link_previews(urls))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
fn delete_clipboard_item(app: tauri::AppHandle, hash: String) -> Result<(), String> {
    ensure_history_ready()?;
    let affected = clipboard::delete_by_hash(&hash)?;
    if affected == 0 {
        Err("粘贴项不存在".to_string())
    } else {
        paste_queue::emit_state(&app);
        Ok(())
    }
}

#[tauri::command]
fn plain_text_content(hash: String) -> Result<String, String> {
    clipboard::plain_text_content(&hash)
}

#[tauri::command]
fn color_conversion_options(content: String) -> Vec<clipboard::color::ColorVariant> {
    clipboard::color::color_variants(&content)
}

#[tauri::command]
fn export_image_item(source_path: String, target_path: String) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    let target = PathBuf::from(target_path);
    if !source.exists() {
        return Err("图片缓存不存在或已被清理".to_string());
    }
    let image = if file_extension(&source.to_string_lossy()) == "SVG" {
        rasterize_svg_for_export(&source)?
    } else {
        image_reader_secure(&source)?
    };
    let format = image::ImageFormat::from_path(&target).map_err(|err| err.to_string())?;
    let mut encoded = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, format)
        .map_err(|err| err.to_string())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&target, encoded.into_inner()).map_err(|err| err.to_string())
}

fn rasterize_svg_for_export(source: &Path) -> Result<image::DynamicImage, String> {
    if fs::metadata(source).map_err(|err| err.to_string())?.len()
        > image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES
    {
        return Err("SVG source exceeds the 32 MiB export limit".to_string());
    }
    let mut options = resvg::usvg::Options {
        resources_dir: source.parent().map(Path::to_path_buf),
        ..Default::default()
    };
    options.fontdb_mut().load_system_fonts();
    let bytes = history_store::read_file(source)?;
    let tree = resvg::usvg::Tree::from_data(&bytes, &options).map_err(|err| err.to_string())?;
    let size = tree.size().to_int_size();
    if size.width() > 16_384
        || size.height() > 16_384
        || u64::from(size.width()) * u64::from(size.height())
            > image_preview::CARD_PREVIEW_MAX_PIXELS
    {
        return Err("SVG dimensions exceed the export pixel limit".to_string());
    }
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())
        .ok_or_else(|| "Cannot allocate SVG export image".to_string())?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );
    // tiny-skia pixels are premultiplied; image encoders expect straight alpha.
    let pixels = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    let rgba = image::RgbaImage::from_raw(size.width(), size.height(), pixels)
        .ok_or_else(|| "Invalid SVG export pixel buffer".to_string())?;
    Ok(image::DynamicImage::ImageRgba8(rgba))
}

#[tauri::command]
async fn file_preview_info(content: String) -> Result<FilePreviewInfo, String> {
    tauri::async_runtime::spawn_blocking(move || build_file_preview_info(content))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod image_export_tests {
    use super::*;

    #[test]
    fn svg_text_is_rendered() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("text.svg");
        let target = root.path().join("text.png");
        fs::write(&source, r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="4" y="30" font-size="24" font-family="Arial">Test</text></svg>"#).unwrap();
        export_image_item(
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
        )
        .unwrap();
        let decoded = image::open(target).unwrap().to_rgba8();
        assert!(decoded.pixels().filter(|pixel| pixel.0[3] > 0).count() > 30);
    }

    #[test]
    fn oversized_source_and_invalid_target_format_preserve_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("large.svg");
        fs::File::create(&source)
            .unwrap()
            .set_len(image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES + 1)
            .unwrap();
        let target = root.path().join("output.png");
        fs::write(&target, b"existing output").unwrap();
        assert!(export_image_item(
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned()
        )
        .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"existing output");

        let source = root.path().join("source.png");
        image::RgbaImage::new(2, 2).save(&source).unwrap();
        let target = root.path().join("output.unknown");
        fs::write(&target, b"existing output").unwrap();
        assert!(export_image_item(
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned()
        )
        .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"existing output");
    }

    #[test]
    fn svg_exports_are_real_raster_images() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("drawing.svg");
        fs::write(&source, br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#ff0000"/></svg>"##).unwrap();
        for (ext, format) in [
            ("png", image::ImageFormat::Png),
            ("jpg", image::ImageFormat::Jpeg),
            ("webp", image::ImageFormat::WebP),
            ("bmp", image::ImageFormat::Bmp),
        ] {
            let target = root.path().join(format!("output.{ext}"));
            export_image_item(
                source.to_string_lossy().into_owned(),
                target.to_string_lossy().into_owned(),
            )
            .unwrap();
            let bytes = fs::read(target).unwrap();
            assert_eq!(image::guess_format(&bytes).unwrap(), format);
            let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert_eq!(decoded.dimensions(), (16, 16));
            let pixel = decoded.get_pixel(8, 8).0;
            assert!(pixel[0] >= 250 && pixel[1] <= 5 && pixel[2] <= 5);
        }
    }

    #[test]
    fn invalid_or_oversized_svg_preserves_existing_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("drawing.svg");
        let target = root.path().join("output.png");
        for svg in [
            "not an image",
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"/>"#,
        ] {
            fs::write(&source, svg).unwrap();
            fs::write(&target, b"existing output").unwrap();
            assert!(export_image_item(
                source.to_string_lossy().into_owned(),
                target.to_string_lossy().into_owned()
            )
            .is_err());
            assert_eq!(fs::read(&target).unwrap(), b"existing output");
        }
    }

    #[test]
    fn svg_png_export_preserves_straight_alpha() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("alpha.svg");
        let target = root.path().join("output.png");
        fs::write(&source, br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="8" height="16" fill="#ff0000" opacity="0.5"/></svg>"##).unwrap();
        export_image_item(
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
        )
        .unwrap();
        let decoded = image::open(target).unwrap().to_rgba8();
        let pixel = decoded.get_pixel(4, 8).0;
        assert_eq!(pixel[0], 255);
        assert!((127..=128).contains(&pixel[3]));
        assert_eq!(decoded.get_pixel(12, 8).0[3], 0);
    }

    #[test]
    fn ordinary_raster_export_still_converts_formats() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.png");
        image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 0, 0, 255]))
            .save(&source)
            .unwrap();
        for ext in ["png", "jpg", "webp", "bmp"] {
            let target = root.path().join(format!("output.{ext}"));
            export_image_item(
                source.to_string_lossy().into_owned(),
                target.to_string_lossy().into_owned(),
            )
            .unwrap();
            assert_eq!(image::open(target).unwrap().width(), 16);
        }
    }
}

fn build_file_preview_info(content: String) -> Result<FilePreviewInfo, String> {
    let paths = parse_file_clipboard_content(&content)?;
    let missing_paths: Vec<String> = paths
        .iter()
        .filter(|path| !PathBuf::from(path).exists())
        .cloned()
        .collect();
    let exists = missing_paths.is_empty();
    let display_path = paths.first().cloned().unwrap_or_default();

    if paths.len() > 1 {
        let contains_directories = paths.iter().any(|path| PathBuf::from(path).is_dir());
        return Ok(FilePreviewInfo {
            kind: "multiple".to_string(),
            paths,
            exists,
            missing_paths,
            display_path,
            secondary_text: String::new(),
            extension: String::new(),
            preview_path: String::new(),
            contains_directories,
            image_width: None,
            image_height: None,
        });
    }

    let extension = display_path
        .is_empty()
        .then(String::new)
        .unwrap_or_else(|| file_extension(&display_path));
    let is_directory = PathBuf::from(&display_path).is_dir();
    let lower_extension = extension.to_ascii_lowercase();
    let is_pdf = lower_extension == "pdf";
    let is_text_preview = is_plain_text_preview_extension(&extension);
    let is_image_preview = is_image_preview_extension(&extension);
    let preview_path =
        if exists && !display_path.is_empty() && !is_directory && !is_pdf && !is_text_preview {
            if is_image_preview {
                display_path.clone()
            } else {
                create_file_thumbnail(&display_path).unwrap_or_default()
            }
        } else {
            String::new()
        };
    let image_dimensions = if !preview_path.is_empty() {
        image::image_dimensions(&display_path)
            .map_err(|err| err.to_string())
            .ok()
            .or_else(|| image_dimensions_secure(&preview_path).ok())
    } else {
        None
    };
    let kind = if is_directory {
        "single-folder"
    } else if is_pdf {
        "pdf-preview"
    } else if is_text_preview {
        "text-preview"
    } else if preview_path.is_empty() {
        "single-icon"
    } else {
        "single-preview"
    };

    Ok(FilePreviewInfo {
        kind: kind.to_string(),
        paths,
        exists,
        missing_paths,
        display_path,
        secondary_text: String::new(),
        extension,
        preview_path,
        contains_directories: is_directory,
        image_width: image_dimensions.map(|(width, _)| width),
        image_height: image_dimensions.map(|(_, height)| height),
    })
}

#[cfg(target_os = "windows")]
fn create_file_thumbnail(path: &str) -> Result<String, String> {
    use image::{ImageBuffer, Rgba};
    use sha2::{Digest, Sha256};
    use std::mem::{size_of, zeroed};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{HWND, SIZE};
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_SCALEUP,
        SIIGBF_THUMBNAILONLY,
    };

    let metadata = fs::metadata(path).map_err(|err| err.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(modified.to_string().as_bytes());
    let hash = hex::encode(hasher.finalize());

    let preview_dir = PathBuf::from(app_runtime_dir(&["file_previews"]));
    fs::create_dir_all(&preview_dir).map_err(|err| err.to_string())?;
    let preview_path = preview_dir.join(format!("{}.png", hash));
    if preview_path.exists() {
        return Ok(preview_path.to_string_lossy().to_string());
    }

    unsafe {
        let coinited =
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();

        let result = (|| {
            let shell_item: IShellItemImageFactory =
                SHCreateItemFromParsingName(&HSTRING::from(path), None::<&IBindCtx>)
                    .map_err(|err| err.to_string())?;
            let bitmap = shell_item
                .GetImage(
                    SIZE { cx: 420, cy: 300 },
                    SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK | SIIGBF_SCALEUP,
                )
                .map_err(|err| err.to_string())?;

            let mut bitmap_info: BITMAP = zeroed();
            let object_size = GetObjectW(
                bitmap,
                size_of::<BITMAP>() as i32,
                Some(&mut bitmap_info as *mut _ as *mut _),
            );
            if object_size == 0 || bitmap_info.bmWidth <= 0 || bitmap_info.bmHeight <= 0 {
                let _ = DeleteObject(bitmap);
                return Err("read thumbnail bitmap metadata failed".to_string());
            }

            let width = bitmap_info.bmWidth as u32;
            let height = bitmap_info.bmHeight as u32;
            let mut bits = vec![0_u8; (width * height * 4) as usize];
            let mut dib_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: (width * height * 4) as u32,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: Default::default(),
            };

            let hdc = GetDC(HWND(0));
            let lines = GetDIBits(
                hdc,
                bitmap,
                0,
                height,
                Some(bits.as_mut_ptr() as *mut _),
                &mut dib_info,
                DIB_RGB_COLORS,
            );
            let _ = ReleaseDC(HWND(0), hdc);
            let _ = DeleteObject(bitmap);
            if lines == 0 {
                return Err("read thumbnail bitmap pixels failed".to_string());
            }

            for pixel in bits.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }

            let image: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_vec(width, height, bits)
                .ok_or_else(|| "create thumbnail image buffer failed".to_string())?;
            let mut png_bytes = Vec::new();
            image
                .write_to(
                    &mut std::io::Cursor::new(&mut png_bytes),
                    image::ImageFormat::Png,
                )
                .map_err(|err| err.to_string())?;
            history_store::write_file(&preview_path, &png_bytes)?;
            Ok(preview_path.to_string_lossy().to_string())
        })();

        if coinited {
            CoUninitialize();
        }

        result
    }
}

#[cfg(not(target_os = "windows"))]
fn create_file_thumbnail(_path: &str) -> Result<String, String> {
    Ok(String::new())
}

fn toggle_clipboard_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("clipboard") {
        match window.is_visible() {
            Ok(true) => {
                let allow_onboarding_shortcut_demo =
                    ONBOARDING_SHORTCUT_DEMO_ENABLED.load(Ordering::SeqCst);
                hide_clipboard_window_with_onboarding_policy(
                    &window,
                    allow_onboarding_shortcut_demo,
                );
            }
            Ok(false) => {
                show_clipboard_window(&window);
            }
            Err(err) => error!("Failed to check window visibility: {:?}", err),
        }
    } else {
        error!("Clipboard window handle not found when toggling shortcut");
    }
}
fn splicing_with_app_data_dir(path: &[&str]) -> String {
    return get_app_data_dir()
        + std::path::MAIN_SEPARATOR.to_string().as_str()
        + path
            .join(std::path::MAIN_SEPARATOR.to_string().as_str())
            .as_str();
}

pub fn app_runtime_dir(path: &[&str]) -> String {
    splicing_with_app_data_dir(path)
}

pub fn history_storage_dir() -> String {
    let configured = config::get().storage_dir.trim().to_string();
    if configured.is_empty() {
        get_app_data_dir()
    } else {
        configured
    }
}

fn splicing_with_history_storage_dir(path: &[&str]) -> String {
    history_storage_dir()
        + std::path::MAIN_SEPARATOR.to_string().as_str()
        + path
            .join(std::path::MAIN_SEPARATOR.to_string().as_str())
            .as_str()
}

fn custom_tabs_path() -> PathBuf {
    PathBuf::from(history_storage_dir()).join(CUSTOM_TABS_FILE)
}

fn ensure_history_storage_dirs() -> Result<(), String> {
    ensure_history_storage_dirs_at(&history_storage_dir())
}

fn ensure_history_storage_dirs_at(root: &str) -> Result<(), String> {
    for path in [
        PathBuf::from(root),
        PathBuf::from(root).join("data"),
        PathBuf::from(root).join("rich_formats"),
    ] {
        fs::create_dir_all(&path)
            .map_err(|err| format!("create storage path failed: {}: {err}", path.display()))?;
    }
    ensure_runtime_storage_dirs()?;
    Ok(())
}

fn ensure_runtime_storage_dirs() -> Result<(), String> {
    for path in [
        PathBuf::from(app_runtime_dir(&["logs"])),
        PathBuf::from(app_runtime_dir(&["file_previews"])),
        PathBuf::from(app_runtime_dir(&["image_clipboard_cache"])),
        PathBuf::from(app_runtime_dir(&["app_icons"])),
        PathBuf::from(app_runtime_dir(&["lang"])),
        PathBuf::from(app_runtime_dir(&["search"])),
    ] {
        fs::create_dir_all(&path)
            .map_err(|err| format!("create runtime path failed: {}: {err}", path.display()))?;
    }
    Ok(())
}

fn migrate_runtime_dir_out_of_history(name: &str, remove_after_copy: bool) {
    let source = PathBuf::from(history_storage_dir()).join(name);
    let target = PathBuf::from(app_runtime_dir(&[name]));
    if let Err(err) = migrate_runtime_dir(&source, &target, remove_after_copy) {
        error!("migrate runtime dir {} failed: {}", name, err);
    }
}

fn migrate_runtime_dir(
    source: &Path,
    target: &Path,
    remove_after_copy: bool,
) -> Result<(), String> {
    if !source.exists() || paths_resolve_to_same_location(source, target) {
        return Ok(());
    }
    copy_dir_contents_recursive(source, target)?;
    if remove_after_copy {
        fs::remove_dir_all(source).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn paths_resolve_to_same_location(source: &Path, target: &Path) -> bool {
    if source == target {
        return true;
    }
    let Ok(source) = fs::canonicalize(source) else {
        return false;
    };
    let Ok(target) = fs::canonicalize(target) else {
        return false;
    };
    source == target
}

#[cfg(test)]
mod runtime_dir_migration_tests {
    use super::*;

    #[test]
    fn same_runtime_directory_is_not_removed() {
        let root = tempfile::tempdir().unwrap();
        let runtime_dir = root.path().join("app_icons");
        fs::create_dir_all(&runtime_dir).unwrap();
        let icon = runtime_dir.join("source.png");
        fs::write(&icon, b"icon").unwrap();

        migrate_runtime_dir(&runtime_dir, &runtime_dir, true).unwrap();

        assert!(icon.exists());
    }

    #[test]
    fn separate_history_directory_is_copied_then_removed() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("history").join("app_icons");
        let target = root.path().join("runtime").join("app_icons");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("source.png"), b"icon").unwrap();

        migrate_runtime_dir(&source, &target, true).unwrap();

        assert_eq!(fs::read(target.join("source.png")).unwrap(), b"icon");
        assert!(!source.exists());
    }
}

fn migrate_runtime_dirs_out_of_history() {
    migrate_runtime_dir_out_of_history("lang", true);
    migrate_runtime_dir_out_of_history("logs", true);
    migrate_runtime_dir_out_of_history("app_icons", true);
    for cache in ["search", "file_previews", "image_clipboard_cache"] {
        let path = PathBuf::from(history_storage_dir()).join(cache);
        let runtime_path = PathBuf::from(app_runtime_dir(&[cache]));
        if paths_resolve_to_same_location(&path, &runtime_path) {
            continue;
        }
        if path.exists() {
            let _ = fs::remove_dir_all(path);
        }
    }
    for cache in ["search", "file_previews", "image_clipboard_cache"] {
        let runtime_cache = PathBuf::from(app_runtime_dir(&[cache]));
        let _ = fs::create_dir_all(runtime_cache);
    }
}

fn cleanup_runtime_cache_dir(name: &str, max_age_days: u64) {
    let dir = PathBuf::from(app_runtime_dir(&[name]));
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let cutoff = now_millis().saturating_sub(max_age_days.saturating_mul(DAY_MILLIS));
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        if modified >= cutoff {
            continue;
        }
        if metadata.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else if metadata.is_file() {
            let _ = fs::remove_file(path);
        }
    }
}

fn collect_cache_files(dir: &Path, files: &mut Vec<(PathBuf, u64, u64)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_cache_files(&path, files);
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        files.push((path, metadata.len(), modified));
    }
}

fn cleanup_runtime_cache_dir_by_size(name: &str, max_bytes: u64) {
    let dir = PathBuf::from(app_runtime_dir(&[name]));
    let mut files = Vec::new();
    collect_cache_files(&dir, &mut files);
    let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
    if total <= max_bytes {
        return;
    }

    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn cleanup_runtime_caches() {
    cleanup_runtime_cache_dir("file_previews", 14);
    cleanup_runtime_cache_dir("image_clipboard_cache", 90);
    cleanup_runtime_cache_dir("image_preview_cache", 90);
    cleanup_runtime_cache_dir_by_size("image_clipboard_cache", IMAGE_CLIPBOARD_CACHE_MAX_BYTES);
    cleanup_runtime_cache_dir_by_size("image_preview_cache", IMAGE_PREVIEW_CACHE_MAX_BYTES);
    cleanup_runtime_cache_dir("logs", 14);
}

#[tauri::command]
fn list_language_packs() -> Result<Vec<LanguagePackFile>, String> {
    let lang_dir = PathBuf::from(app_runtime_dir(&["lang"]));
    fs::create_dir_all(&lang_dir).map_err(|err| err.to_string())?;
    let mut packs = Vec::new();

    for entry in fs::read_dir(&lang_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(err) => {
                error!(
                    "read language file failed: {}: {}",
                    path.to_string_lossy(),
                    err
                );
                continue;
            }
        };
        let value: serde_json::Value = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(err) => {
                error!(
                    "parse language file failed: {}: {}",
                    path.to_string_lossy(),
                    err
                );
                continue;
            }
        };
        let Some(code) = value.get("code").and_then(|value| value.as_str()) else {
            continue;
        };
        let name = value
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or(code)
            .to_string();
        let native_name = value
            .get("nativeName")
            .or_else(|| value.get("native_name"))
            .and_then(|value| value.as_str())
            .unwrap_or(name.as_str())
            .to_string();
        let translations = value
            .get("translations")
            .cloned()
            .filter(|value| value.is_object())
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));

        packs.push(LanguagePackFile {
            code: code.to_string(),
            name,
            native_name,
            translations,
        });
    }

    Ok(packs)
}

#[tauri::command]
fn get_custom_tabs() -> Result<serde_json::Value, String> {
    ensure_history_ready()?;
    ensure_history_storage_dirs()?;
    let path = custom_tabs_path();
    if !path.exists() {
        return Ok(serde_json::Value::Array(Vec::new()));
    }
    let content = history_store::read_file(&path)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|err| err.to_string()))
        .map_err(|err| err.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&content).map_err(|err| err.to_string())?;
    Ok(if value.is_array() {
        value
    } else {
        serde_json::Value::Array(Vec::new())
    })
}

#[tauri::command]
fn save_custom_tabs(tabs: serde_json::Value) -> Result<(), String> {
    ensure_history_ready()?;
    ensure_history_storage_dirs()?;
    let path = custom_tabs_path();
    let value = if tabs.is_array() {
        tabs
    } else {
        serde_json::Value::Array(Vec::new())
    };
    let content = serde_json::to_string_pretty(&value).map_err(|err| err.to_string())?;
    history_store::write_file(path, content.as_bytes())
}

fn copy_dir_contents_recursive(source: &Path, target: &Path) -> Result<usize, String> {
    if !source.exists() {
        return Ok(0);
    }
    fs::create_dir_all(target).map_err(|err| err.to_string())?;
    let mut copied = 0_usize;
    for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copied += copy_dir_contents_recursive(&source_path, &target_path)?;
        } else if source_path.is_file() && !target_path.exists() {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            fs::copy(&source_path, &target_path).map_err(|err| err.to_string())?;
            copied += 1;
        }
    }
    Ok(copied)
}

#[cfg(test)]
fn copy_history_file(source: &Path, target: &Path, overwrite: bool) -> Result<bool, String> {
    copy_history_file_with_progress(source, target, overwrite, None)
}

fn copy_history_file_with_progress(
    source: &Path,
    target: &Path,
    overwrite: bool,
    mut progress: Option<&mut HistoryArchiveProgressState>,
) -> Result<bool, String> {
    if !source.is_file() || (!overwrite && target.exists()) {
        if source.is_file() {
            if let (Some(progress), Ok(metadata)) = (progress.as_deref_mut(), fs::metadata(source))
            {
                progress.add_file(metadata.len());
            }
        }
        return Ok(false);
    }
    let source_bytes = fs::metadata(source).map_err(|err| err.to_string())?.len();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let bytes = history_store::read_file(source)?;
    history_store::write_file(target, &bytes)?;
    if let Some(progress) = progress {
        progress.add_file(source_bytes);
    }
    Ok(true)
}

#[cfg(test)]
fn copy_history_dir_contents_recursive(source: &Path, target: &Path) -> Result<usize, String> {
    copy_history_dir_contents_recursive_with_progress(source, target, None)
}

fn copy_history_dir_contents_recursive_with_progress(
    source: &Path,
    target: &Path,
    mut progress: Option<&mut HistoryArchiveProgressState>,
) -> Result<usize, String> {
    if !source.exists() {
        return Ok(0);
    }
    fs::create_dir_all(target).map_err(|err| err.to_string())?;
    let mut copied = 0_usize;
    for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copied += copy_history_dir_contents_recursive_with_progress(
                &source_path,
                &target_path,
                progress.as_deref_mut(),
            )?;
        } else if copy_history_file_with_progress(
            &source_path,
            &target_path,
            false,
            progress.as_deref_mut(),
        )? {
            copied += 1;
        }
    }
    Ok(copied)
}

fn database_table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "select count(*) from sqlite_master where type = 'table' and name = ?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(|err| err.to_string())
}

fn clipboard_table_exists(conn: &rusqlite::Connection) -> Result<bool, String> {
    database_table_exists(conn, "clipboard")
}

fn database_table_columns(conn: &rusqlite::Connection, table: &str) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|err| err.to_string())?;
    let columns = statement
        .query_map([], |row| row.get(1))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(columns)
}

fn rewrite_internal_storage_paths(value: String, source_dir: &str, target_dir: &str) -> String {
    if value.is_empty() {
        return value;
    }
    let source_backslash = source_dir.trim_end_matches(['\\', '/']).replace('/', "\\");
    let target_backslash = target_dir.trim_end_matches(['\\', '/']).replace('/', "\\");
    let source_slash = source_dir.trim_end_matches(['\\', '/']).replace('\\', "/");
    let target_slash = target_dir.trim_end_matches(['\\', '/']).replace('\\', "/");
    let encode = |path: &str| {
        path.bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => {
                    (byte as char).to_string()
                }
                b' ' => "%20".to_string(),
                b':' => "%3A".to_string(),
                b'\\' => "%5C".to_string(),
                b'/' => "%2F".to_string(),
                _ => format!("%{:02X}", byte),
            })
            .collect::<String>()
    };
    let source_backslash_encoded = encode(&source_backslash);
    let target_backslash_encoded = encode(&target_backslash);
    let source_slash_encoded = encode(&source_slash);
    let target_slash_encoded = encode(&target_slash);
    value
        .replace(&source_backslash, &target_backslash)
        .replace(&source_slash, &target_slash)
        .replace(&source_backslash_encoded, &target_backslash_encoded)
        .replace(&source_slash_encoded, &target_slash_encoded)
}

#[cfg(test)]
#[path = "history_import_tests.rs"]
mod history_import_tests;

fn relocate_imported_rich_source(
    source: String,
    archive_dir: &str,
    old_dir: &str,
    target_dir: &str,
) -> String {
    let Some(json) = source.strip_prefix("vpaste-rich:") else {
        return rewrite_internal_storage_paths(source, old_dir, target_dir);
    };
    let Ok(mut meta) = serde_json::from_str::<serde_json::Value>(json) else {
        return source;
    };
    let prefix = format!("{}/", old_dir.replace('\\', "/").trim_end_matches('/'));
    if old_dir.is_empty() {
        return source;
    }
    for field in ["html_path", "rtf_path", "png_path"] {
        let Some(path) = meta.get(field).and_then(|value| value.as_str()) else {
            continue;
        };
        let normalized = path.replace('\\', "/");
        let Some(relative) = normalized.strip_prefix(&prefix) else {
            continue;
        };
        let parts: Vec<_> = relative.split('/').collect();
        if parts.len() < 2
            || !HISTORY_ARCHIVE_DIRS.contains(&parts[0])
            || parts
                .iter()
                .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
        {
            continue;
        }
        let relative: PathBuf = parts.iter().collect();
        let target = Path::new(target_dir).join(&relative);
        // Only rebind attachments actually carried by this archive and copied to the target.
        if Path::new(archive_dir).join(&relative).is_file() && target.is_file() {
            meta[field] = serde_json::Value::String(target.to_string_lossy().into_owned());
        }
    }
    format!("vpaste-rich:{meta}")
}

fn merge_clipboard_database(
    source_dir: &str,
    target_dir: &str,
    rewrite_source_dir: &str,
) -> Result<(usize, usize), String> {
    let source_db = PathBuf::from(source_dir).join("vpaste.db");
    if !source_db.exists() {
        return Ok((0, 0));
    }

    let source_conn = rusqlite::Connection::open(source_db).map_err(|err| err.to_string())?;
    if !clipboard_table_exists(&source_conn)? {
        return Ok((0, 0));
    }

    let target_db = PathBuf::from(target_dir).join("vpaste.db");
    let mut target_conn = rusqlite::Connection::open(target_db).map_err(|err| err.to_string())?;
    clipboard::db::init_schema(&target_conn).map_err(|err| err.to_string())?;
    let transaction = target_conn.transaction().map_err(|err| err.to_string())?;

    let mut statement = source_conn
        .prepare(
            "
            select hash, time, content, preview_content, item_type, search_index, source,
                   app_source, app_icon_path, title_color, icon, label
            from clipboard
            order by time asc, id asc
            ",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<i64>>(5)?.unwrap_or(1),
                row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                row.get::<_, Option<i64>>(11)?.unwrap_or(0),
            ))
        })
        .map_err(|err| err.to_string())?;

    let mut merged = 0_usize;
    let mut skipped = 0_usize;
    for row in rows {
        let (
            hash,
            time,
            mut content,
            mut preview_content,
            item_type,
            search_index,
            mut source,
            app_source,
            mut app_icon_path,
            title_color,
            icon,
            label,
        ) = row.map_err(|err| err.to_string())?;
        if !(item_type == "Text" && source.starts_with("vpaste-rich:")) {
            content = rewrite_internal_storage_paths(content, rewrite_source_dir, target_dir);
            preview_content =
                rewrite_internal_storage_paths(preview_content, rewrite_source_dir, target_dir);
        }
        source = relocate_imported_rich_source(source, source_dir, rewrite_source_dir, target_dir);
        app_icon_path =
            rewrite_internal_storage_paths(app_icon_path, rewrite_source_dir, target_dir);
        let changed = transaction
            .execute(
                "
                insert or ignore into clipboard(
                    hash, time, content, preview_content, item_type, search_index, source,
                    app_source, app_icon_path, title_color, icon, label
                )
                values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ",
                rusqlite::params![
                    hash,
                    time,
                    content.clone(),
                    preview_content.clone(),
                    item_type,
                    search_index,
                    source.clone(),
                    app_source,
                    app_icon_path,
                    title_color,
                    icon,
                    label
                ],
            )
            .map_err(|err| err.to_string())?;
        if changed > 0 {
            merged += 1;
        } else {
            skipped += 1;
            transaction
                .execute(
                    "
                    update clipboard
                    set time = max(time, ?1),
                        app_source = case when ?2 <> '' then ?2 else app_source end,
                        app_icon_path = case when ?3 <> '' then ?3 else app_icon_path end,
                        title_color = case when ?4 <> '' then ?4 else title_color end,
                        label = max(label, ?5)
                    where hash = ?6
                    ",
                    rusqlite::params![time, app_source, app_icon_path, title_color, label, hash],
                )
                .map_err(|err| err.to_string())?;
        }
    }

    if database_table_exists(&source_conn, "tags")? {
        let mut statement = source_conn
            .prepare("select name, created_at, updated_at from tags order by id")
            .map_err(|err| err.to_string())?;
        let tags = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        for tag in tags {
            let (name, created_at, updated_at) = tag.map_err(|err| err.to_string())?;
            transaction
                .execute(
                    "insert or ignore into tags(name, created_at, updated_at)
                     values(?1, ?2, ?3)",
                    rusqlite::params![name, created_at, updated_at],
                )
                .map_err(|err| err.to_string())?;
            transaction
                .execute(
                    "update tags
                     set created_at = min(created_at, ?1), updated_at = max(updated_at, ?2)
                     where name = ?3 collate nocase",
                    rusqlite::params![created_at, updated_at, name],
                )
                .map_err(|err| err.to_string())?;
        }
    }

    if database_table_exists(&source_conn, "clipboard_tags")?
        && database_table_exists(&source_conn, "tags")?
    {
        let mut statement = source_conn
            .prepare(
                "select c.hash, t.name, ct.created_at
                 from clipboard_tags ct
                 join clipboard c on c.id = ct.clipboard_id
                 join tags t on t.id = ct.tag_id
                 order by ct.created_at, c.id, t.id",
            )
            .map_err(|err| err.to_string())?;
        let associations = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        for association in associations {
            let (hash, tag_name, created_at) = association.map_err(|err| err.to_string())?;
            transaction
                .execute(
                    "insert or ignore into clipboard_tags(clipboard_id, tag_id, created_at)
                     select c.id, t.id, ?1
                     from clipboard c, tags t
                     where c.hash = ?2 and t.name = ?3 collate nocase",
                    rusqlite::params![created_at, hash, tag_name],
                )
                .map_err(|err| err.to_string())?;
        }
    }

    if database_table_exists(&source_conn, "paste_queue")? {
        let columns = database_table_columns(&source_conn, "paste_queue")?;
        let has_full_payload = [
            "position",
            "queued_at",
            "time",
            "item_type",
            "search_index",
            "app_source",
            "app_icon_path",
            "title_color",
            "label",
        ]
        .iter()
        .all(|required| columns.iter().any(|column| column == required));
        let queue_query = if has_full_payload {
            "select hash, position, queued_at, time, content, preview_content, item_type,
                    search_index, source, app_source, app_icon_path, title_color, label
             from paste_queue order by position, rowid"
        } else {
            "select q.hash, row_number() over (order by q.rowid) - 1, 0,
                    coalesce(c.time, 0), coalesce(q.content, ''),
                    coalesce(q.preview_content, ''), coalesce(c.item_type, 'Text'),
                    coalesce(c.search_index, 1), coalesce(q.source, ''),
                    coalesce(c.app_source, ''), coalesce(c.app_icon_path, ''),
                    coalesce(c.title_color, ''), coalesce(c.label, 0)
             from paste_queue q left join clipboard c on c.hash = q.hash
             order by q.rowid"
        };
        let mut statement = source_conn
            .prepare(queue_query)
            .map_err(|err| err.to_string())?;
        let queue_items = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, u64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, i64>(12)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        let mut next_position = transaction
            .query_row(
                "select coalesce(max(position), -1) + 1 from paste_queue",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| err.to_string())?;
        for queue_item in queue_items {
            let (
                hash,
                queued_at,
                time,
                mut content,
                mut preview_content,
                item_type,
                search_index,
                mut source,
                app_source,
                mut app_icon_path,
                title_color,
                label,
            ) = queue_item.map_err(|err| err.to_string())?;
            if !(item_type == "Text" && source.starts_with("vpaste-rich:")) {
                content = rewrite_internal_storage_paths(content, rewrite_source_dir, target_dir);
                preview_content =
                    rewrite_internal_storage_paths(preview_content, rewrite_source_dir, target_dir);
            }
            source =
                relocate_imported_rich_source(source, source_dir, rewrite_source_dir, target_dir);
            app_icon_path =
                rewrite_internal_storage_paths(app_icon_path, rewrite_source_dir, target_dir);
            let changed = transaction
                .execute(
                    "insert or ignore into paste_queue(
                        hash, position, queued_at, time, content, preview_content, item_type,
                        search_index, source, app_source, app_icon_path, title_color, label
                     ) values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    rusqlite::params![
                        hash,
                        next_position,
                        queued_at,
                        time,
                        content,
                        preview_content,
                        item_type,
                        search_index,
                        source,
                        app_source,
                        app_icon_path,
                        title_color,
                        label
                    ],
                )
                .map_err(|err| err.to_string())?;
            if changed > 0 {
                next_position += 1;
            }
        }
    }

    transaction.commit().map_err(|err| err.to_string())?;

    Ok((merged, skipped))
}

fn rebuild_current_search_index() -> Result<(), String> {
    clipboard::rebuild_search_index()
}

const HISTORY_ARCHIVE_METADATA: &str = "vpaste-export.json";
const HISTORY_ARCHIVE_DB: &str = "vpaste.db";
const CUSTOM_TABS_FILE: &str = "custom_tabs.json";
const HISTORY_ARCHIVE_VERSION: u32 = 3;
const HISTORY_ARCHIVE_MAGIC: &[u8] = b"VPASTE-HISTORY";
const HISTORY_ARCHIVE_METADATA_MAX_BYTES: u64 = 1024 * 1024;
const HISTORY_ARCHIVE_PATH_MAX_BYTES: u32 = 4096;
const HISTORY_ARCHIVE_DIRS: [&str; 2] = ["data", "rich_formats"];
const HISTORY_ARCHIVE_FILES: [&str; 1] = [CUSTOM_TABS_FILE];
const LEGACY_TEXT_PREFIX: &str = "vpaste-secure:v2:";
const LEGACY_FILE_MAGIC: &[u8] = b"VPASTESEC2";

fn path_contains_legacy_history(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|err| err.to_string())? {
            if path_contains_legacy_history(&entry.map_err(|err| err.to_string())?.path())? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    let mut magic = [0_u8; 10];
    Ok(
        file.read(&mut magic).map_err(|err| err.to_string())? == magic.len()
            && magic == LEGACY_FILE_MAGIC,
    )
}

fn table_has_legacy_text(conn: &rusqlite::Connection, table: &str) -> Result<bool, String> {
    let exists: i64 = conn
        .query_row(
            "select count(*) from sqlite_master where type='table' and name=?1",
            [table],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if exists == 0 {
        return Ok(false);
    }
    let query = format!(
        "select count(*) from {table} where content like ?1 or preview_content like ?1 or source like ?1"
    );
    conn.query_row(&query, [format!("{LEGACY_TEXT_PREFIX}%")], |row| {
        row.get::<_, i64>(0)
    })
    .map(|count| count > 0)
    .map_err(|err| err.to_string())
}

fn legacy_history_present(root: &Path) -> Result<bool, String> {
    let db_path = root.join(HISTORY_ARCHIVE_DB);
    if db_path.is_file() {
        let conn = rusqlite::Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|err| err.to_string())?;
        if table_has_legacy_text(&conn, "clipboard")?
            || table_has_legacy_text(&conn, "paste_queue")?
        {
            return Ok(true);
        }
    }
    for name in [
        CUSTOM_TABS_FILE,
        "data",
        "rich_formats",
        "image_clipboard_cache",
    ] {
        if path_contains_legacy_history(&root.join(name))? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod legacy_history_detection_tests {
    use super::*;

    fn create_history_db(root: &Path, clipboard_content: &str, queue_content: &str) {
        let conn = rusqlite::Connection::open(root.join(HISTORY_ARCHIVE_DB)).unwrap();
        conn.execute_batch(
            "create table clipboard(content text, preview_content text, source text);
             create table paste_queue(content text, preview_content text, source text);",
        )
        .unwrap();
        conn.execute(
            "insert into clipboard values(?1, 'preview', 'source')",
            [clipboard_content],
        )
        .unwrap();
        conn.execute(
            "insert into paste_queue values(?1, 'preview', 'source')",
            [queue_content],
        )
        .unwrap();
    }

    #[test]
    fn detects_legacy_clipboard_and_mixed_plaintext() {
        let root = tempfile::tempdir().unwrap();
        create_history_db(root.path(), "vpaste-secure:v2:ciphertext", "plain queue");
        assert!(legacy_history_present(root.path()).unwrap());
    }

    #[test]
    fn detects_legacy_paste_queue_without_legacy_clipboard() {
        let root = tempfile::tempdir().unwrap();
        create_history_db(
            root.path(),
            "plain clipboard",
            "vpaste-secure:v2:ciphertext",
        );
        assert!(legacy_history_present(root.path()).unwrap());
    }

    #[test]
    fn detects_legacy_managed_file_magic() {
        let root = tempfile::tempdir().unwrap();
        create_history_db(root.path(), "plain clipboard", "plain queue");
        fs::create_dir(root.path().join("rich_formats")).unwrap();
        fs::write(
            root.path().join("rich_formats/item.html"),
            b"VPASTESEC2ciphertext",
        )
        .unwrap();
        assert!(legacy_history_present(root.path()).unwrap());
    }

    #[test]
    fn accepts_fully_plaintext_history() {
        let root = tempfile::tempdir().unwrap();
        create_history_db(root.path(), "plain clipboard", "plain queue");
        fs::create_dir(root.path().join("data")).unwrap();
        fs::write(root.path().join("data/item"), b"plain bytes").unwrap();
        assert!(!legacy_history_present(root.path()).unwrap());
    }
}

#[derive(Clone, Serialize)]
struct HistoryFormatStatus {
    migration_required: bool,
}

#[tauri::command]
fn get_history_format_status() -> HistoryFormatStatus {
    HistoryFormatStatus {
        migration_required: LEGACY_HISTORY_BLOCKED.load(Ordering::SeqCst),
    }
}

fn ensure_history_ready() -> Result<(), String> {
    if LEGACY_HISTORY_BLOCKED.load(Ordering::SeqCst) {
        Err("LEGACY_HISTORY_MIGRATION_REQUIRED".to_string())
    } else {
        Ok(())
    }
}

fn remove_managed_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| err.to_string())
    } else if path.is_file() {
        fs::remove_file(path).map_err(|err| err.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn clear_legacy_history(app: tauri::AppHandle, confirmation: String) -> Result<(), String> {
    if confirmation != "CLEAR_LEGACY_HISTORY" {
        return Err("legacy history clear confirmation is invalid".to_string());
    }
    if !LEGACY_HISTORY_BLOCKED.load(Ordering::SeqCst) {
        return Err("legacy history migration is not required".to_string());
    }
    clipboard::db::clear_legacy_payload().map_err(|err| err.to_string())?;
    let root = PathBuf::from(history_storage_dir());
    for name in [
        CUSTOM_TABS_FILE,
        "data",
        "rich_formats",
        "image_clipboard_cache",
    ] {
        remove_managed_path(&root.join(name))?;
    }
    for name in [
        "search",
        "file_previews",
        "image_clipboard_cache",
        "image_preview_cache",
    ] {
        remove_managed_path(&PathBuf::from(app_runtime_dir(&[name])))?;
    }
    clipboard::db::init();
    rebuild_current_search_index()?;
    LEGACY_HISTORY_BLOCKED.store(false, Ordering::SeqCst);
    initialize_paste_queue_worker(&app);
    if let Some(window) = app.get_webview_window("clipboard") {
        listen::start(window);
    }
    let _ = app.emit(
        "history-format-status-changed",
        HistoryFormatStatus {
            migration_required: false,
        },
    );
    Ok(())
}

impl HistoryArchiveTotals {
    fn empty() -> Self {
        Self {
            total_files: 0,
            total_bytes: 0,
        }
    }

    fn add_file(&mut self, bytes: u64) {
        self.total_files += 1;
        self.total_bytes = self.total_bytes.saturating_add(bytes);
    }
}

impl HistoryArchiveProgressState {
    fn new(
        app: Option<&tauri::AppHandle>,
        operation: &'static str,
        totals: HistoryArchiveTotals,
    ) -> Self {
        Self {
            app: app.cloned(),
            operation,
            stage: "scan",
            processed_files: 0,
            total_files: totals.total_files,
            processed_bytes: 0,
            total_bytes: totals.total_bytes,
        }
    }

    fn set_stage(&mut self, stage: &'static str) {
        self.stage = stage;
        self.processed_files = 0;
        self.processed_bytes = 0;
        self.emit();
    }

    fn set_totals(&mut self, totals: HistoryArchiveTotals) {
        self.total_files = totals.total_files;
        self.total_bytes = totals.total_bytes;
        self.processed_files = 0;
        self.processed_bytes = 0;
        self.emit();
    }

    fn add_file(&mut self, bytes: u64) {
        self.processed_files = self.processed_files.saturating_add(1);
        self.processed_bytes = self.processed_bytes.saturating_add(bytes);
        self.emit();
    }

    fn finish(&mut self) {
        self.stage = "done";
        self.processed_files = self.total_files;
        self.processed_bytes = self.total_bytes;
        self.emit();
    }

    fn emit(&self) {
        if let Some(app) = &self.app {
            let payload = HistoryArchiveProgressPayload {
                operation: self.operation.to_string(),
                stage: self.stage.to_string(),
                processed_files: self.processed_files,
                total_files: self.total_files,
                processed_bytes: self.processed_bytes,
                total_bytes: self.total_bytes,
            };
            let _ = app.emit("history-archive-progress", payload);
        }
    }
}

fn add_path_totals(path: &Path, totals: &mut HistoryArchiveTotals) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            add_path_totals(&entry.path(), totals)?;
        }
    } else if path.is_file() {
        let bytes = fs::metadata(path).map_err(|err| err.to_string())?.len();
        totals.add_file(bytes);
    }
    Ok(())
}

fn history_export_totals(root: &Path) -> Result<HistoryArchiveTotals, String> {
    let mut totals = HistoryArchiveTotals::empty();
    add_path_totals(&root.join(HISTORY_ARCHIVE_DB), &mut totals)?;
    for file_name in HISTORY_ARCHIVE_FILES {
        add_path_totals(&root.join(file_name), &mut totals)?;
    }
    for dir_name in HISTORY_ARCHIVE_DIRS {
        add_path_totals(&root.join(dir_name), &mut totals)?;
    }
    Ok(totals)
}

fn history_import_payload_totals(root: &Path) -> Result<HistoryArchiveTotals, String> {
    let mut totals = HistoryArchiveTotals::empty();
    for file_name in HISTORY_ARCHIVE_FILES {
        add_path_totals(&root.join(file_name), &mut totals)?;
    }
    for dir_name in HISTORY_ARCHIVE_DIRS {
        add_path_totals(&root.join(dir_name), &mut totals)?;
    }
    Ok(totals)
}

fn archive_path_name(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|err| err.to_string())
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn write_u32(writer: &mut File, value: u32) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|err| err.to_string())
}

fn write_u64(writer: &mut File, value: u64) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|err| err.to_string())
}

fn read_u32(reader: &mut File) -> Result<u32, String> {
    let mut bytes = [0_u8; 4];
    reader
        .read_exact(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut File) -> Result<u64, String> {
    let mut bytes = [0_u8; 8];
    reader
        .read_exact(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok(u64::from_le_bytes(bytes))
}

fn write_history_archive_header(
    writer: &mut File,
    metadata: &serde_json::Value,
    entry_count: u64,
) -> Result<(), String> {
    let metadata_bytes = metadata.to_string().into_bytes();
    writer
        .write_all(HISTORY_ARCHIVE_MAGIC)
        .map_err(|err| err.to_string())?;
    write_u32(writer, HISTORY_ARCHIVE_VERSION)?;
    write_u64(writer, metadata_bytes.len() as u64)?;
    writer
        .write_all(&metadata_bytes)
        .map_err(|err| err.to_string())?;
    write_u64(writer, entry_count)
}

fn read_history_archive_header(reader: &mut File) -> Result<(serde_json::Value, u64), String> {
    let mut magic = vec![0_u8; HISTORY_ARCHIVE_MAGIC.len()];
    reader
        .read_exact(&mut magic)
        .map_err(|_| "导入文件不是有效的 vPaste 历史包".to_string())?;
    if magic != HISTORY_ARCHIVE_MAGIC {
        return Err("导入文件不是有效的 vPaste 历史包".to_string());
    }

    let version = read_u32(reader)?;
    if version == 2 {
        return Err(
            "vPaste v2 历史包需要先使用 vpaste-history-converter 转换为明文 v3 格式".to_string(),
        );
    }
    if version != HISTORY_ARCHIVE_VERSION {
        return Err(format!("不支持的 vPaste 历史包版本：{}", version));
    }

    let metadata_len = read_u64(reader)?;
    if metadata_len == 0 || metadata_len > HISTORY_ARCHIVE_METADATA_MAX_BYTES {
        return Err("vPaste 历史包元数据无效".to_string());
    }
    let mut metadata_bytes = vec![0_u8; metadata_len as usize];
    reader
        .read_exact(&mut metadata_bytes)
        .map_err(|err| err.to_string())?;
    let metadata = serde_json::from_slice::<serde_json::Value>(&metadata_bytes)
        .map_err(|_| "vPaste 历史包元数据无法解析".to_string())?;
    if metadata.get("format").and_then(|value| value.as_str()) != Some("vpaste-history") {
        return Err("导入文件不是有效的 vPaste 历史包".to_string());
    }

    let entry_count = read_u64(reader)?;
    Ok((metadata, entry_count))
}

fn write_history_archive_entry_header(
    writer: &mut File,
    name: &str,
    size: u64,
) -> Result<(), String> {
    let name_bytes = name.as_bytes();
    if name_bytes.is_empty() || name_bytes.len() > HISTORY_ARCHIVE_PATH_MAX_BYTES as usize {
        return Err(format!("archive path is invalid: {name}"));
    }
    write_u32(writer, name_bytes.len() as u32)?;
    writer
        .write_all(name_bytes)
        .map_err(|err| err.to_string())?;
    write_u64(writer, size)
}

fn read_history_archive_entry_header(reader: &mut File) -> Result<(String, u64), String> {
    let path_len = read_u32(reader)?;
    if path_len == 0 || path_len > HISTORY_ARCHIVE_PATH_MAX_BYTES {
        return Err("vPaste 历史包包含无效路径".to_string());
    }
    let mut path_bytes = vec![0_u8; path_len as usize];
    reader
        .read_exact(&mut path_bytes)
        .map_err(|err| err.to_string())?;
    let name =
        String::from_utf8(path_bytes).map_err(|_| "vPaste 历史包包含无效路径".to_string())?;
    let size = read_u64(reader)?;
    Ok((name, size))
}

fn validate_archive_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('\\') {
        return Err("vPaste 历史包包含无效路径".to_string());
    }
    let path = Path::new(name);
    if path.is_absolute() {
        return Err("vPaste 历史包包含无效路径".to_string());
    }
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("vPaste 历史包包含无效路径".to_string());
    }
    if name != HISTORY_ARCHIVE_DB
        && name != CUSTOM_TABS_FILE
        && !name.starts_with("data/")
        && !name.starts_with("rich_formats/")
    {
        return Err("vPaste 历史包包含不受支持的路径".to_string());
    }
    Ok(())
}

fn validate_archive_metadata(metadata: &serde_json::Value) -> Result<String, String> {
    let source_dir = metadata
        .get("source_dir")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "vPaste 历史包缺少来源目录信息".to_string())?
        .to_string();
    Ok(source_dir)
}

fn validate_history_archive(archive_path: &str) -> Result<(String, HistoryArchiveTotals), String> {
    let mut reader = File::open(archive_path).map_err(|err| err.to_string())?;
    let (metadata, entry_count) = read_history_archive_header(&mut reader)?;
    let source_dir = validate_archive_metadata(&metadata)?;
    let mut totals = HistoryArchiveTotals::empty();
    let mut has_db = false;
    let mut names = HashSet::new();

    for _ in 0..entry_count {
        let (name, size) = read_history_archive_entry_header(&mut reader)?;
        validate_archive_entry_name(&name)?;
        if !names.insert(name.clone()) {
            return Err("vPaste 历史包包含重复路径".to_string());
        }
        if name == HISTORY_ARCHIVE_DB {
            has_db = true;
        }
        totals.add_file(size);
        reader
            .seek(SeekFrom::Current(size as i64))
            .map_err(|err| err.to_string())?;
    }

    if !has_db {
        return Err("导入文件不是有效的 vPaste 历史包".to_string());
    }
    let position = reader.stream_position().map_err(|err| err.to_string())?;
    let length = reader.metadata().map_err(|err| err.to_string())?.len();
    if position != length {
        return Err("vPaste 历史包末尾包含无效数据".to_string());
    }
    Ok((source_dir, totals))
}

fn add_path_to_history_archive(
    root: &Path,
    path: &Path,
    writer: &mut File,
    progress: &mut HistoryArchiveProgressState,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            add_path_to_history_archive(root, &entry.path(), writer, progress)?;
        }
    } else if path.is_file() {
        let name = archive_path_name(root, path)?;
        validate_archive_entry_name(&name)?;
        let source_bytes = fs::metadata(path).map_err(|err| err.to_string())?.len();
        write_history_archive_entry_header(writer, &name, source_bytes)?;
        let mut source = File::open(path).map_err(|err| err.to_string())?;
        io::copy(&mut source, writer).map_err(|err| err.to_string())?;
        progress.add_file(source_bytes);
    }
    Ok(())
}

fn export_history_archive_impl(
    app: Option<&tauri::AppHandle>,
    archive_path: String,
) -> Result<HistoryArchiveInfo, String> {
    ensure_history_ready()?;
    ensure_history_storage_dirs()?;
    clipboard::db::init();
    let _: (i64, i64, i64) = clipboard::db::db()
        .query_row("pragma wal_checkpoint(full)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|err| format!("checkpoint history database failed: {err}"))?;
    let root = PathBuf::from(history_storage_dir());
    let mut progress =
        HistoryArchiveProgressState::new(app, "export", history_export_totals(&root)?);
    progress.emit();
    let archive_path_buf = PathBuf::from(&archive_path);
    if let Some(parent) = archive_path_buf.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let mut writer = File::create(&archive_path_buf).map_err(|err| err.to_string())?;

    progress.set_stage("write");
    let metadata = serde_json::json!({
        "format": "vpaste-history",
        "version": HISTORY_ARCHIVE_VERSION,
        "exported_at": now_millis(),
        "source_dir": root.to_string_lossy().to_string(),
    });
    write_history_archive_header(&mut writer, &metadata, progress.total_files as u64)?;

    add_path_to_history_archive(
        &root,
        &root.join(HISTORY_ARCHIVE_DB),
        &mut writer,
        &mut progress,
    )?;
    for file_name in HISTORY_ARCHIVE_FILES {
        add_path_to_history_archive(&root, &root.join(file_name), &mut writer, &mut progress)?;
    }
    for dir_name in HISTORY_ARCHIVE_DIRS {
        add_path_to_history_archive(&root, &root.join(dir_name), &mut writer, &mut progress)?;
    }
    writer.flush().map_err(|err| err.to_string())?;
    progress.finish();

    Ok(HistoryArchiveInfo {
        archive_path,
        merged_items: 0,
        skipped_items: 0,
        copied_files: 0,
        message: "历史已导出".to_string(),
    })
}

#[tauri::command]
async fn export_history_archive(
    app: tauri::AppHandle,
    archive_path: String,
) -> Result<HistoryArchiveInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_history_archive_impl(Some(&app), archive_path)
    })
    .await
    .map_err(|err| format!("导出任务失败：{err}"))?
}

fn extract_history_archive(
    archive_path: &str,
    target_dir: &Path,
    progress: &mut HistoryArchiveProgressState,
) -> Result<(), String> {
    let (_, totals) = validate_history_archive(archive_path)?;
    let mut reader = File::open(archive_path).map_err(|err| err.to_string())?;
    let (metadata, entry_count) = read_history_archive_header(&mut reader)?;
    progress.set_totals(totals);
    progress.set_stage("extract");

    fs::create_dir_all(target_dir).map_err(|err| err.to_string())?;
    fs::write(
        target_dir.join(HISTORY_ARCHIVE_METADATA),
        metadata.to_string(),
    )
    .map_err(|err| err.to_string())?;

    for _ in 0..entry_count {
        let (name, size) = read_history_archive_entry_header(&mut reader)?;
        validate_archive_entry_name(&name)?;
        let outpath = target_dir.join(&name);
        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut outfile = File::create(&outpath).map_err(|err| err.to_string())?;
        let copied = io::copy(&mut Read::by_ref(&mut reader).take(size), &mut outfile)
            .map_err(|err| err.to_string())?;
        if copied != size {
            return Err("vPaste 历史包内容不完整".to_string());
        }
        progress.add_file(copied);
    }
    Ok(())
}

fn import_history_archive_impl(
    app: tauri::AppHandle,
    archive_path: String,
) -> Result<HistoryArchiveInfo, String> {
    ensure_history_ready()?;
    ensure_history_storage_dirs()?;
    let target_dir = history_storage_dir();
    let mut progress =
        HistoryArchiveProgressState::new(Some(&app), "import", HistoryArchiveTotals::empty());
    progress.emit();
    let (rewrite_source_dir, _) = validate_history_archive(&archive_path)?;
    let temp_dir = tempfile::tempdir().map_err(|err| err.to_string())?;
    extract_history_archive(&archive_path, temp_dir.path(), &mut progress)?;

    let source_db = temp_dir.path().join(HISTORY_ARCHIVE_DB);
    if !source_db.exists() {
        return Err("导入文件不是有效的 vPaste 历史包".to_string());
    }

    progress.set_totals(history_import_payload_totals(temp_dir.path())?);
    progress.set_stage("copy");
    let mut copied_files = 0_usize;
    for file_name in HISTORY_ARCHIVE_FILES {
        let source_path = temp_dir.path().join(file_name);
        if copy_history_file_with_progress(
            &source_path,
            &PathBuf::from(&target_dir).join(file_name),
            true,
            Some(&mut progress),
        )? {
            copied_files += 1;
        }
    }
    for dir_name in HISTORY_ARCHIVE_DIRS {
        copied_files += copy_history_dir_contents_recursive_with_progress(
            &temp_dir.path().join(dir_name),
            &PathBuf::from(&target_dir).join(dir_name),
            Some(&mut progress),
        )?;
    }

    progress.set_totals(HistoryArchiveTotals::empty());
    progress.set_stage("merge");
    let (merged_items, skipped_items) = merge_clipboard_database(
        temp_dir.path().to_str().unwrap_or(""),
        &target_dir,
        &rewrite_source_dir,
    )?;
    clipboard::db::init();
    progress.set_stage("index");
    if let Err(err) = rebuild_current_search_index() {
        error!(
            "Failed to rebuild search index after importing history: {}",
            err
        );
    }
    if let Ok(tabs) = get_custom_tabs() {
        let _ = app.emit_to(
            "clipboard",
            "custom-tabs-changed",
            serde_json::json!({ "tabs": tabs }),
        );
    }
    paste_queue::emit_state(&app);
    progress.finish();

    Ok(HistoryArchiveInfo {
        archive_path,
        merged_items,
        skipped_items,
        copied_files,
        message: format!(
            "导入完成，合并 {} 条，跳过重复 {} 条，复制 {} 个文件",
            merged_items, skipped_items, copied_files
        ),
    })
}

#[tauri::command]
async fn import_history_archive(
    app: tauri::AppHandle,
    archive_path: String,
) -> Result<HistoryArchiveInfo, String> {
    tauri::async_runtime::spawn_blocking(move || import_history_archive_impl(app, archive_path))
        .await
        .map_err(|err| format!("导入任务失败：{err}"))?
}

#[cfg(test)]
mod history_archive_v3_tests {
    use super::*;

    fn archive_with_entries(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let mut archive = tempfile::NamedTempFile::new().unwrap();
        let metadata = serde_json::json!({
            "format": "vpaste-history",
            "version": 3,
            "exported_at": 1,
            "source_dir": "/old/history"
        });
        write_history_archive_header(archive.as_file_mut(), &metadata, entries.len() as u64)
            .unwrap();
        for (name, bytes) in entries {
            write_history_archive_entry_header(archive.as_file_mut(), name, bytes.len() as u64)
                .unwrap();
            archive.as_file_mut().write_all(bytes).unwrap();
        }
        archive.as_file_mut().flush().unwrap();
        archive
    }

    #[test]
    fn v3_metadata_has_no_encryption_node() {
        let archive = archive_with_entries(&[(HISTORY_ARCHIVE_DB, b"sqlite")]);
        let mut reader = File::open(archive.path()).unwrap();
        let (metadata, _) = read_history_archive_header(&mut reader).unwrap();
        assert_eq!(metadata["version"], 3);
        assert!(metadata.get("encryption").is_none());
        validate_history_archive(archive.path().to_str().unwrap()).unwrap();
    }

    #[test]
    fn v2_requires_the_converter() {
        let archive = tempfile::NamedTempFile::new().unwrap();
        let mut file = archive.reopen().unwrap();
        file.write_all(HISTORY_ARCHIVE_MAGIC).unwrap();
        file.write_all(&2_u32.to_le_bytes()).unwrap();
        file.flush().unwrap();
        let error =
            read_history_archive_header(&mut File::open(archive.path()).unwrap()).unwrap_err();
        assert!(error.contains("vpaste-history-converter"));
    }

    #[test]
    fn rejects_duplicate_unsafe_and_trailing_entries() {
        let duplicate =
            archive_with_entries(&[(HISTORY_ARCHIVE_DB, b"one"), (HISTORY_ARCHIVE_DB, b"two")]);
        assert!(validate_history_archive(duplicate.path().to_str().unwrap())
            .unwrap_err()
            .contains("重复"));

        let unsafe_path = archive_with_entries(&[(HISTORY_ARCHIVE_DB, b"db"), ("../x", b"x")]);
        assert!(validate_history_archive(unsafe_path.path().to_str().unwrap()).is_err());

        let mut trailing = archive_with_entries(&[(HISTORY_ARCHIVE_DB, b"db")]);
        trailing.as_file_mut().write_all(b"extra").unwrap();
        trailing.as_file_mut().flush().unwrap();
        assert!(validate_history_archive(trailing.path().to_str().unwrap())
            .unwrap_err()
            .contains("末尾"));
    }

    #[test]
    fn database_merge_preserves_tags_and_paste_queue() {
        let workspace = tempfile::tempdir().unwrap();
        let source_dir = workspace.path().join("source");
        let target_dir = workspace.path().join("target");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();

        let source_db = source_dir.join(HISTORY_ARCHIVE_DB);
        let source_conn = rusqlite::Connection::open(&source_db).unwrap();
        clipboard::db::init_schema(&source_conn).unwrap();
        source_conn
            .execute(
                "insert into clipboard(
                    id, hash, time, content, preview_content, item_type, search_index, source,
                    app_source, app_icon_path, title_color, icon, label
                 ) values(1, 'imported', 10, 'body', 'body', 'Text', 1, '', '', '', '', '', 0)",
                [],
            )
            .unwrap();
        source_conn
            .execute(
                "insert into tags(id, name, created_at, updated_at)
                 values(7, 'important', 11, 12)",
                [],
            )
            .unwrap();
        source_conn
            .execute(
                "insert into clipboard_tags(clipboard_id, tag_id, created_at)
                 values(1, 7, 13)",
                [],
            )
            .unwrap();
        source_conn
            .execute(
                "insert into paste_queue(
                    hash, position, queued_at, time, content, preview_content, item_type,
                    search_index, source, app_source, app_icon_path, title_color, label
                 ) values('imported', 0, 14, 10, 'body', 'body', 'Text', 1, '', '', '', '', 0)",
                [],
            )
            .unwrap();
        drop(source_conn);

        let target_db = target_dir.join(HISTORY_ARCHIVE_DB);
        let target_conn = rusqlite::Connection::open(&target_db).unwrap();
        clipboard::db::init_schema(&target_conn).unwrap();
        target_conn
            .execute(
                "insert into paste_queue(
                    hash, position, queued_at, time, content, preview_content, item_type,
                    search_index, source, app_source, app_icon_path, title_color, label
                 ) values('existing', 0, 1, 1, 'existing', 'existing', 'Text', 1, '', '', '', '', 0)",
                [],
            )
            .unwrap();
        drop(target_conn);

        assert_eq!(
            merge_clipboard_database(
                source_dir.to_str().unwrap(),
                target_dir.to_str().unwrap(),
                "/old/history",
            )
            .unwrap(),
            (1, 0)
        );

        let target_conn = rusqlite::Connection::open(target_db).unwrap();
        let imported_tag: String = target_conn
            .query_row(
                "select t.name
                 from clipboard_tags ct
                 join clipboard c on c.id = ct.clipboard_id
                 join tags t on t.id = ct.tag_id
                 where c.hash = 'imported'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let imported_queue: (i64, String) = target_conn
            .query_row(
                "select position, content from paste_queue where hash = 'imported'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(imported_tag, "important");
        assert_eq!(imported_queue, (1, "body".to_string()));
    }
}

#[cfg(test)]
mod file_preview_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn gif_file_preview_uses_original_path_and_dimensions() {
        let workspace = tempfile::tempdir().unwrap();
        let gif_path = workspace.path().join("sample.gif");
        let image = image::RgbaImage::from_pixel(2, 3, image::Rgba([255, 0, 0, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Gif)
            .unwrap();
        fs::write(&gif_path, bytes).unwrap();

        let info = build_file_preview_info(
            serde_json::to_string(&vec![gif_path.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();

        assert_eq!(info.kind, "single-preview");
        assert_eq!(info.preview_path, gif_path.to_string_lossy());
        assert_eq!(info.image_width, Some(2));
        assert_eq!(info.image_height, Some(3));
    }

    #[test]
    fn image_file_preview_uses_original_path_for_file_semantics() {
        let workspace = tempfile::tempdir().unwrap();
        let image_path = workspace.path().join("sample.png");
        let image = image::RgbaImage::from_pixel(4, 5, image::Rgba([0, 128, 255, 255]));
        image
            .save_with_format(&image_path, image::ImageFormat::Png)
            .unwrap();

        let info = build_file_preview_info(
            serde_json::to_string(&vec![image_path.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();

        assert_eq!(info.kind, "single-preview");
        assert_eq!(info.preview_path, image_path.to_string_lossy());
        assert_eq!(info.image_width, Some(4));
        assert_eq!(info.image_height, Some(5));
    }

    #[test]
    fn multiple_file_preview_leaves_secondary_text_for_frontend_i18n() {
        let workspace = tempfile::tempdir().unwrap();
        let first_path = workspace.path().join("first.txt");
        let second_path = workspace.path().join("second.txt");
        fs::write(&first_path, "first").unwrap();
        fs::write(&second_path, "second").unwrap();

        let info = build_file_preview_info(
            serde_json::to_string(&vec![
                first_path.to_string_lossy().to_string(),
                second_path.to_string_lossy().to_string(),
            ])
            .unwrap(),
        )
        .unwrap();

        assert_eq!(info.kind, "multiple");
        assert_eq!(info.display_path, first_path.to_string_lossy());
        assert!(info.secondary_text.is_empty());
        assert!(!info.contains_directories);
    }

    #[test]
    fn multiple_file_preview_reports_when_the_selection_contains_a_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let file_path = workspace.path().join("first.txt");
        let directory_path = workspace.path().join("folder");
        fs::write(&file_path, "first").unwrap();
        fs::create_dir(&directory_path).unwrap();

        let info = build_file_preview_info(
            serde_json::to_string(&vec![
                file_path.to_string_lossy().to_string(),
                directory_path.to_string_lossy().to_string(),
            ])
            .unwrap(),
        )
        .unwrap();

        assert_eq!(info.kind, "multiple");
        assert!(info.contains_directories);
    }

    #[test]
    fn missing_file_preview_reports_an_invalid_path() {
        let workspace = tempfile::tempdir().unwrap();
        let missing_path = workspace.path().join("deleted.txt");

        let info = build_file_preview_info(
            serde_json::to_string(&vec![missing_path.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();

        assert!(!info.exists);
        assert_eq!(info.kind, "text-preview");
        assert_eq!(info.missing_paths, vec![missing_path.to_string_lossy()]);
    }
}

#[tauri::command]
fn get_storage_paths() -> StoragePaths {
    StoragePaths {
        app_data_dir: get_app_data_dir(),
        config_path: splicing_with_app_data_dir(&["config.json"]),
        history_storage_dir: history_storage_dir(),
        database_path: splicing_with_history_storage_dir(&["vpaste.db"]),
        internal_data_dir: splicing_with_history_storage_dir(&["data"]),
        search_index_dir: app_runtime_dir(&["search"]),
        logs_dir: app_runtime_dir(&["logs"]),
        file_previews_dir: app_runtime_dir(&["file_previews"]),
        image_clipboard_cache_dir: app_runtime_dir(&["image_clipboard_cache"]),
    }
}

#[tauri::command]
async fn estimate_storage_cleanup(days: u64) -> Result<StorageCleanupInfo, String> {
    ensure_history_ready()?;
    tauri::async_runtime::spawn_blocking(move || {
        let estimate = clipboard::cleanup_estimate(days)?;
        Ok(StorageCleanupInfo {
            bytes: estimate.bytes,
            items: estimate.items,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn cleanup_storage_history(days: u64) -> Result<StorageCleanupInfo, String> {
    ensure_history_ready()?;
    tauri::async_runtime::spawn_blocking(move || {
        let estimate = clipboard::cleanup_older_than(days)?;
        Ok(StorageCleanupInfo {
            bytes: estimate.bytes,
            items: estimate.items,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> String {
    if let Err(err) = refresh_stored_autostart_from_system(&app) {
        error!("Failed to refresh stored autostart status: {}", err);
    }
    serde_json::to_string(&config::get()).unwrap()
}

fn refresh_stored_autostart_from_system(app: &tauri::AppHandle) -> Result<bool, String> {
    let mut current = config::get();
    let actual_startup = check_autostart_enabled(app)?;
    if current.startup != actual_startup {
        info!(
            "Updating stored autostart preference from {} to actual status {}",
            current.startup, actual_startup
        );
        current.startup = actual_startup;
        config::save(current.clone());
    }
    Ok(actual_startup)
}

fn shortcut_policy_parts(shortcut: &str) -> Vec<String> {
    shortcut
        .split('+')
        .map(|part| {
            let trimmed = part.trim();
            match trimmed.to_ascii_lowercase().as_str() {
                "control" | "ctrl" => "ctrl".to_string(),
                "option" | "alt" => "alt".to_string(),
                "shift" => "shift".to_string(),
                "command" | "cmd" | "meta" | "super" | "win" | "windows" => "super".to_string(),
                "return" | "enter" => "enter".to_string(),
                "escape" | "esc" => "esc".to_string(),
                "space" | "spacebar" => "space".to_string(),
                value => value.to_string(),
            }
        })
        .filter(|part| !part.is_empty())
        .collect()
}

fn shortcut_policy_key(shortcut: &str) -> String {
    let mut parts = shortcut_policy_parts(shortcut);
    parts.sort();
    parts.join("+")
}

fn shortcut_has_modifier(shortcut: &str) -> bool {
    shortcut_policy_parts(shortcut)
        .iter()
        .any(|part| matches!(part.as_str(), "ctrl" | "alt" | "shift" | "super"))
}

fn is_blocked_main_shortcut(shortcut: &str) -> bool {
    matches!(
        shortcut_policy_key(shortcut).as_str(),
        "super+v" | "alt+space" | "space+super" | "super+tab" | "q+super"
    )
}

fn is_reserved_quick_input_shortcut_for_platform(shortcut: &str, is_macos: bool) -> bool {
    if !is_macos {
        return false;
    }

    let parts = shortcut_policy_parts(shortcut);
    let has_alt = parts.iter().any(|part| part == "alt");
    let has_non_quick_input_modifier = parts.iter().any(|part| part == "ctrl" || part == "super");
    if !has_alt || has_non_quick_input_modifier {
        return false;
    }

    parts.iter().any(|part| {
        matches!(
            part.as_str(),
            "a" | "f" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
        )
    })
}

fn is_reserved_quick_input_shortcut(shortcut: &str) -> bool {
    is_reserved_quick_input_shortcut_for_platform(shortcut, cfg!(target_os = "macos"))
}

fn is_reserved_paste_as_text_shortcut(shortcut: &str) -> bool {
    let parts = shortcut_policy_parts(shortcut);
    let has_ctrl_or_super = parts.iter().any(|part| part == "ctrl" || part == "super");
    if has_ctrl_or_super && parts.iter().any(|part| part == "f") {
        return true;
    }

    parts.iter().any(|part| {
        matches!(
            part.as_str(),
            "space" | "arrowdown" | "arrowleft" | "arrowright" | "tab" | "esc"
        )
    }) || shortcut_policy_key(shortcut) == "enter"
}

fn parse_shortcut(shortcut: &str, label: &str) -> Result<Shortcut, String> {
    shortcut
        .parse::<Shortcut>()
        .map_err(|err| format!("{}快捷键无效或暂不支持：{} ({})", label, shortcut, err))
}

fn parse_optional_shortcut(
    shortcut: Option<&str>,
    label: &str,
) -> Result<Option<Shortcut>, String> {
    shortcut
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_shortcut(value, label).map(Some))
        .unwrap_or(Ok(None))
}

fn validate_main_window_shortcut(shortcut: Option<&str>) -> Result<(), String> {
    let Some(shortcut) = shortcut.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };

    if !shortcut_has_modifier(shortcut) {
        return Err("唤起主窗口快捷键至少需要包含一个修饰键".to_string());
    }
    if is_blocked_main_shortcut(shortcut) {
        return Err("该唤起主窗口快捷键被系统保留，请换一个快捷键".to_string());
    }
    if is_reserved_quick_input_shortcut(shortcut) {
        return Err("该快捷键已保留给快捷输入，请换一个快捷键".to_string());
    }
    parse_shortcut(shortcut, "唤起主窗口")?;
    Ok(())
}

fn validate_paste_as_text_shortcut(shortcut: Option<&str>) -> Result<(), String> {
    let Some(shortcut) = shortcut.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };

    if is_reserved_quick_input_shortcut(shortcut) {
        return Err("该快捷键已保留给快捷输入，请换一个快捷键".to_string());
    }
    if is_reserved_paste_as_text_shortcut(shortcut) {
        return Err("该快捷键已被主窗口操作占用，请换一个快捷键".to_string());
    }
    parse_shortcut(shortcut, "粘贴为文本")?;
    Ok(())
}

fn validate_paste_queue_shortcut(shortcut: Option<&str>) -> Result<(), String> {
    let Some(shortcut) = shortcut.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if !shortcut_has_modifier(shortcut) {
        return Err("粘贴队列快捷键至少需要包含一个修饰键".to_string());
    }
    if is_blocked_main_shortcut(shortcut) || is_reserved_quick_input_shortcut(shortcut) {
        return Err("该粘贴队列快捷键被系统或快捷输入占用，请换一个快捷键".to_string());
    }
    if matches!(shortcut_policy_key(shortcut).as_str(), "ctrl+v" | "super+v") {
        return Err("Ctrl/Command+V 由激活后的粘贴队列自动接管".to_string());
    }
    parse_shortcut(shortcut, "开关粘贴队列")?;
    Ok(())
}

fn validate_shortcut_config(config: &Config) -> Result<(), String> {
    validate_main_window_shortcut(config.shortcut_keys.main_window.as_deref())?;
    validate_paste_queue_shortcut(config.shortcut_keys.paste_queue_toggle.as_deref())?;
    validate_paste_as_text_shortcut(config.shortcut_keys.paste_into_plain_text.as_deref())?;
    if config
        .shortcut_keys
        .main_window
        .as_deref()
        .zip(config.shortcut_keys.paste_queue_toggle.as_deref())
        .is_some_and(|(main, queue)| shortcut_policy_key(main) == shortcut_policy_key(queue))
    {
        return Err("唤起主窗口和粘贴队列不能使用同一个快捷键".to_string());
    }
    Ok(())
}

fn register_main_window_shortcut(
    app: &tauri::AppHandle,
    shortcut: Option<Shortcut>,
) -> Result<ShortcutRegistrationInfo, String> {
    let Some(shortcut) = shortcut else {
        return Ok(ShortcutRegistrationInfo {
            registered: false,
            conflict: false,
        });
    };

    let manager = app.global_shortcut();
    if manager.is_registered(shortcut) {
        return Ok(ShortcutRegistrationInfo {
            registered: true,
            conflict: false,
        });
    }

    match manager.register(shortcut) {
        Ok(()) => Ok(ShortcutRegistrationInfo {
            registered: true,
            conflict: false,
        }),
        Err(err) => {
            error!("Failed to register shortcut: {}", err);
            Ok(ShortcutRegistrationInfo {
                registered: false,
                conflict: true,
            })
        }
    }
}

fn unregister_main_window_shortcut(
    app: &tauri::AppHandle,
    shortcut: Option<Shortcut>,
) -> Result<(), String> {
    let Some(shortcut) = shortcut else {
        return Ok(());
    };

    let manager = app.global_shortcut();
    if manager.is_registered(shortcut) {
        manager
            .unregister(shortcut)
            .map_err(|err| format!("注销快捷键失败：{}", err))?;
    }
    Ok(())
}

fn configured_main_window_shortcut() -> Result<Option<Shortcut>, String> {
    let config = config::get();
    parse_optional_shortcut(config.shortcut_keys.main_window.as_deref(), "唤起主窗口")
}

fn configured_paste_queue_shortcut() -> Result<Option<Shortcut>, String> {
    let config = config::get();
    parse_optional_shortcut(
        config.shortcut_keys.paste_queue_toggle.as_deref(),
        "开关粘贴队列",
    )
}

#[tauri::command]
fn begin_main_shortcut_recording(app: tauri::AppHandle) -> Result<(), String> {
    let current_shortcut = match configured_main_window_shortcut() {
        Ok(shortcut) => shortcut,
        Err(err) => {
            error!(
                "Ignoring invalid current shortcut before recording: {}",
                err
            );
            None
        }
    };
    unregister_main_window_shortcut(&app, current_shortcut)
}

#[tauri::command]
fn end_main_shortcut_recording(app: tauri::AppHandle) -> Result<ShortcutRegistrationInfo, String> {
    let current_shortcut = match configured_main_window_shortcut() {
        Ok(shortcut) => shortcut,
        Err(err) => {
            error!("Skipping invalid current shortcut after recording: {}", err);
            None
        }
    };
    register_main_window_shortcut(&app, current_shortcut)
}

#[tauri::command]
fn begin_paste_queue_shortcut_recording(app: tauri::AppHandle) -> Result<(), String> {
    unregister_main_window_shortcut(&app, configured_paste_queue_shortcut().unwrap_or(None))
}

#[tauri::command]
fn end_paste_queue_shortcut_recording(
    app: tauri::AppHandle,
) -> Result<ShortcutRegistrationInfo, String> {
    register_main_window_shortcut(&app, configured_paste_queue_shortcut().unwrap_or(None))
}

#[tauri::command]
fn check_paste_queue_shortcut_registration(
    app: tauri::AppHandle,
    shortcut: String,
) -> Result<ShortcutRegistrationInfo, String> {
    validate_paste_queue_shortcut(Some(&shortcut))?;
    let parsed = parse_optional_shortcut(Some(&shortcut), "开关粘贴队列")?;
    let Some(parsed) = parsed else {
        return Ok(ShortcutRegistrationInfo {
            registered: false,
            conflict: false,
        });
    };
    if app.global_shortcut().is_registered(parsed) {
        return Ok(ShortcutRegistrationInfo {
            registered: true,
            conflict: false,
        });
    }
    let info = register_main_window_shortcut(&app, Some(parsed))?;
    if info.registered {
        unregister_main_window_shortcut(&app, Some(parsed))?;
    }
    Ok(info)
}

#[tauri::command]
fn check_main_shortcut_registration(
    app: tauri::AppHandle,
    shortcut: String,
) -> Result<ShortcutRegistrationInfo, String> {
    validate_main_window_shortcut(Some(shortcut.as_str()))?;
    let parsed = parse_optional_shortcut(Some(shortcut.as_str()), "唤起主窗口")?;
    let Some(shortcut) = parsed else {
        return Ok(ShortcutRegistrationInfo {
            registered: false,
            conflict: false,
        });
    };

    if app.global_shortcut().is_registered(shortcut) {
        return Ok(ShortcutRegistrationInfo {
            registered: true,
            conflict: false,
        });
    }

    let info = register_main_window_shortcut(&app, Some(shortcut))?;
    if info.registered {
        unregister_main_window_shortcut(&app, Some(shortcut))?;
    }
    Ok(info)
}

#[cfg(test)]
mod shortcut_policy_tests {
    use super::*;

    #[test]
    fn normal_paste_command_exposes_failures_to_tauri() {
        type PasteCommand = fn(&str, Option<bool>, Option<String>) -> Result<(), String>;
        let _: PasteCommand = paste;
    }

    #[test]
    fn normalizes_modifier_aliases_for_policy_checks() {
        assert_eq!(shortcut_policy_key("Control+V"), "ctrl+v");
        assert_eq!(shortcut_policy_key("Ctrl+V"), "ctrl+v");
        assert_eq!(shortcut_policy_key("Command+V"), "super+v");
        assert_eq!(shortcut_policy_key("Meta+V"), "super+v");
        assert_eq!(shortcut_policy_key("Windows+V"), "super+v");
    }

    #[test]
    fn validates_main_window_shortcut_policy() {
        assert!(validate_main_window_shortcut(Some("Alt+V")).is_ok());
        assert!(validate_main_window_shortcut(Some("Command+V")).is_err());
        assert!(validate_main_window_shortcut(Some("Alt+Space")).is_err());
        assert!(validate_main_window_shortcut(Some("A")).is_err());
        assert!(validate_main_window_shortcut(Some("Space")).is_err());
    }

    #[test]
    fn detects_macos_quick_input_reservations() {
        assert!(is_reserved_quick_input_shortcut_for_platform("Alt+A", true));
        assert!(is_reserved_quick_input_shortcut_for_platform("Alt+F", true));
        assert!(is_reserved_quick_input_shortcut_for_platform("Alt+1", true));
        assert!(is_reserved_quick_input_shortcut_for_platform("Alt+9", true));
        assert!(!is_reserved_quick_input_shortcut_for_platform(
            "Alt+V", true
        ));
        assert!(!is_reserved_quick_input_shortcut_for_platform(
            "Alt+A", false
        ));
    }

    #[test]
    fn validates_paste_as_text_shortcut_policy() {
        assert!(validate_paste_as_text_shortcut(Some("Shift+Enter")).is_ok());
        assert!(validate_paste_as_text_shortcut(Some("Command+F")).is_err());
        assert!(validate_paste_as_text_shortcut(Some("Control+F")).is_err());
        assert!(validate_paste_as_text_shortcut(Some("Space")).is_err());
        assert!(validate_paste_as_text_shortcut(Some("ArrowDown")).is_err());
        assert!(validate_paste_as_text_shortcut(Some("Tab")).is_err());
        assert!(validate_paste_as_text_shortcut(Some("Escape")).is_err());
        assert!(validate_paste_as_text_shortcut(Some("Enter")).is_err());
    }

    #[test]
    fn validates_paste_queue_toggle_shortcut_policy() {
        assert!(validate_paste_queue_shortcut(Some("Alt+Shift+V")).is_ok());
        assert!(validate_paste_queue_shortcut(Some("Control+V")).is_err());
        assert!(validate_paste_queue_shortcut(Some("Command+V")).is_err());
        assert!(validate_paste_queue_shortcut(Some("V")).is_err());
    }

    #[test]
    fn rejects_matching_main_and_paste_queue_shortcuts() {
        let mut config = Config::default();
        config.shortcut_keys.main_window = Some("Alt+V".to_string());
        config.shortcut_keys.paste_queue_toggle = Some("V+Alt".to_string());
        assert!(validate_shortcut_config(&config).is_err());
    }

    #[test]
    fn paste_queue_intercepts_only_the_platform_paste_modifier() {
        let mut state = PasteQueueInputState {
            control: true,
            ..Default::default()
        };
        assert!(exact_paste_queue_modifier_for_platform(&state, false));
        assert!(!exact_paste_queue_modifier_for_platform(&state, true));

        state.control = false;
        state.meta = true;
        assert!(exact_paste_queue_modifier_for_platform(&state, true));
        assert!(!exact_paste_queue_modifier_for_platform(&state, false));

        state.shift = true;
        assert!(!exact_paste_queue_modifier_for_platform(&state, true));
    }

    #[test]
    fn paste_queue_ignores_internal_and_repeated_v_presses() {
        let mut state = PasteQueueInputState::default();
        #[cfg(target_os = "macos")]
        {
            state.meta = true;
        }
        #[cfg(not(target_os = "macos"))]
        {
            state.control = true;
        }

        assert_eq!(
            begin_paste_queue_v_press(&mut state, true, false),
            (true, true)
        );
        assert_eq!(
            begin_paste_queue_v_press(&mut state, true, false),
            (true, false)
        );

        state.v_down = false;
        state.swallow_v = false;
        assert_eq!(
            begin_paste_queue_v_press(&mut state, true, true),
            (false, false)
        );
        assert_eq!(
            begin_paste_queue_v_press(&mut state, false, false),
            (false, false)
        );
    }

    #[test]
    fn macos_paste_queue_interceptor_uses_raw_key_events() {
        assert_eq!(
            paste_queue_interceptor_backend_for_platform(true),
            PasteQueueInterceptorBackend::RawMacEventTap
        );
        assert_eq!(
            paste_queue_interceptor_backend_for_platform(false),
            PasteQueueInterceptorBackend::RdevGrab
        );
    }

    #[test]
    fn rejects_unsupported_shortcut_keys_without_panicking() {
        assert!(validate_main_window_shortcut(Some("Alt+Dead")).is_err());
        assert!(validate_paste_as_text_shortcut(Some("Shift+Unidentified")).is_err());
    }
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
const MACOS_BACKGROUND_AGENT_PLIST: &str = "com.loxonl.vpaste.background.plist";

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn macos_background_agent() -> Option<cocoa::base::id> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    let service_class = Class::get("SMAppService")?;
    let plist_name = unsafe { NSString::alloc(nil).init_str(MACOS_BACKGROUND_AGENT_PLIST) };
    let service: id = unsafe { msg_send![service_class, agentServiceWithPlistName: plist_name] };
    unsafe {
        let _: () = msg_send![plist_name, release];
    }
    (service != nil).then_some(service)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn macos_main_app_service() -> Option<cocoa::base::id> {
    use cocoa::base::{id, nil};
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    let service_class = Class::get("SMAppService")?;
    let service: id = unsafe { msg_send![service_class, mainAppService] };
    (service != nil).then_some(service)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn macos_service_status(service: cocoa::base::id) -> MacosServiceStatus {
    use objc::{msg_send, sel, sel_impl};

    let status: isize = unsafe { msg_send![service, status] };
    macos_service_status_from_raw(status)
}

#[cfg(any(all(target_os = "macos", not(debug_assertions)), test))]
fn macos_service_status_from_raw(status: isize) -> MacosServiceStatus {
    match status {
        0 => MacosServiceStatus::NotRegistered,
        1 => MacosServiceStatus::Enabled,
        2 => MacosServiceStatus::RequiresApproval,
        _ => MacosServiceStatus::NotFound,
    }
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn macos_main_app_service_status() -> Option<MacosServiceStatus> {
    macos_main_app_service().map(macos_service_status)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn macos_service_error(error: cocoa::base::id) -> String {
    use cocoa::base::nil;
    use objc::{msg_send, sel, sel_impl};

    if error == nil {
        return "unknown Service Management error".to_string();
    }
    let description: cocoa::base::id = unsafe { msg_send![error, localizedDescription] };
    nsstring_to_string(description)
        .unwrap_or_else(|| "unknown Service Management error".to_string())
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn macos_background_agent_status() -> Option<MacosServiceStatus> {
    macos_background_agent().map(macos_service_status)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn sync_macos_background_agent(enabled: bool) -> Option<Result<bool, String>> {
    use cocoa::base::{id, nil};
    use objc::{msg_send, sel, sel_impl};

    let service: id = macos_background_agent()?;
    let before = macos_service_status(service);
    if enabled && before == MacosServiceStatus::Enabled {
        return Some(Ok(true));
    }
    if enabled && before == MacosServiceStatus::RequiresApproval {
        return Some(Ok(false));
    }
    if !enabled && before == MacosServiceStatus::NotRegistered {
        return Some(Ok(false));
    }

    let mut error: id = nil;
    let succeeded: bool = unsafe {
        if enabled {
            msg_send![service, registerAndReturnError: &mut error]
        } else {
            msg_send![service, unregisterAndReturnError: &mut error]
        }
    };
    let after = macos_service_status(service);

    if enabled && after == MacosServiceStatus::RequiresApproval {
        info!("macOS background agent is awaiting user approval");
        return Some(Ok(false));
    }
    if succeeded {
        return Some(Ok(after == MacosServiceStatus::Enabled));
    }

    Some(Err(format!(
        "failed to {} macOS background agent: {}",
        if enabled { "register" } else { "unregister" },
        macos_service_error(error)
    )))
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn sync_macos_main_app_service(startup: bool) -> Option<Result<bool, String>> {
    use cocoa::base::{id, nil};
    use objc::{msg_send, sel, sel_impl};

    let service: id = macos_main_app_service()?;

    let before = macos_service_status(service);
    if startup && before == MacosServiceStatus::Enabled {
        return Some(Ok(true));
    }
    if startup && before == MacosServiceStatus::RequiresApproval {
        return Some(Ok(false));
    }
    if !startup && before == MacosServiceStatus::NotRegistered {
        return Some(Ok(false));
    }

    let mut error: id = nil;
    let succeeded: bool = unsafe {
        if startup {
            msg_send![service, registerAndReturnError: &mut error]
        } else {
            msg_send![service, unregisterAndReturnError: &mut error]
        }
    };
    let after = macos_service_status(service);

    if startup && after == MacosServiceStatus::RequiresApproval {
        info!("macOS main app login item is awaiting user approval");
        return Some(Ok(false));
    }
    if succeeded {
        return Some(Ok(after == MacosServiceStatus::Enabled));
    }

    Some(Err(format!(
        "failed to {} macOS main app login item: {}",
        if startup { "register" } else { "unregister" },
        macos_service_error(error)
    )))
}

fn check_autostart_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    if let Some(status) = macos_main_app_service_status() {
        return Ok(status == MacosServiceStatus::Enabled);
    }

    app.autolaunch()
        .is_enabled()
        .map_err(|err| format!("failed to check autostart status: {}", err))
}

fn sync_autostart(app: &tauri::AppHandle, startup: bool) -> Result<bool, String> {
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    {
        if let Some(result) = sync_macos_main_app_service(startup) {
            if result.is_ok() {
                if let Err(err) = app.autolaunch().disable() {
                    error!("Failed to remove legacy macOS LaunchAgent entry: {}", err);
                }
            }
            if startup && result.as_ref().is_ok_and(|enabled| !*enabled) {
                lower_onboarding_permission_window(app);
                let _ = open_login_items_settings();
            }
            return result;
        }
    }

    if startup {
        app.autolaunch()
            .enable()
            .map_err(|err| format!("failed to enable autostart: {}", err))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|err| format!("failed to disable autostart: {}", err))?;
    }
    let enabled = check_autostart_enabled(app)?;
    info!(
        "autostart sync completed (requested: {}, enabled: {})",
        startup, enabled
    );
    Ok(enabled)
}

#[cfg(any(target_os = "windows", test))]
fn is_legacy_autostart_entry(value: &str, current_exe: Option<&str>) -> bool {
    let text = value.replace('/', "\\").to_ascii_lowercase();
    if current_exe
        .filter(|path| !path.is_empty())
        .map(|path| text.contains(&path.replace('/', "\\").to_ascii_lowercase()))
        .unwrap_or(false)
    {
        return false;
    }

    text.contains("cargo")
        || text.contains("target\\debug")
        || text.contains("vpaste-desktop.exe")
        || text.contains("antigravity\\vpaste-desktop")
}

#[cfg(test)]
mod autostart_tests {
    use super::{
        is_legacy_autostart_entry, macos_service_status_from_raw, MacosServiceStatus,
        OnboardingPermissionItemStatus, OnboardingPermissionStatus,
    };

    #[test]
    fn keeps_the_current_debug_autostart_entry() {
        let current = r"E:\Coding\vPaste\src-tauri\target\debug\vPaste.exe";
        assert!(!is_legacy_autostart_entry(
            &format!(r#""{current}""#),
            Some(current)
        ));
    }

    #[test]
    fn removes_another_checkout_debug_autostart_entry() {
        assert!(is_legacy_autostart_entry(
            r#""E:\Coding\old-vPaste\src-tauri\target\debug\vPaste.exe""#,
            Some(r"E:\Coding\vPaste\src-tauri\target\debug\vPaste.exe")
        ));
    }

    #[test]
    fn keeps_a_release_autostart_entry() {
        assert!(!is_legacy_autostart_entry(
            r#""C:\Program Files\vPaste\vPaste.exe""#,
            None
        ));
    }

    #[test]
    fn maps_macos_main_app_service_statuses() {
        assert_eq!(
            macos_service_status_from_raw(0),
            MacosServiceStatus::NotRegistered
        );
        assert_eq!(
            macos_service_status_from_raw(1),
            MacosServiceStatus::Enabled
        );
        assert_eq!(
            macos_service_status_from_raw(2),
            MacosServiceStatus::RequiresApproval
        );
        assert_eq!(
            macos_service_status_from_raw(3),
            MacosServiceStatus::NotFound
        );
    }

    #[test]
    fn onboarding_permissions_include_background_but_not_autostart() {
        let status = OnboardingPermissionStatus {
            background: OnboardingPermissionItemStatus {
                done: false,
                needs_settings: true,
                error: None,
            },
            paste: OnboardingPermissionItemStatus {
                done: false,
                needs_settings: true,
                error: None,
            },
        };
        let value = serde_json::to_value(status).unwrap();

        assert!(value.get("paste").is_some());
        assert!(value.get("background").is_some());
        assert!(value.get("startup").is_none());
    }
}

#[cfg(target_os = "windows")]
fn cleanup_legacy_autostart_entries() {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    let candidates = [
        "vPaste",
        "vpaste",
        "vpaste-desktop",
        "vPaste.exe",
        "vpaste-desktop.exe",
    ];
    let current_exe = std::env::current_exe()
        .ok()
        .and_then(|path| path.to_str().map(str::to_owned));
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(run_key) = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_READ | KEY_SET_VALUE,
    ) else {
        return;
    };
    for name in candidates {
        let Ok(value) = run_key.get_value::<String, _>(name) else {
            continue;
        };
        if is_legacy_autostart_entry(&value, current_exe.as_deref()) {
            let _ = run_key.delete_value(name);
            info!("removed legacy autostart entry: {}", name);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn cleanup_legacy_autostart_entries() {}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: String) -> Result<StorageMigrationInfo, String> {
    let mut config_struct: Config =
        serde_json::from_str(&config).map_err(|err| format!("配置格式无效，无法保存：{}", err))?;
    if runtime_mode::is_portable() {
        config_struct.startup = false;
    }
    validate_shortcut_config(&config_struct)?;

    let previous_config = config::get();
    let previous_history_dir = history_storage_dir();
    let previous_main_shortcut = match parse_optional_shortcut(
        previous_config.shortcut_keys.main_window.as_deref(),
        "当前唤起主窗口",
    ) {
        Ok(shortcut) => shortcut,
        Err(err) => {
            error!(
                "Ignoring invalid previous shortcut while saving config: {}",
                err
            );
            None
        }
    };
    let next_main_shortcut = parse_optional_shortcut(
        config_struct.shortcut_keys.main_window.as_deref(),
        "唤起主窗口",
    )?;
    let previous_paste_queue_shortcut = parse_optional_shortcut(
        previous_config.shortcut_keys.paste_queue_toggle.as_deref(),
        "当前粘贴队列",
    )?;
    let next_paste_queue_shortcut = parse_optional_shortcut(
        config_struct.shortcut_keys.paste_queue_toggle.as_deref(),
        "开关粘贴队列",
    )?;
    let automatic_updates_enabled = config_struct.update_check_enabled;
    let next_language = config_struct.multilingual.clone();
    let next_theme_mode = config_struct.theme_mode.clone();

    // Release both old registrations before acquiring either new one. This keeps
    // swapping the two shortcuts from unregistering the first newly registered key.
    unregister_main_window_shortcut(&app, previous_main_shortcut)?;
    unregister_main_window_shortcut(&app, previous_paste_queue_shortcut)?;
    let registration_info = register_main_window_shortcut(&app, next_main_shortcut)?;
    let paste_queue_registration_info =
        register_main_window_shortcut(&app, next_paste_queue_shortcut)?;
    if !runtime_mode::is_portable() {
        let actual_startup = check_autostart_enabled(&app)?;
        if actual_startup != config_struct.startup {
            let enabled = sync_autostart(&app, config_struct.startup)?;
            if enabled != config_struct.startup {
                return Err(if config_struct.startup {
                    "无法注册开机启动项，开关已保持关闭".to_string()
                } else {
                    "无法移除开机启动项，开关状态未保存".to_string()
                });
            }
        }
    }
    sync_tray_visibility(&app, config_struct.display_tray_icon)?;

    let saved_config = config::update(|current| {
        config_struct.last_update_check_at = current.last_update_check_at.clone();
        *current = config_struct;
    });
    app_updater::set_automatic_updates_enabled(automatic_updates_enabled);
    sync_tray_theme_for_mode(&app, &next_theme_mode);
    let _ = app.emit("language-changed", next_language);
    let _ = app.emit("theme-changed", next_theme_mode);
    let _ = app.emit("clipboard-behavior-config-changed", saved_config);
    if let Err(err) = ensure_history_storage_dirs() {
        error!(
            "Failed to prepare history storage dirs after saving config: {}",
            err
        );
    }
    clipboard::db::init();
    let target_dir = history_storage_dir();
    if previous_history_dir != target_dir || !search::engine::is_ready() {
        if let Err(err) = rebuild_current_search_index() {
            error!("Failed to rebuild search index after changing history storage: {err}");
        }
    }
    Ok(StorageMigrationInfo {
        migrated: false,
        source_dir: target_dir.clone(),
        target_dir,
        merged_items: 0,
        skipped_items: 0,
        copied_files: 0,
        backup_dir: String::new(),
        message: if registration_info.conflict || paste_queue_registration_info.conflict {
            "配置已保存，但快捷键被其他应用占用".to_string()
        } else {
            "配置已保存".to_string()
        },
        shortcut_conflict: registration_info.conflict || paste_queue_registration_info.conflict,
    })
}
#[tauri::command]
fn get_app_data_dir() -> String {
    let data_dir_lock = GLOBAL_APP_DATA_DIR.lock();
    match data_dir_lock {
        Ok(data_dir) => {
            let data_dir = data_dir.clone().take();
            if let Some(data_dir) = data_dir {
                data_dir
            } else {
                panic!("data_dir is none");
            }
        }
        Err(err) => {
            panic!("{:?}", err);
        }
    }
}

fn mark_next_clipboard_change_as_internal() {
    CLIPBOARD_IGNORE_NEXT_CHANGE.store(true, Ordering::SeqCst);
    let reset_delay_ms = {
        #[cfg(target_os = "windows")]
        {
            CLIPBOARD_IGNORE_CHANGES_UNTIL.store(
                now_millis().saturating_add(INTERNAL_CLIPBOARD_IGNORE_WINDOW_MS),
                Ordering::SeqCst,
            );
            INTERNAL_CLIPBOARD_IGNORE_WINDOW_MS
        }
        #[cfg(not(target_os = "windows"))]
        {
            900
        }
    };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(reset_delay_ms));
        CLIPBOARD_IGNORE_NEXT_CHANGE.store(false, Ordering::SeqCst);
    });
}

#[cfg(target_os = "windows")]
fn image_dib_cache_path(path: &str) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    use std::time::UNIX_EPOCH;

    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    let key = hex::encode(hasher.finalize());

    Some(PathBuf::from(app_runtime_dir(&["image_clipboard_cache"])).join(format!("{key}.dib")))
}

#[cfg(target_os = "windows")]
fn read_image_dib_cache(cache_path: &Path) -> Result<Vec<u8>, String> {
    fs::read(cache_path).map_err(|err| format!("read image clipboard cache failed: {err}"))
}

#[cfg(target_os = "windows")]
fn write_image_dib_cache(cache_path: &Path, dib: &[u8]) -> Result<(), String> {
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(cache_path, dib).map_err(|err| format!("write image clipboard cache failed: {err}"))
}

#[cfg(target_os = "windows")]
fn image_png_cache_path(dib_cache_path: &Path) -> PathBuf {
    dib_cache_path.with_extension("png")
}

#[cfg(target_os = "windows")]
fn image_not_png_marker_path(dib_cache_path: &Path) -> PathBuf {
    dib_cache_path.with_extension("not-png")
}

#[cfg(target_os = "windows")]
fn write_image_png_cache(dib_cache_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let png_cache_path = image_png_cache_path(dib_cache_path);
    if let Some(parent) = png_cache_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&png_cache_path, bytes)
        .map_err(|err| format!("write image PNG clipboard cache failed: {err}"))?;
    let _ = fs::remove_file(image_not_png_marker_path(dib_cache_path));
    Ok(())
}

#[cfg(target_os = "windows")]
fn image_clipboard_file_path(path: &str, bytes: &[u8]) -> PathBuf {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(bytes.len().to_le_bytes());
    hasher.update(bytes);
    PathBuf::from(app_runtime_dir(&["image_clipboard_cache"]))
        .join(format!("{}.png", hex::encode(hasher.finalize())))
}

#[cfg(target_os = "windows")]
fn write_image_clipboard_file(path: &str, bytes: &[u8]) -> Result<String, String> {
    let file_path = image_clipboard_file_path(path, bytes);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    if !file_path.exists() {
        fs::write(&file_path, bytes)
            .map_err(|err| format!("write image clipboard file failed: {err}"))?;
    }
    Ok(file_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn mark_image_not_png(dib_cache_path: &Path) {
    let marker_path = image_not_png_marker_path(dib_cache_path);
    if let Some(parent) = marker_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(marker_path, []);
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn png_clipboard_bytes_from_image_bytes(bytes: Vec<u8>) -> Option<Vec<u8>> {
    let mime = image_mime_from_bytes(&bytes);
    if mime == "image/gif" {
        return None;
    }
    if mime == "image/png" {
        return Some(bytes);
    }

    let image = image::load_from_memory(&bytes).ok()?;
    let mut png_bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
        .ok()?;
    Some(png_bytes)
}

#[cfg(target_os = "windows")]
fn cached_or_load_png_bytes(path: &str, dib_cache_path: &Path) -> Result<Option<Vec<u8>>, String> {
    let png_cache_path = image_png_cache_path(dib_cache_path);
    if png_cache_path.exists() {
        return fs::read(&png_cache_path)
            .map(Some)
            .map_err(|err| format!("read image PNG clipboard cache failed: {err}"));
    }
    if image_not_png_marker_path(dib_cache_path).exists() {
        return Ok(None);
    }

    let bytes = history_store::read_file(path)?;
    if let Some(png_bytes) = png_clipboard_bytes_from_image_bytes(bytes) {
        let _ = write_image_png_cache(dib_cache_path, &png_bytes);
        Ok(Some(png_bytes))
    } else {
        mark_image_not_png(dib_cache_path);
        Ok(None)
    }
}

#[cfg(target_os = "windows")]
fn copy_image_to_clipboard_fast(path: &str) -> Result<(), String> {
    use clipboard_win::{
        formats::{FileList, CF_DIB, CF_DIBV5},
        Clipboard, Setter,
    };

    let start = Instant::now();
    let cache_path = image_dib_cache_path(path);
    let mut png_bytes: Option<Vec<u8>> = None;
    let dib = if let Some(cache_path) = cache_path.as_ref() {
        if cache_path.exists() {
            let read_start = Instant::now();
            let dib = read_image_dib_cache(cache_path)?;
            info!(
                "Read image DIB cache in {}ms, bytes={}",
                read_start.elapsed().as_millis(),
                dib.len()
            );
            dib
        } else {
            let convert_start = Instant::now();
            let image_bytes = history_store::read_file(path)?;
            if copy_gif_bytes_to_clipboard_as_file(path, &image_bytes)? {
                info!(
                    "Copied GIF image as file list in {}ms",
                    start.elapsed().as_millis()
                );
                return Ok(());
            }
            let dib = clipboard::windows::image_convert::convert_image_bytes_to_dib(&image_bytes)?;
            if let Some(bytes) = png_clipboard_bytes_from_image_bytes(image_bytes) {
                let _ = write_image_png_cache(cache_path, &bytes);
                png_bytes = Some(bytes);
            } else {
                mark_image_not_png(cache_path);
            }
            info!(
                "Converted image to DIB in {}ms",
                convert_start.elapsed().as_millis()
            );
            let _ = write_image_dib_cache(cache_path, &dib);
            dib
        }
    } else {
        let image_bytes = history_store::read_file(path)?;
        if copy_gif_bytes_to_clipboard_as_file(path, &image_bytes)? {
            info!(
                "Copied GIF image as file list in {}ms",
                start.elapsed().as_millis()
            );
            return Ok(());
        }
        let dib = clipboard::windows::image_convert::convert_image_bytes_to_dib(&image_bytes)?;
        if let Some(bytes) = png_clipboard_bytes_from_image_bytes(image_bytes) {
            png_bytes = Some(bytes);
        }
        dib
    };

    if png_bytes.is_none() {
        if let Some(cache_path) = cache_path.as_ref() {
            png_bytes = cached_or_load_png_bytes(path, cache_path)?;
        }
    }
    let dibv5 = clipboard::windows::image_convert::convert_bitmap_to_dibv5(&dib)
        .map_err(|err| {
            info!("Could not build CF_DIBV5 clipboard payload: {}", err);
            err
        })
        .ok();
    let legacy_dib_compatible = clipboard::windows::image_convert::legacy_dib_is_compatible(&dib)
        .map_err(|err| {
        format!("inspect image alpha for legacy clipboard format failed: {err}")
    })?;

    let clipboard_start = Instant::now();
    let _clipboard = Clipboard::new_attempts(10).map_err(|err| format!("{:?}", err))?;
    mark_next_clipboard_change_as_internal();
    clipboard_win::raw::empty().map_err(|err| {
        error!("Failed to clear clipboard before image restore: {:?}", err);
        format!("{:?}", err)
    })?;
    let mut has_file_drop_format = false;
    if let Some(bytes) = png_bytes.as_ref() {
        match write_image_clipboard_file(path, bytes).and_then(|file_path| {
            FileList
                .write_clipboard(&[file_path])
                .map_err(|err| format!("set image clipboard file list failed: {:?}", err))
        }) {
            Ok(()) => {
                has_file_drop_format = true;
            }
            Err(err) => {
                info!("Could not set image clipboard file list: {}", err);
            }
        }
    }

    let mut has_dibv5_format = false;
    if let Some(bytes) = dibv5.as_ref() {
        match clipboard_win::raw::set_without_clear(CF_DIBV5, bytes) {
            Ok(()) => {
                has_dibv5_format = true;
                if legacy_dib_compatible {
                    if let Err(err) = clipboard_win::raw::set_without_clear(CF_DIB, &dib) {
                        error!("Failed to set image DIB after DIBV5: {:?}", err);
                    }
                }
            }
            Err(err) => {
                error!("Failed to set image DIBV5: {:?}", err);
                if legacy_dib_compatible {
                    clipboard_win::raw::set_without_clear(CF_DIB, &dib).map_err(|err| {
                        error!("Failed to set image DIB: {:?}", err);
                        format!("{:?}", err)
                    })?;
                }
            }
        }
    } else if legacy_dib_compatible {
        clipboard_win::raw::set_without_clear(CF_DIB, &dib).map_err(|err| {
            error!("Failed to set image DIB: {:?}", err);
            format!("{:?}", err)
        })?;
    }
    let has_png_format = png_bytes.is_some();
    if let Some(bytes) = png_bytes.as_ref() {
        if let Some(png_format) = registered_clipboard_format("PNG") {
            let _ = clipboard_win::raw::set_without_clear(png_format, bytes);
        }
    }
    write_internal_clipboard_marker_without_open();
    info!(
        "Copied image to clipboard in {}ms, total {}ms, dib_bytes={}, dibv5={}, legacy_dib={}, png={}, hdrop={}",
        clipboard_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        dib.len(),
        has_dibv5_format,
        legacy_dib_compatible,
        has_png_format,
        has_file_drop_format
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_gif_bytes_to_clipboard_as_file(path: &str, bytes: &[u8]) -> Result<bool, String> {
    use clipboard_win::{formats::FileList, Clipboard, Setter};
    use sha2::{Digest, Sha256};

    let is_gif = infer::get(&bytes)
        .map(|kind| kind.mime_type() == "image/gif")
        .unwrap_or_else(|| path.to_ascii_lowercase().ends_with(".gif"));
    if !is_gif {
        return Ok(false);
    }

    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(bytes.len().to_le_bytes());
    let cache_path = PathBuf::from(app_runtime_dir(&["image_clipboard_cache"]))
        .join(format!("{}.gif", hex::encode(hasher.finalize())));
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&cache_path, bytes).map_err(|err| err.to_string())?;

    let files = vec![cache_path.to_string_lossy().to_string()];
    let _clipboard = Clipboard::new_attempts(10).map_err(|err| format!("{:?}", err))?;
    mark_next_clipboard_change_as_internal();
    clipboard_win::raw::empty().map_err(|err| {
        error!("Failed to clear clipboard before GIF restore: {:?}", err);
        format!("{:?}", err)
    })?;
    FileList.write_clipboard(&files).map_err(|err| {
        error!("Failed to set gif file list: {:?}", err);
        format!("{:?}", err)
    })?;
    write_internal_clipboard_marker_without_open();
    Ok(true)
}

#[cfg(target_os = "windows")]
fn prewarm_image_clipboard_cache_path(path: &str) -> Result<bool, String> {
    const MAX_PREWARM_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

    let Some(cache_path) = image_dib_cache_path(path) else {
        return Ok(false);
    };
    if cache_path.exists()
        && (image_png_cache_path(&cache_path).exists()
            || image_not_png_marker_path(&cache_path).exists())
    {
        return Ok(false);
    }
    if fs::metadata(path)
        .map(|metadata| metadata.len() > MAX_PREWARM_IMAGE_BYTES)
        .unwrap_or(false)
    {
        info!("Skip large image clipboard cache prewarm for {}", path);
        return Ok(false);
    }
    let image_bytes = history_store::read_file(path)?;
    let _ = history_image_metadata_from_bytes(path, &image_bytes);
    let is_gif = infer::get(&image_bytes)
        .map(|kind| kind.mime_type() == "image/gif")
        .unwrap_or_else(|| path.to_ascii_lowercase().ends_with(".gif"));
    if is_gif {
        return Ok(false);
    }
    if let Some(png_bytes) = png_clipboard_bytes_from_image_bytes(image_bytes.clone()) {
        let _ = write_image_png_cache(&cache_path, &png_bytes);
    } else {
        mark_image_not_png(&cache_path);
    }
    let convert_start = Instant::now();
    if !cache_path.exists() {
        let dib = clipboard::windows::image_convert::convert_image_bytes_to_dib(&image_bytes)?;
        write_image_dib_cache(&cache_path, &dib)?;
    }
    info!(
        "Prewarmed image DIB cache in {}ms for {}",
        convert_start.elapsed().as_millis(),
        path
    );
    Ok(true)
}

#[tauri::command]
fn prewarm_image_clipboard_cache(paths: Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(move || {
            for path in paths.into_iter().filter(|path| !path.is_empty()).take(6) {
                if let Err(err) = prewarm_image_clipboard_cache_path(&path) {
                    info!("Skip image clipboard cache prewarm for {}: {}", path, err);
                }
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = paths;
    }
}

#[tauri::command]
fn prewarm_image_preview_cache(paths: Vec<String>) {
    std::thread::spawn(move || {
        for path in paths.into_iter().filter(|path| !path.is_empty()).take(6) {
            let _ = history_image_metadata_for_path(&path);
            if let Err(err) = image_card_preview_asset_path(&path) {
                info!("Skip image preview cache prewarm for {}: {}", path, err);
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    });
}

#[cfg(target_os = "windows")]
fn registered_clipboard_format(name: &str) -> Option<u32> {
    clipboard_win::raw::register_format(name).map(|code| code.get())
}

#[cfg(target_os = "windows")]
fn write_internal_clipboard_marker() {
    let _clipboard = match clipboard_win::Clipboard::new_attempts(10) {
        Ok(clipboard) => clipboard,
        Err(err) => {
            error!("Failed to open clipboard for internal marker: {:?}", err);
            return;
        }
    };

    write_internal_clipboard_marker_without_open();
}

#[cfg(target_os = "windows")]
fn write_internal_clipboard_marker_without_open() {
    let marker = generate_internal_clipboard_marker();
    if let Ok(mut current_marker) = CLIPBOARD_INTERNAL_MARKER.lock() {
        *current_marker = marker;
    }

    match registered_clipboard_format(clipboard::windows::listen::VPASTE_INTERNAL_CLIPBOARD_FORMAT)
    {
        Some(format) => {
            if let Err(err) = clipboard_win::raw::set_without_clear(format, &marker) {
                error!("Failed to write internal clipboard marker: {:?}", err);
            }
        }
        None => error!("Failed to register internal clipboard marker format"),
    }
}

#[cfg(any(test, target_os = "windows"))]
fn generate_internal_clipboard_marker() -> [u8; 16] {
    let mut marker = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut marker);
    marker
}

#[cfg(test)]
mod internal_clipboard_marker_tests {
    use super::*;

    #[test]
    fn generated_internal_clipboard_marker_has_expected_size() {
        let marker = generate_internal_clipboard_marker();

        assert_eq!(marker.len(), 16);
    }
}

fn image_dimensions_from_bytes(bytes: &[u8]) -> Result<(u32, u32), String> {
    image::load_from_memory(&bytes)
        .map(|image| (image.width(), image.height()))
        .map_err(|err| err.to_string())
}

fn image_dimensions_secure(path: &str) -> Result<(u32, u32), String> {
    let bytes = history_store::read_file(path)?;
    image_dimensions_from_bytes(&bytes)
}

fn image_reader_secure(path: &Path) -> Result<image::DynamicImage, String> {
    let bytes = history_store::read_file(path)?;
    image::load_from_memory(&bytes).map_err(|err| err.to_string())
}

fn image_mime_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return "image/x-icon";
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return "image/webp";
    }
    if std::str::from_utf8(bytes)
        .map(|text| text.trim_start().starts_with("<svg"))
        .unwrap_or(false)
    {
        return "image/svg+xml";
    }
    infer::get(bytes)
        .map(|kind| kind.mime_type())
        .unwrap_or("image/png")
}

fn image_extension_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return "ico";
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return "webp";
    }
    if std::str::from_utf8(bytes)
        .map(|text| text.trim_start().starts_with("<svg"))
        .unwrap_or(false)
    {
        return "svg";
    }
    infer::get(bytes)
        .map(|kind| kind.extension())
        .unwrap_or("png")
}

fn image_data_url(path: &str) -> Result<String, String> {
    use base64::{engine::general_purpose, Engine as _};
    let bytes = history_store::read_file(path)?;
    let mime = image_mime_from_bytes(&bytes);
    Ok(format!(
        "data:{};base64,{}",
        mime,
        general_purpose::STANDARD.encode(bytes)
    ))
}

fn plain_cache_file_matches_bytes(path: &Path, bytes: &[u8]) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() == bytes.len() as u64)
        .unwrap_or(false)
}

fn valid_png_cache_file(path: &Path) -> bool {
    image::image_dimensions(path).is_ok()
}

fn publish_image_cache_file(
    cache_path: &Path,
    bytes: &[u8],
    is_current: impl Fn(&Path) -> bool,
) -> Result<(), String> {
    let parent = cache_path
        .parent()
        .ok_or_else(|| "image cache path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let temp_id = IMAGE_PREVIEW_CACHE_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let file_name = cache_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image-cache");
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        temp_id
    ));
    if let Err(err) = fs::write(&temp_path, bytes) {
        let _ = fs::remove_file(&temp_path);
        return Err(err.to_string());
    }

    let publish_result = (|| {
        let _guard = IMAGE_PREVIEW_CACHE_PUBLISH_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if is_current(cache_path) {
            Ok(())
        } else {
            if cache_path.exists() {
                fs::remove_file(cache_path).map_err(|err| err.to_string())?;
            }
            fs::rename(&temp_path, cache_path).map_err(|err| err.to_string())
        }
    })();
    if temp_path.exists() {
        let _ = fs::remove_file(temp_path);
    }
    publish_result
}

fn image_preview_asset_path(path: &str) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let bytes = history_store::read_file(path)?;
    let extension = image_extension_from_bytes(&bytes);
    let mut hasher = DefaultHasher::new();
    "preview-asset-v3".hash(&mut hasher);
    path.hash(&mut hasher);
    // The URL must change even when an edited file retains the same byte length.
    bytes.hash(&mut hasher);
    let cache_dir = PathBuf::from(app_runtime_dir(&["image_preview_cache"]));
    fs::create_dir_all(&cache_dir).map_err(|err| err.to_string())?;
    let cache_path = cache_dir.join(format!("{:x}.{}", hasher.finish(), extension));
    if !plain_cache_file_matches_bytes(&cache_path, &bytes) {
        publish_image_cache_file(&cache_path, &bytes, |candidate| {
            plain_cache_file_matches_bytes(candidate, &bytes)
        })?;
    }
    Ok(cache_path.to_string_lossy().to_string())
}

fn image_metadata_cache_path(path: &str) -> Option<PathBuf> {
    image_preview::metadata_cache_path(path)
}

fn history_image_metadata_from_bytes(
    path: &str,
    bytes: &[u8],
) -> Result<HistoryImageMetadata, String> {
    image_preview::metadata_from_bytes(path, bytes)
}

fn history_image_metadata_for_path(path: &str) -> Result<HistoryImageMetadata, String> {
    image_preview::metadata_for_path(path)
}

fn image_thumbnail_preview_asset_path(path: &str, bytes: &[u8]) -> Result<String, String> {
    use std::io::Cursor;

    let cache_path = image_preview::card_preview_cache_path(path)?;
    if valid_png_cache_file(&cache_path) {
        return Ok(cache_path.to_string_lossy().to_string());
    }

    let image = image_preview::decode_card_image(bytes)?;
    let thumb = image.thumbnail(720, 420);
    let mut png = Vec::new();
    thumb
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| format!("encode card preview failed: {err}"))?;
    publish_image_cache_file(&cache_path, &png, valid_png_cache_file)?;
    Ok(cache_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn wait_for_quick_input_release(
    trigger_key: Option<&str>,
    timeout_ms: u64,
    release_if_still_pressed: bool,
) -> bool {
    let started = Instant::now();
    while is_alt_key_pressed()
        || trigger_key
            .and_then(quick_input_trigger_virtual_key)
            .map(virtual_key_pressed)
            .unwrap_or(false)
    {
        if started.elapsed() >= std::time::Duration::from_millis(timeout_ms) {
            if release_if_still_pressed {
                release_quick_input_keys(trigger_key);
                std::thread::sleep(std::time::Duration::from_millis(30));
                return !is_alt_key_pressed()
                    && !trigger_key
                        .and_then(quick_input_trigger_virtual_key)
                        .map(virtual_key_pressed)
                        .unwrap_or(false);
            }
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    true
}

#[cfg(not(target_os = "windows"))]
fn wait_for_quick_input_release(
    _trigger_key: Option<&str>,
    _timeout_ms: u64,
    _release_if_still_pressed: bool,
) -> bool {
    true
}

#[cfg(target_os = "windows")]
fn release_quick_input_keys(trigger_key: Option<&str>) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_MENU,
    };

    const VK_LMENU_VALUE: u16 = 0xA4;
    const VK_RMENU_VALUE: u16 = 0xA5;

    fn key_up(key: VIRTUAL_KEY) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let mut inputs = vec![
        key_up(VK_MENU),
        key_up(VIRTUAL_KEY(VK_LMENU_VALUE)),
        key_up(VIRTUAL_KEY(VK_RMENU_VALUE)),
    ];
    if let Some(trigger_key) = trigger_key.and_then(quick_input_trigger_virtual_key) {
        inputs.push(key_up(VIRTUAL_KEY(trigger_key as u16)));
    }
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        error!(
            "SendInput released {} of {} quick input keys",
            sent,
            inputs.len()
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn release_quick_input_keys(_trigger_key: Option<&str>) {}

fn image_card_preview_asset_path(path: &str) -> Result<String, String> {
    let cache_path = image_preview::card_preview_cache_path(path)?;
    if valid_png_cache_file(&cache_path) {
        return Ok(cache_path.to_string_lossy().to_string());
    }
    let metadata = history_image_metadata_for_path(path)?;
    if metadata.preview_limited {
        return Err(format!(
            "image preview exceeds automatic budget: {} bytes, {}x{}",
            metadata.source_bytes, metadata.width, metadata.height
        ));
    }
    let _decode_guard = image_preview::decode_lock()?;
    if valid_png_cache_file(&cache_path) {
        return Ok(cache_path.to_string_lossy().to_string());
    }
    let bytes = history_store::read_file(path)?;
    image_thumbnail_preview_asset_path(path, &bytes).or_else(|_| image_preview_asset_path(path))
}

#[cfg(test)]
mod image_cache_tests {
    use super::*;

    #[test]
    fn file_preview_refreshes_equal_size_image_replacements() {
        let _guard = TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().into_owned());
        let source = root.path().join("drawing.bmp");
        let content = serde_json::to_string(&vec![source.to_string_lossy()]).unwrap();
        let preview = || {
            let info = build_file_preview_info(content.clone()).unwrap();
            assert_eq!(info.kind, "single-preview");
            tauri::async_runtime::block_on(history_file_preview_asset_path(info.preview_path))
                .unwrap()
        };

        image::RgbImage::from_pixel(16, 16, image::Rgb([255, 0, 0]))
            .save(&source)
            .unwrap();
        let original_len = fs::metadata(&source).unwrap().len();
        let red = preview();
        assert_eq!(preview(), red);
        let modified = fs::metadata(&red).unwrap().modified().unwrap();
        assert_eq!(preview(), red);
        assert_eq!(fs::metadata(&red).unwrap().modified().unwrap(), modified);

        image::RgbImage::from_pixel(16, 16, image::Rgb([0, 0, 255]))
            .save(&source)
            .unwrap();
        assert_eq!(fs::metadata(&source).unwrap().len(), original_len);
        let blue = preview();
        assert_ne!(blue, red, "changed content needs a fresh webview asset URL");
        assert_eq!(
            image::open(&blue).unwrap().to_rgb8().get_pixel(0, 0).0,
            [0, 0, 255]
        );
        assert_eq!(fs::read(&blue).unwrap(), fs::read(&source).unwrap());
        assert_eq!(preview(), blue);

        image::RgbImage::from_pixel(17, 16, image::Rgb([0, 255, 0]))
            .save(&source)
            .unwrap();
        let green = preview();
        assert_ne!(green, blue);
        assert_eq!(
            image::open(green).unwrap().to_rgb8().get_pixel(0, 0).0,
            [0, 255, 0]
        );
    }

    #[test]
    fn history_image_metadata_uses_persistent_cache() {
        let _guard = TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(app_data.path().to_string_lossy().to_string());

        let source_path = app_data.path().join("source.png");
        let image = image::RgbaImage::from_pixel(3, 2, image::Rgba([12, 34, 56, 255]));
        let mut png = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        history_store::write_file(&source_path, &png).unwrap();

        let source = source_path.to_string_lossy().to_string();
        let metadata = history_image_metadata_for_path(&source).unwrap();
        assert_eq!(metadata.width, 3);
        assert_eq!(metadata.height, 2);
        assert!(!metadata.is_gif);

        let cache_path = image_metadata_cache_path(&source).unwrap();
        assert!(cache_path.exists());
        fs::write(&cache_path, r#"{"width":9,"height":8,"isGif":true}"#).unwrap();

        let cached = history_image_metadata_for_path(&source).unwrap();
        assert_eq!(cached.width, 9);
        assert_eq!(cached.height, 8);
        assert!(cached.is_gif);
    }

    #[test]
    fn image_preview_caches_replace_unrenderable_files() {
        let _guard = TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(app_data.path().to_string_lossy().to_string());

        let source_path = app_data.path().join("source.png");
        let image = image::RgbaImage::from_pixel(12, 8, image::Rgba([12, 34, 56, 255]));
        let mut png = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        history_store::write_file(&source_path, &png).unwrap();
        let source = source_path.to_string_lossy().to_string();

        let preview_path = PathBuf::from(image_preview_asset_path(&source).unwrap());
        history_store::write_file(&preview_path, b"invalid cache").unwrap();
        let repaired_preview = PathBuf::from(image_preview_asset_path(&source).unwrap());
        assert_eq!(preview_path, repaired_preview);
        assert_eq!(fs::read(&repaired_preview).unwrap(), png);

        let card_path = PathBuf::from(image_card_preview_asset_path(&source).unwrap());
        fs::write(&card_path, b"truncated png").unwrap();
        let repaired_card = PathBuf::from(image_card_preview_asset_path(&source).unwrap());
        assert_eq!(card_path, repaired_card);
        let (width, height) = image::image_dimensions(&repaired_card).unwrap();
        assert!(width > 0);
        assert!(height > 0);
    }

    #[test]
    fn oversized_source_metadata_skips_original_file_decode() {
        let _guard = TEST_APP_DATA_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        *GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(app_data.path().to_string_lossy().to_string());
        let source = app_data.path().join("oversized-image.bin");
        let file = fs::File::create(&source).unwrap();
        file.set_len(32 * 1024 * 1024 + 1).unwrap();

        let metadata = history_image_metadata_for_path(source.to_str().unwrap()).unwrap();

        assert_eq!(metadata.source_bytes, 32 * 1024 * 1024 + 1);
        assert!(metadata.preview_limited);
        assert_eq!((metadata.width, metadata.height), (0, 0));
    }
}

#[tauri::command]
async fn history_file_preview_asset_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || image_preview_asset_path(&path))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn history_image_card_preview_asset_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || image_card_preview_asset_path(&path))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn history_image_metadata(path: String) -> Result<HistoryImageMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || history_image_metadata_for_path(&path))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn history_image_dimensions(path: String) -> Result<(u32, u32), String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_image_metadata_for_path(&path).map(|metadata| (metadata.width, metadata.height))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn history_image_is_gif(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_image_metadata_for_path(&path).map(|metadata| metadata.is_gif)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn history_file_data_url(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if history_store::file_len(&path)? > image_preview::CARD_PREVIEW_MAX_SOURCE_BYTES {
            return Err("image exceeds the automatic preview budget".to_string());
        }
        image_data_url(&path)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[allow(dead_code)]
fn is_png_file_by_infer(path: &str) -> bool {
    infer::get_from_path(path)
        .ok()
        .flatten()
        .map(|kind| kind.mime_type() == "image/png")
        .unwrap_or_else(|| path.to_ascii_lowercase().ends_with(".png"))
}

#[cfg(target_os = "windows")]
fn write_registered_clipboard_file(format_name: &str, path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    if !PathBuf::from(path).exists() {
        info!(
            "Skip missing rich clipboard format {}: {}",
            format_name, path
        );
        return Ok(());
    }
    let format = registered_clipboard_format(format_name)
        .ok_or_else(|| format!("register clipboard format failed: {}", format_name))?;
    let bytes = history_store::read_file(path)
        .map_err(|err| format!("read {} failed: {}", format_name, err))?;
    if bytes.is_empty() {
        return Ok(());
    }
    clipboard_win::raw::set_without_clear(format, &bytes)
        .map_err(|err| format!("write {} failed: {:?}", format_name, err))
}

#[cfg(target_os = "windows")]
fn copy_rich_to_clipboard(text: &str, meta: &clipboard::RichClipboardMeta) -> Result<(), String> {
    use clipboard_win::Clipboard;

    let _clipboard = Clipboard::new_attempts(10).map_err(|err| format!("{:?}", err))?;
    clipboard_win::raw::set_string(text).map_err(|err| format!("{:?}", err))?;
    for (format_name, path) in [
        ("HTML Format", meta.html_path.as_str()),
        ("Rich Text Format", meta.rtf_path.as_str()),
        ("PNG", meta.png_path.as_str()),
    ] {
        if let Err(err) = write_registered_clipboard_file(format_name, path) {
            error!("{}", err);
        }
    }
    write_internal_clipboard_marker_without_open();
    Ok(())
}

#[cfg(target_os = "macos")]
fn write_macos_pasteboard_file(
    pasteboard: cocoa::base::id,
    pasteboard_type: &str,
    path: &str,
) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    let bytes = history_store::read_file(path).map_err(|err| {
        format!(
            "read {} rich clipboard file failed: {}",
            pasteboard_type, err
        )
    })?;
    if bytes.is_empty() {
        return Ok(());
    }

    unsafe {
        use cocoa::base::nil;
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};

        let ns_type = NSString::alloc(nil).init_str(pasteboard_type);
        let data: cocoa::base::id = msg_send![
            class!(NSData),
            dataWithBytes:bytes.as_ptr()
            length:bytes.len()
        ];
        let ok: bool = msg_send![pasteboard, setData:data forType:ns_type];
        let _: () = msg_send![ns_type, release];
        if !ok {
            return Err(format!("write {} failed", pasteboard_type));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_rich_to_clipboard(text: &str, meta: &clipboard::RichClipboardMeta) -> Result<(), String> {
    unsafe {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};

        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return Err("macOS pasteboard is not available".to_string());
        }

        let _: isize = msg_send![pasteboard, clearContents];

        let text_type = NSString::alloc(nil).init_str("public.utf8-plain-text");
        let text_value = NSString::alloc(nil).init_str(text);
        let ok: bool = msg_send![pasteboard, setString:text_value forType:text_type];
        let _: () = msg_send![text_value, release];
        let _: () = msg_send![text_type, release];
        if !ok {
            return Err("write public.utf8-plain-text failed".to_string());
        }

        for (pasteboard_type, path) in [
            ("public.html", meta.html_path.as_str()),
            ("public.rtf", meta.rtf_path.as_str()),
        ] {
            if let Err(err) = write_macos_pasteboard_file(pasteboard, pasteboard_type, path) {
                error!("{}", err);
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_files_to_macos_pasteboard(files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Err("file clipboard content is empty".to_string());
    }

    unsafe {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};

        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pasteboard == nil {
            return Err("macOS pasteboard is not available".to_string());
        }

        let _: isize = msg_send![pasteboard, clearContents];

        let file_urls: id = msg_send![class!(NSMutableArray), arrayWithCapacity:files.len()];
        for path in files {
            let ns_path = NSString::alloc(nil).init_str(path);
            let file_url: id = msg_send![class!(NSURL), fileURLWithPath:ns_path];
            let _: () = msg_send![ns_path, release];
            if file_url == nil {
                return Err(format!("create macOS file URL failed: {}", path));
            }
            let _: () = msg_send![file_urls, addObject:file_url];
        }

        let ok: bool = msg_send![pasteboard, writeObjects:file_urls];
        if !ok {
            return Err("write macOS file URLs failed".to_string());
        }

        let filenames_type = NSString::alloc(nil).init_str("NSFilenamesPboardType");
        let legacy_paths: id = msg_send![class!(NSMutableArray), arrayWithCapacity:files.len()];
        for path in files {
            let ns_path = NSString::alloc(nil).init_str(path);
            let _: () = msg_send![legacy_paths, addObject:ns_path];
            let _: () = msg_send![ns_path, release];
        }

        let ok: bool = msg_send![pasteboard, setPropertyList:legacy_paths forType:filenames_type];
        let _: () = msg_send![filenames_type, release];
        if !ok {
            return Err("write macOS legacy filename list failed".to_string());
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn normalize_macos_file_clipboard_paths(files: Vec<String>) -> Vec<String> {
    files
        .into_iter()
        .map(|path| resolve_macos_file_reference_path(&path).unwrap_or(path))
        .collect()
}

#[cfg(target_os = "macos")]
fn resolve_macos_file_reference_path(path: &str) -> Option<String> {
    let value = path.trim();
    if value != "/.file" && !value.starts_with("/.file/") {
        return None;
    }

    let file_url = format!("file://{}", value);
    unsafe {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};

        let ns_value = NSString::alloc(nil).init_str(&file_url);
        let url: id = msg_send![class!(NSURL), URLWithString:ns_value];
        let _: () = msg_send![ns_value, release];
        if url == nil {
            return None;
        }

        let file_path_url: id = msg_send![url, filePathURL];
        if file_path_url == nil {
            return None;
        }

        let resolved_path: id = msg_send![file_path_url, path];
        nsstring_to_string(resolved_path)
            .map(|path| path.trim().trim_matches('\0').to_string())
            .filter(|path| PathBuf::from(path).is_absolute())
            .filter(|path| path != "/.file" && !path.starts_with("/.file/"))
    }
}

#[cfg(target_os = "macos")]
fn nsstring_to_string(value: cocoa::base::id) -> Option<String> {
    if value == cocoa::base::nil {
        return None;
    }

    unsafe {
        use std::ffi::CStr;

        use objc::{msg_send, sel, sel_impl};

        let c_string: *const std::os::raw::c_char = msg_send![value, UTF8String];
        if c_string.is_null() {
            return None;
        }

        Some(CStr::from_ptr(c_string).to_string_lossy().into_owned())
    }
}

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
fn copy(
    app: tauri::AppHandle,
    item: String,
    item_type: String,
    hash: Option<String>,
) -> Result<(), String> {
    if hash.is_some() {
        ensure_history_ready()?;
    }
    let rich_meta = hash.as_deref().and_then(clipboard::rich_clipboard_meta);
    copy_with_rich_meta(app, item, item_type, rich_meta)
}

fn copy_with_rich_meta(
    app: tauri::AppHandle,
    item: String,
    item_type: String,
    rich_meta: Option<clipboard::RichClipboardMeta>,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    info!("Attempting to copy item of type: {}", item_type);

    let mut marked_internal_clipboard_change = false;
    let mut mark_internal = || {
        if !marked_internal_clipboard_change {
            mark_next_clipboard_change_as_internal();
            marked_internal_clipboard_change = true;
        }
    };

    if item_type == "Image" {
        info!("Copying image from path: {}", item);
        #[cfg(target_os = "windows")]
        {
            if let Err(err) = copy_image_to_clipboard_fast(&item) {
                error!("Fast image clipboard copy failed, falling back: {}", err);
                let fallback_start = Instant::now();
                let img = image_reader_secure(Path::new(&item)).map_err(|e| {
                    error!("Failed to decode image: {}", e);
                    e.to_string()
                })?;
                let rgba = img.to_rgba8();
                let width = rgba.width();
                let height = rgba.height();
                let bytes = rgba.into_vec();
                let image = tauri::image::Image::new(&bytes, width, height);
                mark_internal();
                app.clipboard().write_image(&image).map_err(|e| {
                    error!("Failed to set image: {}", e);
                    e.to_string()
                })?;
                write_internal_clipboard_marker();
                info!(
                    "Fallback image clipboard copy consumed {}ms",
                    fallback_start.elapsed().as_millis()
                );
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let fallback_start = Instant::now();
            let img = image_reader_secure(Path::new(&item)).map_err(|e| {
                error!("Failed to decode image: {}", e);
                e.to_string()
            })?;
            let rgba = img.to_rgba8();
            let width = rgba.width();
            let height = rgba.height();
            let bytes = rgba.into_vec();
            let image = tauri::image::Image::new(&bytes, width, height);
            mark_internal();
            app.clipboard().write_image(&image).map_err(|e| {
                error!("Failed to set image: {}", e);
                e.to_string()
            })?;
            info!(
                "Image clipboard copy consumed {}ms",
                fallback_start.elapsed().as_millis()
            );
        }
    } else if item_type == "File" {
        #[cfg(target_os = "windows")]
        {
            use clipboard_win::{formats::FileList, Clipboard, Setter};

            let files = parse_file_clipboard_content(&item)?;
            let missing_paths: Vec<String> = files
                .iter()
                .filter(|path| !PathBuf::from(path).exists())
                .cloned()
                .collect();
            if !missing_paths.is_empty() {
                return Err(format!("源文件不存在：{}", missing_paths.join(", ")));
            }
            mark_internal();
            let _clipboard = Clipboard::new_attempts(10).map_err(|e| format!("{:?}", e))?;
            FileList.write_clipboard(&files).map_err(|e| {
                error!("Failed to set file list: {:?}", e);
                format!("{:?}", e)
            })?;
            write_internal_clipboard_marker();
        }
        #[cfg(target_os = "macos")]
        {
            let files = normalize_macos_file_clipboard_paths(parse_file_clipboard_content(&item)?);
            let missing_paths: Vec<String> = files
                .iter()
                .filter(|path| !PathBuf::from(path).exists())
                .cloned()
                .collect();
            if !missing_paths.is_empty() {
                return Err(format!("源文件不存在：{}", missing_paths.join(", ")));
            }

            mark_internal();
            copy_files_to_macos_pasteboard(&files)?;
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            return Err(
                "file clipboard restore is only implemented on Windows and macOS".to_string(),
            );
        }
    } else {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Some(meta) = rich_meta.as_ref() {
            info!("Copying rich text formats");
            mark_internal();
            return copy_rich_to_clipboard(&item, meta);
        }
        info!("Copying text payload: {} bytes", item.len());
        mark_internal();
        app.clipboard().write_text(item).map_err(|e| {
            error!("Failed to set text: {}", e);
            e.to_string()
        })?;
        #[cfg(target_os = "windows")]
        write_internal_clipboard_marker();
    }
    info!("Copy successful");
    Ok(())
}

#[tauri::command]
async fn copy_history_item(
    app: tauri::AppHandle,
    hash: String,
    plain_text: bool,
) -> Result<(), String> {
    ensure_history_ready()?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = clipboard::plain_text_content(&hash)?;
        let rich_meta = if plain_text {
            None
        } else {
            clipboard::rich_clipboard_meta(&hash)
        };
        copy_with_rich_meta(app, text, "Text".to_string(), rich_meta)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(target_os = "macos")]
fn simulate_paste_shortcut() -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, EventField};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const V_KEY_CODE: u16 = 0x09;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "failed to create CGEventSource".to_string())?;
    let flags = CGEventFlags::CGEventFlagCommand;
    let key_down = CGEvent::new_keyboard_event(source.clone(), V_KEY_CODE, true)
        .map_err(|_| "failed to create paste key down event".to_string())?;
    key_down.set_flags(flags);
    key_down.set_integer_value_field(
        EventField::EVENT_SOURCE_USER_DATA,
        PASTE_QUEUE_MAC_EVENT_MARKER,
    );
    key_down.post(CGEventTapLocation::HID);

    let key_up = CGEvent::new_keyboard_event(source, V_KEY_CODE, false)
        .map_err(|_| "failed to create paste key up event".to_string())?;
    key_up.set_flags(flags);
    key_up.set_integer_value_field(
        EventField::EVENT_SOURCE_USER_DATA,
        PASTE_QUEUE_MAC_EVENT_MARKER,
    );
    key_up.post(CGEventTapLocation::HID);
    Ok(())
}

#[cfg(target_os = "windows")]
fn simulate_paste_shortcut() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL, VK_V,
    };

    fn keyboard_input(key: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let inputs = [
        keyboard_input(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(VK_V, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(VK_V, KEYEVENTF_KEYUP),
        keyboard_input(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err(format!(
            "SendInput sent {} of {} paste events",
            sent,
            inputs.len()
        ));
    }
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn simulate_paste_shortcut() -> Result<(), String> {
    use rdev::{simulate, EventType, Key};

    simulate(&EventType::KeyPress(Key::ControlLeft)).map_err(|e| e.to_string())?;
    simulate(&EventType::KeyPress(Key::KeyV)).map_err(|e| e.to_string())?;
    simulate(&EventType::KeyRelease(Key::KeyV)).map_err(|e| e.to_string())?;
    simulate(&EventType::KeyRelease(Key::ControlLeft)).map_err(|e| e.to_string())?;
    Ok(())
}

fn restore_paste_queue_item(app: tauri::AppHandle, hash: &str) -> Result<(), String> {
    let item = paste_queue::item(hash)?.ok_or_else(|| "粘贴项不存在".to_string())?;
    let rich_meta = paste_queue::rich_clipboard_meta(hash);
    let (content, item_type) = match item.item_type {
        clipboard::item::ItemType::TextFile => {
            (paste_queue::plain_text_content(hash)?, "Text".to_string())
        }
        clipboard::item::ItemType::Link => (
            item.content.split("|||").next().unwrap_or("").to_string(),
            "Link".to_string(),
        ),
        _ => (item.content, item.item_type.to_string()),
    };
    copy_with_rich_meta(app, content, item_type, rich_meta)
}

fn should_prepare_paste_queue_click_target(
    origin: PasteQueueRequestOrigin,
    _clipboard_visible: bool,
) -> bool {
    origin == PasteQueueRequestOrigin::QueueWindow
}

fn should_refresh_paste_queue_click_target(
    origin: PasteQueueRequestOrigin,
    clipboard_visible: bool,
) -> bool {
    origin == PasteQueueRequestOrigin::QueueWindow && !clipboard_visible
}

fn prepare_paste_queue_click_target(app: &tauri::AppHandle, origin: PasteQueueRequestOrigin) {
    if !should_prepare_paste_queue_click_target(origin, CLIPBOARD_VISIBLE.load(Ordering::SeqCst)) {
        return;
    }

    if CLIPBOARD_VISIBLE.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window("clipboard") {
            hide_clipboard_window(&window);
            let started = Instant::now();
            while CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
                && started.elapsed() < std::time::Duration::from_millis(400)
            {
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        }
    }
    restore_foreground_app_before_paste();
    std::thread::sleep(std::time::Duration::from_millis(40));
}

fn process_paste_queue_request_inner(app: &tauri::AppHandle, request: PasteQueueRequest) {
    if !paste_queue::is_active() || request.activation_epoch != paste_queue::activation_epoch() {
        return;
    }
    let hash = match paste_queue::paste_target(request.hash.as_deref()) {
        Ok(Some(hash)) => hash,
        Ok(None) => {
            paste_queue::emit_state(app);
            return;
        }
        Err(err) => {
            paste_queue::set_error(request.hash, err);
            paste_queue::emit_state(app);
            return;
        }
    };

    paste_queue::clear_error();
    paste_queue::set_busy(true);
    paste_queue::emit_state(app);
    let result = restore_paste_queue_item(app.clone(), &hash).and_then(|_| {
        prepare_paste_queue_click_target(app, request.origin);
        PASTE_QUEUE_INTERNAL_PASTE.store(true, Ordering::SeqCst);
        let result = simulate_paste_shortcut();
        std::thread::sleep(std::time::Duration::from_millis(24));
        PASTE_QUEUE_INTERNAL_PASTE.store(false, Ordering::SeqCst);
        result
    });
    match result {
        Ok(()) => {
            if let Err(err) = paste_queue::touch(&hash) {
                error!("failed to touch paste queue item: {err}");
            }
            if let Err(err) = paste_queue::consume(&hash) {
                paste_queue::set_error(Some(hash), err);
            } else if !paste_queue::is_active()
                || request.activation_epoch != paste_queue::activation_epoch()
            {
                // An in-flight paste still commits after exit, but its undo entry
                // belongs to the activation that just ended.
                paste_queue::clear_undo();
            }
        }
        Err(err) => paste_queue::set_error(Some(hash), err),
    }
    paste_queue::set_busy(false);
    paste_queue::emit_state(app);
}

fn process_paste_queue_request(app: &tauri::AppHandle, request: PasteQueueRequest) {
    paste_queue::run_paste_operation(|| process_paste_queue_request_inner(app, request));
}

fn initialize_paste_queue_worker(app: &tauri::AppHandle) {
    let (sender, receiver) = std::sync::mpsc::channel::<PasteQueueRequest>();
    *PASTE_QUEUE_REQUEST_SENDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sender);
    let app = app.clone();
    std::thread::spawn(move || {
        while let Ok(request) = receiver.recv() {
            process_paste_queue_request(&app, request);
        }
    });
}

fn enqueue_paste_queue_request(
    hash: Option<String>,
    origin: PasteQueueRequestOrigin,
) -> Result<(), String> {
    let sender = PASTE_QUEUE_REQUEST_SENDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .ok_or_else(|| "粘贴队列执行器尚未就绪".to_string())?;
    sender
        .send(PasteQueueRequest {
            hash,
            activation_epoch: paste_queue::activation_epoch(),
            origin,
        })
        .map_err(|err| err.to_string())
}

#[cfg(any(not(target_os = "macos"), test))]
#[derive(Default)]
struct PasteQueueInputState {
    control: bool,
    meta: bool,
    shift: bool,
    alt: bool,
    v_down: bool,
    swallow_v: bool,
}

#[cfg(any(not(target_os = "macos"), test))]
fn update_paste_queue_modifier(state: &mut PasteQueueInputState, key: rdev::Key, down: bool) {
    match key {
        rdev::Key::ControlLeft | rdev::Key::ControlRight => state.control = down,
        rdev::Key::MetaLeft | rdev::Key::MetaRight => state.meta = down,
        rdev::Key::ShiftLeft | rdev::Key::ShiftRight => state.shift = down,
        rdev::Key::Alt | rdev::Key::AltGr => state.alt = down,
        _ => {}
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn exact_paste_queue_modifier(state: &PasteQueueInputState) -> bool {
    #[cfg(target_os = "macos")]
    {
        exact_paste_queue_modifier_for_platform(state, true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        exact_paste_queue_modifier_for_platform(state, false)
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn exact_paste_queue_modifier_for_platform(state: &PasteQueueInputState, macos: bool) -> bool {
    if macos {
        state.meta && !state.control && !state.shift && !state.alt
    } else {
        state.control && !state.meta && !state.shift && !state.alt
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn begin_paste_queue_v_press(
    state: &mut PasteQueueInputState,
    active: bool,
    internal: bool,
) -> (bool, bool) {
    let intercept = active && !internal && exact_paste_queue_modifier(state);
    let trigger = intercept && !state.v_down;
    state.v_down = true;
    if intercept {
        state.swallow_v = true;
    }
    (intercept, trigger)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PasteQueueInterceptorBackend {
    RawMacEventTap,
    RdevGrab,
}

fn paste_queue_interceptor_backend_for_platform(macos: bool) -> PasteQueueInterceptorBackend {
    if macos {
        PasteQueueInterceptorBackend::RawMacEventTap
    } else {
        PasteQueueInterceptorBackend::RdevGrab
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct PasteQueueMacInputState {
    v_down: bool,
    swallow_v: bool,
}

#[cfg(target_os = "macos")]
static PASTE_QUEUE_MAC_INPUT_STATE: Mutex<PasteQueueMacInputState> =
    Mutex::new(PasteQueueMacInputState {
        v_down: false,
        swallow_v: false,
    });

#[cfg(target_os = "macos")]
type PasteQueueMacEventTapCallback = unsafe extern "C" fn(
    proxy: *mut std::ffi::c_void,
    event_type: u32,
    event: *mut std::ffi::c_void,
    user_info: *mut std::ffi::c_void,
) -> *mut std::ffi::c_void;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: PasteQueueMacEventTapCallback,
        user_info: *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void;
    fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);
    fn CGEventGetIntegerValueField(event: *mut std::ffi::c_void, field: u32) -> i64;
    fn CGEventGetFlags(event: *mut std::ffi::c_void) -> u64;
    fn CGEventSetType(event: *mut std::ffi::c_void, event_type: u32);
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(
        allocator: *const std::ffi::c_void,
        tap: *mut std::ffi::c_void,
        order: i64,
    ) -> *mut std::ffi::c_void;
    fn CFRunLoopGetCurrent() -> *mut std::ffi::c_void;
    fn CFRunLoopAddSource(
        run_loop: *mut std::ffi::c_void,
        source: *mut std::ffi::c_void,
        mode: *const std::ffi::c_void,
    );
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const std::ffi::c_void;
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn paste_queue_macos_event_callback(
    _proxy: *mut std::ffi::c_void,
    event_type: u32,
    event: *mut std::ffi::c_void,
    _user_info: *mut std::ffi::c_void,
) -> *mut std::ffi::c_void {
    const KEY_DOWN: u32 = 10;
    const KEY_UP: u32 = 11;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    const NULL_EVENT: u32 = 0;
    const V_KEY_CODE: i64 = 0x09;
    const KEYBOARD_EVENT_KEYCODE: u32 = 9;
    const EVENT_SOURCE_USER_DATA: u32 = 42;
    const FLAG_SHIFT: u64 = 0x0002_0000;
    const FLAG_CONTROL: u64 = 0x0004_0000;
    const FLAG_ALTERNATE: u64 = 0x0008_0000;
    const FLAG_COMMAND: u64 = 0x0010_0000;
    const FLAG_SECONDARY_FN: u64 = 0x0080_0000;

    if event_type == TAP_DISABLED_BY_TIMEOUT || event_type == TAP_DISABLED_BY_USER_INPUT {
        let tap = PASTE_QUEUE_MAC_EVENT_TAP.load(Ordering::SeqCst);
        if !tap.is_null() {
            CGEventTapEnable(tap, true);
        }
        return event;
    }
    if event_type != KEY_DOWN && event_type != KEY_UP {
        return event;
    }
    if CGEventGetIntegerValueField(event, KEYBOARD_EVENT_KEYCODE) != V_KEY_CODE {
        return event;
    }
    if CGEventGetIntegerValueField(event, EVENT_SOURCE_USER_DATA) == PASTE_QUEUE_MAC_EVENT_MARKER {
        return event;
    }

    let mut state = PASTE_QUEUE_MAC_INPUT_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if event_type == KEY_DOWN {
        let flags = CGEventGetFlags(event);
        let exact_command = flags & FLAG_COMMAND != 0
            && flags & (FLAG_SHIFT | FLAG_CONTROL | FLAG_ALTERNATE | FLAG_SECONDARY_FN) == 0;
        let intercept = paste_queue::is_active()
            && !PASTE_QUEUE_INTERNAL_PASTE.load(Ordering::SeqCst)
            && exact_command;
        let trigger = intercept && !state.v_down;
        state.v_down = true;
        if intercept {
            state.swallow_v = true;
            if trigger {
                let _ = enqueue_paste_queue_request(None, PasteQueueRequestOrigin::Shortcut);
            }
            CGEventSetType(event, NULL_EVENT);
        }
    } else {
        state.v_down = false;
        if state.swallow_v {
            state.swallow_v = false;
            CGEventSetType(event, NULL_EVENT);
        }
    }
    event
}

#[cfg(target_os = "macos")]
fn run_paste_queue_interceptor() -> Result<(), String> {
    const HID_EVENT_TAP: u32 = 0;
    const HEAD_INSERT_EVENT_TAP: u32 = 0;
    const DEFAULT_EVENT_TAP: u32 = 0;
    const KEY_DOWN: u32 = 10;
    const KEY_UP: u32 = 11;
    let event_mask = (1_u64 << KEY_DOWN) | (1_u64 << KEY_UP);

    unsafe {
        let tap = CGEventTapCreate(
            HID_EVENT_TAP,
            HEAD_INSERT_EVENT_TAP,
            DEFAULT_EVENT_TAP,
            event_mask,
            paste_queue_macos_event_callback,
            std::ptr::null_mut(),
        );
        if tap.is_null() {
            return Err("macOS Event Tap 创建失败".to_string());
        }
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            return Err("macOS Event Tap RunLoop Source 创建失败".to_string());
        }
        PASTE_QUEUE_MAC_EVENT_TAP.store(tap, Ordering::SeqCst);
        let run_loop = CFRunLoopGetCurrent();
        CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        PASTE_QUEUE_INTERCEPTOR_READY.store(true, Ordering::SeqCst);
        CFRunLoopRun();
        PASTE_QUEUE_MAC_EVENT_TAP.store(std::ptr::null_mut(), Ordering::SeqCst);
    }
    Err("macOS Event Tap 已停止".to_string())
}

#[cfg(not(target_os = "macos"))]
fn run_paste_queue_interceptor() -> Result<(), String> {
    let input_state = Mutex::new(PasteQueueInputState::default());
    PASTE_QUEUE_INTERCEPTOR_READY.store(true, Ordering::SeqCst);
    rdev::grab(move |event| {
        let mut state = input_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match event.event_type {
            rdev::EventType::KeyPress(key) => {
                update_paste_queue_modifier(&mut state, key, true);
                if key == rdev::Key::KeyV {
                    let (intercept, trigger) = begin_paste_queue_v_press(
                        &mut state,
                        paste_queue::is_active(),
                        PASTE_QUEUE_INTERNAL_PASTE.load(Ordering::SeqCst),
                    );
                    if intercept {
                        if trigger {
                            let _ = enqueue_paste_queue_request(
                                None,
                                PasteQueueRequestOrigin::Shortcut,
                            );
                        }
                        return None;
                    }
                }
            }
            rdev::EventType::KeyRelease(key) => {
                if key == rdev::Key::KeyV {
                    state.v_down = false;
                    if state.swallow_v {
                        state.swallow_v = false;
                        return None;
                    }
                }
                update_paste_queue_modifier(&mut state, key, false);
            }
            _ => {}
        }
        Some(event)
    })
    .map_err(|err| format!("{err:?}"))
}

fn ensure_paste_queue_interceptor(app: &tauri::AppHandle) -> Result<(), String> {
    if PASTE_QUEUE_INTERCEPTOR_READY.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !PASTE_QUEUE_INTERCEPTOR_STARTING.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::spawn(move || {
            info!(
                "starting paste queue interceptor: {:?}",
                paste_queue_interceptor_backend_for_platform(cfg!(target_os = "macos"))
            );
            let result = run_paste_queue_interceptor();
            PASTE_QUEUE_INTERCEPTOR_READY.store(false, Ordering::SeqCst);
            PASTE_QUEUE_INTERCEPTOR_STARTING.store(false, Ordering::SeqCst);
            if let Err(err) = result {
                paste_queue::set_active(false);
                paste_queue::set_error(None, format!("无法接管系统粘贴快捷键：{err}"));
                paste_queue::hide_window(&app);
                paste_queue::emit_state(&app);
            }
        });
    }
    for _ in 0..25 {
        if PASTE_QUEUE_INTERCEPTOR_READY.load(Ordering::SeqCst) {
            return Ok(());
        }
        if !PASTE_QUEUE_INTERCEPTOR_STARTING.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err("无法启动系统粘贴快捷键拦截".to_string())
}

fn show_paste_queue_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("pasteQueue")
        .ok_or_else(|| "粘贴队列窗口不存在".to_string())?;
    let bounds = app
        .get_webview_window("clipboard")
        .map(|clipboard_window| target_clipboard_screen_bounds(&clipboard_window))
        .unwrap_or_else(|| screen_bounds(&window));
    let x = bounds.x + bounds.width - PASTE_QUEUE_WINDOW_WIDTH - 24.0;
    let y = bounds.y + (bounds.height - PASTE_QUEUE_WINDOW_HEIGHT) / 2.0;
    set_window_size_for_scale(
        &window,
        PASTE_QUEUE_WINDOW_WIDTH,
        PASTE_QUEUE_WINDOW_HEIGHT,
        bounds.scale_factor,
    )?;
    set_window_position_for_scale(&window, x, y, bounds.scale_factor)?;
    window.show().map_err(|err| err.to_string())
}

fn schedule_paste_queue_cleanup(cleanup: paste_queue::DeferredCleanup) {
    if cleanup.is_empty() {
        return;
    }
    drop(tauri::async_runtime::spawn_blocking(move || {
        paste_queue::run_deferred_cleanup(cleanup);
    }));
}

fn deactivate_paste_queue_window(app: &tauri::AppHandle) -> Result<(), String> {
    paste_queue::hide_window(app);
    let cleanup = paste_queue::deactivate_with_deferred_cleanup()?;
    schedule_paste_queue_cleanup(cleanup);
    Ok(())
}

fn set_paste_queue_active_impl(app: &tauri::AppHandle, active: bool) -> Result<(), String> {
    if active {
        if !is_process_trusted_with_prompt(false) {
            if let Some(source_window) = app.get_webview_window("clipboard") {
                let _ = open_onboarding_permission_window(
                    app.clone(),
                    source_window,
                    "paste".to_string(),
                    None,
                    None,
                );
            }
            return Err("需要辅助功能权限才能启用粘贴队列".to_string());
        }
        ensure_paste_queue_interceptor(app)?;
        if !paste_queue::is_active() && !CLIPBOARD_VISIBLE.load(Ordering::SeqCst) {
            record_foreground_app_before_clipboard();
        }
        paste_queue::set_active(true);
        paste_queue::clear_error();
        if let Err(err) = show_paste_queue_window(app) {
            paste_queue::set_active(false);
            return Err(err);
        }
        let generation = PASTE_QUEUE_POINTER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        watch_paste_queue_pointer(app.clone(), generation);
    } else {
        PASTE_QUEUE_POINTER_GENERATION.fetch_add(1, Ordering::SeqCst);
        PASTE_QUEUE_MENU_GENERATION.fetch_add(1, Ordering::SeqCst);
        PASTE_QUEUE_MENU_OPEN.store(false, Ordering::SeqCst);
        deactivate_paste_queue_window(app)?;
    }
    paste_queue::emit_state(app);
    Ok(())
}

#[tauri::command]
fn get_paste_queue_state() -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    paste_queue::state()
}

#[tauri::command]
fn set_paste_queue_menu_open(app: tauri::AppHandle, open: bool) {
    let generation = PASTE_QUEUE_MENU_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    PASTE_QUEUE_MENU_OPEN.store(open, Ordering::SeqCst);
    if open {
        watch_paste_queue_menu_outside_click(app, generation);
    }
}

#[tauri::command]
fn set_paste_queue_active(
    app: tauri::AppHandle,
    active: bool,
) -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    set_paste_queue_active_impl(&app, active)?;
    paste_queue::state()
}

#[tauri::command]
fn add_paste_queue_items(
    app: tauri::AppHandle,
    hashes: Vec<String>,
) -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    paste_queue::run_user_operation(|| paste_queue::add_items(&hashes))?;
    paste_queue::emit_state(&app);
    paste_queue::state()
}

#[tauri::command]
fn reorder_paste_queue(
    app: tauri::AppHandle,
    hashes: Vec<String>,
) -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    paste_queue::run_user_operation(|| paste_queue::reorder(&hashes))?;
    paste_queue::emit_state(&app);
    paste_queue::state()
}

#[tauri::command]
fn reverse_paste_queue(app: tauri::AppHandle) -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    paste_queue::run_user_operation(paste_queue::reverse)?;
    paste_queue::emit_state(&app);
    paste_queue::state()
}

#[tauri::command]
fn remove_paste_queue_item(
    app: tauri::AppHandle,
    hash: String,
) -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    let cleanup =
        paste_queue::run_user_operation(|| paste_queue::remove_item_with_deferred_cleanup(&hash))?;
    paste_queue::emit_state(&app);
    let state = paste_queue::state()?;
    schedule_paste_queue_cleanup(cleanup);
    Ok(state)
}

#[tauri::command]
fn clear_paste_queue(app: tauri::AppHandle) -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    let cleanup = paste_queue::run_user_operation(paste_queue::clear_with_deferred_cleanup)?;
    paste_queue::emit_state(&app);
    let state = paste_queue::state()?;
    schedule_paste_queue_cleanup(cleanup);
    Ok(state)
}

#[tauri::command]
fn paste_queue_item(app: tauri::AppHandle, hash: Option<String>) -> Result<(), String> {
    ensure_history_ready()?;
    if !paste_queue::is_active() {
        return Err("粘贴队列尚未激活".to_string());
    }
    if should_refresh_paste_queue_click_target(
        PasteQueueRequestOrigin::QueueWindow,
        CLIPBOARD_VISIBLE.load(Ordering::SeqCst),
    ) {
        record_foreground_app_before_clipboard();
    }
    enqueue_paste_queue_request(hash, PasteQueueRequestOrigin::QueueWindow)?;
    paste_queue::emit_state(&app);
    Ok(())
}

#[tauri::command]
fn undo_paste_queue_consume(app: tauri::AppHandle) -> Result<paste_queue::PasteQueueState, String> {
    ensure_history_ready()?;
    let _ = paste_queue::run_user_operation(paste_queue::undo_consume)?;
    paste_queue::emit_state(&app);
    paste_queue::state()
}

#[tauri::command]
fn paste(
    _hash: &str,
    restore_alt: Option<bool>,
    trigger_key: Option<String>,
) -> Result<(), String> {
    ensure_history_ready()?;
    let restore_alt = restore_alt.unwrap_or(false);
    let trigger_key = trigger_key.as_deref();
    if !_hash.is_empty() {
        if let Err(err) = clipboard::touch(_hash) {
            error!("Failed to update clipboard item recency: {:?}", err);
        }
    }

    // Wait for window to hide and focus to restore
    std::thread::sleep(std::time::Duration::from_millis(120));

    let alt_released = if restore_alt {
        // Alt quick input is triggered while the user is often still holding Alt
        // after Alt+V and a digit. A synthetic Alt key-up does not reliably clear
        // the physical key state, and sending Ctrl+V while Alt is still down turns
        // into Ctrl+Alt+V for many web inputs. Wait for the real key release.
        wait_for_quick_input_release(trigger_key, 3000, false)
    } else {
        wait_for_quick_input_release(None, 450, true)
    };
    if !alt_released {
        release_quick_input_keys(trigger_key);
        std::thread::sleep(std::time::Duration::from_millis(30));
    }

    restore_foreground_app_before_paste();
    if restore_alt {
        release_quick_input_keys(trigger_key);
        std::thread::sleep(std::time::Duration::from_millis(80));
    }
    std::thread::sleep(std::time::Duration::from_millis(40));

    if let Err(err) = simulate_paste_shortcut() {
        error!("Failed to simulate paste shortcut: {}", err);
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
fn record_text_history(content: String) {
    if ensure_history_ready().is_err() {
        return;
    }
    clipboard::insert_text(content);
}

#[tauri::command]
fn set_window_size(
    window: tauri::Window,
    width: u32,
    height: u32,
    preserve_bottom: Option<bool>,
) -> Result<(), ()> {
    let previous_position = if preserve_bottom.unwrap_or(false) {
        window
            .outer_position()
            .ok()
            .zip(window.inner_size().ok())
            .zip(window.scale_factor().ok())
    } else {
        None
    };
    window
        .set_size(LogicalSize { width, height })
        .map_err(|_| ())?;
    if let Some(((position, size), scale_factor)) = previous_position {
        let previous_height = size.height as f64 / scale_factor;
        let next_y = position.y as f64 / scale_factor - (height as f64 - previous_height);
        let _ = window.set_position(LogicalPosition {
            x: position.x as f64 / scale_factor,
            y: next_y,
        });
    }
    Ok(())
}

#[tauri::command]
fn set_position(window: tauri::Window, position: LogicalPosition<u32>) -> Result<(), ()> {
    match window.set_position(position) {
        Ok(_) => Ok(()),
        Err(_) => Err(()),
    }
}

#[tauri::command]
async fn search(
    keywords: String,
    last_id: u64,
    last_time: Option<u64>,
    limit: usize,
    label: String,
) -> Result<String, String> {
    ensure_history_ready()?;
    let last_time = last_time.unwrap_or(0);
    let generation = SEARCH_COMMAND_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SEARCH_COMMAND_LOCK
            .lock()
            .map_err(|_| "search command lock is poisoned".to_string())?;
        let is_current = || SEARCH_COMMAND_GENERATION.load(Ordering::SeqCst) == generation;
        if !is_current() {
            return Err("search superseded".to_string());
        }
        info!("begin clipboard search {} {}", last_id, last_time);
        let start = Instant::now();
        let Some(mut page) = clipboard::search_with_cancellation(
            &keywords, last_id, last_time, limit, &label, is_current,
        )
        .map_err(|error_msg| {
            error!("{:?}", &error_msg);
            error_msg
        })?
        else {
            return Err("search superseded".to_string());
        };
        page.consumed = start.elapsed().as_millis();
        info!(
            "clipboard search completed consumed_ms={} results={} has_more={}",
            page.consumed,
            page.list.len(),
            page.has_more
        );
        serde_json::to_string(&page).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn clear_history(app: tauri::AppHandle, clear_type: String) -> Result<(), String> {
    ensure_history_ready()?;
    if clear_type == "all" {
        clipboard::db::clear_all().map_err(|e| e.to_string())?;
    } else if clear_type == "images" {
        clipboard::db::clear_images().map_err(|e| e.to_string())?;
    }
    paste_queue::emit_state(&app);
    Ok(())
}

#[tauri::command]
fn simulate_cmd_c() -> Result<(), String> {
    use rdev::{simulate, EventType, Key};

    #[cfg(target_os = "macos")]
    let modifier = Key::MetaLeft;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::ControlLeft;

    simulate(&EventType::KeyPress(modifier)).map_err(|e| e.to_string())?;
    simulate(&EventType::KeyPress(Key::KeyC)).map_err(|e| e.to_string())?;
    simulate(&EventType::KeyRelease(Key::KeyC)).map_err(|e| e.to_string())?;
    simulate(&EventType::KeyRelease(modifier)).map_err(|e| e.to_string())?;

    Ok(())
}

const TRAY_ICON_SIZE: u32 = 128;
#[cfg(target_os = "windows")]
const TRAY_ACCENT_RGBA: [u8; 4] = [11, 134, 255, 255];
#[cfg(target_os = "linux")]
const TRAY_ACCENT_RGBA: [u8; 4] = [30, 146, 238, 255];
#[cfg(target_os = "macos")]
const TRAY_TEMPLATE_RGBA: [u8; 4] = [255, 255, 255, 255];
const TRAY_ICON_MASK: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/vpaste-tray.rgba"));

fn colorize_tray_mask(mask: &[u8], color: [u8; 4]) -> Vec<u8> {
    mask.chunks_exact(4)
        .flat_map(|pixel| {
            let alpha = (u16::from(pixel[3]) * u16::from(color[3]) / 255) as u8;
            [color[0], color[1], color[2], alpha]
        })
        .collect()
}

fn build_tray_icon(paused: bool) -> TauriImage<'static> {
    #[cfg(target_os = "macos")]
    let color = TRAY_TEMPLATE_RGBA;
    #[cfg(not(target_os = "macos"))]
    let color = TRAY_ACCENT_RGBA;
    let pixels = colorize_tray_mask(TRAY_ICON_MASK, color);
    let mut image =
        ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(TRAY_ICON_SIZE, TRAY_ICON_SIZE, pixels)
            .unwrap_or_else(|| ImageBuffer::from_pixel(1, 1, Rgba([0, 0, 0, 0])));
    if paused {
        draw_pause_badge(&mut image);
    }
    let (width, height) = image.dimensions();
    TauriImage::new_owned(image.into_raw(), width, height)
}

#[cfg(test)]
mod tray_icon_tests {
    use super::{colorize_tray_mask, TRAY_ICON_MASK, TRAY_ICON_SIZE};

    #[test]
    fn generated_tray_mask_matches_the_declared_dimensions() {
        assert_eq!(
            TRAY_ICON_MASK.len(),
            (TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4) as usize
        );
        assert!(TRAY_ICON_MASK.chunks_exact(4).any(|pixel| pixel[3] > 0));

        let mut bounds = (TRAY_ICON_SIZE, TRAY_ICON_SIZE, 0, 0);
        for (index, pixel) in TRAY_ICON_MASK.chunks_exact(4).enumerate() {
            if pixel[3] == 0 {
                continue;
            }
            let x = index as u32 % TRAY_ICON_SIZE;
            let y = index as u32 / TRAY_ICON_SIZE;
            bounds.0 = bounds.0.min(x);
            bounds.1 = bounds.1.min(y);
            bounds.2 = bounds.2.max(x);
            bounds.3 = bounds.3.max(y);
        }
        assert_eq!(bounds, (21, 5, 105, 122));
    }

    #[test]
    fn tray_mask_accepts_a_runtime_color() {
        let pixels = colorize_tray_mask(&[0, 0, 0, 0, 0, 0, 0, 128], [11, 134, 255, 255]);

        assert_eq!(pixels, [11, 134, 255, 0, 11, 134, 255, 128]);
    }
}

fn draw_pause_badge(image: &mut ImageBuffer<Rgba<u8>, Vec<u8>>) {
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return;
    }

    let size = width.min(height);
    let radius = (size as f32 * 0.18).max(10.0);
    let center_x = width as f32 - radius - size as f32 * 0.04;
    let center_y = height as f32 - radius - size as f32 * 0.04;
    let shadow_radius = radius + 2.0;
    let red = Rgba([229, 57, 53, 245]);
    let shadow = Rgba([120, 20, 20, 120]);
    let white = Rgba([255, 255, 255, 255]);

    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - center_x;
            let dy = y as f32 + 0.5 - center_y;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance <= radius {
                image.put_pixel(x, y, red);
            } else if distance <= shadow_radius {
                image.put_pixel(x, y, shadow);
            }
        }
    }

    let bar_width = (radius * 0.28).round().max(3.0) as i32;
    let bar_height = (radius * 1.18).round().max(10.0) as i32;
    let gap = (radius * 0.22).round().max(2.0) as i32;
    let top = center_y.round() as i32 - bar_height / 2;
    let left_bar = center_x.round() as i32 - gap / 2 - bar_width;
    let right_bar = center_x.round() as i32 + gap / 2;

    for bar_left in [left_bar, right_bar] {
        for y in top..top + bar_height {
            for x in bar_left..bar_left + bar_width {
                if x >= 0 && y >= 0 && (x as u32) < width && (y as u32) < height {
                    image.put_pixel(x as u32, y as u32, white);
                }
            }
        }
    }
}

fn update_tray_appearance(app: &tauri::AppHandle, paused: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        let icon = build_tray_icon(paused);
        #[cfg(target_os = "macos")]
        let icon_result = tray.set_icon_with_as_template(Some(icon), true);
        #[cfg(not(target_os = "macos"))]
        let icon_result = tray.set_icon(Some(icon));
        if let Err(err) = icon_result {
            error!("failed to update tray icon: {:?}", err);
        }
        let tooltip = if paused { "vPaste - Paused" } else { "vPaste" };
        if let Err(err) = tray.set_tooltip(Some(tooltip)) {
            error!("failed to update tray tooltip: {:?}", err);
        }
    }
}

fn sync_tray_theme_for_mode(_app: &tauri::AppHandle, _theme_mode: &str) {}

fn set_clipboard_history_paused_state(app: &tauri::AppHandle, paused: bool) -> bool {
    CLIPBOARD_HISTORY_PAUSED.store(paused, Ordering::SeqCst);
    update_tray_appearance(app, paused);
    let _ = app.emit(
        "clipboard-history-pause-changed",
        ClipboardHistoryPausePayload { paused },
    );
    paused
}

#[tauri::command]
fn get_clipboard_history_paused() -> bool {
    CLIPBOARD_HISTORY_PAUSED.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_clipboard_history_paused(app: tauri::AppHandle, paused: bool) -> Result<bool, String> {
    Ok(set_clipboard_history_paused_state(&app, paused))
}

#[tauri::command]
fn toggle_clipboard_history_paused(app: tauri::AppHandle) -> Result<bool, String> {
    let paused = !CLIPBOARD_HISTORY_PAUSED.load(Ordering::SeqCst);
    Ok(set_clipboard_history_paused_state(&app, paused))
}

fn show_vpaste_tray_menu(app: &tauri::AppHandle, rect: tauri::Rect) {
    if let Some(window) = app.get_webview_window("trayMenu") {
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let icon_position = rect.position.to_physical::<i32>(scale_factor);
        let icon_size = rect.size.to_physical::<u32>(scale_factor);
        let icon_center_x = icon_position.x + icon_size.width as i32 / 2;
        let icon_bottom_y = icon_position.y + icon_size.height as i32;
        let menu_size = window.outer_size().unwrap_or(tauri::PhysicalSize {
            width: TRAY_MENU_WIDTH as u32,
            height: TRAY_MENU_HEIGHT as u32,
        });
        let cursor = cursor_physical_position();
        let monitor = cursor
            .and_then(|position| {
                app.monitor_from_point(position.x as f64, position.y as f64)
                    .ok()
                    .flatten()
            })
            .or_else(|| window.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten());
        let (min_x, min_y, max_x, max_y) = monitor
            .map(|monitor| {
                let pos = monitor.position();
                let size = monitor.size();
                (
                    pos.x,
                    pos.y,
                    pos.x + size.width as i32 - menu_size.width as i32,
                    pos.y + size.height as i32 - menu_size.height as i32,
                )
            })
            .unwrap_or((0, 0, i32::MAX, i32::MAX));
        #[cfg(target_os = "macos")]
        let (target_x, target_y) = (
            (icon_center_x - menu_size.width as i32 / 2).clamp(min_x, max_x),
            icon_bottom_y.clamp(min_y, max_y),
        );
        #[cfg(not(target_os = "macos"))]
        let (target_x, target_y) = (
            cursor
                .map(|position| position.x + TRAY_MENU_CURSOR_GAP)
                .unwrap_or_else(|| icon_center_x - menu_size.width as i32 / 2)
                .clamp(min_x, max_x),
            cursor
                .map(|position| position.y - menu_size.height as i32 - TRAY_MENU_CURSOR_GAP)
                .unwrap_or(icon_bottom_y)
                .clamp(min_y, max_y),
        );
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: target_x,
            y: target_y,
        }));
        let _ = window.show();
        let _ = window.set_focus();
        watch_tray_menu_outside_click(app.clone());
    }
}

fn install_vpaste_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let tray_icon = build_tray_icon(CLIPBOARD_HISTORY_PAUSED.load(Ordering::SeqCst));

    let tray_builder = tauri::tray::TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(tray_icon)
        .tooltip("vPaste")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button,
                button_state,
                ..
            } = event
            {
                if matches!(button, MouseButton::Left | MouseButton::Right)
                    && button_state == MouseButtonState::Up
                {
                    let app = tray.app_handle();
                    show_vpaste_tray_menu(app, rect);
                }
            }
        });
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);
    let _tray = tray_builder.build(app)?;

    TRAY_ICON_VISIBLE.store(true, Ordering::SeqCst);
    Ok(())
}

fn sync_tray_visibility(app: &tauri::AppHandle, visible: bool) -> Result<bool, String> {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        TRAY_ICON_VISIBLE.store(false, Ordering::SeqCst);
        return Err("tray icon is not installed".to_string());
    };

    tray.set_visible(visible)
        .map_err(|err| format!("failed to set tray visibility: {}", err))?;
    TRAY_ICON_VISIBLE.store(visible, Ordering::SeqCst);
    Ok(TRAY_ICON_VISIBLE.load(Ordering::SeqCst))
}

fn build_test_room_window(handle: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(handle, "testRoom", App("__test-room".into()))
        .title("vPaste 测试间")
        .visible(false)
        .focused(false)
        .inner_size(1080.0, 760.0)
        .min_inner_size(860.0, 620.0)
        .resizable(true)
        .maximizable(true)
        .closable(true)
        .decorations(true)
        .center()
        .build()?;
    apply_vpaste_window_icon(&window);
    Ok(window)
}

fn build_paste_fallback_notice_window(
    handle: &tauri::AppHandle,
) -> tauri::Result<tauri::WebviewWindow> {
    #[cfg(target_os = "macos")]
    let route = "paste-fallback-notice";
    #[cfg(not(target_os = "macos"))]
    let route = "paste-failure-notice";

    let window = WebviewWindowBuilder::new(handle, "pasteFallbackNotice", App(route.into()))
        .title("vPaste")
        .visible(false)
        .focused(false)
        .focusable(false)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .skip_taskbar(true)
        .always_on_top(true)
        .accept_first_mouse(true)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .shadow(false)
        .inner_size(PASTE_FALLBACK_NOTICE_WIDTH, PASTE_FALLBACK_NOTICE_HEIGHT)
        .build()?;
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    let _ = window.set_shadow(false);
    #[cfg(target_os = "macos")]
    {
        set_macos_window_level(&window, 102);
        configure_macos_transparent_window(&window);
    }
    Ok(window)
}

fn build_clipboard_window(handle: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let (screen_x, screen_y, screen_width, screen_height) =
        if let Ok(Some(monitor)) = handle.primary_monitor() {
            let scale_factor = monitor.scale_factor();
            let size = monitor.size();
            let position = monitor.position();
            (
                position.x as f64 / scale_factor,
                position.y as f64 / scale_factor,
                size.width as f64 / scale_factor,
                size.height as f64 / scale_factor,
            )
        } else {
            (0.0, 0.0, DEFAULT_SCREEN_WIDTH, DEFAULT_SCREEN_HEIGHT)
        };

    let window_height = CLIPBOARD_WINDOW_HEIGHT;
    let clipboard_window = WebviewWindowBuilder::new(handle, "clipboard", App("clipboard".into()))
        .title("vPaste")
        .visible(false)
        .focused(false)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .shadow(CLIPBOARD_WINDOW_SHADOW)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .skip_taskbar(true)
        .always_on_top(true)
        .accept_first_mouse(true)
        .disable_drag_drop_handler()
        .inner_size(
            screen_width + CLIPBOARD_HORIZONTAL_BLEED * 2.0,
            window_height,
        )
        .position(
            screen_x - CLIPBOARD_HORIZONTAL_BLEED,
            screen_y + screen_height - window_height,
        );

    #[cfg(target_os = "macos")]
    let clipboard_window = clipboard_window
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay);

    let clipboard_window = clipboard_window.build()?;
    let _ = clipboard_window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    let _ = clipboard_window.set_shadow(CLIPBOARD_WINDOW_SHADOW);
    apply_vpaste_window_icon(&clipboard_window);

    #[cfg(target_os = "macos")]
    {
        set_macos_window_level(&clipboard_window, 101);
        enable_macos_mouse_moved_events(&clipboard_window);
        let window_clone = clipboard_window.clone();
        let _ = clipboard_window.run_on_main_thread(move || {
            use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
            if let Err(e) = apply_vibrancy(
                &window_clone,
                NSVisualEffectMaterial::HudWindow,
                Some(NSVisualEffectState::Active),
                None,
            ) {
                error!("apply_vibrancy error for clipboard: {:?}", e);
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_acrylic;
        let _ = apply_acrylic(&clipboard_window, Some((232, 235, 229, 30)));
    }

    Ok(clipboard_window)
}

fn build_paste_queue_window(handle: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(handle, "pasteQueue", App("paste-queue".into()))
        .title("Paste Queue")
        .visible(false)
        .focused(false)
        .focusable(false)
        .accept_first_mouse(true)
        .fullscreen(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .inner_size(PASTE_QUEUE_WINDOW_WIDTH, PASTE_QUEUE_WINDOW_HEIGHT)
        .always_on_top(true)
        .skip_taskbar(true);
    #[cfg(target_os = "windows")]
    let window = window.shadow(false);
    #[cfg(target_os = "macos")]
    let window = window
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay);
    let window = window.build()?;
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    let _ = window.set_shadow(false);
    apply_vpaste_window_icon(&window);
    #[cfg(target_os = "macos")]
    {
        set_macos_window_level(&window, 102);
        enable_macos_mouse_moved_events(&window);
        configure_macos_transparent_window(&window);
    }
    Ok(window)
}

#[cfg(target_os = "windows")]
fn show_startup_error(message: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let message = message
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let title = "vPaste\0".encode_utf16().collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            HWND(0),
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_startup_error(message: &str) {
    eprintln!("{message}");
}

fn main() {
    match maintenance::try_handle_maintenance_command() {
        Ok(true) => return,
        Ok(false) => {}
        Err(err) => {
            eprintln!("vPaste maintenance command failed: {err}");
            std::process::exit(1);
        }
    }
    let installer_exit_requested = maintenance::installer_exit_requested();

    if let Err(err) = runtime_mode::configure_webview_data_directory() {
        let message = format!("vPaste portable mode could not start:\n\n{err}");
        show_startup_error(&message);
        std::process::exit(1);
    }

    // env_logger::Builder::new()
    //     .filter_level(LevelFilter::Info) // 设置全局最小日志级别为 Info
    //     .init();
    std::panic::set_hook(Box::new(|panic_info| {
        if let Some(location) = panic_info.location() {
            if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
                error!("vpaste panic occurred {} {}", location.to_string(), s)
            } else {
                error!("vpaste panic occurred {}", location.to_string())
            }
        } else {
            info!("panic occurred but can't get location information");
        }
        error!("{:?}", backtrace::Backtrace::new())
    }));

    let context = tauri::generate_context!();
    info!("running vPaste");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if maintenance::installer_exit_requested_for_args(&args) {
                app.exit(0);
                return;
            }
            if let Some(window) = app.get_webview_window("onboardingPermission") {
                let _ = window.hide();
            }
            if let Some(window) = app.get_webview_window("clipboard") {
                show_clipboard_window(&window);
                focus_clipboard_window(&window, "second instance launch");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let config = config::get();
                        if let Some(s) = config.shortcut_keys.main_window {
                            if let Ok(parsed) = s.parse::<Shortcut>() {
                                if shortcut == &parsed {
                                    toggle_clipboard_window(&app);
                                    return;
                                }
                            }
                        }
                        if let Some(s) = config.shortcut_keys.paste_queue_toggle {
                            if let Ok(parsed) = s.parse::<Shortcut>() {
                                if shortcut == &parsed {
                                    let active = !paste_queue::is_active();
                                    if let Err(err) = set_paste_queue_active_impl(&app, active) {
                                        paste_queue::set_error(None, err);
                                        paste_queue::emit_state(&app);
                                    }
                                }
                            }
                        }
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
                if should_reapply_clipboard_size_after_scale_change(
                    window.label(),
                    CLIPBOARD_VISIBLE.load(Ordering::SeqCst),
                ) {
                    if let Some(webview_window) =
                        window.app_handle().get_webview_window(window.label())
                    {
                        reapply_clipboard_size_after_scale_change(&webview_window, *scale_factor);
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "pasteQueue" {
                    api.prevent_close();
                    if let Err(err) = deactivate_paste_queue_window(window.app_handle()) {
                        paste_queue::set_error(None, err);
                    }
                    paste_queue::emit_state(window.app_handle());
                }
                if window.label() == "config" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                if window.label() == "testRoom" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                if window.label() == "clipboardPreview" {
                    api.prevent_close();
                    let _ = window.hide();
                    PREVIEW_PINNED.store(false, Ordering::SeqCst);
                    if let Some(clipboard_window) =
                        window.app_handle().get_webview_window("clipboard")
                    {
                        focus_clipboard_window(&clipboard_window, "preview close requested");
                    }
                }
                if window.label() == "tabEditor" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                if window.label() == "emojiPicker" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                if window.label() == "onboardingPermission" {
                    api.prevent_close();
                    let _ = window.hide();
                    restore_parent_after_permission_guide(window.app_handle());
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "config" {
                    handle_config_focus_lost(window.app_handle().clone());
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "clipboardPreview" {
                    handle_preview_focus_lost(window.app_handle().clone());
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "trayMenu" {
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "emojiPicker" {
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "clipboard"
                    && CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
                    && !clipboard_blur_hide_suppressed()
                {
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(35));
                        if tab_editor_window_active(&app) {
                            return;
                        }
                        if preview_window_visible(&app) {
                            let pinned = PREVIEW_PINNED.load(Ordering::SeqCst);
                            let preview_foreground = app_window_is_foreground(
                                &app,
                                "clipboardPreview",
                                "clipboard blur preview guard",
                            );
                            let clipboard_foreground = app_window_is_foreground(
                                &app,
                                "clipboard",
                                "clipboard blur self guard",
                            );
                            let cursor_inside_app = cursor_inside_app_windows(&app);
                            if pinned
                                || preview_foreground
                                || clipboard_foreground
                                || cursor_inside_app
                            {
                                return;
                            }
                            hide_preview_and_clipboard(&app, "clipboard blur outside app");
                            return;
                        }
                        if let Some(window) = app.get_webview_window("clipboard") {
                            let tauri_focused = window.is_focused().unwrap_or(false);
                            let native_foreground =
                                is_native_window_foreground(&window, "focus-loss hide guard");
                            let tab_editor_active = tab_editor_window_active(&app);
                            if CLIPBOARD_VISIBLE.load(Ordering::SeqCst)
                                && !tauri_focused
                                && !native_foreground
                                && !tab_editor_active
                            {
                                hide_clipboard_window(&window);
                            }
                        }
                    });
                }
            }
        })
        .setup(move |app| {
            if installer_exit_requested {
                app.handle().exit(0);
                return Ok(());
            }
            let default_app_data_dir: PathBuf = app.path().app_local_data_dir().unwrap();
            let app_local_data_dir = runtime_mode::initialize(default_app_data_dir)
                .map_err(|err| io::Error::new(io::ErrorKind::PermissionDenied, err))?;
            if !app_local_data_dir.exists() {
                match fs::create_dir_all(&app_local_data_dir) {
                    Ok(_) => info!("目录已成功创建: {:?}", app_local_data_dir),
                    Err(e) => panic!("创建目录时出错: {:?}", e),
                }
            }
            let app_data_dir = Option::from(
                app_local_data_dir
                    .as_os_str()
                    .to_str()
                    .expect("app_data_path to string failed")
                    .to_string(),
            );
            info!("app_path: {:?}", &app_data_dir);
            *GLOBAL_APP_DATA_DIR.lock().unwrap() = app_data_dir;
            app_updater::start_background_checks(app.handle().clone());
            install_vpaste_tray(app.handle())?;

            // Register user-facing entry points before heavier startup maintenance.
            #[cfg(target_os = "macos")]
            if let Err(err) = refresh_stored_autostart_from_system(app.handle()) {
                error!("Failed to refresh autostart status at startup: {}", err);
            }
            let mut config = config::get();
            if runtime_mode::is_portable() && config.startup {
                config.startup = false;
                config::save(config.clone());
            }
            #[cfg(not(target_os = "macos"))]
            if !runtime_mode::is_portable() {
                if let Err(err) = sync_autostart(app.handle(), config.startup) {
                    error!("Failed to sync autostart at startup: {}", err);
                }
            }
            if let Err(err) = sync_tray_visibility(app.handle(), config.display_tray_icon) {
                error!("Failed to sync tray visibility at startup: {}", err);
            }
            if let Some(s) = config.shortcut_keys.main_window.clone() {
                match parse_optional_shortcut(Some(s.as_str()), "唤起主窗口") {
                    Ok(shortcut) => {
                        let _ = register_main_window_shortcut(app.handle(), shortcut);
                    }
                    Err(err) => error!("Skipping invalid startup shortcut: {}", err),
                }
            }
            if let Some(s) = config.shortcut_keys.paste_queue_toggle.clone() {
                match parse_optional_shortcut(Some(s.as_str()), "开关粘贴队列") {
                    Ok(shortcut) => {
                        let _ = register_main_window_shortcut(app.handle(), shortcut);
                    }
                    Err(err) => error!("Skipping invalid paste queue shortcut: {}", err),
                }
            }
            if let Err(err) = ensure_history_storage_dirs() {
                panic!("创建历史存储目录时出错: {:?}", err);
            }
            let legacy_history = legacy_history_present(Path::new(&history_storage_dir()))
                .unwrap_or_else(|err| {
                    error!("Failed to inspect history format: {err}");
                    true
                });
            LEGACY_HISTORY_BLOCKED.store(legacy_history, Ordering::SeqCst);
            if !legacy_history {
                clipboard::db::init();
                if !search::engine::is_ready() {
                    if let Err(err) = rebuild_current_search_index() {
                        error!("Failed to initialize clipboard search index: {err}");
                    }
                }
            }
            let _ = build_clipboard_window(app.handle())?;
            let _ = build_paste_queue_window(app.handle())?;
            if !legacy_history {
                initialize_paste_queue_worker(app.handle());
            }
            if get_developer_mode() {
                let _ = build_test_room_window(app.handle())?;
            }
            get_app_data_dir();
            let handle = app.handle().clone();

            handle
                .plugin(
                    tauri_plugin_log::Builder::new()
                        .targets([
                            Target::new(TargetKind::Folder {
                                path: app_runtime_dir(&["logs"]).into(),
                                file_name: None,
                            }),
                            Target::new(TargetKind::Stdout),
                        ])
                        .level(LevelFilter::Info)
                        .level_for("tantivy", LevelFilter::Error)
                        .build(),
                )
                .expect("load log plugin error");
            std::thread::spawn(move || {
                let clipboard_window = handle
                    .get_webview_window("clipboard")
                    .unwrap_or_else(|| build_clipboard_window(&handle).unwrap());
                let _paste_fallback_notice_window =
                    build_paste_fallback_notice_window(&handle).unwrap();

                let config_window =
                    WebviewWindowBuilder::new(&handle, "config", App("config".into()))
                        .title("vPaste设置")
                        .visible(false)
                        .fullscreen(false)
                        .focused(false)
                        .resizable(true)
                        .minimizable(false)
                        .maximizable(false)
                        .decorations(false)
                        .transparent(true)
                        .background_color(tauri::window::Color(0, 0, 0, 0))
                        .inner_size(720_f64, 700_f64)
                        .min_inner_size(640_f64, 520_f64)
                        .always_on_top(false);
                #[cfg(target_os = "windows")]
                let config_window = config_window.shadow(false);
                #[cfg(target_os = "macos")]
                let config_window = config_window
                    .hidden_title(true)
                    .title_bar_style(TitleBarStyle::Overlay);

                info!("Attempting to build config window");
                let config_window = config_window.build().unwrap();
                let _ = config_window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                apply_vpaste_window_icon(&config_window);
                #[cfg(target_os = "windows")]
                {
                    let _ = config_window.set_shadow(false);
                }
                #[cfg(target_os = "macos")]
                {
                    let window_clone = config_window.clone();
                    let _ = config_window.run_on_main_thread(move || {
                        use cocoa::base::id;
                        use objc::{msg_send, sel, sel_impl};
                        use window_vibrancy::{
                            apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                        };
                        if let Err(e) = apply_vibrancy(
                            &window_clone,
                            NSVisualEffectMaterial::Sidebar,
                            Some(NSVisualEffectState::Active),
                            Some(ROUNDED_WINDOW_RADIUS),
                        ) {
                            error!("apply_vibrancy error for config: {:?}", e);
                        }
                        if let Ok(ns_window) = window_clone.ns_window() {
                            unsafe {
                                if !ns_window.is_null() {
                                    let ns_window = ns_window as id;
                                    let _: () = msg_send![ns_window, invalidateShadow];
                                }
                            }
                        }
                    });
                }
                info!("Config window built successfully");

                let onboarding_permission_window = WebviewWindowBuilder::new(
                    &handle,
                    "onboardingPermission",
                    App("onboarding-permission".into()),
                )
                .title("vPaste Permission Guide")
                .visible(false)
                .focused(false)
                .decorations(false)
                .transparent(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .resizable(false)
                .minimizable(false)
                .maximizable(false)
                .always_on_top(true)
                .shadow(false)
                .inner_size(940_f64, 430_f64)
                .build()
                .unwrap();
                let _ = onboarding_permission_window
                    .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                let _ = onboarding_permission_window.set_shadow(false);
                let _ = onboarding_permission_window.center();
                apply_vpaste_window_icon(&onboarding_permission_window);
                #[cfg(target_os = "macos")]
                {
                    set_macos_window_level(&onboarding_permission_window, 102);
                    configure_macos_transparent_window(&onboarding_permission_window);
                }

                let tray_menu_window =
                    WebviewWindowBuilder::new(&handle, "trayMenu", App("tray-menu".into()))
                        .title("vPaste Tray")
                        .visible(false)
                        .focused(false)
                        .decorations(false)
                        .transparent(true)
                        .background_color(tauri::window::Color(0, 0, 0, 0))
                        .skip_taskbar(true)
                        .always_on_top(true)
                        .resizable(false)
                        .shadow(false)
                        .inner_size(TRAY_MENU_WIDTH as f64, TRAY_MENU_HEIGHT as f64);
                let tray_menu_window = tray_menu_window.build().unwrap();
                let _ =
                    tray_menu_window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                let _ = tray_menu_window.set_shadow(false);
                apply_vpaste_window_icon(&tray_menu_window);
                #[cfg(target_os = "macos")]
                {
                    set_macos_window_level(&tray_menu_window, 101);
                    configure_macos_transparent_window(&tray_menu_window);
                }

                let emoji_picker_window =
                    WebviewWindowBuilder::new(&handle, "emojiPicker", App("emoji-picker".into()))
                        .title("vPaste Emoji Picker")
                        .visible(false)
                        .focused(false)
                        .decorations(false)
                        .transparent(true)
                        .background_color(tauri::window::Color(0, 0, 0, 0))
                        .skip_taskbar(true)
                        .always_on_top(true)
                        .resizable(false)
                        .shadow(false)
                        .inner_size(
                            EMOJI_PICKER_CONTENT_WIDTH + AUXILIARY_WINDOW_GUTTER * 2.0,
                            EMOJI_PICKER_CONTENT_HEIGHT + AUXILIARY_WINDOW_GUTTER * 2.0,
                        );
                let emoji_picker_window = emoji_picker_window.build().unwrap();
                let _ = emoji_picker_window
                    .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                let _ = emoji_picker_window.set_shadow(false);
                apply_vpaste_window_icon(&emoji_picker_window);
                #[cfg(target_os = "macos")]
                {
                    set_macos_window_level(&emoji_picker_window, 101);
                }

                let tab_editor_window =
                    WebviewWindowBuilder::new(&handle, "tabEditor", App("tab-editor".into()))
                        .title("vPaste Tabs")
                        .visible(false)
                        .focused(false)
                        .decorations(false)
                        .transparent(true)
                        .background_color(tauri::window::Color(0, 0, 0, 0))
                        .skip_taskbar(true)
                        .always_on_top(true)
                        .resizable(false)
                        .shadow(false)
                        .inner_size(
                            TAB_EDITOR_CONTENT_WIDTH + AUXILIARY_WINDOW_GUTTER * 2.0,
                            TAB_EDITOR_DEFAULT_CONTENT_HEIGHT + AUXILIARY_WINDOW_GUTTER * 2.0,
                        );
                let tab_editor_window = tab_editor_window.build().unwrap();
                let _ =
                    tab_editor_window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                let _ = tab_editor_window.set_shadow(false);
                apply_vpaste_window_icon(&tab_editor_window);
                #[cfg(target_os = "macos")]
                {
                    set_macos_window_level(&tab_editor_window, 101);
                }

                if !config.onboarding_completed {
                    if let Err(err) = show_onboarding_window(&handle) {
                        error!("Failed to show onboarding window: {}", err);
                    }
                } else {
                    #[cfg(target_os = "macos")]
                    if let Some(window) = handle.get_webview_window("clipboard") {
                        show_clipboard_window(&window);
                    }
                }

                if !LEGACY_HISTORY_BLOCKED.load(Ordering::SeqCst) {
                    info!("Starting clipboard listener");
                    listen::start(clipboard_window);
                    info!("Clipboard listener started");
                } else {
                    error!("Legacy encrypted history detected; history writes are blocked");
                    let _ = handle.emit(
                        "history-format-status-changed",
                        HistoryFormatStatus {
                            migration_required: true,
                        },
                    );
                }
                std::thread::spawn(|| {
                    migrate_runtime_dirs_out_of_history();
                    cleanup_runtime_caches();
                    cleanup_legacy_autostart_entries();
                });
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            copy,
            copy_history_item,
            record_text_history,
            search,
            paste,
            get_paste_queue_state,
            set_paste_queue_menu_open,
            set_paste_queue_active,
            add_paste_queue_items,
            reorder_paste_queue,
            reverse_paste_queue,
            remove_paste_queue_item,
            clear_paste_queue,
            paste_queue_item,
            undo_paste_queue_consume,
            set_window_size,
            set_position,
            get_app_data_dir,
            get_storage_paths,
            get_history_format_status,
            clear_legacy_history,
            export_history_archive,
            import_history_archive,
            estimate_storage_cleanup,
            cleanup_storage_history,
            list_language_packs,
            get_custom_tabs,
            save_custom_tabs,
            list_recent_app_sources,
            list_recent_app_source_options,
            refresh_link_previews,
            get_config,
            get_developer_mode,
            open_test_room_window,
            close_test_room_window,
            test_room::get_test_room_config,
            test_room::save_test_room_config,
            test_room::write_test_room_groups,
            test_room::copy_test_room_item_to_clipboard,
            test_room::cleanup_test_room_groups,
            test_room::cleanup_today_test_room_case_history,
            test_room::cleanup_test_room_history,
            test_room::run_test_room_case,
            get_onboarding_permission_status,
            enable_onboarding_background_service,
            get_clipboard_history_paused,
            set_clipboard_history_paused,
            toggle_clipboard_history_paused,
            app_updater::get_update_state,
            app_updater::check_for_app_update,
            app_updater::prepare_app_update,
            app_updater::restart_and_install_app_update,
            get_app_version,
            begin_main_shortcut_recording,
            end_main_shortcut_recording,
            check_main_shortcut_registration,
            begin_paste_queue_shortcut_recording,
            end_paste_queue_shortcut_recording,
            check_paste_queue_shortcut_registration,
            save_config,
            clear_history,
            simulate_cmd_c,
            finish_hide_clipboard_window,
            begin_hide_clipboard_window,
            hide_clipboard_if_inactive,
            set_clipboard_blur_hide_suppressed,
            set_onboarding_shortcut_demo_enabled,
            begin_onboarding,
            minimize_current_window,
            open_config_window,
            open_onboarding_window,
            open_onboarding_permission_window,
            hide_onboarding_permission_window,
            show_paste_fallback_notice,
            hide_paste_fallback_notice,
            restore_foreground_app,
            notify_onboarding_permission_status_changed,
            complete_onboarding,
            is_alt_key_pressed,
            is_quick_input_modifier_pressed,
            show_preview_window,
            is_preview_window_visible,
            set_preview_pinned,
            hide_preview_window,
            resize_preview_image_window,
            prewarm_image_clipboard_cache,
            prewarm_image_preview_cache,
            fetch_link_preview_document,
            show_main_panel,
            hide_tray_menu,
            resize_tray_menu,
            open_tab_editor_window,
            open_emoji_picker_window,
            hide_emoji_picker_window,
            hide_tab_editor_window,
            apply_custom_tabs_from_editor,
            quit_app,
            native_drag_file,
            validate_file_item,
            file_preview_info,
            containing_folder_path,
            open_containing_folder,
            reveal_file_in_folder,
            open_url_in_browser,
            ensure_paste_accessibility_permission,
            check_paste_accessibility_permission,
            open_accessibility_settings,
            set_item_favorite,
            list_item_tags,
            create_item_tag,
            rename_item_tag,
            delete_item_tag,
            assign_item_tag,
            remove_item_tag,
            delete_clipboard_item,
            plain_text_content,
            color_conversion_options,
            export_image_item,
            read_preview_text_file,
            history_file_preview_asset_path,
            history_image_card_preview_asset_path,
            history_image_metadata,
            history_image_dimensions,
            history_image_is_gif,
            history_file_data_url
        ])
        .build(context)
        .expect("build vpaste failed")
        .run(|app, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Err(err) = show_main_panel_for_app(app) {
                    error!("Failed to show main panel on macOS reopen: {}", err);
                }
            }
        });
}
