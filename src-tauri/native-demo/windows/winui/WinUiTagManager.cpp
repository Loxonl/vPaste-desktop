#include <windows.h>
#undef GetCurrentTime
#include "WinUiTagManager.h"
#include "WinUiAppearance.h"
#include "WinUiNameEmoji.h"

#include <algorithm>
#include <optional>
#include <utility>
#include <vector>

#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Text.h>

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
    block.VerticalAlignment(VerticalAlignment::Center);
    ApplyStyle(block, size < 14 ? L"VPaste.Secondary" : L"VPaste.Body");
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
    TextBlock count{nullptr};
    TextBlock status{nullptr};
    TextBlock guidance{nullptr};
    StackPanel emptyState{nullptr};
    InfoBar feedback{nullptr};
    Button add{nullptr};
    Button addEmoji{nullptr};
    Button closeButton{nullptr};
    ScrollViewer list{nullptr};
    std::vector<Tag> tags;
    TextBox editingBox{nullptr};
    std::optional<std::int64_t> editingId;
    std::wstring editingName;
    std::optional<std::int64_t> confirmingDeleteId;
    std::optional<std::int64_t> focusTagId;
    std::wstring deletingName;
    ContentDialog confirmation{nullptr};
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
        root.Padding(UniformThickness(ManagementInset));
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
        header.ColumnDefinitions().Append(ColumnDefinition{});
        header.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Auto});
        header.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Star});
        header.ColumnDefinitions().GetAt(2).Width(GridLength{1, GridUnitType::Auto});
        header.ColumnSpacing(8);
        header.MinHeight(40);
        title = MakeText(Text(L"管理标签", L"Manage tags"), 14, true);
        ApplyStyle(title, L"VPaste.CompactTitle");
        Grid::SetColumn(title, 1);
        header.Children().Append(title);
        closeButton = NamedIconButton(SymbolIcon{Symbol::Back}, Text(L"返回剪贴板", L"Back to clipboard"));
        auto weak = weak_from_this();
        closeButton.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) {
                if (!self->busy && self->close) self->close();
            }
        });
        header.Children().Append(closeButton);
        count = MakeText(L"", 12);
        Grid::SetColumn(count, 2);
        header.Children().Append(count);
        Grid::SetRow(header, 0);
        root.Children().Append(header);

        root.Unloaded([weak](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->confirmation) self->confirmation.Hide();
        });
        Grid addRow;
        addRow.ColumnSpacing(8);
        addRow.ColumnDefinitions().Append(ColumnDefinition{});
        addRow.ColumnDefinitions().Append(ColumnDefinition{});
        addRow.ColumnDefinitions().Append(ColumnDefinition{});
        addRow.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Auto});
        addRow.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Star});
        addRow.ColumnDefinitions().GetAt(2).Width(GridLength{1, GridUnitType::Auto});
        addRow.Margin(Thickness{0, 8, 0, 12});
        addName = TextBox{};
        addName.MaxLength(20);
        addName.MinHeight(32);
        addName.FontSize(13);
        addName.PlaceholderText(Text(L"输入标签名称", L"Enter a tag name"));
        addName.VerticalAlignment(VerticalAlignment::Center);
        addName.HorizontalAlignment(HorizontalAlignment::Stretch);
        Automation::AutomationProperties::SetName(addName, Text(L"新标签名称", L"New tag name"));
        addName.TextChanged([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock()) {
                self->add.IsEnabled(!self->busy && !sender.as<TextBox>().Text().empty());
            }
        });
        addName.KeyDown([weak](auto const &, auto const &args) {
            if (static_cast<std::uint32_t>(args.OriginalKey()) == VK_PROCESSKEY) return;
            if (args.Key() == winrt::Windows::System::VirtualKey::Enter && !args.KeyStatus().WasKeyDown) {
                if (auto self = weak.lock()) self->CreateTag();
                args.Handled(true);
            }
        });
        addEmoji = NameEmojiButton(addName, english);
        addRow.Children().Append(addEmoji);
        Grid::SetColumn(addName, 1);
        addRow.Children().Append(addName);
        add = MakeButton(Text(L"添加", L"Add"), 68);
        add.VerticalAlignment(VerticalAlignment::Bottom);
        add.Style(Application::Current().Resources().Lookup(winrt::box_value(L"AccentButtonStyle")).as<Style>());
        add.IsEnabled(false);
        Automation::AutomationProperties::SetName(add, Text(L"添加标签", L"Add tag"));
        add.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->CreateTag();
        });
        Grid::SetColumn(add, 2);
        addRow.Children().Append(add);
        Grid::SetRow(addRow, 1);
        root.Children().Append(addRow);

        list = ScrollViewer{};
        list.VerticalScrollMode(ScrollMode::Enabled);
        list.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        list.HorizontalScrollMode(ScrollMode::Disabled);
        list.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
        rows = StackPanel{};
        rows.Spacing(4);
        list.Content(rows);
        Grid::SetRow(list, 2);
        root.Children().Append(list);

        status = MakeText(L"", 12);
        feedback = InfoBar{};
        feedback.IsOpen(false);
        feedback.IsClosable(false);
        feedback.Margin(Thickness{0, 12, 0, 4});
        Grid::SetRow(feedback, 3);
        root.Children().Append(feedback);

        guidance = MakeText(
            Text(L"在剪贴项的操作菜单中添加标签，再从主面板按标签筛选。", L"Assign tags in an item's menu, then filter by tag in the main panel."),
            12);
        guidance.Margin(Thickness{0, 4, 0, 0});
        guidance.TextWrapping(TextWrapping::Wrap);
        Grid::SetRow(guidance, 4);
        root.Children().Append(guidance);
        emptyState = EmptyState(L"\uE8EC", Text(L"还没有标签", L"No tags yet"),
            Text(L"创建一个标签，让常用内容更容易找到。", L"Create a tag to keep frequently used items easy to find."));
        Grid::SetRow(emptyState, 2);
        root.Children().Append(emptyState);

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
        pendingOperation = operation;
        busy = true;
        showError = false;
        error = L"";
        status.Text(Text(L"正在处理…", L"Working…"));
        UpdateEnabled();
        try {
            if (!request(operation, id, name))
                SetError(std::wstring{Text(L"操作未能发送，请重试", L"Could not send this action; try again")});
        } catch (winrt::hresult_error const &failure) {
            SetError(std::wstring{failure.message()});
        }
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

    void CancelEdit() {
        focusTagId = editingId;
        editingId.reset();
        editingName.clear();
        RenderTags();
    }

    void LocalizeConfirmation() {
        if (!confirmation) return;
        confirmation.Title(winrt::box_value(Text(L"删除标签？", L"Delete tag?")));
        confirmation.Content(winrt::box_value(winrt::hstring{deletingName} + Text(
            L"\n不会删除剪贴板内容，但该标签会从所有剪贴项中移除。",
            L"\nClipboard content is kept; this tag is removed from all items.")));
        confirmation.PrimaryButtonText(Text(L"删除", L"Delete"));
        confirmation.CloseButtonText(Text(L"取消", L"Cancel"));
    }

    winrt::fire_and_forget ConfirmDelete(std::int64_t id, std::wstring name) {
        const auto lifetime = shared_from_this();
        if (busy || confirmingDeleteId || !root.IsLoaded()) co_return;
        confirmingDeleteId = id;
        deletingName = std::move(name);
        try {
            confirmation = MakeConfirmationDialog(root, L"", L"", L"", L"");
            LocalizeConfirmation();
            const auto result = co_await confirmation.ShowAsync();
            confirmation = nullptr;
            confirmingDeleteId.reset();
            deletingName.clear();
            if (root.IsLoaded() && result == ContentDialogResult::Primary && !busy &&
                std::any_of(tags.begin(), tags.end(), [id](const auto &tag) { return tag.id == id; })) {
                Send(L"tagsDelete", id);
            }
        } catch (const winrt::hresult_error &error) {
            confirmation = nullptr;
            confirmingDeleteId.reset();
            deletingName.clear();
            if (root.IsLoaded()) SetError(std::wstring{error.message()});
        }
    }

    void UpdateEnabled() {
        if (add) add.IsEnabled(!busy && !addName.Text().empty());
        if (addName) addName.IsEnabled(!busy);
        if (closeButton) closeButton.IsEnabled(!busy);
        if (confirmation) confirmation.IsPrimaryButtonEnabled(!busy && confirmingDeleteId &&
            std::any_of(tags.begin(), tags.end(), [this](const auto &tag) { return tag.id == *confirmingDeleteId; }));
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
            row.ColumnDefinitions().Append(ColumnDefinition{});
            row.ColumnDefinitions().GetAt(0).Width(GridLength{24, GridUnitType::Pixel});
            row.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Star});
            row.ColumnDefinitions().GetAt(2).Width(GridLength{1, GridUnitType::Auto});
            row.ColumnSpacing(8);

            Grid details;
            details.ColumnSpacing(8);
            for (int column = 0; column < 3; ++column) {
                ColumnDefinition definition;
                definition.Width(GridLength{1, column == 0 ? GridUnitType::Star : GridUnitType::Auto});
                details.ColumnDefinitions().Append(definition);
            }
            if (editingId == tag.id) {
                ColumnDefinition emojiColumn; emojiColumn.Width(GridLength{1, GridUnitType::Auto});
                details.ColumnDefinitions().InsertAt(0, emojiColumn);
                TextBox editName;
                editName.Text(editingName);
                editName.MaxLength(20);
                editName.MinHeight(32);
                editName.FontSize(13);
                editName.IsEnabled(!busy);
                Automation::AutomationProperties::SetName(editName, Text(L"编辑标签名称", L"Edit tag name"));
                editName.TextChanged([weak](auto const &sender, auto const &) {
                    if (auto self = weak.lock()) {
                        self->editingName = std::wstring{sender.as<TextBox>().Text()};
                    }
                });
                editName.Loaded([weak, id = tag.id](auto const &sender, auto const &) {
                    if (auto self = weak.lock(); self && !self->busy && self->editingId == id) {
                        sender.as<TextBox>().Focus(FocusState::Programmatic);
                    }
                });
                editName.KeyDown([weak, id = tag.id](auto const &, auto const &args) {
                    if (static_cast<std::uint32_t>(args.OriginalKey()) == VK_PROCESSKEY) return;
                    if (auto self = weak.lock(); self && !self->busy && !args.KeyStatus().WasKeyDown) {
                        if (args.Key() == winrt::Windows::System::VirtualKey::Enter) {
                            self->UpdateTag(id);
                            args.Handled(true);
                        } else if (args.Key() == winrt::Windows::System::VirtualKey::Escape) {
                            self->CancelEdit();
                            args.Handled(true);
                        }
                    }
                });
                editingBox = editName;
                details.Children().Append(NameEmojiButton(editName, english));
                Grid::SetColumn(editName, 1);
                details.Children().Append(editName);
                Button save = NamedIconButton(SymbolIcon{Symbol::Accept}, Text(L"保存标签名称", L"Save tag name"));
                save.IsEnabled(!busy);
                save.Click([weak, id = tag.id](auto const &, auto const &) {
                    if (auto self = weak.lock()) self->UpdateTag(id);
                });
                Grid::SetColumn(save, 2);
                details.Children().Append(save);
                Button cancel = NamedIconButton(SymbolIcon{Symbol::Cancel}, Text(L"取消重命名", L"Cancel rename"));
                cancel.IsEnabled(!busy);
                cancel.Click([weak](auto const &, auto const &) {
                    if (auto self = weak.lock()) {
                        self->CancelEdit();
                    }
                });
                Grid::SetColumn(cancel, 3);
                details.Children().Append(cancel);
            } else {
                TextBlock name = MakeText(winrt::hstring{tag.name}, 14, true);
                name.MaxLines(2);
                name.TextWrapping(TextWrapping::Wrap);
                StackPanel actions;
                actions.Orientation(Orientation::Horizontal);
                actions.Spacing(6);
                actions.VerticalAlignment(VerticalAlignment::Center);
                Button rename = NamedIconButton(SymbolIcon{Symbol::Edit}, Text(L"重命名标签", L"Rename tag"));
                rename.IsEnabled(!busy);
                rename.Click([weak, id = tag.id, currentName = tag.name](auto const &, auto const &) {
                    if (auto self = weak.lock()) {
                        self->editingId = id;
                        self->editingName = currentName;
                        self->RenderTags();
                        if (self->editingBox) self->editingBox.SelectAll();
                    }
                });
                rename.Loaded([weak, id = tag.id](auto const &sender, auto const &) {
                    if (auto self = weak.lock(); self && self->focusTagId == id &&
                        sender.as<Button>().Focus(FocusState::Programmatic)) {
                        self->focusTagId.reset();
                    }
                });
                actions.Children().Append(rename);
                Button remove = NamedIconButton(SymbolIcon{Symbol::Delete}, Text(L"删除标签", L"Delete tag"));
                remove.IsEnabled(!busy);
                remove.Click([weak, id = tag.id, name = tag.name](auto const &, auto const &) {
                    if (auto self = weak.lock()) {
                        self->ConfirmDelete(id, name);
                    }
                });
                actions.Children().Append(remove);
                Grid::SetColumn(name, 1);
                Grid::SetColumn(actions, 2);
                row.Children().Append(name);
                row.Children().Append(actions);
                row.Children().Append(Glyph(L"\uE8EC"));
                Border surface;
                surface.Child(row);
                surface.Padding(Thickness{8, 4, 8, 4});
                surface.CornerRadius(UniformRadius(ManagementRowRadius));
                surface.BorderThickness(Thickness{1, 1, 1, 1});
                surface.MinHeight(42);
                ApplyStyle(surface, L"VPaste.Surface");
                rows.Children().Append(surface);
                continue;
            }

            Grid::SetColumn(details, 0);
            Grid::SetColumnSpan(details, 3);
            row.Children().Append(details);
            Border surface;
            surface.Child(row);
            surface.Padding(Thickness{8, 4, 8, 4});
            surface.CornerRadius(UniformRadius(ManagementRowRadius));
            surface.BorderThickness(Thickness{1, 1, 1, 1});
            surface.MinHeight(42);
            ApplyStyle(surface, L"VPaste.SelectedSurface");
            rows.Children().Append(surface);
        }

        emptyState.Visibility(tags.empty() ? Visibility::Visible : Visibility::Collapsed);
        list.Visibility(tags.empty() ? Visibility::Collapsed : Visibility::Visible);
        count.Text(winrt::hstring{std::to_wstring(tags.size())} + Text(L" 个标签", L" tags"));
        ApplyTheme();
    }

    void ApplyLanguage() {
        title.Text(Text(L"管理标签", L"Manage tags"));
        NameIconButton(closeButton, Text(L"返回剪贴板", L"Back to clipboard"));
        LocalizeConfirmation();
        addName.PlaceholderText(Text(L"输入标签名称", L"Enter a tag name"));
        SetNameEmojiLanguage(addEmoji, english);
        Automation::AutomationProperties::SetName(addName, Text(L"新标签名称", L"New tag name"));
        add.Content(winrt::box_value(Text(L"添加", L"Add")));
        guidance.Text(Text(L"在剪贴项的操作菜单中添加标签，再从主面板按标签筛选。",
                            L"Assign tags in an item's menu, then filter by tag in the main panel."));
        emptyState.Children().GetAt(1).as<TextBlock>().Text(Text(L"还没有标签", L"No tags yet"));
        emptyState.Children().GetAt(2).as<TextBlock>().Text(Text(L"创建一个标签，让常用内容更容易找到。",
            L"Create a tag to keep frequently used items easy to find."));
        if (!showError) {
            status.Text(busy ? Text(L"正在处理…", L"Working…") : Text(L"", L""));
        }
        RenderTags();
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
            focusTagId = editingId;
            editingId.reset();
            editingName.clear();
        }
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
