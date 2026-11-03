//! Move the acrylic HWND as one surface. Moving only WebView2 would leave the
//! native backdrop and shadow behind. No animation waits run on the UI thread.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub(crate) fn set_position(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    scale: f64,
    generation: u64,
) -> Result<bool, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let window_clone = window.clone();
    window
        .run_on_main_thread(move || {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
            };

            let result = (|| {
                // Check again after dispatch, so an old queued frame cannot move a
                // newly reopened panel or its settings size preview.
                if crate::CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) != generation {
                    return Ok(false);
                }
                let hwnd = window_clone.hwnd().map_err(|error| error.to_string())?;
                unsafe {
                    SetWindowPos(
                        HWND(hwnd.0 as isize),
                        HWND(0),
                        (x * scale).round() as i32,
                        (y * scale).round() as i32,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
                    )
                    .map_err(|error| error.to_string())?;
                }
                Ok(true)
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?
}

pub(crate) fn wait_for_frame() {
    let started = Instant::now();
    let composed = unsafe { windows::Win32::Graphics::Dwm::DwmFlush() }.is_ok();
    // DWM can return immediately when no presentation is queued. Keep that
    // path bounded, and retain a fallback when composition is unavailable.
    if !composed || started.elapsed() < Duration::from_millis(1) {
        std::thread::sleep(Duration::from_millis(8));
    }
}
