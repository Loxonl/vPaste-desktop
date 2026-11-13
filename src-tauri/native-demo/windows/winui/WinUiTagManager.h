#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {

class TagManager {
public:
    using RequestCallback = std::function<std::uint64_t(
        const std::wstring &operation, std::int64_t id, const std::wstring &name)>;
    using CloseCallback = std::function<void()>;

    TagManager(RequestCallback request, CloseCallback close);
    ~TagManager();

    TagManager(const TagManager &) = delete;
    TagManager &operator=(const TagManager &) = delete;
    TagManager(TagManager &&) noexcept;
    TagManager &operator=(TagManager &&) noexcept;

    winrt::Microsoft::UI::Xaml::FrameworkElement Root() const;
    void Refresh();
    void SetTags(winrt::Windows::Data::Json::JsonArray const &tags);
    void SetError(const std::wstring &message);
    void SetLanguage(bool english);
    void SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme theme);

private:
    struct Impl;
    std::shared_ptr<Impl> m_impl;
};

} // namespace vpaste::winui
