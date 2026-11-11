#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {

class QueueView {
public:
    using RequestCallback = std::function<void(
        const std::wstring &operation, const std::wstring &hash,
        const std::vector<std::wstring> &hashes)>;
    using CloseCallback = std::function<void()>;

    QueueView(RequestCallback request, CloseCallback close);
    ~QueueView();

    QueueView(const QueueView &) = delete;
    QueueView &operator=(const QueueView &) = delete;
    QueueView(QueueView &&) noexcept;
    QueueView &operator=(QueueView &&) noexcept;

    winrt::Microsoft::UI::Xaml::FrameworkElement Root() const;
    void SetState(winrt::Windows::Data::Json::JsonObject const &state);
    void SetError(const std::wstring &message);
    void SetLanguage(bool english);
    void SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme theme);
    void AddItems(const std::vector<std::wstring> &hashes);

private:
    struct Impl;
    std::shared_ptr<Impl> m_impl;
};

} // namespace vpaste::winui
