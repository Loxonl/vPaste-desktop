#pragma once
#include <windows.h>
#undef GetCurrentTime
#include <functional>
#include <winrt/Microsoft.UI.Xaml.Hosting.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>

namespace vpaste::winui {
// An auxiliary island on the panel's existing STA; never owns the message loop.
class QueueWindow {
public:
    QueueWindow(HWND reference, winrt::Microsoft::UI::Xaml::FrameworkElement content,
        std::function<void()> close);
    ~QueueWindow();
    QueueWindow(const QueueWindow &) = delete;
    QueueWindow &operator=(const QueueWindow &) = delete;
    void Show(double textScale, bool reposition = false);
    void Hide();
    void SetAppearance(bool english, winrt::Microsoft::UI::Xaml::ElementTheme theme);
    HWND Handle() const { return window; }
private:
    static LRESULT CALLBACK WindowProc(HWND, UINT, WPARAM, LPARAM);
    void Resize();
    HWND window = nullptr, reference = nullptr;
    std::function<void()> close;
    winrt::Microsoft::UI::Xaml::Hosting::DesktopWindowXamlSource source{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Viewbox viewport{nullptr};
    double textScale = 1;
    bool positioned = false;
};
}
