use clipboard_win::{Clipboard, ErrorCode, SysResult};
use std::ffi::c_void;
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetMessageW, PostMessageW, HMENU, HWND_MESSAGE, MSG,
    WM_CLIPBOARDUPDATE,
};

static CAPTURE_WINDOW: AtomicIsize = AtomicIsize::new(0);

#[link(name = "user32")]
extern "system" {
    fn AddClipboardFormatListener(window: *mut c_void) -> i32;
    fn RemoveClipboardFormatListener(window: *mut c_void) -> i32;
}

pub(super) struct CaptureMonitor {
    window: HWND,
    // The message queue and DestroyWindow belong to the creating thread.
    _thread_bound: PhantomData<Rc<()>>,
}

impl CaptureMonitor {
    pub(super) fn new() -> Result<Self, String> {
        // SAFETY: STATIC is a built-in class. This is a message-only window,
        // created, read, and destroyed on this thread; no UI or payload is shown.
        let window = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("vPasteClipboardCapture"),
                Default::default(),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                HMENU::default(),
                HINSTANCE::default(),
                None,
            )
        };
        if window.0 == 0 {
            return Err(ErrorCode::last_system().to_string());
        }
        // SAFETY: window is live and owned by this thread. Keep the original
        // error before cleanup, which can change GetLastError.
        if unsafe { AddClipboardFormatListener(window.0 as *mut c_void) } == 0 {
            let error = ErrorCode::last_system().to_string();
            unsafe {
                let _ = DestroyWindow(window);
            }
            return Err(error);
        }
        CAPTURE_WINDOW.store(window.0, Ordering::SeqCst);
        Ok(Self {
            window,
            _thread_bound: PhantomData,
        })
    }

    pub(super) fn recv(&mut self) -> Result<bool, String> {
        let mut message = MSG::default();
        // SAFETY: This window belongs to the calling thread and message is a
        // valid output buffer. Only clipboard updates/wakeups are consumed.
        match unsafe {
            GetMessageW(
                &mut message,
                self.window,
                WM_CLIPBOARDUPDATE,
                WM_CLIPBOARDUPDATE,
            )
        }
        .0
        {
            -1 => Err(ErrorCode::last_system().to_string()),
            0 => Ok(false),
            _ => Ok(true),
        }
    }

    pub(super) fn open(&self) -> SysResult<Clipboard> {
        // A real HWND excludes uncoordinated OpenClipboard(NULL) readers,
        // including libraries that cannot participate in our process mutex.
        Clipboard::new_attempts_for(self.window.0 as *mut c_void, 2)
    }

    #[cfg(test)]
    pub(super) fn try_recv(&mut self) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::{PeekMessageW, PM_REMOVE};
        let mut message = MSG::default();
        // SAFETY: Test-only nonblocking access to this thread's own window.
        unsafe {
            PeekMessageW(
                &mut message,
                self.window,
                WM_CLIPBOARDUPDATE,
                WM_CLIPBOARDUPDATE,
                PM_REMOVE,
            )
            .as_bool()
        }
    }
}

impl Drop for CaptureMonitor {
    fn drop(&mut self) {
        let _ =
            CAPTURE_WINDOW.compare_exchange(self.window.0, 0, Ordering::SeqCst, Ordering::SeqCst);
        // SAFETY: !Send/!Sync keeps cleanup on the creating thread. Unsubscribe
        // before destroying the window, just like the original native monitor.
        unsafe {
            RemoveClipboardFormatListener(self.window.0 as *mut c_void);
            let _ = DestroyWindow(self.window);
        }
    }
}

pub(super) fn request_capture() -> bool {
    let window = CAPTURE_WINDOW.load(Ordering::SeqCst);
    if window == 0 {
        return false;
    }
    // SAFETY: PostMessage is thread-safe and asynchronous. The reader is the
    // sole window owner and rechecks the actual sequence, filters, and budgets.
    unsafe { PostMessageW(HWND(window), WM_CLIPBOARDUPDATE, WPARAM(0), LPARAM(0)).is_ok() }
}
