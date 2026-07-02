use crate::config::get;
use tauri::{App, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub fn _register(app: &App) {
    let _global_shortcut = app.handle().global_shortcut();
    let config = get();
    let shortcut_keys = config.shortcut_keys;
    if shortcut_keys.main_window.is_some() {
        let _window = app.get_webview_window("");
    }
}
