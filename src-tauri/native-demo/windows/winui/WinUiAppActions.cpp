#include <windows.h>
#undef GetCurrentTime
#include "WinUiAppActions.h"
#include "WinUiAppearance.h"
#include <utility>
#ifdef _DEBUG
#include <algorithm>
#include <vector>
#endif
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#ifdef _DEBUG
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Windows::Data::Json;

struct AppActions::Impl : std::enable_shared_from_this<Impl> {
    FrameworkElement owner{nullptr};
    Request request;
    Report report;
    std::function<void()> restoreFocus;
    AppBarButton tools, update;
    MenuFlyout toolsMenu;
    ContentDialog confirmation{nullptr};
    std::int64_t revision = -1;
    std::uint64_t generation = 0, pendingTool = 0, pendingInstall = 0;
    bool english = false, developer = false, ready = false, installing = false, confirming = false, closing = false;
    winrt::hstring version;

    winrt::hstring Text(const wchar_t *zh, const wchar_t *en) const { return english ? en : zh; }

    void Initialize() {
        const auto weak = weak_from_this();
        tools.Icon(Glyph(L"\uE943"));
        tools.Flyout(toolsMenu);
        update.Icon(SymbolIcon{Symbol::Sync});
        for (const auto &button : {tools, update}) ApplyStyle(button, L"VPaste.RoundToolbarCommand");
        ApplyStyle(update, L"VPaste.RoundToolbarUpdate");
        update.Click([weak](auto const &, auto const &) { if (const auto self = weak.lock()) self->Confirm(); });
        Localize();
    }

    void Refresh() {
        tools.Visibility(developer ? Visibility::Visible : Visibility::Collapsed);
        tools.IsEnabled(!pendingTool);
        update.Visibility(ready || installing ? Visibility::Visible : Visibility::Collapsed);
        update.IsEnabled(ready && !confirming && !closing && !pendingInstall);
        update.Label(installing || pendingInstall ? Text(L"正在安装…", L"Installing…") : Text(L"重启更新", L"Restart to update"));
        const auto label = update.Label() + (version.empty() ? L"" : L" · " + version);
        ToolTipService::SetToolTip(update, winrt::box_value(label));
        Automation::AutomationProperties::SetName(update, label);
        Automation::AutomationProperties::SetName(tools, tools.Label());
    }

    void LocalizeConfirmation() {
        if (!confirmation) return;
        confirmation.Title(winrt::box_value(Text(L"更新并重启？", L"Update and restart?")));
        confirmation.Content(winrt::box_value(english
            ? L"vPaste " + version + L" will be installed and the app will restart."
            : L"将安装 vPaste " + version + L" 并自动重启。"));
        confirmation.PrimaryButtonText(Text(L"重启更新", L"Restart to update"));
        confirmation.CloseButtonText(Text(L"取消", L"Cancel"));
    }

    void Localize() {
        toolsMenu.Hide();
        tools.Label(Text(L"开发工具", L"Developer tools"));
        toolsMenu.Items().Clear();
        const auto weak = weak_from_this();
        auto add = [&](const wchar_t *zh, const wchar_t *en, const wchar_t *glyph, const wchar_t *name) {
            MenuFlyoutItem item;
            item.Text(Text(zh, en)); item.Icon(Glyph(glyph));
            item.Click([weak, name = std::wstring{name}](auto const &, auto const &) {
                if (const auto self = weak.lock(); self && self->developer && !self->pendingTool) {
                    self->pendingTool = self->request(L"appTool", name);
                    self->Refresh();
                }
            });
            toolsMenu.Items().Append(item);
        };
        add(L"内存监视器", L"Memory monitor", L"\uE950", L"memory");
        add(L"测试间", L"Test room", L"\uE9D9", L"testRoom");
        add(L"组件样板间（浏览器）", L"UI Lab (browser)", L"\uE774", L"uiLab");
        LocalizeConfirmation(); Refresh();
    }

    void CancelConfirmation() {
        ++generation;
        if (confirmation) { closing = true; confirmation.Hide(); }
        confirmation = nullptr;
        if (std::exchange(confirming, false)) (void)request(L"modalEnd", {});
        Refresh();
    }

