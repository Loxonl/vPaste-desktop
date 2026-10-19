//! Win+V runs in an isolated native process before Tauri/WebView initialization.
//! Architecture reference: https://github.com/btsouth/cubby-clipboard/blob/main/docs/SHORTCUT_BEHAVIOR.md
//! Inherited anonymous pipes carry modes and events; no network listener is needed.
mod helper;

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
enum Mode {
    #[default]
    Off,
    Record(u64),
    Toggle,
}

#[derive(Debug, Deserialize, Serialize)]
enum Event {
    Ready(u32),
    ModeChanged(Mode),
    Pressed(Mode),
    Error(String),
}

struct HelperProcess {
    child: Child,
    input: ChildStdin,
}

static HELPER: Mutex<Option<HelperProcess>> = Mutex::new(None);
static ACKNOWLEDGED_MODE: Mutex<Mode> = Mutex::new(Mode::Off);
static ENABLED: AtomicBool = AtomicBool::new(false);
static RECORDING: AtomicBool = AtomicBool::new(false);
static SESSION: AtomicU64 = AtomicU64::new(0);
static STOPPING: AtomicBool = AtomicBool::new(false);

pub fn matches(shortcut: Shortcut) -> bool {
    shortcut.mods == Modifiers::SUPER && shortcut.key == Code::KeyV
}

fn current_mode() -> Mode {
    if RECORDING.load(Ordering::SeqCst) {
        Mode::Record(SESSION.load(Ordering::SeqCst))
    } else if ENABLED.load(Ordering::SeqCst) {
        Mode::Toggle
    } else {
        Mode::Off
    }
}

fn accepts_event(event: Mode, current: Mode) -> bool {
    event != Mode::Off && event == current
}

pub fn ensure_available(app: &tauri::AppHandle) -> Result<(), String> {
    let mut slot = HELPER
        .lock()
        .map_err(|_| "Win+V helper state unavailable")?;
    if let Some(helper) = slot.as_mut() {
        if helper
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(());
        }
    }
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .arg("--win-v-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("无法启动 Win+V 辅助进程：{e}"))?;
    let output = child.stdout.take().ok_or("Win+V helper stdout missing")?;
    let input = child.stdin.take().ok_or("Win+V helper stdin missing")?;
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ready_tx = Some(ready_tx);
        let mut was_ready = false;
        for line in BufReader::new(output).lines() {
            let event = match line
                .map_err(|e| e.to_string())
                .and_then(|line| serde_json::from_str::<Event>(&line).map_err(|e| e.to_string()))
            {
                Ok(event) => event,
                Err(err) => {
                    log::error!("Win+V helper event failed: {err}");
                    break;
                }
            };
            match event {
                Event::Ready(pid) => {
                    log::info!(
                        "Win+V helper ready: pid={pid}, parent={}",
                        std::process::id()
                    );
                    was_ready = true;
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Event::ModeChanged(mode) => {
                    *ACKNOWLEDGED_MODE.lock().unwrap_or_else(|e| e.into_inner()) = mode;
                    log::info!("Win+V helper mode: {mode:?}");
                }
                Event::Pressed(mode) => {
                    log::info!("Win+V helper captured: {mode:?}");
                    let handle = app.clone();
                    if let Err(err) = app.run_on_main_thread(move || {
                        if !accepts_event(mode, current_mode()) {
                            return;
                        }
                        match mode {
                            Mode::Record(_) => {
                                if let Err(err) =
                                    handle.emit_to("config", "main-shortcut-recorded", "Super+V")
                                {
                                    log::error!("Win+V recording delivery failed: {err}");
                                }
                            }
                            Mode::Toggle => crate::toggle_clipboard_window(&handle),
                            Mode::Off => {}
                        }
                    }) {
                        log::error!("Win+V dispatch failed: {err}");
                    }
                }
                Event::Error(err) => {
                    log::error!("Win+V helper: {err}");
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Err(err));
                    }
                }
            }
        }
        if let Some(tx) = ready_tx.take() {
            let _ = tx.send(Err("Win+V helper exited before ready".into()));
        }
        if was_ready && !STOPPING.load(Ordering::SeqCst) {
            log::warn!("Win+V helper disconnected");
            std::thread::sleep(std::time::Duration::from_secs(1));
            if current_mode() != Mode::Off && !STOPPING.load(Ordering::SeqCst) {
                match ensure_available(&app) {
                    Ok(()) => sync_mode(),
                    Err(err) => log::error!("Win+V helper restart failed: {err}"),
                }
            }
        }
    });
    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => {
            *slot = Some(HelperProcess { child, input });
            Ok(())
        }
        result => {
            let _ = child.kill();
            let _ = child.wait();
            Err(match result {
                Ok(Err(err)) => err,
                Err(err) => format!("Win+V helper readiness failed: {err}"),
                Ok(Ok(())) => unreachable!(),
            })
        }
    }
}

fn sync_mode() {
    let mut slot = HELPER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(helper) = slot.as_mut() {
        let result = serde_json::to_writer(&mut helper.input, &current_mode())
            .map_err(|e| e.to_string())
            .and_then(|_| helper.input.write_all(b"\n").map_err(|e| e.to_string()));
        if let Err(err) = result {
            log::error!("Win+V helper mode update failed: {err}");
        }
    }
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    sync_mode();
}

pub fn set_recording(recording: bool) -> bool {
    SESSION.fetch_add(1, Ordering::SeqCst);
    let previous = RECORDING.swap(recording, Ordering::SeqCst);
    sync_mode();
    previous
}

pub fn log_status() {
    // Startup shortcuts are registered before the application's log plugin.
    // Replay the actual helper acknowledgment once that plugin is available.
    let slot = HELPER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(helper) = slot.as_ref() {
        log::info!(
            "Win+V helper status: pid={}, requested={:?}, acknowledged={:?}",
            helper.child.id(),
            current_mode(),
            *ACKNOWLEDGED_MODE.lock().unwrap_or_else(|e| e.into_inner())
        );
    }
}

pub fn run_if_requested() -> bool {
    if !std::env::args_os().any(|arg| arg == "--win-v-helper") {
        return false;
    }
    if let Err(err) = helper::run() {
        if let Ok(message) = serde_json::to_string(&Event::Error(err)) {
            println!("{message}");
        }
        std::process::exit(1);
    }
    true
}

pub fn shutdown() {
    STOPPING.store(true, Ordering::SeqCst);
    ENABLED.store(false, Ordering::SeqCst);
    RECORDING.store(false, Ordering::SeqCst);
    if let Some(mut helper) = HELPER.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = helper.child.kill();
        let _ = helper.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_recording_events_cannot_save_or_toggle() {
        assert!(accepts_event(Mode::Record(4), Mode::Record(4)));
        assert!(!accepts_event(Mode::Record(3), Mode::Record(4)));
        assert!(!accepts_event(Mode::Record(4), Mode::Off));
        assert!(!accepts_event(Mode::Record(4), Mode::Toggle));
        assert!(accepts_event(Mode::Toggle, Mode::Toggle));
        assert!(!accepts_event(Mode::Toggle, Mode::Record(4)));
        assert!(!accepts_event(Mode::Off, Mode::Off));
    }

    #[test]
    fn only_exact_win_v_uses_the_helper() {
        assert!(matches("Super+V".parse().unwrap()));
        assert!(matches("Command+V".parse().unwrap()));
        for value in ["Alt+V", "Control+V", "Super+Shift+V", "Super+B"] {
            assert!(!matches(value.parse().unwrap()));
        }
    }
}
