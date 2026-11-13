#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {
class RecordTagEditor {
public:
    using Request = std::function<std::uint64_t(const std::wstring &, winrt::Windows::Data::Json::JsonObject)>;
    using Saved = std::function<void(const std::wstring &, std::int64_t, const std::wstring &)>;
    RecordTagEditor(Request request, Saved saved);
    ~RecordTagEditor();
    RecordTagEditor(const RecordTagEditor &) = delete;
    RecordTagEditor &operator=(const RecordTagEditor &) = delete;

    void Show(winrt::Microsoft::UI::Xaml::FrameworkElement anchor, std::int64_t tagId,
              const std::wstring &name, const std::wstring &hash, bool english,
              winrt::Microsoft::UI::Xaml::ElementTheme theme, bool confirmDelete = false,
              winrt::Microsoft::UI::Xaml::FrameworkElement owner = nullptr,
              std::function<void()> closed = {});
    void Receive(winrt::Windows::Data::Json::JsonObject const &response);
    void Hide();
    bool IsOpen() const;
    void SetLanguage(bool english);
    void SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme theme);
#ifdef _DEBUG
    winrt::Microsoft::UI::Xaml::FrameworkElement TestLoad(std::int64_t tagId,
        const std::wstring &name, const std::wstring &hash, bool english);
    void TestSave();
    winrt::hstring TestName() const;
    void TestName(winrt::hstring const &name);
    winrt::Microsoft::UI::Xaml::FrameworkElement TestRoot() const;
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> m_impl;
};
#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestRecordTagEditorControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement fixture, std::uint32_t &stage);
#endif
}
