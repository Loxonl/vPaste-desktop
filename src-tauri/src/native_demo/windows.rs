//! Win32 implementation of the DEV native window experiment.
//!
//! The window lives on Tauri's main thread, whose event loop already pumps
//! Win32 messages for every window on that thread. That loop does not call
//! `IsDialogMessage`, so Enter in the text field is handled by subclassing it.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, DeleteObject, GetMonitorInfoW, GetSysColor, GetSysColorBrush, MonitorFromPoint,
    SetBkMode, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, COLOR_GRAYTEXT,
    COLOR_WINDOW, DEFAULT_CHARSET, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HBRUSH, HDC, HFONT,
    MONITORINFO, MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::{
    InitCommonControlsEx, BST_CHECKED, ICC_BAR_CLASSES, ICC_STANDARD_CLASSES,
    INITCOMMONCONTROLSEX, TBM_SETPOS, TBM_SETRANGE, TRACKBAR_CLASSW,
};
use windows::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetCursorPos, GetWindowTextLengthW, GetWindowTextW,
    IsWindowVisible, LoadCursorW, RegisterClassExW, SendMessageW, SetForegroundWindow,
    SetLayeredWindowAttributes, SetWindowPos, SetWindowTextW, ShowWindow, BM_GETCHECK,
    BM_SETCHECK, BS_AUTOCHECKBOX, BS_PUSHBUTTON, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT,
    ES_AUTOHSCROLL, HMENU, HWND_NOTOPMOST, HWND_TOPMOST, IDC_ARROW, LWA_ALPHA, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOW, WA_INACTIVE, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_ACTIVATE, WM_CHAR, WM_CLOSE, WM_COMMAND, WM_CTLCOLORSTATIC, WM_DPICHANGED,
    WM_HSCROLL, WM_SETFONT, WNDCLASSEXW, WS_BORDER, WS_CAPTION, WS_CHILD, WS_EX_LAYERED,
    WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
};

use super::{
    describe_text, interaction_label, opacity_for_slider, opacity_label, MIN_OPACITY_PERCENT,
};

const CLASS_NAME: PCWSTR = w!("VPasteNativeDemoWindow");
const TBM_GETPOS: u32 = 0x0400; // WM_USER
const BASE_DPI: u32 = 96;
const CLIENT_WIDTH: i32 = 440;
const CLIENT_HEIGHT: i32 = 310;
const BODY_FONT_PX: i32 = 15;
const TITLE_FONT_PX: i32 = 22;

const ID_INPUT: u16 = 101;
const ID_PROCESS: u16 = 102;
const ID_SLIDER: u16 = 103;
const ID_ON_TOP: u16 = 104;

/// Mirrors the window's active state for the clipboard blur-hide guard,
/// which runs off the main thread.
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Handles are plain values, so window procedures can copy them out of the
/// cell without holding a borrow across re-entrant Win32 calls.
#[derive(Clone, Copy)]
struct Handles {
    window: HWND,
    title: HWND,
    subtitle: HWND,
    input: HWND,
    process: HWND,
    result: HWND,
    slider: HWND,
    opacity: HWND,
    on_top: HWND,
    counter: HWND,
    body_font: HFONT,
    title_font: HFONT,
}

thread_local! {
    static HANDLES: Cell<Option<Handles>> = const { Cell::new(None) };
    static INTERACTIONS: Cell<u32> = const { Cell::new(0) };
}

pub(crate) fn is_key_window() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Shows the window, creating it on first use. Closing only hides it, so
/// reopening keeps its state. Must run on the thread that pumps messages.
pub(crate) fn show() {
    let handles = match HANDLES.with(Cell::get) {
        Some(handles) => handles,
        None => match create() {
            Ok(handles) => {
                HANDLES.with(|cell| cell.set(Some(handles)));
                handles
            }
            Err(error) => {
                log::error!("failed to create native demo window: {error}");
                return;
            }
        },
    };
    unsafe {
        if !IsWindowVisible(handles.window).as_bool() {
            center_on_cursor_monitor(handles.window);
        }
        let _ = ShowWindow(handles.window, SW_SHOW);
        let _ = SetForegroundWindow(handles.window);
        let _ = SetFocus(handles.input);
    }
}

