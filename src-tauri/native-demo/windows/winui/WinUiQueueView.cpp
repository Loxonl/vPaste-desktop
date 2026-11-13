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
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
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
using winrt::Windows::ApplicationModel::DataTransfer::DataPackageOperation;
constexpr wchar_t QueueDragFormat[] = L"com.vpaste.native-queue-item";

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
        root.PreviewKeyDown([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->rowFocus.reset(); });
        root.PointerPressed([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->rowFocus.reset(); });
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
        header.Margin(Thickness{0, 0, 0, 8});
        header.RowDefinitions().Append(RowDefinition{});
        header.RowDefinitions().Append(RowDefinition{});
        header.RowDefinitions().GetAt(0).Height(GridLength{1, GridUnitType::Auto});
        header.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Auto});
        header.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Auto});
        header.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Auto});
        header.ColumnDefinitions().GetAt(2).Width(GridLength{1, GridUnitType::Star});

        StackPanel heading;
        heading.Orientation(Orientation::Horizontal);
        heading.Spacing(8);
        heading.VerticalAlignment(VerticalAlignment::Center);
        title = MakeText(Text(L"粘贴队列", L"Paste queue"), 14, true);
        ApplyStyle(title, L"VPaste.CompactTitle");
        count = MakeText(L"0 / 100", 12);
        heading.Children().Append(title);
        heading.Children().Append(count);
        Grid::SetColumn(heading, 1);
        header.Children().Append(heading);

        toolbar = CommandBar{};
        toolbar.DefaultLabelPosition(CommandBarDefaultLabelPosition::Right);
        toolbar.IsDynamicOverflowEnabled(true);
        toolbar.HorizontalAlignment(HorizontalAlignment::Right);
        toolbar.Background(SolidColorBrush{Color{0, 0, 0, 0}});
        reverse = AppBarButton{};
        reverse.Label(Text(L"反转", L"Reverse"));
        reverse.Icon(SymbolIcon{Symbol::Switch});
        reverse.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->Send(L"queueReverse");
        });
        toolbar.SecondaryCommands().Append(reverse);

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
        toolbar.PrimaryCommands().Append(undo);

        closeButton = NamedIconButton(SymbolIcon{Symbol::Cancel}, Text(L"关闭粘贴队列", L"Close paste queue"));
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
        rows.Spacing(8);
        rows.Margin(Thickness{0, 4, 0, 4});
        list.Content(rows);
        dragScroll = winrt::Microsoft::UI::Dispatching::DispatcherQueue::GetForCurrentThread().CreateTimer();
        dragScroll.Interval(std::chrono::milliseconds(50)); // Drag edge scrolling, not a layout animation.
        dragScroll.IsRepeating(true);
        dragScroll.Tick([weak](auto const &, auto const &) {
            if (const auto self = weak.lock(); self && !self->draggingHash.empty() && self->dragScrollDirection != 0) {
                self->list.ChangeView(nullptr, winrt::box_value(std::clamp(self->list.VerticalOffset() +
                    self->dragScrollDirection * 18.0, 0.0, self->list.ScrollableHeight())).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, true);
            }
        });
        list.DragLeave([weak](auto const &, auto const &) {
            if (const auto self = weak.lock()) self->dragScrollDirection = 0;
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
        if (wasDragging && request) request(L"dragEnd", {}, {});
        for (const auto &child : rows.Children()) {
            const auto surface = child.as<Border>();
            surface.Opacity(1);
            const auto row = surface.Child().as<Grid>();
            if (row.Children().Size() > 3) row.Children().GetAt(3).as<Border>().Visibility(Visibility::Collapsed);
        }
        if (pendingDragState) {
            const auto latest = std::exchange(pendingDragState, nullptr);
            SetState(latest);
        }
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

    bool AcceptsDrop(const DragEventArgs &args) const {
        return !busy && !confirmingClear && !draggingHash.empty() &&
            !(pendingDragState && pendingDragState.GetNamedBoolean(L"busy", false)) &&
            args.DataView().Contains(QueueDragFormat);
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
        if (rowFocus->role == L"queue-more" || rowFocus->role == L"queue-remove")
            target = row.Children().GetAt(1).as<StackPanel>().Children().GetAt(rowFocus->role == L"queue-more" ? 0 : 1).as<Button>();
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
            row.ColumnDefinitions().GetAt(0).Width(GridLength{36, GridUnitType::Pixel});
            row.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Star});
            row.ColumnDefinitions().GetAt(2).Width(GridLength{1, GridUnitType::Auto});
            row.ColumnSpacing(8);

            StackPanel details;
            details.Orientation(Orientation::Vertical);
            details.Spacing(2);
            TextBlock type = MakeText((index == 0 ? Text(L"下一项 · ", L"Next · ") : winrt::hstring{}) + TypeLabel(item.itemType, english), 12);
            TextBlock preview = MakeText(
                item.itemType == L"Image" || item.previewText.empty()
                    ? TypeLabel(item.itemType, english) : item.previewText, 13);
            ApplyStyle(preview, L"VPaste.Body");
            preview.FontSize(13);
            preview.MaxLines(1);
            preview.TextWrapping(TextWrapping::NoWrap);
            details.Children().Append(preview);
            details.Children().Append(type);
            ToolTipService::SetToolTip(details, winrt::box_value(item.appSource));

            auto weak = weak_from_this();
            Button paste;
            ApplyStyle(paste, L"VPaste.IconButton");
            paste.Content(details);
            paste.MinHeight(48);
            paste.HorizontalAlignment(HorizontalAlignment::Stretch);
            paste.HorizontalContentAlignment(HorizontalAlignment::Stretch);
            paste.Padding(Thickness{0});
            paste.IsEnabled(!busy);
            Automation::AutomationProperties::SetAutomationId(paste, L"queue-paste");
            Automation::AutomationProperties::SetName(paste, Text(L"粘贴：", L"Paste: ") + preview.Text());
            ToolTipService::SetToolTip(paste, winrt::box_value(preview.Text() + L"\n" + item.appSource));
            paste.Click([weak, hash = item.hash](auto const &, auto const &) {
                if (auto self = weak.lock(); self && !self->suppressDragPaste && self->draggingHash.empty()) self->Send(L"queuePaste", hash);
            });
            paste.PointerPressed([weak](auto const &, auto const &) {
                if (auto self = weak.lock()) self->suppressDragPaste = false;
            });
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
            auto more = NamedIconButton(SymbolIcon{Symbol::More}, Text(L"队列项操作", L"Queue item actions"));
            more.IsEnabled(!busy);
            Automation::AutomationProperties::SetAutomationId(more, L"queue-more");
            more.Flyout(rowMenu);
            paste.ContextFlyout(rowMenu);
            actions.Children().Append(more);

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
            position.Children().Append(identity);
            auto ordinal = MakeText(winrt::hstring{std::to_wstring(index + 1)}, 12, true);
            ordinal.HorizontalAlignment(HorizontalAlignment::Center);
            position.Children().Append(ordinal);
            Button handle; ApplyStyle(handle, L"VPaste.IconButton");
            NameIconButton(handle, Text(L"调整顺序：", L"Reorder: ") + preview.Text());
            handle.Content(position); handle.Width(36); handle.Height(48); handle.Padding(Thickness{0});
            handle.IsEnabled(!busy && !confirmingClear);
            handle.CanDrag(!busy && !confirmingClear);
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
            handle.DragStarting([weak, hash = item.hash](auto const &sender, auto const &args) {
                if (auto self = weak.lock(); self && self->BeginReorder(hash)) {
                    sender.as<Button>().Parent().as<Grid>().Parent().as<Border>().Opacity(DragSourceOpacity);
                    args.Data().SetData(QueueDragFormat, winrt::box_value(winrt::hstring{hash}));
                    args.Data().RequestedOperation(DataPackageOperation::Move);
                    args.AllowedOperations(DataPackageOperation::Move);
                } else args.Cancel(true);
            });
            handle.DropCompleted([weak](auto const &, auto const &) {
                if (auto self = weak.lock()) self->FinishDrag();
            });
            row.Children().Append(handle);

            Border insertion;
            ApplyStyle(insertion, L"VPaste.QueueInsertion");
            insertion.Visibility(Visibility::Collapsed);
            Grid::SetColumnSpan(insertion, 3);
            row.Children().Append(insertion);

            Border container;
            container.Tag(winrt::box_value(winrt::hstring{item.hash}));
            container.Child(row);
            container.CornerRadius(UniformRadius(ManagementRowRadius));
            container.BorderThickness(Thickness{1, 1, 1, 1});
            container.Padding(UniformThickness(8));
            container.MinHeight(66);
            ApplyStyle(container, L"VPaste.Surface");
            container.AllowDrop(true);
            container.DragOver([weak, insertion](auto const &sender, auto const &args) {
                if (auto self = weak.lock(); self && self->AcceptsDrop(args)) {
                    const auto surface = sender.as<Border>();
                    insertion.VerticalAlignment(args.GetPosition(surface).Y >= surface.ActualHeight() / 2
                        ? VerticalAlignment::Bottom : VerticalAlignment::Top);
                    insertion.Visibility(Visibility::Visible);
                    const auto y = args.GetPosition(self->list).Y;
                    self->dragScrollDirection = y < 24 ? -1 : y > self->list.ActualHeight() - 24 ? 1 : 0;
                    args.AcceptedOperation(DataPackageOperation::Move);
                    args.DragUIOverride().Caption(self->Text(L"调整队列顺序", L"Reorder queue"));
                    args.Handled(true);
                } else {
                    insertion.Visibility(Visibility::Collapsed);
                    args.AcceptedOperation(DataPackageOperation::None);
                }
            });
            container.DragLeave([insertion](auto const &, auto const &) { insertion.Visibility(Visibility::Collapsed); });
            container.Drop([weak, insertion, hash = item.hash](auto const &sender, auto const &args) {
                insertion.Visibility(Visibility::Collapsed);
                if (auto self = weak.lock(); self && self->AcceptsDrop(args)) {
                    const auto surface = sender.as<Border>();
                    const bool after = args.GetPosition(surface).Y >= surface.ActualHeight() / 2;
                    args.AcceptedOperation(DataPackageOperation::Move);
                    args.Handled(true);
                    self->DropItem(hash, after);
                }
            });
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
    const auto label = [&](std::uint32_t index) { return button(index).Content().as<StackPanel>().Children().GetAt(0).as<TextBlock>().Text(); };
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
    const auto menu = rows.Children().GetAt(0).as<Border>().Child().as<Grid>().Children().GetAt(1).as<StackPanel>()
        .Children().GetAt(0).as<Button>().Flyout().as<MenuFlyout>();
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
    const auto undo = toolbar.PrimaryCommands().GetAt(0).as<AppBarButton>();
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
    const auto captured = rows.Children().GetAt(0).as<Border>().Child().as<Grid>().Children().GetAt(1).as<StackPanel>()
        .Children().GetAt(0).as<Button>().Flyout().as<MenuFlyout>().Items().GetAt(1);
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
    queue.SetState(scrollState); co_await NextNativeFrame();
    const auto list = root.Children().GetAt(1).as<ScrollViewer>();
    winrt::handle ready{CreateEventW(nullptr, false, false, nullptr)}; winrt::check_bool(static_cast<bool>(ready));
    const winrt::apartment_context ui;
    const auto token = list.ViewChanged([signal = ready.get(), list](auto const &, auto const &args) {
        if (!args.IsIntermediate() && list.VerticalOffset() >= 180) SetEvent(signal);
    });
    list.ChangeView(nullptr, winrt::box_value(180.0).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, true);
    const bool scrolled = co_await winrt::resume_on_signal(ready.get(), std::chrono::seconds(5));
    co_await ui; list.ViewChanged(token); winrt::check_hresult(scrolled ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
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
    const auto undo = toolbar.PrimaryCommands().GetAt(0).as<AppBarButton>();
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
        return rows.Children().GetAt(index).as<Border>().Child().as<Grid>().Children().GetAt(1).as<StackPanel>().Children().GetAt(action).as<Button>();
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
