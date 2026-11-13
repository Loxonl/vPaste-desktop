#include <windows.h>
#undef GetCurrentTime
#include "WinUiRecordTagEditor.h"
#include "WinUiAppearance.h"
#include "WinUiNameEmoji.h"
#include <algorithm>
#include <utility>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.System.h>
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
TextBlock Label(winrt::hstring const &text, bool title = false) {
    TextBlock label; label.Text(text); label.TextWrapping(TextWrapping::Wrap);
    ApplyStyle(label, title ? L"VPaste.CompactTitle" : L"VPaste.Secondary");
    return label;
}
Button Action() {
    Button button; button.Height(CompactActionSize); button.MinWidth(64); button.FontSize(13);
    return button;
}
}

struct RecordTagEditor::Impl : std::enable_shared_from_this<RecordTagEditor::Impl> {
    Request request;
    Saved saved;
    Flyout flyout{nullptr};
    std::function<void()> returnFocus;
    StackPanel root{nullptr}, form{nullptr}, actions{nullptr}, confirmation{nullptr};
    TextBlock title{nullptr}, guidance{nullptr}, warning{nullptr};
    TextBox name{nullptr};
    Button emoji{nullptr}, save{nullptr}, cancel{nullptr}, remove{nullptr}, keep{nullptr}, confirmRemove{nullptr};
    InfoBar error{nullptr};
    std::int64_t tagId = 0;
    std::wstring originalName, hash, operation;
    std::uint64_t pending = 0;
    bool english = false, active = false, busy = false, confirming = false, createdForItem = false;

