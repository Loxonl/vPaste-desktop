#include <windows.h>
#undef GetCurrentTime
#include "WinUiQueueView.h"
#include "WinUiAppearance.h"
#include "WinUiRichContent.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <chrono>
#include <cmath>
#include <utility>
#include <optional>

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
    Grid header{nullptr};
    CommandBar toolbar{nullptr};
    StackPanel rows{nullptr};
    ScrollViewer list{nullptr};
    StackPanel emptyState{nullptr};
    TextBlock title{nullptr};
    TextBlock count{nullptr};
    TextBlock status{nullptr};
    TextBlock guidance{nullptr};
    InfoBar feedback{nullptr};
    AppBarButton reverse{nullptr};
    AppBarButton clear{nullptr};
    AppBarButton undo{nullptr};
    Border undoToast{nullptr};
    TextBlock undoMessage{nullptr};
    Button closeButton{nullptr};
    ContentDialog confirmation{nullptr};
    MenuFlyout openItemMenu{nullptr};
    JsonObject state{nullptr};
    std::vector<QueueItem> items;
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
    bool suppressDragPaste = false;
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer dragScroll{nullptr};
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer undoExpiry{nullptr};
    int dragScrollDirection = 0;
    UIElement pointerOwner{nullptr};
    std::uint32_t pointerId = 0;
    double pointerStartY = 0, pointerY = 0, pointerStartScroll = 0;
    std::vector<QueueRowMetric> dragMetrics;
    std::vector<std::wstring> dragOrder;
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
                    self->EndPointerReorder(true); args.Handled(true);
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
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnSpacing(8);
        header.MinHeight(54);
        header.Margin(Thickness{0, 0, 0, 8});
        header.RowDefinitions().Append(RowDefinition{});
        header.RowDefinitions().Append(RowDefinition{});
        header.RowDefinitions().GetAt(0).Height(GridLength{1, GridUnitType::Auto});
        header.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Auto});
        header.ColumnDefinitions().GetAt(0).Width(GridLength{72, GridUnitType::Pixel});
        header.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Star});
        header.ColumnDefinitions().GetAt(2).Width(GridLength{72, GridUnitType::Pixel});

        StackPanel heading;
        heading.Orientation(Orientation::Vertical);
        heading.Spacing(0);
        heading.HorizontalAlignment(HorizontalAlignment::Center);
        heading.VerticalAlignment(VerticalAlignment::Center);
        title = MakeText(Text(L"粘贴队列", L"Paste queue"), 14, true);
        title.HorizontalAlignment(HorizontalAlignment::Center);
        ApplyStyle(title, L"VPaste.CompactTitle");
        count = MakeText(L"0 / 100", 12);
        count.FontSize(10.5); count.HorizontalAlignment(HorizontalAlignment::Center);
        heading.Children().Append(title);
        heading.Children().Append(count);
        Grid::SetColumn(heading, 1);
        header.Children().Append(heading);

        toolbar = CommandBar{};
        toolbar.DefaultLabelPosition(CommandBarDefaultLabelPosition::Collapsed);
        toolbar.IsDynamicOverflowEnabled(false);
        toolbar.HorizontalAlignment(HorizontalAlignment::Right);
        toolbar.Background(SolidColorBrush{Color{0, 0, 0, 0}});
        reverse = AppBarButton{};
        reverse.Label(Text(L"反转", L"Reverse"));
        reverse.Icon(SymbolIcon{Symbol::Switch});
        reverse.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->Send(L"queueReverse");
        });
        toolbar.PrimaryCommands().Append(reverse);

        clear = AppBarButton{};
        clear.Label(Text(L"清空", L"Clear"));
        clear.Icon(SymbolIcon{Symbol::Delete});
        clear.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ConfirmClear();
        });
        toolbar.SecondaryCommands().Append(clear);

        undo = AppBarButton{};
        undo.Label(Text(L"撤销", L"Undo"));
        undo.Icon(SymbolIcon{Symbol::Undo});
        undo.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                self->UpdateUndo();
                if (self->undo.IsEnabled()) self->Send(L"queueUndo");
            }
        });
        StackPanel undoContent;
        undoContent.Orientation(Orientation::Horizontal); undoContent.Spacing(8);
        undoMessage = MakeText(Text(L"已粘贴", L"Pasted"), 12);
        undoContent.Children().Append(undoMessage); undoContent.Children().Append(undo);
        undoToast = Border(); ApplyStyle(undoToast, L"VPaste.SelectionBar");
        undoToast.Child(undoContent); undoToast.HorizontalAlignment(HorizontalAlignment::Center);
        undoToast.VerticalAlignment(VerticalAlignment::Bottom); undoToast.Margin(Thickness{8, 0, 8, 8});
        undoToast.Visibility(Visibility::Collapsed);
        for (const auto &button : {reverse, undo}) {
            button.Width(32); button.Height(32); button.MinWidth(0); button.MinHeight(0);
        }

        closeButton = NamedIconButton(SymbolIcon{Symbol::Cancel}, Text(L"关闭粘贴队列", L"Close paste queue"));
        closeButton.HorizontalAlignment(HorizontalAlignment::Left);
        closeButton.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                if (self->close) self->close();
            }
        });
        header.Children().Append(closeButton);
        Grid::SetColumn(toolbar, 2);
        header.Children().Append(toolbar);
        guidance = MakeText(Text(L"按顺序整理，逐项粘贴。关闭队列会清空这份临时列表。",
            L"Arrange items, then paste in order. Closing clears this temporary queue."), 12);
        guidance.Margin(Thickness{0, 8, 0, 0});
        guidance.Visibility(Visibility::Collapsed);
        Grid::SetRow(guidance, 1);
        Grid::SetColumn(guidance, 1);
        Grid::SetColumnSpan(guidance, 2);
        header.Children().Append(guidance);
        Grid::SetRow(header, 0);
        root.Children().Append(header);

        list = ScrollViewer{};
        list.VerticalScrollMode(ScrollMode::Enabled);
        list.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        list.HorizontalScrollMode(ScrollMode::Disabled);
        list.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);

        rows = StackPanel{};
        rows.Spacing(0);
        rows.Margin(Thickness{0, 4, 0, 4});
        list.Content(rows);
        dragScroll = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread().CreateTimer();
        dragScroll.Interval(std::chrono::milliseconds(50)); // Drag edge scrolling, not a layout animation.
        dragScroll.IsRepeating(true);
        dragScroll.Tick([weak](auto const &, auto const &) {
            if (const auto self = weak.lock(); self && !self->draggingHash.empty() && self->dragScrollDirection != 0) {
                self->list.ChangeView(nullptr, winrt::box_value(std::clamp(self->list.VerticalOffset() +
                    self->dragScrollDirection * 18.0, 0.0, self->list.ScrollableHeight())).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, true);
                if (!self->dragMetrics.empty()) self->MovePointerReorder(self->pointerY);
            }
        });

        emptyState = EmptyState(L"\uE8FD", Text(L"队列为空", L"Queue is empty"),
            Text(L"从剪贴板历史中选择内容加入队列", L"Select items from clipboard history to add them"));
        Grid::SetRow(emptyState, 1);
        Grid::SetRow(list, 1);
        root.Children().Append(list);
        root.Children().Append(emptyState);

        status = MakeText(L"", 12);
        feedback = InfoBar{};
        feedback.IsOpen(false);
        feedback.IsClosable(false);
        feedback.Margin(Thickness{0, 12, 0, 0});
        Grid::SetRow(feedback, 2);
        root.Children().Append(feedback);
        Grid::SetRow(undoToast, 1); root.Children().Append(undoToast);
        ApplyLanguage();
        ApplyTheme();
    }

    void LocalizeConfirmation() {
        if (!confirmation) return;
        confirmation.Title(winrt::box_value(Text(L"清空粘贴队列？", L"Clear paste queue?")));
        confirmation.Content(winrt::box_value(Text(L"仅清空队列，不会删除剪贴板历史。",
            L"This clears the queue, not your clipboard history.")));
        confirmation.PrimaryButtonText(Text(L"清空", L"Clear"));
        confirmation.CloseButtonText(Text(L"取消", L"Cancel"));
    }

    winrt::fire_and_forget ConfirmClear() {
        const auto lifetime = shared_from_this();
        if (busy || confirmingClear || items.empty() || !root.IsLoaded()) co_return;
        confirmingClear = true;
        const auto generation = ++confirmationGeneration;
        RenderItems();
        try {
            confirmation = MakeConfirmationDialog(root, L"", L"", L"", L"");
            LocalizeConfirmation();
            const auto result = co_await confirmation.ShowAsync();
            if (generation != confirmationGeneration) co_return;
            confirmation = nullptr;
            confirmingClear = false;
            if (!root.IsLoaded()) co_return;
            RenderItems();
            if (result == ContentDialogResult::Primary && !busy && !items.empty()) Send(L"queueClear");
            else if (result != ContentDialogResult::Primary && clear.IsEnabled()) clear.Focus(FocusState::Programmatic);
        } catch (const winrt::hresult_error &error) {
            if (generation != confirmationGeneration) co_return;
            confirmation = nullptr;
            confirmingClear = false;
            if (root.IsLoaded()) SetError(std::wstring{error.message()});
        }
    }

    void Activate() {
        suspended = false;
        UpdateUndo();
    }

    void Deactivate() {
        suspended = true;
        rowFocus.reset(); ++renderGeneration;
        undoExpiry.Stop();
        ++confirmationGeneration;
        const auto dialog = std::exchange(confirmation, nullptr);
        confirmingClear = false;
        if (dialog) dialog.Hide();
        toolbar.IsOpen(false);
        if (const auto menu = std::exchange(openItemMenu, nullptr)) menu.Hide();
        reorderFocusHash.clear();
        FinishDrag();
        RenderItems();
    }

    void Send(const wchar_t *operation, const std::wstring &hash = {},
              const std::vector<std::wstring> &hashes = {}) {
        if (!request || busy || !draggingHash.empty()) return;
        showError = false;
        status.Text(Text(L"正在处理…", L"Working…"));
        busy = true;
        pendingOperation = operation;
        pendingRequest = request(operation, hash, hashes);
        if (!pendingRequest) {
            busy = serverBusy;
            SetError(std::wstring{Text(L"操作未能发送，请重试", L"Could not send this action; try again")});
            return;
        }
        RenderItems();
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
        undo.Visibility(live ? Visibility::Visible : Visibility::Collapsed);
        undoToast.Visibility(live ? Visibility::Visible : Visibility::Collapsed);
        undo.IsEnabled(live && !busy && !confirmingClear);
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
        const bool wasDragging = !draggingHash.empty();
        draggingHash.clear();
        dragMetrics.clear(); dragOrder.clear();
        const auto latest = std::exchange(pendingDragState, nullptr);
        pointerId = 0;
        if (auto owner = std::exchange(pointerOwner, nullptr)) owner.ReleasePointerCaptures();
        if (wasDragging && request) request(L"dragEnd", {}, {});
        for (const auto &child : rows.Children()) {
            const auto surface = child.as<Border>();
            surface.Opacity(1);
            surface.RenderTransform(nullptr);
            Canvas::SetZIndex(surface, 0);
        }
        if (latest) SetState(latest);
    }

    bool BeginReorder(const std::wstring &hash) {
        if (busy || confirmingClear || !draggingHash.empty() ||
            std::none_of(items.begin(), items.end(), [&](const auto &item) { return item.hash == hash; })) return false;
        draggingHash = hash;
        suppressDragPaste = true;
        dragScroll.Start();
        if (request) request(L"dragBegin", {}, {});
        return true;
    }

    bool StartPointerReorder(const std::wstring &hash, double y) {
        if (!root.IsLoaded() || !BeginReorder(hash)) return false;
        pointerStartY = pointerY = y; pointerStartScroll = list.VerticalOffset();
        dragMetrics.clear(); dragOrder = OrderedHashes();
        for (const auto &child : rows.Children()) {
            const auto surface = child.as<Border>();
            const auto point = surface.TransformToVisual(rows).TransformPoint({0, 0});
            dragMetrics.push_back({point.Y, surface.ActualHeight()});
        }
        MovePointerReorder(y);
        return true;
    }

    void MovePointerReorder(double y) {
        if (draggingHash.empty() || dragMetrics.size() != items.size()) return;
        pointerY = y;
        const auto original = OrderedHashes();
        const auto from = static_cast<std::size_t>(std::find(original.begin(), original.end(), draggingHash) - original.begin());
        const auto &source = dragMetrics[from];
        const auto offset = std::clamp(y - pointerStartY + list.VerticalOffset() - pointerStartScroll,
            dragMetrics.front().top - source.top,
            dragMetrics.back().top + dragMetrics.back().height - source.top - source.height);
        dragOrder = QueuePointerOrder(original, dragMetrics, draggingHash, offset);
        double top = dragMetrics.front().top;
        for (const auto &hash : dragOrder) {
            const auto index = static_cast<std::size_t>(std::find(original.begin(), original.end(), hash) - original.begin());
            const auto surface = rows.Children().GetAt(static_cast<std::uint32_t>(index)).as<Border>();
            auto transform = surface.RenderTransform().try_as<TranslateTransform>();
            if (!transform) transform = TranslateTransform();
            transform.Y(hash == draggingHash ? offset : top - dragMetrics[index].top);
            surface.RenderTransform(transform);
            surface.Opacity(hash == draggingHash ? DragSourceOpacity : 1);
            Canvas::SetZIndex(surface, hash == draggingHash ? 1 : 0);
            top += dragMetrics[index].height;
        }
        dragScrollDirection = y < 24 ? -1 : y > list.ActualHeight() - 24 ? 1 : 0;
    }

    void EndPointerReorder(bool commit) {
        if (!commit || dragOrder == OrderedHashes() || dragOrder.empty()) { FinishDrag(); return; }
        const auto found = std::find(dragOrder.begin(), dragOrder.end(), draggingHash);
        if (found == dragOrder.end()) { FinishDrag(); return; }
        const bool after = found + 1 == dragOrder.end();
        const auto target = after ? *(found - 1) : *(found + 1);
        DropItem(target, after);
    }

    void DropItem(const std::wstring &target, bool after) {
        const auto source = draggingHash;
        FinishDrag(); // Merge newer captures/deletions before constructing the order.
        if (busy || confirmingClear || source.empty()) return;
        const auto current = OrderedHashes();
        const auto order = QueueDropOrder(current, source, target, after);
        if (order != current) Send(L"queueReorder", {}, order);
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

    void RenderItems() {
        CaptureRowFocus();
        if (!reorderFocusHash.empty()) rowFocus = RowFocus{reorderFocusHash, 0, L"queue-handle", FocusState::Keyboard};
        ++renderGeneration;
        rows.Children().Clear();
        for (std::size_t index = 0; index < items.size(); ++index) {
            const auto item = items[index];
            Grid row;
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
            paste.ContextFlyout(rowMenu);

            Button remove = NamedIconButton(SymbolIcon{Symbol::Remove}, Text(L"移出队列", L"Remove from queue"));
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
            position.Children().Append(Glyph(L"\uE784"));
            Button handle; ApplyStyle(handle, L"VPaste.IconButton");
            NameIconButton(handle, Text(L"调整顺序：", L"Reorder: ") + preview.Text());
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
            ApplyStyle(container, L"VPaste.Surface");
            container.CornerRadius(UniformRadius(0));
            container.BorderThickness(Thickness{0, 0, 0, 1});
            container.Background(SolidColorBrush{Color{0, 0, 0, 0}});
            container.Padding(Thickness{0}); container.MinHeight(66);
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
            rows.Children().Append(container);
        }
        list.Visibility(items.empty() ? Visibility::Collapsed : Visibility::Visible);
        emptyState.Visibility(items.empty() ? Visibility::Visible : Visibility::Collapsed);
        const auto capacity = state
                                  ? static_cast<std::size_t>(state.GetNamedNumber(L"capacity", 100))
                                  : std::size_t{100};
        count.Text(winrt::hstring{std::to_wstring(items.size()) + L" / " +
                                   std::to_wstring(capacity)});
        reverse.IsEnabled(!busy && items.size() > 1);
        clear.IsEnabled(!busy && !items.empty() && !confirmingClear);
        if (confirmation) confirmation.IsPrimaryButtonEnabled(!busy && !items.empty());
        UpdateUndo();
        if (!reorderFocusHash.empty() && std::none_of(items.begin(), items.end(), [&](auto const &item) { return item.hash == reorderFocusHash; }))
            reorderFocusHash.clear();
        ApplyTheme();
        RestoreRowFocus();
    }

    bool SetState(JsonObject const &nextState) {
        if (!draggingHash.empty()) {
            if (!pendingDragState || nextState.GetNamedNumber(L"revision", 0) >= pendingDragState.GetNamedNumber(L"revision", 0)) {
                pendingDragState = nextState;
            }
            return false;
        }
        const auto nextRevision = static_cast<std::uint64_t>(
            nextState.GetNamedNumber(L"revision", 0));
        if (hasRevision && nextRevision < lastRevision) return false;
        lastRevision = nextRevision;
        hasRevision = true;

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

        winrt::hstring error;
        if (state.HasKey(L"error") && state.GetNamedValue(L"error").ValueType() == JsonValueType::Object) {
            error = state.GetNamedObject(L"error").GetNamedString(L"message", L"");
        }
        showError = !error.empty();
        if (showError) {
            status.Text(error);
        } else {
            status.Text(busy ? Text(L"正在处理…", L"Working…") : winrt::hstring{});
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
            status.Text(serverBusy ? Text(L"正在处理…", L"Working…") : winrt::hstring{});
            RenderItems();
        }
        return true;
    }

    void ApplyLanguage() {
        title.Text(Text(L"粘贴队列", L"Paste queue"));
        reverse.Label(Text(L"反转", L"Reverse"));
        clear.Label(Text(L"清空", L"Clear"));
        undo.Label(Text(L"撤销", L"Undo"));
        undoMessage.Text(Text(L"已粘贴", L"Pasted"));
        NameIconButton(closeButton, Text(L"关闭粘贴队列", L"Close paste queue"));
        LocalizeConfirmation();
        guidance.Text(Text(L"按顺序整理，逐项粘贴。关闭队列会清空这份临时列表。",
            L"Arrange items, then paste in order. Closing clears this temporary queue."));
        ToolTipService::SetToolTip(closeButton, winrt::box_value(guidance.Text()));
        const auto emptyTitle = emptyState.Children().GetAt(1).try_as<TextBlock>();
        const auto emptyDescription = emptyState.Children().GetAt(2).try_as<TextBlock>();
        if (emptyTitle) emptyTitle.Text(Text(L"队列为空", L"Queue is empty"));
        if (emptyDescription) {
            emptyDescription.Text(Text(L"从剪贴板历史中选择内容加入队列",
                                       L"Select items from clipboard history to add them"));
        }
        RenderItems();
    }

    void ApplyTheme() {
        if (!root) return;
        const bool dark = IsDark();
        if (confirmation) confirmation.RequestedTheme(dark ? ElementTheme::Dark : ElementTheme::Light);
        root.Background(WindowCanvasBackground());
        feedback.Severity(showError ? InfoBarSeverity::Error : InfoBarSeverity::Informational);
        feedback.Message(status.Text());
        feedback.IsOpen(!status.Text().empty());
    }

    void SetLanguage(bool useEnglish) {
        FinishDrag();
        english = useEnglish;
        ApplyLanguage();
        ApplyTheme();
    }

    void SetError(const std::wstring &message) {
        FinishDrag();
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

void QueueView::SetState(JsonObject const &state) {
    if (m_impl) m_impl->SetState(state);
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
    winrt::check_hresult(queue.TestStartPointerReorder(L"a", 33) && !queue.TestStartPointerReorder(L"b", 99) ? S_OK : E_FAIL);
    queue.TestMovePointerReorder(183);
    winrt::check_hresult(rows.Children().GetAt(0).as<Border>().RenderTransform().as<TranslateTransform>().Y() > 100 &&
        rows.Children().GetAt(1).as<Border>().RenderTransform().as<TranslateTransform>().Y() < -60 ? S_OK : E_FAIL);
    queue.TestEndPointerReorder(true);
    stage = 2582;
    winrt::check_hresult(requests.size() == 3 && requests[0].GetNamedString(L"op") == L"dragBegin" &&
        requests[1].GetNamedString(L"op") == L"dragEnd" && requests[2].GetNamedString(L"op") == L"queueReorder" &&
        requests[2].GetNamedArray(L"hashes").GetStringAt(2) == L"a" ? S_OK : E_FAIL);
    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(3));
    response.Insert(L"op", JsonValue::CreateStringValue(L"queueReorder"));
    response.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic reorder failure")); queue.Receive(response);
    stage = 2583;
    winrt::check_hresult(queue.TestStartPointerReorder(L"b", 99) ? S_OK : E_FAIL);
    queue.TestMovePointerReorder(-100); queue.TestEndPointerReorder(false);
    const auto cancelled = rows.Children().GetAt(1).as<Border>();
    const auto resting = cancelled.RenderTransform().TransformPoint({0, 0});
    winrt::check_hresult(requests.size() == 5 && resting.X == 0 && resting.Y == 0 &&
        cancelled.Opacity() == 1 ? S_OK : E_FAIL);
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
    const auto toolbar = root.Children().GetAt(0).as<Grid>().Children().GetAt(2).as<CommandBar>();
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
    invoke(button(0)); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == 1 && requests[0].GetNamedString(L"op") == L"queuePaste" && !button(0).IsEnabled() ? S_OK : E_FAIL);
    state.Insert(L"revision", JsonValue::CreateNumberValue(101));
    state.GetNamedArray(L"items").Append(JsonObject::Parse(LR"({"hash":"new","previewText":"New capture"})"));
    queue.SetState(state); queue.AddItems({L"duplicate"});
    winrt::check_hresult(requests.size() == 1 && rows.Children().Size() == 3 && !button(0).IsEnabled() &&
        feedback.Message() == L"Working…" ? S_OK : E_FAIL);
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
    const auto undo = root.Children().GetAt(4).as<Border>().Child().as<StackPanel>().Children().GetAt(1).as<AppBarButton>();
    winrt::check_hresult(undo.Visibility() == Visibility::Visible && undo.IsEnabled() && undo.Label() == L"Undo" ? S_OK : E_FAIL);
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

winrt::Windows::Foundation::IAsyncAction TestQueueUndoExpiryControls(FrameworkElement fixture, std::uint32_t &stage) {
    std::size_t sent = 0;
    QueueView queue{[&](auto const &, auto const &, auto const &) { return ++sent; }, [] {}};
    const auto root = queue.Root().as<Grid>(); fixture.as<Border>().Child(root);
    const auto toolbar = root.Children().GetAt(0).as<Grid>().Children().GetAt(2).as<CommandBar>();
    const auto undo = root.Children().GetAt(4).as<Border>().Child().as<StackPanel>().Children().GetAt(1).as<AppBarButton>();
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
        if (sender.template as<AppBarButton>().Visibility() == Visibility::Collapsed) SetEvent(signal);
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
        control(1, 1).Focus(FocusState::Keyboard);
        refresh(2, LR"([{"hash":"capture"},{"hash":"a"},{"hash":"b"},{"hash":"c"}])"); co_await NextNativeFrame();
        winrt::check_hresult(Input::FocusManager::GetFocusedElement(root.XamlRoot()) != control(2, 1) ? S_OK : E_FAIL);
    }
    fixture.as<Border>().Child(nullptr);
}
#endif

} // namespace vpaste::winui
