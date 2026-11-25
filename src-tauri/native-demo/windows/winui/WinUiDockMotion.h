#pragma once
#include "WinUiMotion.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <utility>
#include <atomic>
#include <thread>
#include <dwmapi.h>

namespace vpaste::winui {
// The complete HWND moves, including Acrylic and the DWM frame. Only this STA
// frame callback owns the dock position; layout settles it before applying bounds.
inline constexpr UINT DockFrameMessage = WM_APP + 0x3F0;
class DockMotion {
public:
    DockMotion(HWND handle, bool &layoutGuard) : window(handle), applyingLayout(layoutGuard) {}
    ~DockMotion() { Stop(); }
    void Configure(winrt::Windows::Data::Json::JsonObject const &data) {
        showMs = data.GetNamedNumber(L"showMs"); hideMs = data.GetNamedNumber(L"hideMs");
        for (std::uint32_t i = 0; i < 4; ++i) {
            showCurve[i] = data.GetNamedArray(L"showEasing").GetNumberAt(i);
            hideCurve[i] = data.GetNamedArray(L"hideEasing").GetNumberAt(i);
        }
    }
    bool Visible() const { return requestedVisible; }
    bool Running() const { return clock.joinable(); }
    void Frame() noexcept { framePosted = false; if (Running()) Step(); }

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
        Stop();
        if (!requestedVisible) ShowWindow(window, SW_HIDE);
    }
    void SetVisible(bool visible, bool animate, bool enabled = NativeAnimationsEnabled()) {
        const bool wasVisible = IsWindowVisible(window) != FALSE;
        const bool repeated = requestedVisible == visible;
        requestedVisible = visible;
        if (repeated && Running() && animate && enabled) return;
        Stop();
        const auto duration = visible ? showMs : hideMs;
        if (!animate || !enabled || duration <= 0 || (repeated && wasVisible == visible)) {
            Finish(); return;
        }
        if (visible && !wasVisible) Move(dock.bottom);
        RECT current{}; winrt::check_bool(GetWindowRect(window, &current));
        from = current.top; to = visible ? dock.top : dock.bottom;
        if (visible) ShowWindow(window, IsIconic(window) ? SW_RESTORE : SW_SHOW);
        if (from == to || (!visible && !wasVisible)) { Finish(); return; }
        durationMs = duration; started = std::chrono::steady_clock::now();
        // Match the WebView's panel_animation::windows::wait_for_frame: DWM
        // paces a worker, never an 8ms low-priority XAML dispatcher timer.
        // The worker posts at most one frame; only the owning STA moves HWND.
        clock = std::jthread([this](std::stop_token stop) {
            while (!stop.stop_requested()) {
                const auto before = std::chrono::steady_clock::now();
                const auto composed = SUCCEEDED(DwmFlush());
                if (!composed || std::chrono::steady_clock::now() - before < std::chrono::milliseconds(1))
                    std::this_thread::sleep_for(std::chrono::milliseconds(8));
                if (!stop.stop_requested() && !framePosted.exchange(true))
                    if (!PostMessageW(window, DockFrameMessage, 0, 0)) framePosted = false;
            }
        });
    }
    void Finish() {
        Stop();
        // Park at the canonical dock bounds, not below a different monitor.
        if (!requestedVisible) ShowWindow(window, SW_HIDE);
        Move(dock.top);
        if (requestedVisible) ShowWindow(window, IsIconic(window) ? SW_RESTORE : SW_SHOW);
    }
private:
    void Stop() {
        if (clock.joinable()) { clock.request_stop(); clock.join(); }
        framePosted = false;
    }
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
            Stop();
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
    std::jthread clock;
    std::atomic<bool> framePosted{false};
};
}
