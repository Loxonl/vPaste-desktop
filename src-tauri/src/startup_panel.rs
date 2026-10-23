use std::ffi::OsStr;
use std::sync::Mutex;

use tauri::AppHandle;

#[derive(Default)]
struct StartupPanel {
    ready: bool,
    requested: bool,
    shown: bool,
}

impl StartupPanel {
    fn take_show(&mut self) -> bool {
        let show = self.ready && self.requested && !self.shown;
        self.shown |= show;
        show
    }
}

static PANEL: Mutex<StartupPanel> = Mutex::new(StartupPanel {
    ready: false,
    requested: false,
    shown: false,
});

pub fn is_update_restart<I, S>(args: I, current_version: &str) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    // The existing Inno argument names the version that has just been installed.
    args.into_iter().any(|arg| {
        arg.as_ref()
            .to_str()
            .and_then(|arg| arg.strip_prefix("--updated-from="))
            .is_some_and(|version| version == current_version)
    })
}

fn show_if_ready(app: &AppHandle, ready: bool, requested: bool) -> Result<(), String> {
    let show = {
        let mut panel = PANEL.lock().unwrap();
        panel.ready |= ready;
        panel.requested |= requested;
        panel.take_show()
    };
    if show {
        crate::show_main_panel_for_app(app)?;
    }
    Ok(())
}

pub fn request_show(app: &AppHandle) -> Result<(), String> {
    show_if_ready(app, false, true)
}

#[tauri::command]
pub fn clipboard_window_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager;

    if window.label() != "clipboard" {
        return Err("only the clipboard window can acknowledge startup readiness".into());
    }
    show_if_ready(window.app_handle(), true, false)
}

#[cfg(test)]
mod tests {
    use super::{is_update_restart, StartupPanel};

    #[test]
    fn only_the_installers_exact_current_version_argument_requests_an_update_show() {
        assert!(is_update_restart(
            ["vPaste.exe", "--updated-from=1.6.5"],
            "1.6.5"
        ));
        assert!(!is_update_restart(["vPaste.exe"], "1.6.5"));
        assert!(!is_update_restart(["--dev-mode"], "1.6.5"));
        assert!(!is_update_restart(["--updated-from=1.6.4"], "1.6.5"));
        assert!(!is_update_restart(["--updated-from=1.6.50"], "1.6.5"));
        assert!(!is_update_restart(["--updated-from="], "1.6.5"));
        assert!(is_update_restart(
            ["--updated-from=1.6.5-rc.1"],
            "1.6.5-rc.1"
        ));
    }

    #[test]
    fn startup_request_waits_for_webview_readiness_and_is_consumed_once() {
        let mut panel = StartupPanel::default();
        panel.requested = true;
        assert!(!panel.take_show());
        panel.ready = true;
        assert!(panel.take_show());
        assert!(!panel.take_show());
    }

    #[test]
    fn webview_ready_first_still_waits_for_startup_initialization() {
        let mut panel = StartupPanel::default();
        panel.ready = true;
        assert!(!panel.take_show());
        panel.requested = true;
        assert!(panel.take_show());
        assert!(!panel.take_show());
    }

    #[test]
    fn normal_windows_startup_does_not_open_a_panel() {
        let mut panel = StartupPanel::default();
        panel.ready = true;
        assert!(!panel.take_show());
        assert!(!panel.take_show());
    }
}
