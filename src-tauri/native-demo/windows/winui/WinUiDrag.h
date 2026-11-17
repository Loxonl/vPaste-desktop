#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>

namespace vpaste::winui {

struct DragRequestState {
    std::uint64_t id = 0;
    std::atomic_bool ended = false;
    bool Accepts(std::uint64_t request) const { return !ended.load() && id != 0 && id == request; }
    bool End() { return !ended.exchange(true); }
};

// Separate from gesture ownership so native tests can inspect the real package.
winrt::Windows::Foundation::IAsyncAction PopulateDragPackage(
    winrt::Windows::ApplicationModel::DataTransfer::DataPackage package,
    winrt::Windows::Data::Json::JsonObject data);
void DeclareDragFormats(winrt::Windows::ApplicationModel::DataTransfer::DataPackage const &package,
    std::wstring const &type, bool rich,
    winrt::Windows::ApplicationModel::DataTransfer::DataProviderHandler const &provider);
bool SuppressInternalCardDrag(winrt::Microsoft::UI::Xaml::DragEventArgs const &args, bool ownCardDrag);

class CardDragSource {
public:
    using Request = std::function<std::uint64_t(const std::wstring &, const std::wstring &)>;
    using Completed = std::function<void(bool, const winrt::hstring &)>;
    CardDragSource(Request request, Completed completed);
    ~CardDragSource();
    CardDragSource(const CardDragSource &) = delete;
    CardDragSource &operator=(const CardDragSource &) = delete;
    CardDragSource(CardDragSource &&) = delete;
    CardDragSource &operator=(CardDragSource &&) = delete;
    void Start(const winrt::Microsoft::UI::Xaml::UIElement &source,
               const winrt::Microsoft::UI::Xaml::DragStartingEventArgs &args,
               const std::wstring &hash, const std::wstring &type, bool rich);
    void Receive(const winrt::Windows::Data::Json::JsonObject &response);
    void Finish(const winrt::Microsoft::UI::Xaml::UIElement &source,
                winrt::Windows::ApplicationModel::DataTransfer::DataPackageOperation result);
    void Cancel();
    bool Active() const;
#ifdef _DEBUG
    static winrt::Windows::Foundation::IAsyncAction TestDataProviders(
        winrt::Windows::ApplicationModel::DataTransfer::DataPackage prepared,
        std::wstring type, bool rich);
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> m_impl;
};

} // namespace vpaste::winui
