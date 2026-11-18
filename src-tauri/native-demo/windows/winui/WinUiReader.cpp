#include "WinUiReader.h"
#include "WinUiResourceProbe.h"
#include "WinUiAppearance.h"
#include "WinUiMotion.h"
#include "WinUiGeometry.h"
#include "WinUiRichContent.h"
#include "WinUiCardContent.h"
#include <dwmapi.h>
#include <objbase.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <utility>
#include <thread>
#ifdef _DEBUG
#include <cstdio>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Composition.SystemBackdrops.h>
#include <winrt/Microsoft.UI.Interop.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Hosting.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Text.h>
#include <winrt/Windows.UI.ViewManagement.h>

namespace vpaste::winui {
namespace {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Microsoft::UI::Xaml::Media;
using namespace winrt::Windows::Data::Json;
constexpr wchar_t ReaderClass[] = L"VPasteWinUiReader";
constexpr UINT ReaderFrameMessage = WM_APP + 0x3F1;
std::atomic<HWND> publishedWindow{nullptr};

TextBlock ReaderText(winrt::hstring const &text, double size = 14) {
    TextBlock block;
    block.Text(text); block.FontSize(size);
    block.TextWrapping(TextWrapping::Wrap);
    ApplyStyle(block, L"VPaste.Body"); block.FontSize(size);
    return block;
}

Canvas ReaderTransparencyMatte() {
    Canvas matte; matte.IsHitTestVisible(false);
    // Tile the shared 256-DIP source rather than stretching its 8-DIP cells or
    // allocating another decoded image at every preview/window size.
    const auto paint = [](Canvas const &canvas) {
        RectangleGeometry clip; clip.Rect({0, 0, static_cast<float>(canvas.ActualWidth()), static_cast<float>(canvas.ActualHeight())});
        canvas.Clip(clip);
        const bool contrast = HighContrastEnabled(), dark = canvas.ActualTheme() == ElementTheme::Dark;
        const auto columns = static_cast<int>(std::ceil(canvas.ActualWidth() / 256));
        const auto rows = static_cast<int>(std::ceil(canvas.ActualHeight() / 256));
        const auto key = winrt::to_hstring(columns) + L":" + winrt::to_hstring(rows) + (contrast ? L":contrast" : dark ? L":dark" : L":light");
        if (canvas.Tag() && winrt::unbox_value<winrt::hstring>(canvas.Tag()) == key) return;
        canvas.Tag(winrt::box_value(key)); canvas.Children().Clear();
        if (contrast) return;
        for (int y = 0; y < rows; ++y) for (int x = 0; x < columns; ++x) {
            Border tile; tile.Width(256); tile.Height(256); tile.Background(TransparencyBrush(dark));
            Canvas::SetLeft(tile, x * 256); Canvas::SetTop(tile, y * 256); canvas.Children().Append(tile);
        }
    };
    matte.SizeChanged([paint](auto const &sender, auto const &) { paint(sender.as<Canvas>()); });
    matte.ActualThemeChanged([paint](auto const &sender, auto const &) { paint(sender.as<Canvas>()); });
    return matte;
}

}

struct Reader::Impl : std::enable_shared_from_this<Reader::Impl> {
    explicit Impl(Request callback, HWND reference) : request(std::move(callback)), owner(reference) {}
    Request request;
    HWND owner;
    HWND window = nullptr, handoffWindow = nullptr;
    Hosting::DesktopWindowXamlSource source{nullptr};
    Grid root{nullptr}, body{nullptr};
    ContentControl contentFocus{nullptr};
    FrameworkElement pending{nullptr}, displayed{nullptr}, outgoing{nullptr};
    winrt::Microsoft::UI::Composition::ScalarKeyFrameAnimation contentEnter{nullptr}, contentExit{nullptr};
    Controls::Primitives::ToggleButton pin{nullptr};
    DispatcherTimer loadTimeout{nullptr};
    std::jthread movement;
    std::atomic<bool> framePosted{false};
    std::uint64_t latest = 0, committed = 0;
    bool english = false, takesFocus = false, retired = false, hover = false, placing = false;
    ElementTheme theme = ElementTheme::Default;
    RECT target{}, from{}, pendingTarget{};
    std::array<double, 4> easing{}, pendingEasing{};
    double durationMs = 0, pendingDurationMs = 0;
    std::chrono::steady_clock::time_point started;
#ifdef _DEBUG
    std::vector<std::chrono::steady_clock::time_point> movementFrames;
#endif

    ~Impl() {
        FinishContentTransition();
        StopMovement();
        if (loadTimeout) loadTimeout.Stop();
        publishedWindow.store(nullptr, std::memory_order_release);
        if (source) { source.Content(nullptr); source.Close(); }
        if (window) { SetWindowLongPtrW(window, GWLP_USERDATA, 0); DestroyWindow(window); }
    }

    winrt::hstring Text(wchar_t const *zh, wchar_t const *en) const { return english ? en : zh; }
    void Send(wchar_t const *op) { if (request) request(op, latest); }

    bool HandleKey(unsigned key, bool repeated, bool control, bool shift, bool alt, bool composing,
        winrt::Windows::Foundation::IInspectable const &origin = nullptr) {
        if (composing || alt) return false;
        // Toolbar controls own their activation and focus-navigation keys.
        // Escape remains a reader-wide close shortcut.
        if (key != VK_ESCAPE) {
            for (auto element = origin.try_as<DependencyObject>(); element && element != root;
                 element = VisualTreeHelper::GetParent(element)) {
                if (element.try_as<Primitives::ButtonBase>()) return false;
            }
        }
        if (!control && !shift && (key == VK_SPACE || key == VK_ESCAPE)) {
            if (!repeated) Send(L"nativeReaderClose");
            return true;
        }
        if (key != VK_TAB && (control || shift || (key != VK_LEFT && key != VK_RIGHT))) return false;
        const bool previous = key == VK_LEFT || (key == VK_TAB && shift);
        Send(control ? (previous ? L"readerPreviousCategory" : L"readerNextCategory")
            : (previous ? L"readerPrevious" : L"readerNext"));
        return true;
    }

    void Resize() {
        if (!source || !window) return;
        RECT rect{}; winrt::check_bool(GetClientRect(window, &rect));
        source.SiteBridge().MoveAndResize({0, 0, rect.right, rect.bottom});
    }

