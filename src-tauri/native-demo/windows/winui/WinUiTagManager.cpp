#include "WinUiTagManager.h"

#include <algorithm>
#include <optional>
#include <utility>
#include <vector>

#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Windows.Foundation.Collections.h>
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
    block.VerticalAlignment(VerticalAlignment::Center);
    return block;
}

Button MakeButton(const winrt::hstring &text, double minWidth = 64) {
    Button button;
    button.Content(winrt::box_value(text));
    button.MinWidth(minWidth);
    button.Height(32);
    button.Padding(Thickness{8, 0, 8, 0});
    button.FontSize(13);
    return button;
}

struct Tag {
    std::int64_t id = 0;
    std::wstring name;
};

} // namespace

struct TagManager::Impl : std::enable_shared_from_this<TagManager::Impl> {
    Impl(RequestCallback requestCallback, CloseCallback closeCallback)
        : request(std::move(requestCallback)), close(std::move(closeCallback)) {}

    RequestCallback request;
    CloseCallback close;
    Grid root{nullptr};
    Grid header{nullptr};
    StackPanel rows{nullptr};
    TextBox addName{nullptr};
    TextBlock title{nullptr};
    TextBlock status{nullptr};
    TextBlock guidance{nullptr};
    Button add{nullptr};
    Button closeButton{nullptr};
    ScrollViewer list{nullptr};
    std::vector<Tag> tags;
    TextBox editingBox{nullptr};
    std::optional<std::int64_t> editingId;
    std::wstring editingName;
    std::optional<std::int64_t> confirmingDeleteId;
    std::wstring pendingOperation;
    winrt::hstring error;
    bool english = false;
    bool busy = false;
    bool showError = false;
    ElementTheme theme = ElementTheme::Default;

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
        root.Padding(Thickness{20, 16, 20, 16});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().Append(RowDefinition{});
        root.RowDefinitions().GetAt(0).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(2).Height(GridLength{1, GridUnitType::Star});
        root.RowDefinitions().GetAt(3).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(4).Height(GridLength{1, GridUnitType::Auto});

