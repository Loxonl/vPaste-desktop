#pragma once
#include <windows.h>
#include <algorithm>
#include <winrt/base.h>

namespace vpaste::winui {
// Auxiliary HWND coordinates are already physical outer bounds. Do not apply
// the WebView main window's client-to-frame correction a second time here.
inline RECT ClampToWorkArea(RECT const &rect, RECT const &work) {
    const auto width = std::clamp<LONG>(rect.right - rect.left, 1, work.right - work.left);
    const auto height = std::clamp<LONG>(rect.bottom - rect.top, 1, work.bottom - work.top);
    const auto x = std::clamp(rect.left, work.left, work.right - width);
    const auto y = std::clamp(rect.top, work.top, work.bottom - height);
    return {x, y, x + width, y + height};
}

inline RECT FitToMonitorWorkArea(RECT const &rect) {
    MONITORINFO info{sizeof(MONITORINFO)};
    winrt::check_bool(GetMonitorInfoW(MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST), &info));
    return ClampToWorkArea(rect, info.rcWork);
}
}
