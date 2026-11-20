#include "WinUiTrayWindow.h"
#include "WinUiAppearance.h"
#include "WinUiGeometry.h"
#include <dwmapi.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <utility>
#include <winrt/Microsoft.UI.Composition.SystemBackdrops.h>
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Interop.h>
#include <winrt/Microsoft.UI.Text.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Hosting.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.h>

#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {
namespace {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Microsoft::UI::Xaml::Media;
using winrt::Microsoft::UI::Xaml::Automation::AutomationProperties;
using winrt::Microsoft::UI::Text::FontWeights;
using winrt::Windows::Data::Json::JsonObject;

constexpr wchar_t TrayClass[] = L"VPasteWinUiTrayWindow";
constexpr UINT_PTR OutsideClickTimer = 1;
constexpr UINT OutsideClickIntervalMs = 30;
// TrayMenu.module.css is the reference. DWM now owns the shadow; still
// reserve its old 8-DIP fit/placement margin around the visible surface.
constexpr double ContentWidth = 200, Inset = 5, Spacing = 2, StatusHeight = 36, RowHeight = 34, Gutter = 8;
constexpr double MenuFontSize = 13, StatusFontSize = 12.5, BadgeFontSize = 10;
constexpr LONG CursorGap = 8;
constexpr std::array Commands{
    L"pause", L"update", L"showMain", L"settings", L"quit",
};
constexpr std::size_t Status = 0, UpdateRow = 1, Main = 2, Settings = 3, Quit = 4;

double ContentHeight(bool update) {
    return Inset * 2 + StatusHeight + (RowHeight + Spacing) * (update ? 4 : 3);
}

struct Placement {
    POINT anchor;
    RECT work;
    double dpiScale;
    bool cursor;

    RECT ClientRect(double textScale, bool update) const {
        const auto scale = dpiScale * textScale;
        const auto pixels = [scale](double dips) { return static_cast<LONG>(std::lround(dips * scale)); };
        const auto gutter = pixels(Gutter);
        const auto width = pixels(ContentWidth + Gutter * 2);
        const auto height = pixels(ContentHeight(update) + Gutter * 2);
        const auto x = cursor ? anchor.x + CursorGap : anchor.x - width / 2;
        const auto y = cursor ? anchor.y - height - CursorGap : anchor.y;
        const auto box = ClampToWorkArea({x, y, x + width, y + height}, work);
        const auto marginX = std::min(gutter, (box.right - box.left - 1) / 2);
        const auto marginY = std::min(gutter, (box.bottom - box.top - 1) / 2);
        return {box.left + marginX, box.top + marginY, box.right - marginX, box.bottom - marginY};
    }
};

SolidColorBrush Brush(std::uint32_t rgb) {
    return SolidColorBrush{winrt::Windows::UI::Color{255, static_cast<std::uint8_t>(rgb >> 16),
        static_cast<std::uint8_t>(rgb >> 8), static_cast<std::uint8_t>(rgb)}};
}

bool MousePressed() noexcept {
    return (GetAsyncKeyState(VK_LBUTTON) | GetAsyncKeyState(VK_RBUTTON) | GetAsyncKeyState(VK_MBUTTON)) < 0;
}

}

struct TrayWindow::Impl : std::enable_shared_from_this<Impl> {
    explicit Impl(Request callback) : request(std::move(callback)) {}
    Request request;
    HWND window = nullptr;
    Hosting::DesktopWindowXamlSource source{nullptr};
    Grid root{nullptr};
    Viewbox viewport{nullptr};
    StackPanel list{nullptr};
    TextBlock statusLabel{nullptr}, badgeLabel{nullptr};
    Border dot{nullptr}, badge{nullptr};
    std::array<Button, Commands.size()> buttons{nullptr, nullptr, nullptr, nullptr, nullptr};
    std::array<std::uint64_t, Commands.size()> pending{};
    Placement placement{};
    double textScale = 1;
    bool english = false, paused = false, updateReady = false, mouseWasDown = false;
    ElementTheme theme = ElementTheme::Default;

    ~Impl() { Destroy(); }

    void Destroy() noexcept {
        if (window) {
            KillTimer(window, OutsideClickTimer);
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        }
        if (source) {
            try { source.SystemBackdrop(nullptr); source.Content(nullptr); source.Close(); }
            catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
            source = nullptr;
        }
        if (window) DestroyWindow(std::exchange(window, nullptr));
    }

