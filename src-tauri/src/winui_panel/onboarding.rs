//! Temporary shipping tutorial, without a resident main WebView.
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy)]
struct PhysicalRect {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

fn fit_window_in_panel(
    monitor: PhysicalRect,
    panel: PhysicalRect,
    window_width: u32,
    window_height: u32,
) -> (i32, i32, u32, u32) {
    fn axis_position(
        screen_start: i64,
        screen_end: i64,
        panel_start: i64,
        panel_end: i64,
        size: u32,
    ) -> i32 {
        let size = i64::from(size);
        let desired = panel_start + (panel_end - panel_start - size) / 2;
        desired.clamp(screen_start, (screen_end - size).max(screen_start)) as i32
    }

    let fitted_width = window_width.min((monitor.right - monitor.left) as u32);
    let fitted_height = window_height.min((monitor.bottom - monitor.top) as u32);
    (
        axis_position(
            monitor.left,
            monitor.right,
            panel.left,
            panel.right,
            fitted_width,
        ),
        axis_position(
            monitor.top,
            monitor.bottom,
            panel.top,
            panel.bottom,
            fitted_height,
        ),
        fitted_width,
        fitted_height,
    )
}

fn position_on_panel(
    window: &tauri::WebviewWindow,
    monitor: Option<tauri::Monitor>,
) -> Result<(), String> {
    let Some(monitor) = monitor else {
        return crate::center_window_on_monitor(window, None);
    };
    crate::center_window_on_monitor(window, Some(monitor.clone()))?;

    let position = monitor.position();
    let size = monitor.size();
    let screen = PhysicalRect {
        left: i64::from(position.x),
        top: i64::from(position.y),
        right: i64::from(position.x) + i64::from(size.width),
        bottom: i64::from(position.y) + i64::from(size.height),
    };
    let panel_layout = crate::clipboard_window_layout(
        crate::screen_bounds_from_monitor(&monitor),
        crate::panel_size::scale(),
    );
    let (_, panel_height) = crate::clipboard_window_physical_size(panel_layout);
    let panel = PhysicalRect {
        left: screen.left,
        top: screen.bottom - i64::from(panel_height),
        right: screen.right,
        bottom: screen.bottom,
    };
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let (x, y, width, height) =
        fit_window_in_panel(screen, panel, window_size.width, window_size.height);
    if window_size.width != width || window_size.height != height {
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }))
            .map_err(|error| error.to_string())?;
    }
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|error| error.to_string())
}

#[derive(Debug, PartialEq, Eq)]
enum ShortcutAction {
    MainPanel,
    ShowGuide,
    HideGuide,
}

fn shortcut_action(active: bool, demo: bool, visible: bool) -> ShortcutAction {
    if !active {
        ShortcutAction::MainPanel
    } else if demo && visible {
        ShortcutAction::HideGuide
    } else {
        ShortcutAction::ShowGuide
    }
}

pub(crate) fn open(app: AppHandle) {
    if let Some(result) = show_if_active(&app) {
        if let Err(error) = result {
            log::error!("Failed to restore tutorial: {error}");
        }
        return;
    }
    crate::ONBOARDING_ACTIVE.store(true, Ordering::SeqCst);
    crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let result = async {
            let window = crate::auxiliary_windows::ensure(
                &app,
                crate::auxiliary_windows::WindowKind::NativeOnboarding,
            )
            .await?;
            let owner = app.clone();
            crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                super::hide()?;
                position_on_panel(&window, super::current_monitor(&owner))?;
                show(&window)
            })
            .await
        }
        .await;
        if let Err(error) = result {
            crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
            crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
            log::error!("Failed to open native-session tutorial: {error}");
            let _ = super::show(app);
        }
    });
}

fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    crate::activate_native_window(window, "native tutorial");
    window.set_focus().map_err(|error| error.to_string())?;
    AsRef::<tauri::Webview>::as_ref(window)
        .set_focus()
        .map_err(|error| error.to_string())
}

pub(crate) fn show_if_active(app: &AppHandle) -> Option<Result<(), String>> {
    if !crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst) {
        return None;
    }
    // An in-flight ensure owns the first show. Do not open the main panel over it.
    Some(match app.get_webview_window("nativeOnboarding") {
        Some(window) => show(&window),
        None => Ok(()),
    })
}

pub(crate) fn toggle_if_active(app: &AppHandle) -> bool {
    let window = app.get_webview_window("nativeOnboarding");
    match shortcut_action(
        crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst),
        crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.load(Ordering::SeqCst),
        window
            .as_ref()
            .is_some_and(|window| window.is_visible().unwrap_or(false)),
    ) {
        ShortcutAction::MainPanel => return false,
        ShortcutAction::ShowGuide => {
            if let Some(window) = window {
                if let Err(error) = show(&window) {
                    log::error!("Failed to restore tutorial: {error}");
                }
            }
        }
        ShortcutAction::HideGuide => {
            if let Some(window) = window {
                if let Err(error) = window.hide() {
                    log::error!("Failed to hide tutorial practice: {error}");
                }
            }
        }
    }
    true
}

pub(crate) fn close(app: &AppHandle) -> Result<(), String> {
    crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
    crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("nativeOnboarding") {
        crate::auxiliary_windows::destroy(&window)?;
    }
    super::show(app.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tutorial_window_centers_on_the_bottom_panel_and_stays_on_screen() {
        let monitor = PhysicalRect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        let panel = PhysicalRect {
            left: -1920,
            top: 778,
            right: 0,
            bottom: 1080,
        };
        assert_eq!(
            fit_window_in_panel(monitor, panel, 1000, 360),
            (-1460, 720, 1000, 360)
        );
    }

    #[test]
    fn tutorial_window_shrinks_to_fit_small_monitors_and_stays_near_the_panel() {
        let monitor = PhysicalRect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
        };
        let panel = PhysicalRect {
            left: 0,
            top: 300,
            right: 800,
            bottom: 600,
        };
        assert_eq!(
            fit_window_in_panel(monitor, panel, 1000, 360),
            (0, 240, 800, 360)
        );
        assert_eq!(
            fit_window_in_panel(monitor, panel, 1000, 900),
            (0, 0, 800, 600)
        );
    }

    #[test]
    fn shortcut_practice_can_hide_and_reopen_without_losing_its_owner() {
        assert_eq!(shortcut_action(true, true, true), ShortcutAction::HideGuide);
        assert_eq!(
            shortcut_action(true, true, false),
            ShortcutAction::ShowGuide
        );
        assert_eq!(
            shortcut_action(true, false, true),
            ShortcutAction::ShowGuide
        );
        assert_eq!(
            shortcut_action(true, false, false),
            ShortcutAction::ShowGuide
        );
        assert_eq!(
            shortcut_action(false, true, false),
            ShortcutAction::MainPanel
        );
    }
}
