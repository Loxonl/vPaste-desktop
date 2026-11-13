#include <windows.h>
#undef GetCurrentTime
#include "WinUiFilterEditor.h"
#include "WinUiAppearance.h"
#include "WinUiNameEmoji.h"
#include "WinUiRichContent.h"

#include <algorithm>
#include <cwctype>
#include <set>
#include <utility>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.Foundation.Collections.h>
#ifdef _DEBUG
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Windows::Data::Json;

namespace {
winrt::hstring String(const JsonObject &object, const wchar_t *key, const wchar_t *fallback = L"") {
    const auto value = object.GetNamedValue(key, nullptr);
    return value && value.ValueType() == JsonValueType::String ? value.GetString() : winrt::hstring{fallback};
}
JsonObject Object(const JsonObject &object, const wchar_t *key) {
    const auto value = object.GetNamedValue(key, nullptr);
    return value && value.ValueType() == JsonValueType::Object ? value.GetObject() : JsonObject{};
}
TextBlock Label(const winrt::hstring &text, bool title = false) {
    TextBlock label;
    label.Text(text);
    label.TextWrapping(TextWrapping::Wrap);
    ApplyStyle(label, title ? L"VPaste.CompactTitle" : L"VPaste.Secondary");
    return label;
}
Button Action(const winrt::hstring &text) {
    Button button;
    button.Content(winrt::box_value(text));
    button.Height(32);
    button.MinWidth(64);
    button.FontSize(13);
    return button;
}
std::wstring Lower(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(), [](wchar_t c) { return std::towlower(c); });
    return value;
}
}

struct FilterEditor::Impl : std::enable_shared_from_this<FilterEditor::Impl> {
    struct App { std::wstring source; std::wstring icon; };
    Request request;
    Saved saved;
    Flyout flyout{nullptr};
    std::function<void()> returnFocus;
    Grid root{nullptr};
    StackPanel form{nullptr}, sourceRows{nullptr}, confirmation{nullptr}, actions{nullptr};
    TextBox name{nullptr}, amount{nullptr}, sourceSearch{nullptr};
    ComboBox type{nullptr}, favorite{nullptr}, unit{nullptr};
    TextBlock sourceLabel{nullptr}, error{nullptr};
    Button save{nullptr}, cancel{nullptr}, remove{nullptr}, keep{nullptr}, confirmRemove{nullptr};
    JsonObject draft;
    std::wstring originalName, operation;
    std::vector<App> apps;
    std::set<std::wstring> selectedSources;
    std::uint64_t pending = 0, sourcesRequest = 0;
    bool english = false, busy = false, active = false;
    static constexpr const wchar_t *types[] = {L"", L"Text", L"Image", L"File", L"Link", L"Color"};
    static constexpr const wchar_t *units[] = {L"minute", L"hour", L"day", L"week", L"month"};
    Impl(Request r, Saved s) : request(std::move(r)), saved(std::move(s)) {}

    void Hide() {
        active = false; pending = 0; sourcesRequest = 0; busy = false;
        if (const auto previous = std::exchange(flyout, nullptr)) previous.Hide();
        if (const auto callback = std::exchange(returnFocus, {})) callback();
    }

