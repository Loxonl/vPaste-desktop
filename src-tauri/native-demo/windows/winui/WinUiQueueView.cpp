#include <windows.h>
#undef GetCurrentTime
#include "WinUiQueueView.h"
#include "WinUiAppearance.h"
#include "WinUiMenuFocus.h"
#include "WinUiRichContent.h"
#include "WinUiMotion.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <chrono>
#include <cmath>
#include <utility>
#include <optional>
#include <unordered_map>

#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Microsoft.UI.Input.h>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Microsoft.UI.Interop.h>
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Text.h>
#include <winrt/Windows.System.h>
#ifdef _DEBUG
#include <cstdio>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {
namespace {

using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Microsoft::UI::Xaml::Media;
using namespace winrt::Windows::Data::Json;
using winrt::Windows::UI::Color;
constexpr double QueueCommandSize = 40;
constexpr double QueueRowSpacing = 4;

TextBlock MakeText(const winrt::hstring &text, double size, bool bold = false) {
    TextBlock block;
    block.Text(text);
    block.FontSize(size);
    block.FontWeight(bold ? winrt::Windows::UI::Text::FontWeights::SemiBold()
                          : winrt::Windows::UI::Text::FontWeights::Normal());
    block.TextTrimming(TextTrimming::CharacterEllipsis);
    block.TextWrapping(TextWrapping::Wrap);
    block.VerticalAlignment(VerticalAlignment::Center);
    ApplyStyle(block, size < 14 ? L"VPaste.Secondary" : L"VPaste.Body");
    return block;
}

struct QueueItem {
    std::wstring hash;
    winrt::hstring itemType;
    winrt::hstring previewText;
    winrt::hstring appSource;
    winrt::hstring imagePath;
};

winrt::hstring FileName(const winrt::hstring &path) {
    const std::wstring value{path};
    const auto separator = value.find_last_of(L"\\/");
    return winrt::hstring{separator == std::wstring::npos ? value : value.substr(separator + 1)};
}

} // namespace

struct QueueView::Impl : std::enable_shared_from_this<QueueView::Impl> {
    explicit Impl(RequestCallback requestCallback, CloseCallback closeCallback)
        : request(std::move(requestCallback)), close(std::move(closeCallback)) {}

    RequestCallback request;
    CloseCallback close;
    Grid root{nullptr};
    std::shared_ptr<MenuOpeningInput> menuInput;
    Grid header{nullptr};
    StackPanel rows{nullptr};
    Canvas exitingRows{nullptr};
    ScrollViewer list{nullptr};
    StackPanel emptyState{nullptr};
    TextBlock title{nullptr};
    TextBlock count{nullptr};
    TextBlock status{nullptr};
    InfoBar feedback{nullptr};
    StackPanel errorActions{nullptr};
    Button retryFailed{nullptr}, removeFailed{nullptr};
    std::wstring failedHash;
    Button reverse{nullptr};
    Button clear{nullptr};
    Button undo{nullptr};
    TextBlock undoLabel{nullptr};
    Border undoToast{nullptr};
    TextBlock undoMessage{nullptr};
    Button closeButton{nullptr};
    Border clearConfirmBar{nullptr};
    TextBlock clearConfirmText{nullptr};
    Button clearConfirmAction{nullptr}, clearCancelAction{nullptr};
    ContentDialog confirmation{nullptr};
    MenuFlyout openItemMenu{nullptr};
    JsonObject state{nullptr};
    std::vector<QueueItem> items;
    std::vector<QueueItem> orderBeforePointerDrop;
    struct RowVisual {
        QueueItem item;
        bool english;
        Border surface{nullptr};
        TextBlock type{nullptr};
        Button paste{nullptr}, remove{nullptr}, handle{nullptr};
        MenuFlyoutItem up{nullptr}, down{nullptr};
    };
    std::unordered_map<std::wstring, RowVisual> rowVisuals;
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer exitExpiry{nullptr};
#ifdef _DEBUG
    bool testRebuildRows = false;
    std::optional<bool> testAnimations;
#endif
    bool english = false;
    bool busy = false;
    bool suspended = false;
    bool serverBusy = false;
    std::uint64_t pendingRequest = 0;
    std::wstring pendingOperation;
    std::wstring reorderFocusHash;
    struct RowFocus {
        std::wstring hash;
        std::uint32_t index = 0;
        std::wstring role;
        FocusState state = FocusState::Keyboard;
    };
    std::optional<RowFocus> rowFocus;
    std::uint64_t renderGeneration = 0;
    bool confirmingClear = false;
    std::uint64_t confirmationGeneration = 0;
    bool showError = false;
    std::wstring draggingHash;
    JsonObject pendingDragState{nullptr};
    bool pendingDragStatePreservesFeedback = false;
    bool suppressDragPaste = false;
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer dragScroll{nullptr};
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer undoExpiry{nullptr};
    int dragScrollDirection = 0;
    UIElement pointerOwner{nullptr};
    std::uint32_t pointerId = 0;
    double pointerStartY = 0, pointerY = 0, pointerStartScroll = 0;
    std::vector<QueueRowMetric> dragMetrics;
    std::vector<std::wstring> dragSourceOrder;
    std::size_t dragFrom = 0, dragTo = 0;
    Vector3Transition dragTransition{nullptr};
    ElementTheme theme = ElementTheme::Default;
    std::uint64_t lastRevision = 0;
    bool hasRevision = false;

    winrt::hstring Text(const wchar_t *chinese, const wchar_t *englishText) const {
        return english ? winrt::hstring{englishText} : winrt::hstring{chinese};
    }

    bool IsDark() const {
        if (theme == ElementTheme::Dark) return true;
        if (theme == ElementTheme::Light) return false;
        return root && root.ActualTheme() == ElementTheme::Dark;
    }

