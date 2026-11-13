//! Physical docking geometry shared with the shipping clipboard panel.
use crate::ScreenBounds;
use tauri::AppHandle;
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::WindowsAndMessaging::GetWindowRect,
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PanelLayout {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    screen_scale: f64,
    panel_scale: f64,
}

fn from_bounds(bounds: ScreenBounds, panel_scale: f64) -> PanelLayout {
    let shared = crate::clipboard_window_layout(bounds, panel_scale);
    let (width, height) = crate::clipboard_window_physical_size(shared);
    let bottom = ((bounds.y + bounds.height) * bounds.scale_factor).round() as i32;
    PanelLayout {
        x: (shared.x * shared.scale_factor).round() as i32,
        y: bottom - height as i32,
        width: width as i32,
        height: height as i32,
        screen_scale: shared.scale_factor,
        // WinUI keeps its native accessibility text scaling. Only the saved
        // panel-size preference is applied by the outer Viewbox.
        panel_scale,
    }
}

fn apply(bounds: ScreenBounds, panel_scale: f64) -> Result<(), String> {
    let layout = from_bounds(bounds, panel_scale);
    let panel = super::api()?;
    // SAFETY: the C export synchronously copies this repr(C) layout onto the
    // owning STA; it never retains this borrowed pointer after returning.
    super::check_hresult("docked layout", unsafe { (panel.set_layout)(&layout) })
}

pub(super) fn before_show(app: &AppHandle) -> Result<(), String> {
    let monitor = crate::target_clipboard_monitor_for_app(app);
    let bounds = monitor
        .as_ref()
        .map(crate::screen_bounds_from_monitor)
        .unwrap_or_else(crate::default_screen_bounds);
    let panel_scale = crate::panel_size::use_configured_size(monitor.as_ref()).scale();
    // Moving the hidden HWND establishes its real per-monitor DPI. Tauri's
    // initial monitor metadata can differ from the WinUI STA's DPI context.
    // Calibrate against the native HWND before showing, not after a visible snap.
    apply(bounds, panel_scale)?;
    refresh(app)
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetDpiForWindow(window: HWND) -> u32;
    fn SetThreadDpiAwarenessContext(context: isize) -> isize;
}

// Both docking and Space preview need raw pixels, even when invoked from a
// thread whose DPI context differs from the WinUI STA. Restore it before any
// Tauri calls or async work, and on every Win32 failure path.
pub(super) fn physical_geometry(window: HWND) -> Option<(MONITORINFO, RECT, f64)> {
    if window.0 == 0 {
        return None;
    }
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let mut rect = RECT::default();
    // SAFETY: this bounded synchronous block changes only the current thread's
    // context; all output buffers live through the calls, and no branch exits
    // after a successful context change until its previous value is restored.
    unsafe {
        let previous = SetThreadDpiAwarenessContext(-4); // PER_MONITOR_AWARE_V2
        if previous == 0 {
            return None;
        }
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let valid = GetMonitorInfoW(monitor, &mut info).as_bool()
            && GetWindowRect(window, &mut rect).is_ok();
        let dpi = GetDpiForWindow(window);
        let restored = SetThreadDpiAwarenessContext(previous) != 0;
        (valid && restored && dpi > 0).then_some((info, rect, f64::from(dpi) / 96.0))
    }
}

pub(super) fn refresh(app: &AppHandle) -> Result<(), String> {
    let panel = super::api()?;
    // SAFETY: this export only snapshots the HWND under its native mutex.
    let window = HWND(unsafe { (panel.window_handle)() } as isize);
    let (info, _, scale) = physical_geometry(window)
        .ok_or_else(|| "The native panel's physical display geometry is unavailable".to_string())?;
    let r = info.rcMonitor;
    let monitor = app
        .monitor_from_point(
            f64::from(r.left + (r.right - r.left) / 2),
            f64::from(r.top + (r.bottom - r.top) / 2),
        )
        .map_err(|error| error.to_string())?;
    let panel_scale = crate::panel_size::use_configured_size(monitor.as_ref()).scale();
    apply(
        ScreenBounds {
            x: f64::from(r.left) / scale,
            y: f64::from(r.top) / scale,
            width: f64::from(r.right - r.left) / scale,
            height: f64::from(r.bottom - r.top) / scale,
            scale_factor: scale,
        },
        panel_scale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_panel_matches_shipping_size_and_has_exact_physical_bottom_edges() {
        for screen_scale in [1.0, 1.5, 2.0] {
            for (x, y) in [(0.0, 0.0), (-1920.0, -200.0), (1920.0, 240.0)] {
                for panel_scale in [0.8, 0.9, 1.0] {
                    let bounds = ScreenBounds {
                        x,
                        y,
                        width: 1920.0,
                        height: 1080.0,
                        scale_factor: screen_scale,
                    };
                    let shared = crate::clipboard_window_layout(bounds, panel_scale);
                    let native = from_bounds(bounds, panel_scale);
                    let size = crate::clipboard_window_physical_size(shared);
                    assert_eq!(
                        (native.width, native.height),
                        (size.0 as i32, size.1 as i32)
                    );
                    assert_eq!(native.x, (x * screen_scale).round() as i32);
                    assert_eq!(
                        native.y + native.height,
                        ((y + 1080.0) * screen_scale).round() as i32
                    );
                    assert!((f64::from(native.y) - shared.target_y * screen_scale).abs() <= 1.0);
                    assert_eq!(native.screen_scale, screen_scale);
                    assert_eq!(native.panel_scale, panel_scale);
                }
            }
        }
    }

    #[test]
    fn native_layout_abi_uses_four_integers_and_two_doubles() {
        assert_eq!(std::mem::size_of::<PanelLayout>(), 32);
        assert_eq!(std::mem::align_of::<PanelLayout>(), 8);
    }

    #[test]
    fn failed_native_geometry_query_restores_the_calling_threads_dpi_context() {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetThreadDpiAwarenessContext() -> isize;
            fn AreDpiAwarenessContextsEqual(first: isize, second: isize) -> i32;
        }
        // SAFETY: these query the current test thread; the invalid HWND is a
        // documented Win32 failure, not a dereference in Rust.
        let before = unsafe { GetThreadDpiAwarenessContext() };
        assert!(physical_geometry(HWND(1)).is_none());
        let after = unsafe { GetThreadDpiAwarenessContext() };
        assert_ne!(unsafe { AreDpiAwarenessContextsEqual(before, after) }, 0);
    }
}
