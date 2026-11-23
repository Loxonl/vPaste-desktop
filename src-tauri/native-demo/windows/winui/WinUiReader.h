#pragma once
#include <windows.h>
#undef GetCurrentTime
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {
LONG ComputeBoundedDecodePixelWidth(LONG naturalWidth, LONG naturalHeight, LONG targetWidth) noexcept;
bool IsSvgImagePath(std::wstring_view path) noexcept;
// One lazy auxiliary island on the existing WinUI STA. It never owns a loop.
class Reader {
public:
    using Request = std::function<std::uint64_t(std::wstring const &, std::uint64_t, winrt::hstring const &)>;
    explicit Reader(Request request, HWND owner = nullptr, bool editor = false);
    ~Reader();
    void Receive(winrt::Windows::Data::Json::JsonObject const &response);
    void SetAppearance(bool english, winrt::Microsoft::UI::Xaml::ElementTheme theme);
    std::uint64_t Generation() const noexcept;
    bool HasOcrDraft() const;
    void CloseOcrDraft(std::function<void()> discardAction = {});
#ifdef _DEBUG
    winrt::Microsoft::UI::Xaml::FrameworkElement TestRoot() const;
    winrt::Microsoft::UI::Xaml::FrameworkElement TestDiscardDialog() const;
    friend winrt::Windows::Foundation::IAsyncAction TestReaderControls(std::uint32_t &stage);
    friend winrt::Windows::Foundation::IAsyncAction TestBatch2ReaderControls(std::vector<std::string> &failures);
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};
std::uintptr_t ReaderWindowHandle() noexcept;
#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestReaderControls(std::uint32_t &stage);
winrt::Windows::Foundation::IAsyncAction TestBatch2ReaderControls(std::vector<std::string> &failures);
#endif
}