    Impl(Request send, Saved onSaved) : request(std::move(send)), saved(std::move(onSaved)) {}
    winrt::hstring Text(wchar_t const *zh, wchar_t const *en) const { return english ? en : zh; }
    void Language() {
        title.Text(confirming ? Text(L"删除标签？", L"Delete tag?") : tagId && !createdForItem
            ? Text(L"编辑标签", L"Edit tag") : hash.empty() ? Text(L"新增标签", L"New tag")
            : Text(L"新建并添加标签", L"Create and assign tag"));
        guidance.Text(hash.empty() ? Text(L"用于整理和筛选剪贴项。", L"Organize and filter clipboard items.")
            : Text(L"保存后添加到这条剪贴项。", L"Assign to this clipboard item after saving."));
        name.PlaceholderText(Text(L"标签名称", L"Tag name"));
        Automation::AutomationProperties::SetName(name, Text(L"标签名称", L"Tag name"));
        SetNameEmojiLanguage(emoji, english);
        save.Content(winrt::box_value(createdForItem ? Text(L"重试添加", L"Retry assignment") : Text(L"保存", L"Save")));
        cancel.Content(winrt::box_value(Text(L"取消", L"Cancel")));
        remove.Content(winrt::box_value(Text(L"删除…", L"Delete…")));
        keep.Content(winrt::box_value(Text(L"取消", L"Cancel")));
        confirmRemove.Content(winrt::box_value(Text(L"确认删除", L"Delete tag")));
        warning.Text(originalName + Text(L"\n不会删除剪贴板内容，但会从所有剪贴项中移除此标签。",
            L"\nClipboard content is kept. This tag will be removed from all items."));
    }
    void Enabled() {
        name.IsEnabled(!busy && !createdForItem);
        name.IsReadOnly(busy || createdForItem);
        emoji.IsEnabled(!busy && !createdForItem);
        save.IsEnabled(!busy); cancel.IsEnabled(!busy);
        keep.IsEnabled(!busy); confirmRemove.IsEnabled(!busy);
        remove.IsEnabled(!busy);
        remove.Visibility(tagId > 0 && !createdForItem ? Visibility::Visible : Visibility::Collapsed);
    }
    void Error(winrt::hstring const &message) {
        error.Message(message); error.IsOpen(!message.empty());
    }
    void Confirm(bool value) {
        if (busy || (value && (!tagId || createdForItem))) return;
        confirming = value;
        form.Visibility(value ? Visibility::Collapsed : Visibility::Visible);
        actions.Visibility(value ? Visibility::Collapsed : Visibility::Visible);
        confirmation.Visibility(value ? Visibility::Visible : Visibility::Collapsed);
        Error(L""); Language();
        if (root.IsLoaded()) (value ? keep : remove).Focus(FocusState::Programmatic);
    }
    void Send(wchar_t const *op) {
        if (!active || busy || !root.IsLoaded() || !request) return;
        Error(L"");
        JsonObject payload;
        if (tagId) payload.Insert(L"tagId", JsonValue::CreateNumberValue(static_cast<double>(tagId)));
        if (wcscmp(op, L"recordTagCreate") == 0 || wcscmp(op, L"recordTagRename") == 0)
            payload.Insert(L"name", JsonValue::CreateStringValue(name.Text()));
        if (wcscmp(op, L"recordTagAssign") == 0) payload.Insert(L"hash", JsonValue::CreateStringValue(hash));
        operation = op; busy = true; Enabled();
        try {
            pending = request(op, payload);
            if (!pending) winrt::throw_hresult(E_UNEXPECTED);
        } catch (winrt::hresult_error const &failure) {
            busy = false; pending = 0; Enabled(); Error(failure.message());
        }
    }
    void Save() {
        if (!active || busy || confirming) return;
        if (createdForItem) { Send(L"recordTagAssign"); return; }
        const std::wstring value{name.Text()};
        if (value.find_first_not_of(L" \t\r\n") == value.npos || (value.size() > 20 && value != originalName)) {
            Error(Text(L"请输入 1–20 个字符的标签名称", L"Use a tag name of 1–20 characters"));
            name.Focus(FocusState::Programmatic); return;
        }
        Send(tagId ? L"recordTagRename" : L"recordTagCreate");
    }
    void Hide() {
        active = false; pending = 0; busy = false;
        if (const auto previous = std::exchange(flyout, nullptr)) previous.Hide();
        if (const auto callback = std::exchange(returnFocus, {})) callback();
    }
    void Build(std::int64_t id, std::wstring const &text, std::wstring const &itemHash, bool useEnglish) {
        tagId = id; originalName = text; hash = itemHash; english = useEnglish;
        pending = 0; busy = false; confirming = false; createdForItem = false; active = true;
        root = StackPanel{}; root.Width(300); root.Spacing(12);
        title = Label(L"", true); root.Children().Append(title);
        form = StackPanel{}; form.Spacing(8);
        Grid nameRow; nameRow.ColumnSpacing(8);
        ColumnDefinition emojiColumn; emojiColumn.Width(GridLength{1, GridUnitType::Auto});
        nameRow.ColumnDefinitions().Append(emojiColumn); nameRow.ColumnDefinitions().Append(ColumnDefinition{});
        name = TextBox{}; name.FontSize(13); name.MinHeight(CompactActionSize);
        // Legacy tags can be longer than the current editor limit. Display them
        // intact; never truncate a saved name merely by opening the editor.
        name.MaxLength(static_cast<int>(std::max<std::size_t>(20, text.size()))); name.Text(text);
        emoji = NameEmojiButton(name, english); nameRow.Children().Append(emoji);
        Grid::SetColumn(name, 1); nameRow.Children().Append(name); form.Children().Append(nameRow);
        guidance = Label(L""); form.Children().Append(guidance); root.Children().Append(form);
        error = InfoBar{}; error.IsOpen(false); error.IsClosable(false); error.Severity(InfoBarSeverity::Error);
        root.Children().Append(error);
        actions = StackPanel{}; actions.Orientation(Orientation::Horizontal); actions.Spacing(8);
        actions.HorizontalAlignment(HorizontalAlignment::Right);
        remove = Action(); cancel = Action(); save = Action();
        save.Style(Application::Current().Resources().Lookup(winrt::box_value(L"AccentButtonStyle")).as<Style>());
        actions.Children().Append(remove); actions.Children().Append(cancel); actions.Children().Append(save);
        root.Children().Append(actions);
        confirmation = StackPanel{}; confirmation.Spacing(12); confirmation.Visibility(Visibility::Collapsed);
        warning = Label(L""); confirmation.Children().Append(warning);
        StackPanel confirmActions; confirmActions.Orientation(Orientation::Horizontal); confirmActions.Spacing(8);
        confirmActions.HorizontalAlignment(HorizontalAlignment::Right);
        keep = Action(); confirmRemove = Action();
        confirmActions.Children().Append(keep); confirmActions.Children().Append(confirmRemove);
        confirmation.Children().Append(confirmActions); root.Children().Append(confirmation);
        const auto weak = weak_from_this();
        save.Click([weak](auto const &sender, auto const &) { if (auto self = weak.lock(); self && sender == self->save) self->Save(); });
        cancel.Click([weak](auto const &sender, auto const &) { if (auto self = weak.lock(); self && sender == self->cancel) self->Hide(); });
        remove.Click([weak](auto const &sender, auto const &) { if (auto self = weak.lock(); self && sender == self->remove) self->Confirm(true); });
        keep.Click([weak](auto const &sender, auto const &) { if (auto self = weak.lock(); self && sender == self->keep) self->Confirm(false); });
        confirmRemove.Click([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && sender == self->confirmRemove && self->confirming) self->Send(L"recordTagDelete");
        });
        name.KeyDown([weak](auto const &sender, auto const &args) {
            if (static_cast<std::uint32_t>(args.OriginalKey()) == VK_PROCESSKEY) return;
            if (args.Key() == winrt::Windows::System::VirtualKey::Enter && !args.KeyStatus().WasKeyDown) {
                if (auto self = weak.lock(); self && sender == self->name) {
                    self->Save(); args.Handled(true);
                }
            }
        });
        root.Unloaded([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && sender == self->root) { self->active = false; self->pending = 0; self->busy = false; }
        });
        Language(); Enabled();
    }
};

