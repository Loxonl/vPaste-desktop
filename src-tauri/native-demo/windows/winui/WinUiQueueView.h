#pragma once

#include <cstdint>
#include <functional>
#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {

inline std::vector<std::wstring> QueueDropOrder(const std::vector<std::wstring> &current,
    const std::wstring &source, const std::wstring &target, bool after) {
    if (source == target || std::find(current.begin(), current.end(), source) == current.end() ||
        std::find(current.begin(), current.end(), target) == current.end()) return current;
    auto result = current;
    result.erase(std::find(result.begin(), result.end(), source));
    auto position = std::find(result.begin(), result.end(), target);
    if (after) ++position;
    result.insert(position, source);
    return result;
}

class QueueView {
public:
    using RequestCallback = std::function<std::uint64_t(
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
    bool Receive(winrt::Windows::Data::Json::JsonObject const &response);
    void SetError(const std::wstring &message);
    void SetLanguage(bool english);
    void SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme theme);
    void AddItems(const std::vector<std::wstring> &hashes);
    void CancelDrag();
    void Activate();
    void Deactivate();
#ifdef _DEBUG
    bool TestBeginReorder(const std::wstring &hash);
    void TestDropReorder(const std::wstring &target, bool after);
    void TestDragScroll(int direction);
    void TestMoveByKeyboard(const std::wstring &hash, int direction);
#endif

private:
    struct Impl;
    std::shared_ptr<Impl> m_impl;
};

#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestQueueUndoExpiryControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement fixture, std::uint32_t &stage);
winrt::Windows::Foundation::IAsyncAction TestQueueFocusContinuityControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement fixture, std::uint32_t &stage);
winrt::Windows::Foundation::IAsyncAction TestQueueConsolidationControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement fixture, std::uint32_t &stage);
#endif

} // namespace vpaste::winui
