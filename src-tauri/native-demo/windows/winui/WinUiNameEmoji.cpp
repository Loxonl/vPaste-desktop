#include <windows.h>
#undef GetCurrentTime
#include "WinUiNameEmoji.h"
#include "WinUiAppearance.h"

#include <algorithm>
#include <memory>
#include <string_view>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.UI.Xaml.Interop.h>

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;

const std::vector<std::wstring> &NameEmojiOptions() {
    static const auto options = [] {
        const auto module = GetModuleHandleW(L"VPasteWinUiPanel.dll");
        const auto resource = FindResourceW(module, L"VPASTE_NAME_PREFIX_EMOJIS", RT_RCDATA);
        winrt::check_bool(resource != nullptr);
        const auto loaded = LoadResource(module, resource);
        winrt::check_bool(loaded != nullptr);
        const auto bytes = static_cast<const char *>(LockResource(loaded));
        winrt::check_bool(bytes != nullptr);
        const auto json = winrt::Windows::Data::Json::JsonArray::Parse(
            winrt::to_hstring(std::string_view{bytes, SizeofResource(module, resource)}));
        std::vector<std::wstring> values;
        for (const auto &value : json) values.emplace_back(value.GetString());
        return values;
    }();
    return options;
}

std::wstring SelectedNameEmoji(const std::wstring &name) {
    std::wstring selected;
    for (const auto &emoji : NameEmojiOptions())
        if (emoji.size() > selected.size() && name.starts_with(emoji)) selected = emoji;
    return selected;
}