    void Build() {
        root = Grid{};
        menuInput = TrackMenuOpeningInput(root);
        // The queue has its own HWND, not the main panel's Acrylic backdrop.
        ApplyStyle(root, L"VPaste.QueueCanvas");
        root.Padding(UniformThickness(ManagementInset));
        auto weak = weak_from_this();
        root.ActualThemeChanged([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ApplyTheme();
        });
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().GetAt(0).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Star});
        root.RowDefinitions().GetAt(2).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().GetAt(3).Height(GridLength{1, GridUnitType::Auto});
        root.Unloaded([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->Deactivate();
        });
        root.PreviewKeyDown([weak](auto const &, auto const &args) {
            if (auto self = weak.lock()) {
                self->rowFocus.reset();
                if (args.Key() == winrt::Windows::System::VirtualKey::Escape && !self->draggingHash.empty()) {
                    self->FinishDrag(); args.Handled(true);
                }
            }
        });
        root.PointerPressed([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->rowFocus.reset(); });
        root.AddHandler(UIElement::PointerMovedEvent(), winrt::box_value(Input::PointerEventHandler{
            [weak](auto const &, auto const &args) {
                if (const auto self = weak.lock(); self && self->pointerOwner && self->pointerId == args.Pointer().PointerId()) {
                    self->MovePointerReorder(args.GetCurrentPoint(self->list).Position().Y); args.Handled(true);
                }
            }}), true);
        root.AddHandler(UIElement::PointerReleasedEvent(), winrt::box_value(Input::PointerEventHandler{
            [weak](auto const &, auto const &args) {
                if (const auto self = weak.lock(); self && self->pointerOwner && self->pointerId == args.Pointer().PointerId()) {
                    const auto point = args.GetCurrentPoint(self->list).Position();
                    const bool inside = point.X >= 0 && point.X < self->list.ActualWidth() &&
                        point.Y >= 0 && point.Y < self->list.ActualHeight();
                    if (inside) self->MovePointerReorder(point.Y);
                    self->EndPointerReorder(inside); args.Handled(true);
                }
            }}), true);
        root.PointerCanceled([weak](auto const &, auto const &args) {
            if (const auto self = weak.lock(); self && self->pointerOwner && self->pointerId == args.Pointer().PointerId()) self->FinishDrag();
        });
        root.PointerCaptureLost([weak](auto const &, auto const &args) {
            if (const auto self = weak.lock(); self && self->pointerOwner == args.OriginalSource()) self->FinishDrag();
        });
        root.Loaded([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->Activate();
        });
        undoExpiry = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread().CreateTimer();
        undoExpiry.IsRepeating(false);
        undoExpiry.Tick([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->UpdateUndo();
        });

        header = Grid{};
        ApplyStyle(header, L"VPaste.AuxiliaryCaption");
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnSpacing(8);
        header.MinHeight(54);
        header.Margin(Thickness{0, 0, 0, 8});
        header.ColumnDefinitions().GetAt(0).Width(GridLength{2 * QueueCommandSize, GridUnitType::Pixel});
        header.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Star});
        header.ColumnDefinitions().GetAt(2).Width(GridLength{2 * QueueCommandSize, GridUnitType::Pixel});

        StackPanel heading;
        heading.Orientation(Orientation::Vertical);
        heading.Spacing(0);
        heading.HorizontalAlignment(HorizontalAlignment::Center);
        heading.VerticalAlignment(VerticalAlignment::Center);
        title = MakeText(L"", 14, true);
        title.HorizontalAlignment(HorizontalAlignment::Center);
        ApplyStyle(title, L"VPaste.CompactTitle");
        count = MakeText(L"0 / 100", 12);
        count.FontSize(10.5); count.HorizontalAlignment(HorizontalAlignment::Center);
        heading.Children().Append(title);
        heading.Children().Append(count);
        Grid::SetColumn(heading, 1);
        header.Children().Append(heading);

        StackPanel toolbar;
        toolbar.Orientation(Orientation::Horizontal);
        toolbar.HorizontalAlignment(HorizontalAlignment::Right);
        toolbar.VerticalAlignment(VerticalAlignment::Center);
        reverse = NamedIconButton(SymbolIcon{Symbol::Switch}, L"");
        reverse.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->Send(L"queueReverse");
        });

        clear = NamedIconButton(SymbolIcon{Symbol::Delete}, L"");
        clear.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ConfirmClear();
        });
        Automation::AutomationProperties::SetAutomationId(reverse, L"queue-reverse");
        Automation::AutomationProperties::SetAutomationId(clear, L"queue-clear");
        for (const auto &command : {reverse, clear}) {
            command.Width(QueueCommandSize); command.Height(QueueCommandSize);
            toolbar.Children().Append(command);
        }

        undo = Button{};
        ApplyStyle(undo, L"VPaste.CompactButton");
        Automation::AutomationProperties::SetAutomationId(undo, L"queue-undo");
        StackPanel undoAction;
        undoAction.Orientation(Orientation::Horizontal); undoAction.Spacing(4);
        undoAction.Children().Append(CompactSymbol(Symbol::Undo));
        undoLabel = MakeText(L"", 12);
        undoAction.Children().Append(undoLabel);
        undo.Content(undoAction);
        undo.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                self->UpdateUndo();
                if (self->undo.IsEnabled()) self->Send(L"queueUndo");
            }
        });
        StackPanel undoContent;
        undoContent.Orientation(Orientation::Horizontal); undoContent.Spacing(8);
        undoMessage = MakeText(L"", 12);
        undoMessage.VerticalAlignment(VerticalAlignment::Center);
        undoContent.Children().Append(undoMessage); undoContent.Children().Append(undo);
        undoToast = Border(); ApplyStyle(undoToast, L"VPaste.SelectionBar");
        undoToast.Child(undoContent);
        undoToast.Margin(Thickness{0, 8, 0, 0});
        undoToast.Visibility(Visibility::Collapsed);
        closeButton = NamedIconButton(SymbolIcon{Symbol::Cancel}, L"");
        closeButton.HorizontalAlignment(HorizontalAlignment::Left);
        closeButton.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                if (self->close) self->close();
            }
        });
        header.Children().Append(closeButton);
        Grid::SetColumn(toolbar, 2);
        header.Children().Append(toolbar);
        Grid::SetRow(header, 0);
        root.Children().Append(header);

        list = ScrollViewer{};
        list.VerticalScrollMode(ScrollMode::Enabled);
        list.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        list.HorizontalScrollMode(ScrollMode::Disabled);
        list.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);

        rows = StackPanel{};
        rows.Spacing(QueueRowSpacing);
        rows.Margin(Thickness{0, QueueRowSpacing, 0, QueueRowSpacing});
        list.Content(rows);
        list.ViewChanged([weak](auto const &, auto const &) {
            if (const auto self = weak.lock(); self && !self->dragMetrics.empty()) self->MovePointerReorder(self->pointerY);
        });
        dragScroll = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread().CreateTimer();
        dragScroll.Interval(std::chrono::milliseconds(50)); // Drag edge scrolling, not a layout animation.
        dragScroll.IsRepeating(true);
        dragScroll.Tick([weak](auto const &, auto const &) {
            if (const auto self = weak.lock(); self && !self->draggingHash.empty() && self->dragScrollDirection != 0) {
                self->list.ChangeView(nullptr, winrt::box_value(std::clamp(self->list.VerticalOffset() +
                    self->dragScrollDirection * 18.0, 0.0, self->list.ScrollableHeight())).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, true);
            }
        });

        emptyState = EmptyState(L"\uE8FD", L"", L"");
        Grid::SetRow(emptyState, 1);
        Grid::SetRow(list, 1);
        root.Children().Append(list);
        root.Children().Append(emptyState);

        status = MakeText(L"", 12);
        feedback = InfoBar{};
        feedback.IsOpen(false);
        feedback.IsClosable(false);
        feedback.Margin(Thickness{0, 12, 0, 0});
        errorActions = StackPanel(); errorActions.Orientation(Orientation::Horizontal); errorActions.Spacing(8);
        retryFailed = Button(); removeFailed = Button();
        ApplyStyle(retryFailed, L"VPaste.CompactButton"); ApplyStyle(removeFailed, L"VPaste.CompactButton");
        Automation::AutomationProperties::SetAutomationId(retryFailed, L"queue-error-retry");
        Automation::AutomationProperties::SetAutomationId(removeFailed, L"queue-error-remove");
        retryFailed.Click([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->RecoverFailure(L"queuePaste"); });
        removeFailed.Click([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->RecoverFailure(L"queueRemove"); });
        errorActions.Children().Append(retryFailed); errorActions.Children().Append(removeFailed);
        feedback.Content(errorActions);
        Grid::SetRow(feedback, 2);
        root.Children().Append(feedback);
        Grid::SetRow(undoToast, 3); root.Children().Append(undoToast);
        exitingRows = Canvas(); exitingRows.IsHitTestVisible(false);
        exitingRows.SizeChanged([](auto const &sender, auto const &) {
            const auto canvas = sender.as<Canvas>(); RectangleGeometry clip;
            clip.Rect({0, 0, static_cast<float>(canvas.ActualWidth()), static_cast<float>(canvas.ActualHeight())}); canvas.Clip(clip);
        });
        Grid::SetRow(exitingRows, 1); root.Children().Append(exitingRows);
        exitExpiry = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread().CreateTimer();
        exitExpiry.IsRepeating(false);
        exitExpiry.Interval(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
            std::chrono::duration<double>{CachedMotionTiming().durationFast}));
        exitExpiry.Tick([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->ClearExits(); });
        clearConfirmBar = Border();
        ApplyStyle(clearConfirmBar, L"VPaste.SelectionBar");
        clearConfirmBar.Margin(Thickness{0, 8, 0, 0});
        clearConfirmBar.Visibility(Visibility::Collapsed);
        Grid confirmLayout;
        confirmLayout.ColumnSpacing(8);
        confirmLayout.ColumnDefinitions().Append(ColumnDefinition{});
        ColumnDefinition confirmBtnsCol; confirmBtnsCol.Width(GridLength{1, GridUnitType::Auto});
        confirmLayout.ColumnDefinitions().Append(confirmBtnsCol);
        clearConfirmText = MakeText(L"", 12);
        clearConfirmText.VerticalAlignment(VerticalAlignment::Center);
        confirmLayout.Children().Append(clearConfirmText);
        StackPanel confirmActions;
        confirmActions.Orientation(Orientation::Horizontal);
        confirmActions.Spacing(6);
        clearCancelAction = Button();
        ApplyStyle(clearCancelAction, L"VPaste.CompactButton");
        Automation::AutomationProperties::SetAutomationId(clearCancelAction, L"queue-clear-cancel");
        clearCancelAction.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->CancelClearConfirmation();
        });
        clearConfirmAction = Button();
        StyleAuxiliaryAction(clearConfirmAction, true);
        clearConfirmAction.MinWidth(68);
        clearConfirmAction.FontSize(12);
        Automation::AutomationProperties::SetAutomationId(clearConfirmAction, L"queue-clear-confirm");
        clearConfirmAction.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ExecuteClearConfirmation();
        });
        confirmActions.Children().Append(clearCancelAction);
        confirmActions.Children().Append(clearConfirmAction);
        Grid::SetColumn(confirmActions, 1);
        confirmLayout.Children().Append(confirmActions);
        clearConfirmBar.Child(confirmLayout);
        // 与 undoToast 共用第 3 行并通过 confirmingClear 互斥显隐，保持 Grid 4 行与子节点 0..5 索引契约不变
        Grid::SetRow(clearConfirmBar, 3);
        root.Children().Append(clearConfirmBar);
        ApplyLanguage();
        ApplyTheme();
    }

    void LocalizeConfirmation() {
        const auto label = Text(L"清空队列", L"Clear queue");
        if (clearConfirmText) clearConfirmText.Text(Text(L"确定清空队列？", L"Clear every item?"));
        if (clearConfirmAction) clearConfirmAction.Content(winrt::box_value(label));
        if (clearCancelAction) clearCancelAction.Content(winrt::box_value(Text(L"保留", L"Keep")));
        if (!confirmation) return;
        confirmation.Title(winrt::box_value(label));
        confirmation.Content(winrt::box_value(Text(L"清空全部待粘贴项目？队列模式会保持激活。",
            L"Clear every queued item? Queue mode will remain active.")));
        confirmation.PrimaryButtonText(label);
        confirmation.CloseButtonText(Text(L"保留", L"Keep"));
    }

    void CancelClearConfirmation() {
        confirmingClear = false;
        if (clearConfirmBar) clearConfirmBar.Visibility(Visibility::Collapsed);
        RenderItems();
        if (clear && clear.IsEnabled()) clear.Focus(FocusState::Programmatic);
    }

    void ExecuteClearConfirmation() {
        if (!confirmingClear) return;
        confirmingClear = false;
        if (clearConfirmBar) clearConfirmBar.Visibility(Visibility::Collapsed);
        RenderItems();
        if (!busy && !items.empty()) Send(L"queueClear");
    }

    winrt::fire_and_forget ConfirmClear() {
        const auto lifetime = shared_from_this();
        if (busy || confirmingClear || items.empty() || !root.IsLoaded()) co_return;
        confirmingClear = true;
        LocalizeConfirmation();
        // WS_EX_NOACTIVATE 悬浮窗不抢系统前台激活，改用内联确认条避免 ContentDialog 拦截键盘失效。
        if (clearConfirmBar) clearConfirmBar.Visibility(Visibility::Visible);
        RenderItems();
    }

    void Activate() {
        suspended = false;
        UpdateUndo();
    }

    void Deactivate() {
        suspended = true;
        rowFocus.reset(); ++renderGeneration;
        undoExpiry.Stop();
        ClearExits();
        ++confirmationGeneration;
        const auto dialog = std::exchange(confirmation, nullptr);
        confirmingClear = false;
        if (clearConfirmBar) clearConfirmBar.Visibility(Visibility::Collapsed);
        if (dialog) dialog.Hide();
        if (const auto menu = std::exchange(openItemMenu, nullptr)) menu.Hide();
        reorderFocusHash.clear();
        FinishDrag();
        RenderItems();
    }

    void Send(const wchar_t *operation, const std::wstring &hash = {},
              const std::vector<std::wstring> &hashes = {}, bool previewDrop = false) {
        if (!request || busy || !draggingHash.empty()) return;
        showError = false;
        status.Text(L"");
        busy = true;
        pendingOperation = operation;
        pendingRequest = request(operation, hash, hashes);
        if (!pendingRequest) {
            busy = serverBusy;
            SetError(std::wstring{Text(L"操作未能发送，请重试", L"Could not send this action; try again")});
            return;
        }
        if (previewDrop) {
            // Like the WebView, show the drop immediately, without waiting for
            // the Rust reply to replace the translated rows with the new order.
            orderBeforePointerDrop = items;
            std::sort(items.begin(), items.end(), [&](QueueItem const &a, QueueItem const &b) {
                return std::find(hashes.begin(), hashes.end(), a.hash) < std::find(hashes.begin(), hashes.end(), b.hash);
            });
        }
        RenderItems();
    }

    void RecoverFailure(wchar_t const *operation) {
        if (!showError || busy || confirmingClear || failedHash.empty() ||
            std::none_of(items.begin(), items.end(), [&](auto const &item) { return item.hash == failedHash; })) return;
        const auto hash = failedHash;
        Send(operation, hash);
    }

    void UpdateUndo() {
        if (!undo) return;
        undoExpiry.Stop();
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        const auto hash = state ? state.GetNamedValue(L"undoHash", nullptr) : JsonValue{nullptr};
        const auto value = state ? state.GetNamedValue(L"undoExpiresAt", nullptr) : JsonValue{nullptr};
        const double deadline = value && value.ValueType() == JsonValueType::Number ? value.GetNumber() : 0;
        const bool live = hash && hash.ValueType() == JsonValueType::String && !hash.GetString().empty() &&
            std::isfinite(deadline) && deadline > static_cast<double>(now);
        const bool showUndo = live && !confirmingClear;
        undo.Visibility(showUndo ? Visibility::Visible : Visibility::Collapsed);
        undoToast.Visibility(showUndo ? Visibility::Visible : Visibility::Collapsed);
        undo.IsEnabled(showUndo && !busy);
        if (live && root.IsLoaded() && !suspended) {
            // Only the Undo affordance changes at expiry; keep rows and focus intact.
            undoExpiry.Interval(std::chrono::milliseconds{
                static_cast<std::int64_t>(std::clamp(deadline - now, 1.0, 60'000.0))});
            undoExpiry.Start();
        }
    }

    std::vector<std::wstring> OrderedHashes() const {
        std::vector<std::wstring> hashes;
        hashes.reserve(items.size());
        for (const auto &item : items) hashes.push_back(item.hash);
        return hashes;
    }

    void MoveItem(std::wstring const &hash, int delta, bool keyboard = false) {
        if (busy || confirmingClear) return;
        const auto found = std::find_if(items.begin(), items.end(), [&](auto const &item) { return item.hash == hash; });
        if (found == items.end()) return;
        const auto index = static_cast<std::size_t>(std::distance(items.begin(), found));
        const auto target = static_cast<std::ptrdiff_t>(index) + delta;
        if (target < 0 || target >= static_cast<std::ptrdiff_t>(items.size())) return;
        auto hashes = OrderedHashes();
        std::swap(hashes[index], hashes[static_cast<std::size_t>(target)]);
        if (keyboard) reorderFocusHash = hash;
        Send(L"queueReorder", {}, hashes);
    }

    void FinishDrag() {
        if (draggingHash.empty() && !pendingDragState) return;
        dragScrollDirection = 0;
        if (dragScroll) dragScroll.Stop();
        const auto source = std::exchange(draggingHash, {});
        if (!dragSourceOrder.empty()) {
            for (std::size_t index = 0; index < dragSourceOrder.size(); ++index) {
                auto const &visual = rowVisuals.at(dragSourceOrder[index]);
                if (visual.surface.TranslationTransition()) visual.surface.TranslationTransition(nullptr);
                if (visual.surface.Translation().y != 0) visual.surface.Translation({0, 0, 0});
                if (index == dragFrom) {
                    Canvas::SetZIndex(visual.surface, 0);
                    visual.surface.Opacity(1);
                }
                visual.type.Text(index == 0 ? Text(L"下一项", L"Next") : TypeLabel(visual.item.itemType, english));
            }
        }
        dragMetrics.clear(); dragSourceOrder.clear(); dragTransition = nullptr;
        const auto latest = std::exchange(pendingDragState, nullptr);
        const bool preserveFeedback = std::exchange(pendingDragStatePreservesFeedback, false);
        pointerId = 0;
        if (auto owner = std::exchange(pointerOwner, nullptr)) owner.ReleasePointerCaptures();
        if (!source.empty() && request) request(L"dragEnd", {}, {});
        if (latest) SetState(latest, preserveFeedback);
    }

    bool BeginReorder(const std::wstring &hash) {
        if (busy || confirmingClear || !draggingHash.empty() ||
            std::none_of(items.begin(), items.end(), [&](const auto &item) { return item.hash == hash; })) return false;
        ClearExits();
        for (auto const &entry : rowVisuals) ResetFeedbackOpacity(entry.second.surface);
        draggingHash = hash;
        suppressDragPaste = true;
        dragScroll.Start();
        if (request) request(L"dragBegin", {}, {});
        return true;
    }

    bool StartPointerReorder(const std::wstring &hash, double y) {
        if (!root.IsLoaded() || !BeginReorder(hash)) return false;
        pointerStartY = pointerY = y; pointerStartScroll = list.VerticalOffset();
        dragSourceOrder = OrderedHashes();
        dragFrom = dragTo = static_cast<std::size_t>(
            std::find(dragSourceOrder.begin(), dragSourceOrder.end(), hash) - dragSourceOrder.begin());
        for (const auto &child : rows.Children()) {
            const auto surface = child.as<Border>();
            const auto point = surface.TransformToVisual(rows).TransformPoint({0, 0});
            dragMetrics.push_back({point.Y, surface.ActualHeight()});
        }
        if (AnimateRows()) {
            dragTransition = Vector3Transition{};
            dragTransition.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
                std::chrono::duration<double>{CachedMotionTiming().durationFast}));
        }
        Canvas::SetZIndex(rowVisuals.at(hash).surface, 2);
        MovePointerReorder(y);
        return true;
    }

    void MovePointerReorder(double y) {
        if (draggingHash.empty() || dragMetrics.empty()) return;
        pointerY = y;
        dragScrollDirection = y < 24 ? -1 : y > list.ActualHeight() - 24 ? 1 : 0;
        const auto offset = y - pointerStartY + list.VerticalOffset() - pointerStartScroll;
        const auto &source = dragMetrics[dragFrom];
        const auto &last = dragMetrics.back();
        const auto travel = std::clamp(offset, dragMetrics.front().top - source.top, last.top + last.height - source.top - source.height);
        rowVisuals.at(draggingHash).surface.Translation({0, static_cast<float>(travel), 0});
        const auto to = QueuePointerSlot(dragMetrics, dragFrom, offset);
        if (to == dragTo) return;
        const double slot = source.height + QueueRowSpacing;
        const auto firstRow = [&](std::size_t destination) { return destination == 0 ? dragFrom : dragFrom == 0 ? 1 : 0; };
        if (const auto previousFirst = firstRow(dragTo); previousFirst != firstRow(to)) {
            auto const &previous = rowVisuals.at(dragSourceOrder[previousFirst]);
            previous.type.Text(TypeLabel(previous.item.itemType, english));
            rowVisuals.at(dragSourceOrder[firstRow(to)]).type.Text(Text(L"下一项", L"Next"));
        }
        dragTo = to;
        // Preview order with transforms only. Keep the live rows and pointer
        // capture intact until the shared queue mutation is accepted.
        for (std::size_t index = 0; index < dragSourceOrder.size(); ++index) {
            auto const &visual = rowVisuals.at(dragSourceOrder[index]);
            if (index == dragFrom) continue;
            const float shift = static_cast<float>(dragFrom < index && index <= to ? -slot
                : to <= index && index < dragFrom ? slot : 0);
            if (visual.surface.Translation().y == shift) continue;
            if (dragTransition && !visual.surface.TranslationTransition()) visual.surface.TranslationTransition(dragTransition);
            visual.surface.Translation({0, shift, 0});
        }
    }

    void EndPointerReorder(bool commit) {
        if (!commit || dragSourceOrder.empty() || dragTo == dragFrom) { FinishDrag(); return; }
        const auto target = dragSourceOrder[dragTo];
        DropItem(target, dragTo > dragFrom);
    }

    void DropItem(const std::wstring &target, bool after) {
        const auto source = draggingHash;
        const bool pointerDrop = !dragMetrics.empty();
        FinishDrag(); // Merge newer captures/deletions before constructing the order.
        if (busy || confirmingClear || source.empty()) return;
        const auto current = OrderedHashes();
        const auto order = QueueDropOrder(current, source, target, after);
        if (order != current) Send(L"queueReorder", {}, order, pointerDrop);
    }

    void CaptureRowFocus() {
        if (suspended || !root.IsLoaded() || confirmingClear) return;
        auto focused = Input::FocusManager::GetFocusedElement(root.XamlRoot()).try_as<Control>();
        if (!focused || focused.FocusState() == FocusState::Unfocused) return;
        auto node = focused.as<DependencyObject>();
        while (node && VisualTreeHelper::GetParent(node) != rows) node = VisualTreeHelper::GetParent(node);
        if (!node) return;
        const auto surface = node.try_as<Border>();
        std::uint32_t index = 0;
        if (!surface || !rows.Children().IndexOf(surface, index)) return;
        rowFocus = RowFocus{std::wstring{winrt::unbox_value<winrt::hstring>(surface.Tag())}, index,
            std::wstring{Automation::AutomationProperties::GetAutomationId(focused)}, focused.FocusState()};
    }

    void RestoreRowFocus() {
        if (items.empty()) { rowFocus.reset(); return; }
        if (suspended || busy || confirmingClear || !rowFocus) return;
        auto found = std::find_if(items.begin(), items.end(), [&](auto const &item) { return item.hash == rowFocus->hash; });
        const auto index = found == items.end() ? std::min<std::size_t>(rowFocus->index, items.size() - 1)
            : static_cast<std::size_t>(std::distance(items.begin(), found));
        const auto row = rows.Children().GetAt(static_cast<std::uint32_t>(index)).as<Border>().Child().as<Grid>();
        auto target = row.Children().GetAt(0).as<Button>();
        if (rowFocus->role == L"queue-handle") target = row.Children().GetAt(2).as<Button>();
        if (rowFocus->role == L"queue-remove")
            target = row.Children().GetAt(1).as<StackPanel>().Children().GetAt(0).as<Button>();
        const auto generation = renderGeneration;
        const auto focusAtSchedule = winrt::make_weak(
            Input::FocusManager::GetFocusedElement(root.XamlRoot()).try_as<DependencyObject>());
        const auto restore = [weak = weak_from_this(), weakTarget = winrt::make_weak(target), generation, focusAtSchedule](auto const &, auto const &) {
            const auto self = weak.lock();
            const auto target = weakTarget.get();
            if (!self || !target || !self->rowFocus || self->renderGeneration != generation || self->busy || self->suspended ||
                !self->root.IsLoaded() || !target.IsLoaded() || !target.IsEnabled()) return;
            const auto state = self->rowFocus->state;
            self->rowFocus.reset(); self->reorderFocusHash.clear();
            const auto focused = Input::FocusManager::GetFocusedElement(self->root.XamlRoot());
            const auto previous = focusAtSchedule.get();
            if (previous && focused != previous && focused != target) return;
            const auto owner = winrt::Microsoft::UI::GetWindowFromWindowId(self->root.XamlRoot().ContentIslandEnvironment().AppWindowId());
            // The dock and queue share an STA, but only this surface may restore focus.
            if (owner && GetAncestor(owner, GA_ROOT) == GetForegroundWindow()) target.Focus(state);
        };
        if (target.IsLoaded()) restore(nullptr, nullptr);
        else target.Loaded(restore);
    }

    bool AnimateRows() const {
#ifdef _DEBUG
        if (testAnimations) return *testAnimations;
#endif
        return NativeAnimationsEnabled();
    }

    void ClearExits() {
        if (exitExpiry) exitExpiry.Stop();
        if (!exitingRows) return;
        for (auto const &child : exitingRows.Children()) ResetFeedbackOpacity(child.as<FrameworkElement>());
        exitingRows.Children().Clear();
    }

    void ExitRow(RowVisual const &visual) {
        const auto surface = visual.surface;
        if (!AnimateRows() || suspended || !surface.IsLoaded() || surface.ActualHeight() <= 0) return;
        const auto point = surface.TransformToVisual(exitingRows).TransformPoint({0, 0});
        const auto width = surface.ActualWidth(), height = surface.ActualHeight();
        std::uint32_t oldIndex = 0;
        if (!rows.Children().IndexOf(surface, oldIndex)) return;
        rows.Children().RemoveAt(oldIndex);
        surface.Width(width); surface.Height(height); surface.IsHitTestVisible(false);
        visual.paste.IsEnabled(false); visual.remove.IsEnabled(false); visual.handle.IsEnabled(false);
        Canvas::SetLeft(surface, point.X); Canvas::SetTop(surface, point.Y);
        exitingRows.Children().Append(surface);
        const auto compositor = CompositionTarget::GetCompositorForCurrentThread();
        const auto &curve = CachedMotionTiming().easingExit;
        const auto easing = compositor.CreateCubicBezierEasingFunction({curve[0], curve[1]}, {curve[2], curve[3]});
        const auto animation = compositor.CreateScalarKeyFrameAnimation(); animation.Target(L"Opacity");
        animation.InsertKeyFrame(0, 1); animation.InsertKeyFrame(1, 0, easing);
        animation.Duration(exitExpiry.Interval()); surface.StartAnimation(animation);
        surface.Resources().Insert(winrt::box_value(FeedbackAnimationResource), animation);
        exitExpiry.Start();
    }

    void RenderItems() {
        CaptureRowFocus();
        if (!reorderFocusHash.empty()) rowFocus = RowFocus{reorderFocusHash, 0, L"queue-handle", FocusState::Keyboard};
        ++renderGeneration;
        if (!AnimateRows()) ClearExits();
#ifdef _DEBUG
        if (testRebuildRows) { rows.Children().Clear(); rowVisuals.clear(); }
#endif
        const bool initial = rowVisuals.empty();
        std::unordered_map<std::wstring, RowVisual> nextRows;
        std::vector<Border> desired;
        for (std::size_t index = 0; index < items.size(); ++index) {
            const auto item = items[index];
            if (const auto found = rowVisuals.find(item.hash); found != rowVisuals.end()) {
                auto visual = found->second;
                if (visual.english == english && visual.item.itemType == item.itemType && visual.item.previewText == item.previewText &&
                    visual.item.imagePath == item.imagePath && visual.item.appSource == item.appSource) {
                    visual.type.Text(index == 0 ? Text(L"下一项", L"Next") : TypeLabel(item.itemType, english));
                    visual.paste.IsEnabled(!busy); visual.remove.IsEnabled(!busy); visual.handle.IsEnabled(!busy && !confirmingClear);
                    visual.up.IsEnabled(!busy && index > 0); visual.down.IsEnabled(!busy && index + 1 < items.size());
                    desired.push_back(visual.surface); nextRows.emplace(item.hash, std::move(visual)); continue;
                }
            }
            Grid row;
            row.VerticalAlignment(VerticalAlignment::Center);
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().GetAt(0).Width(GridLength{34, GridUnitType::Pixel});
            row.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Star});
            row.ColumnDefinitions().GetAt(2).Width(GridLength{1, GridUnitType::Auto});
            row.ColumnSpacing(8);

            StackPanel details;
            details.Orientation(Orientation::Vertical);
            details.Spacing(2);
            TextBlock type = MakeText(index == 0 ? Text(L"下一项", L"Next") : TypeLabel(item.itemType, english), 10.5);
            type.FontSize(10.5); type.TextWrapping(TextWrapping::NoWrap); type.MaxLines(1);
            TextBlock preview = MakeText(
                item.itemType == L"Image" || item.previewText.empty()
                    ? TypeLabel(item.itemType, english) : item.previewText, 13);
            ApplyStyle(preview, L"VPaste.Body");
            preview.FontSize(12.5);
            preview.MaxLines(1);
            preview.TextWrapping(TextWrapping::NoWrap);
            details.Children().Append(preview);
            details.Children().Append(type);

            auto weak = weak_from_this();
            Button paste;
            ApplyStyle(paste, L"VPaste.IconButton");
            Grid itemContent; itemContent.ColumnSpacing(10);
            ColumnDefinition iconColumn; iconColumn.Width(GridLength{36, GridUnitType::Pixel});
            itemContent.ColumnDefinitions().Append(iconColumn); itemContent.ColumnDefinitions().Append(ColumnDefinition{});
            paste.Content(itemContent);
            paste.MinHeight(48);
            paste.HorizontalAlignment(HorizontalAlignment::Stretch);
            paste.HorizontalContentAlignment(HorizontalAlignment::Stretch);
            paste.Padding(Thickness{0});
            paste.IsEnabled(!busy);
            Automation::AutomationProperties::SetAutomationId(paste, L"queue-paste");
            Automation::AutomationProperties::SetName(paste, Text(L"粘贴：", L"Paste: ") + preview.Text());
            paste.Click([weak, hash = item.hash](auto const &, auto const &) {
                if (auto self = weak.lock(); self && !self->suppressDragPaste && self->draggingHash.empty()) self->Send(L"queuePaste", hash);
            });
            paste.AddHandler(UIElement::PointerPressedEvent(), winrt::box_value(Input::PointerEventHandler{
                [weak](auto const &, auto const &) {
                    if (auto self = weak.lock()) self->suppressDragPaste = false;
                }}), true);
            paste.PreviewKeyDown([weak](auto const &, auto const &args) {
                if (args.Key() == winrt::Windows::System::VirtualKey::Enter ||
                    args.Key() == winrt::Windows::System::VirtualKey::Space) {
                    if (auto self = weak.lock()) self->suppressDragPaste = false;
                }
            });
            Grid::SetColumn(paste, 1);
            row.Children().Append(paste);

            StackPanel actions;
            actions.Orientation(Orientation::Horizontal);
            actions.Spacing(4);
            actions.VerticalAlignment(VerticalAlignment::Center);
            FontIcon upIcon;
            upIcon.Glyph(L"\uE70E");
            upIcon.FontSize(16);
            MenuFlyout rowMenu;
            rowMenu.Opened([weak](auto const &sender, auto const &) {
                if (auto self = weak.lock()) self->openItemMenu = sender.template as<MenuFlyout>();
            });
            rowMenu.Closed([weak](auto const &sender, auto const &) {
                if (auto self = weak.lock(); self && self->openItemMenu == sender) self->openItemMenu = nullptr;
            });
            MenuFlyoutItem up;
            up.Text(Text(L"上移", L"Move up"));
            up.Icon(upIcon);
            up.IsEnabled(!busy && index > 0);
            up.Click([weak, hash = item.hash](auto const &, auto const &) {
                if (auto self = weak.lock()) self->MoveItem(hash, -1);
            });
            rowMenu.Items().Append(up);

            FontIcon downIcon;
            downIcon.Glyph(L"\uE70D");
            downIcon.FontSize(16);
            MenuFlyoutItem down;
            down.Text(Text(L"下移", L"Move down"));
            down.Icon(downIcon);
            down.IsEnabled(!busy && index + 1 < items.size());
            down.Click([weak, hash = item.hash](auto const &, auto const &) {
                if (auto self = weak.lock()) self->MoveItem(hash, 1);
            });
            rowMenu.Items().Append(down);
            BindMenuOpeningFocus(rowMenu, menuInput);
            paste.ContextFlyout(rowMenu);

            Button remove = NamedIconButton(SymbolIcon{Symbol::Remove}, Text(L"从队列移除", L"Remove from queue"));
            remove.IsEnabled(!busy);
            Automation::AutomationProperties::SetAutomationId(remove, L"queue-remove");
            remove.Click([weak, hash = item.hash](auto const &, auto const &) {
                if (auto self = weak.lock()) self->Send(L"queueRemove", hash);
            });
            actions.Children().Append(remove);
            Grid::SetColumn(actions, 2);
            row.Children().Append(actions);

            StackPanel position;
            position.Spacing(4);
            position.VerticalAlignment(VerticalAlignment::Center);
            Grid identity;
            identity.Width(36);
            identity.Height(28);
            const auto glyph = Glyph(TypeGlyph(item.itemType));
            glyph.FontSize(22);
            identity.Children().Append(glyph);
            if (!item.imagePath.empty()) {
                try {
                    Image image;
                    image.Stretch(Stretch::Uniform);
                    Media::Imaging::BitmapImage bitmap;
                    bitmap.DecodePixelWidth(76);
                    bitmap.UriSource(LocalAssetUri(item.imagePath));
                    image.Source(bitmap);
                    image.ImageOpened([glyph](auto const &, auto const &) { glyph.Visibility(Visibility::Collapsed); });
                    image.ImageFailed([glyph](auto const &sender, auto const &) {
                        sender.as<Image>().Visibility(Visibility::Collapsed);
                        glyph.Visibility(Visibility::Visible);
                    });
                    identity.Children().Append(image);
                } catch (const winrt::hresult_error &) {
                    // Keep the native type glyph when a stored image is missing.
                }
            }
            Grid::SetColumn(details, 1); itemContent.Children().Append(identity); itemContent.Children().Append(details);
            position.Children().Append(Glyph(L"\uE700"));
            Button handle; ApplyStyle(handle, L"VPaste.IconButton");
            NameIconButton(handle, Text(L"拖动调整顺序", L"Drag to reorder"));
            handle.Content(position); handle.Width(34); handle.Height(48); handle.Padding(Thickness{0});
            handle.IsEnabled(!busy && !confirmingClear);
            handle.ContextFlyout(rowMenu);
            Automation::AutomationProperties::SetAutomationId(handle, L"queue-handle");
            Automation::AutomationProperties::SetHelpText(handle, Text(L"拖动排序，或使用上下方向键及更多菜单",
                L"Drag to reorder, or use the Up/Down keys or item menu"));
            handle.PreviewKeyDown([weak, hash = item.hash](auto const &, auto const &args) {
                if ((GetKeyState(VK_CONTROL) & 0x8000) || (GetKeyState(VK_SHIFT) & 0x8000) || (GetKeyState(VK_MENU) & 0x8000)) return;
                if (args.Key() != winrt::Windows::System::VirtualKey::Up && args.Key() != winrt::Windows::System::VirtualKey::Down) return;
                if (!args.KeyStatus().WasKeyDown) if (auto self = weak.lock())
                    self->MoveItem(hash, args.Key() == winrt::Windows::System::VirtualKey::Up ? -1 : 1, true);
                args.Handled(true);
            });
            handle.ManipulationMode(Input::ManipulationModes::None);
            // Button class handlers consume presses; handledEventsToo is essential.
            handle.AddHandler(UIElement::PointerPressedEvent(), winrt::box_value(Input::PointerEventHandler{
                [weak, hash = item.hash](auto const &sender, auto const &args) {
                    const auto self = weak.lock();
                    if (!self || !args.GetCurrentPoint(self->list).Properties().IsLeftButtonPressed()) return;
                    if (!self->StartPointerReorder(hash, args.GetCurrentPoint(self->list).Position().Y)) return;
                    // ButtonBase already captures on press and releases before
                    // our release handler. Transfer capture to the stable root;
                    // ignore the old button's capture-lost event during transfer.
                    self->pointerOwner = self->root; self->pointerId = args.Pointer().PointerId();
                    sender.as<Button>().ReleasePointerCapture(args.Pointer());
                    if (!self->root.CapturePointer(args.Pointer())) { self->FinishDrag(); return; }
                    args.Handled(true);
                }}), true);
            row.Children().Append(handle);

            Border container;
            container.Tag(winrt::box_value(winrt::hstring{item.hash}));
            container.Child(row);
            ApplyStyle(container, L"VPaste.QueueRow");
            container.MinHeight(62);
            remove.Opacity(0);
            const auto pointerInside = std::make_shared<bool>(false);
            container.PointerEntered([remove, pointerInside](auto const &, auto const &) { *pointerInside = true; remove.Opacity(1); });
            container.PointerExited([remove, pointerInside, weakSurface = winrt::make_weak(container)](auto const &, auto const &) {
                *pointerInside = false;
                const auto surface = weakSurface.get();
                if (!surface || !surface.XamlRoot()) return;
                auto focused = Input::FocusManager::GetFocusedElement(surface.XamlRoot()).try_as<DependencyObject>();
                while (focused && focused != surface) focused = VisualTreeHelper::GetParent(focused);
                if (!focused) remove.Opacity(0);
            });
            container.GotFocus([remove](auto const &, auto const &) { remove.Opacity(1); });
            container.LostFocus([remove, pointerInside](auto const &, auto const &) { if (!*pointerInside) remove.Opacity(0); });
            desired.push_back(container);
            nextRows.emplace(item.hash, RowVisual{item, english, container, type, paste, remove, handle, up, down});
            if (!initial && !rowVisuals.contains(item.hash) && !suspended) {
                container.Loaded([weak, hash = item.hash, weakRow = winrt::make_weak(container), entered = std::make_shared<bool>(false)](auto const &, auto const &) {
                    if (*entered) return;
                    *entered = true;
                    const auto self = weak.lock(); const auto row = weakRow.get();
                    if (!self || !row || !self->draggingHash.empty() || self->suspended) return;
                    const auto current = self->rowVisuals.find(hash);
                    if (current != self->rowVisuals.end() && current->second.surface == row) FadeFeedback(row, self->AnimateRows());
                });
            }
        }
        for (auto const &entry : rowVisuals) if (!nextRows.contains(entry.first)) ExitRow(entry.second);
        // Broadcast and command reply often carry the same revision. Keep the
        // pending exits alive across those refreshes; only Undo/re-add cancels
        // an outgoing copy of the same hash.
        for (std::uint32_t i = exitingRows.Children().Size(); i > 0; --i) {
            const auto surface = exitingRows.Children().GetAt(i - 1).as<Border>();
            if (nextRows.contains(std::wstring{winrt::unbox_value<winrt::hstring>(surface.Tag())})) {
                ResetFeedbackOpacity(surface); exitingRows.Children().RemoveAt(i - 1);
            }
        }
        for (std::uint32_t index = 0; index < desired.size(); ++index) {
            const auto target = desired[index];
            if (index < rows.Children().Size() && rows.Children().GetAt(index) == target) continue;
            std::uint32_t previous = 0;
            if (rows.Children().IndexOf(target, previous)) rows.Children().RemoveAt(previous);
            rows.Children().InsertAt(index, target);
        }
        while (rows.Children().Size() > desired.size()) rows.Children().RemoveAtEnd();
        rowVisuals = std::move(nextRows);
        list.Visibility(items.empty() ? Visibility::Collapsed : Visibility::Visible);
        emptyState.Visibility(items.empty() ? Visibility::Visible : Visibility::Collapsed);
        const auto capacity = state
                                  ? static_cast<std::size_t>(state.GetNamedNumber(L"capacity", 100))
                                  : std::size_t{100};
        count.Text(winrt::hstring{std::to_wstring(items.size()) + L" / " +
                                   std::to_wstring(capacity)});
        reverse.IsEnabled(!busy && items.size() > 1);
        if (items.empty() && confirmingClear) {
            confirmingClear = false;
            if (clearConfirmBar) clearConfirmBar.Visibility(Visibility::Collapsed);
        }
        clear.IsEnabled(!busy && !items.empty() && !confirmingClear);
        if (clearConfirmAction) clearConfirmAction.IsEnabled(!busy && !items.empty());
        if (clearCancelAction) clearCancelAction.IsEnabled(!busy);
        if (confirmation) confirmation.IsPrimaryButtonEnabled(!busy && !items.empty());
        UpdateUndo();
        if (!reorderFocusHash.empty() && std::none_of(items.begin(), items.end(), [&](auto const &item) { return item.hash == reorderFocusHash; }))
            reorderFocusHash.clear();
        ApplyTheme();
        RestoreRowFocus();
    }

    bool SetState(JsonObject const &nextState, bool preserveFeedback = false) {
        const auto nextRevision = static_cast<std::uint64_t>(nextState.GetNamedNumber(L"revision", 0));
        if (hasRevision && (nextRevision < lastRevision || (preserveFeedback && nextRevision == lastRevision))) return false;
        if (!draggingHash.empty()) {
            const auto deferredRevision = pendingDragState
                ? static_cast<std::uint64_t>(pendingDragState.GetNamedNumber(L"revision", 0)) : 0;
            if (!pendingDragState || nextRevision > deferredRevision || (nextRevision == deferredRevision && !preserveFeedback)) {
                pendingDragState = nextState;
                pendingDragStatePreservesFeedback = preserveFeedback;
            }
            return false;
        }
        if (!orderBeforePointerDrop.empty() && pendingRequest && nextRevision == lastRevision) return false;
        lastRevision = nextRevision;
        hasRevision = true;
        orderBeforePointerDrop.clear();

        state = nextState;
        serverBusy = state.GetNamedBoolean(L"busy", false);
        busy = serverBusy || pendingRequest != 0;
        items.clear();
        if (state.HasKey(L"items") && state.GetNamedValue(L"items").ValueType() == JsonValueType::Array) {
            const auto queueItems = state.GetNamedArray(L"items");
            for (std::uint32_t index = 0; index < queueItems.Size(); ++index) {
                const auto value = queueItems.GetAt(index);
                if (value.ValueType() != JsonValueType::Object) continue;
                const auto item = value.GetObject();
                auto preview = item.GetNamedString(L"previewText", L"");
                if (preview.empty()) preview = item.GetNamedString(L"textContent", L"");
                if (preview.empty()) preview = item.GetNamedString(L"previewContent", L"");
                if (preview.empty()) preview = item.GetNamedString(L"content", L"");
                const auto type = item.GetNamedString(L"itemType", L"");
                const auto content = item.GetNamedString(L"content", L"");
                if (type == L"Link" && !content.empty()) {
                    const std::wstring link{content};
                    preview = winrt::hstring{link.substr(0, link.find(L"|||"))};
                } else if (type == L"File") {
                    JsonArray paths;
                    if (JsonArray::TryParse(content, paths) && paths.Size() &&
                        paths.GetAt(0).ValueType() == JsonValueType::String) {
                        preview = FileName(paths.GetStringAt(0));
                        if (paths.Size() > 1) preview = preview + L" +" + winrt::hstring{std::to_wstring(paths.Size() - 1)};
                    }
                } else if (type == L"TextFile" && !content.empty()) {
                    preview = FileName(content);
                }
                items.push_back(QueueItem{
                    std::wstring{item.GetNamedString(L"hash", L"")},
                    type,
                    preview,
                    item.GetNamedString(L"appSource", L""),
                    item.GetNamedString(L"itemType", L"") == L"Image"
                        ? item.GetNamedString(L"previewContent", L"") : winrt::hstring{}});
            }
        }

        if (!preserveFeedback) {
            winrt::hstring error;
            failedHash.clear();
            if (state.HasKey(L"error") && state.GetNamedValue(L"error").ValueType() == JsonValueType::Object) {
                const auto failure = state.GetNamedObject(L"error");
                error = failure.GetNamedString(L"message", L"");
                const auto hash = failure.GetNamedValue(L"hash", nullptr);
                if (hash && hash.ValueType() == JsonValueType::String) failedHash = hash.GetString();
            }
            showError = !error.empty();
            status.Text(error);
        }
        RenderItems();
        return true;
    }

    bool Receive(JsonObject const &response) {
        if (!pendingRequest || static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0)) != pendingRequest ||
            response.GetNamedString(L"op", L"") != pendingOperation) return false;
        pendingRequest = 0; pendingOperation.clear();
        busy = serverBusy;
        if (response.HasKey(L"error")) SetError(std::wstring{response.GetNamedString(L"error")});
        else if (!SetState(response.GetNamedObject(L"data"))) {
            status.Text(L"");
            RenderItems();
        }
        return true;
    }

    void ApplyLanguage() {
        title.Text(Text(L"粘贴队列", L"Paste Queue"));
        NameIconButton(reverse, Text(L"反转顺序", L"Reverse order"));
        NameIconButton(clear, Text(L"清空队列", L"Clear queue"));
        undoLabel.Text(Text(L"恢复到队列", L"Restore to queue"));
        Automation::AutomationProperties::SetName(undo, undoLabel.Text());
        undoMessage.Text(Text(L"已从队列粘贴", L"Pasted from queue"));
        retryFailed.Content(winrt::box_value(Text(L"重试", L"Retry")));
        removeFailed.Content(winrt::box_value(Text(L"删除", L"Delete")));
        Automation::AutomationProperties::SetName(removeFailed, Text(L"删除失败项", L"Delete failed item"));
        NameIconButton(closeButton, Text(L"退出并清空粘贴队列", L"Exit Paste Queue and clear items"));
        LocalizeConfirmation();
        const auto emptyTitle = emptyState.Children().GetAt(1).try_as<TextBlock>();
        const auto emptyDescription = emptyState.Children().GetAt(2).try_as<TextBlock>();
        if (emptyTitle) emptyTitle.Text(Text(L"队列为空", L"Queue is empty"));
        if (emptyDescription) {
            emptyDescription.Text(Text(L"复制新内容后，按 Ctrl + V 从队列粘贴。",
                                       L"Copy new content, then press Ctrl + V to paste from the queue."));
        }
        RenderItems();
    }

    void ApplyTheme() {
        if (!root) return;
        const bool dark = IsDark();
        if (confirmation) confirmation.RequestedTheme(dark ? ElementTheme::Dark : ElementTheme::Light);
        feedback.Severity(showError ? InfoBarSeverity::Error : InfoBarSeverity::Informational);
        feedback.Message(status.Text());
        feedback.IsOpen(!status.Text().empty());
        errorActions.Visibility(showError && !failedHash.empty() ? Visibility::Visible : Visibility::Collapsed);
        const bool recoverable = showError && !busy && !confirmingClear &&
            std::any_of(items.begin(), items.end(), [&](auto const &item) { return item.hash == failedHash; });
        retryFailed.IsEnabled(recoverable); removeFailed.IsEnabled(recoverable);
    }

    void SetLanguage(bool useEnglish) {
        FinishDrag();
        english = useEnglish;
        ApplyLanguage();
        ApplyTheme();
    }

    void SetError(const std::wstring &message) {
        FinishDrag();
        if (!orderBeforePointerDrop.empty()) items = std::exchange(orderBeforePointerDrop, {});
        failedHash.clear();
        busy = serverBusy || pendingRequest != 0;
        showError = true;
        status.Text(winrt::hstring{message});
        RenderItems();
    }

    void SetTheme(ElementTheme requestedTheme) {
        theme = requestedTheme;
        root.RequestedTheme(requestedTheme);
        ApplyTheme();
    }
};