        header = Grid{};
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Star});
        header.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Auto});
        title = MakeText(Text(L"管理标签", L"Manage tags"), 19, true);
        header.Children().Append(title);
        closeButton = MakeButton(Text(L"关闭", L"Close"), 68);
        Automation::AutomationProperties::SetName(closeButton, Text(L"关闭标签管理", L"Close tag manager"));
        auto weak = weak_from_this();
        closeButton.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                if (!self->busy && self->close) self->close();
            }
        });
        Grid::SetColumn(closeButton, 1);
        header.Children().Append(closeButton);
        Grid::SetRow(header, 0);
        root.Children().Append(header);

        StackPanel addRow;
        addRow.Orientation(Orientation::Horizontal);
        addRow.Spacing(8);
        addRow.Margin(Thickness{0, 14, 0, 10});
        addName = TextBox{};
        addName.MaxLength(20);
        addName.MinHeight(36);
        addName.PlaceholderText(Text(L"输入标签名称", L"Enter a tag name"));
        addName.VerticalAlignment(VerticalAlignment::Center);
        addName.HorizontalAlignment(HorizontalAlignment::Stretch);
        addName.Width(350);
        Automation::AutomationProperties::SetName(addName, Text(L"新标签名称", L"New tag name"));
        addName.TextChanged([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock()) {
                self->add.IsEnabled(!self->busy && !sender.as<TextBox>().Text().empty());
            }
        });
        addRow.Children().Append(addName);
        add = MakeButton(Text(L"添加", L"Add"), 68);
        add.IsEnabled(false);
        Automation::AutomationProperties::SetName(add, Text(L"添加标签", L"Add tag"));
        add.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->CreateTag();
        });
        addRow.Children().Append(add);
        Grid::SetRow(addRow, 1);
        root.Children().Append(addRow);

        list = ScrollViewer{};
        list.VerticalScrollMode(ScrollMode::Enabled);
        list.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        list.HorizontalScrollMode(ScrollMode::Disabled);
        list.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
        rows = StackPanel{};
        rows.Spacing(7);
        list.Content(rows);
        Grid::SetRow(list, 2);
        root.Children().Append(list);

        status = MakeText(L"", 12);
        status.Margin(Thickness{0, 8, 0, 4});
        Grid::SetRow(status, 3);
        root.Children().Append(status);

        guidance = MakeText(
            Text(L"删除标签会从所有剪贴项中移除该标签。", L"Deleting a tag removes it from all clipboard items."),
            12);
        guidance.Margin(Thickness{0, 4, 0, 0});
        Grid::SetRow(guidance, 4);
        root.Children().Append(guidance);

        root.ActualThemeChanged([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ApplyTheme();
        });
        ApplyLanguage();
        ApplyTheme();
        RenderTags();
    }

    void Send(const wchar_t *operation, std::int64_t id = 0,
              const std::wstring &name = {}) {
        if (!request || busy) return;
        request(operation, id, name);
        pendingOperation = operation;
        busy = true;
        showError = false;
        error = L"";
        status.Text(Text(L"正在处理…", L"Working…"));
        UpdateEnabled();
    }

    void CreateTag() {
        if (busy || !addName) return;
        const auto name = addName.Text();
        if (name.empty()) {
            addName.Focus(FocusState::Programmatic);
            return;
        }
        Send(L"tagsCreate", 0, std::wstring{name});
    }

    void UpdateTag(std::int64_t id) {
        if (busy || !editingId || *editingId != id) return;
        if (!editingBox) return;
        const auto name = editingBox.Text();
        if (name.empty()) {
            editingBox.Focus(FocusState::Programmatic);
            return;
        }
        Send(L"tagsRename", id, std::wstring{name});
    }

    void UpdateEnabled() {
        if (add) add.IsEnabled(!busy && !addName.Text().empty());
        if (addName) addName.IsEnabled(!busy);
        if (closeButton) closeButton.IsEnabled(!busy);
        RenderTags();
    }

    void RenderTags() {
        if (!rows) return;
        rows.Children().Clear();
        editingBox = nullptr;
        auto weak = weak_from_this();
        for (const auto &tag : tags) {
            Grid row;
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Star});
            row.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Auto});

            StackPanel details;
            details.Orientation(Orientation::Horizontal);
            details.Spacing(8);
            if (editingId == tag.id) {
                TextBox editName;
                editName.Text(editingName);
                editName.MaxLength(20);
                editName.MinHeight(32);
                editName.Width(240);
                Automation::AutomationProperties::SetName(editName, Text(L"编辑标签名称", L"Edit tag name"));
                editName.TextChanged([weak](auto const &sender, auto const &) {
                    if (auto self = weak.lock()) {
                        self->editingName = std::wstring{sender.as<TextBox>().Text()};
                    }
                });
                editingBox = editName;
                details.Children().Append(editName);
                Button save = MakeButton(Text(L"保存", L"Save"), 62);
                save.IsEnabled(!busy);
                Automation::AutomationProperties::SetName(save, Text(L"保存标签名称", L"Save tag name"));
                save.Click([weak, id = tag.id](auto const &, auto const &) {
                    if (auto self = weak.lock()) self->UpdateTag(id);
                });
                details.Children().Append(save);
                Button cancel = MakeButton(Text(L"取消", L"Cancel"), 62);
                cancel.IsEnabled(!busy);
                cancel.Click([weak](auto const &, auto const &) {
                    if (auto self = weak.lock()) {
                        self->editingId.reset();
                        self->editingName.clear();
                        self->RenderTags();
                    }
                });
                details.Children().Append(cancel);
            } else if (confirmingDeleteId == tag.id) {
                TextBlock prompt = MakeText(Text(L"确定删除？", L"Delete this tag?"), 13);
                details.Children().Append(prompt);
                Button confirm = MakeButton(Text(L"删除", L"Delete"), 62);
                confirm.IsEnabled(!busy);
                Automation::AutomationProperties::SetName(confirm, Text(L"确认删除标签", L"Confirm delete tag"));
                confirm.Click([weak, id = tag.id](auto const &, auto const &) {
                    if (auto self = weak.lock()) self->Send(L"tagsDelete", id);
                });
                details.Children().Append(confirm);
                Button cancel = MakeButton(Text(L"取消", L"Cancel"), 62);
                cancel.IsEnabled(!busy);
                cancel.Click([weak](auto const &, auto const &) {
                    if (auto self = weak.lock()) {
                        self->confirmingDeleteId.reset();
                        self->RenderTags();
                    }
                });
                details.Children().Append(cancel);
            } else {
                TextBlock name = MakeText(winrt::hstring{tag.name}, 14, true);
                name.MaxWidth(300);
                StackPanel actions;
                actions.Orientation(Orientation::Horizontal);
                actions.Spacing(6);
                Button rename = MakeButton(Text(L"重命名", L"Rename"), 68);
                rename.IsEnabled(!busy);
                Automation::AutomationProperties::SetName(
                    rename, Text(L"重命名标签", L"Rename tag"));
                rename.Click([weak, id = tag.id, currentName = tag.name](auto const &, auto const &) {
                    if (auto self = weak.lock()) {
                        self->editingId = id;
                        self->editingName = currentName;
                        self->RenderTags();
                    }
                });
                actions.Children().Append(rename);
                Button remove = MakeButton(Text(L"删除", L"Delete"), 62);
                remove.IsEnabled(!busy);
                Automation::AutomationProperties::SetName(remove, Text(L"删除标签", L"Delete tag"));
                remove.Click([weak, id = tag.id](auto const &, auto const &) {
                    if (auto self = weak.lock()) {
                        self->confirmingDeleteId = id;
                        self->editingId.reset();
                        self->RenderTags();
                    }
                });
                actions.Children().Append(remove);
                Grid::SetColumn(actions, 1);
                row.Children().Append(name);
                row.Children().Append(actions);
                Border surface;
                surface.Child(row);
                surface.Padding(Thickness{10, 6, 10, 6});
                surface.CornerRadius(CornerRadius{8, 8, 8, 8});
                rows.Children().Append(surface);
                continue;
            }

            Grid::SetColumn(details, 0);
            Grid::SetColumnSpan(details, 2);
            row.Children().Append(details);
            Border surface;
            surface.Child(row);
            surface.Padding(Thickness{10, 6, 10, 6});
            surface.CornerRadius(CornerRadius{8, 8, 8, 8});
            rows.Children().Append(surface);
        }

        if (tags.empty()) {
            rows.Children().Append(MakeText(
                Text(L"还没有标签", L"No tags yet"), 13));
        }
        ApplyTheme();
    }

    void ApplyLanguage() {
        title.Text(Text(L"管理标签", L"Manage tags"));
        closeButton.Content(winrt::box_value(Text(L"关闭", L"Close")));
        Automation::AutomationProperties::SetName(
            closeButton, Text(L"关闭标签管理", L"Close tag manager"));
        addName.PlaceholderText(Text(L"输入标签名称", L"Enter a tag name"));
        Automation::AutomationProperties::SetName(addName, Text(L"新标签名称", L"New tag name"));
        add.Content(winrt::box_value(Text(L"添加", L"Add")));
        guidance.Text(Text(L"删除标签会从所有剪贴项中移除该标签。",
                            L"Deleting a tag removes it from all clipboard items."));
        if (!showError) {
            status.Text(busy ? Text(L"正在处理…", L"Working…") : Text(L"", L""));
        }
        RenderTags();
    }

    void ApplyTheme() {
        if (!root) return;
        const bool dark = IsDark();
        const auto primary = dark ? Solid(242, 244, 247) : Solid(37, 42, 48);
        const auto secondary = dark ? Solid(190, 197, 207) : Solid(100, 107, 115);
        const auto surface = dark ? Solid(34, 39, 47) : Solid(255, 255, 255);
        const auto border = dark ? Solid(58, 64, 73) : Solid(222, 226, 232);
        root.Background(dark ? Solid(23, 27, 34) : Solid(246, 247, 249));
        title.Foreground(primary);
        status.Foreground(showError ? Solid(196, 55, 55) : secondary);
        if (guidance) guidance.Foreground(secondary);
        const auto rowCount = rows.Children().Size();
        for (std::uint32_t index = 0; index < rowCount; ++index) {
            const auto rowBorder = rows.Children().GetAt(index).try_as<Border>();
            if (!rowBorder) {
                if (const auto message = rows.Children().GetAt(index).try_as<TextBlock>()) {
                    message.Foreground(secondary);
                }
                continue;
            }
            rowBorder.Background(surface);
            rowBorder.BorderBrush(border);
            const auto row = rowBorder.Child().try_as<Grid>();
            if (!row) {
                if (const auto message = rowBorder.Child().try_as<TextBlock>()) message.Foreground(secondary);
                continue;
            }
            for (std::uint32_t child = 0; child < row.Children().Size(); ++child) {
                const auto element = row.Children().GetAt(child);
                if (const auto text = element.try_as<TextBlock>()) text.Foreground(primary);
                if (const auto panel = element.try_as<StackPanel>()) {
                    for (std::uint32_t nested = 0; nested < panel.Children().Size(); ++nested) {
                        const auto text = panel.Children().GetAt(nested).try_as<TextBlock>();
                        if (text) {
                            const bool isDeletePrompt =
                                text.Text() == Text(L"确定删除？", L"Delete this tag?");
                            text.Foreground(isDeletePrompt ? Solid(196, 55, 55) : primary);
                        }
                    }
                }
            }
        }
    }

    void SetTags(JsonArray const &nextTags) {
        tags.clear();
        for (std::uint32_t index = 0; index < nextTags.Size(); ++index) {
            const auto item = nextTags.GetObjectAt(index);
            const auto id = static_cast<std::int64_t>(item.GetNamedNumber(L"id", 0));
            const auto name = item.GetNamedString(L"name", L"");
            if (id > 0 && !name.empty()) tags.push_back(Tag{id, std::wstring{name}});
        }
        busy = false;
        showError = false;
        status.Text(Text(L"", L""));
        if (pendingOperation == L"tagsCreate") addName.Text(L"");
        if (pendingOperation == L"tagsRename") {
            editingId.reset();
            editingName.clear();
        }
        if (pendingOperation == L"tagsDelete") confirmingDeleteId.reset();
        pendingOperation.clear();
        UpdateEnabled();
        RenderTags();
    }

    void Refresh() {
        Send(L"tagsList");
    }

    void SetError(const std::wstring &message) {
        busy = false;
        showError = true;
        pendingOperation.clear();
        status.Text(winrt::hstring{message});
        UpdateEnabled();
        RenderTags();
    }

    void SetLanguage(bool useEnglish) {
        english = useEnglish;
        ApplyLanguage();
        ApplyTheme();
    }

    void SetTheme(ElementTheme requestedTheme) {
        theme = requestedTheme;
        root.RequestedTheme(requestedTheme);
        ApplyTheme();
    }
};

TagManager::TagManager(RequestCallback request, CloseCallback close)
    : m_impl(std::make_shared<Impl>(std::move(request), std::move(close))) {
    m_impl->Build();
}

TagManager::~TagManager() = default;
TagManager::TagManager(TagManager &&) noexcept = default;
TagManager &TagManager::operator=(TagManager &&) noexcept = default;

FrameworkElement TagManager::Root() const {
    return m_impl ? m_impl->root : FrameworkElement{nullptr};
}

void TagManager::Refresh() {
    if (m_impl) m_impl->Refresh();
}

void TagManager::SetTags(JsonArray const &tags) {
    if (m_impl) m_impl->SetTags(tags);
}

void TagManager::SetError(const std::wstring &message) {
    if (m_impl) m_impl->SetError(message);
}

void TagManager::SetLanguage(bool english) {
    if (m_impl) m_impl->SetLanguage(english);
}

void TagManager::SetTheme(ElementTheme theme) {
    if (m_impl) m_impl->SetTheme(theme);
}

} // namespace vpaste::winui