    void SetUpdate(JsonObject const &state) {
        const auto next = static_cast<std::int64_t>(state.GetNamedNumber(L"revision", -1));
        if (next < 0 || next < revision) return;
        revision = next;
        const auto value = state.GetNamedValue(L"availableVersion", nullptr);
        const winrt::hstring nextVersion = value && value.ValueType() == JsonValueType::String ? value.GetString() : L"";
        const auto status = state.GetNamedString(L"status", L"");
        const bool direct = !state.GetNamedBoolean(L"portable", true) && state.GetNamedString(L"source", L"direct") == L"direct";
        ready = direct && status == L"ready" && !nextVersion.empty();
        installing = direct && status == L"installing";
        if (confirming && (!ready || nextVersion != version)) CancelConfirmation();
        version = nextVersion;
        Refresh();
    }

    winrt::fire_and_forget Confirm() {
        const auto lifetime = shared_from_this();
        if (!ready || confirming || closing || pendingInstall || !owner.IsLoaded()) co_return;
        const auto confirmedVersion = version;
        const auto session = ++generation;
        confirming = true;
        (void)request(L"previewDismiss", {});
        (void)request(L"modalBegin", {});
        Refresh();
        try {
            confirmation = MakeConfirmationDialog(owner, L"", L"", L"", L"");
            LocalizeConfirmation();
            const auto result = co_await confirmation.ShowAsync();
            if (session != generation) { closing = false; Refresh(); restoreFocus(); co_return; }
            confirmation = nullptr; confirming = false;
            (void)request(L"modalEnd", {});
            if (result == ContentDialogResult::Primary && ready && version == confirmedVersion) {
                pendingInstall = request(L"updateInstall", std::wstring{confirmedVersion});
            }
            Refresh();
        } catch (winrt::hresult_error const &error) {
            if (session != generation) { closing = false; Refresh(); restoreFocus(); co_return; }
            CancelConfirmation(); closing = false; Refresh(); report(error.message(), true);
        }
    }

    bool Receive(JsonObject const &response) {
        const auto op = response.GetNamedString(L"op", L"");
        if (op == L"appState" || op == L"updateStateChanged") {
            if (response.HasKey(L"error")) report(response.GetNamedString(L"error"), true);
            else {
                const auto state = response.GetNamedObject(L"data");
                if (op == L"appState") {
                    developer = state.GetNamedBoolean(L"developerMode", false);
                    if (!developer) toolsMenu.Hide();
                    SetUpdate(state.GetNamedObject(L"update"));
                    Refresh();
                } else SetUpdate(state);
            }
            return true;
        }
        if (op != L"appTool" && op != L"updateInstall") return false;
        const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
        auto &pending = op == L"appTool" ? pendingTool : pendingInstall;
        if (!id || id != pending) return true;
        pending = 0;
        if (response.HasKey(L"error")) report(response.GetNamedString(L"error"), true);
        Refresh();
        return true;
    }
};

AppActions::AppActions(FrameworkElement owner, Request request, Report report,
    std::function<void()> restoreFocus) : impl_(std::make_shared<Impl>()) {
    impl_->owner = owner; impl_->request = std::move(request); impl_->report = std::move(report);
    impl_->restoreFocus = std::move(restoreFocus);
    impl_->Initialize();
}
AppActions::~AppActions() { Deactivate(); }
AppBarButton AppActions::ToolsButton() const { return impl_->tools; }
AppBarButton AppActions::UpdateButton() const { return impl_->update; }
bool AppActions::Receive(JsonObject const &response) { return impl_->Receive(response); }
bool AppActions::ModalOpen() const { return impl_->confirming || impl_->closing; }
void AppActions::SetLanguage(bool english) { impl_->english = english; impl_->Localize(); }
void AppActions::SetTheme(ElementTheme theme) { if (impl_->confirmation) impl_->confirmation.RequestedTheme(theme); }
void AppActions::Deactivate() { impl_->toolsMenu.Hide(); impl_->CancelConfirmation(); }
#ifdef _DEBUG
ContentDialog AppActions::TestDialog() const { return impl_->confirmation; }

namespace {
Button DialogButton(DependencyObject const &root, const wchar_t *name) {
    if (auto button = root.try_as<Button>(); button && button.Name() == name) return button;
    for (int index = 0; index < Media::VisualTreeHelper::GetChildrenCount(root); ++index) {
        if (auto button = DialogButton(Media::VisualTreeHelper::GetChild(root, index), name)) return button;
    }
    return nullptr;
}
void Invoke(FrameworkElement const &element) {
    Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(element)
        .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
}
}

