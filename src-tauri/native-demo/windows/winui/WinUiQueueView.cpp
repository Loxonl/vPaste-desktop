#include "WinUiQueueView.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <utility>

#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Text.h>

namespace vpaste::winui {
namespace {

using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Microsoft::UI::Xaml::Media;
using namespace winrt::Windows::Data::Json;
using winrt::Windows::UI::Color;

Color Rgb(std::uint8_t red, std::uint8_t green, std::uint8_t blue) {
    Color color{};
    color.A = 255;
    color.R = red;
    color.G = green;
    color.B = blue;
    return color;
}

Brush Solid(std::uint8_t red, std::uint8_t green, std::uint8_t blue) {
    return SolidColorBrush{Rgb(red, green, blue)};
}

TextBlock MakeText(const winrt::hstring &text, double size, bool bold = false) {
    TextBlock block;
    block.Text(text);
    block.FontSize(size);
    block.FontWeight(bold ? winrt::Windows::UI::Text::FontWeights::SemiBold()
                          : winrt::Windows::UI::Text::FontWeights::Normal());
    block.TextTrimming(TextTrimming::CharacterEllipsis);
    block.TextWrapping(TextWrapping::Wrap);
    block.VerticalAlignment(VerticalAlignment::Center);
    return block;
}

Button MakeButton(const winrt::hstring &text, double minWidth = 62) {
    Button button;
    button.Content(winrt::box_value(text));
    button.MinWidth(minWidth);
    button.Height(32);
    button.Padding(Thickness{8, 0, 8, 0});
    button.FontSize(13);
    return button;
}

struct QueueItem {
    std::wstring hash;
    winrt::hstring itemType;
    winrt::hstring previewText;
    winrt::hstring appSource;
};

} // namespace

struct QueueView::Impl : std::enable_shared_from_this<QueueView::Impl> {
    explicit Impl(RequestCallback requestCallback, CloseCallback closeCallback)
        : request(std::move(requestCallback)), close(std::move(closeCallback)) {}

    RequestCallback request;
    CloseCallback close;
    Grid root{nullptr};
    Grid header{nullptr};
    StackPanel toolbar{nullptr};
    StackPanel rows{nullptr};
    ScrollViewer list{nullptr};
    StackPanel emptyState{nullptr};
    TextBlock title{nullptr};
    TextBlock count{nullptr};
    TextBlock status{nullptr};
    Button reverse{nullptr};
    Button clear{nullptr};
    Button undo{nullptr};
    Button closeButton{nullptr};
    StackPanel clearConfirmation{nullptr};
    TextBlock clearPrompt{nullptr};
    Button clearConfirm{nullptr};
    Button clearCancel{nullptr};
    JsonObject state{nullptr};
    std::vector<QueueItem> items;
    bool english = false;
    bool busy = false;
    bool confirmingClear = false;
    bool showError = false;
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
        root.Margin(Thickness{20, 16, 20, 16});
        auto weak = weak_from_this();
        root.ActualThemeChanged([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ApplyTheme();
        });
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().GetAt(0).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(2).Height(GridLength{1, GridUnitType::Star});
        root.RowDefinitions().GetAt(3).Height(GridLength{1, GridUnitType::Auto});