fn create() -> windows::core::Result<Handles> {
    unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None)?.into();
        let controls = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_BAR_CLASSES | ICC_STANDARD_CLASSES,
        };
        let _ = InitCommonControlsEx(&controls);

        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        // A zero atom on reopen after a failed create only means the class exists.
        let _ = RegisterClassExW(&class);

        let window = CreateWindowExW(
            WS_EX_LAYERED,
            CLASS_NAME,
            w!("vPaste 原生窗口实验（Win32）"),
            window_style(),
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CLIENT_WIDTH,
            CLIENT_HEIGHT,
            None,
            None,
            instance,
            None,
        );
        if window.0 == 0 {
            return Err(windows::core::Error::from_win32());
        }
        // Layered windows stay invisible until their attributes are set.
        SetLayeredWindowAttributes(window, COLORREF(0), 255, LWA_ALPHA)?;

        let child = |class: PCWSTR, text: PCWSTR, style: WINDOW_STYLE, id: u16| {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                text,
                WS_CHILD | WS_VISIBLE | style,
                0,
                0,
                0,
                0,
                window,
                HMENU(id as isize),
                instance,
                None,
            )
        };
        let label = |text: PCWSTR| child(w!("STATIC"), text, WINDOW_STYLE(0), 0);

        let dpi = GetDpiForWindow(window).max(BASE_DPI);
        let (body_font, title_font) = create_fonts(dpi);
        let title = label(w!("原生 Win32 窗口"));
        let subtitle = label(w!("由 Rust 通过 windows crate 直接创建，不经过 WebView"));
        let input = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("EDIT"),
            w!(""),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
            0,
            0,
            0,
            0,
            window,
            HMENU(ID_INPUT as isize),
            instance,
            None,
        );
        let process = child(
            w!("BUTTON"),
            w!("交给 Rust 处理"),
            WS_TABSTOP | WINDOW_STYLE(BS_PUSHBUTTON as u32),
            ID_PROCESS,
        );
        let result = label(w!("结果会显示在这里"));
        let slider = child(TRACKBAR_CLASSW, w!(""), WS_TABSTOP, ID_SLIDER);
        let opacity_text = HSTRING::from(opacity_label(1.0));
        let opacity = label(PCWSTR(opacity_text.as_ptr()));
        let on_top = child(
            w!("BUTTON"),
            w!("保持在最前"),
            WS_TABSTOP | WINDOW_STYLE(BS_AUTOCHECKBOX as u32),
            ID_ON_TOP,
        );
        let counter_text = HSTRING::from(interaction_label(0));
        let counter = label(PCWSTR(counter_text.as_ptr()));

        let handles = Handles {
            window,
            title,
            subtitle,
            input,
            process,
            result,
            slider,
            opacity,
            on_top,
            counter,
            body_font,
            title_font,
        };

        let _ = SetWindowSubclass(input, Some(input_proc), 1, 0);
        SendMessageW(
            slider,
            TBM_SETRANGE,
            WPARAM(1),
            LPARAM(make_long(MIN_OPACITY_PERCENT as i32, 100)),
        );
        SendMessageW(slider, TBM_SETPOS, WPARAM(1), LPARAM(100));
        SendMessageW(on_top, BM_SETCHECK, WPARAM(BST_CHECKED.0 as usize), LPARAM(0));
        SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)?;

        apply_fonts(&handles);
        resize_for_dpi(window, dpi);
        layout(&handles, dpi);
        Ok(handles)
    }
}

