#[cfg(target_os = "windows")]
pub mod image_convert;
#[cfg(target_os = "windows")]
pub(crate) mod listen;

// OpenClipboard(NULL) is not a cross-thread lock inside our process. Serialize
// native access so the listener cannot read a partially restored payload or
// close another thread's clipboard handle.
static CLIPBOARD_ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn lock_clipboard_access() -> std::sync::MutexGuard<'static, ()> {
    CLIPBOARD_ACCESS
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}
