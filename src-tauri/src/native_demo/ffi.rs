//! Rust side of the native DEV window (src-tauri/native-demo/).
//!
//! Rust keeps ownership of the process and main thread: it calls the native
//! C entry point (Swift on macOS, C++ Win32 on Windows) and passes a table of
//! Rust callbacks, so the window's logic stays in the shared functions in
//! `super`. `Callbacks` must match `VPasteRustCallbacks` in
//! native-demo/NativeDemoBridge.h.

use std::ffi::{c_char, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};

use super::{
    describe_text, interaction_label, opacity_for_slider, opacity_label, MIN_OPACITY_PERCENT,
};

#[repr(C)]
struct Callbacks {
    describe_text: unsafe extern "C" fn(*const c_char) -> *mut c_char,
    opacity_for_slider: extern "C" fn(f64) -> f64,
    opacity_label: extern "C" fn(f64) -> *mut c_char,
    interaction_label: extern "C" fn(u32) -> *mut c_char,
    free_string: unsafe extern "C" fn(*mut c_char),
    set_key_window: extern "C" fn(bool),
    min_opacity_percent: f64,
}

extern "C" {
    /// Defined in native-demo/{macos,windows}/NativeDemoWindow.*. Main thread only.
    fn vpaste_native_demo_show(callbacks: *const Callbacks);
}

static CALLBACKS: Callbacks = Callbacks {
    describe_text: describe_text_ffi,
    opacity_for_slider: opacity_for_slider_ffi,
    opacity_label: opacity_label_ffi,
    interaction_label: interaction_label_ffi,
    free_string: free_string_ffi,
    set_key_window: set_key_window_ffi,
    min_opacity_percent: MIN_OPACITY_PERCENT,
};

static KEY_WINDOW: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_key_window() -> bool {
    KEY_WINDOW.load(Ordering::SeqCst)
}

/// Shows the native window, creating it on first use. Must run on the main thread.
pub(crate) fn show() {
    // SAFETY: called on the main thread (via `run_on_main_thread`); the table
    // is a static and the native side copies it during the call.
    unsafe { vpaste_native_demo_show(&CALLBACKS) };
}

/// Hands a string to the native side, which returns it through `free_string`.
fn into_foreign(text: String) -> *mut c_char {
    // Interior NULs cannot cross a C string boundary; drop them.
    CString::new(text.replace('\0', ""))
        .unwrap_or_default()
        .into_raw()
}

unsafe extern "C" fn describe_text_ffi(text: *const c_char) -> *mut c_char {
    let text = if text.is_null() {
        String::new()
    } else {
        // SAFETY: the native side passes a valid NUL-terminated UTF-8 C string.
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    };
    into_foreign(describe_text(&text))
}

extern "C" fn opacity_for_slider_ffi(value: f64) -> f64 {
    opacity_for_slider(value)
}

extern "C" fn opacity_label_ffi(opacity: f64) -> *mut c_char {
    into_foreign(opacity_label(opacity))
}

extern "C" fn interaction_label_ffi(count: u32) -> *mut c_char {
    into_foreign(interaction_label(count))
}

unsafe extern "C" fn free_string_ffi(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: `value` came from `into_foreign` and is released once.
        drop(unsafe { CString::from_raw(value) });
    }
}

extern "C" fn set_key_window_ffi(key: bool) {
    KEY_WINDOW.store(key, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_round_trip_through_the_c_boundary() {
        let input = CString::new("你好").unwrap();
        let output = unsafe { describe_text_ffi(input.as_ptr()) };
        let text = unsafe { CStr::from_ptr(output) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe { free_string_ffi(output) };
        assert_eq!(text, describe_text("你好"));
    }

    #[test]
    fn null_input_is_treated_as_empty() {
        let output = unsafe { describe_text_ffi(std::ptr::null()) };
        let text = unsafe { CStr::from_ptr(output) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe { free_string_ffi(output) };
        assert_eq!(text, describe_text(""));
    }

    #[test]
    fn interior_nul_is_dropped_instead_of_failing() {
        let output = into_foreign("a\0b".to_string());
        let text = unsafe { CStr::from_ptr(output) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe { free_string_ffi(output) };
        assert_eq!(text, "ab");
    }

    #[test]
    fn key_window_state_is_recorded() {
        set_key_window_ffi(true);
        assert!(is_key_window());
        set_key_window_ffi(false);
        assert!(!is_key_window());
    }
}
