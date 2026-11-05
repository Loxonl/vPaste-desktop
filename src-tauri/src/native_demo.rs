//! Debug-only native window opened from the DEV toolbar.
//!
//! It evaluates a native (non-WebView) UI written in each platform's own
//! language: Swift/AppKit on macOS and C++/Win32 on Windows
//! (src-tauri/native-demo/). Rust stays the process owner, calls the window
//! through a C interface on the main thread and supplies the shared logic
//! below through callbacks. Reachable only from Debug builds with `--dev-mode`.

mod ffi;

pub(crate) use ffi::{is_key_window, show};

/// Text shown after the user submits the input field.
pub(crate) fn describe_text(text: &str) -> String {
    if text.is_empty() {
        return "请先输入一些文字".to_string();
    }
    let count = text.chars().count();
    let reversed: String = text.chars().rev().collect();
    format!("Rust 收到 {count} 个字符 · 反转：{reversed}")
}

/// Window alpha for a slider value in percent; clamped to a visible range.
pub(crate) fn opacity_for_slider(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.0;
    }
    (value.clamp(MIN_OPACITY_PERCENT, 100.0) / 100.0).clamp(0.0, 1.0)
}

pub(crate) fn opacity_label(opacity: f64) -> String {
    format!("窗口不透明度：{:.0}%", opacity * 100.0)
}

pub(crate) fn interaction_label(count: u32) -> String {
    format!("交互次数：{count}")
}

pub(crate) const MIN_OPACITY_PERCENT: f64 = 40.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_text_prompts_for_empty_input() {
        assert_eq!(describe_text(""), "请先输入一些文字");
    }

    #[test]
    fn describe_text_counts_unicode_scalars_and_reverses() {
        assert_eq!(describe_text("vPaste"), "Rust 收到 6 个字符 · 反转：etsaPv");
        assert_eq!(describe_text("你好"), "Rust 收到 2 个字符 · 反转：好你");
    }

    #[test]
    fn opacity_is_clamped_to_visible_range() {
        assert_eq!(opacity_for_slider(100.0), 1.0);
        assert_eq!(opacity_for_slider(10.0), 0.4);
        assert_eq!(opacity_for_slider(250.0), 1.0);
        assert_eq!(opacity_for_slider(f64::NAN), 1.0);
    }

    #[test]
    fn labels_are_formatted() {
        assert_eq!(opacity_label(0.75), "窗口不透明度：75%");
        assert_eq!(interaction_label(3), "交互次数：3");
    }
}