    static LRESULT CALLBACK WindowProc(HWND handle, UINT message, WPARAM wparam, LPARAM lparam) {
        auto self = reinterpret_cast<Impl *>(GetWindowLongPtrW(handle, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            self = static_cast<Impl *>(reinterpret_cast<CREATESTRUCTW *>(lparam)->lpCreateParams);
            SetWindowLongPtrW(handle, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(handle, message, wparam, lparam);
        try {
            switch (message) {
            case ReaderFrameMessage:
                self->framePosted = false;
                if (self->Moving()) self->Step();
                return 0;
            case WM_NCCALCSIZE: if (wparam) return 0; break;
            case WM_NCHITTEST: return HTCLIENT;
            case WM_ERASEBKGND: return 1;
            case WM_SIZE: self->Resize(); return 0;
            case WM_CLOSE: self->Send(L"nativeReaderClose"); return 0;
            case WM_ACTIVATE:
                if (LOWORD(wparam) == WA_INACTIVE && self->committed && !self->retired)
                    self->Send(L"nativeReaderBlur");
                break;
            case WM_DPICHANGED: {
                // A geometry animation already has a physical destination from
                // Rust. Do not replace it with a mid-frame suggested rectangle.
                if (self->placing) { self->Resize(); return 0; }
                self->StopMovement();
                self->target = FitToMonitorWorkArea(*reinterpret_cast<RECT *>(lparam));
                self->from = self->target;
                self->Place(self->target);
                self->Resize(); return 0;
            }
            case WM_DISPLAYCHANGE:
            case WM_SETTINGCHANGE:
                if (message == WM_SETTINGCHANGE && wparam != SPI_SETWORKAREA) break;
                if (self->window && IsWindowVisible(self->window)) {
                    self->StopMovement();
                    RECT current{}; winrt::check_bool(GetWindowRect(self->window, &current));
                    self->target = FitToMonitorWorkArea(current); self->from = self->target;
                    self->Place(self->target); self->Resize();
                }
                return 0;
            }
        } catch (...) { return DefWindowProcW(handle, message, wparam, lparam); }
        return DefWindowProcW(handle, message, wparam, lparam);
    }

    void Build() {
        if (window) return;
        WNDCLASSEXW type{sizeof(WNDCLASSEXW)};
        type.lpfnWndProc = WindowProc; type.hInstance = GetModuleHandleW(nullptr);
        type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.lpszClassName = ReaderClass;
        if (!RegisterClassExW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) winrt::throw_last_error();
        window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, ReaderClass, L"vPaste",
            WS_POPUP | WS_THICKFRAME | WS_SYSMENU, 0, 0, 760, 560,
            nullptr, nullptr, GetModuleHandleW(nullptr), this);
        winrt::check_bool(window != nullptr);
        source = Hosting::DesktopWindowXamlSource();
        source.Initialize(winrt::Microsoft::UI::GetWindowIdFromWindow(window));
        root = Grid(); ApplyStyle(root, L"VPaste.ReaderCanvas");
        RowDefinition heading; heading.Height(GridLength{40, GridUnitType::Pixel});
        root.RowDefinitions().Append(heading); root.RowDefinitions().Append(RowDefinition{});
        pin = Controls::Primitives::ToggleButton();
        FontIcon pinGlyph;
        pinGlyph.FontFamily(FontFamily{L"Segoe Fluent Icons, Segoe MDL2 Assets"});
        pinGlyph.FontSize(CompactIconSize);
        pin.Content(pinGlyph);
        pin.Width(CompactActionSize); pin.Height(CompactActionSize); pin.Padding(Thickness{0});
        pin.Margin(Thickness{8, 4, 8, 4}); pin.CornerRadius(UniformRadius(4));
        pin.HorizontalAlignment(HorizontalAlignment::Right); pin.VerticalAlignment(VerticalAlignment::Center);
        const auto transparent = SolidColorBrush{winrt::Windows::UI::Colors::Transparent()};
        pin.Background(transparent); pin.BorderBrush(transparent);
        root.Children().Append(pin);
        body = Grid(); body.Margin(Thickness{16, 0, 16, 16});
        // Keep the text/image canvas readable while the same outer reader
        // frame exposes a restrained system material around every content type.
        ApplyStyle(body, L"VPaste.ReaderCanvas");
        body.CornerRadius(UniformRadius(8));
        contentFocus = ContentControl(); contentFocus.Content(body); contentFocus.IsTabStop(true);
        contentFocus.HorizontalContentAlignment(HorizontalAlignment::Stretch);
        contentFocus.VerticalContentAlignment(VerticalAlignment::Stretch);
        Grid::SetRow(contentFocus, 1); root.Children().Append(contentFocus);
        const auto weak = weak_from_this();
        pin.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->committed == self->latest) {
                self->Send(self->pin.IsChecked() && self->pin.IsChecked().Value() ? L"nativeReaderPin" : L"nativeReaderUnpin");
                self->ApplyAppearance();
            }
        });
        root.PointerEntered([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->Send(L"nativeReaderEnter"); });
        root.PointerExited([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->Send(L"nativeReaderLeave"); });
        root.PreviewKeyDown([weak](auto const &, auto const &args) {
            if (auto self = weak.lock()) args.Handled(self->HandleKey(static_cast<unsigned>(args.Key()),
                args.KeyStatus().WasKeyDown, (GetKeyState(VK_CONTROL) & 0x8000) != 0,
                (GetKeyState(VK_SHIFT) & 0x8000) != 0,
                ((GetKeyState(VK_MENU) | GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000) != 0,
                static_cast<unsigned>(args.OriginalKey()) == VK_PROCESSKEY, args.OriginalSource()));
        });
        root.ActualThemeChanged([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ApplyAppearance();
        });
        loadTimeout = DispatcherTimer(); loadTimeout.Interval(std::chrono::seconds(5));
        loadTimeout.Tick([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) { self->loadTimeout.Stop(); self->ImageError(self->latest); }
        });
        source.Content(root); source.SiteBridge().Show(); ApplyAppearance(); Resize();
        const auto corners = DWMWCP_ROUND;
        (void)DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
        const MARGINS shadow{1, 1, 1, 1}; (void)DwmExtendFrameIntoClientArea(window, &shadow);
        const BOOL disableTransitions = TRUE;
        (void)DwmSetWindowAttribute(window, DWMWA_TRANSITIONS_FORCEDISABLED, &disableTransitions, sizeof(disableTransitions));
        publishedWindow.store(window, std::memory_order_release);
    }

    void ApplyAppearance() {
        if (!root) return;
        root.RequestedTheme(theme);
        const bool material = !HighContrastEnabled() &&
            winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController::IsSupported();
        if (material && !source.SystemBackdrop()) {
            try { source.SystemBackdrop(DesktopAcrylicBackdrop{}); }
            catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
        } else if (!material && source.SystemBackdrop()) {
            source.SystemBackdrop(nullptr);
        }
        root.ClearValue(Controls::Panel::BackgroundProperty());
        if (source.SystemBackdrop()) root.Background(SolidColorBrush{winrt::Windows::UI::Color{0, 0, 0, 0}});
        const BOOL dark = root.ActualTheme() == ElementTheme::Dark;
        (void)DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
        SetWindowTextW(window, Text(L"vPaste — 预览", L"vPaste — Preview").c_str());
        Automation::AutomationProperties::SetName(contentFocus, Text(L"预览内容", L"Preview content"));
        const auto pinned = pin.IsChecked() && pin.IsChecked().Value();
        // Match the Segoe Pin and PinnedFill glyphs used in Preview.tsx.
        pin.Content().as<FontIcon>().Glyph(pinned ? L"\uE842" : L"\uE718");
        const auto label = pinned ? Text(L"取消固定", L"Unpin preview") : Text(L"固定预览", L"Pin preview");
        Automation::AutomationProperties::SetName(pin, label);
        ToolTipService::SetToolTip(pin, winrt::box_value(label));
    }

    void Place(RECT const &rect) {
        const auto previous = std::exchange(placing, true);
        const auto moved = SetWindowPos(window, HWND_TOPMOST, rect.left, rect.top,
            rect.right - rect.left, rect.bottom - rect.top, SWP_NOACTIVATE);
        placing = previous;
        winrt::check_bool(moved);
    }

    void Step() {
#ifdef _DEBUG
        movementFrames.push_back(std::chrono::steady_clock::now());
#endif
        const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        const auto progress = std::clamp(elapsed / std::max(1.0, durationMs), 0.0, 1.0);
        if (progress >= 1 || !winrt::Windows::UI::ViewManagement::UISettings().AnimationsEnabled()) {
            StopMovement(); Place(target); return;
        }
        const auto eased = BezierProgress(progress, easing);
        const auto interpolate = [eased](LONG a, LONG b) { return static_cast<LONG>(std::lround(a + (b - a) * eased)); };
        Place({interpolate(from.left, target.left), interpolate(from.top, target.top),
            interpolate(from.right, target.right), interpolate(from.bottom, target.bottom)});
    }

