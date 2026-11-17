#include <windows.h>
#include <shlobj.h>
#undef GetCurrentTime
#include "WinUiDrag.h"
#include "WinUiAppearance.h"

#include <chrono>
#include <utility>
#include <vector>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Storage.h>

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Windows::ApplicationModel::DataTransfer;
using namespace winrt::Windows::Data::Json;
using namespace winrt::Windows::Storage;

void DeclareDragFormats(DataPackage const &package, std::wstring const &type, bool rich,
    DataProviderHandler const &provider) {
    package.RequestedOperation(DataPackageOperation::Copy);
    if (type == L"Image" || type == L"File") package.SetDataProvider(StandardDataFormats::StorageItems(), provider);
    else {
        package.SetDataProvider(StandardDataFormats::Text(), provider);
        if (rich || type == L"Link") package.SetDataProvider(StandardDataFormats::Html(), provider);
        if (type == L"Link") package.SetDataProvider(StandardDataFormats::WebLink(), provider);
    }
}

winrt::Windows::Foundation::IAsyncAction PopulateDragPackage(DataPackage package, JsonObject data) {
    auto cancellation = co_await winrt::get_cancellation_token();
    cancellation.enable_propagation();
    const auto files = data.GetNamedArray(L"files", JsonArray{});
    if (files.Size()) {
        std::vector<IStorageItem> items;
        for (const auto &value : files) {
            if (cancellation()) throw winrt::hresult_canceled();
            const auto file = value.GetObject();
            const auto path = file.GetNamedString(L"path");
            if (file.GetNamedBoolean(L"isDirectory", false)) {
                items.push_back(co_await StorageFolder::GetFolderFromPathAsync(path));
            } else {
                items.push_back(co_await StorageFile::GetFileFromPathAsync(path));
            }
        }
        // Publish atomically after every item resolves; no partial file drops.
        package.SetStorageItems(winrt::single_threaded_vector<IStorageItem>(std::move(items)), true);
        // Keep WinUI's single drag session/cursor, but use the same Shell data
        // object as the shipping WebView file drag for desktop OLE consumers.
        std::vector<std::unique_ptr<ITEMIDLIST, decltype(&ILFree)>> ownedIds;
        std::vector<PCIDLIST_ABSOLUTE> ids;
        for (const auto &value : files) {
            const auto path = value.GetObject().GetNamedString(L"path");
            auto id = std::unique_ptr<ITEMIDLIST, decltype(&ILFree)>{ILCreateFromPathW(path.c_str()), ILFree};
            winrt::check_bool(id != nullptr);
            ids.push_back(id.get()); ownedIds.push_back(std::move(id));
        }
        winrt::com_ptr<IShellItemArray> shellItems;
        winrt::check_hresult(SHCreateShellItemArrayFromIDLists(static_cast<UINT>(ids.size()), ids.data(), shellItems.put()));
        winrt::com_ptr<IDataObject> shellData;
        winrt::check_hresult(shellItems->BindToHandler(nullptr, BHID_DataObject, IID_PPV_ARGS(shellData.put())));
        winrt::check_hresult(package.as<IDataObjectProvider>()->SetDataObject(shellData.get()));
    } else {
        const auto text = data.GetNamedString(L"text", L"");
        const auto html = data.GetNamedString(L"html", L"");
        const auto url = data.GetNamedString(L"url", L"");
        winrt::check_hresult(!text.empty() || !html.empty() ? S_OK : E_INVALIDARG);
        if (!text.empty()) package.SetText(text);
        if (!html.empty()) package.SetHtmlFormat(HtmlFormatHelper::CreateHtmlFormat(html));
        if (!url.empty()) {
            const winrt::Windows::Foundation::Uri uri{url};
            winrt::check_hresult(uri.SchemeName() == L"https" || uri.SchemeName() == L"http" ? S_OK : E_INVALIDARG);
            package.SetWebLink(uri);
        }
    }
    package.RequestedOperation(DataPackageOperation::Copy);
}

