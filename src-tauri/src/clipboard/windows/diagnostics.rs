use clipboard_win::SysResult;
use std::num::NonZeroUsize;
use std::sync::OnceLock;
use std::time::Instant;

const ENVIRONMENT_FLAG: &str = "VPASTE_CLIPBOARD_DIAGNOSTICS";

pub(super) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| detailed_value(std::env::var(ENVIRONMENT_FLAG).ok().as_deref()))
}

pub(super) fn capture_wait_timeout(current: u32, latest: u32, completed: Option<u32>) {
    log::warn!(
        "clipboard_diag stage=capture_wait_timeout current_seq={} latest_seq={} completed_seq={:?} state={:?}",
        current, latest, completed, NativeState::capture()
    );
}

fn detailed_value(value: Option<&str>) -> bool {
    value == Some("1")
}

fn should_emit(detailed: bool, failed: bool) -> bool {
    detailed || failed
}

struct NativeState {
    sequence: u32,
    owner_hwnd: isize,
    owner_pid: u32,
    owner_tid: u32,
    open_hwnd: isize,
    open_pid: u32,
    open_tid: u32,
    current_tid: u32,
}

impl std::fmt::Debug for NativeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeState")
            .field("sequence", &self.sequence)
            .field("owner_hwnd", &self.owner_hwnd)
            .field("owner_pid", &self.owner_pid)
            .field("owner_tid", &self.owner_tid)
            .field("open_hwnd", &self.open_hwnd)
            .field("open_pid", &self.open_pid)
            .field("open_tid", &self.open_tid)
            .field("current_tid", &self.current_tid)
            .finish()
    }
}

impl NativeState {
    fn capture() -> Self {
        #[link(name = "user32")]
        extern "system" {
            fn GetClipboardSequenceNumber() -> u32;
            fn GetClipboardOwner() -> *mut std::ffi::c_void;
            fn GetOpenClipboardWindow() -> *mut std::ffi::c_void;
            fn GetWindowThreadProcessId(hwnd: *mut std::ffi::c_void, process_id: *mut u32) -> u32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentThreadId() -> u32;
        }
        let mut owner_pid = 0;
        let mut open_pid = 0;
        // SAFETY: These APIs only query metadata. Output pointers refer to local
        // u32 values; handles are never dereferenced. No clipboard is opened or
        // read, so observation cannot request Excel's delayed format rendering.
        unsafe {
            let owner_hwnd = GetClipboardOwner();
            let open_hwnd = GetOpenClipboardWindow();
            let owner_tid = if !owner_hwnd.is_null() {
                GetWindowThreadProcessId(owner_hwnd, &mut owner_pid)
            } else {
                0
            };
            let open_tid = if !open_hwnd.is_null() {
                GetWindowThreadProcessId(open_hwnd, &mut open_pid)
            } else {
                0
            };
            Self {
                sequence: GetClipboardSequenceNumber(),
                owner_hwnd: owner_hwnd as isize,
                owner_pid,
                owner_tid,
                open_hwnd: open_hwnd as isize,
                open_pid,
                open_tid,
                current_tid: GetCurrentThreadId(),
            }
        }
    }
}

pub(super) struct ReadTrace {
    sequence: u32,
    attempt: usize,
    detailed: bool,
    started: Instant,
}

impl ReadTrace {
    pub(super) fn new(sequence: u32, attempt: usize) -> Self {
        Self {
            sequence,
            attempt,
            detailed: enabled(),
            started: Instant::now(),
        }
    }

    pub(super) fn native<T>(
        &self,
        stage: &'static str,
        format_name: &'static str,
        format: u32,
        operation: impl FnOnce() -> SysResult<T>,
    ) -> SysResult<T> {
        let before = self.detailed.then(NativeState::capture);
        let started = Instant::now();
        let result = operation();
        let elapsed_us = started.elapsed().as_micros();
        if should_emit(self.detailed, result.is_err()) {
            // Read the error from the returned value, never a possibly stale
            // GetLastError after diagnostic APIs. T has no formatting bounds.
            let error_code = result.as_ref().err().map(|error| error.raw_code());
            log::log!(
                if result.is_err() { log::Level::Warn } else { log::Level::Info },
                "clipboard_diag requested_seq={} attempt={} stage={} format={}({}) ok={} native_error={:?} elapsed_us={} before={:?} after={:?}",
                self.sequence, self.attempt, stage, format_name, format,
                result.is_ok(), error_code, elapsed_us, before, NativeState::capture()
            );
        }
        result
    }

    pub(super) fn size(
        &self,
        format_name: &'static str,
        format: u32,
        operation: impl FnOnce() -> Option<NonZeroUsize>,
    ) -> Option<NonZeroUsize> {
        let before = self.detailed.then(NativeState::capture);
        let result = operation();
        if self.detailed {
            log::info!(
                "clipboard_diag requested_seq={} attempt={} stage=size format={}({}) bytes={:?} before={:?} after={:?}",
                self.sequence, self.attempt, format_name, format,
                result.map(NonZeroUsize::get), before, NativeState::capture()
            );
        }
        result
    }

    pub(super) fn event(&self, stage: &'static str, failed: bool, bytes: Option<usize>) {
        if should_emit(self.detailed, failed) {
            log::log!(
                if failed { log::Level::Warn } else { log::Level::Info },
                "clipboard_diag requested_seq={} attempt={} stage={} failed={} bytes={:?} attempt_us={} state={:?}",
                self.sequence, self.attempt, stage, failed, bytes,
                self.started.elapsed().as_micros(), NativeState::capture()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn trace(detailed: bool) -> ReadTrace {
        ReadTrace {
            sequence: 41,
            attempt: 1,
            detailed,
            started: Instant::now(),
        }
    }

    #[test]
    fn detailed_diagnostics_requires_explicit_opt_in() {
        for value in [None, Some(""), Some("0"), Some("true")] {
            assert!(!detailed_value(value));
        }
        assert!(detailed_value(Some("1")));
    }

    #[test]
    fn failures_are_logged_by_default_but_success_needs_opt_in() {
        assert!(!should_emit(false, false));
        assert!(should_emit(false, true));
        assert!(should_emit(true, false));
        assert!(should_emit(true, true));
    }

    #[test]
    fn observation_executes_once_and_preserves_an_opaque_payload() {
        // A type without Debug/Display prevents accidental payload formatting.
        struct Payload(Box<str>);
        let calls = Cell::new(0);
        for detailed in [false, true] {
            let payload = Payload("private clipboard canary".into());
            let address = payload.0.as_ptr();
            let result = trace(detailed).native("read", "CF_UNICODETEXT", 13, || {
                calls.set(calls.get() + 1);
                Ok(payload)
            });
            let returned = result.unwrap();
            assert_eq!(returned.0.as_ptr(), address);
        }
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn observation_preserves_the_native_error_code() {
        for detailed in [false, true] {
            for code in [5, 1418] {
                let result: SysResult<()> = trace(detailed).native("read", "CF_DIBV5", 17, || {
                    Err(clipboard_win::ErrorCode::new_system(code))
                });
                assert_eq!(result.unwrap_err().raw_code(), code);
            }
        }
    }

    #[test]
    fn size_observation_preserves_empty_and_nonempty_results() {
        for detailed in [false, true] {
            for size in [None, NonZeroUsize::new(4096)] {
                let calls = Cell::new(0);
                let result = trace(detailed).size("CF_DIBV5", 17, || {
                    calls.set(calls.get() + 1);
                    size
                });
                assert_eq!(result, size);
                assert_eq!(calls.get(), 1);
            }
        }
    }
}