    bool Moving() const { return movement.joinable(); }
    void StopMovement() {
        if (movement.joinable()) { movement.request_stop(); movement.join(); }
        framePosted = false;
    }

    void MoveToTarget(bool animationsEnabled) {
        StopMovement();
#ifdef _DEBUG
        movementFrames.clear();
#endif
        winrt::check_bool(GetWindowRect(window, &from));
        if (IsWindowVisible(window) && animationsEnabled && !EqualRect(&from, &target) && durationMs > 0) {
            started = std::chrono::steady_clock::now();
            // Match the shipping preview's DWM pacing. DispatcherTimer ticks
            // run after XAML layout and coalesce to ~3 display frames on resize.
            // The worker only posts; this STA remains the sole HWND owner.
            movement = std::jthread([this](std::stop_token stop) {
                while (!stop.stop_requested()) {
                    const auto before = std::chrono::steady_clock::now();
                    const auto composed = SUCCEEDED(DwmFlush());
                    if (!composed || std::chrono::steady_clock::now() - before < std::chrono::milliseconds(1))
                        std::this_thread::sleep_for(std::chrono::milliseconds(8));
                    if (!stop.stop_requested() && !framePosted.exchange(true))
                        if (!PostMessageW(window, ReaderFrameMessage, 0, 0)) framePosted = false;
                }
            });
        } else Place(target);
    }

    void FinishContentTransition() {
        if (displayed) { if (contentEnter) displayed.StopAnimation(contentEnter); displayed.Opacity(1); }
        if (outgoing) {
            if (contentExit) outgoing.StopAnimation(contentExit);
            std::uint32_t index = 0;
            if (body.Children().IndexOf(outgoing, index)) body.Children().RemoveAt(index);
        }
        outgoing = nullptr; contentEnter = nullptr; contentExit = nullptr;
    }