    winrt::hstring Text(wchar_t const *zh, wchar_t const *en) const { return english ? en : zh; }
    bool Visible() const noexcept { return window && IsWindowVisible(window); }

    static LRESULT CALLBACK WindowProc(HWND handle, UINT message, WPARAM wparam, LPARAM lparam) {
        auto self = reinterpret_cast<Impl *>(GetWindowLongPtrW(handle, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            self = static_cast<Impl *>(reinterpret_cast<CREATESTRUCTW *>(lparam)->lpCreateParams);
            SetWindowLongPtrW(handle, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(handle, message, wparam, lparam);
        try {
            switch (message) {
            case WM_NCCALCSIZE: if (wparam) return 0; break;
            case WM_NCHITTEST: return HTCLIENT;
            case WM_ERASEBKGND: return 1;
            case WM_DPICHANGED:
            case WM_SIZE: self->ResizeIsland(); return 0;
            case WM_ACTIVATE:
                if (LOWORD(wparam) == WA_INACTIVE) self->Hide();
                break;
            case WM_CLOSE: self->Hide(); return 0;
            case WM_KEYDOWN:
                if (wparam == VK_ESCAPE) { self->Hide(); return 0; }
                break;
            case WM_TIMER:
                if (wparam == OutsideClickTimer) { self->CheckOutsidePress(); return 0; }
                break;
            case WM_DISPLAYCHANGE: self->Hide(); break;
            case WM_SETTINGCHANGE:
                if (wparam == SPI_SETWORKAREA) self->Hide();
                self->ApplyAppearance();
                break;
            case WM_THEMECHANGED: self->ApplyAppearance(); break;
            }
        } catch (winrt::hresult_error const &error) {
            std::fprintf(stderr, "WinUI tray message 0x%X failed: 0x%08X\n", message, static_cast<unsigned>(error.code()));
            self->Hide();
        }
        return DefWindowProcW(handle, message, wparam, lparam);
    }

    void Build() {
        WNDCLASSEXW type{sizeof(WNDCLASSEXW)};
        type.lpfnWndProc = WindowProc; type.hInstance = GetModuleHandleW(nullptr);
        type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.lpszClassName = TrayClass;
        if (!RegisterClassExW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) winrt::throw_last_error();
        window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, TrayClass, L"vPaste",
            WS_POPUP | WS_THICKFRAME | WS_SYSMENU, 0, 0, 200, 154,
            nullptr, nullptr, GetModuleHandleW(nullptr), this);
        winrt::check_bool(window != nullptr);
        source = Hosting::DesktopWindowXamlSource{};
        source.Initialize(winrt::Microsoft::UI::GetWindowIdFromWindow(window));
        root = Grid();
        ApplyStyle(root, L"VPaste.ReaderCanvas");
        viewport = Viewbox();
        viewport.Stretch(Stretch::Uniform);
        root.Children().Append(viewport);
        list = StackPanel();
        list.Width(ContentWidth); list.Padding(UniformThickness(Inset)); list.Spacing(Spacing);
        list.TabFocusNavigation(Input::KeyboardNavigationMode::Cycle);
        AutomationProperties::SetAutomationId(root, L"VPasteTrayMenu");
        viewport.Child(list);
        const auto weak = weak_from_this();
        for (std::size_t i = 0; i < buttons.size(); ++i) {
            Button button;
            if (i != Status) ApplyStyle(button, L"SubtleButtonStyle");
            button.Height(i == Status ? StatusHeight : RowHeight);
            button.FontSize(MenuFontSize); button.FontWeight(FontWeights::Medium());
            // The viewport accounts for the host's text scale, once.
            button.IsTextScaleFactorEnabled(false);
            button.CornerRadius(UniformRadius(8));
            button.Padding(Thickness{i == Status ? 8.0 : 10.0, 0, i == Status ? 8.0 : 10.0, 0});
            button.HorizontalAlignment(HorizontalAlignment::Stretch);
            button.HorizontalContentAlignment(i == Status ? HorizontalAlignment::Stretch : HorizontalAlignment::Left);
            AutomationProperties::SetAutomationId(button, L"VPasteTray-" + winrt::hstring{Commands[i]});
            button.Click([weak, i](auto const &, auto const &) {
                if (const auto self = weak.lock()) self->Invoke(i);
            });
            list.Children().Append(button);
            buttons[i] = button;
        }
        BuildStatus();
        root.PreviewKeyDown([weak](auto const &, auto const &args) {
            if (const auto self = weak.lock()) args.Handled(self->HandleKey(static_cast<unsigned>(args.Key())));
        });
        root.ActualThemeChanged([weak](auto const &, auto const &) {
            if (const auto self = weak.lock()) self->ApplyAppearance();
        });
        root.Loaded([weak](auto const &, auto const &) {
            if (const auto self = weak.lock()) self->FocusFirst();
        });
        source.Content(root); source.SiteBridge().Show();
        const auto corners = DWMWCP_ROUND;
        (void)DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
        const MARGINS shadow{1, 1, 1, 1};
        (void)DwmExtendFrameIntoClientArea(window, &shadow);
    }

    void BuildStatus() {
        Grid row;
        row.ColumnSpacing(6);
        ColumnDefinition leading, action, state;
        leading.Width(GridLength{7, GridUnitType::Pixel}); state.Width(GridLength{1, GridUnitType::Auto});
        row.ColumnDefinitions().Append(leading);
        row.ColumnDefinitions().Append(action);
        row.ColumnDefinitions().Append(state);
        dot = Border();
        dot.Width(7); dot.Height(7); dot.CornerRadius(UniformRadius(4));
        dot.VerticalAlignment(VerticalAlignment::Center);
        row.Children().Append(dot);
        statusLabel = TextBlock();
        statusLabel.FontSize(StatusFontSize); statusLabel.FontWeight(FontWeights::SemiBold());
        statusLabel.IsTextScaleFactorEnabled(false);
        statusLabel.TextTrimming(TextTrimming::CharacterEllipsis);
        statusLabel.VerticalAlignment(VerticalAlignment::Center);
        Grid::SetColumn(statusLabel, 1); row.Children().Append(statusLabel);
        badgeLabel = TextBlock();
        badgeLabel.FontSize(BadgeFontSize); badgeLabel.FontWeight(FontWeights::SemiBold());
        badgeLabel.IsTextScaleFactorEnabled(false);
        badge = Border();
        badge.Padding(Thickness{5, 1, 5, 1}); badge.CornerRadius(UniformRadius(8));
        badge.VerticalAlignment(VerticalAlignment::Center); badge.Child(badgeLabel);
        Grid::SetColumn(badge, 2); row.Children().Append(badge);
        // The native button's accessible name includes both texts.
        AutomationProperties::SetAccessibilityView(row, Automation::Peers::AccessibilityView::Raw);
        buttons[Status].Content(row);
    }

    void ApplyAppearance() {
        if (!root || !source || !dot || !badge) return;
        const bool contrast = HighContrastEnabled();
        const BOOL dark = root.ActualTheme() == ElementTheme::Dark;
        (void)DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
        const bool acrylic = !contrast && winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController::IsSupported();
        if (acrylic && !source.SystemBackdrop()) {
            try { source.SystemBackdrop(DesktopAcrylicBackdrop{}); }
            catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
        } else if (!acrylic && source.SystemBackdrop()) source.SystemBackdrop(nullptr);
        if (source.SystemBackdrop()) root.Background(SolidColorBrush{winrt::Windows::UI::Colors::Transparent()});
        else root.ClearValue(Panel::BackgroundProperty());

        if (contrast) {
            buttons[Status].ClearValue(Control::BackgroundProperty());
            buttons[Status].ClearValue(Control::BorderBrushProperty());
            dot.Visibility(Visibility::Collapsed);
            badge.ClearValue(Border::BackgroundProperty());
            badgeLabel.ClearValue(TextBlock::ForegroundProperty());
            buttons[UpdateRow].ClearValue(Control::ForegroundProperty());
            return;
        }
        dot.Visibility(Visibility::Visible);
        buttons[Status].Background(Brush(paused ? (dark ? 0x3C282E : 0xF8EBED) : (dark ? 0x283644 : 0xE8F0F8)));
        buttons[Status].BorderBrush(Brush(paused ? (dark ? 0x5B3D46 : 0xE7CBD0) : (dark ? 0x3C5168 : 0xC6D9E9)));
        dot.Background(Brush(paused ? (dark ? 0xFF928C : 0xB92C35) : (dark ? 0x65D9A0 : 0x16734B)));
        badge.Background(Brush(paused ? (dark ? 0x50303B : 0xFFF5F5) : (dark ? 0x35455C : 0xF4F9FF)));
        badgeLabel.Foreground(Brush(paused ? (dark ? 0xFFABAA : 0xA4262C) : (dark ? 0x9ACCFF : 0x005FB8)));
        buttons[UpdateRow].Foreground(Brush(dark ? 0x65D9A0 : 0x16734B));
    }

    void ResizeIsland() const {
        if (!source) return;
        RECT client{};
        winrt::check_bool(GetClientRect(window, &client));
        source.SiteBridge().MoveAndResize({0, 0, client.right, client.bottom});
    }

    void Place() const {
        const auto bounds = placement.ClientRect(textScale, updateReady);
        winrt::check_bool(SetWindowPos(window, HWND_TOPMOST, bounds.left, bounds.top,
            bounds.right - bounds.left, bounds.bottom - bounds.top, SWP_NOACTIVATE | SWP_NOOWNERZORDER));
        ResizeIsland();
    }

    void FocusOpeningRow() const {
        // The shell opens the custom popup from a tray click. Programmatic
        // focus can inherit a keyboard cue from the previous activation.
        // Pointer focus is still eligible for Tab/arrow/Enter navigation.
        (void)buttons[Status].Focus(FocusState::Pointer);
    }

    void FocusFirst() const {
        if (!Visible() || !root.IsLoaded() || GetForegroundWindow() != window) return;
        const auto island = winrt::Microsoft::UI::GetWindowFromWindowId(source.SiteBridge().WindowId());
        if (island && GetFocus() != island && !IsChild(island, GetFocus())) SetFocus(island);
        FocusOpeningRow();
    }

    bool HandleKey(unsigned key) {
        if (key == VK_ESCAPE) { Hide(); return true; }
        if (key != VK_UP && key != VK_DOWN && key != VK_HOME && key != VK_END) return false;
        const auto focused = Input::FocusManager::GetFocusedElement(root.XamlRoot());
        const auto current = std::find(buttons.begin(), buttons.end(), focused);
        const auto count = static_cast<int>(buttons.size());
        const bool forward = key == VK_DOWN || key == VK_HOME;
        int index = static_cast<int>(current - buttons.begin());
        if (key == VK_HOME || key == VK_END || current == buttons.end()) index = forward ? count - 1 : 0;
        for (int i = 0; i < count; ++i) {
            index = (index + (forward ? 1 : -1) + count) % count;
            const auto &button = buttons[static_cast<std::size_t>(index)];
            if (button.Visibility() == Visibility::Visible && button.IsEnabled() && button.Focus(FocusState::Keyboard)) break;
        }
        return true;
    }

    void Hide() noexcept {
        if (!window) return;
        KillTimer(window, OutsideClickTimer);
        if (Visible()) ShowWindow(window, SW_HIDE);
    }

    void ObservePress(bool pressed, POINT cursor) {
        const auto wasDown = std::exchange(mouseWasDown, pressed);
        if (!Visible() || !pressed || wasDown) return;
        RECT bounds{};
        if (GetWindowRect(window, &bounds) && !PtInRect(&bounds, cursor)) Hide();
    }

    void CheckOutsidePress() {
        POINT cursor{};
        if (GetCursorPos(&cursor)) ObservePress(MousePressed(), cursor);
    }

    void Invoke(std::size_t i) {
        if (!Visible() || pending[i] || (i == UpdateRow && !updateReady)) return;
        RECT bounds{}; winrt::check_bool(GetWindowRect(window, &bounds));
        pending[i] = request(Commands[i], {bounds.left + (bounds.right - bounds.left) / 2,
            bounds.top + (bounds.bottom - bounds.top) / 2});
        if (pending[i] && (i == Status || i == UpdateRow)) {
            // Keep keyboard focus during the short request. Invoke already
            // suppresses re-entry until the shared command replies.
            buttons[i].Opacity(0.72);
        }
    }

    void Complete(std::uint64_t id, bool success) {
        if (!id) return;
        const auto item = std::find(pending.begin(), pending.end(), id);
        if (item == pending.end()) return;
        *item = 0;
        const auto index = static_cast<std::size_t>(item - pending.begin());
        buttons[index].Opacity(1);
        if (success && (index == Main || index == Settings || index == Quit)) Hide();
    }

    void Update(JsonObject const &data) {
        if (!window) return;
        const auto previousHeight = ContentHeight(updateReady) * textScale;
        english = data.GetNamedBoolean(L"english");
        paused = data.GetNamedBoolean(L"paused");
        updateReady = data.GetNamedBoolean(L"updateReady");
        textScale = data.GetNamedNumber(L"textScale");
        const auto mode = data.GetNamedString(L"theme");
        theme = mode == L"dark" ? ElementTheme::Dark : mode == L"light" ? ElementTheme::Light : ElementTheme::Default;
        root.RequestedTheme(theme);
        const auto title = Text(L"vPaste 菜单", L"vPaste menu");
        SetWindowTextW(window, title.c_str()); AutomationProperties::SetName(root, title);
        const auto action = paused ? Text(L"恢复记录", L"Resume Recording") : Text(L"暂停记录", L"Pause Recording");
        const auto state = paused ? Text(L"已暂停", L"Paused") : Text(L"记录中", L"On");
        statusLabel.Text(action); badgeLabel.Text(state);
        AutomationProperties::SetName(buttons[Status], action + L", " + state);
        buttons[UpdateRow].Content(winrt::box_value(Text(L"更新并重启", L"Update and restart")));
        buttons[UpdateRow].Visibility(updateReady ? Visibility::Visible : Visibility::Collapsed);
        buttons[Main].Content(winrt::box_value(Text(L"显示主面板", L"Show Main Panel")));
        buttons[Settings].Content(winrt::box_value(Text(L"设置", L"Settings")));
        buttons[Quit].Content(winrt::box_value(Text(L"退出", L"Quit")));
        ApplyAppearance();
        if (Visible() && previousHeight != ContentHeight(updateReady) * textScale) Place();
    }

    void Show(JsonObject const &data) {
        const auto started = GetTickCount64();
        const bool cold = !window;
        const auto anchor = data.GetNamedObject(L"anchor"), work = data.GetNamedObject(L"workArea");
        placement = {{static_cast<LONG>(anchor.GetNamedNumber(L"x")), static_cast<LONG>(anchor.GetNamedNumber(L"y"))},
            {static_cast<LONG>(work.GetNamedNumber(L"left")), static_cast<LONG>(work.GetNamedNumber(L"top")),
                static_cast<LONG>(work.GetNamedNumber(L"right")), static_cast<LONG>(work.GetNamedNumber(L"bottom"))},
            data.GetNamedNumber(L"dpiScale"), anchor.GetNamedBoolean(L"cursor")};
        winrt::check_hresult(placement.work.right > placement.work.left && placement.work.bottom > placement.work.top &&
            placement.dpiScale > 0 && data.GetNamedNumber(L"textScale") > 0 ? S_OK : E_INVALIDARG);
        if (cold) Build();
        // Older navigation completions must not close a newer popup.
        // A pending pause or update stays guarded across a rapid reopen.
        pending[Main] = pending[Settings] = pending[Quit] = 0;
        Update(data); Place(); root.UpdateLayout();
        mouseWasDown = MousePressed();
        ShowWindow(window, SW_SHOWNOACTIVATE);
        (void)SetForegroundWindow(window);
        FocusFirst();
        if (Visible()) SetTimer(window, OutsideClickTimer, OutsideClickIntervalMs, nullptr);
        std::fprintf(stderr, "WinUI tray shown: cold=%d elapsed_ui_ms=%llu\n", cold,
            static_cast<unsigned long long>(GetTickCount64() - started));
    }
};

TrayWindow::TrayWindow(Request request) : impl_(std::make_shared<Impl>(std::move(request))) {}
TrayWindow::~TrayWindow() = default;
void TrayWindow::Show(JsonObject const &data) { impl_->Show(data); }
void TrayWindow::Update(JsonObject const &data) { impl_->Update(data); }
void TrayWindow::Complete(std::uint64_t request, bool succeeded) { impl_->Complete(request, succeeded); }

#ifdef _DEBUG
HWND TrayWindow::Handle() const { return impl_->window; }
FrameworkElement TrayWindow::TestRoot() const { return impl_->root; }

winrt::Windows::Foundation::IAsyncAction TestTrayWindow(TrayWindow &tray, std::uint32_t &stage) {
    auto &popup = *tray.impl_;
    auto require = [](bool condition) { winrt::check_hresult(condition ? S_OK : E_FAIL); };
    stage = 27802;
    for (int frame = 0; frame < 15 && !popup.buttons[Quit].IsLoaded(); ++frame) co_await NextNativeFrame();
    popup.root.UpdateLayout();
    RECT bounds{};
    require(popup.Visible() && GetWindowRect(popup.window, &bounds) && !GetWindow(popup.window, GW_OWNER) &&
        bounds.right - bounds.left == 200 && bounds.bottom - bounds.top == 154);
    stage = 27803;
    const auto rowFits = [&popup](std::size_t i, double height, double lastEdge) {
        const auto &button = popup.buttons[i];
        const auto origin = button.TransformToVisual(popup.list).TransformPoint({0, 0});
        return button.IsLoaded() && std::abs(button.ActualWidth() - 190) < 0.5 &&
            std::abs(button.ActualHeight() - height) < 0.5 && origin.Y + button.ActualHeight() <= lastEdge + 0.5;
    };
    require(rowFits(Status, 36, 41) && rowFits(Quit, 34, 149) &&
        popup.buttons[UpdateRow].Visibility() == Visibility::Collapsed &&
        popup.buttons[Quit].FontSize() == 13 && popup.statusLabel.Text() == L"暂停记录" &&
        popup.badgeLabel.Text() == L"记录中" && popup.statusLabel.FontSize() == 12.5 && popup.badgeLabel.FontSize() == 10);
    stage = 27804;
    const auto profile = JsonObject::Parse(LR"({"english":true,"paused":true,"updateReady":false,"theme":"dark","textScale":1})");
    popup.Update(profile);
    RECT afterPause{};
    require(popup.Visible() && GetWindowRect(popup.window, &afterPause) && EqualRect(&bounds, &afterPause) &&
        popup.root.RequestedTheme() == ElementTheme::Dark && popup.statusLabel.Text() == L"Resume Recording" &&
        popup.badgeLabel.Text() == L"Paused" && AutomationProperties::GetName(popup.buttons[Status]) == L"Resume Recording, Paused");
    stage = 27805;
    profile.SetNamedValue(L"updateReady", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(true));
    popup.Update(profile);
    co_await NextNativeFrame();
    popup.root.UpdateLayout();
    RECT withUpdate{};
    require(popup.Visible() && GetWindowRect(popup.window, &withUpdate) && withUpdate.bottom - withUpdate.top == 190 &&
        rowFits(UpdateRow, 34, 77) && rowFits(Quit, 34, 185) &&
        winrt::unbox_value<winrt::hstring>(popup.buttons[UpdateRow].Content()) == L"Update and restart");
    stage = 27806;
    for (const auto scale : {1.0, 1.25, 1.5}) {
        const Placement edge{{-4, 1020}, {-1920, 0, 0, 1020}, scale, true};
        const auto rect = edge.ClientRect(1, true);
        require(rect.left >= edge.work.left && rect.right < edge.work.right && rect.top >= edge.work.top &&
            rect.bottom < edge.work.bottom && std::abs((rect.right - rect.left) - 200 * scale) <= 1 &&
            std::abs((rect.bottom - rect.top) - 190 * scale) <= 1);
    }
    stage = 27807;
    popup.ObservePress(false, {});
    popup.ObservePress(true, {withUpdate.left + 1, withUpdate.top + 1});
    const POINT outside{withUpdate.left - 1, withUpdate.top - 1};
    popup.ObservePress(true, outside); // A drag out isn't a new click.
    require(popup.Visible());
    popup.ObservePress(false, outside);
    popup.ObservePress(true, outside);
    require(!popup.Visible());
    stage = 27811;
    // Check the opening focus transition in the real controls even when the
    // isolated desktop cannot take physical foreground from Explorer.
    ShowWindow(popup.window, SW_SHOWNOACTIVATE);
    const auto &first = popup.buttons[Status];
    (void)first.Focus(FocusState::Keyboard);
    popup.FocusOpeningRow();
    require(Input::FocusManager::GetFocusedElement(popup.root.XamlRoot()) == first &&
        first.FocusState() == FocusState::Pointer && first.UseSystemFocusVisuals());
    require(popup.HandleKey(VK_DOWN) && popup.buttons[UpdateRow].FocusState() == FocusState::Keyboard);
    require(popup.HandleKey(VK_HOME) && first.FocusState() == FocusState::Keyboard);
    popup.Hide();
    ShowWindow(popup.window, SW_SHOWNOACTIVATE);
    popup.FocusOpeningRow();
    require(first.FocusState() == FocusState::Pointer);
    require(popup.HandleKey(VK_ESCAPE) && !popup.Visible());
}
#endif
}
