#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>

namespace vpaste::winui {

// App-wide toolbar actions; existing Rust services own the data and effects.
class AppActions {
public:
    using Request = std::function<std::uint64_t(const std::wstring &, const std::wstring &)>;
    using Report = std::function<void(const winrt::hstring &, bool)>;
    AppActions(winrt::Microsoft::UI::Xaml::FrameworkElement owner, Request request, Report report,
        std::function<void()> restoreFocus);
    ~AppActions();
    AppActions(AppActions const &) = delete;
    AppActions &operator=(AppActions const &) = delete;

    winrt::Microsoft::UI::Xaml::Controls::AppBarButton ToolsButton() const;
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton UpdateButton() const;
    bool Receive(winrt::Windows::Data::Json::JsonObject const &response);
    bool ModalOpen() const;
    void SetLanguage(bool english);
    void SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme theme);
    void Deactivate();
#ifdef _DEBUG
    winrt::Microsoft::UI::Xaml::Controls::ContentDialog TestDialog() const;
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestAppActionsControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement owner, std::uint32_t &stage);
#endif
}
