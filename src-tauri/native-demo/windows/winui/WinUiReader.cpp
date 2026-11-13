#include "WinUiReader.h"
#include "WinUiResourceProbe.h"
#include "WinUiAppearance.h"
#include "WinUiRichContent.h"
#include <dwmapi.h>
#include <objbase.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <utility>
#ifdef _DEBUG
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Interop.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Hosting.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.ViewManagement.h>

namespace vpaste::winui {
namespace {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Microsoft::UI::Xaml::Media;
using namespace winrt::Windows::Data::Json;
constexpr wchar_t ReaderClass[] = L"VPasteWinUiReader";
std::atomic<HWND> publishedWindow{nullptr};

TextBlock ReaderText(winrt::hstring const &text, double size = 14) {
    TextBlock block;
    block.Text(text); block.FontSize(size);
    block.TextWrapping(TextWrapping::Wrap);
    ApplyStyle(block, L"VPaste.Body"); block.FontSize(size);
    return block;
}

double Ease(double progress, std::array<double, 4> const &curve) {
    const auto coordinate = [](double t, double a, double b) {
        return 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    };
    double low = 0, high = 1;
    for (int step = 0; step < 16; ++step) {
        const auto t = (low + high) / 2;
        if (coordinate(t, curve[0], curve[2]) < progress) low = t; else high = t;
    }
    return coordinate((low + high) / 2, curve[1], curve[3]);
}
}

struct Reader::Impl : std::enable_shared_from_this<Reader::Impl> {
    explicit Impl(Request callback, HWND reference) : request(std::move(callback)), owner(reference) {}
    Request request;
    HWND owner;
    HWND window = nullptr;
    Hosting::DesktopWindowXamlSource source{nullptr};
    Grid root{nullptr}, body{nullptr};
    FrameworkElement pending{nullptr}, displayed{nullptr};
    Controls::Primitives::ToggleButton pin{nullptr};
    Button close{nullptr};
    DispatcherTimer movement{nullptr}, loadTimeout{nullptr};
    std::uint64_t latest = 0, committed = 0;
    bool english = false, takesFocus = false, retired = false, hover = false;
    ElementTheme theme = ElementTheme::Default;
    RECT target{}, from{};
    std::array<double, 4> easing{};
    double durationMs = 0;
    std::chrono::steady_clock::time_point started;

    ~Impl() {
        if (movement) movement.Stop();
        if (loadTimeout) loadTimeout.Stop();
        publishedWindow.store(nullptr, std::memory_order_release);
        if (source) { source.Content(nullptr); source.Close(); }
        if (window) { SetWindowLongPtrW(window, GWLP_USERDATA, 0); DestroyWindow(window); }
    }

    winrt::hstring Text(wchar_t const *zh, wchar_t const *en) const { return english ? en : zh; }
    void Send(wchar_t const *op) { if (request) request(op, latest); }

