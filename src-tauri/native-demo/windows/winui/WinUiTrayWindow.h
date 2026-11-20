#pragma once
#include <windows.h>
#undef GetCurrentTime
#include <cstdint>
#include <functional>
#include <memory>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {
// A lazy popup on the main WinUI STA, independent of dock visibility.
class TrayWindow {
public:
    using Request = std::function<std::uint64_t(wchar_t const *, POINT)>;
    explicit TrayWindow(Request request);
    ~TrayWindow();
    TrayWindow(const TrayWindow &) = delete;
    TrayWindow &operator=(const TrayWindow &) = delete;
    void Show(winrt::Windows::Data::Json::JsonObject const &data);
    void Update(winrt::Windows::Data::Json::JsonObject const &data);
    void Complete(std::uint64_t request, bool succeeded);
#ifdef _DEBUG
    HWND Handle() const;
    winrt::Microsoft::UI::Xaml::FrameworkElement TestRoot() const;
    friend winrt::Windows::Foundation::IAsyncAction TestTrayWindow(TrayWindow &tray, std::uint32_t &stage);
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestTrayWindow(TrayWindow &tray, std::uint32_t &stage);
#endif
}
