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
#include <dwmapi.h>

// Avoid the Win32 macro colliding with WinUI Storyboard.GetCurrentTime.
#undef GetCurrentTime

#include <winrt/Microsoft.UI.h>
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Composition.SystemBackdrops.h>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Microsoft.UI.Input.h>
#include <winrt/Microsoft.UI.Interop.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
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
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Xaml.Interop.h>
#ifdef _DEBUG
#include <winrt/Microsoft.UI.Xaml.Documents.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame() {
    const winrt::apartment_context ui;
    winrt::handle ready{CreateEventW(nullptr, false, false, nullptr)};
    winrt::check_bool(static_cast<bool>(ready));
    const auto token = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(
        [signal = ready.get()](auto const &, auto const &) { SetEvent(signal); });
    const bool rendered = co_await winrt::resume_on_signal(ready.get(), std::chrono::seconds(5));
    co_await ui;
    winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(token);
    winrt::check_hresult(rendered ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
}

#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>
#endif

#include "WinUiQueueView.h"
#include "WinUiQueueWindow.h"
#include "WinUiTagManager.h"
#include "WinUiFilterEditor.h"
#include "WinUiNameEmoji.h"
#include "WinUiAppearance.h"
#include "WinUiRichContent.h"
#include "WinUiDrag.h"
#include "WinUiCardActions.h"
#include "WinUiKeyboard.h"
#include "WinUiHistoryViewport.h"
#include "WinUiRecordTagEditor.h"
#include "WinUiCardContent.h"
#include "WinUiAppActions.h"
#include "WinUiHoverPreview.h"
#include "WinUiReader.h"
#include "WinUiMotion.h"
#include "WinUiDockMotion.h"
#include "WinUiGeometry.h"
#include "WinUiTabIndicator.h"
#include "WinUiBridge.h"
#include "WinUiResourceProbe.h"

#include <chrono>
#include <cmath>
#include <algorithm>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <future>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
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
constexpr double kPanelHeight = 302;
constexpr double kHeaderHeight = 48;
constexpr double kHeaderInset = 28;
constexpr double kCardWidth = 220;
constexpr double kCardHeight = 230;
constexpr double kCardRadius = 14;
constexpr double kCardHeaderHeight = 48;
constexpr DWORD kDockedWindowStyle = WS_POPUP | WS_THICKFRAME | WS_SYSMENU;
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
constexpr UINT kFocusHistory = WM_APP + 14;
constexpr UINT kSetLayout = WM_APP + 15;
constexpr UINT kSetBehavior = WM_APP + 16;
constexpr UINT kSyncHistoryViewport = WM_APP + 17;
constexpr UINT kGetLayout = WM_APP + 18;

struct PanelLayout {
    std::int32_t x, y, width, height;
    double screenScale, panelScale;
};
static_assert(sizeof(PanelLayout) == 32);

enum class CardDetailState { Idle, Loading, Ready, Limited, Failed };
struct HistoryRowVisual {
    winrt::Microsoft::UI::Xaml::Controls::Border surface{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border header{nullptr};
    winrt::hstring itemType;
    winrt::Microsoft::UI::Xaml::Controls::Image image{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock type{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock preview{nullptr};
    winrt::hstring sourceName;
    winrt::Microsoft::UI::Xaml::Controls::TextBlock tags{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock dimensions{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button favoriteButton{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border mediaFrame{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border colorSwatch{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::FontIcon contentIcon{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Grid body{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock time{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::StackPanel actions{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Image sourceIcon{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border sourceFrame{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock subtitle{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock format{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border richFrame{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock richBadge{nullptr};
    std::optional<winrt::Windows::UI::Color> accent;
    std::vector<std::int64_t> tagIds;
    vpaste::winui::CardMenuExtras menu;
    winrt::Microsoft::UI::Xaml::Controls::Border shortcutHint{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Grid detailFeedback{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock detailStatus{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button retryDetails{nullptr};
    winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage pendingBitmap{nullptr};
    std::uint64_t cardRequestId = 0;
    CardDetailState detailState = CardDetailState::Idle;
    double imageWidth = 0, imageHeight = 0;
    std::uint64_t recordId = 0;
    winrt::Microsoft::UI::Xaml::Controls::Border outline{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border tagChip{nullptr};
    bool pointerOver = false;
};

struct Panel {
    HWND window = nullptr;
    std::unique_ptr<vpaste::winui::DockMotion> dockMotion;
    winrt::Microsoft::UI::Xaml::Controls::Grid root{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Grid header{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Grid shadowReceiver{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Viewbox viewport{nullptr};
    winrt::Microsoft::UI::Xaml::Hosting::WindowsXamlManager xamlManager{nullptr};
    winrt::Microsoft::UI::Xaml::Hosting::DesktopWindowXamlSource xamlSource{nullptr};
    winrt::Microsoft::UI::Xaml::Media::SolidColorBrush windowCanvas{nullptr};
    bool hasSystemBackdrop = false;
    winrt::Microsoft::UI::Xaml::Controls::AutoSuggestBox search{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBox::TextChanging_revoker searchChanging;
    winrt::Microsoft::UI::Xaml::Controls::Button searchButton{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::CommandBar commands{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::SelectorBar filter{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ScrollViewer filterScroll{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::StackPanel filterStrip{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border tabIndicatorHost{nullptr};
    std::unique_ptr<vpaste::winui::TabIndicator> tabIndicator;
    winrt::weak_ref<winrt::Microsoft::UI::Xaml::Controls::SelectorBarItem> indicatorSelection;
    winrt::Microsoft::UI::Xaml::Controls::SelectorBar customTabs{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button addTag{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button tagFilterButton{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ComboBox tagFilter{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ListView history{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ScrollViewer historyScroll{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ScrollViewer::ViewChanged_revoker historyScrollChanged;
    winrt::Microsoft::UI::Xaml::Controls::ScrollViewer::DirectManipulationStarted_revoker historyManipulation;
    winrt::Microsoft::UI::Xaml::Controls::TextBlock status{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ProgressBar loading{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::StackPanel emptyState{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button resetFilters{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button retry{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button cancelSelection{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border selectionBar{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock selectionTitle{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBlock selectionCount{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ContentDialog deletionDialog{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::InfoBar feedback{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton copy{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton paste{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton favorite{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton queueSelect{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button queueAdd{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton queueOpen{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton manageTags{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::AppBarButton settings{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button more{nullptr};
    std::unique_ptr<vpaste::winui::QueueView> queueView;
    std::unique_ptr<vpaste::winui::QueueWindow> queueWindow;
    std::unique_ptr<vpaste::winui::Reader> reader;
    std::unique_ptr<vpaste::winui::TagManager> tagManager;
    std::unique_ptr<vpaste::winui::CardDragSource> cardDrag;
    std::unique_ptr<vpaste::winui::FilterEditor> filterEditor;
    std::unique_ptr<vpaste::winui::RecordTagEditor> recordTagEditor;
    std::unique_ptr<vpaste::winui::ImageExport> imageExport;
    std::unique_ptr<vpaste::winui::AppActions> appActions;
    std::unique_ptr<vpaste::winui::HoverPreview> hoverPreview;
    bool tagManagerViewActive = false;
    std::vector<HistoryRowVisual> rows;
    std::vector<bool> cardRequested;
};

Panel g_panel;
bool PanelVisible() {
    return g_panel.dockMotion && g_panel.dockMotion->Visible() && IsWindowVisible(g_panel.window);
}
void SyncTabIndicator(bool animate = false);
bool NativeEditorOpen() {
    return (g_panel.filterEditor && g_panel.filterEditor->IsOpen()) ||
        (g_panel.recordTagEditor && g_panel.recordTagEditor->IsOpen()) ||
        (g_panel.appActions && g_panel.appActions->ModalOpen());
}
std::uint64_t g_searchSubmitRequestId = 0;
winrt::hstring g_searchText;
std::uint64_t g_latestHoverRequestId = 0;
int g_searchSubmitIndex = 0;
bool g_searchSubmitPlain = false, g_searchSubmitQuick = false;
vpaste::winui::PanelBehavior g_behavior;
bool g_altHints = false;
struct HistoryViewState {
    struct Restore { double offset; std::uint64_t request; bool applied = false; };
    vpaste::winui::HistoryQuery visibleQuery, requestedQuery;
    std::optional<Restore> restore;
    std::optional<std::pair<std::uint64_t, std::uint64_t>> lastAutoCursor;
    double parkedOffset = 0;
    bool resetOnShow = false, pageFailed = false;
} g_historyView;
std::optional<winrt::event_token> g_historyVerifyToken;

void SyncHistoryViewport();
void MaybeLoadMoreHistory();
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
bool g_updatingHistorySelection = false;
bool g_queueSelectionMode = false;
std::wstring g_queueReturnHash;
bool g_queueViewActive = false;
bool g_deleteConfirmationOpen = false;
bool g_applyingLayout = false;
bool g_layoutPending = false;
bool g_historyRefreshAfterDrag = false;
bool g_suppressDragTap = false;
PanelLayout g_dockedLayout{0, 0, kWindowWidth, static_cast<int>(kPanelHeight), 1, 1};
std::uint32_t g_themeMode = 0;
std::uint64_t g_requestId = 0;
std::uint64_t g_latestQueryId = 0;
std::uint64_t g_latestHistoryRequestId = 0;
std::uint64_t g_latestTagsRequestId = 0;
std::uint64_t g_latestFiltersRequestId = 0;
std::vector<winrt::Windows::Data::Json::JsonObject> g_customFilters;
std::vector<std::wstring> g_tabOrder, g_dynamicIds;
std::uint64_t g_tabOrderLoadRequest = 0;
std::uint64_t g_tabOrderSaveRequest = 0, g_editorGeneration = 0;
std::wstring g_selectedFilterId;
std::uint64_t g_latestTagManagerRequestId = 0;
std::uint64_t g_latestPreviewRequestId = 0;
std::vector<std::wstring> g_hashes;
std::wstring g_selectedHash;
std::vector<std::wstring> g_queueSelectedHashes;
std::uint64_t g_queueSelectionAddRequest = 0;
bool g_queueSelectionAdding = false;
std::vector<std::wstring> g_queueSubmittedHashes;
std::vector<bool> g_favorites;
std::vector<std::int64_t> g_tagIds;
std::vector<std::wstring> g_tagNames;
vpaste::winui::SearchTerms g_highlightTerms;
std::int64_t g_selectedTagId = 0;
std::wstring g_selectedTagName;
std::uint64_t g_nextId = 0;
std::uint64_t g_nextTime = 0;
bool g_hasMore = false;
bool g_historyLoading = false;
bool g_historyFailed = false;
winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer g_searchTimer{nullptr};
winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer g_feedbackTimer{nullptr};

winrt::hstring Text(const wchar_t *chinese, const wchar_t *english) {
    return g_english ? winrt::hstring{english} : winrt::hstring{chinese};
}

const wchar_t *FilterValue(int index) {
    switch (index) {
    case 1: return L"favorite";
    case 2: return L"File";
    case 3: return L"Link";
    case 4: return L"Image";
    case 5: return L"Color";
    case 6: return L"Text";
    default: return L"all";
    }
}

int FilterIndex() {
    std::uint32_t index = 0;
    return g_panel.filter && g_panel.filter.SelectedItem() &&
        g_panel.filter.Items().IndexOf(g_panel.filter.SelectedItem(), index)
        ? static_cast<int>(index) : 0;
}

void UpdateFilterLabels() {
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Microsoft::UI::Xaml;
    const bool populate = g_panel.filter.Items().Size() == 0;
    std::uint32_t index = 0;
    for (const auto &label : {
             Text(L"所有", L"All"), Text(L"收藏", L"Favorites"),
             Text(L"文件", L"Files"), Text(L"链接", L"Links"),
             Text(L"照片", L"Images"), Text(L"颜色", L"Colors"),
             Text(L"文本", L"Text")}) {
        if (populate) {
            SelectorBarItem tab;
            const auto glyph = index == 0 ? L"\uE71D" : index == 1 ? L"\uE734" :
                vpaste::winui::TypeGlyph(FilterValue(static_cast<int>(index)));
            tab.Icon(vpaste::winui::Glyph(glyph));
            tab.FontSize(vpaste::winui::TabFontSize);
            tab.MinWidth(78);
            tab.MinHeight(kHeaderHeight);
            tab.Padding(winrt::Microsoft::UI::Xaml::Thickness{10, 10, 10, 10});
            g_panel.filter.Items().Append(tab);
        }
        const auto item = g_panel.filter.Items().GetAt(index);
        item.Text(label);
        item.Visibility(index < 2 ? Visibility::Visible : Visibility::Collapsed);
        ++index;
    }
    if (populate) g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
    winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
        g_panel.filter, Text(L"剪贴项分类", L"Clipboard categories"));
}

bool RebuildTagFilter();
void RequestHistory();
void RefreshFilters();
void SetTagManagerActive(bool active);
void ApplyActiveLayout();
void ResizeIsland() noexcept;
void UpdateHistoryState();
void SetVisible(bool visible, bool freshShow, bool animate = true) noexcept;
void CancelHoverPreview() { if (g_panel.hoverPreview) g_panel.hoverPreview->Cancel(); }
template<typename T> T FindHistoryChild(winrt::Microsoft::UI::Xaml::DependencyObject const &element);
winrt::hstring SearchText() { return g_searchText; }

void SearchChanged(winrt::hstring const &text) {
    // Inner editing and AutoSuggestBox's deferred forwarding report the same
    // value. A duplicate must not cancel an Enter already awaiting its query.
    if (g_searchText == text) return;
    g_searchText = text;
    CancelHoverPreview();
    g_searchSubmitRequestId = 0;
    if (g_searchTimer) {
        if (g_searchTimer.IsRunning()) g_searchTimer.Stop();
        g_searchTimer.Start();
    }
}

void SetSearchText(winrt::hstring const &text) {
    g_panel.search.Text(text);
    if (g_panel.search.IsLoaded()) {
        if (const auto editor = FindHistoryChild<winrt::Microsoft::UI::Xaml::Controls::TextBox>(g_panel.search);
            editor && editor.Text() != text) editor.Text(text);
    }
    SearchChanged(text);
}
void ApplyCardPresenterChrome(winrt::Microsoft::UI::Xaml::DependencyObject const &container,
                              bool contrast);
void UpdateSearchWidth() {
    if (g_panel.search && g_panel.root) {
        const bool narrow = g_panel.root.Width() < 900;
        g_panel.search.Width(narrow ? 120 : 276);
        if (g_panel.status) g_panel.status.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
        if (g_panel.tagFilter) g_panel.tagFilter.Width(narrow ? 112 : 144);
    }
}

void ShowSearch() {
    using namespace winrt::Microsoft::UI::Xaml;
    const bool entering = g_panel.search.Visibility() != Visibility::Visible;
    UpdateSearchWidth(); g_panel.search.Visibility(Visibility::Visible);
    g_panel.search.Focus(FocusState::Programmatic);
    if (entering) g_panel.search.DispatcherQueue().TryEnqueue([weak = winrt::make_weak(g_panel.search)] {
        const auto search = weak.get();
        if (search && search.Visibility() == Visibility::Visible && PanelVisible()) vpaste::winui::FadeFeedback(search);
    });
}

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
    if (type == L"Image") return Brush(255, 152, 0);
    if (type == L"File") return Brush(0, 188, 212);
    if (type == L"Link") return Brush(47, 111, 237);
    if (type == L"Color") return Brush(33, 150, 243);
    return Brush(76, 175, 80);
}

bool IsDarkTheme() {
    return g_themeMode == 2 ||
           (g_themeMode == 0 && g_panel.root &&
            g_panel.root.ActualTheme() == winrt::Microsoft::UI::Xaml::ElementTheme::Dark);
}

void ApplyWindowTheme(bool contrast = vpaste::winui::HighContrastEnabled()) {
    if (!g_panel.windowCanvas) return;
    const bool dark = IsDarkTheme();
    g_panel.windowCanvas.Color(contrast
        ? winrt::Windows::UI::ViewManagement::UISettings().GetColorValue(winrt::Windows::UI::ViewManagement::UIColorType::Background)
        : g_panel.hasSystemBackdrop
        ? winrt::Windows::UI::Color{0, 0, 0, 0}
        : dark ? Rgb(23, 27, 34) : Rgb(246, 247, 249));
    if (g_panel.window) {
        const BOOL darkCaption = dark;
        // Unsupported older Windows builds simply keep their native caption.
        (void)DwmSetWindowAttribute(g_panel.window, DWMWA_USE_IMMERSIVE_DARK_MODE,
                                    &darkCaption, sizeof(darkCaption));
    }
}

bool ConfigureAcrylicBackdrop(bool enabled) {
    using winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController;
    using winrt::Microsoft::UI::Xaml::Media::DesktopAcrylicBackdrop;
    g_panel.xamlSource.SystemBackdrop(nullptr);
    g_panel.hasSystemBackdrop = false;
    if (enabled && DesktopAcrylicController::IsSupported()) {
        try {
            // The SDK owns activation, transparency, battery and contrast policy.
            g_panel.xamlSource.SystemBackdrop(DesktopAcrylicBackdrop{});
            g_panel.hasSystemBackdrop = true;
        } catch (const winrt::hresult_error &error) {
            OutputDebugStringW(L"vPaste: Acrylic initialization failed; using an opaque canvas. ");
            OutputDebugStringW(error.message().c_str());
        }
    }
    ApplyWindowTheme();
    return g_panel.hasSystemBackdrop;
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
    const bool favorite = selected && g_favorites[index];
    g_panel.favorite.Label(favorite ? Text(L"取消收藏", L"Remove favorite")
                                   : Text(L"收藏", L"Add favorite"));
    g_panel.favorite.Icon(winrt::Microsoft::UI::Xaml::Controls::SymbolIcon{
        favorite ? winrt::Microsoft::UI::Xaml::Controls::Symbol::UnFavorite
                 : winrt::Microsoft::UI::Xaml::Controls::Symbol::Favorite});
}

void UpdateCardOutline(std::size_t index) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    if (!g_panel.history || index >= g_panel.rows.size() || index >= g_hashes.size()) return;
    const auto container = g_panel.history.ContainerFromIndex(static_cast<std::uint32_t>(index)).try_as<ListViewItem>();
    const bool systemFocus = container ? container.UseSystemFocusVisuals() : vpaste::winui::HighContrastEnabled();
    const bool selected = g_queueSelectionMode
        ? std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), g_hashes[index]) != g_queueSelectedHashes.end()
        : g_selectedHash == g_hashes[index];
    const bool keyboardFocused = container && container.FocusState() == FocusState::Keyboard;
    g_panel.rows[index].outline.Visibility(!systemFocus && (selected || keyboardFocused) ? Visibility::Visible : Visibility::Collapsed);
}

void ApplyRowTheme(bool contrast = vpaste::winui::HighContrastEnabled()) {
    ApplyWindowTheme(contrast);
    SyncTabIndicator();
    vpaste::winui::ApplyElevation(g_panel.header, vpaste::winui::HeaderElevation, contrast, g_panel.shadowReceiver);
    for (const auto &button : {g_panel.searchButton, g_panel.tagFilterButton, g_panel.addTag})
        vpaste::winui::ApplyElevation(button, vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
    for (const auto &command : {g_panel.queueOpen, g_panel.settings})
        vpaste::winui::ApplyElevation(command, vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
    if (g_panel.appActions) {
        vpaste::winui::ApplyElevation(g_panel.appActions->ToolsButton(), vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
        vpaste::winui::ApplyElevation(g_panel.appActions->UpdateButton(), vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
    }
    vpaste::winui::ApplyElevation(g_panel.selectionBar, vpaste::winui::HoveredCardElevation, contrast, g_panel.shadowReceiver);
    if (g_panel.deletionDialog) g_panel.deletionDialog.RequestedTheme(g_panel.root.ActualTheme());
    if (g_panel.history) g_panel.history.Background(nullptr);
    if (g_panel.status) vpaste::winui::ApplyStyle(g_panel.status, L"VPaste.Secondary");
    for (std::size_t index = 0; index < g_panel.rows.size(); ++index) {
        auto &row = g_panel.rows[index];
        if (g_panel.history) {
            if (const auto container = g_panel.history.ContainerFromIndex(static_cast<std::uint32_t>(index)).try_as<winrt::Microsoft::UI::Xaml::Controls::ListViewItem>()) {
                ApplyCardPresenterChrome(container, contrast);
            }
        }
        row.surface.CanDrag(!g_queueSelectionMode);
        vpaste::winui::ApplyStyle(row.surface, L"VPaste.Surface");
        UpdateCardOutline(index);
        vpaste::winui::ApplyElevation(row.surface, row.pointerOver
            ? vpaste::winui::HoveredCardElevation : vpaste::winui::CardElevation, contrast, g_panel.shadowReceiver);
        vpaste::winui::ApplyElevation(row.tagChip, vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
        if (contrast) {
            row.header.ClearValue(winrt::Microsoft::UI::Xaml::Controls::Border::BackgroundProperty());
            vpaste::winui::ApplyStyle(row.header, L"VPaste.ContrastCardHeader");
        } else row.header.Background(row.accent
            ? winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{*row.accent} : TypeBrush(row.itemType));
        vpaste::winui::ApplyStyle(row.type, contrast ? L"VPaste.ContrastCardTitle" : L"VPaste.CardTitle");
        vpaste::winui::ApplyStyle(row.preview, L"VPaste.Body");
        row.preview.ClearValue(winrt::Microsoft::UI::Xaml::Controls::TextBlock::ForegroundProperty());
        if (!contrast && row.itemType == L"Color") row.preview.Foreground(Brush(40, 40, 40));
        const auto favoriteGlyph = row.favoriteButton.Content().as<winrt::Microsoft::UI::Xaml::Controls::FontIcon>();
        if (contrast) {
            favoriteGlyph.ClearValue(winrt::Microsoft::UI::Xaml::Controls::IconElement::ForegroundProperty());
            vpaste::winui::ApplyStyle(favoriteGlyph, L"VPaste.Glyph");
            row.richBadge.ClearValue(winrt::Microsoft::UI::Xaml::Controls::TextBlock::ForegroundProperty());
            vpaste::winui::ApplyStyle(row.richBadge, L"VPaste.ContrastCardTime");
        } else {
            favoriteGlyph.Foreground(Brush(255, 255, 255));
            row.richBadge.Foreground(Brush(255, 255, 255));
        }
        favoriteGlyph.FontSize(12); row.richBadge.FontSize(10);
        row.richBadge.Opacity(contrast ? 1 : 0.85);
        vpaste::winui::ApplyStyle(row.tags, L"VPaste.CardTag");
        vpaste::winui::ApplyStyle(row.dimensions, L"VPaste.Caption");
        vpaste::winui::ApplyStyle(row.subtitle, L"VPaste.Secondary");
        row.preview.FontWeight(row.itemType == L"File" || row.itemType == L"Link"
            ? winrt::Microsoft::UI::Text::FontWeights::SemiBold()
            : winrt::Microsoft::UI::Text::FontWeights::Normal());
        vpaste::winui::ApplyStyle(row.time, contrast ? L"VPaste.ContrastCardTime" : L"VPaste.CardTime");
        if (row.detailStatus) vpaste::winui::ApplyStyle(row.detailStatus, L"VPaste.Secondary");
        row.actions.Visibility(g_queueSelectionMode
            ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
            : winrt::Microsoft::UI::Xaml::Visibility::Visible);
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

winrt::hstring FormatCardTime(std::uint64_t milliseconds, std::uint64_t now) {
    if (milliseconds == 0) return L"";
    const auto minutes = (now > milliseconds ? now - milliseconds : 0) / 60000;
    if (minutes == 0) return Text(L"刚刚", L"Just now");
    if (minutes < 60) return winrt::hstring{std::to_wstring(minutes)} + Text(L"分钟前", L" min ago");
    if (minutes < 1440) return winrt::hstring{std::to_wstring(minutes / 60)} + Text(L"小时前", L" hr ago");
    if (minutes < 10080) return winrt::hstring{std::to_wstring(minutes / 1440)} + Text(L"天前", L" days ago");
    // Stored timestamps are Unix milliseconds; formatting never changes the data.
    const ULONGLONG ticks = milliseconds * 10000 + 116444736000000000ULL;
    const FILETIME utc{static_cast<DWORD>(ticks), static_cast<DWORD>(ticks >> 32)};
    FILETIME local{};
    SYSTEMTIME date{};
    if (!FileTimeToLocalFileTime(&utc, &local) || !FileTimeToSystemTime(&local, &date)) return L"";
    wchar_t formatted[80]{};
    return GetDateFormatEx(LOCALE_NAME_USER_DEFAULT, DATE_SHORTDATE, &date, nullptr,
        formatted, static_cast<int>(std::size(formatted)), nullptr) > 0 ? winrt::hstring{formatted} : L"";
}

std::optional<winrt::Windows::UI::Color> ParseColor(const winrt::hstring &text) {
    std::wstring_view value{text};
    if (value.empty() || value.front() != L'#' ||
        (value.size() != 4 && value.size() != 7 && value.size() != 9)) return std::nullopt;
    std::uint32_t hex = 0;
    for (const auto ch : value.substr(1)) {
        const auto digit = ch >= L'0' && ch <= L'9' ? ch - L'0'
            : ch >= L'a' && ch <= L'f' ? ch - L'a' + 10
            : ch >= L'A' && ch <= L'F' ? ch - L'A' + 10 : -1;
        if (digit < 0) return std::nullopt;
        hex = (hex << 4) | static_cast<std::uint32_t>(digit);
    }
    if (value.size() == 4) return Rgb(static_cast<std::uint8_t>(((hex >> 8) & 15) * 17),
        static_cast<std::uint8_t>(((hex >> 4) & 15) * 17), static_cast<std::uint8_t>((hex & 15) * 17));
    const auto alpha = value.size() == 9 ? static_cast<std::uint8_t>(hex & 255) : std::uint8_t{255};
    if (value.size() == 9) hex >>= 8;
    return winrt::Windows::UI::Color{alpha, static_cast<std::uint8_t>(hex >> 16),
        static_cast<std::uint8_t>(hex >> 8), static_cast<std::uint8_t>(hex)};
}

void UpdateCardContent(HistoryRowVisual &row, const winrt::hstring &text) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    const bool media = row.itemType == L"Image" || row.itemType == L"File" ||
        row.itemType == L"Link" || row.itemType == L"Color";
    row.mediaFrame.Visibility(media ? Visibility::Visible : Visibility::Collapsed);
    row.body.RowDefinitions().GetAt(0).Height(GridLength{1, media ? GridUnitType::Star : GridUnitType::Auto});
    row.body.RowDefinitions().GetAt(1).Height(GridLength{1, media ? GridUnitType::Auto : GridUnitType::Star});
    row.preview.MaxLines(media ? (row.itemType == L"File" ? 3 : 2) : 8);
    if (row.itemType == L"Image") row.preview.Visibility(Visibility::Collapsed);
    if (!text.empty()) row.preview.Text(text);
    if (row.itemType == L"Color") {
        const auto color = ParseColor(text);
        row.colorSwatch.Visibility(color ? Visibility::Visible : Visibility::Collapsed);
        row.contentIcon.Visibility(color ? Visibility::Collapsed : Visibility::Visible);
        if (color) row.colorSwatch.Background(winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{*color});
    }
    ToolTipService::SetToolTip(row.sourceFrame, winrt::box_value(row.sourceName));
}

void UpdateHistoryState() {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    if (!g_panel.emptyState) return;
    const bool filtered = !SearchText().empty() || FilterIndex() != 0 || g_selectedTagId != 0 || !g_selectedFilterId.empty();
    const bool empty = g_hashes.empty() && !g_historyLoading;
    g_panel.loading.Visibility(g_historyLoading ? Visibility::Visible : Visibility::Collapsed);
    g_panel.emptyState.Visibility(empty ? Visibility::Visible : Visibility::Collapsed);
    const auto heading = g_panel.emptyState.Children().GetAt(1).as<TextBlock>();
    const auto detail = g_panel.emptyState.Children().GetAt(2).as<TextBlock>();
    heading.Text(g_historyFailed ? Text(L"暂时无法读取历史", L"History is unavailable")
        : filtered ? Text(L"没有匹配的剪贴项", L"No matching items") : Text(L"剪贴板还是空的", L"Your clipboard shelf is empty"));
    detail.Text(g_historyFailed ? Text(L"请重试，剪贴板历史不会被删除。", L"Try again. Your saved history is not deleted.")
        : filtered ? Text(L"试试其他关键词，或清除筛选条件。", L"Try another search or clear the filters.")
        : Text(L"在其他应用中复制文字、图片或文件，它们会出现在这里。", L"Copy text, images or files in another app to see them here."));
    g_panel.retry.Visibility(g_historyFailed ? Visibility::Visible : Visibility::Collapsed);
    g_panel.resetFilters.Visibility(!g_historyFailed && filtered ? Visibility::Visible : Visibility::Collapsed);
    g_panel.more.Visibility(g_hasMore ? Visibility::Visible : Visibility::Collapsed);
}

bool IsCardAction(winrt::Windows::Foundation::IInspectable const &source) {
    auto element = source.try_as<winrt::Microsoft::UI::Xaml::DependencyObject>();
    while (element && element != g_panel.history) {
        if (element.try_as<winrt::Microsoft::UI::Xaml::Controls::Primitives::ButtonBase>()) return true;
        element = winrt::Microsoft::UI::Xaml::Media::VisualTreeHelper::GetParent(element);
    }
    return false;
}

void ShowAltHints(bool visible) {
    g_altHints = visible && g_behavior.quickInput && !g_panel.tagManagerViewActive;
    for (std::size_t i = 0; i < g_panel.rows.size(); ++i) {
        if (g_panel.rows[i].shortcutHint) g_panel.rows[i].shortcutHint.Visibility(
            g_altHints && i < 9 ? winrt::Microsoft::UI::Xaml::Visibility::Visible : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    }
}

void UpdateShortcutLabels() {
    const auto label = g_behavior.plainBinding.key ? vpaste::winui::ShortcutLabel(g_behavior.plainShortcut) : L"";
    for (auto const &row : g_panel.rows) if (row.menu.pastePlain) row.menu.pastePlain.KeyboardAcceleratorTextOverride(label);
    if (g_panel.filter && g_panel.filter.Items().Size() >= 2) {
        for (std::uint32_t i = 0; i < 2; ++i) winrt::Microsoft::UI::Xaml::Controls::ToolTipService::SetToolTip(
            g_panel.filter.Items().GetAt(i), winrt::box_value(i == 0
                ? (g_behavior.quickInput ? Text(L"所有 (Alt+A)", L"All (Alt+A)") : Text(L"所有", L"All"))
                : (g_behavior.quickInput ? Text(L"收藏 (Alt+F)", L"Favorites (Alt+F)") : Text(L"收藏", L"Favorites"))));
    }
}

void ApplyBehavior(std::string const &bytes) {
    const auto data = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(bytes));
    if (data.HasKey(L"dockMotion") && g_panel.dockMotion)
        g_panel.dockMotion->Configure(data.GetNamedObject(L"dockMotion"));
    vpaste::winui::PanelBehavior next;
    next.retainSearch = data.GetNamedBoolean(L"retainSearch", false);
    next.retainCategory = data.GetNamedBoolean(L"retainCategory", false);
    next.retainPosition = data.GetNamedBoolean(L"retainPosition", false);
    next.quickInput = data.GetNamedBoolean(L"quickInput", true);
    next.tabSelection = data.GetNamedBoolean(L"tabSelection", true);
    next.hoverPreview = data.GetNamedBoolean(L"hoverPreview", false);
    next.plainShortcut = std::wstring{data.GetNamedString(L"plainShortcut", L"Shift+Enter")};
    next.plainBinding = vpaste::winui::ParseKeyBinding(next.plainShortcut);
    CancelHoverPreview();
    g_behavior = std::move(next);
    g_searchSubmitRequestId = 0;
    ShowAltHints(false);
    UpdateShortcutLabels();
}

void DismissFeedback() {
    if (g_feedbackTimer && g_feedbackTimer.IsRunning()) g_feedbackTimer.Stop();
    vpaste::winui::ResetFeedbackOpacity(g_panel.feedback);
    if (g_panel.feedback) g_panel.feedback.IsOpen(false);
}

void ShowFeedback(const winrt::hstring &message, winrt::Microsoft::UI::Xaml::Controls::InfoBarSeverity severity) {
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    if (!g_panel.feedback || g_panel.tagManagerViewActive || !PanelVisible()) return;
    DismissFeedback();
    g_panel.feedback.Message(message);
    g_panel.feedback.Severity(severity);
    g_panel.feedback.IsClosable(severity != InfoBarSeverity::Success);
    g_panel.feedback.IsOpen(true);
    vpaste::winui::FadeFeedback(g_panel.feedback);
    // This is notification dwell time, not an app-authored animation duration.
    if (severity == InfoBarSeverity::Success && g_feedbackTimer) g_feedbackTimer.Start();
}

void ShowFeedback(const winrt::hstring &message, bool error = false) {
    using winrt::Microsoft::UI::Xaml::Controls::InfoBarSeverity;
    ShowFeedback(message, error ? InfoBarSeverity::Error : InfoBarSeverity::Success);
}

std::uint64_t SendRequest(const wchar_t *operation, const std::wstring &hash = {},
                          bool favorite = false, std::int64_t tagId = 0,
                          const std::vector<std::wstring> &hashes = {},
                          const std::wstring &name = {}, int navigationDirection = 0,
                          const std::wstring &argument = {}) {
    if (g_request == nullptr) {
        return 0;
    }
    if (wcscmp(operation, L"query") == 0 || wcscmp(operation, L"queryMore") == 0 ||
        wcscmp(operation, L"paste") == 0 || wcscmp(operation, L"quickPaste") == 0 ||
        wcscmp(operation, L"edit") == 0 || wcscmp(operation, L"delete") == 0 ||
        wcscmp(operation, L"previewToggle") == 0 || wcscmp(operation, L"previewSelect") == 0 ||
        wcscmp(operation, L"previewClose") == 0 || wcscmp(operation, L"previewDismiss") == 0) CancelHoverPreview();
    if (wcscmp(operation, L"paste") == 0 || wcscmp(operation, L"copy") == 0 || wcscmp(operation, L"quickPaste") == 0 ||
        wcscmp(operation, L"edit") == 0 || wcscmp(operation, L"delete") == 0 ||
        wcscmp(operation, L"previewToggle") == 0) g_searchSubmitRequestId = 0;
    using namespace winrt::Windows::Data::Json;
    JsonObject request;
    const auto id = ++g_requestId;
    request.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
    request.Insert(L"op", JsonValue::CreateStringValue(operation));
    if (wcscmp(operation, L"hoverPreview") == 0) g_latestHoverRequestId = id;
    if (wcscmp(operation, L"hoverDismiss") == 0 || wcscmp(operation, L"previewToggle") == 0 ||
        wcscmp(operation, L"previewClose") == 0 || wcscmp(operation, L"previewDismiss") == 0 ||
        wcscmp(operation, L"dismiss") == 0) g_latestHoverRequestId = 0;
    if (wcscmp(operation, L"previewToggle") == 0 || wcscmp(operation, L"previewSelect") == 0) {
        request.Insert(L"navigationDirection", JsonValue::CreateNumberValue(navigationDirection));
        g_latestPreviewRequestId = id;
    }
    if (wcscmp(operation, L"previewDismiss") == 0 || wcscmp(operation, L"previewClose") == 0 || wcscmp(operation, L"dismiss") == 0)
        g_latestPreviewRequestId = 0;
    if (wcscmp(operation, L"query") == 0) {
        request.Insert(L"query", JsonValue::CreateStringValue(
                                      SearchText()));
        request.Insert(L"filter", JsonValue::CreateStringValue(
                                        g_selectedFilterId.empty() ? std::wstring{FilterValue(FilterIndex())} : L"custom:" + g_selectedFilterId));
        request.Insert(L"tagName", JsonValue::CreateStringValue(g_selectedTagName));
        const bool sameRange = !g_historyView.resetOnShow && g_historyView.requestedQuery == g_historyView.visibleQuery;
        request.Insert(L"limit", JsonValue::CreateNumberValue(static_cast<double>(std::max<std::size_t>(36, sameRange ? g_hashes.size() : 0))));
    } else if (wcscmp(operation, L"queryMore") == 0) {
        request.Insert(L"query", JsonValue::CreateStringValue(
                                      SearchText()));
        request.Insert(L"filter", JsonValue::CreateStringValue(
                                        g_selectedFilterId.empty() ? std::wstring{FilterValue(FilterIndex())} : L"custom:" + g_selectedFilterId));
        request.Insert(L"tagName", JsonValue::CreateStringValue(g_selectedTagName));
        request.Insert(L"lastId", JsonValue::CreateNumberValue(static_cast<double>(g_nextId)));
        request.Insert(L"lastTime", JsonValue::CreateNumberValue(static_cast<double>(g_nextTime)));
    }
    if (!hash.empty()) {
        request.Insert(L"hash", JsonValue::CreateStringValue(hash));
    }
    if (!argument.empty()) request.Insert(L"argument", JsonValue::CreateStringValue(argument));
    if (wcscmp(operation, L"favorite") == 0) {
        request.Insert(L"favorite", JsonValue::CreateBooleanValue(favorite));
    }
    if (wcscmp(operation, L"card") == 0) {
        request.Insert(L"cardScale", JsonValue::CreateNumberValue(g_dockedLayout.screenScale * g_dockedLayout.panelScale));
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
    if (bytes.size() > vpaste::winui::MaxRequestBytes) return 0;
    g_request(reinterpret_cast<const std::uint8_t *>(bytes.data()), bytes.size());
    // Escape lets Rust close a preview before deciding whether to hide the dock.
    // Cancelling hover first would make that preview appear already closed.
    if (wcscmp(operation, L"dismiss") == 0) CancelHoverPreview();
    return id;
}

HistoryRowVisual *FindCard(const std::wstring &hash) {
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), hash);
    if (found == g_hashes.end()) return nullptr;
    const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
    return index < g_panel.rows.size() ? &g_panel.rows[index] : nullptr;
}

void SetCardDetailState(HistoryRowVisual &row, CardDetailState state, const winrt::hstring &message = L"") {
    using namespace winrt::Microsoft::UI::Xaml;
    row.detailState = state;
    if (!row.detailFeedback) return;
    row.detailStatus.Text(state == CardDetailState::Loading ? Text(L"正在读取预览…", L"Loading preview…")
        : state == CardDetailState::Failed ? Text(L"预览暂不可用", L"Preview unavailable") : L"");
    winrt::Microsoft::UI::Xaml::Controls::ToolTipService::SetToolTip(row.detailStatus, winrt::box_value(message));
    row.retryDetails.Visibility(state == CardDetailState::Failed ? Visibility::Visible : Visibility::Collapsed);
    row.retryDetails.IsEnabled(state == CardDetailState::Failed);
    row.detailFeedback.Visibility(state == CardDetailState::Loading || state == CardDetailState::Failed ? Visibility::Visible : Visibility::Collapsed);
}

void ApplyNaturalImageBounds(HistoryRowVisual &row) {
    const auto bounds = vpaste::winui::NaturalImageBounds(row.imageWidth, row.imageHeight,
        row.mediaFrame.ActualWidth() - 8, row.mediaFrame.ActualHeight() - 8);
    row.image.MaxWidth(bounds.Width); row.image.MaxHeight(bounds.Height);
}

void RequestCardDetails(const std::wstring &hash, bool refresh = false) {
    auto *row = FindCard(hash);
    if (!row || row->detailState == CardDetailState::Loading) return;
    row->cardRequestId = SendRequest(L"card", hash, false, 0, {}, {}, 0, refresh ? L"refresh" : L"");
    row->pendingBitmap = nullptr;
    SetCardDetailState(*row, row->cardRequestId ? CardDetailState::Loading : CardDetailState::Failed,
        Text(L"暂时无法读取预览，请重试", L"Could not request this preview; retry"));
}

void CompleteCardBitmap(const std::wstring &hash, std::uint64_t request,
    winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage bitmap, bool loaded, const winrt::hstring &error = L"") {
    using namespace winrt::Microsoft::UI::Xaml;
    auto *row = FindCard(hash);
    if (!row || row->cardRequestId != request ||
        (row->pendingBitmap != bitmap && row->image.Source() != bitmap)) return;
    row->pendingBitmap = nullptr;
    if (loaded) {
        row->image.Source(bitmap); row->image.Visibility(Visibility::Visible);
        row->contentIcon.Visibility(Visibility::Collapsed);
        SetCardDetailState(*row, CardDetailState::Ready);
    } else {
        if (row->image.Source() == bitmap) row->image.Visibility(Visibility::Collapsed);
        if (row->image.Visibility() != Visibility::Visible) row->contentIcon.Visibility(Visibility::Visible);
        SetCardDetailState(*row, CardDetailState::Failed, error);
    }
}

void HighlightCard(HistoryRowVisual &row) {
    for (const auto &block : {row.preview, row.subtitle, row.format}) vpaste::winui::HighlightText(block, g_highlightTerms);
}

std::uint64_t SendCardAction(const std::wstring &operation, const std::wstring &hash,
                            const std::wstring &argument) {
    g_searchSubmitRequestId = 0;
    if (operation == L"exportPrepare") {
        if (g_panel.imageExport) g_panel.imageExport->Start(hash);
        return 0;
    }
    return SendRequest(operation.c_str(), hash, false, 0, {}, {}, 0, argument);
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
    RefreshFilters();
    g_tabOrderLoadRequest = SendRequest(L"tabOrderLoad");
}

std::uint64_t SendEditorRequest(const std::wstring &operation, winrt::Windows::Data::Json::JsonObject payload) {
    using namespace winrt::Windows::Data::Json;
    if (!g_request) return 0;
    const auto id = ++g_requestId;
    payload.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
    payload.Insert(L"op", JsonValue::CreateStringValue(operation));
    const auto bytes = winrt::to_string(payload.Stringify());
    if (bytes.size() > 16 * 1024) throw winrt::hresult_invalid_argument(L"Request too large / 请求内容过大");
    g_request(reinterpret_cast<const std::uint8_t *>(bytes.data()), bytes.size());
    return id;
}

void RefreshFilters() { g_latestFiltersRequestId = SendRequest(L"filtersList"); }

std::wstring RecordTabId(std::int64_t id) { return L"record:" + std::to_wstring(id); }

winrt::Microsoft::UI::Xaml::Controls::SelectorBarItem DynamicTab(std::wstring const &id) {
    const auto found = std::find(g_dynamicIds.begin(), g_dynamicIds.end(), id);
    return found == g_dynamicIds.end() ? nullptr :
        g_panel.customTabs.Items().GetAt(static_cast<std::uint32_t>(std::distance(g_dynamicIds.begin(), found)));
}

winrt::Microsoft::UI::Xaml::FrameworkElement EditorAnchor(std::wstring const &id, std::wstring const &hash = {}) {
    if (const auto tab = DynamicTab(id); tab && tab.IsLoaded()) return tab;
    const auto item = std::find(g_hashes.begin(), g_hashes.end(), hash);
    if (!hash.empty() && item != g_hashes.end()) {
        const auto container = g_panel.history.ContainerFromIndex(static_cast<int>(std::distance(g_hashes.begin(), item)))
            .try_as<winrt::Microsoft::UI::Xaml::FrameworkElement>();
        if (container) return container;
    }
    return g_panel.addTag;
}

std::function<void()> EditorFocusReturn(std::wstring id, std::wstring hash = {}) {
    const auto generation = ++g_editorGeneration;
    return [generation, id = std::move(id), hash = std::move(hash)] {
        if (!g_panel.root) return;
        g_panel.root.DispatcherQueue().TryEnqueue([generation, id, hash] {
            if (generation != g_editorGeneration || NativeEditorOpen() || !g_panel.root ||
                !PanelVisible() || GetForegroundWindow() != g_panel.window) return;
            if (const auto control = EditorAnchor(id, hash).try_as<winrt::Microsoft::UI::Xaml::Controls::Control>())
                control.Focus(winrt::Microsoft::UI::Xaml::FocusState::Programmatic);
        });
    };
}

void ShowFilterEditor(winrt::Windows::Data::Json::JsonObject draft, bool confirmDelete = false) {
    if (!g_panel.filterEditor || g_panel.tagManagerViewActive || g_deleteConfirmationOpen) return;
    if (g_panel.recordTagEditor && g_panel.recordTagEditor->IsOpen()) return;
    if (g_panel.cardDrag && g_panel.cardDrag->Active()) return;
    const auto id = draft.GetNamedString(L"id", L"");
    if (!id.empty()) {
        const auto current = std::find_if(g_customFilters.begin(), g_customFilters.end(),
            [&](auto const &filter) { return filter.GetNamedString(L"id", L"") == id; });
        if (current == g_customFilters.end()) {
            ShowFeedback(Text(L"筛选标签已不存在", L"Filter no longer exists"), true); return;
        }
        draft = winrt::Windows::Data::Json::JsonObject::Parse(current->Stringify());
    }
    (void)SendRequest(L"previewDismiss");
    g_panel.filterEditor->Show(EditorAnchor(std::wstring{id}), draft, g_english, g_panel.root.RequestedTheme(),
        confirmDelete, g_panel.root, EditorFocusReturn(std::wstring{id}));
}

void ShowRecordTagEditor(std::int64_t id = 0, const std::wstring &hash = {}, bool confirmDelete = false) {
    if (!g_panel.recordTagEditor || g_panel.tagManagerViewActive || g_deleteConfirmationOpen ||
        (g_panel.cardDrag && g_panel.cardDrag->Active()) || (g_panel.filterEditor && g_panel.filterEditor->IsOpen())) return;
    std::wstring name;
    if (id) {
        const auto found = std::find(g_tagIds.begin(), g_tagIds.end(), id);
        if (found == g_tagIds.end()) return;
        name = g_tagNames[static_cast<std::size_t>(std::distance(g_tagIds.begin(), found))];
    }
    if (!hash.empty() && std::find(g_hashes.begin(), g_hashes.end(), hash) == g_hashes.end()) return;
    g_searchSubmitRequestId = 0;
    ShowAltHints(false);
    (void)SendRequest(L"previewDismiss");
    // Position from the trigger but own the flyout on a root that survives refresh.
    const auto tabId = id ? RecordTabId(id) : L"";
    g_panel.recordTagEditor->Show(EditorAnchor(tabId, hash), id, name, hash, g_english,
        g_panel.root.RequestedTheme(), confirmDelete, g_panel.root, EditorFocusReturn(tabId, hash));
}

// Only the short tab strip is eager. History keeps its virtualized layout.
// An outer ScrollViewer owns the mixed strip, including the trailing +; an
// estimated StackLayout extent inside SelectorBar cannot position it reliably.
struct TabStripLayout : winrt::Microsoft::UI::Xaml::Controls::NonVirtualizingLayoutT<TabStripLayout> {
    winrt::Windows::Foundation::Size MeasureOverride(
        winrt::Microsoft::UI::Xaml::Controls::NonVirtualizingLayoutContext const &context,
        winrt::Windows::Foundation::Size const &available) {
        winrt::Windows::Foundation::Size desired{};
        for (auto const &child : context.Children()) {
            child.Measure({INFINITY, available.Height});
            desired.Width += child.DesiredSize().Width;
            desired.Height = std::max(desired.Height, child.DesiredSize().Height);
        }
        return desired;
    }
    winrt::Windows::Foundation::Size ArrangeOverride(
        winrt::Microsoft::UI::Xaml::Controls::NonVirtualizingLayoutContext const &context,
        winrt::Windows::Foundation::Size const &finalSize) {
        float x = 0;
        for (auto const &child : context.Children()) {
            const auto width = child.DesiredSize().Width;
            child.Arrange({x, 0, width, finalSize.Height}); x += width;
        }
        return finalSize;
    }
};

void BringSelectedTabIntoView(winrt::Microsoft::UI::Xaml::Controls::SelectorBar const &bar) {
    if (!bar || !bar.SelectedItem() || bar.SelectedItem().Visibility() != winrt::Microsoft::UI::Xaml::Visibility::Visible) return;
    bar.DispatcherQueue().TryEnqueue([weakBar = winrt::make_weak(bar), weakTab = winrt::make_weak(bar.SelectedItem())] {
        const auto currentBar = weakBar.get(); const auto tab = weakTab.get();
        if (!currentBar || !tab || !currentBar.IsLoaded() || currentBar.SelectedItem() != tab) return;
        try {
            currentBar.UpdateLayout();
            if (tab.IsLoaded() && tab.ActualWidth() > 0 && g_panel.filterScroll) {
                const auto bounds = tab.TransformToVisual(g_panel.filterScroll).TransformBounds(
                    {0, 0, static_cast<float>(tab.ActualWidth()), static_cast<float>(tab.ActualHeight())});
                const auto width = g_panel.filterScroll.ViewportWidth();
                const auto delta = bounds.X < 0 ? bounds.X : std::max(0.0, bounds.X + bounds.Width - width);
                if (std::abs(delta) > 0.5) g_panel.filterScroll.ChangeView(
                    winrt::box_value(std::clamp(g_panel.filterScroll.HorizontalOffset() + delta, 0.0,
                        g_panel.filterScroll.ScrollableWidth())).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, nullptr, true);
            }
            SyncTabIndicator(true);
        } catch (winrt::hresult_error const &error) {
            std::fprintf(stderr, "WinUI category positioning failed: 0x%08X %s\n", static_cast<unsigned>(error.code()), winrt::to_string(error.message()).c_str());
            ShowFeedback(Text(L"无法定位所选标签", L"Could not locate the selected tab"), true);
        }
    });
}

void SyncTabIndicator(bool animate) {
    using namespace winrt::Microsoft::UI::Xaml;
    if (!g_panel.tabIndicator || !g_panel.tabIndicatorHost.IsLoaded() || g_updatingTagFilter || g_updatingLanguage) return;
    auto selected = g_panel.customTabs.SelectedItem();
    if (!selected) selected = g_panel.filter.SelectedItem();
    if (!selected || !selected.IsLoaded() || selected.Visibility() != Visibility::Visible) {
        g_panel.tabIndicator->Hide(); return;
    }
    const auto bounds = selected.TransformToVisual(g_panel.tabIndicatorHost).TransformBounds(
        {0, 0, static_cast<float>(selected.ActualWidth()), static_cast<float>(selected.ActualHeight())});
    const auto color = g_panel.tabIndicatorHost.BorderBrush().as<Media::SolidColorBrush>().Color();
    g_panel.tabIndicator->Move(bounds, color, animate || g_panel.indicatorSelection.get() != selected,
        vpaste::winui::NativeAnimationsEnabled() && !vpaste::winui::HighContrastEnabled());
    g_panel.indicatorSelection = winrt::make_weak(selected);
}

void StyleDynamicTab(winrt::Microsoft::UI::Xaml::Controls::SelectorBarItem const &tab, winrt::hstring const &name) {
    tab.Text(name); tab.FontSize(vpaste::winui::TabFontSize); tab.MinHeight(kHeaderHeight);
    tab.MinWidth(58); tab.MaxWidth(vpaste::winui::TabMaxWidth);
    tab.Padding(winrt::Microsoft::UI::Xaml::Thickness{10, 10, 10, 10});
    winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(tab, name);
    winrt::Microsoft::UI::Xaml::Controls::ToolTipService::SetToolTip(tab, winrt::box_value(name));
    tab.Loaded([](auto const &sender, auto const &) {
        if (const auto label = FindHistoryChild<winrt::Microsoft::UI::Xaml::Controls::TextBlock>(sender.as<winrt::Microsoft::UI::Xaml::DependencyObject>())) {
            label.TextWrapping(winrt::Microsoft::UI::Xaml::TextWrapping::NoWrap);
            label.TextTrimming(winrt::Microsoft::UI::Xaml::TextTrimming::CharacterEllipsis);
            label.MaxWidth(vpaste::winui::TabMaxWidth - 20);
        }
        if (g_panel.customTabs && sender == g_panel.customTabs.SelectedItem()) BringSelectedTabIntoView(g_panel.customTabs);
    });
}

void SaveTabDrop(std::wstring const &source, std::wstring const &target) {
    using namespace winrt::Windows::Data::Json;
    if (g_tabOrderSaveRequest || source == target || !DynamicTab(source) || !DynamicTab(target)) return;
    const auto sourceIndex = std::find(g_dynamicIds.begin(), g_dynamicIds.end(), source);
    const auto targetIndex = std::find(g_dynamicIds.begin(), g_dynamicIds.end(), target);
    if (sourceIndex == g_dynamicIds.end() || targetIndex == g_dynamicIds.end()) return;
    JsonObject payload;
    payload.Insert(L"sourceId", JsonValue::CreateStringValue(source));
    payload.Insert(L"targetId", JsonValue::CreateStringValue(target));
    payload.Insert(L"before", JsonValue::CreateBooleanValue(sourceIndex > targetIndex));
    try { g_tabOrderSaveRequest = SendEditorRequest(L"tabOrderSave", payload); }
    catch (winrt::hresult_error const &error) { ShowFeedback(error.message(), true); }
}

void RebuildDynamicTabs() {
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Windows::Data::Json;
    if (!g_panel.customTabs) return;
    const auto updating = std::exchange(g_updatingTagFilter, true);
    std::vector<std::wstring> available;
    for (auto const &filter : g_customFilters) available.push_back(std::wstring{filter.GetNamedString(L"id")});
    for (auto id : g_tagIds) available.push_back(RecordTabId(id));
    g_dynamicIds.clear();
    for (auto const &id : g_tabOrder) if (std::find(available.begin(), available.end(), id) != available.end() &&
        std::find(g_dynamicIds.begin(), g_dynamicIds.end(), id) == g_dynamicIds.end()) g_dynamicIds.push_back(id);
    for (auto const &id : available) if (std::find(g_dynamicIds.begin(), g_dynamicIds.end(), id) == g_dynamicIds.end()) g_dynamicIds.push_back(id);
    g_panel.customTabs.Items().Clear();
    for (auto const &id : g_dynamicIds) {
        SelectorBarItem tab;
        MenuFlyout menu;
        MenuFlyoutItem edit, remove; edit.Icon(SymbolIcon{Symbol::Edit}); remove.Icon(SymbolIcon{Symbol::Delete});
        const auto filter = std::find_if(g_customFilters.begin(), g_customFilters.end(),
            [&](auto const &draft) { return std::wstring{draft.GetNamedString(L"id")} == id; });
        if (filter != g_customFilters.end()) {
            const auto draft = *filter;
            StyleDynamicTab(tab, draft.GetNamedString(L"name"));
            edit.Text(Text(L"编辑筛选", L"Edit filter")); remove.Text(Text(L"删除筛选", L"Delete filter"));
            edit.Click([draft](auto const &, auto const &) { ShowFilterEditor(draft); });
            remove.Click([draft](auto const &, auto const &) { ShowFilterEditor(draft, true); });
            tab.DoubleTapped([draft](auto const &, auto const &args) { ShowFilterEditor(draft); args.Handled(true); });
        } else {
            const auto index = std::find_if(g_tagIds.begin(), g_tagIds.end(), [&](auto tagId) { return RecordTabId(tagId) == id; }) - g_tagIds.begin();
            const auto tagId = g_tagIds[index];
            StyleDynamicTab(tab, winrt::hstring{g_tagNames[index]});
            edit.Text(Text(L"编辑标签", L"Edit tag")); remove.Text(Text(L"删除标签…", L"Delete tag…"));
            edit.Click([tagId](auto const &, auto const &) { ShowRecordTagEditor(tagId); });
            remove.Click([tagId](auto const &, auto const &) { ShowRecordTagEditor(tagId, {}, true); });
            tab.DoubleTapped([tagId](auto const &, auto const &args) { ShowRecordTagEditor(tagId); args.Handled(true); });
        }
        menu.Items().Append(edit); menu.Items().Append(remove);
        tab.ContextFlyout(menu);
        tab.CanDrag(true); tab.AllowDrop(true);
        tab.DragStarting([id](auto const &, auto const &args) {
            if (g_tabOrderSaveRequest || NativeEditorOpen()) { args.Cancel(true); return; }
            args.Data().Properties().Insert(L"com.vpaste.native-tab", winrt::box_value(id));
            args.Data().RequestedOperation(winrt::Windows::ApplicationModel::DataTransfer::DataPackageOperation::Move);
        });
        tab.DragOver([](auto const &, auto const &args) {
            if (!g_tabOrderSaveRequest && args.DataView().Properties().HasKey(L"com.vpaste.native-tab")) {
                args.AcceptedOperation(winrt::Windows::ApplicationModel::DataTransfer::DataPackageOperation::Move);
                args.Handled(true);
            }
        });
        tab.Drop([id](auto const &, auto const &args) {
            if (!args.DataView().Properties().HasKey(L"com.vpaste.native-tab")) return;
            SaveTabDrop(std::wstring{winrt::unbox_value<winrt::hstring>(args.DataView().Properties().Lookup(L"com.vpaste.native-tab"))}, id);
            args.Handled(true);
        });
        g_panel.customTabs.Items().Append(tab);
    }
    g_panel.customTabs.SelectedItem(DynamicTab(!g_selectedFilterId.empty() ? g_selectedFilterId : RecordTabId(g_selectedTagId)));
    g_panel.customTabs.Visibility(g_dynamicIds.empty() ? Visibility::Collapsed : Visibility::Visible);
    g_updatingTagFilter = updating;
    BringSelectedTabIntoView(g_panel.customTabs);
}

void ApplyFilters(const winrt::Windows::Data::Json::JsonArray &items) {
    using namespace winrt::Windows::Data::Json;
    g_customFilters.clear();
    for (auto const &value : items) {
        if (value.ValueType() != JsonValueType::Object) continue;
        auto draft = value.GetObject();
        const auto id = draft.GetNamedValue(L"id", nullptr), name = draft.GetNamedValue(L"name", nullptr);
        if (id && id.ValueType() == JsonValueType::String && !id.GetString().empty() &&
            name && name.ValueType() == JsonValueType::String) g_customFilters.push_back(draft);
    }
    if (!g_selectedFilterId.empty() && std::none_of(g_customFilters.begin(), g_customFilters.end(),
        [](auto const &draft) { return std::wstring{draft.GetNamedString(L"id")} == g_selectedFilterId; })) {
        g_selectedFilterId.clear();
        if (!g_selectedTagId) {
            const auto updatingLanguage = g_updatingLanguage; g_updatingLanguage = true;
            g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
            g_updatingLanguage = updatingLanguage;
        }
    }
    RebuildDynamicTabs();
    RequestHistory();
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
        if (!g_panel.filter.SelectedItem() && g_selectedFilterId.empty()) {
            const auto wasUpdating = g_updatingLanguage;
            g_updatingLanguage = true;
            g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
            g_updatingLanguage = wasUpdating;
        }
    } else if (!selectedName.empty()) {
        g_selectedTagName = std::move(selectedName);
    }
    g_panel.tagFilter.SelectedIndex(selectedIndex);
    RebuildDynamicTabs();
    g_updatingTagFilter = false;
    const bool selectionChanged = selectedTagRemoved || selectedTagRenamed;
    if (selectionChanged) RequestHistory();
    return selectionChanged;
}

void RequestHistory() {
    g_searchSubmitRequestId = 0;
    if (g_panel.cardDrag && g_panel.cardDrag->Active()) {
        g_historyRefreshAfterDrag = true;
        return;
    }
    g_historyLoading = true;
    g_historyFailed = false;
    g_historyView.pageFailed = false;
    g_historyView.lastAutoCursor.reset();
    g_historyView.requestedQuery = {std::wstring{SearchText()},
        g_selectedFilterId.empty() ? FilterValue(FilterIndex()) : L"custom:" + g_selectedFilterId, g_selectedTagName};
    g_latestQueryId = SendRequest(L"query");
    g_latestHistoryRequestId = g_latestQueryId;
    g_nextId = 0;
    g_nextTime = 0;
    g_hasMore = false;
    g_panel.more.IsEnabled(false);
    UpdateHistoryState();
}
void RequestMoreHistory(bool automatic = false) {
    if (g_panel.cardDrag && g_panel.cardDrag->Active()) {
        g_historyRefreshAfterDrag = true;
        return;
    }
    if (g_hasMore && !g_historyLoading) {
        const auto cursor = std::pair{g_nextId, g_nextTime};
        if (automatic && cursor == std::pair<std::uint64_t, std::uint64_t>{0, 0}) return;
        if (automatic && (g_historyView.pageFailed || g_historyView.lastAutoCursor == cursor)) return;
        if (automatic) g_historyView.lastAutoCursor = cursor;
        else { g_historyView.pageFailed = false; g_historyView.lastAutoCursor.reset(); }
        g_historyLoading = true;
        g_panel.more.IsEnabled(false);
        g_latestHistoryRequestId = SendRequest(L"queryMore");
        UpdateHistoryState();
    }
}

double HistoryOffset() {
    return g_historyView.restore ? g_historyView.restore->offset : g_panel.historyScroll && g_panel.history.IsLoaded() &&
        PanelVisible() && !g_panel.tagManagerViewActive
        ? g_panel.historyScroll.HorizontalOffset() : g_historyView.parkedOffset;
}

void QueueHistoryOffset(double offset, std::uint64_t request) {
    g_historyView.restore = HistoryViewState::Restore{offset, request};
    if (g_panel.historyScroll) g_panel.historyScroll.BringIntoViewOnFocusChange(false);
    PostMessageW(g_panel.window, kSyncHistoryViewport, 0, 0);
}

void HistoryViewportInput() {
    g_historyView.restore.reset();
    if (g_panel.historyScroll) g_panel.historyScroll.BringIntoViewOnFocusChange(true);
}

void VerifyHistoryViewportAfterRender() {
    if (g_historyVerifyToken) return;
    g_historyVerifyToken = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering([](auto const &, auto const &) {
        winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(*g_historyVerifyToken);
        g_historyVerifyToken.reset();
        if (!g_historyView.restore || !g_historyView.restore->applied || !g_panel.historyScroll ||
            g_historyLoading || g_panel.tagManagerViewActive || !PanelVisible()) return;
        const auto target = vpaste::winui::ClampHistoryOffset(g_historyView.restore->offset, g_panel.historyScroll.ScrollableWidth());
        if (std::abs(g_panel.historyScroll.HorizontalOffset() - target) <= 0.5) {
            g_historyView.parkedOffset = target;
            g_historyView.restore.reset();
            MaybeLoadMoreHistory();
        } else {
            g_historyView.restore->applied = false;
            PostMessageW(g_panel.window, kSyncHistoryViewport, 0, 0);
        }
    });
}

template<typename T> T FindHistoryChild(winrt::Microsoft::UI::Xaml::DependencyObject const &element) {
    if (auto match = element.try_as<T>()) return match;
    const auto count = winrt::Microsoft::UI::Xaml::Media::VisualTreeHelper::GetChildrenCount(element);
    for (int i = 0; i < count; ++i) {
        if (auto match = FindHistoryChild<T>(winrt::Microsoft::UI::Xaml::Media::VisualTreeHelper::GetChild(element, i))) return match;
    }
    return nullptr;
}

void ApplyCardPresenterChrome(winrt::Microsoft::UI::Xaml::DependencyObject const &container,
                              bool contrast) {
    using namespace winrt::Microsoft::UI::Xaml::Controls::Primitives;
    using namespace winrt::Microsoft::UI::Xaml::Media;
    if (const auto item = container.try_as<winrt::Microsoft::UI::Xaml::Controls::ListViewItem>())
        item.UseSystemFocusVisuals(contrast);
    const auto presenter = FindHistoryChild<ListViewItemPresenter>(container);
    if (!presenter) return;
    if (contrast) {
        presenter.ClearValue(winrt::Microsoft::UI::Xaml::Controls::ContentPresenter::BackgroundProperty());
        presenter.ClearValue(winrt::Microsoft::UI::Xaml::Controls::ContentPresenter::BorderBrushProperty());
        presenter.ClearValue(ListViewItemPresenter::PointerOverBackgroundProperty());
        presenter.ClearValue(ListViewItemPresenter::PointerOverBorderBrushProperty());
        presenter.ClearValue(ListViewItemPresenter::PressedBackgroundProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedBackgroundProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedBorderBrushProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedPointerOverBackgroundProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedPointerOverBorderBrushProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedPressedBackgroundProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedPressedBorderBrushProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedDisabledBackgroundProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedDisabledBorderBrushProperty());
        presenter.ClearValue(ListViewItemPresenter::SelectedInnerBorderBrushProperty());
        presenter.SelectionIndicatorVisualEnabled(contrast);
        presenter.SelectionCheckMarkVisualEnabled(true);
        return;
    }
    const SolidColorBrush transparent{winrt::Windows::UI::Color{0, 0, 0, 0}};
    presenter.Background(transparent);
    presenter.BorderBrush(transparent);
    presenter.PointerOverBackground(transparent);
    presenter.PointerOverBorderBrush(transparent);
    presenter.PressedBackground(transparent);
    presenter.SelectedBackground(transparent);
    presenter.SelectedBorderBrush(transparent);
    presenter.SelectedPointerOverBackground(transparent);
    presenter.SelectedPointerOverBorderBrush(transparent);
    presenter.SelectedPressedBackground(transparent);
    presenter.SelectedPressedBorderBrush(transparent);
    presenter.SelectedDisabledBackground(transparent);
    presenter.SelectedDisabledBorderBrush(transparent);
    presenter.SelectedInnerBorderBrush(transparent);
    presenter.SelectionIndicatorVisualEnabled(contrast);
    presenter.SelectionCheckMarkVisualEnabled(true);
}

void BindHistoryScroll() {
    if (!g_panel.history || !g_panel.history.IsLoaded()) return;
    const auto scroll = FindHistoryChild<winrt::Microsoft::UI::Xaml::Controls::ScrollViewer>(g_panel.history);
    if (!scroll || scroll == g_panel.historyScroll) return;
    g_panel.historyScrollChanged.revoke();
    g_panel.historyManipulation.revoke();
    g_panel.historyScroll = scroll;
    if (g_historyView.restore) scroll.BringIntoViewOnFocusChange(false);
    g_panel.historyManipulation = scroll.DirectManipulationStarted(winrt::auto_revoke, [](auto const &, auto const &) {
        CancelHoverPreview();
        HistoryViewportInput();
    });
    g_panel.historyScrollChanged = scroll.ViewChanged(winrt::auto_revoke, [](auto const &sender, auto const &args) {
        if (g_updatingHistorySelection || !g_panel.history.IsLoaded() || !PanelVisible() ||
            g_panel.tagManagerViewActive) return;
        const auto scroller = sender.as<winrt::Microsoft::UI::Xaml::Controls::ScrollViewer>();
        CancelHoverPreview();
        if (g_historyView.restore) return;
        g_historyView.parkedOffset = scroller.HorizontalOffset();
        if (!args.IsIntermediate()) MaybeLoadMoreHistory();
    });
}

void MaybeLoadMoreHistory() {
    if (!g_panel.historyScroll || !g_panel.history.IsLoaded() || !PanelVisible() || IsIconic(g_panel.window) ||
        g_panel.tagManagerViewActive || g_deleteConfirmationOpen || g_historyView.restore ||
        (g_panel.cardDrag && g_panel.cardDrag->Active()) || NativeEditorOpen() ||
        (g_panel.imageExport && g_panel.imageExport->Active())) return;
    if (vpaste::winui::NearHistoryEnd(g_panel.historyScroll.HorizontalOffset(), g_panel.historyScroll.ScrollableWidth(),
        g_panel.historyScroll.ViewportWidth())) RequestMoreHistory(true);
}

void SyncHistoryViewport() {
    if (!g_panel.history || !g_panel.history.IsLoaded() || !PanelVisible() ||
        g_historyLoading || g_panel.tagManagerViewActive ||
        (g_panel.cardDrag && g_panel.cardDrag->Active())) return;
    BindHistoryScroll();
    if (!g_panel.historyScroll) return;
    if (g_historyView.restore) {
        if (g_historyView.restore->request != g_latestHistoryRequestId) return;
        g_panel.history.UpdateLayout();
        if (!g_historyView.restore || g_historyLoading || g_historyView.restore->request != g_latestHistoryRequestId) return;
        const auto request = g_historyView.restore->request;
        const auto offset = vpaste::winui::ClampHistoryOffset(g_historyView.restore->offset, g_panel.historyScroll.ScrollableWidth());
        g_historyView.restore->offset = offset;
        if (std::abs(g_panel.historyScroll.HorizontalOffset() - offset) <= 0.5) {
            g_historyView.restore->applied = true;
            VerifyHistoryViewportAfterRender();
            return;
        }
        g_historyView.restore->applied = true;
        g_panel.historyScroll.ChangeView(winrt::box_value(offset).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, nullptr, true);
        // ChangeView can synchronously deliver ViewChanged; do not retain a
        // reference into the optional across that callback.
        if (g_historyView.restore && g_historyView.restore->request == request) VerifyHistoryViewportAfterRender();
    }
    MaybeLoadMoreHistory();
}

void RequestSelectedAction(const wchar_t *operation) {
    if (NativeEditorOpen()) return;
    if (g_panel.cardDrag && g_panel.cardDrag->Active()) return;
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

void ActivateHistoryIndex(int index, bool plainText, bool quick) {
    if (NativeEditorOpen()) return;
    ShowAltHints(false);
    g_searchSubmitRequestId = 0;
    if (index == -1) {
        const auto selected = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
        index = selected == g_hashes.end() ? 0 : static_cast<int>(std::distance(g_hashes.begin(), selected));
    }
    if (index < 0 || static_cast<std::size_t>(index) >= g_hashes.size()) return;
    const auto item = g_panel.history.Items().GetAt(static_cast<std::uint32_t>(index));
    if (g_queueSelectionMode) {
        std::uint32_t selected = 0;
        if (g_panel.history.SelectedItems().IndexOf(item, selected)) g_panel.history.SelectedItems().RemoveAt(selected);
        else g_panel.history.SelectedItems().Append(item);
        return;
    }
    g_panel.history.SelectedIndex(index);
    if (quick) (void)SendRequest(L"quickPaste", g_hashes[index], false, 0, {}, {}, 0, std::to_wstring(index + 1));
    else RequestSelectedAction(plainText ? L"pastePlain" : L"paste");
}

void SubmitSearch(bool plainText = false, int index = 0, bool quick = false) {
    if (g_searchTimer.IsRunning()) { g_searchTimer.Stop(); RequestHistory(); }
    if (g_historyLoading && g_latestHistoryRequestId == g_latestQueryId) {
        g_searchSubmitRequestId = g_latestQueryId;
        g_searchSubmitIndex = index; g_searchSubmitPlain = plainText; g_searchSubmitQuick = quick;
    } else ActivateHistoryIndex(index, plainText, quick);
}

bool OpenSelectedCardMenu() {
    if (g_queueSelectionMode || g_panel.tagManagerViewActive || g_deleteConfirmationOpen ||
        NativeEditorOpen() ||
        (g_panel.cardDrag && g_panel.cardDrag->Active())) return false;
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
    if (found == g_hashes.end()) return false;
    g_searchSubmitRequestId = 0;
    const auto &row = g_panel.rows[static_cast<std::size_t>(std::distance(g_hashes.begin(), found))];
    row.surface.ContextFlyout().ShowAt(row.surface);
    return true;
}

void RequestSelectedPreview(const wchar_t *operation, int direction = 0) {
    if (NativeEditorOpen()) return;
    if (g_queueSelectionMode || g_panel.tagManagerViewActive ||
        g_deleteConfirmationOpen || g_selectedHash.empty() ||
        std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash) == g_hashes.end()) return;
    (void)SendRequest(operation, g_selectedHash, false, 0, {}, {}, direction);
}

void NavigatePreview(int direction, bool category = false) {
    if (NativeEditorOpen()) return;
    if (!g_panel.history || (g_queueSelectionMode && !category) ||
        g_panel.tagManagerViewActive || g_deleteConfirmationOpen) return;
    if (category) {
        const auto builtins = 2;
        const auto custom = static_cast<int>(g_panel.customTabs.Items().Size());
        const auto count = builtins + custom;
        if (!count) return;
        int current = std::min(FilterIndex(), builtins - 1);
        std::uint32_t index = 0;
        if (g_panel.customTabs.SelectedItem() && g_panel.customTabs.Items().IndexOf(g_panel.customTabs.SelectedItem(), index))
            current = builtins + static_cast<int>(index);
        const auto next = (current + direction + count) % count;
        if (next < builtins) g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(next));
        else g_panel.customTabs.SelectedItem(g_panel.customTabs.Items().GetAt(next - builtins));
        return;
    }
    if (g_hashes.empty()) return;
    HistoryViewportInput();
    const auto current = g_panel.history.SelectedIndex();
    const auto next = std::clamp(current < 0 ? 0 : current + direction, 0,
                                  static_cast<int>(g_hashes.size()) - 1);
    g_panel.history.SelectedIndex(next);
    g_panel.history.ScrollIntoView(g_panel.history.Items().GetAt(static_cast<std::uint32_t>(next)));
}

bool HandlePreviewKey(winrt::Windows::System::VirtualKey key, bool repeated,
                      bool control, bool shift, bool alt) {
    using winrt::Windows::System::VirtualKey;
    if (NativeEditorOpen()) return false;
    if (g_panel.cardDrag && g_panel.cardDrag->Active()) return false;
    if (g_queueSelectionMode || g_panel.tagManagerViewActive || g_deleteConfirmationOpen) return false;
    if (!control && !shift && !alt && (key == VirtualKey::Space || key == VirtualKey::Escape)) {
        if (!repeated) {
            if (key == VirtualKey::Space) RequestSelectedPreview(L"previewToggle");
            else (void)SendRequest(L"dismiss");
        }
        return true;
    }
    if (!control && !shift && !alt && (key == VirtualKey::Left || key == VirtualKey::Right)) {
        NavigatePreview(key == VirtualKey::Left ? -1 : 1);
        return true;
    }
    if (control && !alt && key == VirtualKey::Tab) {
        NavigatePreview(shift ? -1 : 1, true);
        return true;
    }
    return false;
}

void SelectBuiltinCategory(std::uint32_t index, bool refresh = true) {
    const auto languageGuard = std::exchange(g_updatingLanguage, true);
    const auto tagGuard = std::exchange(g_updatingTagFilter, true);
    g_selectedFilterId.clear(); g_selectedTagId = 0; g_selectedTagName.clear();
    g_panel.customTabs.SelectedItem(nullptr);
    g_panel.tagFilter.SelectedIndex(0);
    g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(index));
    g_updatingLanguage = languageGuard; g_updatingTagFilter = tagGuard;
    if (refresh) RequestHistory();
}

bool HandleMainKey(vpaste::winui::MainKeyInput input) {
    using namespace vpaste::winui;
    input.blocked = input.blocked || g_panel.tagManagerViewActive || g_deleteConfirmationOpen ||
        NativeEditorOpen() || (g_panel.cardDrag && g_panel.cardDrag->Active()) ||
        (g_panel.imageExport && g_panel.imageExport->Active());
    const auto result = ResolveMainKey(g_behavior, input);
    switch (result.action) {
    case MainKeyAction::None: return false;
    case MainKeyAction::Ignore: return true;
    case MainKeyAction::OpenCardMenu: return OpenSelectedCardMenu();
    case MainKeyAction::ShowHints: ShowAltHints(true); break;
    case MainKeyAction::FocusSearch:
        ShowSearch(); break;
    case MainKeyAction::NextCategory: NavigatePreview(1, true); break;
    case MainKeyAction::PreviousCategory: NavigatePreview(-1, true); break;
    case MainKeyAction::NextCard:
    case MainKeyAction::PreviousCard:
        if (g_queueSelectionMode) return false;
        NavigatePreview(result.action == MainKeyAction::NextCard ? 1 : -1);
        g_panel.history.UpdateLayout();
        SendMessageW(g_panel.window, kFocusHistory, 1, 0); break;
    case MainKeyAction::FirstCard:
    case MainKeyAction::LastCard:
    case MainKeyAction::NextPage:
    case MainKeyAction::PreviousPage: {
        if (g_queueSelectionMode) return false;
        BindHistoryScroll();
        const auto page = HistoryPageStep(g_panel.historyScroll ? g_panel.historyScroll.ViewportWidth() : kCardWidth, kCardWidth + 16);
        const auto distance = result.action == MainKeyAction::FirstCard ? -static_cast<int>(g_hashes.size())
            : result.action == MainKeyAction::LastCard ? static_cast<int>(g_hashes.size())
            : result.action == MainKeyAction::NextPage ? page : -page;
        NavigatePreview(distance);
        g_panel.history.UpdateLayout();
        SendMessageW(g_panel.window, kFocusHistory, 1, 0); break;
    }
    case MainKeyAction::PastePlain:
        if (g_queueSelectionMode) RequestSelectedAction(L"pastePlain");
        else SubmitSearch(true, -1);
        break;
    case MainKeyAction::SearchPaste: SubmitSearch(); break;
    case MainKeyAction::SearchPastePlain: SubmitSearch(true); break;
    case MainKeyAction::QuickItem: SubmitSearch(false, result.index, true); break;
    case MainKeyAction::QuickAll: SelectBuiltinCategory(0); break;
    case MainKeyAction::QuickFavorite: SelectBuiltinCategory(1); break;
    case MainKeyAction::ClearSearch: SetSearchText(L""); break;
    case MainKeyAction::CloseSearch:
        g_searchSubmitRequestId = 0;
        g_panel.search.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
        PostMessageW(g_panel.window, kFocusHistory, 1, 0); break;
    }
    return true;
}

vpaste::winui::InputArea MainInputArea(winrt::Windows::Foundation::IInspectable const &source) {
    auto element = source.try_as<winrt::Microsoft::UI::Xaml::DependencyObject>();
    bool button = false;
    while (element) {
        if (element == g_panel.search) return vpaste::winui::InputArea::Search;
        if (element == g_panel.history) return button ? vpaste::winui::InputArea::Other : vpaste::winui::InputArea::History;
        if (element.try_as<winrt::Microsoft::UI::Xaml::Controls::Primitives::ButtonBase>()) button = true;
        element = winrt::Microsoft::UI::Xaml::Media::VisualTreeHelper::GetParent(element);
    }
    return vpaste::winui::InputArea::Other;
}

bool NativeControlOwnsKeys(winrt::Windows::Foundation::IInspectable const &source) {
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    if (g_panel.commands && g_panel.commands.IsOpen()) return true;
    auto element = source.try_as<winrt::Microsoft::UI::Xaml::DependencyObject>();
    bool textEditor = false, button = false;
    while (element) {
        // AutoSuggestBox owns an inner TextBox and clear/query buttons. Route
        // typing shortcuts through the search policy, but leave its buttons
        // with their native Enter/Space behavior.
        if (element == g_panel.search) return button;
        if (element.try_as<MenuFlyoutItemBase>() || element.try_as<MenuFlyoutPresenter>() ||
            element.try_as<FlyoutPresenter>() || element.try_as<ComboBox>()) return true;
        textEditor = textEditor || static_cast<bool>(element.try_as<TextBox>());
        button = button || static_cast<bool>(element.try_as<Primitives::ButtonBase>());
        element = winrt::Microsoft::UI::Xaml::Media::VisualTreeHelper::GetParent(element);
    }
    return textEditor;
}

bool PointerHistoryAllowed() {
    if (!g_panel.root || !g_panel.root.IsLoaded() || !g_panel.history || !g_panel.history.IsLoaded() ||
        !PanelVisible() || IsIconic(g_panel.window) || g_historyLoading ||
        (g_searchTimer && g_searchTimer.IsRunning()) || g_queueSelectionMode ||
        g_panel.tagManagerViewActive || g_deleteConfirmationOpen || NativeEditorOpen() ||
        (g_panel.cardDrag && g_panel.cardDrag->Active()) ||
        (g_panel.imageExport && g_panel.imageExport->Active())) return false;
    const auto foreground = GetForegroundWindow();
    return (foreground == g_panel.window || IsChild(g_panel.window, foreground)) &&
        !NativeControlOwnsKeys(winrt::Microsoft::UI::Xaml::Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot()));
}

std::optional<winrt::Windows::Foundation::Point> g_hoverPosition;
void HoverHistoryCard(std::wstring const &hash, winrt::hstring const &type,
    winrt::Windows::Foundation::Point point, bool interactive, bool contact) {
    if (g_hoverPosition && g_hoverPosition->X == point.X && g_hoverPosition->Y == point.Y) return;
    g_hoverPosition = point;
    if (contact || !PointerHistoryAllowed()) { CancelHoverPreview(); return; }
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), hash);
    if (found == g_hashes.end()) return;
    if (g_selectedHash != hash) {
        CancelHoverPreview();
        HistoryViewportInput();
        g_panel.history.SelectedIndex(static_cast<int>(std::distance(g_hashes.begin(), found)));
    }
    if (interactive) g_panel.hoverPreview->Leave();
    else g_panel.hoverPreview->Enter(hash, std::wstring{type});
}

bool IsEditableTextItem(const winrt::hstring &type) {
    return type == L"Text" || type == L"TextFile" || type == L"Link" ||
           type == L"Color";
}

void UpdateQueueSelectionControls() {
    if (!g_panel.history || !g_panel.copy || !g_panel.paste || !g_panel.favorite ||
        !g_panel.queueSelect || !g_panel.queueAdd || !g_panel.selectionBar) return;
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
    g_panel.queueSelect.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
        : winrt::Microsoft::UI::Xaml::Visibility::Visible);
    g_panel.queueSelect.Label(g_queueSelectionMode
        ? Text(L"取消选择", L"Cancel selection")
        : Text(L"选择加入队列", L"Select for queue"));
    g_panel.queueSelect.Icon(winrt::Microsoft::UI::Xaml::Controls::SymbolIcon{
        g_queueSelectionMode ? winrt::Microsoft::UI::Xaml::Controls::Symbol::Cancel
                             : winrt::Microsoft::UI::Xaml::Controls::Symbol::SelectAll});
    g_panel.queueAdd.IsEnabled(g_queueSelectionMode && !g_queueSelectedHashes.empty() && !g_queueSelectionAdding);
    const bool enteringSelection = g_queueSelectionMode &&
        g_panel.selectionBar.Visibility() != winrt::Microsoft::UI::Xaml::Visibility::Visible;
    if (!g_queueSelectionMode) vpaste::winui::ResetFeedbackOpacity(g_panel.selectionBar);
    g_panel.selectionBar.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Visible
        : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    g_panel.selectionTitle.Text(Text(L"选择加入队列", L"Select for queue"));
    winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
        g_panel.selectionBar, g_panel.selectionTitle.Text());
    const auto countText = winrt::hstring{std::to_wstring(g_queueSelectedHashes.size())} + L" " + Text(L"条已选择", L"selected");
    const bool countChanged = g_panel.selectionCount.Text() != countText;
    g_panel.selectionCount.Text(countText);
    using namespace winrt::Microsoft::UI::Xaml::Automation;
    AutomationProperties::SetName(g_panel.selectionCount, countText);
    AutomationProperties::SetLiveSetting(g_panel.selectionCount, Peers::AutomationLiveSetting::Polite);
    if (g_queueSelectionMode && PanelVisible()) {
        if (enteringSelection) vpaste::winui::FadeFeedback(g_panel.selectionBar);
        if (countChanged) if (const auto peer = Peers::FrameworkElementAutomationPeer::FromElement(g_panel.selectionCount))
            peer.RaiseAutomationEvent(Peers::AutomationEvents::LiveRegionChanged);
    }
    g_panel.queueAdd.Content(winrt::box_value(g_queueSelectionAdding
        ? Text(L"正在加入…", L"Adding…") : Text(L"加入队列", L"Add to queue")));
    g_panel.cancelSelection.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Visible
        : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    g_panel.copy.IsEnabled(!g_queueSelectionMode && !g_selectedHash.empty());
    g_panel.paste.IsEnabled(!g_queueSelectionMode && !g_selectedHash.empty());
    if (g_panel.queueOpen) {
        g_panel.queueOpen.Label(g_queueViewActive
            ? Text(L"关闭粘贴队列", L"Close paste queue") : Text(L"粘贴队列", L"Paste queue"));
        vpaste::winui::ApplyStyle(g_panel.queueOpen, g_queueViewActive
            ? L"VPaste.ActiveToolbarCommand" : L"VPaste.RoundToolbarCommand");
    }
    UpdateFavoriteButton();
}

void ToggleQueueSelectionMode(bool updateStatus = true) {
    if (!g_panel.history) return;
    if (!g_queueSelectionMode) {
        g_queueReturnHash = g_selectedHash;
        (void)SendRequest(L"previewDismiss");
    }
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
        const auto previous = std::find(g_hashes.begin(), g_hashes.end(), g_queueReturnHash);
        const bool updating = std::exchange(g_updatingHistorySelection, true);
        g_panel.history.SelectedIndex(previous == g_hashes.end() ? -1 : static_cast<int>(std::distance(g_hashes.begin(), previous)));
        g_selectedHash = previous == g_hashes.end() ? std::wstring{} : *previous;
        g_updatingHistorySelection = updating;
        g_queueReturnHash.clear();
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
    if (!g_queueSelectionMode || g_queueSelectedHashes.empty() || g_queueSelectionAdding) return;
    g_queueSubmittedHashes = g_queueSelectedHashes;
    g_queueSelectionAddRequest = SendRequest(L"queueAdd", {}, false, 0, g_queueSubmittedHashes);
    g_queueSelectionAdding = g_queueSelectionAddRequest != 0;
    UpdateQueueSelectionControls();
}

winrt::fire_and_forget ConfirmDeleteItem(std::wstring hash) {
    if (g_deleteConfirmationOpen || !g_panel.root) co_return;
    g_deleteConfirmationOpen = true;
    (void)SendRequest(L"previewDismiss");
    try {
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        g_panel.deletionDialog = vpaste::winui::MakeConfirmationDialog(g_panel.root,
            Text(L"删除剪贴板记录", L"Delete clipboard record"), Text(
            L"此操作无法撤销。确定要删除这条记录吗？",
            L"This action cannot be undone. Delete this record?"),
            Text(L"删除", L"Delete"), Text(L"取消", L"Cancel"));
        const auto result = co_await g_panel.deletionDialog.ShowAsync();
        g_panel.deletionDialog = nullptr;
        g_deleteConfirmationOpen = false;
        if (result == ContentDialogResult::Primary && g_panel.root.IsLoaded()) {
            (void)SendRequest(L"delete", hash);
        }
    } catch (...) {
        g_panel.deletionDialog = nullptr;
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
    if (type == L"TextFile") return Text(L"文本", L"Text");
    return vpaste::winui::TypeLabel(type, g_english);
}

void ApplyResponse(const std::string &bytes) {
    try {
        using namespace winrt::Windows::Data::Json;
        const auto response = JsonObject::Parse(winrt::to_hstring(bytes));
        const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
        const auto operation = response.GetNamedString(L"op", L"");
        if (operation == L"nativeReaderBegin" || operation == L"nativeReader" ||
            operation == L"nativeReaderHide" || operation == L"nativeReaderFocus") {
            if (g_panel.reader) g_panel.reader->Receive(response);
            return;
        }
        if (operation == L"previewHover") {
            if (g_panel.hoverPreview) g_panel.hoverPreview->PreviewPointer(response.GetNamedObject(L"data").GetNamedBoolean(L"inside"));
            return;
        }
        if (operation == L"hoverPreview" || operation == L"hoverDismiss") return;
        if (g_panel.appActions && g_panel.appActions->Receive(response)) return;
        if (operation == L"captureRejected") {
            ShowFeedback(Text(L"复制内容过大，未加入历史记录", L"Copied content is too large to save in history"),
                winrt::Microsoft::UI::Xaml::Controls::InfoBarSeverity::Warning);
            return;
        }
        if (operation == L"tabOrderLoad" || operation == L"tabOrderChanged" || operation == L"tabOrderSave") {
            if (operation == L"tabOrderSave") {
                if (id != g_tabOrderSaveRequest) return;
                g_tabOrderSaveRequest = 0;
                if (response.HasKey(L"error")) {
                    ShowFeedback(response.GetNamedString(L"error"), true);
                    g_tabOrderLoadRequest = SendRequest(L"tabOrderLoad");
                }
                // Successful moves publish tab-order-changed from the shared store.
                return;
            }
            if (operation == L"tabOrderLoad" && (!id || id != g_tabOrderLoadRequest)) return;
            // An event supersedes any read already in flight.
            g_tabOrderLoadRequest = 0;
            if (response.HasKey(L"error")) {
                ShowFeedback(response.GetNamedString(L"error"), true);
            } else {
                const auto data = response.GetNamedObject(L"data");
                g_tabOrder.clear();
                for (auto const &value : data.GetNamedArray(L"order")) g_tabOrder.push_back(std::wstring{value.GetString()});
                RebuildDynamicTabs();
            }
            return;
        }
        if (operation == L"editorClosed") {
            // Restore this editing context rather than applying fresh-show resets.
            SetVisible(true, false);
            PostMessageW(g_panel.window, kFocusHistory, 0, 0);
            return;
        }
        if (operation == L"exportPrepare" || operation == L"exportImage") {
            if (g_panel.imageExport) g_panel.imageExport->Receive(response);
            return;
        }
        if (operation == L"dragPrepare") {
            if (g_panel.cardDrag) g_panel.cardDrag->Receive(response);
            return;
        }
        if (operation == L"filterSources" || operation == L"filtersSave" || operation == L"filtersDelete") {
            if (g_panel.filterEditor) g_panel.filterEditor->Receive(response);
            // Closing a flyout cannot cancel an already committed Rust write.
            // Query the authoritative list even when that editor session ended.
            if (operation != L"filterSources" && !response.HasKey(L"error")) RefreshFilters();
            return;
        }
        if (operation == L"recordTagCreate" || operation == L"recordTagRename" ||
            operation == L"recordTagDelete" || operation == L"recordTagAssign") {
            if (g_panel.recordTagEditor) g_panel.recordTagEditor->Receive(response);
            return;
        }
        if (operation == L"filtersList") {
            if (id < g_latestFiltersRequestId) return;
            if (response.HasKey(L"error")) ShowFeedback(response.GetNamedString(L"error"), true);
            else ApplyFilters(response.GetNamedObject(L"data").GetNamedArray(L"items"));
            return;
        }
        if ((operation == L"query" || operation == L"queryMore") &&
            g_panel.cardDrag && g_panel.cardDrag->Active()) {
            g_historyRefreshAfterDrag = true;
            return;
        }
        if (operation == L"previewNavigation") {
            const auto data = response.GetNamedObject(L"data");
            const auto source = static_cast<std::uint64_t>(data.GetNamedNumber(L"sourceRequest", 0));
            if (!source || (source != g_latestPreviewRequestId && source != g_latestHoverRequestId) || !PanelVisible()) return;
            const auto key = data.GetNamedString(L"key", L"");
            NavigatePreview(data.GetNamedNumber(L"direction", 1) < 0 ? -1 : 1,
                key == L"Tab" && data.GetNamedBoolean(L"ctrlKey", false));
            return;
        }
        if (operation == L"dismiss" || operation == L"previewToggle" || operation == L"previewSelect" ||
            operation == L"previewClose" || operation == L"previewDismiss") {
            if ((operation == L"dismiss" || id == g_latestPreviewRequestId) && response.HasKey(L"error")) {
                g_panel.status.Text(response.GetNamedString(L"error"));
                ShowFeedback(g_panel.status.Text(), true);
            }
            return;
        }
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
            const bool queueHandled = g_panel.queueView && g_panel.queueView->Receive(response);
            if (operation == L"queueAdd" && id != 0 && id < g_queueSelectionAddRequest) {
                if (!response.HasKey(L"error") && !queueHandled && g_panel.queueView)
                    g_panel.queueView->SetState(response.GetNamedObject(L"data"));
                return;
            }
            const bool selectionAdd = operation == L"queueAdd" && id == g_queueSelectionAddRequest;
            if (selectionAdd && !g_queueSelectionAdding) return;
            if (selectionAdd) g_queueSelectionAdding = false;
            if (response.HasKey(L"error")) {
                const auto message = response.GetNamedString(L"error");
                if (!queueHandled && selectionAdd && g_panel.queueView) {
                    g_panel.queueView->SetError(std::wstring(message));
                }
                if (g_panel.status) g_panel.status.Text(message);
                if (operation == L"queueAdd" && g_panel.queueAdd) {
                    UpdateQueueSelectionControls();
                }
                if (selectionAdd) ShowFeedback(message, true);
                return;
            }
            if (!queueHandled && g_panel.queueView && operation != L"queueOpen" && operation != L"queueClose") {
                g_panel.queueView->SetState(response.GetNamedObject(L"data"));
            }
            if (operation == L"queueAdd") {
                g_panel.status.Text(Text(L"已加入粘贴队列", L"Added to paste queue"));
                if (selectionAdd && g_queueSelectionMode) {
                    for (const auto &hash : g_queueSubmittedHashes)
                        g_queueSelectedHashes.erase(std::remove(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), hash), g_queueSelectedHashes.end());
                    g_updatingHistorySelection = true;
                    g_panel.history.SelectedItems().Clear();
                    for (std::size_t index = 0; index < g_hashes.size(); ++index)
                        if (std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), g_hashes[index]) != g_queueSelectedHashes.end())
                            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(static_cast<std::uint32_t>(index)));
                    g_updatingHistorySelection = false;
                    UpdateQueueSelectionControls(); ApplyRowTheme();
                    g_panel.status.Text(std::to_wstring(g_queueSelectedHashes.size()) + L" " + Text(L"条已选择", L"selected"));
                }
            }
            return;
        }
        if (response.HasKey(L"error")) {
            if (operation == L"card") {
                for (auto &row : g_panel.rows) if (row.cardRequestId == id) {
                    row.pendingBitmap = nullptr;
                    SetCardDetailState(row, CardDetailState::Failed, response.GetNamedString(L"error"));
                    break;
                }
                return;
            }
            g_panel.status.Text(response.GetNamedString(L"error"));
            if (operation == L"copy" || operation == L"paste" || operation == L"favorite" ||
                operation == L"delete" || operation == L"assignTag" || operation == L"removeTag" || operation == L"edit" ||
                operation == L"copyPlain" || operation == L"pastePlain" || operation == L"quickPaste" || operation == L"openFolder" ||
                operation == L"copyFolder" || operation == L"copyColor" || operation == L"clearTags" || operation == L"imageText") {
                ShowFeedback(g_panel.status.Text(), true);
            }
            if (operation == L"query") {
                g_historyView.restore.reset(); g_historyView.parkedOffset = 0;
                g_searchSubmitRequestId = 0;
                g_historyLoading = false;
                g_historyFailed = true;
                g_updatingHistorySelection = true;
                g_panel.history.Items().Clear();
                g_hashes.clear();
                g_selectedHash.clear();
                g_favorites.clear();
                g_panel.rows.clear();
                g_panel.cardRequested.clear();
                g_hasMore = false;
                g_panel.more.IsEnabled(false);
                g_updatingHistorySelection = false;
                UpdateQueueSelectionControls();
                ApplyRowTheme();
                UpdateHistoryState();
            } else if (operation == L"queryMore") {
                g_historyView.pageFailed = true;
                g_historyLoading = false;
                g_panel.more.IsEnabled(g_hasMore);
                UpdateHistoryState();
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
            if (id < row.cardRequestId) return;
            row.cardRequestId = id;
            row.pendingBitmap = nullptr;
            SetCardDetailState(row, CardDetailState::Ready);
            const auto actions = data.GetNamedValue(L"actions", nullptr);
            if (actions && actions.ValueType() == JsonValueType::Object)
                vpaste::winui::UpdateCardActions(row.menu, actions.GetObject(), hash, SendCardAction);
            row.accent = ParseColor(data.GetNamedString(L"titleColor", L""));
            const auto headerValue = data.GetNamedValue(L"headerColor", nullptr);
            if (headerValue && headerValue.ValueType() == JsonValueType::Object) {
                const auto color = headerValue.GetObject();
                row.accent = Rgb(static_cast<std::uint8_t>(color.GetNamedNumber(L"r", 0)),
                    static_cast<std::uint8_t>(color.GetNamedNumber(L"g", 0)),
                    static_cast<std::uint8_t>(color.GetNamedNumber(L"b", 0)));
            }
            row.header.Background(row.accent ? winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{*row.accent} : TypeBrush(row.itemType));
            const auto sourcePath = data.GetNamedString(L"appIconPath", L"");
            if (!sourcePath.empty()) {
                try {
                    winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage icon;
                    icon.DecodePixelWidth(128);
                    icon.UriSource(vpaste::winui::LocalAssetUri(sourcePath));
                    row.sourceIcon.Source(icon);
                    row.sourceFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                } catch (const winrt::hresult_error &) {
                    row.sourceFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                }
            }
            const auto detail = data.GetNamedString(L"displayText", L"");
            // A successful replacement is authoritative. Retain reference
            // content during requests/failures, not stale decoded/rich surfaces.
            row.image.Source(nullptr);
            row.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
            row.contentIcon.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
            row.richFrame.Child(nullptr);
            row.richFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
            row.richBadge.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
            row.preview.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
            UpdateCardContent(row, detail.empty() ? row.preview.Text() : detail);
            if (row.itemType == L"File" || row.itemType == L"Link") {
                const auto fileCount = static_cast<int>(data.GetNamedNumber(L"fileCount", 0));
                const auto title = fileCount > 1
                    ? winrt::hstring{std::to_wstring(fileCount)} + Text(L" 个文件", L" files")
                    : data.GetNamedString(L"displayTitle", L"");
                if (!title.empty()) row.preview.Text(title);
                const auto subtitle = data.GetNamedString(L"displaySubtitle", L"");
                row.subtitle.Text(subtitle);
                row.subtitle.Visibility(subtitle.empty() ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                    : winrt::Microsoft::UI::Xaml::Visibility::Visible);
                row.preview.MaxLines(2);
                row.format.Text(data.GetNamedString(L"fileFormat", L""));
                row.format.Visibility(row.format.Text().empty() ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                    : winrt::Microsoft::UI::Xaml::Visibility::Visible);
                if (row.itemType == L"File") row.contentIcon.Glyph(fileCount > 1 ? L"\uE8C8"
                    : data.GetNamedString(L"fileKind", L"") == L"single-folder" ? L"\uE8B7" : L"\uE8A5");
            }
            const auto swatchValue = data.GetNamedValue(L"swatchColor", nullptr);
            if (row.itemType == L"Color" && swatchValue && swatchValue.ValueType() == JsonValueType::Object) {
                const auto swatch = swatchValue.GetObject();
                const winrt::Windows::UI::Color color{
                    static_cast<std::uint8_t>(swatch.GetNamedNumber(L"a", 255)),
                    static_cast<std::uint8_t>(swatch.GetNamedNumber(L"r", 0)),
                    static_cast<std::uint8_t>(swatch.GetNamedNumber(L"g", 0)),
                    static_cast<std::uint8_t>(swatch.GetNamedNumber(L"b", 0))};
                row.colorSwatch.Background(winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{color});
                row.colorSwatch.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                row.contentIcon.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
            }
            const auto mediaValue = data.GetNamedValue(L"media", nullptr);
            const auto media = mediaValue && mediaValue.ValueType() == JsonValueType::Object ? mediaValue.GetObject() : JsonObject{};
            row.imageWidth = media.GetNamedNumber(L"width", 0); row.imageHeight = media.GetNamedNumber(L"height", 0);
            ApplyNaturalImageBounds(row);
            const auto dimensions = winrt::hstring{vpaste::winui::MediaCaption(media, data.GetNamedString(L"dimensions", L""), g_english, row.itemType == L"Image")};
            row.dimensions.Text(dimensions);
            row.dimensions.Visibility(dimensions.empty()
                                          ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                                          : winrt::Microsoft::UI::Xaml::Visibility::Visible);
            const auto assetPath = data.GetNamedString(L"assetPath", L"");
            if (!assetPath.empty()) {
                try {
                    winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage bitmap;
                    bitmap.DecodePixelWidth(static_cast<int>(data.GetNamedNumber(L"cardPixelWidth", 480)));
                    row.pendingBitmap = bitmap;
                    SetCardDetailState(row, CardDetailState::Loading);
                    bitmap.ImageOpened([hash, id](auto const &sender, auto const &) {
                        CompleteCardBitmap(hash, id, sender.as<winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage>(), true);
                    });
                    bitmap.ImageFailed([hash, id](auto const &sender, auto const &args) {
                        CompleteCardBitmap(hash, id, sender.as<winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage>(), false, args.ErrorMessage());
                    });
                    // WinUI URI decoding is demand-driven. Attach the source
                    // before waiting for its ImageOpened/ImageFailed event.
                    row.image.Source(bitmap);
                    row.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                    bitmap.UriSource(vpaste::winui::LocalAssetUri(assetPath));
                } catch (const winrt::hresult_error &error) {
                    row.pendingBitmap = nullptr;
                    row.image.Source(nullptr);
                    row.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                    SetCardDetailState(row, CardDetailState::Failed, error.message());
                }
            } else if (media.GetNamedBoolean(L"previewLimited", false)) SetCardDetailState(row, CardDetailState::Limited);
            const auto mediaError = data.GetNamedString(L"mediaError", L"");
            if (!mediaError.empty()) {
                row.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                row.contentIcon.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                SetCardDetailState(row, CardDetailState::Failed, mediaError);
            }
            const auto richValue = data.GetNamedValue(L"rich", nullptr);
            if (richValue && richValue.ValueType() == JsonValueType::Object) {
                const auto rich = richValue.GetObject();
                const auto blocks = rich.GetNamedArray(L"blocks");
                if (blocks.Size()) {
                    row.richFrame.Child(vpaste::winui::RenderRichContent(blocks, rich.GetNamedBoolean(L"darkCanvas", false), g_highlightTerms));
                    row.richFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                    row.richBadge.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                    row.preview.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                    row.mediaFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                    row.dimensions.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                }
            }
            HighlightCard(row);
            return;
        }
        if (operation != L"query" && operation != L"queryMore") {
            if (operation == L"copy" || operation == L"copyPlain" || operation == L"copyFolder" || operation == L"copyColor") {
                g_panel.status.Text(Text(L"已复制", L"Copied"));
                RequestHistory();
            } else if (operation == L"paste" || operation == L"pastePlain" || operation == L"quickPaste") {
                g_panel.status.Text(Text(L"已粘贴", L"Pasted"));
            } else if (operation == L"favorite") {
                g_panel.status.Text(Text(L"收藏状态已更新", L"Favorite updated"));
                RequestHistory();
            } else if (operation == L"delete") {
                const auto deletedHash = std::wstring(data.GetNamedString(L"hash", L""));
                if (g_queueSelectionMode && !deletedHash.empty()) {
                    g_updatingHistorySelection = true;
                    const auto found = std::find(g_hashes.begin(), g_hashes.end(), deletedHash);
                    if (found != g_hashes.end()) {
                        const auto item = g_panel.history.Items().GetAt(static_cast<std::uint32_t>(
                            std::distance(g_hashes.begin(), found)));
                        std::uint32_t selectedIndex = 0;
                        if (g_panel.history.SelectedItems().IndexOf(item, selectedIndex)) {
                            g_panel.history.SelectedItems().RemoveAt(selectedIndex);
                        }
                    }
                    g_queueSelectedHashes.erase(std::remove(
                        g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), deletedHash),
                        g_queueSelectedHashes.end());
                    g_updatingHistorySelection = false;
                    UpdateQueueSelectionControls();
                    ApplyRowTheme();
                }
                g_panel.status.Text(Text(L"记录已删除", L"Record deleted"));
                RequestHistory();
            } else if (operation == L"assignTag" || operation == L"removeTag" || operation == L"clearTags") {
                g_panel.status.Text(Text(L"标签已更新", L"Tags updated"));
            } else {
                g_panel.status.Text(data.GetNamedString(
                    L"message", Text(L"操作已完成", L"Action completed")));
            }
            if (operation == L"copy" || operation == L"favorite" || operation == L"delete" ||
                operation == L"assignTag" || operation == L"removeTag" || operation == L"clearTags" ||
                operation == L"copyPlain" || operation == L"copyFolder" || operation == L"copyColor" ||
                operation == L"openFolder") ShowFeedback(g_panel.status.Text());
            return;
        }

        if (data.HasKey(L"highlightTerms") || operation == L"query") {
            g_highlightTerms.clear();
            for (const auto &term : data.GetNamedArray(L"highlightTerms", JsonArray{})) {
                if (term.ValueType() == JsonValueType::String && !term.GetString().empty()) g_highlightTerms.emplace_back(term.GetString());
                if (g_highlightTerms.size() == 8) break;
            }
        }
        const auto viewportOffset = HistoryOffset();
        const bool resetSelection = operation == L"query" && g_historyView.resetOnShow;
        const bool resetViewport = operation == L"query" && (g_historyView.resetOnShow || g_historyView.requestedQuery != g_historyView.visibleQuery);
        QueueHistoryOffset(resetViewport ? 0 : viewportOffset, id);
        if (operation == L"query") {
            g_historyView.visibleQuery = g_historyView.requestedQuery;
            g_historyView.resetOnShow = false;
        }
        std::wstring selectionToRestore;
        std::uint64_t recordToRestore = 0;
        g_historyLoading = false;
        g_historyFailed = false;
        g_updatingHistorySelection = true;
        if (operation == L"query") {
            if (!g_queueSelectionMode && !resetSelection) {
                selectionToRestore = g_selectedHash;
                if (const auto selected = FindCard(selectionToRestore)) recordToRestore = selected->recordId;
            }
            g_panel.history.Items().Clear();
            g_hashes.clear();
            g_selectedHash.clear();
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
            for (int rowIndex = 0; rowIndex < 3; ++rowIndex) {
                row.RowDefinitions().Append(RowDefinition{});
            }
            row.RowDefinitions().GetAt(0).Height(GridLength{kCardHeaderHeight, GridUnitType::Pixel});
            row.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Star});
            row.RowDefinitions().GetAt(2).Height(GridLength{0, GridUnitType::Pixel});

            Border header;
            header.CornerRadius(CornerRadius{kCardRadius - 1, kCardRadius - 1, 0, 0});
            header.Padding(Thickness{12, 0, 0, 0});
            Grid headerContent;
            headerContent.ColumnDefinitions().Append(ColumnDefinition{});
            headerContent.ColumnDefinitions().Append(ColumnDefinition{});
            headerContent.ColumnDefinitions().Append(ColumnDefinition{});
            headerContent.ColumnDefinitions().GetAt(0).Width(GridLength{1, GridUnitType::Star});
            headerContent.ColumnDefinitions().GetAt(1).Width(GridLength{1, GridUnitType::Auto});
            headerContent.ColumnDefinitions().GetAt(2).Width(GridLength{1, GridUnitType::Auto});
            TextBlock typeText = MakeText(typeLabel, 13);
            typeText.FontWeight(winrt::Microsoft::UI::Text::FontWeights::Bold());
            typeText.TextWrapping(TextWrapping::NoWrap);
            typeText.TextTrimming(TextTrimming::CharacterEllipsis);
            typeText.VerticalAlignment(VerticalAlignment::Center);
            StackPanel titleBlock;
            titleBlock.VerticalAlignment(VerticalAlignment::Center);
            StackPanel titleLine;
            titleLine.Orientation(Orientation::Horizontal);
            titleLine.Spacing(4);
            titleLine.Children().Append(typeText);
            TextBlock richBadge = MakeText(Text(L"富文本", L"Rich"), 10);
            richBadge.Foreground(Brush(255, 255, 255));
            richBadge.Opacity(0.85);
            richBadge.Visibility(Visibility::Collapsed);
            titleLine.Children().Append(richBadge);
            titleBlock.Children().Append(titleLine);
            const auto now = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
            TextBlock timeText = MakeText(FormatCardTime(static_cast<std::uint64_t>(item.GetNamedNumber(L"time", 0)), now), 11);
            timeText.TextWrapping(TextWrapping::NoWrap);
            titleBlock.Children().Append(timeText);
            headerContent.Children().Append(titleBlock);
            StackPanel cardActions;
            cardActions.Orientation(Orientation::Horizontal);
            const auto favoriteIcon = vpaste::winui::Glyph(favorite ? L"\uE735" : L"\uE734");
            Button favoriteButton = vpaste::winui::NamedIconButton(favoriteIcon,
                favorite ? Text(L"取消收藏", L"Remove favorite") : Text(L"收藏", L"Add favorite"));
            favoriteButton.Width(24);
            favoriteButton.Height(24);
            favoriteButton.Visibility(favorite ? Visibility::Visible : Visibility::Collapsed);
            favoriteIcon.Foreground(Brush(255, 255, 255));
            favoriteIcon.FontSize(12);
            cardActions.Children().Append(favoriteButton);
            Button cardMenu = vpaste::winui::NamedIconButton(vpaste::winui::Glyph(L"\uE712"),
                Text(L"剪贴项操作", L"Item actions"));
            ToolTipService::SetToolTip(cardMenu, winrt::box_value(Text(L"剪贴项操作 (Shift+F10)", L"Item actions (Shift+F10)")));
            cardMenu.Width(28);
            cardMenu.Height(28);
            cardMenu.Visibility(Visibility::Collapsed);
            cardActions.Children().Append(cardMenu);
            Grid::SetColumn(cardActions, 1);
            headerContent.Children().Append(cardActions);
            Image sourceIcon;
            sourceIcon.Width(54);
            sourceIcon.Height(54);
            sourceIcon.Opacity(0.92);
            sourceIcon.Stretch(Media::Stretch::Uniform);
            Media::CompositeTransform sourceScale;
            sourceScale.ScaleX(1.14);
            sourceScale.ScaleY(1.14);
            sourceScale.TranslateX(3);
            sourceIcon.RenderTransform(sourceScale);
            sourceIcon.RenderTransformOrigin({0.5f, 0.5f});
            Border sourceFrame;
            sourceFrame.Width(56);
            sourceFrame.Height(kCardHeaderHeight);
            sourceFrame.Child(sourceIcon);
            sourceFrame.Visibility(Visibility::Collapsed);
            Media::RectangleGeometry crop;
            crop.Rect({0, 0, 56, static_cast<float>(kCardHeaderHeight)});
            sourceFrame.Clip(crop);
            sourceIcon.ImageFailed([](auto const &sender, auto const &) {
                if (const auto frame = sender.as<Image>().Parent().try_as<Border>()) frame.Visibility(Visibility::Collapsed);
            });
            Grid::SetColumn(sourceFrame, 2);
            headerContent.Children().Append(sourceFrame);
            header.Child(headerContent);
            Grid::SetRow(header, 0);
            row.Children().Append(header);

            Grid body;
            body.Margin(Thickness{8, tagNames.empty() ? 8.0 : 16.0, 8, 8});
            body.RowSpacing(4);
            for (int bodyRow = 0; bodyRow < 5; ++bodyRow) {
                RowDefinition definition;
                definition.Height(GridLength{1, bodyRow == 1 ? GridUnitType::Star : GridUnitType::Auto});
                body.RowDefinitions().Append(definition);
            }
            Border mediaFrame;
            vpaste::winui::ApplyStyle(mediaFrame, L"VPaste.Inset");
            Grid mediaArea;
            mediaArea.Padding(vpaste::winui::UniformThickness(4));
            auto contentIcon = vpaste::winui::Glyph(vpaste::winui::TypeGlyph(type));
            contentIcon.FontSize(32);
            mediaArea.Children().Append(contentIcon);
            Border colorSwatch;
            colorSwatch.CornerRadius(vpaste::winui::UniformRadius(4));
            colorSwatch.Visibility(Visibility::Collapsed);
            mediaArea.Children().Append(colorSwatch);
            Image mediaImage;
            mediaImage.Stretch(winrt::Microsoft::UI::Xaml::Media::Stretch::Uniform);
            mediaImage.Visibility(Visibility::Collapsed);
            mediaArea.Children().Append(mediaImage);
            TextBlock fileFormat = MakeText(L"", 11);
            fileFormat.HorizontalAlignment(HorizontalAlignment::Right);
            fileFormat.VerticalAlignment(VerticalAlignment::Bottom);
            fileFormat.Visibility(Visibility::Collapsed);
            mediaArea.Children().Append(fileFormat);
            mediaFrame.Child(mediaArea);
            body.Children().Append(mediaFrame);

            TextBlock previewText = MakeText(preview.empty() ? typeLabel : preview, 13);
            previewText.LineHeight(19.5);
            previewText.MaxLines(8);
            previewText.VerticalAlignment(VerticalAlignment::Top);
            previewText.TextTrimming(TextTrimming::CharacterEllipsis);
            Grid::SetRow(previewText, 1);
            if (type == L"Color") {
                Border colorLabel;
                colorLabel.Background(Media::SolidColorBrush{winrt::Windows::UI::Color{205, 255, 255, 255}});
                colorLabel.CornerRadius(vpaste::winui::UniformRadius(12));
                colorLabel.Padding(Thickness{8, 4, 8, 4});
                colorLabel.HorizontalAlignment(HorizontalAlignment::Center);
                colorLabel.VerticalAlignment(VerticalAlignment::Center);
                previewText.FontWeight(winrt::Microsoft::UI::Text::FontWeights::SemiBold());
                colorLabel.Child(previewText);
                mediaArea.Children().Append(colorLabel);
            } else body.Children().Append(previewText);
            TextBlock subtitleText = MakeText(L"", 12);
            subtitleText.MaxLines(2);
            subtitleText.TextTrimming(TextTrimming::CharacterEllipsis);
            subtitleText.Visibility(Visibility::Collapsed);
            Grid::SetRow(subtitleText, 2);
            body.Children().Append(subtitleText);
            Border richFrame;
            richFrame.CornerRadius(vpaste::winui::UniformRadius(4));
            richFrame.Visibility(Visibility::Collapsed);
            Grid::SetRowSpan(richFrame, 4);
            body.Children().Append(richFrame);

            TextBlock tagsText = MakeText(winrt::hstring{tagNames}, 11);
            tagsText.TextWrapping(TextWrapping::NoWrap);
            tagsText.TextTrimming(TextTrimming::CharacterEllipsis);
            tagsText.Visibility(tagNames.empty() ? Visibility::Collapsed : Visibility::Visible);
            Border tagChip;
            tagChip.Child(tagsText);
            vpaste::winui::ApplyStyle(tagChip, L"VPaste.CardTagSurface");
            tagChip.Padding(Thickness{7, 2, 7, 2});
            tagChip.Margin(Thickness{10, 44, 10, 0});
            tagChip.MaxWidth(kCardWidth - 20);
            tagChip.HorizontalAlignment(HorizontalAlignment::Left);
            tagChip.VerticalAlignment(VerticalAlignment::Top);
            tagChip.Visibility(tagNames.empty() ? Visibility::Collapsed : Visibility::Visible);
            ToolTipService::SetToolTip(tagChip, winrt::box_value(winrt::hstring{tagNames}));
            Grid::SetRowSpan(tagChip, 2);
            TextBlock dimensionsText = MakeText(L"", 12);
            dimensionsText.Visibility(Visibility::Collapsed);
            Grid::SetRow(dimensionsText, 3);
            body.Children().Append(dimensionsText);
            Grid detailFeedback; detailFeedback.ColumnSpacing(4); detailFeedback.Margin(Thickness{0, 4, 0, 0});
            detailFeedback.ColumnDefinitions().Append(ColumnDefinition{});
            ColumnDefinition retryColumn; retryColumn.Width(GridLength{1, GridUnitType::Auto}); detailFeedback.ColumnDefinitions().Append(retryColumn);
            auto detailStatus = MakeText(L"", 11); detailStatus.MaxLines(1); detailStatus.TextTrimming(TextTrimming::CharacterEllipsis);
            detailStatus.VerticalAlignment(VerticalAlignment::Center); vpaste::winui::ApplyStyle(detailStatus, L"VPaste.Secondary");
            detailFeedback.Children().Append(detailStatus);
            auto retryDetails = vpaste::winui::NamedIconButton(vpaste::winui::Glyph(L"\uE72C"), Text(L"重试预览", L"Retry preview"));
            retryDetails.Width(24); retryDetails.Height(24); retryDetails.MinWidth(24); retryDetails.MinHeight(24);
            Grid::SetColumn(retryDetails, 1); detailFeedback.Children().Append(retryDetails);
            detailFeedback.Visibility(Visibility::Collapsed); Grid::SetRow(detailFeedback, 4); body.Children().Append(detailFeedback);
            Grid::SetRow(body, 1);
            row.Children().Append(body);
            row.Children().Append(tagChip);
            Border shortcutHint;
            vpaste::winui::ApplyStyle(shortcutHint, L"VPaste.Surface");
            shortcutHint.CornerRadius(vpaste::winui::UniformRadius(4));
            shortcutHint.Padding(Thickness{6, 2, 6, 2});
            shortcutHint.Margin(Thickness{0, 0, 10, 10});
            shortcutHint.HorizontalAlignment(HorizontalAlignment::Right);
            shortcutHint.VerticalAlignment(VerticalAlignment::Bottom);
            shortcutHint.IsHitTestVisible(false);
            shortcutHint.Visibility(g_altHints && g_hashes.size() < 9 ? Visibility::Visible : Visibility::Collapsed);
            auto hintLabel = MakeText(winrt::hstring{L"Alt+" + std::to_wstring(g_hashes.size() + 1)}, 11);
            vpaste::winui::ApplyStyle(hintLabel, L"VPaste.Secondary"); hintLabel.FontSize(11);
            shortcutHint.Child(hintLabel);
            Automation::AutomationProperties::SetAccessibilityView(shortcutHint, Automation::Peers::AccessibilityView::Raw);
            Grid::SetRowSpan(shortcutHint, 2);
            row.Children().Append(shortcutHint);
            Border outline;
            vpaste::winui::ApplyStyle(outline, L"VPaste.CardOutline");
            outline.CornerRadius(vpaste::winui::UniformRadius(kCardRadius));
            outline.Margin(vpaste::winui::UniformThickness(-1));
            outline.Visibility(Visibility::Collapsed);
            Grid::SetRowSpan(outline, 2);
            row.Children().Append(outline);

            Border surface;
            surface.Width(kCardWidth);
            surface.Height(kCardHeight);
            surface.CornerRadius(vpaste::winui::UniformRadius(kCardRadius));
            surface.Margin(Thickness{8, 0, 8, 0});
            surface.Child(row);
            const auto rowHash = std::wstring(hash);
            surface.PointerEntered([cardMenu, rowHash](auto const &, auto const &) {
                if (!g_queueSelectionMode) cardMenu.Visibility(Visibility::Visible);
                if (auto *current = FindCard(rowHash)) {
                    current->pointerOver = true;
                    vpaste::winui::ApplyElevation(current->surface, vpaste::winui::HoveredCardElevation,
                        vpaste::winui::HighContrastEnabled(), g_panel.shadowReceiver);
                }
            });
            surface.PointerExited([cardMenu, rowHash](auto const &, auto const &) {
                cardMenu.Visibility(Visibility::Collapsed);
                if (auto *current = FindCard(rowHash)) {
                    current->pointerOver = false;
                    vpaste::winui::ApplyElevation(current->surface, vpaste::winui::CardElevation,
                        vpaste::winui::HighContrastEnabled(), g_panel.shadowReceiver);
                }
            });
            ToolTipService::SetToolTip(surface, winrt::box_value(source));
            Automation::AutomationProperties::SetHelpText(surface, source);
            surface.PointerMoved([rowHash, type](auto const &, auto const &args) {
                const auto point = args.GetCurrentPoint(g_panel.root);
                HoverHistoryCard(rowHash, type, point.Position(), IsCardAction(args.OriginalSource()), point.IsInContact());
            });
            surface.PointerExited([](auto const &, auto const &) {
                if (g_panel.hoverPreview) g_panel.hoverPreview->Leave();
            });
            retryDetails.Click([rowHash, mediaImage](auto const &, auto const &) {
                if (const auto current = FindCard(rowHash); current && current->image == mediaImage) RequestCardDetails(rowHash, true);
            });
            retryDetails.Tapped([](auto const &, auto const &args) { args.Handled(true); });
            retryDetails.DoubleTapped([](auto const &, auto const &args) { args.Handled(true); });
            mediaFrame.SizeChanged([rowHash](auto const &sender, auto const &) {
                if (auto *current = FindCard(rowHash); current && current->mediaFrame == sender) ApplyNaturalImageBounds(*current);
            });
            surface.DragStarting([rowHash](auto const &sender, auto const &args) {
                if (g_queueSelectionMode || IsCardAction(args.OriginalSource()) || !g_panel.cardDrag) {
                    args.Cancel(true);
                    return;
                }
                for (auto node = args.OriginalSource().try_as<DependencyObject>();
                     node && node != sender.as<DependencyObject>(); node = Media::VisualTreeHelper::GetParent(node)) {
                    if (node.try_as<Primitives::ScrollBar>() || node.try_as<Primitives::Thumb>()) {
                        args.Cancel(true);
                        return;
                    }
                }
                g_suppressDragTap = true;
                (void)SendRequest(L"previewDismiss");
                g_panel.cardDrag->Start(sender.as<UIElement>(), args, rowHash);
            });
            surface.DropCompleted([](auto const &sender, auto const &args) {
                if (g_panel.cardDrag) g_panel.cardDrag->Finish(sender.as<UIElement>(), args.DropResult());
            });
            surface.PointerPressed([](auto const &, auto const &) { g_suppressDragTap = false; });
            MenuFlyout flyout;
            flyout.Opened([](auto const &, auto const &) { CancelHoverPreview(); });
            MenuFlyoutItem copyItem;
            copyItem.Text(Text(L"复制", L"Copy"));
            copyItem.Icon(SymbolIcon{Symbol::Copy});
            copyItem.KeyboardAcceleratorTextOverride(L"Ctrl+C");
            copyItem.Click([rowHash](auto const &, auto const &) {
                (void)SendRequest(L"copy", rowHash);
            });
            flyout.Items().Append(copyItem);
            MenuFlyoutItem pasteItem;
            pasteItem.Text(Text(L"粘贴", L"Paste"));
            pasteItem.Icon(SymbolIcon{Symbol::Paste});
            pasteItem.KeyboardAcceleratorTextOverride(L"Enter");
            pasteItem.Click([rowHash](auto const &, auto const &) {
                (void)SendRequest(L"paste", rowHash);
            });
            flyout.Items().Append(pasteItem);
            MenuFlyoutItem favoriteItem;
            favoriteItem.Text(favorite ? Text(L"取消收藏", L"Remove favorite")
                                       : Text(L"收藏", L"Add favorite"));
            favoriteItem.Icon(SymbolIcon{favorite ? Symbol::UnFavorite : Symbol::Favorite});
            const auto toggleFavorite = [rowHash](auto const &, auto const &) {
                const auto found = std::find(g_hashes.begin(), g_hashes.end(), rowHash);
                if (found == g_hashes.end()) return;
                const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
                if (index < g_favorites.size()) {
                    (void)SendRequest(L"favorite", rowHash, !g_favorites[index]);
                }
            };
            favoriteItem.Click(toggleFavorite);
            favoriteButton.Click(toggleFavorite);
            flyout.Items().Append(favoriteItem);
            MenuFlyoutItem previewItem;
            previewItem.Text(Text(L"预览", L"Preview"));
            previewItem.Icon(vpaste::winui::Glyph(L"\uE890"));
            previewItem.KeyboardAcceleratorTextOverride(L"Space");
            previewItem.Click([rowHash](auto const &, auto const &) {
                if (g_queueSelectionMode) return;
                const auto found = std::find(g_hashes.begin(), g_hashes.end(), rowHash);
                if (found == g_hashes.end()) return;
                g_panel.history.SelectedIndex(static_cast<int>(std::distance(g_hashes.begin(), found)));
                RequestSelectedPreview(L"previewToggle");
            });
            flyout.Items().Append(previewItem);
            MenuFlyoutItem addQueueItem;
            addQueueItem.Text(Text(L"加入粘贴队列", L"Add to paste queue"));
            addQueueItem.Icon(SymbolIcon{Symbol::Add});
            addQueueItem.Click([rowHash](auto const &, auto const &) {
                (void)SendRequest(L"queueAdd", {}, false, 0, {rowHash});
            });
            flyout.Items().Append(addQueueItem);
            flyout.Items().Append(MenuFlyoutSeparator{});
            if (IsEditableTextItem(type)) {
                MenuFlyoutItem editItem;
                editItem.Text(Text(L"编辑文本", L"Edit text"));
                editItem.Icon(SymbolIcon{Symbol::Edit});
                editItem.KeyboardAcceleratorTextOverride(L"F2");
                editItem.Click([rowHash](auto const &, auto const &) {
                    (void)SendRequest(L"edit", rowHash);
                });
                flyout.Items().Append(editItem);
            }
            MenuFlyoutItem deleteItem;
            deleteItem.Text(Text(L"删除记录", L"Delete record"));
            deleteItem.Icon(SymbolIcon{Symbol::Delete});
            deleteItem.KeyboardAcceleratorTextOverride(L"Delete");
            deleteItem.Click([rowHash](auto const &, auto const &) {
                (void)ConfirmDeleteItem(rowHash);
            });
            flyout.Items().Append(deleteItem);
            flyout.Items().Append(MenuFlyoutSeparator{});
            MenuFlyoutSubItem tagsItem;
            tagsItem.Text(Text(L"标签", L"Tags"));
            tagsItem.Icon(vpaste::winui::Glyph(L"\uE8EC"));
            MenuFlyoutItem createTag;
            createTag.Text(Text(L"新建并添加标签…", L"Create and assign tag…")); createTag.Icon(SymbolIcon{Symbol::Add});
            createTag.Click([rowHash](auto const &, auto const &) { ShowRecordTagEditor(0, rowHash); });
            tagsItem.Items().Append(createTag);
            if (!g_tagIds.empty()) tagsItem.Items().Append(MenuFlyoutSeparator{});
            for (std::size_t tagIndex = 0; tagIndex < g_tagIds.size(); ++tagIndex) {
                const auto tagId = g_tagIds[tagIndex];
                const auto tagName = g_tagNames[tagIndex];
                const bool assigned = std::find(tagIds.begin(), tagIds.end(), tagId) != tagIds.end();
                ToggleMenuFlyoutItem tagOption;
                tagOption.Text(winrt::hstring{tagName});
                tagOption.IsChecked(assigned);
                tagOption.Click([rowHash, tagId, assigned](auto const &sender, auto const &) {
                    // The backend owns membership. Do not leave an optimistic
                    // checkmark behind when assignment is rejected.
                    sender.as<ToggleMenuFlyoutItem>().IsChecked(assigned);
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
            const auto menuExtras = vpaste::winui::AppendCardActions(
                flyout, rowHash, type, !tagIds.empty(), g_english, SendCardAction);
            if (menuExtras.pastePlain) menuExtras.pastePlain.KeyboardAcceleratorTextOverride(
                g_behavior.plainBinding.key ? vpaste::winui::ShortcutLabel(g_behavior.plainShortcut) : L"");
            surface.ContextFlyout(flyout);
            cardMenu.Flyout(flyout);
            // Child actions must not bubble into the configured card paste gesture.
            for (const auto &action : {favoriteButton, cardMenu}) {
                action.Tapped([](auto const &, auto const &args) { args.Handled(true); });
                action.DoubleTapped([](auto const &, auto const &args) { args.Handled(true); });
            }
            surface.Tapped([rowHash](auto const &, auto const &args) {
                if (g_suppressDragTap || IsCardAction(args.OriginalSource())) return;
                if (!g_queueSelectionMode && g_singleClickPaste) {
                    (void)SendRequest(L"paste", rowHash);
                }
            });
            surface.DoubleTapped([rowHash](auto const &, auto const &args) {
                if (g_suppressDragTap || IsCardAction(args.OriginalSource())) return;
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
                surface, header, type, mediaImage, typeText, previewText, source, tagsText,
                dimensionsText, favoriteButton, mediaFrame, colorSwatch,
                contentIcon, body, timeText, cardActions, sourceIcon, sourceFrame,
                subtitleText, fileFormat, richFrame, richBadge, std::nullopt, std::move(tagIds), menuExtras, shortcutHint});
            UpdateCardContent(g_panel.rows.back(), preview);
            auto &visual = g_panel.rows.back();
            visual.outline = outline; visual.tagChip = tagChip;
            visual.recordId = static_cast<std::uint64_t>(item.GetNamedNumber(L"id", 0));
            visual.detailFeedback = detailFeedback; visual.detailStatus = detailStatus; visual.retryDetails = retryDetails;
            HighlightCard(visual);
            g_panel.history.Items().Append(surface);
            if (operation == L"queryMore" && g_queueSelectionMode &&
                std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), rowHash) !=
                    g_queueSelectedHashes.end()) {
                g_panel.history.SelectedItems().Append(surface);
            }
        }
        const auto suffix = g_hasMore ? L"+" : L"";
        const auto countText = std::to_wstring(g_hashes.size()) + suffix;
        g_panel.status.Text(g_queueSelectionMode
            ? std::to_wstring(g_queueSelectedHashes.size()) + L" " + Text(L"条已选择", L"selected")
            : countText + L" " + Text(L"条剪贴项", L"clipboard items"));
        g_panel.more.IsEnabled(g_hasMore);
        if (operation == L"query") {
            if (g_queueSelectionMode) {
                for (std::size_t index = 0; index < g_hashes.size(); ++index) {
                    if (std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(),
                                  g_hashes[index]) != g_queueSelectedHashes.end()) {
                        g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(
                            static_cast<std::uint32_t>(index)));
                    }
                }
            } else if (!g_hashes.empty()) {
                const auto found = std::find(g_hashes.begin(), g_hashes.end(), selectionToRestore);
                auto selectedIndex = found != g_hashes.end()
                    ? static_cast<int>(std::distance(g_hashes.begin(), found)) : 0;
                if (found == g_hashes.end() && recordToRestore) {
                    const auto record = std::find_if(g_panel.rows.begin(), g_panel.rows.end(),
                        [&](auto const &row) { return row.recordId == recordToRestore; });
                    if (record != g_panel.rows.end()) selectedIndex = static_cast<int>(std::distance(g_panel.rows.begin(), record));
                }
                g_selectedHash = g_hashes[static_cast<std::size_t>(selectedIndex)];
                g_panel.history.SelectedIndex(selectedIndex);
            }
        }
        g_updatingHistorySelection = false;
        UpdateQueueSelectionControls();
        UpdateHistoryState();
        ApplyRowTheme();
        UpdateFavoriteButton();
        if (!g_queueSelectionMode && g_selectedHash.empty()) (void)SendRequest(L"previewDismiss");
        else RequestSelectedPreview(L"previewSelect");
        if (g_searchSubmitRequestId == id && operation == L"query") {
            g_searchSubmitRequestId = 0;
            ActivateHistoryIndex(g_searchSubmitIndex, g_searchSubmitPlain, g_searchSubmitQuick);
        }
    } catch (const winrt::hresult_error &error) {
        g_updatingHistorySelection = false;
        if (g_panel.status) {
            g_panel.status.Text(error.message());
        }
    } catch (...) {
        g_updatingHistorySelection = false;
        if (g_panel.status) {
            g_panel.status.Text(Text(L"无法显示剪贴板历史", L"Could not display clipboard history"));
        }
    }
}

void PrepareMainShow() {
    if (!g_behavior.retainPosition) {
        g_historyView.resetOnShow = true;
        QueueHistoryOffset(0, g_latestHistoryRequestId);
        if (!g_queueSelectionMode) { g_selectedHash.clear(); g_panel.history.SelectedIndex(-1); }
    } else QueueHistoryOffset(HistoryOffset(), g_latestHistoryRequestId);
    if (!g_behavior.retainSearch) SetSearchText(L"");
    if (g_searchTimer && g_searchTimer.IsRunning()) g_searchTimer.Stop();
    if (!g_behavior.retainCategory) SelectBuiltinCategory(0, false);
}

void SetVisible(bool visible, bool freshShow = true, bool animate) noexcept {
    if (g_panel.root) g_panel.root.IsHitTestVisible(visible);
    if (!visible) CancelHoverPreview();
    if (!visible && !g_panel.tagManagerViewActive) g_historyView.parkedOffset = HistoryOffset();
    if (!visible) ShowAltHints(false);
    if (!visible) g_searchSubmitRequestId = 0;
    if (!visible) g_latestPreviewRequestId = 0;
    if (!visible && g_panel.imageExport) g_panel.imageExport->Cancel();
    if (!visible && g_panel.appActions) g_panel.appActions->Deactivate();
    if (!visible && g_panel.filterEditor) g_panel.filterEditor->Hide();
    if (!visible && g_panel.recordTagEditor) g_panel.recordTagEditor->Hide();
    if (!visible && g_panel.cardDrag) {
        g_historyRefreshAfterDrag = false;
        g_panel.cardDrag->Cancel();
    }
    if (!visible) DismissFeedback();
    if (g_panel.window != nullptr) {
        const bool entering = visible && (!g_panel.dockMotion->Visible() || IsIconic(g_panel.window));
        if (entering && freshShow && !g_panel.tagManagerViewActive) PrepareMainShow();
        try { g_panel.dockMotion->SetVisible(visible, animate && !g_panel.tagManagerViewActive); }
        catch (winrt::hresult_error const &error) {
            std::fprintf(stderr, "WinUI visibility failed: 0x%08X\n", static_cast<unsigned>(error.code()));
            ShowWindow(g_panel.window, visible ? SW_SHOW : SW_HIDE);
        }
        if (visible) {
            SetForegroundWindow(g_panel.window);
            if (entering && !g_panel.tagManagerViewActive)
                ShowAltHints((GetAsyncKeyState(VK_MENU) & 0x8000) != 0 &&
                    ((GetAsyncKeyState(VK_CONTROL) | GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) == 0);
            if (entering) PostMessageW(g_panel.window, kFocusHistory, 0, 0);
        }
    }
    if (g_visibilityChanged != nullptr) {
        g_visibilityChanged(visible);
    }
}

void ShowQueueWithoutActivation() noexcept {
    if (!g_queueViewActive || !g_panel.queueWindow) return;
    try { g_panel.queueWindow->Show(g_dockedLayout.panelScale); }
    catch (...) { if (g_panel.queueView) g_panel.queueView->SetError(L"Could not show queue / 无法显示队列"); }
}

void SetTagManagerActive(bool active) {
    if (active && !g_panel.tagManagerViewActive) QueueHistoryOffset(HistoryOffset(), g_latestHistoryRequestId);
    if (active) ShowAltHints(false);
    if (active) g_searchSubmitRequestId = 0;
    if (active && g_panel.imageExport) g_panel.imageExport->Cancel();
    if (active && g_panel.filterEditor) g_panel.filterEditor->Hide();
    if (active && g_panel.recordTagEditor) g_panel.recordTagEditor->Hide();
    if (active && g_panel.cardDrag) g_panel.cardDrag->Cancel();
    if (!g_panel.window || !g_panel.xamlSource || !g_panel.tagManager) return;
    if (active) {
        (void)SendRequest(L"previewDismiss");
        g_panel.tagManagerViewActive = true;
        const auto theme = g_panel.root.RequestedTheme();
        g_panel.tagManager->SetLanguage(g_english);
        g_panel.tagManager->SetTheme(theme);
        g_panel.xamlSource.Content(g_panel.tagManager->Root());
        ApplyActiveLayout();
        g_panel.tagManager->Refresh();
    } else {
        if (!g_panel.tagManagerViewActive) return;
        g_panel.xamlSource.Content(g_panel.viewport);
        g_panel.tagManagerViewActive = false;
        ApplyActiveLayout();
        if (PanelVisible()) PostMessageW(g_panel.window, kFocusHistory, 0, 0);
        RequestHistory();
    }
}

void SetQueueViewActive(bool active) {
    if (!active && g_panel.queueView) g_panel.queueView->Deactivate();
    if (!g_panel.window || !g_panel.queueView) return;
    if (active) {
        if (!g_panel.queueWindow) g_panel.queueWindow = std::make_unique<vpaste::winui::QueueWindow>(
            g_panel.window, g_panel.queueView->Root(), [] { (void)SendRequest(L"queueClose"); });
        const auto theme = g_panel.root.RequestedTheme();
        g_panel.queueView->SetLanguage(g_english);
        g_panel.queueView->SetTheme(theme);
        g_panel.queueWindow->SetAppearance(g_english, theme);
        g_panel.queueWindow->Show(g_dockedLayout.panelScale, !g_queueViewActive);
        g_panel.queueView->Activate();
        const bool entering = !g_queueViewActive;
        g_queueViewActive = true;
        if (entering && !g_queueSelectionMode) ToggleQueueSelectionMode(false);
        (void)SendRequest(L"queueState");
    } else {
        if (!g_queueViewActive) return;
        if (g_panel.queueWindow) g_panel.queueWindow->Hide();
        g_queueViewActive = false;
        if (g_queueSelectionMode) ToggleQueueSelectionMode();
    }
    UpdateHistoryState();
    UpdateQueueSelectionControls();
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
        if (g_panel.tagManagerViewActive) {
            // A content swap can retain the previous dock's layout slot even
            // though the HWND/island has resized. Size this root from the live
            // client bounds, in DIPs; the main Viewbox keeps its separate scale.
            const auto content = g_panel.xamlSource.Content().try_as<winrt::Microsoft::UI::Xaml::FrameworkElement>();
            const auto scale = GetDpiForWindow(g_panel.window) / 96.0;
            if (content && scale > 0) {
                content.Width((bounds.right - bounds.left) / scale);
                content.Height((bounds.bottom - bounds.top) / scale);
            }
        }
    }
}

void ApplyActiveLayout() {
    if (!g_panel.window || !g_panel.root) return;
    const bool management = g_panel.tagManagerViewActive;
    SetWindowTextW(g_panel.window, g_panel.tagManagerViewActive ? Text(L"vPaste — 管理标签", L"vPaste — Manage tags").c_str()
        : Text(L"vPaste — 剪贴板历史", L"vPaste — Clipboard history").c_str());
    const auto currentStyle = GetWindowLongPtrW(g_panel.window, GWL_STYLE);
    const auto frameBits = static_cast<LONG_PTR>(WS_OVERLAPPEDWINDOW | WS_POPUP);
    const auto style = (currentStyle & ~frameBits) |
        static_cast<LONG_PTR>(management ? WS_OVERLAPPEDWINDOW : kDockedWindowStyle);
    const bool frameChanged = currentStyle != style;
    if (frameChanged) SetWindowLongPtrW(g_panel.window, GWL_STYLE, style);
    RECT target{g_dockedLayout.x, g_dockedLayout.y,
        g_dockedLayout.x + g_dockedLayout.width, g_dockedLayout.y + g_dockedLayout.height};
    if (management) {
        MONITORINFO info{sizeof(MONITORINFO)};
        winrt::check_bool(GetMonitorInfoW(MonitorFromRect(&target, MONITOR_DEFAULTTONEAREST), &info));
        const auto &work = info.rcWork;
        const auto scale = g_dockedLayout.screenScale;
        RECT frame{0, 0, static_cast<LONG>(std::lround(vpaste::winui::QueueContentWidth * scale)),
            static_cast<LONG>(std::lround(vpaste::winui::TagContentHeight * scale))};
        winrt::check_bool(AdjustWindowRectExForDpi(&frame, static_cast<DWORD>(style), false,
            static_cast<DWORD>(GetWindowLongPtrW(g_panel.window, GWL_EXSTYLE)),
            static_cast<UINT>(std::lround(96 * scale))));
        const auto width = std::min(work.right - work.left,
            frame.right - frame.left);
        const auto height = std::min(work.bottom - work.top,
            frame.bottom - frame.top);
        target.left = work.left + (work.right - work.left - width) / 2;
        target.top = work.top + (work.bottom - work.top - height) / 2;
        target.right = target.left + width;
        target.bottom = target.top + height;
    }
    const auto placement = g_panel.dockMotion->Layout(target, !management);
    g_applyingLayout = true;
    const auto moved = SetWindowPos(g_panel.window, HWND_TOPMOST, placement.left, placement.top,
        placement.right - placement.left, placement.bottom - placement.top,
        SWP_NOACTIVATE | (frameChanged ? SWP_FRAMECHANGED : 0));
    g_applyingLayout = false;
    winrt::check_bool(moved);
    if (!management) {
        const auto scale = g_dockedLayout.screenScale * g_dockedLayout.panelScale;
        g_panel.root.Width(g_dockedLayout.width / scale);
        g_panel.root.Height(g_dockedLayout.height / scale);
        UpdateSearchWidth();
    }
    const DWM_WINDOW_CORNER_PREFERENCE corners = management ? DWMWCP_DEFAULT : DWMWCP_DONOTROUND;
    (void)DwmSetWindowAttribute(g_panel.window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
    // Keep the non-client frame for DWM's system shadow, while the dock's
    // NCCALCSIZE handler preserves its original full client bounds.
    const MARGINS shadow = management ? MARGINS{} : MARGINS{1, 1, 1, 1};
    (void)DwmExtendFrameIntoClientArea(g_panel.window, &shadow);
    ResizeIsland();
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case kGetLayout: {
        auto snapshot = g_dockedLayout;
        if (g_panel.tagManagerViewActive || g_layoutPending) {
            RECT current{}; if (!GetWindowRect(window, &current)) return E_FAIL;
            snapshot.x = current.left; snapshot.y = current.top;
            snapshot.width = current.right - current.left; snapshot.height = current.bottom - current.top;
        }
        // Animation frames may temporarily overlap a vertically adjacent
        // monitor. Only external DPI changes establish a new target scale.
        if (!g_panel.dockMotion->Running()) snapshot.screenScale = GetDpiForWindow(window) / 96.0;
        *reinterpret_cast<PanelLayout *>(lparam) = snapshot;
        return S_OK;
    }
    case kSetLayout:
        try {
            g_dockedLayout = *reinterpret_cast<const PanelLayout *>(lparam);
            ApplyActiveLayout();
            g_layoutPending = false;
            if (g_queueViewActive && g_panel.queueWindow) g_panel.queueWindow->Show(g_dockedLayout.panelScale);
            RequestSelectedPreview(L"previewSelect");
            return S_OK;
        } catch (...) {
            return winrt::to_hresult();
        }
    case kShowWindow:
        SetVisible(true);
        return S_OK;
    case kHideWindow:
        SetVisible(false);
        return S_OK;
    case kHideForQueuePaste:
        SetVisible(false, true, false);
        return S_OK;
    case kToggleWindow:
        SetVisible(!g_panel.dockMotion->Visible() || IsIconic(window));
        return S_OK;
    case kStopWindow:
        if (g_panel.dockMotion) g_panel.dockMotion->Suspend();
        g_panel.tabIndicator.reset();
        if (g_panel.imageExport) g_panel.imageExport->Cancel();
        g_panel.queueWindow.reset();
        // Detach while the island and its HWND are still alive.
        if (g_panel.xamlSource) g_panel.xamlSource.SystemBackdrop(nullptr);
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
    case kSyncHistoryViewport:
        SyncHistoryViewport(); return S_OK;
    case kRefreshTags:
        RefreshTags();
        return 0;
    case kSetQueueView:
        try { SetQueueViewActive(wparam != 0); return S_OK; }
        catch (...) { return winrt::to_hresult(); }
    case kShowQueueNoActivate:
        ShowQueueWithoutActivation();
        return S_OK;
    case kFocusHistory:
        if (PanelVisible() && !IsIconic(window) &&
            !g_panel.tagManagerViewActive && !g_deleteConfirmationOpen &&
            !NativeEditorOpen()) {
            if (GetForegroundWindow() != window) SetForegroundWindow(window);
            const auto island = winrt::Microsoft::UI::GetWindowFromWindowId(g_panel.xamlSource.SiteBridge().WindowId());
            SetFocus(island);
            const auto selected = g_panel.history.SelectedIndex();
            const auto container = selected >= 0
                ? g_panel.history.ContainerFromIndex(selected).try_as<winrt::Microsoft::UI::Xaml::Controls::Control>()
                : winrt::Microsoft::UI::Xaml::Controls::Control{nullptr};
            const auto state = wparam ? winrt::Microsoft::UI::Xaml::FocusState::Keyboard : winrt::Microsoft::UI::Xaml::FocusState::Programmatic;
            if (g_panel.historyScroll) g_panel.historyScroll.BringIntoViewOnFocusChange(wparam != 0);
            if (container) container.Focus(state);
            else g_panel.history.Focus(state);
            if (!wparam) g_panel.history.UpdateLayout();
            // Keep focus-driven scrolling disabled after programmatic focus:
            // WinUI can queue its bring-into-view after this call returns.
            // Real input re-enables it before native key/pointer handling.
            // Show/query restoration owns offsets. Enqueuing another restore
            // from a late focus callback could overwrite a newer user scroll.
        }
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
            g_panel.viewport.RequestedTheme(theme);
            if (g_panel.appActions) g_panel.appActions->SetTheme(g_panel.root.ActualTheme());
            ApplyRowTheme();
            if (g_panel.queueView) g_panel.queueView->SetTheme(theme);
            if (g_panel.queueWindow) g_panel.queueWindow->SetAppearance(g_english, theme);
            if (g_panel.tagManager) g_panel.tagManager->SetTheme(theme);
            if (g_panel.filterEditor) g_panel.filterEditor->SetTheme(theme);
            if (g_panel.recordTagEditor) g_panel.recordTagEditor->SetTheme(theme);
            if (g_panel.reader) g_panel.reader->SetAppearance(g_english, theme);
        }
        return 0;
    }
    case kSetBehavior:
        try {
            ApplyBehavior(*reinterpret_cast<std::string const *>(lparam));
            return S_OK;
        } catch (...) { return winrt::to_hresult(); }
    case WM_INPUTLANGCHANGE:
        g_behavior.plainBinding = vpaste::winui::ParseKeyBinding(g_behavior.plainShortcut);
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_NCCALCSIZE:
        if (wparam && !g_panel.tagManagerViewActive) return 0;
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_NCHITTEST:
        if (!g_panel.tagManagerViewActive) return HTCLIENT;
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_ACTIVATE:
        if (LOWORD(wparam) == WA_INACTIVE) {
            if (g_panel.hoverPreview) g_panel.hoverPreview->Leave();
            ShowAltHints(false);
            if (g_panel.appActions) g_panel.appActions->Deactivate();
            if (!g_panel.tagManagerViewActive) (void)SendRequest(L"panelBlur");
        }
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_SYSKEYUP:
        if (wparam == VK_MENU) ShowAltHints(false);
        return DefWindowProcW(window, message, wparam, lparam);
    case kSetLanguage: {
        g_english = wparam != 0;
        g_updatingLanguage = true;
        SetWindowTextW(window, Text(L"vPaste — 剪贴板历史", L"vPaste — Clipboard history").c_str());
        g_panel.search.PlaceholderText(Text(L"搜索剪贴板历史", L"Search clipboard history"));
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.searchButton, Text(L"搜索", L"Search"));
        winrt::Microsoft::UI::Xaml::Controls::ToolTipService::SetToolTip(g_panel.searchButton,
            winrt::box_value(Text(L"搜索 (Ctrl+F)", L"Search (Ctrl+F)")));
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.search, Text(L"搜索剪贴板历史", L"Search clipboard history"));
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.tagFilter, Text(L"按标签筛选", L"Filter by tag"));
        g_panel.tagFilter.Header(winrt::box_value(Text(L"按标签筛选", L"Filter by tag")));
        UpdateFilterLabels();
        if (const auto flyout = g_panel.tagFilterButton.Flyout().try_as<winrt::Microsoft::UI::Xaml::Controls::Flyout>()) {
            const auto choices = flyout.Content().as<winrt::Microsoft::UI::Xaml::Controls::StackPanel>().Children().GetAt(0)
                .as<winrt::Microsoft::UI::Xaml::Controls::Button>();
            choices.Content(winrt::box_value(Text(L"按内容类型筛选", L"Filter by content type")));
            const auto menu = choices.Flyout().as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyout>();
            for (std::uint32_t index = 0; index < menu.Items().Size(); ++index)
                menu.Items().GetAt(index).as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem>().Text(
                    g_panel.filter.Items().GetAt(index + 2).Text());
        }
        vpaste::winui::NameIconButton(g_panel.tagFilterButton, Text(L"叠加标签筛选", L"Combine with a tag filter"));
        vpaste::winui::NameIconButton(g_panel.addTag, Text(L"添加与管理标签", L"Add and manage tags"));
        if (const auto menu = g_panel.addTag.Flyout().try_as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyout>(); menu && menu.Items().Size() == 2) {
            menu.Items().GetAt(0).as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem>().Text(Text(L"新增筛选标签", L"New filter tab"));
            menu.Items().GetAt(1).as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem>().Text(Text(L"新增标签", L"New tag"));
        }
        if (g_panel.recordTagEditor) g_panel.recordTagEditor->SetLanguage(g_english);
        if (g_panel.customTabs) winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.customTabs, Text(L"自定义筛选标签", L"Custom filter tabs"));
        UpdateShortcutLabels();
        g_panel.copy.Label(Text(L"复制", L"Copy"));
        g_panel.paste.Label(Text(L"粘贴", L"Paste"));
        g_panel.more.Content(winrt::box_value(Text(L"加载更多", L"Load more")));
        g_panel.resetFilters.Content(winrt::box_value(Text(L"清除筛选", L"Clear filters")));
        g_panel.retry.Content(winrt::box_value(Text(L"重试", L"Try again")));
        vpaste::winui::NameIconButton(g_panel.cancelSelection,
            Text(L"取消队列选择", L"Cancel queue selection"));
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.loading, Text(L"正在读取历史", L"Loading history"));
        g_panel.queueSelect.Label(g_queueSelectionMode
            ? Text(L"取消选择", L"Cancel selection")
            : Text(L"选择加入队列", L"Select for queue"));
        g_panel.queueAdd.Content(winrt::box_value(Text(L"加入队列", L"Add to queue")));
        g_panel.queueOpen.Label(Text(L"粘贴队列", L"Paste queue"));
        g_panel.manageTags.Label(Text(L"管理标签", L"Manage tags"));
        g_panel.settings.Label(Text(L"设置", L"Settings"));
        if (g_panel.appActions) g_panel.appActions->SetLanguage(g_english);
        if (g_panel.queueView) g_panel.queueView->SetLanguage(g_english);
        if (g_panel.queueWindow) g_panel.queueWindow->SetAppearance(g_english, g_panel.root.RequestedTheme());
        if (g_panel.tagManager) g_panel.tagManager->SetLanguage(g_english);
        if (g_panel.reader) g_panel.reader->SetAppearance(g_english, g_panel.root.RequestedTheme());
        if (g_panel.customTabs) {
            winrt::Windows::Data::Json::JsonArray filters;
            for (const auto &draft : g_customFilters) filters.Append(draft);
            ApplyFilters(filters);
        }
        RebuildTagFilter();
        g_panel.status.Text(Text(L"正在读取剪贴板历史…", L"Loading clipboard history…"));
        UpdateFavoriteButton();
        g_updatingLanguage = false;
        RequestHistory();
        UpdateHistoryState();
        UpdateQueueSelectionControls();
        return 0;
    }
    case kSetClickMode:
        g_singleClickPaste = wparam != 0;
        return 0;
    case WM_GETMINMAXINFO: {
        if (!g_panel.tagManagerViewActive) {
            const auto result = DefWindowProcW(window, message, wparam, lparam);
            // The shadow frame enables system tracking limits. The dock is
            // sized by Rust for its target monitor, which may be wider than
            // the monitor Windows used to calculate those default limits.
            auto limits = reinterpret_cast<MINMAXINFO *>(lparam);
            limits->ptMaxTrackSize.x = std::max<LONG>(limits->ptMaxTrackSize.x, g_dockedLayout.width);
            limits->ptMaxTrackSize.y = std::max<LONG>(limits->ptMaxTrackSize.y, g_dockedLayout.height);
            return result;
        }
        const auto dpi = GetDpiForWindow(window);
        RECT minimum{0, 0, MulDiv(static_cast<int>(vpaste::winui::QueueContentWidth), dpi, 96),
            MulDiv(static_cast<int>(vpaste::winui::ManagementMinHeight), dpi, 96)};
        if (AdjustWindowRectExForDpi(&minimum, static_cast<DWORD>(GetWindowLongPtrW(window, GWL_STYLE)), false,
            static_cast<DWORD>(GetWindowLongPtrW(window, GWL_EXSTYLE)), dpi)) {
            auto limits = reinterpret_cast<MINMAXINFO *>(lparam);
            limits->ptMinTrackSize.x = std::max(limits->ptMinTrackSize.x, minimum.right - minimum.left);
            limits->ptMinTrackSize.y = std::max(limits->ptMinTrackSize.y, minimum.bottom - minimum.top);
        }
        return 0;
    }
    case WM_SIZE:
        ResizeIsland();
        if (wparam == SIZE_MINIMIZED) (void)SendRequest(L"previewDismiss");
        return 0;
    case WM_SETFOCUS:
        if (g_panel.xamlSource && g_panel.history &&
            !g_panel.tagManagerViewActive && !g_deleteConfirmationOpen) {
            return WindowProc(window, kFocusHistory, 0, 0);
        }
        return 0;
    case WM_DPICHANGED: {
        if (!g_applyingLayout) {
            if (g_panel.dockMotion) g_panel.dockMotion->Suspend();
            g_layoutPending = true;
            const auto rect = reinterpret_cast<const RECT *>(lparam);
            SetWindowPos(window, nullptr, rect->left, rect->top, rect->right - rect->left,
                         rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE);
            (void)SendRequest(L"layout");
            RequestSelectedPreview(L"previewSelect");
        }
        ResizeIsland();
        return 0;
    }
    case WM_DISPLAYCHANGE:
        if (g_panel.dockMotion) g_panel.dockMotion->Finish();
        g_layoutPending = true;
        (void)SendRequest(L"layout");
        return 0;
    case WM_SETTINGCHANGE:
        if (wparam == SPI_SETWORKAREA) {
            if (g_panel.dockMotion) g_panel.dockMotion->Finish();
            g_layoutPending = true;
            (void)SendRequest(L"layout");
        }
        if (wparam == SPI_SETHIGHCONTRAST && g_panel.root) ApplyRowTheme();
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_THEMECHANGED:
        if (g_panel.root) ApplyRowTheme();
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_EXITSIZEMOVE:
        RequestSelectedPreview(L"previewSelect");
        return 0;
    case WM_CLOSE:
        if (g_panel.tagManagerViewActive) SetTagManagerActive(false);
        SetVisible(false);
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
    const char *phase = "create native window";
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
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST, kWindowClass,
            Text(L"vPaste — 剪贴板历史", L"vPaste — Clipboard history").c_str(), kDockedWindowStyle,
            0, 0, kWindowWidth, static_cast<int>(kPanelHeight), nullptr,
            nullptr, GetModuleHandleW(nullptr), nullptr);
        if (g_panel.window == nullptr) {
            return HRESULT_FROM_WIN32(GetLastError());
        }
        phase = "initialize XAML";
        g_panel.dockMotion = std::make_unique<vpaste::winui::DockMotion>(g_panel.window, g_applyingLayout);
        g_panel.xamlManager =
            winrt::Microsoft::UI::Xaml::Hosting::WindowsXamlManager::InitializeForCurrentThread();
        winrt::Microsoft::UI::Xaml::Application::Current()
            .Resources().MergedDictionaries().Append(
                winrt::Microsoft::UI::Xaml::Controls::XamlControlsResources());
        phase = "install appearance resources";
        vpaste::winui::InstallAppearanceResources();
        phase = "initialize XAML island";
        g_panel.xamlSource = winrt::Microsoft::UI::Xaml::Hosting::DesktopWindowXamlSource();
        g_panel.xamlSource.Initialize(
            winrt::Microsoft::UI::GetWindowIdFromWindow(g_panel.window));
        g_panel.windowCanvas = winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{Rgb(246, 247, 249)};
        winrt::Microsoft::UI::Xaml::Application::Current().Resources().Insert(
            winrt::box_value(vpaste::winui::WindowCanvasResource), g_panel.windowCanvas);

        using namespace winrt::Microsoft::UI::Xaml;
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        using namespace winrt::Microsoft::UI::Xaml::Media;
        using namespace winrt::Microsoft::UI::Xaml;
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        Grid root;
        for (int row = 0; row < 2; ++row) {
            root.RowDefinitions().Append(RowDefinition{});
        }
        root.RowDefinitions().GetAt(0).Height(GridLength{kHeaderHeight, GridUnitType::Pixel});
        root.RowDefinitions().GetAt(1).Height(GridLength{1, GridUnitType::Star});
        root.Background(vpaste::winui::WindowCanvasBackground());
        g_panel.root = root;
        // A sibling background receives inline shadows on Windows 10; it must
        // not be an ancestor of any caster. Keep existing child indices stable.
        g_panel.shadowReceiver = Grid();
        g_panel.shadowReceiver.Background(vpaste::winui::WindowCanvasBackground());
        g_panel.shadowReceiver.IsHitTestVisible(false);
        Grid::SetRowSpan(g_panel.shadowReceiver, 2);
        Canvas::SetZIndex(g_panel.shadowReceiver, -1);
        g_panel.viewport = Viewbox();
        g_panel.viewport.Stretch(Stretch::Uniform);
        g_panel.viewport.Child(root);
        root.Loaded([](auto const &, auto const &) {
            // Switching a management view unloads history. Focus is valid only
            // after it is attached again, not immediately after Content changes.
            if (GetForegroundWindow() == g_panel.window) PostMessageW(g_panel.window, kFocusHistory, 0, 0);
            BindHistoryScroll(); PostMessageW(g_panel.window, kSyncHistoryViewport, 0, 0);
        });
        root.Unloaded([](auto const &, auto const &) {
            CancelHoverPreview();
            if (g_panel.appActions) g_panel.appActions->Deactivate();
            if (g_panel.deletionDialog) g_panel.deletionDialog.Hide();
            if (g_panel.filterEditor) g_panel.filterEditor->Hide();
            if (g_panel.recordTagEditor) g_panel.recordTagEditor->Hide();
            DismissFeedback();
        });
        root.ActualThemeChanged([](auto const &, auto const &) {
            ApplyRowTheme();
            if (g_panel.appActions) g_panel.appActions->SetTheme(g_panel.root.ActualTheme());
            if (g_panel.queueView) {
                g_panel.queueView->SetTheme(g_panel.root.RequestedTheme());
            }
            if (g_panel.tagManager) {
                g_panel.tagManager->SetTheme(g_panel.root.RequestedTheme());
            }
        });
        phase = "create panel controls";
        Grid header;
        g_panel.header = header;
        vpaste::winui::ApplyStyle(header, L"VPaste.ClipboardHeader");
        header.Height(kHeaderHeight);
        header.Padding(Thickness{kHeaderInset, 0, kHeaderInset, 0});
        header.ColumnSpacing(8);
        for (int column = 0; column < 4; ++column) {
            ColumnDefinition definition;
            definition.Width(GridLength{1, column == 1 ? GridUnitType::Star : GridUnitType::Auto});
            header.ColumnDefinitions().Append(definition);
        }
        root.Children().Append(header);
        g_panel.commands = CommandBar();
        g_panel.commands.IsDynamicOverflowEnabled(true);
        g_panel.commands.DefaultLabelPosition(CommandBarDefaultLabelPosition::Collapsed);
        g_panel.commands.Background(winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{
            winrt::Windows::UI::Color{0, 0, 0, 0}});
        g_panel.commands.VerticalAlignment(VerticalAlignment::Center);
        // Keep WinUI's command behavior/template, but match the shipping 28px
        // circular toolbar surfaces inside each 36×40 command slot.
        g_panel.commands.Resources().Insert(winrt::box_value(L"AppBarThemeCompactHeight"), winrt::box_value(40.0));
        g_panel.commands.Resources().Insert(winrt::box_value(L"AppBarButtonInnerBorderMargin"), winrt::box_value(Thickness{4, 6, 4, 6}));
        g_panel.commands.Resources().Insert(winrt::box_value(L"AppBarButtonContentHeight"), winrt::box_value(16.0));
        g_panel.commands.Resources().Insert(winrt::box_value(L"AppBarButtonContentViewboxCollapsedMargin"), winrt::box_value(Thickness{0, 12, 0, 0}));
        Grid::SetColumn(g_panel.commands, 3);
        header.Children().Append(g_panel.commands);
        StackPanel searchGroup;
        searchGroup.Orientation(Orientation::Horizontal);
        searchGroup.Spacing(8);
        searchGroup.VerticalAlignment(VerticalAlignment::Center);
        g_panel.searchButton = vpaste::winui::NamedIconButton(SymbolIcon{Symbol::Find}, Text(L"搜索", L"Search"));
        vpaste::winui::ApplyStyle(g_panel.searchButton, L"VPaste.RoundToolbarButton");
        g_panel.searchButton.Width(28);
        g_panel.searchButton.Height(28);
        Automation::AutomationProperties::SetName(g_panel.searchButton, Text(L"搜索", L"Search"));
        ToolTipService::SetToolTip(g_panel.searchButton, winrt::box_value(Text(L"搜索 (Ctrl+F)", L"Search (Ctrl+F)")));
        g_panel.searchButton.Click([](auto const &, auto const &) {
            ShowSearch();
        });
        searchGroup.Children().Append(g_panel.searchButton);
        g_panel.search = AutoSuggestBox();
        g_panel.search.FontSize(13);
        g_panel.search.QueryIcon(SymbolIcon{Symbol::Find});
        g_panel.search.PlaceholderText(Text(L"搜索剪贴板历史", L"Search clipboard history"));
        g_panel.search.Width(260);
        g_panel.search.MinHeight(32);
        g_panel.search.Visibility(Visibility::Collapsed);
        g_panel.search.VerticalAlignment(VerticalAlignment::Center);
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.search, Text(L"搜索剪贴板历史", L"Search clipboard history"));
        searchGroup.Children().Append(g_panel.search);
        header.Children().Append(searchGroup);
        root.SizeChanged([](auto const &, auto const &) { UpdateSearchWidth(); });
        g_panel.search.LostFocus([](auto const &, auto const &) {
            if (!g_panel.root || !g_panel.search || !g_panel.search.IsLoaded()) return;
            const auto focused = Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot());
            if (SearchText().empty() && MainInputArea(focused) != vpaste::winui::InputArea::Search)
                g_panel.search.Visibility(Visibility::Collapsed);
        });
        g_panel.search.Loaded([](auto const &, auto const &) {
            g_panel.searchChanging.revoke();
            if (const auto editor = FindHistoryChild<TextBox>(g_panel.search)) {
                // Cancel a pending Enter paste immediately, including native
                // clear. AutoSuggestBox.TextChanged is forwarded later.
                g_panel.searchChanging = editor.TextChanging(winrt::auto_revoke,
                    [](auto const &sender, auto const &) { SearchChanged(sender.Text()); });
            }
        });
        root.PreviewKeyDown([](auto const &, auto const &args) {
            if (!PanelVisible()) { args.Handled(true); return; }
            if (args.Key() != winrt::Windows::System::VirtualKey::Escape) CancelHoverPreview();
            vpaste::winui::MainKeyInput input;
            input.key = static_cast<std::uint32_t>(args.Key());
            input.control = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
            input.shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
            input.alt = (GetKeyState(VK_MENU) & 0x8000) != 0;
            input.meta = ((GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000) != 0;
            input.repeated = args.KeyStatus().WasKeyDown;
            input.composing = input.key == VK_PROCESSKEY || static_cast<std::uint32_t>(args.OriginalKey()) == VK_PROCESSKEY;
            input.area = MainInputArea(args.OriginalSource());
            input.blocked = NativeControlOwnsKeys(args.OriginalSource());
            if (!input.blocked && !input.composing &&
                (input.area == vpaste::winui::InputArea::History || input.key == VK_TAB) &&
                (input.key == VK_LEFT || input.key == VK_RIGHT || input.key == VK_TAB || input.key == VK_HOME ||
                 input.key == VK_END || input.key == VK_NEXT || input.key == VK_PRIOR)) HistoryViewportInput();
            input.searchHasText = !SearchText().empty();
            if (input.control || input.meta) ShowAltHints(false);
            if (HandleMainKey(input)) args.Handled(true);
        });
        root.PreviewKeyUp([](auto const &, auto const &args) {
            if (args.Key() == winrt::Windows::System::VirtualKey::Menu || (GetKeyState(VK_MENU) & 0x8000) == 0) ShowAltHints(false);
        });
        g_panel.filter = SelectorBar();
        UpdateFilterLabels();
        g_panel.filter.Height(kHeaderHeight);
        g_panel.filter.Padding(Thickness{0});
        g_panel.filter.Loaded([](auto const &, auto const &) { BringSelectedTabIntoView(g_panel.filter); });
        g_panel.filter.Resources().Insert(winrt::box_value(L"SelectorBarItemIconScale"), winrt::box_value(1.0));
        g_panel.filter.Resources().Insert(winrt::box_value(L"SelectorBarItemSpacing"), winrt::box_value(5.0));
        g_panel.filter.Resources().Insert(winrt::box_value(L"SelectorBarItemPillFill"), SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
        g_panel.filterStrip = StackPanel();
        g_panel.filterStrip.Orientation(Orientation::Horizontal);
        g_panel.filterStrip.Children().Append(g_panel.filter);
        g_panel.customTabs = SelectorBar();
        g_panel.customTabs.Height(kHeaderHeight);
        g_panel.customTabs.Padding(Thickness{0});
        g_panel.customTabs.Resources().Insert(winrt::box_value(L"SelectorBarItemSpacing"), winrt::box_value(5.0));
        g_panel.customTabs.Resources().Insert(winrt::box_value(L"SelectorBarItemPillFill"), SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
        g_panel.customTabs.Loaded([](auto const &, auto const &) {
            g_panel.customTabs.ApplyTemplate();
            if (const auto view = FindHistoryChild<ItemsView>(g_panel.customTabs)) view.Layout(winrt::make<TabStripLayout>());
            BringSelectedTabIntoView(g_panel.customTabs);
        });
        Automation::AutomationProperties::SetName(g_panel.customTabs, Text(L"自定义筛选标签", L"Custom filter tabs"));
        g_panel.customTabs.SelectionChanged([](auto const &, auto const &) {
            if (g_updatingTagFilter || !g_panel.customTabs.SelectedItem()) return;
            std::uint32_t index = 0;
            if (!g_panel.customTabs.Items().IndexOf(g_panel.customTabs.SelectedItem(), index) || index >= g_dynamicIds.size()) return;
            const auto &id = g_dynamicIds[index];
            const auto tag = std::find_if(g_tagIds.begin(), g_tagIds.end(), [&](auto tagId) { return RecordTabId(tagId) == id; });
            g_updatingTagFilter = true; g_updatingLanguage = true;
            g_panel.filter.SelectedItem(nullptr);
            if (tag != g_tagIds.end()) {
                const auto tagIndex = std::distance(g_tagIds.begin(), tag);
                g_selectedFilterId.clear(); g_selectedTagId = *tag; g_selectedTagName = g_tagNames[tagIndex];
                g_panel.tagFilter.SelectedIndex(static_cast<int>(tagIndex + 1));
            } else {
                g_selectedFilterId = id;
                g_panel.tagFilter.SelectedIndex(0);
                g_selectedTagId = 0; g_selectedTagName.clear();
            }
            g_updatingLanguage = false; g_updatingTagFilter = false;
            BringSelectedTabIntoView(g_panel.customTabs);
            RequestHistory();
        });
        g_panel.filterStrip.Children().Append(g_panel.customTabs);
        g_panel.addTag = vpaste::winui::NamedIconButton(SymbolIcon{Symbol::Add}, Text(L"添加与管理标签", L"Add and manage tags"));
        g_panel.addTag.VerticalAlignment(VerticalAlignment::Center);
        MenuFlyout addMenu;
        addMenu.Placement(Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft);
        addMenu.ShouldConstrainToRootBounds(false);
        MenuFlyoutItem addFilter;
        addFilter.Text(Text(L"新增筛选标签", L"New filter tab")); addFilter.Icon(SymbolIcon{Symbol::Filter});
        addFilter.Click([](auto const &, auto const &) {
            winrt::Windows::Data::Json::JsonObject draft;
            draft.Insert(L"filter", winrt::Windows::Data::Json::JsonObject{});
            ShowFilterEditor(draft);
        });
        addMenu.Items().Append(addFilter);
        MenuFlyoutItem addRecordTag;
        addRecordTag.Text(Text(L"新增标签", L"New tag")); addRecordTag.Icon(SymbolIcon{Symbol::Add});
        addRecordTag.Click([](auto const &, auto const &) { ShowRecordTagEditor(); });
        addMenu.Items().Append(addRecordTag);
        g_panel.addTag.Flyout(addMenu);
        g_panel.filterStrip.Children().Append(g_panel.addTag);
        g_panel.filterScroll = ScrollViewer();
        g_panel.filterScroll.HorizontalScrollMode(ScrollMode::Enabled);
        g_panel.filterScroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Hidden);
        g_panel.filterScroll.VerticalScrollMode(ScrollMode::Disabled);
        g_panel.filterScroll.VerticalScrollBarVisibility(ScrollBarVisibility::Disabled);
        g_panel.filterScroll.Content(g_panel.filterStrip);
        Grid::SetColumn(g_panel.filterScroll, 1);
        header.Children().Append(g_panel.filterScroll);
        g_panel.tabIndicatorHost = Markup::XamlReader::Load(LR"(<Border
            xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
            BorderBrush="{ThemeResource AccentFillColorDefaultBrush}" IsHitTestVisible="False"/>)").as<Border>();
        Grid::SetColumn(g_panel.tabIndicatorHost, 1);
        header.Children().Append(g_panel.tabIndicatorHost);
        g_panel.tabIndicator = std::make_unique<vpaste::winui::TabIndicator>(g_panel.tabIndicatorHost);
        g_panel.tabIndicatorHost.SizeChanged([](auto const &, auto const &) {
            Media::RectangleGeometry clip;
            clip.Rect({0, 0, static_cast<float>(g_panel.tabIndicatorHost.ActualWidth()), static_cast<float>(kHeaderHeight)});
            g_panel.tabIndicatorHost.Clip(clip); SyncTabIndicator();
        });
        g_panel.tabIndicatorHost.LayoutUpdated([](auto const &, auto const &) { SyncTabIndicator(); });
        g_panel.filterScroll.ViewChanged([](auto const &, auto const &) { SyncTabIndicator(); });
        g_panel.tagFilter = ComboBox();
        g_panel.tagFilter.Width(128);
        g_panel.tagFilter.MinHeight(32);
        g_panel.tagFilter.VerticalAlignment(VerticalAlignment::Center);
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.tagFilter, Text(L"按标签筛选", L"Filter by tag"));
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
            g_updatingTagFilter = true;
            g_panel.customTabs.SelectedItem(DynamicTab(!g_selectedFilterId.empty() ? g_selectedFilterId : RecordTabId(g_selectedTagId)));
            g_updatingTagFilter = false;
            const auto wasUpdating = g_updatingLanguage;
            g_updatingLanguage = true;
            if (index > 0 && FilterIndex() == 0) g_panel.filter.SelectedItem(nullptr);
            else if (index == 0 && !g_panel.filter.SelectedItem() && g_selectedFilterId.empty()) g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
            g_updatingLanguage = wasUpdating;
            RequestHistory();
        });
        g_panel.tagFilterButton = vpaste::winui::NamedIconButton(vpaste::winui::Glyph(L"\uE71C"),
            Text(L"叠加标签筛选", L"Combine with a tag filter"));
        vpaste::winui::ApplyStyle(g_panel.tagFilterButton, L"VPaste.RoundToolbarButton");
        g_panel.tagFilterButton.Width(28);
        g_panel.tagFilterButton.Height(28);
        g_panel.tagFilterButton.VerticalAlignment(VerticalAlignment::Center);
        Flyout tagFilterFlyout;
        tagFilterFlyout.Placement(Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft);
        tagFilterFlyout.ShouldConstrainToRootBounds(false);
        StackPanel filterChoices; filterChoices.Spacing(12);
        MenuFlyout typeMenu;
        for (std::uint32_t index = 2; index < g_panel.filter.Items().Size(); ++index) {
            MenuFlyoutItem type;
            type.Text(g_panel.filter.Items().GetAt(index).Text());
            type.Icon(vpaste::winui::Glyph(vpaste::winui::TypeGlyph(FilterValue(static_cast<int>(index)))));
            type.Click([index](auto const &, auto const &) { SelectBuiltinCategory(static_cast<int>(index), false); });
            typeMenu.Items().Append(type);
        }
        Button typeChoices; typeChoices.Content(winrt::box_value(Text(L"按内容类型筛选", L"Filter by content type")));
        typeChoices.Flyout(typeMenu); filterChoices.Children().Append(typeChoices);
        g_panel.tagFilter.Header(winrt::box_value(Text(L"按标签筛选", L"Filter by tag")));
        filterChoices.Children().Append(g_panel.tagFilter);
        tagFilterFlyout.Content(filterChoices);
        g_panel.tagFilterButton.Flyout(tagFilterFlyout);
        Grid::SetColumn(g_panel.tagFilterButton, 2);
        header.Children().Append(g_panel.tagFilterButton);

        g_panel.history = ListView();
        g_panel.history.PointerPressed([](auto const &, auto const &) { HistoryViewportInput(); });
        g_panel.history.BringIntoViewRequested([](auto const &, auto const &args) {
            if (g_historyView.restore || g_updatingHistorySelection) args.Handled(true);
        });
        g_panel.history.AddHandler(UIElement::PointerWheelChangedEvent(), winrt::box_value(
            winrt::Microsoft::UI::Xaml::Input::PointerEventHandler{[](auto const &, auto const &) {
                CancelHoverPreview();
                HistoryViewportInput();
                PostMessageW(g_panel.window, kSyncHistoryViewport, 0, 0);
            }}), true);
        g_panel.history.Loaded([](auto const &, auto const &) {
            BindHistoryScroll(); PostMessageW(g_panel.window, kSyncHistoryViewport, 0, 0);
        });
        g_panel.history.IsTabStop(true);
        g_panel.history.Padding(Thickness{16, 12, 16, 12});
        g_panel.history.SelectionMode(ListViewSelectionMode::Single);
        g_panel.history.HorizontalContentAlignment(HorizontalAlignment::Stretch);
        Style cardContainer{winrt::xaml_typename<ListViewItem>()};
        cardContainer.BasedOn(Application::Current().Resources().Lookup(winrt::box_value(L"VPaste.ClipboardItem")).as<Style>());
        cardContainer.Setters().Append(Setter{Control::PaddingProperty(), winrt::box_value(Thickness{0})});
        cardContainer.Setters().Append(Setter{Control::CornerRadiusProperty(), winrt::box_value(vpaste::winui::UniformRadius(kCardRadius))});
        cardContainer.Setters().Append(Setter{UIElement::UseSystemFocusVisualsProperty(), winrt::box_value(false)});
        // The card has horizontal spacing inside its ListViewItem. Align the
        // native focus visual to the card, not to the outside of that gap.
        cardContainer.Setters().Append(Setter{FrameworkElement::FocusVisualMarginProperty(),
            winrt::box_value(Thickness{8, 0, 8, 0})});
        g_panel.history.ItemContainerStyle(cardContainer);
        // Focus events update only the outline. Reapplying control styles or
        // system-focus settings from them can recursively change focus.
        const auto updateFocus = [](auto const &, auto const &) {
            for (std::size_t index = 0; index < g_panel.rows.size(); ++index) UpdateCardOutline(index);
        };
        g_panel.history.GotFocus(updateFocus);
        g_panel.history.LostFocus(updateFocus);
        const auto itemsPanel = winrt::Microsoft::UI::Xaml::Markup::XamlReader::Load(
                                    L"<ItemsPanelTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><ItemsStackPanel Orientation=\"Horizontal\"/></ItemsPanelTemplate>")
                                    .as<ItemsPanelTemplate>();
        g_panel.history.ItemsPanel(itemsPanel);
        ScrollViewer::SetHorizontalScrollMode(g_panel.history, ScrollMode::Enabled);
        ScrollViewer::SetHorizontalScrollBarVisibility(g_panel.history, ScrollBarVisibility::Hidden);
        ScrollViewer::SetVerticalScrollMode(g_panel.history, ScrollMode::Disabled);
        ScrollViewer::SetVerticalScrollBarVisibility(g_panel.history, ScrollBarVisibility::Disabled);
        g_panel.history.VerticalContentAlignment(VerticalAlignment::Top);
        g_panel.history.ContainerContentChanging([](auto const &, auto const &args) {
            if (args.InRecycleQueue()) return;
            if (const auto container = args.ItemContainer())
                ApplyCardPresenterChrome(container, vpaste::winui::HighContrastEnabled());
            const auto itemIndex = args.ItemIndex();
            const auto index = static_cast<std::size_t>(itemIndex);
            if (index >= g_hashes.size()) return;
            if (index >= g_panel.cardRequested.size() || g_panel.cardRequested[index]) return;
            g_panel.cardRequested[index] = true;
            RequestCardDetails(g_hashes[index]);
        });
        // Tunnel before ListViewItem consumes Space for its own selection.
        g_panel.history.PreviewKeyDown([](auto const &,
                                   winrt::Microsoft::UI::Xaml::Input::KeyRoutedEventArgs const &args) {
            if (IsCardAction(args.OriginalSource())) return;
            if (args.Key() == winrt::Windows::System::VirtualKey::Down &&
                (GetKeyState(VK_CONTROL) & 0x8000) == 0 && (GetKeyState(VK_MENU) & 0x8000) == 0 &&
                (GetKeyState(VK_SHIFT) & 0x8000) == 0 && !args.KeyStatus().WasKeyDown && OpenSelectedCardMenu()) {
                args.Handled(true);
                return;
            }
            if (g_queueSelectionMode && args.Key() == winrt::Windows::System::VirtualKey::Escape &&
                (GetKeyState(VK_CONTROL) & 0x8000) == 0 && (GetKeyState(VK_MENU) & 0x8000) == 0 &&
                (GetKeyState(VK_SHIFT) & 0x8000) == 0) {
                if (!args.KeyStatus().WasKeyDown) ToggleQueueSelectionMode();
                args.Handled(true);
                return;
            }
            if (args.Key() != winrt::Windows::System::VirtualKey::Space &&
                args.Key() != winrt::Windows::System::VirtualKey::Escape) return;
            if (HandlePreviewKey(args.Key(), args.KeyStatus().WasKeyDown,
                                 (GetKeyState(VK_CONTROL) & 0x8000) != 0,
                                 (GetKeyState(VK_SHIFT) & 0x8000) != 0,
                                 (GetKeyState(VK_MENU) & 0x8000) != 0)) {
                args.Handled(true);
                return;
            }
        });
        g_panel.history.KeyDown([](auto const &,
                                   winrt::Microsoft::UI::Xaml::Input::KeyRoutedEventArgs const &args) {
            if (g_panel.cardDrag && g_panel.cardDrag->Active()) return;
            if (IsCardAction(args.OriginalSource())) return;
            if (HandlePreviewKey(args.Key(), args.KeyStatus().WasKeyDown,
                                 (GetKeyState(VK_CONTROL) & 0x8000) != 0,
                                 (GetKeyState(VK_SHIFT) & 0x8000) != 0,
                                 (GetKeyState(VK_MENU) & 0x8000) != 0)) {
                args.Handled(true);
                return;
            }
            if (args.Key() == winrt::Windows::System::VirtualKey::Enter) {
                if (!args.KeyStatus().WasKeyDown) {
                    if (g_queueSelectionMode) RequestSelectedAction(L"paste");
                    else SubmitSearch(false, -1);
                }
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
            if (g_updatingHistorySelection) return;
            g_searchSubmitRequestId = 0;
            if (g_queueSelectionMode) {
                // The logical selection spans filters/pages; SelectedItems is
                // only the currently rendered projection, not the whole set.
                std::vector<std::wstring> visibleSelectedHashes;
                const auto selectedItems = g_panel.history.SelectedItems();
                for (std::uint32_t selectedIndex = 0; selectedIndex < selectedItems.Size(); ++selectedIndex) {
                    const auto surface = selectedItems.GetAt(selectedIndex).as<winrt::Microsoft::UI::Xaml::Controls::Border>();
                    const auto found = std::find_if(g_panel.rows.begin(), g_panel.rows.end(),
                        [&surface](const HistoryRowVisual &row) { return row.surface == surface; });
                    if (found != g_panel.rows.end()) {
                        const auto index = static_cast<std::size_t>(std::distance(g_panel.rows.begin(), found));
                        if (index < g_hashes.size()) visibleSelectedHashes.push_back(g_hashes[index]);
                    }
                }
                g_queueSelectedHashes.erase(std::remove_if(
                    g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(),
                    [&visibleSelectedHashes](const std::wstring &hash) {
                        return std::find(g_hashes.begin(), g_hashes.end(), hash) != g_hashes.end() &&
                            std::find(visibleSelectedHashes.begin(), visibleSelectedHashes.end(), hash) ==
                                visibleSelectedHashes.end();
                    }), g_queueSelectedHashes.end());
                for (const auto &hash : visibleSelectedHashes) {
                    if (std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), hash) ==
                        g_queueSelectedHashes.end()) g_queueSelectedHashes.push_back(hash);
                }
                if (g_panel.queueAdd) {
                    g_panel.queueAdd.IsEnabled(!g_queueSelectedHashes.empty() && !g_queueSelectionAdding);
                }
                if (g_panel.status) {
                    g_panel.status.Text(std::to_wstring(g_queueSelectedHashes.size()) + L" " +
                        Text(L"条已选择", L"selected"));
                }
            } else {
                const auto previous = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
                const auto selectedIndex = g_panel.history.SelectedIndex();
                g_selectedHash = selectedIndex >= 0 &&
                                     static_cast<std::size_t>(selectedIndex) < g_hashes.size()
                    ? g_hashes[static_cast<std::size_t>(selectedIndex)]
                    : std::wstring{};
                const auto direction = previous == g_hashes.end() ? 0 :
                    selectedIndex > std::distance(g_hashes.begin(), previous) ? 1 : -1;
                RequestSelectedPreview(L"previewSelect", direction);
            }
            UpdateQueueSelectionControls();
            ApplyRowTheme();
        });
        Grid::SetRow(g_panel.history, 1);
        root.Children().Append(g_panel.history);

        g_panel.emptyState = vpaste::winui::EmptyState(L"\uE77F", L"", L"");
        Grid::SetRow(g_panel.emptyState, 1);
        StackPanel recovery;
        recovery.Orientation(Orientation::Horizontal);
        recovery.HorizontalAlignment(HorizontalAlignment::Center);
        recovery.Spacing(8);
        g_panel.resetFilters = Button();
        g_panel.resetFilters.Content(winrt::box_value(Text(L"清除筛选", L"Clear filters")));
        g_panel.resetFilters.Click([](auto const &, auto const &) {
            if (g_searchTimer) g_searchTimer.Stop();
            SetSearchText(L"");
            if (g_searchTimer) g_searchTimer.Stop();
            SelectBuiltinCategory(0, false);
            RequestHistory();
        });
        recovery.Children().Append(g_panel.resetFilters);
        g_panel.retry = Button();
        g_panel.retry.Content(winrt::box_value(Text(L"重试", L"Try again")));
        g_panel.retry.Click([](auto const &, auto const &) { RequestHistory(); });
        recovery.Children().Append(g_panel.retry);
        g_panel.emptyState.Children().Append(recovery);
        root.Children().Append(g_panel.emptyState);
        g_panel.loading = ProgressBar();
        g_panel.loading.IsIndeterminate(true);
        g_panel.loading.Height(2);
        g_panel.loading.VerticalAlignment(VerticalAlignment::Top);
        g_panel.loading.Visibility(Visibility::Collapsed);
        Automation::AutomationProperties::SetName(g_panel.loading, Text(L"正在读取历史", L"Loading history"));
        Grid::SetRow(g_panel.loading, 1);
        root.Children().Append(g_panel.loading);
        g_panel.feedback = InfoBar();
        g_panel.feedback.IsOpen(false);
        g_panel.feedback.MaxWidth(420);
        g_panel.feedback.HorizontalAlignment(HorizontalAlignment::Right);
        g_panel.feedback.VerticalAlignment(VerticalAlignment::Top);
        g_panel.feedback.Margin(Thickness{24, 8, 24, 0});
        Grid::SetRow(g_panel.feedback, 1);
        root.Children().Append(g_panel.feedback);

        g_panel.copy = AppBarButton();
        g_panel.copy.Label(Text(L"复制", L"Copy"));
        g_panel.copy.Icon(SymbolIcon{Symbol::Copy});
        g_panel.copy.IsEnabled(false);
        g_panel.copy.Click([](auto const &, auto const &) { RequestSelectedAction(L"copy"); });
        g_panel.commands.SecondaryCommands().Append(g_panel.copy);
        g_panel.paste = AppBarButton();
        g_panel.paste.Label(Text(L"粘贴", L"Paste"));
        g_panel.paste.Icon(SymbolIcon{Symbol::Paste});
        g_panel.paste.IsEnabled(false);
        g_panel.paste.Click([](auto const &, auto const &) { RequestSelectedAction(L"paste"); });
        g_panel.commands.SecondaryCommands().Append(g_panel.paste);
        g_panel.favorite = AppBarButton();
        g_panel.favorite.Label(Text(L"收藏", L"Add favorite"));
        g_panel.favorite.Icon(SymbolIcon{Symbol::Favorite});
        g_panel.favorite.IsEnabled(false);
        g_panel.favorite.Click([](auto const &, auto const &) { RequestSelectedAction(L"favorite"); });
        g_panel.commands.SecondaryCommands().Append(g_panel.favorite);
        g_panel.queueSelect = AppBarButton();
        g_panel.queueSelect.Label(Text(L"选择加入队列", L"Select for queue"));
        g_panel.queueSelect.Icon(SymbolIcon{Symbol::SelectAll});
        g_panel.queueSelect.Click([](auto const &, auto const &) { ToggleQueueSelectionMode(); });
        g_panel.commands.SecondaryCommands().Append(g_panel.queueSelect);
        g_panel.queueAdd = Button();
        g_panel.queueAdd.Content(winrt::box_value(Text(L"加入队列", L"Add to queue")));
        g_panel.queueAdd.Style(Application::Current().Resources().Lookup(winrt::box_value(L"AccentButtonStyle")).as<Style>());
        g_panel.queueAdd.Height(vpaste::winui::CompactActionSize);
        g_panel.queueAdd.FontSize(13);
        g_panel.queueAdd.IsEnabled(false);
        g_panel.queueAdd.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
        g_panel.queueAdd.Click([](auto const &, auto const &) { AddSelectedItemsToQueue(); });
        g_panel.cancelSelection = vpaste::winui::NamedIconButton(SymbolIcon{Symbol::Cancel},
            Text(L"取消队列选择", L"Cancel queue selection"));
        g_panel.cancelSelection.Visibility(Visibility::Collapsed);
        g_panel.cancelSelection.VerticalAlignment(VerticalAlignment::Center);
        g_panel.cancelSelection.Click([](auto const &, auto const &) {
            if (g_queueSelectionMode) ToggleQueueSelectionMode();
        });
        g_panel.selectionTitle = MakeText(Text(L"选择加入队列", L"Select for queue"), 13);
        g_panel.selectionCount = MakeText(L"0", 12);
        Automation::AutomationProperties::SetLiveSetting(g_panel.selectionCount, Automation::Peers::AutomationLiveSetting::Polite);
        StackPanel selectionActions;
        selectionActions.Orientation(Orientation::Horizontal);
        selectionActions.Spacing(12);
        selectionActions.Children().Append(g_panel.selectionTitle);
        selectionActions.Children().Append(g_panel.selectionCount);
        selectionActions.Children().Append(g_panel.queueAdd);
        selectionActions.Children().Append(g_panel.cancelSelection);
        g_panel.selectionBar = Border();
        vpaste::winui::ApplyStyle(g_panel.selectionBar, L"VPaste.SelectionBar");
        g_panel.selectionBar.Child(selectionActions);
        g_panel.selectionBar.HorizontalAlignment(HorizontalAlignment::Center);
        g_panel.selectionBar.VerticalAlignment(VerticalAlignment::Bottom);
        g_panel.selectionBar.Margin(Thickness{16, 0, 16, 12});
        g_panel.selectionBar.Visibility(Visibility::Collapsed);
        Automation::AutomationProperties::SetName(g_panel.selectionBar, Text(L"选择加入队列", L"Select for queue"));
        Grid::SetRow(g_panel.selectionBar, 1);
        root.Children().Append(g_panel.selectionBar);
        g_panel.queueOpen = AppBarButton();
        g_panel.queueOpen.Label(Text(L"粘贴队列", L"Paste queue"));
        g_panel.queueOpen.Icon(vpaste::winui::CompactSymbol(Symbol::List));
        g_panel.queueOpen.Click([](auto const &, auto const &) {
            (void)SendRequest(g_queueViewActive ? L"queueClose" : L"queueOpen");
        });
        g_panel.manageTags = AppBarButton();
        g_panel.manageTags.Label(Text(L"管理标签", L"Manage tags"));
        g_panel.manageTags.Icon(SymbolIcon{Symbol::Edit});
        g_panel.manageTags.Click([](auto const &, auto const &) {
            SetTagManagerActive(true);
        });
        g_panel.commands.SecondaryCommands().Append(g_panel.manageTags);
        g_panel.appActions = std::make_unique<vpaste::winui::AppActions>(root,
            [](const std::wstring &operation, const std::wstring &argument) {
                return SendRequest(operation.c_str(), {}, false, 0, {}, {}, 0, argument);
            }, [](const winrt::hstring &message, bool error) { ShowFeedback(message, error); }, [] {
                if (g_panel.window) PostMessageW(g_panel.window, kFocusHistory, 0, 0);
            });
        g_panel.appActions->SetLanguage(g_english);
        g_panel.hoverPreview = std::make_unique<vpaste::winui::HoverPreview>(
            [](const std::wstring &op, const std::wstring &hash) { (void)SendRequest(op.c_str(), hash); },
            [] { return g_behavior.hoverPreview && PointerHistoryAllowed(); });
        root.AddHandler(UIElement::PointerPressedEvent(), winrt::box_value(
            winrt::Microsoft::UI::Xaml::Input::PointerEventHandler{[](auto const &, auto const &) { CancelHoverPreview(); }}), true);
        g_panel.commands.PrimaryCommands().Append(g_panel.appActions->ToolsButton());
        g_panel.commands.PrimaryCommands().Append(g_panel.queueOpen);
        g_panel.settings = AppBarButton();
        g_panel.settings.Label(Text(L"设置", L"Settings"));
        g_panel.settings.Icon(vpaste::winui::CompactSymbol(Symbol::Setting));
        g_panel.settings.Click([](auto const &, auto const &) { (void)SendRequest(L"settings"); });
        g_panel.commands.PrimaryCommands().Append(g_panel.settings);
        g_panel.commands.PrimaryCommands().Append(g_panel.appActions->UpdateButton());
        for (const auto &action : {g_panel.queueOpen, g_panel.settings}) {
            vpaste::winui::ApplyStyle(action, L"VPaste.RoundToolbarCommand");
        }
        g_panel.more = Button();
        g_panel.more.Content(winrt::box_value(Text(L"加载更多", L"Load more")));
        g_panel.more.MinHeight(32);
        g_panel.more.IsEnabled(false);
        g_panel.more.Click([](auto const &, auto const &) { RequestMoreHistory(); });
        g_panel.more.VerticalAlignment(VerticalAlignment::Center);
        g_panel.history.Footer(g_panel.more);
        g_panel.status = MakeText(Text(L"正在读取剪贴板历史…", L"Loading clipboard history…"), 13);
        g_panel.status.VerticalAlignment(VerticalAlignment::Center);
        g_panel.status.MaxWidth(100);
        g_panel.status.MaxLines(1);
        g_panel.status.TextTrimming(TextTrimming::CharacterEllipsis);
        g_panel.status.Margin(Thickness{0, 0, 8, 0});
        g_panel.status.RegisterPropertyChangedCallback(TextBlock::TextProperty(), [](auto const &, auto const &) {
            ToolTipService::SetToolTip(g_panel.status, winrt::box_value(g_panel.status.Text()));
            ToolTipService::SetToolTip(g_panel.filterScroll, winrt::box_value(g_panel.status.Text()));
        });
        StackPanel toolbarContext;
        toolbarContext.Orientation(Orientation::Horizontal);
        toolbarContext.VerticalAlignment(VerticalAlignment::Center);
        toolbarContext.Children().Append(g_panel.status);
        ToolTipService::SetToolTip(toolbarContext, winrt::box_value(Text(
            L"Space 预览 · Enter 粘贴 · Ctrl+C 复制", L"Space to preview · Enter to paste · Ctrl+C to copy")));
        g_panel.commands.Content(toolbarContext);

        // AutoSuggestBox.TextChanged is deferred. Observe the dependency
        // property synchronously so Enter cannot paste an older query.
        g_panel.search.RegisterPropertyChangedCallback(AutoSuggestBox::TextProperty(), [](auto const &sender, auto const &) {
            SearchChanged(sender.template as<AutoSuggestBox>().Text());
        });
        g_panel.search.QuerySubmitted([](auto const &, auto const &) {
            // QueryIcon applies the filter. Enter-to-paste is handled once by
            // the root keyboard policy before this native event is raised.
            RequestHistory();
        });
        g_panel.filter.SelectionChanged([](auto const &, auto const &) {
            BringSelectedTabIntoView(g_panel.filter);
            if (!g_updatingLanguage) {
                g_updatingTagFilter = true;
                g_panel.customTabs.SelectedItem(nullptr);
                g_selectedFilterId.clear();
                g_panel.tagFilter.SelectedIndex(0);
                g_selectedTagId = 0;
                g_selectedTagName.clear();
                g_updatingTagFilter = false;
                RequestHistory();
            }
        });
        g_searchTimer = g_dispatcher.DispatcherQueue().CreateTimer();
        g_searchTimer.Interval(std::chrono::milliseconds(240));
        g_searchTimer.IsRepeating(false);
        g_searchTimer.Tick([](auto const &timer, auto const &) {
            timer.Stop();
            RequestHistory();
        });
        g_feedbackTimer = g_dispatcher.DispatcherQueue().CreateTimer();
        g_feedbackTimer.Interval(std::chrono::seconds(3));
        g_feedbackTimer.IsRepeating(false);
        g_feedbackTimer.Tick([](auto const &, auto const &) { DismissFeedback(); });

        g_panel.queueView = std::make_unique<vpaste::winui::QueueView>(
            [](const std::wstring &operation, const std::wstring &hash,
               const std::vector<std::wstring> &hashes) {
                return SendRequest(operation.c_str(), hash, false, 0, hashes);
            },
            [] { (void)SendRequest(L"queueClose"); });
        g_panel.queueView->SetLanguage(g_english);
        g_panel.queueView->SetTheme(root.RequestedTheme());
        g_panel.cardDrag = std::make_unique<vpaste::winui::CardDragSource>(
            [](const std::wstring &operation, const std::wstring &hash) { return SendRequest(operation.c_str(), hash); },
            [](bool accepted, const winrt::hstring &error) {
                if (!error.empty()) ShowFeedback(error, true);
                else if (accepted) ShowFeedback(Text(L"已交给目标应用", L"Sent to target application"));
                if (std::exchange(g_historyRefreshAfterDrag, false)) RequestHistory();
                PostMessageW(g_panel.window, kSyncHistoryViewport, 0, 0);
            });
        g_panel.imageExport = std::make_unique<vpaste::winui::ImageExport>(g_panel.window,
            [](const std::wstring &operation, const std::wstring &hash, const std::wstring &argument) {
                return SendRequest(operation.c_str(), hash, false, 0, {}, {}, 0, argument);
            }, [](const std::wstring &message, bool error) { ShowFeedback(winrt::hstring{message}, error); });

        g_panel.tagManager = std::make_unique<vpaste::winui::TagManager>(
            [](const std::wstring &operation, std::int64_t tagId,
               const std::wstring &name) {
                return SendTagManagerRequest(operation, tagId, name);
            },
            [] { SetTagManagerActive(false); });
        g_panel.tagManager->SetLanguage(g_english);
        g_panel.tagManager->SetTheme(root.RequestedTheme());
        g_panel.filterEditor = std::make_unique<vpaste::winui::FilterEditor>(
            SendEditorRequest,
            [](const winrt::Windows::Data::Json::JsonArray &items) {
                ApplyFilters(items);
            });
        g_panel.recordTagEditor = std::make_unique<vpaste::winui::RecordTagEditor>(SendEditorRequest,
            [](const std::wstring &operation, std::int64_t id, const std::wstring &name) {
                if (operation == L"recordTagCreate") {
                    SelectBuiltinCategory(0, false);
                    g_selectedTagId = id; g_selectedTagName = name;
                    const auto languageGuard = std::exchange(g_updatingLanguage, true);
                    g_panel.filter.SelectedItem(nullptr);
                    g_updatingLanguage = languageGuard;
                }
                RefreshTags();
                ShowFeedback(operation == L"recordTagDelete" ? Text(L"标签已删除，剪贴项仍然保留", L"Tag deleted; clipboard items kept")
                    : operation == L"recordTagAssign" ? Text(L"标签已添加到剪贴项", L"Tag assigned to item") : Text(L"标签已保存", L"Tag saved"));
            });

        phase = "create native reader";
        g_panel.reader = std::make_unique<vpaste::winui::Reader>([](auto const &operation, auto generation) {
            if (operation == L"nativeReaderClose") {
                // The shared command cancels hover first, then reserves the
                // explicit close so its focus return cannot be superseded.
                (void)SendRequest(L"previewClose");
                return;
            }
            if (operation == L"readerNext" || operation == L"readerPrevious" ||
                operation == L"readerNextCategory" || operation == L"readerPreviousCategory") {
                NavigatePreview(operation == L"readerPrevious" || operation == L"readerPreviousCategory" ? -1 : 1,
                    operation == L"readerNextCategory" || operation == L"readerPreviousCategory");
                return;
            }
            (void)SendRequest(operation.c_str(), {}, false, 0, {}, {}, 0, std::to_wstring(generation));
        }, g_panel.window);
        g_panel.reader->SetAppearance(g_english, root.RequestedTheme());
        phase = "attach panel controls";
        root.Children().Append(g_panel.shadowReceiver);
        g_panel.xamlSource.Content(g_panel.viewport);
        const auto initialScale = GetDpiForWindow(g_panel.window) / 96.0;
        g_dockedLayout = {0, 0, static_cast<int>(std::lround(kWindowWidth * initialScale)),
            static_cast<int>(std::lround(kPanelHeight * initialScale)), initialScale, 1};
        ApplyActiveLayout();
        phase = "apply panel appearance";
        ConfigureAcrylicBackdrop(true);
        ApplyRowTheme();
        UpdateHistoryState();
        ResizeIsland();
        g_panel.xamlSource.SiteBridge().Show();
        (void)SendRequest(L"appState");
        return S_OK;
    } catch (const winrt::hresult_error &error) {
        std::fprintf(stderr, "WinUI startup failed during %s: 0x%08X %s\n",
            phase, static_cast<unsigned>(error.code()), winrt::to_string(error.message()).c_str());
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
    g_panel.dockMotion.reset();
    g_panel.tabIndicator.reset();
    g_panel.indicatorSelection = {};
    g_historyRefreshAfterDrag = false;
    g_panel.cardDrag.reset();
    g_panel.historyScrollChanged.revoke();
    g_panel.historyManipulation.revoke();
    if (g_historyVerifyToken) {
        winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(*g_historyVerifyToken);
        g_historyVerifyToken.reset();
    }
    g_panel.historyScroll = nullptr;
    g_historyView = {};
    g_panel.imageExport.reset();
    g_panel.reader.reset();
    g_panel.filterEditor.reset();
    g_panel.recordTagEditor.reset();
    g_customFilters.clear();
    g_selectedFilterId.clear();
    if (g_searchTimer != nullptr) {
        if (g_searchTimer.IsRunning()) {
            g_searchTimer.Stop();
        }
        g_searchTimer = nullptr;
    }
    DismissFeedback();
    g_feedbackTimer = nullptr;
    g_panel.hoverPreview.reset();
    g_hoverPosition.reset();
    g_latestHoverRequestId = 0;
    g_panel.appActions.reset();
    if (g_panel.xamlSource != nullptr) {
        // DestroyWindow has disconnected the island; do not set its properties.
        g_panel.xamlSource.Close();
        g_panel.xamlSource = nullptr;
    }
    g_panel.searchChanging.revoke();
    g_panel.search = nullptr;
    g_searchText = L"";
    g_panel.searchButton = nullptr;
    g_panel.commands = nullptr;
    g_panel.filter = nullptr;
    g_panel.filterScroll = nullptr;
    g_panel.filterStrip = nullptr;
    g_panel.tabIndicatorHost = nullptr;
    g_panel.customTabs = nullptr;
    g_panel.addTag = nullptr;
    g_panel.tagFilterButton = nullptr;
    g_panel.tagFilter = nullptr;
    g_panel.history = nullptr;
    g_panel.status = nullptr;
    g_panel.loading = nullptr;
    g_panel.emptyState = nullptr;
    g_panel.resetFilters = nullptr;
    g_panel.retry = nullptr;
    g_panel.cancelSelection = nullptr;
    g_panel.selectionBar = nullptr;
    g_panel.selectionTitle = nullptr;
    g_panel.selectionCount = nullptr;
    g_panel.deletionDialog = nullptr;
    g_panel.feedback = nullptr;
    g_panel.copy = nullptr;
    g_panel.paste = nullptr;
    g_panel.favorite = nullptr;
    g_panel.queueSelect = nullptr;
    g_panel.queueAdd = nullptr;
    g_panel.queueOpen = nullptr;
    g_panel.manageTags = nullptr;
    g_panel.settings = nullptr;
    g_panel.more = nullptr;
    g_panel.viewport = nullptr;
    g_panel.header = nullptr;
    g_panel.shadowReceiver = nullptr;
    g_panel.root = nullptr;
    g_panel.queueWindow.reset();
    g_panel.queueView.reset();
    g_queueViewActive = false;
    g_panel.tagManager.reset();
    g_panel.tagManagerViewActive = false;
    if (g_panel.windowCanvas) {
        winrt::Microsoft::UI::Xaml::Application::Current().Resources().Remove(
            winrt::box_value(vpaste::winui::WindowCanvasResource));
        g_panel.windowCanvas = nullptr;
    }
    g_panel.hasSystemBackdrop = false;
    g_hashes.clear();
    g_favorites.clear();
    g_queueSelectionAddRequest = 0;
    g_queueSelectionAdding = false;
    g_queueSubmittedHashes.clear();
    g_panel.rows.clear();
    g_tagNames.clear();
    g_highlightTerms.clear();
    g_tagIds.clear();
    g_dynamicIds.clear(); g_tabOrder.clear(); g_tabOrderLoadRequest = 0; g_tabOrderSaveRequest = 0;
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

extern "C" __declspec(dllexport) std::uint32_t vpaste_winui_protocol_version() noexcept {
    return vpaste::winui::BridgeVersion;
}

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

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_layout(const PanelLayout *layout) noexcept {
    if (!layout || layout->width <= 0 || layout->height <= 0 ||
        !std::isfinite(layout->screenScale) || layout->screenScale <= 0 ||
        !std::isfinite(layout->panelScale) || layout->panelScale <= 0) return E_INVALIDARG;
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (!window || !IsWindow(window)) return E_UNEXPECTED;
    // The synchronous send keeps this caller-owned copy alive until consumed.
    const auto copied = *layout;
    return static_cast<int32_t>(SendMessageW(window, kSetLayout, 0, reinterpret_cast<LPARAM>(&copied)));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_get_layout(PanelLayout *layout) noexcept {
    if (!layout) return E_INVALIDARG;
    HWND window = nullptr;
    { std::lock_guard lock(g_stateMutex); window = g_panel.window; }
    if (!window || !IsWindow(window)) return E_UNEXPECTED;
    // The caller owns this output until the synchronous STA message returns.
    return static_cast<int32_t>(SendMessageW(window, kGetLayout, 0, reinterpret_cast<LPARAM>(layout)));
}

extern "C" __declspec(dllexport) std::uintptr_t vpaste_winui_window_handle() noexcept {
    std::lock_guard lock(g_stateMutex);
    return reinterpret_cast<std::uintptr_t>(g_panel.window);
}

extern "C" __declspec(dllexport) std::uintptr_t vpaste_winui_reader_handle() noexcept {
    return vpaste::winui::ReaderWindowHandle();
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_focus_history() noexcept {
    std::lock_guard lock(g_stateMutex);
    if (!g_panel.window || !IsWindow(g_panel.window)) return S_FALSE;
    return PostMessageW(g_panel.window, kFocusHistory, 0, 0) ? S_OK : HRESULT_FROM_WIN32(GetLastError());
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_hide() noexcept {
    return static_cast<int32_t>(SendPanelMessage(kHideWindow));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_behavior(
    const std::uint8_t *bytes, std::size_t length) noexcept {
    if (!bytes || length == 0 || length > vpaste::winui::MaxRequestBytes) return E_INVALIDARG;
    try {
        HWND window = nullptr;
        { std::lock_guard lock(g_stateMutex); window = g_panel.window; }
        if (!window || !IsWindow(window)) return E_UNEXPECTED;
        const std::string copied{reinterpret_cast<const char *>(bytes), length};
        // SendMessage consumes the caller-owned string before returning.
        return static_cast<int32_t>(SendMessageW(window, kSetBehavior, 0, reinterpret_cast<LPARAM>(&copied)));
    } catch (...) { return winrt::to_hresult(); }
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
    if (bytes == nullptr || length == 0 || length > vpaste::winui::MaxResponseBytes) {
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
// Optional local render artifacts use synthetic content only. RenderTargetBitmap
// captures XAML, not the desktop compositor's Acrylic or the native frame/shadow.
winrt::Windows::Foundation::IAsyncAction AwaitNativeLoaded(
    winrt::Microsoft::UI::Xaml::FrameworkElement element) {
    if (element.IsLoaded()) co_return;
    const winrt::apartment_context ui;
    winrt::handle ready{CreateEventW(nullptr, false, false, nullptr)};
    winrt::check_bool(static_cast<bool>(ready));
    const auto token = element.Loaded([signal = ready.get()](auto const &, auto const &) { SetEvent(signal); });
    const bool loaded = co_await winrt::resume_on_signal(ready.get(), std::chrono::seconds(5));
    co_await ui;
    element.Loaded(token);
    winrt::check_hresult(loaded && element.IsLoaded() ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
}

winrt::Windows::Foundation::IAsyncAction CloseNativeFlyout(
    winrt::Microsoft::UI::Xaml::Controls::Primitives::FlyoutBase popup) {
    if (!popup.IsOpen()) co_return;
    const winrt::apartment_context ui;
    winrt::handle ready{CreateEventW(nullptr, false, false, nullptr)};
    winrt::check_bool(static_cast<bool>(ready));
    const auto token = popup.Closed([signal = ready.get()](auto const &, auto const &) { SetEvent(signal); });
    popup.Hide();
    const bool closed = co_await winrt::resume_on_signal(ready.get(), std::chrono::seconds(5));
    co_await ui; popup.Closed(token);
    winrt::check_hresult(closed ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
}

winrt::Windows::Foundation::IAsyncAction AwaitHistoryOffset(double offset) {
    const winrt::apartment_context ui;
    // Reparenting/replacing items must reach a rendered layout before reading
    // its scroller or range; a matching pre-layout offset is not readiness.
    co_await NextNativeFrame();
    BindHistoryScroll();
    const auto scroll = g_panel.historyScroll;
    const auto target = vpaste::winui::ClampHistoryOffset(offset, scroll.ScrollableWidth());
    if (!g_historyView.restore && std::abs(scroll.HorizontalOffset() - target) <= 0.5) co_return;
    winrt::handle ready{CreateEventW(nullptr, false, false, nullptr)};
    winrt::check_bool(static_cast<bool>(ready));
    const auto token = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering([signal = ready.get(), target, scroll](auto const &, auto const &) {
        if (!g_historyView.restore && std::abs(scroll.HorizontalOffset() - target) <= 0.5)
            SetEvent(signal);
    });
    const bool reached = co_await winrt::resume_on_signal(ready.get(), std::chrono::seconds(5));
    co_await ui;
    winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(token);
    if (!reached) std::fprintf(stderr, "WinUI viewport wait: input=%.1f target=%.1f old=%.1f current=%.1f max=%.1f loaded=%d same=%d pending=%d loading=%d\n",
        offset, target, scroll.HorizontalOffset(), g_panel.historyScroll.HorizontalOffset(),
        g_panel.historyScroll.ScrollableWidth(), g_panel.history.IsLoaded(), scroll == g_panel.historyScroll,
        g_historyView.restore.has_value(), g_historyLoading);
    winrt::check_hresult(reached ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
}

winrt::Windows::Foundation::IAsyncAction AwaitCardDetailState(
    std::wstring hash, std::uint64_t request, CardDetailState expected) {
    const winrt::apartment_context ui;
    co_await NextNativeFrame();
    const auto matches = [&] {
        const auto row = FindCard(hash);
        return row && row->cardRequestId == request && row->detailState == expected;
    };
    if (matches()) co_return;
    winrt::handle ready{CreateEventW(nullptr, false, false, nullptr)};
    winrt::check_bool(static_cast<bool>(ready));
    const auto token = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(
        [signal = ready.get(), &matches](auto const &, auto const &) { if (matches()) SetEvent(signal); });
    const bool reached = co_await winrt::resume_on_signal(ready.get(), std::chrono::seconds(5));
    co_await ui;
    winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(token);
    if (!reached) std::fprintf(stderr, "WinUI card detail wait: expected=%d actual=%d bitmap=%d\n", static_cast<int>(expected),
        FindCard(hash) ? static_cast<int>(FindCard(hash)->detailState) : -1,
        FindCard(hash) && static_cast<bool>(FindCard(hash)->pendingBitmap));
    winrt::check_hresult(reached ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
}

winrt::Windows::Foundation::IAsyncAction CaptureNativeView(
    winrt::Microsoft::UI::Xaml::FrameworkElement view,
    winrt::Windows::Storage::StorageFolder folder, winrt::hstring name) {
    using namespace winrt::Windows::Graphics::Imaging;
    using namespace winrt::Windows::Storage;
    using namespace winrt::Windows::Storage::Streams;
    const winrt::apartment_context ui;
    view.UpdateLayout();
    co_await NextNativeFrame();
    view.UpdateLayout();
    co_await NextNativeFrame();
    // Native entrance transitions are owned by WinUI. Wait off-thread for their
    // settled state rather than changing system animation settings for a capture.
    co_await winrt::resume_after(std::chrono::milliseconds(400));
    co_await ui;
    view.UpdateLayout();
    RECT client{};
    const auto host = g_panel.queueView && view == g_panel.queueView->Root() && g_panel.queueWindow
        ? g_panel.queueWindow->Handle() : g_panel.window;
    GetClientRect(host, &client);
    std::fprintf(stderr, "WinUI render %ls: root=%.0fx%.0f client=%ldx%ld dpi=%u queue=%d tags=%d\n",
        name.c_str(), view.ActualWidth(), view.ActualHeight(), client.right, client.bottom,
        GetDpiForWindow(host), g_queueViewActive, g_panel.tagManagerViewActive);
    winrt::Microsoft::UI::Xaml::Media::Imaging::RenderTargetBitmap bitmap;
    co_await bitmap.RenderAsync(view);
    const auto pixels = co_await bitmap.GetPixelsAsync();
    std::vector<std::uint8_t> bytes(pixels.Length());
    DataReader::FromBuffer(pixels).ReadBytes(bytes);
    const auto file = co_await folder.CreateFileAsync(name, CreationCollisionOption::ReplaceExisting);
    const auto stream = co_await file.OpenAsync(FileAccessMode::ReadWrite);
    const auto encoder = co_await BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId(), stream);
    encoder.SetPixelData(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied,
        bitmap.PixelWidth(), bitmap.PixelHeight(), 96, 96, bytes);
    co_await encoder.FlushAsync();
}

// Local regression test only: exercise the real controls with synthetic records.
// The Rust test initializes the shell without an AppHandle or clipboard service.
winrt::fire_and_forget RunNativePresentationRegression(
    std::shared_ptr<std::promise<std::pair<HRESULT, std::uint32_t>>> completion) {
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
            const auto dockContent = g_panel.xamlSource.Content();
            RECT dockBeforeQueue{}; GetWindowRect(g_panel.window, &dockBeforeQueue);
            SetQueueViewActive(true);
            RECT dockWithQueue{}; GetWindowRect(g_panel.window, &dockWithQueue);
            winrt::check_hresult(g_panel.xamlSource.Content() == dockContent &&
                EqualRect(&dockBeforeQueue, &dockWithQueue) ? S_OK : E_FAIL);
            g_panel.status.Text(L"No response error");
            ApplyResponse(R"({"id":0,"op":"queueStateUpdate","data":{"active":true,"busy":false,"capacity":100,"revision":1,"items":[{"hash":"test-b","itemType":"Text","previewContent":"New capture","appSource":"Test"}],"error":null,"undoHash":null}})");
            winrt::check_hresult(g_panel.status.Text() == L"No response error" ? S_OK : E_FAIL);
            auto queueRoot = g_panel.queueView->Root().as<winrt::Microsoft::UI::Xaml::Controls::Grid>();
            auto list = queueRoot.Children().GetAt(1).as<winrt::Microsoft::UI::Xaml::Controls::ScrollViewer>();
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
            currentStage = 7;
            SetTagManagerActive(true);
            g_panel.tagManager->SetTags(winrt::Windows::Data::Json::JsonArray::Parse(
                LR"([{"id":1,"name":"工作"},{"id":2,"name":"Notes"}])"));
            auto tagRoot = g_panel.tagManager->Root()
                .as<winrt::Microsoft::UI::Xaml::Controls::Grid>();
            auto tagList = tagRoot.Children().GetAt(2)
                .as<winrt::Microsoft::UI::Xaml::Controls::ScrollViewer>();
            auto tagRows = tagList.Content()
                .as<winrt::Microsoft::UI::Xaml::Controls::StackPanel>();
            winrt::check_hresult(tagRows.Children().Size() == 2 ? S_OK : E_FAIL);
            const auto tagNameAt = [&](std::uint32_t index) {
                return tagRows.Children().GetAt(index)
                    .as<winrt::Microsoft::UI::Xaml::Controls::Border>().Child()
                    .as<winrt::Microsoft::UI::Xaml::Controls::Grid>().Children().GetAt(0)
                    .as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>().Text();
            };
            winrt::check_hresult(tagNameAt(0) == L"工作" ? S_OK : E_FAIL);
            currentStage = 8;
            g_panel.tagManager->SetTags(winrt::Windows::Data::Json::JsonArray::Parse(
                LR"([{"id":1,"name":"工作"},{"id":2,"name":"Notes"},{"id":3,"name":"Personal"}])"));
            winrt::check_hresult(tagRows.Children().Size() == 3 ? S_OK : E_FAIL);
            g_panel.tagManager->SetTags(winrt::Windows::Data::Json::JsonArray::Parse(
                LR"([{"id":1,"name":"Projects"},{"id":3,"name":"Personal"}])"));
            winrt::check_hresult(tagRows.Children().Size() == 2 ? S_OK : E_FAIL);
            winrt::check_hresult(tagNameAt(0) == L"Projects" ? S_OK : E_FAIL);
            currentStage = 9;
            g_panel.tagManager->SetLanguage(true);
            g_panel.tagManager->SetTheme(winrt::Microsoft::UI::Xaml::ElementTheme::Dark);
            g_panel.tagManager->SetError(L"Synthetic tag save failure");
            winrt::check_hresult(tagRows.Children().Size() == 2 ? S_OK : E_FAIL);
            SetTagManagerActive(false);
            SetTagManagerActive(true);
            g_panel.tagManager->SetTags(winrt::Windows::Data::Json::JsonArray::Parse(L"[]"));
            winrt::check_hresult(tagRows.Children().Size() == 0 &&
                tagRoot.Children().GetAt(5).as<winrt::Microsoft::UI::Xaml::Controls::StackPanel>()
                    .Children().GetAt(1).as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>().Text() == L"还没有标签"
                ? S_OK : E_FAIL);
            SetTagManagerActive(false);
            currentStage = 10;
            g_panel.history.SelectedIndex(-1);
            ApplyResponse(R"({"id":300,"op":"query","data":{"items":[{"hash":"test-a"},{"hash":"test-b"}]}})");
            winrt::check_hresult(g_selectedHash == L"test-a" && g_panel.copy.IsEnabled() ? S_OK : E_FAIL);
            g_panel.history.SelectedIndex(1);
            ApplyResponse(R"({"id":301,"op":"query","data":{"items":[{"hash":"test-c"},{"hash":"test-a"},{"hash":"test-b"}]}})");
            winrt::check_hresult(g_selectedHash == L"test-b" && g_panel.history.SelectedIndex() == 2 ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":302,"op":"query","data":{"items":[{"hash":"test-a"}]}})");
            winrt::check_hresult(g_selectedHash == L"test-a" ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":303,"op":"query","data":{"items":[]}})");
            winrt::check_hresult(g_selectedHash.empty() && !g_panel.copy.IsEnabled() ? S_OK : E_FAIL);
            currentStage = 11;
            ApplyResponse(R"({"id":304,"op":"query","data":{"items":[{"hash":"test-a"},{"hash":"test-b"}]}})");
            ToggleQueueSelectionMode();
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
            ApplyResponse(R"({"id":305,"op":"query","data":{"items":[{"hash":"test-c"},{"hash":"test-a"},{"hash":"test-b"}]}})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-a"} &&
                g_panel.history.SelectedItems().Size() == 1 && g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(2));
            currentStage = 12;
            ApplyResponse(R"({"id":306,"op":"query","data":{"items":[{"hash":"test-a"}]}})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-a", L"test-b"} &&
                g_panel.history.SelectedItems().Size() == 1 ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":307,"op":"queryMore","data":{"items":[{"hash":"test-b"}]}})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-a", L"test-b"} &&
                g_panel.history.SelectedItems().Size() == 2 ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":308,"op":"query","data":{"items":[{"hash":"test-a"}]}})");
            g_panel.history.SelectedItems().Clear();
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-b"} &&
                g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":309,"op":"query","error":"Synthetic refresh failure"})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-b"} &&
                g_panel.queueAdd.IsEnabled() && g_panel.status.Text() == L"Synthetic refresh failure"
                ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":310,"op":"query","data":{"items":[{"hash":"test-b"}]}})");
            winrt::check_hresult(g_panel.history.SelectedItems().Size() == 1 ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":311,"op":"query","data":{"items":[]}})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-b"} &&
                g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
            currentStage = 13;
            ApplyResponse(R"({"id":312,"op":"query","data":{"items":[{"hash":"test-b"}]}})");
            ApplyResponse(R"({"id":313,"op":"delete","error":"Synthetic delete failure"})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-b"} &&
                g_panel.history.SelectedItems().Size() == 1 ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":314,"op":"delete","data":{"hash":"test-b","deleted":true}})");
            winrt::check_hresult(g_queueSelectedHashes.empty() &&
                g_panel.history.SelectedItems().Size() == 0 && !g_panel.queueAdd.IsEnabled()
                ? S_OK : E_FAIL);
            currentStage = 14;
            ApplyResponse(R"({"id":315,"op":"query","data":{"items":[{"hash":"test-a"},{"hash":"test-b"}]}})");
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(1));
            ApplyResponse(R"({"id":316,"op":"query","data":{"items":[{"hash":"test-a"}]}})");
            ApplyResponse(R"({"id":317,"op":"delete","data":{"hash":"test-b","deleted":true}})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"test-a"} &&
                g_panel.history.SelectedItems().Size() == 1 && g_panel.queueAdd.IsEnabled()
                ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            winrt::check_hresult(g_queueSelectedHashes.empty() && !g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
            currentStage = 15;
            ApplyResponse(R"({"id":400,"op":"query","data":{"items":[{"hash":"test-a"},{"hash":"test-b"}]}})");
            g_panel.history.SelectedIndex(0);
            static std::vector<std::string> previewRequests;
            previewRequests.clear();
            struct RestoreRequest {
                PanelRequest previous;
                ~RestoreRequest() { g_request = previous; }
            } restoreRequest{g_request};
            g_request = +[](const std::uint8_t *bytes, std::size_t size) {
                previewRequests.emplace_back(reinterpret_cast<const char *>(bytes), size);
            };
            using winrt::Windows::System::VirtualKey;
            const auto requestAt = [&](std::size_t index) {
                return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(previewRequests.at(index)));
            };
            const auto requestAfter = [&](const wchar_t *operation, std::size_t from) {
                winrt::Windows::Data::Json::JsonObject found{nullptr};
                for (auto index = from; index < previewRequests.size(); ++index) {
                    auto request = requestAt(index);
                    if (request.GetNamedString(L"op") != operation) continue;
                    winrt::check_hresult(!found ? S_OK : E_FAIL);
                    found = request;
                }
                winrt::check_hresult(found ? S_OK : E_FAIL);
                return found;
            };
            const auto navigateFromPreview = [&](std::string const &bytes) {
                auto response = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(bytes));
                response.GetNamedObject(L"data").Insert(L"sourceRequest", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(
                    static_cast<double>(g_latestPreviewRequestId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
            };
            winrt::check_hresult(HandlePreviewKey(VirtualKey::Space, false, false, false, false) ? S_OK : E_FAIL);
            winrt::check_hresult(previewRequests.size() == 1 &&
                requestAt(0).GetNamedString(L"op") == L"previewToggle" &&
                requestAt(0).GetNamedString(L"hash") == L"test-a" ? S_OK : E_FAIL);
            HandlePreviewKey(VirtualKey::Space, true, false, false, false);
            winrt::check_hresult(previewRequests.size() == 1 ? S_OK : E_FAIL);
            currentStage = 16;
            HandlePreviewKey(VirtualKey::Right, false, false, false, false);
            winrt::check_hresult(g_selectedHash == L"test-b" && previewRequests.size() == 2 &&
                requestAt(1).GetNamedString(L"op") == L"previewSelect" &&
                requestAt(1).GetNamedNumber(L"navigationDirection") == 1 ? S_OK : E_FAIL);
            HandlePreviewKey(VirtualKey::Right, true, false, false, false);
            winrt::check_hresult(g_selectedHash == L"test-b" && previewRequests.size() == 2 ? S_OK : E_FAIL);
            navigateFromPreview(R"({"id":0,"op":"previewNavigation","data":{"direction":-1,"key":"ArrowLeft","ctrlKey":false}})");
            winrt::check_hresult(g_selectedHash == L"test-a" && previewRequests.size() == 3 &&
                requestAt(2).GetNamedNumber(L"navigationDirection") == -1 ? S_OK : E_FAIL);
            navigateFromPreview(R"({"id":0,"op":"previewNavigation","data":{"direction":1,"key":"Tab","ctrlKey":true}})");
            winrt::check_hresult(FilterIndex() == 1 ? S_OK : E_FAIL);
            navigateFromPreview(R"({"id":0,"op":"previewNavigation","data":{"direction":-1,"key":"Tab","ctrlKey":true}})");
            winrt::check_hresult(FilterIndex() == 0 ? S_OK : E_FAIL);
            currentStage = 17;
            const auto beforeEscape = previewRequests.size();
            HandlePreviewKey(VirtualKey::Escape, false, false, false, false);
            winrt::check_hresult(previewRequests.size() == beforeEscape + 1 &&
                requestAt(beforeEscape).GetNamedString(L"op") == L"dismiss" ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            const auto beforeBlockedSpace = previewRequests.size();
            winrt::check_hresult(!HandlePreviewKey(VirtualKey::Space, false, false, false, false) &&
                previewRequests.size() == beforeBlockedSpace ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            ApplyResponse(R"({"id":500,"op":"query","data":{"items":[]}})");
            const auto beforeEmptySpace = previewRequests.size();
            HandlePreviewKey(VirtualKey::Space, false, false, false, false);
            winrt::check_hresult(previewRequests.size() == beforeEmptySpace ? S_OK : E_FAIL);
            WindowProc(g_panel.window, kFocusHistory, 0, 0);
            currentStage = 18;
            ApplyResponse(R"({"id":600,"op":"query","data":{"items":[{"hash":"material-test","previewText":"Opaque content"}]}})");
            const auto selectedBeforeMaterialChange = g_selectedHash;
            winrt::check_hresult(!ConfigureAcrylicBackdrop(false) && !g_panel.xamlSource.SystemBackdrop() ? S_OK : E_FAIL);
            const std::vector<winrt::Microsoft::UI::Xaml::FrameworkElement> views{
                g_panel.root, g_panel.queueView->Root(), g_panel.tagManager->Root()};
            const auto canvasColor = [](const auto &view) {
                return view.template as<winrt::Microsoft::UI::Xaml::Controls::Grid>().Background()
                    .template as<winrt::Microsoft::UI::Xaml::Media::SolidColorBrush>().Color();
            };
            WindowProc(g_panel.window, kSetTheme, 1, 0);
            for (const auto &view : views) {
                const auto color = canvasColor(view);
                winrt::check_hresult(color.A == 255 && color.R == 246 && color.G == 247 && color.B == 249 ? S_OK : E_FAIL);
            }
            WindowProc(g_panel.window, kSetTheme, 2, 0);
            for (const auto &view : views) {
                const auto color = canvasColor(view);
                winrt::check_hresult(color.A == 255 && color.R == 23 && color.G == 27 && color.B == 34 ? S_OK : E_FAIL);
            }
            const bool supported = winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController::IsSupported();
            winrt::check_hresult(ConfigureAcrylicBackdrop(true) == supported ? S_OK : E_FAIL);
            winrt::check_hresult(static_cast<bool>(g_panel.xamlSource.SystemBackdrop()
                .try_as<winrt::Microsoft::UI::Xaml::Media::DesktopAcrylicBackdrop>()) == supported ? S_OK : E_FAIL);
            for (const auto &view : views) {
                winrt::check_hresult(canvasColor(view).A == (supported ? 0 : 255) ? S_OK : E_FAIL);
            }
            winrt::check_hresult(g_panel.rows[0].surface.Background()
                .as<winrt::Microsoft::UI::Xaml::Media::SolidColorBrush>().Color().A == 255 ? S_OK : E_FAIL);
            winrt::check_hresult(g_selectedHash == selectedBeforeMaterialChange && g_panel.history.Items().Size() == 1 ? S_OK : E_FAIL);
            WindowProc(g_panel.window, kSetTheme, 0, 0);
            currentStage = 19;
            winrt::check_hresult(g_panel.commands.IsDynamicOverflowEnabled() &&
                g_panel.commands.PrimaryCommands().Size() == 4 &&
                g_panel.commands.SecondaryCommands().Size() == 5 ? S_OK : E_FAIL);
            const bool originalEnglish = g_english;
            for (const bool english : {false, true}) {
                WindowProc(g_panel.window, kSetLanguage, english, 0);
                for (std::uint32_t filter = 0; filter < 7; ++filter) {
                    g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(filter));
                    winrt::check_hresult(FilterIndex() == static_cast<int>(filter) &&
                        requestAt(previewRequests.size() - 1).GetNamedString(L"filter") == FilterValue(filter)
                        ? S_OK : E_FAIL);
                }
                const auto selectedFilter = g_panel.filter.SelectedItem();
                UpdateFilterLabels();
                winrt::check_hresult(g_panel.filter.SelectedItem() == selectedFilter &&
                    g_panel.filter.Items().Size() == 7 ? S_OK : E_FAIL);
                for (const auto &action : {g_panel.copy, g_panel.paste, g_panel.favorite,
                         g_panel.queueSelect, g_panel.queueOpen, g_panel.manageTags, g_panel.settings,
                         g_panel.appActions->ToolsButton(), g_panel.appActions->UpdateButton()}) {
                    winrt::check_hresult(!action.Label().empty() && action.Icon() ? S_OK : E_FAIL);
                }
                currentStage = 20;
                for (const auto theme : {1, 2}) {
                    WindowProc(g_panel.window, kSetTheme, theme, 0);
                    for (const float width : {640.0f, 960.0f}) {
                        g_panel.root.Width(width);
                        UpdateSearchWidth();
                        g_panel.search.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                        g_panel.root.Measure({width, 560});
                        g_panel.root.Arrange({0, 0, width, 560});
                        g_panel.root.UpdateLayout();
                        const auto tagPosition = g_panel.tagFilterButton.TransformToVisual(g_panel.root).TransformPoint({0, 0});
                        const auto filterPosition = g_panel.filterScroll.TransformToVisual(g_panel.root).TransformPoint({0, 0});
                        const bool fits = g_panel.commands.ActualWidth() <= width - kHeaderInset * 2 + 1 &&
                            g_panel.search.ActualWidth() >= 120 &&
                            filterPosition.X + g_panel.filterScroll.ActualWidth() <= tagPosition.X + 1 &&
                            tagPosition.X + g_panel.tagFilterButton.ActualWidth() <= width - kHeaderInset + 1 &&
                            g_panel.history.ActualHeight() >= kCardHeight + 24 &&
                            g_panel.root.RowDefinitions().Size() == 2 &&
                            g_panel.root.RowDefinitions().GetAt(0).Height().Value == kHeaderHeight;
                        if (!fits) std::fprintf(stderr,
                            "WinUI layout: english=%d theme=%d width=%.0f actual=%.1f commands=%.1f search=%.1f filter=[%.1f,%.1f] tag=[%.1f,%.1f] history=%.1f\n",
                            english, theme, width, g_panel.root.ActualWidth(), g_panel.commands.ActualWidth(),
                            g_panel.search.ActualWidth(), filterPosition.X, g_panel.filterScroll.ActualWidth(),
                            tagPosition.X, g_panel.tagFilterButton.ActualWidth(), g_panel.history.ActualHeight());
                        winrt::check_hresult(fits ? S_OK : E_FAIL);
                        if (english && width == 640) {
                            // ScrollViewer publishes its extent asynchronously;
                            // verify the measured host and routing here, not a stale extent.
                            winrt::check_hresult(g_panel.filterScroll.HorizontalScrollMode() ==
                                winrt::Microsoft::UI::Xaml::Controls::ScrollMode::Enabled &&
                                g_panel.filterScroll.Content() == g_panel.filterStrip ? S_OK : E_FAIL);
                        }
                    }
                }
            }
            currentStage = 21;
            auto &card = g_panel.rows[0];
            card.itemType = L"Image";
            UpdateCardContent(card, L"Synthetic image caption");
            card.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
            card.preview.MaxLines(1);
            card.tags.Text(L"Work");
            card.tags.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
            card.dimensions.Text(L"1920 × 1080");
            card.dimensions.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
            // Measure the card independently of ListView's deferred realization.
            card.surface.Measure({static_cast<float>(kCardWidth + 16), static_cast<float>(kCardHeight)});
            card.surface.Arrange({0, 0, static_cast<float>(kCardWidth + 16), static_cast<float>(kCardHeight)});
            const auto dimensionsPosition = card.dimensions.TransformToVisual(card.surface).TransformPoint({0, 0});
            const auto timePosition = card.time.TransformToVisual(card.surface).TransformPoint({0, 0});
            const bool cardFits = card.dimensions.ActualHeight() > 0 &&
                dimensionsPosition.Y + card.dimensions.ActualHeight() <= kCardHeight &&
                timePosition.Y + card.time.ActualHeight() <= kCardHeaderHeight &&
                card.surface.Width() == kCardWidth && card.surface.Height() == kCardHeight;
            if (!cardFits) std::fprintf(stderr,
                "WinUI card layout: surface=%.1fx%.1f dimensions=[%.1f,%.1f] time=[%.1f,%.1f]\n",
                card.surface.ActualWidth(), card.surface.ActualHeight(), dimensionsPosition.Y,
                card.dimensions.ActualHeight(), timePosition.Y, card.time.ActualHeight());
            winrt::check_hresult(cardFits ? S_OK : E_FAIL);
            g_panel.root.ClearValue(winrt::Microsoft::UI::Xaml::FrameworkElement::WidthProperty());
            g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
            WindowProc(g_panel.window, kSetLanguage, originalEnglish, 0);
            WindowProc(g_panel.window, kSetTheme, 0, 0);
            currentStage = 22;
            g_panel.search.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
            const auto savedLayout = g_dockedLayout;
            const auto checkDockedClient = [](const PanelLayout &layout) {
                RECT outer{}, client{};
                POINT origin{};
                winrt::check_bool(GetWindowRect(g_panel.window, &outer));
                winrt::check_bool(GetClientRect(g_panel.window, &client));
                winrt::check_bool(ClientToScreen(g_panel.window, &origin));
                const bool fits = outer.left == layout.x && outer.top == layout.y &&
                    outer.right - outer.left == layout.width && outer.bottom - outer.top == layout.height &&
                    origin.x == layout.x && origin.y == layout.y &&
                    client.right == layout.width && client.bottom == layout.height &&
                    (GetWindowLongPtrW(g_panel.window, GWL_STYLE) & WS_CAPTION) == 0 &&
                    (GetWindowLongPtrW(g_panel.window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0;
                if (!fits) std::fprintf(stderr,
                    "WinUI dock: target=[%d,%d,%d,%d], outer=[%ld,%ld,%ld,%ld], client=[%ld,%ld], origin=[%ld,%ld], style=0x%llX\n",
                    layout.x, layout.y, layout.width, layout.height, outer.left, outer.top, outer.right - outer.left,
                    outer.bottom - outer.top, client.right, client.bottom, origin.x, origin.y,
                    static_cast<unsigned long long>(GetWindowLongPtrW(g_panel.window, GWL_STYLE)));
                winrt::check_hresult(fits ? S_OK : E_FAIL);
            };
            winrt::check_hresult(vpaste_winui_set_layout(nullptr) == E_INVALIDARG ? S_OK : E_FAIL);
            for (const double dpi : {1.0, 1.5, 2.0}) {
                const PanelLayout layout{static_cast<int>(-1920 * dpi), static_cast<int>(778 * dpi),
                    static_cast<int>(1920 * dpi), static_cast<int>(302 * dpi), dpi, 1};
                winrt::check_hresult(vpaste_winui_set_layout(&layout));
                checkDockedClient(layout);
            }
            winrt::check_hresult(vpaste_winui_set_layout(&savedLayout));
            SetQueueViewActive(true);
            winrt::check_hresult(g_panel.queueWindow && g_panel.queueWindow->Handle() != g_panel.window &&
                IsWindowVisible(g_panel.queueWindow->Handle()) &&
                (GetWindowLongPtrW(g_panel.window, GWL_STYLE) & WS_CAPTION) == 0 ? S_OK : E_FAIL);
            RECT queueBounds{}; GetWindowRect(g_panel.queueWindow->Handle(), &queueBounds);
            winrt::check_hresult(SendMessageW(g_panel.queueWindow->Handle(), WM_NCHITTEST, 0,
                MAKELPARAM(queueBounds.left + 1, (queueBounds.top + queueBounds.bottom) / 2)) == HTCLIENT ? S_OK : E_FAIL);
            SetVisible(false);
            winrt::check_hresult(IsWindowVisible(g_panel.queueWindow->Handle()) && !IsWindowVisible(g_panel.window) ? S_OK : E_FAIL);
            ShowQueueWithoutActivation();
            winrt::check_hresult(!IsWindowVisible(g_panel.window) ? S_OK : E_FAIL);
            SetVisible(true, false);
            SetQueueViewActive(false);
            checkDockedClient(savedLayout);
            SetTagManagerActive(true);
            winrt::check_hresult((GetWindowLongPtrW(g_panel.window, GWL_STYLE) & WS_CAPTION) != 0 ? S_OK : E_FAIL);
            SetTagManagerActive(false);
            checkDockedClient(savedLayout);
            currentStage = 23;
            using namespace winrt::Microsoft::UI::Xaml;
            using namespace winrt::Microsoft::UI::Xaml::Controls;
            winrt::check_hresult(queueRoot.RowDefinitions().Size() == 3 &&
                queueRoot.RowDefinitions().GetAt(1).Height().GridUnitType == GridUnitType::Star ? S_OK : E_FAIL);
            auto queueCommands = queueRoot.Children().GetAt(0).as<Grid>().Children().GetAt(2).as<CommandBar>();
            winrt::check_hresult(queueCommands.IsDynamicOverflowEnabled() &&
                queueCommands.SecondaryCommands().Size() == 2 && queueCommands.PrimaryCommands().Size() == 1 ? S_OK : E_FAIL);
            g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(
                LR"({"revision":20,"busy":false,"capacity":100,"items":[{"hash":"layout-row","itemType":"Text","previewContent":"Long queue text should stay inside one surface","appSource":"Test"}],"undoHash":null})"));
            const auto queueCard = rows.Children().GetAt(0).as<Border>();
            const auto queueRow = queueCard.Child().as<Grid>();
            winrt::check_hresult(queueRow.Children().GetAt(0).try_as<Button>() &&
                queueCard.BorderThickness().Left == 1 && queueCard.CornerRadius().TopLeft ==
                    vpaste::winui::ManagementRowRadius &&
                queueCard.CornerRadius().TopRight == vpaste::winui::ManagementRowRadius &&
                queueCard.CornerRadius().BottomRight == vpaste::winui::ManagementRowRadius &&
                queueCard.CornerRadius().BottomLeft == vpaste::winui::ManagementRowRadius &&
                queueCard.Padding().Top == 8 && queueCard.Padding().Right == 8 &&
                queueCard.Padding().Bottom == 8 ? S_OK : E_FAIL);
            const auto rowActions = queueRow.Children().GetAt(1).as<StackPanel>();
            for (std::uint32_t index = 0; index < rowActions.Children().Size(); ++index) {
                const auto action = rowActions.Children().GetAt(index).as<Button>();
                winrt::check_hresult(action.Width() == vpaste::winui::CompactActionSize &&
                    !Automation::AutomationProperties::GetName(action).empty() ? S_OK : E_FAIL);
            }
            winrt::Windows::Data::Json::JsonArray capacityItems;
            for (int index = 0; index < 100; ++index) {
                winrt::Windows::Data::Json::JsonObject item;
                item.Insert(L"hash", winrt::Windows::Data::Json::JsonValue::CreateStringValue(
                    L"queue-capacity-" + std::to_wstring(index)));
                item.Insert(L"previewText", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Synthetic queue item"));
                capacityItems.Append(item);
            }
            auto capacityState = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":21,"busy":false,"capacity":100,"undoHash":null})");
            capacityState.Insert(L"items", capacityItems);
            g_panel.queueView->SetState(capacityState);
            winrt::check_hresult(rows.Children().Size() == 100 &&
                heading.Children().GetAt(1).as<TextBlock>().Text() == L"100 / 100" ? S_OK : E_FAIL);
            currentStage = 24;
            const auto addRow = tagRoot.Children().GetAt(1).as<Grid>();
            const auto addField = addRow.Children().GetAt(1).as<TextBox>();
            for (const bool english : {false, true}) {
                g_panel.queueView->SetLanguage(english);
                g_panel.tagManager->SetLanguage(english);
                for (const float width : {360.0f, 640.0f, 960.0f}) {
                    for (const auto &view : {queueRoot, tagRoot}) {
                        view.Width(width);
                        view.Measure({width, 520});
                        view.Arrange({0, 0, width, 520});
                        view.UpdateLayout();
                    }
                    const auto addPosition = addField.TransformToVisual(addRow).TransformPoint({0, 0});
                    const auto addButton = addRow.Children().GetAt(2).as<Button>();
                    const auto buttonPosition = addButton.TransformToVisual(addRow).TransformPoint({0, 0});
                    winrt::check_hresult(addField.ActualWidth() > 100 &&
                        addPosition.X + addField.ActualWidth() <= buttonPosition.X &&
                        buttonPosition.X + addButton.ActualWidth() <= addRow.ActualWidth() + 1 ? S_OK : E_FAIL);
                }
            }
            queueRoot.Width(vpaste::winui::QueueContentWidth);
            tagRoot.ClearValue(FrameworkElement::WidthProperty());
            g_panel.queueView->SetLanguage(originalEnglish);
            g_panel.tagManager->SetLanguage(originalEnglish);
            const auto dialog = vpaste::winui::MakeConfirmationDialog(g_panel.root,
                L"Confirm", L"Synthetic confirmation", L"Delete", L"Cancel");
            winrt::check_hresult(dialog.XamlRoot() == g_panel.root.XamlRoot() &&
                dialog.RequestedTheme() == g_panel.root.ActualTheme() &&
                dialog.DefaultButton() == ContentDialogButton::Close &&
                dialog.PrimaryButtonText() == L"Delete" && dialog.CloseButtonText() == L"Cancel" ? S_OK : E_FAIL);
            currentStage = 25;
            winrt::check_hresult(ParseColor(L"#abc")->R == 170 && ParseColor(L"#123456")->B == 86 &&
                ParseColor(L"#12345680")->A == 128 && !ParseColor(L"#not-a-color") && !ParseColor(L"") ? S_OK : E_FAIL);
            const std::uint64_t clock = 1800000000000;
            for (const bool english : {false, true}) {
                g_english = english;
                winrt::check_hresult(FormatCardTime(0, clock).empty() &&
                    FormatCardTime(clock, clock) == Text(L"刚刚", L"Just now") &&
                    FormatCardTime(clock - 120000, clock) == winrt::hstring{L"2"} + Text(L"分钟前", L" min ago") &&
                    !FormatCardTime(clock - 10ULL * 86400000, clock).empty() ? S_OK : E_FAIL);
            }
            g_english = originalEnglish;
            currentStage = 26;
            ApplyResponse(R"({"id":900,"op":"query","data":{"items":[
                {"hash":"polish-text","itemType":"Text","previewText":"Readable text content","time":1800000000000},
                {"hash":"polish-image","itemType":"Image","previewText":"A photo","tags":[{"id":1,"name":"Work"}]},
                {"hash":"polish-file","itemType":"File","previewText":"report.pdf\nnotes.txt"},
                {"hash":"polish-link","itemType":"Link","previewText":"Reference\nhttps://example.com"},
                {"hash":"polish-color","itemType":"Color","previewText":"#0B86FF"},
                {"hash":"polish-long","itemType":"TextFile","previewText":"Long source content","appSource":"A very long source application name that must not overlap the timestamp"}
            ],"hasMore":false}})");
            winrt::check_hresult(g_panel.rows.size() == 6 &&
                g_panel.rows[0].mediaFrame.Visibility() == Visibility::Collapsed &&
                g_panel.rows[1].mediaFrame.Visibility() == Visibility::Visible &&
                g_panel.rows[4].colorSwatch.Background().as<Media::SolidColorBrush>().Color().B == 255 &&
                IsCardAction(g_panel.rows[0].favoriteButton) && !IsCardAction(g_panel.rows[0].surface) ? S_OK : E_FAIL);
            const auto cardFlyout = g_panel.rows[0].surface.ContextFlyout().as<MenuFlyout>();
            winrt::check_hresult(cardFlyout.Items().GetAt(0).as<MenuFlyoutItem>().Icon() &&
                cardFlyout.Items().GetAt(0).as<MenuFlyoutItem>().KeyboardAcceleratorTextOverride() == L"Ctrl+C" ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":901,"op":"tags","data":{"items":[{"id":1,"name":"Work"},{"id":2,"name":"Notes"}]}})");
            winrt::check_hresult(DynamicTab(L"record:1") && DynamicTab(L"record:2") ? S_OK : E_FAIL);
            g_panel.customTabs.SelectedItem(DynamicTab(L"record:1"));
            winrt::check_hresult(g_selectedTagName == L"Work" && !g_panel.filter.SelectedItem() &&
                requestAt(previewRequests.size() - 1).GetNamedString(L"tagName") == L"Work" ? S_OK : E_FAIL);
            g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(2));
            winrt::check_hresult(g_selectedTagId == 0 &&
                requestAt(previewRequests.size() - 1).GetNamedString(L"filter") == L"File" ? S_OK : E_FAIL);
            g_panel.tagFilter.SelectedIndex(2);
            winrt::check_hresult(requestAt(previewRequests.size() - 1).GetNamedString(L"filter") == L"File" &&
                requestAt(previewRequests.size() - 1).GetNamedString(L"tagName") == L"Notes" ? S_OK : E_FAIL);
            g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
            g_panel.customTabs.SelectedItem(DynamicTab(L"record:1"));
            ApplyResponse(R"({"id":902,"op":"tags","data":{"items":[{"id":2,"name":"Notes"}]}})");
            winrt::check_hresult(g_selectedTagId == 0 && g_panel.filter.SelectedItem() ==
                g_panel.filter.Items().GetAt(0) ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":903,"op":"tags","data":{"items":[{"id":1,"name":"Work"},{"id":2,"name":"Notes"}]}})");
            ToggleQueueSelectionMode();
            winrt::check_hresult(g_panel.cancelSelection.Visibility() == Visibility::Visible &&
                g_panel.rows[0].actions.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            currentStage = 27;
            g_panel.search.Text(L"no-match");
            if (g_searchTimer) g_searchTimer.Stop();
            ApplyResponse(R"({"id":910,"op":"query","data":{"items":[],"hasMore":false}})");
            winrt::check_hresult(g_panel.emptyState.Visibility() == Visibility::Visible &&
                g_panel.resetFilters.Visibility() == Visibility::Visible &&
                g_panel.loading.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":920,"op":"query","error":"Synthetic recoverable query error"})");
            winrt::check_hresult(g_panel.retry.Visibility() == Visibility::Visible &&
                g_panel.resetFilters.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
            RequestHistory();
            winrt::check_hresult(g_panel.loading.Visibility() == Visibility::Visible &&
                g_panel.emptyState.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
            g_panel.search.Text(L"");
            if (g_searchTimer) g_searchTimer.Stop();
            ApplyResponse(R"({"id":930,"op":"query","data":{"items":[],"hasMore":false}})");
            winrt::check_hresult(g_panel.emptyState.Children().GetAt(1).as<TextBlock>().Text() ==
                Text(L"剪贴板还是空的", L"Your clipboard shelf is empty") ? S_OK : E_FAIL);
            currentStage = 28;
            ApplyResponse(R"({"id":940,"op":"copy","error":"Synthetic copy failure"})");
            winrt::check_hresult(g_panel.feedback.IsOpen() &&
                g_panel.feedback.Severity() == InfoBarSeverity::Error && g_panel.feedback.IsClosable() ? S_OK : E_FAIL);
            ShowFeedback(Text(L"已复制", L"Copied"));
            winrt::check_hresult(g_panel.feedback.IsOpen() &&
                g_panel.feedback.Severity() == InfoBarSeverity::Success && g_feedbackTimer.IsRunning() ? S_OK : E_FAIL);
            DismissFeedback();
            winrt::check_hresult(!g_panel.feedback.IsOpen() && !g_feedbackTimer.IsRunning() ? S_OK : E_FAIL);
            g_panel.tagManager->SetTags(winrt::Windows::Data::Json::JsonArray::Parse(L"[]"));
            winrt::check_hresult(tagRoot.Children().GetAt(5).as<StackPanel>().Visibility() == Visibility::Visible &&
                tagRoot.Children().GetAt(0).as<Grid>().Children().GetAt(2).as<TextBlock>().Text() ==
                    (originalEnglish ? L"0 tags" : L"0 个标签") ? S_OK : E_FAIL);
            currentStage = 29;
            for (const bool queue : {false, true, false}) {
                if (queue) SetQueueViewActive(true);
                else SetTagManagerActive(true);
                co_await NextNativeFrame();
                auto view = queue ? g_panel.queueView->Root() : g_panel.xamlSource.Content().as<FrameworkElement>();
                view.UpdateLayout();
                RECT client{};
                const auto handle = queue ? g_panel.queueWindow->Handle() : g_panel.window;
                winrt::check_bool(GetClientRect(handle, &client));
                const auto dpiScale = GetDpiForWindow(handle) / 96.0;
                const bool fills = std::abs(view.ActualWidth() - client.right / dpiScale) < 1 &&
                    std::abs(view.ActualHeight() - client.bottom / dpiScale) < 1 &&
                    std::abs(view.ActualWidth() - vpaste::winui::QueueContentWidth) < 1 &&
                    std::abs(view.ActualHeight() - (queue ? vpaste::winui::QueueContentHeight
                        : vpaste::winui::TagContentHeight)) < 1;
                if (!fills) std::fprintf(stderr,
                    "WinUI management content bounds: queue=%d view=%.1fx%.1f client=%ldx%ld dpi=%.1f\n",
                    queue, view.ActualWidth(), view.ActualHeight(), client.right, client.bottom, dpiScale);
                winrt::check_hresult(fills ? S_OK : E_FAIL);
                MINMAXINFO limits{};
                SendMessageW(handle, WM_GETMINMAXINFO, 0, reinterpret_cast<LPARAM>(&limits));
                const auto frameWidth = (GetSystemMetricsForDpi(SM_CXSIZEFRAME, GetDpiForWindow(g_panel.window)) +
                    GetSystemMetricsForDpi(SM_CXPADDEDBORDER, GetDpiForWindow(g_panel.window))) * 2;
                winrt::check_hresult(limits.ptMinTrackSize.x >= 360 * dpiScale &&
                    limits.ptMinTrackSize.x <= 360 * dpiScale + frameWidth &&
                    limits.ptMinTrackSize.y >= 320 * dpiScale ? S_OK : E_FAIL);
                if (queue) SetQueueViewActive(false);
                else SetTagManagerActive(false);
            }
            currentStage = 31;
            const auto assetUri = vpaste::winui::LocalAssetUri(L"C:\\素材\\image #1 100%.png");
            const auto escapedUri = std::wstring{assetUri.RawUri()};
            // AbsoluteUri canonically displays a literal '#' in a file path;
            // the original escaped path must survive without becoming a fragment.
            winrt::check_hresult(escapedUri.find(L"%23") != std::wstring::npos &&
                escapedUri.find(L"%25") != std::wstring::npos && assetUri.Fragment().empty() ? S_OK : E_FAIL);
            bool remoteRejected = false;
            try { (void)vpaste::winui::LocalAssetUri(L"https://example.com/image.png"); }
            catch (const winrt::hresult_invalid_argument &) { remoteRejected = true; }
            winrt::check_hresult(remoteRejected ? S_OK : E_FAIL);
            currentStage = 32;
            ApplyResponse(R"({"id":950,"op":"query","data":{"items":[{"hash":"rich-test","itemType":"Text"},{"hash":"link-test","itemType":"Link"},{"hash":"files-test","itemType":"File"}]}})");
            ApplyResponse(R"({"id":951,"op":"card","data":{"hash":"rich-test","displayText":"plain fallback","rich":{"darkCanvas":true,"blocks":[{"runs":[{"text":"A😀"},{"text":"强调","bold":true,"italic":true,"underline":true,"foreground":{"r":255,"g":255,"b":255},"backgroundColor":{"r":50,"g":100,"b":150}},{"text":"code","mono":true},{"image":"C:\\cache\\missing #1.png"}],"rows":[]},{"runs":[],"rows":[[[{"text":"列一"}],[{"text":"列二"}]],[[{"text":"值一"}],[{"text":"值二"}]]]}]}}})");
            const auto &richCard = g_panel.rows[0];
            const auto richViewport = richCard.richFrame.Child().as<ScrollViewer>();
            const auto richStack = richViewport.Content().as<StackPanel>();
            const auto richText = richStack.Children().GetAt(0).as<RichTextBlock>();
            const auto paragraph = richText.Blocks().GetAt(0).as<Documents::Paragraph>();
            const auto styledRun = paragraph.Inlines().GetAt(1).as<Documents::Run>();
            const auto highlightRange = richText.TextHighlighters().GetAt(0).Ranges().GetAt(0);
            std::fprintf(stderr, "WinUI rich content: visible=%d preview=%d badge=%d selectable=%d weight=%u style=%d underline=%u range=%d,%d inlines=%u\n",
                static_cast<int>(richCard.richFrame.Visibility()), static_cast<int>(richCard.preview.Visibility()),
                static_cast<int>(richCard.richBadge.Visibility()), richText.IsTextSelectionEnabled(), styledRun.FontWeight().Weight,
                static_cast<int>(styledRun.FontStyle()), static_cast<unsigned>(styledRun.TextDecorations()),
                highlightRange.StartIndex, highlightRange.Length, paragraph.Inlines().Size());
            winrt::check_hresult(richCard.richFrame.Visibility() == Visibility::Visible &&
                richCard.preview.Visibility() == Visibility::Collapsed &&
                richCard.richBadge.Visibility() == Visibility::Visible && !richText.IsTextSelectionEnabled() &&
                styledRun.FontWeight().Weight == 700 &&
                styledRun.FontStyle() == winrt::Windows::UI::Text::FontStyle::Italic &&
                styledRun.TextDecorations() == winrt::Windows::UI::Text::TextDecorations::Underline &&
                highlightRange.StartIndex == 3 && highlightRange.Length == 2 &&
                paragraph.Inlines().GetAt(2).as<Documents::Run>().FontFamily().Source() == L"Consolas" &&
                paragraph.Inlines().GetAt(3).try_as<Documents::InlineUIContainer>() ? S_OK : E_FAIL);
            const auto table = richStack.Children().GetAt(1).as<ScrollViewer>().Content().as<Grid>();
            winrt::check_hresult(table.ColumnDefinitions().Size() == 2 && table.RowDefinitions().Size() == 2 &&
                table.Children().Size() == 4 && richViewport.Background().as<Media::SolidColorBrush>().Color().R == 36
                ? S_OK : E_FAIL);
            currentStage = 33;
            ApplyResponse(R"({"id":952,"op":"card","data":{"hash":"link-test","displayTitle":"Reference","displaySubtitle":"https://example.com/path"}})");
            ApplyResponse(R"({"id":953,"op":"card","data":{"hash":"files-test","fileCount":3,"displaySubtitle":"notes.md\nreport.pdf\nphoto.png"}})");
            winrt::check_hresult(g_panel.rows[1].preview.Text() == L"Reference" &&
                g_panel.rows[1].subtitle.Text() == L"https://example.com/path" &&
                g_panel.rows[2].preview.Text() == winrt::hstring{L"3"} + Text(L" 个文件", L" files") &&
                g_panel.rows[2].subtitle.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
            // Invoke the same native controls exposed to users. No real clipboard
            // action runs: the request callback here records synthetic messages.
            currentStage = 34;
            SetQueueViewActive(true);
            g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":50,"busy":false,"capacity":100,"undoHash":null,"items":[{"hash":"q-a","previewText":"First"},{"hash":"q-b","previewText":"Second"}]})"));
            auto invoke = [](const Button &button) {
                Automation::Peers::ButtonAutomationPeer peer{button};
                peer.GetPattern(Automation::Peers::PatternInterface::Invoke)
                    .as<Automation::Provider::IInvokeProvider>().Invoke();
            };
            const auto queueActions = rows.Children().GetAt(0).as<Border>().Child().as<Grid>()
                .Children().GetAt(1).as<StackPanel>();
            winrt::check_hresult(queueActions.Children().Size() == 2 ? S_OK : E_FAIL);
            const auto moveMenu = queueActions.Children().GetAt(0).as<Button>().Flyout().as<MenuFlyout>();
            winrt::check_hresult(moveMenu.Items().Size() == 2 &&
                !moveMenu.Items().GetAt(0).as<MenuFlyoutItem>().IsEnabled() &&
                moveMenu.Items().GetAt(1).as<MenuFlyoutItem>().IsEnabled() ? S_OK : E_FAIL);
            currentStage = 341;
            const auto beforeQueuePaste = previewRequests.size();
            invoke(rows.Children().GetAt(0).as<Border>().Child().as<Grid>().Children().GetAt(0).as<Button>());
            co_await NextNativeFrame();
            const auto queuePasteRequest = requestAfter(L"queuePaste", beforeQueuePaste);
            winrt::check_hresult(queuePasteRequest.GetNamedString(L"hash") == L"q-a" ? S_OK : E_FAIL);
            currentStage = 342;
            auto labelState = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":51,"busy":false,"capacity":100,"undoHash":null,"items":[{"hash":"q-a","itemType":"File"},{"hash":"q-b","itemType":"Link","content":"https://example.com|||C:\\cover.png|||A page title"}]})");
            const auto labelPaths = winrt::Windows::Data::Json::JsonArray::Parse(LR"(["C:\\notes.md","C:\\report.pdf"])");
            labelState.GetNamedArray(L"items").GetObjectAt(0).Insert(L"content", winrt::Windows::Data::Json::JsonValue::CreateStringValue(labelPaths.Stringify()));
            auto pasteReply = queuePasteRequest;
            pasteReply.Insert(L"data", labelState); g_panel.queueView->Receive(pasteReply);
            const auto detailsAt = [&](std::uint32_t index) {
                return rows.Children().GetAt(index).as<Border>().Child().as<Grid>()
                    .Children().GetAt(0).as<Button>().Content().as<StackPanel>().Children().GetAt(0).as<TextBlock>().Text();
            };
            winrt::check_hresult(detailsAt(0) == L"notes.md +1" && detailsAt(1) == L"https://example.com" ? S_OK : E_FAIL);
            currentStage = 343;
            const auto newActions = rows.Children().GetAt(0).as<Border>().Child().as<Grid>()
                .Children().GetAt(1).as<StackPanel>();
            const auto newMenu = newActions.Children().GetAt(0).as<Button>().Flyout().as<MenuFlyout>();
            Automation::Peers::MenuFlyoutItemAutomationPeer movePeer{newMenu.Items().GetAt(1).as<MenuFlyoutItem>()};
            const auto beforeQueueMove = previewRequests.size();
            movePeer.GetPattern(Automation::Peers::PatternInterface::Invoke)
                .as<Automation::Provider::IInvokeProvider>().Invoke();
            co_await NextNativeFrame();
            auto reorderReply = requestAfter(L"queueReorder", beforeQueueMove);
            winrt::check_hresult(reorderReply.GetNamedArray(L"hashes").GetStringAt(0) == L"q-b" ? S_OK : E_FAIL);
            labelState.Insert(L"revision", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(52));
            reorderReply.Insert(L"data", labelState); g_panel.queueView->Receive(reorderReply);
            SetQueueViewActive(false);
            currentStage = 35;
            vpaste::winui::DragRequestState lease;
            lease.id = 123;
            winrt::check_hresult(!lease.Accepts(122) && lease.Accepts(123) && lease.End() &&
                !lease.End() && !lease.Accepts(123) ? S_OK : E_FAIL);
            const std::vector<std::wstring> order{L"a", L"b", L"c", L"d"};
            winrt::check_hresult(vpaste::winui::QueueDropOrder(order, L"a", L"d", true) ==
                std::vector<std::wstring>{L"b", L"c", L"d", L"a"} &&
                vpaste::winui::QueueDropOrder(order, L"d", L"b", false) ==
                std::vector<std::wstring>{L"a", L"d", L"b", L"c"} &&
                vpaste::winui::QueueDropOrder(order, L"a", L"b", false) == order &&
                vpaste::winui::QueueDropOrder(order, L"b", L"a", true) == order &&
                vpaste::winui::QueueDropOrder(order, L"deleted", L"a", false) == order ? S_OK : E_FAIL);
            winrt::check_hresult(g_panel.rows[0].surface.CanDrag() ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            winrt::check_hresult(!g_panel.rows[0].surface.CanDrag() ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            currentStage = 36;
            using namespace winrt::Windows::ApplicationModel::DataTransfer;
            DataPackage richPackage;
            co_await vpaste::winui::PopulateDragPackage(richPackage, winrt::Windows::Data::Json::JsonObject::Parse(
                LR"({"text":"Native 原文😀","html":"<b>Native 原文😀</b>","url":"","files":[]})"));
            winrt::check_hresult((co_await richPackage.GetView().GetTextAsync()) == L"Native 原文😀" &&
                std::wstring{co_await richPackage.GetView().GetHtmlFormatAsync()}.find(L"<b>") != std::wstring::npos &&
                richPackage.RequestedOperation() == DataPackageOperation::Copy ? S_OK : E_FAIL);
            DataPackage linkPackage;
            co_await vpaste::winui::PopulateDragPackage(linkPackage, winrt::Windows::Data::Json::JsonObject::Parse(
                LR"({"text":"https://example.com/path","url":"https://example.com/path","files":[]})"));
            winrt::check_hresult((co_await linkPackage.GetView().GetWebLinkAsync()).Host() == L"example.com" &&
                !linkPackage.GetView().Contains(StandardDataFormats::StorageItems()) &&
                !linkPackage.GetView().Contains(StandardDataFormats::Bitmap()) ? S_OK : E_FAIL);
            currentStage = 37;
            struct DragFixtures {
                std::wstring first, second;
                ~DragFixtures() { if (!first.empty()) DeleteFileW(first.c_str()); if (!second.empty()) DeleteFileW(second.c_str()); }
            } dragFiles;
            wchar_t temporaryPath[MAX_PATH]{};
            winrt::check_bool(GetTempPathW(MAX_PATH, temporaryPath) > 0);
            GUID fixtureId{};
            winrt::check_hresult(CoCreateGuid(&fixtureId));
            const auto fixtureBase = std::wstring{temporaryPath} + L"vpaste-winui-drag-" +
                std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(fixtureId.Data1);
            dragFiles.first = fixtureBase + L"-文件 #100%.txt";
            dragFiles.second = fixtureBase + L"-second.txt";
            for (const auto &path : {dragFiles.first, dragFiles.second}) {
                winrt::handle file{CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY, nullptr)};
                winrt::check_bool(static_cast<bool>(file));
            }
            winrt::Windows::Data::Json::JsonArray dragPaths;
            for (const auto &path : {dragFiles.first, dragFiles.second}) {
                winrt::Windows::Data::Json::JsonObject file;
                file.Insert(L"path", winrt::Windows::Data::Json::JsonValue::CreateStringValue(path));
                dragPaths.Append(file);
            }
            winrt::Windows::Data::Json::JsonObject filePayload;
            filePayload.Insert(L"files", dragPaths);
            DataPackage filePackage;
            co_await vpaste::winui::PopulateDragPackage(filePackage, filePayload);
            const auto storage = co_await filePackage.GetView().GetStorageItemsAsync();
            winrt::check_hresult(storage.Size() == 2 && storage.GetAt(0).Name() ==
                winrt::hstring{dragFiles.first.substr(dragFiles.first.find_last_of(L'\\') + 1)} &&
                !filePackage.GetView().Contains(StandardDataFormats::Text()) ? S_OK : E_FAIL);
            dragPaths.GetObjectAt(1).SetNamedValue(L"path", winrt::Windows::Data::Json::JsonValue::CreateStringValue(fixtureBase + L"-missing"));
            DataPackage missingPackage;
            bool missingRejected = false;
            try { co_await vpaste::winui::PopulateDragPackage(missingPackage, filePayload); }
            catch (const winrt::hresult_error &) { missingRejected = true; }
            winrt::check_hresult(missingRejected && !missingPackage.GetView().Contains(StandardDataFormats::StorageItems()) ? S_OK : E_FAIL);
            currentStage = 38;
            SetQueueViewActive(true);
            g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":60,"busy":false,"items":[{"hash":"a"},{"hash":"b"},{"hash":"c"}]})"));
            winrt::check_hresult(g_panel.queueView->TestBeginReorder(L"a") ? S_OK : E_FAIL);
            g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":61,"busy":false,"items":[{"hash":"a"},{"hash":"b"},{"hash":"c"},{"hash":"new"}]})"));
            winrt::check_hresult(rows.Children().Size() == 3 ? S_OK : E_FAIL);
            g_panel.queueView->TestDropReorder(L"c", true);
            const auto reordered = requestAt(previewRequests.size() - 1);
            winrt::check_hresult(reordered.GetNamedString(L"op") == L"queueReorder" &&
                reordered.GetNamedArray(L"hashes").Size() == 4 &&
                reordered.GetNamedArray(L"hashes").GetStringAt(2) == L"a" &&
                reordered.GetNamedArray(L"hashes").GetStringAt(3) == L"new" ? S_OK : E_FAIL);
            auto dragReply = reordered;
            dragReply.Insert(L"data", winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":62,"busy":false,"items":[{"hash":"b"},{"hash":"c"},{"hash":"a"},{"hash":"new"}]})"));
            winrt::check_hresult(g_panel.queueView->Receive(dragReply) ? S_OK : E_FAIL);
            winrt::check_hresult(g_panel.queueView->TestBeginReorder(L"a") ? S_OK : E_FAIL);
            g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":63,"busy":false,"items":[{"hash":"b"},{"hash":"c"},{"hash":"new"}]})"));
            g_panel.queueView->TestDropReorder(L"b", false);
            winrt::check_hresult(rows.Children().Size() == 3 &&
                requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"dragEnd" ? S_OK : E_FAIL);
            winrt::check_hresult(g_panel.queueView->TestBeginReorder(L"b") ? S_OK : E_FAIL);
            g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":64,"busy":false,"items":[{"hash":"b"},{"hash":"c"},{"hash":"new"},{"hash":"newer"}]})"));
            g_panel.queueView->CancelDrag();
            winrt::check_hresult(rows.Children().Size() == 4 &&
                requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"dragEnd" ? S_OK : E_FAIL);
            currentStage = 39;
            capacityState.SetNamedValue(L"revision", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(70));
            g_panel.queueView->SetState(capacityState);
            co_await NextNativeFrame();
            winrt::check_hresult(list.ScrollableHeight() > 0 &&
                g_panel.queueView->TestBeginReorder(L"queue-capacity-0") ? S_OK : E_FAIL);
            winrt::handle scrolledEvent{CreateEventW(nullptr, true, false, nullptr)};
            winrt::check_bool(static_cast<bool>(scrolledEvent));
            const auto scrollApartment = winrt::apartment_context{};
            auto scrollChanged = list.ViewChanged(winrt::auto_revoke,
                [event = scrolledEvent.get(), scroll = list](auto const &, auto const &args) {
                    if (!args.IsIntermediate() && scroll.VerticalOffset() > 0) SetEvent(event);
                });
            g_panel.queueView->TestDragScroll(1);
            const bool scrolled = co_await winrt::resume_on_signal(scrolledEvent.get(), std::chrono::seconds(2));
            co_await scrollApartment;
            scrollChanged.revoke();
            winrt::check_hresult(scrolled && list.VerticalOffset() > 0 ? S_OK : E_FAIL);
            g_panel.queueView->CancelDrag();
            const auto stoppedOffset = list.VerticalOffset();
            for (int frame = 0; frame < 6; ++frame) co_await NextNativeFrame();
            winrt::check_hresult(list.VerticalOffset() == stoppedOffset && rows.Children().Size() == 100 ? S_OK : E_FAIL);
            SetQueueViewActive(false);
            currentStage = 41;
            {
                using namespace winrt::Windows::Data::Json;
                const auto filterTabs = JsonArray::Parse(LR"([{"id":"design","name":"设计素材","filter":{"itemType":"Image"}},{"id":"code","name":"Code","filter":{}}])");
                ApplyFilters(filterTabs);
                winrt::check_hresult(g_customFilters.size() == 2 && DynamicTab(L"design") && DynamicTab(L"code") ? S_OK : E_FAIL);
                g_panel.customTabs.SelectedItem(DynamicTab(L"design"));
                winrt::check_hresult(g_selectedFilterId == L"design" &&
                    requestAt(previewRequests.size() - 1).GetNamedString(L"filter") == L"custom:design" ? S_OK : E_FAIL);
                (void)SendRequest(L"queryMore");
                winrt::check_hresult(requestAt(previewRequests.size() - 1).GetNamedString(L"filter") == L"custom:design" ? S_OK : E_FAIL);
                g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(g_panel.filter.Items().Size() - 1));
                NavigatePreview(1, true);
                winrt::check_hresult(g_selectedFilterId == L"design" ? S_OK : E_FAIL);
                NavigatePreview(-1, true);
                winrt::check_hresult(g_selectedFilterId.empty() && FilterIndex() == 1 ? S_OK : E_FAIL);
                g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
                winrt::check_hresult(g_selectedFilterId.empty() && !g_panel.customTabs.SelectedItem() ? S_OK : E_FAIL);
                ApplyFilters(JsonArray{});
                currentStage = 42;
                std::vector<JsonObject> editorRequests;
                int savedCount = 0;
                vpaste::winui::FilterEditor editor{
                    [&](const std::wstring &op, JsonObject payload) {
                        payload.Insert(L"op", JsonValue::CreateStringValue(op));
                        payload.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(editorRequests.size() + 1)));
                        editorRequests.push_back(payload);
                        return static_cast<std::uint64_t>(editorRequests.size());
                    },
                    [&](const JsonArray &items) { winrt::check_hresult(items.Size() == 1 ? S_OK : E_FAIL); ++savedCount; }};
                const auto draft = JsonObject::Parse(LR"({"id":"design","name":"设计素材","filter":{"itemType":"Image","appSources":["Saved but absent"],"favorite":"yes"}})");
                auto editorRoot = editor.TestLoad(draft, false);
                editor.Receive(JsonObject::Parse(LR"({"id":1,"op":"filterSources","data":{"sources":[{"source":"Code","icon_path":""}]}})"));
                editor.TestName(L"Keep this draft"); editor.TestSave(); editor.TestSave();
                winrt::check_hresult(editorRequests.size() == 2 && editorRequests.back().GetNamedString(L"op") == L"filtersSave" &&
                    editorRequests.back().GetNamedObject(L"tab").GetNamedObject(L"filter").GetNamedArray(L"appSources").GetStringAt(0) == L"Saved but absent" ? S_OK : E_FAIL);
                editor.Receive(JsonObject::Parse(LR"({"id":999,"op":"filtersSave","data":{"items":[]}})"));
                winrt::check_hresult(savedCount == 0 ? S_OK : E_FAIL);
                editor.Receive(JsonObject::Parse(LR"({"id":2,"op":"filtersSave","error":"Synthetic storage failure"})"));
                winrt::check_hresult(editor.TestName() == L"Keep this draft" && savedCount == 0 ? S_OK : E_FAIL);
                editor.TestSave();
                editor.Receive(JsonObject::Parse(LR"({"id":3,"op":"filtersSave","data":{"items":[{"id":"design","name":"Saved"}]}})"));
                winrt::check_hresult(savedCount == 1 ? S_OK : E_FAIL);
                currentStage = 43;
                editor.TestLoad(draft, true);
                const auto beforeConfirm = editorRequests.size();
                editor.TestDelete(true);
                winrt::check_hresult(editorRequests.size() == beforeConfirm ? S_OK : E_FAIL);
                editor.TestDelete(false); editor.TestDelete(true); editor.TestDelete(true);
                winrt::check_hresult(editorRequests.size() == beforeConfirm + 1 &&
                    editorRequests.back().GetNamedString(L"op") == L"filtersDelete" &&
                    editorRequests.back().GetNamedString(L"tabId") == L"design" ? S_OK : E_FAIL);
            }
            currentStage = 44;
            {
                using namespace vpaste::winui;
                winrt::check_hresult(NameEmojiOptions().size() == 112 &&
                    SelectedNameEmoji(L"1️⃣   Work") == L"1️⃣" &&
                    ApplyNameEmoji(L"🖼️   Work", L"📌") == L"📌 Work" &&
                    ApplyNameEmoji(L"1️⃣ Work", L"") == L"Work" &&
                    ApplyNameEmoji(L"🖼️\u3000\uFEFF Work", L"") == L"Work" &&
                    ApplyNameEmoji(L"👩‍💻 Notes", L"📌") == L"📌 👩‍💻 Notes" ? S_OK : E_FAIL);
                SetTagManagerActive(true);
                TextBox input; input.MaxLength(20); input.Text(L"1️⃣ Work");
                auto trigger = NameEmojiButton(input, false);
                auto popup = trigger.Flyout().as<Flyout>();
                auto content = popup.Content().as<Grid>();
                auto options = content.Children().GetAt(1).as<GridView>();
                auto none = content.Children().GetAt(0).as<Button>();
                SetNameEmojiLanguage(trigger, true);
                winrt::check_hresult(winrt::unbox_value<winrt::hstring>(none.Content()) == L"No emoji" ? S_OK : E_FAIL);
                SetNameEmojiLanguage(trigger, false);
                // Exercise actual item/clear activation inside our synthetic
                // island, without opening a popup or controlling the desktop.
                popup.Content(nullptr);
                StackPanel fixture; fixture.Spacing(8);
                fixture.Children().Append(input); fixture.Children().Append(trigger); fixture.Children().Append(content);
                g_panel.xamlSource.Content(fixture); ResizeIsland();
                co_await NextNativeFrame();
                winrt::check_hresult(input.IsLoaded() && options.Items().Size() == 112 &&
                    popup.Placement() == Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft &&
                    !popup.ShouldConstrainToRootBounds() ? S_OK : E_FAIL);
                const auto requestCount = previewRequests.size();
                const auto option = options.ContainerFromIndex(3).as<FrameworkElement>();
                const auto invokeOption = Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(option)
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>();
                invokeOption.Invoke(); co_await NextNativeFrame();
                winrt::check_hresult(input.Text() == L"📌 Work" && previewRequests.size() == requestCount ? S_OK : E_FAIL);
                const auto invokeNone = Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(none)
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>();
                invokeNone.Invoke(); co_await NextNativeFrame();
                winrt::check_hresult(input.Text() == L"Work" && previewRequests.size() == requestCount ? S_OK : E_FAIL);
                currentStage = 45;
                const std::wstring fullName(20, L'x'); input.Text(fullName);
                invokeOption.Invoke(); co_await NextNativeFrame();
                winrt::check_hresult(input.Text() == fullName &&
                    content.Children().GetAt(2).as<TextBlock>().Visibility() == Visibility::Visible ? S_OK : E_FAIL);
                input.IsEnabled(false);
                winrt::check_hresult(!trigger.IsEnabled() && !TryApplyNameEmoji(input, L"📌") && input.Text() == fullName ? S_OK : E_FAIL);
                input.IsEnabled(true); input.Text(L"Keep me");
                fixture.Children().RemoveAt(0);
                co_await NextNativeFrame();
                invokeOption.Invoke(); co_await NextNativeFrame();
                winrt::check_hresult(!input.IsLoaded() && input.Text() == L"Keep me" ? S_OK : E_FAIL);
                options.ScrollIntoView(options.Items().GetAt(111));
                co_await NextNativeFrame();
                const auto lastEmoji = options.ContainerFromIndex(111).try_as<FrameworkElement>();
                winrt::check_hresult(lastEmoji && lastEmoji.IsLoaded() && lastEmoji.ActualHeight() > 0 ? S_OK : E_FAIL);
                SetTagManagerActive(false);
            }
            currentStage = 46;
            {
                using namespace vpaste::winui;
                using namespace winrt::Windows::Data::Json;
                const auto invoke = [](MenuFlyoutItem const &item) {
                    Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(item)
                        .GetPattern(Automation::Peers::PatternInterface::Invoke)
                        .as<Automation::Provider::IInvokeProvider>().Invoke();
                };
                const auto find = [](MenuFlyout const &menu, const wchar_t *label) {
                    for (auto const &entry : menu.Items()) {
                        if (const auto item = entry.try_as<MenuFlyoutItem>(); item && item.Text() == label) return item;
                    }
                    return MenuFlyoutItem{nullptr};
                };
                for (auto const *type : {L"Text", L"TextFile", L"Link"}) {
                    MenuFlyout menu;
                    AppendCardActions(menu, L"plain-fixture", type, true, true, SendCardAction);
                    winrt::check_hresult(find(menu, L"Copy as plain text") && find(menu, L"Paste as plain text") &&
                        find(menu, L"Remove all assigned tags") && !find(menu, L"Export image…") ? S_OK : E_FAIL);
                    menu.ShowAt(g_panel.searchButton); co_await NextNativeFrame();
                    invoke(find(menu, L"Copy as plain text")); co_await NextNativeFrame();
                    winrt::check_hresult(requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"copyPlain" &&
                        requestAt(previewRequests.size() - 1).GetNamedString(L"hash") == L"plain-fixture" ? S_OK : E_FAIL);
                    menu.Hide();
                }
                MenuFlyout files;
                const auto fileMenu = AppendCardActions(files, L"file-fixture", L"File", false, true, SendCardAction);
                winrt::check_hresult(find(files, L"Open containing folder") && find(files, L"Copy containing folder") &&
                    !find(files, L"Paste as plain text") && fileMenu.exportImage.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                UpdateCardActions(fileMenu, JsonObject::Parse(LR"({"canExportImage":true})"), L"file-fixture", SendCardAction);
                winrt::check_hresult(fileMenu.exportImage.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
                MenuFlyout image;
                AppendCardActions(image, L"image-fixture", L"Image", false, true, SendCardAction);
                winrt::check_hresult(find(image, L"Image text") && find(image, L"Export image…") &&
                    !find(image, L"Open containing folder") ? S_OK : E_FAIL);
                MenuFlyout colors;
                const auto colorMenu = AppendCardActions(colors, L"color-fixture", L"Color", false, true, SendCardAction);
                UpdateCardActions(colorMenu, JsonObject::Parse(LR"JSON({"colorFormats":[{"format":"HEX","value":"#0B86FF"},{"format":"RGB","value":"rgb(11, 134, 255)"},{"format":"HSL","value":"hsl(210, 100%, 52%)"}]})JSON"), L"color-fixture", SendCardAction);
                winrt::check_hresult(colorMenu.colors.Items().Size() == 3 && colorMenu.colors.IsEnabled() ? S_OK : E_FAIL);
                colors.ShowAt(g_panel.searchButton); co_await NextNativeFrame();
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(colorMenu.colors)
                    .GetPattern(Automation::Peers::PatternInterface::ExpandCollapse)
                    .as<Automation::Provider::IExpandCollapseProvider>().Expand();
                co_await NextNativeFrame();
                invoke(colorMenu.colors.Items().GetAt(1).as<MenuFlyoutItem>()); co_await NextNativeFrame();
                const auto colorRequest = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(colorRequest.GetNamedString(L"op") == L"copyColor" &&
                    colorRequest.GetNamedString(L"argument") == L"RGB" && colorRequest.GetNamedString(L"hash") == L"color-fixture" ? S_OK : E_FAIL);
                colors.Hide();
            }
            currentStage = 47;
            {
                using namespace vpaste::winui;
                using namespace winrt::Windows::Data::Json;
                struct ExportRequest { std::uint64_t id; std::wstring op, hash, argument; };
                std::vector<ExportRequest> sent;
                unsigned chooserCalls = 0, errors = 0;
                std::uint64_t next = 0;
                ImageExport exporter{g_panel.window, [&](auto const &op, auto const &hash, auto const &argument) {
                    sent.push_back({++next, op, hash, argument}); return next;
                }, [&](auto const &, bool error) { if (error) ++errors; }};
                const auto prepared = [&](std::uint64_t id) {
                    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
                    response.Insert(L"op", JsonValue::CreateStringValue(L"exportPrepare"));
                    response.Insert(L"data", JsonObject::Parse(LR"({"fileName":"vpaste-image-test.png"})")); return response;
                };
                exporter.SetTestChooser([&](auto const &) -> std::optional<std::wstring> { ++chooserCalls; return std::nullopt; });
                exporter.Start(L"image-a"); const auto first = sent.back().id;
                exporter.Start(L"image-b"); winrt::check_hresult(sent.size() == 1 ? S_OK : E_FAIL);
                exporter.Receive(prepared(first + 1)); winrt::check_hresult(chooserCalls == 0 ? S_OK : E_FAIL);
                exporter.Receive(prepared(first));
                winrt::check_hresult(!exporter.Active() && chooserCalls == 1 && sent.size() == 3 &&
                    sent[1].op == L"modalBegin" && sent[2].op == L"modalEnd" ? S_OK : E_FAIL);
                exporter.SetTestChooser([&](auto const &) -> std::optional<std::wstring> { ++chooserCalls; return L"C:\\export\\图 #1.webp"; });
                exporter.Start(L"image-a"); exporter.Receive(prepared(sent.back().id));
                winrt::check_hresult(exporter.Active() && sent.back().op == L"exportImage" &&
                    sent.back().hash == L"image-a" && sent.back().argument == L"C:\\export\\图 #1.webp" ? S_OK : E_FAIL);
                JsonObject failure; failure.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(sent.back().id)));
                failure.Insert(L"op", JsonValue::CreateStringValue(L"exportImage")); failure.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic failure"));
                exporter.Receive(failure); winrt::check_hresult(!exporter.Active() && errors == 1 ? S_OK : E_FAIL);
                exporter.SetTestChooser([&](auto const &) -> std::optional<std::wstring> { exporter.Cancel(); return L"C:\\must-not-write.png"; });
                exporter.Start(L"image-a"); exporter.Receive(prepared(sent.back().id));
                winrt::check_hresult(!exporter.Active() && sent.back().op == L"modalEnd" ? S_OK : E_FAIL);
                exporter.Start(L"image-a"); const auto cancelled = sent.back().id; exporter.Cancel();
                const auto count = sent.size(); exporter.Receive(prepared(cancelled));
                winrt::check_hresult(sent.size() == count ? S_OK : E_FAIL);
            }
            currentStage = 48;
            {
                using namespace winrt::Windows::Data::Json;
                const auto pasteCount = [&] {
                    return std::count_if(previewRequests.begin(), previewRequests.end(), [](auto const &bytes) {
                        return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"paste";
                    });
                };
                const auto queryResult = [&](std::uint64_t id, const wchar_t *hash) {
                    JsonObject item; item.Insert(L"hash", JsonValue::CreateStringValue(hash));
                    item.Insert(L"itemType", JsonValue::CreateStringValue(L"Text"));
                    JsonArray items; items.Append(item);
                    JsonObject data; data.Insert(L"items", items); data.Insert(L"hasMore", JsonValue::CreateBooleanValue(false));
                    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
                    response.Insert(L"op", JsonValue::CreateStringValue(L"query")); response.Insert(L"data", data);
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                const auto before = pasteCount();
                currentStage = 481;
                g_panel.search.Text(L"first search"); SubmitSearch();
                const auto firstId = g_latestQueryId;
                winrt::check_hresult(g_searchSubmitRequestId == firstId && pasteCount() == before ? S_OK : E_FAIL);
                g_panel.search.Text(L"new search");
                currentStage = 482;
                queryResult(firstId, L"old-result");
                winrt::check_hresult(pasteCount() == before && g_searchSubmitRequestId == 0 ? S_OK : E_FAIL);
                SubmitSearch(); const auto currentId = g_latestQueryId;
                SubmitSearch();
                currentStage = 483;
                queryResult(currentId, L"new-result");
                winrt::check_hresult(pasteCount() == before + 1 &&
                    requestAt(previewRequests.size() - 1).GetNamedString(L"hash") == L"new-result" &&
                    g_searchSubmitRequestId == 0 ? S_OK : E_FAIL);
                g_panel.search.Text(L"cancelled search"); SubmitSearch();
                SetVisible(false); queryResult(g_latestQueryId, L"do-not-paste");
                currentStage = 484;
                winrt::check_hresult(pasteCount() == before + 1 && g_searchSubmitRequestId == 0 ? S_OK : E_FAIL);
                SetVisible(true);
                g_panel.search.Text(L"failed search"); SubmitSearch();
                JsonObject failure; failure.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestQueryId)));
                failure.Insert(L"op", JsonValue::CreateStringValue(L"query")); failure.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic query failure"));
                ApplyResponse(winrt::to_string(failure.Stringify()));
                currentStage = 485;
                winrt::check_hresult(pasteCount() == before + 1 && g_searchSubmitRequestId == 0 ? S_OK : E_FAIL);
                g_panel.search.Text(L""); g_searchTimer.Stop();
            }
            currentStage = 49;
            {
                using namespace winrt::Windows::Data::Json;
                auto response = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"menu-key-test","itemType":"Text"}],"hasMore":false}})");
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(++g_requestId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
                co_await NextNativeFrame();
                const auto menu = g_panel.rows[0].surface.ContextFlyout().as<MenuFlyout>();
                winrt::check_hresult(OpenSelectedCardMenu() ? S_OK : E_FAIL);
                co_await NextNativeFrame();
                winrt::check_hresult(menu.IsOpen() ? S_OK : E_FAIL);
                menu.Hide();
                ToggleQueueSelectionMode();
                winrt::check_hresult(!OpenSelectedCardMenu() ? S_OK : E_FAIL);
                ToggleQueueSelectionMode();
            }
            currentStage = 50;
            {
                using namespace vpaste::winui;
                const auto chord = ParseKeyBinding(L"Control+Shift+V");
                winrt::check_hresult(chord.key == 'V' && chord.control && chord.shift && !chord.alt && !chord.meta ? S_OK : E_FAIL);
                winrt::check_hresult(ParseKeyBinding(L"Cmd+Return").meta && ParseKeyBinding(L"ctrl+F12").key == VK_F12 &&
                    ParseKeyBinding(L"Invalid+V").key == 0 && ParseKeyBinding(L"Ctrl+").key == 0 &&
                    ShortcutLabel(L"Control+Shift+V") == L"Ctrl+Shift+V" ? S_OK : E_FAIL);
                PanelBehavior behavior;
                const auto expect = [&](MainKeyInput input, MainKeyAction action, int index = -1) {
                    const auto result = ResolveMainKey(behavior, input);
                    winrt::check_hresult(result.action == action && result.index == index ? S_OK : E_FAIL);
                };
                expect({.key=VK_MENU, .alt=true}, MainKeyAction::ShowHints);
                expect({.key='1', .alt=true}, MainKeyAction::QuickItem, 0);
                expect({.key='9', .alt=true, .area=InputArea::Search}, MainKeyAction::QuickItem, 8);
                expect({.key='2', .alt=true, .repeated=true}, MainKeyAction::Ignore);
                // Numpad Alt codes belong to Windows text entry, not quick paste.
                expect({.key=VK_NUMPAD1, .alt=true}, MainKeyAction::None);
                expect({.key='A', .alt=true}, MainKeyAction::QuickAll);
                expect({.key='F', .alt=true}, MainKeyAction::QuickFavorite);
                expect({.key=VK_TAB}, MainKeyAction::NextCard);
                expect({.key=VK_TAB, .shift=true}, MainKeyAction::PreviousCard);
                expect({.key=VK_TAB, .control=true, .area=InputArea::Search}, MainKeyAction::NextCategory);
                expect({.key=VK_TAB, .control=true, .shift=true}, MainKeyAction::PreviousCategory);
                expect({.key=VK_RETURN, .shift=true}, MainKeyAction::PastePlain);
                expect({.key=VK_RETURN, .shift=true, .repeated=true}, MainKeyAction::Ignore);
                expect({.key=VK_RETURN, .shift=true, .area=InputArea::Search}, MainKeyAction::SearchPastePlain);
                expect({.key=VK_RETURN, .area=InputArea::Search}, MainKeyAction::SearchPaste);
                expect({.key=VK_ESCAPE, .area=InputArea::Search, .searchHasText=true}, MainKeyAction::ClearSearch);
                expect({.key=VK_ESCAPE, .area=InputArea::Search}, MainKeyAction::CloseSearch);
                expect({.key=VK_RETURN, .shift=true, .blocked=true}, MainKeyAction::None);
                expect({.key=VK_RETURN, .shift=true, .composing=true}, MainKeyAction::None);
                expect({.key=VK_RETURN, .shift=true, .area=InputArea::Other}, MainKeyAction::None);
                expect({.key='1', .alt=true, .area=InputArea::Other}, MainKeyAction::None);
                expect({.key=VK_TAB, .alt=true}, MainKeyAction::None);
                behavior.quickInput = false; behavior.tabSelection = false;
                expect({.key='1', .alt=true}, MainKeyAction::None);
                expect({.key=VK_TAB}, MainKeyAction::None);
                behavior.plainBinding = ParseKeyBinding(L"Control+Shift+V");
                expect({.key=VK_RETURN, .shift=true}, MainKeyAction::None);
                expect({.key='V', .control=true, .shift=true}, MainKeyAction::PastePlain);
                expect({.key='V', .control=true}, MainKeyAction::None);
                expect({.key='V', .control=true, .shift=true, .meta=true}, MainKeyAction::None);
            }
            currentStage = 51;
            {
                using namespace vpaste::winui;
                using namespace winrt::Windows::Data::Json;
                const auto oldBehavior = g_behavior;
                const auto setBehavior = [&](std::string const &bytes) {
                    winrt::check_hresult(vpaste_winui_set_behavior(reinterpret_cast<const std::uint8_t *>(bytes.data()), bytes.size()));
                };
                const auto rows = [&](const wchar_t *prefix, int count) {
                    JsonArray items;
                    for (int i = 0; i < count; ++i) {
                        JsonObject item; item.Insert(L"hash", JsonValue::CreateStringValue(prefix + std::to_wstring(i)));
                        item.Insert(L"itemType", JsonValue::CreateStringValue(L"Text")); items.Append(item);
                    }
                    JsonObject data; data.Insert(L"items", items); data.Insert(L"hasMore", JsonValue::CreateBooleanValue(false));
                    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(++g_requestId)));
                    response.Insert(L"op", JsonValue::CreateStringValue(L"query")); response.Insert(L"data", data);
                    // Match an outstanding accepted search where present.
                    if (g_searchSubmitRequestId) response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_searchSubmitRequestId)));
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                setBehavior(R"({"quickInput":true,"tabSelection":true,"plainShortcut":"Shift+Enter"})");
                rows(L"keyboard-", 12);
                winrt::check_hresult(MainInputArea(g_panel.search) == InputArea::Search &&
                    MainInputArea(g_panel.rows[0].favoriteButton) == InputArea::Other &&
                    NativeControlOwnsKeys(g_panel.rows[0].menu.pastePlain) && !NativeControlOwnsKeys(g_panel.search) ? S_OK : E_FAIL);
                winrt::check_hresult(HandleMainKey({.key=VK_MENU, .alt=true}) ? S_OK : E_FAIL);
                for (std::size_t i = 0; i < g_panel.rows.size(); ++i) {
                    winrt::check_hresult(g_panel.rows[i].shortcutHint.Visibility() == (i < 9 ? Visibility::Visible : Visibility::Collapsed) &&
                        !g_panel.rows[i].shortcutHint.IsHitTestVisible() ? S_OK : E_FAIL);
                }
                WindowProc(g_panel.window, WM_ACTIVATE, WA_INACTIVE, 0);
                winrt::check_hresult(!g_altHints && g_panel.rows[0].shortcutHint.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                g_panel.history.SelectedIndex(0);
                HandleMainKey({.key=VK_TAB}); winrt::check_hresult(g_panel.history.SelectedIndex() == 1 ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_TAB, .shift=true}); winrt::check_hresult(g_panel.history.SelectedIndex() == 0 ? S_OK : E_FAIL);
                HandleMainKey({.key='9', .alt=true});
                auto last = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(last.GetNamedString(L"op") == L"quickPaste" && last.GetNamedString(L"hash") == L"keyboard-8" &&
                    last.GetNamedString(L"argument") == L"9" ? S_OK : E_FAIL);
                setBehavior(R"({"quickInput":false,"tabSelection":false,"plainShortcut":"Control+Shift+V"})");
                const auto beforeDisabled = previewRequests.size();
                winrt::check_hresult(!HandleMainKey({.key='1', .alt=true}) && !HandleMainKey({.key=VK_TAB}) &&
                    previewRequests.size() == beforeDisabled && !g_altHints &&
                    g_panel.rows[0].menu.pastePlain.KeyboardAcceleratorTextOverride() == L"Ctrl+Shift+V" ? S_OK : E_FAIL);
                HandleMainKey({.key='V', .control=true, .shift=true});
                winrt::check_hresult(requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"pastePlain" ? S_OK : E_FAIL);
                const std::string invalid = R"({"quickInput":"wrong type"})";
                winrt::check_hresult(vpaste_winui_set_behavior(reinterpret_cast<const std::uint8_t *>(invalid.data()), invalid.size()) < 0 &&
                    !g_behavior.quickInput && g_behavior.plainShortcut == L"Control+Shift+V" ? S_OK : E_FAIL);
                currentStage = 52;
                setBehavior(R"({"quickInput":true,"tabSelection":true})");
                ToggleQueueSelectionMode(); const auto beforeQueue = previewRequests.size();
                HandleMainKey({.key='2', .alt=true});
                winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"keyboard-1"} &&
                    previewRequests.size() == beforeQueue ? S_OK : E_FAIL);
                HandleMainKey({.key='2', .alt=true});
                winrt::check_hresult(g_queueSelectedHashes.empty() && previewRequests.size() == beforeQueue ? S_OK : E_FAIL);
                ToggleQueueSelectionMode();
                SelectBuiltinCategory(0, false);
                g_selectedTagName = L"Work"; g_selectedTagId = 1;
                HandleMainKey({.key='A', .alt=true});
                winrt::check_hresult(FilterIndex() == 0 && g_selectedTagName.empty() && g_selectedTagId == 0 ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_TAB, .control=true, .area=InputArea::Search});
                winrt::check_hresult(FilterIndex() == 1 ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_TAB, .control=true, .shift=true, .area=InputArea::Search});
                winrt::check_hresult(FilterIndex() == 0 ? S_OK : E_FAIL);
                currentStage = 53;
                rows(L"search-", 12); g_panel.history.SelectedIndex(4);
                g_panel.search.Visibility(Visibility::Visible);
                g_panel.search.Text(L"fresh search");
                HandleMainKey({.key=VK_RETURN, .shift=true, .area=InputArea::Search});
                winrt::check_hresult(g_searchSubmitRequestId == g_latestQueryId ? S_OK : E_FAIL);
                rows(L"search-", 12);
                last = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(last.GetNamedString(L"op") == L"pastePlain" && last.GetNamedString(L"hash") == L"search-0" ? S_OK : E_FAIL);
                g_panel.search.Text(L"quick filtered");
                HandleMainKey({.key='3', .alt=true, .area=InputArea::Search});
                rows(L"filtered-", 12); last = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(last.GetNamedString(L"op") == L"quickPaste" && last.GetNamedString(L"hash") == L"filtered-2" &&
                    last.GetNamedString(L"argument") == L"3" ? S_OK : E_FAIL);
                g_panel.search.Text(L"cancel with config"); HandleMainKey({.key=VK_RETURN, .area=InputArea::Search});
                setBehavior(R"({"plainShortcut":"Control+Shift+V"})");
                winrt::check_hresult(g_searchSubmitRequestId == 0 ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_ESCAPE, .area=InputArea::Search, .searchHasText=true});
                winrt::check_hresult(g_panel.search.Text().empty() && g_panel.search.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_ESCAPE, .area=InputArea::Search});
                winrt::check_hresult(g_panel.search.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                g_searchTimer.Stop();
                currentStage = 54;
                for (const bool retainSearch : {false, true}) for (const bool retainCategory : {false, true}) {
                    JsonObject behavior; behavior.Insert(L"retainSearch", JsonValue::CreateBooleanValue(retainSearch));
                    behavior.Insert(L"retainCategory", JsonValue::CreateBooleanValue(retainCategory));
                    setBehavior(winrt::to_string(behavior.Stringify()));
                    g_panel.search.Text(L"remember query"); SelectBuiltinCategory(4, false);
                    g_selectedTagName = L"Work"; g_selectedTagId = 1;
                    SetVisible(false); SetVisible(true);
                    winrt::check_hresult(g_panel.search.Text() == (retainSearch ? L"remember query" : L"") &&
                        FilterIndex() == (retainCategory ? 4 : 0) && g_selectedTagName == (retainCategory ? L"Work" : L"") ? S_OK : E_FAIL);
                }
                currentStage = 55;
                setBehavior("{}");
                g_panel.search.Text(L"keep during management"); SelectBuiltinCategory(4, false);
                SetVisible(true);
                winrt::check_hresult(g_panel.search.Text() == L"keep during management" && FilterIndex() == 4 ? S_OK : E_FAIL);
                SetQueueViewActive(true); SetQueueViewActive(false);
                winrt::check_hresult(g_panel.search.Text() == L"keep during management" && FilterIndex() == 4 ? S_OK : E_FAIL);
                SetTagManagerActive(true); SetTagManagerActive(false);
                winrt::check_hresult(g_panel.search.Text() == L"keep during management" && FilterIndex() == 4 ? S_OK : E_FAIL);
                g_panel.search.Text(L""); g_searchTimer.Stop(); SelectBuiltinCategory(0, false);
                currentStage = 56;
                rows(L"refresh-", 12); g_panel.history.SelectedIndex(5);
                RequestHistory();
                HandleMainKey({.key=VK_RETURN, .shift=true});
                winrt::check_hresult(g_searchSubmitRequestId == g_latestQueryId ? S_OK : E_FAIL);
                rows(L"refresh-", 12);
                last = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(last.GetNamedString(L"op") == L"pastePlain" && last.GetNamedString(L"hash") == L"refresh-5" ? S_OK : E_FAIL);
                g_behavior = oldBehavior; ShowAltHints(false); UpdateShortcutLabels();
            }
            currentStage = 57;
            {
                using namespace vpaste::winui;
                winrt::check_hresult(ClampHistoryOffset(1250, 900) == 900 && ClampHistoryOffset(-10, 900) == 0 &&
                    ClampHistoryOffset(125, 900) == 125 && ClampHistoryOffset(125, 0) == 0 ? S_OK : E_FAIL);
                winrt::check_hresult(!NearHistoryEnd(0, 8000, 1000) && NearHistoryEnd(7600, 8000, 1000) &&
                    !NearHistoryEnd(0, 0, 0) && HistoryPageStep(980, 236) == 4 && HistoryPageStep(100, 236) == 1 ? S_OK : E_FAIL);
                PanelBehavior behavior;
                for (auto const &[key, action] : {std::pair{VK_HOME, MainKeyAction::FirstCard}, {VK_END, MainKeyAction::LastCard},
                    {VK_NEXT, MainKeyAction::NextPage}, {VK_PRIOR, MainKeyAction::PreviousPage}}) {
                    MainKeyInput input; input.key = key;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == action ? S_OK : E_FAIL);
                    input.area = InputArea::Search;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == MainKeyAction::None ? S_OK : E_FAIL);
                }
                for (const auto key : {VK_APPS, VK_F10}) {
                    MainKeyInput input; input.key = key; input.shift = key == VK_F10;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == MainKeyAction::OpenCardMenu ? S_OK : E_FAIL);
                    input.repeated = true;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == MainKeyAction::Ignore ? S_OK : E_FAIL);
                    input.repeated = false; input.area = InputArea::Search;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == MainKeyAction::None ? S_OK : E_FAIL);
                    input.area = InputArea::Other;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == MainKeyAction::None ? S_OK : E_FAIL);
                    input.area = InputArea::History; input.composing = true;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == MainKeyAction::None ? S_OK : E_FAIL);
                    input.composing = false; input.blocked = true;
                    winrt::check_hresult(ResolveMainKey(behavior, input).action == MainKeyAction::None ? S_OK : E_FAIL);
                }
            }
            currentStage = 58;
            {
                using namespace vpaste::winui;
                using namespace winrt::Windows::Data::Json;
                const auto oldBehavior = g_behavior;
                g_historyView = {};
                const auto resultRows = [&](const wchar_t *prefix, int count, bool more, bool append = false) {
                    JsonArray items;
                    for (int i = 0; i < count; ++i) {
                        JsonObject item; item.Insert(L"hash", JsonValue::CreateStringValue(prefix + std::to_wstring(i)));
                        item.Insert(L"itemType", JsonValue::CreateStringValue(L"Text")); items.Append(item);
                    }
                    JsonObject data; data.Insert(L"items", items); data.Insert(L"hasMore", JsonValue::CreateBooleanValue(more));
                    data.Insert(L"nextId", JsonValue::CreateNumberValue(append ? 48 : 36));
                    data.Insert(L"nextTime", JsonValue::CreateNumberValue(append ? 4800 : 3600));
                    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                    response.Insert(L"op", JsonValue::CreateStringValue(append ? L"queryMore" : L"query")); response.Insert(L"data", data);
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                const auto scrollTo = [&](double offset) {
                    g_panel.historyScroll.ChangeView(winrt::box_value(offset).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, nullptr, true);
                };
                g_panel.search.Text(L""); g_searchTimer.Stop(); SelectBuiltinCategory(0, false);
                RequestHistory(); resultRows(L"viewport-", 36, false);
                co_await AwaitHistoryOffset(0); BindHistoryScroll(); SyncHistoryViewport();
                winrt::check_hresult(g_panel.historyScroll && g_panel.historyScroll.ScrollableWidth() > 1000 &&
                    g_panel.historyScroll.ViewportWidth() > 0 && ScrollViewer::GetVerticalScrollBarVisibility(g_panel.history) == ScrollBarVisibility::Disabled ? S_OK : E_FAIL);
                currentStage = 581;
                scrollTo(1000); co_await AwaitHistoryOffset(1000); g_panel.history.SelectedIndex(5);
                currentStage = 582;
                RequestHistory(); resultRows(L"viewport-", 36, false); co_await AwaitHistoryOffset(1000);
                winrt::check_hresult(g_selectedHash == L"viewport-5" ? S_OK : E_FAIL);
                WindowProc(g_panel.window, kFocusHistory, 0, 0);
                co_await AwaitHistoryOffset(1000);
                winrt::check_hresult(!g_panel.historyScroll.BringIntoViewOnFocusChange() ? S_OK : E_FAIL);
                currentStage = 59;
                g_behavior.retainPosition = true;
                SetVisible(false); SetVisible(true); RequestHistory(); resultRows(L"viewport-", 36, false);
                co_await AwaitHistoryOffset(1000);
                winrt::check_hresult(g_selectedHash == L"viewport-5" ? S_OK : E_FAIL);
                g_behavior.retainPosition = false; SetVisible(false); SetVisible(true);
                // Simulate cached native focus reselecting an old item before
                // the new query. The disabled position setting must still win.
                g_panel.history.SelectedIndex(5);
                RequestHistory(); resultRows(L"viewport-", 36, false); co_await AwaitHistoryOffset(0);
                winrt::check_hresult(g_selectedHash == L"viewport-0" ? S_OK : E_FAIL);
                currentStage = 60;
                scrollTo(1200); co_await AwaitHistoryOffset(1200); g_panel.history.SelectedIndex(6);
                currentStage = 601;
                SetQueueViewActive(true); SetQueueViewActive(false); co_await AwaitHistoryOffset(1200);
                winrt::check_hresult(g_selectedHash == L"viewport-6" ? S_OK : E_FAIL);
                SetTagManagerActive(true); SetTagManagerActive(false);
                currentStage = 602;
                resultRows(L"viewport-", 36, false); co_await AwaitHistoryOffset(1200);
                g_panel.search.Text(L"new query"); g_searchTimer.Stop(); RequestHistory(); resultRows(L"new-", 36, false);
                currentStage = 603;
                co_await AwaitHistoryOffset(0);
                QueueHistoryOffset(1500, g_latestHistoryRequestId);
                HandleMainKey({.key=VK_HOME}); co_await NextNativeFrame();
                winrt::check_hresult(g_panel.history.SelectedIndex() == 0 && !g_historyView.restore &&
                    g_panel.historyScroll.BringIntoViewOnFocusChange() ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_NEXT});
                winrt::check_hresult(g_panel.history.SelectedIndex() == HistoryPageStep(g_panel.historyScroll.ViewportWidth(), kCardWidth + 16) ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_END}); co_await NextNativeFrame();
                winrt::check_hresult(g_panel.history.SelectedIndex() == 35 ? S_OK : E_FAIL);
                currentStage = 61;
                g_panel.search.Text(L""); g_searchTimer.Stop(); RequestHistory(); resultRows(L"viewport-", 36, true);
                co_await AwaitHistoryOffset(0); SyncHistoryViewport();
                const auto pageRequests = [&] {
                    return std::count_if(previewRequests.begin(), previewRequests.end(), [](auto const &bytes) {
                        return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"queryMore";
                    });
                };
                const auto beforePage = pageRequests(); const auto end = g_panel.historyScroll.ScrollableWidth();
                scrollTo(end); co_await AwaitHistoryOffset(end);
                MaybeLoadMoreHistory(); MaybeLoadMoreHistory(); RequestMoreHistory(true);
                currentStage = 611;
                winrt::check_hresult(pageRequests() == beforePage + 1 && g_historyLoading ? S_OK : E_FAIL);
                auto failure = JsonObject::Parse(LR"({"op":"queryMore","error":"Synthetic page failure"})");
                failure.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(failure.Stringify())); MaybeLoadMoreHistory();
                currentStage = 612;
                winrt::check_hresult(pageRequests() == beforePage + 1 && g_historyView.pageFailed && g_panel.more.IsEnabled() ? S_OK : E_FAIL);
                RequestMoreHistory();
                currentStage = 613;
                winrt::check_hresult(pageRequests() == beforePage + 2 && !g_historyView.pageFailed ? S_OK : E_FAIL);
                resultRows(L"page-", 12, true, true); SyncHistoryViewport(); co_await AwaitHistoryOffset(end);
                currentStage = 614;
                winrt::check_hresult(g_hashes.size() == 48 && g_panel.historyScroll.ScrollableWidth() > end ? S_OK : E_FAIL);
                const auto nextEnd = g_panel.historyScroll.ScrollableWidth(); scrollTo(nextEnd); co_await AwaitHistoryOffset(nextEnd);
                MaybeLoadMoreHistory(); winrt::check_hresult(pageRequests() == beforePage + 3 ? S_OK : E_FAIL);
                resultRows(L"empty-", 0, true, true); SyncHistoryViewport(); MaybeLoadMoreHistory();
                winrt::check_hresult(pageRequests() == beforePage + 3 ? S_OK : E_FAIL);
                currentStage = 62;
                RequestHistory();
                const auto refresh = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(refresh.GetNamedString(L"op") == L"query" && refresh.GetNamedNumber(L"limit") == 48 ? S_OK : E_FAIL);
                resultRows(L"viewport-", 48, false); SyncHistoryViewport(); co_await AwaitHistoryOffset(nextEnd);
                winrt::check_hresult(g_hashes.size() == 48 ? S_OK : E_FAIL);
                g_behavior = oldBehavior; RequestHistory(); resultRows(L"viewport-", 36, false);
                QueueHistoryOffset(0, g_latestHistoryRequestId); SyncHistoryViewport(); co_await AwaitHistoryOffset(0);
            }
            currentStage = 63;
            {
                using namespace winrt::Microsoft::UI::Xaml;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                SetTagManagerActive(true);
                Border fixture; fixture.Padding(vpaste::winui::UniformThickness(12));
                g_panel.xamlSource.Content(fixture); ResizeIsland();
                co_await vpaste::winui::TestRecordTagEditorControls(fixture, currentStage);
                SetTagManagerActive(false); co_await NextNativeFrame();
            }
            currentStage = 67;
            {
                using namespace winrt::Microsoft::UI::Xaml;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                using namespace winrt::Windows::Data::Json;
                const auto useEnglish = g_english;
                WindowProc(g_panel.window, kSetLanguage, true, 0);
                g_tagIds = {9, 10}; g_tagNames = {L"Work", L"Notes"}; RebuildTagFilter();
                SelectBuiltinCategory(2, false);
                g_panel.search.Text(L"keep"); g_searchTimer.Stop(); RequestHistory();
                auto result = JsonObject::Parse(LR"({"op":"query","data":{"hasMore":false,"items":[
                    {"hash":"single-tag","itemType":"File","previewText":"A.txt","tags":[{"id":9,"name":"Work"}]},
                    {"hash":"multi-tag","itemType":"File","previewText":"B.txt","tags":[{"id":9,"name":"Work"},{"id":10,"name":"Notes"}]}]}})");
                result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(result.Stringify())); co_await AwaitHistoryOffset(0);
                currentStage = 671;
                const auto badge = g_panel.rows[1].tags.Parent().as<Border>();
                winrt::check_hresult(badge.IsLoaded() && !badge.try_as<Button>() &&
                    winrt::unbox_value<winrt::hstring>(ToolTipService::GetToolTip(badge)) == L"Work · Notes" ? S_OK : E_FAIL);
                const auto beforeMenu = previewRequests.size();
                const auto cardMenu = g_panel.rows[0].surface.ContextFlyout().as<MenuFlyout>();
                currentStage = 672;
                for (const auto key : {VK_APPS, VK_F10}) {
                    winrt::check_hresult(HandleMainKey({.key = static_cast<std::uint32_t>(key), .shift = key == VK_F10}) ? S_OK : E_FAIL);
                    co_await NextNativeFrame();
                    if (!cardMenu.IsOpen()) std::fprintf(stderr, "WinUI menu-key check: key=%d foreground=%d selected=%d\n", key, GetForegroundWindow() == g_panel.window, g_panel.history.SelectedIndex());
                    winrt::check_hresult(cardMenu.IsOpen() ? S_OK : E_FAIL); co_await CloseNativeFlyout(cardMenu);
                }
                MenuFlyoutSubItem tagMenu{nullptr};
                currentStage = 673;
                for (const auto &option : cardMenu.Items()) {
                    if (auto submenu = option.try_as<MenuFlyoutSubItem>(); submenu && submenu.Text() == L"Tags") tagMenu = submenu;
                }
                winrt::check_hresult(tagMenu && tagMenu.Items().GetAt(0).as<MenuFlyoutItem>().Text() == L"Create and assign tag…" ? S_OK : E_FAIL);
                cardMenu.ShowAt(g_panel.rows[0].surface); co_await NextNativeFrame();
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(tagMenu)
                    .GetPattern(Automation::Peers::PatternInterface::ExpandCollapse).as<Automation::Provider::IExpandCollapseProvider>().Expand();
                co_await NextNativeFrame();
                g_searchSubmitRequestId = g_latestQueryId;
                currentStage = 674;
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(tagMenu.Items().GetAt(0))
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                co_await NextNativeFrame();
                if (!g_panel.recordTagEditor->IsOpen()) std::fprintf(stderr, "WinUI tag-editor entry: parent=%d foreground=%d loaded=%d\n", cardMenu.IsOpen(), GetForegroundWindow() == g_panel.window, g_panel.root.IsLoaded());
                winrt::check_hresult(g_panel.recordTagEditor->IsOpen() && g_searchSubmitRequestId == 0 ? S_OK : E_FAIL);
                g_panel.recordTagEditor->Hide(); cardMenu.Hide();
                for (std::size_t i = beforeMenu; i < previewRequests.size(); ++i) {
                    const auto operation = requestAt(i).GetNamedString(L"op");
                    winrt::check_hresult(operation != L"paste" && operation != L"pastePlain" && operation != L"quickPaste" &&
                        operation != L"dragPrepare" ? S_OK : E_FAIL);
                }
                currentStage = 675;
                g_tagIds = {10, 9}; g_tagNames = {L"Notes", L"Renamed"}; RebuildTagFilter(); ShowRecordTagEditor(9);
                co_await NextNativeFrame();
                winrt::check_hresult(g_panel.recordTagEditor->IsOpen() && g_panel.recordTagEditor->TestName() == L"Renamed" ? S_OK : E_FAIL);
                g_panel.recordTagEditor->Hide();
                g_tagIds = {10}; g_tagNames = {L"Notes"}; RebuildTagFilter();
                const auto beforeStale = previewRequests.size(); ShowRecordTagEditor(9);
                winrt::check_hresult(!g_panel.recordTagEditor->IsOpen() && previewRequests.size() == beforeStale ? S_OK : E_FAIL);
                const auto add = g_panel.addTag.Flyout().as<MenuFlyout>();
                currentStage = 676;
                const auto tabMenu = DynamicTab(L"record:10").ContextFlyout().as<MenuFlyout>();
                winrt::check_hresult(add.Items().Size() == 2 && tabMenu.Items().Size() == 2 &&
                    add.Items().GetAt(1).as<MenuFlyoutItem>().Text() == L"New tag" &&
                    tabMenu.Items().GetAt(0).as<MenuFlyoutItem>().Text() == L"Edit tag" ? S_OK : E_FAIL);
                g_searchSubmitRequestId = g_latestQueryId;
                currentStage = 677;
                ShowRecordTagEditor(10); co_await NextNativeFrame();
                const auto beforeEditorKey = previewRequests.size();
                ActivateHistoryIndex(0, false, true);
                winrt::check_hresult(g_panel.recordTagEditor->IsOpen() && NativeEditorOpen() &&
                    g_searchSubmitRequestId == 0 && previewRequests.size() == beforeEditorKey &&
                    !HandleMainKey({.key = VK_HOME}) ? S_OK : E_FAIL);
                currentStage = 68;
                g_panel.recordTagEditor->Hide(); ShowRecordTagEditor(); co_await NextNativeFrame();
                co_await AwaitNativeLoaded(g_panel.recordTagEditor->TestRoot());
                currentStage = 681;
                g_panel.recordTagEditor->TestName(L"New saved tag"); g_panel.recordTagEditor->TestSave();
                const auto saveTag = requestAt(previewRequests.size() - 1);
                if (saveTag.GetNamedString(L"op") != L"recordTagCreate") std::fprintf(stderr,
                    "WinUI tag save readiness: open=%d loaded=%d last=%ls\n", g_panel.recordTagEditor->IsOpen(),
                    g_panel.recordTagEditor->TestRoot().IsLoaded(), saveTag.GetNamedString(L"op").c_str());
                winrt::check_hresult(saveTag.GetNamedString(L"op") == L"recordTagCreate" && saveTag.GetNamedString(L"name") == L"New saved tag" ? S_OK : E_FAIL);
                auto savedTag = JsonObject::Parse(LR"({"op":"recordTagCreate","data":{"tag":{"id":11,"name":"New saved tag"}}})");
                savedTag.Insert(L"id", saveTag.GetNamedValue(L"id")); ApplyResponse(winrt::to_string(savedTag.Stringify()));
                currentStage = 682;
                auto updatedTags = JsonObject::Parse(LR"({"op":"tags","data":{"items":[{"id":10,"name":"Notes"},{"id":11,"name":"New saved tag"}]}})");
                updatedTags.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestTagsRequestId)));
                ApplyResponse(winrt::to_string(updatedTags.Stringify()));
                winrt::check_hresult(!g_panel.recordTagEditor->IsOpen() && g_selectedTagId == 11 &&
                    !g_panel.filter.SelectedItem() && g_panel.customTabs.SelectedItem().Text() == L"New saved tag" ? S_OK : E_FAIL);
                SetVisible(false); winrt::check_hresult(!g_panel.recordTagEditor->IsOpen() ? S_OK : E_FAIL);
                SetVisible(true); WindowProc(g_panel.window, kSetLanguage, useEnglish, 0);
            }
            currentStage = 69;
            {
                SetTagManagerActive(true);
                winrt::Microsoft::UI::Xaml::Controls::Border fixture;
                fixture.Padding(vpaste::winui::UniformThickness(12));
                g_panel.xamlSource.Content(fixture); ResizeIsland();
                co_await vpaste::winui::TestCardContentControls(fixture, currentStage);
                SetTagManagerActive(false); co_await NextNativeFrame();
            }
            currentStage = 71;
            {
                using namespace winrt::Microsoft::UI::Xaml;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                using namespace winrt::Windows::Data::Json;
                g_panel.search.Text(L"hello tag:Work"); g_searchTimer.Stop(); RequestHistory();
                auto result = JsonObject::Parse(LR"({"op":"query","data":{"highlightTerms":["hello"],"hasMore":false,"items":[
                    {"hash":"content-text","itemType":"Text","previewText":"😀 HELLO reference"},
                    {"hash":"content-file","itemType":"File","previewText":"hello.txt"},
                    {"hash":"content-image","itemType":"Image","previewText":"Tiny image"}]}})");
                result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(result.Stringify())); co_await AwaitHistoryOffset(0);
                const auto cardResult = [&](const wchar_t *hash, std::uint64_t request, JsonObject data) {
                    data.Insert(L"hash", JsonValue::CreateStringValue(hash));
                    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(request)));
                    response.Insert(L"op", JsonValue::CreateStringValue(L"card")); response.Insert(L"data", data);
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                const auto cardError = [&](std::uint64_t request) {
                    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(request)));
                    response.Insert(L"op", JsonValue::CreateStringValue(L"card")); response.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic preview failure"));
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                currentStage = 710;
                winrt::check_hresult(g_highlightTerms == vpaste::winui::SearchTerms{L"hello"} &&
                    FindCard(L"content-text")->preview.TextHighlighters().Size() == 1 &&
                    FindCard(L"content-text")->preview.TextHighlighters().GetAt(0).Ranges().GetAt(0).StartIndex == 3 ? S_OK : E_FAIL);
                cardResult(L"content-file", FindCard(L"content-file")->cardRequestId,
                    JsonObject::Parse(LR"({"displayText":"hello.txt","displayTitle":"hello.txt","displaySubtitle":"C:\\hello\\file.txt"})"));
                currentStage = 711;
                winrt::check_hresult(FindCard(L"content-file")->preview.TextHighlighters().Size() == 1 &&
                    FindCard(L"content-file")->subtitle.TextHighlighters().Size() == 1 ? S_OK : E_FAIL);
                const auto imageRequest = FindCard(L"content-image")->cardRequestId;
                const auto globalStatus = g_panel.status.Text(); cardError(imageRequest);
                currentStage = 712;
                winrt::check_hresult(FindCard(L"content-image")->detailState == CardDetailState::Failed &&
                    FindCard(L"content-image")->retryDetails.IsEnabled() && g_panel.status.Text() == globalStatus &&
                    FindCard(L"content-image")->preview.Text() == L"Tiny image" ? S_OK : E_FAIL);
                const auto beforeRetry = previewRequests.size();
                co_await NextNativeFrame();
                currentStage = 713;
                winrt::check_hresult(IsCardAction(FindCard(L"content-image")->retryDetails) &&
                    IsCardAction(FindCard(L"content-image")->retryDetails.Content()) &&
                    !IsCardAction(FindCard(L"content-image")->surface) ? S_OK : E_FAIL);
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(FindCard(L"content-image")->retryDetails)
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                co_await NextNativeFrame();
                const auto retry = requestAt(previewRequests.size() - 1);
                const auto retryId = FindCard(L"content-image")->cardRequestId;
                RequestCardDetails(L"content-image", true);
                currentStage = 714;
                winrt::check_hresult(previewRequests.size() == beforeRetry + 1 && retry.GetNamedString(L"op") == L"card" &&
                    retry.GetNamedString(L"argument") == L"refresh" && retry.GetNamedString(L"hash") == L"content-image" &&
                    retry.GetNamedNumber(L"cardScale") > 0 && FindCard(L"content-image")->detailState == CardDetailState::Loading ? S_OK : E_FAIL);
                cardError(imageRequest);
                cardResult(L"content-image", imageRequest, JsonObject::Parse(LR"({"displayText":"OLD","mediaError":"Old failure"})"));
                currentStage = 715;
                winrt::check_hresult(FindCard(L"content-image")->detailState == CardDetailState::Loading &&
                    FindCard(L"content-image")->preview.Text() == L"Tiny image" ? S_OK : E_FAIL);
                cardResult(L"content-image", retryId, JsonObject::Parse(LR"({"dimensions":"24 × 16","media":{"width":24,"height":16,"isGif":true,"format":"GIF","sourceBytes":4096,"previewLimited":true}})"));
                currentStage = 716;
                winrt::check_hresult(FindCard(L"content-image")->detailState == CardDetailState::Limited &&
                    FindCard(L"content-image")->retryDetails.Visibility() == Visibility::Collapsed &&
                    FindCard(L"content-image")->image.MaxWidth() == 24 && FindCard(L"content-image")->image.MaxHeight() == 16 &&
                    std::wstring{FindCard(L"content-image")->dimensions.Text()}.find(L"4.0 KB") != std::wstring::npos ? S_OK : E_FAIL);

                currentStage = 72;
                // One unique, synthetic PNG, deleted by its scoped owner even
                // when an assertion fails. No user image or history is edited.
                wchar_t tempDirectory[MAX_PATH]{}, imagePath[MAX_PATH]{};
                const auto tempLength = GetTempPathW(MAX_PATH, tempDirectory);
                winrt::check_bool(tempLength > 0 && tempLength < MAX_PATH);
                winrt::check_bool(GetTempFileNameW(tempDirectory, L"vpc", 0, imagePath));
                struct RemoveFixture {
                    std::wstring path;
                    ~RemoveFixture() { (void)DeleteFileW(path.c_str()); }
                } removeFixture{imagePath};
                const auto file = co_await winrt::Windows::Storage::StorageFile::GetFileFromPathAsync(imagePath);
                {
                    const auto stream = co_await file.OpenAsync(winrt::Windows::Storage::FileAccessMode::ReadWrite);
                    const auto encoder = co_await winrt::Windows::Graphics::Imaging::BitmapEncoder::CreateAsync(
                        winrt::Windows::Graphics::Imaging::BitmapEncoder::PngEncoderId(), stream);
                    std::vector<std::uint8_t> pixels(8 * 6 * 4, 255);
                    encoder.SetPixelData(winrt::Windows::Graphics::Imaging::BitmapPixelFormat::Bgra8,
                        winrt::Windows::Graphics::Imaging::BitmapAlphaMode::Premultiplied, 8, 6, 96, 96, pixels);
                    co_await encoder.FlushAsync();
                }
                RequestCardDetails(L"content-image", true);
                const auto bitmapRequest = FindCard(L"content-image")->cardRequestId;
                auto imageData = JsonObject::Parse(LR"({"dimensions":"8 × 6","cardPixelWidth":240,"media":{"width":8,"height":6,"format":"PNG","sourceBytes":128}})");
                imageData.Insert(L"assetPath", JsonValue::CreateStringValue(imagePath));
                cardResult(L"content-image", bitmapRequest, imageData);
                co_await AwaitCardDetailState(L"content-image", bitmapRequest, CardDetailState::Ready);
                const auto decoded = FindCard(L"content-image")->image.Source().as<Media::Imaging::BitmapImage>();
                winrt::check_hresult(decoded.PixelWidth() > 0 && FindCard(L"content-image")->image.MaxWidth() == 8 &&
                    FindCard(L"content-image")->image.MaxHeight() == 6 && FindCard(L"content-image")->contentIcon.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                currentStage = 73;
                RequestCardDetails(L"content-image", true);
                const auto newer = FindCard(L"content-image")->cardRequestId;
                CompleteCardBitmap(L"content-image", bitmapRequest, decoded, false, L"Old decoder failure");
                winrt::check_hresult(FindCard(L"content-image")->detailState == CardDetailState::Loading ? S_OK : E_FAIL);
                cardResult(L"content-image", newer, imageData); co_await AwaitCardDetailState(L"content-image", newer, CardDetailState::Ready);
                CompleteCardBitmap(L"content-image", bitmapRequest, decoded, false, L"Late old failure");
                winrt::check_hresult(FindCard(L"content-image")->detailState == CardDetailState::Ready &&
                    FindCard(L"content-image")->retryDetails.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                currentStage = 731;
                // GetTempFileName creates an empty file: a real local URI whose
                // bytes cannot decode, without damaging an image or cache entry.
                wchar_t invalidPath[MAX_PATH]{};
                winrt::check_bool(GetTempFileNameW(tempDirectory, L"vpc", 0, invalidPath));
                RemoveFixture removeInvalid{invalidPath};
                RequestCardDetails(L"content-image", true);
                const auto invalidRequest = FindCard(L"content-image")->cardRequestId;
                JsonObject invalidImage;
                invalidImage.Insert(L"assetPath", JsonValue::CreateStringValue(invalidPath));
                cardResult(L"content-image", invalidRequest, invalidImage);
                co_await AwaitCardDetailState(L"content-image", invalidRequest, CardDetailState::Failed);
                winrt::check_hresult(FindCard(L"content-image")->retryDetails.Visibility() == Visibility::Visible &&
                    FindCard(L"content-image")->contentIcon.Visibility() == Visibility::Visible &&
                    FindCard(L"content-image")->image.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                RequestCardDetails(L"content-image", true);
                const auto recovered = FindCard(L"content-image")->cardRequestId;
                cardResult(L"content-image", recovered, imageData);
                co_await AwaitCardDetailState(L"content-image", recovered, CardDetailState::Ready);
                currentStage = 74;
                RequestCardDetails(L"content-image", true);
                cardResult(L"content-image", FindCard(L"content-image")->cardRequestId,
                    JsonObject::Parse(LR"({"media":{"width":8,"height":6,"previewLimited":true}})"));
                winrt::check_hresult(FindCard(L"content-image")->detailState == CardDetailState::Limited &&
                    !FindCard(L"content-image")->image.Source() && FindCard(L"content-image")->image.Visibility() == Visibility::Collapsed &&
                    FindCard(L"content-image")->contentIcon.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
                currentStage = 75;
                cardResult(L"content-text", FindCard(L"content-text")->cardRequestId,
                    JsonObject::Parse(LR"({"displayText":"hello rich fallback","rich":{"blocks":[{"runs":[{"text":"hello rich","bold":true}],"rows":[]}]}})"));
                winrt::check_hresult(FindCard(L"content-text")->richFrame.Visibility() == Visibility::Visible &&
                    FindCard(L"content-text")->preview.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                RequestCardDetails(L"content-text", true);
                cardResult(L"content-text", FindCard(L"content-text")->cardRequestId,
                    JsonObject::Parse(LR"({"displayText":"hello refreshed text"})"));
                winrt::check_hresult(FindCard(L"content-text")->richFrame.Visibility() == Visibility::Collapsed &&
                    !FindCard(L"content-text")->richFrame.Child() && FindCard(L"content-text")->richBadge.Visibility() == Visibility::Collapsed &&
                    FindCard(L"content-text")->preview.Visibility() == Visibility::Visible &&
                    FindCard(L"content-text")->preview.Text() == L"hello refreshed text" ? S_OK : E_FAIL);
                currentStage = 76;
                const auto previousQuery = g_latestHistoryRequestId;
                g_panel.search.Text(L""); g_searchTimer.Stop(); RequestHistory();
                result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                const auto data = result.GetNamedObject(L"data"); data.Insert(L"highlightTerms", JsonArray{});
                ApplyResponse(winrt::to_string(result.Stringify()));
                winrt::check_hresult(g_highlightTerms.empty() && FindCard(L"content-text")->preview.TextHighlighters().Size() == 0 ? S_OK : E_FAIL);
                result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(previousQuery)));
                data.Insert(L"highlightTerms", JsonArray::Parse(LR"(["stale"])") ); ApplyResponse(winrt::to_string(result.Stringify()));
                winrt::check_hresult(g_highlightTerms.empty() ? S_OK : E_FAIL);
            }
            currentStage = 77;
            {
                using namespace winrt::Windows::Data::Json;
                ApplyFilters(JsonArray::Parse(LR"([{"id":"clear-me","name":"Filtered","filter":{"itemType":"Image"}}])"));
                g_panel.customTabs.SelectedItem(g_panel.customTabs.Items().GetAt(0));
                g_panel.search.Text(L"no matches"); g_searchTimer.Stop(); RequestHistory();
                auto empty = JsonObject::Parse(LR"({"op":"query","data":{"items":[],"hasMore":false}})");
                empty.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(empty.Stringify())); co_await NextNativeFrame();
                const auto before = previewRequests.size();
                invoke(g_panel.resetFilters); co_await NextNativeFrame();
                const auto last = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(g_selectedFilterId.empty() && !g_panel.customTabs.SelectedItem() &&
                    g_panel.search.Text().empty() && g_selectedTagName.empty() && FilterIndex() == 0 &&
                    last.GetNamedString(L"op") == L"query" && last.GetNamedString(L"filter") == L"all" &&
                    previewRequests.size() == before + 1 ? S_OK : E_FAIL);
                ApplyFilters(JsonArray{});
                currentStage = 78;
                auto items = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"add-a"},{"hash":"add-b"}],"hasMore":false}})");
                items.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(items.Stringify()));
                ToggleQueueSelectionMode(); g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                AddSelectedItemsToQueue(); const auto add = requestAt(previewRequests.size() - 1);
                const auto afterAdd = previewRequests.size();
                AddSelectedItemsToQueue();
                winrt::check_hresult(previewRequests.size() == afterAdd ? S_OK : E_FAIL);
                RequestHistory();
                items.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(items.Stringify()));
                winrt::check_hresult(!g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
                auto failure = JsonObject::Parse(LR"({"op":"queueAdd","error":"Synthetic queue capacity failure"})");
                failure.Insert(L"id", add.GetNamedValue(L"id")); ApplyResponse(winrt::to_string(failure.Stringify()));
                winrt::check_hresult(g_panel.queueAdd.IsEnabled() && g_queueSelectedHashes == std::vector<std::wstring>{L"add-a"} ? S_OK : E_FAIL);
                AddSelectedItemsToQueue(); const auto retriedAdd = requestAt(previewRequests.size() - 1);
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(1));
                ApplyResponse(winrt::to_string(failure.Stringify()));
                winrt::check_hresult(!g_panel.queueAdd.IsEnabled() && g_queueSelectedHashes.size() == 2 ? S_OK : E_FAIL);
                JsonObject added;
                added.Insert(L"op", JsonValue::CreateStringValue(L"queueAdd")); added.Insert(L"id", retriedAdd.GetNamedValue(L"id"));
                added.Insert(L"data", JsonObject::Parse(LR"({"revision":90,"busy":false,"items":[]})"));
                ApplyResponse(winrt::to_string(added.Stringify()));
                winrt::check_hresult(g_queueSelectionMode && g_panel.queueAdd.IsEnabled() &&
                    g_queueSelectedHashes == std::vector<std::wstring>{L"add-b"} && g_panel.history.SelectedItems().Size() == 1 ? S_OK : E_FAIL);
                ApplyResponse(winrt::to_string(added.Stringify()));
                winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"add-b"} ? S_OK : E_FAIL);
                ToggleQueueSelectionMode();
            }
            currentStage = 79;
            {
                SetTagManagerActive(true);
                Border fixture; fixture.Padding(vpaste::winui::UniformThickness(12));
                g_panel.xamlSource.Content(fixture); ResizeIsland();
                co_await vpaste::winui::TestQueueConsolidationControls(fixture, currentStage);
                SetTagManagerActive(false); co_await NextNativeFrame();
            }
            currentStage = 82;
            {
                using namespace winrt::Windows::Data::Json;
                auto response = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"preview-a"},{"hash":"preview-b"}],"hasMore":false}})");
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
                g_panel.history.SelectedIndex(0); RequestSelectedPreview(L"previewToggle");
                auto navigation = JsonObject::Parse(LR"({"op":"previewNavigation","data":{"direction":1,"key":"ArrowRight"}})");
                navigation.GetNamedObject(L"data").Insert(L"sourceRequest", JsonValue::CreateNumberValue(static_cast<double>(g_latestPreviewRequestId)));
                RequestSelectedPreview(L"previewToggle");
                const auto before = previewRequests.size();
                ApplyResponse(winrt::to_string(navigation.Stringify()));
                winrt::check_hresult(g_selectedHash == L"preview-a" && previewRequests.size() == before ? S_OK : E_FAIL);
                navigation.GetNamedObject(L"data").Insert(L"sourceRequest", JsonValue::CreateNumberValue(static_cast<double>(g_latestPreviewRequestId)));
                ApplyResponse(winrt::to_string(navigation.Stringify()));
                winrt::check_hresult(g_selectedHash == L"preview-b" && requestAt(previewRequests.size() - 1).GetNamedString(L"hash") == L"preview-b" ? S_OK : E_FAIL);
                navigation.GetNamedObject(L"data").Insert(L"sourceRequest", JsonValue::CreateNumberValue(static_cast<double>(g_latestPreviewRequestId)));
                navigation.GetNamedObject(L"data").Insert(L"direction", JsonValue::CreateNumberValue(-1));
                (void)SendRequest(L"previewDismiss"); const auto dismissed = previewRequests.size();
                ApplyResponse(winrt::to_string(navigation.Stringify()));
                winrt::check_hresult(g_selectedHash == L"preview-b" && previewRequests.size() == dismissed ? S_OK : E_FAIL);
            }
            {
                winrt::Microsoft::UI::Xaml::Controls::Border fixture;
                g_panel.xamlSource.Content(fixture); ResizeIsland();
                co_await vpaste::winui::TestFilterEditorControls(fixture, currentStage);
                g_panel.xamlSource.Content(g_panel.viewport); ResizeIsland();
                co_await NextNativeFrame();
            }
            currentStage = 88;
            {
                using namespace winrt::Microsoft::UI::Xaml;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                using namespace winrt::Windows::Data::Json;
                ApplyFilters(JsonArray::Parse(LR"([{"id":"saved","name":"Old draft","filter":{}}])"));
                const auto capturedDraft = g_customFilters.front();
                ApplyFilters(JsonArray::Parse(LR"([{"id":"saved","name":"Current filter name","filter":{"favorite":"yes"}}])"));
                ShowFilterEditor(capturedDraft); co_await NextNativeFrame();
                winrt::check_hresult(g_panel.filterEditor->TestName() == L"Current filter name" ? S_OK : E_FAIL);
                g_panel.filterEditor->Hide(); co_await NextNativeFrame();
                std::uint32_t index = 0;
                winrt::check_hresult(g_panel.filterStrip.Children().IndexOf(g_panel.addTag, index) &&
                    index == g_panel.filterStrip.Children().Size() - 1 ? S_OK : E_FAIL);
                winrt::check_hresult(g_panel.customTabs.Items().GetAt(0).MaxWidth() <= 200 &&
                    winrt::unbox_value<winrt::hstring>(ToolTipService::GetToolTip(g_panel.customTabs.Items().GetAt(0))) == L"Current filter name" ? S_OK : E_FAIL);
                g_panel.customTabs.SelectedItem(g_panel.customTabs.Items().GetAt(0));
                ApplyFilters(JsonArray{}); ShowFilterEditor(capturedDraft);
                winrt::check_hresult(!g_panel.filterEditor->IsOpen() && g_selectedFilterId.empty() && FilterIndex() == 0 ? S_OK : E_FAIL);

                currentStage = 89;
                const auto render = [&](JsonArray const &items) {
                    RequestHistory();
                    JsonObject data; data.Insert(L"items", items); data.Insert(L"hasMore", JsonValue::CreateBooleanValue(false));
                    JsonObject response; response.Insert(L"op", JsonValue::CreateStringValue(L"query")); response.Insert(L"data", data);
                    response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                render(JsonArray::Parse(LR"([{"id":10,"hash":"first"},{"id":20,"hash":"before-edit"}])"));
                g_panel.history.SelectedIndex(1);
                render(JsonArray::Parse(LR"([{"id":10,"hash":"first"},{"id":20,"hash":"after-edit"}])"));
                winrt::check_hresult(g_selectedHash == L"after-edit" && g_panel.history.SelectedIndex() == 1 ? S_OK : E_FAIL);
                render(JsonArray::Parse(LR"([{"id":20,"hash":"after-edit"},{"id":10,"hash":"first"}])"));
                winrt::check_hresult(g_selectedHash == L"after-edit" && g_panel.history.SelectedIndex() == 0 ? S_OK : E_FAIL);

                currentStage = 90;
                ApplyFilters(JsonArray::Parse(LR"([{"id":"saved","name":"Work","filter":{}}])"));
                g_panel.customTabs.SelectedItem(g_panel.customTabs.Items().GetAt(0));
                g_panel.search.Text(L"memo"); g_searchTimer.Stop();
                const auto beforeClose = g_latestHistoryRequestId;
                SetVisible(false);
                ApplyResponse(R"({"op":"editorClosed","data":{}})"); co_await NextNativeFrame();
                winrt::check_hresult(IsWindowVisible(g_panel.window) && g_selectedFilterId == L"saved" &&
                    g_panel.search.Text() == L"memo" && g_selectedHash == L"after-edit" &&
                    g_latestHistoryRequestId == beforeClose ? S_OK : E_FAIL);
                g_panel.search.Text(L""); g_searchTimer.Stop(); SelectBuiltinCategory(0, false); ApplyFilters(JsonArray{});

                currentStage = 91;
                JsonArray manyTabs;
                for (int index = 0; index < 12; ++index) {
                    JsonObject tab;
                    tab.Insert(L"id", JsonValue::CreateStringValue(L"overflow-" + winrt::to_hstring(index)));
                    tab.Insert(L"name", JsonValue::CreateStringValue(L"Long filter name " + winrt::to_hstring(index)));
                    tab.Insert(L"filter", JsonObject{}); manyTabs.Append(tab);
                }
                ApplyFilters(manyTabs);
                g_panel.customTabs.SelectedItem(g_panel.customTabs.Items().GetAt(11));
                const auto visible = [&] {
                    const auto selected = g_panel.customTabs.SelectedItem();
                    if (!selected || !selected.IsLoaded()) return false;
                    const auto bounds = selected.TransformToVisual(g_panel.filterScroll).TransformBounds(
                        {0, 0, static_cast<float>(selected.ActualWidth()), static_cast<float>(selected.ActualHeight())});
                    return bounds.Width > 0 && bounds.X >= -1 && bounds.X + bounds.Width <= g_panel.filterScroll.ActualWidth() + 1;
                };
                for (int frame = 0; frame < 30 && !visible(); ++frame) co_await NextNativeFrame();
                if (!visible()) {
                    const auto selected = g_panel.customTabs.SelectedItem();
                    const auto bounds = selected.TransformToVisual(g_panel.filterScroll).TransformBounds(
                        {0, 0, static_cast<float>(selected.ActualWidth()), static_cast<float>(selected.ActualHeight())});
                    std::fprintf(stderr, "WinUI category overflow: root=%.1f viewport=%.1f item=%.1f,%.1f scroll=%.1f/%.1f add=%.1f\n",
                        g_panel.root.ActualWidth(), g_panel.filterScroll.ActualWidth(), bounds.X, bounds.Width,
                        g_panel.filterScroll.HorizontalOffset(), g_panel.filterScroll.ScrollableWidth(), g_panel.addTag.ActualWidth());
                }
                winrt::check_hresult(visible() && g_panel.addTag.ActualWidth() >= 24 ? S_OK : E_FAIL);
                currentStage = 912;
                g_panel.filterScroll.ChangeView(winrt::box_value(0.0).as<winrt::Windows::Foundation::IReference<double>>(), nullptr, nullptr, true);
                co_await NextNativeFrame(); co_await NextNativeFrame();
                winrt::check_hresult(std::abs(g_panel.filterScroll.HorizontalOffset()) < 0.5 ? S_OK : E_FAIL);
                currentStage = 911;
                ApplyFilters(manyTabs);
                for (int frame = 0; frame < 30 && !visible(); ++frame) co_await NextNativeFrame();
                winrt::check_hresult(visible() && g_selectedFilterId == L"overflow-11" ? S_OK : E_FAIL);

                currentStage = 92;
                ShowFilterEditor(g_customFilters.front()); co_await NextNativeFrame();
                g_panel.filterEditor->TestName(L"Fresh draft");
                const auto beforeLateSave = g_latestFiltersRequestId;
                ApplyResponse(R"({"id":1,"op":"filtersSave","data":{"items":[]}})");
                winrt::check_hresult(g_panel.filterEditor->IsOpen() && g_panel.filterEditor->TestName() == L"Fresh draft" &&
                    g_latestFiltersRequestId > beforeLateSave && requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"filtersList" ? S_OK : E_FAIL);
                g_panel.filterEditor->Hide(); co_await NextNativeFrame();
                ApplyFilters(JsonArray{});
            }
            currentStage = 93;
            {
                using namespace winrt::Windows::Data::Json;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                g_tagIds = {7}; g_tagNames = {L"Work"}; RebuildTagFilter();
                const auto filters = JsonArray::Parse(LR"([{"id":"images","name":"Images","filter":{"itemType":"Image"}},{"id":"notes","name":"Notes","filter":{}}])");
                ApplyFilters(filters);
                ApplyResponse(R"({"op":"tabOrderChanged","data":{"order":["record:7","notes","images"]}})");
                winrt::check_hresult(g_dynamicIds == std::vector<std::wstring>{L"record:7", L"notes", L"images"} ? S_OK : E_FAIL);
                g_panel.customTabs.SelectedItem(DynamicTab(L"record:7"));
                const auto historyRequest = g_latestHistoryRequestId;
                SaveTabDrop(L"images", L"record:7");
                const auto save = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(save.GetNamedString(L"op") == L"tabOrderSave" &&
                    save.GetNamedString(L"sourceId") == L"images" && save.GetNamedString(L"targetId") == L"record:7" &&
                    save.GetNamedBoolean(L"before") && !save.HasKey(L"order") && g_selectedTagId == 7 &&
                    g_dynamicIds.front() == L"record:7" ? S_OK : E_FAIL);
                JsonObject failure; failure.Insert(L"id", save.GetNamedValue(L"id"));
                failure.Insert(L"op", JsonValue::CreateStringValue(L"tabOrderSave"));
                failure.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic write failure"));
                ApplyResponse(winrt::to_string(failure.Stringify()));
                winrt::check_hresult(!g_tabOrderSaveRequest && g_dynamicIds.front() == L"record:7" ? S_OK : E_FAIL);
                SaveTabDrop(L"images", L"record:7");
                const auto retry = requestAt(previewRequests.size() - 1);
                const auto oldRead = g_tabOrderLoadRequest;
                ApplyResponse(R"({"op":"tabOrderChanged","data":{"order":["images","record:7","notes"]}})");
                JsonObject accepted = JsonObject::Parse(LR"({"op":"tabOrderSave","data":{"order":["record:7","images","notes"]}})");
                accepted.Insert(L"id", retry.GetNamedValue(L"id")); ApplyResponse(winrt::to_string(accepted.Stringify()));
                JsonObject stale = JsonObject::Parse(LR"({"op":"tabOrderLoad","data":{"order":["notes","images"]}})");
                stale.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(oldRead)));
                ApplyResponse(winrt::to_string(stale.Stringify()));
                winrt::check_hresult(g_dynamicIds.front() == L"images" && g_selectedTagId == 7 &&
                    g_panel.customTabs.SelectedItem() == DynamicTab(L"record:7") &&
                    g_latestHistoryRequestId == historyRequest ? S_OK : E_FAIL);
                NavigatePreview(1, true);
                winrt::check_hresult(g_selectedFilterId == L"notes" ? S_OK : E_FAIL);
                co_await NextNativeFrame();
                currentStage = 94;
                ShowFilterEditor(g_customFilters.back()); co_await NextNativeFrame();
                g_panel.filterEditor->TestName(L"Unsaved draft");
                ApplyFilters(filters); co_await NextNativeFrame();
                winrt::check_hresult(g_panel.filterEditor->IsOpen() && g_panel.filterEditor->TestName() == L"Unsaved draft" ? S_OK : E_FAIL);
                g_panel.filterEditor->Hide(); co_await NextNativeFrame();
                ShowRecordTagEditor(7); co_await NextNativeFrame();
                g_panel.recordTagEditor->TestName(L"Unsaved tag");
                RebuildTagFilter(); co_await NextNativeFrame();
                winrt::check_hresult(g_panel.recordTagEditor->IsOpen() && g_panel.recordTagEditor->TestName() == L"Unsaved tag" ? S_OK : E_FAIL);
                g_panel.recordTagEditor->Hide(); co_await NextNativeFrame();
                g_tabOrder.clear(); g_tabOrderLoadRequest = 0; g_tagIds.clear(); g_tagNames.clear();
                SelectBuiltinCategory(0, false); RebuildTagFilter(); ApplyFilters(JsonArray{});
            }
            currentStage = 95;
            {
                using namespace winrt::Microsoft::UI::Xaml;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                SetQueueViewActive(true);
                g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(
                    LR"({"revision":99,"busy":false,"items":[{"hash":"fresh-activation"}]})"));
                co_await NextNativeFrame();
                const auto menuButton = rows.Children().GetAt(0).as<Border>().Child().as<Grid>().Children().GetAt(1)
                    .as<StackPanel>().Children().GetAt(0).as<Button>();
                const auto menu = menuButton.Flyout().as<MenuFlyout>();
                menu.ShowAt(menuButton); co_await NextNativeFrame();
                winrt::check_hresult(menu.IsOpen() ? S_OK : E_FAIL);
                SetQueueViewActive(false); SetQueueViewActive(true);
                for (int frame = 0; frame < 30 && menu.IsOpen(); ++frame) co_await NextNativeFrame();
                winrt::check_hresult(!menu.IsOpen() ? S_OK : E_FAIL);
                const auto clear = queueRoot.Children().GetAt(0).as<Grid>().Children().GetAt(2)
                    .as<CommandBar>().SecondaryCommands().GetAt(1).as<AppBarButton>();
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(clear)
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                co_await NextNativeFrame();
                winrt::check_hresult(!clear.IsEnabled() ? S_OK : E_FAIL);
                SetQueueViewActive(false);
                SetQueueViewActive(true);
                co_await NextNativeFrame();
                winrt::check_hresult(clear.IsEnabled() ? S_OK : E_FAIL);
                SetQueueViewActive(false);
            }
            currentStage = 96;
            SetVisible(true, false);
            DismissFeedback();
            ApplyResponse(R"({"id":0,"op":"captureRejected","data":{}})");
            winrt::check_hresult(g_panel.feedback.IsOpen() &&
                g_panel.feedback.Severity() == InfoBarSeverity::Warning &&
                g_panel.feedback.IsClosable() && !g_feedbackTimer.IsRunning() ? S_OK : E_FAIL);
            SetVisible(false);
            ApplyResponse(R"({"id":0,"op":"captureRejected","data":{}})");
            winrt::check_hresult(!g_panel.feedback.IsOpen() ? S_OK : E_FAIL);
            SetVisible(true, false);
            winrt::check_hresult(!g_panel.feedback.IsOpen() ? S_OK : E_FAIL);
            co_await vpaste::winui::TestAppActionsControls(g_panel.root, currentStage);
            currentStage = 105;
            ApplyResponse(R"({"id":0,"op":"appState","data":{"developerMode":true,"update":{"revision":100,"status":"ready","portable":false,"source":"direct","availableVersion":"1.7.1"}}})");
            co_await NextNativeFrame();
            winrt::check_hresult(g_panel.appActions->ToolsButton().Visibility() == Visibility::Visible &&
                g_panel.appActions->UpdateButton().IsEnabled() &&
                MainInputArea(g_panel.appActions->UpdateButton()) == vpaste::winui::InputArea::Other ? S_OK : E_FAIL);
            Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(g_panel.appActions->UpdateButton())
                .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
            co_await NextNativeFrame();
            vpaste::winui::MainKeyInput blockedSearch;
            blockedSearch.key = 'F'; blockedSearch.control = true; blockedSearch.area = vpaste::winui::InputArea::History;
            winrt::check_hresult(g_panel.appActions->ModalOpen() && !HandleMainKey(blockedSearch) &&
                !HandlePreviewKey(VirtualKey::Space, false, false, false, false) ? S_OK : E_FAIL);
            SetVisible(false);
            SetVisible(true, false);
            for (int frame = 0; frame < 30 && g_panel.appActions->ModalOpen(); ++frame) co_await NextNativeFrame();
            winrt::check_hresult(!g_panel.appActions->ModalOpen() ? S_OK : E_FAIL);
            currentStage = 106;
            const auto statusWidth = g_panel.root.Width();
            const auto statusSearch = g_panel.search.Visibility();
            for (const auto width : {640.0, 960.0}) {
                g_panel.root.Width(width); UpdateSearchWidth();
                g_panel.search.Visibility(Visibility::Visible); co_await NextNativeFrame();
                g_panel.root.UpdateLayout();
                winrt::check_hresult(g_panel.commands.ActualWidth() <= width - kHeaderInset * 2 + 1 &&
                    g_panel.search.ActualWidth() >= 120 ? S_OK : E_FAIL);
            }
            g_panel.root.Width(statusWidth); UpdateSearchWidth(); g_panel.search.Visibility(statusSearch);
            ApplyResponse(R"({"id":0,"op":"updateStateChanged","data":{"revision":101,"status":"disabled","portable":false}})");
            {
                Border fixture; fixture.Width(360); fixture.Height(448);
                g_panel.root.Children().Append(fixture);
                co_await vpaste::winui::TestQueueUndoExpiryControls(fixture, currentStage);
                std::uint32_t fixtureIndex = 0;
                if (g_panel.root.Children().IndexOf(fixture, fixtureIndex)) g_panel.root.Children().RemoveAt(fixtureIndex);
            }
            vpaste::winui::TestHoverPreview(currentStage);
            {
                Border fixture; fixture.Width(360); fixture.Height(448);
                g_panel.root.Children().Append(fixture);
                co_await vpaste::winui::TestQueueFocusContinuityControls(fixture, currentStage);
                std::uint32_t fixtureIndex = 0;
                if (g_panel.root.Children().IndexOf(fixture, fixtureIndex)) g_panel.root.Children().RemoveAt(fixtureIndex);
            }
            {
                currentStage = 110;
                auto original = std::move(g_panel.hoverPreview);
                g_panel.hoverPreview = std::make_unique<vpaste::winui::HoverPreview>(
                    [](auto const &op, auto const &hash) { (void)SendRequest(op.c_str(), hash); }, [] { return true; });
                g_panel.hoverPreview->Enter(L"hover-escape", L"Text"); g_panel.hoverPreview->TestShow();
                const auto beforeHoverEscape = previewRequests.size();
                (void)SendRequest(L"dismiss");
                winrt::check_hresult(previewRequests.size() == beforeHoverEscape + 2 &&
                    requestAt(beforeHoverEscape).GetNamedString(L"op") == L"dismiss" &&
                    requestAt(beforeHoverEscape + 1).GetNamedString(L"op") == L"hoverDismiss" &&
                    !g_panel.hoverPreview->TestPending() ? S_OK : E_FAIL);
                currentStage = 111;
                const auto originalQuery = g_panel.search.Text();
                g_panel.hoverPreview->Enter(L"old-search-result", L"Text");
                g_panel.search.Text(L"hover-cancellation-regression");
                winrt::check_hresult(!g_panel.hoverPreview->TestPending() &&
                    requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"hoverDismiss" ? S_OK : E_FAIL);
                g_panel.search.Text(originalQuery); g_searchTimer.Stop();
                g_panel.hoverPreview = std::move(original);
            }
            currentStage = 112;
            {
                using namespace winrt::Microsoft::UI::Xaml;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                using namespace winrt::Windows::Data::Json;
                SetQueueViewActive(false);
                if (g_queueSelectionMode) ToggleQueueSelectionMode(false);
                SetQueueViewActive(true);
                winrt::check_hresult(g_queueSelectionMode && g_panel.history.SelectionMode() ==
                    ListViewSelectionMode::Multiple ? S_OK : E_FAIL);
                RequestHistory();
                JsonObject response = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"batch-one","itemType":"Text"},{"hash":"batch-two","itemType":"Text"}],"hasMore":false}})");
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                AddSelectedItemsToQueue();
                const auto first = requestAt(previewRequests.size() - 1);
                currentStage = 113;
                auto added = JsonObject::Parse(LR"({"op":"queueAdd","data":{"revision":500,"active":true,"busy":false,"items":[{"hash":"batch-one"}]}})");
                added.Insert(L"id", first.GetNamedValue(L"id"));
                ApplyResponse(winrt::to_string(added.Stringify()));
                winrt::check_hresult(g_queueSelectionMode && g_queueSelectedHashes.empty() &&
                    g_panel.history.SelectedItems().Size() == 0 && !g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(1));
                winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"batch-two"} &&
                    g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
                SetQueueViewActive(false);
                winrt::check_hresult(!g_queueSelectionMode ? S_OK : E_FAIL);

                currentStage = 114;
                std::uint64_t attempts = 0;
                bool throwRequest = false;
                vpaste::winui::TagManager rejected([&](auto const &, auto, auto const &) -> std::uint64_t {
                    ++attempts;
                    if (throwRequest) winrt::throw_hresult(E_ACCESSDENIED);
                    return 0;
                }, [] {});
                const auto tagRoot = rejected.Root().as<Grid>();
                g_panel.xamlSource.Content(tagRoot); ResizeIsland();
                co_await NextNativeFrame();
                const auto addRow = tagRoot.Children().GetAt(1).as<Grid>();
                const auto name = addRow.Children().GetAt(1).as<TextBox>();
                const auto add = addRow.Children().GetAt(2).as<Button>();
                name.Text(L"Keep this draft");
                co_await NextNativeFrame();
                rejected.Refresh();
                co_await NextNativeFrame();
                winrt::check_hresult(name.IsEnabled() && add.IsEnabled() && name.Text() == L"Keep this draft" &&
                    attempts == 1 && tagRoot.Children().GetAt(3).as<InfoBar>().IsOpen() ? S_OK : E_FAIL);
                throwRequest = true;
                rejected.Refresh();
                winrt::check_hresult(attempts == 2 && name.IsEnabled() && add.IsEnabled() &&
                    name.Text() == L"Keep this draft" && tagRoot.Children().GetAt(3).as<InfoBar>().IsOpen() ? S_OK : E_FAIL);
                g_panel.xamlSource.Content(g_panel.viewport); ResizeIsland();
                co_await NextNativeFrame();

                currentStage = 115;
                SetQueueViewActive(true);
                const auto originalWidth = g_panel.root.Width();
                const auto originalLanguage = g_english;
                for (const bool english : {false, true}) {
                    WindowProc(g_panel.window, kSetLanguage, english, 0);
                    for (const double width : {640.0, 960.0}) {
                        g_panel.root.Width(width);
                        const auto rootHeight = static_cast<float>(g_panel.root.ActualHeight());
                        g_panel.root.Measure({static_cast<float>(width), rootHeight});
                        g_panel.root.Arrange({0.0f, 0.0f, static_cast<float>(width), rootHeight});
                        g_panel.root.UpdateLayout();
                        co_await NextNativeFrame();
                        g_panel.root.UpdateLayout();
                        const auto bounds = g_panel.selectionBar.TransformToVisual(g_panel.root).TransformBounds(
                            {0, 0, static_cast<float>(g_panel.selectionBar.ActualWidth()), static_cast<float>(g_panel.selectionBar.ActualHeight())});
                        const auto margin = g_panel.selectionBar.Margin();
                        const bool fits = g_panel.selectionBar.IsLoaded() &&
                            g_panel.selectionBar.HorizontalAlignment() == HorizontalAlignment::Center &&
                            g_panel.selectionBar.ActualWidth() + margin.Left + margin.Right <= width &&
                            bounds.Y >= kHeaderHeight &&
                            bounds.Y + bounds.Height <= g_panel.root.ActualHeight() && g_panel.queueAdd.ActualWidth() >= 32 &&
                            g_panel.cancelSelection.ActualWidth() >= 32 && g_panel.selectionCount.Text() ==
                                (english ? L"0 selected" : L"0 条已选择");
                        if (!fits) std::fprintf(stderr,
                            "WinUI selection-bar bounds: english=%d width=%.1f root=%.1fx%.1f bounds=%.1f,%.1f %.1fx%.1f buttons=%.1f/%.1f count=%ls\n",
                            english, width, g_panel.root.ActualWidth(), g_panel.root.ActualHeight(),
                            bounds.X, bounds.Y, bounds.Width, bounds.Height,
                            g_panel.queueAdd.ActualWidth(), g_panel.cancelSelection.ActualWidth(),
                            g_panel.selectionCount.Text().c_str());
                        winrt::check_hresult(fits ? S_OK : E_FAIL);
                    }
                }
                SetQueueViewActive(false);
                g_panel.root.Width(originalWidth);
                WindowProc(g_panel.window, kSetLanguage, originalLanguage, 0);
                currentStage = 116;
                winrt::check_hresult(g_panel.addTag.Flyout().Placement() == Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft &&
                    !g_panel.addTag.Flyout().ShouldConstrainToRootBounds() &&
                    g_panel.tagFilterButton.Flyout().Placement() == Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft &&
                    !g_panel.tagFilterButton.Flyout().ShouldConstrainToRootBounds() ? S_OK : E_FAIL);
                winrt::check_hresult(g_panel.root.Children().GetAt(0).as<Grid>().BorderThickness().Bottom == 1 ? S_OK : E_FAIL);
            }
            wchar_t artifactDirectory[MAX_PATH]{};
            const auto artifactLength = GetEnvironmentVariableW(L"VPASTE_WINUI_ARTIFACT_DIR", artifactDirectory, MAX_PATH);
            if (artifactLength > 0) {
                currentStage = 30;
                winrt::check_hresult(artifactLength < MAX_PATH ? S_OK : E_INVALIDARG);
                const auto folder = co_await winrt::Windows::Storage::StorageFolder::GetFolderFromPathAsync(artifactDirectory);
                DismissFeedback();
                ConfigureAcrylicBackdrop(false);
                for (const bool english : {false, true}) {
                    const auto suffix = english ? L"-dark-en.png" : L"-light-zh.png";
                    WindowProc(g_panel.window, kSetLanguage, english, 0);
                    WindowProc(g_panel.window, kSetTheme, english ? 2 : 1, 0);
                    g_tagIds = {1, 2};
                    g_tagNames = english ? std::vector<std::wstring>{L"Work", L"Design"}
                        : std::vector<std::wstring>{L"工作", L"设计"};
                    g_tabOrder = {L"record:1", L"photos", L"record:2", L"notes"};
                    RebuildTagFilter();
                    ApplyFilters(winrt::Windows::Data::Json::JsonArray::Parse(english
                        ? LR"([{"id":"photos","name":"Photos","filter":{"itemType":"Image"}},{"id":"notes","name":"Notes","filter":{}}])"
                        : LR"([{"id":"photos","name":"照片","filter":{"itemType":"Image"}},{"id":"notes","name":"笔记","filter":{}}])"));
                    auto sampleHistory = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"op":"query","data":{"items":[
                        {"hash":"sample-notes","itemType":"Text","previewText":"会议备忘 / Meeting notes\n\n确认原生界面布局\n整理本周设计参考\n同步交互与键盘操作","appSource":"Notepad","favorite":true,"tags":[{"id":1,"name":"工作"}]},
                        {"hash":"sample-image","itemType":"Image","previewText":"设计参考.png","appSource":"Photos"},
                        {"hash":"sample-link","itemType":"Link","previewText":"Fluent Design\nhttps://fluent2.microsoft.design","appSource":"Microsoft Edge"},
                        {"hash":"sample-file","itemType":"File","previewText":"Design specification.pdf\nRelease notes.md\nREADME.md","appSource":"File Explorer"},
                        {"hash":"sample-color","itemType":"Color","previewText":"#0B86FF","appSource":"Figma"},
                        {"hash":"sample-long","itemType":"TextFile","previewText":"A clipboard shelf that stays out of the way.\n\nUse your keyboard to find, preview and paste saved content.","appSource":"Visual Studio Code"}
                    ],"hasMore":false}})");
                    RequestHistory();
                    sampleHistory.Insert(L"id", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                    ApplyResponse(winrt::to_string(sampleHistory.Stringify()));
                    co_await AwaitHistoryOffset(0);
                    const auto fixtureNow = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch()).count());
                    const wchar_t *headerColors[] = {L"#1687BF", L"#16B46A", L"#D43B31", L"#CC9900", L"#2196F3", L"#217344"};
                    std::vector<winrt::Windows::Data::Json::JsonObject> sampleDetails;
                    for (std::size_t index = 0; index < g_panel.rows.size(); ++index) {
                        auto &visual = g_panel.rows[index];
                        visual.time.Text(FormatCardTime(fixtureNow - (index + 1) * 60000, fixtureNow));
                        winrt::Windows::Data::Json::JsonObject metadata;
                        metadata.Insert(L"hash", winrt::Windows::Data::Json::JsonValue::CreateStringValue(g_hashes[index]));
                        metadata.Insert(L"titleColor", winrt::Windows::Data::Json::JsonValue::CreateStringValue(headerColors[index]));
                        const std::wstring iconPath = std::wstring{folder.Path()} + L"\\" + g_hashes[index] + L".png";
                        if (GetFileAttributesW(iconPath.c_str()) != INVALID_FILE_ATTRIBUTES) {
                            metadata.Insert(L"appIconPath", winrt::Windows::Data::Json::JsonValue::CreateStringValue(iconPath));
                        }
                        const std::wstring imagePath = std::wstring{folder.Path()} + L"\\sample preview #100%.png";
                        if (visual.itemType == L"Image" && GetFileAttributesW(imagePath.c_str()) != INVALID_FILE_ATTRIBUTES) {
                            metadata.Insert(L"assetPath", winrt::Windows::Data::Json::JsonValue::CreateStringValue(imagePath));
                            metadata.Insert(L"dimensions", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"1024 × 1024"));
                        }
                        if (index == 0) {
                            metadata.Insert(L"rich", winrt::Windows::Data::Json::JsonObject::Parse(LR"({"darkCanvas":false,"blocks":[{"runs":[{"text":"会议备忘 / Meeting notes\n","bold":true,"size":16},{"text":"确认原生界面布局\n","foreground":{"r":22,"g":135,"b":191}},{"text":"同步交互与键盘操作\n","backgroundColor":{"r":255,"g":238,"b":160}}],"rows":[]},{"runs":[],"rows":[[[{"text":"页面 / View","bold":true}],[{"text":"状态 / Status","bold":true}]],[[{"text":"主面板"}],[{"text":"开发中"}]]]}]})"));
                        } else if (visual.itemType == L"Link") {
                            metadata.Insert(L"displayTitle", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Fluent Design guidelines"));
                            metadata.Insert(L"displaySubtitle", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"https://fluent2.microsoft.design"));
                        } else if (visual.itemType == L"File") {
                            metadata.Insert(L"fileCount", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(3));
                            metadata.Insert(L"displaySubtitle", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Design specification.pdf\nRelease notes.md\nREADME.md"));
                        }
                        winrt::Windows::Data::Json::JsonObject detail;
                        g_panel.cardRequested[index] = true;
                        if (!visual.cardRequestId) RequestCardDetails(g_hashes[index]);
                        detail.Insert(L"id", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(static_cast<double>(visual.cardRequestId)));
                        detail.Insert(L"op", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"card"));
                        detail.Insert(L"data", metadata);
                        ApplyResponse(winrt::to_string(detail.Stringify()));
                        sampleDetails.push_back(detail);
                    }
                    g_panel.root.Width(1480);
                    g_panel.root.Height(kPanelHeight);
                    g_panel.root.Measure({1480, static_cast<float>(kPanelHeight)});
                    g_panel.root.Arrange({0, 0, 1480, static_cast<float>(kPanelHeight)});
                    co_await CaptureNativeView(g_panel.root, folder, winrt::hstring{L"history"} + suffix);
                    SetQueueViewActive(true);
                    g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                    g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(1));
                    co_await CaptureNativeView(g_panel.root, folder, winrt::hstring{L"history-selection"} + suffix);
                    const auto fullWidth = g_panel.root.Width();
                    g_panel.root.Width(640);
                    co_await CaptureNativeView(g_panel.root, folder, winrt::hstring{L"history-selection-narrow"} + suffix);
                    g_panel.root.Width(fullWidth);
                    SetQueueViewActive(false);
                    ShowAltHints(true);
                    co_await CaptureNativeView(g_panel.root, folder, winrt::hstring{L"history-shortcuts"} + suffix);
                    auto runtime = winrt::Windows::Data::Json::JsonObject::Parse(
                        LR"({"op":"appState","data":{"developerMode":true,"update":{"status":"ready","portable":false,"source":"direct","availableVersion":"1.7.1"}}})");
                    auto updateState = runtime.GetNamedObject(L"data").GetNamedObject(L"update");
                    updateState.Insert(L"revision", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(english ? 104 : 102));
                    ApplyResponse(winrt::to_string(runtime.Stringify()));
                    ShowAltHints(false);
                    co_await CaptureNativeView(g_panel.root, folder, winrt::hstring{L"history-app-status"} + suffix);
                    Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(g_panel.appActions->UpdateButton())
                        .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                    co_await NextNativeFrame();
                    winrt::check_hresult(g_panel.appActions->ModalOpen() ? S_OK : E_FAIL);
                    co_await CaptureNativeView(g_panel.appActions->TestDialog(), folder, winrt::hstring{L"update-confirmation"} + suffix);
                    g_panel.appActions->Deactivate();
                    for (int frame = 0; frame < 30 && !g_panel.appActions->UpdateButton().IsEnabled(); ++frame) co_await NextNativeFrame();
                    updateState.Insert(L"revision", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(english ? 105 : 103));
                    updateState.Insert(L"status", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"disabled"));
                    ApplyResponse(winrt::to_string(runtime.Stringify()));
                    ShowAltHints(false);
                    const auto sampleImage = g_panel.rows[1].image.Source().try_as<Media::Imaging::BitmapImage>();
                    if (sampleImage) winrt::check_hresult(sampleImage.PixelWidth() > 0 &&
                        g_panel.rows[1].contentIcon.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                    sampleHistory.GetNamedObject(L"data").Insert(L"highlightTerms",
                        winrt::Windows::Data::Json::JsonArray::Parse(LR"(["原生","Design","clipboard"])") );
                    RequestHistory();
                    sampleHistory.Insert(L"id", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                    ApplyResponse(winrt::to_string(sampleHistory.Stringify()));
                    co_await AwaitHistoryOffset(0);
                    for (std::size_t index = 0; index + 1 < sampleDetails.size(); ++index) {
                        g_panel.cardRequested[index] = true;
                        if (!g_panel.rows[index].cardRequestId) RequestCardDetails(g_hashes[index]);
                        sampleDetails[index].Insert(L"id", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(
                            static_cast<double>(g_panel.rows[index].cardRequestId)));
                        const auto metadata = sampleDetails[index].GetNamedObject(L"data");
                        if (index == 1) {
                            metadata.Insert(L"assetPath", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L""));
                            metadata.Insert(L"dimensions", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"24000 × 16000"));
                            metadata.Insert(L"media", winrt::Windows::Data::Json::JsonObject::Parse(
                                LR"({"format":"PNG","width":24000,"height":16000,"sourceBytes":536870912,"previewLimited":true})"));
                        } else if (index == 2) metadata.Insert(L"mediaError",
                            winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Synthetic missing thumbnail"));
                        ApplyResponse(winrt::to_string(sampleDetails[index].Stringify()));
                    }
                    g_panel.cardRequested.back() = true;
                    RequestCardDetails(g_hashes.back());
                    co_await CaptureNativeView(g_panel.root, folder, winrt::hstring{L"history-content"} + suffix);
                    SetQueueViewActive(true);
                    auto sampleQueue = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"revision":100,"busy":false,"capacity":100,"undoHash":"undo-example","items":[{"hash":"q1","itemType":"Text","previewText":"A short note ready to paste","appSource":"Notepad"},{"hash":"q2","itemType":"Link","previewText":"https://fluent2.microsoft.design","appSource":"Microsoft Edge"},{"hash":"q3","itemType":"File","previewText":"Design specification.pdf","appSource":"File Explorer"}]})");
                    // Each sample has a newer revision than the prior one.
                    sampleQueue.SetNamedValue(L"revision", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(english ? 101 : 100));
                    g_panel.queueView->SetState(sampleQueue);
                    co_await CaptureNativeView(queueRoot, folder, winrt::hstring{L"queue"} + suffix);
                    SetQueueViewActive(false);
                    SetTagManagerActive(true);
                    g_panel.tagManager->SetTags(winrt::Windows::Data::Json::JsonArray::Parse(
                        LR"([{"id":1,"name":"工作"},{"id":2,"name":"Design references"},{"id":3,"name":"稍后处理"}])"));
                    co_await CaptureNativeView(tagRoot, folder, winrt::hstring{L"tags"} + suffix);
                    const auto filterRoot = g_panel.filterEditor->TestLoad(
                        winrt::Windows::Data::Json::JsonObject::Parse(LR"({"id":"review-filter","name":"设计素材 / Design","filter":{"itemType":"Image","favorite":"any","relativeAmount":"7","relativeUnit":"day","appSources":["Photos"]}})"), english);
                    const auto sourceRequest = requestAt(previewRequests.size() - 1);
                    auto sourceResponse = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"op":"filterSources","data":{"sources":[{"source":"Photos"},{"source":"Microsoft Edge"},{"source":"Visual Studio Code"}]}})");
                    sourceResponse.Insert(L"id", sourceRequest.GetNamedValue(L"id"));
                    g_panel.filterEditor->Receive(sourceResponse);
                    g_panel.filterEditor->SetTheme(english ? ElementTheme::Dark : ElementTheme::Light);
                    Border editorHost;
                    editorHost.Background(vpaste::winui::WindowCanvasBackground());
                    editorHost.Padding(vpaste::winui::UniformThickness(12));
                    editorHost.Child(filterRoot);
                    g_panel.xamlSource.Content(editorHost);
                    // A RenderTargetBitmap is clipped by its actual island.
                    // Enlarge only this synthetic host, not the product dock.
                    const auto captureDpi = GetDpiForWindow(g_panel.window);
                    RECT editorFrame{0, 0, MulDiv(360, captureDpi, 96), MulDiv(520, captureDpi, 96)};
                    winrt::check_bool(AdjustWindowRectExForDpi(&editorFrame,
                        static_cast<DWORD>(GetWindowLongPtrW(g_panel.window, GWL_STYLE)), false,
                        static_cast<DWORD>(GetWindowLongPtrW(g_panel.window, GWL_EXSTYLE)), captureDpi));
                    winrt::check_bool(SetWindowPos(g_panel.window, nullptr, 0, 0,
                        editorFrame.right - editorFrame.left, editorFrame.bottom - editorFrame.top,
                        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE));
                    ResizeIsland();
                    co_await CaptureNativeView(editorHost, folder, winrt::hstring{L"custom-filter"} + suffix);
                    const auto recordEditor = g_panel.recordTagEditor->TestLoad(9, english ? L"📌 Work" : L"📌 工作", L"", english).as<StackPanel>();
                    g_panel.recordTagEditor->SetTheme(english ? ElementTheme::Dark : ElementTheme::Light);
                    Border recordHost; recordHost.Padding(vpaste::winui::UniformThickness(12));
                    recordHost.RequestedTheme(english ? ElementTheme::Dark : ElementTheme::Light);
                    recordHost.Background(vpaste::winui::WindowCanvasBackground()); recordHost.Child(recordEditor);
                    g_panel.xamlSource.Content(recordHost); ResizeIsland();
                    co_await CaptureNativeView(recordHost, folder, winrt::hstring{L"record-tag-editor"} + suffix);
                    const auto deleteButton = recordEditor.Children().GetAt(3).as<StackPanel>().Children().GetAt(0).as<Button>();
                    Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(deleteButton)
                        .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                    co_await NextNativeFrame();
                    co_await CaptureNativeView(recordHost, folder, winrt::hstring{L"record-tag-delete"} + suffix);
                    g_panel.recordTagEditor->Hide();
                    TextBox emojiName; emojiName.MaxLength(20); emojiName.Text(L"📌 Work");
                    auto emojiTrigger = vpaste::winui::NameEmojiButton(emojiName, english);
                    auto emojiFlyout = emojiTrigger.Flyout().as<Flyout>();
                    const auto emojiContent = emojiFlyout.Content().as<Grid>();
                    emojiFlyout.Content(nullptr);
                    emojiContent.Children().GetAt(1).as<GridView>().SelectedItem(winrt::box_value(L"📌"));
                    Border emojiPlate; emojiPlate.Width(280); emojiPlate.Padding(vpaste::winui::UniformThickness(12));
                    emojiPlate.Background(vpaste::winui::WindowCanvasBackground()); emojiPlate.Child(emojiContent);
                    StackPanel emojiFixture; emojiFixture.Spacing(8);
                    emojiFixture.RequestedTheme(english ? ElementTheme::Dark : ElementTheme::Light);
                    emojiFixture.Children().Append(emojiName); emojiFixture.Children().Append(emojiTrigger); emojiFixture.Children().Append(emojiPlate);
                    g_panel.xamlSource.Content(emojiFixture); ResizeIsland();
                    co_await CaptureNativeView(emojiPlate, folder, winrt::hstring{L"name-emoji"} + suffix);
                    vpaste::winui::Reader sampleReader([](auto const &, auto) {});
                    sampleReader.SetAppearance(english, english ? ElementTheme::Dark : ElementTheme::Light);
                    auto readerSample = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"op":"nativeReader","data":{
                        "generation":1,"kind":"text","text":"会议备忘 / Meeting notes\n\n确认原生界面布局\n整理本周设计参考\n同步交互与键盘操作\n\nA native reader that stays open while you browse.",
                        "rect":{"x":100,"y":100,"width":600,"height":360},"durationMs":0,"easing":[0.22,1,0.36,1]}})");
                    sampleReader.Receive(readerSample);
                    co_await CaptureNativeView(sampleReader.TestRoot(), folder, winrt::hstring{L"native-reader"} + suffix);
                    SetTagManagerActive(false);
                }
                WindowProc(g_panel.window, kSetLanguage, originalEnglish, 0);
                WindowProc(g_panel.window, kSetTheme, 0, 0);
                ConfigureAcrylicBackdrop(true);
                ApplyActiveLayout();
            }
            co_await vpaste::winui::TestReaderControls(currentStage);
            currentStage = 125;
            {
                auto originalHover = std::move(g_panel.hoverPreview);
                g_panel.hoverPreview = std::make_unique<vpaste::winui::HoverPreview>(
                    [](auto const &operation, auto const &hash) { (void)SendRequest(operation.c_str(), hash); },
                    [] { return true; });
                g_panel.hoverPreview->Enter(L"reader-close-fixture", L"Text");
                g_panel.hoverPreview->TestShow();
                auto sample = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"op":"nativeReader","data":{
                    "generation":1000001,"kind":"text","text":"Close returns keyboard input to the dock",
                    "rect":{"x":100,"y":100,"width":600,"height":360},"durationMs":0,"easing":[0.22,1,0.36,1]}})");
                g_panel.reader->Receive(sample);
                const auto before = previewRequests.size();
                SendMessageW(reinterpret_cast<HWND>(vpaste::winui::ReaderWindowHandle()), WM_CLOSE, 0, 0);
                winrt::check_hresult(previewRequests.size() == before + 2 &&
                    requestAt(before).GetNamedString(L"op") == L"hoverDismiss" &&
                    requestAt(before + 1).GetNamedString(L"op") == L"previewClose" &&
                    g_latestPreviewRequestId == 0 ? S_OK : E_FAIL);
                g_panel.reader->Receive(winrt::Windows::Data::Json::JsonObject::Parse(
                    LR"({"op":"nativeReaderHide","data":{"generation":1000002}})"));
                g_panel.hoverPreview = std::move(originalHover);
            }
            currentStage = 126;
            ApplyResponse(R"({"id":9000001,"op":"query","data":{"items":[{"hash":"accessibility-fixture","itemType":"Text","previewText":"Native keyboard target","favorite":true}]}})");
            co_await NextNativeFrame();
            winrt::check_hresult(g_panel.rows.size() == 1 &&
                g_panel.rows.front().favoriteButton.Width() >= 24 &&
                g_panel.rows.front().favoriteButton.Height() >= 24 ? S_OK : E_FAIL);
            currentStage = 127;
            {
                const auto normal = g_panel.rows.front().header.Background().as<Media::SolidColorBrush>().Color();
                ApplyRowTheme(true);
                const auto contrast = g_panel.rows.front().header.Background().as<Media::SolidColorBrush>().Color();
                winrt::check_hresult(normal != contrast && g_panel.rows.front().time.Opacity() == 1 &&
                    g_panel.rows.front().preview.Text() == L"Native keyboard target" ? S_OK : E_FAIL);
                ApplyRowTheme(false);
                winrt::check_hresult(g_panel.rows.front().header.Background().as<Media::SolidColorBrush>().Color() == normal ? S_OK : E_FAIL);
                const auto target = g_panel.rows.front().favoriteButton;
                winrt::check_hresult(vpaste::winui::MotionTokens().GetNamedObject(L"duration").GetNamedNumber(L"fast") == 0.18 &&
                    vpaste::winui::FadeFeedback(target, true) ? S_OK : E_FAIL);
                winrt::check_hresult(!vpaste::winui::FadeFeedback(target, false) &&
                    Hosting::ElementCompositionPreview::GetElementVisual(target).Opacity() == 1 ? S_OK : E_FAIL);
                UpdateQueueSelectionControls();
                winrt::check_hresult(Automation::AutomationProperties::GetLiveSetting(g_panel.selectionCount) ==
                    Automation::Peers::AutomationLiveSetting::Polite ? S_OK : E_FAIL);
            }
            currentStage = 128;
            {
                using namespace winrt::Windows::Data::Json;
                const auto started = std::chrono::steady_clock::now();
                vpaste::winui::RecordNativeResources("history-before");
                std::vector<winrt::weak_ref<Controls::Border>> retired;
                for (int cycle = 0; cycle < 6; ++cycle) {
                    JsonObject response, data;
                    JsonArray items;
                    for (int index = 0; index < 36; ++index) {
                        JsonObject item;
                        item.Insert(L"hash", JsonValue::CreateStringValue(L"resource-" + std::to_wstring(cycle) + L"-" + std::to_wstring(index)));
                        item.Insert(L"itemType", JsonValue::CreateStringValue(index % 2 ? L"Text" : L"Link"));
                        item.Insert(L"previewText", JsonValue::CreateStringValue(L"Synthetic history resource fixture"));
                        items.Append(item);
                    }
                    data.Insert(L"items", items);
                    response.Insert(L"id", JsonValue::CreateNumberValue(9000010 + cycle));
                    response.Insert(L"op", JsonValue::CreateStringValue(L"query"));
                    response.Insert(L"data", data);
                    ApplyResponse(winrt::to_string(response.Stringify()));
                    co_await NextNativeFrame();
                    winrt::check_hresult(g_panel.rows.size() == 36 ? S_OK : E_FAIL);
                    for (auto const &row : g_panel.rows) retired.push_back(winrt::make_weak(row.surface));
                }
                ApplyResponse(R"({"id":9000020,"op":"query","data":{"items":[]}})");
                for (int frame = 0; frame < 3; ++frame) co_await NextNativeFrame();
                winrt::check_hresult(g_panel.rows.empty() && std::none_of(retired.begin(), retired.end(),
                    [](auto const &row) { return static_cast<bool>(row.get()); }) ? S_OK : E_FAIL);
                vpaste::winui::RecordNativeResources("history-after-6x36-clear");
                std::printf("WinUI history 6x36 replace/clear: %.2f ms including render waits\n",
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count());
            }
            currentStage = 129;
            {
                using namespace winrt::Windows::Data::Json;
                const auto started = std::chrono::steady_clock::now();
                vpaste::winui::RecordNativeResources("queue-before");
                winrt::weak_ref<FrameworkElement> released;
                {
                    vpaste::winui::QueueView queue{[](auto const &, auto const &, auto const &) { return std::uint64_t{1}; }, [] {}};
                    const auto root = queue.Root().as<Controls::Grid>();
                    released = winrt::make_weak(queue.Root());
                    g_panel.xamlSource.Content(root); ResizeIsland();
                    JsonObject state;
                    JsonArray items;
                    for (int index = 0; index < 100; ++index) {
                        JsonObject item;
                        item.Insert(L"hash", JsonValue::CreateStringValue(L"queue-resource-" + std::to_wstring(index)));
                        item.Insert(L"previewText", JsonValue::CreateStringValue(L"Synthetic queue resource fixture"));
                        items.Append(item);
                    }
                    state.Insert(L"items", items);
                    for (int cycle = 0; cycle < 6; ++cycle) {
                        state.Insert(L"revision", JsonValue::CreateNumberValue(cycle + 1));
                        queue.SetState(state);
                        co_await NextNativeFrame();
                        winrt::check_hresult(root.Children().GetAt(1).as<Controls::ScrollViewer>()
                            .Content().as<Controls::StackPanel>().Children().Size() == 100 ? S_OK : E_FAIL);
                    }
                    queue.Deactivate();
                    g_panel.xamlSource.Content(g_panel.viewport); ResizeIsland();
                }
                for (int frame = 0; frame < 3; ++frame) co_await NextNativeFrame();
                winrt::check_hresult(!released.get() ? S_OK : E_FAIL);
                vpaste::winui::RecordNativeResources("queue-after-6x100-destroy");
                std::printf("WinUI queue 6x100 refresh/destroy: %.2f ms including render waits\n",
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count());
            }
            currentStage = 130;
            {
                using namespace winrt::Windows::Data::Json;
                for (std::uint32_t index = 0; index < g_panel.filter.Items().Size(); ++index) {
                    const auto expectedVisibility = index < 2
                        ? winrt::Microsoft::UI::Xaml::Visibility::Visible
                        : winrt::Microsoft::UI::Xaml::Visibility::Collapsed;
                    winrt::check_hresult(g_panel.filter.Items().GetAt(index).Visibility() ==
                        expectedVisibility ? S_OK : E_FAIL);
                }
                RequestHistory();
                JsonObject response = JsonObject::Parse(
                    LR"({"op":"query","data":{"items":[{"hash":"presenter-chrome","itemType":"Text"}],"hasMore":false}})");
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
                co_await NextNativeFrame();
                g_panel.root.UpdateLayout();
                const auto container = g_panel.history.ContainerFromIndex(0);
                const auto presenter = FindHistoryChild<winrt::Microsoft::UI::Xaml::Controls::Primitives::ListViewItemPresenter>(container);
                winrt::check_hresult(presenter && !presenter.SelectionIndicatorVisualEnabled() &&
                    presenter.SelectionCheckMarkVisualEnabled() ? S_OK : E_FAIL);
                const auto isTransparent = [](winrt::Microsoft::UI::Xaml::Media::Brush const &brush) {
                    const auto solid = brush.try_as<winrt::Microsoft::UI::Xaml::Media::SolidColorBrush>();
                    return solid && solid.Color().A == 0;
                };
                winrt::check_hresult(isTransparent(presenter.Background()) &&
                    isTransparent(presenter.PointerOverBackground()) &&
                    isTransparent(presenter.SelectedBackground()) &&
                    isTransparent(presenter.SelectedPointerOverBackground()) &&
                    isTransparent(presenter.SelectedPressedBackground()) ? S_OK : E_FAIL);
                const auto previousSelection = g_selectedHash;
                g_selectedHash = g_hashes[0];
                ApplyRowTheme(false);
                const auto thickness = g_panel.rows[0].surface.BorderThickness();
                const auto radius = g_panel.rows[0].surface.CornerRadius();
                const auto outline = g_panel.rows[0].outline;
                winrt::check_hresult(thickness.Left == 1 && thickness.Top == 1 &&
                    radius.TopLeft == kCardRadius && outline.CornerRadius().TopLeft == kCardRadius &&
                    outline.BorderThickness().Left == 2 && outline.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
                currentStage = 131;
                ApplyRowTheme(true);
                const auto contrastThickness = g_panel.rows[0].surface.BorderThickness();
                winrt::check_hresult(presenter.SelectionIndicatorVisualEnabled() &&
                    presenter.SelectionCheckMarkVisualEnabled() && contrastThickness.Left == 1 &&
                    !isTransparent(presenter.SelectedBackground()) ? S_OK : E_FAIL);
                g_selectedHash = previousSelection;
                ApplyRowTheme(false);
                winrt::check_hresult(!presenter.SelectionIndicatorVisualEnabled() &&
                    isTransparent(presenter.SelectedBackground()) ? S_OK : E_FAIL);
            }
            completion->set_value({S_OK, 131});
        } catch (...) {
            completion->set_value({winrt::to_hresult(), currentStage});
        }
}

winrt::fire_and_forget RunNativeShellRegression(
    std::shared_ptr<std::promise<std::pair<HRESULT, std::uint32_t>>> completion) {
    std::uint32_t stage = 1;
    try {
        using namespace winrt::Microsoft::UI::Xaml;
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        using namespace winrt::Windows::Data::Json;
        struct RestoreRequest {
            PanelRequest previous = g_request;
            ~RestoreRequest() { g_request = previous; }
        } restoreRequest;
        static std::vector<std::string> requests;
        requests.clear();
        g_request = +[](const std::uint8_t *data, std::size_t length) {
            requests.emplace_back(reinterpret_cast<const char *>(data), length);
        };
        const auto search = g_panel.search.try_as<AutoSuggestBox>();
        winrt::check_hresult(search && search.QueryIcon() ? S_OK : E_FAIL);
        search.Visibility(Visibility::Visible);
        co_await NextNativeFrame();
        const auto editor = FindHistoryChild<TextBox>(search);
        winrt::check_hresult(editor && MainInputArea(editor) == vpaste::winui::InputArea::Search &&
            !NativeControlOwnsKeys(editor) ? S_OK : E_FAIL);
        editor.Focus(FocusState::Programmatic);
        editor.Text(L"latest typed query");
        HandleMainKey({.key=VK_RETURN, .area=vpaste::winui::InputArea::Search});
        stage = 11;
        winrt::check_hresult(!requests.empty() &&
            JsonObject::Parse(winrt::to_hstring(requests.back())).GetNamedString(L"query") == L"latest typed query" &&
            g_searchSubmitRequestId == g_latestQueryId ? S_OK : E_FAIL);
        const auto submitted = g_searchSubmitRequestId;
        co_await NextNativeFrame();
        co_await NextNativeFrame();
        winrt::check_hresult(g_searchSubmitRequestId == submitted ? S_OK : E_FAIL);
        const auto beforeComposition = requests.size();
        HandleMainKey({.key=VK_RETURN, .composing=true, .area=vpaste::winui::InputArea::Search});
        winrt::check_hresult(requests.size() == beforeComposition ? S_OK : E_FAIL);
        const auto clear = FindHistoryChild<Button>(editor);
        stage = 12;
        winrt::check_hresult(clear && NativeControlOwnsKeys(clear) ? S_OK : E_FAIL);
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(clear)
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
        co_await NextNativeFrame();
        winrt::check_hresult(SearchText().empty() && editor.Text().empty() &&
            g_searchSubmitRequestId == 0 ? S_OK : E_FAIL);
        search.Text(L"Escape test");
        stage = 13;
        HandleMainKey({.key=VK_ESCAPE, .area=vpaste::winui::InputArea::Search, .searchHasText=true});
        winrt::check_hresult(search.Text().empty() && search.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
        HandleMainKey({.key=VK_ESCAPE, .area=vpaste::winui::InputArea::Search});
        winrt::check_hresult(search.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
        g_searchTimer.Stop();
        stage = 2;
        RequestHistory();
        auto response = JsonObject::Parse(
            LR"({"op":"query","data":{"items":[{"hash":"shell-parity","itemType":"Text","previewText":"Clipboard card"}],"hasMore":false}})");
        response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
        ApplyResponse(winrt::to_string(response.Stringify()));
        co_await NextNativeFrame();
        const auto container = g_panel.history.ContainerFromIndex(0).as<ListViewItem>();
        ApplyRowTheme(false);
        winrt::check_hresult(!container.UseSystemFocusVisuals() &&
            g_panel.rows[0].surface.Shadow() && g_panel.rows[0].surface.Translation().z > 0 ? S_OK : E_FAIL);
        const auto bodyPosition = g_panel.rows[0].body.TransformToVisual(g_panel.root).TransformPoint({0, 0});
        g_selectedHash.clear(); ApplyRowTheme(false); g_panel.root.UpdateLayout();
        const auto unselectedPosition = g_panel.rows[0].body.TransformToVisual(g_panel.root).TransformPoint({0, 0});
        winrt::check_hresult(bodyPosition == unselectedPosition && g_panel.rows[0].surface.BorderThickness().Left == 1 ? S_OK : E_FAIL);
        g_selectedHash = g_hashes[0]; ApplyRowTheme(false);
        const auto outline = g_panel.rows[0].outline;
        winrt::check_hresult(outline.Visibility() == Visibility::Visible &&
            outline.CornerRadius().TopLeft == kCardRadius && outline.BorderThickness().Left == 2 &&
            !outline.IsHitTestVisible() ? S_OK : E_FAIL);
        ApplyRowTheme(true);
        winrt::check_hresult(container.UseSystemFocusVisuals() && !g_panel.rows[0].surface.Shadow() &&
            outline.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
        ApplyRowTheme(false);
        stage = 3;
        WindowProc(g_panel.window, WM_ACTIVATE, WA_INACTIVE, 0);
        winrt::check_hresult(!requests.empty() &&
            JsonObject::Parse(winrt::to_hstring(requests.back())).GetNamedString(L"op") == L"panelBlur" ? S_OK : E_FAIL);
        stage = 4;
        const auto commands = g_panel.commands.PrimaryCommands();
        winrt::check_hresult(commands.Size() == 4 && commands.GetAt(0) == g_panel.appActions->ToolsButton() &&
            commands.GetAt(1) == g_panel.queueOpen && commands.GetAt(2) == g_panel.settings &&
            commands.GetAt(3) == g_panel.appActions->UpdateButton() &&
            g_panel.filterStrip.Children().GetAt(g_panel.filterStrip.Children().Size() - 1) == g_panel.addTag ? S_OK : E_FAIL);
        stage = 5;
        const winrt::apartment_context ui;
        for (int tick = 0; tick < 60 && g_panel.dockMotion->Running(); ++tick) {
            co_await winrt::resume_after(std::chrono::milliseconds(16)); co_await ui;
        }
        RECT outer{}, client{};
        winrt::check_bool(GetWindowRect(g_panel.window, &outer) && GetClientRect(g_panel.window, &client));
        winrt::check_hresult((GetWindowLongPtrW(g_panel.window, GWL_STYLE) & WS_THICKFRAME) &&
            outer.right - outer.left == client.right && outer.bottom - outer.top == client.bottom &&
            g_panel.header.Shadow() && g_panel.searchButton.Shadow() && g_panel.rows[0].tagChip.Shadow() ? S_OK : E_FAIL);
        stage = 6;
        if (vpaste::winui::NativeAnimationsEnabled()) {
            SetVisible(false);
            // A normal dismiss must stay mapped until its slide finishes.
            winrt::check_hresult(IsWindowVisible(g_panel.window) ? S_OK : E_FAIL);
            for (int tick = 0; tick < 60 && IsWindowVisible(g_panel.window); ++tick) {
                co_await winrt::resume_after(std::chrono::milliseconds(16)); co_await ui;
            }
            winrt::check_bool(!IsWindowVisible(g_panel.window));
            RECT parked{}; winrt::check_bool(GetWindowRect(g_panel.window, &parked));
            winrt::check_hresult(EqualRect(&outer, &parked) ? S_OK : E_FAIL);
            SetVisible(true, false);
        }
        stage = 7;
        const auto searchIcon = g_panel.searchButton.Content().try_as<FontIcon>();
        winrt::check_hresult(searchIcon && searchIcon.FontSize() == 16 ? S_OK : E_FAIL);
        stage = 8;
        SetQueueViewActive(true);
        const auto queueHandle = g_panel.queueWindow->Handle();
        const auto beforeFocus = GetForegroundWindow();
        winrt::check_bool(SetWindowPos(queueHandle, nullptr, -30000, -30000, 0, 0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE));
        SendMessageW(queueHandle, WM_DISPLAYCHANGE, 0, 0);
        RECT queueBounds{}; winrt::check_bool(GetWindowRect(queueHandle, &queueBounds));
        const auto fitted = vpaste::winui::FitToMonitorWorkArea(queueBounds);
        winrt::check_hresult(EqualRect(&queueBounds, &fitted) && GetForegroundWindow() == beforeFocus ? S_OK : E_FAIL);
        SetQueueViewActive(false);
        stage = 9;
        // Keep valid user placement; a work-area notification must not center
        // the queue again or steal the paste target's foreground activation.
        const auto preserved = queueBounds;
        SendMessageW(queueHandle, WM_SETTINGCHANGE, SPI_SETWORKAREA, 0);
        winrt::check_bool(GetWindowRect(queueHandle, &queueBounds));
        winrt::check_hresult(EqualRect(&preserved, &queueBounds) && GetForegroundWindow() == beforeFocus ? S_OK : E_FAIL);
        stage = 10;
        if (vpaste::winui::NativeAnimationsEnabled()) {
            SetVisible(true, false, false);
            SetVisible(false);
            co_await winrt::resume_after(std::chrono::milliseconds(32)); co_await ui;
            PanelLayout snapshot{};
            winrt::check_hresult(vpaste_winui_get_layout(&snapshot));
            RECT moving{}; winrt::check_bool(GetWindowRect(g_panel.window, &moving));
            winrt::check_hresult(snapshot.y == g_dockedLayout.y && moving.top > snapshot.y &&
                snapshot.screenScale == g_dockedLayout.screenScale ? S_OK : E_FAIL);
            SetVisible(true, false);
            for (int tick = 0; tick < 60 && g_panel.dockMotion->Running(); ++tick) {
                co_await winrt::resume_after(std::chrono::milliseconds(16)); co_await ui;
            }
            winrt::check_bool(GetWindowRect(g_panel.window, &moving));
            winrt::check_hresult(PanelVisible() && moving.top == g_dockedLayout.y ? S_OK : E_FAIL);
        }
        stage = 11;
        SetVisible(false, true, false);
        winrt::check_hresult(!IsWindowVisible(g_panel.window) && !g_panel.dockMotion->Running() ? S_OK : E_FAIL);
        g_panel.dockMotion->SetVisible(true, true, false);
        winrt::check_hresult(IsWindowVisible(g_panel.window) && !g_panel.dockMotion->Running() ? S_OK : E_FAIL);
        g_panel.dockMotion->SetVisible(false, true, false);
        winrt::check_hresult(!IsWindowVisible(g_panel.window) && !g_panel.dockMotion->Running() ? S_OK : E_FAIL);
        SetVisible(true, false, false);
        stage = 12;
        const auto originalLayout = g_dockedLayout;
        SetVisible(false);
        auto replacementLayout = originalLayout; replacementLayout.x += 24;
        winrt::check_hresult(vpaste_winui_set_layout(&replacementLayout));
        winrt::check_hresult(!IsWindowVisible(g_panel.window) && !g_panel.dockMotion->Running() ? S_OK : E_FAIL);
        winrt::check_hresult(vpaste_winui_set_layout(&originalLayout));
        SetVisible(true, false, false);
        stage = 13;
        for (const auto scale : {1.0, 1.5, 2.0}) {
            const RECT work{static_cast<LONG>(-1920 * scale), static_cast<LONG>(-200 * scale), 0, static_cast<LONG>(840 * scale)};
            const RECT outside{work.right - 100, work.bottom - 50, work.right + 260, work.bottom + 398};
            const auto inside = vpaste::winui::ClampToWorkArea(outside, work);
            const auto again = vpaste::winui::ClampToWorkArea(inside, work);
            winrt::check_hresult(inside.left >= work.left && inside.top >= work.top && inside.right <= work.right &&
                inside.bottom <= work.bottom && inside.right - inside.left == 360 && inside.bottom - inside.top == 448 &&
                EqualRect(&inside, &again) ? S_OK : E_FAIL);
        }
        stage = 14;
        g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(1));
        co_await NextNativeFrame(); co_await NextNativeFrame();
        const auto selectedTab = g_panel.filter.SelectedItem();
        const auto selectedBounds = selectedTab.TransformToVisual(g_panel.tabIndicatorHost).TransformBounds(
            {0, 0, static_cast<float>(selectedTab.ActualWidth()), static_cast<float>(selectedTab.ActualHeight())});
        const auto indicatorBounds = g_panel.tabIndicator->Target();
        winrt::check_hresult(std::abs(indicatorBounds.X - selectedBounds.X) < 0.5 &&
            std::abs(indicatorBounds.Width - selectedBounds.Width) < 0.5 &&
            selectedTab.FontSize() == vpaste::winui::TabFontSize &&
            selectedTab.Icon().as<FontIcon>().FontSize() == 16 ? S_OK : E_FAIL);
        const auto spring = vpaste::winui::SelectionSpring(
            Hosting::ElementCompositionPreview::GetElementVisual(g_panel.tabIndicatorHost).Compositor());
        winrt::check_hresult(spring.DampingRatio() > 0.8f && spring.DampingRatio() <= 1.0f &&
            spring.Period() > std::chrono::milliseconds(200) && spring.Period() < std::chrono::milliseconds(320) ? S_OK : E_FAIL);
        const auto indicatorColor = g_panel.tabIndicatorHost.BorderBrush().as<Media::SolidColorBrush>().Color();
        g_panel.tabIndicator->Move(selectedBounds, indicatorColor, true, false);
        const auto line = g_panel.tabIndicator->TestGeometry();
        winrt::check_hresult(std::abs(line.Offset().x - (selectedBounds.X + 10)) < 0.5 &&
            std::abs(line.Size().x - (selectedBounds.Width - 20)) < 0.5 ? S_OK : E_FAIL);
        stage = 15;
        RECT changedDpi{originalLayout.x + 24, originalLayout.y, originalLayout.x + 24 + originalLayout.width,
            originalLayout.y + originalLayout.height};
        WindowProc(g_panel.window, WM_DPICHANGED, MAKEWPARAM(144, 144), reinterpret_cast<LPARAM>(&changedDpi));
        PanelLayout pending{}; winrt::check_hresult(vpaste_winui_get_layout(&pending));
        winrt::check_hresult(g_layoutPending && pending.x == changedDpi.left && pending.y == changedDpi.top ? S_OK : E_FAIL);
        winrt::check_hresult(vpaste_winui_set_layout(&originalLayout));
        winrt::check_hresult(!g_layoutPending && g_panel.root.Width() == originalLayout.width /
            (originalLayout.screenScale * originalLayout.panelScale) ? S_OK : E_FAIL);
        completion->set_value({S_OK, stage});
    } catch (...) { completion->set_value({winrt::to_hresult(), stage}); }
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_test_shell_parity(std::uint32_t *stage) noexcept {
    if (!stage || !g_dispatcher) return E_INVALIDARG;
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([completion] { RunNativeShellRegression(completion); })) return E_FAIL;
    if (result.wait_for(std::chrono::seconds(15)) != std::future_status::ready) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    const auto [status, completedStage] = result.get(); *stage = completedStage;
    return status;
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_test_history_and_queue(
    std::uint32_t *stage) noexcept {
    if (!stage || !g_dispatcher) return E_INVALIDARG;
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    // A captured coroutine lambda would outlive its dispatcher closure at the
    // first render await. The named coroutine owns its promise parameter instead.
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([completion] {
        RunNativePresentationRegression(completion);
    })) return E_FAIL;
    if (result.wait_for(std::chrono::seconds(60)) != std::future_status::ready) {
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    const auto [status, completedStage] = result.get();
    *stage = completedStage;
    return status;
}
// Route real window messages through WinUI rather than calling HandlePreviewKey.
// This stays inside the synthetic test window: no SendInput or global keys.
extern "C" __declspec(dllexport) int32_t vpaste_winui_test_preview_key_route(
    std::uint32_t *stage) noexcept {
    if (!stage || !g_dispatcher) return E_INVALIDARG;
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([completion] {
        static std::vector<std::string> requests;
        static winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer timer{nullptr};
        const auto previous = g_request;
        std::uint32_t currentStage = 1;
        try {
            ApplyResponse(R"({"id":1000,"op":"query","data":{"items":[{"hash":"key-route-test","previewText":"Synthetic keyboard test"}]}})");
            g_panel.root.UpdateLayout();
            WindowProc(g_panel.window, kFocusHistory, 0, 0);
            if (GetForegroundWindow() != g_panel.window) {
                completion->set_value({S_FALSE, 0});
                return;
            }
            requests.clear();
            g_request = +[](const std::uint8_t *bytes, std::size_t size) {
                requests.emplace_back(reinterpret_cast<const char *>(bytes), size);
            };
            timer = g_dispatcher.DispatcherQueue().CreateTimer();
            timer.Interval(std::chrono::milliseconds(150));
            timer.IsRepeating(true);
            timer.Tick([completion, previous, posted = false](auto const &sender, auto const &) mutable {
                try {
                    if (!posted) {
                        // Yield to the input/focus queue before posting keys.
                        if (GetForegroundWindow() != g_panel.window) {
                            sender.Stop();
                            g_request = previous;
                            timer = nullptr;
                            completion->set_value({S_FALSE, 0});
                            return;
                        }
                        const auto focused = winrt::Microsoft::UI::Xaml::Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot());
                        const auto target = GetFocus();
                        if (!focused || !target || !IsChild(g_panel.window, target)) std::fprintf(stderr,
                            "WinUI posted-key focus: loaded=%d focusState=%d element=%d child=%d\n",
                            g_panel.history.IsLoaded(), static_cast<int>(g_panel.history.FocusState()),
                            static_cast<bool>(focused), target && IsChild(g_panel.window, target));
                        winrt::check_hresult(focused ? S_OK : E_FAIL);
                        winrt::check_hresult(target && IsChild(g_panel.window, target) ? S_OK : E_FAIL);
                        const LPARAM first = 1 | (static_cast<LPARAM>(MapVirtualKeyW(VK_SPACE, MAPVK_VK_TO_VSC)) << 16);
                        winrt::check_bool(PostMessageW(target, WM_KEYDOWN, VK_SPACE, first));
                        winrt::check_bool(PostMessageW(target, WM_KEYDOWN, VK_SPACE, first | (LPARAM{1} << 30)));
                        winrt::check_bool(PostMessageW(target, WM_KEYUP, VK_SPACE, first | (LPARAM{1} << 30) | (LPARAM{1} << 31)));
                        posted = true;
                        return;
                    }
                    const auto toggles = std::count_if(requests.begin(), requests.end(), [](const auto &request) {
                        return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(request))
                            .GetNamedString(L"op") == L"previewToggle";
                    });
                    sender.Stop();
                    g_request = previous;
                    completion->set_value({toggles == 1 ? S_OK : E_FAIL, 3});
                } catch (...) {
                    sender.Stop();
                    g_request = previous;
                    completion->set_value({winrt::to_hresult(), posted ? 3 : 2});
                }
                timer = nullptr;
            });
            timer.Start();
        } catch (...) {
            g_request = previous;
            if (timer) timer.Stop();
            timer = nullptr;
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