    bool HandleKey(unsigned key, bool repeated, bool control, bool shift, bool alt, bool composing) {
        if (composing || alt) return false;
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
                if (self->movement) self->movement.Stop();
                const auto rect = reinterpret_cast<RECT *>(lparam);
                SetWindowPos(handle, nullptr, rect->left, rect->top,
                    rect->right - rect->left, rect->bottom - rect->top, SWP_NOACTIVATE | SWP_NOZORDER);
                self->Resize(); return 0;
            }
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
        // This reader has no Acrylic controller. Use a live theme resource,
        // rather than the main dock's potentially transparent canvas brush.
        root = Markup::XamlReader::Load(LR"(<Grid
            xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
            Background="{ThemeResource ApplicationPageBackgroundThemeBrush}"/>)").as<Grid>();
        RowDefinition heading; heading.Height(GridLength{40, GridUnitType::Pixel});
        root.RowDefinitions().Append(heading); root.RowDefinitions().Append(RowDefinition{});
        StackPanel actions; actions.Orientation(Orientation::Horizontal);
        actions.HorizontalAlignment(HorizontalAlignment::Right); actions.Spacing(4);
        actions.Margin(Thickness{8, 4, 8, 4});
        pin = Controls::Primitives::ToggleButton();
        pin.Content(SymbolIcon{Symbol::Pin}); pin.Width(32); pin.Height(32); pin.Padding(Thickness{0});
        close = NamedIconButton(SymbolIcon{Symbol::Cancel}, Text(L"关闭预览", L"Close preview"));
        actions.Children().Append(pin); actions.Children().Append(close);
        root.Children().Append(actions);
        body = Grid(); body.Margin(Thickness{16, 0, 16, 16}); Grid::SetRow(body, 1);
        root.Children().Append(body);
        const auto weak = weak_from_this();
        pin.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->committed == self->latest) {
                self->Send(self->pin.IsChecked() && self->pin.IsChecked().Value() ? L"nativeReaderPin" : L"nativeReaderUnpin");
                self->ApplyAppearance();
            }
        });
        close.Click([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->Send(L"nativeReaderClose"); });
        root.PointerEntered([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->Send(L"nativeReaderEnter"); });
        root.PointerExited([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->Send(L"nativeReaderLeave"); });
        root.PreviewKeyDown([weak](auto const &, auto const &args) {
            if (auto self = weak.lock()) args.Handled(self->HandleKey(static_cast<unsigned>(args.Key()),
                args.KeyStatus().WasKeyDown, (GetKeyState(VK_CONTROL) & 0x8000) != 0,
                (GetKeyState(VK_SHIFT) & 0x8000) != 0,
                ((GetKeyState(VK_MENU) | GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000) != 0,
                static_cast<unsigned>(args.OriginalKey()) == VK_PROCESSKEY));
        });
        root.ActualThemeChanged([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) self->ApplyAppearance();
        });
        movement = DispatcherTimer(); movement.Interval(std::chrono::milliseconds(16));
        movement.Tick([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->Step(); });
        loadTimeout = DispatcherTimer(); loadTimeout.Interval(std::chrono::seconds(5));
        loadTimeout.Tick([weak](auto const &, auto const &) {
            if (auto self = weak.lock()) { self->loadTimeout.Stop(); self->ImageError(self->latest); }
        });
        source.Content(root); source.SiteBridge().Show(); ApplyAppearance(); Resize();
        const auto corners = DWMWCP_ROUND;
        (void)DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
        const MARGINS shadow{1, 1, 1, 1}; (void)DwmExtendFrameIntoClientArea(window, &shadow);
        publishedWindow.store(window, std::memory_order_release);
    }

    void ApplyAppearance() {
        if (!root) return;
        root.RequestedTheme(theme);
        const BOOL dark = root.ActualTheme() == ElementTheme::Dark;
        (void)DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
        SetWindowTextW(window, Text(L"vPaste — 预览", L"vPaste — Preview").c_str());
        NameIconButton(close, Text(L"关闭预览", L"Close preview"));
        const auto label = pin.IsChecked() && pin.IsChecked().Value()
            ? Text(L"取消固定预览", L"Unpin preview") : Text(L"固定预览", L"Pin preview");
        Automation::AutomationProperties::SetName(pin, label);
        ToolTipService::SetToolTip(pin, winrt::box_value(label));
    }

    void Place(RECT const &rect) {
        winrt::check_bool(SetWindowPos(window, HWND_TOPMOST, rect.left, rect.top,
            rect.right - rect.left, rect.bottom - rect.top, SWP_NOACTIVATE));
    }

    void Step() {
        const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        const auto progress = std::clamp(elapsed / std::max(1.0, durationMs), 0.0, 1.0);
        if (progress >= 1 || !winrt::Windows::UI::ViewManagement::UISettings().AnimationsEnabled()) {
            movement.Stop(); Place(target); return;
        }
        const auto eased = Ease(progress, easing);
        const auto interpolate = [eased](LONG a, LONG b) { return static_cast<LONG>(std::lround(a + (b - a) * eased)); };
        Place({interpolate(from.left, target.left), interpolate(from.top, target.top),
            interpolate(from.right, target.right), interpolate(from.bottom, target.bottom)});
    }

    void MoveToTarget(bool animationsEnabled) {
        movement.Stop();
        winrt::check_bool(GetWindowRect(window, &from));
        if (IsWindowVisible(window) && animationsEnabled && !EqualRect(&from, &target) && durationMs > 0) {
            started = std::chrono::steady_clock::now(); movement.Start();
        } else Place(target);
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
        loadTimeout.Stop(); movement.Stop();
        displayed = pending; pending = nullptr; displayed.Opacity(1); displayed.IsHitTestVisible(true);
        body.Children().Clear(); body.Children().Append(displayed);
        committed = generation; pin.IsEnabled(true);
        MoveToTarget(winrt::Windows::UI::ViewManagement::UISettings().AnimationsEnabled());
        ShowWindow(window, SW_SHOWNOACTIVATE);
        if (takesFocus) {
            SetForegroundWindow(window);
            pin.Focus(FocusState::Programmatic);
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
        if (movement) movement.Stop();
        if (loadTimeout) loadTimeout.Stop();
        if (pending && body) { std::uint32_t index = 0; if (body.Children().IndexOf(pending, index)) body.Children().RemoveAt(index); }
        pending = nullptr;
        if (pin) pin.IsEnabled(false);
    }

    void Hide(std::uint64_t generation) {
        if (generation < latest) return;
        latest = generation; committed = 0; retired = true;
        if (movement) movement.Stop();
        if (loadTimeout) loadTimeout.Stop();
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
        target = {number(L"x"), number(L"y"), 0, 0};
        const auto width = number(L"width"), height = number(L"height");
        winrt::check_hresult(width > 0 && height > 0 ? S_OK : E_INVALIDARG);
        target.right = target.left + width; target.bottom = target.top + height;
        durationMs = std::clamp(data.GetNamedNumber(L"durationMs"), 0.0, 320.0);
        const auto curve = data.GetNamedArray(L"easing");
        winrt::check_hresult(curve.Size() == 4 ? S_OK : E_INVALIDARG);
        for (unsigned i = 0; i < 4; ++i) { easing[i] = curve.GetNumberAt(i); winrt::check_hresult(std::isfinite(easing[i]) ? S_OK : E_INVALIDARG); }
        takesFocus = data.GetNamedBoolean(L"takesFocus", false);
        hover = data.GetNamedBoolean(L"hover", false);
        if (!IsWindowVisible(window)) Place(target);
        const auto kind = data.GetNamedString(L"kind");
        Grid content;
        const auto caption = data.GetNamedString(L"caption", L"");
        if (!caption.empty()) {
            RowDefinition label; label.Height(GridLength{1, GridUnitType::Auto});
            const bool imageCaption = kind == L"image";
            content.RowDefinitions().Append(imageCaption ? RowDefinition{} : label);
            content.RowDefinitions().Append(imageCaption ? label : RowDefinition{});
            StackPanel description; description.Spacing(4);
            auto title = ReaderText(caption); ApplyStyle(title, L"VPaste.CompactTitle");
            description.Children().Append(title);
            const auto detail = data.GetNamedString(L"detail", L"");
            if (!detail.empty()) {
                auto path = ReaderText(detail, 12); ApplyStyle(path, L"VPaste.Secondary");
                path.TextWrapping(TextWrapping::NoWrap); path.TextTrimming(TextTrimming::CharacterEllipsis);
                ToolTipService::SetToolTip(path, winrt::box_value(detail)); description.Children().Append(path);
            }
            description.Margin(imageCaption ? Thickness{0, 8, 0, 0} : Thickness{0, 0, 0, 8});
            if (imageCaption) Grid::SetRow(description, 1);
            content.Children().Append(description);
        }
        if (kind == L"image") {
            Image image; image.Stretch(Stretch::Uniform);
            content.Children().Append(image);
            pending = content; pending.Opacity(0); pending.IsHitTestVisible(false);
            body.Children().Append(pending);
            const auto weak = weak_from_this();
            image.ImageOpened([weak, generation](auto const &, auto const &) { if (auto self = weak.lock()) self->Commit(generation); });
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
        } else {
            StackPanel textContent; textContent.Spacing(12);
            if (kind == L"files") {
                const auto count = static_cast<unsigned>(data.GetNamedNumber(L"count", 1));
                textContent.Children().Append(ReaderText(winrt::to_hstring(count) + Text(L" 个文件 / 文件夹", L" files / folders"), 12));
            }
            const auto value = data.GetNamedString(L"text", L"");
            auto text = ReaderText(value.empty() ? Text(L"没有可预览的文本", L"No text to preview") : value);
            text.IsTextSelectionEnabled(true);
            textContent.Children().Append(text);
            if (data.GetNamedBoolean(L"truncated", false))
                textContent.Children().Append(ReaderText(Text(L"仅显示部分内容，复制和粘贴保留完整文本。", L"Partial preview; copy and paste keep the full text."), 12));
            if (data.GetNamedBoolean(L"missing", false))
                textContent.Children().Append(ReaderText(Text(L"部分文件已不存在。", L"Some files no longer exist."), 12));
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
            if (window && IsWindowVisible(window)) { SetForegroundWindow(window); pin.Focus(FocusState::Programmatic); }
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
    const auto invoke = [](auto const &control) {
        Peers::FrameworkElementAutomationPeer::CreatePeerForElement(control)
            .GetPattern(Peers::PatternInterface::Invoke).as<Provider::IInvokeProvider>().Invoke();
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
    state->pin.IsChecked(true);
    // Toggle peer invokes the same Click handler as the real native control.
    Peers::FrameworkElementAutomationPeer::CreatePeerForElement(state->pin)
        .GetPattern(Peers::PatternInterface::Toggle).as<Provider::IToggleProvider>().Toggle();
    co_await NextNativeFrame();
    winrt::check_hresult(events.back().first == L"nativeReaderUnpin" ? S_OK : E_FAIL);
    invoke(state->close); co_await NextNativeFrame();
    winrt::check_hresult(events.back().first == L"nativeReaderClose" ? S_OK : E_FAIL);

    stage = 119;
    reader.SetAppearance(true, ElementTheme::Dark); co_await NextNativeFrame();
    const auto dark = state->root.Background().as<SolidColorBrush>().Color();
    reader.SetAppearance(false, ElementTheme::Light); co_await NextNativeFrame();
    const auto light = state->root.Background().as<SolidColorBrush>().Color();
    winrt::check_hresult(dark.A == 255 && light.A == 255 && dark.R < light.R ? S_OK : E_FAIL);
    state->target = {120, 110, 720, 510}; state->durationMs = 240;
    state->MoveToTarget(false);
    RECT actual{}; winrt::check_bool(GetWindowRect(handle, &actual));
    winrt::check_hresult(EqualRect(&actual, &state->target) && !state->movement.IsEnabled() ? S_OK : E_FAIL);

    stage = 120;
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
        state->displayed.as<Grid>().Children().GetAt(1).try_as<Image>() ? S_OK : E_FAIL);
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
    winrt::check_hresult(EqualRect(&state->target, &actual) && !state->movement.IsEnabled() ? S_OK : E_FAIL);
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
    winrt::check_hresult(!state->movement.IsEnabled() && state->latest == 21 ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderHide", 22));

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
        winrt::check_hresult(state->committed == generation + 1 && !textContent.get() ? S_OK : E_FAIL);
        auto imageContent = winrt::make_weak(state->displayed);
        reader.Receive(message(L"nativeReaderHide", generation + 2));
        co_await NextNativeFrame();
        winrt::check_hresult(!imageContent.get() && !state->pending && !state->displayed &&
            !state->movement.IsEnabled() && !state->loadTimeout.IsEnabled() &&
            state->window == handle && !IsWindowVisible(handle) ? S_OK : E_FAIL);
    }
    RecordNativeResources("reader-after-20-text-image-hide");
    std::printf("WinUI reader 20 text/image/hide cycles: %.2f ms including decode/render waits\n",
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count());
}
#endif
}