QueueView::QueueView(RequestCallback request, CloseCallback close)
    : m_impl(std::make_shared<Impl>(std::move(request), std::move(close))) {
    m_impl->Build();
}

QueueView::~QueueView() = default;
QueueView::QueueView(QueueView &&) noexcept = default;
QueueView &QueueView::operator=(QueueView &&) noexcept = default;

FrameworkElement QueueView::Root() const {
    return m_impl ? m_impl->root : FrameworkElement{nullptr};
}

void QueueView::SetState(JsonObject const &state, bool preserveFeedback) {
    if (m_impl) m_impl->SetState(state, preserveFeedback);
}

bool QueueView::Receive(JsonObject const &response) {
    return m_impl && m_impl->Receive(response);
}

void QueueView::SetError(const std::wstring &message) {
    if (m_impl) m_impl->SetError(message);
}

void QueueView::SetLanguage(bool english) {
    if (m_impl) m_impl->SetLanguage(english);
}

void QueueView::SetTheme(ElementTheme theme) {
    if (m_impl) m_impl->SetTheme(theme);
}

void QueueView::AddItems(const std::vector<std::wstring> &hashes) {
    if (m_impl) m_impl->Send(L"queueAdd", {}, hashes);
}

void QueueView::CancelDrag() {
    if (m_impl) m_impl->FinishDrag();
}