struct CardDragSource::Impl : std::enable_shared_from_this<CardDragSource::Impl> {
    struct Session : DragRequestState {
        UIElement source{nullptr};
        DragStartingEventArgs args{nullptr};
        DragOperationDeferral deferral{nullptr};
        winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer timer{nullptr};
        winrt::Windows::Foundation::IAsyncAction preparation{nullptr};
        DataPackage prepared;
        winrt::handle ready{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
        bool populated = false;
        std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
    };
    Request request;
    Completed completed;
    std::shared_ptr<Session> current;

    Impl(Request callback, Completed done) : request(std::move(callback)), completed(std::move(done)) {}

    void Reset(bool accepted = false, const winrt::hstring &error = {}) {
        auto session = std::exchange(current, nullptr);
        if (!session || !session->End()) return;
        SetEvent(session->ready.get());
        const auto cleanup = [](auto &&action) {
            try { action(); }
            catch (const winrt::hresult_error &error) { OutputDebugStringW(error.message().c_str()); }
        };
        if (session->timer) cleanup([&] { session->timer.Stop(); });
        if (session->preparation) cleanup([&] { session->preparation.Cancel(); });
        if (session->deferral) {
            cleanup([&] { session->args.Cancel(true); });
            cleanup([&] { session->deferral.Complete(); });
        }
        if (session->source) cleanup([&] { session->source.Opacity(1); });
        session->timer = nullptr;
        session->deferral = nullptr;
        session->args = nullptr;
        session->source = nullptr;
        session->preparation = nullptr;
        if (request) request(L"dragEnd", {});
        if (completed) completed(accepted, error);
    }

    // Owned coroutine parameters: never a capturing coroutine event lambda.
    static winrt::fire_and_forget Provide(std::shared_ptr<Session> session, DataProviderRequest request) {
        const auto deferral = request.GetDeferral();
        const winrt::apartment_context ui;
        try {
            const bool ready = co_await winrt::resume_on_signal(session->ready.get(), std::chrono::seconds(10));
            co_await ui;
            if (ready && session->populated && !session->ended.load())
                request.SetData(co_await session->prepared.GetView().GetDataAsync(request.FormatId()));
        } catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
        try { deferral.Complete(); }
        catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
    }

