// Win32 (C++) version of the DEV native window experiment.
//
// Rust owns the process and the main thread. It calls the C entry point
// `vpaste_native_demo_show` on the main thread; this file only builds the
// Win32 UI and forwards every interaction to the Rust callback table declared
// in ../NativeDemoBridge.h. Tauri's event loop already pumps messages for all
// windows on that thread, but it does not call IsDialogMessage, so Enter in
// the text field is handled by subclassing the edit control.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <commctrl.h>

#include <string>

#include "NativeDemoBridge.h"

namespace {

constexpr wchar_t kClassName[] = L"VPasteNativeDemoWindow";
constexpr UINT kBaseDpi = 96;
constexpr int kClientWidth = 440;
constexpr int kClientHeight = 310;
constexpr int kBodyFontPx = 15;
constexpr int kTitleFontPx = 22;
constexpr DWORD kWindowStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
constexpr DWORD kWindowExStyle = WS_EX_LAYERED;

enum ControlId : int {
    kIdInput = 101,
    kIdProcess = 102,
    kIdSlider = 103,
    kIdOnTop = 104,
};

struct DemoWindow {
    VPasteRustCallbacks rust{};
    HWND window = nullptr;
    HWND title = nullptr;
    HWND subtitle = nullptr;
    HWND input = nullptr;
    HWND process = nullptr;
    HWND result = nullptr;
    HWND slider = nullptr;
    HWND opacity = nullptr;
    HWND onTop = nullptr;
    HWND counter = nullptr;
    HFONT bodyFont = nullptr;
    HFONT titleFont = nullptr;
    uint32_t interactions = 0;
};

// Main thread only; created on first show and kept for reuse.
DemoWindow *g_demo = nullptr;

std::wstring Utf8ToWide(const char *text) {
    const int length = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
    if (length <= 1) {
        return {};
    }
    std::wstring wide(static_cast<size_t>(length - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text, -1, wide.data(), length);
    return wide;
}

std::string WideToUtf8(const std::wstring &text) {
    if (text.empty()) {
        return {};
    }
    const int length = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (length <= 1) {
        return {};
    }
    std::string utf8(static_cast<size_t>(length - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, utf8.data(), length, nullptr, nullptr);
    return utf8;
}

/// Copies a Rust-owned string and hands it back to Rust for release.
std::wstring TakeRustString(const DemoWindow &demo, char *value) {
    if (value == nullptr) {
        return {};
    }
    std::wstring text = Utf8ToWide(value);
    demo.rust.free_string(value);
    return text;
}

std::wstring WindowText(HWND control) {
    const int length = GetWindowTextLengthW(control);
    if (length <= 0) {
        return {};
    }
    std::wstring text(static_cast<size_t>(length) + 1, L'\0');
    const int copied = GetWindowTextW(control, text.data(), length + 1);
    text.resize(static_cast<size_t>(copied > 0 ? copied : 0));
    return text;
}

int Scale(int value, UINT dpi) {
    return MulDiv(value, static_cast<int>(dpi), static_cast<int>(kBaseDpi));
}

HFONT CreateUiFont(int px, int weight, UINT dpi) {
    return CreateFontW(-Scale(px, dpi), 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                       OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                       DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
}

void ReplaceFonts(DemoWindow &demo, UINT dpi) {
    HFONT body = CreateUiFont(kBodyFontPx, FW_NORMAL, dpi);
    HFONT title = CreateUiFont(kTitleFontPx, FW_SEMIBOLD, dpi);
    SendMessageW(demo.title, WM_SETFONT, reinterpret_cast<WPARAM>(title), TRUE);
    for (HWND control : {demo.subtitle, demo.input, demo.process, demo.result, demo.opacity,
                         demo.onTop, demo.counter}) {
        SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(body), TRUE);
    }
    if (demo.bodyFont != nullptr) {
        DeleteObject(demo.bodyFont);
    }
    if (demo.titleFont != nullptr) {
        DeleteObject(demo.titleFont);
    }
    demo.bodyFont = body;
    demo.titleFont = title;
}

/// Positions children from a 96-DPI layout scaled to the window's DPI.
void Layout(const DemoWindow &demo, UINT dpi) {
    const auto place = [dpi](HWND control, int x, int y, int width, int height) {
        SetWindowPos(control, nullptr, Scale(x, dpi), Scale(y, dpi), Scale(width, dpi),
                     Scale(height, dpi), SWP_NOZORDER | SWP_NOACTIVATE);
    };
    place(demo.title, 24, 18, 392, 32);
    place(demo.subtitle, 24, 54, 392, 22);
    place(demo.input, 24, 88, 250, 28);
    place(demo.process, 286, 87, 130, 30);
    place(demo.result, 24, 128, 392, 44);
    place(demo.slider, 18, 180, 232, 32);
    place(demo.opacity, 258, 186, 158, 22);
    place(demo.onTop, 24, 224, 392, 26);
    place(demo.counter, 24, 264, 392, 22);
}

/// Sizes the outer window so the client area matches the layout at `dpi`.
void ResizeForDpi(HWND window, UINT dpi) {
    RECT rect{0, 0, Scale(kClientWidth, dpi), Scale(kClientHeight, dpi)};
    if (AdjustWindowRectExForDpi(&rect, kWindowStyle, FALSE, kWindowExStyle, dpi)) {
        SetWindowPos(window, nullptr, 0, 0, rect.right - rect.left, rect.bottom - rect.top,
                     SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

/// Opens on the monitor under the cursor, i.e. where the toolbar was clicked.
void CenterOnCursorMonitor(HWND window) {
    POINT cursor{};
    if (!GetCursorPos(&cursor)) {
        return;
    }
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST), &info)) {
        return;
    }
    RECT frame{};
    if (!GetWindowRect(window, &frame)) {
        return;
    }
    const RECT &work = info.rcWork;
    const int width = frame.right - frame.left;
    const int height = frame.bottom - frame.top;
    const int x = work.left + (work.right - work.left - width) / 2;
    const int y = work.top + (work.bottom - work.top - height) / 2;
    SetWindowPos(window, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void RecordInteraction(DemoWindow &demo) {
    demo.interactions += 1;
    const std::wstring label = TakeRustString(demo, demo.rust.interaction_label(demo.interactions));
    SetWindowTextW(demo.counter, label.c_str());
}

void ProcessText(DemoWindow &demo) {
    const std::string text = WideToUtf8(WindowText(demo.input));
    const std::wstring result = TakeRustString(demo, demo.rust.describe_text(text.c_str()));
    SetWindowTextW(demo.result, result.c_str());
    RecordInteraction(demo);
}

void SliderChanged(DemoWindow &demo) {
    const auto position = SendMessageW(demo.slider, TBM_GETPOS, 0, 0);
    const double opacity = demo.rust.opacity_for_slider(static_cast<double>(position));
    const auto alpha = static_cast<BYTE>(opacity * 255.0 + 0.5);
    SetLayeredWindowAttributes(demo.window, 0, alpha, LWA_ALPHA);
    const std::wstring label = TakeRustString(demo, demo.rust.opacity_label(opacity));
    SetWindowTextW(demo.opacity, label.c_str());
    RecordInteraction(demo);
}

void ToggleOnTop(DemoWindow &demo) {
    const bool checked = SendMessageW(demo.onTop, BM_GETCHECK, 0, 0) == BST_CHECKED;
    SetWindowPos(demo.window, checked ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    RecordInteraction(demo);
}

/// Paints labels on the window background; secondary labels are dimmed.
LRESULT ColorStatic(HDC hdc, HWND control) {
    SetBkMode(hdc, TRANSPARENT);
    if (g_demo != nullptr && (control == g_demo->subtitle || control == g_demo->counter)) {
        SetTextColor(hdc, GetSysColor(COLOR_GRAYTEXT));
    }
    return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
}

void DpiChanged(HWND window, UINT dpi, const RECT &suggested) {
    SetWindowPos(window, nullptr, suggested.left, suggested.top, suggested.right - suggested.left,
                 suggested.bottom - suggested.top, SWP_NOZORDER | SWP_NOACTIVATE);
    if (g_demo != nullptr) {
        ReplaceFonts(*g_demo, dpi);
        Layout(*g_demo, dpi);
    }
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case WM_COMMAND:
        if (g_demo != nullptr && HIWORD(wparam) == BN_CLICKED) {
            switch (LOWORD(wparam)) {
            case kIdProcess:
                ProcessText(*g_demo);
                break;
            case kIdOnTop:
                ToggleOnTop(*g_demo);
                break;
            default:
                break;
            }
        }
        return 0;
    case WM_HSCROLL:
        if (g_demo != nullptr && reinterpret_cast<HWND>(lparam) == g_demo->slider) {
            SliderChanged(*g_demo);
        }
        return 0;
    case WM_CTLCOLORSTATIC:
        return ColorStatic(reinterpret_cast<HDC>(wparam), reinterpret_cast<HWND>(lparam));
    case WM_ACTIVATE:
        if (g_demo != nullptr) {
            g_demo->rust.set_key_window(LOWORD(wparam) != WA_INACTIVE);
        }
        break;
    case WM_DPICHANGED:
        DpiChanged(window, LOWORD(wparam), *reinterpret_cast<const RECT *>(lparam));
        return 0;
    case WM_CLOSE:
        // Keep the window and its state for the next open.
        if (g_demo != nullptr) {
            g_demo->rust.set_key_window(false);
        }
        ShowWindow(window, SW_HIDE);
        return 0;
    default:
        break;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

/// Single-line edits beep on Enter outside a dialog; treat it as submit.
LRESULT CALLBACK InputProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam,
                           UINT_PTR /*id*/, DWORD_PTR /*data*/) {
    if (message == WM_CHAR && wparam == VK_RETURN) {
        if (g_demo != nullptr) {
            ProcessText(*g_demo);
        }
        return 0;
    }
    return DefSubclassProc(window, message, wparam, lparam);
}

HWND CreateChild(HWND parent, HINSTANCE instance, const wchar_t *className, const wchar_t *text,
                 DWORD style, int id) {
    return CreateWindowExW(0, className, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 0, 0, parent,
                           reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance, nullptr);
}

bool CreateDemoWindow(DemoWindow &demo) {
    HINSTANCE instance = GetModuleHandleW(nullptr);
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_BAR_CLASSES | ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&controls);

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = WindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    windowClass.lpszClassName = kClassName;
    // A zero atom on a retry only means the class is already registered.
    RegisterClassExW(&windowClass);

    demo.window = CreateWindowExW(kWindowExStyle, kClassName, L"vPaste 原生窗口实验（Win32 C++）",
                                  kWindowStyle, CW_USEDEFAULT, CW_USEDEFAULT, kClientWidth,
                                  kClientHeight, nullptr, nullptr, instance, nullptr);
    if (demo.window == nullptr) {
        return false;
    }
    // Layered windows stay invisible until their attributes are set.
    SetLayeredWindowAttributes(demo.window, 0, 255, LWA_ALPHA);

    demo.title = CreateChild(demo.window, instance, L"STATIC", L"原生 Win32 窗口（C++）", SS_LEFT, 0);
    demo.subtitle = CreateChild(demo.window, instance, L"STATIC",
                                L"由 C++ 编写，Rust 主线程通过 C 接口调用", SS_LEFT, 0);
    demo.input = CreateChild(demo.window, instance, L"EDIT", L"",
                             WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, kIdInput);
    SendMessageW(demo.input, EM_SETCUEBANNER, TRUE,
                 reinterpret_cast<LPARAM>(L"输入文字后按回车或点按钮"));
    demo.process = CreateChild(demo.window, instance, L"BUTTON", L"交给 Rust 处理",
                               WS_TABSTOP | BS_PUSHBUTTON, kIdProcess);
    demo.result = CreateChild(demo.window, instance, L"STATIC", L"结果会显示在这里", SS_LEFT, 0);
    demo.slider = CreateChild(demo.window, instance, TRACKBAR_CLASSW, L"", WS_TABSTOP, kIdSlider);
    demo.opacity = CreateChild(demo.window, instance, L"STATIC",
                               TakeRustString(demo, demo.rust.opacity_label(1.0)).c_str(), SS_LEFT, 0);
    demo.onTop = CreateChild(demo.window, instance, L"BUTTON", L"保持在最前",
                             WS_TABSTOP | BS_AUTOCHECKBOX, kIdOnTop);
    demo.counter = CreateChild(demo.window, instance, L"STATIC",
                               TakeRustString(demo, demo.rust.interaction_label(0)).c_str(), SS_LEFT, 0);

    SetWindowSubclass(demo.input, InputProc, 1, 0);
    const int minOpacity = static_cast<int>(demo.rust.min_opacity_percent);
    SendMessageW(demo.slider, TBM_SETRANGE, TRUE, MAKELPARAM(minOpacity, 100));
    SendMessageW(demo.slider, TBM_SETPOS, TRUE, 100);
    SendMessageW(demo.onTop, BM_SETCHECK, BST_CHECKED, 0);
    SetWindowPos(demo.window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);

    UINT dpi = GetDpiForWindow(demo.window);
    if (dpi < kBaseDpi) {
        dpi = kBaseDpi;
    }
    ReplaceFonts(demo, dpi);
    ResizeForDpi(demo.window, dpi);
    Layout(demo, dpi);
    return true;
}

} // namespace

extern "C" void vpaste_native_demo_show(const VPasteRustCallbacks *callbacks) {
    if (g_demo == nullptr) {
        // Published before creation so messages sent during creation can see it.
        g_demo = new DemoWindow{};
        g_demo->rust = *callbacks;
        if (!CreateDemoWindow(*g_demo)) {
            if (g_demo->window != nullptr) {
                DestroyWindow(g_demo->window);
            }
            delete g_demo;
            g_demo = nullptr;
            return;
        }
    }
    if (!IsWindowVisible(g_demo->window)) {
        CenterOnCursorMonitor(g_demo->window);
    }
    ShowWindow(g_demo->window, SW_SHOW);
    SetForegroundWindow(g_demo->window);
    SetFocus(g_demo->input);
}
