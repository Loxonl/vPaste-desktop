use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::{auxiliary_windows, config};

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(crate) mod layout_check;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PanelSize {
    Small,
    Medium,
    #[default]
    Large,
}

impl PanelSize {
    fn percent(self) -> u8 {
        match self {
            Self::Small => 80,
            Self::Medium => 90,
            Self::Large => 100,
        }
    }

    pub fn scale(self) -> f64 {
        f64::from(self.percent()) / 100.0
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DisplayMetrics {
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale_factor: f64,
    pub logical_width: f64,
    pub logical_height: f64,
    pub work_width: f64,
    pub work_height: f64,
}

impl DisplayMetrics {
    fn from_monitor(monitor: &tauri::Monitor) -> Option<Self> {
        let scale_factor = monitor.scale_factor();
        let size = monitor.size();
        if !scale_factor.is_finite() || scale_factor <= 0.0 || size.width == 0 || size.height == 0 {
            return None;
        }
        let work = monitor.work_area().size;
        let work = if work.width == 0 || work.height == 0 {
            *size
        } else {
            work
        };
        Some(Self {
            pixel_width: size.width,
            pixel_height: size.height,
            scale_factor,
            logical_width: f64::from(size.width) / scale_factor,
            logical_height: f64::from(size.height) / scale_factor,
            work_width: f64::from(work.width) / scale_factor,
            work_height: f64::from(work.height) / scale_factor,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PanelSizeState {
    pub preference: Option<PanelSize>,
    pub recommended: PanelSize,
    pub effective: PanelSize,
    pub display: Option<DisplayMetrics>,
}

// Use the largest preset within one third of the logical work-area height.
// Small is the lower bound; unavailable display information keeps the original size.
fn recommended_size(work_height: f64) -> PanelSize {
    if !work_height.is_finite() || work_height <= 0.0 {
        return PanelSize::Large;
    }
    for size in [PanelSize::Large, PanelSize::Medium] {
        if work_height * 100.0 >= crate::CLIPBOARD_WINDOW_HEIGHT * f64::from(size.percent()) * 3.0 {
            return size;
        }
    }
    PanelSize::Small
}

fn state_for_monitor(monitor: Option<&tauri::Monitor>) -> PanelSizeState {
    let display = monitor.and_then(DisplayMetrics::from_monitor);
    let recommended = display.as_ref().map_or(PanelSize::Large, |display| {
        recommended_size(display.work_height)
    });
    let preference = config::get().clipboard_panel_size;
    PanelSizeState {
        preference,
        recommended,
        effective: preference.unwrap_or(recommended),
        display,
    }
}

fn settings_monitor(app: &tauri::AppHandle) -> Option<tauri::Monitor> {
    app.get_webview_window("config")
        .and_then(|window| {
            crate::source_window_monitor(&window)
                .or_else(|| window.current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten())
}

static PERCENT: AtomicU8 = AtomicU8::new(100);
static PREVIEWING: AtomicBool = AtomicBool::new(false);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(0);
static SESSION: Mutex<Option<u64>> = Mutex::new(None);

pub fn scale() -> f64 {
    f64::from(PERCENT.load(Ordering::SeqCst)) / 100.0
}

pub fn is_previewing() -> bool {
    PREVIEWING.load(Ordering::SeqCst)
}

pub fn use_configured_size(monitor: Option<&tauri::Monitor>) -> PanelSize {
    if is_previewing() {
        return match PERCENT.load(Ordering::SeqCst) {
            80 => PanelSize::Small,
            90 => PanelSize::Medium,
            _ => PanelSize::Large,
        };
    }
    let size = state_for_monitor(monitor).effective;
    PERCENT.store(size.percent(), Ordering::SeqCst);
    size
}

fn validate_source(source: &tauri::WebviewWindow) -> Result<(), String> {
    if source.label() != "config" || !auxiliary_windows::is_open(source) {
        return Err("Panel size previews require the open settings window".into());
    }
    Ok(())
}

fn show_without_activation(
    window: &tauri::WebviewWindow,
    source: &tauri::WebviewWindow,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SW_SHOWNOACTIVATE,
        };
        let panel = window.hwnd().map_err(|err| err.to_string())?;
        let _ = source;
        window
            .set_always_on_top(true)
            .map_err(|err| err.to_string())?;
        unsafe {
            ShowWindow(HWND(panel.0 as isize), SW_SHOWNOACTIVATE);
            SetWindowPos(
                HWND(panel.0 as isize),
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
            .map_err(|err| err.to_string())?;
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::id;
        use objc::{msg_send, sel, sel_impl};
        let panel = window.ns_window().map_err(|err| err.to_string())? as id;
        let settings = source.ns_window().map_err(|err| err.to_string())? as id;
        unsafe {
            let source_level: isize = msg_send![settings, level];
            // Above the main panel (101), previews (102), and DEV monitor (103).
            let level = source_level.saturating_add(1).max(104);
            let _: () = msg_send![panel, setLevel:level];
            let _: () = msg_send![panel, orderFrontRegardless];
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = source;
        window.show().map_err(|err| err.to_string())
    }
}

fn restore_normal_order(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::id;
        use objc::{msg_send, sel, sel_impl};
        if let Ok(panel) = window.ns_window() {
            unsafe {
                let _: () = msg_send![panel as id, setLevel:101isize];
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Err(err) = window.set_always_on_top(true) {
        log::error!("Failed to restore main panel window level: {err}");
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = window;
}

fn apply_preview(
    app: &tauri::AppHandle,
    source: &tauri::WebviewWindow,
    size: PanelSize,
) -> Result<Option<tauri::WebviewWindow>, String> {
    #[cfg(all(debug_assertions, target_os = "macos"))]
    if crate::main_panel_mode::native() {
        PERCENT.store(size.percent(), Ordering::SeqCst);
        crate::native_panel::show_default(app.clone())?;
        return Ok(None);
    }
    let window = app
        .get_webview_window("clipboard")
        .ok_or("Main panel is unavailable")?;
    let bounds = crate::source_window_monitor(source)
        .as_ref()
        .map(crate::screen_bounds_from_monitor)
        .unwrap_or_else(|| crate::screen_bounds(source));
    let layout = crate::clipboard_window_layout(bounds, size.scale());
    #[cfg(target_os = "macos")]
    crate::panel_animation::macos::set_fraction(&window, 0.0)?;
    window.set_focusable(false).map_err(|err| err.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|err| err.to_string())?;
    window
        .set_zoom(size.scale())
        .map_err(|err| err.to_string())?;
    crate::set_window_size_for_scale(&window, layout.width, layout.height, layout.scale_factor)?;
    crate::set_window_position_for_scale(&window, layout.x, layout.target_y, layout.scale_factor)?;
    crate::ui_text_scale::remember(&window, layout.content_scale);
    PERCENT.store(size.percent(), Ordering::SeqCst);
    show_without_activation(&window, source)?;
    Ok(Some(window))
}

fn finish(
    app: &tauri::AppHandle,
    expected_session: Option<u64>,
    commit: Option<PanelSize>,
) -> Result<PanelSizeState, String> {
    let _transition = crate::CLIPBOARD_WINDOW_TRANSITION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut session = SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if session.is_none() {
        return Ok(state_for_monitor(settings_monitor(app).as_ref()));
    }
    if expected_session.is_some_and(|expected| Some(expected) != *session) {
        return Err("Panel size preview was superseded".into());
    }
    *session = None;
    PREVIEWING.store(false, Ordering::SeqCst);
    drop(session);

    // Remove the preview before writing configuration. Neither cancellation nor
    // a failed save may leave a non-interactive main panel on screen.
    #[cfg(all(debug_assertions, target_os = "macos"))]
    if crate::main_panel_mode::native() {
        crate::native_panel::close_preview(app)?;
        crate::CLIPBOARD_VISIBLE.store(false, Ordering::SeqCst);
        crate::background_resources::set_visible(app, false);
    }
    let hidden = if let Some(window) = app.get_webview_window("clipboard") {
        let hidden = crate::finish_hide_window_locked(&window, false);
        restore_normal_order(&window);
        hidden
    } else {
        Ok(())
    };
    let saved = match commit {
        Some(size) if hidden.is_ok() => config::try_update(|config| {
            config.clipboard_panel_size = Some(size);
        })
        .map(Some),
        _ => Ok(None),
    };
    use_configured_size(settings_monitor(app).as_ref());
    if let Some(window) = app.get_webview_window("clipboard") {
        let _ = window.set_zoom(scale());
    }
    hidden?;
    if let Some(saved) = saved? {
        let _ = app.emit("clipboard-behavior-config-changed", saved);
    }
    Ok(state_for_monitor(settings_monitor(app).as_ref()))
}

#[tauri::command]
pub async fn get_clipboard_panel_size_state(
    source_window: tauri::WebviewWindow,
) -> Result<PanelSizeState, String> {
    validate_source(&source_window)?;
    let app = source_window.app_handle().clone();
    auxiliary_windows::on_main_thread(app.clone(), move || {
        validate_source(&source_window)?;
        Ok(state_for_monitor(settings_monitor(&app).as_ref()))
    })
    .await
}

#[tauri::command]
pub async fn reset_clipboard_panel_size(
    source_window: tauri::WebviewWindow,
) -> Result<PanelSizeState, String> {
    validate_source(&source_window)?;
    let app = source_window.app_handle().clone();
    auxiliary_windows::on_main_thread(app.clone(), move || {
        validate_source(&source_window)?;
        if is_previewing() {
            return Err("Finish the panel size preview before restoring automatic sizing".into());
        }
        if config::get().clipboard_panel_size.is_some() {
            let saved = config::try_update(|config| config.clipboard_panel_size = None)?;
            let _ = app.emit("clipboard-behavior-config-changed", saved);
        }
        Ok(state_for_monitor(settings_monitor(&app).as_ref()))
    })
    .await
}

pub fn cancel(app: &tauri::AppHandle) {
    if is_previewing() {
        if let Err(err) = finish(app, None, None) {
            log::error!("Failed to cancel panel size preview: {err}");
        }
    }
}

#[tauri::command]
pub async fn begin_clipboard_size_preview(
    source_window: tauri::WebviewWindow,
    size: PanelSize,
) -> Result<u64, String> {
    validate_source(&source_window)?;
    let app = source_window.app_handle().clone();
    auxiliary_windows::on_main_thread(app.clone(), move || {
        validate_source(&source_window)?;
        if crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst) {
            return Err("Finish onboarding before previewing panel sizes".into());
        }
        if !source_window.is_focused().unwrap_or(false) {
            return Err("Focus the settings window before previewing panel sizes".into());
        }
        let _transition = crate::CLIPBOARD_WINDOW_TRANSITION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if session.is_some() {
            return Err("A panel size preview is already active".into());
        }
        let id = NEXT_SESSION.fetch_add(1, Ordering::SeqCst) + 1;
        *session = Some(id);
        PREVIEWING.store(true, Ordering::SeqCst);
        crate::CLIPBOARD_WINDOW_GENERATION.fetch_add(1, Ordering::SeqCst);
        crate::CLIPBOARD_HIDING.store(false, Ordering::SeqCst);
        drop(session);
        let result = apply_preview(&app, &source_window, size);
        match result {
            Ok(window) => {
                crate::CLIPBOARD_VISIBLE.store(true, Ordering::SeqCst);
                crate::background_resources::set_visible(&app, true);
                if let Some(window) = window {
                    let _ = window.emit("window-show", Option::<serde_json::Value>::None);
                    let _ = window.emit("window-show-complete", ());
                }
                Ok(id)
            }
            Err(err) => {
                drop(_transition);
                cancel(&app);
                Err(err)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn update_clipboard_size_preview(
    source_window: tauri::WebviewWindow,
    session_id: u64,
    size: PanelSize,
) -> Result<(), String> {
    validate_source(&source_window)?;
    let app = source_window.app_handle().clone();
    auxiliary_windows::on_main_thread(app.clone(), move || {
        validate_source(&source_window)?;
        let _transition = crate::CLIPBOARD_WINDOW_TRANSITION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            != Some(session_id)
        {
            return Err("Panel size preview has ended".into());
        }
        apply_preview(&app, &source_window, size).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn finish_clipboard_size_preview(
    source_window: tauri::WebviewWindow,
    session_id: u64,
    size: Option<PanelSize>,
) -> Result<PanelSizeState, String> {
    validate_source(&source_window)?;
    let app = source_window.app_handle().clone();
    auxiliary_windows::on_main_thread(app.clone(), move || finish(&app, Some(session_id), size))
        .await
}

#[cfg(test)]
mod tests {
    use super::{recommended_size, PanelSize};

    #[test]
    fn configurations_without_an_override_follow_the_screen_and_manual_sizes_are_preserved() {
        let mut value = serde_json::to_value(crate::config::Config::default()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("clipboard_panel_size");
        let config: crate::config::Config = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(config.clipboard_panel_size, None);
        for (name, size, scale) in [
            ("small", PanelSize::Small, 0.8),
            ("medium", PanelSize::Medium, 0.9),
            ("large", PanelSize::Large, 1.0),
        ] {
            value["clipboard_panel_size"] = serde_json::json!(name);
            let config: crate::config::Config = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(config.clipboard_panel_size, Some(size));
            assert_eq!(size.scale(), scale);
        }
        value["clipboard_panel_size"] = serde_json::json!("extra_large");
        assert!(serde_json::from_value::<crate::config::Config>(value).is_err());
    }

    #[test]
    fn automatic_sizes_use_logical_work_height_with_bounded_presets() {
        for (physical_height, dpi, taskbar, expected) in [
            (1080.0, 1.0, 48.0, PanelSize::Large),
            (1080.0, 1.25, 48.0, PanelSize::Medium),
            (1080.0, 1.5, 48.0, PanelSize::Small),
            (1440.0, 1.5, 48.0, PanelSize::Large),
            (2160.0, 2.0, 48.0, PanelSize::Large),
            (2160.0, 2.5, 48.0, PanelSize::Medium),
            (2160.0, 3.0, 48.0, PanelSize::Small),
        ] {
            assert_eq!(recommended_size(physical_height / dpi - taskbar), expected);
        }
        assert_eq!(recommended_size(906.0), PanelSize::Large);
        assert_eq!(recommended_size(905.9), PanelSize::Medium);
        assert_eq!(recommended_size(815.4), PanelSize::Medium);
        assert_eq!(recommended_size(815.3), PanelSize::Small);
        for unavailable in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(recommended_size(unavailable), PanelSize::Large);
        }
    }
}
