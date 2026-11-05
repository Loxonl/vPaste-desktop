//! Keep the padded window logo's native transparency mask consistent with its alpha.

use std::sync::LazyLock;

use tauri::image::Image;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIcon, DestroyIcon, SendMessageW, HICON, ICON_SMALL, WM_SETICON,
};

// Windows borrows the HICON. Share one for the process lifetime so destroying an
// auxiliary window cannot invalidate another window's icon.
static WINDOW_ICON: LazyLock<Result<NativeIcon, String>> = LazyLock::new(|| {
    let image = super::build_vpaste_window_icon().map_err(|err| err.to_string())?;
    NativeIcon::from_image(&image).map_err(|err| err.to_string())
});

pub(super) fn apply(window: &tauri::Window) -> tauri::Result<()> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let result = target
            .hwnd()
            .map_err(|err| err.to_string())
            .and_then(|hwnd| {
                let icon = WINDOW_ICON.as_ref().map_err(Clone::clone)?;
                icon.set_for_window(HWND(hwnd.0 as isize));
                Ok(())
            });
        if let Err(err) = result {
            log::error!("Failed to set Windows window icon: {err}");
        }
    })
}

struct NativeIcon {
    handle: HICON,
}

impl NativeIcon {
    fn from_image(image: &Image<'_>) -> windows::core::Result<Self> {
        let width = image.width() as usize;
        // CreateIcon's monochrome AND bitmap is packed MSB-first and WORD-aligned,
        // not one alpha byte per pixel as in the runtime's RGBA conversion.
        let stride = width.div_ceil(16) * 2;
        let mut mask = vec![0_u8; stride * image.height() as usize];
        let mut bgra = image.rgba().to_vec();
        for (index, pixel) in bgra.chunks_exact_mut(4).enumerate() {
            if pixel[3] == 0 {
                mask[index / width * stride + index % width / 8] |= 0x80 >> (index % width % 8);
            }
            pixel.swap(0, 2);
        }
        // SAFETY: the internal image builder supplies a complete 32-bit image;
        // both buffers cover every scanline and stay alive until CreateIcon copies them.
        unsafe {
            CreateIcon(
                None,
                image.width() as i32,
                image.height() as i32,
                1,
                32,
                mask.as_ptr(),
                bgra.as_ptr(),
            )
            .map(|handle| Self { handle })
        }
    }

    fn set_for_window(&self, hwnd: HWND) {
        // SAFETY: called on the owning UI thread; WINDOW_ICON outlives all windows.
        // Only replace the small icon, matching the previous Tauri set_icon behavior.
        unsafe {
            SendMessageW(
                hwnd,
                WM_SETICON,
                WPARAM(ICON_SMALL as usize),
                LPARAM(self.handle.0),
            );
        }
    }
}

impl Drop for NativeIcon {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns the handle returned by CreateIcon.
        unsafe {
            let _ = DestroyIcon(self.handle);
        }
    }
}