        header = Grid{};
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Star});
        header.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Auto});

        StackPanel heading;
        heading.Orientation(Orientation::Horizontal);
        heading.Spacing(10);
        title = MakeText(Text(L"粘贴队列", L"Paste queue"), 19, true);
        count = MakeText(L"0 / 100", 13);
        heading.Children().Append(title);
        heading.Children().Append(count);
        header.Children().Append(heading);

        toolbar = StackPanel{};
        toolbar.Orientation(Orientation::Horizontal);
        toolbar.Spacing(6);
        reverse = MakeButton(Text(L"反转", L"Reverse"));
        reverse.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->Send(L"queueReverse");
        });
        toolbar.Children().Append(reverse);

        clear = MakeButton(Text(L"清空", L"Clear"));
        clear.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                self->confirmingClear = true;
                self->UpdateClearConfirmation();
            }
        });
        toolbar.Children().Append(clear);

        undo = MakeButton(Text(L"撤销", L"Undo"));
        undo.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->Send(L"queueUndo");
        });
        toolbar.Children().Append(undo);

        closeButton = MakeButton(Text(L"关闭", L"Close"), 68);
        closeButton.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                if (self->close) self->close();
            }
        });
        toolbar.Children().Append(closeButton);
        Grid::SetColumn(toolbar, 1);
        header.Children().Append(toolbar);
        Grid::SetRow(header, 0);
        root.Children().Append(header);

        clearConfirmation = StackPanel{};
        clearConfirmation.Orientation(Orientation::Horizontal);
        clearConfirmation.Spacing(8);
        clearConfirmation.Margin(Thickness{0, 10, 0, 10});
        clearPrompt = MakeText(Text(L"确定清空全部队列项目？", L"Clear all queued items?"), 13);
        clearConfirmation.Children().Append(clearPrompt);
        clearConfirm = MakeButton(Text(L"确认清空", L"Confirm clear"), 88);
        clearConfirm.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                if (self->busy || !self->confirmingClear) return;
                self->confirmingClear = false;
                self->UpdateClearConfirmation();
                self->Send(L"queueClear");
            }
        });
        clearConfirmation.Children().Append(clearConfirm);
        clearCancel = MakeButton(Text(L"取消", L"Cancel"), 58);
        clearCancel.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                self->confirmingClear = false;
                self->UpdateClearConfirmation();
            }
        });
        clearConfirmation.Children().Append(clearCancel);
        clearConfirmation.Visibility(Visibility::Collapsed);
        Grid::SetRow(clearConfirmation, 1);
        root.Children().Append(clearConfirmation);

        list = ScrollViewer{};
        list.VerticalScrollMode(ScrollMode::Enabled);
        list.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        list.HorizontalScrollMode(ScrollMode::Disabled);
        list.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);

        rows = StackPanel{};
        rows.Spacing(8);
        rows.Margin(Thickness{0, 4, 0, 4});
        list.Content(rows);

        emptyState = StackPanel{};
        emptyState.Spacing(4);
        emptyState.VerticalAlignment(VerticalAlignment::Center);
        emptyState.HorizontalAlignment(HorizontalAlignment::Center);
        TextBlock emptyTitle = MakeText(Text(L"队列为空", L"Queue is empty"), 16, true);
        TextBlock emptyDescription = MakeText(
            Text(L"从剪贴板历史中选择内容加入队列", L"Select items from clipboard history to add them"),
            13);
        emptyState.Children().Append(emptyTitle);
        emptyState.Children().Append(emptyDescription);
        Grid::SetRow(emptyState, 2);
        Grid::SetRow(list, 2);
        root.Children().Append(list);
        root.Children().Append(emptyState);

        status = MakeText(L"", 12);
        status.Margin(Thickness{0, 8, 0, 0});
        Grid::SetRow(status, 3);
        root.Children().Append(status);
        ApplyLanguage();
        ApplyTheme();
    }

    void Send(const wchar_t *operation, const std::wstring &hash = {},
              const std::vector<std::wstring> &hashes = {}) {
        if (!request || busy) return;
        showError = false;
        status.Text(Text(L"正在处理…", L"Working…"));
        request(operation, hash, hashes);
        busy = true;
        RenderItems();
    }

    std::vector<std::wstring> OrderedHashes() const {
        std::vector<std::wstring> hashes;
        hashes.reserve(items.size());
        for (const auto &item : items) hashes.push_back(item.hash);
        return hashes;
    }

    void MoveItem(std::size_t index, int delta) {
        if (busy || index >= items.size()) return;
        const auto target = static_cast<std::ptrdiff_t>(index) + delta;
        if (target < 0 || target >= static_cast<std::ptrdiff_t>(items.size())) return;
        std::swap(items[index], items[static_cast<std::size_t>(target)]);
        auto hashes = OrderedHashes();
        Send(L"queueReorder", {}, hashes);
        RenderItems();
    }

    void RenderItems() {
        rows.Children().Clear();
        for (std::size_t index = 0; index < items.size(); ++index) {
            const auto item = items[index];
            Grid row;
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Star});
            row.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Auto});

            StackPanel details;
            details.Orientation(Orientation::Vertical);
            details.Spacing(2);
            TextBlock type = MakeText(item.itemType, 11, true);
            TextBlock preview = MakeText(
                item.previewText.empty() ? item.itemType : item.previewText, 14);
            preview.MaxLines(2);
            TextBlock source = MakeText(item.appSource, 11);
            details.Children().Append(type);
            details.Children().Append(preview);
            if (!item.appSource.empty()) details.Children().Append(source);

            Border surface;
            surface.Padding(Thickness{12, 8, 8, 8});
            surface.CornerRadius(CornerRadius{10, 10, 10, 10});
            surface.BorderThickness(Thickness{1, 1, 1, 1});
            surface.Child(details);
            row.Children().Append(surface);

            StackPanel actions;
            actions.Orientation(Orientation::Horizontal);
            actions.Spacing(4);
            auto weak = weak_from_this();

            Button paste = MakeButton(Text(L"粘贴", L"Paste"), 60);
            paste.IsEnabled(!busy);
            paste.Click([weak, hash = item.hash](auto const &, auto const &) {
                if (auto self = weak.lock()) self->Send(L"queuePaste", hash);
            });
            actions.Children().Append(paste);

            Button up = MakeButton(L"↑", 32);
            Automation::AutomationProperties::SetName(
                up, Text(L"上移", L"Move up"));
            up.IsEnabled(!busy && index > 0);
            up.Click([weak, index](auto const &, auto const &) {
                if (auto self = weak.lock()) self->MoveItem(index, -1);
            });
            actions.Children().Append(up);

            Button down = MakeButton(L"↓", 32);
            Automation::AutomationProperties::SetName(
                down, Text(L"下移", L"Move down"));
            down.IsEnabled(!busy && index + 1 < items.size());
            down.Click([weak, index](auto const &, auto const &) {
                if (auto self = weak.lock()) self->MoveItem(index, 1);
            });
            actions.Children().Append(down);

            Button remove = MakeButton(Text(L"移除", L"Remove"), 60);
            remove.IsEnabled(!busy);
            remove.Click([weak, hash = item.hash](auto const &, auto const &) {
                if (auto self = weak.lock()) self->Send(L"queueRemove", hash);
            });
            actions.Children().Append(remove);
            Grid::SetColumn(actions, 1);
            row.Children().Append(actions);

            Border container;
            container.Child(row);
            container.CornerRadius(CornerRadius{10, 10, 10, 10});
            container.BorderThickness(Thickness{1, 1, 1, 1});
            container.Padding(Thickness{1, 1, 1, 1});
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
        clear.IsEnabled(!busy && !items.empty());
        const auto undoHash = state ? state.GetNamedValue(L"undoHash", nullptr) : JsonValue{nullptr};
        undo.IsEnabled(!busy && undoHash && undoHash.ValueType() == JsonValueType::String &&
                       !undoHash.GetString().empty());
        ApplyTheme();
    }

    void UpdateClearConfirmation() {
        clearConfirmation.Visibility(confirmingClear ? Visibility::Visible : Visibility::Collapsed);
        clear.IsEnabled(!busy && !items.empty() && !confirmingClear);
        clearConfirm.IsEnabled(!busy);
        clearCancel.IsEnabled(!busy);
    }

    void SetState(JsonObject const &nextState) {
        const auto nextRevision = static_cast<std::uint64_t>(
            nextState.GetNamedNumber(L"revision", 0));
        if (hasRevision && nextRevision < lastRevision) return;
        lastRevision = nextRevision;
        hasRevision = true;

        state = nextState;
        busy = state.GetNamedBoolean(L"busy", false);
        items.clear();
        if (state.HasKey(L"items") && state.GetNamedValue(L"items").ValueType() == JsonValueType::Array) {
            const auto queueItems = state.GetNamedArray(L"items");
            for (std::uint32_t index = 0; index < queueItems.Size(); ++index) {
                const auto value = queueItems.GetAt(index);
                if (value.ValueType() != JsonValueType::Object) continue;
                const auto item = value.GetObject();
                auto preview = item.GetNamedString(L"previewText", L"");
                if (preview.empty()) preview = item.GetNamedString(L"previewContent", L"");
                if (preview.empty()) preview = item.GetNamedString(L"content", L"");
                items.push_back(QueueItem{
                    std::wstring{item.GetNamedString(L"hash", L"")},
                    item.GetNamedString(L"itemType", L""),
                    preview,
                    item.GetNamedString(L"appSource", L"")});
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
        UpdateClearConfirmation();
    }

    void ApplyLanguage() {
        title.Text(Text(L"粘贴队列", L"Paste queue"));
        reverse.Content(winrt::box_value(Text(L"反转", L"Reverse")));
        clear.Content(winrt::box_value(Text(L"清空", L"Clear")));
        undo.Content(winrt::box_value(Text(L"撤销", L"Undo")));
        closeButton.Content(winrt::box_value(Text(L"关闭", L"Close")));
        clearPrompt.Text(Text(L"确定清空全部队列项目？", L"Clear all queued items?"));
        clearConfirm.Content(winrt::box_value(Text(L"确认清空", L"Confirm clear")));
        clearCancel.Content(winrt::box_value(Text(L"取消", L"Cancel")));
        const auto emptyTitle = emptyState.Children().GetAt(0).try_as<TextBlock>();
        const auto emptyDescription = emptyState.Children().GetAt(1).try_as<TextBlock>();
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
        const auto background = dark ? Solid(23, 27, 34) : Solid(246, 247, 249);
        const auto surface = dark ? Solid(34, 39, 47) : Solid(255, 255, 255);
        const auto primary = dark ? Solid(242, 244, 247) : Solid(37, 42, 48);
        const auto secondary = dark ? Solid(190, 197, 207) : Solid(100, 107, 115);
        const auto border = dark ? Solid(58, 64, 73) : Solid(222, 226, 232);
        root.Background(background);
        title.Foreground(primary);
        count.Foreground(secondary);
        status.Foreground(showError ? Solid(196, 55, 55) : secondary);
        clearPrompt.Foreground(primary);
        const auto rowChildren = rows.Children();
        for (std::uint32_t rowIndex = 0; rowIndex < rowChildren.Size(); ++rowIndex) {
            const auto element = rowChildren.GetAt(rowIndex);
            const auto container = element.try_as<Border>();
            if (!container) continue;
            container.Background(surface);
            container.BorderBrush(border);
            const auto row = container.Child().try_as<Grid>();
            if (!row) continue;
            const auto detailsBorder = row.Children().GetAt(0).try_as<Border>();
            if (!detailsBorder) continue;
            const auto details = detailsBorder.Child().try_as<StackPanel>();
            if (!details) continue;
            for (std::uint32_t index = 0; index < details.Children().Size(); ++index) {
                const auto text = details.Children().GetAt(index).try_as<TextBlock>();
                if (!text) continue;
                text.Foreground(index == 1 ? primary : secondary);
            }
        }
        if (emptyState) {
            for (std::uint32_t index = 0; index < emptyState.Children().Size(); ++index) {
                const auto text = emptyState.Children().GetAt(index).try_as<TextBlock>();
                if (text) text.Foreground(index == 0 ? primary : secondary);
            }
        }
    }

    void SetLanguage(bool useEnglish) {
        english = useEnglish;
        ApplyLanguage();
        ApplyTheme();
    }

    void SetError(const std::wstring &message) {
        busy = false;
        showError = true;
        status.Text(winrt::hstring{message});
        RenderItems();
        UpdateClearConfirmation();
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

} // namespace vpaste::winui