winrt::Windows::Foundation::IAsyncAction TestAppActionsControls(FrameworkElement owner, std::uint32_t &stage) {
    std::vector<JsonObject> requests;
    std::vector<winrt::hstring> errors;
    std::uint64_t requestId = 0;
    AppActions actions{owner, [&](const std::wstring &op, const std::wstring &argument) {
        JsonObject request;
        request.Insert(L"op", JsonValue::CreateStringValue(op));
        request.Insert(L"argument", JsonValue::CreateStringValue(argument));
        request.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(++requestId)));
        requests.push_back(request);
        return requestId;
    }, [&](const winrt::hstring &message, bool error) { if (error) errors.push_back(message); }, [] {}};
    const auto count = [&](const wchar_t *op) {
        return std::count_if(requests.begin(), requests.end(), [&](JsonObject const &item) { return item.GetNamedString(L"op") == op; });
    };
    const auto update = [&](int revision, const wchar_t *status, const wchar_t *version = L"1.7.1", bool portable = false) {
        JsonObject state;
        state.Insert(L"revision", JsonValue::CreateNumberValue(revision));
        state.Insert(L"status", JsonValue::CreateStringValue(status));
        state.Insert(L"availableVersion", JsonValue::CreateStringValue(version));
        state.Insert(L"portable", JsonValue::CreateBooleanValue(portable));
        state.Insert(L"source", JsonValue::CreateStringValue(L"direct"));
        JsonObject response; response.Insert(L"op", JsonValue::CreateStringValue(L"updateStateChanged"));
        response.Insert(L"data", state); actions.Receive(response);
    };
    const auto runtime = [&](bool developer) {
        actions.Receive(JsonObject::Parse(developer
            ? LR"({"op":"appState","data":{"developerMode":true,"update":{"revision":0,"status":"disabled","portable":false,"availableVersion":null}}})"
            : LR"({"op":"appState","data":{"developerMode":false,"update":{"revision":0,"status":"disabled","portable":false,"availableVersion":null}}})"));
    };
    const auto reply = [&](const wchar_t *op, std::uint64_t id, bool failed) {
        JsonObject response;
        response.Insert(L"op", JsonValue::CreateStringValue(op));
        response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
        if (failed) response.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic retryable failure"));
        actions.Receive(response);
    };
    CommandBar bar;
    bar.DefaultLabelPosition(CommandBarDefaultLabelPosition::Collapsed);
    bar.PrimaryCommands().Append(actions.ToolsButton()); bar.PrimaryCommands().Append(actions.UpdateButton());
    bar.HorizontalAlignment(HorizontalAlignment::Right); bar.VerticalAlignment(VerticalAlignment::Top);
    const auto host = owner.as<Grid>();
    host.Children().Append(bar);
    struct RemoveBar {
        Grid host; CommandBar bar;
        ~RemoveBar() { std::uint32_t index = 0; if (host.Children().IndexOf(bar, index)) host.Children().RemoveAt(index); }
    } remove{host, bar};
    stage = 97;
    runtime(false); co_await NextNativeFrame();
    winrt::check_hresult(actions.ToolsButton().Visibility() == Visibility::Collapsed &&
        actions.UpdateButton().Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    stage = 98;
    runtime(true); update(1, L"ready"); co_await NextNativeFrame();
    winrt::check_hresult(actions.ToolsButton().Visibility() == Visibility::Visible && actions.UpdateButton().IsEnabled() ? S_OK : E_FAIL);
    const auto tools = actions.ToolsButton().Flyout().as<MenuFlyout>();
    winrt::check_hresult(tools.Items().Size() == 3 && tools.Items().GetAt(0).as<MenuFlyoutItem>().Text() == L"内存监视器" ? S_OK : E_FAIL);
    stage = 99;
    tools.ShowAt(actions.ToolsButton()); co_await NextNativeFrame();
    Invoke(tools.Items().GetAt(0));
    const auto toolId = requests.back().GetNamedNumber(L"id");
    winrt::check_hresult(requests.back().GetNamedString(L"argument") == L"memory" && !actions.ToolsButton().IsEnabled() ? S_OK : E_FAIL);
    const auto beforeRepeatedTool = requests.size();
    Invoke(tools.Items().GetAt(0));
    winrt::check_hresult(requests.size() == beforeRepeatedTool ? S_OK : E_FAIL);
    reply(L"appTool", static_cast<std::uint64_t>(toolId) + 1, true);
    winrt::check_hresult(!actions.ToolsButton().IsEnabled() && errors.empty() ? S_OK : E_FAIL);
    reply(L"appTool", static_cast<std::uint64_t>(toolId), true);
    winrt::check_hresult(actions.ToolsButton().IsEnabled() && errors.size() == 1 ? S_OK : E_FAIL);
    tools.Hide(); co_await NextNativeFrame();
    for (std::uint32_t index = 1; index < 3; ++index) {
        tools.ShowAt(actions.ToolsButton()); co_await NextNativeFrame();
        Invoke(tools.Items().GetAt(index));
        winrt::check_hresult(requests.back().GetNamedString(L"argument") == (index == 1 ? L"testRoom" : L"uiLab") ? S_OK : E_FAIL);
        reply(L"appTool", static_cast<std::uint64_t>(requests.back().GetNamedNumber(L"id")), false);
        tools.Hide(); co_await NextNativeFrame();
    }
    stage = 100;
    actions.SetLanguage(true);
    winrt::check_hresult(actions.ToolsButton().Label() == L"Developer tools" &&
        tools.Items().GetAt(2).as<MenuFlyoutItem>().Text() == L"UI Lab (browser)" ? S_OK : E_FAIL);
    Invoke(actions.UpdateButton()); co_await NextNativeFrame();
    winrt::check_hresult(actions.ModalOpen() && !actions.UpdateButton().IsEnabled() && actions.TestDialog().DefaultButton() == ContentDialogButton::Close &&
        actions.TestDialog().PrimaryButtonText() == L"Restart to update" ? S_OK : E_FAIL);
    actions.SetTheme(ElementTheme::Dark);
    actions.SetLanguage(false);
    winrt::check_hresult(actions.TestDialog().RequestedTheme() == ElementTheme::Dark && actions.TestDialog().CloseButtonText() == L"取消" ? S_OK : E_FAIL);
    actions.Deactivate();
    for (int frame = 0; frame < 30 && !actions.UpdateButton().IsEnabled(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(!actions.ModalOpen() && actions.UpdateButton().IsEnabled() && count(L"updateInstall") == 0 &&
        count(L"modalBegin") == count(L"modalEnd") ? S_OK : E_FAIL);
    stage = 101;
    Invoke(actions.UpdateButton()); co_await NextNativeFrame();
    update(2, L"ready", L"1.7.2");
    for (int frame = 0; frame < 30 && !actions.UpdateButton().IsEnabled(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(!actions.ModalOpen() && count(L"updateInstall") == 0 ? S_OK : E_FAIL);
    update(1, L"disabled");
    winrt::check_hresult(actions.UpdateButton().IsEnabled() ? S_OK : E_FAIL);
    stage = 102;
    Invoke(actions.UpdateButton()); co_await NextNativeFrame();
    const auto confirm = DialogButton(actions.TestDialog(), L"PrimaryButton");
    winrt::check_hresult(confirm ? S_OK : E_FAIL);
    Invoke(confirm);
    for (int frame = 0; frame < 30 && actions.ModalOpen(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(count(L"updateInstall") == 1 && requests.back().GetNamedString(L"argument") == L"1.7.2" &&
        !actions.UpdateButton().IsEnabled() && count(L"modalBegin") == count(L"modalEnd") ? S_OK : E_FAIL);
    const auto installId = static_cast<std::uint64_t>(requests.back().GetNamedNumber(L"id"));
    reply(L"updateInstall", installId + 1, true);
    winrt::check_hresult(!actions.UpdateButton().IsEnabled() && errors.size() == 1 ? S_OK : E_FAIL);
    reply(L"updateInstall", installId, true);
    winrt::check_hresult(actions.UpdateButton().IsEnabled() && errors.size() == 2 ? S_OK : E_FAIL);
    stage = 103;
    update(3, L"installing", L"1.7.2"); update(2, L"ready");
    winrt::check_hresult(actions.UpdateButton().Visibility() == Visibility::Visible && !actions.UpdateButton().IsEnabled() ? S_OK : E_FAIL);
    update(4, L"ready", L"1.7.2", true);
    winrt::check_hresult(actions.UpdateButton().Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    update(5, L"failed");
    winrt::check_hresult(actions.UpdateButton().Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    stage = 104;
    update(6, L"ready"); Invoke(actions.UpdateButton()); co_await NextNativeFrame();
    update(7, L"downloading");
    for (int frame = 0; frame < 30 && actions.ModalOpen(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(!actions.ModalOpen() && count(L"updateInstall") == 1 && count(L"modalBegin") == count(L"modalEnd") ? S_OK : E_FAIL);
    runtime(false);
    winrt::check_hresult(actions.ToolsButton().Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    actions.Deactivate();
}
#endif
}