void QueueView::Deactivate() {
    if (m_impl) m_impl->Deactivate();
}

void QueueView::Activate() {
    if (m_impl) m_impl->Activate();
}

#ifdef _DEBUG
bool QueueView::TestBeginReorder(const std::wstring &hash) {
    return m_impl && m_impl->BeginReorder(hash);
}
void QueueView::TestDropReorder(const std::wstring &target, bool after) {
    if (m_impl) m_impl->DropItem(target, after);
}
void QueueView::TestDragScroll(int direction) {
    if (m_impl) m_impl->dragScrollDirection = direction;
}
void QueueView::TestMoveByKeyboard(const std::wstring &hash, int direction) {
    if (m_impl) m_impl->MoveItem(hash, direction, true);
}
bool QueueView::TestStartPointerReorder(const std::wstring &hash, double y) {
    return m_impl && m_impl->StartPointerReorder(hash, y);
}
void QueueView::TestMovePointerReorder(double y) { if (m_impl) m_impl->MovePointerReorder(y); }
void QueueView::TestEndPointerReorder(bool commit) { if (m_impl) m_impl->EndPointerReorder(commit); }

winrt::Windows::Foundation::IAsyncAction TestQueuePointerReorderControls(FrameworkElement fixture, std::uint32_t &stage) {
    stage = 258;
    std::vector<JsonObject> requests;
    QueueView queue{[&](auto const &operation, auto const &, auto const &hashes) {
        JsonObject value; value.Insert(L"op", JsonValue::CreateStringValue(operation));
        JsonArray order; for (auto const &hash : hashes) order.Append(JsonValue::CreateStringValue(hash));
        value.Insert(L"hashes", order); requests.push_back(value);
        return static_cast<std::uint64_t>(requests.size());
    }, [] {}};
    const auto root = queue.Root().as<Grid>(); root.Width(360); root.Height(448);
    queue.m_impl->testAnimations = true;
    fixture.as<Border>().Child(root);
    auto state = JsonObject::Parse(LR"({"revision":1,"items":[{"hash":"a","previewText":"A long entry that must not push controls out of the queue viewport"},{"hash":"b","previewText":"Second"},{"hash":"c","previewText":"Third"}]})");
    queue.SetState(state); co_await NextNativeFrame();
    const auto list = root.Children().GetAt(1).as<ScrollViewer>();
    const auto rows = list.Content().as<StackPanel>();
    const auto row = rows.Children().GetAt(0).as<Border>().Child().as<Grid>();
    const auto paste = row.Children().GetAt(0).as<Button>();
    const auto handle = row.Children().GetAt(2).as<Button>();
    const auto remove = row.Children().GetAt(1).as<StackPanel>().Children().GetAt(0).as<Button>();
    const auto bounds = [&](FrameworkElement const &element) {
        return element.TransformToVisual(row).TransformBounds({0, 0,
            static_cast<float>(element.ActualWidth()), static_cast<float>(element.ActualHeight())});
    };
    const auto p = bounds(paste), h = bounds(handle), r = bounds(remove);
    std::fprintf(stderr, "WinUI queue geometry: row=%.1f paste=%.1f handle=%.1f remove=%.1f\n",
        row.ActualWidth(), paste.ActualWidth(), handle.ActualWidth(), remove.ActualWidth());
    std::fprintf(stderr, "WinUI queue bounds: paste=(%.1f %.1f) handle=(%.1f %.1f) remove=(%.1f %.1f) rowHeight=%.1f\n",
        p.X, p.Width, h.X, h.Width, r.X, r.Width, rows.Children().GetAt(0).as<Border>().ActualHeight());
    winrt::check_hresult(paste.ActualWidth() > 120 && h.X + h.Width <= p.X + 0.5 &&
        p.X + p.Width <= r.X + 0.5 && r.X + r.Width <= row.ActualWidth() + 0.5 &&
        rows.Children().GetAt(0).as<Border>().ActualHeight() <= 67 ? S_OK : E_FAIL);
    stage = 2581;
    const auto first = rows.Children().GetAt(0).as<Border>();
    const auto second = rows.Children().GetAt(1).as<Border>();
    const auto last = rows.Children().GetAt(2).as<Border>();
    const auto rowY = [&](Border const &surface) {
        return surface.TransformToVisual(rows).TransformPoint({0, 0}).Y;
    };
    const auto firstY = rowY(first), secondY = rowY(second);
    const auto typeLabel = [](Border const &surface) {
        return surface.Child().as<Grid>().Children().GetAt(0).as<Button>().Content().as<Grid>()
            .Children().GetAt(1).as<StackPanel>().Children().GetAt(1).as<TextBlock>().Text();
    };
    winrt::check_hresult(queue.TestStartPointerReorder(L"a", 33) && !queue.TestStartPointerReorder(L"b", 99) ? S_OK : E_FAIL);
    queue.TestMovePointerReorder(43);
    winrt::check_hresult(first.Translation().y == 10 && !first.TranslationTransition() &&
        second.Translation().y == 0 && typeLabel(first) == L"下一项" ? S_OK : E_FAIL);
    queue.TestMovePointerReorder(183);
    std::fprintf(stderr, "WinUI queue drag: source=%.1f neighbor=%.1f\n", first.Translation().y, second.Translation().y);
    winrt::check_hresult(first.Translation().y > 100 &&
        std::abs(second.Translation().y + secondY - firstY) < 0.5 &&
        std::abs(last.Translation().y - second.Translation().y) < 0.5 &&
        second.TranslationTransition() && !first.TranslationTransition() &&
        Canvas::GetZIndex(first) > Canvas::GetZIndex(second) &&
        rows.Children().GetAt(0) == first && typeLabel(second) == L"下一项" &&
        requests.size() == 1 ? S_OK : E_FAIL);
    queue.TestEndPointerReorder(true);
    stage = 2582;
    winrt::check_hresult(first.Translation().y == 0 && second.Translation().y == 0 && !second.TranslationTransition() &&
        Canvas::GetZIndex(first) == 0 && rows.Children().GetAt(2) == first && typeLabel(second) == L"下一项" && requests.size() == 3 &&
        requests[0].GetNamedString(L"op") == L"dragBegin" &&
        requests[1].GetNamedString(L"op") == L"dragEnd" && requests[2].GetNamedString(L"op") == L"queueReorder" &&
        requests[2].GetNamedArray(L"hashes").GetStringAt(2) == L"a" ? S_OK : E_FAIL);
    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(3));
    response.Insert(L"op", JsonValue::CreateStringValue(L"queueReorder"));
    response.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic reorder failure")); queue.Receive(response);
    stage = 2583;
    winrt::check_hresult(rows.Children().GetAt(0) == first && typeLabel(first) == L"下一项" ? S_OK : E_FAIL);
    // Wait for the restored layout, as a subsequent pointer press would.
    co_await NextNativeFrame(); root.UpdateLayout();
    queue.m_impl->testAnimations = false;
    stage = 25831;
    winrt::check_hresult(queue.TestStartPointerReorder(L"b", 99) ? S_OK : E_FAIL);
    queue.TestMovePointerReorder(-100);
    std::fprintf(stderr, "WinUI queue reduced motion: source=%.1f neighbor=%.1f transition=%d\n",
        second.Translation().y, first.Translation().y, static_cast<bool>(first.TranslationTransition()));
    winrt::check_hresult(second.Translation().y < 0 && first.Translation().y > 0 && !first.TranslationTransition() &&
        typeLabel(second) == L"下一项" ? S_OK : E_FAIL);
    queue.TestEndPointerReorder(false);
    stage = 25832;
    winrt::check_hresult(requests.size() == 5 && rows.Children().GetAt(1) == second &&
        std::abs(rowY(second) - secondY) < 0.5 && second.Opacity() == 1 &&
        !second.TranslationTransition() && second.Translation().y == 0 ? S_OK : E_FAIL);
    // Capture during drag is merged; a deleted source cannot be resurrected.
    winrt::check_hresult(queue.TestStartPointerReorder(L"a", 33) ? S_OK : E_FAIL);
    queue.TestMovePointerReorder(180);
    queue.SetState(JsonObject::Parse(LR"({"revision":2,"items":[{"hash":"b"},{"hash":"c"},{"hash":"new"}]})"));
    queue.TestEndPointerReorder(true);
    stage = 2584;
    winrt::check_hresult(requests.size() == 7 && rows.Children().Size() == 3 &&
        winrt::unbox_value<winrt::hstring>(rows.Children().GetAt(0).as<Border>().Tag()) == L"b" ? S_OK : E_FAIL);
    queue.SetState(JsonObject::Parse(LR"({"revision":3,"busy":true,"items":[{"hash":"b"}]})"));
    winrt::check_hresult(!queue.TestStartPointerReorder(L"b", 33) ? S_OK : E_FAIL);
    stage = 2585;
    JsonObject fullState; JsonArray fullItems;
    for (int index = 0; index < 100; ++index) {
        JsonObject item; item.Insert(L"hash", JsonValue::CreateStringValue(L"item-" + std::to_wstring(index)));
        item.Insert(L"itemType", JsonValue::CreateStringValue(L"Text"));
        item.Insert(L"previewText", JsonValue::CreateStringValue(L"Queue item " + std::to_wstring(index)));
        fullItems.Append(item);
    }
    fullState.Insert(L"revision", JsonValue::CreateNumberValue(4)); fullState.Insert(L"items", fullItems);
    queue.SetState(fullState); co_await NextNativeFrame(); root.UpdateLayout();
    winrt::check_hresult(rows.Children().Size() == 100 && queue.TestStartPointerReorder(L"item-0", 33) ? S_OK : E_FAIL);
    const auto start = std::chrono::steady_clock::now();
    for (int step = 1; step <= 120; ++step) queue.TestMovePointerReorder(33 + step * 56.0);
    const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::fprintf(stderr, "WinUI queue pointer benchmark: rows=100 moves=120 totalMs=%.2f meanMs=%.3f\n", elapsed, elapsed / 120);
    queue.TestEndPointerReorder(true);
    winrt::check_hresult(requests.back().GetNamedString(L"op") == L"queueReorder" &&
        requests.back().GetNamedArray(L"hashes").Size() == 100 &&
        requests.back().GetNamedArray(L"hashes").GetStringAt(99) == L"item-0" ? S_OK : E_FAIL);
    fixture.as<Border>().Child(nullptr);
}