fn window_style() -> WINDOW_STYLE {
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_COMMAND => {
            let id = (wparam.0 & 0xffff) as u16;
            match id {
                ID_PROCESS => process_text(),
                ID_ON_TOP => toggle_on_top(),
                _ => {}
            }
            LRESULT(0)
        }
        WM_HSCROLL => {
            slider_changed();
            LRESULT(0)
        }
        WM_CTLCOLORSTATIC => color_static(HDC(wparam.0 as isize), HWND(lparam.0)),
        WM_ACTIVATE => {
            ACTIVE.store((wparam.0 & 0xffff) as u32 != WA_INACTIVE, Ordering::SeqCst);
            DefWindowProcW(window, message, wparam, lparam)
        }
        WM_DPICHANGED => {
            dpi_changed(window, (wparam.0 & 0xffff) as u32, lparam);
            LRESULT(0)
        }
        WM_CLOSE => {
            // Keep the window and its state for the next open.
            ACTIVE.store(false, Ordering::SeqCst);
            let _ = ShowWindow(window, SW_HIDE);
            LRESULT(0)
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

/// Single-line edits beep on Enter outside a dialog; treat it as submit.
unsafe extern "system" fn input_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_CHAR && wparam.0 == usize::from(b'\r') {
        process_text();
        return LRESULT(0);
    }
    DefSubclassProc(window, message, wparam, lparam)
}

fn process_text() {
    let Some(handles) = HANDLES.with(Cell::get) else { return };
    let text = unsafe { window_text(handles.input) };
    unsafe {
        let _ = SetWindowTextW(handles.result, &HSTRING::from(describe_text(&text)));
    }
    record_interaction(&handles);
}

fn slider_changed() {
    let Some(handles) = HANDLES.with(Cell::get) else { return };
    let position = unsafe { SendMessageW(handles.slider, TBM_GETPOS, WPARAM(0), LPARAM(0)) };
    let opacity = opacity_for_slider(position.0 as f64);
    unsafe {
        let alpha = (opacity * 255.0).round() as u8;
        let _ = SetLayeredWindowAttributes(handles.window, COLORREF(0), alpha, LWA_ALPHA);
        let _ = SetWindowTextW(handles.opacity, &HSTRING::from(opacity_label(opacity)));
    }
    record_interaction(&handles);
}

fn toggle_on_top() {
    let Some(handles) = HANDLES.with(Cell::get) else { return };
    unsafe {
        let checked = SendMessageW(handles.on_top, BM_GETCHECK, WPARAM(0), LPARAM(0));
        let after = if checked.0 == BST_CHECKED.0 as isize {
            HWND_TOPMOST
        } else {
            HWND_NOTOPMOST
        };
        let _ = SetWindowPos(
            handles.window,
            after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
    record_interaction(&handles);
}

fn record_interaction(handles: &Handles) {
    let count = INTERACTIONS.with(|cell| {
        let count = cell.get().saturating_add(1);
        cell.set(count);
        count
    });
    unsafe {
        let _ = SetWindowTextW(handles.counter, &HSTRING::from(interaction_label(count)));
    }
}

/// Paints labels on the window background; secondary labels are dimmed.
unsafe fn color_static(hdc: HDC, control: HWND) -> LRESULT {
    SetBkMode(hdc, TRANSPARENT);
    if let Some(handles) = HANDLES.with(Cell::get) {
        if control == handles.subtitle || control == handles.counter {
            SetTextColor(hdc, COLORREF(GetSysColor(COLOR_GRAYTEXT)));
        }
    }
    let brush: HBRUSH = GetSysColorBrush(COLOR_WINDOW);
    LRESULT(brush.0)
}

unsafe fn dpi_changed(window: HWND, dpi: u32, lparam: LPARAM) {
    let suggested = &*(lparam.0 as *const RECT);
    let _ = SetWindowPos(
        window,
        None,
        suggested.left,
        suggested.top,
        suggested.right - suggested.left,
        suggested.bottom - suggested.top,
        SWP_NOZORDER | SWP_NOACTIVATE,
    );
    let Some(mut handles) = HANDLES.with(Cell::get) else { return };
    let (body_font, title_font) = create_fonts(dpi);
    let _ = DeleteObject(handles.body_font);
    let _ = DeleteObject(handles.title_font);
    handles.body_font = body_font;
    handles.title_font = title_font;
    HANDLES.with(|cell| cell.set(Some(handles)));
    apply_fonts(&handles);
    layout(&handles, dpi);
}

unsafe fn create_fonts(dpi: u32) -> (HFONT, HFONT) {
    let font = |px: i32, weight: u32| {
        CreateFontW(
            -scale(px, dpi),
            0,
            0,
            0,
            weight as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET.0 as u32,
            OUT_DEFAULT_PRECIS.0 as u32,
            CLIP_DEFAULT_PRECIS.0 as u32,
            CLEARTYPE_QUALITY.0 as u32,
            FF_DONTCARE.0 as u32,
            w!("Microsoft YaHei UI"),
        )
    };
    (font(BODY_FONT_PX, FW_NORMAL.0), font(TITLE_FONT_PX, FW_SEMIBOLD.0))
}

unsafe fn apply_fonts(handles: &Handles) {
    let set = |control: HWND, font: HFONT| {
        SendMessageW(control, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
    };
    set(handles.title, handles.title_font);
    for control in [
        handles.subtitle,
        handles.input,
        handles.process,
        handles.result,
        handles.opacity,
        handles.on_top,
        handles.counter,
    ] {
        set(control, handles.body_font);
    }
}

/// Positions children from a 96-DPI layout scaled to the window's DPI.
unsafe fn layout(handles: &Handles, dpi: u32) {
    let place = |control: HWND, x: i32, y: i32, width: i32, height: i32| {
        let _ = SetWindowPos(
            control,
            None,
            scale(x, dpi),
            scale(y, dpi),
            scale(width, dpi),
            scale(height, dpi),
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    };
    place(handles.title, 24, 18, 392, 32);
    place(handles.subtitle, 24, 54, 392, 22);
    place(handles.input, 24, 88, 250, 28);
    place(handles.process, 286, 87, 130, 30);
    place(handles.result, 24, 128, 392, 44);
    place(handles.slider, 18, 180, 232, 32);
    place(handles.opacity, 258, 186, 158, 22);
    place(handles.on_top, 24, 224, 392, 26);
    place(handles.counter, 24, 264, 392, 22);
}

/// Sizes the outer window so the client area matches the layout at `dpi`.
unsafe fn resize_for_dpi(window: HWND, dpi: u32) {
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: scale(CLIENT_WIDTH, dpi),
        bottom: scale(CLIENT_HEIGHT, dpi),
    };
    if AdjustWindowRectExForDpi(&mut rect, window_style(), false, WS_EX_LAYERED, dpi).is_ok() {
        let _ = SetWindowPos(
            window,
            None,
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// Opens on the monitor under the cursor, i.e. where the toolbar was clicked.
unsafe fn center_on_cursor_monitor(window: HWND) {
    let mut cursor = POINT::default();
    if GetCursorPos(&mut cursor).is_err() {
        return;
    }
    let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return;
    }
    let mut frame = RECT::default();
    if windows::Win32::UI::WindowsAndMessaging::GetWindowRect(window, &mut frame).is_err() {
        return;
    }
    let (x, y) = centered_origin(info.rcWork, frame);
    let _ = SetWindowPos(window, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

fn centered_origin(work: RECT, frame: RECT) -> (i32, i32) {
    let width = frame.right - frame.left;
    let height = frame.bottom - frame.top;
    (
        work.left + (work.right - work.left - width) / 2,
        work.top + (work.bottom - work.top - height) / 2,
    )
}

unsafe fn window_text(control: HWND) -> String {
    let length = GetWindowTextLengthW(control).max(0) as usize;
    let mut buffer = vec![0u16; length + 1];
    let copied = GetWindowTextW(control, &mut buffer).max(0) as usize;
    String::from_utf16_lossy(&buffer[..copied])
}

fn scale(value: i32, dpi: u32) -> i32 {
    (i64::from(value) * i64::from(dpi) / i64::from(BASE_DPI)) as i32
}

fn make_long(low: i32, high: i32) -> isize {
    ((high as u32 & 0xffff) << 16 | (low as u32 & 0xffff)) as isize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_converts_from_96_dpi() {
        assert_eq!(scale(440, 96), 440);
        assert_eq!(scale(440, 144), 660);
        assert_eq!(scale(15, 120), 18);
    }

    #[test]
    fn make_long_packs_low_and_high_words() {
        assert_eq!(make_long(40, 100), (100 << 16) | 40);
    }

    #[test]
    fn centered_origin_uses_work_area() {
        let work = RECT { left: -1920, top: 0, right: 0, bottom: 1040 };
        let frame = RECT { left: 0, top: 0, right: 456, bottom: 349 };
        assert_eq!(centered_origin(work, frame), (-1188, 345));
    }
}
