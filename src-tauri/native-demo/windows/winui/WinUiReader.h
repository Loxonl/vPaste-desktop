#pragma once
#include <windows.h>
#undef GetCurrentTime
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {
// One lazy auxiliary island on the existing WinUI STA. It never owns a loop.
class Reader {
public:
    using Request = std::function<void(std::wstring const &, std::uint64_t)>;
    explicit Reader(Request request, HWND owner = nullptr);
    ~Reader();
    void Receive(winrt::Windows::Data::Json::JsonObject const &response);
    void SetAppearance(bool english, winrt::Microsoft::UI::Xaml::ElementTheme theme);
#ifdef _DEBUG
    winrt::Microsoft::UI::Xaml::FrameworkElement TestRoot() const;
    friend winrt::Windows::Foundation::IAsyncAction TestReaderControls(std::uint32_t &stage);
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};
std::uintptr_t ReaderWindowHandle() noexcept;
#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestReaderControls(std::uint32_t &stage);
#endif
}