winrt::Windows::Foundation::IAsyncAction TestQueueConsolidationControls(FrameworkElement fixture, std::uint32_t &stage) {
    std::vector<JsonObject> requests;
    QueueView queue{[&](auto const &operation, auto const &hash, auto const &hashes) {
        JsonObject value;
        value.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(requests.size() + 1)));
        value.Insert(L"op", JsonValue::CreateStringValue(operation));
        value.Insert(L"hash", JsonValue::CreateStringValue(hash));
        JsonArray order; for (auto const &item : hashes) order.Append(JsonValue::CreateStringValue(item));
        value.Insert(L"hashes", order); requests.push_back(value);
        return static_cast<std::uint64_t>(requests.size());
    }, [] {}};
    queue.SetLanguage(true);
    const auto root = queue.Root().as<Grid>(); fixture.as<Border>().Child(root);
    const auto rows = root.Children().GetAt(1).as<ScrollViewer>().Content().as<StackPanel>();
    const auto feedback = root.Children().GetAt(3).as<InfoBar>();
    const auto button = [&](std::uint32_t index) { return rows.Children().GetAt(index).as<Border>().Child().as<Grid>().Children().GetAt(0).as<Button>(); };
    const auto label = [&](std::uint32_t index) { return button(index).Content().as<Grid>().Children().GetAt(1).as<StackPanel>().Children().GetAt(0).as<TextBlock>().Text(); };
    const auto invoke = [](FrameworkElement element) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(element)
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    const auto reply = [&](std::size_t index, JsonObject data, winrt::hstring failure = L"") {
        JsonObject response; response.Insert(L"id", requests.at(index).GetNamedValue(L"id"));
        response.Insert(L"op", requests.at(index).GetNamedValue(L"op"));
        if (failure.empty()) response.Insert(L"data", data);
        else response.Insert(L"error", JsonValue::CreateStringValue(failure));
        return response;
    };
    stage = 79;
    auto state = JsonObject::Parse(LR"({"revision":100,"busy":false,"items":[{"hash":"a","previewText":"First"},{"hash":"b","previewText":"Second"}]})");
    queue.SetState(state); co_await NextNativeFrame();
    const auto listHeight = root.Children().GetAt(1).as<ScrollViewer>().ActualHeight();
    invoke(button(0)); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 1 && requests[0].GetNamedString(L"op") == L"queuePaste" && !button(0).IsEnabled() &&
        !feedback.IsOpen() && root.Children().GetAt(1).as<ScrollViewer>().ActualHeight() == listHeight ? S_OK : E_FAIL);
    state.Insert(L"revision", JsonValue::CreateNumberValue(101));
    state.GetNamedArray(L"items").Append(JsonObject::Parse(LR"({"hash":"new","previewText":"New capture"})"));
    queue.SetState(state); queue.AddItems({L"duplicate"});
    winrt::check_hresult(requests.size() == 1 && rows.Children().Size() == 3 && !button(0).IsEnabled() &&
        !feedback.IsOpen() ? S_OK : E_FAIL);
    auto wrong = reply(0, JsonObject{}, L"Wrong operation"); wrong.Insert(L"op", JsonValue::CreateStringValue(L"queueRemove"));
    winrt::check_hresult(!queue.Receive(wrong) && !button(0).IsEnabled() ? S_OK : E_FAIL);
    auto older = JsonObject::Parse(LR"({"revision":100,"busy":false,"items":[{"hash":"old","previewText":"Old state"}]})");
    winrt::check_hresult(queue.Receive(reply(0, older)) && button(0).IsEnabled() && label(0) == L"First" && rows.Children().Size() == 3 ? S_OK : E_FAIL);
    stage = 80;
    const auto menu = button(0).ContextFlyout().as<MenuFlyout>();
    invoke(menu.Items().GetAt(1)); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 2 && requests[1].GetNamedString(L"op") == L"queueReorder" &&
        requests[1].GetNamedArray(L"hashes").GetStringAt(0) == L"b" && label(0) == L"First" ? S_OK : E_FAIL);
    winrt::check_hresult(queue.Receive(reply(1, JsonObject{}, L"Synthetic reorder failure")) &&
        label(0) == L"First" && button(0).IsEnabled() && feedback.Message() == L"Synthetic reorder failure" ? S_OK : E_FAIL);
    winrt::check_hresult(!queue.Receive(reply(0, JsonObject{}, L"Stale error")) &&
        feedback.Message() == L"Synthetic reorder failure" ? S_OK : E_FAIL);
    stage = 81;
    state.Insert(L"revision", JsonValue::CreateNumberValue(102));
    state.Insert(L"undoExpiresAt", JsonValue::CreateNumberValue(static_cast<double>(
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() + 60'000)));
    state.Insert(L"undoHash", JsonValue::CreateStringValue(L"consumed")); queue.SetState(state);
    const auto undo = root.Children().GetAt(4).as<Border>().Child().as<StackPanel>().Children().GetAt(1).as<Button>();
    winrt::check_hresult(undo.Visibility() == Visibility::Visible && undo.IsEnabled() &&
        Automation::AutomationProperties::GetName(undo) == L"Restore to queue" ? S_OK : E_FAIL);
    invoke(undo); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 3 && requests[2].GetNamedString(L"op") == L"queueUndo" ? S_OK : E_FAIL);
    state.Insert(L"revision", JsonValue::CreateNumberValue(103)); state.Remove(L"undoHash");
    winrt::check_hresult(queue.Receive(reply(2, state)) && undo.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    stage = 83;
    queue.TestMoveByKeyboard(L"b", -1);
    winrt::check_hresult(requests.size() == 4 && requests[3].GetNamedString(L"op") == L"queueReorder" &&
        requests[3].GetNamedArray(L"hashes").GetStringAt(0) == L"b" && label(0) == L"First" ? S_OK : E_FAIL);
    auto moved = JsonObject::Parse(LR"({"revision":104,"busy":false,"items":[{"hash":"b","previewText":"Second"},{"hash":"a","previewText":"First"},{"hash":"new","previewText":"New capture"}]})");
    winrt::check_hresult(queue.Receive(reply(3, moved)) ? S_OK : E_FAIL);
    co_await NextNativeFrame();
    const auto handle = rows.Children().GetAt(0).as<Border>().Child().as<Grid>().Children().GetAt(2).try_as<Button>();
    winrt::check_hresult(handle && handle.IsTabStop() && !Automation::AutomationProperties::GetName(handle).empty() ? S_OK : E_FAIL);
    if (GetWindowThreadProcessId(GetForegroundWindow(), nullptr) == GetCurrentThreadId())
        winrt::check_hresult(Input::FocusManager::GetFocusedElement(root.XamlRoot()) == handle ? S_OK : E_FAIL);
    // A menu stays tied to its item even when an external capture reorders rows.
    const auto captured = button(0).ContextFlyout().as<MenuFlyout>().Items().GetAt(1);
    state.Insert(L"revision", JsonValue::CreateNumberValue(105)); queue.SetState(state);
    invoke(captured); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 5 && requests[4].GetNamedArray(L"hashes").GetStringAt(1) == L"new" &&
        requests[4].GetNamedArray(L"hashes").GetStringAt(2) == L"b" ? S_OK : E_FAIL);
    queue.Receive(reply(4, JsonObject{}, L"Synthetic stale order failure"));
    queue.SetState(JsonObject::Parse(LR"({"revision":106,"busy":false,"items":[{"hash":"a","previewText":"First"},{"hash":"new","previewText":"New capture"}]})"));
    invoke(captured); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 5 ? S_OK : E_FAIL);
    stage = 84;
    JsonArray many;
    for (int index = 0; index < 99; ++index) {
        JsonObject item; item.Insert(L"hash", JsonValue::CreateStringValue(L"scroll-" + std::to_wstring(index)));
        item.Insert(L"previewText", JsonValue::CreateStringValue(L"Synthetic queue entry")); many.Append(item);
    }
    JsonObject scrollState; scrollState.Insert(L"revision", JsonValue::CreateNumberValue(107)); scrollState.Insert(L"items", many);
    queue.SetState(scrollState); co_await NextNativeFrame(); root.UpdateLayout();
    const auto list = root.Children().GetAt(1).as<ScrollViewer>();
    winrt::handle ready{CreateEventW(nullptr, false, false, nullptr)}; winrt::check_bool(static_cast<bool>(ready));
    const winrt::apartment_context ui;
    // Observe the settled offset, not a particular ViewChanged edge: layout
    // and synchronous ChangeView can deliver that event before the await.
    const auto token = CompositionTarget::Rendering([signal = ready.get(), list](auto const &, auto const &) {
        if (std::abs(list.VerticalOffset() - 180) < 0.5) SetEvent(signal);
    });
    const auto acceptedScroll = list.ChangeView(nullptr, winrt::box_value(180.0).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, true);
    std::fprintf(stderr, "WinUI queue scroll request: accepted=%d loaded=%d height=%.1f viewport=%.1f max=%.1f offset=%.3f\n",
        acceptedScroll, list.IsLoaded(), root.ActualHeight(), list.ViewportHeight(), list.ScrollableHeight(), list.VerticalOffset());
    const bool scrolled = co_await winrt::resume_on_signal(ready.get(), std::chrono::seconds(5));
    co_await ui; CompositionTarget::Rendering(token);
    if (!scrolled) std::fprintf(stderr, "WinUI queue scroll timeout: viewport=%.1f max=%.1f offset=%.3f loaded=%d\n",
        list.ViewportHeight(), list.ScrollableHeight(), list.VerticalOffset(), list.IsLoaded());
    winrt::check_hresult(scrolled ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
    many.Append(JsonObject::Parse(LR"({"hash":"last-capture","previewText":"Last capture"})"));
    scrollState.Insert(L"revision", JsonValue::CreateNumberValue(108)); queue.SetState(scrollState);
    co_await NextNativeFrame();
    winrt::check_hresult(rows.Children().Size() == 100 && std::abs(list.VerticalOffset() - 180) < 0.5 ? S_OK : E_FAIL);
    fixture.as<Border>().Child(nullptr);
}

winrt::Windows::Foundation::IAsyncAction TestQueueFailureRecoveryControls(FrameworkElement fixture, std::uint32_t &stage) {
    stage = 260;
    std::vector<JsonObject> requests;
    QueueView queue{[&](auto const &op, auto const &hash, auto const &) {
        JsonObject value; value.Insert(L"op", JsonValue::CreateStringValue(op));
        value.Insert(L"hash", JsonValue::CreateStringValue(hash)); requests.push_back(value);
        return static_cast<std::uint64_t>(requests.size());
    }, [] {}};
    queue.SetLanguage(true);
    const auto root = queue.Root().as<Grid>(); fixture.as<Border>().Child(root);
    const auto feedback = root.Children().GetAt(3).as<InfoBar>();
    const auto actions = feedback.Content().as<StackPanel>();
    const auto retry = actions.Children().GetAt(0).as<Button>(), remove = actions.Children().GetAt(1).as<Button>();
    const auto invoke = [](FrameworkElement const &button) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(button)
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    auto failure = JsonObject::Parse(LR"({"revision":1,"items":[{"hash":"first"},{"hash":"failed"}],"error":{"hash":"failed","message":"Target rejected paste"}})");
    queue.SetState(failure); co_await NextNativeFrame();
    winrt::check_hresult(actions.Visibility() == Visibility::Visible && retry.IsEnabled() && remove.IsEnabled() &&
        winrt::unbox_value<winrt::hstring>(retry.Content()) == L"Retry" && feedback.Message() == L"Target rejected paste" ? S_OK : E_FAIL);
    invoke(retry); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 1 && requests[0].GetNamedString(L"op") == L"queuePaste" &&
        requests[0].GetNamedString(L"hash") == L"failed" && !retry.IsEnabled() && !remove.IsEnabled() ? S_OK : E_FAIL);
    // A fresh capture must not unlock a request still awaiting its reply.
    failure.Insert(L"revision", JsonValue::CreateNumberValue(2)); queue.SetState(failure);
    winrt::check_hresult(!retry.IsEnabled() && requests.size() == 1 ? S_OK : E_FAIL);
    JsonObject reply; reply.Insert(L"id", JsonValue::CreateNumberValue(1));
    reply.Insert(L"op", JsonValue::CreateStringValue(L"queuePaste")); reply.Insert(L"data", failure);
    winrt::check_hresult(queue.Receive(reply) && retry.IsEnabled() ? S_OK : E_FAIL);
    invoke(remove); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 2 && requests[1].GetNamedString(L"op") == L"queueRemove" &&
        requests[1].GetNamedString(L"hash") == L"failed" ? S_OK : E_FAIL);
    const auto recovered = JsonObject::Parse(LR"({"revision":3,"items":[{"hash":"first"}]})");
    reply.Insert(L"id", JsonValue::CreateNumberValue(2)); reply.Insert(L"op", JsonValue::CreateStringValue(L"queueRemove"));
    reply.Insert(L"data", recovered); queue.Receive(reply);
    winrt::check_hresult(actions.Visibility() == Visibility::Collapsed && !feedback.IsOpen() ? S_OK : E_FAIL);
    // A stale failure may still be explained, but cannot act on a deleted item.
    failure.Insert(L"revision", JsonValue::CreateNumberValue(4));
    failure.Insert(L"items", recovered.GetNamedArray(L"items")); queue.SetState(failure);
    winrt::check_hresult(!retry.IsEnabled() && !remove.IsEnabled() && requests.size() == 2 ? S_OK : E_FAIL);
    queue.SetState(JsonObject::Parse(LR"({"revision":5,"items":[],"error":{"hash":null,"message":"General queue error"}})"));
    winrt::check_hresult(actions.Visibility() == Visibility::Collapsed && feedback.IsOpen() ? S_OK : E_FAIL);
    stage = 2601;
    // General RPC errors must not inherit an unrelated failed paste target.
    failure.Insert(L"revision", JsonValue::CreateNumberValue(6));
    failure.Insert(L"items", JsonArray::Parse(LR"([{"hash":"first"},{"hash":"failed"}])")); queue.SetState(failure);
    const auto toolbar = root.Children().GetAt(0).as<Grid>().Children().GetAt(2).as<StackPanel>();
    invoke(toolbar.Children().GetAt(0).as<Button>());
    const auto reverse = requests.back();
    JsonObject generalError; generalError.Insert(L"id", JsonValue::CreateNumberValue(requests.size()));
    generalError.Insert(L"op", reverse.GetNamedValue(L"op"));
    generalError.Insert(L"error", JsonValue::CreateStringValue(L"Reverse failed"));
    winrt::check_hresult(queue.Receive(generalError) && feedback.Message() == L"Reverse failed" &&
        actions.Visibility() == Visibility::Collapsed && !retry.IsEnabled() && !remove.IsEnabled() ? S_OK : E_FAIL);
    const auto beforeStaleRecovery = requests.size();
    for (const auto &action : {retry, remove}) {
        bool disabled = false;
        try { invoke(action); }
        catch (winrt::hresult_error const &error) { disabled = error.code() == static_cast<HRESULT>(0x80040200); }
        winrt::check_hresult(disabled ? S_OK : E_FAIL); // UIA_E_ELEMENTNOTENABLED
    }
    winrt::check_hresult(requests.size() == beforeStaleRecovery ? S_OK : E_FAIL);
    fixture.as<Border>().Child(nullptr);
}