    winrt::hstring Text(const wchar_t *zh, const wchar_t *en) const { return english ? en : zh; }
    void SetError(const winrt::hstring &message) {
        error.Text(message);
        error.Visibility(message.empty() ? Visibility::Collapsed : Visibility::Visible);
    }
    void SetFormEnabled(bool value) {
        for (const auto &input : {name, amount, sourceSearch}) input.IsEnabled(value);
        for (const auto &choice : {type, favorite, unit}) choice.IsEnabled(value);
        for (const auto &row : sourceRows.Children()) if (const auto control = row.try_as<Control>()) control.IsEnabled(value);
    }
    void SetBusy(bool value) {
        busy = value;
        SetFormEnabled(!value && confirmation.Visibility() == Visibility::Collapsed);
        for (const auto &button : {save, cancel, remove, keep, confirmRemove}) button.IsEnabled(!value);
    }
    ComboBox Choice(const winrt::hstring &header, const std::vector<winrt::hstring> &labels, int selected) {
        ComboBox control;
        control.Header(winrt::box_value(header));
        control.HorizontalAlignment(HorizontalAlignment::Stretch);
        control.MinHeight(32);
        control.FontSize(13);
        Automation::AutomationProperties::SetName(control, header);
        for (const auto &label : labels) control.Items().Append(winrt::box_value(label));
        control.SelectedIndex(selected);
        return control;
    }
    TextBox Input(const winrt::hstring &header) {
        TextBox input;
        input.Header(winrt::box_value(header));
        input.MinHeight(32);
        input.FontSize(13);
        Automation::AutomationProperties::SetName(input, header);
        return input;
    }
    void SourceSummary() {
        sourceLabel.Text(selectedSources.empty() ? Text(L"来源应用 · 不限", L"Source apps · Any")
            : Text(L"来源应用 · 已选 ", L"Source apps · Selected ") + winrt::to_hstring(selectedSources.size()));
    }
    void RenderSources() {
        sourceRows.Children().Clear();
        const auto search = Lower(std::wstring{sourceSearch.Text()});
        auto weak = weak_from_this();
        for (const auto &app : apps) {
            if (!search.empty() && Lower(app.source).find(search) == std::wstring::npos) continue;
            CheckBox check;
            check.IsEnabled(!busy && confirmation.Visibility() == Visibility::Collapsed);
            check.MinHeight(36);
            check.HorizontalAlignment(HorizontalAlignment::Stretch);
            check.HorizontalContentAlignment(HorizontalAlignment::Stretch);
            check.IsChecked(selectedSources.count(app.source) > 0);
            Automation::AutomationProperties::SetName(check, winrt::hstring{app.source});
            StackPanel content;
            content.Orientation(Orientation::Horizontal);
            content.Spacing(8);
            if (!app.icon.empty()) {
                try {
                    Image image;
                    image.Width(20); image.Height(20);
                    image.Source(Media::Imaging::BitmapImage{LocalAssetUri(winrt::hstring{app.icon})});
                    content.Children().Append(image);
                } catch (const winrt::hresult_error &) { /* Label remains usable for an invalid cached icon. */ }
            }
            const auto separator = app.source.find_last_of(L"/\\");
            const auto display = separator == std::wstring::npos ? app.source : app.source.substr(separator + 1);
            auto label = Label(winrt::hstring{display});
            ApplyStyle(label, L"VPaste.Body"); label.FontSize(13);
            label.MaxWidth(228);
            label.TextWrapping(TextWrapping::NoWrap);
            label.TextTrimming(TextTrimming::CharacterEllipsis);
            content.Children().Append(label);
            check.Content(content);
            ToolTipService::SetToolTip(check, winrt::box_value(app.source));
            check.Checked([weak, source = app.source](auto const &, auto const &) {
                if (auto self = weak.lock()) { self->selectedSources.insert(source); self->SourceSummary(); }
            });
            check.Unchecked([weak, source = app.source](auto const &, auto const &) {
                if (auto self = weak.lock()) { self->selectedSources.erase(source); self->SourceSummary(); }
            });
            sourceRows.Children().Append(check);
        }
        if (sourceRows.Children().Size() == 0)
            sourceRows.Children().Append(Label(Text(L"没有匹配的近期应用", L"No matching recent apps")));
        SourceSummary();
    }
    void ConfirmDelete(bool confirm) {
        if (!active || busy) return;
        confirmation.Visibility(confirm ? Visibility::Visible : Visibility::Collapsed);
        actions.Visibility(confirm ? Visibility::Collapsed : Visibility::Visible);
        SetFormEnabled(!confirm);
        if (confirm) keep.Focus(FocusState::Programmatic);
        else remove.Focus(FocusState::Programmatic);
    }
    void Send(const wchar_t *operation, JsonObject payload) {
        if (!active || busy || !request) return;
        SetError(L"");
        SetBusy(true);
        this->operation = operation;
        try {
            pending = request(operation, payload);
            if (!pending) winrt::throw_hresult(E_UNEXPECTED);
        } catch (const winrt::hresult_error &failure) {
            pending = 0; SetBusy(false); SetError(failure.message());
        }
    }
    void Save() {
        if (!active || busy || confirmation.Visibility() == Visibility::Visible) return;
        const auto text = std::wstring{name.Text()};
        if (text.find_first_not_of(L" \t\r\n") == std::wstring::npos || (text.size() > 20 && text != originalName)) {
            SetError(Text(L"请输入 1–20 个字符的筛选名称", L"Use a filter name of 1–20 characters")); name.Focus(FocusState::Programmatic); return;
        }
        // Clone rather than mutate the active tab before persistence succeeds.
        auto next = JsonObject::Parse(draft.Stringify());
        next.Insert(L"name", JsonValue::CreateStringValue(name.Text()));
        auto filter = Object(next, L"filter");
        filter.Insert(L"itemType", JsonValue::CreateStringValue(types[std::max(0, type.SelectedIndex())]));
        constexpr const wchar_t *favorites[] = {L"any", L"yes", L"no"};
        filter.Insert(L"favorite", JsonValue::CreateStringValue(favorites[std::max(0, favorite.SelectedIndex())]));
        filter.Insert(L"relativeAmount", JsonValue::CreateStringValue(amount.Text()));
        filter.Insert(L"relativeUnit", JsonValue::CreateStringValue(units[std::max(0, unit.SelectedIndex())]));
        JsonArray sources;
        for (const auto &source : selectedSources) sources.Append(JsonValue::CreateStringValue(source));
        filter.Insert(L"appSources", sources);
        filter.Insert(L"appSource", JsonValue::CreateStringValue(L""));
        next.Insert(L"filter", filter);
        JsonObject payload; payload.Insert(L"tab", next);
        Send(L"filtersSave", payload);
    }
    void Delete() {
        if (!active || busy || confirmation.Visibility() != Visibility::Visible) return;
        JsonObject payload; payload.Insert(L"tabId", JsonValue::CreateStringValue(String(draft, L"id")));
        Send(L"filtersDelete", payload);
    }
    void Build(JsonObject value, bool useEnglish) {
        english = useEnglish; draft = JsonObject::Parse(value.Stringify());
        pending = 0; sourcesRequest = 0; busy = false; active = true; apps.clear(); selectedSources.clear();
        originalName = String(draft, L"name");
        const auto filter = Object(draft, L"filter");
        const auto rawSources = filter.GetNamedValue(L"appSources", nullptr);
        if (rawSources && rawSources.ValueType() == JsonValueType::Array) {
            for (const auto &source : rawSources.GetArray())
                if (source.ValueType() == JsonValueType::String && !source.GetString().empty()) selectedSources.insert(std::wstring{source.GetString()});
        } else if (!String(filter, L"appSource").empty()) selectedSources.insert(std::wstring{String(filter, L"appSource")});
        for (const auto &source : selectedSources) apps.push_back({source, {}});

        root = Grid{}; root.Width(320); root.MaxHeight(508); root.RowSpacing(8);
        for (int i = 0; i < 5; ++i) { RowDefinition row; row.Height(GridLength{1, i == 1 ? GridUnitType::Star : GridUnitType::Auto}); root.RowDefinitions().Append(row); }
        auto title = Label(String(draft, L"id").empty() ? Text(L"新增筛选标签", L"New filter tab") : Text(L"编辑筛选标签", L"Edit filter tab"), true);
        root.Children().Append(title);
        form = StackPanel{}; form.Spacing(12);
        name = Input(Text(L"名称", L"Name"));
        name.MaxLength(static_cast<int>(std::max<std::size_t>(20, originalName.size()))); name.Text(originalName);
        name.Header(nullptr);
        StackPanel nameGroup; nameGroup.Spacing(4);
        auto nameLabel = Label(Text(L"名称", L"Name")); ApplyStyle(nameLabel, L"VPaste.Body"); nameLabel.FontSize(13);
        nameGroup.Children().Append(nameLabel);
        Grid nameRow; nameRow.ColumnSpacing(8);
        ColumnDefinition emojiColumn; emojiColumn.Width(GridLength{1, GridUnitType::Auto});
        nameRow.ColumnDefinitions().Append(emojiColumn); nameRow.ColumnDefinitions().Append(ColumnDefinition{});
        nameRow.Children().Append(NameEmojiButton(name, english));
        Grid::SetColumn(name, 1); nameRow.Children().Append(name); nameGroup.Children().Append(nameRow); form.Children().Append(nameGroup);
        Grid conditions; conditions.ColumnSpacing(12);
        for (int i = 0; i < 2; ++i) conditions.ColumnDefinitions().Append(ColumnDefinition{});
        int typeIndex = 0, unitIndex = 2;
        for (int i = 0; i < 6; ++i) if (String(filter, L"itemType") == types[i]) typeIndex = i;
        for (int i = 0; i < 5; ++i) if (String(filter, L"relativeUnit") == units[i]) unitIndex = i;
        type = Choice(Text(L"内容类型", L"Content type"), {Text(L"不限", L"Any"), Text(L"文本", L"Text"), Text(L"图片", L"Image"), Text(L"文件", L"File"), Text(L"链接", L"Link"), Text(L"颜色", L"Color")}, typeIndex);
        const auto fav = String(filter, L"favorite");
        favorite = Choice(Text(L"收藏状态", L"Favorites"), {Text(L"不限", L"Any"), Text(L"仅收藏", L"Only favorites"), Text(L"未收藏", L"Not favorites")}, fav == L"yes" ? 1 : fav == L"no" ? 2 : 0);
        conditions.Children().Append(type); Grid::SetColumn(favorite, 1); conditions.Children().Append(favorite);
        form.Children().Append(conditions);
        Grid time; time.ColumnSpacing(12);
        for (int i = 0; i < 2; ++i) time.ColumnDefinitions().Append(ColumnDefinition{});
        amount = Input(Text(L"最近时间范围", L"Within the last")); amount.MaxLength(20);
        amount.PlaceholderText(Text(L"不限", L"Any time")); amount.Text(String(filter, L"relativeAmount"));
        unit = Choice(Text(L"单位", L"Unit"), {Text(L"分钟", L"Minutes"), Text(L"小时", L"Hours"), Text(L"天", L"Days"), Text(L"周", L"Weeks"), Text(L"月", L"Months")}, unitIndex);
        time.Children().Append(amount); Grid::SetColumn(unit, 1); time.Children().Append(unit); form.Children().Append(time);
        sourceLabel = Label(L"", true); form.Children().Append(sourceLabel);
        sourceSearch = TextBox{}; sourceSearch.MinHeight(32); sourceSearch.FontSize(13);
        sourceSearch.PlaceholderText(Text(L"筛选近 7 天的来源应用", L"Find source apps from the last 7 days"));
        Automation::AutomationProperties::SetName(sourceSearch, Text(L"筛选来源应用", L"Find source apps"));
        auto weak = weak_from_this();
        sourceSearch.TextChanged([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && self->active && sender == self->sourceSearch) self->RenderSources();
        });
        form.Children().Append(sourceSearch);
        ScrollViewer sourceList; sourceList.MaxHeight(144); sourceList.HorizontalScrollMode(ScrollMode::Disabled);
        sourceList.VerticalScrollMode(ScrollMode::Enabled); sourceList.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        sourceList.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
        sourceRows = StackPanel{}; sourceList.Content(sourceRows); form.Children().Append(sourceList);
        ScrollViewer scroll; scroll.MaxHeight(400); scroll.HorizontalScrollMode(ScrollMode::Disabled);
        scroll.VerticalScrollMode(ScrollMode::Enabled); scroll.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        scroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled); scroll.Content(form);
        Grid::SetRow(scroll, 1); root.Children().Append(scroll);
        error = Label(L""); error.Visibility(Visibility::Collapsed); Grid::SetRow(error, 2); root.Children().Append(error);
        confirmation = StackPanel{}; confirmation.Spacing(8); confirmation.Visibility(Visibility::Collapsed);
        confirmation.Children().Append(Label(Text(L"删除此筛选标签？剪贴板历史不会被删除。", L"Delete this filter tab? Clipboard history will be kept.")));
        StackPanel confirmActions; confirmActions.Orientation(Orientation::Horizontal); confirmActions.Spacing(8);
        keep = Action(Text(L"取消", L"Cancel"));
        keep.Click([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->ConfirmDelete(false); });
        confirmActions.Children().Append(keep);
        confirmRemove = Action(Text(L"确认删除", L"Delete filter"));
        confirmRemove.Click([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->Delete(); });
        confirmActions.Children().Append(confirmRemove); confirmation.Children().Append(confirmActions);
        Grid::SetRow(confirmation, 3); root.Children().Append(confirmation);
        actions = StackPanel{}; actions.Orientation(Orientation::Horizontal); actions.Spacing(8); actions.HorizontalAlignment(HorizontalAlignment::Right);
        remove = Action(Text(L"删除", L"Delete")); remove.Visibility(String(draft, L"id").empty() ? Visibility::Collapsed : Visibility::Visible);
        remove.Click([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && sender == self->remove) self->ConfirmDelete(true);
        }); actions.Children().Append(remove);
        cancel = Action(Text(L"取消", L"Cancel"));
        cancel.Click([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && !self->busy && sender == self->cancel) self->Hide();
        }); actions.Children().Append(cancel);
        save = Action(Text(L"保存", L"Save"));
        save.Style(Application::Current().Resources().Lookup(winrt::box_value(L"AccentButtonStyle")).as<Style>());
        save.Click([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && sender == self->save) self->Save();
        }); actions.Children().Append(save);
        Grid::SetRow(actions, 4); root.Children().Append(actions);
        root.Unloaded([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && sender == self->root) self->Hide();
        });
        RenderSources();
    }
};

