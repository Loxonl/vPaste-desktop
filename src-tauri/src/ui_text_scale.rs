//! CSS content sizes and Windows DIPs differ when accessibility text is enlarged.
//! Screen coordinates still use monitor DPI; only content dimensions use this factor.

#[cfg(target_os = "windows")]
use tauri::Manager;

pub(crate) fn content_size(width: f64, height: f64, text_scale: f64) -> (f64, f64) {
    (width * text_scale, height * text_scale)
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn clipboard_height(text_scale: f64, screen_height: f64) -> f64 {
    (crate::CLIPBOARD_WINDOW_HEIGHT * text_scale).min(screen_height)
}

pub(crate) fn current() -> f64 {
    #[cfg(target_os = "windows")]
    return f64::from_bits(windows_text_scale::FACTOR.load(std::sync::atomic::Ordering::SeqCst));
    #[cfg(not(target_os = "windows"))]
    1.0
}

pub(crate) fn logical_size(width: f64, height: f64) -> tauri::LogicalSize<f64> {
    let (width, height) = content_size(width, height, current());
    tauri::LogicalSize::new(width, height)
}

pub(crate) fn value(css_pixels: f64) -> f64 {
    css_pixels * current()
}

#[cfg(target_os = "windows")]
struct AppliedScale(std::sync::atomic::AtomicU64);
#[cfg(target_os = "windows")]
impl tauri::Resource for AppliedScale {}

pub(crate) fn remember(_window: &tauri::WebviewWindow, _scale: f64) {
    remember_native(&AsRef::<tauri::Webview>::as_ref(_window).window(), _scale);
}

pub(crate) fn remember_native(_window: &tauri::Window, _scale: f64) {
    #[cfg(target_os = "windows")]
    {
        let mut table = _window.resources_table();
        let id = table
            .names()
            .find_map(|(id, name)| (name == std::any::type_name::<AppliedScale>()).then_some(id));
        if let Some(id) = id {
            table
                .get::<AppliedScale>(id)
                .expect("window text scale resource")
                .0
                .store(_scale.to_bits(), std::sync::atomic::Ordering::SeqCst);
        } else {
            table.add(AppliedScale(std::sync::atomic::AtomicU64::new(
                _scale.to_bits(),
            )));
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn applied(window: &tauri::WebviewWindow) -> f64 {
    let window = AsRef::<tauri::Webview>::as_ref(window).window();
    let table = window.resources_table();
    let value = table
        .names()
        .find_map(|(id, name)| (name == std::any::type_name::<AppliedScale>()).then_some(id))
        .map(|id| {
            table
                .get::<AppliedScale>(id)
                .expect("window text scale resource")
        });
    value
        .map(|value| f64::from_bits(value.0.load(std::sync::atomic::Ordering::SeqCst)))
        .unwrap_or(1.0)
}

pub(crate) fn set_content_size(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let scale = current();
    let (width, height) = content_size(width, height, scale);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    remember(window, scale);
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn fit_rect(
    rect: (i32, i32, u32, u32),
    work: (i32, i32, u32, u32),
) -> (i32, i32, u32, u32) {
    let (x, y, width, height) = rect;
    let (left, top, work_width, work_height) = work;
    let width = width.min(work_width);
    let height = height.min(work_height);
    let max_x = i64::from(left) + i64::from(work_width - width);
    let max_y = i64::from(top) + i64::from(work_height - height);
    (
        i64::from(x).clamp(i64::from(left), max_x) as i32,
        i64::from(y).clamp(i64::from(top), max_y) as i32,
        width,
        height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_zoom_and_text_size_compose_once_without_changing_the_css_viewport() {
        for panel_zoom in [0.8, 0.9, 1.0] {
            for text_scale in [1.0, 1.25, 1.5, 2.0] {
                let height = clipboard_height(panel_zoom, text_scale, 1200.0);
                for dpi in [1.0, 1.5, 2.0] {
                    let css_height = height * dpi / (dpi * panel_zoom * text_scale);
                    assert!((css_height - crate::CLIPBOARD_WINDOW_HEIGHT).abs() < 0.0001);
                }
            }
        }
    }

    #[test]
    fn combined_panel_and_text_scaling_stays_bounded_on_a_small_screen() {
        assert_eq!(clipboard_height(0.8, 2.0, 400.0), 400.0);
        assert_eq!(clipboard_height(0.8, 1.25, 1200.0), 302.0);
    }

    #[test]
    fn large_windows_fit_negative_origin_monitors_without_changing_coordinate_scale() {
        assert_eq!(
            fit_rect((-3800, 1300, 2200, 1900), (-3840, 0, 3840, 2080)),
            (-3800, 180, 2200, 1900)
        );
        assert_eq!(
            fit_rect((0, 0, 3000, 2000), (0, 0, 1920, 1040)),
            (0, 0, 1920, 1040)
        );
        assert_eq!(
            fit_rect((100, 100, 720, 700), (0, 0, 1920, 1040)),
            (100, 100, 720, 700)
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
mod native_tests;

#[cfg(target_os = "windows")]
pub(crate) use windows_text_scale::plugin;

#[cfg(target_os = "windows")]
mod windows_text_scale {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    };

    use tauri::Manager;
    use windows::core::IInspectable;
    use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
    use windows::UI::ViewManagement::UISettings;

    pub(super) static FACTOR: AtomicU64 = AtomicU64::new(1.0_f64.to_bits());

    struct Watcher {
        settings: UISettings,
        token: EventRegistrationToken,
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            if let Err(error) = self.settings.RemoveTextScaleFactorChanged(self.token) {
                log::warn!("Failed to unsubscribe Windows text scaling: {error}");
            }
        }
    }

    impl Watcher {
        fn new(app: &tauri::AppHandle) -> windows::core::Result<Self> {
            let settings = UISettings::new()?;
            let scale = settings.TextScaleFactor()?;
            FACTOR.store(scale.to_bits(), Ordering::SeqCst);
            log::info!("Windows accessibility text scale: {scale}");
            let app = app.clone();
            let handler = TypedEventHandler::<UISettings, IInspectable>::new(move |sender, _| {
                let Some(settings) = sender else {
                    return Ok(());
                };
                let scale = settings.TextScaleFactor()?;
                let previous = f64::from_bits(FACTOR.swap(scale.to_bits(), Ordering::SeqCst));
                if (scale - previous).abs() < f64::EPSILON {
                    return Ok(());
                }
                log::info!("Windows accessibility text scale changed: {previous} -> {scale}");
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    crate::apply_ui_text_scale_change(&handle, scale);
                }) {
                    log::error!("Failed to apply Windows text scaling: {error}");
                }
                Ok(())
            });
            let token = settings.TextScaleFactorChanged(&handler)?;
            Ok(Self { settings, token })
        }
    }

    pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
        tauri::plugin::Builder::new("ui-text-scale")
            .setup(|app, _| {
                let watcher = match Watcher::new(app) {
                    Ok(watcher) => Some(watcher),
                    Err(error) => {
                        log::error!("Windows text scaling is unavailable: {error}");
                        None
                    }
                };
                app.manage(Mutex::new(watcher));
                Ok(())
            })
            .on_event(|app, event| {
                if matches!(event, tauri::RunEvent::Exit) {
                    // Remove the handler (and its AppHandle) before the app is dropped.
                    app.state::<Mutex<Option<Watcher>>>().lock().unwrap().take();
                }
            })
            .build()
    }
}
