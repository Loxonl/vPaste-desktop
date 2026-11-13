#include "WinUiQueueWindow.h"
#include "WinUiAppearance.h"
#include <dwmapi.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <utility>
#include <winrt/Microsoft.UI.Interop.h>
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Input.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Windows.Graphics.h>

namespace vpaste::winui {
namespace { constexpr wchar_t QueueClass[] = L"VPasteWinUiQueueWindow"; }

QueueWindow::QueueWindow(HWND referenceWindow, winrt::Microsoft::UI::Xaml::FrameworkElement content,
    std::function<void()> onClose) : reference(referenceWindow), close(std::move(onClose)) {
    WNDCLASSEXW type{sizeof(WNDCLASSEXW)};
    type.lpfnWndProc = WindowProc; type.hInstance = GetModuleHandleW(nullptr);
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.lpszClassName = QueueClass;
    if (!RegisterClassExW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) winrt::throw_last_error();
    window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE, QueueClass,
        L"vPaste", WS_POPUP | WS_THICKFRAME | WS_SYSMENU, 0, 0, 360, 448,
        nullptr, nullptr, GetModuleHandleW(nullptr), this);
    winrt::check_bool(window != nullptr);
    try {
        source = winrt::Microsoft::UI::Xaml::Hosting::DesktopWindowXamlSource();
        source.Initialize(winrt::Microsoft::UI::GetWindowIdFromWindow(window));
        viewport = winrt::Microsoft::UI::Xaml::Controls::Viewbox();
        viewport.Stretch(winrt::Microsoft::UI::Xaml::Media::Stretch::Fill);
        viewport.ActualThemeChanged([handle = window](auto const &sender, auto const &) {
            const BOOL dark = sender.template as<winrt::Microsoft::UI::Xaml::FrameworkElement>().ActualTheme()
                == winrt::Microsoft::UI::Xaml::ElementTheme::Dark;
            (void)DwmSetWindowAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
        });
        content.Width(QueueContentWidth); content.Height(QueueContentHeight);
        viewport.Child(content); source.Content(viewport);
        source.SiteBridge().Show();
        const auto corners = DWMWCP_ROUND;
        (void)DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
        const MARGINS shadow{1, 1, 1, 1}; (void)DwmExtendFrameIntoClientArea(window, &shadow);
        // Only the heading is a move surface; queue buttons and rows keep their input.
        const auto header = content.as<winrt::Microsoft::UI::Xaml::Controls::Grid>().Children().GetAt(0)
            .as<winrt::Microsoft::UI::Xaml::Controls::Grid>();
        header.Children().GetAt(0).PointerPressed([handle = window](auto const &, auto const &args) {
            if (!args.GetCurrentPoint(nullptr).Properties().IsLeftButtonPressed()) return;
            args.Handled(true); ReleaseCapture(); SendMessageW(handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        });
    } catch (...) {
        if (source) { source.Close(); source = nullptr; }
        DestroyWindow(window); window = nullptr; throw;
    }
}

QueueWindow::~QueueWindow() {
    if (source) { source.Content(nullptr); source.Close(); source = nullptr; }
    if (window) { SetWindowLongPtrW(window, GWLP_USERDATA, 0); DestroyWindow(window); }
}

void QueueWindow::Resize() {
    if (!source) return;
    RECT bounds{}; winrt::check_bool(GetClientRect(window, &bounds));
    source.SiteBridge().MoveAndResize({0, 0, bounds.right, bounds.bottom});
}

void QueueWindow::Show(double scale, bool reposition) {
    const bool sizeChanged = textScale != scale; textScale = scale;
    if (!positioned || reposition || sizeChanged) {
        MONITORINFO info{sizeof(MONITORINFO)};
        winrt::check_bool(GetMonitorInfoW(MonitorFromWindow(reference, MONITOR_DEFAULTTONEAREST), &info));
        const auto dpi = GetDpiForWindow(reference) / 96.0;
        const auto width = std::min(info.rcWork.right - info.rcWork.left,
            static_cast<LONG>(std::lround(QueueContentWidth * dpi * scale)));
        const auto height = std::min(info.rcWork.bottom - info.rcWork.top,
            static_cast<LONG>(std::lround(QueueContentHeight * dpi * scale)));
        winrt::check_bool(SetWindowPos(window, HWND_TOPMOST,
            std::max(info.rcWork.left, info.rcWork.right - width - static_cast<LONG>(std::lround(24 * dpi))),
            info.rcWork.top + (info.rcWork.bottom - info.rcWork.top - height) / 2,
            width, height, SWP_NOACTIVATE));
        positioned = true;
    }
    Resize(); ShowWindow(window, SW_SHOWNOACTIVATE);
}

void QueueWindow::Hide() { ShowWindow(window, SW_HIDE); }

void QueueWindow::SetAppearance(bool english, winrt::Microsoft::UI::Xaml::ElementTheme theme) {
    SetWindowTextW(window, english ? L"vPaste — Paste queue" : L"vPaste — 粘贴队列");
    viewport.RequestedTheme(theme);
    const BOOL dark = viewport.ActualTheme() == winrt::Microsoft::UI::Xaml::ElementTheme::Dark;
    (void)DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
}

LRESULT CALLBACK QueueWindow::WindowProc(HWND handle, UINT message, WPARAM wparam, LPARAM lparam) {
    auto self = reinterpret_cast<QueueWindow *>(GetWindowLongPtrW(handle, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        self = static_cast<QueueWindow *>(reinterpret_cast<CREATESTRUCTW *>(lparam)->lpCreateParams);
        SetWindowLongPtrW(handle, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (!self) return DefWindowProcW(handle, message, wparam, lparam);
    try {
        switch (message) {
        case WM_NCCALCSIZE: if (wparam) return 0; break;
        // Keep the frame for DWM shadow, but preserve the fixed-size queue.
        case WM_NCHITTEST: return HTCLIENT;
        case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
        case WM_ERASEBKGND: return 1;
        case WM_SIZE: if (self->window) self->Resize(); return 0;
        case WM_DPICHANGED: {
            const auto bounds = reinterpret_cast<RECT *>(lparam);
            SetWindowPos(handle, nullptr, bounds->left, bounds->top, bounds->right - bounds->left,
                bounds->bottom - bounds->top, SWP_NOACTIVATE | SWP_NOZORDER);
            self->Resize(); return 0;
        }
        case WM_CLOSE: if (self->close) self->close(); return 0;
        case WM_GETMINMAXINFO: {
            const auto dpi = GetDpiForWindow(handle);
            auto limits = reinterpret_cast<MINMAXINFO *>(lparam);
            limits->ptMinTrackSize = {MulDiv(static_cast<int>(QueueContentWidth), dpi, 96),
                MulDiv(static_cast<int>(ManagementMinHeight), dpi, 96)};
            return 0;
        }
        }
    } catch (winrt::hresult_error const &error) {
        std::fprintf(stderr, "WinUI queue window failed: 0x%08X\n", static_cast<unsigned>(error.code()));
    }
    return DefWindowProcW(handle, message, wparam, lparam);
}
}
