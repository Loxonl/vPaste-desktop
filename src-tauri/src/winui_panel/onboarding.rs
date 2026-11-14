//! Temporary shipping tutorial, without a resident main WebView.
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

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
                crate::center_window_on_monitor(&window, super::current_monitor(&owner))?;
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
