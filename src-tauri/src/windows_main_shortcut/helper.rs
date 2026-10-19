//! Native-only entry point. Cubby's isolated-helper and physical Win-state
//! approach informed this implementation; it does not initialize Tauri.
use super::{Event, Mode};
use std::io::{BufRead, Write};
use std::sync::{mpsc, Mutex, OnceLock};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN,
    WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const V: usize = 0x56;
const LEFT_WIN: usize = 0x5B;
const RIGHT_WIN: usize = 0x5C;
const OWN_INPUT: usize = 0x5650_5756;
static MODE: Mutex<Mode> = Mutex::new(Mode::Off);
static STATE: OnceLock<Mutex<InputState>> = OnceLock::new();
static EVENTS: OnceLock<mpsc::Sender<Event>> = OnceLock::new();

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Pass,
    Consume,
    Activate { mode: Mode, release: u8 },
    RestoreWin(u8),
}

struct InputState {
    pressed: [bool; 256],
    swallowed_v: bool,
    released_win: u8,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            pressed: [false; 256],
            swallowed_v: false,
            released_win: 0,
        }
    }
}

impl InputState {
    fn activation_failed(&mut self, release: u8) {
        self.swallowed_v = false;
        self.released_win &= !release;
    }

    fn win_mask(&self) -> u8 {
        u8::from(self.pressed[LEFT_WIN]) | (u8::from(self.pressed[RIGHT_WIN]) << 1)
    }

    fn update(&mut self, key: usize, down: bool, mode: Mode) -> Decision {
        if key >= self.pressed.len() {
            return Decision::Pass;
        }
        let was_down = self.pressed[key];
        self.pressed[key] = down;
        let win_bit = match key {
            LEFT_WIN => 1,
            RIGHT_WIN => 2,
            _ => 0,
        };
        if !down && win_bit & self.released_win != 0 {
            self.released_win &= !win_bit;
            return Decision::Consume;
        }
        if key == V && self.swallowed_v {
            if !down {
                self.swallowed_v = false;
            }
            return Decision::Consume;
        }
        let exact_win_v = self.win_mask() != 0
            && self
                .pressed
                .iter()
                .enumerate()
                .all(|(key, &held)| !held || matches!(key, LEFT_WIN | RIGHT_WIN | V));
        if key == V && down && !was_down && exact_win_v && mode != Mode::Off {
            self.swallowed_v = true;
            let release = self.win_mask() & !self.released_win;
            self.released_win |= release;
            return Decision::Activate { mode, release };
        }
        // Win is still physically held, but was released logically for Win+V.
        // Restore it before an unrelated key (e.g. Win+E) reaches Windows.
        if down && win_bit == 0 && self.released_win != 0 {
            let restore = self.win_mask() & self.released_win;
            self.released_win = 0;
            if restore != 0 {
                return Decision::RestoreWin(restore);
            }
        }
        Decision::Pass
    }
}

fn emit(event: Event) {
    if let Some(sender) = EVENTS.get() {
        let _ = sender.send(event);
    }
}

fn input(key: u16, up: bool) -> INPUT {
    let mut flags = if up {
        KEYEVENTF_KEYUP
    } else {
        Default::default()
    };
    if key == LEFT_WIN as u16 || key == RIGHT_WIN as u16 {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(key),
                dwFlags: flags,
                dwExtraInfo: OWN_INPUT,
                ..Default::default()
            },
        },
    }
}

fn inject_win(mask: u8, up: bool) -> bool {
    if mask == 0 {
        return true;
    }
    let mut inputs = Vec::with_capacity(4);
    if up {
        // VK_E8 is unassigned. It prevents Start from seeing a bare Win press.
        inputs.extend([input(0xE8, false), input(0xE8, true)]);
    }
    for (bit, key) in [(1, LEFT_WIN), (2, RIGHT_WIN)] {
        if mask & bit != 0 {
            inputs.push(input(key as u16, up));
        }
    }
    (unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) }) == inputs.len() as u32
}