winrt::Windows::Foundation::IAsyncAction TestQueueRowContinuityControls(FrameworkElement fixture, std::uint32_t &stage) {
    stage = 261;
    QueueView queue{[](auto const &, auto const &, auto const &) { return std::uint64_t{1}; }, [] {}};
    const auto state = queue.m_impl;
    const auto root = queue.Root().as<Grid>(); root.Width(360); root.Height(448); fixture.as<Border>().Child(root);
    state->testAnimations = true;
    const auto refresh = [&](int revision, wchar_t const *items, bool busy = false) {
        JsonObject data; data.Insert(L"revision", JsonValue::CreateNumberValue(revision));
        data.Insert(L"items", JsonArray::Parse(items)); data.Insert(L"busy", JsonValue::CreateBooleanValue(busy)); queue.SetState(data);
    };
    refresh(1, LR"([{"hash":"a"},{"hash":"b"},{"hash":"c"}])"); co_await NextNativeFrame();
    const auto a = state->rowVisuals.at(L"a").surface, b = state->rowVisuals.at(L"b").surface;
    winrt::check_hresult(!a.Resources().HasKey(winrt::box_value(FeedbackAnimationResource)) ? S_OK : E_FAIL);
    refresh(2, LR"([{"hash":"a"},{"hash":"b"},{"hash":"c"}])", true);
    winrt::check_hresult(state->rowVisuals.at(L"a").surface == a && !state->rowVisuals.at(L"a").paste.IsEnabled() ? S_OK : E_FAIL);
    refresh(3, LR"([{"hash":"b"},{"hash":"a"},{"hash":"new"}])");
    co_await NextNativeFrame();
    winrt::check_hresult(state->rows.Children().GetAt(0) == b && state->rows.Children().GetAt(1) == a &&
        state->exitingRows.Children().Size() == 1 && state->exitExpiry.IsRunning() &&
        state->rowVisuals.at(L"new").surface.Resources().HasKey(winrt::box_value(FeedbackAnimationResource)) ? S_OK : E_FAIL);
    refresh(3, LR"([{"hash":"b"},{"hash":"a"},{"hash":"new"}])");
    winrt::check_hresult(state->exitingRows.Children().Size() == 1 && state->exitExpiry.IsRunning() ? S_OK : E_FAIL);
    // Wait for the actual dispatcher completion, including release of old rows.
    for (int frame = 0; frame < 90 && state->exitingRows.Children().Size(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(state->exitingRows.Children().Size() == 0 && !state->exitExpiry.IsRunning() ? S_OK : E_FAIL);
    state->testAnimations = false;
    refresh(4, LR"([{"hash":"a"},{"hash":"reduced"}])"); co_await NextNativeFrame();
    winrt::check_hresult(state->rowVisuals.at(L"a").surface == a && state->exitingRows.Children().Size() == 0 &&
        !state->rowVisuals.at(L"reduced").surface.Resources().HasKey(winrt::box_value(FeedbackAnimationResource)) &&
        state->rowVisuals.at(L"reduced").surface.Opacity() == 1 ? S_OK : E_FAIL);
    stage = 262;
    JsonObject full; JsonArray items;
    for (int i = 0; i < 100; ++i) {
        JsonObject item; item.Insert(L"hash", JsonValue::CreateStringValue(L"bench-" + std::to_wstring(i)));
        item.Insert(L"previewText", JsonValue::CreateStringValue(L"Queue continuity benchmark")); items.Append(item);
    }
    full.Insert(L"items", items);
    int revision = 10;
    double rebuildMs = 0, retainedMs = 0;
    // The same builder runs both modes: the Debug-only baseline deliberately
    // clears all rows as the pre-change renderer did. Include loaded layout.
    for (const bool rebuild : {true, false}) {
        state->testRebuildRows = rebuild;
        full.Insert(L"revision", JsonValue::CreateNumberValue(++revision)); queue.SetState(full);
        co_await NextNativeFrame(); root.UpdateLayout();
        double elapsed = 0;
        for (int iteration = 0; iteration < 6; ++iteration) {
            full.Insert(L"revision", JsonValue::CreateNumberValue(++revision));
            const auto start = std::chrono::steady_clock::now(); queue.SetState(full); root.UpdateLayout();
            elapsed += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        }
        if (rebuild) rebuildMs = elapsed / 6; else retainedMs = elapsed / 6;
    }
    std::fprintf(stderr, "WinUI queue continuity benchmark: rows=100 rebuildMeanMs=%.3f retainedMeanMs=%.3f ratio=%.3f\n", rebuildMs, retainedMs, retainedMs / rebuildMs);
    winrt::check_hresult(state->rows.Children().Size() == 100 && retainedMs <= rebuildMs * 1.10 ? S_OK : E_FAIL);
    const auto retained = state->rowVisuals.at(L"bench-50").surface;
    items.RemoveAt(0); items.Append(JsonObject::Parse(LR"({"hash":"capture","previewText":"Concurrent capture"})"));
    full.Insert(L"revision", JsonValue::CreateNumberValue(++revision)); queue.SetState(full); co_await NextNativeFrame();
    winrt::check_hresult(state->rows.Children().Size() == 100 && state->rowVisuals.at(L"bench-50").surface == retained ? S_OK : E_FAIL);
    queue.Deactivate();
    winrt::check_hresult(state->exitingRows.Children().Size() == 0 && !state->exitExpiry.IsRunning() ? S_OK : E_FAIL);
    fixture.as<Border>().Child(nullptr);
}

winrt::Windows::Foundation::IAsyncAction TestQueueUndoExpiryControls(FrameworkElement fixture, std::uint32_t &stage) {
    std::size_t sent = 0;
    QueueView queue{[&](auto const &, auto const &, auto const &) { return ++sent; }, [] {}};
    const auto root = queue.Root().as<Grid>(); fixture.as<Border>().Child(root);
    const auto undo = root.Children().GetAt(4).as<Border>().Child().as<StackPanel>().Children().GetAt(1).as<Button>();
    auto state = JsonObject::Parse(LR"({"revision":1,"items":[],"undoHash":"consumed","undoExpiresAt":1})");
    stage = 107;
    queue.SetState(state); co_await NextNativeFrame();
    winrt::check_hresult(undo.Visibility() == Visibility::Collapsed && !undo.IsEnabled() && sent == 0 ? S_OK : E_FAIL);
    state.Insert(L"revision", JsonValue::CreateNumberValue(2)); state.Remove(L"undoExpiresAt");
    queue.SetState(state);
    winrt::check_hresult(undo.Visibility() == Visibility::Collapsed && !undo.IsEnabled() ? S_OK : E_FAIL);
    state.Insert(L"revision", JsonValue::CreateNumberValue(3)); state.Insert(L"undoExpiresAt", JsonValue::CreateNullValue());
    queue.SetState(state);
    winrt::check_hresult(undo.Visibility() == Visibility::Collapsed && !undo.IsEnabled() ? S_OK : E_FAIL);
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    state.Insert(L"revision", JsonValue::CreateNumberValue(4));
    state.Insert(L"undoExpiresAt", JsonValue::CreateNumberValue(static_cast<double>(now + 200)));
    state.Insert(L"items", JsonArray::Parse(LR"([{"hash":"a","previewText":"Keep this row"}])"));
    winrt::handle expired{CreateEventW(nullptr, false, false, nullptr)}; winrt::check_bool(static_cast<bool>(expired));
    const auto token = undo.RegisterPropertyChangedCallback(UIElement::VisibilityProperty(), [signal = expired.get()](auto const &sender, auto const &) {
        if (sender.template as<Button>().Visibility() == Visibility::Collapsed) SetEvent(signal);
    });
    queue.SetState(state);
    const auto rows = root.Children().GetAt(1).as<ScrollViewer>().Content().as<StackPanel>();
    const auto original = rows.Children().GetAt(0);
    winrt::check_hresult(undo.IsEnabled() && undo.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
    const winrt::apartment_context ui;
    const bool completed = co_await winrt::resume_on_signal(expired.get(), std::chrono::seconds(3));
    co_await ui;
    undo.UnregisterPropertyChangedCallback(UIElement::VisibilityProperty(), token);
    winrt::check_hresult(completed && !undo.IsEnabled() && rows.Children().GetAt(0) == original && sent == 0 ? S_OK : E_FAIL);
    // Closing a still-loaded HWND suspends its timer. Reopening rechecks the
    // authoritative deadline, even if it expired while the view was hidden.
    state.Insert(L"revision", JsonValue::CreateNumberValue(5));
    state.Insert(L"undoExpiresAt", JsonValue::CreateNumberValue(static_cast<double>(now + 60'000)));
    queue.SetState(state); queue.Deactivate();
    state.Insert(L"undoExpiresAt", JsonValue::CreateNumberValue(1));
    queue.Activate();
    winrt::check_hresult(!undo.IsEnabled() && undo.Visibility() == Visibility::Collapsed && sent == 0 ? S_OK : E_FAIL);
    fixture.as<Border>().Child(nullptr);
}

winrt::Windows::Foundation::IAsyncAction TestQueueFocusContinuityControls(FrameworkElement fixture, std::uint32_t &stage) {
    QueueView queue{[](auto const &, auto const &, auto const &) { return std::uint64_t{1}; }, [] {}};
    const auto root = queue.Root().as<Grid>(); fixture.as<Border>().Child(root);
    const auto rows = root.Children().GetAt(1).as<ScrollViewer>().Content().as<StackPanel>();
    const auto control = [&](std::uint32_t index, std::uint32_t action) {
        const auto row = rows.Children().GetAt(index).as<Border>().Child().as<Grid>();
        return action == 0 ? row.Children().GetAt(2).as<Button>()
            : row.Children().GetAt(1).as<StackPanel>().Children().GetAt(0).as<Button>();
    };
    const auto refresh = [&](std::uint64_t revision, const wchar_t *items) {
        JsonObject state; state.Insert(L"revision", JsonValue::CreateNumberValue(static_cast<double>(revision)));
        state.Insert(L"items", JsonArray::Parse(items)); queue.SetState(state);
    };
    stage = 109;
    refresh(1, LR"([{"hash":"a"},{"hash":"b"},{"hash":"c"}])"); co_await NextNativeFrame();
    const auto owner = winrt::Microsoft::UI::GetWindowFromWindowId(root.XamlRoot().ContentIslandEnvironment().AppWindowId());
    if (GetAncestor(owner, GA_ROOT) == GetForegroundWindow()) {
        winrt::check_hresult(control(1, 1).Focus(FocusState::Keyboard) ? S_OK : E_FAIL);
        refresh(2, LR"([{"hash":"capture"},{"hash":"a"},{"hash":"b"},{"hash":"c"}])"); co_await NextNativeFrame();
        winrt::check_hresult(Input::FocusManager::GetFocusedElement(root.XamlRoot()) == control(2, 1) ? S_OK : E_FAIL);
        queue.SetLanguage(true); co_await NextNativeFrame();
        winrt::check_hresult(Input::FocusManager::GetFocusedElement(root.XamlRoot()) == control(2, 1) ? S_OK : E_FAIL);
        refresh(3, LR"([{"hash":"capture"},{"hash":"a"},{"hash":"c"}])"); co_await NextNativeFrame();
        winrt::check_hresult(Input::FocusManager::GetFocusedElement(root.XamlRoot()) == control(2, 1) ? S_OK : E_FAIL);
        queue.Deactivate();
        // A hidden view's refresh must not restore focus to a newly built row.
        refresh(4, LR"([{"hash":"capture"},{"hash":"c"}])"); co_await NextNativeFrame();
        const auto focused = Input::FocusManager::GetFocusedElement(root.XamlRoot());
        winrt::check_hresult(focused != control(1, 1) ? S_OK : E_FAIL);
        queue.Activate();
        TextBox newerChoice; root.Children().Append(newerChoice);
        co_await NextNativeFrame();
        winrt::check_hresult(control(0, 0).Focus(FocusState::Keyboard) ? S_OK : E_FAIL);
        refresh(5, LR"([{"hash":"capture"},{"hash":"c"}])");
        winrt::check_hresult(newerChoice.Focus(FocusState::Keyboard) ? S_OK : E_FAIL);
        // A newer user choice must win over the old row's Loaded callback.
        co_await NextNativeFrame();
        winrt::check_hresult(Input::FocusManager::GetFocusedElement(root.XamlRoot()) == newerChoice ? S_OK : E_FAIL);
    } else {
        std::fprintf(stderr, "WinUI queue focus continuity: foreground-dependent assertions skipped\n");
        const auto retained = control(1, 1);
        retained.Focus(FocusState::Keyboard);
        refresh(2, LR"([{"hash":"capture"},{"hash":"a"},{"hash":"b"},{"hash":"c"}])"); co_await NextNativeFrame();
        // XAML may keep its logical focus on the retained control while the
        // window stays inactive. Check identity and HWND activation separately.
        winrt::check_hresult(control(2, 1) == retained &&
            GetAncestor(owner, GA_ROOT) != GetForegroundWindow() ? S_OK : E_FAIL);
    }
    fixture.as<Border>().Child(nullptr);
}

winrt::Windows::Foundation::IAsyncAction TestBatch2QueueControls(
    FrameworkElement fixture, std::vector<std::string> &failures) {
    std::vector<JsonObject> requests;
    QueueView queue{[&](auto const &operation, auto const &, auto const &hashes) {
        JsonObject value; value.Insert(L"op", JsonValue::CreateStringValue(operation));
        JsonArray order; for (auto const &hash : hashes) order.Append(JsonValue::CreateStringValue(hash));
        value.Insert(L"hashes", order); requests.push_back(value);
        return static_cast<std::uint64_t>(requests.size());
    }, [] {}};
    const auto root = queue.Root().as<Grid>(); root.Width(360); root.Height(448);
    fixture.as<Border>().Child(root);
    auto state = JsonObject::Parse(LR"({"revision":1,"items":[{"hash":"a","previewText":"First"},{"hash":"b","previewText":"Second"},{"hash":"c","previewText":"Third"}]})");
    queue.SetState(state); co_await NextNativeFrame(); root.UpdateLayout();

    // 点击清空按钮应呈现内联确认操作而不是在 WS_EX_NOACTIVATE 窗体上弹 ContentDialog。
    const auto invoke = [](FrameworkElement const &element) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(element)
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    std::function<Button(DependencyObject const &, winrt::hstring const &)> findButton =
        [&](DependencyObject const &parent, winrt::hstring const &id) -> Button {
            if (!parent) return nullptr;
            if (const auto btn = parent.try_as<Button>(); btn && Automation::AutomationProperties::GetAutomationId(btn) == id)
                return btn;
            const auto count = Media::VisualTreeHelper::GetChildrenCount(parent);
            for (int i = 0; i < count; ++i) {
                if (const auto found = findButton(Media::VisualTreeHelper::GetChild(parent, i), id)) return found;
            }
            return nullptr;
        };
    for (int f = 0; f < 10 && !queue.m_impl->clear.IsLoaded(); ++f) co_await NextNativeFrame();
    const auto beforeClearReq = requests.size();
    invoke(queue.m_impl->clear);
    co_await NextNativeFrame(); root.UpdateLayout();
    if (queue.m_impl->confirmation) {
        failures.push_back("queue_clear_uses_content_dialog");
        queue.m_impl->confirmation.Hide();
        for (int f = 0; f < 30 && queue.m_impl->confirmation; ++f) co_await NextNativeFrame();
    } else {
        const auto confirmBtn = findButton(root, L"queue-clear-confirm");
        if (confirmBtn) {
            for (int f = 0; f < 10 && !confirmBtn.IsLoaded(); ++f) co_await NextNativeFrame();
        }
        if (!confirmBtn || !confirmBtn.IsLoaded() || confirmBtn.Visibility() != Visibility::Visible) {
            failures.push_back("queue_clear_missing_inline_confirm");
        } else {
            invoke(confirmBtn);
            co_await NextNativeFrame();
            if (requests.size() <= beforeClearReq || requests.back().GetNamedString(L"op") != L"queueClear") {
                failures.push_back("queue_clear_inline_confirm_did_not_submit");
            }
        }
    }
    fixture.as<Border>().Child(nullptr);
}
#endif

} // namespace vpaste::winui
