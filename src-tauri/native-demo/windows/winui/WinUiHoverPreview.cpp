#include <windows.h>
#include "WinUiHoverPreview.h"
#include <chrono>
#include <utility>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Windows.Foundation.h>
#ifdef _DEBUG
#include <vector>
#endif

namespace vpaste::winui {
struct HoverPreview::Impl : std::enable_shared_from_this<Impl> {
    Request request;
    std::function<bool()> allowed;
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer show{nullptr}, close{nullptr};
    std::wstring hash;
    bool tracking = false, inside = false, submitted = false;

    void Initialize() {
        const auto dispatcher = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread();
        show = dispatcher.CreateTimer(); show.IsRepeating(false); show.Interval(std::chrono::milliseconds(500));
        close = dispatcher.CreateTimer(); close.IsRepeating(false); close.Interval(std::chrono::milliseconds(250));
        const auto weak = weak_from_this();
        show.Tick([weak](auto const &, auto const &) { if (const auto self = weak.lock()) self->Show(); });
        close.Tick([weak](auto const &, auto const &) { if (const auto self = weak.lock()) self->Close(); });
    }
    void Cancel() {
        show.Stop(); close.Stop(); hash.clear(); inside = false; submitted = false;
        if (std::exchange(tracking, false)) request(L"hoverDismiss", {});
    }
    void Show() {
        show.Stop();
        if (!tracking || hash.empty() || submitted) return;
        if (!allowed()) { Cancel(); return; }
        submitted = true;
        request(L"hoverPreview", hash);
    }
    void Close() { close.Stop(); if (!inside) Cancel(); }
};

HoverPreview::HoverPreview(Request request, std::function<bool()> allowed) : impl_(std::make_shared<Impl>()) {
    impl_->request = std::move(request); impl_->allowed = std::move(allowed); impl_->Initialize();
}
HoverPreview::~HoverPreview() { Cancel(); }
void HoverPreview::Enter(std::wstring const &hash, std::wstring const &type) {
    if (!impl_->allowed() || hash.empty() || (type != L"Text" && type != L"TextFile" && type != L"Image" && type != L"Link")) {
        Cancel(); return;
    }
    impl_->close.Stop();
    if (impl_->hash == hash) return;
    impl_->show.Stop();
    impl_->hash = hash; impl_->tracking = true; impl_->inside = false; impl_->submitted = false;
    impl_->show.Start();
}
void HoverPreview::Leave() {
    if (!impl_->tracking) return;
    impl_->show.Stop(); impl_->hash.clear(); impl_->close.Start();
}
void HoverPreview::PreviewPointer(bool inside) {
    if (!impl_->tracking) return;
    impl_->inside = inside;
    if (inside) impl_->close.Stop(); else Leave();
}
void HoverPreview::Cancel() { impl_->Cancel(); }
#ifdef _DEBUG
void HoverPreview::TestShow() { impl_->Show(); }
void HoverPreview::TestClose() { impl_->Close(); }
bool HoverPreview::TestPending() const { return impl_->show.IsRunning(); }

void TestHoverPreview(std::uint32_t &stage) {
    std::vector<std::pair<std::wstring, std::wstring>> requests;
    bool allowed = true;
    HoverPreview hover{[&](auto const &op, auto const &hash) { requests.emplace_back(op, hash); }, [&] { return allowed; }};
    stage = 108;
    hover.Enter(L"first", L"Text");
    winrt::check_hresult(hover.TestPending() && requests.empty() ? S_OK : E_FAIL);
    hover.Enter(L"second", L"Image"); hover.TestShow(); hover.TestShow();
    winrt::check_hresult(requests.size() == 1 && requests.back() == std::pair{std::wstring{L"hoverPreview"}, std::wstring{L"second"}} ? S_OK : E_FAIL);
    hover.Leave(); hover.PreviewPointer(true); hover.TestClose();
    winrt::check_hresult(requests.size() == 1 ? S_OK : E_FAIL);
    hover.PreviewPointer(false); hover.TestClose(); hover.Cancel();
    winrt::check_hresult(requests.size() == 2 && requests.back().first == L"hoverDismiss" ? S_OK : E_FAIL);
    hover.Enter(L"short", L"Link"); hover.Leave(); hover.TestShow(); hover.TestClose();
    winrt::check_hresult(requests.size() == 3 && requests.back().first == L"hoverDismiss" ? S_OK : E_FAIL);
    hover.Enter(L"file", L"File"); hover.TestShow();
    winrt::check_hresult(requests.size() == 3 && !hover.TestPending() ? S_OK : E_FAIL);
    hover.Enter(L"late", L"TextFile"); allowed = false; hover.TestShow();
    winrt::check_hresult(requests.size() == 4 && requests.back().first == L"hoverDismiss" && !hover.TestPending() ? S_OK : E_FAIL);
    hover.Enter(L"blocked", L"Text"); hover.TestShow();
    winrt::check_hresult(requests.size() == 4 ? S_OK : E_FAIL);
    allowed = true;
    { HoverPreview temporary{[&](auto const &op, auto const &hash) { requests.emplace_back(op, hash); }, [&] { return allowed; }};
      temporary.Enter(L"shutdown", L"Text"); }
    winrt::check_hresult(requests.size() == 5 && requests.back().first == L"hoverDismiss" ? S_OK : E_FAIL);
}
#endif
}
