use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconEvent};
use tauri::AppHandle;

use crate::{app_updater, LanguagePackFile};

#[cfg(test)]
mod tests;

static TRACKING: AtomicBool = AtomicBool::new(false);

extern "C" {
    fn vpaste_show_macos_tray_menu(
        status_item: *const c_void,
        bytes: *const u8,
        length: usize,
        display_id: &mut u32,
    ) -> i32;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
enum Action {
    Pause = 1,
    Restart,
    AppStore,
    ShowMain,
    Settings,
    Quit,
}

impl Serialize for Action {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i32(*self as i32)
    }
}

#[derive(Serialize)]
struct Menu {
    title: String,
    rows: Vec<Row>,
}

#[derive(Serialize)]
struct Row {
    id: Action,
    title: String,
    recording: Option<RecordingStatus>,
}

#[derive(Serialize)]
struct RecordingStatus {
    paused: bool,
    label: String,
}

impl Menu {
    fn selection(&self, id: i32) -> Result<Option<Action>, String> {
        if id == 0 {
            return Ok(None);
        }
        self.rows
            .iter()
            .find(|row| row.id as i32 == id)
            .map(|row| Some(row.id))
            .ok_or_else(|| format!("Invalid native tray selection: {id}"))
    }
}

fn menu(
    paused: bool,
    update: Option<Action>,
    language: &str,
    default_language: &str,
    packs: &[LanguagePackFile],
) -> Menu {
    let language = if matches!(language, "Chinese" | "English")
        || packs.iter().any(|pack| pack.code == language)
    {
        language
    } else {
        default_language
    };
    let translate = |key, english: &str, chinese: &str| {
        packs
            .iter()
            .rev()
            .filter(|pack| pack.code == language)
            .find_map(|pack| pack.translations.get(key))
            .map(|value| {
                value
                    .as_str()
                    .filter(|text| !text.is_empty())
                    .unwrap_or(english)
            })
            .unwrap_or(if language == "Chinese" {
                chinese
            } else {
                english
            })
            .to_owned()
    };
    let (pause_title, label) = if paused {
        (
            translate("tray.resumeHistory", "Resume Recording", "恢复记录"),
            translate("tray.historyPausedShort", "Paused", "已暂停"),
        )
    } else {
        (
            translate("tray.pauseHistory", "Pause Recording", "暂停记录"),
            translate("tray.historyRecordingShort", "On", "记录中"),
        )
    };
    let mut rows = Vec::new();
    let mut row = |action: Action, title, recording| {
        rows.push(Row {
            id: action,
            title,
            recording,
        });
    };
    row(
        Action::Pause,
        pause_title,
        Some(RecordingStatus { paused, label }),
    );
    match update {
        Some(Action::Restart) => row(
            Action::Restart,
            translate("tray.updateRestart", "Update and restart", "更新并重启"),
            None,
        ),
        Some(Action::AppStore) => row(
            Action::AppStore,
            translate(
                "tray.updateOpenAppStore",
                "Update in App Store",
                "前往 App Store 更新",
            ),
            None,
        ),
        _ => {}
    }
    row(
        Action::ShowMain,
        translate("tray.showMain", "Show Main Panel", "显示主面板"),
        None,
    );
    row(
        Action::Settings,
        translate("tray.settings", "Settings", "设置"),
        None,
    );
    row(Action::Quit, translate("tray.quit", "Quit", "退出"), None);
    Menu {
        title: translate("tray.menu", "vPaste menu", "vPaste 菜单"),
        rows,
    }
}

fn opens_on(button: MouseButton, state: MouseButtonState) -> bool {
    matches!(button, MouseButton::Left | MouseButton::Right) && state == MouseButtonState::Up
}

pub(super) fn handle_event(tray: &TrayIcon, event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button,
        button_state,
        ..
    } = event
    else {
        return;
    };
    if !opens_on(button, button_state) || TRACKING.swap(true, Ordering::AcqRel) {
        return;
    }
    let tray = tray.clone();
    tauri::async_runtime::spawn(async move {
        let app = tray.app_handle().clone();
        // Tauri holds its tray listener lock during handle_event. Enter AppKit tracking
        // on a later main-thread turn, and dispatch actions only after tracking ends.
        let selection = tauri::async_runtime::spawn_blocking(move || show(&tray)).await;
        TRACKING.store(false, Ordering::Release);
        let result = match selection {
            Ok(Ok(Some((action, display_id)))) => dispatch(app, action, display_id).await,
            Ok(Ok(None)) => Ok(()),
            Ok(Err(error)) => Err(error),
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = result {
            log::error!("macOS tray menu: {error}");
        }
    });
}

fn current_menu(update: Option<Action>) -> Menu {
    let language = crate::config::get().multilingual;
    #[cfg(debug_assertions)]
    let language = crate::native_panel::developer::preview_language().unwrap_or(language);
    let packs = crate::list_language_packs().unwrap_or_else(|error| {
        log::warn!("Failed to load tray translations: {error}");
        Vec::new()
    });
    menu(
        crate::get_clipboard_history_paused(),
        update,
        &language,
        &crate::config::default_language(),
        &packs,
    )
}

fn show(tray: &TrayIcon) -> Result<Option<(Action, u32)>, String> {
    let state = app_updater::get_update_state(tray.app_handle().clone());
    let update = if state.tray_restart_ready() {
        Some(Action::Restart)
    } else if state.tray_store_update_available() {
        Some(Action::AppStore)
    } else {
        None
    };
    let menu = current_menu(update);
    let data = serde_json::to_vec(&menu).map_err(|error| error.to_string())?;
    let (id, display_id) = tray
        .with_inner_tray_icon(move |inner| {
            let mut display_id = 0;
            let Some(item) = inner.ns_status_item() else {
                return (0, 0);
            };
            // with_inner_tray_icon runs on AppKit's main thread and retains the status
            // item and the encoded menu until Swift's synchronous tracking returns.
            let id = unsafe {
                vpaste_show_macos_tray_menu(
                    std::ptr::from_ref(&*item).cast(),
                    data.as_ptr(),
                    data.len(),
                    &mut display_id,
                )
            };
            (id, display_id)
        })
        .map_err(|error| error.to_string())?;
    Ok(menu.selection(id)?.map(|action| (action, display_id)))
}

async fn dispatch(app: AppHandle, action: Action, display_id: u32) -> Result<(), String> {
    match action {
        Action::Pause => crate::toggle_clipboard_history_paused(app).map(|_| ()),
        Action::Restart => app_updater::restart_and_install_app_update(app).await,
        Action::AppStore => app_updater::open_app_store_update(),
        Action::ShowMain => crate::show_main_panel_for_app(&app),
        Action::Settings => {
            let monitor = if display_id == 0 {
                app.primary_monitor().ok().flatten()
            } else {
                let bounds = core_graphics::display::CGDisplay::new(display_id).bounds();
                app.monitor_from_point(
                    bounds.origin.x + bounds.size.width / 2.0,
                    bounds.origin.y + bounds.size.height / 2.0,
                )
                .ok()
                .flatten()
            };
            crate::open_config_window_from_source_monitor(app, None, None, monitor).await
        }
        Action::Quit => {
            crate::quit_app(app);
            Ok(())
        }
    }
}
