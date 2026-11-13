#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {

class FilterEditor {
public:
    using Request = std::function<std::uint64_t(const std::wstring &, winrt::Windows::Data::Json::JsonObject)>;
    using Saved = std::function<void(winrt::Windows::Data::Json::JsonArray)>;
    FilterEditor(Request request, Saved saved);
    ~FilterEditor();
    FilterEditor(const FilterEditor &) = delete;
    FilterEditor &operator=(const FilterEditor &) = delete;
    FilterEditor(FilterEditor &&) = delete;
    FilterEditor &operator=(FilterEditor &&) = delete;

    void Show(winrt::Microsoft::UI::Xaml::FrameworkElement anchor,
              winrt::Windows::Data::Json::JsonObject draft, bool english,
              winrt::Microsoft::UI::Xaml::ElementTheme theme, bool confirmDelete = false,
              winrt::Microsoft::UI::Xaml::FrameworkElement owner = nullptr,
              std::function<void()> closed = {});
    void Receive(winrt::Windows::Data::Json::JsonObject response);
    void Hide();
    bool IsOpen() const;
    void SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme theme);
#ifdef _DEBUG
    winrt::Microsoft::UI::Xaml::FrameworkElement TestLoad(winrt::Windows::Data::Json::JsonObject draft, bool english);
    void TestName(const winrt::hstring &name);
    winrt::hstring TestName() const;
    void TestSave();
    void TestDelete(bool confirm);
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> m_impl;
};

#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestFilterEditorControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement fixture, std::uint32_t &stage);
#endif
} // namespace vpaste::winui