    void StartContentTransition(std::uint64_t generation, bool enabled) {
        if (generation != committed || !outgoing) return;
        displayed.Opacity(1);
        if (!enabled || !NativeAnimationsEnabled()) { FinishContentTransition(); return; }
        const auto compositor = CompositionTarget::GetCompositorForCurrentThread();
        const auto tokens = MotionTokens();
        const auto curve = tokens.GetNamedObject(L"easing").GetNamedArray(L"enter");
        const auto contentEasing = compositor.CreateCubicBezierEasingFunction(
            {static_cast<float>(curve.GetNumberAt(0)), static_cast<float>(curve.GetNumberAt(1))},
            {static_cast<float>(curve.GetNumberAt(2)), static_cast<float>(curve.GetNumberAt(3))});
        auto batch = compositor.CreateScopedBatch(winrt::Microsoft::UI::Composition::CompositionBatchTypes::Animation);
        const auto duration = std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
            std::chrono::duration<double>{tokens.GetNamedObject(L"duration").GetNamedNumber(L"fast")});
        contentEnter = compositor.CreateScalarKeyFrameAnimation(); contentEnter.Target(L"Opacity");
        contentEnter.InsertKeyFrame(0, 0); contentEnter.InsertKeyFrame(1, 1, contentEasing); contentEnter.Duration(duration);
        contentExit = compositor.CreateScalarKeyFrameAnimation(); contentExit.Target(L"Opacity");
        contentExit.InsertKeyFrame(0, 1); contentExit.InsertKeyFrame(1, 0, contentEasing); contentExit.Duration(duration);
        displayed.StartAnimation(contentEnter); outgoing.StartAnimation(contentExit);
        batch.Completed([weak = weak_from_this(), generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->committed == generation) self->FinishContentTransition();
        });
        batch.End();
    }

    void Commit(std::uint64_t generation) {
        if (generation != latest || committed == generation || !pending) return;
        // An image can finish decoding after the user activates another app.
        // Recheck on the owning STA without synchronously calling Tauri.
        if (hover && owner) {
            const auto foreground = GetForegroundWindow();
            if (!IsWindowVisible(owner) || (foreground != owner && foreground != window &&
                !IsChild(owner, foreground) && !IsChild(window, foreground))) {
                Send(L"nativeReaderCancelled"); Hide(generation); return;
            }
        }
        loadTimeout.Stop(); StopMovement();
        // Geometry belongs to accepted content. A pending image must not
        // retarget the previous resize before its pixels are ready.
        target = pendingTarget; durationMs = pendingDurationMs; easing = pendingEasing;
        const bool visible = IsWindowVisible(window) != FALSE;
        FinishContentTransition(); outgoing = displayed;
        displayed = pending; pending = nullptr; displayed.IsHitTestVisible(true);
        std::uint32_t index = 0;
        if (!body.Children().IndexOf(displayed, index)) body.Children().Append(displayed);
        committed = generation; pin.IsEnabled(true);
        if (outgoing) {
            outgoing.IsHitTestVisible(false);
            Automation::AutomationProperties::SetAccessibilityView(outgoing, Automation::Peers::AccessibilityView::Raw);
            const bool animate = visible && durationMs > 0 && NativeAnimationsEnabled();
            displayed.Opacity(animate ? 0 : 1);
            if (!animate || displayed.IsLoaded()) StartContentTransition(generation, animate);
            else displayed.Loaded([weak = weak_from_this(), generation](auto const &sender, auto const &) {
                if (const auto self = weak.lock(); self && self->committed == generation && self->displayed == sender)
                    self->StartContentTransition(generation, true);
            });
        } else displayed.Opacity(1);
        if (!visible) {
            RECT inherited{}; DWORD process = 0;
            if (handoffWindow) GetWindowThreadProcessId(handoffWindow, &process);
            const bool handoff = process == GetCurrentProcessId() && IsWindowVisible(handoffWindow) &&
                GetWindowRect(handoffWindow, &inherited);
            Place(handoff ? inherited : target);
            ShowWindow(window, SW_SHOWNOACTIVATE);
        }
        MoveToTarget(NativeAnimationsEnabled());
        if (takesFocus) {
            SetForegroundWindow(window);
            contentFocus.Focus(FocusState::Programmatic);
        }
        Send(L"nativeReaderReady"); ApplyAppearance();
    }

    void ImageError(std::uint64_t generation) {
        if (generation != latest || committed == generation) return;
        if (pending) { std::uint32_t index = 0; if (body.Children().IndexOf(pending, index)) body.Children().RemoveAt(index); }
        pending = ReaderText(Text(L"暂时无法预览此内容", L"This content cannot be previewed"));
        Commit(generation);
    }

    void Begin(std::uint64_t generation) {
        if (generation <= latest) return;
        latest = generation;
        retired = false;
        // A slow next image must not freeze the previous accepted resize.
        FinishContentTransition();
        if (loadTimeout) loadTimeout.Stop();
        if (pending && body) { std::uint32_t index = 0; if (body.Children().IndexOf(pending, index)) body.Children().RemoveAt(index); }
        pending = nullptr;
        if (pin) pin.IsEnabled(false);
    }

    void Hide(std::uint64_t generation) {
        if (generation < latest) return;
        latest = generation; committed = 0; retired = true;
        StopMovement();
        if (loadTimeout) loadTimeout.Stop();
        FinishContentTransition();
        pending = nullptr; displayed = nullptr;
        if (body) body.Children().Clear();
        if (pin) { pin.IsChecked(false); pin.IsEnabled(false); }
        if (window) ShowWindow(window, SW_HIDE);
    }

    void Show(JsonObject const &data) {
        const auto generation = static_cast<std::uint64_t>(data.GetNamedNumber(L"generation"));
        if (generation < latest || generation == committed || (generation == latest && retired)) return;
        Begin(generation); Build();
        const auto rect = data.GetNamedObject(L"rect");
        const auto number = [&](wchar_t const *key) {
            const auto value = rect.GetNamedNumber(key);
            winrt::check_hresult(std::isfinite(value) && std::abs(value) < 1000000 ? S_OK : E_INVALIDARG);
            return static_cast<LONG>(std::lround(value));
        };
        pendingTarget = {number(L"x"), number(L"y"), 0, 0};
        const auto width = number(L"width"), height = number(L"height");
        winrt::check_hresult(width > 0 && height > 0 ? S_OK : E_INVALIDARG);
        pendingTarget.right = pendingTarget.left + width; pendingTarget.bottom = pendingTarget.top + height;
        pendingDurationMs = std::clamp(data.GetNamedNumber(L"durationMs"), 0.0, 320.0);
        const auto curve = data.GetNamedArray(L"easing");
        winrt::check_hresult(curve.Size() == 4 ? S_OK : E_INVALIDARG);
        for (unsigned i = 0; i < 4; ++i) { pendingEasing[i] = curve.GetNumberAt(i); winrt::check_hresult(std::isfinite(pendingEasing[i]) ? S_OK : E_INVALIDARG); }
        takesFocus = data.GetNamedBoolean(L"takesFocus", false);
        hover = data.GetNamedBoolean(L"hover", false);
        handoffWindow = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(data.GetNamedNumber(L"handoffWindow", 0)));
        const auto kind = data.GetNamedString(L"kind");
        Grid content;
        const auto caption = data.GetNamedString(L"caption", L"");
        if (!caption.empty() && kind != L"files") {
            RowDefinition label; label.Height(GridLength{1, GridUnitType::Auto});
            const bool imageCaption = kind == L"image";
            content.RowDefinitions().Append(imageCaption ? RowDefinition{} : label);
            content.RowDefinitions().Append(imageCaption ? label : RowDefinition{});
            StackPanel description; description.Spacing(4);
            auto title = ReaderText(caption); ApplyStyle(title, L"VPaste.CompactTitle");
            if (imageCaption) { title.FontSize(13); title.TextAlignment(TextAlignment::Center); }
            description.Children().Append(title);
            const auto detail = data.GetNamedString(L"detail", L"");
            if (!detail.empty()) {
                auto path = ReaderText(detail, 12); ApplyStyle(path, L"VPaste.Secondary");
                path.TextWrapping(TextWrapping::NoWrap); path.TextTrimming(TextTrimming::CharacterEllipsis);
                if (imageCaption) path.TextAlignment(TextAlignment::Center);
                ToolTipService::SetToolTip(path, winrt::box_value(detail)); description.Children().Append(path);
            }
            description.Margin(imageCaption ? Thickness{0, 12, 0, 0} : Thickness{0, 0, 0, 8});
            if (imageCaption) Grid::SetRow(description, 1);
            content.Children().Append(description);
        }
        if (kind == L"image") {
            Grid stage, frame;
            frame.HorizontalAlignment(HorizontalAlignment::Center); frame.VerticalAlignment(VerticalAlignment::Center);
            frame.CornerRadius(UniformRadius(8));
            if (data.GetNamedBoolean(L"checkerboard", true)) frame.Children().Append(ReaderTransparencyMatte());
            Image image; image.Stretch(Stretch::Uniform);
            frame.Children().Append(image); stage.Children().Append(frame); content.Children().Append(stage);
            const auto natural = std::make_shared<winrt::Windows::Foundation::Size>(winrt::Windows::Foundation::Size{
                static_cast<float>(data.GetNamedNumber(L"imageWidth", 0)), static_cast<float>(data.GetNamedNumber(L"imageHeight", 0))});
            const auto fit = [natural, weakFrame = winrt::make_weak(frame)](Grid const &area) {
                if (const auto target = weakFrame.get(); target && natural->Width > 0 && natural->Height > 0 &&
                    area.ActualWidth() > 0 && area.ActualHeight() > 0) {
                    const auto scale = std::min({1.0, area.ActualWidth() / natural->Width, area.ActualHeight() / natural->Height});
                    target.Width(natural->Width * scale); target.Height(natural->Height * scale);
                }
            };
            stage.SizeChanged([fit](auto const &sender, auto const &) { fit(sender.as<Grid>()); });
            pending = content; pending.Opacity(0); pending.IsHitTestVisible(false);
            body.Children().Append(pending);
            const auto weak = weak_from_this();
            image.ImageOpened([weak, generation, natural, fit, weakStage = winrt::make_weak(stage)](auto const &sender, auto const &) {
                if (const auto area = weakStage.get()) {
                    const auto bitmap = sender.as<Image>().Source().as<Imaging::BitmapImage>();
                    if (natural->Width <= 0 || natural->Height <= 0) *natural = {static_cast<float>(bitmap.PixelWidth()), static_cast<float>(bitmap.PixelHeight())};
                    fit(area);
                }
                if (auto self = weak.lock()) self->Commit(generation);
            });
            image.ImageFailed([weak, generation](auto const &, auto const &) { if (auto self = weak.lock()) self->ImageError(generation); });
            try {
                Imaging::BitmapImage bitmap;
                bitmap.DecodePixelWidth(std::max<LONG>(1, width));
                bitmap.UriSource(LocalAssetUri(data.GetNamedString(L"imagePath")));
                image.Source(bitmap); loadTimeout.Start();
            } catch (winrt::hresult_error const &) { ImageError(generation); }
            return;
        }
        if (kind == L"color") {
            const auto color = data.GetNamedObject(L"color");
            content.Background(SolidColorBrush{winrt::Windows::UI::Color{
                static_cast<std::uint8_t>(color.GetNamedNumber(L"a")), static_cast<std::uint8_t>(color.GetNamedNumber(L"r")),
                static_cast<std::uint8_t>(color.GetNamedNumber(L"g")), static_cast<std::uint8_t>(color.GetNamedNumber(L"b"))}});
            Border label; ApplyStyle(label, L"VPaste.Surface"); label.Padding(Thickness{12, 8, 12, 8});
            label.HorizontalAlignment(HorizontalAlignment::Center); label.VerticalAlignment(VerticalAlignment::Center);
            label.Child(ReaderText(data.GetNamedString(L"text"))); content.Children().Append(label);
        } else if (kind == L"files") {
            const auto file = data.GetNamedObject(L"file");
            StackPanel info; info.MaxWidth(460); info.Padding(UniformThickness(28));
            info.HorizontalAlignment(HorizontalAlignment::Center); info.VerticalAlignment(VerticalAlignment::Center);
            auto icon = FileTypePresentation(file, root.ActualTheme() == ElementTheme::Dark, FilePresentationVariant::Preview);
            icon.HorizontalAlignment(HorizontalAlignment::Center); icon.Margin(Thickness{0, 0, 0, 18});
            info.Children().Append(icon);
            auto name = ReaderText(caption.empty() ? Text(L"文件", L"File") : caption, 18);
            name.FontWeight(winrt::Windows::UI::Text::FontWeights::SemiBold()); name.LineHeight(24);
            name.TextAlignment(TextAlignment::Center); info.Children().Append(name);
            auto path = ReaderText(file.GetNamedString(L"path"), 12); ApplyStyle(path, L"VPaste.Secondary");
            path.LineHeight(18); path.TextAlignment(TextAlignment::Center); path.Margin(Thickness{0, 7, 0, 0});
            info.Children().Append(path);
            if (data.GetNamedBoolean(L"batch", false)) {
                const auto count = static_cast<unsigned>(data.GetNamedNumber(L"count", 1));
                auto note = ReaderText(english ? winrt::to_hstring(count) + L" files. Batch preview is not supported yet"
                    : L"共 " + winrt::to_hstring(count) + L" 个文件，暂不支持批量文件预览", 13);
                ApplyStyle(note, L"VPaste.Secondary"); note.TextAlignment(TextAlignment::Center);
                note.Margin(Thickness{0, 14, 0, 0}); info.Children().Append(note);
            }
            if (data.GetNamedBoolean(L"missing", false)) {
                auto warning = ReaderText(Text(L"源文件不存在或已移动", L"Source file is missing or moved"), 13);
                ApplyStyle(warning, L"VPaste.WarningText"); warning.TextAlignment(TextAlignment::Center);
                warning.Margin(Thickness{0, 14, 0, 0}); info.Children().Append(warning);
            }
            ScrollViewer scroll; scroll.Content(info); scroll.HorizontalScrollMode(ScrollMode::Disabled);
            scroll.VerticalScrollBarVisibility(ScrollBarVisibility::Auto); content.Children().Append(scroll);
        } else {
            StackPanel textContent; textContent.Spacing(12);
            const auto value = data.GetNamedString(L"text", L"");
            auto text = ReaderText(value.empty() ? Text(L"没有可预览的文本", L"No text to preview") : value);
            text.IsTextSelectionEnabled(true);
            textContent.Children().Append(text);
            if (data.GetNamedBoolean(L"truncated", false))
                textContent.Children().Append(ReaderText(Text(L"仅显示部分内容，复制和粘贴保留完整文本。", L"Partial preview; copy and paste keep the full text."), 12));
            ScrollViewer scroll; scroll.Content(textContent);
            scroll.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
            scroll.HorizontalScrollMode(ScrollMode::Disabled); content.Children().Append(scroll);
            if (!caption.empty()) Grid::SetRow(scroll, 1);
        }
        pending = content; Commit(generation);
    }

    void Receive(JsonObject const &response) {
        const auto operation = response.GetNamedString(L"op", L"");
        if (operation == L"nativeReaderFocus") {
            if (window && IsWindowVisible(window)) { SetForegroundWindow(window); contentFocus.Focus(FocusState::Programmatic); }
            return;
        }
        const auto data = response.GetNamedObject(L"data");
        const auto generation = static_cast<std::uint64_t>(data.GetNamedNumber(L"generation"));
        if (operation == L"nativeReaderBegin") Begin(generation);
        else if (operation == L"nativeReaderHide") Hide(generation);
        else if (operation == L"nativeReader") Show(data);
    }
};