RecordTagEditor::RecordTagEditor(Request request, Saved saved) : m_impl(std::make_shared<Impl>(std::move(request), std::move(saved))) {}
RecordTagEditor::~RecordTagEditor() {
    try { Hide(); }
    catch (winrt::hresult_error const &failure) { OutputDebugStringW(failure.message().c_str()); }
}
void RecordTagEditor::Show(FrameworkElement anchor, std::int64_t id, std::wstring const &name,
    std::wstring const &hash, bool english, ElementTheme theme, bool confirmDelete,
    FrameworkElement owner, std::function<void()> closed) {
    if (m_impl->busy) return;
    Hide(); m_impl->Build(id, name, hash, english); m_impl->root.RequestedTheme(theme);
    m_impl->returnFocus = std::move(closed);
    m_impl->flyout = Flyout{};
    m_impl->flyout.ShouldConstrainToRootBounds(false);
    m_impl->flyout.Placement(Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft);
    m_impl->flyout.Content(m_impl->root);
    const auto weak = std::weak_ptr<Impl>{m_impl};
    m_impl->flyout.Opened([weak, confirmDelete](auto const &sender, auto const &) {
        if (auto self = weak.lock(); self && sender == self->flyout) {
            if (confirmDelete) self->Confirm(true);
            else self->name.Focus(FocusState::Programmatic);
        }
    });
    m_impl->flyout.Closing([weak](auto const &sender, auto const &args) {
        if (auto self = weak.lock(); self && sender == self->flyout && self->active && self->busy) args.Cancel(true);
    });
    m_impl->flyout.Closed([weak](auto const &sender, auto const &) {
        if (auto self = weak.lock(); self && sender == self->flyout) self->Hide();
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
}
void RecordTagEditor::Receive(JsonObject const &response) {
    const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
    if (!m_impl->active || !m_impl->root.IsLoaded() || !id || id != m_impl->pending ||
        response.GetNamedString(L"op", L"") != m_impl->operation) return;
    m_impl->pending = 0; m_impl->busy = false;
    if (response.HasKey(L"error")) {
        m_impl->Enabled();
        m_impl->Error((m_impl->createdForItem ? m_impl->Text(L"标签已创建，但添加失败。重试不会重复创建。\n",
            L"Tag created, but assignment failed. Retry will not create another tag.\n") : winrt::hstring{}) + response.GetNamedString(L"error"));
        return;
    }
    if (m_impl->operation == L"recordTagCreate" || m_impl->operation == L"recordTagRename") {
        const auto tag = response.GetNamedObject(L"data").GetNamedObject(L"tag");
        m_impl->tagId = static_cast<std::int64_t>(tag.GetNamedNumber(L"id"));
        m_impl->originalName = tag.GetNamedString(L"name");
        if (m_impl->operation == L"recordTagCreate" && !m_impl->hash.empty()) {
            m_impl->createdForItem = true; m_impl->name.Text(m_impl->originalName);
            m_impl->Language(); m_impl->Send(L"recordTagAssign"); return;
        }
    }
    const auto operation = m_impl->operation;
    const auto tagId = m_impl->tagId;
    const auto name = m_impl->originalName;
    Hide();
    if (m_impl->saved) m_impl->saved(operation, tagId, name);
}
void RecordTagEditor::Hide() { if (m_impl) m_impl->Hide(); }
bool RecordTagEditor::IsOpen() const { return m_impl && m_impl->active; }
void RecordTagEditor::SetLanguage(bool english) { if (m_impl->root) { m_impl->english = english; m_impl->Language(); } }
void RecordTagEditor::SetTheme(ElementTheme theme) { if (m_impl->root) m_impl->root.RequestedTheme(theme); }
#ifdef _DEBUG
FrameworkElement RecordTagEditor::TestLoad(std::int64_t id, std::wstring const &name, std::wstring const &hash, bool english) {
    Hide(); m_impl->Build(id, name, hash, english); return m_impl->root;
}
void RecordTagEditor::TestSave() { m_impl->Save(); }
winrt::hstring RecordTagEditor::TestName() const { return m_impl->name.Text(); }
void RecordTagEditor::TestName(winrt::hstring const &name) { m_impl->name.Text(name); }
FrameworkElement RecordTagEditor::TestRoot() const { return m_impl->root; }

// Uses synthetic requests and real controls only; never touches the clipboard
// or the user's tag store. The caller owns this fixture on its XAML apartment.
winrt::Windows::Foundation::IAsyncAction TestRecordTagEditorControls(FrameworkElement host, std::uint32_t &stage) {
    const auto fixture = host.as<Border>();
    std::vector<JsonObject> requests;
    std::vector<std::pair<std::wstring, std::int64_t>> saved;
    RecordTagEditor editor{
        [&](std::wstring const &op, JsonObject payload) {
            payload.Insert(L"op", JsonValue::CreateStringValue(op));
            payload.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(requests.size() + 1)));
            requests.push_back(payload); return static_cast<std::uint64_t>(requests.size());
        },
        [&](std::wstring const &op, std::int64_t id, std::wstring const &) { saved.emplace_back(op, id); }};
    StackPanel root{nullptr};
    const auto mount = [&](std::int64_t id, std::wstring const &name, std::wstring const &hash, bool english = true) {
        root = editor.TestLoad(id, name, hash, english).as<StackPanel>(); fixture.Child(root);
    };
    const auto input = [&] { return root.Children().GetAt(1).as<StackPanel>().Children().GetAt(0).as<Grid>().Children().GetAt(1).as<TextBox>(); };
    const auto actions = [&] { return root.Children().GetAt(3).as<StackPanel>(); };
    const auto button = [&](int index) { return actions().Children().GetAt(index).as<Button>(); };
    const auto error = [&] { return root.Children().GetAt(2).as<InfoBar>(); };
    const auto invoke = [](FrameworkElement const &element) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(element)
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    const auto reply = [&](JsonObject const &request, JsonObject data, winrt::hstring const &failure = L"") {
        JsonObject response; response.Insert(L"id", request.GetNamedValue(L"id")); response.Insert(L"op", request.GetNamedValue(L"op"));
        if (failure.empty()) response.Insert(L"data", data);
        else response.Insert(L"error", JsonValue::CreateStringValue(failure));
        editor.Receive(response);
    };
    stage = 63;
    mount(0, L"", L"", false); co_await NextNativeFrame();
    winrt::check_hresult(editor.IsOpen() && input().IsLoaded() && input().MaxLength() == 20 ? S_OK : E_FAIL);
    invoke(button(2)); co_await NextNativeFrame();
    winrt::check_hresult(requests.empty() && error().IsOpen() ? S_OK : E_FAIL);
    input().Text(L"Keep this draft"); invoke(button(2)); co_await NextNativeFrame(); editor.TestSave();
    winrt::check_hresult(requests.size() == 1 && !button(2).IsEnabled() &&
        requests.back().GetNamedString(L"op") == L"recordTagCreate" && requests.back().GetNamedString(L"name") == L"Keep this draft" ? S_OK : E_FAIL);
    const auto firstRequest = requests.back();
    editor.Receive(JsonObject::Parse(LR"({"id":999,"op":"recordTagCreate","data":{"tag":{"id":9,"name":"Wrong"}}})"));
    auto wrongOperation = JsonObject::Parse(LR"({"op":"recordTagRename","error":"Wrong operation"})");
    wrongOperation.Insert(L"id", firstRequest.GetNamedValue(L"id")); editor.Receive(wrongOperation);
    winrt::check_hresult(!button(2).IsEnabled() && saved.empty() ? S_OK : E_FAIL);
    reply(firstRequest, JsonObject{}, L"Synthetic storage failure");
    winrt::check_hresult(error().IsOpen() && button(2).IsEnabled() && input().Text() == L"Keep this draft" ? S_OK : E_FAIL);
    invoke(button(1)); co_await NextNativeFrame();
    winrt::check_hresult(!editor.IsOpen() && requests.size() == 1 && saved.empty() ? S_OK : E_FAIL);

    stage = 64;
    mount(0, L"Work", L"captured-card"); co_await NextNativeFrame();
    invoke(button(2)); co_await NextNativeFrame();
    const auto create = requests.back();
    reply(create, JsonObject::Parse(LR"({"tag":{"id":9,"name":"Work"},"items":[{"id":9,"name":"Work"}]})"));
    const auto assignment = requests.back();
    winrt::check_hresult(requests.size() == 3 && assignment.GetNamedString(L"op") == L"recordTagAssign" &&
        assignment.GetNamedNumber(L"tagId") == 9 && assignment.GetNamedString(L"hash") == L"captured-card" && saved.empty() ? S_OK : E_FAIL);
    reply(assignment, JsonObject{}, L"Synthetic missing card");
    winrt::check_hresult(error().IsOpen() && input().IsReadOnly() && button(2).IsEnabled() &&
        !TryApplyNameEmoji(input(), L"📌") && std::wstring{error().Message()}.find(L"Tag created") != std::wstring::npos ? S_OK : E_FAIL);
    editor.TestSave(); editor.TestSave();
    winrt::check_hresult(requests.size() == 4 && requests.back().GetNamedString(L"op") == L"recordTagAssign" &&
        requests.back().GetNamedNumber(L"tagId") == 9 && requests.back().GetNamedString(L"hash") == L"captured-card" ? S_OK : E_FAIL);
    reply(requests.back(), JsonObject{});
    winrt::check_hresult(!editor.IsOpen() && saved.size() == 1 && saved.back() == std::pair<std::wstring, std::int64_t>{L"recordTagAssign", 9} ? S_OK : E_FAIL);

    stage = 65;
    mount(9, L"Work", L""); co_await NextNativeFrame(); input().Text(L"Old request"); editor.TestSave();
    const auto stale = requests.back(); editor.Hide();
    mount(9, L"Fresh draft", L""); co_await NextNativeFrame();
    reply(stale, JsonObject::Parse(LR"({"tag":{"id":9,"name":"Old request"}})"));
    winrt::check_hresult(editor.IsOpen() && input().Text() == L"Fresh draft" && saved.size() == 1 ? S_OK : E_FAIL);
    input().Text(L"Edited name"); invoke(button(2)); co_await NextNativeFrame();
    const auto rename = requests.back();
    winrt::check_hresult(rename.GetNamedString(L"op") == L"recordTagRename" && rename.GetNamedNumber(L"tagId") == 9 ? S_OK : E_FAIL);
    reply(rename, JsonObject{}, L"Synthetic rename failure");
    editor.SetLanguage(false); editor.SetTheme(ElementTheme::Dark); editor.SetLanguage(true);
    winrt::check_hresult(input().Text() == L"Edited name" && error().IsOpen() &&
        root.RequestedTheme() == ElementTheme::Dark && root.Children().GetAt(0).as<TextBlock>().Text() == L"Edit tag" ? S_OK : E_FAIL);
    invoke(button(1)); co_await NextNativeFrame();
    const auto beforeLegacy = requests.size(); const std::wstring legacy(32, L'x');
    mount(9, legacy, L""); co_await NextNativeFrame();
    winrt::check_hresult(input().Text() == legacy && input().MaxLength() == 32 ? S_OK : E_FAIL);
    invoke(button(1)); co_await NextNativeFrame();
    winrt::check_hresult(requests.size() == beforeLegacy ? S_OK : E_FAIL);

    stage = 66;
    mount(9, L"Work", L""); co_await NextNativeFrame(); input().Text(L"Unsaved name");
    const auto beforeDelete = requests.size();
    invoke(button(0)); co_await NextNativeFrame();
    const auto confirmation = root.Children().GetAt(4).as<StackPanel>();
    const auto confirmActions = confirmation.Children().GetAt(1).as<StackPanel>();
    const auto keep = confirmActions.Children().GetAt(0).as<Button>();
    const auto remove = confirmActions.Children().GetAt(1).as<Button>();
    winrt::check_hresult(confirmation.Visibility() == Visibility::Visible && requests.size() == beforeDelete &&
        winrt::unbox_value<winrt::hstring>(keep.Content()) == L"Cancel" &&
        std::wstring{confirmation.Children().GetAt(0).as<TextBlock>().Text()}.find(L"Clipboard content is kept") != std::wstring::npos ? S_OK : E_FAIL);
    invoke(keep); co_await NextNativeFrame();
    winrt::check_hresult(input().Text() == L"Unsaved name" && requests.size() == beforeDelete ? S_OK : E_FAIL);
    invoke(button(0)); co_await NextNativeFrame(); invoke(remove); co_await NextNativeFrame(); editor.TestSave();
    winrt::check_hresult(requests.size() == beforeDelete + 1 && !remove.IsEnabled() &&
        requests.back().GetNamedString(L"op") == L"recordTagDelete" && requests.back().GetNamedNumber(L"tagId") == 9 ? S_OK : E_FAIL);
    reply(requests.back(), JsonObject{}, L"Synthetic delete failure");
    winrt::check_hresult(error().IsOpen() && confirmation.Visibility() == Visibility::Visible && remove.IsEnabled() ? S_OK : E_FAIL);
    invoke(remove); co_await NextNativeFrame(); reply(requests.back(), JsonObject{});
    winrt::check_hresult(!editor.IsOpen() && saved.size() == 2 &&
        saved.back() == std::pair<std::wstring, std::int64_t>{L"recordTagDelete", 9} ? S_OK : E_FAIL);
    fixture.Child(nullptr);
}
#endif
}
