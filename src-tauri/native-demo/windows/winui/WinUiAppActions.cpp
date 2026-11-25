#include <windows.h>
#undef GetCurrentTime
#include "WinUiAppActions.h"
#include "WinUiAppearance.h"
#include "WinUiHeaderArtwork.h"
#include <utility>
#ifdef _DEBUG
#include <algorithm>
#include <vector>
#endif
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#ifdef _DEBUG
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.Storage.Streams.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Windows::Data::Json;

namespace {
constexpr double DeveloperIconSize = 13;

Viewbox DeveloperIcon(const wchar_t *path) {
    // 规范化 SVG 路径以消除 Z+m 偏移歧义；将 PathIcon 置于 24x24 画布内由 Viewbox 缩放，
    // 既保留 24 单位参考系，又自动继承按钮各交互态（Hover/Pressed/Disabled/高对比）的 Foreground。
    const auto normalized = NormalizeSvgPathForXaml(path);
    const auto xaml = std::wstring{LR"(<Viewbox xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
        <Grid Width="24" Height="24"><PathIcon Width="24" Height="24" Data="F1 )"}
        + normalized + LR"("/></Grid></Viewbox>)";
    auto icon = Markup::XamlReader::Load(winrt::hstring{xaml}).as<Viewbox>();
    icon.Width(DeveloperIconSize);
    icon.Height(DeveloperIconSize);
    Automation::AutomationProperties::SetAccessibilityView(icon, Automation::Peers::AccessibilityView::Raw);
    return icon;
}

// Four independent panes, with a clear cross-shaped gap at toolbar scale.
constexpr wchar_t WindowsGuideMark[] = LR"(M3,3 H11 V11 H3 Z M13,3 H21 V11 H13 Z M3,13 H11 V21 H3 Z M13,13 H21 V21 H13 Z)";
}

struct AppActions::Impl : std::enable_shared_from_this<Impl> {
    FrameworkElement owner{nullptr};
    Request request;
    Report report;
    std::function<void()> restoreFocus;
    Border developerGroup;
    TextBlock developerBadge{nullptr};
    std::vector<TextBlock> guideCaptions;
    std::vector<Border> developerDividers;
    Button tools, update;
    std::vector<Button> developerButtons;
    ContentDialog confirmation{nullptr};
    std::int64_t revision = -1;
    std::uint64_t generation = 0, pendingTool = 0, pendingInstall = 0;
    bool english = false, developer = false, toolsVisible = true, darkPreview = false, compact = false;
    bool ready = false, installing = false, confirming = false, closing = false;
    winrt::hstring version;

    winrt::hstring Text(const wchar_t *zh, const wchar_t *en) const { return english ? en : zh; }

    void OpenTool(std::wstring const &name) {
        if (!developer || !toolsVisible || pendingTool) return;
        pendingTool = request(L"appTool", name); Refresh();
    }

    void Initialize() {
        const auto weak = weak_from_this();
        ApplyStyle(developerGroup, L"VPaste.DeveloperGroupSurface");
        developerGroup.VerticalAlignment(VerticalAlignment::Center);
        StackPanel developerActions;
        developerActions.Orientation(Orientation::Horizontal);
        developerActions.Spacing(2);
        developerGroup.Child(developerActions);
        TextBlock badge;
        badge.Text(L"DEV");
        ApplyStyle(badge, L"VPaste.DeveloperBadge");
        badge.Margin({7, 0, 5, 0});
        developerBadge = badge;
        developerActions.Children().Append(badge);
        ApplyStyle(tools, L"VPaste.RoundToolbarCommand");
        // 光学居中及收敛宽度，使眼睛图标在 28x28 圆中与队列/设置保持协调。
        tools.Content(HeaderIcon(HeaderArtwork::VisibilityOutlined, HeaderIconMetrics{CompactIconSize, 0.97, 0.0, 0.45}));
        tools.Click([weak](auto const &, auto const &) {
            if (const auto self = weak.lock(); self && self->developer) {
                self->toolsVisible = !self->toolsVisible; self->Refresh();
            }
        });
        for (const auto name : {L"tutorial-windows", L"tutorial-mac", L"language", L"theme",
                               L"testRoom", L"memory", L"uiLab"}) {
            Button button;
            ApplyStyle(button, L"VPaste.DeveloperToolbarButton");
            button.Tag(winrt::box_value(winrt::hstring{name}));
            button.Click([weak, name = std::wstring{name}](auto const &, auto const &) {
                if (const auto self = weak.lock()) self->OpenTool(name);
            });
            developerButtons.push_back(button);
            developerActions.Children().Append(button);
            if (developerButtons.size() == 2 || developerButtons.size() == 4) {
                Border divider;
                ApplyStyle(divider, L"VPaste.DeveloperDivider");
                divider.Margin({2, 0, 2, 0});
                developerDividers.push_back(divider);
                developerActions.Children().Append(divider);
            }
        }
        // 更新箭头适当留白，保证在 100% 和 150% DPI 下上下尖角均不贴边裁剪。
        update.Content(HeaderIcon(HeaderArtwork::SyncRounded, HeaderIconMetrics{CompactIconSize, 0.98, 0.0, 0.0}));
        ApplyStyle(update, L"VPaste.RoundToolbarUpdate");
        update.Click([weak](auto const &, auto const &) { if (const auto self = weak.lock()) self->Confirm(); });
        Localize();
    }