unsafe extern "system" fn keyboard_callback(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code != HC_ACTION as i32 {
        return CallNextHookEx(None, code, message, data);
    }
    let event = &*(data.0 as *const KBDLLHOOKSTRUCT);
    if event.dwExtraInfo == OWN_INPUT {
        return CallNextHookEx(None, code, message, data);
    }
    let down = match message.0 as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => true,
        WM_KEYUP | WM_SYSKEYUP => false,
        _ => return CallNextHookEx(None, code, message, data),
    };
    let key = match event.vkCode {
        0x10 => 0xA0,
        0x11 => 0xA2,
        0x12 => 0xA4,
        key => key,
    };
    let mode = *MODE.lock().unwrap_or_else(|e| e.into_inner());
    let decision = STATE
        .get()
        .expect("helper state initialized")
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .update(key as usize, down, mode);
    // No log formatting, Tauri calls or pipe writes run on this callback thread.
    match decision {
        Decision::Activate { mode, release } => {
            if inject_win(release, true) {
                emit(Event::Pressed(mode));
            } else {
                STATE
                    .get()
                    .expect("helper state initialized")
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .activation_failed(release);
                emit(Event::Error("Win+V Windows-key release was blocked".into()));
                return CallNextHookEx(None, code, message, data);
            }
            LRESULT(1)
        }
        Decision::Consume => LRESULT(1),
        Decision::RestoreWin(mask) => {
            if !inject_win(mask, false) {
                emit(Event::Error(
                    "Win+V Windows-key restoration was blocked".into(),
                ));
            }
            CallNextHookEx(None, code, message, data)
        }
        Decision::Pass => CallNextHookEx(None, code, message, data),
    }
}

fn initial_state(mut is_down: impl FnMut(usize) -> bool) -> InputState {
    let mut state = InputState::default();
    // Mouse buttons have virtual-key codes too, but this keyboard hook never
    // receives their release events (e.g. the click that opens the recorder).
    for key in 0x08..256 {
        if !matches!(key, 0x10..=0x12) {
            state.pressed[key] = is_down(key);
        }
    }
    state
}