Reader::Reader(Request request, HWND owner) : impl_(std::make_shared<Impl>(std::move(request), owner)) {}
Reader::~Reader() = default;
void Reader::Receive(JsonObject const &response) { impl_->Receive(response); }
void Reader::SetAppearance(bool english, ElementTheme theme) {
    impl_->english = english; impl_->theme = theme; impl_->ApplyAppearance();
}
std::uintptr_t ReaderWindowHandle() noexcept {
    return reinterpret_cast<std::uintptr_t>(publishedWindow.load(std::memory_order_acquire));
}
#ifdef _DEBUG
FrameworkElement Reader::TestRoot() const { return impl_->root; }

winrt::Windows::Foundation::IAsyncAction TestReaderControls(std::uint32_t &stage) {
    using namespace Automation;
    std::vector<std::pair<std::wstring, std::uint64_t>> events;
    Reader reader([&events](auto const &operation, auto generation) { events.emplace_back(operation, generation); });
    const auto state = reader.impl_;
    auto message = [](wchar_t const *operation, std::uint64_t generation) {
        JsonObject response, data;
        response.Insert(L"op", JsonValue::CreateStringValue(operation));
        data.Insert(L"generation", JsonValue::CreateNumberValue(static_cast<double>(generation)));
        response.Insert(L"data", data); return response;
    };
    auto text = [&](std::uint64_t generation, wchar_t const *value) {
        auto response = message(L"nativeReader", generation);
        auto data = response.GetNamedObject(L"data");
        data.Insert(L"kind", JsonValue::CreateStringValue(L"text"));
        data.Insert(L"text", JsonValue::CreateStringValue(value));
        data.Insert(L"rect", JsonObject::Parse(LR"({"x":100,"y":100,"width":600,"height":360})"));
        data.Insert(L"durationMs", JsonValue::CreateNumberValue(0));
        data.Insert(L"easing", JsonArray::Parse(L"[0.22,1,0.36,1]"));
        return response;
    };
    stage = 117;
    winrt::check_hresult(!state->window ? S_OK : E_FAIL);
    reader.Receive(text(1, L"可选择的原生文本 / Native selectable text"));
    co_await NextNativeFrame();
    const auto handle = state->window;
    winrt::check_hresult(IsWindowVisible(handle) && ReaderWindowHandle() == reinterpret_cast<std::uintptr_t>(handle) &&
        state->committed == 1 && state->body.Children().Size() == 1 ? S_OK : E_FAIL);
    const auto selected = state->displayed.as<Grid>().Children().GetAt(0).as<ScrollViewer>()
        .Content().as<StackPanel>().Children().GetAt(0).as<TextBlock>();
    winrt::check_hresult(selected.IsTextSelectionEnabled() ? S_OK : E_FAIL);
    selected.SelectAll();
    winrt::check_hresult(selected.SelectedText() == selected.Text() ? S_OK : E_FAIL);
    reader.Receive(text(3, L"New selection")); co_await NextNativeFrame();
    reader.Receive(text(1, L"Old selection"));
    winrt::check_hresult(state->window == handle && state->committed == 3 ? S_OK : E_FAIL);

    stage = 118;
    const auto key = [&](unsigned value, bool repeated = false, bool control = false, bool shift = false,
        bool alt = false, bool composing = false) { return state->HandleKey(value, repeated, control, shift, alt, composing); };
    events.clear();
    winrt::check_hresult(key(VK_SPACE, true) && events.empty() && key(VK_ESCAPE) &&
        events.back().first == L"nativeReaderClose" && events.back().second == 3 ? S_OK : E_FAIL);
    winrt::check_hresult(key(VK_LEFT) && events.back().first == L"readerPrevious" &&
        key(VK_TAB, false, false, true) && events.back().first == L"readerPrevious" &&
        key(VK_TAB, false, true) && events.back().first == L"readerNextCategory" ? S_OK : E_FAIL);
    const auto count = events.size();
    winrt::check_hresult(!key(VK_SPACE, false, false, false, false, true) &&
        !key(VK_RIGHT, false, false, false, true) && !key('C', false, true) &&
        events.size() == count ? S_OK : E_FAIL);
    stage = 1181;
    const auto toolbarKey = [&](unsigned value, FrameworkElement const &origin) {
        // Route through the same reader handler as root.PreviewKeyDown. A
        // glyph origin must retain the containing native button's ownership.
        return state->HandleKey(value, false, false, false, false, false, origin);
    };
    const auto pinGlyph = state->pin.Content().as<FontIcon>();
    winrt::check_hresult(state->root.Children().Size() == 2 && state->root.Children().GetAt(0) == state->pin &&
        state->pin.ActualWidth() == CompactActionSize && state->pin.ActualHeight() == CompactActionSize &&
        pinGlyph.Glyph() == L"\uE718" ? S_OK : E_FAIL);
    for (auto const &origin : std::array<FrameworkElement, 2>{state->pin, pinGlyph}) {
        for (auto value : {VK_SPACE, VK_TAB, VK_LEFT, VK_RIGHT, VK_RETURN}) {
            winrt::check_hresult(!toolbarKey(value, origin) && events.size() == count ? S_OK : E_FAIL);
        }
    }
    winrt::check_hresult(!state->HandleKey(VK_TAB, false, true, true, false, false, state->pin) &&
        events.size() == count ? S_OK : E_FAIL);
    winrt::check_hresult(toolbarKey(VK_ESCAPE, state->pin.Content().as<FrameworkElement>()) &&
        events.size() == count + 1 && events.back().first == L"nativeReaderClose" ? S_OK : E_FAIL);
    winrt::check_hresult(toolbarKey(VK_LEFT, state->displayed) && events.back().first == L"readerPrevious" &&
        toolbarKey(VK_TAB, state->displayed) && events.back().first == L"readerNext" &&
        toolbarKey(VK_SPACE, state->displayed) && events.back().first == L"nativeReaderClose" ? S_OK : E_FAIL);
    // Toggle peer invokes the same Click handler as the real native control.
    const auto toggle = Peers::FrameworkElementAutomationPeer::CreatePeerForElement(state->pin)
        .GetPattern(Peers::PatternInterface::Toggle).as<Provider::IToggleProvider>();
    toggle.Toggle();
    co_await NextNativeFrame();
    winrt::check_hresult(events.back().first == L"nativeReaderPin" && pinGlyph.Glyph() == L"\uE842" ? S_OK : E_FAIL);
    toggle.Toggle();
    co_await NextNativeFrame();
    winrt::check_hresult(events.back().first == L"nativeReaderUnpin" && pinGlyph.Glyph() == L"\uE718" ? S_OK : E_FAIL);

    stage = 1182;
    const auto contentFocus = state->root.Children().GetAt(1).try_as<ContentControl>();
    winrt::check_hresult(contentFocus && contentFocus.Content() == state->body &&
        contentFocus.IsTabStop() && !contentFocus.try_as<Primitives::ButtonBase>() ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderFocus", 3));
    co_await NextNativeFrame();
    if (GetForegroundWindow() == handle) {
        winrt::check_hresult(Input::FocusManager::GetFocusedElement(state->root.XamlRoot()) == contentFocus ? S_OK : E_FAIL);
    } else {
        std::fprintf(stderr, "WinUI reader focus target: physical foreground assertion skipped\n");
    }
    winrt::check_hresult(toolbarKey(VK_RIGHT, contentFocus) && events.back().first == L"readerNext" ? S_OK : E_FAIL);

    stage = 119;
    reader.SetAppearance(true, ElementTheme::Dark); co_await NextNativeFrame();
    const auto dark = state->root.Background().as<SolidColorBrush>().Color();
    reader.SetAppearance(false, ElementTheme::Light); co_await NextNativeFrame();
    const auto light = state->root.Background().as<SolidColorBrush>().Color();
    const bool transparentFrame = winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController::IsSupported() && !HighContrastEnabled();
    winrt::check_hresult((transparentFrame ? (dark.A == 0 && light.A == 0 && state->source.SystemBackdrop())
        : (dark.A == 255 && light.A == 255 && dark.R < light.R)) ? S_OK : E_FAIL);
    const auto canvas = state->body.Background().as<SolidColorBrush>().Color();
    winrt::check_hresult(canvas.A == 255 && state->root.Padding() == UniformThickness(0) ? S_OK : E_FAIL);
    state->target = {120, 110, 720, 510}; state->durationMs = 240;
    state->MoveToTarget(false);
    RECT actual{}; winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(EqualRect(&actual, &state->target) && !state->Moving() ? S_OK : E_FAIL);

    stage = 1191;
    RECT changedDpi{140, 120, 840, 620};
    SendMessageW(handle, WM_DPICHANGED, MAKEWPARAM(144, 144), reinterpret_cast<LPARAM>(&changedDpi));
    winrt::check_bool(GetWindowRect(handle, &actual));
    const auto expectedDpiBounds = FitToMonitorWorkArea(changedDpi);
    winrt::check_hresult(EqualRect(&actual, &expectedDpiBounds) && EqualRect(&state->target, &actual) ? S_OK : E_FAIL);
    state->MoveToTarget(false);
    winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(EqualRect(&actual, &expectedDpiBounds) ? S_OK : E_FAIL);
    state->placing = true;
    RECT inFlight{200, 180, 600, 480};
    SendMessageW(handle, WM_DPICHANGED, MAKEWPARAM(144, 144), reinterpret_cast<LPARAM>(&inFlight));
    state->placing = false;
    winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(EqualRect(&actual, &expectedDpiBounds) && EqualRect(&state->target, &actual) ? S_OK : E_FAIL);
    stage = 1192;
    winrt::check_bool(SetWindowPos(handle, nullptr, -30000, -30000, 0, 0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE));
    SendMessageW(handle, WM_DISPLAYCHANGE, 0, 0);
    winrt::check_bool(GetWindowRect(handle, &actual));
    const auto displayBounds = FitToMonitorWorkArea(actual);
    winrt::check_hresult(EqualRect(&actual, &displayBounds) && EqualRect(&actual, &state->target) &&
        !state->Moving() ? S_OK : E_FAIL);

    stage = 120;
    auto files = text(4, L""); auto filesData = files.GetNamedObject(L"data");
    filesData.Insert(L"kind", JsonValue::CreateStringValue(L"files"));
    filesData.Insert(L"caption", JsonValue::CreateStringValue(L"report.zip"));
    filesData.Insert(L"count", JsonValue::CreateNumberValue(2));
    filesData.Insert(L"batch", JsonValue::CreateBooleanValue(true));
    filesData.Insert(L"missing", JsonValue::CreateBooleanValue(true));
    filesData.Insert(L"file", JsonObject::Parse(LR"({"path":".../documents/report.zip","label":"2 个文件","multiple":true,"light":{"name":"zip-light","svg":"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='blue'/></svg>"},"dark":{"name":"zip-dark","svg":"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='white'/></svg>"}})"));
    reader.Receive(files); co_await NextNativeFrame();
    const auto fileInfo = state->displayed.as<Grid>().Children().GetAt(0).as<ScrollViewer>().Content().as<StackPanel>();
    winrt::check_hresult(fileInfo.Children().Size() == 5 &&
        fileInfo.Children().GetAt(0).as<Grid>().Width() == 104 &&
        fileInfo.Children().GetAt(1).as<TextBlock>().Text() == L"report.zip" &&
        fileInfo.Children().GetAt(2).as<TextBlock>().Text() == L".../documents/report.zip" &&
        fileInfo.Children().GetAt(3).as<TextBlock>().Text() == L"共 2 个文件，暂不支持批量文件预览" &&
        fileInfo.Children().GetAt(4).as<TextBlock>().Text() == L"源文件不存在或已移动" ? S_OK : E_FAIL);
    reader.SetAppearance(false, ElementTheme::Dark); co_await NextNativeFrame();
    winrt::check_hresult(winrt::unbox_value<winrt::hstring>(fileInfo.Children().GetAt(0).as<Grid>().Tag()) == L"zip-dark" ? S_OK : E_FAIL);
    reader.SetAppearance(false, ElementTheme::Light); co_await NextNativeFrame();
    winrt::check_hresult(winrt::unbox_value<winrt::hstring>(fileInfo.Children().GetAt(0).as<Grid>().Tag()) == L"zip-light" ? S_OK : E_FAIL);
    auto missing = text(5, L""); auto missingData = missing.GetNamedObject(L"data");
    missingData.Insert(L"kind", JsonValue::CreateStringValue(L"image"));
    missingData.Insert(L"imagePath", JsonValue::CreateStringValue(L"Z:\\vpaste-missing-synthetic-image.png"));
    reader.Receive(missing);
    for (int frame = 0; frame < 180 && state->committed != 5; ++frame) co_await NextNativeFrame();
    winrt::check_hresult(state->committed == 5 && state->body.Children().Size() == 1 &&
        !state->pending && !state->loadTimeout.IsEnabled() ? S_OK : E_FAIL);
    auto released = winrt::make_weak(state->displayed);
    reader.Receive(message(L"nativeReaderHide", 6)); co_await NextNativeFrame();
    winrt::check_hresult(!IsWindowVisible(handle) && state->body.Children().Size() == 0 &&
        !state->displayed && !released.get() ? S_OK : E_FAIL);
    reader.Receive(text(5, L"Late reply")); reader.Receive(text(6, L"Retired reply"));
    winrt::check_hresult(!IsWindowVisible(handle) && state->committed == 0 ? S_OK : E_FAIL);
    reader.Receive(text(7, L"Reopened")); co_await NextNativeFrame();
    reader.Receive(message(L"nativeReaderHide", 6));
    winrt::check_hresult(IsWindowVisible(handle) && state->committed == 7 && state->window == handle ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderBegin", 9));
    reader.Receive(text(7, L"Superseded")); state->ImageError(7);
    winrt::check_hresult(state->committed == 7 && state->latest == 9 && !state->pin.IsEnabled() ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderHide", 10));

    stage = 121;
    struct ImageFixture {
        std::wstring path;
        ~ImageFixture() { if (!path.empty()) DeleteFileW(path.c_str()); }
    } fixture;
    wchar_t temporary[MAX_PATH]{}; winrt::check_bool(GetTempPathW(MAX_PATH, temporary) > 0);
    GUID id{}; winrt::check_hresult(CoCreateGuid(&id));
    fixture.path = std::wstring{temporary} + L"vpaste-reader-" + std::to_wstring(id.Data1) + L"-图片 #100%.bmp";
    {
        winrt::handle file{CreateFileW(fixture.path.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
            nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY, nullptr)};
        winrt::check_bool(static_cast<bool>(file));
        const BITMAPFILEHEADER header{0x4D42, 70, 0, 0, 54};
        const BITMAPINFOHEADER bitmap{40, 2, 2, 1, 24, BI_RGB, 16, 0, 0, 0, 0};
        const std::uint8_t pixels[16]{255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0};
        const auto write = [&](void const *bytes, DWORD size) {
            DWORD written = 0; winrt::check_bool(WriteFile(file.get(), bytes, size, &written, nullptr));
            winrt::check_hresult(written == size ? S_OK : E_FAIL);
        };
        write(&header, sizeof(header)); write(&bitmap, sizeof(bitmap)); write(pixels, sizeof(pixels));
    }
    auto image = text(11, L""); auto imageData = image.GetNamedObject(L"data");
    imageData.Insert(L"kind", JsonValue::CreateStringValue(L"image"));
    imageData.Insert(L"imagePath", JsonValue::CreateStringValue(fixture.path));
    imageData.Insert(L"caption", JsonValue::CreateStringValue(L"图片 #100%.bmp"));
    imageData.Insert(L"detail", JsonValue::CreateStringValue(fixture.path));
    reader.Receive(image);
    for (int frame = 0; frame < 180 && state->committed != 11; ++frame) co_await NextNativeFrame();
    winrt::check_hresult(state->committed == 11 && state->window == handle &&
        state->displayed.as<Grid>().Children().GetAt(0).as<StackPanel>().Children().GetAt(0).as<TextBlock>().Text() == L"图片 #100%.bmp" &&
        state->displayed.as<Grid>().Children().GetAt(1).as<Grid>().Children().GetAt(0).as<Grid>()
            .Children().GetAt(1).try_as<Image>() ? S_OK : E_FAIL);
    const auto imageFrame = state->displayed.as<Grid>().Children().GetAt(1).as<Grid>().Children().GetAt(0).as<Grid>();
    co_await NextNativeFrame();
    winrt::check_hresult(imageFrame.Width() == 2 && imageFrame.Height() == 2 &&
        imageFrame.Children().GetAt(0).try_as<Canvas>() ? S_OK : E_FAIL);
    // A large image needs repeated tiles, not a centered 256-DIP patch. Verify
    // pixels across tile boundaries, separately from the image's own alpha.
    for (const auto appearance : {ElementTheme::Light, ElementTheme::Dark}) {
        reader.SetAppearance(false, appearance);
        auto matte = ReaderTransparencyMatte(); matte.Width(560); matte.Height(96);
        state->body.Children().Append(matte);
        for (int frame = 0; frame < 6; ++frame) co_await NextNativeFrame();
        winrt::check_hresult(HighContrastEnabled() || matte.Children().Size() == 3 ? S_OK : E_FAIL);
        if (!HighContrastEnabled()) {
            Imaging::RenderTargetBitmap bitmap; co_await bitmap.RenderAsync(matte, 560, 96);
            const auto buffer = co_await bitmap.GetPixelsAsync();
            winrt::com_array<std::uint8_t> pixels(buffer.Length());
            winrt::Windows::Storage::Streams::DataReader::FromBuffer(buffer).ReadBytes(pixels);
            winrt::check_hresult(bitmap.PixelWidth() == 560 && bitmap.PixelHeight() == 96 ? S_OK : E_FAIL);
            // Fractional layout can antialias one edge into two adjacent color
            // changes. Count light/dark crossings, not those intermediate shades.
            const auto midpoint = appearance == ElementTheme::Dark ? 70 : 229;
            int transitions = 0;
            for (int x = 1; x < 560; ++x)
                if ((pixels[(12 * 560 + x) * 4] > midpoint) != (pixels[(12 * 560 + x - 1) * 4] > midpoint)) ++transitions;
            std::fprintf(stderr, "WinUI reader matte: theme=%d transitions=%d logical=%.1fx%.1f pixels=%dx%d scale=%.3f\n",
                static_cast<int>(appearance), transitions, matte.ActualWidth(), matte.ActualHeight(),
                bitmap.PixelWidth(), bitmap.PixelHeight(), matte.XamlRoot().RasterizationScale());
            winrt::check_hresult(transitions >= 68 && transitions <= 71 ? S_OK : E_FAIL);
        }
        state->body.Children().RemoveAtEnd();
    }
    auto decoded = winrt::make_weak(state->displayed);
    reader.Receive(message(L"nativeReaderHide", 12)); co_await NextNativeFrame();
    winrt::check_hresult(!decoded.get() && state->body.Children().Size() == 0 ? S_OK : E_FAIL);

    stage = 122;
    imageData.Insert(L"generation", JsonValue::CreateNumberValue(13));
    reader.Receive(image); reader.Receive(text(15, L"Newer text replaces pending image"));
    for (int frame = 0; frame < 3; ++frame) co_await NextNativeFrame();
    state->ImageError(13);
    winrt::check_hresult(state->committed == 15 && state->body.Children().Size() == 1 &&
        state->displayed.as<Grid>().Children().GetAt(0).try_as<ScrollViewer>() ? S_OK : E_FAIL);
    // A new rectangle starts from the actual current rectangle; reduced motion
    // commits the target synchronously even if an animation was in progress.
    state->target = {180, 120, 880, 570}; state->durationMs = 240;
    state->MoveToTarget(true);
    state->target = {140, 110, 740, 510}; state->MoveToTarget(true);
    winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(EqualRect(&state->from, &actual) ? S_OK : E_FAIL);
    state->MoveToTarget(false); winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(EqualRect(&state->target, &actual) && !state->Moving() ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderHide", 16));

    stage = 123;
    // A hidden owner invalidates even a successfully prepared hover result.
    state->owner = handle;
    auto hover = text(17, L"Must not open over another app");
    hover.GetNamedObject(L"data").Insert(L"hover", JsonValue::CreateBooleanValue(true));
    reader.Receive(hover); co_await NextNativeFrame();
    winrt::check_hresult(!IsWindowVisible(handle) && state->retired && state->committed == 0 &&
        events.back().first == L"nativeReaderCancelled" && events.back().second == 17 ? S_OK : E_FAIL);
    state->owner = nullptr;

    stage = 124;
    reader.Receive(text(19, L"Reader activation follows the shared focus policy"));
    SendMessageW(handle, WM_ACTIVATE, WA_INACTIVE, 0);
    winrt::check_hresult(events.back().first == L"nativeReaderBlur" &&
        events.back().second == 19 ? S_OK : E_FAIL);
    state->target = {200, 180, 800, 580}; state->durationMs = 240;
    state->MoveToTarget(true); reader.Receive(message(L"nativeReaderBegin", 21));
    winrt::check_hresult(state->Moving() && state->latest == 21 && IsWindowVisible(handle) ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderHide", 22));

    stage = 1242;
    reader.Receive(text(24, L"Visible content remains until its replacement is ready"));
    co_await NextNativeFrame();
    const auto oldContent = state->displayed;
    auto replacement = text(26, L"Continuous next content");
    replacement.GetNamedObject(L"data").Insert(L"durationMs", JsonValue::CreateNumberValue(240));
    replacement.GetNamedObject(L"data").Insert(L"rect", JsonObject::Parse(LR"({"x":160,"y":120,"width":640,"height":400})"));
    reader.Receive(replacement);
    winrt::check_hresult(state->window == handle && IsWindowVisible(handle) &&
        state->displayed && state->body.Children().Size() >= 1 && state->body.Children().Size() <= 2 ? S_OK : E_FAIL);
    if (NativeAnimationsEnabled()) winrt::check_hresult(state->outgoing == oldContent && !oldContent.IsHitTestVisible() ? S_OK : E_FAIL);
    for (int frame = 0; frame < 90 && state->outgoing; ++frame) {
        co_await NextNativeFrame();
        winrt::check_hresult(IsWindowVisible(handle) && state->body.Children().Size() >= 1 &&
            state->body.Children().Size() <= 2 ? S_OK : E_FAIL);
    }
    winrt::check_hresult(!state->outgoing && state->body.Children().Size() == 1 && state->displayed.Opacity() == 1 ? S_OK : E_FAIL);
    const auto accepted = state->displayed;
    reader.Receive(message(L"nativeReaderBegin", 27)); co_await NextNativeFrame();
    winrt::check_hresult(state->displayed == accepted && accepted.Opacity() == 1 && IsWindowVisible(handle) ? S_OK : E_FAIL);
    reader.Receive(text(28, L"Reduced motion settles immediately"));
    winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(!state->outgoing && state->body.Children().Size() == 1 &&
        state->displayed.Opacity() == 1 && !state->Moving() &&
        EqualRect(&state->target, &actual) ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderHide", 28));

    stage = 1243;
    // Renderer handoff must animate the outer rectangle, not just fade a new
    // HWND at its final size. Sample actual OS bounds while frames advance.
    const auto shared = CreateWindowExW(WS_EX_TOOLWINDOW, L"STATIC", L"Preview handoff fixture",
        WS_POPUP, 120, 90, 880, 600, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    winrt::check_bool(shared != nullptr);
    struct SharedFixture { HWND window; ~SharedFixture() { DestroyWindow(window); } } sharedFixture{shared};
    ShowWindow(shared, SW_SHOWNOACTIVATE);
    RECT sharedBounds{}; winrt::check_bool(GetWindowRect(shared, &sharedBounds));
    auto handoff = text(29, L"Native preview inherits the visible shared rectangle");
    handoff.GetNamedObject(L"data").Insert(L"handoffWindow", JsonValue::CreateNumberValue(
        static_cast<double>(reinterpret_cast<std::uintptr_t>(shared))));
    handoff.GetNamedObject(L"data").Insert(L"durationMs", JsonValue::CreateNumberValue(240));
    reader.Receive(handoff); winrt::check_bool(GetWindowRect(handle, &actual));
    const bool animatedHandoff = NativeAnimationsEnabled();
    winrt::check_hresult((animatedHandoff ? EqualRect(&actual, &sharedBounds) && state->Moving()
        : EqualRect(&actual, &state->target)) ? S_OK : E_FAIL);
    bool intermediate = false;
    for (int frame = 0; frame < 90 && state->Moving(); ++frame) {
        co_await NextNativeFrame(); winrt::check_bool(GetWindowRect(handle, &actual));
        intermediate = intermediate || (!EqualRect(&actual, &sharedBounds) && !EqualRect(&actual, &state->target));
        winrt::check_hresult(IsWindowVisible(handle) ? S_OK : E_FAIL);
    }
    winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(EqualRect(&actual, &state->target) && (!animatedHandoff || intermediate) ? S_OK : E_FAIL);
    if (animatedHandoff && state->movementFrames.size() > 1) {
        double maximum = 0;
        for (std::size_t i = 1; i < state->movementFrames.size(); ++i)
            maximum = std::max(maximum, std::chrono::duration<double, std::milli>(
                state->movementFrames[i] - state->movementFrames[i - 1]).count());
        const auto span = std::chrono::duration<double, std::milli>(
            state->movementFrames.back() - state->movementFrames.front()).count();
        std::fprintf(stderr, "WinUI reader resize cadence: frames=%zu mean=%.2fms max=%.2fms\n",
            state->movementFrames.size(), span / (state->movementFrames.size() - 1), maximum);
    }
    reader.Receive(message(L"nativeReaderHide", 29)); ShowWindow(shared, SW_HIDE);

    stage = 1241;
    const auto started = std::chrono::steady_clock::now();
    RecordNativeResources("reader-before");
    for (std::uint64_t cycle = 0; cycle < 20; ++cycle) {
        const auto generation = 30 + cycle * 4;
        reader.Receive(text(generation, L"Repeated native reader lifecycle"));
        co_await NextNativeFrame();
        auto textContent = winrt::make_weak(state->displayed);
        imageData.Insert(L"generation", JsonValue::CreateNumberValue(static_cast<double>(generation + 1)));
        reader.Receive(image);
        for (int frame = 0; frame < 180 && state->committed != generation + 1; ++frame) co_await NextNativeFrame();
        for (int frame = 0; frame < 90 && state->outgoing; ++frame) co_await NextNativeFrame();
        winrt::check_hresult(state->committed == generation + 1 && !textContent.get() ? S_OK : E_FAIL);
        auto imageContent = winrt::make_weak(state->displayed);
        reader.Receive(message(L"nativeReaderHide", generation + 2));
        co_await NextNativeFrame();
        winrt::check_hresult(!imageContent.get() && !state->pending && !state->displayed &&
            !state->Moving() && !state->loadTimeout.IsEnabled() &&
            state->window == handle && !IsWindowVisible(handle) ? S_OK : E_FAIL);
    }
    RecordNativeResources("reader-after-20-text-image-hide");
    std::printf("WinUI reader 20 text/image/hide cycles: %.2f ms including decode/render waits\n",
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count());

    stage = 1244;
    reader.Receive(text(200, L"Accepted geometry continues while the next image decodes"));
    co_await NextNativeFrame();
    const auto acceptedTarget = state->target;
    const auto acceptedContent = state->displayed;
    imageData.Insert(L"generation", JsonValue::CreateNumberValue(201));
    imageData.Insert(L"rect", JsonObject::Parse(LR"({"x":240,"y":160,"width":320,"height":640})"));
    reader.Receive(image);
    winrt::check_hresult(state->committed == 200 && state->pending &&
        state->displayed == acceptedContent && EqualRect(&state->target, &acceptedTarget) ? S_OK : E_FAIL);
    reader.Receive(text(202, L"Newer text wins over pending image geometry"));
    co_await NextNativeFrame();
    state->ImageError(201);
    winrt::check_hresult(state->committed == 202 && state->displayed != acceptedContent ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderHide", 204));
}
#endif
}