    void Refresh() {
        tools.Visibility(developer ? Visibility::Visible : Visibility::Collapsed);
        NameIconButton(tools, toolsVisible ? Text(L"隐藏开发工具", L"Hide developer tools") : Text(L"显示开发工具", L"Show developer tools"));
        developerGroup.Visibility(developer && toolsVisible ? Visibility::Visible : Visibility::Collapsed);
        // 窄屏下隐藏非必需 DEV 文本标识及引导字样，避免挤压中间标签栏和右侧主操作按钮。
        if (developerBadge) developerBadge.Visibility(compact ? Visibility::Collapsed : Visibility::Visible);
        for (std::size_t i = 0; i < guideCaptions.size(); ++i) {
            guideCaptions[i].Visibility(compact ? Visibility::Collapsed : Visibility::Visible);
            if (i < developerButtons.size()) developerButtons[i].Width(compact ? 30 : 42);
        }
        for (const auto &button : developerButtons) {
            button.Visibility(developer && toolsVisible ? Visibility::Visible : Visibility::Collapsed);
            button.IsEnabled(!pendingTool);
        }
        update.Visibility(ready || installing ? Visibility::Visible : Visibility::Collapsed);
        update.IsEnabled(ready && !confirming && !closing && !pendingInstall);
        const auto label = installing || pendingInstall ? Text(L"正在安装…", L"Installing…") : Text(L"重启更新", L"Restart to update");
        NameIconButton(update, label + (version.empty() ? L"" : L" · " + version));
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
        std::size_t index = 0;
        guideCaptions.clear();
        const auto set = [&](const wchar_t *zh, const wchar_t *en, const wchar_t *path, const wchar_t *caption = nullptr) {
            const auto button = developerButtons[index++];
            NameIconButton(button, Text(zh, en));
            if (caption) {
                StackPanel content;
                content.Orientation(Orientation::Horizontal); content.Spacing(3);
                content.Children().Append(DeveloperIcon(path));
                TextBlock text; text.Text(caption); text.FontSize(10); text.FontWeight({720});
                text.VerticalAlignment(VerticalAlignment::Center);
                content.Children().Append(text);
                guideCaptions.push_back(text);
                button.Width(compact ? 30 : 42);
                button.Content(content);
            } else if (path) button.Content(DeveloperIcon(path));
            else {
                TextBlock text; text.Text(english ? L"EN" : L"中"); text.FontSize(10); text.FontWeight({720});
                button.Content(text);
            }
        };
        set(L"Windows 使用引导", L"Windows tutorial", WindowsGuideMark, L"Win");
        set(L"Mac 使用引导", L"Mac tutorial", HeaderArtwork::Apple, L"Mac");
        set(L"切换预览语言", L"Switch preview language", nullptr);
        set(L"切换预览主题", L"Switch preview theme", darkPreview ? HeaderArtwork::DarkModeRounded : HeaderArtwork::LightModeRounded);
        set(L"测试间", L"Test room", HeaderArtwork::ScienceOutlined);
        set(L"内存监视器", L"Memory monitor", HeaderArtwork::MemoryOutlined);
        set(L"组件样板间（浏览器）", L"UI Lab (browser)", HeaderArtwork::DashboardCustomizeOutlined);
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
                    darkPreview = state.GetNamedString(L"themePreview", L"light") == L"dark";
                    SetUpdate(state.GetNamedObject(L"update"));
                    Localize();
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
        else if (op == L"appTool") {
            const auto state = response.GetNamedObject(L"data", JsonObject{});
            darkPreview = state.GetNamedString(L"themePreview", darkPreview ? L"dark" : L"light") == L"dark";
            Localize();
        }
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
Border AppActions::DeveloperGroup() const { return impl_->developerGroup; }
Button AppActions::ToolsButton() const { return impl_->tools; }
Button AppActions::UpdateButton() const { return impl_->update; }
bool AppActions::Receive(JsonObject const &response) { return impl_->Receive(response); }
bool AppActions::ModalOpen() const { return impl_->confirming || impl_->closing; }
void AppActions::SetLanguage(bool english) { impl_->english = english; impl_->Localize(); }
void AppActions::SetTheme(ElementTheme theme) { if (impl_->confirmation) impl_->confirmation.RequestedTheme(theme); }
void AppActions::SetCompact(bool compact) {
    if (impl_->compact == compact) return;
    impl_->compact = compact;
    impl_->Refresh();
}
void AppActions::Deactivate() { impl_->CancelConfirmation(); }
#ifdef _DEBUG
std::vector<Button> AppActions::DeveloperButtons() const { return impl_->developerButtons; }
ContentDialog AppActions::TestDialog() const { return impl_->confirmation; }
void AppActions::TestToolAction(std::wstring const &name) { impl_->OpenTool(name); }

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
    StackPanel bar;
    bar.Orientation(Orientation::Horizontal);
    bar.Children().Append(actions.DeveloperGroup());
    bar.Children().Append(actions.ToolsButton()); bar.Children().Append(actions.UpdateButton());
    bar.HorizontalAlignment(HorizontalAlignment::Right); bar.VerticalAlignment(VerticalAlignment::Top);
    const auto host = owner.as<Grid>();
    host.Children().Append(bar);
    struct RemoveBar {
        Grid host; StackPanel bar;
        ~RemoveBar() { std::uint32_t index = 0; if (host.Children().IndexOf(bar, index)) host.Children().RemoveAt(index); }
    } remove{host, bar};
    stage = 97;
    runtime(false); co_await NextNativeFrame();
    winrt::check_hresult(actions.ToolsButton().Visibility() == Visibility::Collapsed &&
        actions.UpdateButton().Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    for (const auto &button : actions.DeveloperButtons()) winrt::check_hresult(button.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    stage = 98;
    runtime(true); update(1, L"ready"); co_await NextNativeFrame();
    winrt::check_hresult(actions.ToolsButton().Visibility() == Visibility::Visible && actions.UpdateButton().IsEnabled() ? S_OK : E_FAIL);
    const auto tools = actions.DeveloperButtons();
    const auto guideFits = [](const Button &button, const wchar_t *label) {
        const auto row = button.Content().try_as<StackPanel>();
        if (!row || row.Orientation() != Orientation::Horizontal || row.Children().Size() != 2) return false;
        const auto icon = row.Children().GetAt(0).try_as<Viewbox>();
        const auto caption = row.Children().GetAt(1).try_as<TextBlock>();
        return button.ActualWidth() >= 42 && button.ActualHeight() == 26 && icon && caption &&
            caption.Text() == label && row.Spacing() >= 3 && icon.ActualWidth() == DeveloperIconSize &&
            caption.TransformToVisual(row).TransformPoint({0, 0}).X >= icon.ActualWidth() + 2;
    };
    winrt::check_hresult(tools.size() == 7 && !actions.ToolsButton().Flyout() &&
        guideFits(tools[0], L"Win") && guideFits(tools[1], L"Mac") &&
        Automation::AutomationProperties::GetName(tools[0]) == L"Windows 使用引导" &&
        Automation::AutomationProperties::GetName(tools[5]) == L"内存监视器" ? S_OK : E_FAIL);
    stage = 981;
    // Check the painted glyph, not only its declared layout width.
    {
        const auto mark = tools[0].Content().as<StackPanel>().Children().GetAt(0).as<Viewbox>();
        Media::Imaging::RenderTargetBitmap bitmap;
        co_await bitmap.RenderAsync(mark, 24, 24);
        auto buffer = co_await bitmap.GetPixelsAsync();
        std::vector<std::uint8_t> pixels(buffer.Length());
        winrt::Windows::Storage::Streams::DataReader::FromBuffer(buffer).ReadBytes(pixels);
        winrt::check_hresult(bitmap.PixelWidth() == 24 && bitmap.PixelHeight() == 24 ? S_OK : E_FAIL);
        const auto alpha = [&](int x, int y) { return pixels[(y * 24 + x) * 4 + 3]; };
        for (const auto y : {7, 17}) {
            winrt::check_hresult(alpha(7, y) > 100 && alpha(17, y) > 100 && alpha(12, y) < 16 ? S_OK : E_FAIL);
        }
        winrt::check_hresult(alpha(7, 12) < 16 && alpha(17, 12) < 16 ? S_OK : E_FAIL);
        const auto memory = tools[5].Content().as<Viewbox>();
        winrt::check_hresult(memory.ActualWidth() == DeveloperIconSize ? S_OK : E_FAIL);
        co_await bitmap.RenderAsync(memory, 24, 24);
        buffer = co_await bitmap.GetPixelsAsync();
        pixels.resize(buffer.Length());
        winrt::Windows::Storage::Streams::DataReader::FromBuffer(buffer).ReadBytes(pixels);
        winrt::check_hresult(bitmap.PixelWidth() == 24 && bitmap.PixelHeight() == 24 ? S_OK : E_FAIL);
        int first = 24, last = -1;
        for (int y = 0; y < 24; ++y) for (int x = 0; x < 24; ++x) {
            if (alpha(x, y) > 100) { first = std::min(first, x); last = std::max(last, x); }
        }
        winrt::check_hresult(last - first >= 16 ? S_OK : E_FAIL);
    }
    for (const auto &button : tools) winrt::check_hresult(button.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
    Invoke(actions.ToolsButton()); co_await NextNativeFrame();
    for (const auto &button : tools) winrt::check_hresult(button.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    Invoke(actions.ToolsButton()); co_await NextNativeFrame();
    stage = 99;
    Invoke(tools[5]);
    const auto toolId = requests.back().GetNamedNumber(L"id");
    winrt::check_hresult(requests.back().GetNamedString(L"argument") == L"memory" && !tools[5].IsEnabled() ? S_OK : E_FAIL);
    const auto beforeRepeatedTool = requests.size();
    actions.TestToolAction(L"memory");
    winrt::check_hresult(requests.size() == beforeRepeatedTool ? S_OK : E_FAIL);
    reply(L"appTool", static_cast<std::uint64_t>(toolId) + 1, true);
    winrt::check_hresult(!tools[5].IsEnabled() && errors.empty() ? S_OK : E_FAIL);
    reply(L"appTool", static_cast<std::uint64_t>(toolId), true);
    winrt::check_hresult(tools[5].IsEnabled() && errors.size() == 1 ? S_OK : E_FAIL);
    for (const auto &button : tools) {
        Invoke(button);
        winrt::check_hresult(requests.back().GetNamedString(L"argument") == winrt::unbox_value<winrt::hstring>(button.Tag()) ? S_OK : E_FAIL);
        reply(L"appTool", static_cast<std::uint64_t>(requests.back().GetNamedNumber(L"id")), false);
    }
    stage = 100;
    actions.SetLanguage(true);
    winrt::check_hresult(Automation::AutomationProperties::GetName(actions.ToolsButton()) == L"Hide developer tools" &&
        Automation::AutomationProperties::GetName(tools[6]) == L"UI Lab (browser)" ? S_OK : E_FAIL);
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
