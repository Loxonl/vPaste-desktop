//! Native dock deactivation. All final checks run on Tauri's event loop.
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

static VISIBILITY_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(super) fn visibility_changed() {
    VISIBILITY_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[derive(Default)]
struct BlurState {
    visible: bool,
    suppressed: bool,
    interacting: bool,
    internal_focus: bool,
    preview_protected: bool,
}

fn should_hide(expected: u64, current: u64, state: BlurState) -> bool {
    expected == current
        && state.visible
        && !state.suppressed
        && !state.interacting
        && !state.internal_focus
        && !state.preview_protected
}

fn process_foreground() -> bool {
    // SAFETY: read-only queries of the current foreground HWND; a closed or
    // missing window returns zero and cannot match the current process.
    unsafe {
        let mut process = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut process));
        process == std::process::id()
    }
}

pub(super) fn lost(app: AppHandle) {
    let generation = VISIBILITY_GENERATION.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        // Match the shipping panel's delayed blur check; never block the WinUI
        // callback or synchronously wait for Tauri while it is waiting for WinUI.
        std::thread::sleep(std::time::Duration::from_millis(35));
        let owner = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if !crate::main_panel_mode::winui() {
                return;
            }
            let preview_protected = crate::preview_window_visible(&owner)
                && (crate::PREVIEW_PINNED.load(Ordering::SeqCst)
                    || crate::app_window_is_foreground(&owner, "clipboardPreview", "WinUI blur")
                    || crate::cursor_inside_app_windows(&owner));
            let state = BlurState {
                visible: crate::CLIPBOARD_VISIBLE.load(Ordering::SeqCst),
                suppressed: crate::memory_profile_active()
                    || crate::clipboard_blur_hide_suppressed(),
                interacting: super::dragging() || super::modal_active(),
                internal_focus: process_foreground()
                    || crate::tab_editor_window_active(&owner)
                    || crate::text_editor_window_active(&owner)
                    || crate::memory_monitor_window_active(&owner)
                    || crate::native_demo_window_active(),
                preview_protected,
            };
            if should_hide(
                generation,
                VISIBILITY_GENERATION.load(Ordering::SeqCst),
                state,
            ) {
                crate::hide_preview_and_clipboard(&owner, "WinUI blur outside app");
            }
        }) {
            log::debug!("WinUI blur recheck could not be queued: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_deactivation_hides_an_unprotected_visible_panel() {
        assert!(should_hide(
            7,
            7,
            BlurState {
                visible: true,
                ..Default::default()
            }
        ));
    }

    #[test]
    fn reopening_or_hiding_invalidates_an_old_blur() {
        assert!(!should_hide(
            7,
            8,
            BlurState {
                visible: true,
                ..Default::default()
            }
        ));
        assert!(!should_hide(7, 7, BlurState::default()));
    }

    #[test]
    fn preserves_internal_windows_drag_dialogs_and_preview_guards() {
        for state in [
            BlurState {
                visible: true,
                suppressed: true,
                ..Default::default()
            },
            BlurState {
                visible: true,
                interacting: true,
                ..Default::default()
            },
            BlurState {
                visible: true,
                internal_focus: true,
                ..Default::default()
            },
            BlurState {
                visible: true,
                preview_protected: true,
                ..Default::default()
            },
        ] {
            assert!(!should_hide(7, 7, state));
        }
    }
}