    static winrt::fire_and_forget Populate(std::shared_ptr<Impl> owner,
                                         std::shared_ptr<Session> session, JsonObject data) {
        try {
            const auto preparation = PopulateDragPackage(session->prepared, data);
            session->preparation = preparation;
            co_await preparation;
            if (session->ended.load()) co_return;
            session->preparation = nullptr;
            if ((GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0 || !session->source.as<FrameworkElement>().IsLoaded()) {
                owner->Reset();
                co_return;
            }
            winrt::com_ptr<IDataObject> nativeData;
            winrt::check_hresult(session->prepared.as<IDataObjectProvider>()->GetDataObject(nativeData.put()));
            winrt::check_hresult(session->args.Data().as<IDataObjectProvider>()->SetDataObject(nativeData.get()));
            session->populated = true;
            SetEvent(session->ready.get());
            auto deferral = std::exchange(session->deferral, nullptr);
            session->args = nullptr;
            session->timer.Stop();
            deferral.Complete();
        } catch (const winrt::hresult_error &error) {
            // Shutdown clears every XAML owner before closing its STA. A late
            // storage completion must never touch those released UI objects.
            if (!session->ended.load()) owner->Reset(false, error.message());
        }
    }
};

CardDragSource::CardDragSource(Request request, Completed completed)
    : m_impl(std::make_shared<Impl>(std::move(request), std::move(completed))) {}
CardDragSource::~CardDragSource() { Cancel(); }

void CardDragSource::Start(const UIElement &source, const DragStartingEventArgs &args,
                           const std::wstring &hash, const std::wstring &type, bool rich) {
    Cancel();
    try {
        if (hash.empty() || !m_impl->request) { args.Cancel(true); return; }
        auto session = std::make_shared<Impl::Session>();
        session->source = source;
        session->args = args;
        m_impl->current = session;
        winrt::check_bool(static_cast<bool>(session->ready));
        // Desktop targets can enumerate formats before the Rust reply, even
        // with a DragStarting deferral. Announce them now and defer values only.
        DeclareDragFormats(args.Data(), type, rich, [weak = std::weak_ptr<Impl::Session>{session}](DataProviderRequest const &request) {
            if (const auto pending = weak.lock()) Impl::Provide(pending, request);
        });
        // WinUI starts CoreDragOperation even with an outstanding deferral.
        // Only data may be prepared later; visual settings must be synchronous.
        args.AllowedOperations(DataPackageOperation::Copy);
        args.DragUI().SetContentFromDataPackage();
        session->deferral = args.GetDeferral();
        source.Opacity(DragSourceOpacity);
        m_impl->request(L"dragBegin", hash);
        session->id = m_impl->request(L"dragPrepare", hash);
        session->timer = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread().CreateTimer();
        session->timer.Interval(std::chrono::milliseconds(50)); // Pending-input check, not animation.
        session->timer.IsRepeating(true);
        session->timer.Tick([weak = std::weak_ptr<Impl>{m_impl}](auto const &, auto const &) {
            if (const auto self = weak.lock(); self && self->current && self->current->deferral) {
                if ((GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0) self->Reset();
                else if (std::chrono::steady_clock::now() - self->current->started >= std::chrono::seconds(10))
                    self->Reset(false, L"Drag preparation timed out / 拖拽准备超时");
            }
        });
        session->timer.Start();
    } catch (const winrt::hresult_error &error) {
        args.Cancel(true);
        m_impl->Reset(false, error.message());
    }
}

bool SuppressInternalCardDrag(DragEventArgs const &args, bool ownCardDrag) {
    if (!ownCardDrag) return false;
    // The panel is not a destination for its own cards. Hide only this target's
    // OLE adorners; another app still negotiates its normal Copy/None feedback.
    args.AcceptedOperation(DataPackageOperation::None);
    const auto feedback = args.DragUIOverride();
    feedback.IsCaptionVisible(false);
    feedback.IsContentVisible(false);
    feedback.IsGlyphVisible(false);
    args.Handled(true);
    return true;
}

void CardDragSource::Receive(const JsonObject &response) {
    const auto session = m_impl->current;
    const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
    if (!session || !session->Accepts(id) || !session->deferral) return;
    session->id = 0; // Consume once, including while StorageItems resolve asynchronously.
    if (response.HasKey(L"error")) m_impl->Reset(false, response.GetNamedString(L"error"));
    else Impl::Populate(m_impl, session, response.GetNamedObject(L"data"));
}

void CardDragSource::Finish(const UIElement &source, DataPackageOperation result) {
    if (m_impl->current && m_impl->current->source == source) m_impl->Reset(result != DataPackageOperation::None);
}
void CardDragSource::Cancel() { if (m_impl) m_impl->Reset(); }
bool CardDragSource::Active() const { return m_impl && m_impl->current != nullptr; }

#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction CardDragSource::TestDataProviders(
    DataPackage prepared, std::wstring type, bool rich) {
    auto session = std::make_shared<Impl::Session>();
    DataPackage pending;
    DeclareDragFormats(pending, type, rich, [session](DataProviderRequest const &request) {
        Impl::Provide(session, request);
    });
    const auto formats = pending.GetView().AvailableFormats();
    std::vector<winrt::Windows::Foundation::IAsyncOperation<winrt::Windows::Foundation::IInspectable>> reads;
    for (const auto &format : formats) reads.push_back(pending.GetView().GetDataAsync(format));
    co_await winrt::resume_after(std::chrono::milliseconds(10));
    session->prepared = prepared; session->populated = true; SetEvent(session->ready.get());
    for (const auto &read : reads) winrt::check_hresult((co_await read) != nullptr ? S_OK : E_FAIL);
    session = std::make_shared<Impl::Session>();
    DataPackage canceled;
    DeclareDragFormats(canceled, L"Text", false, [session](DataProviderRequest const &request) {
        Impl::Provide(session, request);
    });
    const auto rejected = canceled.GetView().GetTextAsync();
    session->End(); SetEvent(session->ready.get());
    bool failed = false;
    try { (void)(co_await rejected); } catch (winrt::hresult_error const &) { failed = true; }
    winrt::check_hresult(failed ? S_OK : E_FAIL);
}
#endif

} // namespace vpaste::winui