pub(super) fn run() -> Result<(), String> {
    let (events, receiver) = mpsc::channel();
    EVENTS
        .set(events)
        .map_err(|_| "Win+V helper already initialized")?;
    std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        for event in receiver {
            if serde_json::to_writer(&mut output, &event).is_err()
                || output.write_all(b"\n").is_err()
                || output.flush().is_err()
            {
                break;
            }
        }
    });
    let state = initial_state(|key| unsafe { GetAsyncKeyState(key as i32) } < 0);
    STATE
        .set(Mutex::new(state))
        .map_err(|_| "Win+V helper state already initialized")?;
    unsafe {
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_callback), None, 0)
            .map_err(|e| format!("Win+V helper hook installation failed: {e}"))?;
        let thread = GetCurrentThreadId();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                match line
                    .ok()
                    .and_then(|line| serde_json::from_str::<Mode>(&line).ok())
                {
                    Some(mode) => {
                        *MODE.lock().unwrap_or_else(|e| e.into_inner()) = mode;
                        emit(Event::ModeChanged(mode));
                    }
                    None => break,
                }
            }
            // Closing the parent's write handle (including a crash) releases the hook.
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        });
        emit(Event::Ready(std::process::id()));
        let status = loop {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result <= 0 {
                break result;
            }
        };
        let _ = UnhookWindowsHookEx(hook);
        if status < 0 {
            return Err(windows::core::Error::from_win32().to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(win: usize, mode: Mode) -> InputState {
        let mut state = InputState::default();
        assert_eq!(state.update(win, true, mode), Decision::Pass);
        state
    }

    #[test]
    fn captures_recording_from_win_transitions_without_async_state() {
        for win in [LEFT_WIN, RIGHT_WIN] {
            let mut state = start(win, Mode::Record(9));
            let mask = if win == LEFT_WIN { 1 } else { 2 };
            assert_eq!(
                state.update(V, true, Mode::Record(9)),
                Decision::Activate {
                    mode: Mode::Record(9),
                    release: mask
                }
            );
            assert_eq!(state.update(V, true, Mode::Record(9)), Decision::Consume);
            assert_eq!(state.update(V, false, Mode::Off), Decision::Consume);
            assert_eq!(state.update(win, false, Mode::Off), Decision::Consume);
            assert_eq!(state.update(0x41, true, Mode::Off), Decision::Pass);
        }
    }

    #[test]
    fn mouse_held_when_recording_starts_does_not_block_win_v() {
        let mut state = initial_state(|key| key == 0x01);
        state.update(LEFT_WIN, true, Mode::Record(1));
        assert_eq!(
            state.update(V, true, Mode::Record(1)),
            Decision::Activate {
                mode: Mode::Record(1),
                release: 1
            }
        );
    }

    #[test]
    fn startup_preserves_held_keyboard_modifiers() {
        let mut state = initial_state(|key| key == 0xA2);
        state.update(LEFT_WIN, true, Mode::Toggle);
        assert_eq!(state.update(V, true, Mode::Toggle), Decision::Pass);
    }

    #[test]
    fn releasing_win_before_v_completes_the_same_press() {
        let mut state = start(LEFT_WIN, Mode::Toggle);
        state.update(V, true, Mode::Toggle);
        assert_eq!(
            state.update(LEFT_WIN, false, Mode::Toggle),
            Decision::Consume
        );
        assert_eq!(state.update(V, false, Mode::Toggle), Decision::Consume);
        assert_eq!(state.update(V, true, Mode::Toggle), Decision::Pass);
    }

    #[test]
    fn preserves_other_chords_and_v_held_before_win() {
        for key in [0xA0, 0xA2, 0xA4, 0x41] {
            let mut state = start(LEFT_WIN, Mode::Toggle);
            state.update(key, true, Mode::Toggle);
            assert_eq!(state.update(V, true, Mode::Toggle), Decision::Pass);
        }
        let mut state = InputState::default();
        state.update(V, true, Mode::Toggle);
        state.update(LEFT_WIN, true, Mode::Toggle);
        assert_eq!(state.update(V, true, Mode::Toggle), Decision::Pass);
    }

    #[test]
    fn off_mode_preserves_windows_and_single_win_is_untouched() {
        let mut state = start(LEFT_WIN, Mode::Off);
        assert_eq!(state.update(V, true, Mode::Off), Decision::Pass);
        assert_eq!(state.update(V, false, Mode::Off), Decision::Pass);
        assert_eq!(state.update(LEFT_WIN, false, Mode::Off), Decision::Pass);
    }

    #[test]
    fn restores_win_before_an_unrelated_shortcut() {
        let mut state = start(LEFT_WIN, Mode::Toggle);
        state.update(V, true, Mode::Toggle);
        state.update(V, false, Mode::Toggle);
        assert_eq!(
            state.update(0x45, true, Mode::Toggle),
            Decision::RestoreWin(1)
        );
        assert_eq!(state.update(LEFT_WIN, false, Mode::Toggle), Decision::Pass);
    }

    #[test]
    fn repeated_chords_with_win_held_release_it_only_once() {
        let mut state = start(LEFT_WIN, Mode::Toggle);
        state.update(V, true, Mode::Toggle);
        state.update(V, false, Mode::Toggle);
        assert_eq!(
            state.update(V, true, Mode::Toggle),
            Decision::Activate {
                mode: Mode::Toggle,
                release: 0
            }
        );
    }

    #[test]
    fn both_win_keys_are_released_and_restored_together() {
        let mut state = start(LEFT_WIN, Mode::Toggle);
        state.update(RIGHT_WIN, true, Mode::Toggle);
        assert_eq!(
            state.update(V, true, Mode::Toggle),
            Decision::Activate {
                mode: Mode::Toggle,
                release: 3
            }
        );
        state.update(V, false, Mode::Toggle);
        assert_eq!(
            state.update(0x45, true, Mode::Toggle),
            Decision::RestoreWin(3)
        );
    }

    #[test]
    fn blocked_injection_does_not_swallow_the_physical_win_release() {
        let mut state = start(LEFT_WIN, Mode::Toggle);
        state.update(V, true, Mode::Toggle);
        state.activation_failed(1);
        assert_eq!(state.update(V, false, Mode::Toggle), Decision::Pass);
        assert_eq!(state.update(LEFT_WIN, false, Mode::Toggle), Decision::Pass);
    }
}
