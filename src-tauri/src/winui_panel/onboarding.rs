//! Temporary shipping tutorial, without a resident main WebView.
use std::sync::atomic::Ordering;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicBool, AtomicU64};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(debug_assertions)]
static PREVIEW_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(debug_assertions)]
static PREVIEW_SESSION: AtomicU64 = AtomicU64::new(0);

fn guide_label() -> &'static str {
    #[cfg(debug_assertions)]
    if PREVIEW_ACTIVE.load(Ordering::SeqCst) {
        return "devTutorial";
    }
    "nativeOnboarding"
}

fn set_tutorial_active(
    window: Option<&tauri::WebviewWindow>,
    preview_session: u64,
) -> Result<(), String> {
    let hwnd = window
        .map(|window| window.hwnd().map(|hwnd| hwnd.0 as usize))
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    let mut data = super::behavior::from_config(&crate::config::get());
    data["tutorialWindow"] = serde_json::json!(hwnd);
    data["tutorialPreviewSession"] = serde_json::json!(preview_session);
    let bytes = serde_json::to_vec(&data).map_err(|error| error.to_string())?;
    let panel = super::api()?;
    // SAFETY: synchronous private preference message; the native STA attaches
    // the live, process-owned content host and computes its actual content rect.
    super::check_hresult("tutorial attachment", unsafe {
        (panel.set_behavior)(bytes.as_ptr(), bytes.len())
    })
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
                super::layout::before_show(&owner)?;
                set_tutorial_active(Some(&window), 0)?;
                super::show_on_ui_thread()?;
                show(&window)
            })
            .await
        }
        .await;
        if let Err(error) = result {
            let _ = set_tutorial_active(None, 0);
            if let Some(window) = app.get_webview_window("nativeOnboarding") {
                let _ = crate::auxiliary_windows::destroy(&window);
            }
            crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
            crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
            log::error!("Failed to open native-session tutorial: {error}");
            let _ = super::show(app);
        }
    });
}

#[cfg(debug_assertions)]
pub(crate) async fn open_preview(
    app: AppHandle,
    mut payload: serde_json::Value,
) -> Result<(), String> {
    if crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst) && !PREVIEW_ACTIVE.load(Ordering::SeqCst) {
        return Err("Finish the active tutorial before opening a Debug preview".into());
    }
    payload["savedTabs"] = crate::get_custom_tabs()?;
    let window =
        crate::auxiliary_windows::ensure(&app, crate::auxiliary_windows::WindowKind::DevTutorial)
            .await?;
    payload["embedded"] = serde_json::json!(true);
    let owner = app.clone();
    let result = crate::auxiliary_windows::on_main_thread(app.clone(), move || {
        if !crate::auxiliary_windows::is_open(&window) {
            return Err("Tutorial preview closed while opening".into());
        }
        super::layout::before_show(&owner)?;
        let session = PREVIEW_SESSION.fetch_add(1, Ordering::SeqCst) + 1;
        set_tutorial_active(Some(&window), session)?;
        payload["previewSession"] = serde_json::json!(session);
        PREVIEW_ACTIVE.store(true, Ordering::SeqCst);
        crate::ONBOARDING_ACTIVE.store(true, Ordering::SeqCst);
        crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
        window
            .emit("dev-tutorial-open", payload)
            .map_err(|error| error.to_string())?;
        super::show_on_ui_thread()?;
        show(&window)
    })
    .await;
    if result.is_err() {
        let _ = close_preview(&app);
    }
    result
}

#[cfg(debug_assertions)]
pub(crate) fn project_preview_filters(
    window: &tauri::WebviewWindow,
    tabs: serde_json::Value,
    session: u64,
) -> Result<(), String> {
    if window.label() != "devTutorial"
        || !crate::auxiliary_windows::is_open(window)
        || !PREVIEW_ACTIVE.load(Ordering::SeqCst)
        || session != PREVIEW_SESSION.load(Ordering::SeqCst)
    {
        return Err("Tutorial preview session is no longer active".into());
    }
    if !tabs.is_array() {
        return Err("Expected an array of tutorial filters".into());
    }
    super::send_response(
        0,
        "tutorialPreviewFilters",
        Ok(serde_json::json!({ "session": session, "items": tabs })),
    );
    Ok(())
}

#[cfg(debug_assertions)]
pub(crate) fn close_preview(app: &AppHandle) -> Result<(), String> {
    if !PREVIEW_ACTIVE.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("devTutorial") {
        // Use the same hide -> detach -> destroy order as real onboarding so
        // completion cannot expose the final illustration on the restored dock.
        window.hide().map_err(|error| error.to_string())?;
        set_tutorial_active(None, 0)?;
        crate::auxiliary_windows::destroy(&window)?;
    } else {
        set_tutorial_active(None, 0)?;
    }
    PREVIEW_ACTIVE.store(false, Ordering::SeqCst);
    crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
    crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
    super::show(app.clone())
}

fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    crate::activate_native_window(window, "native tutorial");
    window.set_focus().map_err(|error| error.to_string())?;
    AsRef::<tauri::Webview>::as_ref(window)
        .set_focus()
        .map_err(|error| error.to_string())?;
    window
        .emit("native-onboarding-shown", ())
        .map_err(|error| error.to_string())
}

fn restore(app: &AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(guide_label()) {
            let result = super::show_on_ui_thread().and_then(|_| show(&window));
            if let Err(error) = result {
                log::error!("Failed to restore tutorial: {error}");
            }
        }
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn show_if_active(app: &AppHandle) -> Option<Result<(), String>> {
    if !crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst) {
        return None;
    }
    // An in-flight ensure owns the first show. Do not open the main panel over it.
    Some(match app.get_webview_window(guide_label()) {
        Some(_) => restore(app),
        None => Ok(()),
    })
}

pub(crate) fn toggle_if_active(app: &AppHandle) -> bool {
    match shortcut_action(
        crate::ONBOARDING_ACTIVE.load(Ordering::SeqCst),
        crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.load(Ordering::SeqCst),
        crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst),
    ) {
        ShortcutAction::MainPanel => return false,
        ShortcutAction::ShowGuide => {
            if let Err(error) = restore(app) {
                log::error!("Failed to restore tutorial: {error}");
            }
        }
        ShortcutAction::HideGuide => {
            if let Err(error) = super::hide() {
                log::error!("Failed to hide tutorial practice: {error}");
            }
        }
    }
    true
}

pub(crate) fn close(app: &AppHandle) -> Result<(), String> {
    crate::ONBOARDING_ACTIVE.store(false, Ordering::SeqCst);
    crate::ONBOARDING_SHORTCUT_DEMO_ENABLED.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("nativeOnboarding") {
        // Hide while it is still attached. Detaching a visible owned HWND can
        // expose its last frame again when its dock owner is restored.
        window.hide().map_err(|error| error.to_string())?;
        set_tutorial_active(None, 0)?;
        crate::auxiliary_windows::destroy(&window)?;
    } else {
        set_tutorial_active(None, 0)?;
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