std::wstring ApplyNameEmoji(const std::wstring &name, const std::wstring &emoji) {
    const auto prefix = SelectedNameEmoji(name);
    auto rest = name;
    if (!prefix.empty()) {
        // Match JavaScript /^\s+/, including Chinese/full-width name spacing.
        const auto whitespace = [](wchar_t c) {
            return (c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0xA0 || c == 0x1680 ||
                (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 ||
                c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
        };
        auto offset = prefix.size();
        while (offset < name.size() && whitespace(name[offset])) ++offset;
        rest = name.substr(offset);
    }
    return emoji.empty() ? rest : emoji + (rest.empty() ? L"" : L" " + rest);
}

bool TryApplyNameEmoji(const TextBox &target, const std::wstring &emoji) {
    if (!target.IsEnabled()) return false;
    const auto next = ApplyNameEmoji(std::wstring{target.Text()}, emoji);
    const auto limit = target.MaxLength();
    if (limit > 0 && next.size() > static_cast<std::size_t>(limit)) return false;
    target.Text(next);
    return true;
}

namespace {
bool English(const Button &button) { return winrt::unbox_value<bool>(button.Tag()); }
void UpdateTrigger(const Button &button, const TextBox &target) {
    const auto selected = SelectedNameEmoji(std::wstring{target.Text()});
    if (selected.empty()) button.Content(Glyph(L"\uE76E"));
    else {
        TextBlock text;
        text.Text(selected); text.FontSize(18); text.FontFamily(Media::FontFamily{L"Segoe UI Emoji"});
        button.Content(text);
    }
    NameIconButton(button, winrt::hstring{English(button) ? L"Choose name emoji" : L"选择名称表情"} +
        (selected.empty() ? winrt::hstring{} : winrt::hstring{L" "} + selected));
}
}

void SetNameEmojiLanguage(const Button &button, bool english) {
    button.Tag(winrt::box_value(english));
    const auto emoji = button.Content().try_as<TextBlock>();
    NameIconButton(button, winrt::hstring{english ? L"Choose name emoji" : L"选择名称表情"} +
        (emoji ? winrt::hstring{L" "} + emoji.Text() : winrt::hstring{}));
    if (const auto flyout = button.Flyout().try_as<Flyout>()) {
        const auto root = flyout.Content().as<Grid>();
        root.Children().GetAt(0).as<Button>().Content(winrt::box_value(english ? L"No emoji" : L"无表情"));
        Automation::AutomationProperties::SetName(root.Children().GetAt(1), english ? L"Name emoji" : L"名称表情");
    }
}

Button NameEmojiButton(const TextBox &target, bool english) {
    Button button = NamedIconButton(Glyph(L"\uE76E"), english ? L"Choose name emoji" : L"选择名称表情");
    button.VerticalAlignment(VerticalAlignment::Bottom);
    button.Tag(winrt::box_value(english));
    Grid root; root.Width(256); root.RowSpacing(8);
    for (int i = 0; i < 3; ++i) { RowDefinition row; row.Height(GridLength{1, GridUnitType::Auto}); root.RowDefinitions().Append(row); }
    Button clear; clear.Height(32); clear.HorizontalAlignment(HorizontalAlignment::Stretch);
    root.Children().Append(clear);
    GridView grid;
    grid.MaxHeight(224); grid.Padding(Thickness{0});
    grid.SelectionMode(ListViewSelectionMode::Single);
    grid.IsItemClickEnabled(true);
    ScrollViewer::SetVerticalScrollBarVisibility(grid, ScrollBarVisibility::Auto);
    ScrollViewer::SetHorizontalScrollMode(grid, ScrollMode::Disabled);
    grid.ItemsPanel(Markup::XamlReader::Load(LR"(<ItemsPanelTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><ItemsWrapGrid Orientation="Horizontal" MaximumRowsOrColumns="8" ItemWidth="32" ItemHeight="32"/></ItemsPanelTemplate>)").as<ItemsPanelTemplate>());
    grid.ItemTemplate(Markup::XamlReader::Load(LR"(<DataTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><TextBlock Text="{Binding}" FontFamily="Segoe UI Emoji" FontSize="20" IsColorFontEnabled="True" HorizontalAlignment="Center" VerticalAlignment="Center"/></DataTemplate>)").as<DataTemplate>());
    Style itemStyle{winrt::xaml_typename<GridViewItem>()};
    itemStyle.Setters().Append(Setter{FrameworkElement::MinWidthProperty(), winrt::box_value(32.0)});
    itemStyle.Setters().Append(Setter{FrameworkElement::MinHeightProperty(), winrt::box_value(32.0)});
    itemStyle.Setters().Append(Setter{Control::PaddingProperty(), winrt::box_value(Thickness{0})});
    itemStyle.Setters().Append(Setter{Control::HorizontalContentAlignmentProperty(), winrt::box_value(HorizontalAlignment::Center)});
    itemStyle.Setters().Append(Setter{Control::VerticalContentAlignmentProperty(), winrt::box_value(VerticalAlignment::Center)});
    grid.ItemContainerStyle(itemStyle);
    for (const auto &emoji : NameEmojiOptions()) grid.Items().Append(winrt::box_value(emoji));
    Grid::SetRow(grid, 1); root.Children().Append(grid);
    TextBlock error; ApplyStyle(error, L"VPaste.Secondary"); error.TextWrapping(TextWrapping::Wrap);
    error.Visibility(Visibility::Collapsed); Grid::SetRow(error, 2); root.Children().Append(error);
    Flyout flyout;
    flyout.ShouldConstrainToRootBounds(false);
    flyout.Placement(Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft);
    flyout.Content(root); button.Flyout(flyout);
    SetNameEmojiLanguage(button, english);
    UpdateTrigger(button, target);
    const auto weakTarget = winrt::make_weak(target);
    const auto weakButton = winrt::make_weak(button);
    const auto weakFlyout = winrt::make_weak(flyout);
    const auto weakGrid = winrt::make_weak(grid);
    const auto weakError = winrt::make_weak(error);
    const auto weakClear = winrt::make_weak(clear);
    const auto weakRoot = winrt::make_weak(root);
    auto applied = std::make_shared<bool>(false);
    const auto choose = [weakTarget, weakButton, weakFlyout, weakGrid, weakError, applied](const std::wstring &emoji) {
        const auto input = weakTarget.get(); const auto popup = weakFlyout.get();
        if (!input || !input.IsLoaded() || !input.IsEnabled()) { if (popup) popup.Hide(); return; }
        if (TryApplyNameEmoji(input, emoji)) {
            *applied = true; if (popup) popup.Hide();
        } else if (const auto message = weakError.get()) {
            const auto owner = weakButton.get();
            message.Text(winrt::hstring{owner && English(owner) ? L"The name would be too long (maximum " : L"名称将超出长度限制（最多 "} +
                winrt::to_hstring(input.MaxLength()) + (owner && English(owner) ? L" characters)." : L" 个字符）。"));
            message.Visibility(Visibility::Visible);
            if (const auto options = weakGrid.get()) {
                const auto selected = SelectedNameEmoji(std::wstring{input.Text()});
                options.SelectedItem(selected.empty() ? nullptr : winrt::box_value(selected));
            }
        }
    };
    clear.Click([choose](auto const &, auto const &) { choose(L""); });
    grid.ItemClick([choose](auto const &, auto const &args) { choose(std::wstring{winrt::unbox_value<winrt::hstring>(args.ClickedItem())}); });
    flyout.Opening([weakTarget, weakRoot](auto const &, auto const &) {
        if (const auto input = weakTarget.get()) if (const auto content = weakRoot.get()) content.RequestedTheme(input.ActualTheme());
    });
    flyout.Opened([weakTarget, weakButton, weakGrid, weakError, weakClear, weakRoot, applied](auto const &, auto const &) {
        *applied = false;
        const auto input = weakTarget.get(); const auto owner = weakButton.get(); const auto options = weakGrid.get();
        if (!input || !owner || !options) return;
        if (const auto content = weakRoot.get()) content.RequestedTheme(input.ActualTheme());
        if (const auto message = weakError.get()) message.Visibility(Visibility::Collapsed);
        const auto selected = SelectedNameEmoji(std::wstring{input.Text()});
        if (const auto clearOption = weakClear.get()) clearOption.IsEnabled(!selected.empty());
        Automation::AutomationProperties::SetName(options, English(owner) ? L"Name emoji" : L"名称表情");
        options.SelectedItem(selected.empty() ? nullptr : winrt::box_value(selected));
        if (!selected.empty()) options.ScrollIntoView(options.SelectedItem());
        options.Focus(FocusState::Programmatic);
    });
    flyout.Closed([weakTarget, applied](auto const &, auto const &) {
        if (*applied) if (const auto input = weakTarget.get(); input && input.IsLoaded() && input.IsEnabled()) {
            input.Focus(FocusState::Programmatic);
            input.SelectionStart(static_cast<int>(input.Text().size()));
        }
        *applied = false;
    });
    target.TextChanged([weakButton](auto const &sender, auto const &) {
        if (const auto owner = weakButton.get()) UpdateTrigger(owner, sender.as<TextBox>());
    });
    target.ActualThemeChanged([weakRoot](auto const &sender, auto const &) {
        if (const auto content = weakRoot.get()) content.RequestedTheme(sender.as<FrameworkElement>().ActualTheme());
    });
    target.RegisterPropertyChangedCallback(Control::IsEnabledProperty(), [weakButton, weakFlyout](auto const &sender, auto const &) {
        if (const auto owner = weakButton.get()) owner.IsEnabled(sender.as<TextBox>().IsEnabled());
        if (!sender.as<TextBox>().IsEnabled()) if (const auto popup = weakFlyout.get()) popup.Hide();
    });
    button.Unloaded([weakFlyout](auto const &, auto const &) { if (const auto popup = weakFlyout.get()) popup.Hide(); });
    button.IsEnabled(target.IsEnabled());
    return button;
}

} // namespace vpaste::winui