FilterEditor::FilterEditor(Request request, Saved saved) : m_impl(std::make_shared<Impl>(std::move(request), std::move(saved))) {}
FilterEditor::~FilterEditor() {
    try { Hide(); }
    catch (const winrt::hresult_error &error) { OutputDebugStringW(error.message().c_str()); }
}
void FilterEditor::Show(FrameworkElement anchor, JsonObject draft, bool english, ElementTheme theme, bool confirmDelete,
    FrameworkElement owner, std::function<void()> closed) {
    if (m_impl->busy) return;
    Hide(); m_impl->Build(draft, english); m_impl->root.RequestedTheme(theme);
    m_impl->returnFocus = std::move(closed);
    m_impl->flyout = Flyout{};
    m_impl->flyout.ShouldConstrainToRootBounds(false);
    m_impl->flyout.Placement(Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft);
    m_impl->flyout.Content(m_impl->root);
    m_impl->flyout.Closed([weak = std::weak_ptr<Impl>{m_impl}](auto const &sender, auto const &) {
        if (const auto self = weak.lock(); self && sender == self->flyout) self->Hide();
    });
    m_impl->flyout.Closing([weak = std::weak_ptr<Impl>{m_impl}](auto const &sender, auto const &args) {
        if (const auto self = weak.lock(); self && sender == self->flyout && self->active && self->busy) args.Cancel(true);
    });
    m_impl->flyout.Opened([weak = std::weak_ptr<Impl>{m_impl}, confirmDelete](auto const &sender, auto const &) {
        if (const auto self = weak.lock(); self && sender == self->flyout) {
            if (confirmDelete) self->ConfirmDelete(true);
            else self->name.Focus(FocusState::Programmatic);
        }
    });
    if (owner) {
        const auto bounds = anchor.TransformToVisual(owner).TransformBounds(
            {0, 0, static_cast<float>(anchor.ActualWidth()), static_cast<float>(anchor.ActualHeight())});
        Controls::Primitives::FlyoutShowOptions options;
        options.Placement(Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft);
        options.Position(winrt::box_value(winrt::Windows::Foundation::Point{bounds.X, bounds.Y})
            .as<winrt::Windows::Foundation::IReference<winrt::Windows::Foundation::Point>>());
        m_impl->flyout.ShowAt(owner, options);
    } else m_impl->flyout.ShowAt(anchor);
    if (m_impl->request) m_impl->sourcesRequest = m_impl->request(L"filterSources", JsonObject{});
}
void FilterEditor::Receive(JsonObject response) {
    if (!m_impl->active) return;
    const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
    const auto operation = String(response, L"op");
    if (id && id == m_impl->sourcesRequest && operation == L"filterSources") {
        m_impl->sourcesRequest = 0;
        if (response.HasKey(L"error")) { m_impl->SetError(String(response, L"error")); return; }
        const auto sources = response.GetNamedObject(L"data").GetNamedArray(L"sources");
        m_impl->apps.clear();
        std::set<std::wstring> seen;
        for (const auto &value : sources) {
            const auto option = value.GetObject(); const auto source = std::wstring{String(option, L"source")};
            if (!source.empty() && seen.insert(source).second) m_impl->apps.push_back({source, std::wstring{String(option, L"icon_path")}});
        }
        for (const auto &source : m_impl->selectedSources) if (seen.insert(source).second) m_impl->apps.push_back({source, {}});
        m_impl->RenderSources();
    } else if (id && id == m_impl->pending && operation == m_impl->operation) {
        m_impl->pending = 0; m_impl->SetBusy(false);
        if (response.HasKey(L"error")) { m_impl->SetError(String(response, L"error")); return; }
        const auto items = response.GetNamedObject(L"data").GetNamedArray(L"items");
        Hide();
        if (m_impl->saved) m_impl->saved(items);
    }
}
void FilterEditor::Hide() {
    if (m_impl) m_impl->Hide();
}
bool FilterEditor::IsOpen() const { return m_impl && m_impl->active; }
void FilterEditor::SetTheme(ElementTheme theme) { if (m_impl->root) m_impl->root.RequestedTheme(theme); }
#ifdef _DEBUG
FrameworkElement FilterEditor::TestLoad(JsonObject draft, bool english) {
    Hide(); m_impl->Build(draft, english);
    if (m_impl->request) m_impl->sourcesRequest = m_impl->request(L"filterSources", JsonObject{});
    return m_impl->root;
}
void FilterEditor::TestName(const winrt::hstring &name) { m_impl->name.Text(name); }
winrt::hstring FilterEditor::TestName() const { return m_impl->name.Text(); }
void FilterEditor::TestSave() { m_impl->Save(); }
void FilterEditor::TestDelete(bool confirm) { if (confirm) m_impl->Delete(); else m_impl->ConfirmDelete(true); }

