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
#ifdef _DEBUG
#include <crtdbg.h>
#endif
#include <objbase.h>
#include <shobjidl.h>
#include <shlobj.h>
#include <shellapi.h>
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
#include <winrt/Microsoft.UI.Xaml.Media.Animation.h>
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
#include "WinUiTrayWindow.h"
#include "WinUiTagManager.h"
#include "WinUiFilterEditor.h"
#include "WinUiNameEmoji.h"
#include "WinUiAppearance.h"
#include "WinUiMenuFocus.h"
#include "WinUiRichContent.h"
#include "WinUiDrag.h"
#include "WinUiCardActions.h"
#include "WinUiKeyboard.h"
#include "WinUiHistoryViewport.h"
#include "WinUiRecordTagEditor.h"
#include "WinUiCardContent.h"
#include "WinUiAppActions.h"
#include "WinUiHeaderArtwork.h"
#include "WinUiCardPreview.h"
#include "WinUiHoverPreview.h"
#include "WinUiReader.h"
#include "WinUiOnboarding.h"
#include "WinUiMotion.h"
#include "WinUiDockMotion.h"
#include "WinUiGeometry.h"
#include "WinUiTabIndicator.h"
#include "WinUiBridge.h"
#include "WinUiDiagnostics.h"
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
#include <set>
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
constexpr LPARAM kPreviewFocusReturn = 1;
constexpr UINT kSetLayout = WM_APP + 15;
constexpr UINT kSetBehavior = WM_APP + 16;
constexpr UINT kSyncHistoryViewport = WM_APP + 17;
constexpr UINT kGetLayout = WM_APP + 18;
constexpr UINT kSetPreviewLayout = WM_APP + 19;
constexpr UINT kSetSizePreview = WM_APP + 20;

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
    winrt::Microsoft::UI::Xaml::Controls::TextBlock gifBadge{nullptr};
    winrt::hstring summary;
    winrt::Microsoft::UI::Xaml::FrameworkElement frame{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border richBadgeFrame{nullptr}, gifBadgeFrame{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border imageMatte{nullptr};
    bool linkIcon = false;
    winrt::Microsoft::UI::Xaml::Controls::Border filePresentation{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border dimensionsFrame{nullptr};
    winrt::Windows::Data::Json::JsonObject fileData{nullptr};
    std::optional<bool> filePresentationDark;
    winrt::Microsoft::UI::Xaml::Controls::Border fileInvalidBadge{nullptr};
    winrt::hstring visualType;
    std::shared_ptr<vpaste::winui::AutoScrollCardPreview> autoPreview, richAutoPreview;
    std::shared_ptr<vpaste::winui::CardRecordTags> recordTags;
    bool isRichText = false;
    bool favorite = false;
    winrt::Microsoft::UI::Xaml::Controls::MenuFlyout contextMenu{nullptr};
    winrt::Windows::Data::Json::JsonObject pendingMenuActions{nullptr};
};

struct Panel {
    HWND window = nullptr;
    std::unique_ptr<vpaste::winui::DockMotion> dockMotion;
    winrt::Microsoft::UI::Xaml::Controls::Grid root{nullptr};
    std::shared_ptr<vpaste::winui::MenuOpeningInput> menuInput;
    winrt::Microsoft::UI::Xaml::Controls::Grid header{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Grid shadowReceiver{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Viewbox viewport{nullptr};
    winrt::Microsoft::UI::Xaml::Hosting::WindowsXamlManager xamlManager{nullptr};
    winrt::Microsoft::UI::Xaml::Hosting::DesktopWindowXamlSource xamlSource{nullptr};
    winrt::Microsoft::UI::Xaml::Media::SolidColorBrush windowCanvas{nullptr};
    bool hasSystemBackdrop = false;
    winrt::Microsoft::UI::Xaml::Controls::TextBox search{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Grid searchField{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::TextBox::TextChanging_revoker searchChanging;
    winrt::Microsoft::UI::Xaml::Controls::TextBox::TextCompositionStarted_revoker searchCompositionStarted;
    winrt::Microsoft::UI::Xaml::Controls::TextBox::TextCompositionEnded_revoker searchCompositionEnded;
    winrt::Microsoft::UI::Xaml::Controls::Button searchButton{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::StackPanel commands{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::SelectorBar filter{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::ScrollViewer filterScroll{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::StackPanel filterStrip{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border tabIndicatorHost{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Border tabDropMarker{nullptr};
    std::unique_ptr<vpaste::winui::TabIndicator> tabIndicator;
    winrt::weak_ref<winrt::Microsoft::UI::Xaml::Controls::SelectorBarItem> indicatorSelection;
    winrt::Microsoft::UI::Xaml::Controls::SelectorBar customTabs{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button addTag{nullptr};
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
    winrt::Microsoft::UI::Xaml::Controls::InfoBar feedback{nullptr}, staleHistory{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button queueAdd{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button queueOpen{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button settings{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::Button more{nullptr};
    std::unique_ptr<vpaste::winui::QueueView> queueView;
    std::unique_ptr<vpaste::winui::QueueWindow> queueWindow;
    std::unique_ptr<vpaste::winui::TrayWindow> trayWindow;
    std::unique_ptr<vpaste::winui::Reader> reader;
    std::unique_ptr<vpaste::winui::Reader> textEditor;
    std::unique_ptr<vpaste::winui::OnboardingView> onboarding;
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
bool g_searchComposing = false;
void ScheduleHistoryFocus(WPARAM wparam = 0);
winrt::Microsoft::UI::Xaml::ElementTheme EffectivePanelTheme(
    winrt::Microsoft::UI::Xaml::ElementTheme requested) noexcept;
std::uint64_t g_latestHoverRequestId = 0;
int g_searchSubmitIndex = 0;
std::wstring g_submitSelectedHash;
bool g_searchSubmitPlain = false, g_searchSubmitQuick = false;
vpaste::winui::PanelBehavior g_behavior;
bool g_altHints = false;
struct HistoryViewState {
    struct Restore { double offset; std::uint64_t request; bool applied = false; };
    vpaste::winui::HistoryQuery visibleQuery, requestedQuery;
    winrt::hstring renderedItems;
    std::optional<Restore> restore;
    std::optional<vpaste::winui::HistoryQuery> removedTabFallback;
    std::optional<std::pair<std::uint64_t, std::uint64_t>> lastAutoCursor;
    // Text changes retire in-flight requests before the next debounce dispatches.
    std::uint64_t visibleQueryId = 0, discardThrough = 0;
    double parkedOffset = 0;
    bool resetOnShow = false, pageFailed = false;
} g_historyView;
std::optional<winrt::event_token> g_historyVerifyToken;
winrt::Microsoft::UI::Xaml::Application::UnhandledException_revoker g_unhandledExceptionRevoker;
vpaste::winui::DiagnosticsLogger g_diagnostics;
vpaste::winui::PowerLifecycleTracker g_powerLifecycle;

void LogWinUiDiagnostic(std::string_view eventName, std::string_view details) noexcept {
    (void)g_diagnostics.WriteLine(eventName, details);
}

void LogWinUiError(
    const char *context,
    HRESULT code,
    std::string_view rawMessage = {}) noexcept {
    try {
        const auto snapshot = g_powerLifecycle.Snapshot(GetTickCount64());
        const auto cleanMessage = vpaste::winui::SanitizeDiagnosticText(rawMessage);
        char buffer[512]{};
        const int len = std::snprintf(
            buffer, sizeof(buffer),
            "context=%s hr=0x%08X visible=%d tagManager=%d acrylic=%d suspendCount=%llu resumeCount=%llu pendingResumeShow=%d sinceResumeMs=%llu msg=\"%s\"",
            context ? context : "unknown",
            static_cast<unsigned>(code),
            PanelVisible() ? 1 : 0,
            g_panel.tagManagerViewActive ? 1 : 0,
            g_panel.hasSystemBackdrop ? 1 : 0,
            static_cast<unsigned long long>(snapshot.suspendCount),
            static_cast<unsigned long long>(snapshot.resumeCount),
            snapshot.pendingFirstShow ? 1 : 0,
            static_cast<unsigned long long>(snapshot.elapsedSinceResumeMs),
            cleanMessage.c_str());
        if (len > 0) {
            LogWinUiDiagnostic("winui_error", std::string_view(buffer, static_cast<std::size_t>(len)));
        }
    } catch (...) {}
}

void LogPowerResumeFirstShow(vpaste::winui::PowerResumeContext const &context, bool freshShow) noexcept {
    try {
        char buffer[384]{};
        const int len = std::snprintf(
            buffer, sizeof(buffer),
            "suspendCount=%llu resumeCount=%llu sleepMs=%llu sinceResumeMs=%llu resumeKind=%s freshShow=%d tagManager=%d acrylic=%d",
            static_cast<unsigned long long>(context.suspendCount),
            static_cast<unsigned long long>(context.resumeCount),
            static_cast<unsigned long long>(context.sleepDurationMs),
            static_cast<unsigned long long>(context.elapsedSinceResumeMs),
            context.userResume ? "user" : "automatic",
            freshShow ? 1 : 0,
            g_panel.tagManagerViewActive ? 1 : 0,
            g_panel.hasSystemBackdrop ? 1 : 0);
        if (len > 0) {
            LogWinUiDiagnostic("power_resume_first_show", std::string_view(buffer, static_cast<std::size_t>(len)));
        }
    } catch (...) {}
}

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
struct CardTarget {
    std::wstring hash;
    std::uint64_t recordId;
};
HistoryRowVisual *FindCard(const std::wstring &hash);
std::uint64_t g_textEditorOpenRequest = 0;
std::optional<CardTarget> g_textEditorRequestedCard, g_textEditorOrigin;
bool g_textEditorRefreshAfterSave = false;
struct TextEditorReturn {
    CardTarget target;
    vpaste::winui::HistoryQuery query;
    std::wstring selection;
};
std::optional<TextEditorReturn> g_textEditorReturnAfterQuery;
struct QueuePreviewFocus {
    CardTarget target;
    std::uint64_t request, generation = 0;
    bool ready = false, closed = false;
};
std::optional<QueuePreviewFocus> g_queuePreviewFocus;
std::optional<CardTarget> g_recordTagAssignmentTarget;
bool g_queueViewActive = false;
bool g_deleteConfirmationOpen = false;
bool g_applyingLayout = false;
bool g_layoutPending = false;
bool g_sizePreviewActive = false;
bool g_sizePreviewRestoreHitTestVisible = true;
bool g_historyRefreshAfterDrag = false;
bool g_suppressDragTap = false;
PanelLayout g_dockedLayout{0, 0, kWindowWidth, static_cast<int>(kPanelHeight), 1, 1};
std::uint32_t g_themeMode = 0;
std::uint64_t g_requestId = 0;
std::uint64_t g_latestQueryId = 0;
std::uint64_t g_latestHistoryRequestId = 0;
std::uint64_t g_latestTagsRequestId = 0;
bool g_recordTagsLoaded = false;
bool g_recordTagsFailed = false;
std::set<std::uint64_t> g_cardTagRequests;
std::uint64_t g_latestFiltersRequestId = 0;
std::vector<winrt::Windows::Data::Json::JsonObject> g_customFilters;
std::optional<std::vector<winrt::Windows::Data::Json::JsonObject>> g_tutorialPreviewFilters;
std::vector<std::wstring> g_tabOrder, g_dynamicIds;
std::uint64_t g_tabOrderLoadRequest = 0;
std::uint64_t g_tabOrderSaveRequest = 0, g_editorGeneration = 0;
std::uint64_t g_tabDeleteRequest = 0;
std::wstring g_tabDeleteOperation;
winrt::hstring g_renderedDynamicTabs;
struct TabDropPreview {
    std::wstring source, target;
    bool before = false;
    std::vector<winrt::Windows::Foundation::Rect> bounds;
} g_tabDrop;
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
#ifdef _DEBUG
std::chrono::steady_clock::time_point g_queryStarted;
#endif
constexpr std::chrono::milliseconds kLoadingIndicatorDelay{250};
winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer g_searchTimer{nullptr};
winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer g_feedbackTimer{nullptr};
winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer g_loadingTimer{nullptr};

bool IsHistorySearching();
void SetLoadingIndicatorVisible(bool visible);
void HideLoadingIndicator();
winrt::Microsoft::UI::Xaml::Controls::MenuFlyout EnsureCardContextMenu(
    HistoryRowVisual &row, std::wstring const &hash);

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

void UpdateCategoryShortcutHints(bool visible);

void PrepareTabTemplate(winrt::Microsoft::UI::Xaml::Controls::SelectorBarItem const &tab) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    tab.ApplyTemplate();
    const auto root = Media::VisualTreeHelper::GetChild(tab, 0).try_as<Grid>();
    if (!root) return;
    // Transparent space is interactive too, including the native template's
    // padding above/below its text and icon.
    root.Background(Media::SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
    root.HorizontalAlignment(HorizontalAlignment::Stretch);
    root.VerticalAlignment(VerticalAlignment::Stretch);
    // The pinned native template uses two Auto rows. Centering its content
    // alone leaves the first row at the top of our shipping-height header.
    root.RowDefinitions().GetAt(0).Height({1, GridUnitType::Star});
    root.RowDefinitions().GetAt(1).Height({0, GridUnitType::Pixel});
    root.ColumnDefinitions().GetAt(1).Width({1, GridUnitType::Star});
    const auto label = root.FindName(L"PART_TextVisual").as<TextBlock>();
    label.VerticalAlignment(VerticalAlignment::Center);
    label.TextWrapping(TextWrapping::NoWrap);
    label.TextTrimming(TextTrimming::CharacterEllipsis);
    label.MaxWidth(vpaste::winui::TabMaxWidth - 20);
    const auto icon = root.FindName(L"PART_IconVisual").as<ContentPresenter>();
    icon.VerticalAlignment(VerticalAlignment::Center);
    // A single shared underline owns selection across both native bars.
    root.FindName(L"PART_SelectionVisual").as<UIElement>().Visibility(Visibility::Collapsed);
    UpdateCategoryShortcutHints(g_altHints);
}

void UpdateCategoryShortcutHints(bool visible) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    if (!g_panel.filter) return;
    for (std::uint32_t index = 0; index < std::min(2u, g_panel.filter.Items().Size()); ++index) {
        const auto tab = g_panel.filter.Items().GetAt(index);
        if (!tab.IsLoaded() || Media::VisualTreeHelper::GetChildrenCount(tab) == 0) continue;
        const auto root = Media::VisualTreeHelper::GetChild(tab, 0).try_as<Grid>();
        if (!root) continue;
        Border hint{nullptr};
        for (auto const &child : root.Children())
            if (Automation::AutomationProperties::GetAutomationId(child) == L"category-shortcut-hint") hint = child.try_as<Border>();
        if (!hint) {
            hint = Border(); vpaste::winui::ApplyStyle(hint, L"VPaste.Surface");
            hint.CornerRadius(vpaste::winui::UniformRadius(4));
            hint.Width(14); hint.Height(14);
            hint.HorizontalAlignment(HorizontalAlignment::Right); hint.VerticalAlignment(VerticalAlignment::Center);
            hint.Margin({0, 0, 5, 0}); hint.IsHitTestVisible(false);
            TextBlock label; label.Text(index == 0 ? L"A" : L"F"); label.FontSize(9);
            label.FontWeight(winrt::Windows::UI::Text::FontWeight{680});
            label.HorizontalAlignment(HorizontalAlignment::Center);
            label.VerticalAlignment(VerticalAlignment::Center);
            hint.Child(label); Grid::SetColumnSpan(hint, 2); Grid::SetRowSpan(hint, 2);
            Automation::AutomationProperties::SetAutomationId(hint, L"category-shortcut-hint");
            Automation::AutomationProperties::SetAccessibilityView(hint, Automation::Peers::AccessibilityView::Raw);
            root.Children().Append(hint);
        }
        hint.Visibility(visible ? Visibility::Visible : Visibility::Collapsed);
    }
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
            tab.MaxWidth(vpaste::winui::TabMaxWidth);
            tab.Padding(winrt::Microsoft::UI::Xaml::Thickness{10, 0, index < 2 ? 23.0 : 10.0, 0});
            tab.Background(winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
            tab.HorizontalContentAlignment(HorizontalAlignment::Center);
            tab.VerticalContentAlignment(VerticalAlignment::Center);
            tab.Loaded([](auto const &sender, auto const &) { PrepareTabTemplate(sender.as<SelectorBarItem>()); });
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
void RequestHistory(bool preserveSearchSubmit = false);
void RefreshFilters();
void SetTagManagerActive(bool active);
void SetQueueViewActive(bool active);
void ApplyActiveLayout();
void ResizeIsland() noexcept;
void UpdateHistoryState();
void SetVisible(bool visible, bool freshShow, bool animate = true) noexcept;
void SetTutorialInteraction(bool active);
void RemoveTutorial();
std::optional<winrt::Windows::Foundation::Point> g_hoverPosition;
std::wstring g_hoverHash;
void CancelHoverPreview() {
    g_hoverPosition.reset(); g_hoverHash.clear();
    if (g_panel.hoverPreview) g_panel.hoverPreview->Cancel();
}
template<typename T> T FindHistoryChild(winrt::Microsoft::UI::Xaml::DependencyObject const &element);
winrt::hstring SearchText() { return g_searchText; }
vpaste::winui::HistoryQuery CurrentHistoryQuery() {
    return {std::wstring{SearchText()},
        g_selectedFilterId.empty() ? FilterValue(FilterIndex()) : L"custom:" + g_selectedFilterId, g_selectedTagName};
}

bool HistoryRowsMatchSearch() {
    return !g_searchComposing && !g_historyFailed &&
        g_historyView.visibleQueryId > g_historyView.discardThrough &&
        g_historyView.visibleQuery == CurrentHistoryQuery();
}

bool HistoryRowsCurrent() {
    return HistoryRowsMatchSearch() && !(g_historyLoading && g_latestHistoryRequestId == g_latestQueryId);
}

void RetireHistoryQuery() {
    g_historyView.discardThrough = g_latestHistoryRequestId;
    g_historyLoading = false;
    g_searchSubmitRequestId = 0;
    if (!IsHistorySearching()) HideLoadingIndicator();
}

void ScheduleSearch() {
    if (!g_searchTimer) return;
    g_searchTimer.Stop();
    if (g_searchComposing) { UpdateHistoryState(); return; }
    const bool empty = std::wstring_view{g_searchText}.find_first_not_of(L" \t\r\n") == std::wstring_view::npos;
    // Query debounce, matching clipboardSearch.ts; these are not motion timings.
    g_searchTimer.Interval(std::chrono::milliseconds(empty ? 40 : 120));
    g_searchTimer.Start();
    UpdateHistoryState();
}

void SearchCompositionChanged(bool composing, winrt::hstring const &text) {
    g_searchComposing = composing;
    g_searchText = text;
    RetireHistoryQuery();
    g_historyFailed = false;
    CancelHoverPreview();
    ScheduleSearch();
}

void SearchChanged(winrt::hstring const &text) {
    if (g_searchText == text) return;
    g_searchText = text;
    RetireHistoryQuery();
    g_historyFailed = false;
    CancelHoverPreview();
    ScheduleSearch();
}

void SetSearchText(winrt::hstring const &text) {
    g_panel.search.Text(text);
}
void ApplyCardPresenterChrome(winrt::Microsoft::UI::Xaml::DependencyObject const &container,
                              bool contrast);
void UpdateSearchWidth() {
    if (g_panel.searchField && g_panel.root) {
        const double width = g_panel.root.Width();
        const bool narrow = width < 900;
        const bool ultraNarrow = width > 0 && width < 560;
        g_panel.searchField.Width(narrow ? 120 : 276);
        if (g_panel.status) g_panel.status.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
        if (g_panel.tagFilter) g_panel.tagFilter.Width(narrow ? 112 : 144);
        // 窄屏下同步收敛开发者工具胶囊与极端窄窗边距，保护标签栏与右上角主操作按钮不被裁剪挤压。
        if (g_panel.appActions) g_panel.appActions->SetCompact(width > 0 && width < 860);
        if (g_panel.header) {
            const double inset = ultraNarrow ? 16.0 : kHeaderInset;
            const auto currentPadding = g_panel.header.Padding();
            if (currentPadding.Left != inset || currentPadding.Right != inset) {
                g_panel.header.Padding(winrt::Microsoft::UI::Xaml::Thickness{inset, 0, inset, 0});
            }
            const double nextColumnSpacing = ultraNarrow ? 6.0 : 10.0;
            if (g_panel.header.ColumnSpacing() != nextColumnSpacing) {
                g_panel.header.ColumnSpacing(nextColumnSpacing);
            }
        }
        if (g_panel.commands) {
            const double nextCommandSpacing = ultraNarrow ? 6.0 : 8.0;
            if (g_panel.commands.Spacing() != nextCommandSpacing) {
                g_panel.commands.Spacing(nextCommandSpacing);
            }
        }
    }
}

void ShowSearch() {
    using namespace winrt::Microsoft::UI::Xaml;
    UpdateSearchWidth(); g_panel.search.Visibility(Visibility::Visible);
    g_panel.searchButton.Visibility(Visibility::Collapsed);
    g_panel.search.Focus(FocusState::Programmatic);
    vpaste::winui::FadeFeedback(g_panel.search);
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

void ScheduleHistoryFocus(WPARAM wparam) {
    if (g_panel.window) PostMessageW(g_panel.window, kFocusHistory, wparam, 0);
}

winrt::Microsoft::UI::Xaml::ElementTheme EffectivePanelTheme(
    winrt::Microsoft::UI::Xaml::ElementTheme requested) noexcept {
    const auto actual = g_panel.root
        ? g_panel.root.ActualTheme()
        : winrt::Microsoft::UI::Xaml::ElementTheme::Default;
    return vpaste::winui::ResolveDarkTheme(requested, actual)
        ? winrt::Microsoft::UI::Xaml::ElementTheme::Dark
        : winrt::Microsoft::UI::Xaml::ElementTheme::Light;
}

winrt::Microsoft::UI::Xaml::Media::Brush CardHeaderBrush(HistoryRowVisual const &row) {
    using namespace winrt::Microsoft::UI::Xaml::Media;
    if (row.accent) return SolidColorBrush{*row.accent};
    // ClipboardCard.tsx uses this neutral fallback when source artwork has no
    // dominant color. A generic clipboard icon must not inherit the green Text identity.
    if (row.sourceIcon.Source()) {
        LinearGradientBrush brush; brush.StartPoint({0, 0}); brush.EndPoint({1, 1});
        GradientStop start; start.Offset(0); start.Color(Rgb(116, 124, 135));
        GradientStop end; end.Offset(1); end.Color(Rgb(86, 94, 104));
        brush.GradientStops().Append(start); brush.GradientStops().Append(end);
        return brush;
    }
    return TypeBrush(row.visualType.empty() ? row.itemType : row.visualType);
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

void SetFormatBadge(winrt::Microsoft::UI::Xaml::Controls::Border const &frame, bool visible) {
    using winrt::Microsoft::UI::Xaml::Visibility;
    // The chip surface owns visibility, including its label and padding.
    frame.Visibility(visible ? Visibility::Visible : Visibility::Collapsed);
}

void ApplyFormatBadgeColors(HistoryRowVisual const &row, bool contrast) {
    using namespace winrt::Microsoft::UI::Xaml;
    for (auto const &[badge, frame] : {std::pair{row.richBadge, row.richBadgeFrame}, std::pair{row.gifBadge, row.gifBadgeFrame}}) {
        if (contrast) {
            frame.ClearValue(Controls::Border::BackgroundProperty());
            vpaste::winui::ApplyStyle(frame, L"VPaste.Surface");
            badge.ClearValue(Controls::TextBlock::ForegroundProperty());
            vpaste::winui::ApplyStyle(badge, L"VPaste.Caption");
        } else {
            frame.Background(Media::SolidColorBrush{winrt::Windows::UI::Color{230, 255, 255, 255}});
            badge.Foreground(row.accent ? Media::SolidColorBrush{*row.accent} : Brush(99, 112, 131));
        }
        badge.FontSize(10);
    }
}

void UpdateCardPreviewMotion(bool visible = true) {
    const bool shown = visible && PanelVisible() && !g_queueViewActive && !g_panel.onboarding;
    const bool animations = shown && vpaste::winui::NativeAnimationsEnabled();
    for (std::size_t index = 0; index < g_panel.rows.size(); ++index) {
        auto &row = g_panel.rows[index];
        const bool active = row.pointerOver || (index < g_hashes.size() && g_hashes[index] == g_selectedHash);
        if (row.autoPreview) row.autoPreview->SetActive(active,
            shown && row.richFrame.Visibility() != winrt::Microsoft::UI::Xaml::Visibility::Visible, animations);
        if (row.richAutoPreview) row.richAutoPreview->SetActive(active, shown, animations);
        if (row.recordTags) row.recordTags->SetVisible(shown, animations);
    }
}

void SetCardRichContent(HistoryRowVisual &row, winrt::Microsoft::UI::Xaml::Controls::ScrollViewer rendered) {
    const auto content = rendered.Content().as<winrt::Microsoft::UI::Xaml::FrameworkElement>();
    const auto background = rendered.Background();
    rendered.Content(nullptr);
    row.richAutoPreview = vpaste::winui::AutoScrollCardPreview::Create(content);
    row.richAutoPreview->viewport.Background(background);
    row.richFrame.Child(row.richAutoPreview->viewport);
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

#ifdef _DEBUG
std::uint64_t g_filePresentationBuilds = 0;
#endif
void UpdateFilePresentation(HistoryRowVisual &row, bool refresh = false) {
    if (!row.fileData) return;
    const bool dark = IsDarkTheme();
    if (refresh || !row.filePresentation.Child() || row.filePresentationDark != dark) {
#ifdef _DEBUG
        ++g_filePresentationBuilds;
#endif
        row.filePresentation.Child(vpaste::winui::FileTypePresentation(row.fileData, dark));
        row.filePresentationDark = dark;
    }
    vpaste::winui::ApplyFileStage(row.mediaFrame, dark, !row.fileData.GetNamedBoolean(L"exists"),
        row.fileData.GetNamedBoolean(L"imageFile", false));
}

void ApplyRowTheme(bool contrast = vpaste::winui::HighContrastEnabled()) {
    ApplyWindowTheme(contrast);
    SyncTabIndicator();
    vpaste::winui::ApplyElevation(g_panel.header, vpaste::winui::HeaderElevation, contrast, g_panel.shadowReceiver);
    for (const auto &button : {g_panel.searchButton, g_panel.addTag})
        vpaste::winui::ApplyElevation(button, vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
    for (const auto &command : {g_panel.queueOpen, g_panel.settings})
        vpaste::winui::ApplyElevation(command, vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
    if (g_panel.appActions) {
        vpaste::winui::ApplyElevation(g_panel.appActions->ToolsButton(), vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
        vpaste::winui::ApplyElevation(g_panel.appActions->UpdateButton(), vpaste::winui::ControlElevation, contrast, g_panel.shadowReceiver);
    }
    vpaste::winui::ApplyElevation(g_panel.selectionBar, vpaste::winui::HoveredCardElevation, contrast, g_panel.shadowReceiver);
    if (g_panel.deletionDialog) g_panel.deletionDialog.RequestedTheme(EffectivePanelTheme(g_panel.root.RequestedTheme()));
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
        if (contrast) {
            row.header.ClearValue(winrt::Microsoft::UI::Xaml::Controls::Border::BackgroundProperty());
            vpaste::winui::ApplyStyle(row.header, L"VPaste.ContrastCardHeader");
        } else row.header.Background(CardHeaderBrush(row));
        vpaste::winui::ApplyStyle(row.type, contrast ? L"VPaste.ContrastCardTitle" : L"VPaste.CardTitle");
        vpaste::winui::ApplyStyle(row.preview, L"VPaste.Body");
        row.preview.FontSize(13);
        if (row.imageMatte && row.itemType == L"Image") row.imageMatte.Background(contrast
            ? nullptr : vpaste::winui::TransparencyBrush(EffectivePanelTheme(g_panel.root.RequestedTheme()) == winrt::Microsoft::UI::Xaml::ElementTheme::Dark));
        row.preview.ClearValue(winrt::Microsoft::UI::Xaml::Controls::TextBlock::ForegroundProperty());
        if (!contrast && row.itemType == L"Color") row.preview.Foreground(Brush(40, 40, 40));
        const auto favoriteGlyph = row.favoriteButton.Content().as<winrt::Microsoft::UI::Xaml::Controls::FontIcon>();
        if (contrast) {
            favoriteGlyph.ClearValue(winrt::Microsoft::UI::Xaml::Controls::IconElement::ForegroundProperty());
            vpaste::winui::ApplyStyle(favoriteGlyph, L"VPaste.Glyph");
        } else {
            favoriteGlyph.Foreground(Brush(255, 255, 255));
        }
        favoriteGlyph.FontSize(12);
        ApplyFormatBadgeColors(row, contrast);
        vpaste::winui::ApplyStyle(row.tags, L"VPaste.CardTag");
        vpaste::winui::ApplyStyle(row.dimensions, L"VPaste.Caption");
        vpaste::winui::ApplyStyle(row.subtitle, L"VPaste.Secondary");
        if (row.itemType == L"Link") row.subtitle.FontSize(11);
        row.preview.FontWeight(row.itemType == L"Link"
            ? winrt::Microsoft::UI::Text::FontWeights::SemiBold()
            : winrt::Microsoft::UI::Text::FontWeights::Normal());
        if (row.itemType == L"File") {
            row.preview.FontSize(11); row.preview.FontWeight(winrt::Microsoft::UI::Text::FontWeights::Medium());
            row.subtitle.FontSize(11);
            UpdateFilePresentation(row);
        }
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
    // Keep all thresholds and compact English labels in sync with
    // src/lang/index.ts::formatRelativeTime; old items never become dates.
    const auto seconds = (now > milliseconds ? now - milliseconds : 0) / 1000;
    if (seconds < 10) return Text(L"刚刚", L"Just now");
    const auto minutes = seconds / 60, hours = minutes / 60, days = hours / 24, months = days / 30;
    const auto amount = seconds < 60 ? seconds : minutes < 60 ? minutes : hours < 24 ? hours
        : days < 30 ? days : months < 12 ? months : days / 365;
    const auto suffix = seconds < 60 ? Text(L"秒前", L"s ago") : minutes < 60 ? Text(L"分钟前", L"m ago")
        : hours < 24 ? Text(L"小时前", L"h ago") : days < 30 ? Text(L"天前", L"d ago")
        : months < 12 ? Text(L"个月前", L"mo ago") : Text(L"年前", L"y ago");
    return winrt::hstring{std::to_wstring(amount)} + suffix;
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
    row.preview.MaxLines(media ? (row.itemType == L"File" ? 3 : 2) : 0);
    if (row.itemType == L"Image") row.preview.Visibility(Visibility::Collapsed);
    if (row.itemType == L"Image" || row.itemType == L"Link") {
        const bool link = row.itemType == L"Link";
        row.body.RowSpacing(0);
        row.preview.Margin(Thickness{0, link ? 8.0 : 0.0, 0, 0});
        row.mediaFrame.CornerRadius(vpaste::winui::UniformRadius(8));
        row.mediaFrame.Child().as<Grid>().Padding(Thickness{0});
        if (!link) row.mediaFrame.Background(nullptr);
        row.preview.MaxLines(1); row.preview.TextWrapping(TextWrapping::NoWrap);
        row.preview.FontWeight(winrt::Microsoft::UI::Text::FontWeights::SemiBold());
        row.preview.LineHeight(18);
        row.subtitle.FontSize(11); row.subtitle.MaxLines(1);
        row.subtitle.LineHeight(16); row.subtitle.TextWrapping(TextWrapping::NoWrap);
        row.contentIcon.FontSize(42);
    }
    if (row.itemType == L"File") {
        row.body.RowSpacing(0); row.mediaFrame.Margin(Thickness{0, 0, 0, 6});
        row.mediaFrame.CornerRadius(vpaste::winui::UniformRadius(8));
        row.mediaFrame.Child().as<Grid>().Padding(Thickness{0});
        row.preview.MaxLines(1); row.preview.FontSize(11); row.preview.LineHeight(14);
        row.preview.TextWrapping(TextWrapping::NoWrap); row.preview.TextAlignment(TextAlignment::Center);
        row.preview.FontWeight(winrt::Microsoft::UI::Text::FontWeights::Medium());
        row.subtitle.FontSize(11); row.subtitle.LineHeight(14); row.subtitle.MaxLines(1);
        row.subtitle.TextWrapping(TextWrapping::NoWrap); row.subtitle.TextAlignment(TextAlignment::Center);
        row.contentIcon.Visibility(Visibility::Collapsed);
    }
    if (!text.empty()) row.preview.Text(text);
    if (row.itemType == L"Color") {
        const auto color = ParseColor(text);
        row.colorSwatch.Visibility(color ? Visibility::Visible : Visibility::Collapsed);
        row.contentIcon.Visibility(color ? Visibility::Collapsed : Visibility::Visible);
        if (color) row.colorSwatch.Background(winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{*color});
    }
}

bool IsHistorySearching() {
    return g_searchComposing || (g_searchTimer && g_searchTimer.IsRunning()) ||
        (g_historyLoading && g_latestHistoryRequestId == g_latestQueryId);
}

void SetLoadingIndicatorVisible(bool visible) {
    using winrt::Microsoft::UI::Xaml::Visibility;
    if (!g_panel.loading) return;
    // 隐藏态同步关闭 IsIndeterminate，避免不可见时继续运行合成动画并消除左端蓝条瞬间闪现。
    g_panel.loading.IsIndeterminate(visible);
    g_panel.loading.Visibility(visible ? Visibility::Visible : Visibility::Collapsed);
}

void HideLoadingIndicator() {
    if (g_loadingTimer && g_loadingTimer.IsRunning()) g_loadingTimer.Stop();
    SetLoadingIndicatorVisible(false);
}

void UpdateHistoryState() {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    if (!g_panel.emptyState) return;
    const bool filtered = std::wstring_view{SearchText()}.find_first_not_of(L" \t\r\n") != std::wstring_view::npos ||
        FilterIndex() != 0 || g_selectedTagId != 0 || !g_selectedFilterId.empty();
    const bool searching = IsHistorySearching();
    const bool empty = g_hashes.empty() && !searching;
    // Existing rows stay in place while the new query is loading.
    // 仅在查询耗时超过 250ms 仍未返回时才显示顶部进度条，彻底消除常规标签切换的蓝条闪烁。
    if (searching && !g_hashes.empty()) {
        if (g_panel.loading && g_panel.loading.Visibility() != Visibility::Visible) {
            if (g_loadingTimer) {
                if (!g_loadingTimer.IsRunning()) g_loadingTimer.Start();
            } else {
                SetLoadingIndicatorVisible(true);
            }
        }
    } else {
        HideLoadingIndicator();
    }
    g_panel.staleHistory.Title(Text(L"查询失败：以下不是最新结果", L"Search failed: showing previous results"));
    g_panel.staleHistory.IsOpen(g_historyFailed && !g_hashes.empty());
    g_panel.emptyState.Visibility(empty ? Visibility::Visible : Visibility::Collapsed);
    const auto heading = g_panel.emptyState.Children().GetAt(1).as<TextBlock>();
    const auto detail = g_panel.emptyState.Children().GetAt(2).as<TextBlock>();
    heading.Text(g_historyFailed ? Text(L"暂时无法读取历史", L"History is unavailable")
        : filtered ? Text(L"没有匹配的剪贴项", L"No matching items") : Text(L"剪贴板还是空的", L"Your clipboard shelf is empty"));
    detail.Text(g_historyFailed ? g_panel.staleHistory.Message()
        : filtered ? Text(L"试试其他关键词，或清除筛选条件。", L"Try another search or clear the filters.")
        : Text(L"在其他应用中复制文字、图片或文件，它们会出现在这里。", L"Copy text, images or files in another app to see them here."));
    g_panel.retry.Visibility(g_historyFailed ? Visibility::Visible : Visibility::Collapsed);
    g_panel.resetFilters.Visibility(!g_historyFailed && filtered ? Visibility::Visible : Visibility::Collapsed);
    g_panel.more.Visibility(g_hasMore && HistoryRowsCurrent() ? Visibility::Visible : Visibility::Collapsed);
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
    UpdateCategoryShortcutHints(g_altHints);
    for (std::size_t i = 0; i < g_panel.rows.size(); ++i) {
        if (g_panel.rows[i].shortcutHint) g_panel.rows[i].shortcutHint.Visibility(
            g_altHints && i < 9 ? winrt::Microsoft::UI::Xaml::Visibility::Visible : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    }
}

void UpdateShortcutLabels() {
    const auto label = g_behavior.plainBinding.key ? vpaste::winui::ShortcutLabel(g_behavior.plainShortcut) : L"";
    for (auto const &row : g_panel.rows) if (row.menu.pastePlain) row.menu.pastePlain.KeyboardAcceleratorTextOverride(label);
    if (g_panel.filter && g_panel.filter.Items().Size() >= 2) {
        for (std::uint32_t i = 0; i < 2; ++i) winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetHelpText(
            g_panel.filter.Items().GetAt(i), g_behavior.quickInput ? (i == 0 ? L"Alt+A" : L"Alt+F") : L"");
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
    if (g_request == nullptr) return 0;
    const std::wstring_view op{operation};
    if (g_panel.reader && (op == L"panelBlur" || op == L"dismiss" || op == L"previewToggle" ||
                           op == L"imageText") && g_panel.reader->HasOcrDraft()) {
        if (op == L"dismiss" || op == L"previewToggle") {
            g_searchSubmitRequestId = 0;
            g_panel.reader->CloseOcrDraft();
        } else if (op == L"imageText") {
            ShowFeedback(Text(L"请先处理当前图片文字草稿", L"Close the current image text draft before opening another."), true);
        }
        return 0;
    }
    if (op == L"edit" && g_textEditorOpenRequest) return 0;
    if ((op == L"paste" || op == L"pastePlain" || op == L"quickPaste" || op == L"delete") &&
        (!HistoryRowsCurrent() || std::find(g_hashes.begin(), g_hashes.end(), hash) == g_hashes.end())) return 0;
    if (wcscmp(operation, L"query") == 0 || wcscmp(operation, L"queryMore") == 0 ||
        wcscmp(operation, L"paste") == 0 || wcscmp(operation, L"quickPaste") == 0 ||
        wcscmp(operation, L"edit") == 0 || wcscmp(operation, L"delete") == 0 ||
        wcscmp(operation, L"previewToggle") == 0 || wcscmp(operation, L"previewSelect") == 0 ||
        wcscmp(operation, L"previewClose") == 0 || wcscmp(operation, L"previewDismiss") == 0) CancelHoverPreview();
    if (wcscmp(operation, L"paste") == 0 || wcscmp(operation, L"copy") == 0 || wcscmp(operation, L"quickPaste") == 0 ||
        wcscmp(operation, L"edit") == 0 || wcscmp(operation, L"delete") == 0 ||
        wcscmp(operation, L"previewToggle") == 0 || wcscmp(operation, L"modalBegin") == 0 ||
        op == L"pastePlain" || op == L"dismiss") g_searchSubmitRequestId = 0;
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
    if (op == L"query" || op == L"queryMore") {
        const auto &query = g_historyView.requestedQuery;
        request.Insert(L"query", JsonValue::CreateStringValue(query.search));
        request.Insert(L"filter", JsonValue::CreateStringValue(query.category));
        request.Insert(L"tagName", JsonValue::CreateStringValue(query.tag));
    }
    if (op == L"query") {
        const bool sameRange = !g_historyView.resetOnShow && g_historyView.requestedQuery == g_historyView.visibleQuery;
        request.Insert(L"limit", JsonValue::CreateNumberValue(static_cast<double>(std::max<std::size_t>(36, sameRange ? g_hashes.size() : 0))));
    } else if (op == L"queryMore") {
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
    if (op == L"assignTag" || op == L"removeTag" || op == L"clearTags") g_cardTagRequests.insert(id);
    if (op == L"edit") {
        g_textEditorOpenRequest = id;
        if (const auto card = FindCard(hash)) g_textEditorRequestedCard = CardTarget{hash, card->recordId};
    }
    g_request(reinterpret_cast<const std::uint8_t *>(bytes.data()), bytes.size());
    // Escape lets Rust close a preview before deciding whether to hide the dock.
    // Cancelling hover first would make that preview appear already closed.
    if (wcscmp(operation, L"dismiss") == 0) CancelHoverPreview();
    return id;
}

std::uint64_t SendDocumentRequest(const wchar_t *operation, std::uint64_t generation, winrt::hstring const &document) {
    if (!g_request) return 0;
    if (wcscmp(operation, L"nativeEditorSave") != 0 && wcscmp(operation, L"nativeOcrCopy") != 0)
        return SendRequest(operation, {}, false, 0, {}, {}, 0, std::to_wstring(generation));
    if (document.size() > vpaste::winui::TextDocumentBytes || winrt::to_string(document).size() > vpaste::winui::TextDocumentBytes)
        return 0;
    using namespace winrt::Windows::Data::Json;
    JsonObject request;
    const auto id = ++g_requestId;
    request.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
    request.Insert(L"op", JsonValue::CreateStringValue(operation));
    request.Insert(L"argument", JsonValue::CreateStringValue(std::to_wstring(generation)));
    request.Insert(L"documentText", JsonValue::CreateStringValue(document));
    const auto bytes = winrt::to_string(request.Stringify());
    if (bytes.size() > vpaste::winui::MaxDocumentBytes) return 0;
    g_request(reinterpret_cast<const std::uint8_t *>(bytes.data()), bytes.size());
    return id;
}

HistoryRowVisual *FindCard(const std::wstring &hash) {
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), hash);
    if (found == g_hashes.end()) return nullptr;
    const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
    return index < g_panel.rows.size() ? &g_panel.rows[index] : nullptr;
}

HistoryRowVisual *FindCard(const CardTarget &target) {
    const auto card = FindCard(target.hash);
    return card && card->recordId == target.recordId ? card : nullptr;
}

bool SelectEditorOrigin(const CardTarget &target) {
    const auto card = FindCard(target);
    if (!card) return false;
    const auto index = static_cast<int>(card - g_panel.rows.data());
    const bool updating = std::exchange(g_updatingHistorySelection, true);
    g_panel.history.SelectedIndex(index);
    g_selectedHash = target.hash;
    g_updatingHistorySelection = updating;
    if (!g_panel.history.ContainerFromIndex(index))
        g_panel.history.ScrollIntoView(g_panel.history.Items().GetAt(index));
    return true;
}

void ScheduleEditorReturnFocus(const CardTarget &target, std::uint64_t id) {
    // The query can replace or realize the selected container. Leave a newer
    // selection or the search field in control if the user moves on.
    g_panel.root.DispatcherQueue().TryEnqueue(winrt::Microsoft::UI::Dispatching::DispatcherQueuePriority::Low,
        [id, target] {
            if (g_historyView.visibleQueryId == id && HistoryRowsCurrent() && !g_panel.textEditor &&
                !g_queueSelectionMode && g_selectedHash == target.hash && FindCard(target)) ScheduleHistoryFocus();
        });
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
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Media;
    if (row.itemType == L"Link") {
        const bool icon = row.linkIcon || (row.imageWidth > 0 && row.imageHeight > 0 &&
            std::max(row.imageWidth, row.imageHeight) <= 96);
        row.image.Stretch(icon ? Stretch::Uniform : Stretch::UniformToFill);
        row.image.MaxWidth(INFINITY); row.image.MaxHeight(INFINITY);
        const auto size = std::min(52.0, row.mediaFrame.ActualWidth() * 0.44);
        row.image.Width(icon ? std::max(1.0, size) : NAN); row.image.Height(icon ? std::max(1.0, size) : NAN);
        row.image.HorizontalAlignment(icon ? HorizontalAlignment::Center : HorizontalAlignment::Stretch);
        row.image.VerticalAlignment(icon ? VerticalAlignment::Center : VerticalAlignment::Stretch);
        return;
    }
    if (row.itemType == L"Image" && row.imageMatte && row.imageWidth > 0 && row.imageHeight > 0 &&
        row.mediaFrame.ActualWidth() > 0 && row.mediaFrame.ActualHeight() > 0) {
        const auto scale = std::min({1.0, row.mediaFrame.ActualWidth() / row.imageWidth,
            row.mediaFrame.ActualHeight() / row.imageHeight});
        row.image.MaxWidth(row.imageWidth * scale); row.image.MaxHeight(row.imageHeight * scale);
        row.imageMatte.Width(row.imageWidth * scale); row.imageMatte.Height(row.imageHeight * scale);
        return;
    }
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
#ifdef _DEBUG
    if (vpaste::winui::TraceCardMedia()) std::fprintf(stderr, "WinUI media probe: card bitmap ready=%d\n", loaded);
#endif
    row->pendingBitmap = nullptr;
    if (loaded) {
        row->image.Source(bitmap); row->image.Visibility(Visibility::Visible);
        row->contentIcon.Visibility(Visibility::Collapsed);
        if (row->filePresentation) row->filePresentation.Visibility(Visibility::Collapsed);
        ApplyNaturalImageBounds(*row);
        SetCardDetailState(*row, CardDetailState::Ready);
    } else {
        if (row->image.Source() == bitmap) row->image.Visibility(Visibility::Collapsed);
        if (row->image.Visibility() != Visibility::Visible) row->contentIcon.Visibility(Visibility::Visible);
        if (row->itemType == L"File" && row->fileData) {
            row->filePresentation.Visibility(Visibility::Visible);
            row->contentIcon.Visibility(Visibility::Collapsed);
        }
        SetCardDetailState(*row, CardDetailState::Failed, error);
    }
}

void HighlightCard(HistoryRowVisual &row) {
    for (const auto &block : {row.preview, row.subtitle, row.format}) vpaste::winui::HighlightText(block, g_highlightTerms);
}

std::uint64_t SendCardAction(const std::wstring &operation, const std::wstring &hash,
                            const std::wstring &argument) {
    if (g_queueSelectionMode || !HistoryRowsCurrent() || !FindCard(hash)) return 0;
    g_searchSubmitRequestId = 0;
    if (operation == L"exportPrepare") {
        if (g_panel.imageExport) g_panel.imageExport->Start(hash);
        return 0;
    }
    return SendRequest(operation.c_str(), hash, false, 0, {}, {}, 0, argument);
}

vpaste::winui::CardActionRequest GuardedCardAction(CardTarget target) {
    return [target = std::move(target)](auto const &operation, auto const &hash, auto const &argument) {
        return FindCard(target) ? SendCardAction(operation, hash, argument) : 0;
    };
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
    g_recordTagsLoaded = false;
    g_latestTagsRequestId = SendRequest(L"tags");
    g_recordTagsFailed = !g_latestTagsRequestId;
    RefreshFilters();
    g_tabOrderLoadRequest = SendRequest(L"tabOrderLoad");
}

std::uint64_t SendEditorRequest(const std::wstring &operation, winrt::Windows::Data::Json::JsonObject payload) {
    using namespace winrt::Windows::Data::Json;
    if (!g_request) return 0;
    if (operation == L"recordTagAssign" && (!g_recordTagAssignmentTarget ||
        payload.GetNamedString(L"hash") != g_recordTagAssignmentTarget->hash || !FindCard(*g_recordTagAssignmentTarget))) {
        throw winrt::hresult_error(E_FAIL, Text(L"原剪贴项不再可用", L"The original clipboard item is no longer available."));
    }
    const auto id = ++g_requestId;
    payload.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
    payload.Insert(L"op", JsonValue::CreateStringValue(operation));
    const auto bytes = winrt::to_string(payload.Stringify());
    if (bytes.size() > 16 * 1024) throw winrt::hresult_invalid_argument(L"Request too large / 请求内容过大");
    if (operation == L"recordTagAssign") g_cardTagRequests.insert(id);
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
        g_panel.root.DispatcherQueue().TryEnqueue(winrt::Microsoft::UI::Dispatching::DispatcherQueuePriority::Low,
            [generation, id, hash] {
                if (generation != g_editorGeneration || NativeEditorOpen() || !g_panel.root ||
                    !PanelVisible()) return;
                // The popup can still own native focus while XAML is returning
                // to the dock. Restore its logical target without activating the HWND.
                if (const auto control = EditorAnchor(id, hash).try_as<winrt::Microsoft::UI::Xaml::Controls::Control>())
                    control.Focus(winrt::Microsoft::UI::Xaml::FocusState::Programmatic);
            });
    };
}

winrt::fire_and_forget ConfirmDeleteTab(std::wstring id);

void ShowFilterEditor(winrt::Windows::Data::Json::JsonObject draft) {
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
    g_searchSubmitRequestId = 0;
    (void)SendRequest(L"previewDismiss");
    g_panel.filterEditor->Show(EditorAnchor(std::wstring{id}), draft, g_english, g_panel.root.RequestedTheme(),
        g_panel.root, EditorFocusReturn(std::wstring{id}));
}

void ShowRecordTagEditor(std::int64_t id = 0, const std::wstring &hash = {}) {
    if (!g_panel.recordTagEditor || g_panel.recordTagEditor->IsOpen() || g_panel.tagManagerViewActive || g_deleteConfirmationOpen ||
        (g_panel.cardDrag && g_panel.cardDrag->Active()) || (g_panel.filterEditor && g_panel.filterEditor->IsOpen())) return;
    std::wstring name;
    if (id) {
        const auto found = std::find(g_tagIds.begin(), g_tagIds.end(), id);
        if (found == g_tagIds.end()) return;
        name = g_tagNames[static_cast<std::size_t>(std::distance(g_tagIds.begin(), found))];
    }
    const auto card = hash.empty() ? nullptr : FindCard(hash);
    if (!hash.empty() && !card) return;
    const auto target = card ? std::optional{CardTarget{hash, card->recordId}} : std::nullopt;
    g_searchSubmitRequestId = 0;
    ShowAltHints(false);
    (void)SendRequest(L"previewDismiss");
    // Position from the trigger but own the flyout on a root that survives refresh.
    const auto tabId = id ? RecordTabId(id) : L"";
    const auto returnFocus = EditorFocusReturn(tabId, hash);
    const auto generation = g_editorGeneration;
    g_panel.recordTagEditor->Show(EditorAnchor(tabId, hash), id, name, hash, g_english,
        g_panel.root.RequestedTheme(), g_panel.root, [returnFocus, generation] {
            if (generation == g_editorGeneration) g_recordTagAssignmentTarget.reset();
            returnFocus();
        });
    g_recordTagAssignmentTarget = target;
}

winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItemBase MakeCardTagEntry(
    const CardTarget &target, const std::vector<std::int64_t> &tagIds,
    const std::shared_ptr<bool> &createRequested) {
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    MenuFlyoutSubItem tagsItem;
    tagsItem.Text(Text(L"标签", L"Tags"));
    tagsItem.Icon(vpaste::winui::Glyph(L"\uE8EC"));
    const auto hint = [&](winrt::hstring const &text) {
        MenuFlyoutItem item; item.Text(text); item.IsEnabled(false); tagsItem.Items().Append(item);
    };
    if (!g_recordTagsLoaded) {
        hint(g_recordTagsFailed ? Text(L"标签读取失败", L"Could not load tags") : Text(L"正在读取标签…", L"Loading tags…"));
        if (g_recordTagsFailed) {
            MenuFlyoutItem retry; retry.Text(Text(L"重试", L"Try again"));
            retry.Click([](auto const &, auto const &) { RefreshTags(); });
            tagsItem.Items().Append(retry);
        }
        return tagsItem;
    }
    if (g_tagIds.empty()) hint(Text(L"还没有标签", L"No tags yet"));
    std::size_t assignedCount = 0;
    for (std::size_t index = 0; index < g_tagIds.size(); ++index) {
        const auto tagId = g_tagIds[index];
        const bool assigned = std::find(tagIds.begin(), tagIds.end(), tagId) != tagIds.end();
        if (assigned) ++assignedCount;
        ToggleMenuFlyoutItem tagOption;
        tagOption.Text(winrt::hstring{g_tagNames[index]});
        tagOption.IsChecked(assigned);
        tagOption.RegisterPropertyChangedCallback(ToggleMenuFlyoutItem::IsCheckedProperty(),
            [target, tagId, assigned](auto const &sender, auto const &) {
            const auto toggle = sender.template as<ToggleMenuFlyoutItem>();
            if (toggle.IsChecked() == assigned) return;
            // Pointer, keyboard and automation change the same checked property.
            toggle.IsChecked(assigned);
            if (!g_queueSelectionMode && HistoryRowsCurrent() && FindCard(target) &&
                !SendRequest(assigned ? L"removeTag" : L"assignTag", target.hash, false, tagId))
                ShowFeedback(Text(L"标签更改未发送，请重试", L"Could not send the tag change. Try again."), true);
        });
        tagsItem.Items().Append(tagOption);
    }
    if (assignedCount && assignedCount == g_tagIds.size())
        hint(Text(L"已添加全部标签", L"All tags are assigned"));
    MenuFlyoutItem createTag;
    createTag.Text(Text(L"新建并添加标签…", L"Create and assign tag…"));
    createTag.Icon(SymbolIcon{Symbol::Add});
    createTag.Click([createRequested](auto const &, auto const &) { *createRequested = true; });
    tagsItem.Items().Append(createTag);
    if (assignedCount) {
        tagsItem.Items().Append(MenuFlyoutSeparator{});
        MenuFlyoutItem clearTags;
        clearTags.Text(Text(L"移除全部标签", L"Remove all assigned tags"));
        clearTags.Click([target](auto const &, auto const &) {
            if (!g_queueSelectionMode && HistoryRowsCurrent() && FindCard(target) && !SendRequest(L"clearTags", target.hash))
                ShowFeedback(Text(L"标签更改未发送，请重试", L"Could not send the tag change. Try again."), true);
        });
        tagsItem.Items().Append(clearTags);
    }
    return tagsItem;
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
            if (child.Visibility() == winrt::Microsoft::UI::Xaml::Visibility::Collapsed) continue;
            child.Measure({INFINITY, available.Height});
            if (desired.Width > 0) desired.Width += 8;
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
            if (child.Visibility() == winrt::Microsoft::UI::Xaml::Visibility::Collapsed) continue;
            const auto width = child.DesiredSize().Width;
            if (x > 0) x += 8;
            child.Arrange({x, 0, width, finalSize.Height}); x += width;
        }
        return finalSize;
    }
};

void BringSelectedTabIntoView(winrt::Microsoft::UI::Xaml::Controls::SelectorBar const &bar) {
    if (!bar || !bar.SelectedItem() || bar.SelectedItem().Visibility() != winrt::Microsoft::UI::Xaml::Visibility::Visible) return;
    // Feedback must not wait behind an already-queued history response/layout.
    SyncTabIndicator(true);
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
    tab.Padding(winrt::Microsoft::UI::Xaml::Thickness{10, 0, 10, 0});
    tab.Background(winrt::Microsoft::UI::Xaml::Media::SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
    tab.HorizontalContentAlignment(winrt::Microsoft::UI::Xaml::HorizontalAlignment::Center);
    tab.VerticalContentAlignment(winrt::Microsoft::UI::Xaml::VerticalAlignment::Center);
    winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(tab, name);
    tab.Loaded([](auto const &sender, auto const &) {
        PrepareTabTemplate(sender.as<winrt::Microsoft::UI::Xaml::Controls::SelectorBarItem>());
        if (g_panel.customTabs && sender == g_panel.customTabs.SelectedItem()) BringSelectedTabIntoView(g_panel.customTabs);
    });
}

void ResetTabDropOffsets() {
    for (auto const &tab : g_panel.customTabs.Items()) {
        const auto key = winrt::box_value(L"VPaste.TabDropAnimation");
        if (const auto animation = tab.Resources().TryLookup(key)) {
            tab.StopAnimation(animation.as<winrt::Microsoft::UI::Composition::ICompositionAnimationBase>());
            tab.Resources().Remove(key);
        }
        tab.TranslationTransition(nullptr);
        tab.Translation({0, 0, 0}); tab.Opacity(1);
    }
    if (g_panel.tabDropMarker) g_panel.tabDropMarker.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
}
void ClearTabDropPreview() {
    ResetTabDropOffsets();
    g_tabDrop = {};
}

void BeginTabDropPreview(std::wstring const &source) {
    ClearTabDropPreview(); g_tabDrop.source = source;
    for (auto const &tab : g_panel.customTabs.Items()) {
        g_tabDrop.bounds.push_back(tab.TransformToVisual(g_panel.customTabs).TransformBounds(
            {0, 0, static_cast<float>(tab.ActualWidth()), static_cast<float>(tab.ActualHeight())}));
        if (tab == DynamicTab(source)) tab.Opacity(0.35);
    }
}

bool PreviewTabDrop(std::wstring const &source, double x) {
    if (g_tabOrderSaveRequest || source != g_tabDrop.source || g_tabDrop.bounds.size() != g_dynamicIds.size()) return false;
    const auto found = std::find(g_dynamicIds.begin(), g_dynamicIds.end(), source);
    if (found == g_dynamicIds.end()) return false;
    const auto from = static_cast<std::size_t>(std::distance(g_dynamicIds.begin(), found));
    std::size_t to = 0;
    g_tabDrop.target.clear();
    for (std::size_t index = 0; index < g_dynamicIds.size(); ++index) {
        if (index == from) continue;
        const auto &rect = g_tabDrop.bounds[index];
        g_tabDrop.target = g_dynamicIds[index];
        g_tabDrop.before = x < rect.X + rect.Width / 2;
        if (g_tabDrop.before) break;
        ++to;
    }
    const auto width = g_tabDrop.bounds[from].Width + 8; // TabStripLayout spacing
    const bool animate = vpaste::winui::NativeAnimationsEnabled();
    for (std::size_t index = 0; index < g_dynamicIds.size(); ++index) {
        const auto tab = g_panel.customTabs.Items().GetAt(static_cast<std::uint32_t>(index));
        if (index == from) tab.Opacity(0.35);
        const auto shift = from < to && index > from && index <= to ? -width
            : from > to && index >= to && index < from ? width : 0;
        if (tab.Translation().x == shift) continue;
        const auto start = tab.Translation();
        const auto key = winrt::box_value(L"VPaste.TabDropAnimation");
        if (const auto previous = tab.Resources().TryLookup(key)) {
            tab.StopAnimation(previous.as<winrt::Microsoft::UI::Composition::ICompositionAnimationBase>());
            tab.Resources().Remove(key);
        }
        tab.Translation({shift, 0, 0});
        if (animate) {
            const auto compositor = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::GetCompositorForCurrentThread();
            const auto animation = compositor.CreateVector3KeyFrameAnimation();
            animation.Target(L"Translation"); animation.InsertKeyFrame(0, start); animation.InsertKeyFrame(1, {shift, 0, 0});
            animation.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
                std::chrono::duration<double>{vpaste::winui::CachedMotionTiming().durationFast}));
            tab.StartAnimation(animation); tab.Resources().Insert(key, animation);
        }
    }
    const auto &rect = g_tabDrop.bounds[to];
    const auto start = rect.X + (to > from ? rect.Width - g_tabDrop.bounds[from].Width : 0);
    const auto point = g_panel.customTabs.TransformToVisual(g_panel.filterScroll).TransformPoint({start, 0});
    g_panel.tabDropMarker.Translation({point.X, 0, 0});
    g_panel.tabDropMarker.Visibility(to != from && point.X >= 0 && point.X < g_panel.filterScroll.ActualWidth()
        ? winrt::Microsoft::UI::Xaml::Visibility::Visible : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    if (to == from) g_tabDrop.target.clear();
    return true;
}

void SaveTabDrop(std::wstring const &source, std::wstring const &target, std::optional<bool> before = std::nullopt) {
    using namespace winrt::Windows::Data::Json;
    if (g_tabOrderSaveRequest || source == target || !DynamicTab(source) || !DynamicTab(target)) return;
    const auto sourceIndex = std::find(g_dynamicIds.begin(), g_dynamicIds.end(), source);
    const auto targetIndex = std::find(g_dynamicIds.begin(), g_dynamicIds.end(), target);
    if (sourceIndex == g_dynamicIds.end() || targetIndex == g_dynamicIds.end()) return;
    JsonObject payload;
    payload.Insert(L"sourceId", JsonValue::CreateStringValue(source));
    payload.Insert(L"targetId", JsonValue::CreateStringValue(target));
    payload.Insert(L"before", JsonValue::CreateBooleanValue(before.value_or(sourceIndex > targetIndex)));
    try { g_tabOrderSaveRequest = SendEditorRequest(L"tabOrderSave", payload); }
    catch (winrt::hresult_error const &error) { ShowFeedback(error.message(), true); }
}

void RebuildDynamicTabs() {
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Windows::Data::Json;
    if (!g_panel.customTabs) return;
    const auto &filters = g_tutorialPreviewFilters ? *g_tutorialPreviewFilters : g_customFilters;
    const auto updating = std::exchange(g_updatingTagFilter, true);
    std::vector<std::pair<std::wstring, SelectorBarItem>> existing;
    for (std::uint32_t i = 0; i < std::min<std::size_t>(g_dynamicIds.size(), g_panel.customTabs.Items().Size()); ++i)
        existing.emplace_back(g_dynamicIds[i], g_panel.customTabs.Items().GetAt(i));
    std::vector<std::wstring> available;
    for (auto const &filter : filters) available.push_back(std::wstring{filter.GetNamedString(L"id")});
    for (auto id : g_tagIds) available.push_back(RecordTabId(id));
    g_dynamicIds.clear();
    for (auto const &id : g_tabOrder) if (std::find(available.begin(), available.end(), id) != available.end() &&
        std::find(g_dynamicIds.begin(), g_dynamicIds.end(), id) == g_dynamicIds.end()) g_dynamicIds.push_back(id);
    for (auto const &id : available) if (std::find(g_dynamicIds.begin(), g_dynamicIds.end(), id) == g_dynamicIds.end()) g_dynamicIds.push_back(id);
    JsonArray signature;
    signature.Append(JsonValue::CreateBooleanValue(g_english));
    for (auto const &id : g_dynamicIds) {
        signature.Append(JsonValue::CreateStringValue(id));
        const auto filter = std::find_if(filters.begin(), filters.end(),
            [&](auto const &draft) { return std::wstring{draft.GetNamedString(L"id")} == id; });
        if (filter != filters.end()) signature.Append(*filter);
        else {
            const auto index = std::find_if(g_tagIds.begin(), g_tagIds.end(), [&](auto value) { return RecordTabId(value) == id; }) - g_tagIds.begin();
            signature.Append(JsonValue::CreateStringValue(g_tagNames[index]));
        }
    }
    if (g_renderedDynamicTabs == signature.Stringify()) {
        g_panel.customTabs.SelectedItem(DynamicTab(!g_selectedFilterId.empty() ? g_selectedFilterId : RecordTabId(g_selectedTagId)));
        g_updatingTagFilter = updating;
        BringSelectedTabIntoView(g_panel.customTabs);
        return;
    }
    ClearTabDropPreview();
    g_renderedDynamicTabs = signature.Stringify();
    std::uint32_t destination = 0;
    for (auto const &id : g_dynamicIds) {
        SelectorBarItem tab;
        MenuFlyout menu;
        menu.Opened([](auto const &, auto const &) { g_searchSubmitRequestId = 0; CancelHoverPreview(); });
        MenuFlyoutItem edit, remove; edit.Icon(SymbolIcon{Symbol::Edit}); remove.Icon(SymbolIcon{Symbol::Delete});
        const auto filter = std::find_if(filters.begin(), filters.end(),
            [&](auto const &draft) { return std::wstring{draft.GetNamedString(L"id")} == id; });
        const auto contentKey = winrt::hstring{g_english ? L"en:" : L"zh:"} + (filter != filters.end()
            ? filter->Stringify() : winrt::hstring{g_tagNames[std::find_if(g_tagIds.begin(), g_tagIds.end(),
                [&](auto tagId) { return RecordTabId(tagId) == id; }) - g_tagIds.begin()]});
        const auto old = std::find_if(existing.begin(), existing.end(), [&](auto const &entry) { return entry.first == id; });
        if (old != existing.end() && winrt::unbox_value_or<winrt::hstring>(old->second.Tag(), L"") == contentKey) {
            tab = old->second;
            std::uint32_t position = 0;
            if (g_panel.customTabs.Items().IndexOf(tab, position) && position != destination) {
                g_panel.customTabs.Items().RemoveAt(position);
                g_panel.customTabs.Items().InsertAt(destination, tab);
            }
            ++destination;
            continue;
        }
        tab.Tag(winrt::box_value(contentKey));
        if (filter != filters.end()) {
            const auto draft = *filter;
            StyleDynamicTab(tab, draft.GetNamedString(L"name"));
            edit.Text(Text(L"编辑筛选", L"Edit filter")); remove.Text(Text(L"删除筛选", L"Delete filter"));
            edit.Click([draft](auto const &, auto const &) { ShowFilterEditor(draft); });
            remove.Click([draft](auto const &, auto const &) { (void)ConfirmDeleteTab(std::wstring{draft.GetNamedString(L"id")}); });
            tab.DoubleTapped([draft](auto const &, auto const &args) { ShowFilterEditor(draft); args.Handled(true); });
        } else {
            const auto index = std::find_if(g_tagIds.begin(), g_tagIds.end(), [&](auto tagId) { return RecordTabId(tagId) == id; }) - g_tagIds.begin();
            const auto tagId = g_tagIds[index];
            StyleDynamicTab(tab, winrt::hstring{g_tagNames[index]});
            edit.Text(Text(L"编辑标签", L"Edit tag")); remove.Text(Text(L"删除标签…", L"Delete tag…"));
            edit.Click([tagId](auto const &, auto const &) { ShowRecordTagEditor(tagId); });
            remove.Click([tagId](auto const &, auto const &) { (void)ConfirmDeleteTab(RecordTabId(tagId)); });
            tab.DoubleTapped([tagId](auto const &, auto const &args) { ShowRecordTagEditor(tagId); args.Handled(true); });
        }
        menu.Items().Append(edit); menu.Items().Append(remove);
        vpaste::winui::BindMenuOpeningFocus(menu, g_panel.menuInput);
        tab.ContextFlyout(menu);
        tab.CanDrag(true);
        tab.DragStarting([id](auto const &, auto const &args) {
            if (g_tabOrderSaveRequest || NativeEditorOpen()) { args.Cancel(true); return; }
            args.Data().Properties().Insert(L"com.vpaste.native-tab", winrt::box_value(id));
            args.Data().RequestedOperation(winrt::Windows::ApplicationModel::DataTransfer::DataPackageOperation::Move);
            CancelHoverPreview(); BeginTabDropPreview(id); (void)SendRequest(L"dragBegin");
        });
        tab.DropCompleted([](auto const &, auto const &) {
            ClearTabDropPreview(); (void)SendRequest(L"dragEnd");
        });
        g_panel.customTabs.Items().InsertAt(destination++, tab);
    }
    while (g_panel.customTabs.Items().Size() > destination) g_panel.customTabs.Items().RemoveAtEnd();
    g_panel.customTabs.SelectedItem(DynamicTab(!g_selectedFilterId.empty() ? g_selectedFilterId : RecordTabId(g_selectedTagId)));
    g_panel.customTabs.Visibility(g_dynamicIds.empty() ? Visibility::Collapsed : Visibility::Visible);
    g_updatingTagFilter = updating;
    BringSelectedTabIntoView(g_panel.customTabs);
}

std::vector<winrt::Windows::Data::Json::JsonObject> FilterObjects(
    winrt::Windows::Data::Json::JsonArray const &items) {
    using namespace winrt::Windows::Data::Json;
    std::vector<JsonObject> filters;
    for (auto const &value : items) {
        if (value.ValueType() != JsonValueType::Object) continue;
        auto draft = value.GetObject();
        const auto id = draft.GetNamedValue(L"id", nullptr), name = draft.GetNamedValue(L"name", nullptr);
        if (id && id.ValueType() == JsonValueType::String && !id.GetString().empty() &&
            name && name.ValueType() == JsonValueType::String) filters.push_back(draft);
    }
    return filters;
}

void ApplyFilters(const winrt::Windows::Data::Json::JsonArray &items) {
    winrt::hstring previousActiveFilter;
    if (!g_selectedFilterId.empty()) {
        const auto oldFound = std::find_if(g_customFilters.begin(), g_customFilters.end(),
            [](auto const &draft) { return std::wstring{draft.GetNamedString(L"id")} == g_selectedFilterId; });
        if (oldFound != g_customFilters.end()) {
            const auto filterObj = oldFound->GetNamedValue(L"filter", nullptr);
            previousActiveFilter = filterObj ? filterObj.Stringify() : L"";
        }
    }
    g_customFilters = FilterObjects(items);
    bool selectionImpacted = false;
    if (!g_selectedFilterId.empty()) {
        const auto newFound = std::find_if(g_customFilters.begin(), g_customFilters.end(),
            [](auto const &draft) { return std::wstring{draft.GetNamedString(L"id")} == g_selectedFilterId; });
        if (newFound == g_customFilters.end()) {
            g_selectedFilterId.clear();
            selectionImpacted = true;
            if (!g_selectedTagId) {
                const auto updatingLanguage = g_updatingLanguage; g_updatingLanguage = true;
                g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
                g_updatingLanguage = updatingLanguage;
            }
        } else {
            const auto filterObj = newFound->GetNamedValue(L"filter", nullptr);
            const auto nextActiveFilter = filterObj ? filterObj.Stringify() : winrt::hstring{};
            selectionImpacted = nextActiveFilter != previousActiveFilter;
        }
    }
    RebuildDynamicTabs();
    // 仅当当前激活筛选条件变更/被删除，或尚未拉取首次历史数据时才请求查询，避免启动连发重复 query。
    if (selectionImpacted && g_selectedFilterId.empty()) g_historyView.removedTabFallback = CurrentHistoryQuery();
    if (selectionImpacted || g_latestQueryId == 0) RequestHistory();
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
    if (selectedTagRemoved) g_historyView.removedTabFallback = CurrentHistoryQuery();
    if (selectionChanged) RequestHistory();
    return selectionChanged;
}

void FailHistoryQuery(winrt::hstring const &message) {
    RetireHistoryQuery();
    g_historyFailed = true;
    g_hasMore = false;
    g_panel.more.IsEnabled(false);
    g_panel.staleHistory.Message(message);
    UpdateHistoryState();
}

void RequestHistory(bool preserveSearchSubmit) {
    if (!preserveSearchSubmit) g_searchSubmitRequestId = 0;
    if (g_searchComposing) return;
    if (g_panel.cardDrag && g_panel.cardDrag->Active()) {
        g_historyRefreshAfterDrag = true;
        return;
    }
    // This request already includes the current text, even when a tab click
    // arrives before its search debounce. Do not query the same view twice.
    if (g_searchTimer && g_searchTimer.IsRunning()) g_searchTimer.Stop();
    auto query = CurrentHistoryQuery();
    if (g_historyView.removedTabFallback && *g_historyView.removedTabFallback != query)
        g_historyView.removedTabFallback.reset();
    if (query != g_historyView.requestedQuery) RetireHistoryQuery();
    g_historyView.requestedQuery = std::move(query);
#ifdef _DEBUG
    g_queryStarted = std::chrono::steady_clock::now();
#endif
    const auto sent = SendRequest(L"query");
    if (!sent) {
        // A failed dispatch has no reply to retire the pending Enter.
        FailHistoryQuery(Text(L"查询无法发送，请缩短搜索词或重试。", L"Could not send the query. Shorten the search text or try again."));
        return;
    }
    g_historyLoading = true;
    g_historyFailed = false;
    g_historyView.pageFailed = false;
    g_historyView.lastAutoCursor.reset();
    g_latestQueryId = sent;
    if (preserveSearchSubmit && g_searchSubmitRequestId != 0)
        g_searchSubmitRequestId = g_latestQueryId;
#ifdef _DEBUG
    std::fprintf(stderr, "WinUI query dispatch: id=%llu callbackMs=%.2f\n", static_cast<unsigned long long>(g_latestQueryId),
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - g_queryStarted).count());
#endif
    g_latestHistoryRequestId = g_latestQueryId;
    g_nextId = 0;
    g_nextTime = 0;
    g_hasMore = false;
    g_panel.more.IsEnabled(false);
    UpdateHistoryState();
}

void AnimateResultBatch(winrt::Microsoft::UI::Xaml::FrameworkElement const &frame,
                        std::size_t index) {
    const auto pending = winrt::box_value(L"VPaste.ResultBatchIndex");
    const auto hooked = winrt::box_value(L"VPaste.ResultBatchHooked");
    if (frame.IsLoaded()) { vpaste::winui::AnimateResultItem(frame, index); return; }
    frame.Resources().Insert(pending, winrt::box_value(static_cast<std::uint32_t>(index)));
    if (frame.Resources().HasKey(hooked)) return;
    frame.Resources().Insert(hooked, winrt::box_value(true));
    frame.Loaded([pending](auto const &sender, auto const &) {
        const auto item = sender.template as<winrt::Microsoft::UI::Xaml::FrameworkElement>();
        if (!item.Resources().HasKey(pending)) return;
        const auto index = winrt::unbox_value<std::uint32_t>(item.Resources().Lookup(pending));
        item.Resources().Remove(pending);
        vpaste::winui::AnimateResultItem(item, index);
    });
}
void RequestMoreHistory(bool automatic = false) {
    if (g_panel.cardDrag && g_panel.cardDrag->Active()) {
        g_historyRefreshAfterDrag = true;
        return;
    }
    if (g_hasMore && !g_historyLoading && HistoryRowsCurrent()) {
        const auto cursor = std::pair{g_nextId, g_nextTime};
        if (automatic && cursor == std::pair<std::uint64_t, std::uint64_t>{0, 0}) return;
        if (automatic && (g_historyView.pageFailed || g_historyView.lastAutoCursor == cursor)) return;
        if (automatic) g_historyView.lastAutoCursor = cursor;
        else { g_historyView.pageFailed = false; g_historyView.lastAutoCursor.reset(); }
        const auto sent = SendRequest(L"queryMore");
        if (!sent) {
            g_historyLoading = false;
            g_historyView.pageFailed = true;
            g_historyView.lastAutoCursor.reset();
            g_panel.more.IsEnabled(g_hasMore);
            UpdateHistoryState();
            ShowFeedback(Text(L"加载更多失败，请重试", L"Could not load more items; try again"), true);
            return;
        }
        g_historyLoading = true;
        g_panel.more.IsEnabled(false);
        g_latestHistoryRequestId = sent;
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
    g_historyVerifyToken = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering([](auto const &, auto const &) noexcept {
        try {
            if (g_historyVerifyToken) {
                winrt::Microsoft::UI::Xaml::Media::CompositionTarget::Rendering(*g_historyVerifyToken);
                g_historyVerifyToken.reset();
            }
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
        } catch (winrt::hresult_error const &error) {
            LogWinUiError("composition_target_rendering", error.code(), winrt::to_string(error.message()));
        } catch (...) {
            LogWinUiError("composition_target_rendering", winrt::to_hresult());
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
        UpdateCardPreviewMotion(!args.IsIntermediate());
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
    if (NativeEditorOpen() || !HistoryRowsCurrent()) return;
    ShowAltHints(false);
    g_searchSubmitRequestId = 0;
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
    else (void)SendRequest(plainText ? L"pastePlain" : L"paste", g_hashes[index]);
}

void SubmitSearch(bool plainText = false, int index = 0, bool quick = false) {
    if (g_searchComposing) return;
    if (g_searchTimer.IsRunning()) RequestHistory();
    if (g_historyFailed || g_historyView.requestedQuery != CurrentHistoryQuery()) return;
    if (g_historyLoading && g_latestHistoryRequestId == g_latestQueryId) {
        g_searchSubmitRequestId = g_latestQueryId;
        g_submitSelectedHash.clear();
        g_searchSubmitIndex = index; g_searchSubmitPlain = plainText; g_searchSubmitQuick = quick;
    } else ActivateHistoryIndex(index, plainText, quick);
}

void CompletePendingSubmit(std::uint64_t id) {
    if (!id || id != g_searchSubmitRequestId) return;
    g_searchSubmitRequestId = 0;
    if (!g_submitSelectedHash.empty()) {
        const auto selected = std::find(g_hashes.begin(), g_hashes.end(), g_submitSelectedHash);
        g_submitSelectedHash.clear();
        if (selected == g_hashes.end()) return;
        g_searchSubmitIndex = static_cast<int>(std::distance(g_hashes.begin(), selected));
    }
    ActivateHistoryIndex(g_searchSubmitIndex, g_searchSubmitPlain, g_searchSubmitQuick);
}

int HistoryIndexFromSource(winrt::Windows::Foundation::IInspectable const &source) {
    using namespace winrt::Microsoft::UI::Xaml;
    auto element = source.try_as<DependencyObject>();
    while (element && element != g_panel.history) {
        if (const auto container = element.try_as<Controls::ListViewItem>())
            return g_panel.history.IndexFromContainer(container);
        element = Media::VisualTreeHelper::GetParent(element);
    }
    return -1;
}

void ToggleQueueCardPreview(std::wstring const &hash) {
    const auto card = FindCard(hash);
    if (!g_queueSelectionMode || !card || !HistoryRowsCurrent() || NativeEditorOpen() ||
        g_deleteConfirmationOpen || g_panel.tagManagerViewActive) return;
    if (const auto request = SendRequest(L"previewToggle", hash)) {
        // While a preview is open, a second toggle closes it. Keep its origin.
        if (!g_queuePreviewFocus || g_queuePreviewFocus->closed)
            g_queuePreviewFocus = QueuePreviewFocus{{hash, card->recordId}, request};
    } else if (!g_panel.reader || !g_panel.reader->HasOcrDraft()) {
        ShowFeedback(Text(L"无法打开预览，请重试", L"Could not request the preview. Try again."), true);
    }
}

bool OpenSelectedCardMenu(winrt::Windows::Foundation::IInspectable const &source = nullptr) {
    if (g_panel.tagManagerViewActive || g_deleteConfirmationOpen ||
        NativeEditorOpen() ||
        (g_panel.cardDrag && g_panel.cardDrag->Active())) return false;
    const auto index = g_queueSelectionMode ? HistoryIndexFromSource(source)
        : static_cast<int>(std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash) - g_hashes.begin());
    if (index < 0 || static_cast<std::size_t>(index) >= g_panel.rows.size() || !HistoryRowsCurrent()) return false;
    g_searchSubmitRequestId = 0;
    auto &row = g_panel.rows[index];
    const auto flyout = EnsureCardContextMenu(row, g_hashes[index]);
    if (!flyout) return false;
    g_panel.menuInput->keyboardGesture = true;
    flyout.ShowAt(row.surface);
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
    if (NativeEditorOpen() || g_searchComposing) return false;
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
    if (refresh) {
        RequestHistory();
        ScheduleHistoryFocus();
    }
}

bool HandleMainKey(vpaste::winui::MainKeyInput input,
                   winrt::Windows::Foundation::IInspectable const &source = nullptr) {
    using namespace vpaste::winui;
    input.composing = input.composing || g_searchComposing;
    input.blocked = input.blocked || g_panel.tagManagerViewActive || g_deleteConfirmationOpen ||
        NativeEditorOpen() || (g_panel.cardDrag && g_panel.cardDrag->Active()) ||
        (g_panel.imageExport && g_panel.imageExport->Active());
    // Search dismissal has priority even after focus moves back to cards or
    // ordinary toolbar buttons. Native modal/menu ownership still wins.
    if (input.key == VK_ESCAPE && !input.control && !input.shift && !input.alt && !input.meta &&
        g_panel.search && g_panel.search.Visibility() == winrt::Microsoft::UI::Xaml::Visibility::Visible)
        input.area = InputArea::Search;
    const auto result = ResolveMainKey(g_behavior, input);
    switch (result.action) {
    case MainKeyAction::None: return false;
    case MainKeyAction::Ignore: return true;
    case MainKeyAction::Dismiss: (void)SendRequest(L"dismiss"); break;
    case MainKeyAction::OpenCardMenu: return OpenSelectedCardMenu(source);
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
    case MainKeyAction::PasteCard:
    case MainKeyAction::PastePlain: {
        const bool plainText = result.action == MainKeyAction::PastePlain;
        if (g_queueSelectionMode) {
            const auto index = HistoryIndexFromSource(source);
            if (index >= 0) ActivateHistoryIndex(index, plainText, false);
        } else if (HistoryRowsMatchSearch()) {
            const auto selected = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
            if (selected != g_hashes.end()) {
                SubmitSearch(plainText, static_cast<int>(std::distance(g_hashes.begin(), selected)));
                if (g_searchSubmitRequestId) g_submitSelectedHash = *selected;
            }
        }
        break;
    }
    case MainKeyAction::SearchPaste: SubmitSearch(); break;
    case MainKeyAction::SearchPastePlain: SubmitSearch(true); break;
    case MainKeyAction::QuickItem: SubmitSearch(false, result.index, true); break;
    case MainKeyAction::QuickAll: SelectBuiltinCategory(0); break;
    case MainKeyAction::QuickFavorite: SelectBuiltinCategory(1); break;
    case MainKeyAction::ClearSearch: SetSearchText(L""); break;
    case MainKeyAction::CloseSearch:
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
    auto element = source.try_as<winrt::Microsoft::UI::Xaml::DependencyObject>();
    bool textEditor = false, button = false;
    while (element) {
        // Route typing shortcuts through the search editor, but let its
        // built-in clear button keep native Enter/Space behavior.
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
        !PanelVisible() || IsIconic(g_panel.window) || g_historyLoading || !HistoryRowsCurrent() ||
        (g_searchTimer && g_searchTimer.IsRunning()) || g_queueSelectionMode ||
        g_panel.tagManagerViewActive || g_deleteConfirmationOpen || NativeEditorOpen() ||
        (g_panel.cardDrag && g_panel.cardDrag->Active()) ||
        (g_panel.imageExport && g_panel.imageExport->Active())) return false;
    const auto foreground = GetForegroundWindow();
    return (foreground == g_panel.window || IsChild(g_panel.window, foreground)) &&
        !NativeControlOwnsKeys(winrt::Microsoft::UI::Xaml::Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot()));
}

void HoverHistoryCard(std::wstring const &hash, winrt::hstring const &type,
    winrt::Windows::Foundation::Point point, bool interactive, bool contact) {
    if (contact || !PointerHistoryAllowed()) {
        g_hoverPosition.reset(); g_hoverHash.clear(); CancelHoverPreview(); return;
    }
    if (g_hoverPosition && g_hoverHash == hash && g_hoverPosition->X == point.X && g_hoverPosition->Y == point.Y) return;
    g_hoverPosition = point;
    g_hoverHash = hash;
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), hash);
    if (found == g_hashes.end()) return;
    if (g_selectedHash != hash) {
        CancelHoverPreview();
        HistoryViewportInput();
        g_panel.history.SelectedIndex(static_cast<int>(std::distance(g_hashes.begin(), found)));
    }
    if (interactive) g_panel.hoverPreview->Leave();
    else {
        g_panel.history.Focus(winrt::Microsoft::UI::Xaml::FocusState::Programmatic);
        g_panel.hoverPreview->Enter(hash, std::wstring{type});
    }
}

bool IsEditableTextItem(const winrt::hstring &type) {
    return type == L"Text" || type == L"TextFile" || type == L"Link" ||
           type == L"Color";
}

void UpdateQueueSelectionControls() {
    if (!g_panel.history || !g_panel.queueAdd || !g_panel.selectionBar) return;
    g_panel.queueAdd.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Visible
        : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    g_panel.queueAdd.IsEnabled(g_queueSelectionMode && !g_queueSelectedHashes.empty() && !g_queueSelectionAdding);
    const bool enteringSelection = g_queueSelectionMode &&
        g_panel.selectionBar.Visibility() != winrt::Microsoft::UI::Xaml::Visibility::Visible;
    if (!g_queueSelectionMode) vpaste::winui::ResetFeedbackOpacity(g_panel.selectionBar);
    g_panel.selectionBar.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Visible
        : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    g_panel.selectionTitle.Text(Text(L"选择要加入队列的项目", L"Select items to add to the queue"));
    winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
        g_panel.selectionBar, g_panel.selectionTitle.Text());
    const auto countText = winrt::hstring{std::to_wstring(g_queueSelectedHashes.size())};
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
    g_panel.queueAdd.Content(winrt::box_value(g_english ? L"Add " + countText + L" items" : L"加入 " + countText + L" 项"));
    g_panel.cancelSelection.Visibility(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Visibility::Visible
        : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    if (g_panel.queueOpen) {
        const auto targetStyleKey = g_queueViewActive ? L"VPaste.ActiveToolbarCommand" : L"VPaste.RoundToolbarCommand";
        vpaste::winui::NameIconButton(g_panel.queueOpen, g_queueViewActive
            ? Text(L"退出并清空粘贴队列", L"Exit Paste Queue and clear items") : Text(L"粘贴队列", L"Paste Queue"));
        const auto expected = winrt::Microsoft::UI::Xaml::Application::Current().Resources()
            .Lookup(winrt::box_value(targetStyleKey)).as<winrt::Microsoft::UI::Xaml::Style>();
        if (g_panel.queueOpen.Style() != expected) {
            g_panel.queueOpen.Style(expected);
            // Style 切换会重建 Button 的 ControlTemplate；重挂 Content 使内部 PathIcon 立即重新继承新前景色，防止退出队列后残留激活态色调。
            if (const auto content = g_panel.queueOpen.Content()) {
                g_panel.queueOpen.Content(nullptr);
                g_panel.queueOpen.Content(content);
            }
        }
    }
}

void ToggleQueueSelectionMode(bool updateStatus = true) {
    if (!g_panel.history) return;
    g_searchSubmitRequestId = 0;
    g_textEditorReturnAfterQuery.reset();
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
    if (g_queuePreviewFocus && !g_queuePreviewFocus->closed) (void)SendRequest(L"previewDismiss");
    g_queuePreviewFocus.reset();
    g_queueSelectionMode = !g_queueSelectionMode;
    g_queueSelectedHashes.clear();
    g_selectedHash.clear();
    g_panel.history.SelectionMode(g_queueSelectionMode
        ? winrt::Microsoft::UI::Xaml::Controls::ListViewSelectionMode::Multiple
        : winrt::Microsoft::UI::Xaml::Controls::ListViewSelectionMode::Single);
    if (!g_queueSelectionMode) {
        // A committed Rust write may still finish, but its reply no longer
        // owns a canceled selection draft or a later selection session.
        g_queueSelectionAddRequest = 0;
        g_queueSelectionAdding = false;
        g_queueSubmittedHashes.clear();
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
    if (!g_queueSelectionAdding) {
        g_queueSubmittedHashes.clear();
        ShowFeedback(Text(L"无法发送加入队列请求，请重试。", L"Could not send the queue add request. Try again."), true);
    }
    UpdateQueueSelectionControls();
}

winrt::fire_and_forget ConfirmDeleteTab(std::wstring id) {
    if (g_deleteConfirmationOpen || g_tabDeleteRequest || !g_panel.root || NativeEditorOpen() ||
        (g_panel.cardDrag && g_panel.cardDrag->Active())) co_return;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    const auto filter = std::find_if(g_customFilters.begin(), g_customFilters.end(),
        [&](auto const &draft) { return draft.GetNamedString(L"id") == id; });
    const auto tag = std::find_if(g_tagIds.begin(), g_tagIds.end(),
        [&](auto tagId) { return RecordTabId(tagId) == id; });
    if (filter == g_customFilters.end() && tag == g_tagIds.end()) co_return;
    const bool record = filter == g_customFilters.end();
    const auto tagId = record ? *tag : 0;
    const std::wstring name = record ? g_tagNames[tag - g_tagIds.begin()]
        : std::wstring{filter->GetNamedString(L"name")};
    const auto focusReturn = EditorFocusReturn(id);
    g_searchSubmitRequestId = 0;
    g_deleteConfirmationOpen = true;
    ContentDialog dialog{nullptr};
    bool completed = false;
    try {
        const auto description = record
            ? g_english ? L"Remove tag “" + name + L"” from all records? History records will be kept."
                        : L"从全部记录中删除标签「" + name + L"」？历史记录保留。"
            : g_english ? L"Delete “" + name + L"”? History records will be kept."
                        : L"删除「" + name + L"」？历史记录会保留。";
        dialog = vpaste::winui::MakeConfirmationDialog(g_panel.root,
            Text(L"删除标签", L"Delete Tab"), winrt::hstring{description},
            Text(L"删除", L"Delete"), Text(L"取消", L"Cancel"));
        g_panel.deletionDialog = dialog;
        const auto result = co_await dialog.ShowAsync();
        if (g_panel.deletionDialog != dialog) co_return;
        g_panel.deletionDialog = nullptr;
        g_deleteConfirmationOpen = false;
        completed = true;
        if (result == ContentDialogResult::Primary && g_panel.root.IsLoaded()) {
            JsonObject payload;
            if (record) payload.Insert(L"tagId", JsonValue::CreateNumberValue(static_cast<double>(tagId)));
            else payload.Insert(L"tabId", JsonValue::CreateStringValue(id));
            g_tabDeleteOperation = record ? L"recordTagDelete" : L"filtersDelete";
            g_tabDeleteRequest = SendEditorRequest(g_tabDeleteOperation, payload);
            if (!g_tabDeleteRequest) ShowFeedback(Text(L"删除失败，请重试", L"Could not delete; try again"), true);
        }
        focusReturn();
    } catch (winrt::hresult_error const &error) {
        if (!completed && g_panel.deletionDialog != dialog) co_return;
        g_panel.deletionDialog = nullptr;
        g_deleteConfirmationOpen = false;
        ShowFeedback(error.message(), true);
        focusReturn();
    }
}

winrt::fire_and_forget DeleteCard(std::wstring hash) {
    const auto card = FindCard(hash);
    if (g_queueSelectionMode || g_panel.tagManagerViewActive || g_deleteConfirmationOpen ||
        NativeEditorOpen() || !HistoryRowsCurrent() || !card ||
        (g_panel.cardDrag && g_panel.cardDrag->Active())) co_return;
    const CardTarget target{hash, card->recordId};
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    const auto restoreFocus = EditorFocusReturn({}, hash);
    g_searchSubmitRequestId = 0;
    ContentDialog dialog{nullptr};
    g_deleteConfirmationOpen = true;
    try {
        dialog = vpaste::winui::MakeConfirmationDialog(g_panel.root, Text(L"删除记录", L"Delete record"),
            Text(L"删除这条历史记录？", L"Delete this history record?"), Text(L"删除", L"Delete"), Text(L"取消", L"Cancel"));
        g_panel.deletionDialog = dialog;
        const auto result = co_await dialog.ShowAsync();
        if (g_panel.deletionDialog != dialog) co_return;
        if (result == ContentDialogResult::Primary && PanelVisible() && !g_queueSelectionMode) {
            if (!HistoryRowsMatchSearch() || !FindCard(target)) {
                ShowFeedback(Text(L"历史记录已变更，请重新选择要删除的记录", L"History changed. Select the record again to delete it."), true);
            } else if (!HistoryRowsCurrent()) {
                ShowFeedback(Text(L"历史记录正在刷新，请加载完成后重试", L"History is refreshing. Try deleting again after it loads."), true);
            } else {
                (void)SendRequest(L"previewDismiss");
                if (!SendRequest(L"delete", target.hash))
                    ShowFeedback(Text(L"删除失败，请重试", L"Could not delete. Try again."), true);
            }
        }
    } catch (winrt::hresult_error const &error) {
        if (g_panel.deletionDialog != dialog) co_return;
        ShowFeedback(error.message(), true);
    }
    g_panel.deletionDialog = nullptr;
    g_deleteConfirmationOpen = false;
    restoreFocus();
}

void EditSelectedItem() {
    if (g_queueSelectionMode || !HistoryRowsCurrent() || g_selectedHash.empty()) return;
    const auto found = std::find(g_hashes.begin(), g_hashes.end(), g_selectedHash);
    if (found == g_hashes.end()) return;
    const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
    if (index < g_panel.rows.size() && IsEditableTextItem(g_panel.rows[index].itemType)) {
        (void)SendRequest(L"edit", g_selectedHash);
    }
}

winrt::Microsoft::UI::Xaml::Controls::MenuFlyout EnsureCardContextMenu(
    HistoryRowVisual &row, std::wstring const &hash) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    const CardTarget target{hash, row.recordId};
    const auto requestCardAction = GuardedCardAction(target);
    if (row.contextMenu) {
        if (!row.contextMenu.IsOpen() && row.pendingMenuActions) {
            vpaste::winui::UpdateCardActions(
                row.menu, std::exchange(row.pendingMenuActions, nullptr), hash, requestCardAction);
        }
        return row.contextMenu;
    }
    // 卡片右键菜单按需懒创建：常规列表渲染不再为 36 张卡片同步构造数百个菜单项与 SVG 图标。
    MenuFlyout flyout;
    flyout.Placement(Controls::Primitives::FlyoutPlacementMode::Top);
    MenuFlyoutItem pasteItem;
    pasteItem.Text(Text(L"复制并粘贴", L"Copy and paste"));
    pasteItem.Icon(SymbolIcon{Symbol::Paste});
    pasteItem.KeyboardAcceleratorTextOverride(L"Enter");
    pasteItem.Click([hash, requestCardAction](auto const &, auto const &) {
        (void)requestCardAction(L"paste", hash, {});
    });
    MenuFlyoutItem deleteItem;
    deleteItem.Text(Text(L"删除记录", L"Delete record"));
    deleteItem.Icon(SymbolIcon{Symbol::Delete});
    deleteItem.KeyboardAcceleratorTextOverride(L"Delete");
    deleteItem.Click([hash, target](auto const &, auto const &) {
        if (FindCard(target)) DeleteCard(hash);
    });
    flyout.Items().Append(deleteItem);
    flyout.Items().Append(MenuFlyoutSeparator{});
    const auto menuExtras = vpaste::winui::AppendCardActions(
        flyout, hash, row.itemType, g_english, requestCardAction);
    const auto tagSlot = flyout.Items().Size();
    flyout.Items().Append(MenuFlyoutItem{});
    MenuFlyoutItem favoriteItem;
    const bool favorite = row.favorite;
    favoriteItem.Text(favorite ? Text(L"取消收藏", L"Remove favorite") : Text(L"收藏", L"Add favorite"));
    favoriteItem.Icon(SymbolIcon{favorite ? Symbol::UnFavorite : Symbol::Favorite});
    favoriteItem.Click([target, favorite](auto const &, auto const &) {
        if (!g_queueSelectionMode && HistoryRowsCurrent() && FindCard(target) &&
            !SendRequest(L"favorite", target.hash, !favorite))
            ShowFeedback(Text(L"收藏更改未发送，请重试", L"Could not send the favorite change. Try again."), true);
    });
    flyout.Items().Append(favoriteItem);
    if (IsEditableTextItem(row.itemType)) {
        MenuFlyoutItem editItem;
        editItem.Text(Text(L"编辑文本", L"Edit text"));
        editItem.Icon(SymbolIcon{Symbol::Edit});
        editItem.KeyboardAcceleratorTextOverride(L"F2");
        editItem.Click([hash, requestCardAction](auto const &, auto const &) {
            (void)requestCardAction(L"edit", hash, {});
        });
        flyout.Items().Append(editItem);
    } else if (row.itemType == L"Image") {
        flyout.Items().Append(vpaste::winui::MakeImageTextAction(hash, g_english, requestCardAction));
    }
    MenuFlyoutItem previewItem;
    previewItem.Text(Text(L"预览", L"Preview"));
    previewItem.Icon(vpaste::winui::Glyph(L"\uE890"));
    previewItem.KeyboardAcceleratorTextOverride(L"Space");
    previewItem.Click([target](auto const &, auto const &) {
        if (!HistoryRowsCurrent() || !FindCard(target)) return;
        if (g_queueSelectionMode) ToggleQueueCardPreview(target.hash);
        else (void)SendCardAction(L"previewToggle", target.hash, {});
    });
    flyout.Items().Append(previewItem);
    if (menuExtras.pastePlain) {
        menuExtras.pastePlain.KeyboardAcceleratorTextOverride(
            g_behavior.plainBinding.key ? vpaste::winui::ShortcutLabel(g_behavior.plainShortcut) : L"");
        flyout.Items().Append(menuExtras.pastePlain);
    }
    flyout.Items().Append(pasteItem);
    // 保留的卡片可能跨越多轮标签变更，打开时动态刷新标签子菜单与延迟到达的详情操作。
    const auto createTagRequested = std::make_shared<bool>(false);
    const auto keyboardMenu = std::make_shared<bool>(false);
    const auto hiddenQueueCommands = std::make_shared<std::vector<MenuFlyoutItemBase>>();
    flyout.Opening([target, tagSlot, createTagRequested, keyboardMenu, hiddenQueueCommands,
                    preview = winrt::make_weak(previewItem)]
                   (auto const &sender, auto const &) {
        *keyboardMenu = g_panel.menuInput->keyboardGesture;
        if (auto *card = FindCard(target)) {
            const auto menu = sender.as<MenuFlyout>();
            menu.Items().SetAt(tagSlot, MakeCardTagEntry(target, card->tagIds, createTagRequested));
            if (card->pendingMenuActions)
                vpaste::winui::UpdateCardActions(card->menu, std::exchange(card->pendingMenuActions, nullptr),
                    target.hash, GuardedCardAction(target));
            if (g_queueSelectionMode) {
                for (const auto &item : menu.Items()) {
                    if (item != preview.get() && item.Visibility() == Visibility::Visible) {
                        item.Visibility(Visibility::Collapsed);
                        hiddenQueueCommands->push_back(item);
                    }
                }
            } else if (HistoryRowsCurrent()) {
                const auto index = static_cast<int>(card - g_panel.rows.data());
                if (g_panel.history.SelectedIndex() != index) g_panel.history.SelectedIndex(index);
            }
        }
    });
    flyout.Opened([keyboardMenu, primary = winrt::make_weak(pasteItem), preview = winrt::make_weak(previewItem)]
                  (auto const &sender, auto const &) {
        g_searchSubmitRequestId = 0;
        CancelHoverPreview();
        if (!*keyboardMenu) return;
        const auto command = g_queueSelectionMode ? preview : primary;
        const auto popup = winrt::make_weak(sender.as<MenuFlyout>());
        g_panel.root.DispatcherQueue().TryEnqueue([command, popup] {
            const auto menu = popup.get();
            if (!menu || !menu.IsOpen()) return;
            if (const auto item = command.get(); item && item.IsLoaded()) item.Focus(FocusState::Keyboard);
        });
    });
    flyout.Closed([target, createTagRequested, keyboardMenu, hiddenQueueCommands](auto const &, auto const &) {
        for (const auto &item : *hiddenQueueCommands) item.Visibility(Visibility::Visible);
        hiddenQueueCommands->clear();
        const bool create = std::exchange(*createTagRequested, false);
        const bool keyboard = std::exchange(*keyboardMenu, false);
        if (!g_panel.root || (!create && !keyboard)) return;
        // 编辑器共享同一个 XamlRoot，等菜单轻关闭完成后再弹出或恢复焦点。
        g_panel.root.DispatcherQueue().TryEnqueue([target, create] {
            const auto card = FindCard(target);
            if (!card || !PanelVisible() || NativeEditorOpen() || g_deleteConfirmationOpen) return;
            if (create && !g_queueSelectionMode && HistoryRowsCurrent()) {
                ShowRecordTagEditor(0, target.hash);
            } else if (!create && GetForegroundWindow() == g_panel.window) {
                const auto focused = Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot());
                if (NativeControlOwnsKeys(focused) || MainInputArea(focused) == vpaste::winui::InputArea::Search) return;
                const auto index = static_cast<int>(card - g_panel.rows.data());
                if (const auto container = g_panel.history.ContainerFromIndex(index).try_as<Control>())
                    container.Focus(FocusState::Keyboard);
            }
        });
    });
    vpaste::winui::BindMenuOpeningFocus(flyout, g_panel.menuInput);
    row.menu = menuExtras;
    row.contextMenu = flyout;
    row.surface.ContextFlyout(flyout);
    if (row.pendingMenuActions) {
        vpaste::winui::UpdateCardActions(
            row.menu, std::exchange(row.pendingMenuActions, nullptr), hash, requestCardAction);
    }
    return flyout;
}

winrt::hstring ItemTypeLabel(const winrt::hstring &type) {
    if (type == L"TextFile") return Text(L"文本", L"Text");
    return vpaste::winui::TypeLabel(type, g_english);
}

void ApplyResponse(const std::string &bytes) {
    bool applyingQuery = false;
    try {
        using namespace winrt::Windows::Data::Json;
        const auto response = JsonObject::Parse(winrt::to_hstring(bytes));
        const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
        const auto operation = response.GetNamedString(L"op", L"");
        if (operation == L"nativeTrayShow") {
            const auto data = response.GetNamedObject(L"data");
            if (g_panel.trayWindow) {
                g_panel.trayWindow->Show(data);
            } else {
                auto tray = std::make_unique<vpaste::winui::TrayWindow>([](const wchar_t *action, POINT point) {
                    JsonObject payload;
                    payload.Insert(L"argument", JsonValue::CreateStringValue(action));
                    payload.Insert(L"x", JsonValue::CreateNumberValue(point.x));
                    payload.Insert(L"y", JsonValue::CreateNumberValue(point.y));
                    return SendEditorRequest(L"nativeTrayAction", payload);
                });
                tray->Show(data);
                g_panel.trayWindow = std::move(tray);
            }
            return;
        }
        if (operation == L"nativeTrayState" || operation == L"nativeTrayAction") {
            if (!g_panel.trayWindow) return;
            if (operation == L"nativeTrayState") g_panel.trayWindow->Update(response.GetNamedObject(L"data"));
            else {
                const auto error = response.GetNamedString(L"error", L"");
                if (!error.empty()) std::fprintf(stderr, "WinUI tray action failed: %s\n", winrt::to_string(error).c_str());
                g_panel.trayWindow->Complete(id, error.empty());
            }
            return;
        }
        if (operation == L"nativeTutorialOpen" || operation == L"nativeTutorialState" || operation == L"nativeTutorialClose") {
            const auto data = response.GetNamedObject(L"data");
            const auto session = static_cast<std::uint64_t>(data.GetNamedNumber(L"session"));
            if (operation == L"nativeTutorialOpen") {
                SetTagManagerActive(false);
                if (g_queueViewActive) SetQueueViewActive(false);
                if (g_queueSelectionMode) ToggleQueueSelectionMode();
                if (g_panel.filterEditor) g_panel.filterEditor->Hide();
                if (g_panel.recordTagEditor) g_panel.recordTagEditor->Hide();
                g_deleteConfirmationOpen = false;
                if (const auto dialog = std::exchange(g_panel.deletionDialog, nullptr)) dialog.Hide();
                (void)SendRequest(L"previewDismiss");
                auto view = std::make_unique<vpaste::winui::OnboardingView>(data,
                    [](auto operation, auto const &payload) { return SendEditorRequest(operation, payload); });
                RemoveTutorial();
                CancelHoverPreview(); DismissFeedback(); ShowAltHints(false);
                winrt::Microsoft::UI::Xaml::Controls::Grid::SetRow(view->Root(), 1);
                g_panel.root.Children().Append(view->Root());
                g_panel.onboarding = std::move(view);
                SetTutorialInteraction(true);
            } else if (!g_panel.onboarding || session != g_panel.onboarding->Session()) {
                return;
            }
            if (operation == L"nativeTutorialClose") {
                RemoveTutorial();
                SetVisible(true, false);
                PostMessageW(g_panel.window, kFocusHistory, 0, 0);
                RefreshTags(); RequestHistory();
                return;
            }
            const auto items = data.GetNamedArray(L"items");
            if (g_panel.onboarding->Preview()) {
                g_tutorialPreviewFilters = FilterObjects(items);
                RebuildDynamicTabs();
            } else if (data.GetNamedBoolean(L"ready")) ApplyFilters(items);
            if (operation == L"nativeTutorialOpen") SetVisible(true, false);
            else g_panel.onboarding->Update(data, id);
            return;
        }
        if (operation == L"historyReset") {
            CancelHoverPreview();
            if (g_panel.imageExport) g_panel.imageExport->Cancel();
            for (auto const &row : g_panel.rows)
                if (const auto menu = row.contextMenu) menu.Hide();
            for (auto const &tab : g_panel.customTabs.Items())
                if (const auto menu = tab.ContextFlyout()) menu.Hide();
            g_searchSubmitRequestId = 0;
            ++g_editorGeneration;
            if (g_panel.filterEditor) g_panel.filterEditor->Hide();
            if (g_panel.recordTagEditor) g_panel.recordTagEditor->Hide();
            // A confirmation belongs to the dataset it was opened against,
            // even if its Primary result is already queued for continuation.
            g_deleteConfirmationOpen = false;
            if (const auto dialog = std::exchange(g_panel.deletionDialog, nullptr)) dialog.Hide();
            g_queueSelectionAddRequest = 0;
            g_queueSelectionAdding = false;
            g_queueSubmittedHashes.clear();
            g_queueSelectedHashes.clear();
            g_queueReturnHash.clear();
            g_queuePreviewFocus.reset();
            g_cardTagRequests.clear();
            g_recordTagAssignmentTarget.reset();
            g_textEditorRequestedCard.reset();
            g_textEditorOrigin.reset();
            g_textEditorRefreshAfterSave = false;
            g_textEditorReturnAfterQuery.reset();
            g_historyView.removedTabFallback.reset();
            if (g_queueSelectionMode) g_panel.history.SelectedItems().Clear();
            UpdateQueueSelectionControls();
            g_historyView.resetOnShow = true;
            if (g_panel.tagManagerViewActive && g_panel.tagManager) g_panel.tagManager->Refresh(true);
            RefreshTags();
            RefreshFilters();
            RequestHistory();
            return;
        }
        if (operation == L"clipboardItemEdited") {
            const auto data = response.GetNamedObject(L"data");
            const auto prevHash = std::wstring(data.GetNamedString(L"previousHash", L""));
            const auto newHash = std::wstring(data.GetNamedString(L"hash", L""));
            if (!prevHash.empty()) {
                if (g_textEditorOrigin && g_textEditorOrigin->hash == prevHash && !newHash.empty()) {
                    g_textEditorOrigin->hash = newHash;
                    g_textEditorRefreshAfterSave = true;
                }
                if (g_selectedHash == prevHash && !newHash.empty()) g_selectedHash = newHash;
                if (g_queueReturnHash == prevHash && !newHash.empty()) g_queueReturnHash = newHash;
                for (auto &itemHash : g_hashes) {
                    if (itemHash == prevHash && !newHash.empty()) itemHash = newHash;
                }
                bool touched = false;
                for (auto it = g_queueSelectedHashes.begin(); it != g_queueSelectedHashes.end();) {
                    if (*it == prevHash) {
                        touched = true;
                        if (newHash.empty() || std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), newHash) != g_queueSelectedHashes.end()) {
                            it = g_queueSelectedHashes.erase(it);
                        } else {
                            *it = newHash;
                            ++it;
                        }
                    } else {
                        ++it;
                    }
                }
                if (touched) {
                    if (g_queueSelectionMode) {
                        g_panel.status.Text(std::to_wstring(g_queueSelectedHashes.size()) + L" " + Text(L"条已选择", L"selected"));
                    }
                    UpdateQueueSelectionControls();
                    ApplyRowTheme();
                }
            }
            return;
        }
        if (operation == L"imageOcrUpdated") {
            if (!g_searchComposing &&
                std::wstring_view{SearchText()}.find_first_not_of(L" \t\r\n") != std::wstring_view::npos)
                RequestHistory(true);
            return;
        }
        if (operation == L"filtersChanged") {
            RefreshFilters();
            return;
        }
        if (operation == L"nativeReaderBegin" || operation == L"nativeReader" ||
            operation == L"nativeReaderHide" || operation == L"nativeReaderFocus" ||
            operation == L"nativeOcrState" || operation == L"nativeOcrImage" || operation == L"nativeOcrCopy") {
            if (g_queuePreviewFocus && (operation == L"nativeReaderBegin" || operation == L"nativeReaderHide")) {
                const auto generation = static_cast<std::uint64_t>(response.GetNamedObject(L"data").GetNamedNumber(L"generation"));
                if (operation == L"nativeReaderBegin" && !g_queuePreviewFocus->ready) {
                    g_queuePreviewFocus->generation = generation;
                    g_queuePreviewFocus->closed = false;
                }
                // A WebView handoff retires the native reader at the same generation.
                else if (operation == L"nativeReaderHide" && g_queuePreviewFocus->generation &&
                         generation > g_queuePreviewFocus->generation)
                    g_queuePreviewFocus->closed = true;
            }
            if (g_panel.reader) g_panel.reader->Receive(response);
            return;
        }
        if (operation == L"nativeEditorOpen") {
            if (!g_panel.textEditor) {
                const auto failure = Text(L"无法打开文字编辑器，请重试。", L"Could not open the text editor. Try again.");
                if (response.HasKey(L"error")) {
                    ShowFeedback(failure, true);
                    return;
                }
                const auto data = response.GetNamedObject(L"data");
                const auto generation = static_cast<std::uint64_t>(data.GetNamedNumber(L"generation"));
                const auto error = data.GetNamedString(L"error", L"");
                if (!error.empty()) {
                    ShowFeedback(error == L"editor.missing" ? Text(L"找不到原剪贴记录。",
                        L"The original clipboard record is no longer available.") : failure, true);
                    (void)SendDocumentRequest(L"nativeEditorClose", generation, {});
                    return;
                }
                auto editor = std::make_unique<vpaste::winui::Reader>(
                    [](auto const &op, auto generation, auto const &document) {
                        return SendDocumentRequest(op.c_str(), generation, document);
                    }, g_panel.window, true);
                editor->SetAppearance(g_english, g_panel.root.RequestedTheme());
                try {
                    editor->Receive(response);
                    g_panel.textEditor = std::move(editor);
                    g_textEditorOrigin = std::exchange(g_textEditorRequestedCard, std::nullopt);
                    g_textEditorReturnAfterQuery.reset();
                } catch (...) {
                    ShowFeedback(failure, true);
                    (void)SendDocumentRequest(L"nativeEditorClose", generation, {});
                    throw;
                }
            }
            return;
        }
        if (operation == L"nativeEditorSave" || operation == L"nativeEditorRaise") {
            if (g_panel.textEditor) g_panel.textEditor->Receive(response);
            return;
        }
        if (operation == L"edit") {
            if (id != g_textEditorOpenRequest) return;
            g_textEditorOpenRequest = 0;
            // The native open message precedes the acknowledgement. The rich editor owns its focus.
            g_textEditorRequestedCard.reset();
        }
        if (operation == L"nativeEditorClosed") {
            const auto generation = static_cast<std::uint64_t>(response.GetNamedObject(L"data").GetNamedNumber(L"generation"));
            if (!g_panel.textEditor || g_panel.textEditor->Generation() != generation) return;
            g_panel.textEditor.reset();
            const auto origin = std::exchange(g_textEditorOrigin, std::nullopt);
            const bool refreshAfterSave = std::exchange(g_textEditorRefreshAfterSave, false);
            SetVisible(true, false);
            if (origin && !g_queueSelectionMode) {
                if (SelectEditorOrigin(*origin)) ApplyRowTheme();
                if (refreshAfterSave || !HistoryRowsCurrent())
                    g_textEditorReturnAfterQuery = TextEditorReturn{*origin, CurrentHistoryQuery(), g_selectedHash};
            }
            PostMessageW(g_panel.window, kFocusHistory, 0, 0);
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
        if (g_tabDeleteRequest && id == g_tabDeleteRequest && operation == g_tabDeleteOperation) {
            g_tabDeleteRequest = 0;
            g_tabDeleteOperation.clear();
            if (response.HasKey(L"error")) ShowFeedback(response.GetNamedString(L"error"), true);
            else {
                if (operation == L"filtersDelete") RefreshFilters();
                else RefreshTags();
                ShowFeedback(Text(L"标签已删除，剪贴项仍然保留", L"Tag deleted; clipboard items kept"));
            }
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
            if (operation == L"recordTagAssign" && !g_cardTagRequests.erase(id)) return;
            if (g_panel.recordTagEditor) g_panel.recordTagEditor->Receive(response);
            if (operation == L"recordTagAssign" && !response.HasKey(L"error")) RequestHistory(true);
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
            if (g_queueSelectionMode) return;
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
            if (operation == L"previewToggle" && g_queuePreviewFocus && id == g_queuePreviewFocus->request) {
                if (response.HasKey(L"error") || !g_queuePreviewFocus->generation) g_queuePreviewFocus.reset();
                else g_queuePreviewFocus->ready = true;
            }
            if ((operation == L"dismiss" || id == g_latestPreviewRequestId) && response.HasKey(L"error")) {
                g_panel.status.Text(response.GetNamedString(L"error"));
                ShowFeedback(g_panel.status.Text(), true);
            }
            return;
        }
        if (operation == L"query" || operation == L"queryMore") {
            if (id < g_latestHistoryRequestId || id <= g_historyView.discardThrough || g_searchComposing) return;
            if (id == g_latestHistoryRequestId && g_historyView.requestedQuery != CurrentHistoryQuery()) return;
            applyingQuery = operation == L"query";
        }
#ifdef _DEBUG
        const auto responseStarted = std::chrono::steady_clock::now();
        if (operation == L"query" && id == g_latestQueryId)
            std::fprintf(stderr, "WinUI query response: id=%llu waitMs=%.2f\n", static_cast<unsigned long long>(id),
                std::chrono::duration<double, std::milli>(responseStarted - g_queryStarted).count());
#endif
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
            const bool selectionAdd = operation == L"queueAdd" && id == g_queueSelectionAddRequest && g_queueSelectionAdding;
            if (operation == L"queueAdd" && !selectionAdd && !queueHandled) {
                if (!response.HasKey(L"error") && g_panel.queueView)
                    g_panel.queueView->SetState(response.GetNamedObject(L"data"), /*preserveFeedback=*/true);
                return;
            }
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
            if (operation == L"queueStateUpdate") {
                const auto stateData = response.GetNamedObject(L"data");
                if (stateData.HasKey(L"active") && !stateData.GetNamedBoolean(L"active") && g_queueViewActive) {
                    SetQueueViewActive(false);
                    return;
                }
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
        if (operation == L"assignTag" || operation == L"removeTag" || operation == L"clearTags") {
            if (!g_cardTagRequests.erase(id)) return;
            const bool failed = response.HasKey(L"error");
            ShowFeedback(failed ? response.GetNamedString(L"error") : Text(L"标签已更新", L"Tags updated"), failed);
            RequestHistory(true);
            return;
        }
        if (response.HasKey(L"error")) {
            if (operation == L"tags") {
                g_recordTagsLoaded = false;
                g_recordTagsFailed = true;
            }
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
                operation == L"delete" || operation == L"edit" ||
                operation == L"copyPlain" || operation == L"pastePlain" || operation == L"quickPaste" || operation == L"openFolder" ||
                operation == L"copyFolder" || operation == L"copyColor" || operation == L"imageText") {
                ShowFeedback(g_panel.status.Text(), true);
            }
            if (operation == L"query") {
                FailHistoryQuery(g_panel.status.Text());
            } else if (operation == L"queryMore") {
                g_historyView.pageFailed = true;
                g_historyLoading = false;
                g_panel.more.IsEnabled(g_hasMore);
                UpdateHistoryState();
                ShowFeedback(g_panel.status.Text(), true);
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
            g_recordTagsLoaded = true;
            g_recordTagsFailed = false;
            const bool selectionChanged = RebuildTagFilter();
            if (!selectionChanged && g_latestQueryId == 0) RequestHistory();
            return;
        }
        if (operation == L"card") {
            const auto hash = std::wstring(data.GetNamedString(L"hash", L""));
            const auto found = std::find(g_hashes.begin(), g_hashes.end(), hash);
            if (found == g_hashes.end()) return;
            const auto index = static_cast<std::size_t>(std::distance(g_hashes.begin(), found));
            if (index >= g_panel.rows.size()) return;
            auto &row = g_panel.rows[index];
            // A retained row can still be awaiting a detail request made before
            // the latest history refresh. Validate its own request, not the list's.
            if (!id || id != row.cardRequestId) return;
            row.cardRequestId = id;
            row.pendingBitmap = nullptr;
            SetCardDetailState(row, CardDetailState::Ready);
            const auto actions = data.GetNamedValue(L"actions", nullptr);
            if (actions && actions.ValueType() == JsonValueType::Object) {
                if (!row.contextMenu || row.contextMenu.IsOpen()) row.pendingMenuActions = actions.GetObject();
                else vpaste::winui::UpdateCardActions(row.menu, actions.GetObject(), hash, GuardedCardAction({hash, row.recordId}));
            }
            row.accent = ParseColor(data.GetNamedString(L"titleColor", L""));
            const auto headerValue = data.GetNamedValue(L"headerColor", nullptr);
            if (headerValue && headerValue.ValueType() == JsonValueType::Object) {
                const auto color = headerValue.GetObject();
                row.accent = Rgb(static_cast<std::uint8_t>(color.GetNamedNumber(L"r", 0)),
                    static_cast<std::uint8_t>(color.GetNamedNumber(L"g", 0)),
                    static_cast<std::uint8_t>(color.GetNamedNumber(L"b", 0)));
            }
            row.visualType = data.GetNamedString(L"visualType", row.itemType);
            row.type.Text(ItemTypeLabel(row.visualType));
            const auto sourcePath = data.GetNamedString(L"appIconPath", L"");
            row.sourceIcon.Source(nullptr);
            row.sourceFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
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
            const bool contrast = vpaste::winui::HighContrastEnabled();
            if (!contrast) row.header.Background(CardHeaderBrush(row));
            ApplyFormatBadgeColors(row, contrast);
            const auto detail = data.GetNamedString(L"displayText", L"");
            // A successful replacement is authoritative. Retain reference
            // content during requests/failures, not stale decoded/rich surfaces.
            row.image.Source(nullptr);
            row.image.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
            row.contentIcon.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
            row.richAutoPreview.reset();
            row.richFrame.Child(nullptr);
            row.richFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
            const bool richText = data.GetNamedBoolean(L"isRichText", false);
            row.isRichText = richText;
            SetFormatBadge(row.richBadgeFrame, richText);
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
                row.preview.MaxLines(row.itemType == L"Link" ? 1 : 2);
                row.format.Text(data.GetNamedString(L"fileFormat", L""));
                row.format.Visibility(row.format.Text().empty() ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                    : winrt::Microsoft::UI::Xaml::Visibility::Visible);
                if (row.itemType == L"File") row.contentIcon.Glyph(fileCount > 1 ? L"\uE8C8"
                    : data.GetNamedString(L"fileKind", L"") == L"single-folder" ? L"\uE8B7" : L"\uE8A5");
            }
            if (row.itemType == L"File") {
                const auto file = data.GetNamedValue(L"filePresentation", nullptr);
                if (file && file.ValueType() == JsonValueType::Object) {
                    row.fileData = file.GetObject();
                    UpdateFilePresentation(row, true);
                    row.fileInvalidBadge.Visibility(row.fileData.GetNamedBoolean(L"exists")
                        ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed : winrt::Microsoft::UI::Xaml::Visibility::Visible);
                    row.filePresentation.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                    row.preview.Text(row.fileData.GetNamedString(L"path"));
                    row.subtitle.Text(row.fileData.GetNamedString(L"secondary"));
                    row.subtitle.Visibility(row.subtitle.Text().empty() ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                        : winrt::Microsoft::UI::Xaml::Visibility::Visible);
                    winrt::Microsoft::UI::Xaml::Controls::ToolTipService::SetToolTip(row.preview,
                        winrt::box_value(row.fileData.GetNamedString(L"fullPath")));
                }
                row.preview.MaxLines(1); row.format.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                row.contentIcon.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
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
            SetFormatBadge(row.gifBadgeFrame, data.GetNamedBoolean(L"isGif", false) ||
                ((row.itemType == L"Image" || data.GetNamedString(L"fileKind", L"") == L"single-preview") && media.GetNamedBoolean(L"isGif", false)));
            row.imageWidth = media.GetNamedNumber(L"width", 0); row.imageHeight = media.GetNamedNumber(L"height", 0);
            row.linkIcon = data.GetNamedString(L"imageKind", L"") == L"icon";
            ApplyNaturalImageBounds(row);
            const auto dimensions = row.itemType == L"Image" || row.itemType == L"File" ? data.GetNamedString(L"dimensions", L"")
                : row.itemType == L"Link" ? winrt::hstring{}
                : winrt::hstring{vpaste::winui::MediaCaption(media, data.GetNamedString(L"dimensions", L""), g_english, false)};
            row.dimensions.Text(dimensions);
            row.dimensions.Visibility(dimensions.empty()
                                          ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                                          : winrt::Microsoft::UI::Xaml::Visibility::Visible);
            if (row.itemType == L"Image" || row.itemType == L"File") {
                // Detail replies can arrive before the first XAML layout;
                // the visual parent is not available yet. Retain its owner.
                row.dimensionsFrame.Visibility(row.dimensions.Visibility());
            }
            if (row.itemType == L"Image") {
                row.subtitle.Text(detail.empty() ? L"" : Text(L"含文本", L"Text included"));
                row.subtitle.Visibility(detail.empty() ? winrt::Microsoft::UI::Xaml::Visibility::Collapsed
                    : winrt::Microsoft::UI::Xaml::Visibility::Visible);
            }
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
                    SetCardRichContent(row, vpaste::winui::RenderRichContent(blocks, rich.GetNamedBoolean(L"darkCanvas", false), g_highlightTerms));
                    row.richFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Visible);
                    row.preview.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                    row.mediaFrame.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                    row.dimensions.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                }
            }
            HighlightCard(row);
            if (row.autoPreview) row.autoPreview->ContentChanged();
            UpdateCardPreviewMotion();
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
            } else {
                g_panel.status.Text(data.GetNamedString(
                    L"message", Text(L"操作已完成", L"Action completed")));
            }
            if (operation == L"copy" || operation == L"favorite" || operation == L"delete" ||
                operation == L"copyPlain" || operation == L"copyFolder" || operation == L"copyColor" ||
                operation == L"openFolder") ShowFeedback(g_panel.status.Text());
            return;
        }

        const auto previousHighlightTerms = g_highlightTerms;
        if (data.HasKey(L"highlightTerms") || operation == L"query") {
            g_highlightTerms.clear();
            for (const auto &term : data.GetNamedArray(L"highlightTerms", JsonArray{})) {
                if (term.ValueType() == JsonValueType::String && !term.GetString().empty()) g_highlightTerms.emplace_back(term.GetString());
                if (g_highlightTerms.size() == 8) break;
            }
        }
        const bool highlightTermsChanged = previousHighlightTerms != g_highlightTerms;
        const auto viewportOffset = HistoryOffset();
        const auto items = data.GetNamedArray(L"items");
        const bool removedTabFallback = operation == L"query" && std::exchange(g_historyView.removedTabFallback, {}).has_value();
        const bool sameQuery = g_historyView.requestedQuery == g_historyView.visibleQuery;
        const bool preserveRenderedHistory = operation == L"query" &&
            sameQuery && !highlightTermsChanged &&
            !g_panel.rows.empty() && g_panel.rows.size() == items.Size() &&
            g_historyView.renderedItems == items.Stringify();
        const bool animateResults = operation == L"query" && !g_historyView.resetOnShow &&
            g_historyView.requestedQuery != g_historyView.visibleQuery && !g_hashes.empty() && PanelVisible();
        const bool resetSelection = operation == L"query" && g_historyView.resetOnShow;
        const bool resetViewport = operation == L"query" && (g_historyView.resetOnShow || g_historyView.requestedQuery != g_historyView.visibleQuery);
        QueueHistoryOffset(resetViewport ? 0 : viewportOffset, id);
        std::optional<TextEditorReturn> editorReturn;
        if (operation == L"query") {
            g_textEditorRefreshAfterSave = false;
            editorReturn = std::exchange(g_textEditorReturnAfterQuery, std::nullopt);
            g_historyView.visibleQuery = g_historyView.requestedQuery;
            g_historyView.visibleQueryId = id;
            g_historyView.resetOnShow = false;
        }
        const auto editorTarget = editorReturn && !g_panel.textEditor && !g_queueSelectionMode &&
            editorReturn->query == g_historyView.visibleQuery && editorReturn->selection == g_selectedHash
            ? &editorReturn->target : nullptr;
        std::wstring selectionToRestore;
        std::uint64_t recordToRestore = 0;
        int previousSelectedIndex = -1;
        g_historyLoading = false;
        g_historyFailed = false;
        g_nextId = static_cast<std::uint64_t>(data.GetNamedNumber(L"nextId", 0));
        g_nextTime = static_cast<std::uint64_t>(data.GetNamedNumber(L"nextTime", 0));
        g_hasMore = data.GetNamedBoolean(L"hasMore", false);
        // Reopening or a no-op refresh must not discard decoded images, native
        // controls and their realized containers only to reconstruct them.
        if (preserveRenderedHistory) {
            const auto now = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
            for (std::uint32_t index = 0; index < items.Size(); ++index)
                g_panel.rows[index].time.Text(FormatCardTime(
                    static_cast<std::uint64_t>(items.GetObjectAt(index).GetNamedNumber(L"time", 0)), now));
            const bool selectionChanged = resetSelection && !g_queueSelectionMode && !g_hashes.empty() && g_selectedHash != g_hashes.front();
            if (resetSelection && !g_queueSelectionMode && !g_hashes.empty()) {
                g_updatingHistorySelection = true;
                g_panel.history.SelectedIndex(0); g_selectedHash = g_hashes.front();
                g_updatingHistorySelection = false;
                for (std::size_t index = 0; index < g_panel.rows.size(); ++index) UpdateCardOutline(index);
            }
            const bool editorRestored = editorTarget && SelectEditorOrigin(*editorTarget);
            if (editorRestored) {
                ApplyRowTheme();
                ScheduleEditorReturnFocus(*editorTarget, id);
            }
            g_panel.more.IsEnabled(g_hasMore);
            g_panel.status.Text(g_queueSelectionMode
                ? std::to_wstring(g_queueSelectedHashes.size()) + L" " + Text(L"条已选择", L"selected")
                : std::to_wstring(g_hashes.size()) + (g_hasMore ? L"+ " : L" ") + Text(L"条剪贴项", L"clipboard items"));
            UpdateHistoryState(); UpdateQueueSelectionControls();
            CompletePendingSubmit(id);
            if (!removedTabFallback && PanelVisible() && (selectionChanged || resetViewport || editorRestored))
                RequestSelectedPreview(L"previewSelect");
            return;
        }
        g_historyView.renderedItems = operation == L"query" ? items.Stringify() : L"";
        std::vector<HistoryRowVisual> retainedRows;
        g_updatingHistorySelection = true;
        if (operation == L"query") {
            if (!g_queueSelectionMode && !resetSelection) {
                selectionToRestore = g_selectedHash;
                if (!selectionToRestore.empty()) {
                    const auto prevIt = std::find(g_hashes.begin(), g_hashes.end(), selectionToRestore);
                    if (prevIt != g_hashes.end()) previousSelectedIndex = static_cast<int>(std::distance(g_hashes.begin(), prevIt));
                }
                if (const auto selected = FindCard(selectionToRestore)) recordToRestore = selected->recordId;
            }
            // A copied item can prepend a query while the dock is opening.
            // Retain unchanged rendered cards/decoded bitmaps, not just the
            // special case where the entire response is byte-for-byte equal.
            retainedRows = std::move(g_panel.rows);
            g_hashes.clear();
            g_selectedHash.clear();
            g_favorites.clear();
            g_panel.rows.clear();
            g_panel.cardRequested.clear();
        }
        for (std::uint32_t index = 0; index < items.Size(); ++index) {
            const auto item = items.GetObjectAt(index);
            const auto itemSummary = item.Stringify();
            const auto hash = item.GetNamedString(L"hash", L"");
            const auto type = item.GetNamedString(L"itemType", L"Text");
            const auto preview = item.GetNamedString(L"previewText", L"");
            const auto source = item.GetNamedString(L"appSource", L"");
            const bool favorite = item.GetNamedBoolean(L"favorite", false);
            const auto retained = std::find_if(retainedRows.begin(), retainedRows.end(),
                [&](auto const &row) {
                    // Rich search ranges are embedded in its rendered runs.
                    // Rebuild only that card when terms change; pending details
                    // and ordinary/image cards can use the current terms in place.
                    return row.frame && row.summary == itemSummary &&
                        !(highlightTermsChanged && row.richFrame.Child());
                });
            if (retained != retainedRows.end()) {
                HighlightCard(*retained);
                retained->shortcutHint.Child().as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>().Text(
                    L"Alt+" + std::to_wstring(index + 1));
                retained->shortcutHint.Visibility(g_altHints && index < 9
                    ? winrt::Microsoft::UI::Xaml::Visibility::Visible : winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
                retained->time.Text(FormatCardTime(static_cast<std::uint64_t>(item.GetNamedNumber(L"time", 0)),
                    static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch()).count())));
                g_hashes.emplace_back(hash); g_favorites.push_back(favorite);
                g_panel.cardRequested.push_back(retained->cardRequestId != 0);
                g_panel.rows.push_back(std::move(*retained));
                continue;
            }
            const auto tagsArray = item.GetNamedArray(L"tags", winrt::Windows::Data::Json::JsonArray{});
            std::vector<winrt::hstring> tagNames;
            std::vector<std::int64_t> tagIds;
            for (std::uint32_t tagIndex = 0; tagIndex < tagsArray.Size(); ++tagIndex) {
                const auto tag = tagsArray.GetObjectAt(tagIndex);
                const auto tagId = static_cast<std::int64_t>(tag.GetNamedNumber(L"id", 0));
                if (tagId > 0) tagIds.push_back(tagId);
                tagNames.push_back(tag.GetNamedString(L"name", L""));
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
            const auto formatBadge = [&](winrt::hstring const &label) {
                auto text = MakeText(label, 10);
                text.FontWeight(winrt::Microsoft::UI::Text::FontWeights::SemiBold());
                text.VerticalAlignment(VerticalAlignment::Center);
                text.TextWrapping(TextWrapping::NoWrap);
                Border frame; frame.Height(16); frame.Padding(Thickness{7, 0, 7, 0});
                frame.Visibility(Visibility::Collapsed);
                frame.CornerRadius(vpaste::winui::UniformRadius(8)); frame.Child(text);
                titleLine.Children().Append(frame);
                return std::pair{text, frame};
            };
            const auto [richBadge, richBadgeFrame] = formatBadge(Text(L"富文本", L"Rich"));
            const auto [gifBadge, gifBadgeFrame] = formatBadge(L"GIF");
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
            Border filePresentation;
            filePresentation.Visibility(type == L"File" ? Visibility::Visible : Visibility::Collapsed);
            mediaArea.Children().Append(filePresentation);
            Border colorSwatch;
            colorSwatch.CornerRadius(vpaste::winui::UniformRadius(4));
            colorSwatch.Visibility(Visibility::Collapsed);
            mediaArea.Children().Append(colorSwatch);
            Image mediaImage;
            mediaImage.Stretch(winrt::Microsoft::UI::Xaml::Media::Stretch::Uniform);
            mediaImage.Visibility(Visibility::Collapsed);
            Border imageMatte;
            imageMatte.Child(mediaImage);
            if (type == L"Image") {
                imageMatte.HorizontalAlignment(HorizontalAlignment::Center);
                imageMatte.VerticalAlignment(VerticalAlignment::Center);
            }
            mediaArea.Children().Append(imageMatte);
            TextBlock fileFormat = MakeText(L"", 11);
            fileFormat.HorizontalAlignment(HorizontalAlignment::Right);
            fileFormat.VerticalAlignment(VerticalAlignment::Bottom);
            fileFormat.Visibility(Visibility::Collapsed);
            mediaArea.Children().Append(fileFormat);
            Border fileInvalidBadge;
            vpaste::winui::ApplyStyle(fileInvalidBadge, L"VPaste.Surface");
            fileInvalidBadge.Width(24); fileInvalidBadge.Height(24);
            fileInvalidBadge.CornerRadius(vpaste::winui::UniformRadius(12));
            fileInvalidBadge.HorizontalAlignment(HorizontalAlignment::Right);
            fileInvalidBadge.VerticalAlignment(VerticalAlignment::Top); fileInvalidBadge.Margin(Thickness{0, 6, 6, 0});
            fileInvalidBadge.Padding(vpaste::winui::UniformThickness(3));
            const auto warning = vpaste::winui::Glyph(L"\uE7BA"); warning.FontSize(vpaste::winui::CompactIconSize);
            fileInvalidBadge.Child(warning); fileInvalidBadge.Visibility(Visibility::Collapsed);
            mediaArea.Children().Append(fileInvalidBadge);
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
            }
            std::shared_ptr<vpaste::winui::AutoScrollCardPreview> autoPreview;
            if (type == L"Text" || type == L"TextFile") {
                previewText.MaxLines(0); previewText.TextTrimming(TextTrimming::None);
                previewText.IsTextSelectionEnabled(false);
                autoPreview = vpaste::winui::AutoScrollCardPreview::Create(previewText);
                Grid::SetRow(autoPreview->viewport, 1); body.Children().Append(autoPreview->viewport);
            } else if (type != L"Color") body.Children().Append(previewText);
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

            const auto recordTags = vpaste::winui::CardRecordTags::Create(tagNames);
            const auto tagsText = recordTags->FirstLabel();
            Border tagChip = recordTags->surface;
            tagChip.Margin(Thickness{10, 38, 10, 0});
            tagChip.MaxWidth(kCardWidth - 20);
            tagChip.HorizontalAlignment(HorizontalAlignment::Stretch);
            tagChip.VerticalAlignment(VerticalAlignment::Top);
            tagChip.Visibility(tagNames.empty() ? Visibility::Collapsed : Visibility::Visible);
            Grid::SetRowSpan(tagChip, 2);
            TextBlock dimensionsText = MakeText(L"", 12);
            dimensionsText.Visibility(Visibility::Collapsed);
            Border dimensionsFrame{nullptr};
            if (type == L"Image" || type == L"File") {
                Border metadata;
                vpaste::winui::ApplyStyle(metadata, L"VPaste.Surface");
                metadata.CornerRadius(vpaste::winui::UniformRadius(4));
                metadata.Padding(Thickness{6, 2, 6, 2}); metadata.Margin(Thickness{10, 0, 10, 8});
                metadata.HorizontalAlignment(HorizontalAlignment::Center);
                metadata.VerticalAlignment(VerticalAlignment::Bottom); metadata.IsHitTestVisible(false);
                metadata.Visibility(Visibility::Collapsed);
                metadata.Child(dimensionsText); mediaArea.Children().Append(metadata);
                dimensionsFrame = metadata;
            } else {
                Grid::SetRow(dimensionsText, 3); body.Children().Append(dimensionsText);
            }
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
            outline.CornerRadius(vpaste::winui::UniformRadius(kCardRadius + 4));
            // Keep the outside selection ring beside the rounded surface, not
            // inside its clipped content. The frame reserves a 4-DIP gutter.
            outline.Margin(Thickness{4, 0, 4, 0});
            outline.Visibility(Visibility::Collapsed);

            Border surface;
            surface.Width(kCardWidth);
            surface.Height(kCardHeight);
            surface.CornerRadius(vpaste::winui::UniformRadius(kCardRadius));
            surface.Margin(Thickness{8, 4, 8, 4});
            surface.Child(row);
            Grid cardFrame;
            // Virtualization and refresh must use the same fixed slot even
            // while rich/media details and the outside outline change.
            cardFrame.Width(kCardWidth + 16);
            cardFrame.Height(kCardHeight + 8);
            cardFrame.Children().Append(surface);
            cardFrame.Children().Append(outline);
            const auto rowHash = std::wstring(hash);
            const CardTarget target{rowHash, static_cast<std::uint64_t>(item.GetNamedNumber(L"id", 0))};
            const auto requestCardAction = GuardedCardAction(target);
            surface.PointerEntered([rowHash](auto const &, auto const &) {
                if (auto *current = FindCard(rowHash)) {
                    current->pointerOver = true;
                    UpdateCardPreviewMotion();
                    vpaste::winui::ApplyElevation(current->surface, vpaste::winui::HoveredCardElevation,
                        vpaste::winui::HighContrastEnabled(), g_panel.shadowReceiver);
                }
            });
            surface.PointerExited([rowHash](auto const &, auto const &) {
                if (auto *current = FindCard(rowHash)) {
                    current->pointerOver = false;
                    UpdateCardPreviewMotion();
                    vpaste::winui::ApplyElevation(current->surface, vpaste::winui::CardElevation,
                        vpaste::winui::HighContrastEnabled(), g_panel.shadowReceiver);
                }
            });
            Automation::AutomationProperties::SetHelpText(surface, source);
            surface.PointerMoved([rowHash, type](auto const &, auto const &args) {
                const auto point = args.GetCurrentPoint(g_panel.root);
                HoverHistoryCard(rowHash, type, point.Position(), IsCardAction(args.OriginalSource()), point.IsInContact());
            });
            surface.PointerExited([](auto const &, auto const &) {
                g_hoverPosition.reset(); g_hoverHash.clear();
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
                if (!HistoryRowsCurrent() || g_queueSelectionMode || IsCardAction(args.OriginalSource()) || !g_panel.cardDrag) {
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
                const auto current = FindCard(rowHash);
                if (!current) { args.Cancel(true); return; }
                g_panel.cardDrag->Start(sender.as<UIElement>(), args, rowHash, std::wstring{current->itemType},
                    current->isRichText || current->richBadgeFrame.Visibility() == Visibility::Visible);
            });
            surface.DropCompleted([](auto const &sender, auto const &args) {
                if (g_panel.cardDrag) g_panel.cardDrag->Finish(sender.as<UIElement>(), args.DropResult());
            });
            surface.PointerPressed([](auto const &, auto const &) { g_suppressDragTap = false; });
            favoriteButton.Click([target, favorite](auto const &, auto const &) {
                if (!g_queueSelectionMode && HistoryRowsCurrent() && FindCard(target) &&
                    !SendRequest(L"favorite", target.hash, !favorite))
                    ShowFeedback(Text(L"收藏更改未发送，请重试", L"Could not send the favorite change. Try again."), true);
            });
            // 右键或 Shift+F10/菜单键触发上下文菜单时才按需构建 MenuFlyout，避免切标签同步构造 36 套菜单。
            surface.ContextRequested([rowHash](auto const &,
                winrt::Microsoft::UI::Xaml::Input::ContextRequestedEventArgs const &args) {
                if (auto *current = FindCard(rowHash)) {
                    const auto flyout = EnsureCardContextMenu(*current, rowHash);
                    if (!flyout) return;
                    winrt::Windows::Foundation::Point point{};
                    if (args.TryGetPosition(current->surface, point)) flyout.ShowAt(current->surface, point);
                    else flyout.ShowAt(current->surface);
                    args.Handled(true);
                }
            });
            // Child actions must not bubble into the configured card paste gesture.
            favoriteButton.Tapped([](auto const &, auto const &args) { args.Handled(true); });
            favoriteButton.DoubleTapped([](auto const &, auto const &args) { args.Handled(true); });
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
                subtitleText, fileFormat, richFrame, richBadge, std::nullopt, std::move(tagIds), vpaste::winui::CardMenuExtras{}, shortcutHint});
            UpdateCardContent(g_panel.rows.back(), preview);
            auto &visual = g_panel.rows.back();
            visual.gifBadge = gifBadge;
            visual.richBadgeFrame = richBadgeFrame; visual.gifBadgeFrame = gifBadgeFrame;
            visual.frame = cardFrame; visual.summary = itemSummary;
            visual.favorite = favorite;
            visual.imageMatte = imageMatte;
            visual.filePresentation = filePresentation;
            visual.dimensionsFrame = dimensionsFrame;
            visual.fileInvalidBadge = fileInvalidBadge;
            visual.outline = outline; visual.tagChip = tagChip;
            visual.autoPreview = std::move(autoPreview); visual.recordTags = recordTags;
            visual.isRichText = item.GetNamedBoolean(L"isRichText", false);
            visual.recordId = target.recordId;
            visual.detailFeedback = detailFeedback; visual.detailStatus = detailStatus; visual.retryDetails = retryDetails;
            HighlightCard(visual);
            if (operation != L"query") g_panel.history.Items().Append(cardFrame);
            if (operation == L"queryMore" && g_queueSelectionMode &&
                std::find(g_queueSelectedHashes.begin(), g_queueSelectedHashes.end(), rowHash) !=
                    g_queueSelectedHashes.end()) {
                g_panel.history.SelectedItems().Append(cardFrame);
            }
        }
        bool hadHistoryFocus = false;
        if (operation == L"query" && g_panel.root && g_panel.root.XamlRoot() && PanelVisible()) {
            if (const auto focused = winrt::Microsoft::UI::Xaml::Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot())) {
                auto dep = focused.try_as<winrt::Microsoft::UI::Xaml::DependencyObject>();
                while (dep) {
                    if (dep == g_panel.history) {
                        hadHistoryFocus = true;
                        break;
                    }
                    dep = winrt::Microsoft::UI::Xaml::Media::VisualTreeHelper::GetParent(dep);
                }
            }
        }
        if (operation == L"query") {
            // Reconcile the live vector instead of resetting it: inserting a
            // fresh capture must not unload every existing card/container.
            const auto controls = g_panel.history.Items();
            for (auto index = controls.Size(); index > 0; --index) {
                const auto frame = controls.GetAt(index - 1).as<winrt::Microsoft::UI::Xaml::FrameworkElement>();
                if (std::none_of(g_panel.rows.begin(), g_panel.rows.end(),
                        [&](auto const &row) { return row.frame == frame; })) controls.RemoveAt(index - 1);
            }
            for (std::uint32_t index = 0; index < g_panel.rows.size(); ++index) {
                const auto frame = g_panel.rows[index].frame;
                std::uint32_t current = 0;
                if (controls.IndexOf(frame, current)) {
                    if (current == index) continue;
                    controls.RemoveAt(current);
                }
                controls.InsertAt(index, frame);
            }
            if (animateResults) for (std::size_t index = 0; index < g_panel.rows.size(); ++index)
                AnimateResultBatch(g_panel.rows[index].frame, index);
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
                        const auto item = g_panel.history.Items().GetAt(static_cast<std::uint32_t>(index));
                        std::uint32_t selectedIndex = 0;
                        if (!g_panel.history.SelectedItems().IndexOf(item, selectedIndex))
                            g_panel.history.SelectedItems().Append(item);
                    }
                }
            } else if (!g_hashes.empty()) {
                const auto found = std::find(g_hashes.begin(), g_hashes.end(), selectionToRestore);
                int selectedIndex = 0;
                if (found != g_hashes.end()) {
                    selectedIndex = static_cast<int>(std::distance(g_hashes.begin(), found));
                } else if (recordToRestore) {
                    const auto record = std::find_if(g_panel.rows.begin(), g_panel.rows.end(),
                        [&](auto const &row) { return row.recordId == recordToRestore; });
                    if (record != g_panel.rows.end()) selectedIndex = static_cast<int>(std::distance(g_panel.rows.begin(), record));
                    else if (sameQuery && previousSelectedIndex >= 0)
                        selectedIndex = std::min(previousSelectedIndex, static_cast<int>(g_hashes.size()) - 1);
                } else if (sameQuery && previousSelectedIndex >= 0) {
                    // 当前选中的记录被删除且同条件刷新后，将焦点回落到相邻下标而非无条件跳回首条。
                    selectedIndex = std::min(previousSelectedIndex, static_cast<int>(g_hashes.size()) - 1);
                }
                g_selectedHash = g_hashes[static_cast<std::size_t>(selectedIndex)];
                g_panel.history.SelectedIndex(selectedIndex);
            }
        }
        if (editorTarget && SelectEditorOrigin(*editorTarget)) ScheduleEditorReturnFocus(*editorTarget, id);
        g_updatingHistorySelection = false;
        UpdateQueueSelectionControls();
        UpdateHistoryState();
        ApplyRowTheme();
        UpdateCardPreviewMotion();
        if (hadHistoryFocus && PanelVisible() && g_panel.history && g_panel.history.IsLoaded()) {
            // 旧卡片容器刚被 RemoveAt 从树中移除时，WinUI 会把焦点回落到顶栏首控件；
            // 立即将焦点锚定回历史列表并在下一帧精确定位新选中卡片。
            if (g_panel.historyScroll) g_panel.historyScroll.BringIntoViewOnFocusChange(false);
            g_panel.history.Focus(winrt::Microsoft::UI::Xaml::FocusState::Programmatic);
            if (!g_hashes.empty()) ScheduleHistoryFocus();
        }
#ifdef _DEBUG
        if (operation == L"query") std::fprintf(stderr, "WinUI query render: id=%llu rows=%zu applyMs=%.2f\n",
            static_cast<unsigned long long>(id), g_panel.rows.size(),
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - responseStarted).count());
#endif
        if (removedTabFallback && !g_queueSelectionMode) {
            if (g_selectedHash.empty() || (!selectionToRestore.empty() && !FindCard(CardTarget{selectionToRestore, recordToRestore})))
                (void)SendRequest(L"previewDismiss");
        } else if (!g_queueSelectionMode && g_selectedHash.empty()) (void)SendRequest(L"previewDismiss");
        else if (operation == L"query" && PanelVisible() &&
                 (resetSelection || resetViewport || g_selectedHash != selectionToRestore)) {
            RequestSelectedPreview(L"previewSelect");
        }
        if (operation == L"query") CompletePendingSubmit(id);
    } catch (const winrt::hresult_error &error) {
        g_updatingHistorySelection = false;
        std::fprintf(stderr, "WinUI response failed: 0x%08X %s\n", static_cast<unsigned>(error.code()), winrt::to_string(error.message()).c_str());
        if (g_panel.status) {
            g_panel.status.Text(error.message());
            if (applyingQuery) FailHistoryQuery(error.message());
        }
    } catch (...) {
        g_updatingHistorySelection = false;
        if (g_panel.status) {
            g_panel.status.Text(Text(L"无法显示剪贴板历史", L"Could not display clipboard history"));
            if (applyingQuery) FailHistoryQuery(g_panel.status.Text());
        }
    }
}

void PrepareMainShow() {
    g_searchComposing = false;
    if (!g_behavior.retainPosition) {
        g_historyView.resetOnShow = true;
        QueueHistoryOffset(0, g_latestHistoryRequestId);
        if (!g_queueSelectionMode) { g_selectedHash.clear(); g_panel.history.SelectedIndex(-1); }
    } else QueueHistoryOffset(HistoryOffset(), g_latestHistoryRequestId);
    if (!g_behavior.retainSearch) {
        SetSearchText(L"");
        g_panel.search.Visibility(winrt::Microsoft::UI::Xaml::Visibility::Collapsed);
    }
    if (g_searchTimer && g_searchTimer.IsRunning()) g_searchTimer.Stop();
    if (!g_behavior.retainCategory) SelectBuiltinCategory(0, false);
}

void SetTutorialInteraction(bool active) {
    g_panel.history.Opacity(active ? 0 : 1);
    g_panel.emptyState.Opacity(active ? 0 : 1);
    g_panel.selectionBar.Opacity(active ? 0 : 1);
    g_panel.loading.Opacity(active ? 0 : 1);
    g_panel.staleHistory.Opacity(active ? 0 : 1);
    g_panel.staleHistory.IsHitTestVisible(!active);
    g_panel.history.IsHitTestVisible(!active);
    g_panel.emptyState.IsHitTestVisible(!active);
    g_panel.selectionBar.IsHitTestVisible(!active);
    g_panel.header.IsHitTestVisible(!active);
}

void RemoveTutorial() {
    if (g_panel.onboarding) {
        std::uint32_t index = 0;
        if (g_panel.root.Children().IndexOf(g_panel.onboarding->Root(), index)) g_panel.root.Children().RemoveAt(index);
        g_panel.onboarding.reset();
        SetTutorialInteraction(false);
    }
    if (g_tutorialPreviewFilters) {
        g_tutorialPreviewFilters.reset();
        RebuildDynamicTabs();
    }
}

void SetVisible(bool visible, bool freshShow = true, bool animate) noexcept {
    // 将整个可见性切换路径纳入 try/catch，避免 noexcept 函数内任意 WinRT 异常触发 std::terminate()。
    try {
        if (!visible) UpdateCardPreviewMotion(false);
        if (g_panel.root) g_panel.root.IsHitTestVisible(visible);
        if (!visible) CancelHoverPreview();
        if (!visible && !g_panel.tagManagerViewActive) g_historyView.parkedOffset = HistoryOffset();
        if (!visible) ShowAltHints(false);
        if (!visible) g_searchSubmitRequestId = 0;
        if (!visible) {
            g_latestPreviewRequestId = 0;
            g_queuePreviewFocus.reset();
            g_textEditorReturnAfterQuery.reset();
            g_historyView.removedTabFallback.reset();
        }
        if (!visible && g_panel.imageExport) g_panel.imageExport->Cancel();
        if (!visible && g_panel.appActions) g_panel.appActions->Deactivate();
        if (!visible && g_panel.deletionDialog) g_panel.deletionDialog.Hide();
        if (!visible && g_panel.filterEditor) g_panel.filterEditor->Hide();
        if (!visible && g_panel.recordTagEditor) g_panel.recordTagEditor->Hide();
        if (!visible && g_panel.cardDrag) {
            g_historyRefreshAfterDrag = false;
            g_panel.cardDrag->Cancel();
        }
        if (!visible) DismissFeedback();
        if (!visible) HideLoadingIndicator();
        if (g_panel.window != nullptr) {
            const bool entering = visible && (!g_panel.dockMotion->Visible() || IsIconic(g_panel.window));
            // 仅在休眠唤醒后的首次显示路径落盘脱敏诊断上下文，不改变原有显示与动画逻辑。
            if (entering) {
                if (const auto resumeContext = g_powerLifecycle.ConsumeFirstShowAfterResume(GetTickCount64())) {
                    LogPowerResumeFirstShow(*resumeContext, freshShow);
                }
            }
            if (entering && freshShow && !g_panel.tagManagerViewActive && !g_panel.onboarding) PrepareMainShow();
            if (entering) g_panel.root.UpdateLayout();
            try { g_panel.dockMotion->SetVisible(visible, animate && !g_panel.tagManagerViewActive); }
            catch (winrt::hresult_error const &error) {
                std::fprintf(stderr, "WinUI visibility failed: 0x%08X\n", static_cast<unsigned>(error.code()));
                LogWinUiError("dock_motion_set_visible", error.code(), winrt::to_string(error.message()));
                ShowWindow(g_panel.window, visible ? SW_SHOW : SW_HIDE);
            }
            if (visible) {
                (void)vpaste::winui::ActivateWindowFromBackground(g_panel.window);
                if (g_panel.onboarding) g_panel.onboarding->Shown();
                if (entering && !g_panel.tagManagerViewActive)
                    ShowAltHints((GetAsyncKeyState(VK_MENU) & 0x8000) != 0 &&
                        ((GetAsyncKeyState(VK_CONTROL) | GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) == 0);
                if (entering && !g_panel.onboarding) ScheduleHistoryFocus();
                UpdateCardPreviewMotion();
            }
        }
    } catch (winrt::hresult_error const &error) {
        std::fprintf(stderr, "WinUI SetVisible(%d) failed: 0x%08X %s\n",
            visible ? 1 : 0, static_cast<unsigned>(error.code()), winrt::to_string(error.message()).c_str());
        LogWinUiError(visible ? "set_visible_show" : "set_visible_hide", error.code(), winrt::to_string(error.message()));
        if (g_panel.window != nullptr) {
            ShowWindow(g_panel.window, visible ? SW_SHOW : SW_HIDE);
        }
    } catch (...) {
        const auto hr = winrt::to_hresult();
        std::fprintf(stderr, "WinUI SetVisible(%d) failed: 0x%08X\n",
            visible ? 1 : 0, static_cast<unsigned>(hr.value));
        LogWinUiError(visible ? "set_visible_show" : "set_visible_hide", hr);
        if (g_panel.window != nullptr) {
            ShowWindow(g_panel.window, visible ? SW_SHOW : SW_HIDE);
        }
    }
    if (g_visibilityChanged != nullptr) {
        g_visibilityChanged(visible);
    }
}

int32_t SetSizePreviewWindow(bool visible, bool restoreVisible) noexcept {
    if (!g_panel.window || !g_panel.root || !IsWindow(g_panel.window)) return E_UNEXPECTED;
    try {
        if (visible) {
            if (!g_sizePreviewActive) {
                g_sizePreviewRestoreHitTestVisible = g_panel.root.IsHitTestVisible();
                // The non-interactive preview takes position ownership from
                // any unfinished dock slide before it becomes visible.
                g_panel.dockMotion->Suspend();
                ApplyActiveLayout();
            }
            if (!SetWindowPos(g_panel.window, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE)) {
                return HRESULT_FROM_WIN32(GetLastError());
            }
            g_panel.root.IsHitTestVisible(false);
            g_sizePreviewActive = true;
            ShowWindow(g_panel.window, SW_SHOWNOACTIVATE);
        } else {
            g_sizePreviewActive = false;
            g_panel.root.IsHitTestVisible(g_sizePreviewRestoreHitTestVisible);
            if (restoreVisible && !SetWindowPos(g_panel.window, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE)) {
                const auto error = HRESULT_FROM_WIN32(GetLastError());
                ShowWindow(g_panel.window, SW_SHOWNOACTIVATE);
                return error;
            }
            ShowWindow(g_panel.window, restoreVisible ? SW_SHOWNOACTIVATE : SW_HIDE);
            g_sizePreviewRestoreHitTestVisible = true;
        }
        return S_OK;
    } catch (...) {
        g_sizePreviewActive = false;
        try {
            if (g_panel.root) g_panel.root.IsHitTestVisible(g_sizePreviewRestoreHitTestVisible);
        } catch (...) {}
        ShowWindow(g_panel.window, restoreVisible ? SW_SHOWNOACTIVATE : SW_HIDE);
        return winrt::to_hresult();
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
    // Windows' own show/restore transition must not animate on top of the
    // Rust-policy dock slide. Management windows retain their system effect.
    const BOOL disableTransitions = !management;
    (void)DwmSetWindowAttribute(g_panel.window, DWMWA_TRANSITIONS_FORCEDISABLED,
        &disableTransitions, sizeof(disableTransitions));
    // Keep the non-client frame for DWM's system shadow, while the dock's
    // NCCALCSIZE handler preserves its original full client bounds.
    const MARGINS shadow = management ? MARGINS{} : MARGINS{1, 1, 1, 1};
    (void)DwmExtendFrameIntoClientArea(g_panel.window, &shadow);
    ResizeIsland();
    // A display-layout reply may suspend the dock's hidden visibility state.
    // Keep the settings preview mapped without activating it.
    if (g_sizePreviewActive) ShowWindow(g_panel.window, SW_SHOWNOACTIVATE);
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) try {
    switch (message) {
    case vpaste::winui::DockFrameMessage:
        if (g_panel.dockMotion) g_panel.dockMotion->Frame();
        return 0;
    case WM_MOUSEACTIVATE:
        if (g_sizePreviewActive) return MA_NOACTIVATE;
        break;
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
    case kSetPreviewLayout:
        if (!lparam) return E_INVALIDARG;
        try {
            g_dockedLayout = *reinterpret_cast<const PanelLayout *>(lparam);
            ApplyActiveLayout();
            g_layoutPending = false;
            if (g_queueViewActive && g_panel.queueWindow) {
                g_panel.queueWindow->Show(g_dockedLayout.panelScale);
            }
            return S_OK;
        } catch (...) {
            return winrt::to_hresult();
        }
    case kSetSizePreview:
        return SetSizePreviewWindow(wparam != 0, lparam != 0);
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
        try {
            const bool show = !g_panel.dockMotion->Visible() || IsIconic(window);
            if (!show && g_panel.reader && g_panel.reader->HasOcrDraft()) {
                g_searchSubmitRequestId = 0;
                g_panel.reader->CloseOcrDraft([] { SetVisible(false); });
            } else SetVisible(show);
            return S_OK;
        } catch (...) {
            return winrt::to_hresult();
        }
    case kStopWindow:
        HideLoadingIndicator();
        if (g_panel.dockMotion) g_panel.dockMotion->Suspend();
        g_panel.tabIndicator.reset();
        if (g_panel.imageExport) g_panel.imageExport->Cancel();
        g_panel.trayWindow.reset();
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
        RequestHistory(true);
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
    case kFocusHistory: {
        if (PanelVisible() && !g_panel.onboarding && !g_panel.textEditor && !IsIconic(window) &&
            !g_panel.tagManagerViewActive && !g_deleteConfirmationOpen &&
            !NativeEditorOpen() && g_panel.history && g_panel.history.IsLoaded() &&
            g_panel.root && g_panel.root.IsLoaded()) {
            const auto island = winrt::Microsoft::UI::GetWindowFromWindowId(g_panel.xamlSource.SiteBridge().WindowId());
            const auto focusedWindow = GetFocus();
            // A late preview cleanup (e.g. from an empty result) may return
            // focus while this island already owns the user's search editing.
            // Only an explicit keyboard handoff may take that focus away.
            if (!wparam && island && (focusedWindow == island || IsChild(island, focusedWindow))) {
                const auto focused = winrt::Microsoft::UI::Xaml::Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot());
                if (MainInputArea(focused) == vpaste::winui::InputArea::Search)
                    return S_OK;
            }
            if (GetForegroundWindow() != window) (void)vpaste::winui::ActivateWindowFromBackground(window);
            SetFocus(island);
            auto selected = g_panel.history.SelectedIndex();
            if (lparam == kPreviewFocusReturn && g_queueSelectionMode && g_queuePreviewFocus && g_queuePreviewFocus->ready) {
                if (const auto card = FindCard(g_queuePreviewFocus->target))
                    selected = static_cast<int>(card - g_panel.rows.data());
                if (g_queuePreviewFocus->closed) g_queuePreviewFocus.reset();
            }
            const auto container = selected >= 0
                ? g_panel.history.ContainerFromIndex(selected).try_as<winrt::Microsoft::UI::Xaml::Controls::Control>()
                : winrt::Microsoft::UI::Xaml::Controls::Control{nullptr};
            const auto state = wparam ? winrt::Microsoft::UI::Xaml::FocusState::Keyboard : winrt::Microsoft::UI::Xaml::FocusState::Programmatic;
            if (g_panel.historyScroll) g_panel.historyScroll.BringIntoViewOnFocusChange(wparam != 0);
            if (container && container.IsLoaded()) container.Focus(state);
            else g_panel.history.Focus(state);
            // Let XAML schedule layout. Forcing it here after a preview focus
            // handoff throws E_INVALIDARG while containers are being arranged.
            // Keep focus-driven scrolling disabled after programmatic focus:
            // WinUI can queue its bring-into-view after this call returns.
            // Real input re-enables it before native key/pointer handling.
            // Show/query restoration owns offsets. Enqueuing another restore
            // from a late focus callback could overwrite a newer user scroll.
        }
        return S_OK;
    }
    case kSetTheme: {
        if (g_panel.xamlSource != nullptr && g_panel.xamlSource.Content() != nullptr) {
            const auto theme = wparam == 1
                                   ? winrt::Microsoft::UI::Xaml::ElementTheme::Light
                               : wparam == 2
                                   ? winrt::Microsoft::UI::Xaml::ElementTheme::Dark
                                   : winrt::Microsoft::UI::Xaml::ElementTheme::Default;
            // Summon applies preferences on every show. An unchanged theme
            // must not rebuild every card, file artwork and auxiliary surface.
            if (g_themeMode == static_cast<std::uint32_t>(wparam) && g_panel.root.RequestedTheme() == theme) return S_OK;
            g_themeMode = static_cast<std::uint32_t>(wparam);
            g_panel.root.RequestedTheme(theme);
            g_panel.viewport.RequestedTheme(theme);
            const auto effectiveTheme = EffectivePanelTheme(theme);
            if (g_panel.appActions) g_panel.appActions->SetTheme(effectiveTheme);
            ApplyRowTheme();
            if (g_panel.queueView) g_panel.queueView->SetTheme(theme);
            if (g_panel.queueWindow) g_panel.queueWindow->SetAppearance(g_english, theme);
            if (g_panel.tagManager) g_panel.tagManager->SetTheme(theme);
            if (g_panel.filterEditor) g_panel.filterEditor->SetTheme(theme);
            if (g_panel.recordTagEditor) g_panel.recordTagEditor->SetTheme(theme);
            if (g_panel.reader) g_panel.reader->SetAppearance(g_english, theme);
            if (g_panel.textEditor) g_panel.textEditor->SetAppearance(g_english, theme);
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
    case WM_ERASEBKGND: {
        // 停靠态与同仓库其余 WinUI 窗口保持一致，跳过 GDI 白色擦除以消除 XAML 首帧前的白框闪烁；
        // 标签管理标准窗口态按当前有效主题/高对比度画布色填充，避免拖拽缩放边缘出现黑边残影。
        if (!g_panel.tagManagerViewActive) return 1;
        if (const auto dc = reinterpret_cast<HDC>(wparam)) {
            RECT client{};
            if (GetClientRect(window, &client)) {
                const COLORREF fill = vpaste::winui::HighContrastEnabled()
                    ? GetSysColor(COLOR_WINDOW)
                    : (IsDarkTheme() ? RGB(23, 27, 34) : RGB(246, 247, 249));
                if (const auto brush = CreateSolidBrush(fill)) {
                    FillRect(dc, &client, brush);
                    DeleteObject(brush);
                }
            }
        }
        return 1;
    }
    case WM_POWERBROADCAST:
        // 严格遵守系统挂起 2 秒红线：仅更新纯内存原子状态与时间戳，绝不调用 WinRT/XAML/DWM 或文件 I/O。
        if (wparam == PBT_APMSUSPEND) {
            g_powerLifecycle.OnSuspend(GetTickCount64());
            return TRUE;
        }
        if (wparam == PBT_APMRESUMEAUTOMATIC || wparam == PBT_APMRESUMESUSPEND) {
            g_powerLifecycle.OnResume(GetTickCount64(), wparam == PBT_APMRESUMESUSPEND);
            return TRUE;
        }
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_NCHITTEST:
        if (g_sizePreviewActive) return HTTRANSPARENT;
        if (!g_panel.tagManagerViewActive) return HTCLIENT;
        return DefWindowProcW(window, message, wparam, lparam);
    case WM_ACTIVATE:
        if (LOWORD(wparam) == WA_INACTIVE) {
            g_searchSubmitRequestId = 0;
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
        vpaste::winui::NameIconButton(g_panel.addTag, Text(L"添加标签", L"Add tab"));
        if (const auto menu = g_panel.addTag.Flyout().try_as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyout>(); menu && menu.Items().Size() == 2) {
            menu.Items().GetAt(0).as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem>().Text(Text(L"筛选型标签", L"Filter Tag"));
            menu.Items().GetAt(1).as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem>().Text(Text(L"记录型标签", L"Record Tag"));
        }
        if (g_panel.recordTagEditor) g_panel.recordTagEditor->SetLanguage(g_english);
        if (g_panel.filterEditor) g_panel.filterEditor->SetLanguage(g_english);
        if (g_panel.customTabs) winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.customTabs, Text(L"自定义筛选标签", L"Custom filter tabs"));
        UpdateShortcutLabels();
        g_panel.more.Content(winrt::box_value(Text(L"加载更多", L"Load more")));
        g_panel.resetFilters.Content(winrt::box_value(Text(L"清除筛选", L"Clear filters")));
        g_panel.retry.Content(winrt::box_value(Text(L"重试", L"Try again")));
        g_panel.staleHistory.ActionButton().as<winrt::Microsoft::UI::Xaml::Controls::Button>()
            .Content(winrt::box_value(Text(L"重试", L"Try again")));
        vpaste::winui::NameIconButton(g_panel.cancelSelection,
            Text(L"取消队列选择", L"Cancel queue selection"));
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.loading, Text(L"正在读取历史", L"Loading history"));
        g_panel.queueAdd.Content(winrt::box_value(Text(L"加入队列", L"Add to queue")));
        vpaste::winui::NameIconButton(g_panel.queueOpen, g_queueViewActive
            ? Text(L"关闭粘贴队列", L"Close paste queue") : Text(L"粘贴队列", L"Paste queue"));
        vpaste::winui::NameIconButton(g_panel.settings, Text(L"设置", L"Settings"));
        if (g_panel.appActions) g_panel.appActions->SetLanguage(g_english);
        if (g_panel.queueView) g_panel.queueView->SetLanguage(g_english);
        if (g_panel.queueWindow) g_panel.queueWindow->SetAppearance(g_english, g_panel.root.RequestedTheme());
        if (g_panel.tagManager) g_panel.tagManager->SetLanguage(g_english);
        if (g_panel.reader) g_panel.reader->SetAppearance(g_english, g_panel.root.RequestedTheme());
        if (g_panel.textEditor) g_panel.textEditor->SetAppearance(g_english, g_panel.root.RequestedTheme());
        if (g_panel.customTabs) {
            winrt::Windows::Data::Json::JsonArray filters;
            for (const auto &draft : g_customFilters) filters.Append(draft);
            ApplyFilters(filters);
        }
        RebuildTagFilter();
        g_panel.status.Text(Text(L"正在读取剪贴板历史…", L"Loading clipboard history…"));
        g_updatingLanguage = false;
        g_historyView.renderedItems.clear();
        for (std::size_t index = 0; index < g_panel.rows.size(); ++index) {
            auto &row = g_panel.rows[index];
            row.summary = L"";
            if (row.contextMenu) {
                row.contextMenu.Hide();
                row.contextMenu = nullptr;
                row.menu = {};
                if (row.surface) row.surface.ContextFlyout(nullptr);
            }
            if (row.type) row.type.Text(ItemTypeLabel(row.visualType.empty() ? row.itemType : row.visualType));
            if (row.richBadge) row.richBadge.Text(Text(L"富文本", L"Rich"));
            const bool favorite = index < g_favorites.size() && g_favorites[index];
            if (row.favoriteButton) {
                vpaste::winui::NameIconButton(row.favoriteButton,
                    favorite ? Text(L"取消收藏", L"Remove favorite") : Text(L"收藏", L"Add favorite"));
            }
        }
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
            if (g_panel.dockMotion && !g_sizePreviewActive) g_panel.dockMotion->Suspend();
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
        if (g_panel.dockMotion && !g_sizePreviewActive) g_panel.dockMotion->Finish();
        g_layoutPending = true;
        (void)SendRequest(L"layout");
        return 0;
    case WM_SETTINGCHANGE:
        if (wparam == SPI_SETWORKAREA) {
            if (g_panel.dockMotion && !g_sizePreviewActive) g_panel.dockMotion->Finish();
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
} catch (winrt::hresult_error const &error) {
    // Never unwind a WinRT exception through the Win32 callback ABI. Keep the
    // failing message and HRESULT visible for subsequent lifecycle diagnosis.
    const auto messageText = winrt::to_string(error.message());
    std::fprintf(stderr, "WinUI window message=%u failed: HRESULT=0x%08X %s\n", message,
        static_cast<unsigned>(error.code().value), messageText.c_str());
    char ctx[48]{};
    std::snprintf(ctx, sizeof(ctx), "window_proc_msg_%u", message);
    LogWinUiError(ctx, error.code(), messageText);
    return message >= WM_APP ? error.code().value : DefWindowProcW(window, message, wparam, lparam);
} catch (...) {
    const auto error = winrt::to_hresult();
    std::fprintf(stderr, "WinUI window message=%u failed: HRESULT=0x%08X\n", message, static_cast<unsigned>(error.value));
    char ctx[48]{};
    std::snprintf(ctx, sizeof(ctx), "window_proc_msg_%u", message);
    LogWinUiError(ctx, error);
    return message >= WM_APP ? error.value : DefWindowProcW(window, message, wparam, lparam);
}

HRESULT CreatePanel() noexcept {
    const char *phase = "create native window";
    try {
        WNDCLASSEXW windowClass{};
        windowClass.cbSize = sizeof(windowClass);
        windowClass.lpfnWndProc = WindowProc;
        windowClass.hInstance = GetModuleHandleW(nullptr);
        windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        // 与 WinUiTrayWindow / WinUiReader / WinUiQueueWindow 对齐，移除白色背景画刷以消除白框闪烁。
        windowClass.hbrBackground = nullptr;
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
        auto application = winrt::Microsoft::UI::Xaml::Application::Current();
        // 注册只读未处理异常观测钩子：仅落盘精确 HRESULT 与休眠上下文，严禁设 Handled(true) 强行续命。
        g_unhandledExceptionRevoker = application.UnhandledException(
            winrt::auto_revoke,
            [](auto const &, winrt::Microsoft::UI::Xaml::UnhandledExceptionEventArgs const &args) noexcept {
                try {
                    const auto snapshot = g_powerLifecycle.Snapshot(GetTickCount64());
                    const auto cleanMessage = vpaste::winui::SanitizeDiagnosticText(
                        winrt::to_string(args.Message()));
                    char buffer[512]{};
                    const int len = std::snprintf(
                        buffer, sizeof(buffer),
                        "hr=0x%08X visible=%d tagManager=%d acrylic=%d suspended=%d suspendCount=%llu resumeCount=%llu pendingResumeShow=%d sleepMs=%llu sinceResumeMs=%llu msg=\"%s\"",
                        static_cast<unsigned>(args.Exception().value),
                        PanelVisible() ? 1 : 0,
                        g_panel.tagManagerViewActive ? 1 : 0,
                        g_panel.hasSystemBackdrop ? 1 : 0,
                        snapshot.suspended ? 1 : 0,
                        static_cast<unsigned long long>(snapshot.suspendCount),
                        static_cast<unsigned long long>(snapshot.resumeCount),
                        snapshot.pendingFirstShow ? 1 : 0,
                        static_cast<unsigned long long>(snapshot.sleepDurationMs),
                        static_cast<unsigned long long>(snapshot.elapsedSinceResumeMs),
                        cleanMessage.c_str());
                    if (len > 0) {
                        LogWinUiDiagnostic("unhandled_exception", std::string_view(buffer, static_cast<std::size_t>(len)));
                    }
                } catch (...) {}
            });
        application.Resources().MergedDictionaries().Append(
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
        g_panel.menuInput = vpaste::winui::TrackMenuOpeningInput(root);
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
        root.Loaded([](auto const &, auto const &) noexcept {
            try {
                // Switching a management view unloads history. Focus is valid only
                // after it is attached again, not immediately after Content changes.
                if (GetForegroundWindow() == g_panel.window) PostMessageW(g_panel.window, kFocusHistory, 0, 0);
                BindHistoryScroll(); PostMessageW(g_panel.window, kSyncHistoryViewport, 0, 0);
            } catch (winrt::hresult_error const &error) {
                LogWinUiError("root_loaded", error.code(), winrt::to_string(error.message()));
            } catch (...) {
                LogWinUiError("root_loaded", winrt::to_hresult());
            }
        });
        root.Unloaded([](auto const &, auto const &) noexcept {
            try {
                CancelHoverPreview();
                if (g_panel.appActions) g_panel.appActions->Deactivate();
                if (g_panel.deletionDialog) g_panel.deletionDialog.Hide();
                if (g_panel.filterEditor) g_panel.filterEditor->Hide();
                if (g_panel.recordTagEditor) g_panel.recordTagEditor->Hide();
                DismissFeedback();
            } catch (winrt::hresult_error const &error) {
                LogWinUiError("root_unloaded", error.code(), winrt::to_string(error.message()));
            } catch (...) {
                LogWinUiError("root_unloaded", winrt::to_hresult());
            }
        });
        root.ActualThemeChanged([](auto const &, auto const &) noexcept {
            try {
                // 销毁流程清空 g_panel.root 后，XAML 关闭期间仍可能派发挂起的主题变更回调。
                if (!g_panel.root) return;
                ApplyRowTheme();
                const auto requested = g_panel.root.RequestedTheme();
                const auto effective = EffectivePanelTheme(requested);
                if (g_panel.appActions) g_panel.appActions->SetTheme(effective);
                if (g_panel.queueView) g_panel.queueView->SetTheme(requested);
                if (g_panel.queueWindow) g_panel.queueWindow->SetAppearance(g_english, requested);
                if (g_panel.tagManager) g_panel.tagManager->SetTheme(requested);
                if (g_panel.filterEditor) g_panel.filterEditor->SetTheme(requested);
                if (g_panel.recordTagEditor) g_panel.recordTagEditor->SetTheme(requested);
                if (g_panel.reader) g_panel.reader->SetAppearance(g_english, requested);
                if (g_panel.textEditor) g_panel.textEditor->SetAppearance(g_english, requested);
            } catch (winrt::hresult_error const &error) {
                LogWinUiError("root_actual_theme_changed", error.code(), winrt::to_string(error.message()));
            } catch (...) {
                LogWinUiError("root_actual_theme_changed", winrt::to_hresult());
            }
        });
        phase = "create panel controls";
        Grid header;
        g_panel.header = header;
        vpaste::winui::ApplyStyle(header, L"VPaste.ClipboardHeader");
        header.Height(kHeaderHeight);
        header.Padding(Thickness{kHeaderInset, 0, kHeaderInset, 0});
        header.ColumnSpacing(10);
        for (int column = 0; column < 3; ++column) {
            ColumnDefinition definition;
            definition.Width(GridLength{1, column == 1 ? GridUnitType::Star : GridUnitType::Auto});
            header.ColumnDefinitions().Append(definition);
        }
        root.Children().Append(header);
        g_panel.commands = StackPanel();
        g_panel.commands.Orientation(Orientation::Horizontal);
        g_panel.commands.Spacing(8);
        g_panel.commands.HorizontalAlignment(HorizontalAlignment::Right);
        g_panel.commands.VerticalAlignment(VerticalAlignment::Center);
        Grid::SetColumn(g_panel.commands, 2);
        Grid searchGroup;
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
        g_panel.search = TextBox();
        g_panel.searchField = Grid();
        g_panel.searchField.VerticalAlignment(VerticalAlignment::Center);
        g_panel.searchField.Visibility(Visibility::Collapsed);
        g_panel.searchField.Width(276);
        g_panel.search.FontSize(13);
        g_panel.search.PlaceholderText(Text(L"搜索剪贴板历史", L"Search clipboard history"));
        g_panel.search.MinHeight(32);
        g_panel.search.Visibility(Visibility::Collapsed);
        g_panel.search.RegisterPropertyChangedCallback(UIElement::VisibilityProperty(),
            [](auto const &sender, auto const &) {
                if (sender != g_panel.search) return;
                const auto visibility = g_panel.search.Visibility();
                g_panel.searchField.Visibility(visibility);
                g_panel.searchButton.Visibility(visibility == Visibility::Visible
                    ? Visibility::Collapsed : Visibility::Visible);
                if (visibility == Visibility::Collapsed) {
                    g_searchSubmitRequestId = 0;
                    g_searchComposing = false;
                    vpaste::winui::ResetFeedbackOpacity(g_panel.search);
                    if (PanelVisible()) vpaste::winui::FadeFeedback(g_panel.searchButton);
                }
            });
        g_panel.search.VerticalAlignment(VerticalAlignment::Center);
        winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(
            g_panel.search, Text(L"搜索剪贴板历史", L"Search clipboard history"));
        g_panel.searchField.Children().Append(g_panel.search);
        searchGroup.Children().Append(g_panel.searchField);
        header.Children().Append(searchGroup);
        root.SizeChanged([](auto const &, auto const &) { UpdateSearchWidth(); });
        g_panel.search.LostFocus([](auto const &, auto const &) {
            if (!g_panel.root || !g_panel.search || !g_panel.search.IsLoaded()) return;
            const auto focused = Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot());
            if (MainInputArea(focused) != vpaste::winui::InputArea::Search) {
                g_searchSubmitRequestId = 0;
                if (SearchText().empty()) g_panel.search.Visibility(Visibility::Collapsed);
            }
        });
        g_panel.searchChanging = g_panel.search.TextChanging(winrt::auto_revoke,
            [](auto const &sender, auto const &) { SearchChanged(sender.Text()); });
        g_panel.searchCompositionStarted = g_panel.search.TextCompositionStarted(winrt::auto_revoke,
            [](auto const &sender, auto const &) { SearchCompositionChanged(true, sender.Text()); });
        g_panel.searchCompositionEnded = g_panel.search.TextCompositionEnded(winrt::auto_revoke,
            [](auto const &sender, auto const &) { SearchCompositionChanged(false, sender.Text()); });
        root.PreviewKeyDown([](auto const &, auto const &args) {
            if (g_panel.onboarding) {
                if (args.Key() == winrt::Windows::System::VirtualKey::Escape && g_panel.onboarding->CancelPreview())
                    args.Handled(true);
                return;
            }
            if (!PanelVisible()) { args.Handled(true); return; }
            if (args.Key() != winrt::Windows::System::VirtualKey::Escape) CancelHoverPreview();
            vpaste::winui::MainKeyInput input;
            input.key = static_cast<std::uint32_t>(args.Key());
            input.control = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
            input.shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
            input.alt = (GetKeyState(VK_MENU) & 0x8000) != 0;
            input.meta = ((GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000) != 0;
            input.repeated = args.KeyStatus().WasKeyDown;
            input.composing = g_searchComposing || input.key == VK_PROCESSKEY || static_cast<std::uint32_t>(args.OriginalKey()) == VK_PROCESSKEY;
            input.area = MainInputArea(args.OriginalSource());
            input.blocked = NativeControlOwnsKeys(args.OriginalSource()) &&
                !(input.key == VK_ESCAPE && input.area == vpaste::winui::InputArea::Search);
            if (!input.blocked && !input.composing &&
                (input.area == vpaste::winui::InputArea::History || input.key == VK_TAB) &&
                (input.key == VK_LEFT || input.key == VK_RIGHT || input.key == VK_TAB || input.key == VK_HOME ||
                 input.key == VK_END || input.key == VK_NEXT || input.key == VK_PRIOR)) HistoryViewportInput();
            input.searchHasText = !SearchText().empty();
            if (input.control || input.meta) ShowAltHints(false);
            if (HandleMainKey(input, args.OriginalSource())) args.Handled(true);
        });
        root.PreviewKeyUp([](auto const &, auto const &args) {
            if (args.Key() == winrt::Windows::System::VirtualKey::Menu || (GetKeyState(VK_MENU) & 0x8000) == 0) ShowAltHints(false);
        });
        g_panel.filter = SelectorBar();
        UpdateFilterLabels();
        g_panel.filter.Height(kHeaderHeight);
        g_panel.filter.Padding(Thickness{0});
        g_panel.filter.Loaded([](auto const &, auto const &) {
            g_panel.filter.ApplyTemplate();
            if (const auto view = FindHistoryChild<ItemsView>(g_panel.filter)) {
                view.Layout(winrt::make<TabStripLayout>());
                view.ItemTransitionProvider(nullptr);
            }
            BringSelectedTabIntoView(g_panel.filter);
        });
        g_panel.filter.Resources().Insert(winrt::box_value(L"SelectorBarItemIconScale"), winrt::box_value(1.0));
        g_panel.filter.Resources().Insert(winrt::box_value(L"SelectorBarItemSpacing"), winrt::box_value(5.0));
        g_panel.filter.Resources().Insert(winrt::box_value(L"SelectorBarItemPillFill"), SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
        g_panel.filterStrip = StackPanel();
        g_panel.filterStrip.Orientation(Orientation::Horizontal);
        g_panel.filterStrip.Spacing(8);
        g_panel.filterStrip.Children().Append(g_panel.filter);
        g_panel.customTabs = SelectorBar();
        g_panel.customTabs.Height(kHeaderHeight);
        g_panel.customTabs.Padding(Thickness{0});
        g_panel.customTabs.Background(SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
        g_panel.customTabs.AllowDrop(true);
        const auto previewTabDrag = [](auto const &, auto const &args) {
            if (!args.DataView().Properties().HasKey(L"com.vpaste.native-tab")) return;
            const auto id = std::wstring{winrt::unbox_value<winrt::hstring>(args.DataView().Properties().Lookup(L"com.vpaste.native-tab"))};
            if (!PreviewTabDrop(id, args.GetPosition(g_panel.customTabs).X)) return;
            args.AcceptedOperation(winrt::Windows::ApplicationModel::DataTransfer::DataPackageOperation::Move);
            args.DragUIOverride().IsCaptionVisible(false); args.Handled(true);
        };
        const auto dropTab = [previewTabDrag](auto const &sender, auto const &args) {
            previewTabDrag(sender, args);
            if (!args.Handled()) return;
            if (!g_tabDrop.target.empty()) SaveTabDrop(g_tabDrop.source, g_tabDrop.target, g_tabDrop.before);
            ClearTabDropPreview();
        };
        g_panel.customTabs.DragOver(previewTabDrag);
        g_panel.customTabs.Drop(dropTab);
        g_panel.customTabs.DragLeave([](auto const &, auto const &args) {
            const auto position = args.GetPosition(g_panel.filterScroll);
            if (position.X < 0 || position.X > g_panel.filterScroll.ActualWidth() || position.Y < 0 || position.Y > kHeaderHeight)
                ResetTabDropOffsets();
        });
        g_panel.customTabs.Resources().Insert(winrt::box_value(L"SelectorBarItemSpacing"), winrt::box_value(5.0));
        g_panel.customTabs.Resources().Insert(winrt::box_value(L"SelectorBarItemPillFill"), SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
        g_panel.customTabs.Loaded([](auto const &, auto const &) {
            g_panel.customTabs.ApplyTemplate();
            if (const auto view = FindHistoryChild<ItemsView>(g_panel.customTabs)) {
                view.Layout(winrt::make<TabStripLayout>());
                // The drag preview owns movement. SDK removal/move transitions
                // must not retain the retired labels at their old positions.
                view.ItemTransitionProvider(nullptr);
            }
            BringSelectedTabIntoView(g_panel.customTabs);
        });
        Automation::AutomationProperties::SetName(g_panel.customTabs, Text(L"自定义筛选标签", L"Custom filter tabs"));
        g_panel.customTabs.SelectionChanged([](auto const &sender, auto const &) {
            if (!g_panel.customTabs || sender != g_panel.customTabs ||
                g_updatingTagFilter || !g_panel.customTabs.SelectedItem()) return;
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
            PostMessageW(g_panel.window, kFocusHistory, 0, 0);
        });
        g_panel.filterStrip.Children().Append(g_panel.customTabs);
        g_panel.addTag = vpaste::winui::NamedIconButton(SymbolIcon{Symbol::Add}, Text(L"添加标签", L"Add tab"));
        g_panel.addTag.Width(36);
        g_panel.addTag.Height(kHeaderHeight);
        g_panel.addTag.Content().as<FontIcon>().FontSize(18);
        g_panel.addTag.VerticalAlignment(VerticalAlignment::Center);
        MenuFlyout addMenu;
        addMenu.Opened([](auto const &, auto const &) { g_searchSubmitRequestId = 0; CancelHoverPreview(); });
        addMenu.Placement(Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft);
        addMenu.ShouldConstrainToRootBounds(false);
        MenuFlyoutItem addFilter;
        addFilter.Text(Text(L"筛选型标签", L"Filter Tag")); addFilter.Icon(SymbolIcon{Symbol::Filter});
        addFilter.Click([](auto const &, auto const &) {
            winrt::Windows::Data::Json::JsonObject draft;
            draft.Insert(L"filter", winrt::Windows::Data::Json::JsonObject{});
            ShowFilterEditor(draft);
        });
        addMenu.Items().Append(addFilter);
        MenuFlyoutItem addRecordTag;
        addRecordTag.Text(Text(L"记录型标签", L"Record Tag")); addRecordTag.Icon(SymbolIcon{Symbol::Add});
        addRecordTag.Click([](auto const &, auto const &) { ShowRecordTagEditor(); });
        addMenu.Items().Append(addRecordTag);
        vpaste::winui::BindMenuOpeningFocus(addMenu, g_panel.menuInput);
        g_panel.addTag.Flyout(addMenu);
        g_panel.filterStrip.Children().Append(g_panel.addTag);
        g_panel.filterScroll = ScrollViewer();
        g_panel.filterScroll.HorizontalScrollMode(ScrollMode::Enabled);
        g_panel.filterScroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Hidden);
        g_panel.filterScroll.VerticalScrollMode(ScrollMode::Disabled);
        g_panel.filterScroll.VerticalScrollBarVisibility(ScrollBarVisibility::Disabled);
        g_panel.filterScroll.Content(g_panel.filterStrip);
        g_panel.filterScroll.AllowDrop(true);
        g_panel.filterScroll.DragOver(previewTabDrag);
        g_panel.filterScroll.Drop(dropTab);
        Grid::SetColumn(g_panel.filterScroll, 1);
        header.Children().Append(g_panel.filterScroll);
        g_panel.tabIndicatorHost = Markup::XamlReader::Load(LR"(<Border
            xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
            BorderBrush="{ThemeResource AccentFillColorDefaultBrush}" IsHitTestVisible="False"/>)").as<Border>();
        Grid::SetColumn(g_panel.tabIndicatorHost, 1);
        header.Children().Append(g_panel.tabIndicatorHost);
        g_panel.tabIndicator = std::make_unique<vpaste::winui::TabIndicator>(g_panel.tabIndicatorHost);
        g_panel.tabDropMarker = Border();
        g_panel.tabDropMarker.Width(2); g_panel.tabDropMarker.Height(24);
        g_panel.tabDropMarker.HorizontalAlignment(HorizontalAlignment::Left);
        g_panel.tabDropMarker.VerticalAlignment(VerticalAlignment::Center);
        g_panel.tabDropMarker.Background(g_panel.tabIndicatorHost.BorderBrush());
        g_panel.tabDropMarker.IsHitTestVisible(false); g_panel.tabDropMarker.Visibility(Visibility::Collapsed);
        Grid::SetColumn(g_panel.tabDropMarker, 1); header.Children().Append(g_panel.tabDropMarker);
        // 按左到右视觉列序追加命令区，避免失焦回落优先击中右上角工具栏按钮。
        header.Children().Append(g_panel.commands);
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
            ScheduleHistoryFocus();
        });

        g_panel.history = ListView();
        // A complete query is committed in one UI turn. Default ListView
        // entrance/reposition transitions replay on every recreated card.
        g_panel.history.ItemContainerTransitions(Media::Animation::TransitionCollection{});
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
        g_panel.history.Padding(Thickness{16, 8, 16, 8});
        g_panel.history.SelectionMode(ListViewSelectionMode::Single);
        // Cards already own the selection outline; the SDK checkbox gutter
        // would shift and crop the same card when queue selection is enabled.
        g_panel.history.IsMultiSelectCheckBoxEnabled(false);
        g_panel.history.HorizontalContentAlignment(HorizontalAlignment::Stretch);
        Style cardContainer{winrt::xaml_typename<ListViewItem>()};
        cardContainer.BasedOn(Application::Current().Resources().Lookup(winrt::box_value(L"VPaste.ClipboardItem")).as<Style>());
        cardContainer.Setters().Append(Setter{Control::PaddingProperty(), winrt::box_value(Thickness{0})});
        cardContainer.Setters().Append(Setter{FrameworkElement::WidthProperty(), winrt::box_value(kCardWidth + 16)});
        cardContainer.Setters().Append(Setter{Control::CornerRadiusProperty(), winrt::box_value(vpaste::winui::UniformRadius(kCardRadius))});
        cardContainer.Setters().Append(Setter{UIElement::UseSystemFocusVisualsProperty(), winrt::box_value(false)});
        // The card has horizontal spacing inside its ListViewItem. Align the
        // native focus visual to the card, not to the outside of that gap.
        cardContainer.Setters().Append(Setter{FrameworkElement::FocusVisualMarginProperty(),
            winrt::box_value(Thickness{8, 4, 8, 4})});
        g_panel.history.ItemContainerStyle(cardContainer);
        // Focus events update only the outline. Reapplying control styles or
        // system-focus settings from them can recursively change focus.
        const auto updateFocus = [](auto const &, auto const &) {
            for (std::size_t index = 0; index < g_panel.rows.size(); ++index) UpdateCardOutline(index);
        };
        g_panel.history.GotFocus(updateFocus);
        g_panel.history.LostFocus(updateFocus);
        // A realized container requests full card details (and a native image
        // source). Keep a short scroll buffer instead of the SDK's four
        // off-screen viewports of decoded resources.
        const auto itemsPanel = winrt::Microsoft::UI::Xaml::Markup::XamlReader::Load(
                                    LR"(<ItemsPanelTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><ItemsStackPanel Orientation="Horizontal" CacheLength="0.5" ItemsUpdatingScrollMode="KeepScrollOffset"/></ItemsPanelTemplate>)")
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
            if (!g_queueSelectionMode && args.Key() == winrt::Windows::System::VirtualKey::Down &&
                (GetKeyState(VK_CONTROL) & 0x8000) == 0 && (GetKeyState(VK_MENU) & 0x8000) == 0 &&
                (GetKeyState(VK_SHIFT) & 0x8000) == 0 && !args.KeyStatus().WasKeyDown && OpenSelectedCardMenu()) {
                args.Handled(true);
                return;
            }
            if (g_queueSelectionMode && args.Key() == winrt::Windows::System::VirtualKey::Space &&
                (GetKeyState(VK_CONTROL) & 0x8000) == 0 && (GetKeyState(VK_MENU) & 0x8000) == 0 &&
                (GetKeyState(VK_SHIFT) & 0x8000) == 0) {
                const auto index = HistoryIndexFromSource(args.OriginalSource());
                if (!args.KeyStatus().WasKeyDown && index >= 0 && static_cast<std::size_t>(index) < g_hashes.size())
                    ToggleQueueCardPreview(g_hashes[index]);
                args.Handled(true);
                return;
            }
            if (g_queueSelectionMode && args.Key() == winrt::Windows::System::VirtualKey::Escape &&
                (GetKeyState(VK_CONTROL) & 0x8000) == 0 && (GetKeyState(VK_MENU) & 0x8000) == 0 &&
                (GetKeyState(VK_SHIFT) & 0x8000) == 0) {
                if (!args.KeyStatus().WasKeyDown) {
                    if (g_queuePreviewFocus && !g_queuePreviewFocus->closed) (void)SendRequest(L"previewClose");
                    else ToggleQueueSelectionMode();
                }
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
            if (NativeEditorOpen() || g_deleteConfirmationOpen || (g_panel.cardDrag && g_panel.cardDrag->Active())) return;
            if (IsCardAction(args.OriginalSource())) return;
            if (HandlePreviewKey(args.Key(), args.KeyStatus().WasKeyDown,
                                 (GetKeyState(VK_CONTROL) & 0x8000) != 0,
                                 (GetKeyState(VK_SHIFT) & 0x8000) != 0,
                                 (GetKeyState(VK_MENU) & 0x8000) != 0)) {
                args.Handled(true);
                return;
            }
            if (args.Key() == winrt::Windows::System::VirtualKey::Delete &&
                       !args.KeyStatus().WasKeyDown &&
                       (GetKeyState(VK_CONTROL) & 0x8000) == 0 &&
                       (GetKeyState(VK_SHIFT) & 0x8000) == 0 &&
                       (GetKeyState(VK_MENU) & 0x8000) == 0) {
                DeleteCard(g_selectedHash);
                args.Handled(true);
            } else if (args.Key() == winrt::Windows::System::VirtualKey::F2 &&
                       !args.KeyStatus().WasKeyDown &&
                       (GetKeyState(VK_CONTROL) & 0x8000) == 0 &&
                       (GetKeyState(VK_SHIFT) & 0x8000) == 0 &&
                       (GetKeyState(VK_MENU) & 0x8000) == 0) {
                EditSelectedItem();
                args.Handled(true);
            } else if (args.Key() == winrt::Windows::System::VirtualKey::C &&
                       (GetKeyState(VK_CONTROL) & 0x8000) != 0 &&
                       (GetKeyState(VK_SHIFT) & 0x8000) == 0 &&
                       (GetKeyState(VK_MENU) & 0x8000) == 0) {
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
                    std::uint32_t index = 0;
                    if (g_panel.history.Items().IndexOf(selectedItems.GetAt(selectedIndex), index) && index < g_hashes.size())
                        visibleSelectedHashes.push_back(g_hashes[index]);
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
            // Selection owns outlines only, not the cards' content or theme.
            for (std::size_t index = 0; index < g_panel.rows.size(); ++index) UpdateCardOutline(index);
            UpdateCardPreviewMotion();
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
        g_panel.loading.IsIndeterminate(false);
        g_panel.loading.Height(2);
        g_panel.loading.VerticalAlignment(VerticalAlignment::Top);
        g_panel.loading.Visibility(Visibility::Collapsed);
        Automation::AutomationProperties::SetName(g_panel.loading, Text(L"正在读取历史", L"Loading history"));
        Grid::SetRow(g_panel.loading, 1);
        root.Children().Append(g_panel.loading);
        g_panel.staleHistory = InfoBar();
        g_panel.staleHistory.Severity(InfoBarSeverity::Error);
        g_panel.staleHistory.IsClosable(false);
        g_panel.staleHistory.VerticalAlignment(VerticalAlignment::Top);
        g_panel.staleHistory.HorizontalAlignment(HorizontalAlignment::Center);
        Button retryStale;
        retryStale.Content(winrt::box_value(Text(L"重试", L"Try again")));
        retryStale.Click([](auto const &, auto const &) { RequestHistory(); });
        g_panel.staleHistory.ActionButton(retryStale);
        Grid::SetRow(g_panel.staleHistory, 1);
        root.Children().Append(g_panel.staleHistory);
        g_panel.feedback = InfoBar();
        g_panel.feedback.IsOpen(false);
        g_panel.feedback.MaxWidth(420);
        g_panel.feedback.HorizontalAlignment(HorizontalAlignment::Right);
        g_panel.feedback.VerticalAlignment(VerticalAlignment::Top);
        g_panel.feedback.Margin(Thickness{24, 8, 24, 0});
        Grid::SetRow(g_panel.feedback, 1);
        root.Children().Append(g_panel.feedback);

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
        g_panel.selectionTitle = MakeText(L"", 13);
        g_panel.selectionCount = MakeText(L"0", 12);
        g_panel.selectionTitle.VerticalAlignment(VerticalAlignment::Center);
        g_panel.selectionCount.VerticalAlignment(VerticalAlignment::Center);
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
        Grid::SetRow(g_panel.selectionBar, 1);
        root.Children().Append(g_panel.selectionBar);
        // 光学微调队列图标，使其三条横线与对勾居中对齐并拥有均衡视觉重心。
        g_panel.queueOpen = vpaste::winui::NamedIconButton(
            vpaste::winui::HeaderIcon(vpaste::winui::HeaderArtwork::PlaylistAddCheckRounded,
                vpaste::winui::HeaderIconMetrics{vpaste::winui::CompactIconSize, 1.06, -0.10, -0.75}),
            Text(L"粘贴队列", L"Paste Queue"));
        g_panel.queueOpen.Click([](auto const &, auto const &) {
            (void)SendRequest(g_queueViewActive ? L"queueClose" : L"queueOpen");
        });
        g_panel.appActions = std::make_unique<vpaste::winui::AppActions>(root,
            [](const std::wstring &operation, const std::wstring &argument) {
                if (operation == L"appTool") { g_searchSubmitRequestId = 0; CancelHoverPreview(); }
                return SendRequest(operation.c_str(), {}, false, 0, {}, {}, 0, argument);
            }, [](const winrt::hstring &message, bool error) { ShowFeedback(message, error); }, [] {
                if (g_panel.window) PostMessageW(g_panel.window, kFocusHistory, 0, 0);
            });
        g_panel.appActions->SetLanguage(g_english);
        root.AllowDrop(true);
        const auto internalCardDrag = [](auto const &, auto const &args) {
            vpaste::winui::SuppressInternalCardDrag(args, g_panel.cardDrag && g_panel.cardDrag->Active());
        };
        root.DragEnter(internalCardDrag);
        root.DragOver(internalCardDrag);
        root.Drop(internalCardDrag);
        g_panel.hoverPreview = std::make_unique<vpaste::winui::HoverPreview>(
            [](const std::wstring &op, const std::wstring &hash) { (void)SendRequest(op.c_str(), hash); },
            [] { return g_behavior.hoverPreview && PointerHistoryAllowed(); });
        root.AddHandler(UIElement::PointerPressedEvent(), winrt::box_value(
            winrt::Microsoft::UI::Xaml::Input::PointerEventHandler{[](auto const &, auto const &) { CancelHoverPreview(); }}), true);
        g_panel.commands.Children().Append(g_panel.appActions->DeveloperGroup());
        g_panel.commands.Children().Append(g_panel.appActions->ToolsButton());
        g_panel.commands.Children().Append(g_panel.queueOpen);
        g_panel.settings = vpaste::winui::NamedIconButton(
            vpaste::winui::HeaderIcon(vpaste::winui::HeaderArtwork::SettingsOutlined), Text(L"设置", L"Settings"));
        g_panel.settings.Click([](auto const &, auto const &) { (void)SendRequest(L"settings"); });
        g_panel.commands.Children().Append(g_panel.settings);
        g_panel.commands.Children().Append(g_panel.appActions->UpdateButton());
        for (const auto &action : {g_panel.queueOpen, g_panel.settings}) {
            vpaste::winui::ApplyStyle(action, L"VPaste.RoundToolbarCommand");
            // NamedIconButton also serves 32-DIP card actions. Let this
            // header's 28-DIP style own the actual hit target.
            action.ClearValue(FrameworkElement::WidthProperty());
            action.ClearValue(FrameworkElement::HeightProperty());
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
        });
        g_panel.status.Visibility(Visibility::Collapsed);
        g_panel.commands.Children().Append(g_panel.status);

        g_panel.filter.SelectionChanged([](auto const &sender, auto const &) {
            if (!g_panel.filter || sender != g_panel.filter) return;
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
                PostMessageW(g_panel.window, kFocusHistory, 0, 0);
            }
        });
        g_searchTimer = g_dispatcher.DispatcherQueue().CreateTimer();
        g_searchTimer.Interval(std::chrono::milliseconds(120));
        g_searchTimer.IsRepeating(false);
        g_searchTimer.Tick([](auto const &timer, auto const &) {
            timer.Stop();
            if (!g_searchComposing) RequestHistory();
        });
        g_feedbackTimer = g_dispatcher.DispatcherQueue().CreateTimer();
        g_feedbackTimer.Interval(std::chrono::seconds(3));
        g_feedbackTimer.IsRepeating(false);
        g_feedbackTimer.Tick([](auto const &, auto const &) { DismissFeedback(); });
        g_loadingTimer = g_dispatcher.DispatcherQueue().CreateTimer();
        g_loadingTimer.Interval(kLoadingIndicatorDelay);
        g_loadingTimer.IsRepeating(false);
        g_loadingTimer.Tick([](auto const &, auto const &) {
            if (IsHistorySearching() && !g_hashes.empty()) SetLoadingIndicatorVisible(true);
            else SetLoadingIndicatorVisible(false);
        });

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
        g_panel.reader = std::make_unique<vpaste::winui::Reader>([](auto const &operation, auto generation, auto const &document) -> std::uint64_t {
            if (operation == L"nativeReaderClose") {
                // The shared command cancels hover first, then reserves the
                // explicit close so its focus return cannot be superseded.
                return SendRequest(L"previewClose");
            }
            if (operation == L"readerNext" || operation == L"readerPrevious" ||
                operation == L"readerNextCategory" || operation == L"readerPreviousCategory") {
                if (g_queueSelectionMode) return 0;
                NavigatePreview(operation == L"readerPrevious" || operation == L"readerPreviousCategory" ? -1 : 1,
                    operation == L"readerNextCategory" || operation == L"readerPreviousCategory");
                return 0;
            }
            return SendDocumentRequest(operation.c_str(), generation, document);
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
        const auto messageText = winrt::to_string(error.message());
        std::fprintf(stderr, "WinUI startup failed during %s: 0x%08X %s\n",
            phase, static_cast<unsigned>(error.code()), messageText.c_str());
        LogWinUiError(phase, error.code(), messageText);
        if (g_panel.window != nullptr) {
            DestroyWindow(g_panel.window);
        }
        return error.code();
    } catch (...) {
        LogWinUiError(phase, E_FAIL);
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
    g_panel.textEditor.reset();
    g_textEditorOpenRequest = 0;
    g_textEditorRequestedCard.reset();
    g_textEditorOrigin.reset();
    g_textEditorRefreshAfterSave = false;
    g_textEditorReturnAfterQuery.reset();
    g_panel.onboarding.reset();
    g_panel.filterEditor.reset();
    g_panel.recordTagEditor.reset();
    g_customFilters.clear();
    g_tutorialPreviewFilters.reset();
    g_selectedFilterId.clear();
    if (g_searchTimer != nullptr) {
        if (g_searchTimer.IsRunning()) {
            g_searchTimer.Stop();
        }
        g_searchTimer = nullptr;
    }
    DismissFeedback();
    g_feedbackTimer = nullptr;
    HideLoadingIndicator();
    g_loadingTimer = nullptr;
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
    g_panel.searchCompositionStarted.revoke(); g_panel.searchCompositionEnded.revoke();
    g_panel.search = nullptr;
    g_panel.searchField = nullptr;
    g_searchText = L"";
    g_searchComposing = false;
    g_panel.searchButton = nullptr;
    g_panel.commands = nullptr;
    g_panel.filter = nullptr;
    g_panel.filterScroll = nullptr;
    g_panel.filterStrip = nullptr;
    g_panel.tabIndicatorHost = nullptr;
    g_panel.tabDropMarker = nullptr; g_tabDrop = {}; g_renderedDynamicTabs = L"";
    g_panel.customTabs = nullptr;
    g_panel.addTag = nullptr;
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
    g_tabDeleteRequest = 0;
    g_tabDeleteOperation.clear();
    g_panel.feedback = nullptr;
    g_panel.staleHistory = nullptr;
    g_panel.queueAdd = nullptr;
    g_panel.queueOpen = nullptr;
    g_panel.settings = nullptr;
    g_panel.more = nullptr;
    g_panel.viewport = nullptr;
    g_panel.header = nullptr;
    g_panel.shadowReceiver = nullptr;
    g_panel.root = nullptr;
    g_panel.menuInput.reset();
    g_panel.trayWindow.reset();
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
    g_recordTagsLoaded = false;
    g_cardTagRequests.clear();
    g_recordTagAssignmentTarget.reset();
    g_dynamicIds.clear(); g_tabOrder.clear(); g_tabOrderLoadRequest = 0; g_tabOrderSaveRequest = 0;
    g_selectedTagId = 0;
    g_selectedTagName.clear();
    g_unhandledExceptionRevoker.revoke();
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

LRESULT SendPanelMessage(UINT message, WPARAM wparam = 0, LPARAM lparam = 0) noexcept {
    HWND window = nullptr;
    {
        std::lock_guard lock(g_stateMutex);
        window = g_panel.window;
    }
    if (window == nullptr || !IsWindow(window)) {
        return E_UNEXPECTED;
    }
    return SendMessageW(window, message, wparam, lparam);
}

} // namespace

extern "C" __declspec(dllexport) std::uint32_t vpaste_winui_protocol_version() noexcept {
    return vpaste::winui::BridgeVersion;
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_diagnostics_log_path(
    const wchar_t *path) noexcept {
    if (path == nullptr || path[0] == L'\0') {
        g_diagnostics.SetPath({});
        return S_OK;
    }
    g_diagnostics.SetPath(std::wstring(path));
    return S_OK;
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

extern "C" __declspec(dllexport) int32_t vpaste_winui_set_preview_layout(const PanelLayout *layout) noexcept {
    if (!layout || layout->width <= 0 || layout->height <= 0 ||
        !std::isfinite(layout->screenScale) || layout->screenScale <= 0 ||
        !std::isfinite(layout->panelScale) || layout->panelScale <= 0) return E_INVALIDARG;
    const auto copied = *layout;
    return static_cast<int32_t>(SendPanelMessage(
        kSetPreviewLayout, 0, reinterpret_cast<LPARAM>(&copied)));
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_size_preview(
    bool visible, bool restoreVisible) noexcept {
    return static_cast<int32_t>(SendPanelMessage(kSetSizePreview, visible, restoreVisible));
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
    return PostMessageW(g_panel.window, kFocusHistory, 0, kPreviewFocusReturn) ? S_OK : HRESULT_FROM_WIN32(GetLastError());
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
    if (bytes == nullptr || length == 0 || length > vpaste::winui::MaxDocumentBytes) {
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
bool OwnsNativePointer(winrt::Microsoft::UI::Xaml::FrameworkElement const &target, bool edges = false,
    winrt::Microsoft::UI::Xaml::UIElement const &searchRoot = nullptr) {
    using namespace winrt::Microsoft::UI::Xaml;
    const auto w = static_cast<float>(target.ActualWidth()), h = static_cast<float>(target.ActualHeight());
    std::vector<winrt::Windows::Foundation::Point> samples{{w * .25f, h / 2}, {w / 2, h / 2}, {w * .75f, h / 2}};
    if (edges) samples.insert(samples.end(), {{2, 2}, {w - 2, 2}, {2, h - 2}, {w - 2, h - 2}});
    for (const auto &sample : samples) {
        const auto point = target.TransformToVisual(nullptr).TransformPoint(sample);
        const auto hits = Media::VisualTreeHelper::FindElementsInHostCoordinates(point,
            searchRoot ? searchRoot : g_panel.root, false);
        auto hit = hits.First();
        auto element = hit.HasCurrent() ? hit.Current().as<DependencyObject>() : nullptr;
        bool owned = false;
        std::wstring path;
        for (; element; element = Media::VisualTreeHelper::GetParent(element)) {
            path += std::wstring{winrt::get_class_name(element)} + L" / ";
            if (element == target) { owned = true; break; }
        }
        if (!owned) {
            std::fprintf(stderr, "WinUI pointer miss: target=%ls point=%.1f,%.1f path=%ls\n",
                winrt::get_class_name(target).c_str(), point.X, point.Y, path.c_str());
            return false;
        }
    }
    return true;
}

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
    std::shared_ptr<std::promise<std::pair<HRESULT, std::uint32_t>>> completion, std::string fileFixtures) {
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
            const auto tagGroup = tagRoot.Children().GetAt(2)
                .as<winrt::Microsoft::UI::Xaml::Controls::Border>();
            auto tagList = tagGroup.Child().as<winrt::Microsoft::UI::Xaml::Controls::ScrollViewer>();
            auto tagRows = tagList.Content()
                .as<winrt::Microsoft::UI::Xaml::Controls::StackPanel>();
            winrt::check_hresult(tagGroup.CornerRadius() == vpaste::winui::UniformRadius(8) &&
                tagGroup.BorderThickness() == vpaste::winui::UniformThickness(1) &&
                tagRows.Children().Size() == 2 ? S_OK : E_FAIL);
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
            // 卡片右键菜单按需懒创建：渲染后默认不提前构造，首次请求时才创建。
            winrt::check_hresult(!g_panel.rows[0].contextMenu && !g_panel.rows[0].surface.ContextFlyout() ? S_OK : E_FAIL);
            const auto firstCardMenu = EnsureCardContextMenu(g_panel.rows[0], g_hashes[0]);
            winrt::check_hresult(g_selectedHash == L"test-a" && firstCardMenu.Items().Size() >= 3 &&
                firstCardMenu.Items().GetAt(firstCardMenu.Items().Size() - 1).as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem>().Text() ==
                    Text(L"复制并粘贴", L"Copy and paste") &&
                firstCardMenu.Items().GetAt(firstCardMenu.Items().Size() - 4).as<winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem>().Text() ==
                    Text(L"编辑文本", L"Edit text") ? S_OK : E_FAIL);
            g_panel.history.SelectedIndex(1);
            ApplyResponse(R"({"id":301,"op":"query","data":{"items":[{"hash":"test-c"},{"hash":"test-a"},{"hash":"test-b"}]}})");
            winrt::check_hresult(g_selectedHash == L"test-b" && g_panel.history.SelectedIndex() == 2 ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":302,"op":"query","data":{"items":[{"hash":"test-a"}]}})");
            winrt::check_hresult(g_selectedHash == L"test-a" ? S_OK : E_FAIL);
            ApplyResponse(R"({"id":303,"op":"query","data":{"items":[]}})");
            winrt::check_hresult(g_selectedHash.empty() && g_hashes.empty() ? S_OK : E_FAIL);
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
            std::fprintf(stderr, "WinUI history: retained selection and preview keys\n");
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
            const auto beforeRightPreview = previewRequests.size();
            HandlePreviewKey(VirtualKey::Right, false, false, false, false);
            const auto rightPreview = requestAfter(L"previewSelect", beforeRightPreview);
            winrt::check_hresult(g_selectedHash == L"test-b" &&
                rightPreview.GetNamedNumber(L"navigationDirection") == 1 ? S_OK : E_FAIL);
            const auto afterRightPreview = previewRequests.size();
            HandlePreviewKey(VirtualKey::Right, true, false, false, false);
            currentStage = 161;
            // Realization may request a card after ScrollIntoView. It must not
            // be mistaken for another preview/navigation operation.
            winrt::check_hresult(g_selectedHash == L"test-b" &&
                std::none_of(previewRequests.begin() + afterRightPreview, previewRequests.end(), [](auto const &request) {
                    return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(request))
                        .GetNamedString(L"op") == L"previewSelect";
                }) ? S_OK : E_FAIL);
            const auto beforeLeftPreview = previewRequests.size();
            navigateFromPreview(R"({"id":0,"op":"previewNavigation","data":{"direction":-1,"key":"ArrowLeft","ctrlKey":false}})");
            currentStage = 162;
            winrt::check_hresult(g_selectedHash == L"test-a" &&
                requestAfter(L"previewSelect", beforeLeftPreview).GetNamedNumber(L"navigationDirection") == -1 ? S_OK : E_FAIL);
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
            const std::vector<winrt::Microsoft::UI::Xaml::FrameworkElement> dockViews{
                g_panel.root, g_panel.tagManager->Root()};
            const auto canvasColor = [](const auto &view) {
                return view.template as<winrt::Microsoft::UI::Xaml::Controls::Grid>().Background()
                    .template as<winrt::Microsoft::UI::Xaml::Media::SolidColorBrush>().Color();
            };
            WindowProc(g_panel.window, kSetTheme, 1, 0);
            for (const auto &view : dockViews) {
                const auto color = canvasColor(view);
                winrt::check_hresult(color.A == 255 && color.R == 246 && color.G == 247 && color.B == 249 ? S_OK : E_FAIL);
            }
            WindowProc(g_panel.window, kSetTheme, 2, 0);
            for (const auto &view : dockViews) {
                const auto color = canvasColor(view);
                winrt::check_hresult(color.A == 255 && color.R == 23 && color.G == 27 && color.B == 34 ? S_OK : E_FAIL);
            }
            const bool supported = winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController::IsSupported();
            winrt::check_hresult(ConfigureAcrylicBackdrop(true) == supported ? S_OK : E_FAIL);
            winrt::check_hresult(static_cast<bool>(g_panel.xamlSource.SystemBackdrop()
                .try_as<winrt::Microsoft::UI::Xaml::Media::DesktopAcrylicBackdrop>()) == supported ? S_OK : E_FAIL);
            for (const auto &view : dockViews) {
                winrt::check_hresult(canvasColor(view).A == (supported ? 0 : 255) ? S_OK : E_FAIL);
            }
            // The separate queue window must stay opaque regardless of dock Acrylic.
            winrt::check_hresult(canvasColor(g_panel.queueView->Root()).A == 255 ? S_OK : E_FAIL);
            winrt::check_hresult(g_panel.rows[0].surface.Background()
                .as<winrt::Microsoft::UI::Xaml::Media::SolidColorBrush>().Color().A == 255 ? S_OK : E_FAIL);
            winrt::check_hresult(g_selectedHash == selectedBeforeMaterialChange && g_panel.history.Items().Size() == 1 ? S_OK : E_FAIL);
            WindowProc(g_panel.window, kSetTheme, 0, 0);
            currentStage = 19;
            winrt::check_hresult(g_panel.commands.Children().Size() == 6 &&
                g_panel.commands.Orientation() == winrt::Microsoft::UI::Xaml::Controls::Orientation::Horizontal &&
                g_panel.commands.Spacing() == 8 ? S_OK : E_FAIL);
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
                for (std::uint32_t index = 0; index < g_panel.filter.Items().Size(); ++index) {
                    const auto tab = g_panel.filter.Items().GetAt(index)
                        .as<winrt::Microsoft::UI::Xaml::Controls::SelectorBarItem>();
                    const auto padding = tab.Padding();
                    winrt::check_hresult(tab.VerticalContentAlignment() ==
                        winrt::Microsoft::UI::Xaml::VerticalAlignment::Center &&
                        padding.Top == 0 && padding.Bottom == 0 ? S_OK : E_FAIL);
                }
                for (const auto &action : {g_panel.queueOpen, g_panel.settings,
                         g_panel.appActions->ToolsButton(), g_panel.appActions->UpdateButton()}) {
                    winrt::check_hresult(!winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::GetName(action).empty() &&
                        action.Content().try_as<winrt::Microsoft::UI::Xaml::Controls::PathIcon>() ? S_OK : E_FAIL);
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
                        const auto commandPosition = g_panel.commands.TransformToVisual(g_panel.root).TransformPoint({0, 0});
                        const auto filterPosition = g_panel.filterScroll.TransformToVisual(g_panel.root).TransformPoint({0, 0});
                        const bool fits = g_panel.commands.ActualWidth() <= width - kHeaderInset * 2 + 1 &&
                            g_panel.searchField.ActualWidth() >= 120 &&
                            filterPosition.X + g_panel.filterScroll.ActualWidth() <= commandPosition.X + 1 &&
                            commandPosition.X + g_panel.commands.ActualWidth() <= width - kHeaderInset + 1 &&
                            g_panel.history.ActualHeight() >= kCardHeight + 24 &&
                            g_panel.root.RowDefinitions().Size() == 2 &&
                            g_panel.root.RowDefinitions().GetAt(0).Height().Value == kHeaderHeight;
                        if (!fits) std::fprintf(stderr,
                            "WinUI layout: english=%d theme=%d width=%.0f actual=%.1f commands=%.1f search=%.1f filter=[%.1f,%.1f] commandX=%.1f history=%.1f\n",
                            english, theme, width, g_panel.root.ActualWidth(), g_panel.commands.ActualWidth(),
                            g_panel.searchField.ActualWidth(), filterPosition.X, g_panel.filterScroll.ActualWidth(),
                            commandPosition.X, g_panel.history.ActualHeight());
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
            std::fprintf(stderr, "WinUI history: dock geometry\n");
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
            winrt::check_hresult(queueRoot.RowDefinitions().Size() == 4 &&
                queueRoot.RowDefinitions().GetAt(1).Height().GridUnitType == GridUnitType::Star &&
                queueRoot.RowDefinitions().GetAt(3).Height().GridUnitType == GridUnitType::Auto ? S_OK : E_FAIL);
            const auto queueCommands = queueRoot.Children().GetAt(0).as<Grid>().Children().GetAt(2).as<StackPanel>().Children();
            winrt::check_hresult(queueCommands.Size() == 2 &&
                Automation::AutomationProperties::GetAutomationId(queueCommands.GetAt(0)) == L"queue-reverse" &&
                Automation::AutomationProperties::GetAutomationId(queueCommands.GetAt(1)) == L"queue-clear" ? S_OK : E_FAIL);
            g_panel.queueView->SetState(winrt::Windows::Data::Json::JsonObject::Parse(
                LR"({"revision":20,"busy":false,"capacity":100,"items":[{"hash":"layout-row","itemType":"Text","previewContent":"Long queue text should stay inside one surface","appSource":"Test"}],"undoHash":null})"));
            const auto queueCard = rows.Children().GetAt(0).as<Border>();
            const auto queueRow = queueCard.Child().as<Grid>();
            const auto paste = queueRow.Children().GetAt(0).as<Button>();
            const auto handle = queueRow.Children().GetAt(2).as<Button>();
            winrt::check_hresult(Automation::AutomationProperties::GetAutomationId(paste) == L"queue-paste" &&
                Grid::GetColumn(paste) == 1 && Automation::AutomationProperties::GetAutomationId(handle) == L"queue-handle" &&
                Grid::GetColumn(handle) == 0 &&
                queueCard.BorderThickness().Left > 0 && queueCard.BorderThickness().Bottom > 0 &&
                queueCard.CornerRadius().TopLeft > 0 && queueCard.CornerRadius().BottomRight > 0 ? S_OK : E_FAIL);
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
                    FormatCardTime(clock - 120000, clock) == winrt::hstring{L"2"} + Text(L"分钟前", L"m ago") &&
                    FormatCardTime(clock - 10000, clock) == Text(L"10秒前", L"10s ago") &&
                    FormatCardTime(clock - 10ULL * 86400000, clock) == Text(L"10天前", L"10d ago") &&
                    FormatCardTime(clock - 30ULL * 86400000, clock) == Text(L"1个月前", L"1mo ago") &&
                    FormatCardTime(clock - 365ULL * 86400000, clock) == Text(L"1年前", L"1y ago") ? S_OK : E_FAIL);
            }
            g_english = originalEnglish;
            currentStage = 26;
            std::fprintf(stderr, "WinUI history: content and dynamic tabs\n");
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
            const auto cardFlyout = EnsureCardContextMenu(g_panel.rows[0], g_hashes[0]);
            winrt::check_hresult(cardFlyout.Items().GetAt(cardFlyout.Items().Size() - 1).as<MenuFlyoutItem>().Icon() &&
                cardFlyout.Items().GetAt(cardFlyout.Items().Size() - 1).as<MenuFlyoutItem>().KeyboardAcceleratorTextOverride() == L"Enter" ? S_OK : E_FAIL);
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
            winrt::check_hresult(g_panel.loading.Visibility() == Visibility::Collapsed &&
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
            const auto fixtureCard = [](char const *json) {
                using namespace winrt::Windows::Data::Json;
                auto response = JsonObject::Parse(winrt::to_hstring(json));
                const auto hash = std::wstring{response.GetNamedObject(L"data").GetNamedString(L"hash")};
                RequestCardDetails(hash);
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(FindCard(hash)->cardRequestId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
            };
            ApplyResponse(R"({"id":950,"op":"query","data":{"items":[{"hash":"rich-test","itemType":"Text"},{"hash":"link-test","itemType":"Link"},{"hash":"files-test","itemType":"File"}]}})");
            fixtureCard(R"({"op":"card","data":{"hash":"rich-test","isRichText":true,"displayText":"plain fallback","rich":{"darkCanvas":true,"blocks":[{"runs":[{"text":"A😀"},{"text":"强调","bold":true,"italic":true,"underline":true,"foreground":{"r":255,"g":255,"b":255},"backgroundColor":{"r":50,"g":100,"b":150}},{"text":"code","mono":true},{"image":"C:\\cache\\missing #1.png"}],"rows":[]},{"runs":[],"rows":[[[{"text":"列一"}],[{"text":"列二"}]],[[{"text":"值一"}],[{"text":"值二"}]]]}]}}})");
            const auto &richCard = g_panel.rows[0];
            winrt::check_hresult(richCard.richFrame.Child() ? S_OK : E_FAIL);
            const auto richViewport = richCard.richFrame.Child().as<ScrollViewer>();
            const auto richStack = richViewport.Content().as<StackPanel>();
            const auto richText = richStack.Children().GetAt(0).as<RichTextBlock>();
            const auto paragraph = richText.Blocks().GetAt(0).as<Documents::Paragraph>();
            const auto styledRun = paragraph.Inlines().GetAt(1).as<Documents::Run>();
            const auto highlightRange = richText.TextHighlighters().GetAt(0).Ranges().GetAt(0);
            std::fprintf(stderr, "WinUI rich content: visible=%d preview=%d badge=%d selectable=%d weight=%u style=%d underline=%u range=%d,%d inlines=%u\n",
                static_cast<int>(richCard.richFrame.Visibility()), static_cast<int>(richCard.preview.Visibility()),
                static_cast<int>(richCard.richBadgeFrame.Visibility()), richText.IsTextSelectionEnabled(), styledRun.FontWeight().Weight,
                static_cast<int>(styledRun.FontStyle()), static_cast<unsigned>(styledRun.TextDecorations()),
                highlightRange.StartIndex, highlightRange.Length, paragraph.Inlines().Size());
            winrt::check_hresult(richCard.richFrame.Visibility() == Visibility::Visible &&
                richCard.preview.Visibility() == Visibility::Collapsed &&
                richCard.richBadgeFrame.Visibility() == Visibility::Visible && !richText.IsTextSelectionEnabled() &&
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
            std::fprintf(stderr, "WinUI history: link/file detail fixtures\n");
            fixtureCard(R"({"op":"card","data":{"hash":"link-test","displayTitle":"Reference","displaySubtitle":"https://example.com/path"}})");
            fixtureCard(R"({"op":"card","data":{"hash":"files-test","fileCount":3,"displaySubtitle":"notes.md\nreport.pdf\nphoto.png"}})");
            winrt::check_hresult(g_panel.rows[1].preview.Text() == L"Reference" &&
                g_panel.rows[1].subtitle.Text() == L"https://example.com/path" &&
                g_panel.rows[2].dimensionsFrame &&
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
            winrt::check_hresult(queueActions.Children().Size() == 1 ? S_OK : E_FAIL);
            const auto moveMenu = rows.Children().GetAt(0).as<Border>().Child().as<Grid>().Children().GetAt(0)
                .as<Button>().ContextFlyout().as<MenuFlyout>();
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
                    .Children().GetAt(0).as<Button>().Content().as<Grid>().Children().GetAt(1).as<StackPanel>().Children().GetAt(0).as<TextBlock>().Text();
            };
            winrt::check_hresult(detailsAt(0) == L"notes.md +1" && detailsAt(1) == L"https://example.com" ? S_OK : E_FAIL);
            currentStage = 343;
            const auto newMenu = rows.Children().GetAt(0).as<Border>().Child().as<Grid>()
                .Children().GetAt(0).as<Button>().ContextFlyout().as<MenuFlyout>();
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
            const std::vector<vpaste::winui::QueueRowMetric> metrics{{0, 66}, {66, 66}, {132, 66}, {198, 66}};
            winrt::check_hresult(vpaste::winui::QueuePointerOrder(order, metrics, L"a", 198) ==
                std::vector<std::wstring>{L"b", L"c", L"d", L"a"} &&
                vpaste::winui::QueuePointerOrder(order, metrics, L"d", -199) ==
                std::vector<std::wstring>{L"d", L"a", L"b", L"c"} &&
                vpaste::winui::QueuePointerOrder(order, metrics, L"d", -198) ==
                std::vector<std::wstring>{L"a", L"d", L"b", L"c"} &&
                vpaste::winui::QueuePointerOrder(order, metrics, L"b", 0) == order &&
                vpaste::winui::QueuePointerOrder(order, {}, L"b", 100) == order ? S_OK : E_FAIL);
            winrt::check_hresult(g_panel.rows[0].surface.CanDrag() ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            winrt::check_hresult(!g_panel.rows[0].surface.CanDrag() ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            currentStage = 36;
            using namespace winrt::Windows::ApplicationModel::DataTransfer;
            for (const auto type : {L"Text", L"TextFile", L"Color", L"Link", L"Image", L"File"}) {
                DataPackage announced;
                vpaste::winui::DeclareDragFormats(announced, type, true, [](DataProviderRequest const &) {});
                winrt::com_ptr<IDataObject> object;
                winrt::check_hresult(announced.as<IDataObjectProvider>()->GetDataObject(object.put()));
                FORMATETC expected{static_cast<CLIPFORMAT>(std::wstring_view{type} == L"Image" ||
                    std::wstring_view{type} == L"File" ? CF_HDROP : CF_UNICODETEXT),
                    nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
                const auto result = object->QueryGetData(&expected);
                std::fprintf(stderr, "WinUI drag declared format: type=%ls HRESULT=0x%08X\n", type, static_cast<unsigned>(result));
                winrt::check_hresult(result);
            }
            DataPackage richPackage;
            winrt::com_ptr<IDataObject> earlyRichData;
            winrt::check_hresult(richPackage.as<IDataObjectProvider>()->GetDataObject(earlyRichData.put()));
            co_await vpaste::winui::PopulateDragPackage(richPackage, winrt::Windows::Data::Json::JsonObject::Parse(
                LR"({"text":"Native 原文😀","html":"<b>Native 原文😀</b>","url":"","files":[]})"));
            winrt::check_hresult((co_await richPackage.GetView().GetTextAsync()) == L"Native 原文😀" &&
                std::wstring{co_await richPackage.GetView().GetHtmlFormatAsync()}.find(L"<b>") != std::wstring::npos &&
                richPackage.RequestedOperation() == DataPackageOperation::Copy ? S_OK : E_FAIL);
            co_await vpaste::winui::CardDragSource::TestDataProviders(richPackage, L"Text", true);
            FORMATETC unicodeText{CF_UNICODETEXT, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
            const auto earlyRichResult = earlyRichData->QueryGetData(&unicodeText);
            std::fprintf(stderr, "WinUI drag early OLE text format: HRESULT=0x%08X\n", static_cast<unsigned>(earlyRichResult));
            winrt::check_hresult(earlyRichResult);
            STGMEDIUM textMedium{};
            winrt::check_hresult(earlyRichData->GetData(&unicodeText, &textMedium));
            const auto nativeText = static_cast<const wchar_t *>(GlobalLock(textMedium.hGlobal));
            const bool textMatches = nativeText && std::wstring_view{nativeText} == L"Native 原文😀";
            if (nativeText) GlobalUnlock(textMedium.hGlobal);
            ReleaseStgMedium(&textMedium);
            winrt::check_hresult(textMatches ? S_OK : E_FAIL);
            DataPackage linkPackage;
            co_await vpaste::winui::PopulateDragPackage(linkPackage, winrt::Windows::Data::Json::JsonObject::Parse(
                LR"({"text":"https://example.com/path","html":"<a href=\"https://example.com/path\">https://example.com/path</a>","url":"https://example.com/path","files":[]})"));
            winrt::check_hresult((co_await linkPackage.GetView().GetWebLinkAsync()).Host() == L"example.com" &&
                !linkPackage.GetView().Contains(StandardDataFormats::StorageItems()) &&
                !linkPackage.GetView().Contains(StandardDataFormats::Bitmap()) ? S_OK : E_FAIL);
            co_await vpaste::winui::CardDragSource::TestDataProviders(linkPackage, L"Link", false);
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
            winrt::com_ptr<IDataObject> earlyFileData;
            winrt::check_hresult(filePackage.as<IDataObjectProvider>()->GetDataObject(earlyFileData.put()));
            co_await vpaste::winui::PopulateDragPackage(filePackage, filePayload);
            co_await vpaste::winui::CardDragSource::TestDataProviders(filePackage, L"File", false);
            const auto storage = co_await filePackage.GetView().GetStorageItemsAsync();
            winrt::check_hresult(storage.Size() == 2 && storage.GetAt(0).Name() ==
                winrt::hstring{dragFiles.first.substr(dragFiles.first.find_last_of(L'\\') + 1)} &&
                !filePackage.GetView().Contains(StandardDataFormats::Text()) ? S_OK : E_FAIL);
            winrt::com_ptr<IDataObject> shellData;
            winrt::check_hresult(filePackage.as<IDataObjectProvider>()->GetDataObject(shellData.put()));
            FORMATETC shellIdList{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_SHELLIDLIST)),
                nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
            FORMATETC fileDrop{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
            std::fprintf(stderr, "WinUI drag formats: CF_HDROP=0x%08X ShellIDList=0x%08X\n",
                static_cast<unsigned>(shellData->QueryGetData(&fileDrop)),
                static_cast<unsigned>(shellData->QueryGetData(&shellIdList)));
            winrt::check_hresult(shellData->QueryGetData(&fileDrop));
            winrt::check_hresult(shellData->QueryGetData(&shellIdList));
            const auto earlyFileResult = earlyFileData->QueryGetData(&fileDrop);
            std::fprintf(stderr, "WinUI drag early OLE file format: HRESULT=0x%08X\n", static_cast<unsigned>(earlyFileResult));
            winrt::check_hresult(earlyFileResult);
            STGMEDIUM medium{};
            winrt::check_hresult(shellData->GetData(&fileDrop, &medium));
            struct DropMedium { STGMEDIUM &value; ~DropMedium() { ReleaseStgMedium(&value); } } dropMedium{medium};
            const auto drop = static_cast<HDROP>(medium.hGlobal);
            wchar_t droppedPath[32768]{};
            winrt::check_hresult(DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0) == 2 ? S_OK : E_FAIL);
            DragQueryFileW(drop, 0, droppedPath, static_cast<UINT>(std::size(droppedPath)));
            winrt::check_hresult(dragFiles.first == droppedPath ? S_OK : E_FAIL);
            DragQueryFileW(drop, 1, droppedPath, static_cast<UINT>(std::size(droppedPath)));
            winrt::check_hresult(dragFiles.second == droppedPath ? S_OK : E_FAIL);
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
                winrt::check_hresult(options.ItemContainerTransitions().Size() == 0 ? S_OK : E_FAIL);
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
                const auto density = options.ItemsPanelRoot().as<ItemsWrapGrid>();
                winrt::check_hresult(content.Width() == 224 && density.ItemWidth() == 28 && density.ItemHeight() == 28 ? S_OK : E_FAIL);
                std::fprintf(stderr, "WinUI emoji palette: items=%u firstVisible=%d entranceTransitions=%u\n",
                    options.Items().Size(), options.ContainerFromIndex(0) != nullptr, options.ItemContainerTransitions().Size());
                const auto requestCount = previewRequests.size();
                const auto option = options.ContainerFromIndex(3).as<FrameworkElement>();
                winrt::check_hresult(option.ActualWidth() <= 28.5 && option.ActualHeight() <= 28.5 ? S_OK : E_FAIL);
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
                    menu.Items().Append(AppendCardActions(menu, L"plain-fixture", type, true, SendCardAction).pastePlain);
                    winrt::check_hresult(!find(menu, L"Copy as plain text") && find(menu, L"Paste as plain text") &&
                        !find(menu, L"Export image…") ? S_OK : E_FAIL);
                    menu.ShowAt(g_panel.searchButton); co_await NextNativeFrame();
                    invoke(find(menu, L"Paste as plain text")); co_await NextNativeFrame();
                    winrt::check_hresult(requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"pastePlain" &&
                        requestAt(previewRequests.size() - 1).GetNamedString(L"hash") == L"plain-fixture" ? S_OK : E_FAIL);
                    menu.Hide();
                }
                MenuFlyout files;
                const auto fileMenu = AppendCardActions(files, L"file-fixture", L"File", true, SendCardAction);
                winrt::check_hresult(find(files, L"Open containing folder") && find(files, L"Copy containing folder") &&
                    !find(files, L"Paste as plain text") && fileMenu.exportImage.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                UpdateCardActions(fileMenu, JsonObject::Parse(LR"({"canExportImage":true})"), L"file-fixture", SendCardAction);
                winrt::check_hresult(fileMenu.exportImage.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
                MenuFlyout image;
                image.Items().Append(MakeImageTextAction(L"image-fixture", true, SendCardAction));
                AppendCardActions(image, L"image-fixture", L"Image", true, SendCardAction);
                const auto recognize = find(image, L"Recognize text in image");
                winrt::check_hresult(recognize && recognize.Icon().try_as<PathIcon>() && find(image, L"Export image…") &&
                    !find(image, L"Open containing folder") ? S_OK : E_FAIL);
                MenuFlyout colors;
                const auto colorMenu = AppendCardActions(colors, L"color-fixture", L"Color", true, SendCardAction);
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
                RequestHistory();
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestQueryId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
                co_await NextNativeFrame();
                winrt::check_hresult(!g_panel.rows[0].contextMenu ? S_OK : E_FAIL);
                winrt::check_hresult(OpenSelectedCardMenu() ? S_OK : E_FAIL);
                const auto menu = g_panel.rows[0].contextMenu;
                co_await NextNativeFrame();
                winrt::check_hresult(menu && menu.IsOpen() ? S_OK : E_FAIL);
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
                expect({.key='1', .alt=true, .area=InputArea::Other}, MainKeyAction::QuickItem, 0);
                expect({.key='A', .alt=true, .area=InputArea::Other}, MainKeyAction::QuickAll);
                expect({.key='F', .alt=true, .area=InputArea::Other}, MainKeyAction::QuickFavorite);
                expect({.key='F', .alt=true, .blocked=true, .area=InputArea::Other}, MainKeyAction::None);
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
                    if (!g_historyLoading || g_historyView.requestedQuery != CurrentHistoryQuery()) RequestHistory();
                    JsonObject response; response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestQueryId)));
                    response.Insert(L"op", JsonValue::CreateStringValue(L"query")); response.Insert(L"data", data);
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                setBehavior(R"({"quickInput":true,"tabSelection":true,"plainShortcut":"Shift+Enter"})");
                rows(L"keyboard-", 12);
                (void)EnsureCardContextMenu(g_panel.rows[0], g_hashes[0]);
                winrt::check_hresult(MainInputArea(g_panel.search) == InputArea::Search &&
                    MainInputArea(g_panel.rows[0].favoriteButton) == InputArea::Other &&
                    NativeControlOwnsKeys(g_panel.rows[0].menu.pastePlain) && !NativeControlOwnsKeys(g_panel.search) ? S_OK : E_FAIL);
                winrt::check_hresult(HandleMainKey({.key=VK_MENU, .alt=true}) ? S_OK : E_FAIL);
                for (std::size_t i = 0; i < g_panel.rows.size(); ++i) {
                    winrt::check_hresult(g_panel.rows[i].shortcutHint.Visibility() == (i < 9 ? Visibility::Visible : Visibility::Collapsed) &&
                        !g_panel.rows[i].shortcutHint.IsHitTestVisible() ? S_OK : E_FAIL);
                }
                co_await NextNativeFrame();
                const auto categoryHint = [](std::uint32_t index) {
                    const auto tab = g_panel.filter.Items().GetAt(index);
                    const auto root = Media::VisualTreeHelper::GetChild(tab, 0).as<Grid>();
                    for (const auto &child : root.Children())
                        if (Automation::AutomationProperties::GetAutomationId(child) == L"category-shortcut-hint") return child.as<Border>();
                    throw winrt::hresult_error(E_FAIL, L"Missing loaded category shortcut hint");
                };
                for (std::uint32_t index = 0; index < 2; ++index) {
                    const auto hint = categoryHint(index);
                    winrt::check_hresult(hint.Visibility() == Visibility::Visible && !hint.IsHitTestVisible() &&
                        hint.Child().as<TextBlock>().Text() == (index == 0 ? L"A" : L"F") ? S_OK : E_FAIL);
                }
                WindowProc(g_panel.window, WM_ACTIVATE, WA_INACTIVE, 0);
                winrt::check_hresult(!g_altHints && g_panel.rows[0].shortcutHint.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                winrt::check_hresult(categoryHint(0).Visibility() == Visibility::Collapsed &&
                    categoryHint(1).Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                HandleMainKey({.key='F', .alt=true, .area=InputArea::Other});
                winrt::check_hresult(FilterIndex() == 1 ? S_OK : E_FAIL);
                HandleMainKey({.key='A', .alt=true, .area=InputArea::Other});
                winrt::check_hresult(FilterIndex() == 0 ? S_OK : E_FAIL);
                rows(L"keyboard-", 12); // Complete the newly requested category before quick paste.
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
                winrt::check_hresult(!g_panel.history.IsMultiSelectCheckBoxEnabled() ? S_OK : E_FAIL);
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
                const auto beforeEnter = previewRequests.size();
                HandleMainKey({.key=VK_RETURN});
                HandleMainKey({.key=VK_RETURN, .repeated=true});
                winrt::check_hresult(previewRequests.size() == beforeEnter + 1 &&
                    requestAt(beforeEnter).GetNamedString(L"op") == L"paste" &&
                    requestAt(beforeEnter).GetNamedString(L"hash") == L"refresh-5" ? S_OK : E_FAIL);
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
                    g_panel.rows[1].recordTags->Pills().Children().Size() == 2 &&
                    !g_panel.rows[1].tagChip.IsHitTestVisible() ? S_OK : E_FAIL);
                const auto beforeMenu = previewRequests.size();
                winrt::check_hresult(!g_panel.rows[0].contextMenu ? S_OK : E_FAIL);
                currentStage = 672;
                for (const auto key : {VK_APPS, VK_F10}) {
                    winrt::check_hresult(HandleMainKey({.key = static_cast<std::uint32_t>(key), .shift = key == VK_F10}) ? S_OK : E_FAIL);
                    co_await NextNativeFrame();
                    const auto cardMenu = g_panel.rows[0].contextMenu;
                    if (!cardMenu || !cardMenu.IsOpen()) std::fprintf(stderr, "WinUI menu-key check: key=%d foreground=%d selected=%d\n", key, GetForegroundWindow() == g_panel.window, g_panel.history.SelectedIndex());
                    winrt::check_hresult(cardMenu && cardMenu.IsOpen() ? S_OK : E_FAIL); co_await CloseNativeFlyout(cardMenu);
                }
                const auto cardMenu = EnsureCardContextMenu(g_panel.rows[0], g_hashes[0]);
                MenuFlyoutSubItem tagMenu{nullptr};
                currentStage = 673;
                for (const auto &option : cardMenu.Items()) {
                    if (auto submenu = option.try_as<MenuFlyoutSubItem>(); submenu && submenu.Text() == L"Tags") tagMenu = submenu;
                }
                winrt::check_hresult(tagMenu && tagMenu.Items().GetAt(0).as<ToggleMenuFlyoutItem>().IsChecked() &&
                    tagMenu.Items().GetAt(1).as<ToggleMenuFlyoutItem>().Text() == L"Notes" ? S_OK : E_FAIL);
                cardMenu.ShowAt(g_panel.rows[0].surface); co_await NextNativeFrame();
                for (const auto &option : cardMenu.Items())
                    if (auto submenu = option.try_as<MenuFlyoutSubItem>(); submenu && submenu.Text() == L"Tags") tagMenu = submenu;
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(tagMenu)
                    .GetPattern(Automation::Peers::PatternInterface::ExpandCollapse).as<Automation::Provider::IExpandCollapseProvider>().Expand();
                currentStage = 674;
                const auto option = tagMenu.Items().GetAt(1).as<ToggleMenuFlyoutItem>();
                co_await AwaitNativeLoaded(option);
                const auto toggle = Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(option)
                    .GetPattern(Automation::Peers::PatternInterface::Toggle).try_as<Automation::Provider::IToggleProvider>();
                winrt::check_hresult(toggle ? S_OK : E_NOINTERFACE);
                const auto beforeAssign = previewRequests.size();
                toggle.Toggle();
                co_await NextNativeFrame();
                winrt::check_hresult(previewRequests.size() > beforeAssign &&
                    requestAt(previewRequests.size() - 1).GetNamedString(L"op") == L"assignTag" &&
                    requestAt(previewRequests.size() - 1).GetNamedString(L"hash") == L"single-tag" &&
                    requestAt(previewRequests.size() - 1).GetNamedNumber(L"tagId") == 10 ? S_OK : E_FAIL);
                co_await CloseNativeFlyout(cardMenu);
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
                const auto dynamicTab = DynamicTab(L"record:10");
                const auto dynamicPadding = dynamicTab.Padding();
                winrt::check_hresult(add.Items().Size() == 2 && tabMenu.Items().Size() == 2 &&
                    dynamicTab.VerticalContentAlignment() == VerticalAlignment::Center &&
                    dynamicPadding.Top == 0 && dynamicPadding.Bottom == 0 &&
                    add.Items().GetAt(1).as<MenuFlyoutItem>().Text() == L"Record Tag" &&
                    add.Items().GetAt(0).as<MenuFlyoutItem>().Text() == L"Filter Tag" &&
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
                co_await vpaste::winui::TestCardContentControls(fixture, currentStage,
                    winrt::Windows::Data::Json::JsonArray::Parse(winrt::to_hstring(fileFixtures)));
                SetTagManagerActive(false); co_await NextNativeFrame();
            }
            currentStage = 71;
            {
                using namespace winrt::Microsoft::UI::Xaml;
                using namespace winrt::Microsoft::UI::Xaml::Controls;
                using namespace winrt::Windows::Data::Json;
                g_panel.search.Text(L"hello tag:Work"); g_searchTimer.Stop(); RequestHistory();
                auto result = JsonObject::Parse(LR"({"op":"query","data":{"highlightTerms":["tag:Work","hello"],"hasMore":false,"items":[
                    {"hash":"content-text","itemType":"Text","previewText":"😀 HELLO reference tag:Work"},
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
                winrt::check_hresult(g_highlightTerms == vpaste::winui::SearchTerms{L"tag:Work", L"hello"} &&
                    FindCard(L"content-text")->preview.TextHighlighters().Size() == 1 &&
                    FindCard(L"content-text")->preview.TextHighlighters().GetAt(0).Ranges().GetAt(0).StartIndex == 3 ? S_OK : E_FAIL);
                cardResult(L"content-file", FindCard(L"content-file")->cardRequestId,
                    JsonObject::Parse(LR"({"displayText":"hello.txt","displayTitle":"hello.txt","displaySubtitle":"C:\\hello\\file.txt"})"));
                currentStage = 711;
                winrt::check_hresult(FindCard(L"content-file")->preview.TextHighlighters().Size() == 1 &&
                    FindCard(L"content-file")->subtitle.TextHighlighters().Size() == 1 ? S_OK : E_FAIL);
                RequestCardDetails(L"content-file", true);
                cardResult(L"content-file", FindCard(L"content-file")->cardRequestId,
                    JsonObject::Parse(LR"({"visualType":"Image","displayTitle":"photo.png"})"));
                winrt::check_hresult(FindCard(L"content-file")->itemType == L"File" &&
                    FindCard(L"content-file")->type.Text() == ItemTypeLabel(L"Image") ? S_OK : E_FAIL);
                RequestCardDetails(L"content-file", true);
                cardResult(L"content-file", FindCard(L"content-file")->cardRequestId, JsonObject{});
                winrt::check_hresult(FindCard(L"content-file")->type.Text() == ItemTypeLabel(L"File") ? S_OK : E_FAIL);
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
                    FindCard(L"content-image")->dimensions.Text() == L"24 × 16" ? S_OK : E_FAIL);

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
                imageData.Insert(L"appIconPath", JsonValue::CreateStringValue(imagePath));
                cardResult(L"content-image", bitmapRequest, imageData);
                co_await AwaitCardDetailState(L"content-image", bitmapRequest, CardDetailState::Ready);
                const auto decoded = FindCard(L"content-image")->image.Source().as<Media::Imaging::BitmapImage>();
                winrt::check_hresult(decoded.PixelWidth() > 0 && FindCard(L"content-image")->image.MaxWidth() == 8 &&
                    FindCard(L"content-image")->image.MaxHeight() == 6 && FindCard(L"content-image")->contentIcon.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                auto &photo = *FindCard(L"content-image");
                winrt::check_hresult(photo.sourceIcon.Source() && photo.sourceFrame.Visibility() == Visibility::Visible &&
                    photo.fileInvalidBadge.Width() == 24 && photo.fileInvalidBadge.Height() == 24 &&
                    photo.fileInvalidBadge.Child().as<FontIcon>().FontSize() == vpaste::winui::CompactIconSize ? S_OK : E_FAIL);
                const auto neutralSourceHeader = photo.header.Background().as<Media::LinearGradientBrush>();
                winrt::check_hresult(neutralSourceHeader.GradientStops().Size() == 2 &&
                    neutralSourceHeader.GradientStops().GetAt(0).Color() == Rgb(116, 124, 135) &&
                    neutralSourceHeader.GradientStops().GetAt(1).Color() == Rgb(86, 94, 104) ? S_OK : E_FAIL);
                winrt::check_hresult(!photo.mediaFrame.Background() && photo.imageMatte.Width() == 8 &&
                    photo.imageMatte.Height() == 6 && photo.imageMatte.Background() &&
                    photo.dimensions.TransformToVisual(photo.mediaFrame).TransformPoint({0, 0}).Y < photo.mediaFrame.ActualHeight()
                    ? S_OK : E_FAIL);
                currentStage = 73;
                RequestCardDetails(L"content-image", true);
                const auto newer = FindCard(L"content-image")->cardRequestId;
                CompleteCardBitmap(L"content-image", bitmapRequest, decoded, false, L"Old decoder failure");
                winrt::check_hresult(FindCard(L"content-image")->detailState == CardDetailState::Loading ? S_OK : E_FAIL);
                imageData.Remove(L"appIconPath");
                cardResult(L"content-image", newer, imageData); co_await AwaitCardDetailState(L"content-image", newer, CardDetailState::Ready);
                winrt::check_hresult(!FindCard(L"content-image")->sourceIcon.Source() &&
                    FindCard(L"content-image")->sourceFrame.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
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
                    JsonObject::Parse(LR"({"displayText":"hello rich fallback","isRichText":true,"rich":{"blocks":[{"runs":[{"text":"hello rich","bold":true}],"rows":[]}]}})"));
                winrt::check_hresult(FindCard(L"content-text")->richFrame.Visibility() == Visibility::Visible &&
                    FindCard(L"content-text")->preview.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                currentStage = 751;
                const auto priorRichFrame = FindCard(L"content-text")->frame;
                const auto priorFileFrame = FindCard(L"content-file")->frame;
                const auto priorImageFrame = FindCard(L"content-image")->frame;
                g_panel.search.Text(L"rich"); g_searchTimer.Stop(); RequestHistory();
                result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                result.GetNamedObject(L"data").Insert(L"highlightTerms", JsonArray::Parse(LR"(["rich"])") );
                ApplyResponse(winrt::to_string(result.Stringify()));
                winrt::check_hresult(FindCard(L"content-text")->frame != priorRichFrame &&
                    FindCard(L"content-file")->frame == priorFileFrame &&
                    FindCard(L"content-image")->frame == priorImageFrame ? S_OK : E_FAIL);
                RequestCardDetails(L"content-text");
                cardResult(L"content-text", FindCard(L"content-text")->cardRequestId,
                    JsonObject::Parse(LR"({"displayText":"hello rich fallback","isRichText":true,"rich":{"blocks":[{"runs":[{"text":"hello rich","bold":true}],"rows":[]}]}})"));
                currentStage = 752;
                const auto highlightedRich = FindCard(L"content-text")->richFrame.Child().as<ScrollViewer>()
                    .Content().as<StackPanel>().Children().GetAt(0).as<RichTextBlock>();
                winrt::check_hresult(highlightedRich.TextHighlighters().Size() == 1 &&
                    highlightedRich.TextHighlighters().GetAt(0).Ranges().GetAt(0).StartIndex == 6 &&
                    highlightedRich.TextHighlighters().GetAt(0).Ranges().GetAt(0).Length == 4 ? S_OK : E_FAIL);
                const auto sameTermsRichFrame = FindCard(L"content-text")->frame;
                RequestHistory();
                result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(result.Stringify()));
                winrt::check_hresult(FindCard(L"content-text")->frame == sameTermsRichFrame ? S_OK : E_FAIL);
                RequestCardDetails(L"content-text", true);
                cardResult(L"content-text", FindCard(L"content-text")->cardRequestId,
                    JsonObject::Parse(LR"({"displayText":"hello refreshed text"})"));
                winrt::check_hresult(FindCard(L"content-text")->richFrame.Visibility() == Visibility::Collapsed &&
                    !FindCard(L"content-text")->richFrame.Child() && FindCard(L"content-text")->richBadgeFrame.Visibility() == Visibility::Collapsed &&
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
                ToggleQueueSelectionMode(); g_panel.history.UpdateLayout();
                const auto origin = g_panel.rows[1].surface;
                const auto beforeEnter = previewRequests.size();
                winrt::check_hresult(MainInputArea(origin) == vpaste::winui::InputArea::History &&
                    HandleMainKey({.key=VK_RETURN}, origin) &&
                    g_queueSelectedHashes == std::vector<std::wstring>{L"add-b"} ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_RETURN, .repeated=true}, origin);
                winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"add-b"} ? S_OK : E_FAIL);
                HandleMainKey({.key=VK_RETURN, .shift=true}, origin);
                HandleMainKey({.key=VK_RETURN}, g_panel.history);
                winrt::check_hresult(g_queueSelectedHashes.empty() && previewRequests.size() == beforeEnter ? S_OK : E_FAIL);
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
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
                co_await vpaste::winui::TestQueueFailureRecoveryControls(fixture, currentStage);
                co_await vpaste::winui::TestQueueRowContinuityControls(fixture, currentStage);
                co_await vpaste::winui::TestQueuePointerReorderControls(fixture, currentStage);
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
                    !ToolTipService::GetToolTip(g_panel.customTabs.Items().GetAt(0)) &&
                    Automation::AutomationProperties::GetName(g_panel.customTabs.Items().GetAt(0)) == L"Current filter name" ? S_OK : E_FAIL);
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
                const auto menuButton = rows.Children().GetAt(0).as<Border>().Child().as<Grid>().Children().GetAt(0).as<Button>();
                const auto menu = menuButton.ContextFlyout().as<MenuFlyout>();
                menu.ShowAt(menuButton); co_await NextNativeFrame();
                winrt::check_hresult(menu.IsOpen() ? S_OK : E_FAIL);
                SetQueueViewActive(false); SetQueueViewActive(true);
                for (int frame = 0; frame < 30 && menu.IsOpen(); ++frame) co_await NextNativeFrame();
                winrt::check_hresult(!menu.IsOpen() ? S_OK : E_FAIL);
                const auto clear = queueRoot.Children().GetAt(0).as<Grid>().Children().GetAt(2)
                    .as<StackPanel>().Children().GetAt(1).as<Button>();
                winrt::check_hresult(Automation::AutomationProperties::GetAutomationId(clear) == L"queue-clear" ? S_OK : E_FAIL);
                const auto beforeClear = previewRequests.size();
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(clear)
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                co_await NextNativeFrame();
                winrt::check_hresult(!clear.IsEnabled() ? S_OK : E_FAIL);
                SetQueueViewActive(false);
                SetQueueViewActive(true);
                co_await NextNativeFrame();
                winrt::check_hresult(clear.IsEnabled() && rows.Children().Size() == 1 ? S_OK : E_FAIL);
                for (auto index = beforeClear; index < previewRequests.size(); ++index)
                    winrt::check_hresult(requestAt(index).GetNamedString(L"op") != L"queueClear" ? S_OK : E_FAIL);
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
                    g_panel.searchField.ActualWidth() >= 120 ? S_OK : E_FAIL);
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
            // Opening a menu/search cancels a pending hover. Returning to the
            // same card at the same pointer position must be able to re-arm it.
            g_hoverPosition = winrt::Windows::Foundation::Point{12, 18};
            g_hoverHash = L"hover-rearm";
            CancelHoverPreview();
            winrt::check_hresult(!g_hoverPosition && g_hoverHash.empty() ? S_OK : E_FAIL);
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
                co_await NextNativeFrame();
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(g_panel.queueAdd)
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                co_await NextNativeFrame();
                const auto first = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(first.GetNamedString(L"op") == L"queueAdd" &&
                    first.GetNamedArray(L"hashes").Size() == 1 && first.GetNamedArray(L"hashes").GetStringAt(0) == L"batch-one" &&
                    !g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
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
                            g_panel.cancelSelection.ActualWidth() >= 32 && g_panel.selectionCount.Text() == L"0" &&
                            g_panel.selectionTitle.Text() == Text(L"选择要加入队列的项目", L"Select items to add to the queue") &&
                            winrt::unbox_value<winrt::hstring>(g_panel.queueAdd.Content()) == Text(L"加入 0 项", L"Add 0 items");
                        if (!fits) std::fprintf(stderr,
                            "WinUI selection-bar bounds: english=%d width=%.1f root=%.1fx%.1f bounds=%.1f,%.1f %.1fx%.1f buttons=%.1f/%.1f count=%ls\n",
                            english, width, g_panel.root.ActualWidth(), g_panel.root.ActualHeight(),
                            bounds.X, bounds.Y, bounds.Width, bounds.Height,
                            g_panel.queueAdd.ActualWidth(), g_panel.cancelSelection.ActualWidth(),
                            g_panel.selectionCount.Text().c_str());
                        winrt::check_hresult(fits ? S_OK : E_FAIL);
                        g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                        g_panel.root.UpdateLayout();
                        co_await NextNativeFrame();
                        const bool addHit = OwnsNativePointer(g_panel.queueAdd);
                        const bool cancelHit = OwnsNativePointer(g_panel.cancelSelection);
                        const auto centerY = [](FrameworkElement const &element) {
                            return element.TransformToVisual(g_panel.root).TransformPoint({0, static_cast<float>(element.ActualHeight()) / 2}).Y;
                        };
                        const bool centered = g_panel.selectionTitle.VerticalAlignment() == VerticalAlignment::Center &&
                            g_panel.selectionCount.VerticalAlignment() == VerticalAlignment::Center &&
                            std::abs(centerY(g_panel.selectionTitle) - centerY(g_panel.queueAdd)) < 1 &&
                            std::abs(centerY(g_panel.selectionCount) - centerY(g_panel.queueAdd)) < 1;
                        std::fprintf(stderr, "WinUI queue pointer regression: english=%d width=%.0f enabled=%d add=%d cancel=%d centered=%d\n",
                            english, width, g_panel.queueAdd.IsEnabled(), addHit, cancelHit, centered);
                        winrt::check_hresult(g_panel.queueAdd.IsEnabled() && addHit && cancelHit && centered ? S_OK : E_FAIL);
                        winrt::check_hresult(OwnsNativePointer(g_panel.selectionBar) ? S_OK : E_FAIL);
                        vpaste::winui::FadeFeedback(g_panel.selectionBar, false);
                        ApplyRowTheme(true);
                        winrt::check_hresult(g_panel.selectionBar.Opacity() == 1 && !g_panel.selectionBar.Shadow() &&
                            OwnsNativePointer(g_panel.queueAdd) && OwnsNativePointer(g_panel.cancelSelection) ? S_OK : E_FAIL);
                        ApplyRowTheme(false);
                        for (auto &row : g_panel.rows) row.pointerOver = true;
                        ApplyRowTheme();
                        winrt::check_hresult(g_panel.selectionBar.Shadow() && OwnsNativePointer(g_panel.queueAdd) &&
                            OwnsNativePointer(g_panel.cancelSelection) ? S_OK : E_FAIL);
                        for (auto &row : g_panel.rows) row.pointerOver = false;
                        ApplyRowTheme();
                        ShowFeedback(L"Synthetic closable feedback", true);
                        g_panel.root.UpdateLayout();
                        co_await NextNativeFrame(); co_await NextNativeFrame();
                        const auto close = FindHistoryChild<Button>(g_panel.feedback);
                        winrt::check_hresult(close && close.IsEnabled() && OwnsNativePointer(close) ? S_OK : E_FAIL);
                        DismissFeedback();
                        g_panel.history.SelectedItems().Clear();
                    }
                }
                SetQueueViewActive(false);
                g_panel.root.Width(originalWidth);
                WindowProc(g_panel.window, kSetLanguage, originalLanguage, 0);
                currentStage = 116;
                winrt::check_hresult(g_panel.addTag.Flyout().Placement() == Controls::Primitives::FlyoutPlacementMode::TopEdgeAlignedLeft &&
                    !g_panel.addTag.Flyout().ShouldConstrainToRootBounds() &&
                    g_panel.addTag.Flyout().as<MenuFlyout>().Items().Size() == 2 &&
                    g_panel.header.ColumnDefinitions().Size() == 3 ? S_OK : E_FAIL);
                winrt::check_hresult(g_panel.root.Children().GetAt(0).as<Grid>().BorderThickness().Bottom == 1 ? S_OK : E_FAIL);
                co_await NextNativeFrame();
                for (const FrameworkElement &button : {FrameworkElement{g_panel.searchButton}, FrameworkElement{g_panel.addTag},
                         FrameworkElement{g_panel.queueOpen}, FrameworkElement{g_panel.settings}})
                    winrt::check_hresult(OwnsNativePointer(button) ? S_OK : E_FAIL);
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
                            metadata.Insert(L"media", winrt::Windows::Data::Json::JsonObject::Parse(LR"({"width":1024,"height":1024})"));
                        }
                        if (index == 0) {
                            metadata.Insert(L"isRichText", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(true));
                            metadata.Insert(L"rich", winrt::Windows::Data::Json::JsonObject::Parse(LR"({"darkCanvas":false,"blocks":[{"runs":[{"text":"会议备忘 / Meeting notes\n","bold":true,"size":16},{"text":"确认原生界面布局\n","foreground":{"r":22,"g":135,"b":191}},{"text":"同步交互与键盘操作\n","backgroundColor":{"r":255,"g":238,"b":160}}],"rows":[]},{"runs":[],"rows":[[[{"text":"页面 / View","bold":true}],[{"text":"状态 / Status","bold":true}]],[[{"text":"主面板"}],[{"text":"开发中"}]]]}]})"));
                        } else if (visual.itemType == L"Link") {
                            metadata.Insert(L"displayTitle", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Fluent Design guidelines"));
                            metadata.Insert(L"displaySubtitle", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"https://fluent2.microsoft.design"));
                            if (GetFileAttributesW(imagePath.c_str()) != INVALID_FILE_ATTRIBUTES) {
                                metadata.Insert(L"assetPath", winrt::Windows::Data::Json::JsonValue::CreateStringValue(imagePath));
                                metadata.Insert(L"imageKind", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"icon"));
                            }
                        } else if (visual.itemType == L"File") {
                            metadata.Insert(L"fileCount", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(3));
                            metadata.Insert(L"displaySubtitle", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Design specification.pdf\nRelease notes.md\nREADME.md"));
                            metadata.Insert(L"filePresentation", winrt::Windows::Data::Json::JsonArray::Parse(
                                winrt::to_hstring(fileFixtures)).GetObjectAt(6));
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
                    co_await CaptureNativeView(g_panel.root, folder, winrt::hstring{L"history-ready"} + suffix);
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
                    // Newer than the revision 108 mutation/scroll fixtures above.
                    sampleQueue.SetNamedValue(L"revision", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(english ? 1010 : 1000));
                    g_panel.queueView->SetState(sampleQueue);
                    winrt::check_hresult(queueRoot.as<Grid>().Children().GetAt(1).as<ScrollViewer>()
                        .Content().as<StackPanel>().Children().Size() == 3 ? S_OK : E_FAIL);
                    co_await CaptureNativeView(queueRoot, folder, winrt::hstring{L"queue"} + suffix);
                    sampleQueue.SetNamedValue(L"revision", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(english ? 1011 : 1001));
                    sampleQueue.SetNamedValue(L"error", winrt::Windows::Data::Json::JsonObject::Parse(english
                        ? LR"({"hash":"q1","message":"Target window is unavailable"})"
                        : LR"({"hash":"q1","message":"目标窗口暂不可用"})"));
                    g_panel.queueView->SetState(sampleQueue);
                    co_await CaptureNativeView(queueRoot, folder, winrt::hstring{L"queue-error-recovery"} + suffix);
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
                    const auto filterForm = filterRoot.as<Grid>().Children().GetAt(1).as<ScrollViewer>().Content().as<StackPanel>();
                    const auto criteria = filterForm.Children().GetAt(1).as<Border>().Child().as<StackPanel>();
                    const auto sourceButton = criteria.Children().GetAt(criteria.Children().Size() - 1).as<DropDownButton>();
                    const auto sourceFlyout = sourceButton.Flyout().as<Flyout>();
                    sourceFlyout.ShowAt(sourceButton);
                    co_await NextNativeFrame(); co_await NextNativeFrame();
                    co_await CaptureNativeView(sourceFlyout.Content().as<FrameworkElement>(), folder,
                        winrt::hstring{L"filter-source-picker"} + suffix);
                    sourceFlyout.Hide(); co_await NextNativeFrame();
                    const auto recordEditor = g_panel.recordTagEditor->TestLoad(9, english ? L"📌 Work" : L"📌 工作", L"", english).as<StackPanel>();
                    g_panel.recordTagEditor->SetTheme(english ? ElementTheme::Dark : ElementTheme::Light);
                    Border recordHost; recordHost.Padding(vpaste::winui::UniformThickness(12));
                    recordHost.RequestedTheme(english ? ElementTheme::Dark : ElementTheme::Light);
                    recordHost.Background(vpaste::winui::WindowCanvasBackground()); recordHost.Child(recordEditor);
                    g_panel.xamlSource.Content(recordHost); ResizeIsland();
                    co_await CaptureNativeView(recordHost, folder, winrt::hstring{L"record-tag-editor"} + suffix);
                    recordHost.Child(nullptr);
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
                    vpaste::winui::Reader sampleReader([](auto const &, auto, auto const &) { return 0u; });
                    sampleReader.SetAppearance(english, english ? ElementTheme::Dark : ElementTheme::Light);
                    auto readerSample = winrt::Windows::Data::Json::JsonObject::Parse(LR"({"op":"nativeReader","data":{
                        "generation":1,"kind":"text","text":"会议备忘 / Meeting notes\n\n确认原生界面布局\n整理本周设计参考\n同步交互与键盘操作\n\nA native reader that stays open while you browse.",
                        "rect":{"x":100,"y":100,"width":600,"height":360},"durationMs":0,"easing":[0.22,1,0.36,1]}})");
                    sampleReader.Receive(readerSample);
                    co_await CaptureNativeView(sampleReader.TestRoot(), folder, winrt::hstring{L"native-reader"} + suffix);
                    auto readerData = readerSample.GetNamedObject(L"data");
                    readerData.SetNamedValue(L"generation", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(2));
                    readerData.SetNamedValue(L"kind", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"files"));
                    readerData.SetNamedValue(L"caption", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Design specification.pdf"));
                    readerData.SetNamedValue(L"count", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(3));
                    readerData.SetNamedValue(L"batch", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(true));
                    auto readerFile = winrt::Windows::Data::Json::JsonArray::Parse(winrt::to_hstring(fileFixtures)).GetObjectAt(6);
                    readerFile.SetNamedValue(L"path", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"C:/Design specification.pdf"));
                    readerFile.SetNamedValue(L"label", winrt::Windows::Data::Json::JsonValue::CreateStringValue(english ? L"3 files" : L"3 个文件"));
                    readerData.SetNamedValue(L"file", readerFile);
                    sampleReader.Receive(readerSample);
                    co_await CaptureNativeView(sampleReader.TestRoot(), folder, winrt::hstring{L"native-reader-files"} + suffix);
                    const auto readerImage = std::wstring{folder.Path()} + L"\\sample preview #100%.png";
                    if (GetFileAttributesW(readerImage.c_str()) != INVALID_FILE_ATTRIBUTES) {
                        readerData.SetNamedValue(L"generation", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(3));
                        readerData.SetNamedValue(L"kind", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"image"));
                        readerData.SetNamedValue(L"imagePath", winrt::Windows::Data::Json::JsonValue::CreateStringValue(readerImage));
                        readerData.SetNamedValue(L"caption", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"Transparent image.png"));
                        sampleReader.Receive(readerSample);
                        for (int frame = 0; frame < 8; ++frame) co_await NextNativeFrame();
                        co_await CaptureNativeView(sampleReader.TestRoot(), folder, winrt::hstring{L"native-reader-image"} + suffix);
                    }
                    SetTagManagerActive(false);
                }
                WindowProc(g_panel.window, kSetLanguage, originalEnglish, 0);
                WindowProc(g_panel.window, kSetTheme, 0, 0);
                ConfigureAcrylicBackdrop(true);
                ApplyActiveLayout();
            }
            std::fprintf(stderr, "WinUI history: reader controls\n");
            co_await vpaste::winui::TestReaderControls(currentStage);
            std::fprintf(stderr, "WinUI history: reader complete\n");
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
                    vpaste::winui::CachedMotionTiming().durationFast == 0.18 &&
                    vpaste::winui::CachedMotionTiming().durationSlow == 0.32 &&
                    vpaste::winui::CachedMotionTiming().staggerTight == 0.018 &&
                    vpaste::winui::FadeFeedback(target, true) ? S_OK : E_FAIL);
                winrt::check_hresult(!vpaste::winui::FadeFeedback(target, false) &&
                    target.Opacity() == 1 && !target.Resources().HasKey(winrt::box_value(vpaste::winui::FeedbackAnimationResource)) ? S_OK : E_FAIL);
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
                    radius.TopLeft == kCardRadius && outline.CornerRadius().TopLeft == kCardRadius + 4 &&
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
            currentStage = 132;
            {
                using namespace winrt::Windows::Data::Json;
                SetQueueViewActive(false);
                if (g_queueSelectionMode) ToggleQueueSelectionMode(false);
                RequestHistory();
                auto history = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"reselected","itemType":"Text"}],"hasMore":false}})");
                history.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(history.Stringify()));
                SetQueueViewActive(true);
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                AddSelectedItemsToQueue();
                const auto submitted = g_queueSelectionAddRequest;
                invoke(g_panel.cancelSelection);
                co_await NextNativeFrame();
                winrt::check_hresult(!g_queueSelectionMode ? S_OK : E_FAIL);
                ToggleQueueSelectionMode(false);
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                winrt::check_hresult(g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
                auto added = JsonObject::Parse(LR"({"op":"queueAdd","data":{"revision":2000,"busy":false,"items":[{"hash":"reselected"}]}})");
                added.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(submitted)));
                ApplyResponse(winrt::to_string(added.Stringify()));
                std::fprintf(stderr, "WinUI canceled queue batch: selected=%zu enabled=%d\n",
                    g_queueSelectedHashes.size(), g_panel.queueAdd.IsEnabled());
                winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"reselected"} &&
                    g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
                currentStage = 133;
                AddSelectedItemsToQueue();
                const auto newSubmission = g_queueSelectionAddRequest;
                auto failure = JsonObject::Parse(LR"({"op":"queueAdd","error":"Delayed canceled batch"})");
                failure.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(submitted)));
                ApplyResponse(winrt::to_string(failure.Stringify()));
                winrt::check_hresult(g_queueSelectionAdding && !g_panel.queueAdd.IsEnabled() &&
                    g_queueSelectedHashes == std::vector<std::wstring>{L"reselected"} ? S_OK : E_FAIL);
                failure.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(newSubmission)));
                ApplyResponse(winrt::to_string(failure.Stringify()));
                winrt::check_hresult(!g_queueSelectionAdding && g_panel.queueAdd.IsEnabled() &&
                    g_queueSelectedHashes == std::vector<std::wstring>{L"reselected"} ? S_OK : E_FAIL);
                currentStage = 134;
                AddSelectedItemsToQueue();
                added.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_queueSelectionAddRequest)));
                ApplyResponse(winrt::to_string(added.Stringify()));
                ApplyResponse(winrt::to_string(added.Stringify()));
                winrt::check_hresult(g_queueSelectionMode && g_queueSelectedHashes.empty() &&
                    !g_queueSelectionAdding && !g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
                currentStage = 135;
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                AddSelectedItemsToQueue();
                const auto oldDatasetRequest = g_queueSelectionAddRequest;
                ApplyResponse(R"({"op":"historyReset","data":{}})");
                winrt::check_hresult(!g_queueSelectionAdding && !g_queueSelectionAddRequest &&
                    g_queueSubmittedHashes.empty() ? S_OK : E_FAIL);
                history.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(history.Stringify()));
                g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
                added.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(oldDatasetRequest)));
                ApplyResponse(winrt::to_string(added.Stringify()));
                winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"reselected"} &&
                    g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
                SetQueueViewActive(false);
            }
            currentStage = 136;
            {
                using namespace winrt::Windows::Data::Json;
                const auto savedFilters = g_customFilters;
                g_customFilters.push_back(JsonObject::Parse(LR"({"id":"reset-confirmation","name":"Test filter"})"));
                const auto tab = L"reset-confirmation";
                const auto deletes = [&] {
                    return std::count_if(previewRequests.begin(), previewRequests.end(), [](auto const &bytes) {
                        return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"filtersDelete";
                    });
                };
                const auto before = deletes();
                (void)ConfirmDeleteTab(tab);
                winrt::check_hresult(g_panel.deletionDialog && g_deleteConfirmationOpen ? S_OK : E_FAIL);
                const auto previous = g_panel.deletionDialog;
                co_await AwaitNativeLoaded(previous);
                bool previousClosed = false;
                auto previousToken = previous.Closed(winrt::auto_revoke, [&](auto const &, auto const &) { previousClosed = true; });
                ApplyResponse(R"({"op":"historyReset","data":{}})");
                const bool retired = !g_panel.deletionDialog && !g_deleteConfirmationOpen;
                if (!retired) previous.Hide();
                for (int frame = 0; frame < 90 && (!previousClosed || g_deleteConfirmationOpen); ++frame) co_await NextNativeFrame();
                previousToken.revoke();
                std::fprintf(stderr, "WinUI dataset reset confirmation: retired=%d deletes=%zu\n", retired,
                    static_cast<std::size_t>(deletes() - before));
                winrt::check_hresult(retired && previousClosed && deletes() == before ? S_OK : E_FAIL);

                currentStage = 137;
                const auto primaryButton = [&](auto const &self, DependencyObject const &element) -> Button {
                    if (const auto button = element.try_as<Button>(); button && button.Name() == L"PrimaryButton") return button;
                    for (int index = 0; index < Media::VisualTreeHelper::GetChildrenCount(element); ++index)
                        if (const auto button = self(self, Media::VisualTreeHelper::GetChild(element, index))) return button;
                    return nullptr;
                };
                (void)ConfirmDeleteTab(tab);
                const auto closing = g_panel.deletionDialog;
                co_await AwaitNativeLoaded(closing);
                bool resetAtClose = false;
                auto closed = closing.Closed(winrt::auto_revoke, [&](auto const &, auto const &args) {
                    if (args.Result() == ContentDialogResult::Primary) {
                        resetAtClose = true;
                        ApplyResponse(R"({"op":"historyReset","data":{}})");
                    }
                });
                const auto primary = primaryButton(primaryButton, closing);
                winrt::check_hresult(primary ? S_OK : E_FAIL);
                invoke(primary);
                for (int frame = 0; frame < 90 && (!resetAtClose || g_deleteConfirmationOpen); ++frame) co_await NextNativeFrame();
                closed.revoke();
                winrt::check_hresult(resetAtClose && !g_panel.deletionDialog &&
                    !g_deleteConfirmationOpen && deletes() == before ? S_OK : E_FAIL);

                currentStage = 138;
                (void)ConfirmDeleteTab(tab);
                const auto current = g_panel.deletionDialog;
                (void)ConfirmDeleteTab(tab);
                winrt::check_hresult(current && g_panel.deletionDialog == current ? S_OK : E_FAIL);
                co_await AwaitNativeLoaded(current);
                invoke(primaryButton(primaryButton, current));
                for (int frame = 0; frame < 90 && g_deleteConfirmationOpen; ++frame) co_await NextNativeFrame();
                winrt::check_hresult(!g_deleteConfirmationOpen && deletes() == before + 1 && g_tabDeleteRequest &&
                    requestAt(previewRequests.size() - 1).GetNamedString(L"tabId") == tab ? S_OK : E_FAIL);
                JsonObject deleted;
                deleted.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_tabDeleteRequest)));
                deleted.Insert(L"op", JsonValue::CreateStringValue(L"filtersDelete"));
                ApplyResponse(winrt::to_string(deleted.Stringify()));
                g_customFilters = savedFilters;
            }
            currentStage = 139;
            {
                using namespace vpaste::winui;
                for (auto const &origin : std::array<FrameworkElement, 4>{g_panel.settings,
                         g_panel.searchButton, g_panel.rows.front().favoriteButton,
                         g_panel.rows.front().favoriteButton.Content().as<FrameworkElement>()}) {
                    const auto before = previewRequests.size();
                    MainKeyInput input{.key=VK_ESCAPE};
                    input.area = MainInputArea(origin); input.blocked = NativeControlOwnsKeys(origin);
                    winrt::check_hresult(input.area == InputArea::Other && HandleMainKey(input) &&
                        previewRequests.size() == before + 1 &&
                        requestAt(before).GetNamedString(L"op") == L"dismiss" ? S_OK : E_FAIL);
                }
                const auto before = previewRequests.size();
                winrt::check_hresult(HandleMainKey({.key=VK_ESCAPE, .repeated=true, .area=InputArea::Other}) ? S_OK : E_FAIL);
                for (auto key : {VK_SPACE, VK_RETURN})
                    winrt::check_hresult(!HandleMainKey({.key=static_cast<std::uint32_t>(key), .area=InputArea::Other}) ? S_OK : E_FAIL);
                for (auto input : {MainKeyInput{.key=VK_ESCAPE, .control=true, .area=InputArea::Other},
                         MainKeyInput{.key=VK_ESCAPE, .shift=true, .area=InputArea::Other},
                         MainKeyInput{.key=VK_ESCAPE, .alt=true, .area=InputArea::Other},
                         MainKeyInput{.key=VK_ESCAPE, .meta=true, .area=InputArea::Other},
                         MainKeyInput{.key=VK_ESCAPE, .composing=true, .area=InputArea::Other},
                         MainKeyInput{.key=VK_ESCAPE, .blocked=true, .area=InputArea::Other}})
                    winrt::check_hresult(!HandleMainKey(input) ? S_OK : E_FAIL);
                winrt::check_hresult(previewRequests.size() == before &&
                    NativeControlOwnsKeys(g_panel.rows.front().menu.pastePlain) ? S_OK : E_FAIL);
            }
            currentStage = 140;
            bool searchEscapeParity = true;
            {
                using namespace vpaste::winui;
                for (const auto area : {InputArea::History, InputArea::Other}) {
                    g_panel.search.Visibility(Visibility::Visible); SetSearchText(L"lookup");
                    g_searchTimer.Stop();
                    const auto before = previewRequests.size();
                    // PreviewKeyDown supplies the synchronized query state.
                    for (auto input : {MainKeyInput{.key=VK_ESCAPE, .control=true},
                             MainKeyInput{.key=VK_ESCAPE, .shift=true}, MainKeyInput{.key=VK_ESCAPE, .alt=true},
                             MainKeyInput{.key=VK_ESCAPE, .meta=true}, MainKeyInput{.key=VK_ESCAPE, .blocked=true},
                             MainKeyInput{.key=VK_ESCAPE, .composing=true}}) {
                        input.area = area; input.searchHasText = true;
                        winrt::check_hresult(!HandleMainKey(input) && SearchText() == L"lookup" &&
                            g_panel.search.Visibility() == Visibility::Visible && previewRequests.size() == before ? S_OK : E_FAIL);
                    }
                    searchEscapeParity = HandleMainKey({.key=VK_ESCAPE, .area=area, .searchHasText=true}) &&
                        SearchText().empty() && g_panel.search.Visibility() == Visibility::Visible &&
                        previewRequests.size() == before && searchEscapeParity;
                    // Keep the second assertion independent if the old handler
                    // did not clear search in the first assertion.
                    SetSearchText(L""); g_searchTimer.Stop();
                    searchEscapeParity = HandleMainKey({.key=VK_ESCAPE, .area=area}) &&
                        g_panel.search.Visibility() == Visibility::Collapsed &&
                        previewRequests.size() == before && searchEscapeParity;
                }
                g_panel.search.Visibility(Visibility::Collapsed);
                std::fprintf(stderr, "WinUI search Escape priority: correct=%d\n", searchEscapeParity);
            }
            currentStage = 141;
            bool recordResetSafe = false;
            {
                const auto countAssignments = [&] {
                    return std::count_if(previewRequests.begin(), previewRequests.end(), [](auto const &bytes) {
                        return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"recordTagAssign";
                    });
                };
                const auto assignments = countAssignments();
                g_panel.recordTagEditor->Show(g_panel.addTag, 0, L"Old tag", L"old-dataset", true,
                    g_panel.root.RequestedTheme(), g_panel.root, EditorFocusReturn(L"", L"old-dataset"));
                co_await AwaitNativeLoaded(g_panel.recordTagEditor->TestRoot());
                g_panel.recordTagEditor->TestSave();
                auto response = winrt::Windows::Data::Json::JsonObject::Parse(
                    LR"({"op":"recordTagCreate","data":{"tag":{"id":99,"name":"Old tag"}}})");
                response.Insert(L"id", requestAt(previewRequests.size() - 1).GetNamedValue(L"id"));
                const auto focusGeneration = g_editorGeneration;
                ApplyResponse(R"({"op":"historyReset","data":{}})");
                const bool retired = !g_panel.recordTagEditor->IsOpen() && g_editorGeneration > focusGeneration;
                ApplyResponse(winrt::to_string(response.Stringify()));
                recordResetSafe = retired && countAssignments() == assignments;
                std::fprintf(stderr, "WinUI reset tag editor: retired=%d noStaleAssignment=%d\n",
                    retired, countAssignments() == assignments);
                const auto assignmentsAfterReset = countAssignments();
                g_panel.recordTagEditor->Hide(); co_await NextNativeFrame();
                g_panel.recordTagEditor->Show(g_panel.addTag, 9, L"Fresh tag", L"", true,
                    g_panel.root.RequestedTheme(), g_panel.root);
                co_await AwaitNativeLoaded(g_panel.recordTagEditor->TestRoot());
                g_panel.recordTagEditor->TestSave();
                const auto fresh = requestAt(previewRequests.size() - 1);
                ApplyResponse(winrt::to_string(response.Stringify()));
                winrt::check_hresult(g_panel.recordTagEditor->IsOpen() &&
                    g_panel.recordTagEditor->TestName() == L"Fresh tag" && countAssignments() == assignmentsAfterReset ? S_OK : E_FAIL);
                response.Insert(L"id", fresh.GetNamedValue(L"id"));
                response.Insert(L"op", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"recordTagRename"));
                response.Insert(L"data", winrt::Windows::Data::Json::JsonObject::Parse(LR"({"tag":{"id":9,"name":"Fresh tag"}})"));
                ApplyResponse(winrt::to_string(response.Stringify()));
                winrt::check_hresult(!g_panel.recordTagEditor->IsOpen() ? S_OK : E_FAIL);
                co_await NextNativeFrame();
            }
            currentStage = 142;
            bool filterResetSafe = false;
            {
                using namespace winrt::Windows::Data::Json;
                g_panel.filterEditor->Show(g_panel.addTag,
                    JsonObject::Parse(LR"({"id":"old-filter","name":"Old filter","filter":{}})"),
                    true, g_panel.root.RequestedTheme(), g_panel.root, EditorFocusReturn(L"old-filter"));
                co_await AwaitNativeLoaded(g_panel.filterEditor->TestRoot());
                g_panel.filterEditor->TestSave();
                auto response = JsonObject::Parse(LR"({"op":"filtersSave","data":{"items":[{"id":"old-filter","name":"Old filter"}]}})");
                response.Insert(L"id", requestAt(previewRequests.size() - 1).GetNamedValue(L"id"));
                const auto focusGeneration = g_editorGeneration;
                ApplyResponse(R"({"op":"historyReset","data":{}})");
                const bool retired = !g_panel.filterEditor->IsOpen() && g_editorGeneration > focusGeneration;
                ApplyFilters(JsonArray::Parse(LR"([{"id":"replacement-filter","name":"Replacement","filter":{}}])"));
                ApplyResponse(winrt::to_string(response.Stringify()));
                filterResetSafe = retired && g_customFilters.size() == 1 &&
                    g_customFilters.front().GetNamedString(L"id") == L"replacement-filter";
                std::fprintf(stderr, "WinUI reset filter editor: retired=%d replacementKept=%d\n", retired, filterResetSafe);
                g_panel.filterEditor->Hide(); co_await NextNativeFrame();
                g_panel.filterEditor->Show(g_panel.addTag,
                    JsonObject::Parse(LR"({"id":"fresh-filter","name":"Fresh filter","filter":{}})"),
                    true, g_panel.root.RequestedTheme(), g_panel.root);
                co_await AwaitNativeLoaded(g_panel.filterEditor->TestRoot());
                g_panel.filterEditor->TestSave();
                const auto fresh = requestAt(previewRequests.size() - 1);
                ApplyResponse(winrt::to_string(response.Stringify()));
                winrt::check_hresult(g_panel.filterEditor->IsOpen() &&
                    g_panel.filterEditor->TestName() == L"Fresh filter" ? S_OK : E_FAIL);
                response.Insert(L"id", fresh.GetNamedValue(L"id"));
                response.Insert(L"data", JsonObject::Parse(LR"({"items":[{"id":"fresh-filter","name":"Fresh filter","filter":{}}]})"));
                ApplyResponse(winrt::to_string(response.Stringify()));
                winrt::check_hresult(!g_panel.filterEditor->IsOpen() && g_customFilters.size() == 1 &&
                    g_customFilters.front().GetNamedString(L"id") == L"fresh-filter" ? S_OK : E_FAIL);
                co_await NextNativeFrame();
            }
            currentStage = 143;
            winrt::check_hresult(searchEscapeParity && recordResetSafe && filterResetSafe ? S_OK : E_FAIL);
            currentStage = 144;
            bool exportResetSafe = true;
            {
                using namespace winrt::Windows::Data::Json;
                auto &exporter = *g_panel.imageExport;
                struct RestoreChooser {
                    vpaste::winui::ImageExport &exporter;
                    ~RestoreChooser() { exporter.Cancel(); exporter.SetTestChooser({}); }
                } restoreChooser{exporter};
                const auto count = [&](const wchar_t *operation) {
                    return std::count_if(previewRequests.begin(), previewRequests.end(), [&](auto const &bytes) {
                        return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == operation;
                    });
                };
                const auto prepared = [&](JsonObject const &request) {
                    auto response = JsonObject::Parse(LR"({"op":"exportPrepare","data":{"fileName":"fixture.png"}})");
                    response.Insert(L"id", request.GetNamedValue(L"id")); return response;
                };
                unsigned chooserCalls = 0;
                exporter.SetTestChooser([&](auto const &) -> std::optional<std::wstring> { ++chooserCalls; return std::nullopt; });
                exporter.Start(L"old-image"); const auto old = prepared(requestAt(previewRequests.size() - 1));
                ApplyResponse(R"({"op":"historyReset","data":{}})");
                const bool retired = !exporter.Active();
                ApplyResponse(winrt::to_string(old.Stringify()));
                exportResetSafe = retired && chooserCalls == 0;
                std::fprintf(stderr, "WinUI reset export preparation: retired=%d chooserCalls=%u\n", retired, chooserCalls);
                exporter.Cancel();
                const auto writes = count(L"exportImage"), begins = count(L"modalBegin"), ends = count(L"modalEnd");
                exporter.SetTestChooser([&](auto const &) -> std::optional<std::wstring> {
                    ApplyResponse(R"({"op":"historyReset","data":{}})"); return L"C:\\fixture-must-not-write.png";
                });
                exporter.Start(L"reset-in-chooser");
                ApplyResponse(winrt::to_string(prepared(requestAt(previewRequests.size() - 1)).Stringify()));
                const bool chooserResetSafe = !exporter.Active() && count(L"exportImage") == writes;
                exportResetSafe = chooserResetSafe && exportResetSafe;
                winrt::check_hresult(count(L"modalBegin") == begins + 1 && count(L"modalEnd") == ends + 1 ? S_OK : E_FAIL);
                std::fprintf(stderr, "WinUI reset export chooser: noStaleWrite=%d\n", chooserResetSafe);
                exporter.Cancel();
                const auto freshWrites = count(L"exportImage");
                exporter.SetTestChooser([](auto const &) -> std::optional<std::wstring> { return L"C:\\fixture-only.png"; });
                exporter.Start(L"fresh-image"); const auto fresh = prepared(requestAt(previewRequests.size() - 1));
                const auto before = previewRequests.size();
                ApplyResponse(winrt::to_string(old.Stringify()));
                winrt::check_hresult(exporter.Active() && previewRequests.size() == before ? S_OK : E_FAIL);
                ApplyResponse(winrt::to_string(fresh.Stringify()));
                const auto write = requestAt(previewRequests.size() - 1);
                winrt::check_hresult(exporter.Active() && write.GetNamedString(L"op") == L"exportImage" &&
                    write.GetNamedString(L"hash") == L"fresh-image" && count(L"exportImage") == freshWrites + 1 ? S_OK : E_FAIL);
                auto result = JsonObject::Parse(LR"({"op":"exportImage","error":"Synthetic export failure"})");
                result.Insert(L"id", write.GetNamedValue(L"id")); ApplyResponse(winrt::to_string(result.Stringify()));
                winrt::check_hresult(!exporter.Active() ? S_OK : E_FAIL);
                exporter.Start(L"retry-image");
                ApplyResponse(winrt::to_string(prepared(requestAt(previewRequests.size() - 1)).Stringify()));
                result.Remove(L"error"); result.Insert(L"data", JsonObject{});
                result.Insert(L"id", requestAt(previewRequests.size() - 1).GetNamedValue(L"id"));
                ApplyResponse(winrt::to_string(result.Stringify()));
                winrt::check_hresult(!exporter.Active() && count(L"exportImage") == freshWrites + 2 ? S_OK : E_FAIL);
                DismissFeedback();
            }
            currentStage = 145;
            bool menusResetSafe = true;
            {
                using namespace winrt::Windows::Data::Json;
                auto response = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"menu-reset","itemType":"Text"}],"hasMore":false}})");
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(++g_requestId)));
                ApplyResponse(winrt::to_string(response.Stringify())); co_await NextNativeFrame();
                g_tagIds = {10}; g_tagNames = {L"Menu reset tag"}; RebuildTagFilter();
                for (const auto &origin : std::array<FrameworkElement, 3>{g_panel.rows.front().surface,
                         DynamicTab(L"record:10"), DynamicTab(L"fresh-filter")}) {
                    co_await AwaitNativeLoaded(origin);
                    const auto menu = origin == g_panel.rows.front().surface
                        ? Controls::Primitives::FlyoutBase{EnsureCardContextMenu(g_panel.rows.front(), g_hashes.front())}
                        : origin.ContextFlyout();
                    menu.ShowAt(origin); co_await NextNativeFrame();
                    winrt::check_hresult(menu.IsOpen() ? S_OK : E_FAIL);
                    ApplyResponse(R"({"op":"historyReset","data":{}})");
                    co_await NextNativeFrame();
                    menusResetSafe = !menu.IsOpen() && menusResetSafe;
                    std::fprintf(stderr, "WinUI reset context menu: origin=%ls closed=%d\n",
                        winrt::get_class_name(origin).c_str(), !menu.IsOpen());
                    co_await CloseNativeFlyout(menu);
                }
                // Replacement data still owns a functional native card menu.
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(response.Stringify())); co_await NextNativeFrame();
                const auto menu = EnsureCardContextMenu(g_panel.rows.front(), g_hashes.front());
                menu.ShowAt(g_panel.rows.front().surface); co_await NextNativeFrame();
                const auto before = previewRequests.size();
                Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(menu.Items().GetAt(menu.Items().Size() - 1))
                    .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                co_await NextNativeFrame();
                winrt::check_hresult(previewRequests.size() == before + 1 && requestAt(before).GetNamedString(L"op") == L"paste" &&
                    requestAt(before).GetNamedString(L"hash") == L"menu-reset" ? S_OK : E_FAIL);
                co_await CloseNativeFlyout(menu);
            }
            currentStage = 146;
            bool searchShowParity = true;
            {
                const auto previous = g_behavior;
                for (const bool retain : {false, true}) {
                    g_behavior.retainSearch = retain;
                    g_panel.search.Visibility(Visibility::Visible); SetSearchText(L"reopen query");
                    SetVisible(false, true, false); SetVisible(true, true, false);
                    searchShowParity = g_panel.search.Visibility() == (retain ? Visibility::Visible : Visibility::Collapsed) &&
                        SearchText() == (retain ? L"reopen query" : L"") && searchShowParity;
                }
                SetSearchText(L""); g_panel.search.Visibility(Visibility::Collapsed);
                SetVisible(false, true, false); SetVisible(true, true, false);
                winrt::check_hresult(g_panel.search.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
                g_behavior.retainSearch = false;
                SetVisible(false, true, false);
                g_panel.search.Visibility(Visibility::Visible); SetSearchText(L"same editing session");
                SetVisible(true, false, false);
                winrt::check_hresult(g_panel.search.Visibility() == Visibility::Visible &&
                    SearchText() == L"same editing session" ? S_OK : E_FAIL);
                g_behavior = previous; SetSearchText(L""); g_searchTimer.Stop();
                g_panel.search.Visibility(Visibility::Collapsed);
                std::fprintf(stderr, "WinUI fresh-show search retention: correct=%d\n", searchShowParity);
            }
            currentStage = 147;
            winrt::check_hresult(exportResetSafe && menusResetSafe && searchShowParity ? S_OK : E_FAIL);
            currentStage = 148;
            bool deferredSearchSafe = true;
            {
                using namespace winrt::Windows::Data::Json;
                const auto pastes = [&] {
                    return std::count_if(previewRequests.begin(), previewRequests.end(), [](auto const &bytes) {
                        const auto op = JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op");
                        return op == L"paste" || op == L"pastePlain" || op == L"quickPaste";
                    });
                };
                const auto submit = [&](bool plain = false, bool quick = false) {
                    g_panel.search.Visibility(Visibility::Visible); SetSearchText(L"deferred query");
                    g_searchTimer.Stop(); RequestHistory(); SubmitSearch(plain, 0, quick);
                    winrt::check_hresult(g_searchSubmitRequestId == g_latestQueryId && g_searchSubmitRequestId ? S_OK : E_FAIL);
                    return g_latestQueryId;
                };
                const auto result = [&](std::uint64_t id) {
                    auto response = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"deferred-result","itemType":"Text"}],"hasMore":false}})");
                    response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
                    ApplyResponse(winrt::to_string(response.Stringify()));
                };
                ApplyResponse(R"({"op":"updateStateChanged","data":{"revision":1000000,"status":"ready","portable":false,"source":"direct","availableVersion":"99.0.0-test"}})");
                co_await NextNativeFrame();
                for (int overlay = 0; overlay < 3; ++overlay) {
                    const auto before = pastes();
                    const auto pending = submit(overlay == 1, overlay == 2);
                    if (overlay == 0) {
                        ShowFilterEditor(JsonObject{});
                        co_await AwaitNativeLoaded(g_panel.filterEditor->TestRoot());
                    } else if (overlay == 1) {
                        (void)ConfirmDeleteTab(L"fresh-filter");
                        co_await AwaitNativeLoaded(g_panel.deletionDialog);
                    } else {
                        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(g_panel.appActions->UpdateButton())
                            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
                        co_await AwaitNativeLoaded(g_panel.appActions->TestDialog());
                    }
                    const bool retired = g_searchSubmitRequestId == 0;
                    if (overlay == 0) g_panel.filterEditor->Hide();
                    else if (overlay == 1) g_panel.deletionDialog.Hide();
                    else g_panel.appActions->Deactivate();
                    for (int frame = 0; frame < 90 && (NativeEditorOpen() || g_deleteConfirmationOpen); ++frame)
                        co_await NextNativeFrame();
                    winrt::check_hresult(!NativeEditorOpen() && !g_deleteConfirmationOpen ? S_OK : E_FAIL);
                    result(pending);
                    const bool noPaste = pastes() == before;
                    deferredSearchSafe = retired && noPaste && deferredSearchSafe;
                    std::fprintf(stderr, "WinUI canceled overlay search: kind=%d retired=%d noLatePaste=%d\n", overlay, retired, noPaste);
                    const auto afterCancel = pastes();
                    const auto beforeFresh = previewRequests.size();
                    const auto fresh = submit(overlay == 1, overlay == 2); result(fresh); result(fresh);
                    const auto paste = requestAfter(overlay == 1 ? L"pastePlain" : overlay == 2 ? L"quickPaste" : L"paste", beforeFresh);
                    winrt::check_hresult(pastes() == afterCancel + 1 && !g_searchSubmitRequestId &&
                        paste.GetNamedString(L"hash") == L"deferred-result" ? S_OK : E_FAIL);
                }
                for (int kind = 0; kind < 4; ++kind) {
                    const auto before = pastes();
                    const auto pending = submit();
                    const FrameworkElement origin = kind == 0 ? FrameworkElement{g_panel.rows.front().surface} :
                        kind == 1 ? FrameworkElement{DynamicTab(L"record:10")} :
                        kind == 2 ? FrameworkElement{DynamicTab(L"fresh-filter")} : FrameworkElement{g_panel.addTag};
                    co_await AwaitNativeLoaded(origin);
                    const auto menu = kind == 3 ? g_panel.addTag.Flyout()
                        : kind == 0 ? Controls::Primitives::FlyoutBase{EnsureCardContextMenu(g_panel.rows.front(), g_hashes.front())}
                        : origin.ContextFlyout();
                    menu.ShowAt(origin); co_await NextNativeFrame();
                    winrt::check_hresult(menu.IsOpen() ? S_OK : E_FAIL);
                    const bool retired = g_searchSubmitRequestId == 0;
                    co_await CloseNativeFlyout(menu);
                    result(pending);
                    const bool noPaste = pastes() == before;
                    deferredSearchSafe = retired && noPaste && deferredSearchSafe;
                    std::fprintf(stderr, "WinUI canceled menu search: kind=%d retired=%d noLatePaste=%d\n", kind, retired, noPaste);
                    const auto fresh = submit(); result(fresh); result(fresh);
                    winrt::check_hresult(pastes() == before + 1 && !g_searchSubmitRequestId ? S_OK : E_FAIL);
                }
                SetSearchText(L""); g_searchTimer.Stop(); g_panel.search.Visibility(Visibility::Collapsed);
            }
            currentStage = 149;
            bool hiddenMenusSafe = true;
            {
                const auto card = g_panel.rows.front().surface;
                for (const auto &origin : std::array<FrameworkElement, 4>{card, DynamicTab(L"record:10"),
                         DynamicTab(L"fresh-filter"), g_panel.addTag}) {
                    co_await AwaitNativeLoaded(origin);
                    const auto menu = origin == g_panel.addTag ? g_panel.addTag.Flyout()
                        : origin == card ? Controls::Primitives::FlyoutBase{EnsureCardContextMenu(g_panel.rows.front(), g_hashes.front())}
                        : origin.ContextFlyout();
                    menu.ShowAt(origin); co_await NextNativeFrame();
                    winrt::check_hresult(menu.IsOpen() ? S_OK : E_FAIL);
                    SetVisible(false, true, false); SetVisible(true, false, false);
                    co_await NextNativeFrame();
                    hiddenMenusSafe = !menu.IsOpen() && hiddenMenusSafe;
                    std::fprintf(stderr, "WinUI hidden panel menu: origin=%ls closed=%d\n",
                        winrt::get_class_name(origin).c_str(), !menu.IsOpen());
                    co_await CloseNativeFlyout(menu);
                }
            }
            currentStage = 150;
            bool hiddenDeleteSafe = false;
            {
                const auto deletes = [&] {
                    return std::count_if(previewRequests.begin(), previewRequests.end(), [](auto const &bytes) {
                        return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"filtersDelete";
                    });
                };
                const auto before = deletes();
                (void)ConfirmDeleteTab(L"fresh-filter");
                const auto dialog = g_panel.deletionDialog;
                co_await AwaitNativeLoaded(dialog);
                SetVisible(false, true, false); SetVisible(true, false, false);
                for (int frame = 0; frame < 30 && g_deleteConfirmationOpen; ++frame) co_await NextNativeFrame();
                hiddenDeleteSafe = !g_deleteConfirmationOpen && !g_panel.deletionDialog;
                std::fprintf(stderr, "WinUI hidden panel confirmation: closed=%d\n", hiddenDeleteSafe);
                dialog.Hide();
                for (int frame = 0; frame < 90 && g_deleteConfirmationOpen; ++frame) co_await NextNativeFrame();
                winrt::check_hresult(!g_deleteConfirmationOpen && deletes() == before ? S_OK : E_FAIL);
                (void)ConfirmDeleteTab(L"fresh-filter");
                winrt::check_hresult(g_deleteConfirmationOpen && g_panel.deletionDialog != dialog ? S_OK : E_FAIL);
                co_await AwaitNativeLoaded(g_panel.deletionDialog);
                g_panel.deletionDialog.Hide();
                for (int frame = 0; frame < 90 && g_deleteConfirmationOpen; ++frame) co_await NextNativeFrame();
                winrt::check_hresult(!g_deleteConfirmationOpen && deletes() == before ? S_OK : E_FAIL);
            }
            currentStage = 151;
            winrt::check_hresult(deferredSearchSafe && hiddenMenusSafe && hiddenDeleteSafe ? S_OK : E_FAIL);
            currentStage = 152;
            SetSearchText(L""); if (g_searchTimer) g_searchTimer.Stop();
            SelectBuiltinCategory(0, false); g_historyView.resetOnShow = false;
            const auto steady = winrt::Windows::Data::Json::JsonObject::Parse(
                LR"({"op":"query","data":{"items":[{"hash":"steady-surface","itemType":"Text","previewText":"Keep my realized card"}],"hasMore":false}})");
            const auto refreshSteady = [&] {
                RequestHistory();
                steady.Insert(L"id", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(static_cast<double>(g_latestQueryId)));
                ApplyResponse(winrt::to_string(steady.Stringify()));
            };
            refreshSteady(); co_await NextNativeFrame(); co_await NextNativeFrame();
            const auto steadyCard = g_panel.history.Items().GetAt(0);
            g_panel.rows.front().time.Text(L"Stale relative time");
            g_panel.history.SelectedIndex(-1); g_selectedHash.clear();
            g_panel.rows.front().outline.Visibility(Visibility::Collapsed);
            g_historyView.resetOnShow = true;
            steady.GetNamedObject(L"data").Insert(L"hasMore", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(true));
            steady.GetNamedObject(L"data").Insert(L"nextId", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(12));
            refreshSteady();
            winrt::check_hresult(g_panel.history.Items().GetAt(0) == steadyCard &&
                g_panel.rows.front().time.Text() != L"Stale relative time" &&
                g_hasMore && g_nextId == 12 && g_panel.more.IsEnabled() &&
                g_panel.history.SelectedIndex() == 0 && g_selectedHash == L"steady-surface" &&
                (vpaste::winui::HighContrastEnabled() || g_panel.rows.front().outline.Visibility() == Visibility::Visible) ? S_OK : E_FAIL);
            co_await NextNativeFrame();
            currentStage = 153;
            winrt::check_hresult(g_panel.history.ItemContainerTransitions().Size() == 0 &&
                g_panel.loading.Visibility() == Visibility::Collapsed && g_panel.history.Opacity() == 1 ? S_OK : E_FAIL);
            const auto frame = steadyCard.as<FrameworkElement>();
            winrt::check_hresult(vpaste::winui::AnimateResultItem(frame, 13, true) ? S_OK : E_FAIL);
            const auto animation = frame.Resources().Lookup(winrt::box_value(L"VPaste.ResultAnimation"))
                .as<winrt::Microsoft::UI::Composition::Vector3KeyFrameAnimation>();
            winrt::check_hresult(animation.DelayTime() == std::chrono::milliseconds(18) &&
                animation.Duration() == std::chrono::milliseconds(320) ? S_OK : E_FAIL);
            winrt::check_hresult(!vpaste::winui::AnimateResultItem(frame, 13, false) &&
                frame.Translation().x == 0 && !frame.Resources().HasKey(winrt::box_value(L"VPaste.ResultAnimation")) ? S_OK : E_FAIL);
            completion->set_value({S_OK, currentStage});
        } catch (...) {
            completion->set_value({winrt::to_hresult(), currentStage});
        }
}

winrt::Windows::Foundation::IAsyncAction BenchmarkCategorySwitches() {
    using namespace winrt::Windows::Data::Json;
    JsonArray all, subset;
    for (int index = 0; index < 36; ++index) {
        JsonObject item; item.Insert(L"hash", JsonValue::CreateStringValue(L"category-benchmark-" + std::to_wstring(index)));
        item.Insert(L"previewText", JsonValue::CreateStringValue(L"Category benchmark clipboard text"));
        item.Insert(L"itemType", JsonValue::CreateStringValue(L"Text")); all.Append(item);
        if (index % 3 == 0) subset.Append(item);
    }
    const auto response = [&](JsonArray items) {
        JsonObject data; data.Insert(L"items", items);
        JsonObject result; result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
        result.Insert(L"op", JsonValue::CreateStringValue(L"query")); result.Insert(L"data", data);
        return winrt::to_string(result.Stringify());
    };
    using Clock = std::chrono::steady_clock;
    const auto ms = [](auto start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); };
    SelectBuiltinCategory(0); ApplyResponse(response(all)); co_await NextNativeFrame();
    for (int cycle = 0; cycle < 6; ++cycle) {
        const auto selected = cycle % 2 == 0 ? 1 : 0;
        const auto start = Clock::now(); SelectBuiltinCategory(selected);
        const auto dispatch = ms(start);
        co_await NextNativeFrame(); const auto feedback = ms(start);
        const auto firstFrame = g_panel.rows.front().frame;
        const auto apply = Clock::now(); ApplyResponse(response(selected ? subset : all));
        const auto build = ms(apply);
        winrt::check_hresult(g_panel.rows.front().frame == firstFrame &&
            g_panel.rows.size() == (selected ? 12 : 36) ? S_OK : E_FAIL);
        for (std::size_t index = 0; index < g_panel.rows.size(); ++index)
            winrt::check_hresult(g_panel.rows[index].shortcutHint.Child().as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>().Text() ==
                L"Alt+" + std::to_wstring(index + 1) ? S_OK : E_FAIL);
        co_await NextNativeFrame();
        std::fprintf(stderr, "WinUI category benchmark: cycle=%d dispatchMs=%.2f feedbackFrameMs=%.2f applyMs=%.2f resultFrameMs=%.2f\n",
            cycle, dispatch, feedback, build, ms(apply));
    }
}

// Loaded-control checks also run on an isolated desktop that does not deliver
// compositor frames. Keep the full animation/focus suite on its existing path.
winrt::Windows::Foundation::IAsyncAction CheckDesktopFollowup(std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    co_await AwaitNativeLoaded(g_panel.root);
    const auto bounds = [](FrameworkElement child, UIElement parent) {
        return child.TransformToVisual(parent).TransformBounds(
            {0, 0, static_cast<float>(child.ActualWidth()), static_cast<float>(child.ActualHeight())});
    };
    const auto withinDip = [](double actual, double expected) { return std::abs(actual - expected) <= 1.0; };
    const auto layout = [] {
        const auto width = static_cast<float>(g_panel.root.Width());
        const auto height = static_cast<float>(g_panel.root.Height());
        g_panel.root.Measure({width, height});
        g_panel.root.Arrange({0, 0, width, height});
        g_panel.root.UpdateLayout();
    };
    stage = 261;
    ApplyBehavior(R"({"quickInput":true})");
    layout();
    for (std::uint32_t index = 0; index < 2; ++index) {
        const auto tab = g_panel.filter.Items().GetAt(index);
        co_await AwaitNativeLoaded(tab);
        PrepareTabTemplate(tab);
    }
    for (bool english : {false, true}) {
        WindowProc(g_panel.window, kSetLanguage, english, 0);
        ShowAltHints(false); layout();
        const auto firstWidth = g_panel.filter.Items().GetAt(0).ActualWidth();
        const auto secondWidth = g_panel.filter.Items().GetAt(1).ActualWidth();
        ShowAltHints(true); layout();
        for (std::uint32_t index = 0; index < 2; ++index) {
            const auto tab = g_panel.filter.Items().GetAt(index);
            const auto templateRoot = Media::VisualTreeHelper::GetChild(tab, 0).as<Grid>();
            bool found = false;
            for (auto const &child : templateRoot.Children()) {
                if (Automation::AutomationProperties::GetAutomationId(child) != L"category-shortcut-hint") continue;
                const auto hint = child.as<Border>();
                const auto badge = bounds(hint, tab);
                const auto label = bounds(templateRoot.FindName(L"PART_TextVisual").as<TextBlock>(), tab);
                std::fprintf(stderr, "WinUI Alt badge: en=%d tab=%u inset=%.1f rect=%.1fx%.1f labelRight=%.1f badgeX=%.1f\n",
                    english, index, tab.ActualWidth() - badge.X - badge.Width, badge.Width, badge.Height, label.X + label.Width, badge.X);
                winrt::check_hresult(hint.Visibility() == Visibility::Visible && !hint.IsHitTestVisible() &&
                    withinDip(tab.ActualWidth(), index == 0 ? firstWidth : secondWidth) && withinDip(badge.Width, 14) && withinDip(badge.Height, 14) &&
                    withinDip(badge.Y + badge.Height / 2, tab.ActualHeight() / 2) && withinDip(tab.ActualWidth() - badge.X - badge.Width, 5) &&
                    label.X + label.Width <= badge.X + 1.0 ? S_OK : E_FAIL);
                found = true;
                break;
            }
            winrt::check_hresult(found ? S_OK : E_FAIL);
        }
        ShowAltHints(false);
    }
    stage = 262;
    layout();
    const auto queue = bounds(g_panel.queueOpen, g_panel.header);
    const auto settings = bounds(g_panel.settings, g_panel.header);
    std::fprintf(stderr, "WinUI toolbar: settings inset=%.1f gap=%.1f\n",
        g_panel.header.ActualWidth() - settings.X - settings.Width, settings.X - queue.X - queue.Width);
    winrt::check_hresult(withinDip(g_panel.header.ActualWidth() - settings.X - settings.Width, 28) &&
        withinDip(settings.X - queue.X - queue.Width, 8) ? S_OK : E_FAIL);
    for (const auto button : {g_panel.queueOpen, g_panel.settings, g_panel.appActions->ToolsButton()}) {
        if (button.Visibility() != Visibility::Visible) continue;
        const auto icon = bounds(button.Content().as<PathIcon>(), button);
        std::fprintf(stderr, "WinUI toolbar hit target: %.1fx%.1f icon=(%.1f,%.1f) %.1fx%.1f\n",
            button.ActualWidth(), button.ActualHeight(), icon.X, icon.Y, icon.Width, icon.Height);
        winrt::check_hresult(withinDip(button.ActualWidth(), 28) && withinDip(button.ActualHeight(), 28) &&
            withinDip(icon.Width, 16) && withinDip(icon.Height, 16) && withinDip(icon.X, 6) && withinDip(icon.Y, 6) ? S_OK : E_FAIL);
    }
    if (!vpaste::winui::HighContrastEnabled()) {
        const auto originalTheme = g_panel.root.RequestedTheme();
        for (const auto theme : {ElementTheme::Light, ElementTheme::Dark}) {
            g_panel.root.RequestedTheme(theme);
            co_await NextNativeFrame();
            const bool dark = theme == ElementTheme::Dark;
            const auto ink = g_panel.settings.Foreground().as<Media::SolidColorBrush>().Color();
            const auto edge = g_panel.settings.BorderBrush().as<Media::SolidColorBrush>().Color();
            const auto expectedInk = dark ? winrt::Windows::UI::Color{255, 228, 233, 241}
                                          : winrt::Windows::UI::Color{217, 32, 38, 36};
            winrt::check_hresult(ink == expectedInk && edge.A == (dark ? 0x26 : 0x24) ? S_OK : E_FAIL);
        }
        g_panel.root.RequestedTheme(originalTheme);
    }
    stage = 263;
    ShowSearch();
    const auto editor = g_panel.search;
    editor.Text(L"d"); RequestHistory();
    const auto earlier = g_latestHistoryRequestId;
    editor.Text(L"dd"); editor.Text(L"ddd"); RequestHistory();
    auto stale = JsonObject::Parse(LR"({"op":"query","data":{"items":[]}})");
    stale.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(earlier)));
    ApplyResponse(winrt::to_string(stale.Stringify()));
    winrt::check_hresult(editor.Text() == L"ddd" && SearchText() == L"ddd" ? S_OK : E_FAIL);
    editor.Text(L"");
    winrt::check_hresult(SearchText().empty() && g_searchTimer.Interval() == std::chrono::milliseconds(40) ? S_OK : E_FAIL);
    g_searchTimer.Stop();
    stage = 264;
    struct Fixture { ~Fixture() { RemoveTutorial(); } } fixture;
    const auto savedTabs = g_customFilters.size();
    ApplyResponse(R"({"op":"nativeTutorialOpen","data":{"session":2,"preview":true,"mac":false,"english":true,
        "ready":true,"shortcut":"Alt + V","filters":[],"items":[],"error":""}})");
    ApplyResponse(R"({"op":"nativeTutorialState","data":{"session":1,"items":[{"id":"guide-test","name":"Stale"}]}})");
    winrt::check_hresult(!DynamicTab(L"guide-test") ? S_OK : E_FAIL);
    ApplyResponse(R"({"op":"nativeTutorialState","data":{"session":2,"ready":true,"filters":[],
        "items":[{"id":"guide-test","name":"Guide","emoji":"🖼️"}]}})");
    winrt::check_hresult(DynamicTab(L"guide-test") && g_customFilters.size() == savedTabs ? S_OK : E_FAIL);
    RemoveTutorial();
    winrt::check_hresult(!DynamicTab(L"guide-test") && !g_tutorialPreviewFilters ? S_OK : E_FAIL);
    stage = 265;
}

void CheckEmptySearchFocus(std::vector<std::string> const &requests, std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Windows::Data::Json;
    stage = 266;
    const auto island = winrt::Microsoft::UI::GetWindowFromWindowId(g_panel.xamlSource.SiteBridge().WindowId());
    SetFocus(island);
    ShowSearch();
    const auto editor = g_panel.search;
    const auto focused = [&] { return Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot()); };
    winrt::check_hresult(focused() == editor ? S_OK : E_FAIL);
    const auto reply = [](bool match) {
        auto result = JsonObject::Parse(match
            ? LR"({"op":"query","data":{"items":[{"hash":"search-fixture","itemType":"Text","previewText":"alpha"}]}})"
            : LR"({"op":"query","data":{"items":[]}})");
        result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
        ApplyResponse(winrt::to_string(result.Stringify()));
    };
    editor.Text(L"alpha"); RequestHistory(); reply(true);
    editor.Text(L"alphax"); editor.Select(6, 0);
    SubmitSearch(); // An Enter on zero matches must not paste the old card.
    const auto beforeEmpty = requests.size();
    reply(false);
    winrt::check_hresult(g_hashes.empty() && g_panel.emptyState.Visibility() == Visibility::Visible &&
        g_searchSubmitRequestId == 0 && requests.size() == beforeEmpty + 1 &&
        JsonObject::Parse(winrt::to_hstring(requests.back())).GetNamedString(L"op") == L"previewDismiss" ? S_OK : E_FAIL);
    stage = 267;
    // Replay the Rust preview-close response at its real native focus endpoint.
    WindowProc(g_panel.window, kFocusHistory, 0, 0);
    winrt::check_hresult(focused() == editor && editor.Text() == L"alphax" && editor.SelectionStart() == 6 ? S_OK : E_FAIL);
    editor.Select(5, 1); editor.SelectedText(L"");
    RequestHistory(); reply(true);
    winrt::check_hresult(focused() == editor && SearchText() == L"alpha" && g_hashes.size() == 1 ? S_OK : E_FAIL);
    WindowProc(g_panel.window, kFocusHistory, 1, 0); // Explicit keyboard handoff still works.
    winrt::check_hresult(MainInputArea(focused()) == vpaste::winui::InputArea::History ? S_OK : E_FAIL);
    stage = 268;
}

winrt::Windows::Foundation::IAsyncAction CheckCardHoverScroll(std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    stage = 258;
    RequestHistory();
    JsonArray items;
    for (const auto *hash : {L"scroll-a", L"scroll-b"}) {
        JsonObject item;
        std::wstring text;
        for (int line = 1; line <= 16; ++line) {
            text += std::wstring{hash} + L" text line " + std::to_wstring(line) + L"\n";
        }
        item.Insert(L"hash", JsonValue::CreateStringValue(hash));
        item.Insert(L"itemType", JsonValue::CreateStringValue(L"Text"));
        item.Insert(L"previewText", JsonValue::CreateStringValue(text));
        items.Append(item);
    }
    JsonObject data; data.Insert(L"items", items);
    JsonObject response; response.Insert(L"op", JsonValue::CreateStringValue(L"query"));
    response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
    response.Insert(L"data", data);
    ApplyResponse(winrt::to_string(response.Stringify()));
    winrt::check_hresult(g_panel.rows.size() == 2 ? S_OK : E_FAIL);
    for (auto &row : g_panel.rows) {
        co_await AwaitNativeLoaded(row.autoPreview->viewport);
        row.preview.Foreground(Brush(255, 0, 255));
    }
    const auto a = g_panel.rows[0].autoPreview;
    const auto b = g_panel.rows[1].autoPreview;
    const auto move = [](int hover, int selected) {
        g_panel.history.SelectedIndex(selected);
        g_panel.rows[0].pointerOver = hover == 0;
        g_panel.rows[1].pointerOver = hover == 1;
        UpdateCardPreviewMotion();
    };
    const auto moving = [](std::shared_ptr<vpaste::winui::AutoScrollCardPreview> preview)
        -> winrt::Windows::Foundation::IAsyncOperation<bool> {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        do {
            co_await NextNativeFrame();
            if (preview->viewport.VerticalOffset() >= 32) co_return true;
        } while (std::chrono::steady_clock::now() < deadline);
        co_return false;
    };
    move(0, 0);
    stage = 2581;
    const bool firstMoves = co_await moving(a);
    move(1, 0); // The selected card can still be active when a neighbor is hovered.
    stage = 2582;
    const bool neighborMoves = co_await moving(b);
    const bool overlap = a->viewport.VerticalOffset() > 0 && a->Animating();
    move(1, 1);
    for (int frame = 0; frame < 12 && a->viewport.VerticalOffset() > 0.5; ++frame) co_await NextNativeFrame();
    const bool firstRetired = !a->Animating() && a->viewport.VerticalOffset() <= 0.5;
    move(0, 1);
    stage = 2583;
    const bool returnMoves = co_await moving(a);
    std::fprintf(stderr, "WinUI card scroll switch: first=%d neighbor=%d overlap=%d retired=%d return=%d\n",
        firstMoves, neighborMoves, overlap, firstRetired, returnMoves);
    winrt::check_hresult(firstMoves && neighborMoves && overlap && firstRetired && returnMoves ? S_OK : E_FAIL);
    stage = 2584;
    Media::Imaging::RenderTargetBitmap bitmap;
    co_await bitmap.RenderAsync(g_panel.root);
    const auto pixels = co_await bitmap.GetPixelsAsync();
    std::vector<std::uint8_t> bytes(pixels.Length());
    winrt::Windows::Storage::Streams::DataReader::FromBuffer(pixels).ReadBytes(bytes);
    const auto width = bitmap.PixelWidth(), height = bitmap.PixelHeight();
    winrt::check_hresult(width > 0 && height > 0 ? S_OK : E_FAIL);
    const auto scaleX = width / g_panel.root.ActualWidth();
    const auto scaleY = height / g_panel.root.ActualHeight();
    const auto bounds = [](FrameworkElement const &element) {
        return element.TransformToVisual(g_panel.root).TransformBounds({0, 0,
            static_cast<float>(element.ActualWidth()), static_cast<float>(element.ActualHeight())});
    };
    for (const auto &row : g_panel.rows) {
        const auto viewport = row.autoPreview->viewport;
        const auto body = bounds(viewport), header = bounds(row.header), card = bounds(row.frame);
        const auto top = static_cast<int>(body.Y * scaleY);
        const auto bottom = static_cast<int>((body.Y + body.Height) * scaleY);
        const auto left = std::max(0, static_cast<int>(card.X * scaleX));
        const auto right = std::min(width, static_cast<int>((card.X + card.Width) * scaleX));
        int inside = 0, outside = 0;
        for (int y = 0; y < height; ++y) for (int x = left; x < right; ++x) {
            const auto i = static_cast<std::size_t>((y * width + x) * 4);
            if (bytes[i] < 190 || bytes[i + 1] > 100 || bytes[i + 2] < 190 || bytes[i + 3] < 200) continue;
            if (y >= top && y < bottom) ++inside;
            else if (y < top - 1 || y > bottom) ++outside;
        }
        std::fprintf(stderr, "WinUI moving card pixels: offset=%.1f body=(%.1f,%.1f) header=(%.1f,%.1f) inside=%d outside=%d\n",
            viewport.VerticalOffset(), body.Y, body.Height, header.Y, header.Height, inside, outside);
        winrt::check_hresult(body.Y + 0.5 >= header.Y + header.Height && inside > 0 && outside == 0 ? S_OK : E_FAIL);
    }
    for (int index = 0; index < 6; ++index) {
        move(index % 2, index % 2);
        co_await NextNativeFrame();
    }
    move(-1, -1);
    stage = 2585;
    const auto quietUntil = std::chrono::steady_clock::now() + std::chrono::milliseconds(450);
    do { co_await NextNativeFrame(); } while (std::chrono::steady_clock::now() < quietUntil);
    winrt::check_hresult(!a->Animating() && !b->Animating() &&
        a->viewport.VerticalOffset() <= 0.5 && b->viewport.VerticalOffset() <= 0.5 ? S_OK : E_FAIL);

    move(0, 0);
    stage = 2586;
    const auto bottom = a->viewport.ScrollableHeight();
    const auto loopUntil = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    bool reachedBottom = false, returnedToTop = false, restarted = false;
    do {
        co_await NextNativeFrame();
        const auto offset = a->viewport.VerticalOffset();
        reachedBottom |= offset >= bottom - 1;
        returnedToTop |= reachedBottom && offset <= 0.5;
        restarted = returnedToTop && offset > 8;
    } while (!restarted && std::chrono::steady_clock::now() < loopUntil);
    std::fprintf(stderr, "WinUI card scroll loop: bottom=%d top=%d restarted=%d\n", reachedBottom, returnedToTop, restarted);
    winrt::check_hresult(restarted && !b->Animating() && b->viewport.VerticalOffset() <= 0.5 ? S_OK : E_FAIL);
    move(-1, -1);
}

winrt::Windows::Foundation::IAsyncAction CheckCardContextMenu(
    std::vector<std::string> const &requests, std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    const auto reply = [](JsonObject const &response) {
        response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
        ApplyResponse(winrt::to_string(response.Stringify()));
    };
    const auto menuFor = [](std::size_t index) { return EnsureCardContextMenu(g_panel.rows[index], g_hashes[index]); };
    const auto find = [](auto const &items, auto const &label) -> MenuFlyoutItemBase {
        for (const auto &item : items) {
            if (const auto command = item.template try_as<MenuFlyoutItem>(); command && command.Text() == label) return item;
            if (const auto submenu = item.template try_as<MenuFlyoutSubItem>(); submenu && submenu.Text() == label) return item;
        }
        return nullptr;
    };
    const auto closeMenu = [](MenuFlyout const &popup) -> winrt::Windows::Foundation::IAsyncAction {
        const auto first = popup.Items().GetAt(0);
        if (!popup.IsOpen() && !first.IsLoaded()) co_return;
        if (popup.IsOpen()) popup.Hide();
        // Invocation can start light dismissal before IsOpen and the visual tree agree.
        for (int frame = 0; frame < 60 && (popup.IsOpen() || first.IsLoaded()); ++frame)
            co_await NextNativeFrame();
        winrt::check_hresult(!popup.IsOpen() && !first.IsLoaded() ? S_OK : E_FAIL);
        // The inactive desktop can still be finishing the popup's focus handoff.
        const winrt::apartment_context ui;
        co_await winrt::resume_after(std::chrono::milliseconds(180));
        co_await ui;
    };
    const auto invoke = [](FrameworkElement const &item) {
        winrt::check_hresult(item ? S_OK : E_FAIL);
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(item)
            .GetPattern(Automation::Peers::PatternInterface::Invoke)
            .as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    const auto expand = [](MenuFlyoutSubItem const &item) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(item)
            .GetPattern(Automation::Peers::PatternInterface::ExpandCollapse)
            .as<Automation::Provider::IExpandCollapseProvider>().Expand();
    };
    const auto tagsReply = [](const wchar_t *payload) {
        auto response = JsonObject::Parse(payload);
        response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestTagsRequestId)));
        ApplyResponse(winrt::to_string(response.Stringify()));
    };
    const auto sent = [&](std::size_t from, const wchar_t *op, const wchar_t *hash) {
        return std::count_if(requests.begin() + from, requests.end(), [&](auto const &bytes) {
            const auto req = JsonObject::Parse(winrt::to_hstring(bytes));
            return req.GetNamedString(L"op") == op && req.GetNamedString(L"hash", L"") == hash;
        });
    };
    const auto requestFor = [&](std::size_t from, const wchar_t *op, const wchar_t *hash) {
        for (auto it = requests.begin() + from; it != requests.end(); ++it) {
            const auto request = JsonObject::Parse(winrt::to_hstring(*it));
            if (request.GetNamedString(L"op") == op && request.GetNamedString(L"hash", L"") == hash) return request;
        }
        winrt::throw_hresult(E_FAIL);
    };
    WindowProc(g_panel.window, kSetLanguage, true, 0);
    RequestHistory();
    const auto response = JsonObject::Parse(LR"({"op":"query","data":{"items":[
        {"id":101,"hash":"menu-text","itemType":"Text","previewText":"Menu text"},
        {"id":102,"hash":"menu-image","itemType":"Image","previewText":"Menu image"},
        {"hash":"menu-file","itemType":"File","previewText":"Menu file"},
        {"hash":"menu-link","itemType":"Link","previewText":"https://example.com"},
        {"hash":"menu-color","itemType":"Color","previewText":"#0B86FF"},
        {"hash":"menu-text-file","itemType":"TextFile","previewText":"Long text"}
    ]}})");
    reply(response);
    const auto primaryButton = [&](auto const &self, DependencyObject const &element) -> Button {
        if (const auto button = element.try_as<Button>(); button && button.Name() == L"PrimaryButton") return button;
        for (int i = 0; i < Media::VisualTreeHelper::GetChildrenCount(element); ++i)
            if (const auto button = self(self, Media::VisualTreeHelper::GetChild(element, i))) return button;
        return nullptr;
    };
    auto before = requests.size();
    if (!GetEnvironmentVariableW(L"VPASTE_WINUI_CARD_ASYNC_CHECK", nullptr, 0)) {
        stage = 271;
        winrt::check_hresult(g_panel.rows.size() == 6 ? S_OK : E_FAIL);
        // Direct mutations must re-read history even when the tab catalogue is unchanged.
        for (auto op : {L"assignTag", L"removeTag", L"clearTags"}) {
            for (bool reject : {false, true}) {
                JsonObject mutation;
                mutation.Insert(L"op", JsonValue::CreateStringValue(op));
                const auto id = SendRequest(op, L"menu-text", false, 9);
                mutation.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
                if (reject) mutation.Insert(L"error", JsonValue::CreateStringValue(L"Controlled tag write failure"));
                else mutation.Insert(L"data", JsonObject{});
                const auto beforeQuery = g_latestQueryId;
                ApplyResponse(winrt::to_string(mutation.Stringify()));
                winrt::check_hresult(id && g_latestQueryId > beforeQuery && g_panel.feedback.IsOpen() &&
                    g_panel.feedback.Message() == (reject ? L"Controlled tag write failure" : L"Tags updated") ? S_OK : E_FAIL);
                const auto refreshed = g_latestQueryId;
                ApplyResponse(winrt::to_string(mutation.Stringify()));
                winrt::check_hresult(refreshed == g_latestQueryId ? S_OK : E_FAIL);
                reply(response);
            }
        }
        for (std::size_t i = 0; i < g_panel.rows.size(); ++i) {
            const auto items = menuFor(i).Items();
            const auto paste = items.GetAt(items.Size() - 1).as<MenuFlyoutItem>();
            const auto preview = find(items, L"Preview").try_as<MenuFlyoutItem>();
            const auto deletion = find(items, L"Delete record").try_as<MenuFlyoutItem>();
            winrt::check_hresult(paste.Text() == L"Copy and paste" && paste.KeyboardAcceleratorTextOverride() == L"Enter" &&
                preview && preview.KeyboardAcceleratorTextOverride() == L"Space" &&
                !find(items, L"Copy") && !find(items, L"Copy as plain text") && !find(items, L"Add to paste queue") &&
                deletion && deletion.KeyboardAcceleratorTextOverride() == L"Delete" ? S_OK : E_FAIL);
        }
        const auto textItems = menuFor(0).Items();
        const auto imageItems = menuFor(1).Items();
        const auto ocr = find(imageItems, L"Recognize text in image").as<MenuFlyoutItem>();
        winrt::check_hresult(find(textItems, L"Edit text") &&
            ocr.Text() == L"Recognize text in image" && ocr.Icon().try_as<PathIcon>() &&
            find(textItems, L"Paste as plain text") &&
            find(menuFor(2).Items(), L"Open containing folder") && find(menuFor(2).Items(), L"Copy containing folder") &&
            find(menuFor(3).Items(), L"Paste as plain text") && find(menuFor(4).Items(), L"Copy color as") &&
            find(menuFor(5).Items(), L"Edit text") ? S_OK : E_FAIL);
        for (const auto index : {0u, 2u}) {
            g_panel.history.ScrollIntoView(g_panel.history.Items().GetAt(index));
            co_await NextNativeFrame();
            const auto surface = g_panel.rows[index].surface;
            const auto popup = menuFor(index);
            co_await AwaitNativeLoaded(surface);
            popup.ShowAt(surface);
            co_await NextNativeFrame();
            const auto labels = index == 0
                ? std::vector<const wchar_t *>{L"Delete record", L"Tags", L"Add favorite", L"Edit text", L"Preview", L"Paste as plain text", L"Copy and paste"}
                : std::vector<const wchar_t *>{L"Delete record", L"Open containing folder", L"Copy containing folder", L"Tags", L"Add favorite", L"Preview", L"Copy and paste"};
            float previousBottom = -INFINITY;
            for (const auto label : labels) {
                const auto command = find(popup.Items(), label);
                co_await AwaitNativeLoaded(command);
                const auto rect = Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(command).GetBoundingRectangle();
                std::fwprintf(stderr, L"WinUI menu %ls: y=%.1f h=%.1f\\n", label, rect.Y, rect.Height);
                winrt::check_hresult(rect.Height > 0 && rect.Y >= previousBottom - 1 ? S_OK : E_FAIL);
                previousBottom = rect.Y + rect.Height;
            }
            winrt::check_hresult(popup.Items().GetAt(1).try_as<MenuFlyoutSeparator>() ? S_OK : E_FAIL);
            co_await closeMenu(popup);
        }
        g_panel.history.ScrollIntoView(g_panel.history.Items().GetAt(0));
        co_await NextNativeFrame();
        stage = 272;
        const auto menu = menuFor(0);
        const auto target = g_panel.rows[0].surface;
        co_await AwaitNativeLoaded(target);
        const auto show = [&]() -> winrt::Windows::Foundation::IAsyncAction {
            co_await closeMenu(menu);
            const auto first = menu.Items().GetAt(0);
            menu.ShowAt(target);
            co_await AwaitNativeLoaded(first);
            winrt::check_hresult(menu.IsOpen() ? S_OK : E_FAIL);
        };
        co_await show();
        const auto loading = find(menu.Items(), L"Tags").as<MenuFlyoutSubItem>();
        const auto unavailable = find(loading.Items(), L"Loading tags…").try_as<MenuFlyoutItem>();
        winrt::check_hresult(unavailable && !unavailable.IsEnabled() &&
            !find(menu.Items(), L"Create and assign tag…") ? S_OK : E_FAIL);
        co_await closeMenu(menu);
        stage = 2721;
        tagsReply(LR"({"op":"tags","error":"Controlled catalogue failure"})");
        co_await show();
        const auto failed = find(menu.Items(), L"Tags").as<MenuFlyoutSubItem>();
        expand(failed);
        const auto retryTags = find(failed.Items(), L"Try again").as<MenuFlyoutItem>();
        co_await AwaitNativeLoaded(retryTags);
        const auto beforeRetry = g_latestTagsRequestId;
        winrt::check_hresult(!find(failed.Items(), L"Could not load tags").as<MenuFlyoutItem>().IsEnabled() &&
            retryTags.IsEnabled() && !find(failed.Items(), L"Create and assign tag…") ? S_OK : E_FAIL);
        {
            bool closed = false;
            const auto observer = menu.Closed(winrt::auto_revoke, [&](auto const &, auto const &) { closed = true; });
            invoke(retryTags);
            co_await NextNativeFrame();
            if (menu.IsOpen()) menu.Hide();
            for (int frame = 0; frame < 60 && !closed; ++frame) co_await NextNativeFrame();
            winrt::check_hresult(closed ? S_OK : E_FAIL);
        }
        winrt::check_hresult(g_latestTagsRequestId > beforeRetry && !g_recordTagsLoaded && !g_recordTagsFailed ? S_OK : E_FAIL);
        co_await closeMenu(menu);

        // Tags can arrive after history or change without replacing a retained card.
        stage = 2723;
        tagsReply(LR"({"op":"tags","data":{"items":[{"id":9,"name":"Work"},{"id":10,"name":"Notes"}]}})");
        co_await show();
        const auto assigned = find(menu.Items(), L"Tags").try_as<MenuFlyoutSubItem>();
        if (!assigned || assigned.Items().Size() != 3) std::fprintf(stderr,
            "WinUI card tags: menuOpen=%d, loaded=%d, knownTags=%zu, submenuItems=%u\n",
            menu.IsOpen(), g_recordTagsLoaded, g_tagIds.size(), assigned ? assigned.Items().Size() : 0);
        winrt::check_hresult(assigned && assigned.Items().Size() == 3 &&
            !assigned.Items().GetAt(0).as<ToggleMenuFlyoutItem>().IsChecked() &&
            !find(menu.Items(), L"Create and assign tag…") ? S_OK : E_FAIL);
        co_await closeMenu(menu);
        stage = 273;
        g_panel.rows[0].tagIds = {9};
        co_await show();
        const auto tagMenu = find(menu.Items(), L"Tags").as<MenuFlyoutSubItem>();
        const auto tags = tagMenu.Items();
        winrt::check_hresult(tags.GetAt(0).as<ToggleMenuFlyoutItem>().IsChecked() &&
            !tags.GetAt(1).as<ToggleMenuFlyoutItem>().IsChecked() &&
            tags.GetAt(tags.Size() - 1).as<MenuFlyoutItem>().Text() == L"Remove all assigned tags" &&
            !find(menu.Items(), L"Remove all assigned tags") ? S_OK : E_FAIL);
        stage = 2731;
        expand(tagMenu);
        co_await AwaitNativeLoaded(tags.GetAt(tags.Size() - 1));
        for (const bool wasAssigned : {true, false}) {
            stage = wasAssigned ? 2732 : 2733;
            const auto toggle = tags.GetAt(wasAssigned ? 0 : 1).as<ToggleMenuFlyoutItem>();
            before = requests.size();
            toggle.IsChecked(!wasAssigned);
            const auto op = wasAssigned ? L"removeTag" : L"assignTag";
            winrt::check_hresult(toggle.IsChecked() == wasAssigned && sent(before, op, L"menu-text") == 1 &&
                requestFor(before, op, L"menu-text").GetNamedNumber(L"tagId") == (wasAssigned ? 9 : 10) ? S_OK : E_FAIL);
        }
        stage = 2734;
        before = requests.size();
        invoke(tags.GetAt(tags.Size() - 1)); co_await NextNativeFrame();
        winrt::check_hresult(sent(before, L"clearTags", L"menu-text") == 1 ? S_OK : E_FAIL);
        co_await closeMenu(menu);
        stage = 2735;
        tagsReply(LR"({"op":"tags","data":{"items":[{"id":10,"name":"Renamed"}]}})");
        co_await show();
        const auto remaining = find(menu.Items(), L"Tags").as<MenuFlyoutSubItem>().Items();
        winrt::check_hresult(remaining.Size() == 2 &&
            remaining.GetAt(0).as<ToggleMenuFlyoutItem>().Text() == L"Renamed" ? S_OK : E_FAIL);
        co_await closeMenu(menu);

        stage = 274;
        g_panel.history.SelectedIndex(1);
        before = requests.size();
        RequestSelectedAction(L"copy");
        winrt::check_hresult(sent(before, L"copy", L"menu-image") == 1 && !sent(before, L"paste", L"menu-image") ? S_OK : E_FAIL);
        co_await show();
        before = requests.size();
        invoke(find(menu.Items(), L"Copy and paste")); co_await NextNativeFrame();
        winrt::check_hresult(sent(before, L"paste", L"menu-text") == 1 && !sent(before, L"copy", L"menu-text") ? S_OK : E_FAIL);
        co_await closeMenu(menu);
        co_await show();
        before = requests.size();
        invoke(find(menu.Items(), L"Paste as plain text")); co_await NextNativeFrame();
        winrt::check_hresult(sent(before, L"pastePlain", L"menu-text") == 1 && !sent(before, L"paste", L"menu-text") &&
            !sent(before, L"copyPlain", L"menu-text") ? S_OK : E_FAIL);
        co_await closeMenu(menu);
        co_await show();
        before = requests.size();
        invoke(find(menu.Items(), L"Delete record")); co_await NextNativeFrame();
        winrt::check_hresult(!sent(before, L"delete", L"menu-text") && g_deleteConfirmationOpen && g_panel.deletionDialog ? S_OK : E_FAIL);
        co_await AwaitNativeLoaded(g_panel.deletionDialog);
        g_panel.deletionDialog.Hide();
        while (g_deleteConfirmationOpen) co_await NextNativeFrame();
        winrt::check_hresult(!sent(before, L"delete", L"menu-text") && g_selectedHash == L"menu-text" ? S_OK : E_FAIL);
        co_await closeMenu(menu);
        stage = 275;
        before = requests.size();
        g_panel.history.SelectedIndex(1);
        DeleteCard(g_selectedHash);
        const auto confirmation = g_panel.deletionDialog;
        DeleteCard(L"menu-text");
        winrt::check_hresult(confirmation && confirmation == g_panel.deletionDialog && !sent(before, L"delete", L"menu-image") ? S_OK : E_FAIL);
        co_await AwaitNativeLoaded(confirmation);
        invoke(primaryButton(primaryButton, confirmation));
        while (g_deleteConfirmationOpen) co_await NextNativeFrame();
        DeleteCard(L"missing-row");
        winrt::check_hresult(sent(before, L"delete", L"menu-image") == 1 && !sent(before, L"delete", L"menu-text") &&
            !g_deleteConfirmationOpen ? S_OK : E_FAIL);
        SetQueueViewActive(true);
        g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
        g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(1));
        winrt::check_hresult(g_panel.queueOpen && g_queueViewActive && g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
        before = requests.size();
        DeleteCard(L"menu-text");
        winrt::check_hresult(!sent(before, L"delete", L"menu-text") ? S_OK : E_FAIL);
        invoke(g_panel.queueAdd); co_await NextNativeFrame();
        const auto add = std::find_if(requests.begin() + before, requests.end(), [](auto const &bytes) {
            return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"queueAdd";
        });
        winrt::check_hresult(add != requests.end() ? S_OK : E_FAIL);
        const auto selected = JsonObject::Parse(winrt::to_hstring(*add)).GetNamedArray(L"hashes");
        winrt::check_hresult(selected.Size() == 2 && selected.GetStringAt(0) == L"menu-text" &&
            selected.GetStringAt(1) == L"menu-image" ? S_OK : E_FAIL);
        SetQueueViewActive(false);
        stage = 2751;
        tagsReply(LR"({"op":"tags","data":{"items":[]}})");
        co_await AwaitNativeLoaded(target);
        co_await show();
        const auto empty = find(menu.Items(), L"Tags").as<MenuFlyoutSubItem>();
        expand(empty);
        const auto create = find(empty.Items(), L"Create and assign tag…").as<MenuFlyoutItem>();
        winrt::check_hresult(!find(empty.Items(), L"No tags yet").as<MenuFlyoutItem>().IsEnabled() ? S_OK : E_FAIL);
        co_await AwaitNativeLoaded(create);
        g_searchSubmitRequestId = g_latestQueryId;
        stage = 2752;
        invoke(create);
        for (int frame = 0; frame < 12 && !g_panel.recordTagEditor->IsOpen(); ++frame) co_await NextNativeFrame();
        winrt::check_hresult(!menu.IsOpen() && g_panel.recordTagEditor->IsOpen() && !g_searchSubmitRequestId ? S_OK : E_FAIL);
        co_await AwaitNativeLoaded(g_panel.recordTagEditor->TestRoot());
        before = requests.size();
        g_panel.recordTagEditor->TestName(L"First tag");
        g_panel.recordTagEditor->TestSave();
        winrt::check_hresult(sent(before, L"recordTagCreate", L"") == 1 ? S_OK : E_FAIL);
        const auto created = JsonObject::Parse(winrt::to_hstring(requests.back()));
        auto createdReply = JsonObject::Parse(LR"({"op":"recordTagCreate","data":{"tag":{"id":9,"name":"First tag"}}})");
        createdReply.Insert(L"id", created.GetNamedValue(L"id"));
        ApplyResponse(winrt::to_string(createdReply.Stringify()));
        winrt::check_hresult(sent(before, L"recordTagAssign", L"menu-text") == 1 ? S_OK : E_FAIL);
        const auto assignment = JsonObject::Parse(winrt::to_hstring(requests.back()));
        auto assignedReply = JsonObject::Parse(LR"({"op":"recordTagAssign","data":{}})");
        assignedReply.Insert(L"id", assignment.GetNamedValue(L"id"));
        const auto beforeAssignRefresh = g_latestQueryId;
        stage = 27521;
        ApplyResponse(winrt::to_string(assignedReply.Stringify()));
        winrt::check_hresult(!g_panel.recordTagEditor->IsOpen() && g_latestQueryId > beforeAssignRefresh ? S_OK : E_FAIL);
        const auto assignedRows = JsonObject::Parse(response.Stringify());
        assignedRows.GetNamedObject(L"data").GetNamedArray(L"items").GetObjectAt(0).Insert(
            L"tags", JsonArray::Parse(LR"([{"id":9,"name":"First tag"}])"));
        reply(assignedRows);
        const auto assignedCard = FindCard(L"menu-text");
        winrt::check_hresult(assignedCard && assignedCard->tagChip.Visibility() == Visibility::Visible &&
            assignedCard->tags.Text() == L"First tag" ? S_OK : E_FAIL);
        stage = 2753;
        tagsReply(LR"({"op":"tags","data":{"items":[{"id":9,"name":"Work"}]}})");
        g_panel.customTabs.SelectedItem(DynamicTab(RecordTabId(9)));
        const auto onlyMatch = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"only-match","itemType":"Text","tags":[{"id":9,"name":"Work"}]}]}})");
        reply(onlyMatch);
        for (bool reject : {true, false}) {
            const CardTarget target{L"only-match", 0};
            const auto card = FindCard(target);
            winrt::check_hresult(card ? S_OK : E_FAIL);
            const auto sub = MakeCardTagEntry(target, card->tagIds, std::make_shared<bool>(false)).as<MenuFlyoutSubItem>();
            const auto toggle = sub.Items().GetAt(0).as<ToggleMenuFlyoutItem>();
            winrt::check_hresult(toggle.IsChecked() && !find(sub.Items(), L"All tags are assigned").as<MenuFlyoutItem>().IsEnabled() &&
                find(sub.Items(), L"Create and assign tag…").as<MenuFlyoutItem>().IsEnabled() &&
                sub.Items().GetAt(sub.Items().Size() - 2).try_as<MenuFlyoutSeparator>() ? S_OK : E_FAIL);
            const auto initial = requests.size();
            toggle.IsChecked(false);
            winrt::check_hresult(sent(initial, L"removeTag", L"only-match") == 1 ? S_OK : E_FAIL);
            const auto previous = g_latestQueryId;
            auto removal = JsonObject::Parse(reject ? LR"({"op":"removeTag","error":"Controlled fixture failure"})"
                                                    : LR"({"op":"removeTag","data":{}})");
            removal.Insert(L"id", requestFor(initial, L"removeTag", L"only-match").GetNamedValue(L"id"));
            ApplyResponse(winrt::to_string(removal.Stringify()));
            winrt::check_hresult(g_latestQueryId > previous && g_historyView.requestedQuery.tag == L"Work" ? S_OK : E_FAIL);
            reply(reject ? onlyMatch : JsonObject::Parse(LR"({"op":"query","data":{"items":[]}})"));
            winrt::check_hresult(PanelVisible() && g_selectedTagId == 9 &&
                (reject ? FindCard(L"only-match") && g_panel.feedback.IsOpen() && g_panel.feedback.Message() == L"Controlled fixture failure"
                        : g_hashes.empty()) ? S_OK : E_FAIL);
        }
        stage = 276;
        co_return;
    }

    stage = 2761;
    SelectBuiltinCategory(0);
    reply(response);
    const auto file = FindCard(L"menu-file");
    g_panel.history.ScrollIntoView(file->frame);
    co_await AwaitNativeLoaded(file->surface);
    if (!file->cardRequestId) RequestCardDetails(L"menu-file");
    const auto filePopup = EnsureCardContextMenu(*file, L"menu-file");
    filePopup.ShowAt(file->surface);
    co_await NextNativeFrame();
    const auto fileExport = file->menu.exportImage;
    const auto fileDelete = find(filePopup.Items(), L"Delete record");
    co_await AwaitNativeLoaded(fileDelete);
    const auto deletePeer = Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(fileDelete);
    const auto initialBounds = deletePeer.GetBoundingRectangle();
    winrt::check_hresult(filePopup.IsOpen() && initialBounds.Height > 0 && !fileExport.IsEnabled() &&
        fileExport.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    auto details = JsonObject::Parse(LR"({"op":"card","data":{"hash":"menu-file","actions":{"canExportImage":true}}})");
    details.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(file->cardRequestId)));
    ApplyResponse(winrt::to_string(details.Stringify()));
    co_await NextNativeFrame();
    winrt::check_hresult(filePopup.IsOpen() && file->pendingMenuActions &&
        !fileExport.IsEnabled() && fileExport.Visibility() == Visibility::Collapsed &&
        deletePeer.GetBoundingRectangle() == initialBounds ? S_OK : E_FAIL);
    co_await closeMenu(filePopup);
    filePopup.ShowAt(file->surface);
    co_await AwaitNativeLoaded(fileExport);
    winrt::check_hresult(!file->pendingMenuActions && fileExport.IsEnabled() ? S_OK : E_FAIL);
    co_await closeMenu(filePopup);

    stage = 2762;
    auto reordered = JsonObject::Parse(response.Stringify());
    const auto reorderedItems = reordered.GetNamedObject(L"data").GetNamedArray(L"items");
    const auto firstItem = reorderedItems.GetAt(0);
    reorderedItems.SetAt(0, reorderedItems.GetAt(1));
    reorderedItems.SetAt(1, firstItem);
    RequestHistory(true); reply(reordered);
    const auto movedCard = FindCard(L"menu-text");
    const auto moved = movedCard->surface;
    const auto movedMenu = EnsureCardContextMenu(*movedCard, L"menu-text");
    g_panel.history.SelectedIndex(0);
    g_panel.history.ScrollIntoView(g_panel.history.Items().GetAt(1));
    co_await AwaitNativeLoaded(moved);
    before = requests.size();
    movedMenu.ShowAt(moved); co_await NextNativeFrame();
    const auto addFavorite = find(movedMenu.Items(), L"Add favorite");
    winrt::check_hresult(g_selectedHash == L"menu-text" && sent(before, L"previewSelect", L"menu-text") == 1 && addFavorite ? S_OK : E_FAIL);
    // A newer favorite value must not invert the action the open menu offered.
    g_favorites[1] = true;
    invoke(addFavorite); co_await NextNativeFrame();
    winrt::check_hresult(sent(before, L"favorite", L"menu-text") == 1 &&
        requestFor(before, L"favorite", L"menu-text").GetNamedBoolean(L"favorite") ? S_OK : E_FAIL);
    co_await closeMenu(movedMenu);
    auto replaced = JsonObject::Parse(reordered.Stringify());
    replaced.GetNamedObject(L"data").GetNamedArray(L"items").GetObjectAt(1).Insert(L"id", JsonValue::CreateNumberValue(201));
    RequestHistory(true); reply(replaced);
    winrt::check_hresult(!GuardedCardAction({L"menu-text", 101})(L"paste", L"menu-text", {}) &&
        !GuardedCardAction({L"removed-from-view", 300})(L"copyFolder", L"removed-from-view", {}) ? S_OK : E_FAIL);

    stage = 2763;
    before = requests.size();
    DeleteCard(L"menu-image");
    const auto refreshConfirmation = g_panel.deletionDialog;
    co_await AwaitNativeLoaded(refreshConfirmation);
    RequestHistory(true);
    invoke(primaryButton(primaryButton, refreshConfirmation));
    while (g_deleteConfirmationOpen) co_await NextNativeFrame();
    winrt::check_hresult(!sent(before, L"delete", L"menu-image") &&
        g_panel.feedback.Message() == L"History is refreshing. Try deleting again after it loads." ? S_OK : E_FAIL);
    reply(response);
    DeleteCard(L"menu-image");
    const auto changedConfirmation = g_panel.deletionDialog;
    co_await AwaitNativeLoaded(changedConfirmation);
    RequestHistory(true);
    auto changedRows = JsonObject::Parse(response.Stringify());
    changedRows.GetNamedObject(L"data").GetNamedArray(L"items").GetObjectAt(1).Insert(L"id", JsonValue::CreateNumberValue(202));
    reply(changedRows);
    invoke(primaryButton(primaryButton, changedConfirmation));
    while (g_deleteConfirmationOpen) co_await NextNativeFrame();
    winrt::check_hresult(!sent(before, L"delete", L"menu-image") &&
        g_panel.feedback.Message() == L"History changed. Select the record again to delete it." ? S_OK : E_FAIL);

    stage = 2764;
    SetQueueViewActive(true);
    co_await NextNativeFrame();
    const auto firstContainer = g_panel.history.ContainerFromIndex(0).as<ListViewItem>();
    const auto secondContainer = g_panel.history.ContainerFromIndex(1).as<ListViewItem>();
    vpaste::winui::MainKeyInput enter;
    enter.key = VK_RETURN; enter.area = vpaste::winui::InputArea::History;
    before = requests.size();
    winrt::check_hresult(HandleMainKey(enter, g_panel.history) && g_queueSelectedHashes.empty() ? S_OK : E_FAIL);
    winrt::check_hresult(HandleMainKey(enter, firstContainer) &&
        g_queueSelectedHashes == std::vector<std::wstring>{L"menu-text"} ? S_OK : E_FAIL);
    enter.repeated = true;
    (void)HandleMainKey(enter, secondContainer);
    winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"menu-text"} &&
        !sent(before, L"paste", L"menu-text") && !sent(before, L"paste", L"menu-image") ? S_OK : E_FAIL);
    const auto selectedBeforePreview = g_queueSelectedHashes;
    const auto beforePreviewQuery = CurrentHistoryQuery();
    winrt::check_hresult(OpenSelectedCardMenu(secondContainer) ? S_OK : E_FAIL);
    const auto queuePopup = menuFor(1);
    co_await NextNativeFrame();
    const auto queuePreviewCommand = find(queuePopup.Items(), L"Preview");
    for (const auto &item : queuePopup.Items())
        winrt::check_hresult(item.Visibility() == (item == queuePreviewCommand ? Visibility::Visible : Visibility::Collapsed) ? S_OK : E_FAIL);
    invoke(queuePreviewCommand); co_await NextNativeFrame();
    winrt::check_hresult(g_queuePreviewFocus && sent(before, L"previewToggle", L"menu-image") == 1 &&
        g_queueSelectedHashes == selectedBeforePreview ? S_OK : E_FAIL);
    const auto previewId = g_queuePreviewFocus->request;
    ApplyResponse(R"({"op":"nativeReaderHide","data":{"generation":700}})");
    ApplyResponse(R"({"op":"nativeReaderBegin","data":{"generation":701}})");
    const auto opened = std::string{R"({"op":"previewToggle","data":null,"id":)"} + std::to_string(previewId) + "}";
    ApplyResponse(opened);
    WindowProc(g_panel.window, kFocusHistory, 0, 0);
    winrt::check_hresult(g_queuePreviewFocus && g_queuePreviewFocus->ready && !g_queuePreviewFocus->closed ? S_OK : E_FAIL);
    const auto navigation = std::string{R"({"op":"previewNavigation","data":{"key":"Tab","direction":1,"ctrlKey":true,"sourceRequest":)"}
        + std::to_string(previewId) + "}}";
    ApplyResponse(navigation);
    ApplyResponse(R"({"op":"nativeReaderHide","data":{"generation":701}})");
    winrt::check_hresult(g_queuePreviewFocus && !g_queuePreviewFocus->closed && CurrentHistoryQuery() == beforePreviewQuery ? S_OK : E_FAIL);
    ApplyResponse(R"({"op":"nativeReaderHide","data":{"generation":702}})");
    WindowProc(g_panel.window, kFocusHistory, 0, kPreviewFocusReturn);
    co_await NextNativeFrame();
    winrt::check_hresult(!g_queuePreviewFocus && g_queueSelectedHashes == selectedBeforePreview &&
        HistoryIndexFromSource(Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot())) == 1 ? S_OK : E_FAIL);
    ToggleQueueCardPreview(L"menu-image");
    auto previewFailure = std::string{R"({"op":"previewToggle","error":"Controlled preview failure","id":)"}
        + std::to_string(g_queuePreviewFocus->request) + "}";
    ApplyResponse(previewFailure);
    winrt::check_hresult(!g_queuePreviewFocus && g_panel.feedback.Message() == L"Controlled preview failure" ? S_OK : E_FAIL);
    ToggleQueueCardPreview(L"menu-image");
    SetQueueViewActive(false);
    winrt::check_hresult(!g_queuePreviewFocus ? S_OK : E_FAIL);

    stage = 2765;
    ApplyFilters(JsonArray::Parse(LR"([{"id":"filter-fixture","name":"Example filter","filter":{}}])"));
    tagsReply(LR"({"op":"tags","data":{"items":[{"id":9,"name":"Work"}]}})");
    const std::array<std::wstring, 2> tabIds{L"filter-fixture", RecordTabId(9)};
    SetSearchText(L"preserve this query");
    for (const auto &tab : tabIds) {
        const bool tag = tab == tabIds[1];
        g_panel.customTabs.SelectedItem(DynamicTab(tab));
        reply(response);
        g_panel.history.SelectedIndex(0);
        before = requests.size();
        ConfirmDeleteTab(tab);
        auto dialog = g_panel.deletionDialog;
        co_await AwaitNativeLoaded(dialog);
        dialog.Hide();
        while (g_deleteConfirmationOpen) co_await NextNativeFrame();
        const auto op = tag ? L"recordTagDelete" : L"filtersDelete";
        winrt::check_hresult(!sent(before, op, L"") && !sent(before, L"previewDismiss", L"") &&
            DynamicTab(tab) && g_panel.customTabs.SelectedItem() == DynamicTab(tab) ? S_OK : E_FAIL);
        ConfirmDeleteTab(tab);
        dialog = g_panel.deletionDialog;
        co_await AwaitNativeLoaded(dialog);
        invoke(primaryButton(primaryButton, dialog));
        while (g_deleteConfirmationOpen) co_await NextNativeFrame();
        winrt::check_hresult(sent(before, op, L"") == 1 && !sent(before, L"delete", L"menu-text") ? S_OK : E_FAIL);
        auto deletionReply = requestFor(before, op, L"");
        deletionReply.Insert(L"data", JsonObject{});
        ApplyResponse(winrt::to_string(deletionReply.Stringify()));
        if (tag) {
            tagsReply(LR"({"op":"tags","data":{"items":[]}})");
        } else {
            auto filters = JsonObject::Parse(LR"({"op":"filtersList","data":{"items":[]}})");
            filters.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestFiltersRequestId)));
            ApplyResponse(winrt::to_string(filters.Stringify()));
        }
        winrt::check_hresult(!DynamicTab(tab) && FilterIndex() == 0 && g_selectedFilterId.empty() &&
            !g_selectedTagId && SearchText() == L"preserve this query" ? S_OK : E_FAIL);
        before = requests.size();
        reply(response);
        winrt::check_hresult(g_selectedHash == L"menu-text" && !sent(before, L"previewDismiss", L"") &&
            !sent(before, L"previewSelect", L"menu-text") ? S_OK : E_FAIL);
    }

    stage = 2766;
    ApplyFilters(JsonArray::Parse(LR"([{"id":"drag-first","name":"First"},{"id":"drag-last","name":"Last"}])"));
    co_await NextNativeFrame();
    before = requests.size();
    BeginTabDropPreview(L"drag-first");
    winrt::check_hresult(g_tabDrop.bounds.size() == 2 ? S_OK : E_FAIL);
    const auto lastTab = g_tabDrop.bounds.back();
    winrt::check_hresult(PreviewTabDrop(L"drag-first", lastTab.X + lastTab.Width) && g_tabDrop.target == L"drag-last" ? S_OK : E_FAIL);
    ClearTabDropPreview();
    winrt::check_hresult(g_tabDrop.target.empty() && g_panel.tabDropMarker.Visibility() == Visibility::Collapsed &&
        !sent(before, L"tabOrderSave", L"") && g_dynamicIds.front() == L"drag-first" ? S_OK : E_FAIL);
    SaveTabDrop(L"drag-first", L"drag-last");
    const auto move = requestFor(before, L"tabOrderSave", L"");
    winrt::check_hresult(move.GetNamedString(L"sourceId") == L"drag-first" && move.GetNamedString(L"targetId") == L"drag-last" &&
        !move.GetNamedBoolean(L"before") ? S_OK : E_FAIL);
    ApplyResponse(R"({"op":"tabOrderChanged","data":{"order":["drag-last","drag-first"]}})");
    winrt::check_hresult(g_dynamicIds == std::vector<std::wstring>{L"drag-last", L"drag-first"} ? S_OK : E_FAIL);
    stage = 2767;
}

winrt::Windows::Foundation::IAsyncAction CheckNativeTray(
    const std::vector<std::string> &requests, std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    const auto require = [](bool condition) { winrt::check_hresult(condition ? S_OK : E_FAIL); };
    const std::string show = R"({"op":"nativeTrayShow","data":{"anchor":{"x":390,"y":360,"cursor":true},
        "workArea":{"left":0,"top":0,"right":640,"bottom":480},"dpiScale":1,
        "english":false,"paused":false,"theme":"light","textScale":1,"updateReady":false}})";
    stage = 27801;
    require(!g_panel.trayWindow && !IsWindowVisible(g_panel.window));
    ApplyResponse(show);
    require(g_panel.trayWindow && !IsWindowVisible(g_panel.window));
    co_await vpaste::winui::TestTrayWindow(*g_panel.trayWindow, stage);
    stage = 27808;
    auto &tray = *g_panel.trayWindow;
    const auto popup = tray.Handle();
    ApplyResponse(show);
    auto list = tray.TestRoot().as<Grid>().Children().GetAt(0).as<Viewbox>().Child().as<StackPanel>().Children();
    const auto invoke = [&](std::uint32_t index) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(list.GetAt(index).as<Button>())
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    const auto checkRequest = [&](std::size_t sizeBefore, const wchar_t *name) {
        require(requests.size() == sizeBefore + 1);
        const auto event = JsonObject::Parse(winrt::to_hstring(requests.back()));
        require(event.GetNamedString(L"op") == L"nativeTrayAction" && event.GetNamedString(L"argument") == name);
        return static_cast<std::uint64_t>(event.GetNamedNumber(L"id"));
    };
    auto before = requests.size();
    invoke(0);
    co_await NextNativeFrame();
    const auto pause = checkRequest(before, L"pause");
    require(IsWindowVisible(popup) && list.GetAt(0).as<Button>().Opacity() < 1);
    before = requests.size();
    ApplyResponse(show);
    invoke(0);
    co_await NextNativeFrame();
    require(requests.size() == before && IsWindowVisible(popup));
    ApplyResponse(R"({"op":"nativeTrayState","data":{"english":false,"paused":true,"theme":"light","textScale":1,"updateReady":false}})");
    const auto finish = [](std::uint64_t id, bool ok) {
        ApplyResponse("{\"op\":\"nativeTrayAction\",\"id\":" + std::to_string(id) +
            (ok ? ",\"data\":{}}" : ",\"error\":\"fixture\"}"));
    };
    finish(pause, true);
    require(IsWindowVisible(popup) && list.GetAt(0).as<Button>().Opacity() == 1 &&
        Automation::AutomationProperties::GetName(list.GetAt(0)) == L"恢复记录, 已暂停");
    stage = 27809;
    before = requests.size(); invoke(3); co_await NextNativeFrame();
    const auto settings = checkRequest(before, L"settings");
    const auto position = JsonObject::Parse(winrt::to_hstring(requests.back()));
    RECT bounds{};
    require(GetWindowRect(popup, &bounds) &&
        position.GetNamedNumber(L"x") == (bounds.left + bounds.right) / 2 &&
        position.GetNamedNumber(L"y") == (bounds.top + bounds.bottom) / 2);
    finish(settings, false);
    require(IsWindowVisible(popup));
    before = requests.size(); invoke(2); co_await NextNativeFrame();
    finish(checkRequest(before, L"showMain"), true);
    require(!IsWindowVisible(popup));
    stage = 27810;
    ApplyResponse(show);
    SendMessageW(popup, WM_KEYDOWN, VK_ESCAPE, 0);
    require(!IsWindowVisible(popup));
    ApplyResponse(show);
    // The opening callback can belong to the shell, not the dock window.
    SendMessageW(popup, WM_ACTIVATE, WA_INACTIVE, 0);
    require(!IsWindowVisible(popup) && !IsWindowVisible(g_panel.window) && tray.Handle() == popup);
    g_panel.trayWindow.reset();
}

winrt::Windows::Foundation::IAsyncAction CheckMenuOpeningFocus(std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    stage = 27900;
    SetVisible(true, true, false);
    g_tagIds = {7}; g_tagNames = {L"Focus fixture"}; RebuildTagFilter();
    ApplyFilters(JsonArray::Parse(LR"([{"id":"focus-fixture","name":"Focus filter","filter":{}}])"));
    auto response = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"focus-record","itemType":"Text","previewText":"Synthetic"}],"hasMore":false}})");
    response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
    ApplyResponse(winrt::to_string(response.Stringify()));
    winrt::check_hresult(g_panel.rows.size() == 1 ? S_OK : E_FAIL);
    const auto invisible = [](Media::Brush const &brush) {
        const auto solid = brush.try_as<Media::SolidColorBrush>();
        return solid && solid.Color().A == 0;
    };
    const auto postKey = [](UINT key) {
        // Post only to the test panel's own input site, never to the desktop.
        HWND target = GetFocus();
        if (!target) EnumChildWindows(g_panel.window, [](HWND child, LPARAM result) -> BOOL {
            wchar_t kind[64]{};
            if (!GetClassNameW(child, kind, 64) || std::wstring_view{kind} != L"InputSiteWindowClass") return TRUE;
            *reinterpret_cast<HWND *>(result) = child;
            return FALSE;
        }, reinterpret_cast<LPARAM>(&target));
        winrt::check_hresult(target && GetWindowThreadProcessId(target, nullptr) == GetCurrentThreadId() ? S_OK : E_FAIL);
        const auto bits = 1 | (MapVirtualKeyW(key, MAPVK_VK_TO_VSC) << 16) | (key == VK_DOWN ? (1u << 24) : 0);
        winrt::check_bool(PostMessageW(target, WM_KEYDOWN, key, bits));
        winrt::check_bool(PostMessageW(target, WM_KEYUP, key, bits | (3u << 30)));
    };
    const std::array<FrameworkElement, 4> origins{g_panel.addTag, g_panel.rows[0].surface,
        DynamicTab(L"focus-fixture"), DynamicTab(L"record:7")};
    for (const auto &origin : origins) {
        ++stage;
        co_await AwaitNativeLoaded(origin);
        const bool add = origin == g_panel.addTag;
        const auto menu = (add ? g_panel.addTag.Flyout()
            : origin == g_panel.rows[0].surface
                ? Controls::Primitives::FlyoutBase{EnsureCardContextMenu(g_panel.rows[0], g_hashes[0])}
                : origin.ContextFlyout()).as<MenuFlyout>();
        const auto first = menu.Items().GetAt(0);
        if (add) {
            Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(origin)
                .GetPattern(Automation::Peers::PatternInterface::Invoke)
                .as<Automation::Provider::IInvokeProvider>().Invoke();
        } else menu.ShowAt(origin, {8, 8});
        co_await NextNativeFrame();
        co_await AwaitNativeLoaded(first);
        const bool hidden = invisible(first.FocusVisualPrimaryBrush()) && invisible(first.FocusVisualSecondaryBrush());
        std::fprintf(stderr, "WinUI command focus: stage=%u open=%d focus=%d hidden=%d\n", stage, menu.IsOpen(),
            static_cast<int>(first.FocusState()), hidden);
        winrt::check_hresult(menu.IsOpen() && first.UseSystemFocusVisuals() && hidden ? S_OK : E_FAIL);
        if (add) {
            // Deliberately request late keyboard focus once the real popup is
            // loaded. The visual stays hidden until a real navigation event.
            winrt::check_hresult(first.Focus(FocusState::Keyboard) ? S_OK : E_FAIL);
            co_await NextNativeFrame();
            winrt::check_hresult(first.FocusState() == FocusState::Keyboard &&
                invisible(first.FocusVisualPrimaryBrush()) ? S_OK : E_FAIL);
            postKey(VK_DOWN);
            const auto second = menu.Items().GetAt(1);
            for (int frame = 0; frame < 30 && second.FocusState() != FocusState::Keyboard; ++frame) co_await NextNativeFrame();
            std::fprintf(stderr, "WinUI command focus after Down: second=%d visible=%d\n",
                static_cast<int>(second.FocusState()), !invisible(second.FocusVisualPrimaryBrush()));
            winrt::check_hresult(menu.IsOpen() && second.FocusState() == FocusState::Keyboard &&
                !invisible(second.FocusVisualPrimaryBrush()) && !invisible(second.FocusVisualSecondaryBrush()) ? S_OK : E_FAIL);
            postKey(VK_ESCAPE);
            for (int frame = 0; frame < 30 && menu.IsOpen(); ++frame) co_await NextNativeFrame();
            winrt::check_hresult(!menu.IsOpen() ? S_OK : E_FAIL);
        }
        co_await CloseNativeFlyout(menu);
        winrt::check_hresult(!invisible(first.FocusVisualPrimaryBrush()) && !invisible(first.FocusVisualSecondaryBrush()) ? S_OK : E_FAIL);
    }
    ++stage;
    const auto add = g_panel.addTag;
    const auto menu = add.Flyout().as<MenuFlyout>();
    winrt::check_hresult(add.Focus(FocusState::Keyboard) ? S_OK : E_FAIL);
    postKey(VK_SPACE);
    for (int frame = 0; frame < 30 && !menu.IsOpen(); ++frame) co_await NextNativeFrame();
    const auto first = menu.Items().GetAt(0);
    co_await AwaitNativeLoaded(first);
    std::fprintf(stderr, "WinUI keyboard open: state=%d visible=%d\n",
        static_cast<int>(first.FocusState()), !invisible(first.FocusVisualPrimaryBrush()));
    // An inactive test island may not assign initial focus. This test checks
    // whether the actual keyboard opening preserves the system brushes.
    winrt::check_hresult(menu.IsOpen() && first.UseSystemFocusVisuals() &&
        !invisible(first.FocusVisualPrimaryBrush()) && !invisible(first.FocusVisualSecondaryBrush()) ? S_OK : E_FAIL);
    co_await CloseNativeFlyout(menu);
}

// Runs with the shell suite's recording bridge: no clipboard, database or paste target.
winrt::Windows::Foundation::IAsyncAction CheckSearchSendFailure(const std::vector<std::string> &requests, std::uint32_t &stage) {
    using namespace winrt::Windows::Data::Json;
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace vpaste::winui;
    const auto result = [](const wchar_t *payload, std::uint64_t id = 0) {
        auto response = JsonObject::Parse(payload);
        response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id ? id : g_latestQueryId)));
        ApplyResponse(winrt::to_string(response.Stringify()));
    };
    const auto enter = [] { (void)HandleMainKey({.key=VK_RETURN, .area=InputArea::Search}); };
    const auto pastes = [&] {
        std::vector<std::wstring> hashes;
        for (const auto &bytes : requests) {
            const auto message = JsonObject::Parse(winrt::to_hstring(bytes));
            if (message.GetNamedString(L"op") == L"paste") hashes.emplace_back(message.GetNamedString(L"hash"));
        }
        return hashes;
    };
    ShowSearch();
    winrt::check_hresult(g_panel.searchButton.Visibility() == Visibility::Collapsed &&
        g_panel.searchField.Children().Size() == 1 && g_panel.search.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
    stage = 301;
    SetSearchText(L"phase-one A"); RequestHistory();
    result(LR"({"op":"query","data":{"items":[{"hash":"synthetic-A","itemType":"Text"}]}})");
    enter();
    const auto before = pastes();
    winrt::check_hresult(before == std::vector<std::wstring>{L"synthetic-A"} ? S_OK : E_FAIL);
    {
        // P0-1 防闪验证：① 250ms 内快速返回的查询全程不显示蓝条；② 超过 250ms 未返回时显示并开启不确定动画，返回后立即隐藏停用。
        const winrt::apartment_context ui;
        RequestHistory();
        winrt::check_hresult(g_panel.loading.Visibility() == Visibility::Collapsed &&
            !g_panel.loading.IsIndeterminate() && g_loadingTimer && g_loadingTimer.IsRunning() ? S_OK : E_FAIL);
        result(LR"({"op":"query","data":{"items":[{"hash":"synthetic-A","itemType":"Text"}]}})");
        winrt::check_hresult(g_panel.loading.Visibility() == Visibility::Collapsed &&
            !g_panel.loading.IsIndeterminate() && !g_loadingTimer.IsRunning() ? S_OK : E_FAIL);
        RequestHistory();
        co_await winrt::resume_after(std::chrono::milliseconds(350));
        co_await ui;
        for (int frame = 0; frame < 10 && g_panel.loading.Visibility() != Visibility::Visible; ++frame)
            co_await NextNativeFrame();
        std::fprintf(stderr, "WinUI loading delay probe: vis=%d indet=%d running=%d searching=%d hashes=%zu\n",
            g_panel.loading.Visibility() == Visibility::Visible ? 1 : 0,
            g_panel.loading.IsIndeterminate() ? 1 : 0,
            g_loadingTimer && g_loadingTimer.IsRunning() ? 1 : 0,
            IsHistorySearching() ? 1 : 0,
            g_hashes.size());
        winrt::check_hresult(g_panel.loading.Visibility() == Visibility::Visible &&
            g_panel.loading.IsIndeterminate() ? S_OK : E_FAIL);
        result(LR"({"op":"query","data":{"items":[{"hash":"synthetic-A","itemType":"Text"}]}})");
        winrt::check_hresult(g_panel.loading.Visibility() == Visibility::Collapsed &&
            !g_panel.loading.IsIndeterminate() && !g_loadingTimer.IsRunning() ? S_OK : E_FAIL);
    }
    stage = 302;
    RequestHistory(); // A refresh is still outstanding when B fails to dispatch.
    // Exceed the real send budget, keeping the callback installed to catch an
    // accidental paste. A and B never refer to the same synthetic record.
    SetSearchText(winrt::hstring{L"phase-one B " + std::wstring(MaxRequestBytes, L'b')});
    const auto beforeFailure = g_latestQueryId;
    winrt::check_hresult(g_panel.loading.Visibility() == Visibility::Collapsed &&
        !g_panel.loading.IsIndeterminate() && g_loadingTimer && g_loadingTimer.IsRunning() ? S_OK : E_FAIL);
    enter();
    const auto afterFailure = pastes();
    if (afterFailure.size() > before.size()) std::fprintf(stderr, "WinUI search send failure pasted %s\n",
        winrt::to_string(afterFailure.back()).c_str());
    winrt::check_hresult(g_latestQueryId == beforeFailure && afterFailure == before && !g_searchSubmitRequestId ? S_OK : E_FAIL);
    result(LR"({"op":"query","data":{"items":[{"hash":"late-A","itemType":"Text"}]}})", beforeFailure);
    winrt::check_hresult(g_panel.staleHistory.IsOpen() && g_panel.staleHistory.ActionButton().IsEnabled() &&
        g_hashes == before && !PointerHistoryAllowed() ? S_OK : E_FAIL);
    const auto beforeStaleAction = requests.size();
    DeleteCard(L"synthetic-A");
    for (auto op : {L"paste", L"pastePlain", L"quickPaste", L"delete"}) (void)SendRequest(op, L"synthetic-A");
    winrt::check_hresult(requests.size() == beforeStaleAction ? S_OK : E_FAIL);
    stage = 303;
    SetSearchText(L"phase-one B"); enter();
    result(LR"({"op":"query","data":{"items":[{"hash":"synthetic-B","itemType":"Text"}]}})");
    winrt::check_hresult(pastes() == std::vector<std::wstring>{L"synthetic-A", L"synthetic-B"} ? S_OK : E_FAIL);
    stage = 304;
    SetSearchText(L"phase-one no match"); enter();
    result(LR"({"op":"query","data":{"items":[]}})");
    enter();
    winrt::check_hresult(pastes().size() == 2 && !g_searchSubmitRequestId &&
        g_panel.resetFilters.Visibility() == Visibility::Visible && !g_panel.staleHistory.IsOpen() ? S_OK : E_FAIL);
    stage = 305;
    SetSearchText(winrt::hstring{std::wstring(MaxRequestBytes, L'c')});
    enter();
    winrt::check_hresult(pastes().size() == 2 && !g_searchSubmitRequestId && g_panel.emptyState.Visibility() == Visibility::Visible &&
        g_panel.retry.Visibility() == Visibility::Visible && g_panel.resetFilters.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    stage = 306;
    SetSearchText(L"draft"); enter();
    const auto previous = g_latestQueryId;
    SearchCompositionChanged(true, L"candidate");
    const auto beforeComposition = requests.size();
    enter(); RequestHistory();
    winrt::check_hresult(!HandleMainKey({.key=VK_ESCAPE, .area=InputArea::Search, .searchHasText=true}) &&
        requests.size() == beforeComposition && !g_searchSubmitRequestId ? S_OK : E_FAIL);
    SearchCompositionChanged(false, L"draft"); // Same text as the retired request.
    result(LR"({"op":"query","data":{"items":[{"hash":"late-draft","itemType":"Text"}]}})", previous);
    winrt::check_hresult(g_hashes.empty() && g_searchTimer.IsRunning() ? S_OK : E_FAIL);
    enter();
    result(LR"({"op":"query","error":"Controlled query failure"})");
    winrt::check_hresult(pastes().size() == 2 && !g_searchSubmitRequestId && g_panel.retry.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
    stage = 307;
    RequestHistory(); enter(); // A retry can succeed after a deferred Enter is canceled.
    (void)HandleMainKey({.key=VK_ESCAPE, .area=InputArea::Other, .searchHasText=true});
    result(LR"({"op":"query","data":{"items":[{"hash":"canceled","itemType":"Text"}]}})");
    winrt::check_hresult(SearchText().empty() && g_hashes.empty() && !g_searchSubmitRequestId &&
        g_panel.search.Visibility() == Visibility::Visible && pastes().size() == 2 ? S_OK : E_FAIL);
    (void)HandleMainKey({.key=VK_ESCAPE, .repeated=true, .area=InputArea::Other});
    winrt::check_hresult(g_panel.search.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
    (void)HandleMainKey({.key=VK_ESCAPE, .area=InputArea::Other});
    RequestHistory(); result(LR"({"op":"query","data":{"items":[]}})");
    winrt::check_hresult(g_panel.search.Visibility() == Visibility::Collapsed &&
        g_panel.emptyState.Children().GetAt(1).as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>().Text() ==
            Text(L"剪贴板还是空的", L"Your clipboard shelf is empty") ? S_OK : E_FAIL);
    stage = 308;
    RequestHistory();
    const auto twoRows = LR"({"op":"query","data":{"items":[{"hash":"synthetic-A","itemType":"Text"},{"hash":"synthetic-B","itemType":"Text"}]}})";
    result(twoRows);
    g_panel.history.SelectedIndex(-1);
    (void)HandleMainKey({.key=VK_RETURN});
    winrt::check_hresult(pastes().size() == 2 ? S_OK : E_FAIL);
    g_panel.history.SelectedIndex(1);
    RequestHistory();
    const auto beforeRefreshAction = requests.size();
    DeleteCard(L"synthetic-B");
    (void)SendRequest(L"paste", L"synthetic-B");
    winrt::check_hresult(requests.size() == beforeRefreshAction ? S_OK : E_FAIL);
    (void)HandleMainKey({.key=VK_RETURN});
    result(LR"({"op":"query","data":{"items":[{"hash":"synthetic-A","itemType":"Text"}]}})");
    winrt::check_hresult(pastes().size() == 2 && !g_searchSubmitRequestId ? S_OK : E_FAIL);
    RequestHistory(); result(twoRows);
    g_panel.history.SelectedIndex(1);
    (void)HandleMainKey({.key=VK_RETURN});
    winrt::check_hresult(pastes().size() == 3 && pastes().back() == L"synthetic-B" ? S_OK : E_FAIL);
    RequestHistory();
    (void)HandleMainKey({.key=VK_RETURN, .shift=true});
    result(twoRows);
    const auto plain = JsonObject::Parse(winrt::to_hstring(requests.back()));
    winrt::check_hresult(plain.GetNamedString(L"op") == L"pastePlain" && plain.GetNamedString(L"hash") == L"synthetic-B" ? S_OK : E_FAIL);
    (void)HandleMainKey({.key='1', .alt=true});
    const auto quick = JsonObject::Parse(winrt::to_hstring(requests.back()));
    winrt::check_hresult(quick.GetNamedString(L"op") == L"quickPaste" && quick.GetNamedString(L"hash") == L"synthetic-A" ? S_OK : E_FAIL);
    stage = 309;
    ToggleQueueSelectionMode();
    RequestHistory(); enter(); result(twoRows);
    winrt::check_hresult(pastes().size() == 3 && g_queueSelectedHashes == std::vector<std::wstring>{L"synthetic-A"} ? S_OK : E_FAIL);
    ToggleQueueSelectionMode();
    stage = 310;
    ShowSearch(); SetSearchText(L"tag:Work");
    SelectBuiltinCategory(1); enter();
    result(LR"({"op":"query","error":"Controlled filter failure"})");
    const auto failed = g_latestQueryId;
    const auto invoke = [](Controls::Button const &button) {
        Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(button)
            .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
    };
    co_await NextNativeFrame();
    invoke(g_panel.staleHistory.ActionButton().as<Controls::Button>());
    co_await NextNativeFrame();
    winrt::check_hresult(g_latestQueryId > failed && !g_searchSubmitRequestId && g_historyLoading && !g_panel.staleHistory.IsOpen() ? S_OK : E_FAIL);
    const auto retry = JsonObject::Parse(winrt::to_hstring(requests.back()));
    winrt::check_hresult(retry.GetNamedString(L"op") == L"query" && retry.GetNamedString(L"query") == L"tag:Work" &&
        retry.GetNamedString(L"filter") == L"favorite" ? S_OK : E_FAIL);
    result(LR"({"op":"query","data":{"items":[]}})");
    co_await NextNativeFrame();
    invoke(g_panel.resetFilters);
    co_await NextNativeFrame();
    winrt::check_hresult(SearchText().empty() && FilterIndex() == 0 && pastes().size() == 3 ? S_OK : E_FAIL);
    enter();
    result(LR"({"op":"query","data":{"items":"invalid"}})");
    winrt::check_hresult(g_historyFailed && !g_searchSubmitRequestId &&
        g_panel.retry.Visibility() == Visibility::Visible && pastes().size() == 3 ? S_OK : E_FAIL);
    const auto inSearch = [] {
        return MainInputArea(Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot())) == vpaste::winui::InputArea::Search;
    };
    stage = 311;
    ShowSearch();
    for (int frame = 0; frame < 30 && !inSearch(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(inSearch() ? S_OK : E_FAIL);
    RequestHistory(); enter();
    winrt::check_hresult(g_searchSubmitRequestId == g_latestQueryId && g_searchSubmitRequestId ? S_OK : E_FAIL);
    g_panel.settings.Focus(FocusState::Keyboard);
    for (int frame = 0; frame < 30 && (inSearch() || g_searchSubmitRequestId); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(g_panel.search.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
    result(twoRows);
    winrt::check_hresult(!g_searchSubmitRequestId && pastes().size() == 3 ? S_OK : E_FAIL);
    stage = 312;
    ShowSearch(); SetSearchText(L"phase-one B");
    for (int frame = 0; frame < 30 && !inSearch(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(inSearch() ? S_OK : E_FAIL);
    enter();
    const auto beforeBlur = pastes().size();
    g_panel.settings.Focus(FocusState::Keyboard);
    for (int frame = 0; frame < 30 && (inSearch() || g_searchSubmitRequestId); ++frame) co_await NextNativeFrame();
    result(twoRows);
    const bool canceledOnFocusChange = g_panel.search.Visibility() == Visibility::Visible && pastes().size() == beforeBlur;
    ShowSearch(); RequestHistory(); enter();
    const auto beforeDeactivate = pastes().size();
    SendMessageW(g_panel.window, WM_ACTIVATE, WA_INACTIVE, 0);
    result(twoRows);
    const bool canceledOnDeactivate = pastes().size() == beforeDeactivate;
    ShowSearch(); RequestHistory(); enter();
    const auto beforeOcr = pastes().size();
    ApplyResponse(R"({"id":0,"op":"imageOcrUpdated","data":{}})");
    const auto firstRefresh = g_latestQueryId;
    SendMessageW(g_panel.window, kRefreshHistory, 0, 0);
    result(twoRows, firstRefresh);
    const auto afterOldReply = pastes().size();
    result(LR"({"op":"query","data":{"items":[{"hash":"synthetic-B","itemType":"Text"}]}})");
    const auto finalPastes = pastes();
    const bool followedRefresh = afterOldReply == beforeOcr && finalPastes.size() == beforeOcr + 1 && finalPastes.back() == L"synthetic-B";
    std::fprintf(stderr, "WinUI deferred Enter: fieldBlurCanceled=%d deactivationCanceled=%d latestRefreshPasted=%d\n",
        canceledOnFocusChange, canceledOnDeactivate, followedRefresh);
    winrt::check_hresult(canceledOnFocusChange && canceledOnDeactivate && followedRefresh ? S_OK : E_FAIL);
    stage = 313;
    SetQueueViewActive(true);
    RequestHistory(); enter();
    winrt::check_hresult(g_queueSelectionMode && g_queueSelectedHashes.empty() && g_searchSubmitRequestId ? S_OK : E_FAIL);
    const auto beforeQueueExit = pastes().size();
    SetQueueViewActive(false);
    result(twoRows);
    winrt::check_hresult(!g_queueSelectionMode && !g_searchSubmitRequestId && pastes().size() == beforeQueueExit ? S_OK : E_FAIL);
    RequestHistory(); enter();
    SetQueueViewActive(true);
    result(twoRows);
    winrt::check_hresult(g_queueSelectionMode && !g_searchSubmitRequestId && g_queueSelectedHashes.empty() ? S_OK : E_FAIL);
    SetQueueViewActive(false);
}

winrt::fire_and_forget RunNativeShellRegression(
    std::shared_ptr<std::promise<std::pair<HRESULT, std::uint32_t>>> completion) {
    std::uint32_t stage = 1;
    std::fprintf(stderr, "WinUI shell: starting control scenarios\n");
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
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_SEARCH_CHECK", nullptr, 0)) {
            co_await CheckSearchSendFailure(requests, stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_MENU_FOCUS_CHECK", nullptr, 0)) {
            co_await CheckMenuOpeningFocus(stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_TRAY_CHECK", nullptr, 0)) {
            co_await CheckNativeTray(requests, stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_CARD_EDITORS_CHECK", nullptr, 0)) {
            Border fixture;
            g_panel.xamlSource.Content(fixture); ResizeIsland();
            co_await vpaste::winui::TestRecordTagEditorControls(fixture, stage);
            co_await vpaste::winui::TestFilterEditorControls(fixture, stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_CARD_MENU_CHECK", nullptr, 0)) {
            co_await CheckCardContextMenu(requests, stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_EDITOR_OPEN_CHECK", nullptr, 0)) {
            stage = 320;
            WindowProc(g_panel.window, kSetLanguage, true, 0);
            ApplyResponse(R"({"op":"nativeEditorOpen","data":{"generation":90,"kind":"editor","error":"editor.missing",
                "rect":{"x":80,"y":80,"width":420,"height":350},"durationMs":0,"easing":[0,0,1,1]}})");
            winrt::check_hresult(!g_panel.textEditor && g_panel.feedback.IsOpen() &&
                g_panel.feedback.Message() == L"The original clipboard record is no longer available." &&
                std::any_of(requests.begin(), requests.end(), [](auto const &bytes) {
                    const auto request = JsonObject::Parse(winrt::to_hstring(bytes));
                    return request.GetNamedString(L"op") == L"nativeEditorClose" && request.GetNamedString(L"argument") == L"90";
                }) ? S_OK : E_FAIL);
            stage = 324;
            RequestHistory();
            auto rows = JsonObject::Parse(LR"({"op":"query","data":{"items":[
                {"id":40,"hash":"edited-a","itemType":"Text","previewText":"Original A"},
                {"id":41,"hash":"other-b","itemType":"Text","previewText":"Other B"}]}})");
            rows.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
            ApplyResponse(winrt::to_string(rows.Stringify()));
            const auto open = SendRequest(L"edit", L"edited-a");
            winrt::check_hresult(open && !SendRequest(L"edit", L"other-b") ? S_OK : E_FAIL);
            ApplyResponse(R"({"op":"nativeEditorOpen","data":{"generation":91,"kind":"editor","text":"Original A",
                "rect":{"x":80,"y":80,"width":420,"height":350},"durationMs":0,"easing":[0,0,1,1]}})");
            auto ack = JsonObject::Parse(LR"({"op":"edit","data":{}})");
            ack.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(open)));
            ApplyResponse(winrt::to_string(ack.Stringify()));
            g_panel.history.SelectedIndex(1);
            ApplyResponse(R"({"op":"clipboardItemEdited","data":{"previousHash":"edited-a","hash":"saved-a"}})");
            ApplyResponse(R"({"op":"nativeEditorClosed","data":{"generation":90}})");
            winrt::check_hresult(g_panel.textEditor && g_selectedHash == L"other-b" ? S_OK : E_FAIL);
            ApplyResponse(R"({"op":"nativeEditorClosed","data":{"generation":91}})");
            winrt::check_hresult(!g_panel.textEditor && g_selectedHash == L"saved-a" &&
                g_panel.history.SelectedIndex() == 0 ? S_OK : E_FAIL);
            const auto refresh = [](JsonArray const &items) {
                JsonObject response, data;
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                response.Insert(L"op", JsonValue::CreateStringValue(L"query"));
                data.Insert(L"items", items);
                response.Insert(L"data", data);
                ApplyResponse(winrt::to_string(response.Stringify()));
            };
            for (const int scenario : {0, 1, 2}) {
                const bool save = scenario == 1, moveSelection = scenario == 2;
                stage = moveSelection ? 329 : save ? 326 : 325;
                SetSearchText(L"editor start"); RequestHistory();
                const auto visible = JsonArray::Parse(LR"([
                    {"id":41,"hash":"other-b","itemType":"Text"},
                    {"id":40,"hash":"return-a","itemType":"Text"},
                    {"id":42,"hash":"other-c","itemType":"Text"}])");
                refresh(visible);
                const auto edit = SendRequest(L"edit", L"return-a");
                winrt::check_hresult(edit ? S_OK : E_FAIL);
                auto editor = JsonObject::Parse(LR"({"op":"nativeEditorOpen","data":{"kind":"editor","text":"Original A",
                    "rect":{"x":80,"y":80,"width":420,"height":350},"durationMs":0,"easing":[0,0,1,1]}})");
                const auto generation = JsonValue::CreateNumberValue(save ? 93 : 92);
                editor.GetNamedObject(L"data").Insert(L"generation", generation);
                ApplyResponse(winrt::to_string(editor.Stringify()));
                ack.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(edit)));
                ApplyResponse(winrt::to_string(ack.Stringify()));
                SetSearchText(L"only B"); RequestHistory();
                JsonArray filtered;
                filtered.Append(visible.GetAt(0));
                filtered.Append(visible.GetAt(2));
                refresh(filtered);
                SetSearchText(L"both records"); RequestHistory();
                if (save) {
                    ApplyResponse(R"({"op":"clipboardItemEdited","data":{"previousHash":"return-a","hash":"return-saved"}})");
                    visible.GetObjectAt(1).Insert(L"hash", JsonValue::CreateStringValue(L"return-saved"));
                }
                auto closed = JsonObject::Parse(LR"({"op":"nativeEditorClosed","data":{}})");
                closed.GetNamedObject(L"data").Insert(L"generation", generation);
                ApplyResponse(winrt::to_string(closed.Stringify()));
                if (moveSelection) g_panel.history.SelectedIndex(1);
                refresh(visible);
                const auto expected = moveSelection ? L"other-c" : save ? L"return-saved" : L"return-a";
                winrt::check_hresult(!g_panel.textEditor && g_selectedHash == expected &&
                    g_panel.history.SelectedIndex() == (moveSelection ? 2 : 1) ? S_OK : E_FAIL);
            }
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_QUEUE_FEEDBACK_CHECK", nullptr, 0)) {
            stage = 327;
            ApplyResponse(R"({"op":"queueStateUpdate","data":{"revision":10,"active":true,"items":[{"hash":"queued-a"}]}})");
            const auto root = g_panel.queueView->Root().as<Grid>();
            const auto rows = root.Children().GetAt(1).as<ScrollViewer>().Content().as<StackPanel>();
            const auto feedback = root.Children().GetAt(3).as<InfoBar>();
            g_panel.queueView->SetError(L"Reverse failed after Add");
            ApplyResponse(R"({"id":80,"op":"queueAdd","data":{"revision":10,"active":true,"items":[{"hash":"queued-a"}]}})");
            winrt::check_hresult(rows.Children().Size() == 1 && feedback.IsOpen() &&
                feedback.Message() == L"Reverse failed after Add" ? S_OK : E_FAIL);
            stage = 328;
            ApplyResponse(R"({"id":80,"op":"queueAdd","data":{"revision":11,"active":true,
                "items":[{"hash":"queued-a"},{"hash":"queued-b"}]}})");
            winrt::check_hresult(rows.Children().Size() == 2 && feedback.IsOpen() &&
                feedback.Message() == L"Reverse failed after Add" ? S_OK : E_FAIL);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_QUEUE_CHECK", nullptr, 0)) {
            stage = 321;
            WindowProc(g_panel.window, kSetLanguage, true, 0);
            RequestHistory();
            const auto result = [](const wchar_t *payload) {
                auto response = JsonObject::Parse(payload);
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(response.Stringify()));
            };
            result(LR"({"op":"query","data":{"items":[{"hash":"batch-a"},{"hash":"batch-b"}]}})");
            ToggleQueueSelectionMode();
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
            SetSearchText(L"hide selected fixture"); RequestHistory();
            result(LR"({"op":"query","data":{"items":[{"hash":"batch-b"}],"hasMore":true,"nextId":11,"nextTime":1}})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"batch-a"} && g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
            RequestMoreHistory();
            result(LR"({"op":"queryMore","data":{"items":[{"hash":"batch-c"}],"hasMore":false}})");
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"batch-a"} && g_hashes.back() == L"batch-c" ? S_OK : E_FAIL);
            AddSelectedItemsToQueue();
            const auto first = g_queueSelectionAddRequest;
            winrt::check_hresult(first && g_queueSelectionAdding ? S_OK : E_FAIL);
            ToggleQueueSelectionMode(); ToggleQueueSelectionMode();
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
            const auto activeStatus = g_panel.status.Text();
            auto staleAdd = JsonObject::Parse(LR"({"op":"queueAdd","data":{"revision":2,"items":[]}})");
            staleAdd.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(first)));
            ApplyResponse(winrt::to_string(staleAdd.Stringify()));
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"batch-b"} &&
                g_panel.queueAdd.IsEnabled() && g_panel.status.Text() == activeStatus ? S_OK : E_FAIL);
            stage = 322;
            const auto callback = std::exchange(g_request, nullptr);
            AddSelectedItemsToQueue();
            g_request = callback;
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"batch-b"} && g_panel.queueAdd.IsEnabled() &&
                !g_queueSelectionAdding && g_panel.feedback.IsOpen() &&
                g_panel.feedback.Message() == L"Could not send the queue add request. Try again." ? S_OK : E_FAIL);
            stage = 323;
            AddSelectedItemsToQueue();
            const auto sendResult = [](JsonObject response) {
                response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_queueSelectionAddRequest)));
                ApplyResponse(winrt::to_string(response.Stringify()));
            };
            sendResult(JsonObject::Parse(LR"({"op":"queueAdd","error":"Synthetic add failure"})"));
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"batch-b"} && g_panel.queueAdd.IsEnabled() &&
                g_panel.feedback.Message() == L"Synthetic add failure" ? S_OK : E_FAIL);
            AddSelectedItemsToQueue();
            g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(1));
            sendResult(JsonObject::Parse(LR"({"op":"queueAdd","data":{"revision":3,"items":[{"hash":"batch-b"}]}})"));
            winrt::check_hresult(g_queueSelectedHashes == std::vector<std::wstring>{L"batch-c"} && g_panel.queueAdd.IsEnabled() ? S_OK : E_FAIL);
            ToggleQueueSelectionMode();
            SetTagManagerActive(true);
            Border fixture;
            fixture.Padding(vpaste::winui::UniformThickness(12));
            g_panel.xamlSource.Content(fixture); ResizeIsland();
            co_await vpaste::winui::TestQueueConsolidationControls(fixture, stage);
            co_await vpaste::winui::TestQueueFailureRecoveryControls(fixture, stage);
            co_await vpaste::winui::TestQueueRowContinuityControls(fixture, stage);
            co_await vpaste::winui::TestQueuePointerReorderControls(fixture, stage);
            co_await vpaste::winui::TestQueueUndoExpiryControls(fixture, stage);
            co_await vpaste::winui::TestQueueFocusContinuityControls(fixture, stage);
            SetTagManagerActive(false);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_CARD_PREVIEW_CHECK", nullptr, 0)) {
            co_await vpaste::winui::TestCardPreviewControls(g_panel.root, stage);
            co_await CheckCardHoverScroll(stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_PREVIEW_TOOLBAR_CHECK", nullptr, 0)) {
            stage = 270;
            RequestHistory();
            auto rows = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"id":10,"hash":"ocr-fixture","itemType":"Image"}]}})");
            rows.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
            ApplyResponse(winrt::to_string(rows.Stringify()));
            MenuFlyout image;
            const auto recognize = vpaste::winui::MakeImageTextAction(L"ocr-fixture", true, SendCardAction);
            image.Items().Append(recognize);
            const auto icon = recognize.Icon().try_as<PathIcon>();
            winrt::check_hresult(icon && icon.Data() && recognize.Text() == L"Recognize text in image" ? S_OK : E_FAIL);
            image.ShowAt(g_panel.searchButton);
            co_await NextNativeFrame();
            Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(recognize)
                .GetPattern(Automation::Peers::PatternInterface::Invoke)
                .as<Automation::Provider::IInvokeProvider>().Invoke();
            co_await NextNativeFrame();
            winrt::check_hresult(!requests.empty() ? S_OK : E_FAIL);
            const auto request = JsonObject::Parse(winrt::to_hstring(requests.back()));
            winrt::check_hresult(request.GetNamedString(L"op") == L"imageText" &&
                request.GetNamedString(L"hash") == L"ocr-fixture" ? S_OK : E_FAIL);
            image.Hide();
            stage = 271;
            ApplyResponse(R"({"op":"nativeReader","data":{"generation":300,"kind":"ocr",
                "rect":{"x":80,"y":80,"width":680,"height":380},"durationMs":0,"easing":[0,0,1,1]}})");
            ApplyResponse(R"({"op":"nativeOcrState","data":{"generation":300,"record":{"status":"complete","text":"Original OCR"}}})");
            co_await NextNativeFrame();
            const auto findField = [](auto const &self, DependencyObject const &element) -> TextBox {
                if (const auto field = element.try_as<TextBox>()) return field;
                for (int i = 0; i < Media::VisualTreeHelper::GetChildrenCount(element); ++i)
                    if (const auto field = self(self, Media::VisualTreeHelper::GetChild(element, i))) return field;
                return nullptr;
            };
            const auto draft = findField(findField, g_panel.reader->TestRoot());
            winrt::check_hresult(draft ? S_OK : E_FAIL);
            draft.Text(L"Keep this OCR draft");
            const auto beforeDraft = requests.size();
            (void)SendRequest(L"panelBlur");
            (void)SendRequest(L"imageText", L"ocr-fixture");
            (void)SendRequest(L"dismiss");
            winrt::check_hresult(requests.size() == beforeDraft && g_panel.reader->HasOcrDraft() &&
                draft.Text() == L"Keep this OCR draft" && g_panel.feedback.IsOpen() ? S_OK : E_FAIL);
            ApplyResponse(R"({"op":"nativeReaderHide","data":{"generation":301}})");
            co_await NextNativeFrame();
            stage = 272;
            SetVisible(true, false, false);
            ApplyResponse(R"({"op":"nativeReader","data":{"generation":302,"kind":"ocr",
                "rect":{"x":80,"y":80,"width":680,"height":380},"durationMs":0,"easing":[0,0,1,1]}})");
            ApplyResponse(R"({"op":"nativeOcrState","data":{"generation":302,"record":{"status":"complete","text":"Original OCR"}}})");
            co_await NextNativeFrame();
            const auto hotkeyDraft = findField(findField, g_panel.reader->TestRoot());
            winrt::check_hresult(hotkeyDraft && PanelVisible() ? S_OK : E_FAIL);
            hotkeyDraft.Text(L"Keep the hotkey draft");
            WindowProc(g_panel.window, kToggleWindow, 0, 0);
            winrt::check_hresult(PanelVisible() && g_panel.reader->HasOcrDraft() &&
                hotkeyDraft.Text() == L"Keep the hotkey draft" ? S_OK : E_FAIL);
            stage = 273;
            const auto keep = g_panel.reader->TestDiscardDialog().as<ContentDialog>();
            winrt::check_hresult(keep && !keep.CloseButtonText().empty() ? S_OK : E_FAIL);
            keep.Hide();
            const auto promptDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
            while (g_panel.reader->TestDiscardDialog() && std::chrono::steady_clock::now() < promptDeadline)
                co_await NextNativeFrame();
            winrt::check_hresult(!g_panel.reader->TestDiscardDialog() && PanelVisible() &&
                g_panel.reader->HasOcrDraft() ? S_OK : E_FAIL);
            stage = 274;
            WindowProc(g_panel.window, kToggleWindow, 0, 0);
            const auto discard = g_panel.reader->TestDiscardDialog();
            winrt::check_hresult(discard ? S_OK : E_FAIL);
            const auto findButton = [](auto const &self, DependencyObject const &element, const wchar_t *name) -> Button {
                if (const auto button = element.try_as<Button>(); button && button.Name() == name) return button;
                for (int i = 0; i < Media::VisualTreeHelper::GetChildrenCount(element); ++i)
                    if (const auto button = self(self, Media::VisualTreeHelper::GetChild(element, i), name)) return button;
                return nullptr;
            };
            Button discardButton{nullptr};
            for (int frame = 0; frame < 60 && !discardButton; ++frame) {
                co_await NextNativeFrame();
                discardButton = findButton(findButton, discard, L"PrimaryButton");
            }
            winrt::check_hresult(discardButton && discardButton.IsLoaded() ? S_OK : E_FAIL);
            Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(discardButton)
                .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
            const auto hideDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
            while (PanelVisible() && std::chrono::steady_clock::now() < hideDeadline) co_await NextNativeFrame();
            winrt::check_hresult(!PanelVisible() ? S_OK : E_FAIL);
            ApplyResponse(R"({"op":"nativeReaderHide","data":{"generation":303}})");
            SetVisible(true, false, false);
            co_await NextNativeFrame();
            co_await vpaste::winui::TestReaderControls(stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_CATEGORY_BENCHMARK", nullptr, 0)) {
            co_await BenchmarkCategorySwitches(); completion->set_value({S_OK, 259}); co_return;
        }
        if (GetEnvironmentVariableW(L"VPASTE_WINUI_DESKTOP_FOLLOWUP", nullptr, 0)) {
            co_await CheckDesktopFollowup(stage);
            CheckEmptySearchFocus(requests, stage);
            completion->set_value({S_OK, stage}); co_return;
        }
        const auto search = g_panel.search;
        winrt::check_hresult(search && g_panel.searchField.Children().Size() == 1 ? S_OK : E_FAIL);
        ShowSearch();
        std::fprintf(stderr, "WinUI shell: search shown, awaiting frame\n");
        co_await NextNativeFrame();
        winrt::check_hresult(g_panel.searchButton.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
        const auto editor = search;
        winrt::check_hresult(editor && MainInputArea(editor) == vpaste::winui::InputArea::Search &&
            !NativeControlOwnsKeys(editor) ? S_OK : E_FAIL);
        editor.Focus(FocusState::Programmatic);
        editor.Text(L"d"); RequestHistory();
        const auto olderQuery = g_latestQueryId;
        editor.Text(L"dd");
        editor.Text(L"ddd");
        auto stale = JsonObject::Parse(LR"({"op":"query","data":{"items":[]}})");
        stale.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(olderQuery)));
        ApplyResponse(winrt::to_string(stale.Stringify()));
        winrt::check_hresult(editor.Text() == L"ddd" && SearchText() == L"ddd" ? S_OK : E_FAIL);
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
        stage = 111;
        const std::string ocrResponse = R"({"id":0,"op":"imageOcrUpdated","data":{}})";
        SearchCompositionChanged(true, editor.Text());
        editor.Text(L"输入法候选");
        const auto composingRequests = requests.size();
        SubmitSearch();
        ApplyResponse(ocrResponse);
        for (int frame = 0; frame < 12; ++frame) co_await NextNativeFrame();
        winrt::check_hresult(g_searchComposing && !g_searchTimer.IsRunning() && requests.size() == composingRequests &&
            SearchText() == L"输入法候选" && !g_searchSubmitRequestId ? S_OK : E_FAIL);
        SearchCompositionChanged(false, editor.Text());
        winrt::check_hresult(g_searchTimer.IsRunning() && g_searchTimer.Interval() == std::chrono::milliseconds(120) ? S_OK : E_FAIL);
        for (int frame = 0; frame < 90 && requests.size() == composingRequests; ++frame) co_await NextNativeFrame();
        winrt::check_hresult(requests.size() == composingRequests + 1 &&
            JsonObject::Parse(winrt::to_hstring(requests.back())).GetNamedString(L"query") == L"输入法候选" ? S_OK : E_FAIL);
        stage = 112;
        SetSearchText(L""); g_searchTimer.Stop();
        const auto noSearchRequests = requests.size();
        ApplyResponse(ocrResponse);
        winrt::check_hresult(requests.size() == noSearchRequests ? S_OK : E_FAIL);
        SetSearchText(L"ocr query"); g_searchTimer.Stop(); RequestHistory();
        const auto beforeOcrRefresh = g_latestQueryId;
        g_searchSubmitRequestId = beforeOcrRefresh;
        const auto pendingRequests = requests.size();
        ApplyResponse(ocrResponse);
        winrt::check_hresult(g_latestQueryId != beforeOcrRefresh &&
            g_searchSubmitRequestId == g_latestQueryId && requests.size() == pendingRequests + 1 &&
            JsonObject::Parse(winrt::to_hstring(requests.back())).GetNamedString(L"query") == L"ocr query" ? S_OK : E_FAIL);
        g_searchSubmitRequestId = 0;
        stage = 113;
        SetSearchText(L"category before debounce");
        winrt::check_hresult(g_searchTimer.IsRunning() ? S_OK : E_FAIL);
        const auto beforeCategory = requests.size();
        SelectBuiltinCategory(1);
        const auto categoryRequest = JsonObject::Parse(winrt::to_hstring(requests.back()));
        winrt::check_hresult(!g_searchTimer.IsRunning() && requests.size() == beforeCategory + 1 &&
            categoryRequest.GetNamedString(L"filter") == L"favorite" &&
            categoryRequest.GetNamedString(L"query") == L"category before debounce" ? S_OK : E_FAIL);
        SelectBuiltinCategory(0, false);
        stage = 12;
        // TextBox only exposes its clear button while it has a value.
        editor.Focus(FocusState::Programmatic);
        SetSearchText(L"Clear button fixture"); g_searchTimer.Stop();
        co_await NextNativeFrame();
        const auto clear = FindHistoryChild<Button>(editor);
        winrt::check_hresult(clear && NativeControlOwnsKeys(clear) ? S_OK : E_FAIL);
        const auto peer = Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(clear);
        const auto clearAction = peer ? peer.GetPattern(Automation::Peers::PatternInterface::Invoke)
            .try_as<Automation::Provider::IInvokeProvider>() : nullptr;
        winrt::check_hresult(clearAction ? S_OK : E_NOINTERFACE);
        clearAction.Invoke();
        co_await NextNativeFrame();
        winrt::check_hresult(SearchText().empty() && editor.Text().empty() &&
            g_searchSubmitRequestId == 0 && g_searchTimer.Interval() == std::chrono::milliseconds(40) ? S_OK : E_FAIL);
        search.Text(L"Escape test");
        stage = 13;
        HandleMainKey({.key=VK_ESCAPE, .area=vpaste::winui::InputArea::Search, .searchHasText=true});
        winrt::check_hresult(search.Text().empty() && search.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
        HandleMainKey({.key=VK_ESCAPE, .area=vpaste::winui::InputArea::Search});
        winrt::check_hresult(search.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
        // Escape posts history focus. Complete that interaction before opening
        // search again, rather than racing its queued focus handoff.
        co_await NextNativeFrame();
        winrt::check_hresult(search.Visibility() == Visibility::Collapsed ? S_OK : E_FAIL);
        stage = 131;
        const auto beforeSearchWidth = g_panel.root.ActualWidth();
        ShowSearch(); co_await NextNativeFrame();
        std::fprintf(stderr, "WinUI search feedback: widthBefore=%.2f widthAfter=%.2f visible=%d composing=%d editorLoaded=%d\n",
            beforeSearchWidth, g_panel.root.ActualWidth(), static_cast<int>(search.Visibility()), g_searchComposing, editor.IsLoaded());
        winrt::check_hresult(g_panel.root.ActualWidth() == beforeSearchWidth && search.Visibility() == Visibility::Visible &&
            !g_searchComposing ? S_OK : E_FAIL);
        stage = 1311;
        vpaste::winui::FadeFeedback(editor, false);
        winrt::check_hresult(editor.Opacity() == 1 && !editor.Resources().HasKey(winrt::box_value(vpaste::winui::FeedbackAnimationResource)) ? S_OK : E_FAIL);
        search.Visibility(Visibility::Collapsed);
        g_searchTimer.Stop();
        stage = 2;
        std::fprintf(stderr, "WinUI shell: history geometry\n");
        RequestHistory();
        std::fprintf(stderr, "WinUI shell: requested history\n");
        auto response = JsonObject::Parse(
            LR"({"op":"query","data":{"items":[{"hash":"shell-parity","itemType":"Text","previewText":"Clipboard card"}],"hasMore":false}})");
        response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
        ApplyResponse(winrt::to_string(response.Stringify()));
        std::fprintf(stderr, "WinUI shell: applied history\n");
        co_await NextNativeFrame();
        std::fprintf(stderr, "WinUI shell: history frame ready\n");
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
            outline.CornerRadius().TopLeft == kCardRadius + 4 && outline.BorderThickness().Left == 2 &&
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
        const auto commands = g_panel.commands.Children();
        winrt::check_hresult(commands.Size() == 6 && commands.GetAt(0) == g_panel.appActions->DeveloperGroup() &&
            commands.GetAt(1) == g_panel.appActions->ToolsButton() &&
            commands.GetAt(2) == g_panel.queueOpen && commands.GetAt(3) == g_panel.settings &&
            commands.GetAt(4) == g_panel.appActions->UpdateButton() &&
            g_panel.filterStrip.Children().GetAt(g_panel.filterStrip.Children().Size() - 1) == g_panel.addTag ? S_OK : E_FAIL);
        stage = 5;
        PanelLayout previewOriginalLayout{};
        winrt::check_hresult(vpaste_winui_get_layout(&previewOriginalLayout));
        auto previewLayout = previewOriginalLayout;
        ++previewLayout.x;
        winrt::check_hresult(vpaste_winui_set_preview_layout(&previewLayout));
        PanelLayout appliedPreviewLayout{};
        winrt::check_hresult(vpaste_winui_get_layout(&appliedPreviewLayout));
        winrt::check_hresult(appliedPreviewLayout.x == previewLayout.x ? S_OK : E_FAIL);
        winrt::check_hresult(vpaste_winui_set_preview_layout(&previewOriginalLayout));
        const bool wasVisible = IsWindowVisible(g_panel.window) != FALSE;
        const bool wasHitTestVisible = g_panel.root.IsHitTestVisible();
        const HWND foregroundBeforePreview = GetForegroundWindow();
        winrt::check_hresult(vpaste_winui_size_preview(true, false));
        winrt::check_hresult(IsWindowVisible(g_panel.window) && !g_panel.root.IsHitTestVisible() &&
            GetForegroundWindow() == foregroundBeforePreview &&
            WindowProc(g_panel.window, WM_NCHITTEST, 0, 0) == HTTRANSPARENT
            ? S_OK : E_FAIL);
        winrt::check_hresult(vpaste_winui_size_preview(false, wasVisible));
        winrt::check_hresult((IsWindowVisible(g_panel.window) != FALSE) == wasVisible &&
            g_panel.root.IsHitTestVisible() == wasHitTestVisible ? S_OK : E_FAIL);
        winrt::check_hresult(WindowProc(g_panel.window, WM_NCHITTEST, 0, 0) == HTCLIENT ? S_OK : E_FAIL);
        const winrt::apartment_context ui;
        for (int tick = 0; tick < 60 && g_panel.dockMotion->Running(); ++tick) {
            co_await winrt::resume_after(std::chrono::milliseconds(16)); co_await ui;
        }
        RECT outer{}, client{};
        winrt::check_bool(GetWindowRect(g_panel.window, &outer) && GetClientRect(g_panel.window, &client));
        winrt::check_hresult((GetWindowLongPtrW(g_panel.window, GWL_STYLE) & WS_THICKFRAME) &&
            outer.right - outer.left == client.right && outer.bottom - outer.top == client.bottom &&
            g_panel.header.Shadow() && g_panel.searchButton.Shadow() && !g_panel.rows[0].tagChip.IsHitTestVisible() ? S_OK : E_FAIL);
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
        for (const auto &command : {g_panel.queueOpen, g_panel.settings}) {
            const auto icon = command.Content().as<PathIcon>();
            const auto bounds = icon.TransformToVisual(command).TransformBounds(
                {0, 0, static_cast<float>(icon.ActualWidth()), static_cast<float>(icon.ActualHeight())});
            std::fprintf(stderr, "WinUI toolbar icon center: x=%.1f y=%.1f command=%.1fx%.1f\n",
                bounds.X + bounds.Width / 2, bounds.Y + bounds.Height / 2, command.ActualWidth(), command.ActualHeight());
            winrt::check_hresult(std::abs(bounds.X + bounds.Width / 2 - command.ActualWidth() / 2) <= 1 &&
                std::abs(bounds.Y + bounds.Height / 2 - command.ActualHeight() / 2) <= 1 ? S_OK : E_FAIL);
        }
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
        winrt::check_hresult(spring.DampingRatio() >= 0.83f && spring.DampingRatio() <= 0.89f &&
            spring.Period() >= std::chrono::milliseconds(110) && spring.Period() <= std::chrono::milliseconds(135) ? S_OK : E_FAIL);
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
        stage = 16;
        // Material artwork uses a 24-unit canvas. Merely setting PathIcon's
        // Width/Height clips its geometry instead of scaling that canvas.
        {
            const auto icon = g_panel.settings.Content().as<PathIcon>();
            Media::Imaging::RenderTargetBitmap bitmap;
            co_await bitmap.RenderAsync(icon);
            const auto buffer = co_await bitmap.GetPixelsAsync();
            std::vector<std::uint8_t> pixels(buffer.Length());
            winrt::Windows::Storage::Streams::DataReader::FromBuffer(buffer).ReadBytes(pixels);
            double weight = 0, centerX = 0, centerY = 0;
            for (int y = 0; y < bitmap.PixelHeight(); ++y) for (int x = 0; x < bitmap.PixelWidth(); ++x) {
                const auto alpha = pixels[(y * bitmap.PixelWidth() + x) * 4 + 3];
                weight += alpha; centerX += (x + 0.5) * alpha; centerY += (y + 0.5) * alpha;
            }
            winrt::check_hresult(weight > 0 ? S_OK : E_FAIL);
            std::fprintf(stderr, "WinUI settings artwork: size=%dx%d center=%.2f,%.2f\n",
                bitmap.PixelWidth(), bitmap.PixelHeight(), centerX / weight, centerY / weight);
            winrt::check_hresult(std::abs(centerX / weight - bitmap.PixelWidth() / 2.0) < 0.8 &&
                std::abs(centerY / weight - bitmap.PixelHeight() / 2.0) < 0.8 ? S_OK : E_FAIL);
        }
        g_tagIds = {10, 11, 12, 13};
        g_tagNames = {L"工作", L"A very long saved tag name", L"设计与资料", L"Project references"};
        RebuildTagFilter();
        winrt::Windows::Storage::StorageFolder artifactFolder{nullptr};
        wchar_t artifactDirectory[MAX_PATH]{};
        const auto artifactLength = GetEnvironmentVariableW(L"VPASTE_WINUI_ARTIFACT_DIR", artifactDirectory, MAX_PATH);
        if (artifactLength > 0) {
            winrt::check_hresult(artifactLength < MAX_PATH ? S_OK : E_INVALIDARG);
            artifactFolder = co_await winrt::Windows::Storage::StorageFolder::GetFolderFromPathAsync(artifactDirectory);
        }
        for (const bool english : {false, true}) for (const auto theme : {1, 2}) for (const float width : {640.0f, 960.0f}) {
            stage = 1601;
            WindowProc(g_panel.window, kSetLanguage, english, 0);
            WindowProc(g_panel.window, kSetTheme, theme, 0);
            g_panel.root.Width(width);
            UpdateSearchWidth();
            co_await NextNativeFrame(); co_await NextNativeFrame();
            g_panel.root.UpdateLayout();
            std::vector<SelectorBarItem> tabs{g_panel.filter.Items().GetAt(0), g_panel.filter.Items().GetAt(1)};
            for (auto const &tab : g_panel.customTabs.Items()) tabs.push_back(tab);
            float previousRight = 0;
            bool first = true;
            for (auto const &tab : tabs) {
                const auto label = FindHistoryChild<TextBlock>(tab);
                winrt::check_hresult(label && label.ActualHeight() > 0 ? S_OK : E_FAIL);
                const auto labelBounds = label.TransformToVisual(tab).TransformBounds(
                    {0, 0, static_cast<float>(label.ActualWidth()), static_cast<float>(label.ActualHeight())});
                const auto error = std::abs(labelBounds.Y + labelBounds.Height / 2 - kHeaderHeight / 2);
                if (error > 1.5) std::fprintf(stderr, "WinUI tab centering: height=%.1f labelY=%.1f labelH=%.1f error=%.1f\n",
                    tab.ActualHeight(), labelBounds.Y, labelBounds.Height, error);
                winrt::check_hresult(std::abs(tab.ActualHeight() - kHeaderHeight) <= 0.5 && error <= 1.5 &&
                    label.TextWrapping() == TextWrapping::NoWrap ? S_OK : E_FAIL);
                const auto bounds = tab.TransformToVisual(g_panel.filterStrip).TransformBounds(
                    {0, 0, static_cast<float>(tab.ActualWidth()), static_cast<float>(tab.ActualHeight())});
                if (!first && std::abs(bounds.X - previousRight - 8) > 0.5)
                    std::fprintf(stderr, "WinUI tab gap: previousRight=%.1f nextX=%.1f\n", previousRight, bounds.X);
                winrt::check_hresult((first || std::abs(bounds.X - previousRight - 8) <= 0.5) &&
                    tab.ActualWidth() <= vpaste::winui::TabMaxWidth + 0.5 ? S_OK : E_FAIL);
                previousRight = bounds.X + bounds.Width; first = false;
            }
            const auto addPosition = g_panel.addTag.TransformToVisual(g_panel.filterStrip).TransformPoint({0, 0});
            stage = 1602;
            winrt::check_hresult(std::abs(addPosition.X - previousRight - 8) <= 0.5 ? S_OK : E_FAIL);
            g_panel.customTabs.SelectedItem(tabs.back());
            BringSelectedTabIntoView(g_panel.customTabs);
            co_await NextNativeFrame(); co_await NextNativeFrame();
            const auto selectedBounds = tabs.back().TransformToVisual(g_panel.filterScroll).TransformBounds(
                {0, 0, static_cast<float>(tabs.back().ActualWidth()), static_cast<float>(kHeaderHeight)});
            stage = 1603;
            if (selectedBounds.X < -0.5 || selectedBounds.X + selectedBounds.Width > g_panel.filterScroll.ViewportWidth() + 0.5)
                std::fprintf(stderr, "WinUI selected tab viewport: english=%d theme=%d width=%.0f bounds=%.1f,%.1f viewport=%.1f offset=%.1f max=%.1f\n",
                    english, theme, width, selectedBounds.X, selectedBounds.Width,
                    g_panel.filterScroll.ViewportWidth(), g_panel.filterScroll.HorizontalOffset(), g_panel.filterScroll.ScrollableWidth());
            winrt::check_hresult(selectedBounds.X >= -0.5 &&
                selectedBounds.X + selectedBounds.Width <= g_panel.filterScroll.ViewportWidth() + 0.5 ? S_OK : E_FAIL);
            const auto root = Media::VisualTreeHelper::GetChild(tabs.back(), 0).as<Grid>();
            stage = 1604;
            winrt::check_hresult(root.FindName(L"PART_SelectionVisual").as<UIElement>().Visibility() == Visibility::Collapsed &&
                g_panel.tabIndicator->Target().Height == kHeaderHeight ? S_OK : E_FAIL);
            const auto selectedLabel = root.FindName(L"PART_TextVisual").as<TextBlock>();
            VisualStateManager::GoToState(tabs.back(), L"SelectedNormal", false);
            co_await NextNativeFrame();
            const auto selectedColor = selectedLabel.Foreground().as<Media::SolidColorBrush>().Color();
            const auto indicatorColor = g_panel.tabIndicatorHost.BorderBrush().as<Media::SolidColorBrush>().Color();
            stage = 1605;
            if (selectedColor != indicatorColor) std::fprintf(stderr,
                "WinUI selected tab: rgb=%u,%u,%u expected=%u,%u,%u\n",
                selectedColor.R, selectedColor.G, selectedColor.B,
                indicatorColor.R, indicatorColor.G, indicatorColor.B);
            winrt::check_hresult(selectedColor == indicatorColor ? S_OK : E_FAIL);
            if (artifactFolder) {
                const auto file = std::wstring{L"header-"} + (english ? L"en-" : L"zh-") +
                    (theme == 2 ? L"dark-" : L"light-") + std::to_wstring(static_cast<int>(width)) + L".png";
                co_await CaptureNativeView(g_panel.header, artifactFolder, winrt::hstring{file});
                ShowSearch(); co_await NextNativeFrame();
                co_await CaptureNativeView(g_panel.header, artifactFolder, winrt::hstring{L"search-" + file});
                g_panel.search.Visibility(Visibility::Collapsed);
            }
        }
        stage = 17;
        g_panel.root.UpdateLayout();
        const auto &card = g_panel.rows[0];
        const auto outlineBounds = card.outline.TransformToVisual(card.surface).TransformBounds(
            {0, 0, static_cast<float>(card.outline.ActualWidth()), static_cast<float>(card.outline.ActualHeight())});
        std::fprintf(stderr, "WinUI card outline: x=%.1f y=%.1f width=%.1f height=%.1f\n",
            outlineBounds.X, outlineBounds.Y, outlineBounds.Width, outlineBounds.Height);
        winrt::check_hresult(std::abs(outlineBounds.X + 4) <= 0.5 && std::abs(outlineBounds.Y + 4) <= 0.5 &&
            std::abs(outlineBounds.Width - kCardWidth - 8) <= 0.5 &&
            std::abs(outlineBounds.Height - kCardHeight - 8) <= 0.5 ? S_OK : E_FAIL);
        g_panel.history.SelectedIndex(0);
        ApplyRowTheme(false);
        co_await NextNativeFrame();
        Media::Imaging::RenderTargetBitmap selectedBitmap;
        co_await selectedBitmap.RenderAsync(g_panel.root);
        const auto selectedPixels = co_await selectedBitmap.GetPixelsAsync();
        std::vector<std::uint8_t> selectedBytes(selectedPixels.Length());
        winrt::Windows::Storage::Streams::DataReader::FromBuffer(selectedPixels).ReadBytes(selectedBytes);
        const auto edge = card.surface.TransformToVisual(g_panel.root).TransformPoint({kCardWidth / 2, -3});
        const auto pixelX = static_cast<std::size_t>(std::round(edge.X * selectedBitmap.PixelWidth() / g_panel.root.ActualWidth()));
        const auto pixelY = static_cast<std::size_t>(std::round(edge.Y * selectedBitmap.PixelHeight() / g_panel.root.ActualHeight()));
        const auto pixel = (pixelY * selectedBitmap.PixelWidth() + pixelX) * 4;
        const auto accent = card.outline.BorderBrush().as<Media::SolidColorBrush>().Color();
        winrt::check_hresult(pixel + 3 < selectedBytes.size() ? S_OK : E_FAIL);
        std::fprintf(stderr, "WinUI rendered outline: rgb=%u,%u,%u expected=%u,%u,%u\n",
            selectedBytes[pixel + 2], selectedBytes[pixel + 1], selectedBytes[pixel], accent.R, accent.G, accent.B);
        winrt::check_hresult(std::abs(selectedBytes[pixel + 2] - accent.R) <= 2 &&
            std::abs(selectedBytes[pixel + 1] - accent.G) <= 2 &&
            std::abs(selectedBytes[pixel] - accent.B) <= 2 ? S_OK : E_FAIL);
        if (artifactFolder) co_await CaptureNativeView(g_panel.root, artifactFolder, L"history-selection-outline.png");
        stage = 18;
        SetQueueViewActive(true);
        g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
        winrt::check_hresult(!g_queueSelectedHashes.empty() ? S_OK : E_FAIL);
        g_historyView.resetOnShow = false;
        const auto oldHistory = g_latestHistoryRequestId;
        const auto oldFilters = g_latestFiltersRequestId;
        AddSelectedItemsToQueue();
        winrt::check_hresult(g_queueSelectionAdding && g_queueSelectionAddRequest &&
            !g_queueSubmittedHashes.empty() ? S_OK : E_FAIL);
        stage = 181;
        ApplyResponse(R"({"op":"historyReset","data":{}})");
        winrt::check_hresult(g_queueSelectedHashes.empty() && !g_panel.queueAdd.IsEnabled() &&
            !g_queueSelectionAdding && !g_queueSelectionAddRequest && g_queueSubmittedHashes.empty() &&
            g_historyView.resetOnShow && g_latestHistoryRequestId > oldHistory &&
            g_latestFiltersRequestId > oldFilters ? S_OK : E_FAIL);
        auto emptyHistory = JsonObject::Parse(LR"({"op":"query","data":{"items":[],"hasMore":false}})");
        emptyHistory.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
        ApplyResponse(winrt::to_string(emptyHistory.Stringify()));
        winrt::check_hresult(g_panel.rows.empty() && g_selectedHash.empty() && !g_historyView.resetOnShow ? S_OK : E_FAIL);
        const auto filtersBeforeEvent = g_latestFiltersRequestId;
        ApplyResponse(R"({"op":"filtersChanged","data":{}})");
        winrt::check_hresult(g_latestFiltersRequestId > filtersBeforeEvent ? S_OK : E_FAIL);
        stage = 19;
        SetQueueViewActive(false);
        SetVisible(true, false, false);
        g_panel.dockMotion->SetVisible(false, true, true);
        winrt::check_hresult(g_panel.dockMotion->Running() ? S_OK : E_FAIL);
        const auto previewForeground = GetForegroundWindow();
        winrt::check_hresult(vpaste_winui_size_preview(true, false));
        RECT settledPreview{};
        winrt::check_bool(GetWindowRect(g_panel.window, &settledPreview));
        winrt::check_hresult(!g_panel.dockMotion->Running() && IsWindowVisible(g_panel.window) &&
            settledPreview.top == g_dockedLayout.y && !g_panel.root.IsHitTestVisible() &&
            // Finishing a hide can relinquish the panel's own foreground, but
            // a preview must never take activation from an external window.
            (previewForeground == g_panel.window || GetForegroundWindow() == previewForeground) ? S_OK : E_FAIL);
        co_await NextNativeFrame(); co_await NextNativeFrame();
        RECT stablePreview{};
        winrt::check_bool(GetWindowRect(g_panel.window, &stablePreview));
        winrt::check_hresult(EqualRect(&settledPreview, &stablePreview) && IsWindowVisible(g_panel.window) ? S_OK : E_FAIL);
        stage = 20;
        const auto beforeDisplayRequests = requests.size();
        WindowProc(g_panel.window, WM_DISPLAYCHANGE, 0, 0);
        winrt::check_hresult(IsWindowVisible(g_panel.window) && !g_panel.root.IsHitTestVisible() &&
            requests.size() > beforeDisplayRequests ? S_OK : E_FAIL);
        auto refreshedPreview = g_dockedLayout;
        ++refreshedPreview.x;
        winrt::check_hresult(vpaste_winui_set_layout(&refreshedPreview));
        winrt::check_hresult(IsWindowVisible(g_panel.window) && !g_layoutPending &&
            !g_panel.root.IsHitTestVisible() ? S_OK : E_FAIL);
        WindowProc(g_panel.window, WM_SETTINGCHANGE, SPI_SETWORKAREA, 0);
        winrt::check_hresult(IsWindowVisible(g_panel.window) && !g_panel.root.IsHitTestVisible() ? S_OK : E_FAIL);
        WindowProc(g_panel.window, WM_DPICHANGED, MAKEWPARAM(144, 144), reinterpret_cast<LPARAM>(&stablePreview));
        winrt::check_hresult(IsWindowVisible(g_panel.window) && !g_panel.root.IsHitTestVisible() ? S_OK : E_FAIL);
        --refreshedPreview.x;
        winrt::check_hresult(vpaste_winui_set_layout(&refreshedPreview));
        winrt::check_hresult(IsWindowVisible(g_panel.window) && !g_layoutPending &&
            !g_panel.root.IsHitTestVisible() ? S_OK : E_FAIL);
        winrt::check_hresult(vpaste_winui_size_preview(false, false));
        winrt::check_hresult(!IsWindowVisible(g_panel.window) ? S_OK : E_FAIL);
        stage = 21;
        std::fprintf(stderr, "WinUI shell: queue geometry\n");
        COLORREF borderColor{};
        if (SUCCEEDED(DwmGetWindowAttribute(queueHandle, DWMWA_BORDER_COLOR, &borderColor, sizeof(borderColor))) &&
            !vpaste::winui::HighContrastEnabled()) {
            winrt::check_hresult(borderColor == DWMWA_COLOR_NONE ? S_OK : E_FAIL);
        }
        winrt::check_hresult(SendMessageW(queueHandle, WM_MOUSEACTIVATE,
            reinterpret_cast<WPARAM>(queueHandle), MAKELPARAM(HTCLIENT, WM_LBUTTONDOWN)) == MA_NOACTIVATE ? S_OK : E_FAIL);
        JsonArray queueItems;
        for (int index = 0; index < 8; ++index) {
            JsonObject item;
            item.Insert(L"hash", JsonValue::CreateStringValue(L"constrained-" + std::to_wstring(index)));
            item.Insert(L"previewText", JsonValue::CreateStringValue(L"Queue layout fixture"));
            queueItems.Append(item);
        }
        JsonObject queueState;
        queueState.Insert(L"revision", JsonValue::CreateNumberValue(1000));
        queueState.Insert(L"items", queueItems);
        g_panel.queueView->SetState(queueState);
        g_panel.queueWindow->Show(1.0, true);
        co_await NextNativeFrame(); co_await NextNativeFrame();
        const auto queueRoot = g_panel.queueView->Root().as<Grid>();
        const auto queueList = queueRoot.Children().GetAt(1).as<ScrollViewer>();
        const auto queueHeader = queueRoot.Children().GetAt(0).as<Grid>();
        const auto queueToolbar = queueHeader.Children().GetAt(2).as<StackPanel>();
        stage = 211;
        const auto queueBackground = queueRoot.Background().try_as<Media::SolidColorBrush>();
        winrt::check_hresult(queueToolbar.Children().Size() == 2 && queueBackground &&
            queueBackground.Color().A == 255 ? S_OK : E_FAIL);
        for (const auto &command : queueToolbar.Children()) {
            const auto button = command.as<Button>();
            const auto area = button.TransformToVisual(queueHeader).TransformBounds({0, 0,
                static_cast<float>(button.ActualWidth()), static_cast<float>(button.ActualHeight())});
            std::fprintf(stderr, "WinUI queue command: bounds=(%.1f,%.1f %.1fx%.1f) header=%.1f\n",
                area.X, area.Y, area.Width, area.Height, queueHeader.ActualWidth());
            winrt::check_hresult(button.IsEnabled() && button.Visibility() == Visibility::Visible &&
                area.Width >= 39 && area.Height >= 39 && area.X >= 0 &&
                area.X + area.Width <= queueHeader.ActualWidth() + 0.5 &&
                OwnsNativePointer(button, true, queueRoot.XamlRoot().Content()) ? S_OK : E_FAIL);
        }
        stage = 21;
        const auto originalListHeight = queueList.ActualHeight();
        RECT fullQueue{};
        winrt::check_bool(GetWindowRect(queueHandle, &fullQueue));
        winrt::check_bool(SetWindowPos(queueHandle, nullptr, 0, 0, fullQueue.right - fullQueue.left,
            (fullQueue.bottom - fullQueue.top) * 3 / 4, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE));
        co_await NextNativeFrame(); co_await NextNativeFrame();
        const auto queueTransform = queueRoot.TransformToVisual(queueRoot.XamlRoot().Content());
        const auto queueOrigin = queueTransform.TransformPoint({0, 0});
        const auto queueAxes = queueTransform.TransformPoint({100, 100});
        const auto scaleX = (queueAxes.X - queueOrigin.X) / 100;
        const auto scaleY = (queueAxes.Y - queueOrigin.Y) / 100;
        const auto shortListHeight = queueList.ActualHeight();
        std::fprintf(stderr, "WinUI constrained queue: scale=%.3f,%.3f list=%.1f original=%.1f\n",
            scaleX, scaleY, shortListHeight, originalListHeight);
        if (artifactFolder) co_await CaptureNativeView(queueRoot, artifactFolder, L"queue-short-work-area.png");
        winrt::check_bool(SetWindowPos(queueHandle, nullptr, fullQueue.left, fullQueue.top,
            fullQueue.right - fullQueue.left, fullQueue.bottom - fullQueue.top, SWP_NOZORDER | SWP_NOACTIVATE));
        winrt::check_hresult(std::abs(scaleX - scaleY) < 0.01 && shortListHeight < originalListHeight ? S_OK : E_FAIL);
        for (const auto density : {0.8, 0.9}) {
            g_panel.queueWindow->Show(density, true);
            co_await NextNativeFrame(); co_await NextNativeFrame();
            const auto transform = queueRoot.TransformToVisual(queueRoot.XamlRoot().Content());
            const auto origin = transform.TransformPoint({0, 0});
            const auto axes = transform.TransformPoint({100, 100});
            std::fprintf(stderr, "WinUI queue density %.2f: scale=%.3f,%.3f root=%.1fx%.1f\n", density,
                (axes.X - origin.X) / 100, (axes.Y - origin.Y) / 100,
                queueRoot.ActualWidth(), queueRoot.ActualHeight());
            winrt::check_hresult(std::abs(axes.X - origin.X - 100 * density) < 0.5 &&
                std::abs(axes.Y - origin.Y - 100 * density) < 0.5 &&
                std::abs(queueRoot.ActualWidth() - vpaste::winui::QueueContentWidth) < 1 &&
                std::abs(queueRoot.ActualHeight() - vpaste::winui::QueueContentHeight) < 1 ? S_OK : E_FAIL);
        }
        g_panel.queueWindow->Hide();
        stage = 22;
        // A focus/selection notification can arrive while XAML releases a
        // retired strip. It must not read the cleared owner or issue a query.
        const auto beforeRetirement = requests.size();
        const auto retiredTabs = std::exchange(g_panel.customTabs, nullptr);
        retiredTabs.SelectedItem(retiredTabs.SelectedItem() ? SelectorBarItem{nullptr}
            : retiredTabs.Items().GetAt(0));
        g_panel.customTabs = retiredTabs;
        const auto retiredFilter = std::exchange(g_panel.filter, nullptr);
        retiredFilter.SelectedItem(retiredFilter.SelectedItem() ? SelectorBarItem{nullptr}
            : retiredFilter.Items().GetAt(0));
        g_panel.filter = retiredFilter;
        winrt::check_hresult(requests.size() == beforeRetirement ? S_OK : E_FAIL);
        stage = 23;
        std::fprintf(stderr, "WinUI continuity: tabs and dock\n");
        SetVisible(true, false, false);
        // This DWM attribute is write-only; exercise OS support without an
        // unsupported getter. Physical review still checks the composed show.
        const BOOL transitionsDisabled = TRUE;
        winrt::check_hresult(DwmSetWindowAttribute(g_panel.window, DWMWA_TRANSITIONS_FORCEDISABLED,
            &transitionsDisabled, sizeof(transitionsDisabled)));
        g_tagIds.clear(); g_tagNames.clear(); g_tabOrder.clear();
        g_selectedTagId = 0; g_selectedTagName.clear(); g_selectedFilterId.clear();
        RebuildTagFilter();
        ApplyFilters(JsonArray::Parse(LR"([{"id":"drag-a","name":"Short"},{"id":"drag-b","name":"A longer tab"},{"id":"drag-c","name":"Last"}])"));
        co_await NextNativeFrame();
        g_panel.root.UpdateLayout();
        const auto stableTab = DynamicTab(L"drag-a");
        const auto stripView = FindHistoryChild<ItemsView>(g_panel.customTabs);
        winrt::check_hresult(stripView && !stripView.ItemTransitionProvider() ? S_OK : E_FAIL);
        RebuildDynamicTabs();
        winrt::check_hresult(stableTab == DynamicTab(L"drag-a") ? S_OK : E_FAIL);
        BeginTabDropPreview(L"drag-a");
        const auto last = g_tabDrop.bounds.back();
        winrt::check_hresult(PreviewTabDrop(L"drag-a", last.X + last.Width) &&
            g_tabDrop.target == L"drag-c" && !g_tabDrop.before &&
            DynamicTab(L"drag-b").Translation().x < 0 && DynamicTab(L"drag-a").Opacity() < 1 ? S_OK : E_FAIL);
        ResetTabDropOffsets();
        winrt::check_hresult(PreviewTabDrop(L"drag-a", last.X + last.Width) ? S_OK : E_FAIL);
        ClearTabDropPreview();
        winrt::check_hresult(DynamicTab(L"drag-b").Translation().x == 0 &&
            DynamicTab(L"drag-a").Opacity() == 1 && g_tabDrop.source.empty() ? S_OK : E_FAIL);
        BeginTabDropPreview(L"drag-c");
        const auto first = g_tabDrop.bounds.front();
        winrt::check_hresult(PreviewTabDrop(L"drag-c", first.X) && g_tabDrop.target == L"drag-a" &&
            g_tabDrop.before && DynamicTab(L"drag-b").Translation().x > 0 ? S_OK : E_FAIL);
        ClearTabDropPreview();

        // Drop/cancel must clear the animation owner, not just its target.
        for (int repeat = 0; repeat < 4; ++repeat) {
            BeginTabDropPreview(repeat % 2 ? L"drag-c" : L"drag-a");
            const auto edge = repeat % 2 ? g_tabDrop.bounds.front().X
                : g_tabDrop.bounds.back().X + g_tabDrop.bounds.back().Width;
            winrt::check_hresult(PreviewTabDrop(g_tabDrop.source, edge) ? S_OK : E_FAIL);
            co_await NextNativeFrame();
            ClearTabDropPreview();
            for (auto const &tab : g_panel.customTabs.Items())
                winrt::check_hresult(!tab.TranslationTransition() && tab.Translation().x == 0 &&
                    tab.Opacity() == 1 && !tab.Resources().HasKey(winrt::box_value(L"VPaste.TabDropAnimation")) ? S_OK : E_FAIL);
            g_tabOrder = repeat % 2 ? std::vector<std::wstring>{L"drag-a", L"drag-b", L"drag-c"}
                : std::vector<std::wstring>{L"drag-c", L"drag-a", L"drag-b"};
            RebuildDynamicTabs(); co_await NextNativeFrame();
            // A real drop occurs with composition transitions in flight. Keep
            // the same source control rather than retiring its visual into an
            // ItemsRepeater recycle pool and constructing a duplicate label.
            winrt::check_hresult(stableTab == DynamicTab(L"drag-a") ? S_OK : E_FAIL);
            std::size_t renderedTabs = 0;
            const std::function<void(DependencyObject)> countTabs = [&](DependencyObject element) {
                if (element.try_as<SelectorBarItem>()) ++renderedTabs;
                for (int i = 0; i < Media::VisualTreeHelper::GetChildrenCount(element); ++i)
                    countTabs(Media::VisualTreeHelper::GetChild(element, i));
            };
            countTabs(g_panel.customTabs);
            winrt::check_hresult(renderedTabs == g_dynamicIds.size() ? S_OK : E_FAIL);
            float end = -1;
            for (auto const &id : g_dynamicIds) {
                const auto tab = DynamicTab(id);
                winrt::check_hresult(OwnsNativePointer(tab, true) ? S_OK : E_FAIL);
                const auto bounds = tab.TransformToVisual(g_panel.customTabs).TransformBounds(
                    {0, 0, static_cast<float>(tab.ActualWidth()), static_cast<float>(tab.ActualHeight())});
                winrt::check_hresult(bounds.Width > 0 && bounds.X >= end - 0.5f ? S_OK : E_FAIL);
                end = bounds.X + bounds.Width;
            }
            if (artifactFolder) co_await CaptureNativeView(g_panel.header, artifactFolder,
                winrt::hstring{L"reorder-settled-" + std::to_wstring(repeat) + L".png"});
        }

        // Exercise the real layout -> toggle path, including a reversal while
        // the previous hide animation still owns a visible HWND.
        for (const bool retain : {false, true}) {
            g_behavior.retainCategory = retain;
            for (int cycle = 0; cycle < 3; ++cycle) {
                g_panel.customTabs.SelectedItem(DynamicTab(L"drag-b"));
                WindowProc(g_panel.window, kHideWindow, 0, 0);
                auto layout = g_dockedLayout;
                winrt::check_hresult(static_cast<HRESULT>(WindowProc(g_panel.window, kSetLayout, 0,
                    reinterpret_cast<LPARAM>(&layout))));
                WindowProc(g_panel.window, kToggleWindow, 0, 0);
                winrt::check_hresult(g_selectedFilterId == (retain ? L"drag-b" : L"") &&
                    (retain || FilterIndex() == 0) ? S_OK : E_FAIL);
                co_await NextNativeFrame();
            }
        }
        g_behavior.retainCategory = false;

        stage = 24;
        std::fprintf(stderr, "WinUI continuity: format badges and retained cards\n");
        // Posted focus work can outlive the active history control. It must
        // neither synchronously force layout nor dereference an unloaded view.
        {
            const auto mounted = g_panel.history;
            g_panel.history = nullptr;
            winrt::check_hresult(static_cast<HRESULT>(WindowProc(g_panel.window, kFocusHistory, 0, 0)));
            g_panel.history = ListView();
            winrt::check_hresult(static_cast<HRESULT>(WindowProc(g_panel.window, kFocusHistory, 0, 0)));
            g_panel.history = mounted;
        }
        {
            const auto callback = g_request;
            g_request = +[](const std::uint8_t *, std::size_t) {
                throw winrt::hresult_invalid_argument(L"Synthetic message-boundary regression");
            };
            const auto status = WindowProc(g_panel.window, kRefreshHistory, 0, 0);
            g_request = callback;
            winrt::check_hresult(status == E_INVALIDARG ? S_OK : E_FAIL);
        }
        const auto result = [&](JsonArray const &items) {
            RequestHistory();
            JsonObject response, data;
            response.Insert(L"op", JsonValue::CreateStringValue(L"query"));
            response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestQueryId)));
            data.Insert(L"items", items); response.Insert(L"data", data);
            ApplyResponse(winrt::to_string(response.Stringify()));
        };
        const auto formatItems = JsonArray::Parse(LR"([{"hash":"format-rich","itemType":"Text"},{"hash":"format-gif","itemType":"Image"}])");
        result(formatItems); co_await NextNativeFrame();
        const auto formatCard = [&](wchar_t const *hash, JsonObject data) {
            const auto row = FindCard(hash);
            JsonObject response; response.Insert(L"op", JsonValue::CreateStringValue(L"card"));
            response.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(row->cardRequestId)));
            data.Insert(L"hash", JsonValue::CreateStringValue(hash)); response.Insert(L"data", data);
            ApplyResponse(winrt::to_string(response.Stringify()));
        };
        formatCard(L"format-rich", JsonObject::Parse(LR"({"isRichText":true,"rich":null,"displayText":"Rich format with plain fallback"})"));
        formatCard(L"format-gif", JsonObject::Parse(LR"({"isGif":true,"media":{"isGif":false}})"));
        winrt::check_hresult(FindCard(L"format-rich")->richBadgeFrame.Visibility() == Visibility::Visible &&
            FindCard(L"format-rich")->richFrame.Visibility() == Visibility::Collapsed &&
            FindCard(L"format-gif")->gifBadgeFrame.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
        winrt::check_hresult(FindCard(L"format-rich")->actions.Children().Size() == 1 &&
            !FindCard(L"format-rich")->contextMenu &&
            EnsureCardContextMenu(*FindCard(L"format-rich"), L"format-rich") ? S_OK : E_FAIL);
        if (artifactFolder) co_await CaptureNativeView(g_panel.root, artifactFolder, L"format-badges.png");
        const auto cardBounds = [&] {
            std::vector<winrt::Windows::Foundation::Rect> bounds;
            for (auto const &row : g_panel.rows) bounds.push_back(row.surface.TransformToVisual(g_panel.history).TransformBounds(
                {0, 0, static_cast<float>(row.surface.ActualWidth()), static_cast<float>(row.surface.ActualHeight())}));
            return bounds;
        };
        const auto normalBounds = cardBounds();
        ToggleQueueSelectionMode(); co_await NextNativeFrame(); co_await NextNativeFrame();
        g_panel.history.SelectedItems().Append(g_panel.history.Items().GetAt(0));
        co_await NextNativeFrame();
        const auto selectionBounds = cardBounds();
        winrt::check_hresult(normalBounds.size() == selectionBounds.size() ? S_OK : E_FAIL);
        for (std::size_t i = 0; i < normalBounds.size(); ++i) {
            const auto a = normalBounds[i], b = selectionBounds[i];
            winrt::check_hresult(std::abs(a.X - b.X) < 0.5f && std::abs(a.Width - b.Width) < 0.5f &&
                std::abs(a.Height - b.Height) < 0.5f ? S_OK : E_FAIL);
        }
        if (artifactFolder) co_await CaptureNativeView(g_panel.root, artifactFolder, L"queue-selection-cards.png");
        ToggleQueueSelectionMode(); co_await NextNativeFrame();
        const auto retainedSurface = FindCard(L"format-rich")->surface;
        const auto retainedBadge = FindCard(L"format-rich")->richBadge;
        const auto retainedFrame = FindCard(L"format-rich")->frame;
        const auto retainedContainer = g_panel.history.ContainerFromItem(retainedFrame);
        auto unloads = std::make_shared<unsigned>(0);
        retainedFrame.Unloaded([unloads](auto const &, auto const &) { ++*unloads; });
        RequestCardDetails(L"format-rich", true);
        RequestCardDetails(L"format-gif", true);
        const auto retainedImage = FindCard(L"format-gif")->image;
        const auto retainedBitmap = winrt::Microsoft::UI::Xaml::Media::Imaging::BitmapImage{};
        retainedImage.Source(retainedBitmap);
        auto prepended = JsonArray::Parse(LR"([{"hash":"new-copy","itemType":"Text"}])");
        for (auto const &item : formatItems) prepended.Append(item);
        result(prepended); co_await NextNativeFrame();
        winrt::check_hresult(FindCard(L"format-rich")->surface == retainedSurface &&
            FindCard(L"format-rich")->richBadge == retainedBadge &&
            FindCard(L"format-rich")->richBadgeFrame.Visibility() == Visibility::Visible ? S_OK : E_FAIL);
        std::fprintf(stderr, "WinUI retained card: unloads=%u container=%d bitmap=%d\n", *unloads,
            g_panel.history.ContainerFromItem(retainedFrame) == retainedContainer,
            FindCard(L"format-gif")->image.Source() == retainedBitmap);
        winrt::check_hresult(*unloads == 0 && retainedContainer &&
            g_panel.history.ContainerFromItem(retainedFrame) == retainedContainer &&
            FindCard(L"format-gif")->image.Source() == retainedBitmap ? S_OK : E_FAIL);
        formatCard(L"format-rich", JsonObject::Parse(LR"({"isRichText":false})"));
        formatCard(L"format-gif", JsonObject::Parse(LR"({"isGif":false,"media":{"isGif":false}})"));
        winrt::check_hresult(FindCard(L"format-rich")->richBadgeFrame.Visibility() == Visibility::Collapsed &&
            FindCard(L"format-gif")->gifBadgeFrame.Visibility() == Visibility::Collapsed &&
            FindCard(L"format-rich")->detailState == CardDetailState::Ready &&
            FindCard(L"format-gif")->detailState == CardDetailState::Ready ? S_OK : E_FAIL);

        // Repeated prepend/reorder/delete with long content must not stretch a
        // realized container or leave an empty slot between fixed-width cards.
        for (int cycle = 0; cycle < 8; ++cycle) {
            JsonArray cards;
            for (int index = 0; index < 36; ++index) {
                JsonObject card;
                card.Insert(L"hash", JsonValue::CreateStringValue(L"gap-" + std::to_wstring((index + cycle) % 40)));
                card.Insert(L"itemType", JsonValue::CreateStringValue(L"Text"));
                card.Insert(L"previewText", JsonValue::CreateStringValue(winrt::hstring{std::wstring(500, L'W')}));
                cards.Append(card);
            }
            if (g_panel.historyScroll) {
                HistoryViewportInput();
                g_panel.historyScroll.ChangeView(winrt::box_value((cycle % 3) * (kCardWidth + 16) * 6).as<winrt::Windows::Foundation::IReference<double>>(),
                    nullptr, nullptr, true);
                co_await NextNativeFrame();
            }
            result(cards);
            WindowProc(g_panel.window, kFocusHistory, 0, 0);
            co_await NextNativeFrame();
            FrameworkElement previous{nullptr};
            unsigned realized = 0;
            for (std::uint32_t index = 0; index < cards.Size(); ++index) {
                const auto container = g_panel.history.ContainerFromIndex(index).try_as<FrameworkElement>();
                if (!container || !container.IsLoaded()) continue;
                const auto frame = g_panel.rows[index].frame;
                const auto bounds = frame.TransformToVisual(g_panel.history).TransformBounds(
                    {0, 0, static_cast<float>(frame.ActualWidth()), static_cast<float>(frame.ActualHeight())});
                // Recycled cached containers can remain loaded at WinUI's
                // offscreen parking coordinates. Check the actual viewport.
                if (bounds.X + bounds.Width <= 0 || bounds.X >= g_panel.history.ActualWidth()) continue;
                if (std::abs(bounds.Width - (kCardWidth + 16)) >= 1)
                    std::fprintf(stderr, "WinUI card width: cycle=%d index=%u width=%.1f\n", cycle, index, bounds.Width);
                winrt::check_hresult(std::abs(bounds.Width - (kCardWidth + 16)) < 1 ? S_OK : E_FAIL);
                if (previous) {
                    const auto left = previous.TransformToVisual(g_panel.history).TransformPoint({0, 0});
                    if (std::abs(bounds.X - left.X - (kCardWidth + 16)) >= 1)
                        std::fprintf(stderr, "WinUI card gap: cycle=%d index=%u left=%.1f previous=%.1f delta=%.1f\n",
                            cycle, index, bounds.X, left.X, bounds.X - left.X);
                    winrt::check_hresult(std::abs(bounds.X - left.X - (kCardWidth + 16)) < 1 ? S_OK : E_FAIL);
                }
                previous = frame; ++realized;
            }
            std::fprintf(stderr, "WinUI card geometry: cycle=%d realized=%u offset=%.1f\n", cycle, realized,
                g_panel.historyScroll ? g_panel.historyScroll.HorizontalOffset() : -1);
            winrt::check_hresult(realized >= 2 ? S_OK : E_FAIL);
        }

        stage = 260;
        {
        JsonArray files;
        for (int index = 0; index < 36; ++index) {
            auto fileCard = JsonObject::Parse(LR"({"itemType":"File","previewText":"Synthetic report.pdf","tags":[]})");
            fileCard.Insert(L"hash", JsonValue::CreateStringValue(L"focus-file-" + std::to_wstring(index)));
            fileCard.Insert(L"appSource", JsonValue::CreateStringValue(L"Synthetic source app"));
            files.Append(fileCard);
        }
        result(files); co_await NextNativeFrame();
        const auto file = JsonObject::Parse(LR"({"exists":true,"path":"report.pdf","secondary":"","fullPath":"C:/synthetic/report.pdf","label":"PDF","light":{"name":"pdf-light","asset":"pdf"},"dark":{"name":"pdf-dark","asset":"pdf"}})");
        WindowProc(g_panel.window, kSetTheme, 1, 0);
        // Load through the viewport/detail route before measuring loaded-card
        // focus changes. An unvisited container legitimately requests details
        // the first time it is realized; that is not a focus-triggered reload.
        for (std::size_t index = 0; index < g_panel.rows.size(); ++index) {
            g_panel.history.ScrollIntoView(g_panel.rows[index].frame);
            co_await NextNativeFrame();
            winrt::check_hresult(g_panel.rows[index].cardRequestId && g_panel.cardRequested[index] ? S_OK : E_FAIL);
            JsonObject detail; detail.Insert(L"filePresentation", file);
            formatCard(g_hashes[index].c_str(), detail);
        }
        g_panel.history.ScrollIntoView(g_panel.rows.front().frame);
        co_await NextNativeFrame();
        for (auto const &row : g_panel.rows) winrt::check_hresult(!ToolTipService::GetToolTip(row.surface) &&
            !ToolTipService::GetToolTip(row.sourceFrame) && !Automation::AutomationProperties::GetHelpText(row.surface).empty() ? S_OK : E_FAIL);
        // Replay only the former focus-triggered restyle; no real user profile
        // or live capture is involved. Wall times are diagnostic, not gates.
        vpaste::winui::RecordNativeResources("file-focus-before-selection");
        std::vector<UIElement> artwork;
        for (auto const &row : g_panel.rows) artwork.push_back(row.filePresentation.Child());
        const auto cardRequests = [&] {
            return std::count_if(requests.begin(), requests.end(), [](auto const &bytes) {
                return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"card";
            });
        };
        const auto requestCount = cardRequests();
        const auto steadyBuilds = g_filePresentationBuilds;
        const auto steadyStart = std::chrono::steady_clock::now();
        for (int step = 0; step < 12; ++step) {
            g_panel.history.SelectedIndex((step + 1) % 12);
            WindowProc(g_panel.window, kSetTheme, 1, 0);
        }
        const auto steadyMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - steadyStart).count();
        for (std::size_t index = 0; index < g_panel.rows.size(); ++index) {
            if (g_panel.rows[index].filePresentation.Child() != artwork[index])
                std::fprintf(stderr, "WinUI file-focus: artwork replaced at index=%zu\n", index);
            winrt::check_hresult(g_panel.rows[index].filePresentation.Child() == artwork[index] ? S_OK : E_FAIL);
        }
        std::fprintf(stderr, "WinUI file-focus: retainedBuilds=%llu additionalCardRequests=%lld\n",
            static_cast<unsigned long long>(g_filePresentationBuilds - steadyBuilds),
            static_cast<long long>(cardRequests() - requestCount));
        winrt::check_hresult(g_filePresentationBuilds == steadyBuilds && cardRequests() == requestCount ? S_OK : E_FAIL);
        vpaste::winui::RecordNativeResources("file-focus-after-retained-selection");
        artwork.clear();
        const auto legacyStart = std::chrono::steady_clock::now();
        const auto legacyBuilds = g_filePresentationBuilds;
        for (int step = 0; step < 12; ++step) {
            g_panel.history.SelectedIndex(step);
            for (auto &row : g_panel.rows) row.filePresentationDark.reset();
            ApplyRowTheme();
        }
        const auto legacyMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - legacyStart).count();
        winrt::check_hresult(g_filePresentationBuilds - legacyBuilds == 12 * 36 ? S_OK : E_FAIL);
        for (int frame = 0; frame < 6; ++frame) co_await NextNativeFrame();
        vpaste::winui::RecordNativeResources("file-focus-after-replayed-restyle");
        std::fprintf(stderr, "WinUI file-focus benchmark: rows=36 moves=12 replayedRestyleBuilds=432 replayedMs=%.2f retainedBuilds=0 retainedMs=%.2f\n", legacyMs, steadyMs);
        const auto themeBuilds = g_filePresentationBuilds;
        stage = 261;
        WindowProc(g_panel.window, kSetTheme, 2, 0); co_await NextNativeFrame();
        winrt::check_hresult(g_filePresentationBuilds == themeBuilds + 36 &&
            winrt::unbox_value<winrt::hstring>(g_panel.rows.front().filePresentation.Child().as<FrameworkElement>().Tag()) == L"pdf-dark" ? S_OK : E_FAIL);
        ApplyRowTheme();
        winrt::check_hresult(g_filePresentationBuilds == themeBuilds + 36 ? S_OK : E_FAIL);
        // Explicitly refreshed detail still replaces changed art; unchanged
        // focus and repeated theme messages must never suppress that path.
        RequestCardDetails(L"focus-file-0", true);
        const auto changed = JsonObject::Parse(file.Stringify());
        changed.SetNamedValue(L"path", JsonValue::CreateStringValue(L"report.pdf"));
        changed.SetNamedValue(L"secondary", JsonValue::CreateStringValue(L""));
        changed.SetNamedValue(L"fullPath", JsonValue::CreateStringValue(L"C:/synthetic/report.pdf"));
        changed.GetNamedObject(L"dark").SetNamedValue(L"name", JsonValue::CreateStringValue(L"pdf-updated"));
        JsonObject detail; detail.Insert(L"filePresentation", changed);
        formatCard(L"focus-file-0", detail);
        winrt::check_hresult(g_filePresentationBuilds == themeBuilds + 37 &&
            winrt::unbox_value<winrt::hstring>(g_panel.rows.front().filePresentation.Child().as<FrameworkElement>().Tag()) == L"pdf-updated" ? S_OK : E_FAIL);
        WindowProc(g_panel.window, kSetTheme, 1, 0);
        artwork.clear(); result(JsonArray{});
        for (int frame = 0; frame < 3; ++frame) co_await NextNativeFrame();
        vpaste::winui::RecordNativeResources("file-focus-after-clear");
        }

        stage = 262;
        {
        WindowProc(g_panel.window, kSetLanguage, true, 0);
        ApplyFilters(JsonArray::Parse(LR"([{"id":"delete-filter","name":"Work","filter":{}}])"));
        g_tagIds = {9}; g_tagNames = {L"Work"}; RebuildTagFilter();
        co_await NextNativeFrame();
        for (auto const &tab : {g_panel.filter.Items().GetAt(0), g_panel.filter.Items().GetAt(1), DynamicTab(RecordTabId(9))}) {
            winrt::check_hresult(!ToolTipService::GetToolTip(tab) && !tab.Text().empty() &&
                VisualStateManager::GoToState(tab, L"UnselectedPointerOver", false) &&
                VisualStateManager::GoToState(tab, L"UnselectedPressed", false) &&
                VisualStateManager::GoToState(tab, L"SelectedPointerOver", false) &&
                VisualStateManager::GoToState(tab, L"SelectedPressed", false) &&
                VisualStateManager::GoToState(tab,
                    tab == g_panel.filter.SelectedItem() || tab == g_panel.customTabs.SelectedItem()
                        ? L"SelectedNormal" : L"UnselectedNormal", false) ? S_OK : E_FAIL);
        }
        stage = 2621;
        const auto deletes = [&] {
            return std::count_if(requests.begin(), requests.end(), [](auto const &bytes) {
                const auto op = JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op");
                return op == L"filtersDelete" || op == L"recordTagDelete";
            });
        };
        const auto findButton = [&](auto const &self, DependencyObject const &element, wchar_t const *name) -> Button {
            if (auto button = element.try_as<Button>(); button && button.Name() == name) return button;
            for (int index = 0; index < Media::VisualTreeHelper::GetChildrenCount(element); ++index)
                if (const auto button = self(self, Media::VisualTreeHelper::GetChild(element, index), name)) return button;
            return nullptr;
        };
        const auto invoke = [](Button const &button) {
            winrt::check_hresult(button ? S_OK : E_FAIL);
            Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(button)
                .GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>().Invoke();
        };
        const auto waitClosed = [&]() -> winrt::Windows::Foundation::IAsyncAction {
            for (int frame = 0; frame < 90 && g_deleteConfirmationOpen; ++frame) co_await NextNativeFrame();
            winrt::check_hresult(!g_deleteConfirmationOpen && !g_panel.deletionDialog ? S_OK : E_FAIL);
        };
        for (bool record : {false, true}) {
            const auto id = record ? RecordTabId(9) : L"delete-filter";
            const auto count = deletes();
            const auto before = requests.size();
            (void)ConfirmDeleteTab(id);
            const auto canceled = g_panel.deletionDialog;
            winrt::check_hresult(canceled ? S_OK : E_FAIL);
            co_await AwaitNativeLoaded(canceled);
            (void)ConfirmDeleteTab(id);
            winrt::check_hresult(g_panel.deletionDialog == canceled && deletes() == count &&
                canceled.DefaultButton() == ContentDialogButton::Close &&
                winrt::unbox_value<winrt::hstring>(canceled.Title()) == L"Delete Tab" &&
                std::wstring{winrt::unbox_value<winrt::hstring>(canceled.Content())}.find(L"History records will be kept.") != std::wstring::npos ? S_OK : E_FAIL);
            for (std::size_t index = before; index < requests.size(); ++index)
                winrt::check_hresult(JsonObject::Parse(winrt::to_hstring(requests[index])).GetNamedString(L"op") != L"filterSources" ? S_OK : E_FAIL);
            invoke(findButton(findButton, canceled, L"CloseButton")); co_await waitClosed();
            winrt::check_hresult(deletes() == count ? S_OK : E_FAIL);
            stage = 2622;
            for (bool fail : {true, false}) {
                (void)ConfirmDeleteTab(id);
                const auto dialog = g_panel.deletionDialog;
                co_await AwaitNativeLoaded(dialog);
                invoke(findButton(findButton, dialog, L"PrimaryButton")); co_await waitClosed();
                winrt::check_hresult(g_tabDeleteRequest ? S_OK : E_FAIL);
                const auto pendingDeleteId = g_tabDeleteRequest;
                const auto requestBytes = std::find_if(requests.begin(), requests.end(), [&](auto const &bytes) {
                    return static_cast<std::uint64_t>(JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedNumber(L"id", 0)) == pendingDeleteId;
                });
                winrt::check_hresult(requestBytes != requests.end() ? S_OK : E_FAIL);
                const auto request = JsonObject::Parse(winrt::to_hstring(*requestBytes));
                winrt::check_hresult((record ? request.GetNamedNumber(L"tagId") == 9 : request.GetNamedString(L"tabId") == id) ? S_OK : E_FAIL);
                (void)ConfirmDeleteTab(id);
                winrt::check_hresult(!g_panel.deletionDialog && g_tabDeleteRequest == pendingDeleteId ? S_OK : E_FAIL);
                JsonObject reply; reply.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(pendingDeleteId)));
                reply.Insert(L"op", request.GetNamedValue(L"op")); reply.Insert(L"data", JsonObject{});
                if (fail) reply.Insert(L"error", JsonValue::CreateStringValue(L"Synthetic delete failure"));
                ApplyResponse(winrt::to_string(reply.Stringify()));
                stage = 2623;
                winrt::check_hresult(!g_tabDeleteRequest && (!fail || (g_panel.feedback.IsOpen() &&
                    g_panel.feedback.Message() == L"Synthetic delete failure")) ? S_OK : E_FAIL);
            }
            winrt::check_hresult(deletes() == count + 2 ? S_OK : E_FAIL);
        }
        stage = 263;
        const auto count = deletes();
        (void)ConfirmDeleteTab(L"delete-filter");
        const auto retired = g_panel.deletionDialog;
        co_await AwaitNativeLoaded(retired);
        ApplyResponse(R"({"op":"historyReset","data":{}})");
        for (int frame = 0; frame < 30; ++frame) co_await NextNativeFrame();
        winrt::check_hresult(!g_panel.deletionDialog && !g_deleteConfirmationOpen && deletes() == count ? S_OK : E_FAIL);
        }

        stage = 25;
        std::fprintf(stderr, "WinUI continuity: native tutorial in the dock\n");
        {
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        winrt::Windows::Storage::StorageFolder guideArtifacts{nullptr};
        wchar_t guidePath[MAX_PATH]{};
        const auto guidePathLength = GetEnvironmentVariableW(L"VPASTE_WINUI_AUXILIARY_ARTIFACT_DIR", guidePath, MAX_PATH);
        if (guidePathLength > 0 && guidePathLength < MAX_PATH)
            guideArtifacts = co_await winrt::Windows::Storage::StorageFolder::GetFolderFromPathAsync(guidePath);
        ApplyResponse(R"({"op":"nativeTutorialOpen","data":{"session":105,"ready":true,"preview":true,"mac":false,"english":true,
            "shortcut":"Alt + V","items":[{"id":"tutorial-filter-text","name":"Text","filter":{"itemType":"Text"}}],
            "filters":[{"id":"text","name":"Text","enabled":true},{"id":"image","name":"Image","enabled":false},
                       {"id":"link","name":"Link","enabled":true},{"id":"file","name":"File","enabled":true},{"id":"color","name":"Color","enabled":false}],"error":""}})");
        stage = 251;
        winrt::check_hresult(g_panel.onboarding && g_panel.onboarding->Session() == 105 ? S_OK : E_FAIL);
        const auto guide = g_panel.onboarding->Root();
        co_await AwaitNativeLoaded(guide);
        winrt::check_hresult(guide.XamlRoot() == g_panel.history.XamlRoot() &&
            g_panel.history.Opacity() == 0 && !g_panel.header.IsHitTestVisible() && g_panel.root.IsHitTestVisible() ? S_OK : E_FAIL);
        stage = 252;
        g_panel.root.UpdateLayout();
        co_await NextNativeFrame();
        const auto bounds = guide.TransformToVisual(g_panel.root).TransformBounds({0, 0,
            static_cast<float>(guide.ActualWidth()), static_cast<float>(guide.ActualHeight())});
        const auto history = g_panel.history.TransformToVisual(g_panel.root).TransformPoint({0, 0});
        std::fprintf(stderr, "WinUI tutorial layout: guide=(%.1f,%.1f %.1fx%.1f) history=(%.1f,%.1f)\n",
            bounds.X, bounds.Y, bounds.Width, bounds.Height, history.X, history.Y);
        winrt::check_hresult(std::abs(bounds.Y - history.Y) < 2 && bounds.Width > 0 && bounds.Height > 0 ? S_OK : E_FAIL);
        const auto tutorialPage = [&] {
            return guide.as<ContentControl>().Content().as<ScrollViewer>().Content().as<Grid>();
        };
        const auto welcome = tutorialPage().Children().GetAt(0).as<StackPanel>();
        const auto wide = guide.ActualWidth() > 900;
        winrt::check_hresult(welcome.Orientation() == (wide ? Orientation::Horizontal : Orientation::Vertical) &&
            welcome.Children().GetAt(0).as<Grid>().Children().GetAt(0).as<Image>().Height() == 118 &&
            welcome.Children().GetAt(1).as<StackPanel>().Children().GetAt(2).as<Border>().Width() == 86 ? S_OK : E_FAIL);
        if (guideArtifacts) co_await CaptureNativeView(guide, guideArtifacts, L"guide-welcome.png");
        stage = 2521;
        ApplyResponse(R"({"op":"nativeTutorialClose","data":{"session":104}})");
        winrt::check_hresult(g_panel.onboarding && g_panel.onboarding->Root() == guide ? S_OK : E_FAIL);
        SetVisible(false, false, false);
        stage = 253;
        co_await NextNativeFrame();
        winrt::check_hresult(!IsWindowVisible(g_panel.window) && g_panel.onboarding->Root() == guide ? S_OK : E_FAIL);
        SetVisible(true, false, false);
        stage = 254;
        co_await NextNativeFrame();
        winrt::check_hresult(IsWindowVisible(g_panel.window) && g_panel.onboarding->Root() == guide &&
            !g_panel.history.IsHitTestVisible() ? S_OK : E_FAIL);
        stage = 2541;
        auto filter = FindHistoryChild<ToggleSwitch>(guide);
        const auto filtersDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (!filter && std::chrono::steady_clock::now() < filtersDeadline) {
            co_await NextNativeFrame();
            filter = FindHistoryChild<ToggleSwitch>(guide);
        }
        winrt::check_hresult(filter ? S_OK : HRESULT_FROM_WIN32(ERROR_TIMEOUT));
        const auto choices = tutorialPage().Children().GetAt(1).as<Grid>();
        const auto centeredGuide = [&] {
            const auto page = tutorialPage();
            const auto left = page.TransformToVisual(guide).TransformPoint({0, 0}).X;
            return std::abs(2 * left + page.ActualWidth() - guide.ActualWidth()) < 2;
        };
        const auto switchesFit = [&] {
            constexpr bool enabled[]{true, false, true, true, false};
            for (std::uint32_t i = 0; i < choices.Children().Size(); ++i) {
                const auto tile = choices.Children().GetAt(i).as<Border>();
                const auto control = FindHistoryChild<ToggleSwitch>(tile);
                if (!control || control.IsOn() != enabled[i] ||
                    control.ReadLocalValue(FrameworkElement::StyleProperty()) != DependencyProperty::UnsetValue() ||
                    control.ActualWidth() < 40 ||
                    control.ActualWidth() > tile.ActualWidth() || !control.IsHitTestVisible() || !control.IsTabStop()) return false;
            }
            return true;
        };
        // Rendering event counts are refresh-rate dependent. Observe the
        // settled geometry and the loaded switch templates before measuring.
        while ((!centeredGuide() || !switchesFit()) && std::chrono::steady_clock::now() < filtersDeadline)
            co_await NextNativeFrame();
        winrt::check_hresult(filter && filter.IsOn() && choices.Children().Size() == 5 &&
            choices.ColumnDefinitions().Size() == (wide ? 5u : 0u) &&
            Grid::GetColumn(choices) == (wide ? 1 : 0) && centeredGuide() && switchesFit() ? S_OK : E_FAIL);
        if (wide) {
            stage = 25414;
            guide.Width(640); guide.UpdateLayout(); co_await NextNativeFrame();
            winrt::check_hresult(choices.RowDefinitions().Size() == 5 &&
                Grid::GetColumn(choices) == 0 && filter.IsOn() && centeredGuide() && switchesFit() ? S_OK : E_FAIL);
            stage = 25415;
            guide.Width(1320); guide.UpdateLayout(); co_await NextNativeFrame();
            winrt::check_hresult(choices.ColumnDefinitions().Size() == 5 &&
                std::abs(tutorialPage().ActualWidth() - 1080) < 2 && centeredGuide() ? S_OK : E_FAIL);
            guide.ClearValue(FrameworkElement::WidthProperty()); guide.UpdateLayout(); co_await NextNativeFrame();
            winrt::check_hresult(choices.ColumnDefinitions().Size() == 5 && Grid::GetColumn(choices) == 1 ? S_OK : E_FAIL);
        }
        if (guideArtifacts) co_await CaptureNativeView(guide, guideArtifacts, L"guide-filters.png");
        stage = 25411;
        winrt::Microsoft::UI::Xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(filter)
            .GetPattern(winrt::Microsoft::UI::Xaml::Automation::Peers::PatternInterface::Toggle)
            .as<winrt::Microsoft::UI::Xaml::Automation::Provider::IToggleProvider>().Toggle();
        co_await NextNativeFrame();
        const auto lastPayload = [&](std::wstring_view op) {
            for (auto message = requests.rbegin(); message != requests.rend(); ++message) {
                auto value = JsonObject::Parse(winrt::to_hstring(*message));
                if (value.GetNamedString(L"op") == op) return value;
            }
            return JsonObject{nullptr};
        };
        const auto toggle = lastPayload(L"tutorialToggle");
        winrt::check_hresult(toggle && toggle.GetNamedString(L"filter") == L"text" &&
            !toggle.GetNamedBoolean(L"enabled") && toggle.GetNamedNumber(L"session") == 105 ? S_OK : E_FAIL);
        stage = 25412;
        const auto invokeGuideAction = [&](wchar_t const *label) {
            const auto content = tutorialPage();
            const auto action = content.Children().GetAt(content.Children().Size() - 1).as<Button>();
            winrt::check_hresult(Grid::GetColumn(action) == (wide ? 2 : 0) && action.MinHeight() == 44 ? S_OK : E_FAIL);
            winrt::check_hresult(winrt::unbox_value<winrt::hstring>(action.Content()) == label ? S_OK : E_FAIL);
            winrt::Microsoft::UI::Xaml::Automation::Peers::ButtonAutomationPeer(action)
                .GetPattern(winrt::Microsoft::UI::Xaml::Automation::Peers::PatternInterface::Invoke)
                .as<winrt::Microsoft::UI::Xaml::Automation::Provider::IInvokeProvider>().Invoke();
        };
        invokeGuideAction(L"Next");
        auto practice = lastPayload(L"tutorialDemo");
        for (int frame = 0; frame < 15 && (!practice || !practice.GetNamedBoolean(L"enabled")); ++frame) {
            co_await NextNativeFrame();
            practice = lastPayload(L"tutorialDemo");
        }
        winrt::check_hresult(practice && practice.GetNamedBoolean(L"enabled") ? S_OK : E_FAIL);
        stage = 25413;
        co_await NextNativeFrame();
        // The shipped shortcut SVG already owns the illustrated surface.
        const auto shortcutStage = tutorialPage().Children().GetAt(1).as<Grid>();
        const auto illustration = shortcutStage.Children().GetAt(0).try_as<Image>();
        winrt::check_hresult(illustration && illustration.Source() && illustration.Height() == 162 &&
            shortcutStage.Children().GetAt(1).try_as<Grid>() ? S_OK : E_FAIL);
        if (guideArtifacts) co_await CaptureNativeView(guide, guideArtifacts, L"guide-shortcut.png");
        invokeGuideAction(L"Finish");
        for (int frame = 0; frame < 15 && !lastPayload(L"tutorialFinish"); ++frame) co_await NextNativeFrame();
        winrt::check_hresult(lastPayload(L"tutorialFinish") && !guide.as<ContentControl>().Content() ? S_OK : E_FAIL);
        ApplyResponse(R"({"op":"nativeTutorialClose","data":{"session":105}})");
        stage = 255;
        winrt::check_hresult(!g_panel.onboarding && !g_tutorialPreviewFilters &&
            g_panel.header.IsHitTestVisible() && g_panel.history.IsHitTestVisible() && g_panel.history.Opacity() == 1 ? S_OK : E_FAIL);

        stage = 256;
        ApplyResponse(R"({"op":"nativeTutorialOpen","data":{"session":106,"ready":true,"preview":true,"mac":true,
            "english":true,"shortcut":"Option + V","items":[],"filters":[],"error":"",
            "permissions":{"background":{"done":true},"paste":{"done":true}}}})");
        winrt::check_hresult(g_panel.onboarding && g_panel.onboarding->Session() == 106 ? S_OK : E_FAIL);
        const auto macGuide = g_panel.onboarding->Root();
        Grid permissionPage{nullptr};
        const auto permissionsDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        do {
            const auto page = macGuide.as<ContentControl>().Content().as<ScrollViewer>().Content().as<Grid>();
            if (page.Children().Size() >= 4) { permissionPage = page; break; }
            co_await NextNativeFrame();
        } while (std::chrono::steady_clock::now() < permissionsDeadline);
        winrt::check_hresult(permissionPage && permissionPage.Children().GetAt(1).as<Grid>().Children().Size() == 2 ?
            S_OK : E_FAIL);
        const auto permissions = permissionPage.Children().GetAt(1).as<Grid>();
        for (auto const &element : permissions.Children()) {
            const auto image = element.as<Border>().Child().as<Grid>().Children().GetAt(0).as<Border>()
                .Child().as<Grid>().Children().GetAt(0).as<Image>();
            winrt::check_hresult(image.Source() && image.Height() == 92 ? S_OK : E_FAIL);
        }
        if (guideArtifacts) co_await CaptureNativeView(macGuide, guideArtifacts, L"guide-permissions.png");
        ApplyResponse(R"({"op":"nativeTutorialClose","data":{"session":106}})");
        }
        co_await vpaste::winui::TestCardPreviewControls(g_panel.root, stage);
        completion->set_value({S_OK, stage});
    } catch (...) { completion->set_value({winrt::to_hresult(), stage}); }
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_test_shell_parity(std::uint32_t *stage) noexcept {
    if (!stage || !g_dispatcher) return E_INVALIDARG;
    // An assertion in an isolated Debug desktop must be captured, not open a dialog.
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([completion] { RunNativeShellRegression(completion); })) return E_FAIL;
    // Artifact captures deliberately settle 400 ms each before saving. Keep
    // the ordinary regression deadline; allow its optional screenshot batch.
    const auto timeout = (GetEnvironmentVariableW(L"VPASTE_WINUI_ARTIFACT_DIR", nullptr, 0) ||
        GetEnvironmentVariableW(L"VPASTE_WINUI_AUXILIARY_ARTIFACT_DIR", nullptr, 0))
        ? std::chrono::seconds(60) : std::chrono::seconds(15);
    if (result.wait_for(timeout) != std::future_status::ready) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    const auto [status, completedStage] = result.get(); *stage = completedStage;
    return status;
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_test_history_and_queue(
    std::uint8_t const *fixtures, std::size_t fixturesSize, std::uint32_t *stage) noexcept {
    if (!fixtures || !fixturesSize || !stage || !g_dispatcher) return E_INVALIDARG;
    // Test assertions must report to the runner, not block on an invisible
    // Debug CRT dialog when a desktop regression is run unattended.
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    // A captured coroutine lambda would outlive its dispatcher closure at the
    // first render await. The named coroutine owns its promise parameter instead.
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([completion,
        files = std::string{reinterpret_cast<char const *>(fixtures), fixturesSize}] {
        RunNativePresentationRegression(completion, files);
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

winrt::Windows::Foundation::IAsyncAction RunBatch2RegressionTests(
    std::shared_ptr<std::promise<std::pair<HRESULT, std::uint32_t>>> completion) {
    using namespace vpaste::winui;
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    std::uint32_t stage = 2000;
    std::vector<std::string> failures;
    const auto previousRequest = g_request;
    static std::vector<std::string> requests;
    requests.clear();

    try {
        g_request = +[](const std::uint8_t *bytes, std::size_t size) {
            requests.emplace_back(reinterpret_cast<const char *>(bytes), size);
        };
        // 注意：SendRequest 在 g_request == nullptr 时返回 0，因此在 stage=2007 暂时置空 g_request 验证防卡死逻辑。

        // 2001: FilterEditor 保持空白名称必填拦截，且 SetLanguage 支持热更新不丢失草稿。
        stage = 2001;
        {
            Border host;
            host.Width(360); host.Height(480);
            std::vector<JsonObject> editorReqs;
            FilterEditor editor{
                [&](std::wstring const &op, JsonObject payload) {
                    payload.Insert(L"op", JsonValue::CreateStringValue(op));
                    payload.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(editorReqs.size() + 1)));
                    editorReqs.push_back(payload);
                    return static_cast<std::uint64_t>(editorReqs.size());
                },
                [](JsonArray const &) {}};
            auto root = editor.TestLoad(JsonObject::Parse(LR"({"id":"","name":"","filter":{"itemType":"Image"}})"), true);
            g_panel.root.Children().Append(host);
            host.Child(root);
            co_await NextNativeFrame();
            editor.TestName(L"   ");
            editor.TestSave();
            const auto save = std::find_if(editorReqs.begin(), editorReqs.end(), [](auto const &req) {
                return req.GetNamedString(L"op") == L"filtersSave";
            });
            if (save == editorReqs.end() || editor.TestName() != L"New filter" ||
                save->GetNamedObject(L"tab").GetNamedString(L"name") != editor.TestName() || !editor.IsOpen()) {
                failures.push_back("filter_editor_blank_name_should_save_visible_default");
            }
            editor.SetLanguage(false);
            if (editor.TestTitle() != L"添加标签" && editor.TestTitle() != L"编辑标签") {
                failures.push_back("filter_editor_set_language_no_effect");
            }
            host.Child(nullptr);
            std::uint32_t hostIndex = 0;
            if (g_panel.root.Children().IndexOf(host, hostIndex)) g_panel.root.Children().RemoveAt(hostIndex);
        }

        // 2002: 超长文本写入搜索框应正常保留并发送完整查询请求，不得截断或静默丢弃。
        stage = 2002;
        {
            SetVisible(true, false);
            g_panel.search.Visibility(Visibility::Visible);
            std::wstring long500;
            long500.reserve(520);
            for (int i = 0; i < 10; ++i) long500 += L"abcdefghijklmnopqrstuvwxyz0123456789_ABCDEFGHIJKLM";
            g_panel.search.Text(winrt::hstring{long500});
            co_await NextNativeFrame();
            const auto reqBefore = requests.size();
            RequestHistory();
            if (requests.size() != reqBefore + 1 || SearchText().size() != long500.size()) {
                failures.push_back("long_search_query_truncated_or_dropped");
            }
            SetSearchText(L"");
            if (g_searchTimer) g_searchTimer.Stop();
            g_panel.search.Visibility(Visibility::Collapsed);
            co_await NextNativeFrame();
        }

        // 2003: QueueView 内联清空确认条。
        stage = 2003;
        {
            Border queueHost; queueHost.Padding(vpaste::winui::UniformThickness(12));
            g_panel.xamlSource.Content(queueHost); ResizeIsland();
            co_await TestBatch2QueueControls(queueHost, failures);
            g_panel.xamlSource.Content(g_panel.viewport); ResizeIsland();
            co_await NextNativeFrame();
        }

        // 2004: Reader SVG 加载、图像像素宽度防放大/限高、以及 SetAppearance 同步刷新 DWM 暗色标志。
        stage = 2004;
        co_await TestBatch2ReaderControls(failures);

        // 2005: OnboardingView::Update 语言切换应触发重绘 + nativeTutorialOpen 应自动退出现有标签管理器和弹框。
        stage = 2005;
        {
            SetTagManagerActive(true);
            co_await NextNativeFrame();
            ApplyResponse(R"({"op":"nativeTutorialOpen","data":{"session":77,"ready":true,"preview":true,"mac":false,"english":false,"shortcut":"Alt+V","items":[],"filters":[{"id":"text","name":"📝 文本","enabled":false},{"id":"image","name":"🖼️ 图片","enabled":false},{"id":"link","name":"🔗 链接","enabled":false},{"id":"file","name":"📁 文件","enabled":false},{"id":"color","name":"🎨 颜色","enabled":false}]}})");
            co_await NextNativeFrame();
            if (g_panel.tagManagerViewActive) {
                failures.push_back("tutorial_open_left_tag_manager_covering_screen");
            }
            const auto zhTitle = g_panel.onboarding ? g_panel.onboarding->TestWelcomeTitle() : winrt::hstring{};
            ApplyResponse(R"({"op":"nativeTutorialState","data":{"session":77,"ready":true,"preview":true,"mac":false,"english":true,"shortcut":"Alt+V","items":[],"filters":[{"id":"text","name":"📝 Text","enabled":false},{"id":"image","name":"🖼️ Image","enabled":false},{"id":"link","name":"🔗 Link","enabled":false},{"id":"file","name":"📁 File","enabled":false},{"id":"color","name":"🎨 Color","enabled":false}]}})");
            co_await NextNativeFrame();
            const auto enTitle = g_panel.onboarding ? g_panel.onboarding->TestWelcomeTitle() : winrt::hstring{};
            if (zhTitle == enTitle || enTitle.empty()) {
                failures.push_back("onboarding_update_ignored_language_change");
            }
            if (g_panel.onboarding) (void)g_panel.onboarding->CancelPreview();
            RemoveTutorial();
            SetTagManagerActive(false);
        }

        // 2006: TrayWindow Update 深色模式应同步刷新 DWM 暗色标题栏属性。
        stage = 2006;
        {
            ApplyResponse(R"({"op":"nativeTrayShow","data":{"anchor":{"x":300,"y":300,"cursor":true},"workArea":{"left":0,"top":0,"right":640,"bottom":480},"dpiScale":1,"english":false,"paused":false,"theme":"light","textScale":1,"updateReady":false}})");
            co_await NextNativeFrame();
            ApplyResponse(R"({"op":"nativeTrayState","data":{"english":false,"paused":false,"theme":"dark","textScale":1,"updateReady":false}})");
            BOOL trayDark = FALSE;
            if (!g_panel.trayWindow || !g_panel.trayWindow->Handle() ||
                FAILED(DwmGetWindowAttribute(g_panel.trayWindow->Handle(), DWMWA_USE_IMMERSIVE_DARK_MODE, &trayDark, sizeof(trayDark))) || !trayDark) {
                failures.push_back("tray_theme_dwm_sync_stale");
            }
            ApplyResponse(R"({"op":"nativeTrayState","data":{"english":false,"paused":false,"theme":"light","textScale":1,"updateReady":false}})");
            BOOL trayLightDarkAttr = TRUE;
            if (!g_panel.trayWindow || !g_panel.trayWindow->Handle() ||
                FAILED(DwmGetWindowAttribute(g_panel.trayWindow->Handle(), DWMWA_USE_IMMERSIVE_DARK_MODE, &trayLightDarkAttr, sizeof(trayLightDarkAttr))) || trayLightDarkAttr) {
                failures.push_back("tray_theme_dwm_sync_stale_to_light");
            }
            if (g_panel.trayWindow) ShowWindow(g_panel.trayWindow->Handle(), SW_HIDE);
        }

        // 2007: SendRequest 返回 0 时不可永久卡死 g_historyLoading 且不可抹零 g_latestHistoryRequestId；
        // 且已有卡片同条件刷新失败时不清空可见历史。
        stage = 2007;
        {
            SetVisible(true, false);
            ApplyResponse(R"({"id":9002,"op":"query","data":{"items":[{"hash":"keep-on-err","itemType":"Text","previewText":"Stay visible"}],"hasMore":true,"nextId":5,"nextTime":500}})");
            co_await NextNativeFrame();
            const auto savedLatestReq = g_latestHistoryRequestId;
            const auto savedCallback = g_request;
            g_request = nullptr;
            RequestMoreHistory(false);
            const bool failedPage = !g_historyLoading && g_historyView.pageFailed;
            RequestHistory();
            const bool stuckLoading = g_historyLoading;
            const bool clobberedId = g_latestHistoryRequestId == 0 && savedLatestReq != 0;
            g_request = savedCallback;
            if (stuckLoading || clobberedId || !failedPage) {
                failures.push_back("send_request_zero_locks_loading_or_clobbers_id");
            }

            // 同条件下后台刷新失败应保留已有卡片。
            RequestHistory();
            JsonObject refreshErr;
            refreshErr.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
            refreshErr.Insert(L"op", JsonValue::CreateStringValue(L"query"));
            refreshErr.Insert(L"error", JsonValue::CreateStringValue(L"Transient query error"));
            ApplyResponse(winrt::to_string(refreshErr.Stringify()));
            if (g_hashes.empty() || g_hashes.front() != L"keep-on-err") {
                failures.push_back("refresh_error_wiped_existing_history");
            }
        }

        // 2008: SearchCompositionChanged(true) IME 组合输入期间切换 Tab，发出的 query 不应含未提交拼音草稿。
        stage = 2008;
        {
            g_panel.search.Text(L"committed");
            SearchCompositionChanged(false, L"committed");
            if (g_searchTimer) g_searchTimer.Stop();
            SearchCompositionChanged(true, L"committed nihao");
            g_panel.search.Text(L"committed nihao");
            const auto before = requests.size();
            RequestHistory();
            if (requests.size() != before || SearchText() != L"committed nihao")
                failures.push_back("ime_composing_text_leaked_to_query");
            SearchCompositionChanged(false, L"");
            g_panel.search.Text(L"");
            if (g_searchTimer) g_searchTimer.Stop();
        }

        // 2009: tags 回复若未影响当前选中标签，且已有历史请求，不应额外重复发出 RequestHistory()。
        stage = 2009;
        {
            SelectBuiltinCategory(0, false);
            g_tagIds = {10}; g_tagNames = {L"Alpha"};
            RebuildTagFilter();
            RequestHistory();
            const auto before = requests.size();
            ApplyResponse(R"({"id":9003,"op":"tags","data":{"items":[{"id":10,"name":"Alpha"},{"id":11,"name":"Beta"}]}})");
            const auto queryCount = std::count_if(requests.begin() + before, requests.end(), [](auto const &bytes) {
                return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"query";
            });
            if (queryCount > 0) {
                failures.push_back("unchanged_tags_triggered_redundant_query");
            }
        }

        // 2010: 删除中间第 2 项或最后一项后刷新，未找到原 hash 时应停在 min(deletedIndex, size - 1)。
        stage = 2010;
        {
            ApplyResponse(R"({"id":9004,"op":"query","data":{"items":[{"hash":"d0","itemType":"Text"},{"hash":"d1","itemType":"Text"},{"hash":"d2","itemType":"Text"}]}})");
            co_await NextNativeFrame();
            g_panel.history.SelectedIndex(2);
            g_selectedHash = L"d2";
            RequestHistory();
            JsonObject afterDelete;
            afterDelete.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
            afterDelete.Insert(L"op", JsonValue::CreateStringValue(L"query"));
            afterDelete.Insert(L"data", JsonObject::Parse(LR"({"items":[{"hash":"d0","itemType":"Text"},{"hash":"d1","itemType":"Text"}]})"));
            ApplyResponse(winrt::to_string(afterDelete.Stringify()));
            if (g_selectedHash != L"d1" || g_panel.history.SelectedIndex() != 1) {
                failures.push_back("delete_last_card_jumped_to_zero");
            }
        }

        // 2011: clipboardItemEdited 把多选和单选归位状态从 previousHash 迁移到新 hash。
        stage = 2011;
        {
            ApplyResponse(R"({"id":9005,"op":"query","data":{"items":[{"hash":"edit-old","itemType":"Text"}]}})");
            co_await NextNativeFrame();
            g_selectedHash = L"edit-old";
            if (!g_queueSelectionMode) ToggleQueueSelectionMode();
            g_queueSelectedHashes = {L"edit-old"};
            ApplyResponse(R"({"id":0,"op":"clipboardItemEdited","data":{"previousHash":"edit-old","hash":"edit-new"}})");
            if (g_queueSelectedHashes != std::vector<std::wstring>{L"edit-new"}) {
                failures.push_back("clipboard_item_edited_left_stale_hash");
            }
            if (g_queueSelectionMode) ToggleQueueSelectionMode();
            if (g_selectedHash != L"edit-new") {
                failures.push_back("clipboard_item_edited_left_stale_return_hash");
            }
        }

        // 2012: queueStateUpdate 带 active=false 时应关闭队列管理视图。
        stage = 2012;
        {
            SetQueueViewActive(true);
            co_await NextNativeFrame();
            ApplyResponse(R"({"id":0,"op":"queueStateUpdate","data":{"active":false,"busy":false,"capacity":100,"revision":99,"items":[],"error":null,"undoHash":null}})");
            co_await NextNativeFrame();
            if (g_queueViewActive) {
                failures.push_back("queue_inactive_update_did_not_close_view");
                SetQueueViewActive(false);
            }
        }

        // 2013: query 摘要自带 isRichText=true 时，rows[0].isRichText 应在细节加载前即为 true。
        stage = 2013;
        {
            ApplyResponse(R"({"id":9006,"op":"query","data":{"items":[{"hash":"rich-summary","itemType":"Text","isRichText":true,"previewText":"Rich"}]}})");
            co_await NextNativeFrame();
            if (g_panel.rows.empty() || !g_panel.rows.front().isRichText) {
                failures.push_back("history_row_missing_is_rich_text_flag");
            }
        }

        // 2014: queryMore 翻页与隐藏状态刷新不可覆写置顶预览令牌 g_latestPreviewRequestId。
        stage = 2014;
        {
            SetVisible(true, false);
            ApplyResponse(R"({"id":9007,"op":"query","data":{"items":[{"hash":"pv-0","itemType":"Text"}],"hasMore":true,"nextId":1,"nextTime":100}})");
            co_await NextNativeFrame();
            (void)SendRequest(L"previewToggle", L"pv-0");
            const auto pinnedToken = g_latestPreviewRequestId;
            RequestMoreHistory(false);
            JsonObject moreResp;
            moreResp.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
            moreResp.Insert(L"op", JsonValue::CreateStringValue(L"queryMore"));
            moreResp.Insert(L"data", JsonObject::Parse(LR"({"items":[{"hash":"pv-1","itemType":"Text"}],"hasMore":false})"));
            ApplyResponse(winrt::to_string(moreResp.Stringify()));
            if (g_latestPreviewRequestId != pinnedToken) {
                failures.push_back("query_more_clobbered_pinned_preview_token");
            }
            SetVisible(false, false);
            g_latestPreviewRequestId = pinnedToken;
            RequestHistory();
            JsonObject bgResp;
            bgResp.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
            bgResp.Insert(L"op", JsonValue::CreateStringValue(L"query"));
            bgResp.Insert(L"data", JsonObject::Parse(LR"({"items":[{"hash":"pv-bg","itemType":"Text"},{"hash":"pv-0","itemType":"Text"}]})"));
            ApplyResponse(winrt::to_string(bgResp.Stringify()));
            if (g_latestPreviewRequestId != pinnedToken) {
                failures.push_back("hidden_background_query_clobbered_pinned_preview_token");
            }
            SetVisible(true, false);
        }

        // 2015: kSetLanguage 应同步清理 renderedItems/更新卡片类型文本，kSetTheme/ActualThemeChanged 传播到弹窗，
        // historyReset 应刷新开启着的 TagManager，分类/标签切换后记录聚焦恢复。
        stage = 2015;
        {
            ApplyResponse(R"({"id":9008,"op":"query","data":{"items":[{"hash":"lang-1","itemType":"Text","previewText":"Lang check"}]}})");
            co_await NextNativeFrame();
            WindowProc(g_panel.window, kSetLanguage, 1, 0);
            if (g_panel.rows.empty() || g_panel.rows.front().type.Text() != L"Text") {
                failures.push_back("language_switch_did_not_update_existing_cards");
            }
            WindowProc(g_panel.window, kSetLanguage, 0, 0);
            if (g_panel.rows.empty() || g_panel.rows.front().type.Text() != L"文本") {
                failures.push_back("language_switch_back_zh_did_not_update_existing_cards");
            }
            // 测试 kSetTheme 对 reader 标题栏和打开的 filterEditor 语言/主题同步生效。
            if (g_panel.filterEditor) {
                g_panel.filterEditor->Show(g_panel.addTag, JsonObject::Parse(LR"({"id":"","name":"","filter":{}})"),
                    g_english, g_panel.root.RequestedTheme(), g_panel.root);
                co_await NextNativeFrame();
                WindowProc(g_panel.window, kSetLanguage, 1, 0);
                if (g_panel.filterEditor->TestTitle() != L"Add Tab" && g_panel.filterEditor->TestTitle() != L"Edit Tab") {
                    failures.push_back("kset_language_did_not_update_open_filter_editor");
                }
                WindowProc(g_panel.window, kSetTheme, 1, 0);
                co_await NextNativeFrame();
                WindowProc(g_panel.window, kSetTheme, 2, 0);
                if (g_panel.filterEditor->TestRoot().RequestedTheme() != ElementTheme::Dark) {
                    failures.push_back("panel_kset_theme_filter_editor_stale");
                }
                g_panel.filterEditor->Hide();
            } else {
                WindowProc(g_panel.window, kSetTheme, 1, 0);
                co_await NextNativeFrame();
                WindowProc(g_panel.window, kSetTheme, 2, 0);
            }
            if (g_panel.reader) {
                auto readerOpen = JsonObject::Parse(LR"({"op":"nativeReader","data":{"generation":91,"kind":"text","text":"Theme sync check","rect":{"x":80,"y":80,"width":400,"height":240},"durationMs":0,"easing":[0.22,1,0.36,1]}})");
                g_panel.reader->Receive(readerOpen);
                co_await NextNativeFrame();
                BOOL readerDark = FALSE;
                const auto readerHwnd = reinterpret_cast<HWND>(vpaste::winui::ReaderWindowHandle());
                if (!readerHwnd || FAILED(DwmGetWindowAttribute(readerHwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &readerDark, sizeof(readerDark))) || !readerDark) {
                    failures.push_back("panel_kset_theme_reader_dwm_stale");
                }
                g_panel.reader->Receive(JsonObject::Parse(LR"({"op":"nativeReaderHide","data":{"generation":92}})"));
            }
            WindowProc(g_panel.window, kSetTheme, 0, 0);
            WindowProc(g_panel.window, kSetLanguage, 0, 0);

            // historyReset 应自动刷新打开着的 tagManager。
            SetTagManagerActive(true);
            co_await NextNativeFrame();
            const auto beforeResetReq = requests.size();
            ApplyResponse(R"({"op":"historyReset","data":{}})");
            const bool refreshedTagManager = std::any_of(requests.begin() + beforeResetReq, requests.end(), [](auto const &bytes) {
                return JsonObject::Parse(winrt::to_hstring(bytes)).GetNamedString(L"op") == L"tagsList";
            });
            if (!refreshedTagManager) {
                failures.push_back("history_reset_did_not_refresh_active_tag_manager");
            }
            SetTagManagerActive(false);

            // SelectBuiltinCategory(1, true) 应调度 kFocusHistory。
            MSG msg{};
            while (PeekMessageW(&msg, g_panel.window, kFocusHistory, kFocusHistory, PM_REMOVE)) {}
            SelectBuiltinCategory(1, true);
            const bool posted = PeekMessageW(&msg, g_panel.window, kFocusHistory, kFocusHistory, PM_NOREMOVE) != FALSE;
            if (!posted) {
                failures.push_back("select_category_did_not_return_focus_to_history");
            }
            while (PeekMessageW(&msg, g_panel.window, kFocusHistory, kFocusHistory, PM_REMOVE)) {}
            SelectBuiltinCategory(0, false);

            // 2016: 点击分类筛选导致旧聚焦卡片被 ApplyResponse 移除后，焦点不得回落到“Windows 使用引导”等顶栏按钮。
            stage = 2016;
            if (g_panel.appActions) {
                ApplyResponse(R"({"id":0,"op":"appState","data":{"developerMode":true,"update":{"revision":0,"status":"disabled","portable":false,"availableVersion":null}}})");
            }
            SetVisible(true, false, false);
            co_await NextNativeFrame();
            SelectBuiltinCategory(0, false);
            RequestHistory();
            {
                auto r1 = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"cat-a-1","itemType":"Text","previewText":"Cat A"}],"hasMore":false}})");
                r1.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(r1.Stringify()));
            }
            co_await NextNativeFrame();
            WindowProc(g_panel.window, kFocusHistory, 1, 0);
            co_await NextNativeFrame();
            // 模拟鼠标切换分类触发 SelectionChanged -> 期间 kFocusHistory 先落到旧卡 -> 随后 query 替换旧卡（包含非空与空结果场景）
            g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(1));
            co_await NextNativeFrame();
            {
                auto r2 = JsonObject::Parse(LR"({"op":"query","data":{"items":[{"hash":"cat-b-1","itemType":"Text","previewText":"Cat B"}],"hasMore":false}})");
                r2.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(r2.Stringify()));
            }
            co_await NextNativeFrame();
            const auto focusedAfterReplace = Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot());
            const auto focusedDep = focusedAfterReplace.try_as<DependencyObject>();
            const auto focusedName = focusedDep ? Automation::AutomationProperties::GetName(focusedDep) : L"";
            if (!focusedAfterReplace || MainInputArea(focusedAfterReplace) != InputArea::History) {
                std::fprintf(stderr, "BATCH2_FOCUS_DIAG: replace focusedName=%ls area=%d\n",
                    focusedName.c_str(), static_cast<int>(MainInputArea(focusedAfterReplace)));
                failures.push_back("category_click_lost_history_focus_to_header");
            }
            // 再切回全部分类且返回空结果，确认焦点也不应滑进顶栏按钮（如 Windows 使用引导）
            g_panel.filter.SelectedItem(g_panel.filter.Items().GetAt(0));
            co_await NextNativeFrame();
            {
                auto r3 = JsonObject::Parse(LR"({"op":"query","data":{"items":[],"hasMore":false}})");
                r3.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(g_latestHistoryRequestId)));
                ApplyResponse(winrt::to_string(r3.Stringify()));
            }
            co_await NextNativeFrame();
            const auto focusedAfterEmpty = Input::FocusManager::GetFocusedElement(g_panel.root.XamlRoot());
            const auto emptyDep = focusedAfterEmpty.try_as<DependencyObject>();
            const auto emptyName = emptyDep ? Automation::AutomationProperties::GetName(emptyDep) : L"";
            if (!focusedAfterEmpty || MainInputArea(focusedAfterEmpty) != InputArea::History) {
                std::fprintf(stderr, "BATCH2_FOCUS_DIAG: empty focusedName=%ls area=%d\n",
                    emptyName.c_str(), static_cast<int>(MainInputArea(focusedAfterEmpty)));
                failures.push_back("empty_category_lost_history_focus_to_header");
            }
            SetVisible(false, false, false);
        }
    } catch (winrt::hresult_error const &err) {
        failures.push_back("exception_hr_" + std::to_string(static_cast<unsigned>(err.code())) + "_stage_" + std::to_string(stage));
    } catch (...) {
        failures.push_back("unknown_exception_stage_" + std::to_string(stage));
    }

    g_request = previousRequest;
    for (auto const &item : failures) {
        std::fprintf(stderr, "BATCH2_REGRESSION_FAILURE: %s\n", item.c_str());
    }
    std::fprintf(stderr, "BATCH2_REGRESSION_SUMMARY: total_failures=%zu\n", failures.size());
    completion->set_value({failures.empty() ? S_OK : E_FAIL, failures.empty() ? stage : 2999});
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_test_batch2_regressions(std::uint32_t *stage) noexcept {
    if (!stage || !g_dispatcher) return E_INVALIDARG;
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([completion] {
        RunBatch2RegressionTests(completion);
    })) return E_FAIL;
    if (result.wait_for(std::chrono::seconds(30)) != std::future_status::ready) {
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    const auto [status, completedStage] = result.get();
    *stage = completedStage;
    return status;
}

winrt::fire_and_forget RunStage1DiagnosticsProbe(
    std::wstring logPath,
    std::shared_ptr<std::promise<std::pair<HRESULT, std::uint32_t>>> completion) {
    std::uint32_t stage = 3001;
    try {
        // 3001: 校验脱敏清洗函数与轮转路径推导（不劈断 UTF-8，去除控制字符/换行）。
        const auto sanitized = vpaste::winui::SanitizeDiagnosticText("line1\r\nline2\t\x01ok", 64);
        winrt::check_hresult(sanitized == "line1 line2 ok" ? S_OK : E_FAIL);
        const auto prevPath = vpaste::winui::PreviousDiagnosticsLogPath(logPath);
        winrt::check_hresult(prevPath.ends_with(L".prev.log") ? S_OK : E_FAIL);

        // 3002: 校验独立日志写入器达到上限后自动轮转为 .prev.log。
        stage = 3002;
        {
            const std::wstring rotatePath = logPath + L".rotate-test.log";
            const std::wstring rotatePrev = vpaste::winui::PreviousDiagnosticsLogPath(rotatePath);
            DeleteFileW(rotatePath.c_str());
            DeleteFileW(rotatePrev.c_str());
            vpaste::winui::DiagnosticsLogger bounded;
            bounded.SetPath(rotatePath, 160);
            winrt::check_hresult(bounded.WriteLine("probe_one", "payload=alpha_0123456789") ? S_OK : E_FAIL);
            winrt::check_hresult(bounded.WriteLine("probe_two", "payload=beta_0123456789") ? S_OK : E_FAIL);
            winrt::check_hresult(GetFileAttributesW(rotatePrev.c_str()) != INVALID_FILE_ATTRIBUTES ? S_OK : E_FAIL);
            DeleteFileW(rotatePath.c_str());
            DeleteFileW(rotatePrev.c_str());
        }

        // 3003: 校验主窗口类已移除 COLOR_WINDOW + 1 背景画刷且绝未设置 WS_EX_NOREDIRECTIONBITMAP。
        stage = 3003;
        winrt::check_hresult(g_panel.window != nullptr ? S_OK : E_UNEXPECTED);
        const auto classBrush = GetClassLongPtrW(g_panel.window, GCLP_HBRBACKGROUND);
        winrt::check_hresult(classBrush == 0 ? S_OK : E_FAIL);
        const auto exStyle = GetWindowLongPtrW(g_panel.window, GWL_EXSTYLE);
        winrt::check_hresult((exStyle & WS_EX_NOREDIRECTIONBITMAP) == 0 ? S_OK : E_FAIL);

        // 3004: 校验停靠态与标签管理态 WM_ERASEBKGND 均返回 1 且不崩溃。
        stage = 3004;
        SetVisible(false, false, false);
        const auto dockErase = SendMessageW(g_panel.window, WM_ERASEBKGND, 0, 0);
        winrt::check_hresult(dockErase == 1 ? S_OK : E_FAIL);
        SetTagManagerActive(true);
        co_await NextNativeFrame();
        HDC screenDc = GetDC(g_panel.window);
        const auto mgmtErase = SendMessageW(g_panel.window, WM_ERASEBKGND, reinterpret_cast<WPARAM>(screenDc), 0);
        if (screenDc) ReleaseDC(g_panel.window, screenDc);
        winrt::check_hresult(mgmtErase == 1 ? S_OK : E_FAIL);
        SetTagManagerActive(false);
        co_await NextNativeFrame();

        // 3005: 合成发送 WM_POWERBROADCAST(PBT_APMSUSPEND -> PBT_APMRESUMEAUTOMATIC) 并触发首次 SetVisible(true)，
        // 验证纯原子状态机正常流转且仅在首次显示时写入一次 power_resume_first_show 诊断日志。
        stage = 3005;
        g_powerLifecycle.Reset();
        SetVisible(false, false, false);
        winrt::check_hresult(SendMessageW(g_panel.window, WM_POWERBROADCAST, PBT_APMSUSPEND, 0) == TRUE ? S_OK : E_FAIL);
        const auto suspendedSnap = g_powerLifecycle.Snapshot(GetTickCount64());
        winrt::check_hresult(suspendedSnap.suspended && suspendedSnap.suspendCount == 1 && !suspendedSnap.pendingFirstShow ? S_OK : E_FAIL);
        winrt::check_hresult(SendMessageW(g_panel.window, WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC, 0) == TRUE ? S_OK : E_FAIL);
        const auto resumedSnap = g_powerLifecycle.Snapshot(GetTickCount64());
        winrt::check_hresult(!resumedSnap.suspended && resumedSnap.resumeCount == 1 && resumedSnap.pendingFirstShow ? S_OK : E_FAIL);

        SetVisible(true, true, false);
        co_await NextNativeFrame();
        const auto afterShowSnap = g_powerLifecycle.Snapshot(GetTickCount64());
        winrt::check_hresult(!afterShowSnap.pendingFirstShow ? S_OK : E_FAIL);

        // 二次隐藏再显示不应重复标记 pendingFirstShow。
        SetVisible(false, false, false);
        SetVisible(true, true, false);
        co_await NextNativeFrame();
        SetVisible(false, false, false);

        completion->set_value({S_OK, stage});
    } catch (winrt::hresult_error const &err) {
        completion->set_value({err.code(), stage});
    } catch (...) {
        completion->set_value({E_FAIL, stage});
    }
}

extern "C" __declspec(dllexport) int32_t vpaste_winui_test_stage1_diagnostics(
    const wchar_t *logPath, std::uint32_t *stage) noexcept {
    if (!logPath || !stage || !g_dispatcher) return E_INVALIDARG;
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    auto completion = std::make_shared<std::promise<std::pair<HRESULT, std::uint32_t>>>();
    auto result = completion->get_future();
    std::wstring pathCopy(logPath);
    if (!g_dispatcher.DispatcherQueue().TryEnqueue([pathCopy = std::move(pathCopy), completion] {
        RunStage1DiagnosticsProbe(pathCopy, completion);
    })) return E_FAIL;
    if (result.wait_for(std::chrono::seconds(30)) != std::future_status::ready) {
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    const auto [status, completedStage] = result.get();
    *stage = completedStage;
    return status;
}
#endif
