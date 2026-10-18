//! Windows support for using Win+V as the main window shortcut.
//!
//! Explorer owns Win+V for the built-in clipboard history, so `RegisterHotKey`
//! cannot claim it, and the settings recorder never receives the key press.
//! A low-level keyboard hook sees the chord before Explorer: while Win+V is the
//! saved main window shortcut it toggles the clipboard window, and while the
//! main shortcut recorder is open it reports the chord to the settings window.

use std::sync::atomic::{AtomicBool, Ordering};

/// Emitted to the settings window when Win+V is pressed during recording.
pub(crate) const RECORDED_EVENT: &str = "win-v-shortcut-recorded";

static ACTIVE: AtomicBool = AtomicBool::new(false);
static RECORDING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Modifiers {
    pub win: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HookKey {
    V,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HookMode {
    /// Win+V belongs to Windows.
    PassThrough,
    /// Win+V is the saved main window shortcut.
    ToggleWindow,
    /// The main shortcut recorder is waiting for a key press.
    Record,
}

#[derive(Debug, Default)]
pub(crate) struct HookState {
    swallowing_v: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct HookDecision {
    /// Drop the key event so neither Explorer nor the focused app sees it.
    pub intercept: bool,
    /// Toggle the clipboard window.
    pub open: bool,
    /// Report Win+V to the shortcut recorder.
    pub record: bool,
    /// Inject a neutral key so releasing Win does not open the Start menu.
    pub mask_win: bool,
}

pub(crate) fn decide(
    state: &mut HookState,
    key: HookKey,
    down: bool,
    injected: bool,
    modifiers: Modifiers,
    mode: HookMode,
) -> HookDecision {
    if injected || key != HookKey::V {
        return HookDecision::default();
    }
    if !down {
        let intercept = std::mem::take(&mut state.swallowing_v);
        return HookDecision {
            intercept,
            ..HookDecision::default()
        };
    }
    if state.swallowing_v {
        // Auto-repeat while V stays held: keep swallowing, act only once.
        return HookDecision {
            intercept: true,
            ..HookDecision::default()
        };
    }
    let exact_win_v = modifiers.win && !modifiers.ctrl && !modifiers.shift && !modifiers.alt;
    if mode == HookMode::PassThrough || !exact_win_v {
        return HookDecision::default();
    }
    state.swallowing_v = true;
    HookDecision {
        intercept: true,
        open: mode == HookMode::ToggleWindow,
        record: mode == HookMode::Record,
        mask_win: true,
    }
}

fn current_mode() -> HookMode {
    if RECORDING.load(Ordering::SeqCst) {
        HookMode::Record
    } else if ACTIVE.load(Ordering::SeqCst) {
        HookMode::ToggleWindow
    } else {
        HookMode::PassThrough
    }
}

/// Sets whether Win+V is the saved main window shortcut.
pub(crate) fn set_active(app: &tauri::AppHandle, active: bool) {
    let active = active && cfg!(target_os = "windows");
    ACTIVE.store(active, Ordering::SeqCst);
    if active {
        ensure_hook(app);
    }
}

/// Sets whether the main shortcut recorder is open.
pub(crate) fn set_recording(app: &tauri::AppHandle, recording: bool) {
    let recording = recording && cfg!(target_os = "windows");
    RECORDING.store(recording, Ordering::SeqCst);
    if recording {
        ensure_hook(app);
    }
}

/// The hook thread starts the first time it is needed and then stays
/// installed, passing every event through while the mode is `PassThrough`.
fn ensure_hook(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    windows_hook::ensure_started(app);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[cfg(target_os = "windows")]
mod windows_hook {
    use super::{current_mode, decide, HookKey, HookState, Modifiers, RECORDED_EVENT};
    use log::{error, info};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    /// Unassigned virtual key used only to break the "Win pressed alone" sequence.
    const MASK_VIRTUAL_KEY: u16 = 0xFF;
    const MASK_EVENT_MARKER: usize = 0x5650_5756;

    static STARTED: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static STATE: Mutex<HookState> = Mutex::new(HookState {
        swallowing_v: false,
    });

    pub(super) fn ensure_started(app: &AppHandle) {
        let _ = APP.set(app.clone());
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| {
            info!("starting Win+V takeover keyboard hook");
            if let Err(err) = run() {
                error!("Win+V takeover keyboard hook stopped: {}", err);
            }
            STARTED.store(false, Ordering::SeqCst);
        });
    }

    fn key_pressed(key: VIRTUAL_KEY) -> bool {
        unsafe { GetAsyncKeyState(key.0 as i32) < 0 }
    }

    fn current_modifiers() -> Modifiers {
        Modifiers {
            win: key_pressed(VK_LWIN) || key_pressed(VK_RWIN),
            ctrl: key_pressed(VK_CONTROL),
            shift: key_pressed(VK_SHIFT),
            alt: key_pressed(VK_MENU),
        }
    }

    fn send_mask_key() {
        fn input(flags: KEYBD_EVENT_FLAGS) -> INPUT {
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(MASK_VIRTUAL_KEY),
                        wScan: 0,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: MASK_EVENT_MARKER,
                    },
                },
            }
        }
        let inputs = [input(KEYBD_EVENT_FLAGS(0)), input(KEYEVENTF_KEYUP)];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            error!(
                "SendInput sent {} of {} Win+V mask keys",
                sent,
                inputs.len()
            );
        }
    }

    fn open_clipboard_window() {
        let Some(app) = APP.get() else {
            return;
        };
        let handle = app.clone();
        // Keep the hook callback short; window work runs on the main thread
        // like the regular global-shortcut handler.
        if let Err(err) = app.run_on_main_thread(move || crate::toggle_clipboard_window(&handle)) {
            error!("Failed to toggle clipboard window from Win+V: {}", err);
        }
    }

    fn report_recorded_shortcut() {
        if let Some(app) = APP.get() {
            if let Err(err) = app.emit(RECORDED_EVENT, "Super+V") {
                error!("Failed to report recorded Win+V shortcut: {}", err);
            }
        }
    }

    unsafe extern "system" fn keyboard_callback(
        code: i32,
        message: WPARAM,
        data: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 {
            let down = match message.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
                WM_KEYUP | WM_SYSKEYUP => Some(false),
                _ => None,
            };
            if let Some(down) = down {
                let event = &*(data.0 as *const KBDLLHOOKSTRUCT);
                let key = if event.vkCode == VK_V.0 as u32 {
                    HookKey::V
                } else {
                    HookKey::Other
                };
                let injected = (event.flags.0 & LLKHF_INJECTED.0) != 0;
                let modifiers = if key == HookKey::V && down {
                    current_modifiers()
                } else {
                    Modifiers::default()
                };
                let decision = {
                    let mut state = STATE
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    decide(&mut state, key, down, injected, modifiers, current_mode())
                };
                if decision.mask_win {
                    send_mask_key();
                }
                if decision.open {
                    open_clipboard_window();
                }
                if decision.record {
                    report_recorded_shortcut();
                }
                if decision.intercept {
                    return LRESULT(1);
                }
            }
        }
        CallNextHookEx(None, code, message, data)
    }

    fn run() -> Result<(), String> {
        unsafe {
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_callback), None, 0)
                .map_err(|err| err.to_string())?;
            let mut message = MSG::default();
            loop {
                let status = GetMessageW(&mut message, None, 0, 0).0;
                if status <= 0 {
                    let _ = UnhookWindowsHookEx(hook);
                    return Err(if status < 0 {
                        windows::core::Error::from_win32().to_string()
                    } else {
                        "message loop ended".to_string()
                    });
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn win_v_hook_can_be_installed_and_removed() {
            unsafe {
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_callback), None, 0)
                    .expect("the Win+V keyboard hook must install on this desktop");
                UnhookWindowsHookEx(hook).unwrap();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: Modifiers = Modifiers {
        win: true,
        ctrl: false,
        shift: false,
        alt: false,
    };

    fn press(state: &mut HookState, modifiers: Modifiers, mode: HookMode) -> HookDecision {
        decide(state, HookKey::V, true, false, modifiers, mode)
    }

    fn release(state: &mut HookState, mode: HookMode) -> HookDecision {
        decide(state, HookKey::V, false, false, Modifiers::default(), mode)
    }

    const SWALLOW_ONLY: HookDecision = HookDecision {
        intercept: true,
        open: false,
        record: false,
        mask_win: false,
    };

    #[test]
    fn win_v_shortcut_toggles_once_and_swallows_the_whole_press() {
        let mut state = HookState::default();
        assert_eq!(
            press(&mut state, WIN, HookMode::ToggleWindow),
            HookDecision {
                intercept: true,
                open: true,
                record: false,
                mask_win: true,
            }
        );
        assert_eq!(
            press(&mut state, WIN, HookMode::ToggleWindow),
            SWALLOW_ONLY,
            "auto-repeat must not toggle the window again"
        );
        assert_eq!(release(&mut state, HookMode::ToggleWindow), SWALLOW_ONLY);
        assert!(
            press(&mut state, WIN, HookMode::ToggleWindow).open,
            "the next real press toggles again"
        );
    }

    #[test]
    fn recorder_receives_win_v_instead_of_toggling() {
        let mut state = HookState::default();
        assert_eq!(
            press(&mut state, WIN, HookMode::Record),
            HookDecision {
                intercept: true,
                open: false,
                record: true,
                mask_win: true,
            }
        );
        assert_eq!(press(&mut state, WIN, HookMode::Record), SWALLOW_ONLY);
        assert_eq!(release(&mut state, HookMode::Record), SWALLOW_ONLY);
    }

    #[test]
    fn win_v_belongs_to_windows_when_it_is_not_the_shortcut() {
        let mut state = HookState::default();
        assert_eq!(
            press(&mut state, WIN, HookMode::PassThrough),
            HookDecision::default()
        );
        assert_eq!(
            release(&mut state, HookMode::PassThrough),
            HookDecision::default()
        );
    }

    #[test]
    fn other_chords_and_keys_pass_through() {
        for mode in [HookMode::ToggleWindow, HookMode::Record] {
            let mut state = HookState::default();
            for modifiers in [
                Modifiers::default(),
                Modifiers { shift: true, ..WIN },
                Modifiers { ctrl: true, ..WIN },
                Modifiers { alt: true, ..WIN },
                Modifiers {
                    ctrl: true,
                    ..Modifiers::default()
                },
            ] {
                assert_eq!(
                    press(&mut state, modifiers, mode),
                    HookDecision::default(),
                    "{modifiers:?} must not be taken over in {mode:?}"
                );
                assert_eq!(release(&mut state, mode), HookDecision::default());
            }
            assert_eq!(
                decide(&mut state, HookKey::Other, true, false, WIN, mode),
                HookDecision::default()
            );
        }
    }

    #[test]
    fn injected_events_are_ignored() {
        let mut state = HookState::default();
        assert_eq!(
            decide(
                &mut state,
                HookKey::V,
                true,
                true,
                WIN,
                HookMode::ToggleWindow
            ),
            HookDecision::default()
        );
    }

    #[test]
    fn releasing_v_after_the_mode_changes_still_completes_the_swallowed_press() {
        let mut state = HookState::default();
        assert!(press(&mut state, WIN, HookMode::ToggleWindow).open);
        assert!(release(&mut state, HookMode::PassThrough).intercept);
    }
}
