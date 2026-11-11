#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <objbase.h>

// Avoid the Win32 macro colliding with WinUI Storyboard.GetCurrentTime.
#undef GetCurrentTime

#include <winrt/Microsoft.UI.h>
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Microsoft.UI.Interop.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Hosting.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Microsoft.UI.Xaml.Markup.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Microsoft.UI.Xaml.XamlTypeInfo.h>
#include <winrt/Microsoft.UI.Text.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Xaml.Interop.h>

#include "WinUiQueueView.h"
#include "WinUiTagManager.h"

#include <chrono>
#include <algorithm>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {

using VisibilityChanged = void(__cdecl *)(bool);
using PanelRequest = void(__cdecl *)(const std::uint8_t *, std::size_t);

// Supply WinUI's standard control templates and XAML metadata to the island.
struct XamlApplication : winrt::Microsoft::UI::Xaml::ApplicationT<
                             XamlApplication,
                             winrt::Microsoft::UI::Xaml::Markup::IXamlMetadataProvider> {
    winrt::Microsoft::UI::Xaml::Markup::IXamlType GetXamlType(
        winrt::Windows::UI::Xaml::Interop::TypeName const &type) {
        return metadata.GetXamlType(type);
    }

    winrt::Microsoft::UI::Xaml::Markup::IXamlType GetXamlType(
        winrt::hstring const &name) {
        return metadata.GetXamlType(name);
    }

    winrt::com_array<winrt::Microsoft::UI::Xaml::Markup::XmlnsDefinition>
    GetXmlnsDefinitions() {
        return metadata.GetXmlnsDefinitions();
    }

private:
    winrt::Microsoft::UI::Xaml::XamlTypeInfo::XamlControlsXamlMetaDataProvider metadata;
};

constexpr wchar_t kWindowClass[] = L"VPasteWinUiExperimentWindow";
constexpr int kWindowWidth = 980;
constexpr int kWindowHeight = 600;
constexpr UINT kShowWindow = WM_APP + 1;
constexpr UINT kHideWindow = WM_APP + 2;
constexpr UINT kToggleWindow = WM_APP + 3;
constexpr UINT kStopWindow = WM_APP + 4;
constexpr UINT kPanelResponse = WM_APP + 5;
constexpr UINT kRefreshHistory = WM_APP + 6;
constexpr UINT kSetTheme = WM_APP + 7;
constexpr UINT kSetLanguage = WM_APP + 8;
constexpr UINT kSetClickMode = WM_APP + 9;
constexpr UINT kRefreshTags = WM_APP + 10;
constexpr UINT kSetQueueView = WM_APP + 11;
constexpr UINT kShowQueueNoActivate = WM_APP + 12;
constexpr UINT kHideForQueuePaste = WM_APP + 13;

