#pragma once
#include "WinUiMotion.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <utility>
#include <winrt/Microsoft.UI.Dispatching.h>

namespace vpaste::winui {
// The complete HWND moves, including Acrylic and the DWM frame. Only this STA
// timer owns the dock position; layout changes settle it before applying bounds.
class DockMotion {
public:
    DockMotion(HWND handle, bool &layoutGuard) : window(handle), applyingLayout(layoutGuard) {
        timer = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread().CreateTimer();
        timer.Tick([this](auto const &, auto const &) { Step(); });
    }
    ~DockMotion() { timer.Stop(); }
    void Configure(winrt::Windows::Data::Json::JsonObject const &data) {
        showMs = data.GetNamedNumber(L"showMs"); hideMs = data.GetNamedNumber(L"hideMs");
        for (std::uint32_t i = 0; i < 4; ++i) {
            showCurve[i] = data.GetNamedArray(L"showEasing").GetNumberAt(i);
            hideCurve[i] = data.GetNamedArray(L"hideEasing").GetNumberAt(i);
        }
        timer.Interval(std::chrono::milliseconds(static_cast<int>(data.GetNamedNumber(L"frameMs"))));
    }
    bool Visible() const { return requestedVisible; }
    bool Running() const { return timer.IsRunning(); }

    RECT Layout(RECT const &next, bool docked) {
        if (!docked || !EqualRect(&dock, &next)) {
            Suspend(); dock = next;
        }
        RECT placement = next;
        if (Running()) GetWindowRect(window, &placement);
        return placement;
    }
    // External DPI/display events invalidate an in-flight endpoint. A hide must
    // still finish hiding; the following layout operation supplies fresh bounds.
    void Suspend() {
        timer.Stop();
        if (!requestedVisible) ShowWindow(window, SW_HIDE);
    }
    void SetVisible(bool visible, bool animate, bool enabled = NativeAnimationsEnabled()) {
        const bool wasVisible = IsWindowVisible(window) != FALSE;
        const bool repeated = requestedVisible == visible;
        requestedVisible = visible;
        if (repeated && Running() && animate && enabled) return;
        timer.Stop();
        const auto duration = visible ? showMs : hideMs;
        if (!animate || !enabled || duration <= 0 || (repeated && wasVisible == visible)) {
            Finish(); return;
        }
        if (visible && !wasVisible) Move(dock.bottom);
        RECT current{}; winrt::check_bool(GetWindowRect(window, &current));
        from = current.top; to = visible ? dock.top : dock.bottom;
        if (visible) ShowWindow(window, IsIconic(window) ? SW_RESTORE : SW_SHOW);
        if (from == to || (!visible && !wasVisible)) { Finish(); return; }
        durationMs = duration; started = std::chrono::steady_clock::now(); timer.Start();
    }
    void Finish() {
        timer.Stop();
        // Park at the canonical dock bounds, not below a different monitor.
        if (!requestedVisible) ShowWindow(window, SW_HIDE);
        Move(dock.top);
        if (requestedVisible) ShowWindow(window, IsIconic(window) ? SW_RESTORE : SW_SHOW);
    }
private:
    void Move(LONG y) {
        const auto previous = std::exchange(applyingLayout, true);
        const auto moved = SetWindowPos(window, nullptr, dock.left, y, 0, 0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        applyingLayout = previous;
        winrt::check_bool(moved);
    }
    void Step() noexcept {
        try {
            const auto elapsed = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - started).count();
            const auto progress = std::clamp(elapsed / durationMs, 0.0, 1.0);
            if (progress >= 1 || !NativeAnimationsEnabled()) { Finish(); return; }
            Move(static_cast<LONG>(std::lround(from + (to - from) *
                BezierProgress(progress, requestedVisible ? showCurve : hideCurve))));
        } catch (winrt::hresult_error const &error) {
            timer.Stop();
            std::fprintf(stderr, "WinUI dock motion failed: 0x%08X\n", static_cast<unsigned>(error.code()));
            if (!requestedVisible) ShowWindow(window, SW_HIDE);
        }
    }
    HWND window;
    bool &applyingLayout;
    RECT dock{};
    bool requestedVisible = false;
    LONG from = 0, to = 0;
    double showMs = 0, hideMs = 0, durationMs = 0;
    std::array<double, 4> showCurve{}, hideCurve{};
    std::chrono::steady_clock::time_point started;
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer timer{nullptr};
};
}