winrt::Windows::Foundation::IAsyncAction TestFilterEditorControls(FrameworkElement host, std::uint32_t &stage) {
    const auto fixture = host.as<Border>();
    std::vector<JsonObject> requests;
    int saved = 0;
    FilterEditor editor{
        [&](std::wstring const &op, JsonObject payload) {
            payload.Insert(L"op", JsonValue::CreateStringValue(op));
            payload.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(requests.size() + 1)));
            requests.push_back(payload); return static_cast<std::uint64_t>(requests.size());
        },
        [&](JsonArray const &) { ++saved; }};
    auto draft = JsonObject::Parse(LR"({"id":"saved","name":"Work","filter":{"appSources":["Absent app"]}})");
    Grid root{nullptr};
    const auto mount = [&] { root = editor.TestLoad(draft, true).as<Grid>(); fixture.Child(root); };
    const auto actions = [&] { return root.Children().GetAt(4).as<StackPanel>(); };
    const auto invoke = [](FrameworkElement const &element) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(element)
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    const auto reply = [&](JsonObject const &request, wchar_t const *op, wchar_t const *error = L"") {
        JsonObject response; response.Insert(L"id", request.GetNamedValue(L"id"));
        response.Insert(L"op", JsonValue::CreateStringValue(op));
        if (*error) response.Insert(L"error", JsonValue::CreateStringValue(error));
        else response.Insert(L"data", JsonObject::Parse(LR"({"items":[{"id":"saved","name":"Saved"}]})"));
        editor.Receive(response);
    };

    stage = 85;
    const std::wstring legacy(32, L'x'); draft.Insert(L"name", JsonValue::CreateStringValue(legacy));
    mount(); co_await NextNativeFrame();
    winrt::check_hresult(editor.TestName() == legacy ? S_OK : E_FAIL);
    editor.Hide(); draft.Insert(L"name", JsonValue::CreateStringValue(L"Work"));

    stage = 86;
    mount(); co_await NextNativeFrame(); editor.TestName(L"Changed"); editor.TestSave();
    const auto save = requests.back(); const auto count = requests.size();
    reply(save, L"filtersDelete"); editor.TestSave();
    winrt::check_hresult(saved == 0 && requests.size() == count && editor.TestName() == L"Changed" ? S_OK : E_FAIL);
    reply(save, L"filtersSave", L"Synthetic write failure");
    winrt::check_hresult(root.Children().GetAt(2).as<TextBlock>().Text() == L"Synthetic write failure" &&
        editor.TestName() == L"Changed" && actions().Children().GetAt(2).as<Button>().IsEnabled() ? S_OK : E_FAIL);
    editor.TestSave(); editor.TestSave();
    winrt::check_hresult(requests.size() == count + 1 ? S_OK : E_FAIL);
    const auto abandoned = requests.back(); editor.Hide(); reply(abandoned, L"filtersSave");
    winrt::check_hresult(saved == 0 ? S_OK : E_FAIL);
    mount(); co_await NextNativeFrame(); editor.TestName(L"Fresh draft");
    reply(abandoned, L"filtersSave");
    winrt::check_hresult(editor.TestName() == L"Fresh draft" && saved == 0 ? S_OK : E_FAIL);
    editor.TestSave(); const auto accepted = requests.back(); reply(accepted, L"filtersSave"); reply(accepted, L"filtersSave");
    winrt::check_hresult(saved == 1 ? S_OK : E_FAIL);

    stage = 87;
    mount(); co_await NextNativeFrame();
    const auto beforeCancel = requests.size(); invoke(actions().Children().GetAt(1).as<Button>()); co_await NextNativeFrame();
    editor.TestSave(); winrt::check_hresult(requests.size() == beforeCancel ? S_OK : E_FAIL);
    stage = 871;
    mount(); co_await NextNativeFrame(); editor.TestSave(); const auto unloaded = requests.back();
    fixture.Child(nullptr);
    for (int frame = 0; frame < 30 && editor.IsOpen(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(!root.IsLoaded() && !editor.IsOpen() ? S_OK : E_FAIL);
    reply(unloaded, L"filtersSave");
    winrt::check_hresult(saved == 1 ? S_OK : E_FAIL);
    editor.Hide();
}
#endif
} // namespace vpaste::winui