struct HistoryRowVisual {
    winrt::Microsoft::UI::Xaml::Controls::Border surface{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border header{nullptr};
    winrt::hstring itemType;
    winrt::Microsoft::UI::Xaml::Controls::Image image{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock type{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock preview{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock source{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock tags{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock dimensions{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock favorite{nullptr};
    std::vector<std::int64_t> tagIds;
};

struct Panel {
    HWND window = nullptr;
    winrt::Microsoft::UI::Xaml::Controls::Grid root{nullptr};
    winrt::Microsoft::UI::Xaml::Hosting::WindowsXamlManager xamlManager{nullptr};
    winrt::Microsoft::UI::Xaml::Hosting::DesktopWindowXamlSource xamlSource{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBox search{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::RadioButtons filter{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ComboBox tagFilter{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ListView history{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock status{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button copy{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button paste{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button favorite{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button queueSelect{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button queueAdd{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button queueOpen{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button manageTags{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button more{nullptr};
    std::unique_ptr<vpaste::winui::QueueView> queueView;
    std::unique_ptr<vpaste::winui::TagManager> tagManager;
    bool tagManagerViewActive = false;
    std::vector<HistoryRowVisual> rows;
    std::vector<bool> cardRequested;
};

Panel g_panel;
winrt::Microsoft::UI::Dispatching::DispatcherQueueController g_dispatcher{nullptr};
std::mutex g_stateMutex;
std::condition_variable g_stateChanged;
std::thread g_uiThread;
HRESULT g_startResult = E_PENDING;
bool g_startFinished = false;
VisibilityChanged g_visibilityChanged = nullptr;
PanelRequest g_request = nullptr;
bool g_english = false;
bool g_singleClickPaste = true;
bool g_updatingLanguage = false;
bool g_updatingTagFilter = false;
bool g_queueSelectionMode = false;
bool g_queueViewActive = false;
bool g_queueReturnVisible = false;
bool g_queueWasTopmost = false;
bool g_deleteConfirmationOpen = false;
std::uint32_t g_themeMode = 0;
std::uint64_t g_requestId = 0;
std::uint64_t g_latestQueryId = 0;
std::uint64_t g_latestHistoryRequestId = 0;
std::uint64_t g_latestTagsRequestId = 0;
std::uint64_t g_latestTagManagerRequestId = 0;
std::vector<std::wstring> g_hashes;
std::wstring g_selectedHash;
std::vector<std::wstring> g_queueSelectedHashes;
std::vector<bool> g_favorites;
std::vector<std::int64_t> g_tagIds;
std::vector<std::wstring> g_tagNames;
std::int64_t g_selectedTagId = 0;
std::wstring g_selectedTagName;
std::uint64_t g_nextId = 0;
std::uint64_t g_nextTime = 0;
bool g_hasMore = false;
winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer g_searchTimer{nullptr};

winrt::hstring Text(const wchar_t *chinese, const wchar_t *english) {
    return g_english ? winrt::hstring{english} : winrt::hstring{chinese};
}

const wchar_t *FilterValue(int index) {
    switch (index) {
    case 1: return L"favorite";
    case 2: return L"Text";
    case 3: return L"Image";
    case 4: return L"Link";
    case 5: return L"Color";
    case 6: return L"File";
    default: return L"all";
    }
}

bool RebuildTagFilter();
void RequestHistory();
void SetTagManagerActive(bool active);

winrt::Windows::UI::Color Rgb(std::uint8_t red, std::uint8_t green, std::uint8_t blue) {
    winrt::Windows::UI::Color color{};
    color.A = 255;
    color.R = red;
    color.G = green;
    color.B = blue;
    return color;
}

winrt::Microsoft::UI::Xaml::Media::Brush Brush(std::uint8_t red, std::uint8_t green,
                                               std::uint8_t blue) {
    return winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{Rgb(red, green, blue)};
}

winrt::Microsoft::UI::Xaml::Media::Brush TypeBrush(const winrt::hstring &type) {
    if (type == L"Image") return Brush(230, 126, 34);
    if (type == L"File" || type == L"TextFile") return Brush(0, 150, 136);
    if (type == L"Link") return Brush(47, 111, 237);
    if (type == L"Color") return Brush(33, 150, 243);
    return Brush(67, 160, 71);
}

winrt::hstring FileUri(std::wstring path) {
    std::replace(path.begin(), path.end(), L'\\', L'/');
    return winrt::hstring{L"file:///" + path};
}

bool IsDarkTheme() {
    return g_themeMode == 2 ||
           (g_themeMode == 0 && g_panel.root &&
            g_panel.root.ActualTheme() == winrt::Microsoft::UI::Xaml::ElementTheme::Dark);
}

void UpdateFavoriteButton() {
    if (!g_panel.history || !g_panel.favorite) return;
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
    const auto index = found == g_hashes.end()
        ? g_favorites.size()
        : static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
    const bool selected = !g_queueSelectionMode && !g_selectedHash.empty() &&
                          found != g_hashes.end() && index < g_favorites.size();
    g_panel.favorite.IsEnabled(selected);
    if (selected) {
        g_panel.favorite.Content(winrt::box_value(g_favorites[index]
            ? Text(L"取消收藏", L"Remove favorite")
            : Text(L"收藏", L"Add favorite")));
    } else {
        g_panel.favorite.Content(winrt::box_value(Text(L"收藏", L"Add favorite")));
    }
}

void ApplyRowTheme() {
    const bool dark = IsDarkTheme();
    const auto primary = dark ? Brush(242, 244, 247) : Brush(37, 42, 48);
    const auto secondary = dark ? Brush(190, 197, 207) : Brush(100, 107, 115);
    const auto normal = dark ? Brush(36, 40, 46) : Brush(255, 255, 255);
    const auto selected = dark ? Brush(36, 78, 116) : Brush(220, 238, 255);
    if (g_panel.root) g_panel.root.Background(dark ? Brush(23, 27, 34) : Brush(246, 247, 249));
    if (g_panel.history) g_panel.history.Background(nullptr);
    if (g_panel.status) g_panel.status.Foreground(secondary);
    for (std::size_t index = 0; index < g_panel.rows.size(); ++index) {
        auto &row = g_panel.rows[index];
        const bool isSelected = index < g_hashes.size() && (g_queueSelectionMode
            ? std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), g_hashes[index]) !=
                  g_queueSelectedHashes.end()
            : g_hashes[index] == g_selectedHash);
        row.surface.Background(isSelected ? selected : normal);
        row.surface.BorderBrush(dark ? Brush(58, 64, 73) : Brush(222, 226, 232));
        row.header.Background(TypeBrush(row.itemType));
        row.type.Foreground(Brush(255, 255, 255));
        row.preview.Foreground(primary);
        row.source.Foreground(secondary);
        row.favorite.Foreground(dark ? Brush(255, 205, 86) : Brush(123, 84, 0));
    }
}

winrt::Microsoft::UI::Xaml::Controls::TextBlock MakeText(const winrt::hstring &text,
                                                          double size) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    TextBlock block;
    block.Text(text);
    block.FontSize(size);
    block.TextWrapping(TextWrapping::Wrap);
    return block;
}

std::uint64_t SendRequest(const wchar_t *operation, const std::wstring &hash = {},
                          bool favorite = false, std::int64_t tagId = 0,
                          const std::vector<std::wstring> &hashes = {},
                          const std::wstring &name = {}) {
    if (g_request == nullptr) {
        return 0;
    }
    using namespace winrt::Windows::Data::Json;
    JsonObject request;
    const auto id = ++g_requestId;
    request.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
    request.Insert(L"op", JsonValue::CreateStringValue(operation));
    if (wcscmp(operation, L"query") == 0) {
        request.Insert(L"query", JsonValue::CreateStringValue(
                                      g_panel.search ? g_panel.search.Text() : L""));
        request.Insert(L"filter", JsonValue::CreateStringValue(
                                        FilterValue(g_panel.filter ? g_panel.filter.SelectedIndex() : 0)));
        request.Insert(L"tagName", JsonValue::CreateStringValue(g_selectedTagName));
    } else if (wcscmp(operation, L"queryMore") == 0) {
        request.Insert(L"query", JsonValue::CreateStringValue(
                                      g_panel.search ? g_panel.search.Text() : L""));
        request.Insert(L"filter", JsonValue::CreateStringValue(
                                        FilterValue(g_panel.filter ? g_panel.filter.SelectedIndex() : 0)));
        request.Insert(L"tagName", JsonValue::CreateStringValue(g_selectedTagName));
        request.Insert(L"lastId", JsonValue::CreateNumberValue(static_cast<double>(g_nextId)));
        request.Insert(L"lastTime", JsonValue::CreateNumberValue(static_cast<double>(g_nextTime)));
    }
    if (!hash.empty()) {
        request.Insert(L"hash", JsonValue::CreateStringValue(hash));
    }
    if (wcscmp(operation, L"favorite") == 0) {
        request.Insert(L"favorite", JsonValue::CreateBooleanValue(favorite));
    }
    if (wcscmp(operation, L"assignTag") == 0 || wcscmp(operation, L"removeTag") == 0) {
        request.Insert(L"tagId", JsonValue::CreateNumberValue(static_cast<double>(tagId)));
    }
    if (wcscmp(operation, L"tagsCreate") == 0 || wcscmp(operation, L"tagsRename") == 0) {
        request.Insert(L"name", JsonValue::CreateStringValue(name));
    }
    if (wcscmp(operation, L"tagsRename") == 0 || wcscmp(operation, L"tagsDelete") == 0) {
        request.Insert(L"tagId", JsonValue::CreateNumberValue(static_cast<double>(tagId)));
    }
    if (wcscmp(operation, L"queueAdd") == 0 ||
        wcscmp(operation, L"queueReorder") == 0) {
        JsonArray selectedHashes;
        for (const auto &selectedHash : hashes) {
            selectedHashes.Append(JsonValue::CreateStringValue(selectedHash));
        }
        request.Insert(L"hashes", selectedHashes);
    }
    const auto bytes = winrt::to_string(request.Stringify());
    g_request(reinterpret_cast<const std::uint8_t *>(bytes.data()), bytes.size());
    return id;
}

bool IsQueueOperation(const winrt::hstring &operation) {
    return operation == L"queueState" || operation == L"queueStateUpdate" ||
           operation == L"queueAdd" || operation == L"queueRemove" ||
           operation == L"queueReorder" || operation == L"queueReverse" ||
           operation == L"queueClear" || operation == L"queuePaste" ||
           operation == L"queueUndo" || operation == L"queueOpen" ||
           operation == L"queueClose";
}

bool IsTagManagerOperation(const winrt::hstring &operation) {
    return operation == L"tagsList" || operation == L"tagsCreate" ||
           operation == L"tagsRename" || operation == L"tagsDelete";
}

std::uint64_t SendTagManagerRequest(const std::wstring &operation, std::int64_t tagId,
                                   const std::wstring &name) {
    g_latestTagManagerRequestId = SendRequest(operation.c_str(), {}, false, tagId, {}, name);
    return g_latestTagManagerRequestId;
}

void RefreshTags() {
    g_latestTagsRequestId = SendRequest(L"tags");
}

bool RebuildTagFilter() {
    if (!g_panel.tagFilter) return false;
    g_updatingTagFilter = true;
    g_panel.tagFilter.Items().Clear();
    g_panel.tagFilter.Items().Append(winrt::box_value(Text(L"全部标签", L"All tags")));
    int selectedIndex = 0;
    std::wstring selectedName;
    for (std::size_t index = 0; index < g_tagNames.size(); ++index) {
        g_panel.tagFilter.Items().Append(winrt::box_value(g_tagNames[index]));
        if (g_tagIds[index] == g_selectedTagId) {
            selectedIndex = static_cast<int>(index + 1);
            selectedName = g_tagNames[index];
        }
    }
    const bool selectedTagRemoved = g_selectedTagId != 0 && selectedIndex == 0;
    const bool selectedTagRenamed = !selectedName.empty() && selectedName != g_selectedTagName;
    if (selectedTagRemoved) {
        g_selectedTagId = 0;
        g_selectedTagName.clear();
    } else if (!selectedName.empty()) {
        g_selectedTagName = std::move(selectedName);
    }
    g_panel.tagFilter.SelectedIndex(selectedIndex);
    g_updatingTagFilter = false;
    const bool selectionChanged = selectedTagRemoved || selectedTagRenamed;
    if (selectionChanged) RequestHistory();
    return selectionChanged;
}

void RequestHistory() {
    g_latestQueryId = SendRequest(L"query");
    g_latestHistoryRequestId = g_latestQueryId;
    g_nextId = 0;
    g_nextTime = 0;
    g_hasMore = false;
    g_panel.more.IsEnabled(false);
}
void RequestMoreHistory() {
    if (g_hasMore) {
        g_panel.more.IsEnabled(false);
        g_latestHistoryRequestId = SendRequest(L"queryMore");
    }
}

void RequestSelectedAction(const wchar_t *operation) {
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
    if (g_queueSelectionMode) {
        if (g_panel.status) {
            g_panel.status.Text(Text(L"请先退出队列选择模式", L"Exit queue selection mode first"));
        }
        return;
    }
    if (g_selectedHash.empty() || found == g_hashes.end()) {
        if (g_panel.status) {
            g_panel.status.Text(Text(L"请先选择一个剪贴项", L"Select a clipboard item first"));
        }
        return;
    }
    const auto selected = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
    if (wcscmp(operation, L"favorite") == 0) {
        if (selected < g_favorites.size()) {
            SendRequest(operation, g_hashes[selected], !g_favorites[selected]);
        }
        return;
    }
    SendRequest(operation, g_hashes[selected]);
}

bool IsEditableTextItem(const winrt::hstring &type) {
    return type == L"Text" || type == L"TextFile" || type == L"Link" ||
           type == L"Color";
}

void UpdateQueueSelectionControls() {
    if (!g_panel.history || !g_panel.copy || !g_panel.paste || !g_panel.favorite ||
        !g_panel.queueSelect || !g_panel.queueAdd) return;
    g_panel.copy.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
        : winrt::Microsoft::UI::Xaml::Visibility::Visible);
    g_panel.paste.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
        : winrt::Microsoft::UI::Xaml::Visibility::Visible);
    g_panel.favorite.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
        : winrt::Microsoft::UI::Xaml::Visibility::Visible);
    g_panel.queueAdd.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Visible
        : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    g_panel.queueSelect.Content(winrt::box_value(g_queueSelectionMode
        ? Text(L"取消选择", L"Cancel selection")
        : Text(L"选择加入队列", L"Select for queue")));
    g_panel.queueAdd.IsEnabled(g_queueSelectionMode && !g_queueSelectedHashes.empty());
    g_panel.copy.IsEnabled(!g_queueSelectionMode && !g_selectedHash.empty());
    g_panel.paste.IsEnabled(!g_queueSelectionMode && !g_selectedHash.empty());
    UpdateFavoriteButton();
}

void ToggleQueueSelectionMode(bool updateStatus = true) {
    if (!g_panel.history) return;
    // SelectedItems is mutable only in a multi-selection mode. Clear the old
    // mode first so synchronous SelectionChanged also observes that old mode.
    if (g_panel.history.SelectionMode() ==
        winrt::Microsoft::UI::Xaml::Controls::ListViewSelectionMode::Single) {
        g_panel.history.SelectedIndex(-1);
    } else {
        g_panel.history.SelectedItems().Clear();
    }
    g_queueSelectionMode = !g_queueSelectionMode;
    g_queueSelectedHashes.clear();
    g_selectedHash.clear();
    g_panel.history.SelectionMode(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Controls::ListViewSelectionMode::Multiple
        : winrt::Microsoft::UI::Xaml::Controls::ListViewSelectionMode::Single);
    if (!g_queueSelectionMode) {
        g_panel.history.SelectedIndex(-1);
        g_selectedHash.clear();
    }
    if (updateStatus && g_panel.status) {
        if (g_queueSelectionMode) {
            g_panel.status.Text(std::to_wstring(g_queueSelectedHashes.size()) + L" " +
                Text(L"条已选择", L"selected"));
        } else {
            const auto suffix = g_hasMore ? L"+" : L"";
            g_panel.status.Text(std::to_wstring(g_hashes.size()) + suffix + L" " +
                Text(L"条剪贴项", L"clipboard items"));
        }
    }
    UpdateQueueSelectionControls();
    ApplyRowTheme();
}

void AddSelectedItemsToQueue() {
    if (!g_queueSelectionMode || g_queueSelectedHashes.empty()) return;
    g_panel.queueAdd.IsEnabled(false);
    if (SendRequest(L"queueAdd", {}, false, 0, g_queueSelectedHashes) == 0) {
        g_panel.queueAdd.IsEnabled(true);
    }
}

winrt::fire_and_forget ConfirmDeleteItem(std::wstring hash) {
    if (g_deleteConfirmationOpen || !g_panel.root) co_return;
    g_deleteConfirmationOpen = true;
    try {
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        ContentDialog dialog;
        dialog.XamlRoot(g_panel.root.XamlRoot());
        dialog.Title(winrt::box_value(Text(L"删除剪贴板记录", L"Delete clipboard record")));
        dialog.Content(winrt::box_value(Text(
            L"此操作无法撤销。确定要删除这条记录吗？",
            L"This action cannot be undone. Delete this record?")));
        dialog.PrimaryButtonText(Text(L"删除", L"Delete"));
        dialog.CloseButtonText(Text(L"取消", L"Cancel"));
        dialog.DefaultButton(ContentDialogButton::Close);
        const auto result = co_await dialog.ShowAsync();
        g_deleteConfirmationOpen = false;
        if (result == ContentDialogResult::Primary) {
            (void)SendRequest(L"delete", hash);
        }
    } catch (...) {
        g_deleteConfirmationOpen = false;
        if (g_panel.status) {
            g_panel.status.Text(Text(L"无法打开删除确认窗口", L"Could not open delete confirmation"));
        }
    }
}

void ConfirmDeleteSelectedItem() {
    if (g_queueSelectionMode || g_selectedHash.empty() ||
        std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash) == g_hashes.end()) {
        return;
    }
    (void)ConfirmDeleteItem(g_selectedHash);
}

void EditSelectedItem() {
    if (g_queueSelectionMode || g_selectedHash.empty()) return;
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
    if (found == g_hashes.end()) return;
    const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
    if (index < g_panel.rows.size() && IsEditableTextItem(g_panel.rows[index].itemType)) {
        (void)SendRequest(L"edit", g_selectedHash);
    }
}

winrt::hstring ItemTypeLabel(const winrt::hstring &type) {
    if (type == L"Image") return Text(L"图片", L"Image");
    if (type == L"File") return Text(L"文件", L"File");
    if (type == L"TextFile") return Text(L"文本文件", L"Text file");
    if (type == L"Link") return Text(L"链接", L"Link");
    if (type == L"Color") return Text(L"颜色", L"Color");
    return Text(L"文本", L"Text");
}

void ApplyResponse(const std::string &bytes) {
    try {
        using namespace winrt::Windows::Data::Json;
        const auto response = JsonObject::Parse(winrt::to_hstring(bytes));
        const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
        const auto operation = response.GetNamedString(L"op", L"");
        if ((operation == L"query" || operation == L"queryMore") &&
            id < g_latestHistoryRequestId) {
            return;
        }
        if (operation == L"card" && id < g_latestQueryId) return;
        if (operation == L"tags" && id < g_latestTagsRequestId) return;
        if (IsTagManagerOperation(operation)) {
            if (id < g_latestTagManagerRequestId || !g_panel.tagManager) return;
            if (response.HasKey(L"error")) {
                g_panel.tagManager->SetError(
                    std::wstring{response.GetNamedString(L"error")});
            } else {
                const auto data = response.GetNamedObject(L"data");
                g_panel.tagManager->SetTags(data.GetNamedArray(L"items"));
            }
            return;
        }
        if (IsQueueOperation(operation)) {
            if (response.HasKey(L"error")) {
                const auto message = response.GetNamedString(L"error");
                if (g_panel.queueView && operation != L"queueOpen" && operation != L"queueClose") {
                    g_panel.queueView->SetError(std::wstring(message));
                }
                if (g_panel.status) g_panel.status.Text(message);
                if (operation == L"queueAdd" && g_panel.queueAdd) {
                    g_panel.queueAdd.IsEnabled(g_queueSelectionMode && !g_queueSelectedHashes.empty());
                }
                return;
            }
            if (g_panel.queueView && operation != L"queueOpen" && operation != L"queueClose") {
                g_panel.queueView->SetState(response.GetNamedObject(L"data"));
            }
            if (operation == L"queueAdd") {
                g_panel.status.Text(Text(L"已加入粘贴队列", L"Added to paste queue"));
                if (g_queueSelectionMode) ToggleQueueSelectionMode(false);
            }
            return;
        }
        if (response.HasKey(L"error")) {
            g_panel.status.Text(response.GetNamedString(L"error"));
            if (operation == L"query") {
                g_panel.history.Items().Clear();
                g_hashes.clear();
                g_selectedHash.clear();
                g_queueSelectedHashes.clear();
                g_favorites.clear();
                g_panel.rows.clear();
                g_panel.cardRequested.clear();
                g_hasMore = false;
                g_panel.more.IsEnabled(false);
                UpdateQueueSelectionControls();
                ApplyRowTheme();
            } else if (operation == L"queryMore") {
                g_panel.more.IsEnabled(g_hasMore);
            }
            if (operation == L"queueAdd" && g_panel.queueAdd) {
                g_panel.queueAdd.IsEnabled(g_queueSelectionMode && !g_queueSelectedHashes.empty());
            }
            return;
        }
        const auto data = response.GetNamedObject(L"data");
        if (operation == L"tags") {
            g_tagNames.clear();
            g_tagIds.clear();
            const auto items = data.GetNamedArray(L"items");
            for (std::uint32_t index = 0; index < items.Size(); ++index) {
                const auto tag = items.GetObjectAt(index);
                const auto name = tag.GetNamedString(L"name", L"");
                const auto id = static_cast<std::int64_t>(tag.GetNamedNumber(L"id", 0));
                if (!name.empty() && id > 0) {
                    g_tagIds.push_back(id);
                    g_tagNames.emplace_back(name);
                }
            }
            if (!RebuildTagFilter()) RequestHistory();
            return;
        }
        if (operation == L"card") {
            const auto hash = std::wstring(data.GetNamedString(L"hash", L""));
            const auto found = std::find(g_hashes.begin(), g_hashes.end(), hash);
            if (found == g_hashes.end()) return;
            const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
            if (index >= g_panel.rows.size()) return;
            auto &row = g_panel.rows[index];
            const auto detail = data.GetNamedString(L"displayText", L"");
            if (!detail.empty()) row.preview.Text(detail);
            const auto dimensions = data.GetNamedString(L"dimensions", L"");
            row.dimensions.Text(dimensions);
            row.dimensions.Visibility(dimensions.empty()
                                          ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                                          : winrt::Microsoft::UI::Xaml::Visibility::Visible);
            const auto assetPath = data.GetNamedString(L"assetPath", L"");
            if (!assetPath.empty()) {
                try {
                    winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage bitmap;
                    bitmap.UriSource(winrt::Windows::Foundation::Uri{FileUri(std::wstring(assetPath))});
                    row.image.Source(bitmap);
                    row.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                } catch (const winrt::hresult_error &) {
                    row.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                }
            }
            return;
        }
        if (operation != L"query" && operation != L"queryMore") {
            if (operation == L"copy") {
                g_panel.status.Text(Text(L"已复制", L"Copied"));
                RequestHistory();
            } else if (operation == L"paste") {
                g_panel.status.Text(Text(L"已粘贴", L"Pasted"));
            } else if (operation == L"favorite") {
                g_panel.status.Text(Text(L"收藏状态已更新", L"Favorite updated"));
                RequestHistory();
            } else if (operation == L"delete") {
                g_panel.status.Text(Text(L"记录已删除", L"Record deleted"));
                RequestHistory();
            } else if (operation == L"assignTag" || operation == L"removeTag") {
                g_panel.status.Text(Text(L"标签已更新", L"Tags updated"));
            } else {
                g_panel.status.Text(data.GetNamedString(
                    L"message", Text(L"操作已完成", L"Action completed")));
            }
            return;
        }

        std::wstring selectionToRestore;
        if (operation == L"query") {
            if (!g_queueSelectionMode) selectionToRestore = g_selectedHash;
            g_panel.history.Items().Clear();
            g_hashes.clear();
            g_selectedHash.clear();
            g_queueSelectedHashes.clear();
            g_favorites.clear();
            g_panel.rows.clear();
            g_panel.cardRequested.clear();
        }
        g_nextId = static_cast<std::uint64_t>(data.GetNamedNumber(L"nextId", 0));
        g_nextTime = static_cast<std::uint64_t>(data.GetNamedNumber(L"nextTime", 0));
        g_hasMore = data.GetNamedBoolean(L"hasMore", false);
        const auto items = data.GetNamedArray(L"items");
        for (std::uint32_t index = 0; index < items.Size(); ++index) {
            const auto item = items.GetObjectAt(index);
            const auto hash = item.GetNamedString(L"hash", L"");
            const auto type = item.GetNamedString(L"itemType", L"Text");
            const auto preview = item.GetNamedString(L"previewText", L"");
            const auto source = item.GetNamedString(L"appSource", L"");
            const bool favorite = item.GetNamedBoolean(L"favorite", false);
            const auto tagsArray = item.GetNamedArray(L"tags", winrt::Windows::Data::Json::JsonArray{});
            std::wstring tagNames;
            std::vector<std::int64_t> tagIds;
            for (std::uint32_t tagIndex = 0; tagIndex < tagsArray.Size(); ++tagIndex) {
                const auto tag = tagsArray.GetObjectAt(tagIndex);
                const auto tagId = static_cast<std::int64_t>(tag.GetNamedNumber(L"id", 0));
                if (tagId > 0) tagIds.push_back(tagId);
                if (!tagNames.empty()) tagNames += L" · ";
                tagNames += tag.GetNamedString(L"name", L"");
            }
            const auto typeLabel = ItemTypeLabel(type);

            using namespace winrt::Microsoft::UI::Xaml;
            using namespace winrt::Microsoft::UI::Xaml::Controls;
            Grid row;
            row.Width(220);
            row.Height(230);
            for (int rowIndex = 0; rowIndex < 3; ++rowIndex) {
                row.RowDefinitions().Append(RowDefinition{});
            }
            row.RowDefinitions().GetAt(0).Height(GridLength{48, GridUnitType::Pixel});
            row.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Star});
            row.RowDefinitions().GetAt(2).Height(GridLength{30, GridUnitType::Pixel});

            Border header;
            header.Background(TypeBrush(type));
            header.CornerRadius(CornerRadius{14, 14, 0, 0});
            header.Padding(Thickness{12, 6, 12, 6});
            Grid headerContent;
            headerContent.ColumnDefinitions().Append(ColumnDefinition{});
            headerContent.ColumnDefinitions().Append(ColumnDefinition{});
            headerContent.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Star});
            headerContent.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Auto});
            TextBlock typeText = MakeText(typeLabel, 13);
            typeText.FontWeight(winrt::Microsoft::UI::Text::FontWeights::SemiBold());
            typeText.VerticalAlignment(VerticalAlignment::Center);
            headerContent.Children().Append(typeText);
            TextBlock favoriteText = MakeText(favorite ? L"★" : L"", 14);
            favoriteText.VerticalAlignment(VerticalAlignment::Center);
            Grid::SetColumn(favoriteText, 1);
            headerContent.Children().Append(favoriteText);
            header.Child(headerContent);
            Grid::SetRow(header, 0);
            row.Children().Append(header);

            StackPanel body;
            body.Margin(Thickness{12, 8, 12, 6});
            body.Spacing(5);
            Image mediaImage;
            mediaImage.Height(112);
            mediaImage.Stretch(winrt::Microsoft::UI::Xaml::Media::Stretch::Uniform);
            mediaImage.Visibility(Visibility::Collapsed);
            body.Children().Append(mediaImage);

            TextBlock previewText = MakeText(preview.empty() ? typeLabel : preview, 14);
            previewText.MaxLines(4);
            previewText.TextTrimming(TextTrimming::CharacterEllipsis);
            body.Children().Append(previewText);

            TextBlock tagsText = MakeText(winrt::hstring{tagNames}, 11);
            tagsText.TextWrapping(TextWrapping::NoWrap);
            tagsText.TextTrimming(TextTrimming::CharacterEllipsis);
            tagsText.Visibility(tagNames.empty() ? Visibility::Collapsed : Visibility::Visible);
            body.Children().Append(tagsText);
            TextBlock dimensionsText = MakeText(L"", 11);
            dimensionsText.Visibility(Visibility::Collapsed);
            body.Children().Append(dimensionsText);
            Grid::SetRow(body, 1);
            row.Children().Append(body);

            Border sourceSurface;
            sourceSurface.CornerRadius(CornerRadius{0, 0, 14, 14});
            sourceSurface.Padding(Thickness{12, 4, 12, 4});
            TextBlock sourceText = MakeText(source.empty() ? L"vPaste" : source, 11);
            sourceText.TextWrapping(TextWrapping::NoWrap);
            sourceText.TextTrimming(TextTrimming::CharacterEllipsis);
            sourceSurface.Child(sourceText);
            Grid::SetRow(sourceSurface, 2);
            row.Children().Append(sourceSurface);

            Border surface;
            surface.Width(220);
            surface.Height(230);
            surface.CornerRadius(CornerRadius{14, 14, 14, 14});
            surface.BorderThickness(Thickness{1, 1, 1, 1});
            surface.Margin(Thickness{6, 8, 6, 8});
            surface.Child(row);
            const auto rowHash = std::wstring(hash);
            MenuFlyout flyout;
            MenuFlyoutItem copyItem;
            copyItem.Text(Text(L"复制", L"Copy"));
            copyItem.Click([rowHash](auto const &, auto const &) {
                (void)SendRequest(L"copy", rowHash);
            });
            flyout.Items().Append(copyItem);
            MenuFlyoutItem pasteItem;
            pasteItem.Text(Text(L"粘贴", L"Paste"));
            pasteItem.Click([rowHash](auto const &, auto const &) {
                (void)SendRequest(L"paste", rowHash);
            });
            flyout.Items().Append(pasteItem);
            MenuFlyoutItem favoriteItem;
            favoriteItem.Text(favorite ? Text(L"取消收藏", L"Remove favorite")
                                       : Text(L"收藏", L"Add favorite"));
            favoriteItem.Click([rowHash](auto const &, auto const &) {
                const auto found = std::find(g_hashes.begin(), g_hashes.end(), rowHash);
                if (found == g_hashes.end()) return;
                const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
                if (index < g_favorites.size()) {
                    (void)SendRequest(L"favorite", rowHash, !g_favorites[index]);
                }
            });
            flyout.Items().Append(favoriteItem);
            flyout.Items().Append(MenuFlyoutSeparator{});
            if (IsEditableTextItem(type)) {
                MenuFlyoutItem editItem;
                editItem.Text(Text(L"编辑文本", L"Edit text"));
                editItem.Click([rowHash](auto const &, auto const &) {
                    (void)SendRequest(L"edit", rowHash);
                });
                flyout.Items().Append(editItem);
            }
            MenuFlyoutItem deleteItem;
            deleteItem.Text(Text(L"删除记录", L"Delete record"));
            deleteItem.Click([rowHash](auto const &, auto const &) {
                (void)ConfirmDeleteItem(rowHash);
            });
            flyout.Items().Append(deleteItem);
            flyout.Items().Append(MenuFlyoutSeparator{});
            MenuFlyoutSubItem tagsItem;
            tagsItem.Text(Text(L"标签", L"Tags"));
            for (std::size_t tagIndex = 0; tagIndex < g_tagIds.size(); ++tagIndex) {
                const auto tagId = g_tagIds[tagIndex];
                const auto tagName = g_tagNames[tagIndex];
                const bool assigned = std::find(tagIds.begin(), tagIds.end(), tagId) != tagIds.end();
                std::wstring optionText = assigned
                    ? (g_english ? L"Remove: " : L"移除标签：")
                    : (g_english ? L"Add: " : L"添加标签：");
                optionText += tagName;
                MenuFlyoutItem tagOption;
                tagOption.Text(winrt::hstring{optionText});
                tagOption.Click([rowHash, tagId, assigned](auto const &, auto const &) {
                    (void)SendRequest(assigned ? L"removeTag" : L"assignTag", rowHash, false, tagId);
                });
                tagsItem.Items().Append(tagOption);
            }
            if (g_tagIds.empty()) {
                MenuFlyoutItem noTagsItem;
                noTagsItem.Text(Text(L"没有可用标签", L"No tags available"));
                noTagsItem.IsEnabled(false);
                tagsItem.Items().Append(noTagsItem);
            }
            flyout.Items().Append(tagsItem);
            surface.ContextFlyout(flyout);
            surface.Tapped([rowHash](auto const &, auto const &) {
                if (!g_queueSelectionMode && g_singleClickPaste) {
                    (void)SendRequest(L"paste", rowHash);
                }
            });
            surface.DoubleTapped([rowHash](auto const &, auto const &) {
                if (!g_queueSelectionMode && !g_singleClickPaste) {
                    (void)SendRequest(L"paste", rowHash);
                }
            });
            winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
                surface, preview.empty() ? typeLabel : preview);

            g_hashes.push_back(hash.c_str());
            g_favorites.push_back(favorite);
            g_panel.cardRequested.push_back(false);
            g_panel.rows.push_back(HistoryRowVisual{
                surface, header, type, mediaImage, typeText, previewText, sourceText, tagsText,
                dimensionsText, favoriteText, std::move(tagIds)});
            g_panel.history.Items().Append(surface);
        }
        const auto suffix = g_hasMore ? L"+" : L"";
        const auto countText = std::to_wstring(g_hashes.size()) + suffix;
        g_panel.status.Text(countText + L" " + Text(L"条剪贴项", L"clipboard items"));
        g_panel.more.IsEnabled(g_hasMore);
        if (operation == L"query") {
            if (!selectionToRestore.empty()) {
                const auto found = std::find(g_hashes.begin(), g_hashes.end(), selectionToRestore);
                if (found != g_hashes.end()) {
                    g_panel.history.SelectedIndex(static_cast<int>(
                        std::distance(g_hashes.begin(), found)));
                }
            }
            UpdateQueueSelectionControls();
        }
        ApplyRowTheme();
        UpdateFavoriteButton();
    } catch (const winrt::hresult_error &error) {
        if (g_panel.status) {
            g_panel.status.Text(error.message());
        }
    } catch (...) {
        if (g_panel.status) {
            g_panel.status.Text(Text(L"无法显示剪贴板历史", L"Could not display clipboard history"));
        }
    }
}

void SetVisible(bool visible) noexcept {
    if (g_panel.window != nullptr) {
        const int showCommand = visible
                                    ? (IsIconic(g_panel.window) ? SW_RESTORE : SW_SHOW)
                                    : SW_HIDE;
        ShowWindow(g_panel.window, showCommand);
        if (visible) {
            SetForegroundWindow(g_panel.window);
        }
    }
    if (g_visibilityChanged != nullptr) {
        g_visibilityChanged(visible);
    }
}

void ShowQueueWithoutActivation() noexcept {
    if (!g_queueViewActive || g_panel.window == nullptr) return;
    ShowWindow(g_panel.window, SW_SHOWNOACTIVATE);
    if (g_visibilityChanged != nullptr) {
        g_visibilityChanged(true);
    }
}

void SetTagManagerActive(bool active) {
    if (!g_panel.window || !g_panel.xamlSource || !g_panel.tagManager) return;
    if (active) {
        if (g_queueViewActive) return;
        g_panel.tagManagerViewActive = true;
        const auto theme = g_panel.root.RequestedTheme();
        g_panel.tagManager->SetLanguage(g_english);
        g_panel.tagManager->SetTheme(theme);
        g_panel.xamlSource.Content(g_panel.tagManager->Root());
        g_panel.tagManager->Refresh();
    } else {
        if (!g_panel.tagManagerViewActive) return;
        g_panel.xamlSource.Content(g_panel.root);
        g_panel.tagManagerViewActive = false;
        RequestHistory();
    }
}

void SetQueueViewActive(bool active) {
    if (!g_panel.window || !g_panel.xamlSource || !g_panel.queueView) return;
    if (active) {
        if (g_panel.tagManagerViewActive) SetTagManagerActive(false);
        if (!g_queueViewActive) {
            g_queueReturnVisible = IsWindowVisible(g_panel.window) != FALSE;
            g_queueWasTopmost =
                (GetWindowLongPtrW(g_panel.window, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
            g_queueViewActive = true;
        }
        const auto theme = g_panel.root.RequestedTheme();
        g_panel.queueView->SetLanguage(g_english);
        g_panel.queueView->SetTheme(theme);
        g_panel.xamlSource.Content(g_panel.queueView->Root());
        SetWindowPos(g_panel.window, HWND_TOPMOST, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetVisible(true);
        (void)SendRequest(L"queueState");
    } else {
        if (!g_queueViewActive) return;
        g_panel.xamlSource.Content(g_panel.root);
        SetWindowPos(g_panel.window, g_queueWasTopmost ? HWND_TOPMOST : HWND_NOTOPMOST,
                     0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        const bool returnVisible = g_queueReturnVisible;
        g_queueViewActive = false;
        g_queueReturnVisible = false;
        g_queueWasTopmost = false;
        SetVisible(returnVisible);
    }
}

void ResizeIsland() noexcept {
    if (g_panel.window == nullptr || g_panel.xamlSource == nullptr) {
        return;
    }
    RECT bounds{};
    if (GetClientRect(g_panel.window, &bounds)) {
        g_panel.xamlSource.SiteBridge().MoveAndResize(
            winrt::Windows::Graphics::RectInt32{0, 0, bounds.right - bounds.left,
                                                bounds.bottom - bounds.top});
    }
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case kShowWindow:
        SetVisible(true);
        return S_OK;
    case kHideWindow:
        if (g_queueViewActive) g_queueReturnVisible = false;
        SetVisible(false);
        return S_OK;
    case kHideForQueuePaste:
        SetVisible(false);
        return S_OK;
    case kToggleWindow:
        SetVisible(IsWindowVisible(window) == FALSE || IsIconic(window));
        return S_OK;
    case kStopWindow:
        DestroyWindow(window);
        return S_OK;
    case kPanelResponse: {
        std::unique_ptr<std::string> response(reinterpret_cast<std::string *>(lparam));
        if (response) {
            ApplyResponse(*response);
        }
        return 0;
    }
    case kRefreshHistory:
        RequestHistory();
        return 0;
    case kRefreshTags:
        RefreshTags();
        return 0;
    case kSetQueueView:
        if (g_panel.xamlSource && g_panel.queueView) {
            SetQueueViewActive(wparam != 0);
        }
        return S_OK;
    case kShowQueueNoActivate:
        ShowQueueWithoutActivation();
        return S_OK;
    case kSetTheme: {
        if (g_panel.xamlSource != nullptr && g_panel.xamlSource.Content() != nullptr) {
            g_themeMode = static_cast<std::uint32_t>(wparam);
            const auto theme = wparam == 1
                                   ? winrt::Microsoft::UI::Xaml::ElementTheme::Light
                               : wparam == 2
                                   ? winrt::Microsoft::UI::Xaml::ElementTheme::Dark
                                   : winrt::Microsoft::UI::Xaml::ElementTheme::Default;
            g_panel.root.RequestedTheme(theme);
            ApplyRowTheme();
            if (g_panel.queueView) g_panel.queueView->SetTheme(theme);
            if (g_panel.tagManager) g_panel.tagManager->SetTheme(theme);
        }
        return 0;
    }
    case kSetLanguage: {
        g_english = wparam != 0;
        const int selected = g_panel.filter ? g_panel.filter.SelectedIndex() : 0;
        g_updatingLanguage = true;
        SetWindowTextW(window, Text(L"vPaste — 剪贴板历史", L"vPaste — Clipboard history").c_str());
        g_panel.search.PlaceholderText(Text(L"搜索剪贴板历史", L"Search clipboard history"));
        g_panel.filter.Items().Clear();
        for (const auto &choice : {
                 Text(L"全部", L"All"), Text(L"收藏", L"Favorites"),
                 Text(L"文本", L"Text"), Text(L"图片", L"Image"),
                 Text(L"链接", L"Link"), Text(L"颜色", L"Color"),
                 Text(L"文件", L"File")}) {
            g_panel.filter.Items().Append(winrt::box_value(choice));
        }
        g_panel.filter.SelectedIndex(std::clamp(selected, 0, 6));
        g_panel.copy.Content(winrt::box_value(Text(L"复制", L"Copy")));
        g_panel.paste.Content(winrt::box_value(Text(L"粘贴", L"Paste")));
        g_panel.more.Content(winrt::box_value(Text(L"加载更多", L"Load more")));
        g_panel.queueSelect.Content(winrt::box_value(g_queueSelectionMode
            ? Text(L"取消选择", L"Cancel selection")
            : Text(L"选择加入队列", L"Select for queue")));
        g_panel.queueAdd.Content(winrt::box_value(Text(L"加入队列", L"Add to queue")));
        g_panel.queueOpen.Content(winrt::box_value(Text(L"粘贴队列", L"Paste queue")));
        g_panel.manageTags.Content(winrt::box_value(Text(L"管理标签", L"Manage tags")));
        if (g_panel.queueView) g_panel.queueView->SetLanguage(g_english);
        if (g_panel.tagManager) g_panel.tagManager->SetLanguage(g_english);
        RebuildTagFilter();
        g_panel.status.Text(Text(L"正在读取剪贴板历史…", L"Loading clipboard history…"));
        UpdateFavoriteButton();
        g_updatingLanguage = false;
        RequestHistory();
        return 0;
    }
    case kSetClickMode:
        g_singleClickPaste = wparam != 0;
        return 0;
    case WM_SIZE:
        ResizeIsland();
        return 0;
    case WM_CLOSE:
        if (g_queueViewActive) {
            (void)SendRequest(L"queueClose");
        } else {
            if (g_panel.tagManagerViewActive) SetTagManagerActive(false);
            SetVisible(false);
        }
        return 0;
    case WM_DESTROY:
        {
            std::lock_guard lock(g_stateMutex);
            if (window == g_panel.window) {
                g_panel.window = nullptr;
            }
        }
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProcW(window, message, wparam, lparam);
    }
}

HRESULT CreatePanel() noexcept {
    try {
        WNDCLASSEXW windowClass{};
        windowClass.cbSize = sizeof(windowClass);
        windowClass.lpfnWndProc = WindowProc;
        windowClass.hInstance = GetModuleHandleW(nullptr);
        windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        windowClass.lpszClassName = kWindowClass;
        if (RegisterClassExW(&windowClass) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
            return HRESULT_FROM_WIN32(GetLastError());
        }

        g_panel.window = CreateWindowExW(
            0, kWindowClass, Text(L"vPaste — 剪贴板历史", L"vPaste — Clipboard history").c_str(), WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT, CW_USEDEFAULT, kWindowWidth, kWindowHeight, nullptr,
            nullptr, GetModuleHandleW(nullptr), nullptr);
        if (g_panel.window == nullptr) {
            return HRESULT_FROM_WIN32(GetLastError());
        }
        g_panel.xamlManager =
            winrt::Microsoft::UI::Xaml::Hosting::WindowsXamlManager::InitializeForCurrentThread();
        winrt::Microsoft::UI::Xaml::Application::Current()
            .Resources().MergedDictionaries().Append(
                winrt::Microsoft::UI::Xaml::Controls::XamlControlsResources());
        g_panel.xamlSource = winrt::Microsoft::UI::Xaml::Hosting::DesktopWindowXamlSource();
        g_panel.xamlSource.Initialize(
            winrt::Microsoft::UI::GetWindowIdFromWindow(g_panel.window));

        using namespace winrt::Microsoft::UI::Xaml;
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        using namespace winrt::Microsoft::UI::Xaml::Media;
        using namespace winrt::Microsoft::UI::Xaml;
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        Grid root;
        root.Padding(Thickness{20, 16, 20, 16});
        for (int row = 0; row < 4; ++row) {
            root.RowDefinitions().Append(RowDefinition{});
        }
        root.RowDefinitions().GetAt(0).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Auto});
        root.RowDefinitions().GetAt(2).Height(GridLength{1, GridUnitType::Star});
        root.Background(Application::Current().Resources()
                            .Lookup(winrt::box_value(L"ApplicationPageBackgroundThemeBrush"))
                            .as<winrt::Microsoft::UI::Xaml::Media::Brush>());
        g_panel.root = root;
        root.ActualThemeChanged([](auto const &, auto const &) {
            ApplyRowTheme();
            if (g_panel.queueView) {
                g_panel.queueView->SetTheme(g_panel.root.RequestedTheme());
            }
            if (g_panel.tagManager) {
                g_panel.tagManager->SetTheme(g_panel.root.RequestedTheme());
            }
        });

        StackPanel toolbar;
        toolbar.Orientation(Orientation::Horizontal);
        toolbar.Spacing(12);
        toolbar.Margin(Thickness{0, 0, 0, 12});
        g_panel.search = TextBox();
        g_panel.search.PlaceholderText(Text(L"搜索剪贴板历史", L"Search clipboard history"));
        g_panel.search.Width(300);
        g_panel.search.MinHeight(40);
        g_panel.search.VerticalAlignment(VerticalAlignment::Center);
        toolbar.Children().Append(g_panel.search);
        g_panel.filter = RadioButtons();
        g_panel.filter.MaxColumns(7);
        g_panel.filter.Items().Append(winrt::box_value(Text(L"全部", L"All")));
        g_panel.filter.Items().Append(winrt::box_value(Text(L"收藏", L"Favorites")));
        g_panel.filter.Items().Append(winrt::box_value(Text(L"文本", L"Text")));
        g_panel.filter.Items().Append(winrt::box_value(Text(L"图片", L"Image")));
        g_panel.filter.Items().Append(winrt::box_value(Text(L"链接", L"Link")));
        g_panel.filter.Items().Append(winrt::box_value(Text(L"颜色", L"Color")));
        g_panel.filter.Items().Append(winrt::box_value(Text(L"文件", L"File")));
        g_panel.filter.SelectedIndex(0);
        g_panel.filter.VerticalAlignment(VerticalAlignment::Center);
        toolbar.Children().Append(g_panel.filter);
        Grid::SetRow(toolbar, 0);
        root.Children().Append(toolbar);

        StackPanel tagFilterRow;
        tagFilterRow.Orientation(Orientation::Horizontal);
        tagFilterRow.Spacing(8);
        tagFilterRow.Margin(Thickness{0, 0, 0, 8});
        TextBlock tagFilterLabel = MakeText(Text(L"标签", L"Tag"), 13);
        tagFilterLabel.VerticalAlignment(VerticalAlignment::Center);
        tagFilterRow.Children().Append(tagFilterLabel);
        g_panel.tagFilter = ComboBox();
        g_panel.tagFilter.Width(240);
        g_panel.tagFilter.MinHeight(32);
        g_panel.tagFilter.VerticalAlignment(VerticalAlignment::Center);
        g_panel.tagFilter.Items().Append(winrt::box_value(Text(L"全部标签", L"All tags")));
        g_panel.tagFilter.SelectedIndex(0);
        g_panel.tagFilter.SelectionChanged([](auto const &, auto const &) {
            if (g_updatingTagFilter) return;
            const auto index = g_panel.tagFilter.SelectedIndex();
            if (index > 0 && static_cast<std::size_t>(index - 1) < g_tagNames.size()) {
                const auto tagIndex = static_cast<std::size_t>(index - 1);
                g_selectedTagId = g_tagIds[tagIndex];
                g_selectedTagName = g_tagNames[tagIndex];
            } else {
                g_selectedTagId = 0;
                g_selectedTagName.clear();
            }
            RequestHistory();
        });
        tagFilterRow.Children().Append(g_panel.tagFilter);
        Grid::SetRow(tagFilterRow, 1);
        root.Children().Append(tagFilterRow);

        g_panel.history = ListView();
        g_panel.history.SelectionMode(ListViewSelectionMode::Single);
        g_panel.history.HorizontalContentAlignment(HorizontalAlignment::Stretch);
        const auto itemsPanel = winrt::Microsoft::UI::Xaml::Markup::XamlReader::Load(
                                    L"<ItemsPanelTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><ItemsStackPanel Orientation=\"Horizontal\"/></ItemsPanelTemplate>")
                                    .as<ItemsPanelTemplate>();
        g_panel.history.ItemsPanel(itemsPanel);
        ScrollViewer::SetHorizontalScrollMode(g_panel.history, ScrollMode::Enabled);
        ScrollViewer::SetHorizontalScrollBarVisibility(g_panel.history, ScrollBarVisibility::Auto);
        ScrollViewer::SetVerticalScrollMode(g_panel.history, ScrollMode::Disabled);
        ScrollViewer::SetVerticalScrollBarVisibility(g_panel.history, ScrollBarVisibility::Disabled);
        g_panel.history.VerticalContentAlignment(VerticalAlignment::Center);
        g_panel.history.ContainerContentChanging([](auto const &, auto const &args) {
            if (args.InRecycleQueue()) return;
            const auto itemIndex = args.ItemIndex();
            const auto index = static_cast<std::size_t>(itemIndex);
            if (index >= g_hashes.size()) return;
            if (index >= g_panel.cardRequested.size() || g_panel.cardRequested[index]) return;
            g_panel.cardRequested[index] = true;
            (void)SendRequest(L"card", g_hashes[index]);
        });
        g_panel.history.KeyDown([](auto const &,
                                   winrt::Microsoft::UI::Xaml::Input::KeyRoutedEventArgs const &args) {
            if (args.Key() == winrt::Windows::System::VirtualKey::Enter) {
                RequestSelectedAction(L"paste");
                args.Handled(true);
            } else if (args.Key() == winrt::Windows::System::VirtualKey::Delete &&
                       !args.KeyStatus().WasKeyDown &&
                       (GetKeyState(VK_CONTROL) & 0x8000) == 0 &&
                       (GetKeyState(VK_SHIFT) & 0x8000) == 0 &&
                       (GetKeyState(VK_MENU) & 0x8000) == 0) {
                ConfirmDeleteSelectedItem();
                args.Handled(true);
            } else if (args.Key() == winrt::Windows::System::VirtualKey::F2 &&
                       !args.KeyStatus().WasKeyDown &&
                       (GetKeyState(VK_CONTROL) & 0x8000) == 0 &&
                       (GetKeyState(VK_SHIFT) & 0x8000) == 0 &&
                       (GetKeyState(VK_MENU) & 0x8000) == 0) {
                EditSelectedItem();
                args.Handled(true);
            } else if (args.Key() == winrt::Windows::System::VirtualKey::C &&
                       (GetKeyState(VK_CONTROL) & 0x8000) != 0) {
                RequestSelectedAction(L"copy");
                args.Handled(true);
            }
        });
        g_panel.history.SelectionChanged([](auto const &, auto const &) {
            if (g_queueSelectionMode) {
                g_queueSelectedHashes.clear();
                const auto selectedItems = g_panel.history.SelectedItems();
                for (std::uint32_t selectedIndex = 0; selectedIndex < selectedItems.Size(); ++selectedIndex) {
                    const auto surface = selectedItems.GetAt(selectedIndex).as<winrt::Microsoft::UI::Xaml::Controls::Border>();
                    const auto found = std::find_if(g_panel.rows.begin(), g_panel.rows.end(),
                        [&surface](const HistoryRowVisual &row) { return row.surface == surface; });
                    if (found != g_panel.rows.end()) {
                        const auto index = static_cast<std::size_t>(std::distance(g_panel.rows.begin(), found));
                        if (index < g_hashes.size()) g_queueSelectedHashes.push_back(g_hashes[index]);
                    }
                }
                if (g_panel.queueAdd) {
                    g_panel.queueAdd.IsEnabled(!g_queueSelectedHashes.empty());
                }
                if (g_panel.status) {
                    g_panel.status.Text(std::to_wstring(g_queueSelectedHashes.size()) + L" " +
                        Text(L"条已选择", L"selected"));
                }
            } else {
                const auto selectedIndex = g_panel.history.SelectedIndex();
                g_selectedHash = selectedIndex >= 0 &&
                                     static_cast<std::size_t>(selectedIndex) < g_hashes.size()
                    ? g_hashes[static_cast<std::size_t>(selectedIndex)]
                    : std::wstring{};
            }
            UpdateQueueSelectionControls();
            ApplyRowTheme();
        });
        Grid::SetRow(g_panel.history, 2);
        root.Children().Append(g_panel.history);

        StackPanel footer;
        footer.Orientation(Orientation::Horizontal);
        footer.Spacing(12);
        footer.Margin(Thickness{0, 12, 0, 0});
        g_panel.copy = Button();
        g_panel.copy.Content(winrt::box_value(Text(L"复制", L"Copy")));
        g_panel.copy.IsEnabled(false);
        g_panel.copy.Click([](auto const &, auto const &) { RequestSelectedAction(L"copy"); });
        footer.Children().Append(g_panel.copy);
        g_panel.paste = Button();
        g_panel.paste.Content(winrt::box_value(Text(L"粘贴", L"Paste")));
        g_panel.paste.IsEnabled(false);
        g_panel.paste.Click([](auto const &, auto const &) { RequestSelectedAction(L"paste"); });
        footer.Children().Append(g_panel.paste);
        g_panel.favorite = Button();
        g_panel.favorite.Content(winrt::box_value(Text(L"收藏", L"Add favorite")));
        g_panel.favorite.IsEnabled(false);
        g_panel.favorite.Click([](auto const &, auto const &) { RequestSelectedAction(L"favorite"); });
        footer.Children().Append(g_panel.favorite);
        g_panel.queueSelect = Button();
        g_panel.queueSelect.Content(winrt::box_value(Text(L"选择加入队列", L"Select for queue")));
        g_panel.queueSelect.Click([](auto const &, auto const &) { ToggleQueueSelectionMode(); });
        footer.Children().Append(g_panel.queueSelect);
        g_panel.queueAdd = Button();
        g_panel.queueAdd.Content(winrt::box_value(Text(L"加入队列", L"Add to queue")));
        g_panel.queueAdd.IsEnabled(false);
        g_panel.queueAdd.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
        g_panel.queueAdd.Click([](auto const &, auto const &) { AddSelectedItemsToQueue(); });
        footer.Children().Append(g_panel.queueAdd);
        g_panel.queueOpen = Button();
        g_panel.queueOpen.Content(winrt::box_value(Text(L"粘贴队列", L"Paste queue")));
        g_panel.queueOpen.Click([](auto const &, auto const &) {
            (void)SendRequest(L"queueOpen");
        });
        footer.Children().Append(g_panel.queueOpen);
        g_panel.manageTags = Button();
        g_panel.manageTags.Content(winrt::box_value(Text(L"管理标签", L"Manage tags")));
        g_panel.manageTags.Click([](auto const &, auto const &) {
            SetTagManagerActive(true);
        });
        footer.Children().Append(g_panel.manageTags);
        g_panel.more = Button();
        g_panel.more.Content(winrt::box_value(Text(L"加载更多", L"Load more")));
        g_panel.more.IsEnabled(false);
        g_panel.more.Click([](auto const &, auto const &) { RequestMoreHistory(); });
        footer.Children().Append(g_panel.more);
        g_panel.status = MakeText(Text(L"正在读取剪贴板历史…", L"Loading clipboard history…"), 13);
        g_panel.status.VerticalAlignment(VerticalAlignment::Center);
        g_panel.status.Margin(Thickness{4, 0, 0, 0});
        footer.Children().Append(g_panel.status);
        Grid::SetRow(footer, 3);
        root.Children().Append(footer);

        g_panel.search.TextChanged([](auto const &, auto const &) {
            if (g_searchTimer) {
                if (g_searchTimer.IsRunning()) g_searchTimer.Stop();
                g_searchTimer.Start();
            }
        });
        g_panel.filter.SelectionChanged([](auto const &, auto const &) {
            if (!g_updatingLanguage) RequestHistory();
        });
        g_searchTimer = g_dispatcher.DispatcherQueue().CreateTimer();
        g_searchTimer.Interval(std::chrono::milliseconds(240));
        g_searchTimer.IsRepeating(false);
        g_searchTimer.Tick([](auto const &timer, auto const &) {
            timer.Stop();
            RequestHistory();
        });

        g_panel.queueView = std::make_unique<vpaste::winui::QueueView>(
            [](const std::wstring &operation, const std::wstring &hash,
               const std::vector<std::wstring> &hashes) {
                (void)SendRequest(operation.c_str(), hash, false, 0, hashes);
            },
            [] { (void)SendRequest(L"queueClose"); });
        g_panel.queueView->SetLanguage(g_english);
        g_panel.queueView->SetTheme(root.RequestedTheme());

        g_panel.tagManager = std::make_unique<vpaste::winui::TagManager>(
            [](const std::wstring &operation, std::int64_t tagId,
               const std::wstring &name) {
                (void)SendTagManagerRequest(operation, tagId, name);
            },
            [] { SetTagManagerActive(false); });
        g_panel.tagManager->SetLanguage(g_english);
        g_panel.tagManager->SetTheme(root.RequestedTheme());

        g_panel.xamlSource.Content(root);
        ApplyRowTheme();
        ResizeIsland();
        g_panel.xamlSource.SiteBridge().Show();
        return S_OK;
    } catch (const winrt::hresult_error &error) {
        if (g_panel.window != nullptr) {
            DestroyWindow(g_panel.window);
        }
        return error.code();
    } catch (...) {
        if (g_panel.window != nullptr) {
            DestroyWindow(g_panel.window);
        }
        return E_FAIL;
    }
}

void RunUiThread() noexcept {
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(apartment)) {
        std::lock_guard lock(g_stateMutex);
        g_startResult = apartment;
        g_startFinished = true;
        g_stateChanged.notify_all();
        return;
    }

    HRESULT result = S_OK;
    winrt::Microsoft::UI::Xaml::Application xamlApplication{nullptr};
    try {
        g_dispatcher = winrt::Microsoft::UI::Dispatching::DispatcherQueueController::
            CreateOnCurrentThread();
        xamlApplication = winrt::make<XamlApplication>().as<
            winrt::Microsoft::UI::Xaml::Application>();
        result = CreatePanel();
    } catch (const winrt::hresult_error &error) {
        result = error.code();
    } catch (...) {
        result = E_FAIL;
    }

    {
        std::lock_guard lock(g_stateMutex);
        g_startResult = result;
        g_startFinished = true;
        g_stateChanged.notify_all();
    }
    if (SUCCEEDED(result)) {
        // The Windows App SDK event loop also pretranslates WinUI input messages.
        g_dispatcher.DispatcherQueue().RunEventLoop();
    }

    // Release UI objects on their STA even when startup failed, before COM ends.
    if (g_searchTimer != nullptr) {
        if (g_searchTimer.IsRunning()) {
            g_searchTimer.Stop();
        }
        g_searchTimer = nullptr;
    }
    if (g_panel.xamlSource != nullptr) {
        g_panel.xamlSource.Close();
        g_panel.xamlSource = nullptr;
    }
    g_panel.search = nullptr;
    g_panel.filter = nullptr;
    g_panel.tagFilter = nullptr;
    g_panel.history = nullptr;
    g_panel.status = nullptr;
    g_panel.copy = nullptr;
    g_panel.paste = nullptr;
    g_panel.favorite = nullptr;
    g_panel.queueSelect = nullptr;
    g_panel.queueAdd = nullptr;
    g_panel.queueOpen = nullptr;
    g_panel.manageTags = nullptr;
    g_panel.more = nullptr;
    g_panel.root = nullptr;
    g_panel.queueView.reset();
    g_queueViewActive = false;
    g_queueReturnVisible = false;
    g_queueWasTopmost = false;
    g_panel.tagManager.reset();
    g_panel.tagManagerViewActive = false;
    g_hashes.clear();
    g_favorites.clear();
    g_panel.rows.clear();
    g_tagNames.clear();
    g_tagIds.clear();
    g_selectedTagId = 0;
    g_selectedTagName.clear();
    if (g_panel.xamlManager != nullptr) {
        g_panel.xamlManager.Close();
        g_panel.xamlManager = nullptr;
    }
    if (g_dispatcher != nullptr) {
        g_dispatcher.ShutdownQueue();
    }
    xamlApplication = nullptr;
    g_dispatcher = nullptr;
    CoUninitialize();
}

LRESULT SendPanelMessage(UINT message) noexcept {
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return E_UNEXPECTED;
    }
    return SendMessageW(window, message, 0, 0);
}

} // namespace

extern "C" __declspec(dllexport) int32_t vpaste_winui_initialize(
    VisibilityChanged visibilityChanged, PanelRequest request, bool english,
    bool singleClickPaste) noexcept {
    std::unique_lock lock(g_stateMutex);
    if (g_uiThread.joinable()) {
        g_stateChanged.wait(lock, [] { return g_startFinished; });
        return g_startResult;
    }
    g_visibilityChanged = visibilityChanged;
    g_request = request;
    g_english = english;
    g_singleClickPaste = singleClickPaste;
    g_startFinished = false;
    g_startResult = E_PENDING;
    try {
        g_uiThread = std::thread(RunUiThread);
    } catch (...) {
        return E_FAIL;
    }
    if (!g_stateChanged.wait_for(lock, std::chrono::seconds(30),
                                 [] { return g_startFinished; })) {
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    return g_startResult;
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_show() noexcept {
    return static_cast<int32_t>(SendPanelMessage(kShowWindow));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_hide() noexcept {
    return static_cast<int32_t>(SendPanelMessage(kHideWindow));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_hide_for_queue_paste() noexcept {
    return static_cast<int32_t>(SendPanelMessage(kHideForQueuePaste));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_toggle() noexcept {
    return static_cast<int32_t>(SendPanelMessage(kToggleWindow));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_refresh() noexcept {
    return static_cast<int32_t>(SendPanelMessage(kRefreshHistory));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_refresh_tags() noexcept {
    return static_cast<int32_t>(SendPanelMessage(kRefreshTags));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_theme(std::uint32_t theme) noexcept {
    if (theme > 2) {
        return E_INVALIDARG;
    }
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return E_UNEXPECTED;
    }
    return static_cast<int32_t>(SendMessageW(window, kSetTheme, theme, 0));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_language(bool english) noexcept {
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return E_UNEXPECTED;
    }
    return static_cast<int32_t>(SendMessageW(window, kSetLanguage, english ? 1 : 0, 0));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_click_mode(
    bool singleClickPaste) noexcept {
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return E_UNEXPECTED;
    }
    return static_cast<int32_t>(SendMessageW(window, kSetClickMode, singleClickPaste ? 1 : 0, 0));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_queue_view(bool active) noexcept {
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return E_UNEXPECTED;
    }
    return static_cast<int32_t>(SendMessageW(window, kSetQueueView, active ? 1 : 0, 0));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_show_queue_no_activate() noexcept {
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return E_UNEXPECTED;
    }
    return static_cast<int32_t>(SendMessageW(window, kShowQueueNoActivate, 0, 0));
}

extern "C" __declspec(dllexport) void vpaste_winui_receive(
    const std::uint8_t *bytes, std::size_t length) noexcept {
    if (bytes == nullptr || length == 0 || length > 4 * 1024 * 1024) {
        return;
    }
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return;
    }
    auto response = std::make_unique<std::string>(
        reinterpret_cast<const char *>(bytes), length);
    if (PostMessageW(window, kPanelResponse, 0,
                     reinterpret_cast<LPARAM>(response.get()))) {
        response.release();
    }
}

extern "C" __declspec(dllexport) void vpaste_winui_shutdown() noexcept {
    if (g_uiThread.joinable()) {
        SendPanelMessage(kStopWindow);
        g_uiThread.join();
    }
    g_visibilityChanged = nullptr;
    g_request = nullptr;
}

#ifdef _DEBUG
// Local regression test only: exercise the real controls with synthetic records.
// The Rust test initializes the shell without an AppHandle or clipboard service.
extern "C" __declspec(dllexport) int32_t vpaste_winui_test_history_and_queue(
    std::uint32_t *stage) noexcept {
    if (!stage || !g_dispatcher) return E_INVALIDARG;
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([completion] {
        std::uint32_t currentStage = 1;
        try {
            ApplyResponse(R"({"id":100,"op":"query","data":{"items":[{"hash":"test-a","itemType":"Text","previewText":"Synthetic history","tags":[]}],"hasMore":false}})");
            winrt::check_hresult(g_panel.history.Items().Size() == 1 ? S_OK : E_FAIL);
            currentStage = 2;
            g_panel.history.SelectedIndex(0);
            ToggleQueueSelectionMode();
            winrt::check_hresult(g_panel.history.SelectionMode() ==
                winrt::Microsoft::UI::Xaml::Controls::ListViewSelectionMode::Multiple ? S_OK : E_FAIL);
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
            winrt::check_hresult(g_queueSelectedHashes.size() == 1 ? S_OK : E_FAIL);
            currentStage = 3;
            ToggleQueueSelectionMode();
            ApplyResponse(R"({"id":101,"op":"query","data":{"items":[{"hash":"test-b","itemType":"Text","previewText":"New capture","tags":[]}],"hasMore":false}})");
            winrt::check_hresult(g_hashes.size() == 1 && g_hashes[0] == L"test-b" ? S_OK : E_FAIL);
            currentStage = 4;
            SetQueueViewActive(true);
            g_panel.status.Text(L"No response error");
            ApplyResponse(R"({"id":0,"op":"queueStateUpdate","data":{"active":true,"busy":false,"capacity":100,"revision":1,"items":[{"hash":"test-b","itemType":"Text","previewContent":"New capture","appSource":"Test"}],"error":null,"undoHash":null}})");
            winrt::check_hresult(g_panel.status.Text() == L"No response error" ? S_OK : E_FAIL);
            auto queueRoot = g_panel.queueView->Root().as<winrt::Microsoft::UI::Xaml::Controls::Grid>();
            auto list = queueRoot.Children().GetAt(2).as<winrt::Microsoft::UI::Xaml::Controls::ScrollViewer>();
            auto rows = list.Content().as<winrt::Microsoft::UI::Xaml::Controls::StackPanel>();
            auto heading = queueRoot.Children().GetAt(0)
                .as<winrt::Microsoft::UI::Xaml::Controls::Grid>().Children().GetAt(0)
                .as<winrt::Microsoft::UI::Xaml::Controls::StackPanel>();
            winrt::check_hresult(rows.Children().Size() == 1 ? S_OK : E_FAIL);
            winrt::check_hresult(heading.Children().GetAt(1)
                .as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>().Text() == L"1 / 100" ? S_OK : E_FAIL);
            currentStage = 5;
            g_panel.queueView->SetLanguage(true);
            g_panel.queueView->SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme::Dark);
            g_panel.queueView->SetError(L"Synthetic error");
            ApplyResponse(R"({"id":0,"op":"queueStateUpdate","data":{"active":true,"busy":false,"capacity":100,"revision":2,"items":[{"hash":"test-b","itemType":"Text","previewContent":"New capture","appSource":"Test"},{"hash":"test-c","itemType":"Text","previewContent":"Another capture","appSource":"Test"}],"error":null,"undoHash":"test-undo"}})");
            winrt::check_hresult(g_panel.status.Text() == L"No response error" ? S_OK : E_FAIL);
            winrt::check_hresult(rows.Children().Size() == 2 ? S_OK : E_FAIL);
            winrt::check_hresult(heading.Children().GetAt(1)
                .as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>().Text() == L"2 / 100" ? S_OK : E_FAIL);
            currentStage = 6;
            SetQueueViewActive(false);
            SetQueueViewActive(true);
            SetQueueViewActive(false);
            completion->set_value({S_OK, 7});
        } catch (...) {
            completion->set_value({winrt::to_hresult(), currentStage});
        }
    })) return E_FAIL;
    if (result.wait_for(std::chrono::seconds(10)) != std::future_status::ready) {
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    const auto [status, completedStage] = result.get();
    *stage = completedStage;
    return status;
}
#endif
