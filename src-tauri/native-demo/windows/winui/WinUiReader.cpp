#include "WinUiReader.h"
#include "WinUiResourceProbe.h"
#include "WinUiAppearance.h"
#include "WinUiMotion.h"
#include "WinUiGeometry.h"
#include "WinUiRichContent.h"
#include "WinUiCardContent.h"
#include "WinUiCardActions.h"
#include <dwmapi.h>
#include <objbase.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <optional>
#include <utility>
#include <thread>
#ifdef _DEBUG
#include <cstdio>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
#include <winrt/Windows.Storage.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
winrt::Windows::Foundation::IAsyncAction CaptureNativeView(
    winrt::Microsoft::UI::Xaml::FrameworkElement view,
    winrt::Windows::Storage::StorageFolder folder, winrt::hstring name);
#endif
#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Composition.SystemBackdrops.h>
#include <winrt/Microsoft.UI.Input.h>
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
constexpr double FormHeadingInset = 12;
// DWMWA_SYSTEMBACKDROP_TYPE was added after our minimum SDK. Use it as a
// capability check: below it the browser fallback can only use a solid fill.
constexpr DWORD ReaderBackdropAttribute = 38;
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

winrt::hstring NormalizedLines(winrt::hstring const &input) {
    // TextBox uses CR in some editing operations; textarea.value uses LF.
    if (std::wstring_view{input}.find(L'\r') == std::wstring_view::npos) return input;
    std::wstring result;
    result.reserve(input.size());
    for (std::uint32_t i = 0; i < input.size(); ++i) {
        if (input[i] == L'\r') {
            result += L'\n';
            if (i + 1 < input.size() && input[i + 1] == L'\n') ++i;
        } else result += input[i];
    }
    return winrt::hstring{result};
}

}

struct Reader::Impl : std::enable_shared_from_this<Reader::Impl> {
    explicit Impl(Request callback, HWND reference, bool editor)
        : request(std::move(callback)), owner(reference), editorWindow(editor) {}
    Request request;
    HWND owner;
    bool const editorWindow;
    HWND window = nullptr, handoffWindow = nullptr;
    Hosting::DesktopWindowXamlSource source{nullptr};
    Grid root{nullptr}, body{nullptr};
    ContentControl contentFocus{nullptr};
    FrameworkElement pending{nullptr}, displayed{nullptr}, outgoing{nullptr};
    winrt::Microsoft::UI::Composition::ScalarKeyFrameAnimation contentEnter{nullptr}, contentExit{nullptr};
    Controls::Primitives::ToggleButton pin{nullptr};
    Button windowClose{nullptr};
    Grid captionBar{nullptr};
    TextBlock formTitle{nullptr};
    IconElement captionIcon{nullptr};
    std::optional<std::uint32_t> captionPointer;
    winrt::Windows::Foundation::Point captionGrab{};
    bool systemCorners = false, captionMoved = false;
    struct Form {
        TextBox field;
        Button primary, cancel;
        InfoBar status, copyError;
        Image image{nullptr};
        ProgressRing imageProgress{nullptr}, work{nullptr};
        TextBlock imageTitle{nullptr}, resultTitle{nullptr}, imageMessage{nullptr}, workLabel{nullptr};
        StackPanel workStatus{nullptr};
        ContentDialog discard{nullptr};
        winrt::hstring original, statusKey;
        std::uint64_t action = 0, copyAll = 0;
        bool edited = false, initializing = false, composing = false, imageMissing = false, hasRecord = false;
    };
    std::optional<Form> form;
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
        if (form && form->discard) {
            try { form->discard.Hide(); }
            catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
        }
        FinishContentTransition();
        StopMovement();
        if (loadTimeout) loadTimeout.Stop();
        if (!editorWindow) publishedWindow.store(nullptr, std::memory_order_release);
        if (source) { source.Content(nullptr); source.Close(); }
        if (window) { SetWindowLongPtrW(window, GWLP_USERDATA, 0); DestroyWindow(window); }
    }

    winrt::hstring Text(wchar_t const *zh, wchar_t const *en) const { return english ? en : zh; }
    std::uint64_t Send(wchar_t const *op, winrt::hstring const &text = {}) {
        return request ? request(op, latest, text) : 0;
    }

    bool HandleKey(unsigned key, bool repeated, bool control, bool shift, bool alt, bool composing,
        winrt::Windows::Foundation::IInspectable const &origin = nullptr) {
        if (composing || alt || (form && form->composing)) return false;
        if (form) {
            if (form->discard) return false;
            if (key == VK_F2 && editorWindow) return true;
            if (key != VK_ESCAPE || control || shift) return false;
            if (!repeated) CloseForm();
            return true;
        }
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
            case WM_NCCALCSIZE:
                if (self->systemCorners) {
                    auto &client = wparam ? reinterpret_cast<NCCALCSIZE_PARAMS *>(lparam)->rgrc[0]
                        : *reinterpret_cast<RECT *>(lparam);
                    // Leave a real non-client perimeter for the Windows 11
                    // compositor. XAML must not paint into the window outline.
                    InflateRect(&client, -1, -1);
                }
                return 0;
            case WM_NCHITTEST: return HTCLIENT;
            case WM_ERASEBKGND: return 1;
            case WM_SIZE: self->Resize(); return 0;
            case WM_CLOSE:
                if (self->form) self->CloseForm();
                else if (!self->editorWindow) self->Send(L"nativeReaderClose");
                return 0;
            case WM_ACTIVATE:
                if (LOWORD(wparam) == WA_INACTIVE) self->EndCaptionDrag();
                if (self->editorWindow && self->committed && !self->retired)
                    self->Send(LOWORD(wparam) == WA_INACTIVE ? L"nativeEditorFocusOut" : L"nativeEditorFocusIn");
                else if (LOWORD(wparam) == WA_INACTIVE && self->committed && !self->retired)
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
                if (message == WM_SETTINGCHANGE && wparam != SPI_SETWORKAREA) {
                    self->ApplyAppearance(); break;
                }
                if (self->window && IsWindowVisible(self->window)) {
                    self->StopMovement();
                    RECT current{}; winrt::check_bool(GetWindowRect(self->window, &current));
                    self->target = FitToMonitorWorkArea(current); self->from = self->target;
                    self->Place(self->target); self->Resize();
                }
                return 0;
            case WM_THEMECHANGED: self->ApplyAppearance(); break;
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
        pin.CornerRadius(UniformRadius(6));
        pin.HorizontalAlignment(HorizontalAlignment::Right); pin.VerticalAlignment(VerticalAlignment::Center);
        const auto transparent = SolidColorBrush{winrt::Windows::UI::Colors::Transparent()};
        pin.Background(transparent); pin.BorderBrush(transparent);
        formTitle = ReaderText(L"", 16);
        windowClose = AuxiliaryClose(Text(L"关闭", L"Close"));
        StackPanel commands; commands.Orientation(Orientation::Horizontal);
        commands.Spacing(4); commands.VerticalAlignment(VerticalAlignment::Center);
        commands.Children().Append(pin); commands.Children().Append(windowClose);
        captionIcon = editorWindow ? Glyph(L"\uE70F").as<IconElement>() : MakeImageTextIcon().as<IconElement>();
        captionBar = AuxiliaryCaption(formTitle, commands, captionIcon);
        captionBar.Background(transparent);
        captionBar.Margin(Thickness{AuxiliaryInset, 0, editorWindow ? AuxiliaryInset : AuxiliaryGap, 0});
        // The icon alone contributes spacing, so hiding it does not move the preview title.
        captionBar.ColumnSpacing(0);
        captionIcon.Margin(Thickness{0, 0, AuxiliaryGap, 0});
        root.Children().Append(captionBar);
        body = Grid();
        contentFocus = ContentControl(); contentFocus.Content(body); contentFocus.IsTabStop(true);
        contentFocus.HorizontalContentAlignment(HorizontalAlignment::Stretch);
        contentFocus.VerticalContentAlignment(VerticalAlignment::Stretch);
        Grid::SetRow(contentFocus, 1); root.Children().Append(contentFocus);
        const auto weak = weak_from_this();
        windowClose.Click([weak](auto const &, auto const &) { if (auto self = weak.lock()) self->CloseForm(); });
        if (editorWindow) pin.Visibility(Visibility::Collapsed);
        captionBar.PointerPressed([weak](auto const &, Input::PointerRoutedEventArgs const &args) {
            auto self = weak.lock();
            if (!self || !self->form || self->form->discard || self->captionPointer ||
                args.Pointer().PointerDeviceType() != winrt::Microsoft::UI::Input::PointerDeviceType::Mouse) return;
            for (auto hit = args.OriginalSource().try_as<DependencyObject>(); hit && hit != self->captionBar;
                hit = VisualTreeHelper::GetParent(hit)) {
                if (hit.try_as<Primitives::ButtonBase>()) return;
            }
            auto press = args.GetCurrentPoint(self->root);
            if (!press.Properties().IsLeftButtonPressed() || !self->captionBar.CapturePointer(args.Pointer())) return;
            self->captionPointer = args.Pointer().PointerId();
            self->captionGrab = press.Position();
            self->captionMoved = false;
            args.Handled(true);
        });
        captionBar.PointerMoved([weak](auto const &, Input::PointerRoutedEventArgs const &args) {
            if (auto self = weak.lock(); self && self->captionPointer == args.Pointer().PointerId()) {
                if (!args.GetCurrentPoint(self->root).Properties().IsLeftButtonPressed()) {
                    self->EndCaptionDrag();
                    return;
                }
                POINT cursor{};
                if (GetCursorPos(&cursor)) self->MoveCaption(cursor);
                args.Handled(true);
            }
        });
        const auto releaseCaption = [weak](auto const &, Input::PointerRoutedEventArgs const &args) {
            if (auto self = weak.lock(); self && self->captionPointer == args.Pointer().PointerId())
                self->EndCaptionDrag();
        };
        captionBar.PointerReleased(releaseCaption);
        captionBar.PointerCanceled(releaseCaption);
        captionBar.PointerCaptureLost(releaseCaption);
        pin.Click([weak](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->committed == self->latest) {
                self->Send(self->pin.IsChecked() && self->pin.IsChecked().Value() ? L"nativeReaderPin" : L"nativeReaderUnpin");
                self->ApplyAppearance();
            }
        });
        root.PointerEntered([weak](auto const &, auto const &) { if (auto self = weak.lock(); self && !self->editorWindow) self->Send(L"nativeReaderEnter"); });
        root.PointerExited([weak](auto const &, auto const &) { if (auto self = weak.lock(); self && !self->editorWindow) self->Send(L"nativeReaderLeave"); });
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
        source.Content(root);
        const auto corners = DWMWCP_ROUND;
        systemCorners = SUCCEEDED(DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners)));
        if (systemCorners) SetWindowPos(window, nullptr, 0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        const MARGINS frame{1, 1, 1, 1}; (void)DwmExtendFrameIntoClientArea(window, &frame);
        source.SiteBridge().Show(); ApplyAppearance(); Resize();
        const BOOL disableTransitions = TRUE;
        (void)DwmSetWindowAttribute(window, DWMWA_TRANSITIONS_FORCEDISABLED, &disableTransitions, sizeof(disableTransitions));
        if (!editorWindow) publishedWindow.store(window, std::memory_order_release);
    }

    void ApplyAppearance() {
        if (!root) return;
        root.RequestedTheme(theme);
        const BOOL dark = ResolveDarkTheme(theme, root.ActualTheme());
        (void)DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
        // A lifted XAML Island is not guaranteed to expose its parent's
        // backdrop. Use the supported island backdrop slot here and the
        // equivalent DWM material in the browser host, one per surface.
        DWORD systemBackdrop{};
        const bool material = !HighContrastEnabled() &&
            SUCCEEDED(DwmGetWindowAttribute(window, ReaderBackdropAttribute, &systemBackdrop, sizeof(systemBackdrop))) &&
            winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController::IsSupported();
        if (material && !source.SystemBackdrop()) {
            try { source.SystemBackdrop(DesktopAcrylicBackdrop{}); }
            catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
        } else if (!material && source.SystemBackdrop()) {
            source.SystemBackdrop(nullptr);
        }
        if (source.SystemBackdrop()) root.Background(SolidColorBrush{winrt::Windows::UI::Colors::Transparent()});
        else root.ClearValue(Controls::Panel::BackgroundProperty());
        const auto title = editorWindow ? Text(L"编辑文本", L"Edit text")
            : form ? Text(L"查看图片文字", L"View image text") : Text(L"预览", L"Preview");
        SetWindowTextW(window, (L"vPaste — " + title).c_str());
        formTitle.Text(title);
        captionIcon.Visibility(form ? Visibility::Visible : Visibility::Collapsed);
        windowClose.Visibility(form ? Visibility::Visible : Visibility::Collapsed);
        NameIconButton(windowClose, Text(L"关闭", L"Close"));
        Automation::AutomationProperties::SetName(contentFocus, form ? title : Text(L"预览内容", L"Preview content"));
        // The window owns the material. A form's fields and groups provide
        // their own boundaries; only a reader without fields needs a surface.
        const bool isForm = editorWindow || form.has_value();
        body.Margin(isForm ? Thickness{AuxiliaryInset, FormHeadingInset, AuxiliaryInset, AuxiliaryInset}
            : UniformThickness(AuxiliaryGap));
        if (isForm) body.Style(nullptr);
        else if (!body.Style()) ApplyStyle(body, L"VPaste.AuxiliaryReadingSurface");
        if (form) {
            const auto fieldLabel = editorWindow ? Text(L"文字内容", L"Text content") : Text(L"识别结果", L"Recognized text");
            form->resultTitle.Text(fieldLabel);
            Automation::AutomationProperties::SetName(form->field, fieldLabel);
            form->primary.Content(winrt::box_value(editorWindow ? Text(L"保存", L"Save") : Text(L"复制全部", L"Copy all")));
            if (editorWindow) form->cancel.Content(winrt::box_value(Text(L"取消", L"Cancel")));
            if (form->image) {
                form->imageTitle.Text(Text(L"原始图片", L"Original image"));
                Automation::AutomationProperties::SetName(form->image, Text(L"图片", L"Image"));
                form->imageMessage.Text(form->imageMissing ? Message(L"image_missing") : Text(L"图片", L"Image"));
                form->copyError.Message(Text(L"复制失败，请重试", L"Copy failed. Try again."));
            }
            ApplyFormStatus();
        }
        const auto pinned = pin.IsChecked() && pin.IsChecked().Value();
        // Match the Segoe Pin and PinnedFill glyphs used in Preview.tsx.
        pin.Content().as<FontIcon>().Glyph(pinned ? L"\uE842" : L"\uE718");
        const auto label = pinned ? Text(L"取消固定", L"Unpin preview") : Text(L"固定预览", L"Pin preview");
        Automation::AutomationProperties::SetName(pin, label);
        ToolTipService::SetToolTip(pin, winrt::box_value(label));
    }

    void MoveCaption(POINT cursor) {
        // The pointer is already captured. Move the actual window in screen
        // pixels without starting a second, modal Win32 mouse tracking loop.
        POINT origin{};
        if (!ClientToScreen(window, &origin)) return;
        const auto dpi = GetDpiForWindow(window);
        const auto dx = cursor.x - origin.x - static_cast<LONG>(std::lround(captionGrab.X * dpi / 96));
        const auto dy = cursor.y - origin.y - static_cast<LONG>(std::lround(captionGrab.Y * dpi / 96));
        if (!dx && !dy) return;
        if (!captionMoved) {
            if (std::abs(dx) < GetSystemMetricsForDpi(SM_CXDRAG, dpi) &&
                std::abs(dy) < GetSystemMetricsForDpi(SM_CYDRAG, dpi)) return;
            StopMovement();
            captionMoved = true;
        }
        RECT current{};
        if (!GetWindowRect(window, &current)) return;
        if (SetWindowPos(window, nullptr, current.left + dx, current.top + dy, 0, 0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) && GetWindowRect(window, &current)) {
            from = target = current;
        }
    }

    void EndCaptionDrag() {
        if (!captionPointer) return;
        captionPointer.reset(); captionMoved = false;
        captionBar.ReleasePointerCaptures();
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
        ApplyAppearance();
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
            if (form) FadeFeedback(contentFocus, NativeAnimationsEnabled() && !HighContrastEnabled());
        }
        MoveToTarget(NativeAnimationsEnabled());
        if (takesFocus) {
            (void)ActivateWindowFromBackground(window);
            FocusContent();
        }
        if (!editorWindow) Send(L"nativeReaderReady");
    }

    void ImageError(std::uint64_t generation) {
        if (generation != latest || committed == generation) return;
        if (pending) { std::uint32_t index = 0; if (body.Children().IndexOf(pending, index)) body.Children().RemoveAt(index); }
        pending = ReaderText(Text(L"暂时无法预览此内容", L"This content cannot be previewed"));
        Commit(generation);
    }

    void Begin(std::uint64_t generation) {
        if (generation <= latest) return;
        EndCaptionDrag();
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
        EndCaptionDrag();
        StopMovement();
        if (loadTimeout) loadTimeout.Stop();
        FinishContentTransition();
        if (contentFocus) ResetFeedbackOpacity(contentFocus);
        pending = nullptr; displayed = nullptr;
        form.reset();
        if (body) body.Children().Clear();
        if (pin) { pin.IsChecked(false); pin.IsEnabled(false); }
        if (window) ShowWindow(window, SW_HIDE);
    }

    void FocusContent() const {
        if (form && GetForegroundWindow() == window) {
            const auto island = winrt::Microsoft::UI::GetWindowFromWindowId(source.SiteBridge().WindowId());
            const auto current = GetFocus();
            if (island && current != island && !IsChild(island, current)) SetFocus(island);
        }
        if (form && form->field.IsEnabled() && form->field.Visibility() == Visibility::Visible)
            form->field.Focus(FocusState::Programmatic);
        else contentFocus.Focus(FocusState::Programmatic);
    }

    winrt::hstring Message(winrt::hstring const &key) const {
        if (editorWindow) {
            if (key == L"editor.missing") return Text(L"原记录已被删除或清理，修改尚未保存。", L"The original record was deleted or cleaned up. Your changes have not been saved.");
            if (key == L"editor.changed") return Text(L"原记录在编辑期间发生变化，请保留修改内容并重新打开。", L"The original record changed while editing. Keep your draft and reopen the record.");
            if (key == L"editor.duplicate") return Text(L"相同内容已存在，请调整后再保存。", L"Identical content already exists. Adjust your draft before saving.");
            if (key == L"editor.blank") return Text(L"内容不能为空。", L"Content cannot be empty.");
            if (key == L"editor.tooLarge") return Text(L"内容超过可保存的大小。", L"The content exceeds the supported size.");
            if (key == L"editor.unsupported") return Text(L"该条目不支持文字编辑。", L"This item does not support text editing.");
            if (key == L"editor.richUnavailable") return Text(L"富文本读取不完整，无法编辑。原记录未修改。", L"Rich text could not be fully loaded for editing. The original record is unchanged.");
            return Text(L"操作失败：", L"Operation failed: ") + key;
        }
        if (key == L"recognizing") return Text(L"正在识别文字…", L"Recognizing text…");
        if (key == L"empty") return Text(L"未识别到文字", L"No text found");
        if (key == L"image_missing") return Text(L"图片记录已删除或不可用", L"This image was deleted or is unavailable");
        if (key == L"language_unavailable") return Text(L"系统未安装可用的 OCR 语言，请在系统语言设置中安装文字识别功能",
            L"No OCR language is installed. Add text recognition in your system language settings.");
        if (key == L"unsupported") return Text(L"当前系统不支持图片文字识别", L"Image text recognition is unavailable on this system");
        if (key == L"resource_limit") return Text(L"图片超过识别大小限制", L"This image exceeds the recognition size limit");
        if (key == L"timeout") return Text(L"识别超时", L"Recognition timed out");
        return Text(L"识别失败", L"Recognition failed");
    }

    void ApplyFormStatus() const {
        const bool busy = form->statusKey == L"recognizing";
        form->status.IsOpen(!form->statusKey.empty() && !busy);
        if (!form->statusKey.empty()) form->status.Message(Message(form->statusKey));
        form->status.Severity(form->statusKey == L"empty" ? InfoBarSeverity::Informational : InfoBarSeverity::Error);
        if (form->work) {
            form->work.IsActive(busy);
            form->workStatus.Visibility(busy ? Visibility::Visible : Visibility::Collapsed);
            form->workLabel.Text(Message(L"recognizing"));
        }
    }

    void UpdateFormActions() {
        if (!form) return;
        const auto value = NormalizedLines(form->field.Text());
        const bool dirty = value != form->original;
        const auto firstNonSpace = std::wstring_view{value}.find_first_not_of(L" \t\r\n");
        form->primary.IsEnabled(editorWindow
            ? form->field.IsEnabled() && !form->composing && form->action == 0 && dirty &&
                firstNonSpace != std::wstring_view::npos
            : !value.empty() && form->copyAll == 0);
        if (editorWindow) {
            form->cancel.IsEnabled(form->action == 0);
            windowClose.IsEnabled(form->action == 0);
        }
    }

    void CopyOcr(winrt::hstring const &value, bool all) {
        if (value.empty() || (all && form->copyAll)) return;
        if (all) windowClose.Focus(FocusState::Programmatic);
        form->copyError.IsOpen(false);
        form->action = Send(L"nativeOcrCopy", NormalizedLines(value));
        if (all) form->copyAll = form->action;
        if (!form->action) form->copyError.IsOpen(true);
        UpdateFormActions();
    }

    void SaveEditor() {
        if (!form->primary.IsEnabled()) return;
        form->statusKey = L"";
        form->action = Send(L"nativeEditorSave", NormalizedLines(form->field.Text()));
        if (!form->action) form->statusKey = L"editor.tooLarge";
        form->field.IsReadOnly(form->action != 0);
        ApplyFormStatus(); UpdateFormActions();
    }

    void FormActionResult(winrt::hstring const &operation, JsonObject const &response) {
        if (!form || latest != committed) return;
        const auto id = static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0));
        if (!id) return;
        if (operation == L"nativeOcrCopy" && !editorWindow) {
            if (id == form->copyAll) form->copyAll = 0;
            if (id == form->action) form->copyError.IsOpen(response.HasKey(L"error"));
            UpdateFormActions();
        } else if (operation == L"nativeEditorSave" && editorWindow && id == form->action && response.HasKey(L"error")) {
            form->action = 0;
            form->field.IsReadOnly(false);
            form->statusKey = response.GetNamedString(L"error");
            ApplyFormStatus(); UpdateFormActions();
        }
    }

    static winrt::fire_and_forget WaitForDiscard(std::weak_ptr<Impl> owner, ContentDialog dialog) {
        try {
            const auto result = co_await dialog.ShowAsync();
            const auto self = owner.lock();
            if (!self || !self->form || self->form->discard != dialog) co_return;
            self->form->discard = nullptr;
            if (result == ContentDialogResult::Primary) self->Send(L"nativeEditorClose");
            else self->FocusContent();
        } catch (winrt::hresult_error const &error) {
            if (const auto self = owner.lock(); self && self->form && self->form->discard == dialog) {
                self->form->discard = nullptr;
                self->form->statusKey = error.message();
                self->ApplyFormStatus();
            }
        }
    }

    void ConfirmDiscard() {
        form->discard = MakeConfirmationDialog(root, Text(L"放弃修改？", L"Discard changes?"),
            Text(L"尚未保存的修改将丢失。", L"Your unsaved changes will be lost."),
            Text(L"放弃修改", L"Discard changes"), Text(L"继续编辑", L"Keep editing"));
        WaitForDiscard(weak_from_this(), form->discard);
    }

    void CloseForm() {
        if (!form || !committed || latest != committed || form->discard || form->composing) return;
        EndCaptionDrag();
        if (!editorWindow) { Send(L"nativeReaderClose"); return; }
        if (form->action) return;
        if (NormalizedLines(form->field.Text()) != form->original) ConfirmDiscard();
        else Send(L"nativeEditorClose");
    }

    Grid BuildForm(JsonObject const &data, std::uint64_t generation) {
        form.emplace();
        Grid content, workspace;
        content.RowSpacing(12);
        content.RowDefinitions().Append(RowDefinition{});
        RowDefinition footerRow; footerRow.Height(GridLength{1, GridUnitType::Auto});
        content.RowDefinitions().Append(footerRow);
        content.Children().Append(workspace);
        RowDefinition headings, feedbackRow;
        headings.Height(GridLength{1, GridUnitType::Auto});
        feedbackRow.Height(GridLength{1, GridUnitType::Auto});
        workspace.RowDefinitions().Append(headings);
        workspace.RowSpacing(AuxiliaryGap);
        workspace.RowDefinitions().Append(RowDefinition{});
        workspace.RowDefinitions().Append(feedbackRow);
        form->resultTitle = ReaderText(L"");
        ApplyStyle(form->resultTitle, L"VPaste.CompactTitle");
        workspace.Children().Append(form->resultTitle);
        form->field.AcceptsReturn(true); form->field.TextWrapping(TextWrapping::Wrap);
        form->field.IsSpellCheckEnabled(false); form->field.IsTextPredictionEnabled(false);
        form->field.AllowDrop(false);
        ScrollViewer::SetVerticalScrollBarVisibility(form->field, ScrollBarVisibility::Auto);
        Automation::AutomationProperties::SetAutomationId(form->field, editorWindow ? L"EditClipboardText" : L"ImageTextResult");
        Automation::AutomationProperties::SetLabeledBy(form->field, form->resultTitle);
        Grid::SetRow(form->field, 1);
        form->status.IsClosable(false); form->copyError.IsClosable(false); form->copyError.Severity(InfoBarSeverity::Error);
        Automation::AutomationProperties::SetLiveSetting(form->status, Automation::Peers::AutomationLiveSetting::Polite);
        Automation::AutomationProperties::SetLiveSetting(form->copyError, Automation::Peers::AutomationLiveSetting::Assertive);
        StackPanel feedback;
        feedback.Spacing(AuxiliaryGap);
        feedback.Children().Append(form->status);
        Grid::SetRow(feedback, 2);
        workspace.Children().Append(feedback);
        StackPanel actions;
        StyleAuxiliaryAction(form->primary, editorWindow);
        if (editorWindow) {
            StyleAuxiliaryAction(form->cancel);
            actions.Children().Append(form->cancel);
            form->statusKey = data.GetNamedString(L"error", L"");
            form->field.Text(data.GetNamedString(L"text", L""));
            form->original = NormalizedLines(form->field.Text());
            form->field.IsEnabled(form->statusKey.empty());
        } else {
            workspace.ColumnSpacing(12);
            ColumnDefinition imageColumn, textColumn;
            imageColumn.Width(GridLength{2, GridUnitType::Star});
            textColumn.Width(GridLength{3, GridUnitType::Star});
            workspace.ColumnDefinitions().Append(imageColumn); workspace.ColumnDefinitions().Append(textColumn);
            form->imageTitle = ReaderText(L"");
            ApplyStyle(form->imageTitle, L"VPaste.CompactTitle");
            Grid::SetColumn(form->resultTitle, 1);
            workspace.Children().Append(form->imageTitle);
            Grid picture;
            auto imagePane = AuxiliaryGroup(picture);
            Grid::SetRow(imagePane, 1); workspace.Children().Append(imagePane);
            form->image = Image(); form->image.Stretch(Stretch::Uniform); picture.Children().Append(form->image);
            StackPanel imageStatus; imageStatus.Spacing(8);
            imageStatus.HorizontalAlignment(HorizontalAlignment::Center); imageStatus.VerticalAlignment(VerticalAlignment::Center);
            form->imageProgress = ProgressRing(); form->imageProgress.Width(20); form->imageProgress.Height(20);
            form->imageProgress.IsActive(true);
            form->imageMessage = ReaderText(L""); form->imageMessage.TextAlignment(TextAlignment::Center);
            imageStatus.Children().Append(form->imageProgress); imageStatus.Children().Append(form->imageMessage);
            picture.Children().Append(imageStatus);
            form->field.VerticalAlignment(VerticalAlignment::Stretch);
            Grid::SetColumn(form->field, 1);
            Grid::SetColumnSpan(feedback, 2);
            form->workStatus = StackPanel(); form->workStatus.Orientation(Orientation::Horizontal); form->workStatus.Spacing(8);
            form->work = ProgressRing(); form->work.Width(20); form->work.Height(20);
            Automation::AutomationProperties::SetAccessibilityView(form->work, Automation::Peers::AccessibilityView::Raw);
            form->workLabel = ReaderText(L"");
            form->workLabel.VerticalAlignment(VerticalAlignment::Center);
            Automation::AutomationProperties::SetLiveSetting(form->workLabel, Automation::Peers::AutomationLiveSetting::Polite);
            form->workStatus.Children().Append(form->work); form->workStatus.Children().Append(form->workLabel);
            feedback.Children().Append(form->workStatus);
            feedback.Children().Append(form->copyError);
            form->field.Visibility(Visibility::Collapsed);
            form->statusKey = L"recognizing";
        }
        workspace.Children().Append(form->field);
        actions.Children().Append(form->primary);
        const auto footer = AuxiliaryFooter(actions);
        Grid::SetRow(footer, 1); content.Children().Append(footer);
        const auto weak = weak_from_this();
        if (editorWindow) form->field.Loaded([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->latest == generation && self->committed == generation &&
                GetForegroundWindow() == self->window) self->FocusContent();
        });
        form->field.TextChanged([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->latest == generation && self->form) {
                if (!self->form->initializing && NormalizedLines(self->form->field.Text()) != self->form->original)
                    self->form->edited = true;
                self->UpdateFormActions();
            }
        });
        form->field.TextCompositionStarted([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->latest == generation && self->form) {
                self->form->composing = true; self->UpdateFormActions();
            }
        });
        form->field.TextCompositionEnded([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->latest == generation && self->form) {
                self->form->composing = false; self->UpdateFormActions();
            }
        });
        if (!editorWindow) form->field.CopyingToClipboard([weak, generation](auto const &sender, auto const &args) {
            if (auto self = weak.lock(); self && self->latest == generation && self->committed == generation && self->form) {
                const auto value = sender.SelectedText();
                if (!value.empty()) { args.Handled(true); self->CopyOcr(value, false); }
            }
        });
        form->primary.Click([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->latest == generation && self->committed == generation && self->form) {
                if (self->editorWindow) self->SaveEditor();
                else self->CopyOcr(self->form->field.Text(), true);
            }
        });
        form->cancel.Click([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->latest == generation) self->CloseForm();
        });
        UpdateFormActions();
        return content;
    }

    void UpdateOcr(JsonObject const &data) {
        form->statusKey = data.GetNamedString(L"loadError", L"");
        if (data.HasKey(L"record")) {
            const auto record = data.GetNamedObject(L"record");
            const auto status = record.GetNamedString(L"status");
            if (status == L"pending" || status == L"running") form->statusKey = L"recognizing";
            else if (record.HasKey(L"error") && record.GetNamedValue(L"error").ValueType() == JsonValueType::String)
                form->statusKey = record.GetNamedString(L"error");
            else if (status == L"empty") form->statusKey = L"empty";
            // A poll may arrive before WinUI delivers the field's TextChanged event.
            const auto current = form->field.Text();
            if (NormalizedLines(current) != form->original) form->edited = true;
            if (!form->edited && current != record.GetNamedString(L"text")) {
                form->initializing = true;
                form->field.Text(record.GetNamedString(L"text"));
                form->original = NormalizedLines(form->field.Text());
                form->initializing = false;
            }
            if (!form->hasRecord) {
                form->hasRecord = true;
                form->field.Visibility(Visibility::Visible);
                if (GetForegroundWindow() == window) FocusContent();
            }
        }
        ApplyFormStatus(); UpdateFormActions();
    }

    void OcrImageReady(bool failed) {
        form->imageProgress.IsActive(false);
        form->imageProgress.Visibility(Visibility::Collapsed);
        form->imageMissing = failed;
        form->imageMessage.Text(Message(L"image_missing"));
        form->imageMessage.Visibility(failed ? Visibility::Visible : Visibility::Collapsed);
    }

    void SetOcrImage(JsonObject const &data, std::uint64_t generation) {
        const auto path = data.GetNamedString(L"path");
        if (path.empty()) { OcrImageReady(true); return; }
        const auto weak = weak_from_this();
        form->image.ImageOpened([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->committed == generation && self->form) self->OcrImageReady(false);
        });
        form->image.ImageFailed([weak, generation](auto const &, auto const &) {
            if (auto self = weak.lock(); self && self->committed == generation && self->form) self->OcrImageReady(true);
        });
        try {
            Imaging::BitmapImage bitmap;
            bitmap.DecodePixelWidth(std::max<LONG>(1, (target.right - target.left) * 2 / 5));
            bitmap.UriSource(LocalAssetUri(path));
            form->image.Source(bitmap);
        } catch (winrt::hresult_error const &) { OcrImageReady(true); }
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
        form.reset();
        if (kind == L"ocr" || kind == L"editor") {
            pin.IsChecked(false);
            pending = BuildForm(data, generation);
            Commit(generation);
            return;
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
            const auto assetPath = data.GetNamedString(L"imagePath");
            const auto weak = weak_from_this();
            if (IsSvgImagePath(assetPath)) {
                try {
                    Imaging::SvgImageSource svg;
                    const double targetSide = std::clamp<double>(
                        static_cast<double>(std::max<LONG>(width, height)), 64.0, 2048.0);
                    svg.RasterizePixelWidth(targetSide);
                    svg.RasterizePixelHeight(targetSide);
                    svg.Opened([weak, generation, natural, fit, weakStage = winrt::make_weak(stage)](auto const &, auto const &) {
                        if (const auto area = weakStage.get()) {
                            if (natural->Width <= 0 || natural->Height <= 0) *natural = {256.0f, 256.0f};
                            fit(area);
                        }
                        if (auto self = weak.lock()) self->Commit(generation);
                    });
                    svg.OpenFailed([weak, generation](auto const &, auto const &) {
                        if (auto self = weak.lock()) self->ImageError(generation);
                    });
                    svg.UriSource(LocalAssetUri(assetPath));
                    image.Source(svg); loadTimeout.Start();
                } catch (winrt::hresult_error const &) { ImageError(generation); }
                return;
            }
            image.ImageOpened([weak, generation, natural, fit, weakStage = winrt::make_weak(stage)](auto const &sender, auto const &) {
                if (const auto area = weakStage.get()) {
                    if (const auto bitmap = sender.as<Image>().Source().try_as<Imaging::BitmapImage>()) {
                        if (natural->Width <= 0 || natural->Height <= 0)
                            *natural = {static_cast<float>(bitmap.PixelWidth()), static_cast<float>(bitmap.PixelHeight())};
                    }
                    fit(area);
                }
                if (auto self = weak.lock()) self->Commit(generation);
            });
            image.ImageFailed([weak, generation](auto const &, auto const &) { if (auto self = weak.lock()) self->ImageError(generation); });
            try {
                Imaging::BitmapImage bitmap;
                bitmap.DecodePixelWidth(ComputeBoundedDecodePixelWidth(
                    static_cast<LONG>(std::lround(natural->Width)),
                    static_cast<LONG>(std::lround(natural->Height)),
                    width));
                bitmap.UriSource(LocalAssetUri(assetPath));
                image.Source(bitmap); loadTimeout.Start();
            } catch (winrt::hresult_error const &) { ImageError(generation); }
            return;
        }
        if (kind == L"color") {
            const auto color = data.GetNamedObject(L"color");
            ApplyStyle(content, L"VPaste.AuxiliaryReadingSurface");
            content.BorderThickness(UniformThickness(0));
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
            // Match the rich WebView's document insets without changing the
            // outer window geometry or reducing the image/file canvas.
            textContent.Padding(Thickness{24, 22, 24, 22});
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
        if (operation == L"nativeOcrCopy" || operation == L"nativeEditorSave") {
            FormActionResult(operation, response);
            return;
        }
        if (operation == L"nativeReaderFocus" || operation == L"nativeEditorRaise") {
            if (operation == L"nativeEditorRaise" &&
                response.GetNamedObject(L"data").GetNamedNumber(L"generation") != static_cast<double>(committed)) return;
            if (window && IsWindowVisible(window)) { SetForegroundWindow(window); FocusContent(); }
            return;
        }
        const auto data = response.GetNamedObject(L"data");
        const auto generation = static_cast<std::uint64_t>(data.GetNamedNumber(L"generation"));
        if (operation == L"nativeReaderBegin") Begin(generation);
        else if (operation == L"nativeReaderHide") Hide(generation);
        else if (operation == L"nativeReader" || operation == L"nativeEditorOpen") Show(data);
        else if (generation == committed && generation == latest && form) {
            if (operation == L"nativeOcrState") UpdateOcr(data);
            else if (operation == L"nativeOcrImage") SetOcrImage(data, generation);
        }
    }
};

Reader::Reader(Request request, HWND owner, bool editor) : impl_(std::make_shared<Impl>(std::move(request), owner, editor)) {}
Reader::~Reader() = default;
void Reader::Receive(JsonObject const &response) { impl_->Receive(response); }
void Reader::SetAppearance(bool english, ElementTheme theme) {
    impl_->english = english; impl_->theme = theme; impl_->ApplyAppearance();
}
std::uint64_t Reader::Generation() const noexcept { return impl_->committed; }
std::uintptr_t ReaderWindowHandle() noexcept {
    return reinterpret_cast<std::uintptr_t>(publishedWindow.load(std::memory_order_acquire));
}
LONG ComputeBoundedDecodePixelWidth(LONG naturalWidth, LONG naturalHeight, LONG targetWidth) noexcept {
    constexpr LONG kMaxD3DTextureEdge = 16384;
    LONG desired = std::clamp<LONG>(targetWidth, 1, kMaxD3DTextureEdge);
    if (naturalWidth > 0) {
        // 小图/图标不放大，避免双线性糊化和不必要的显存开销。
        desired = std::min<LONG>(desired, naturalWidth);
    }
    if (naturalWidth > 0 && naturalHeight > 0) {
        // 细长图片若按目标宽解码会导致高度突破 Direct3D 16384 纹理上限，按高度等比限幅。
        const auto projectedHeight = (static_cast<std::int64_t>(desired) * naturalHeight) / naturalWidth;
        if (projectedHeight > kMaxD3DTextureEdge) {
            desired = static_cast<LONG>((static_cast<std::int64_t>(kMaxD3DTextureEdge) * naturalWidth) / naturalHeight);
        }
    }
    return std::max<LONG>(1, desired);
}
bool IsSvgImagePath(std::wstring_view path) noexcept {
    const auto queryPos = path.find_first_of(L"?#");
    const auto clean = queryPos == std::wstring_view::npos ? path : path.substr(0, queryPos);
    auto endsWithInsensitive = [&](std::wstring_view suffix) {
        if (clean.size() < suffix.size()) return false;
        const auto tail = clean.substr(clean.size() - suffix.size());
        return _wcsnicmp(tail.data(), suffix.data(), suffix.size()) == 0;
    };
    return endsWithInsensitive(L".svg") || endsWithInsensitive(L".svgz");
}
#ifdef _DEBUG
FrameworkElement Reader::TestRoot() const { return impl_->root; }

winrt::Windows::Foundation::IAsyncAction TestBatch2ReaderControls(std::vector<std::string> &failures) {
    // 验证图片解码宽度的防放大与 D3D 16384px 安全限制。
    if (ComputeBoundedDecodePixelWidth(32, 32, 600) > 32) {
        failures.push_back("reader_upscaled_small_icon");
    }
    const auto longDecode = ComputeBoundedDecodePixelWidth(200, 8000, 600);
    if ((static_cast<std::int64_t>(longDecode) * 8000) / 200 > 16384) {
        failures.push_back("reader_tall_image_exceeds_texture_limit");
    }
    if (!IsSvgImagePath(L"C:\\icons\\vector.SVG?v=2") || IsSvgImagePath(L"C:\\icons\\raster.png")) {
        failures.push_back("reader_svg_path_detection");
    }

    // 写入临时合法 SVG 并通过 Reader 加载，验证不会因仅使用 BitmapImage 而触发“暂时无法预览此内容”。
    wchar_t tempDir[MAX_PATH]{};
    GetTempPathW(MAX_PATH, tempDir);
    const std::wstring svgPath = std::wstring{tempDir} + L"vpaste_batch2_reader_test.svg";
    const char svgBytes[] = R"(<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0078d4"/></svg>)";
    if (const auto handle = CreateFileW(svgPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        handle != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(handle, svgBytes, sizeof(svgBytes) - 1, &written, nullptr);
        CloseHandle(handle);
    }

    Reader reader([](auto const &, auto, auto const &) -> std::uint64_t { return 1; });
    auto openSvg = JsonObject::Parse(LR"({"op":"nativeReader","data":{"generation":1,"kind":"image","imageWidth":64,"imageHeight":64,"rect":{"x":120,"y":120,"width":400,"height":320},"durationMs":0,"easing":[0.22,1,0.36,1]}})");
    openSvg.GetNamedObject(L"data").Insert(L"imagePath", JsonValue::CreateStringValue(svgPath));
    reader.Receive(openSvg);
    for (int frame = 0; frame < 30 && reader.Generation() == 0; ++frame) co_await NextNativeFrame();

    const auto state = reader.impl_;
    bool svgLoaded = false;
    if (state->displayed) {
        if (const auto stageGrid = state->displayed.try_as<Grid>()) {
            // 寻找内层 Image 并确认源为 SvgImageSource 而非 ImageError 退化文本。
            for (auto const &child : stageGrid.Children()) {
                if (const auto innerStage = child.try_as<Grid>(); innerStage && innerStage.Children().Size() > 0) {
                    if (const auto frame = innerStage.Children().GetAt(0).try_as<Grid>(); frame && frame.Children().Size() > 0) {
                        for (auto const &item : frame.Children()) {
                            if (const auto img = item.try_as<Image>(); img && img.Source().try_as<Imaging::SvgImageSource>()) {
                                svgLoaded = true;
                            }
                        }
                    }
                }
            }
        }
    }
    if (!svgLoaded) {
        failures.push_back("reader_svg_preview_failed");
    }

    // 验证 SetAppearance(Dark <-> Light) 后无需等待下一个布局帧就能同步刷新 DWM 暗色标题栏标志。
    reader.SetAppearance(false, ElementTheme::Dark);
    co_await NextNativeFrame();
    reader.SetAppearance(false, ElementTheme::Light);
    BOOL lightModeDarkAttr = TRUE;
    if (!state->window || FAILED(DwmGetWindowAttribute(state->window, DWMWA_USE_IMMERSIVE_DARK_MODE, &lightModeDarkAttr, sizeof(lightModeDarkAttr))) || lightModeDarkAttr) {
        failures.push_back("reader_theme_dwm_sync_stale_to_light");
    }
    reader.SetAppearance(false, ElementTheme::Dark);
    BOOL darkAttr = FALSE;
    if (!state->window || FAILED(DwmGetWindowAttribute(state->window, DWMWA_USE_IMMERSIVE_DARK_MODE, &darkAttr, sizeof(darkAttr))) || !darkAttr) {
        failures.push_back("reader_theme_dwm_sync_stale");
    }
    DeleteFileW(svgPath.c_str());
}

winrt::Windows::Foundation::IAsyncAction TestReaderControls(std::uint32_t &stage) {
    using namespace Automation;
    std::vector<std::pair<std::wstring, std::uint64_t>> events;
    winrt::hstring sentText;
    std::size_t writeRequest = 0;
    auto request = [&](auto const &operation, auto generation, auto const &document) {
        events.emplace_back(operation, generation);
        if (operation == L"nativeEditorSave" || operation == L"nativeOcrCopy") {
            sentText = document; writeRequest = events.size();
        }
        return events.size();
    };
    Reader reader(request);
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
    const auto caption = state->root.Children().GetAt(0).try_as<Grid>();
    winrt::check_hresult(caption && caption.BorderThickness().Bottom == 1 && caption.BorderBrush() ? S_OK : E_FAIL);
    stage = 11811;
    state->root.UpdateLayout();
    const auto textScroll = state->displayed.as<Grid>().Children().GetAt(0).as<ScrollViewer>();
    const auto inset = textScroll.Content().as<StackPanel>().Children().GetAt(0).as<TextBlock>()
        .TransformToVisual(textScroll).TransformPoint({0, 0});
    const auto belowCaption = [&](FrameworkElement const &element, FrameworkElement const &root, double gap) {
        const auto top = element.TransformToVisual(root).TransformPoint({0, 0}).Y;
        const auto header = root.as<Grid>().Children().GetAt(0).as<Grid>();
        return std::abs(top - header.ActualHeight() - gap) < 1;
    };
    winrt::check_hresult(belowCaption(state->body, state->root, 8) &&
        inset.X >= 23 && inset.Y >= 21 ? S_OK : E_FAIL);
    const auto toolbarKey = [&](unsigned value, FrameworkElement const &origin) {
        // Route through the same reader handler as root.PreviewKeyDown. A
        // glyph origin must retain the containing native button's ownership.
        return state->HandleKey(value, false, false, false, false, false, origin);
    };
    const auto pinGlyph = state->pin.Content().as<FontIcon>();
    winrt::check_hresult(state->root.Children().Size() == 2 && state->formTitle.Text() == state->Text(L"预览", L"Preview") &&
        state->windowClose.Visibility() == Visibility::Collapsed && state->body.Background() &&
        state->captionIcon.Visibility() == Visibility::Collapsed &&
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
    DWORD systemBackdrop{};
    const bool contrast = HighContrastEnabled();
    const bool supported = SUCCEEDED(DwmGetWindowAttribute(handle, ReaderBackdropAttribute, &systemBackdrop, sizeof(systemBackdrop))) &&
        winrt::Microsoft::UI::Composition::SystemBackdrops::DesktopAcrylicController::IsSupported();
    winrt::check_hresult(systemBackdrop == 0 && (supported && !contrast
            ? dark.A == 0 && light.A == 0 && state->source.SystemBackdrop().try_as<DesktopAcrylicBackdrop>()
            : dark.A == 255 && light.A == 255 && (contrast || dark.R < light.R)) ? S_OK : E_FAIL);
    if (state->systemCorners) {
        RECT frame{}; POINT origin{};
        winrt::check_bool(GetWindowRect(handle, &frame) && ClientToScreen(handle, &origin));
        winrt::check_hresult(origin.x == frame.left + 1 && origin.y == frame.top + 1 ? S_OK : E_FAIL);
    }
    winrt::check_hresult(state->body.Background() && state->body.BorderThickness() == UniformThickness(1) &&
        state->body.CornerRadius() == UniformRadius(12) && state->root.Padding() == UniformThickness(0) ? S_OK : E_FAIL);
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
    filesData.Insert(L"file", JsonObject::Parse(LR"({"path":".../documents/report.zip","label":"2 个文件","multiple":true,"light":{"name":"zip-light","asset":"zip"},"dark":{"name":"zip-dark","asset":"zip"}})"));
    reader.Receive(files); co_await NextNativeFrame();
    state->root.UpdateLayout();
    const auto fileInfo = state->displayed.as<Grid>().Children().GetAt(0).as<ScrollViewer>().Content().as<StackPanel>();
    const auto fileIcon = fileInfo.Children().GetAt(0).as<Grid>();
    winrt::check_hresult(fileInfo.Children().Size() == 5 &&
        fileIcon.Width() == 104 && belowCaption(state->body, state->root, 8) &&
        fileInfo.Children().GetAt(1).as<TextBlock>().Text() == L"report.zip" &&
        fileInfo.Children().GetAt(2).as<TextBlock>().Text() == L".../documents/report.zip" &&
        fileInfo.Children().GetAt(3).as<TextBlock>().Text() == L"共 2 个文件，暂不支持批量文件预览" &&
        fileInfo.Children().GetAt(4).as<TextBlock>().Text() == L"源文件不存在或已移动" ? S_OK : E_FAIL);
    stage = 1201;
    const auto awaitFileTheme = [&](ElementTheme theme, wchar_t const *icon) -> winrt::Windows::Foundation::IAsyncAction {
        reader.SetAppearance(false, theme);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        const auto ready = [&] {
            return fileIcon.IsLoaded() && fileIcon.ActualTheme() == theme &&
                winrt::unbox_value<winrt::hstring>(fileIcon.Tag()) == icon;
        };
        while (!ready() && std::chrono::steady_clock::now() < deadline) co_await NextNativeFrame();
        if (!ready()) std::fprintf(stderr, "WinUI reader file theme: target=%d actual=%d tag=%ls loaded=%d\n",
            static_cast<int>(theme), static_cast<int>(fileIcon.ActualTheme()),
            winrt::unbox_value<winrt::hstring>(fileIcon.Tag()).c_str(), fileIcon.IsLoaded());
        winrt::check_hresult(ready() ? S_OK : E_FAIL);
    };
    co_await awaitFileTheme(ElementTheme::Dark, L"zip-dark");
    co_await awaitFileTheme(ElementTheme::Light, L"zip-light");
    stage = 1202;
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
    winrt::check_hresult(belowCaption(state->body, state->root, 8) &&
        imageFrame.Width() == 2 && imageFrame.Height() == 2 &&
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

    stage = 1245;
    winrt::Windows::Storage::StorageFolder formArtifacts{nullptr};
    wchar_t artifactPath[MAX_PATH]{};
    const auto pathLength = GetEnvironmentVariableW(L"VPASTE_WINUI_AUXILIARY_ARTIFACT_DIR", artifactPath, MAX_PATH);
    if (pathLength > 0 && pathLength < MAX_PATH)
        formArtifacts = co_await winrt::Windows::Storage::StorageFolder::GetFolderFromPathAsync(artifactPath);
    auto ocr = text(205, L"");
    ocr.GetNamedObject(L"data").Insert(L"kind", JsonValue::CreateStringValue(L"ocr"));
    reader.Receive(ocr);
    co_await NextNativeFrame();
    winrt::check_hresult(state->window == handle && state->form && state->form->work.IsActive() &&
        !state->body.Background() && state->windowClose.Visibility() == Visibility::Visible &&
        state->captionIcon.Visibility() == Visibility::Visible && state->captionIcon.as<PathIcon>().Data() &&
        !state->pin.IsChecked().Value() ? S_OK : E_FAIL);
    reader.Receive(JsonObject::Parse(LR"({"op":"nativeOcrState","data":{"generation":205,"record":{"status":"running","text":"","error":null}}})"));
    auto field = state->form->field;
    winrt::check_hresult(field.Visibility() == Visibility::Visible && !state->HandleKey(VK_LEFT, false, false, false, false, false, field) &&
        !state->HandleKey(VK_SPACE, false, false, false, false, false, field) ? S_OK : E_FAIL);
    reader.Receive(JsonObject::Parse(LR"({"op":"nativeOcrState","data":{"generation":205,"record":{"status":"complete","text":"原始结果","error":null}}})"));
    co_await NextNativeFrame();
    winrt::check_hresult(field.Text() == L"原始结果" ? S_OK : E_FAIL);
    auto originalImage = message(L"nativeOcrImage", 205);
    originalImage.GetNamedObject(L"data").Insert(L"path", JsonValue::CreateStringValue(fixture.path));
    reader.Receive(originalImage);
    stage = 12451;
    for (int frame = 0; frame < 60 && state->form->imageProgress.IsActive(); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(!state->form->imageProgress.IsActive() && !state->form->imageMissing ? S_OK : E_FAIL);
    const auto alignedOcrPanes = [&] {
        state->root.UpdateLayout();
        const auto picture = VisualTreeHelper::GetParent(state->form->image);
        const auto imagePane = VisualTreeHelper::GetParent(picture).as<FrameworkElement>();
        const auto imageTop = imagePane.TransformToVisual(state->root).TransformPoint({0, 0}).Y;
        const auto resultTop = field.TransformToVisual(state->root).TransformPoint({0, 0}).Y;
        const auto imageTitle = state->form->imageTitle;
        const auto resultTitle = state->form->resultTitle;
        return belowCaption(imageTitle, state->root, 12) && belowCaption(resultTitle, state->root, 12) &&
            imageTitle.FontSize() >= 13 && resultTitle.FontSize() == imageTitle.FontSize() &&
            !field.Header() && imagePane.ActualHeight() > 0 &&
            std::abs(imageTop - resultTop) < 1 && std::abs(imagePane.ActualHeight() - field.ActualHeight()) < 1;
    };
    winrt::check_hresult(alignedOcrPanes() ? S_OK : E_FAIL);
    const auto captionMovesWithoutModalTracking = [](auto const &reader) {
        RECT before{}, after{};
        POINT cursor{};
        winrt::check_bool(GetWindowRect(reader->window, &before) && ClientToScreen(reader->window, &cursor));
        reader->captionGrab = {0, 0};
        reader->captionPointer = 1;
        reader->MoveCaption(cursor);
        const bool stayed = !reader->captionMoved;
        reader->MoveCaption({cursor.x + 50, cursor.y + 20});
        winrt::check_bool(GetWindowRect(reader->window, &after));
        OffsetRect(&before, 50, 20);
        const bool moved = reader->captionMoved && EqualRect(&before, &after) && EqualRect(&after, &reader->target);
        reader->EndCaptionDrag();
        return stayed && moved && !reader->captionPointer && !reader->captionMoved;
    };
    stage = 12451;
    winrt::check_hresult(captionMovesWithoutModalTracking(state) ? S_OK : E_FAIL);
    if (formArtifacts) {
        const auto previous = state->theme;
        reader.SetAppearance(state->english, ElementTheme::Light);
        co_await CaptureNativeView(state->root, formArtifacts, L"ocr-light.png");
        reader.SetAppearance(state->english, ElementTheme::Dark);
        co_await CaptureNativeView(state->root, formArtifacts, L"ocr-dark.png");
        reader.SetAppearance(state->english, previous);
    }
    stage = 12452;
    field.Text(L"改过的文本");
    // Deliver a poll without allowing a queued TextChanged event to run first.
    reader.Receive(JsonObject::Parse(LR"({"op":"nativeOcrState","data":{"generation":205,"record":{"status":"complete","text":"晚到的识别结果","error":null}}})"));
    winrt::check_hresult(field.Text() == L"改过的文本" && state->form->edited && !state->form->work.IsActive() ? S_OK : E_FAIL);
    stage = 1246;
    Peers::ButtonAutomationPeer(state->form->primary).GetPattern(Peers::PatternInterface::Invoke).as<Provider::IInvokeProvider>().Invoke();
    co_await NextNativeFrame();
    winrt::check_hresult(writeRequest && events.at(writeRequest - 1) == std::pair<std::wstring, std::uint64_t>{L"nativeOcrCopy", 205} &&
        sentText == L"改过的文本" && !state->form->primary.IsEnabled() ? S_OK : E_FAIL);
    auto reply = JsonObject::Parse(LR"({"op":"nativeOcrCopy","error":"copy failed"})");
    reply.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(writeRequest)));
    reader.Receive(reply);
    winrt::check_hresult(state->form->copyError.IsOpen() && state->form->primary.IsEnabled() ? S_OK : E_FAIL);
    co_await NextNativeFrame();
    winrt::check_hresult(alignedOcrPanes() ? S_OK : E_FAIL);
    reader.Receive(message(L"nativeReaderHide", 206));
    reader.Receive(JsonObject::Parse(LR"({"op":"nativeOcrState","data":{"generation":205,"record":{"status":"complete","text":"after close","error":null}}})"));
    winrt::check_hresult(!state->form && !IsWindowVisible(handle) ? S_OK : E_FAIL);

    stage = 1247;
    {
        Reader editor(request, nullptr, true);
        auto open = text(12, L"原始文本");
        open.Insert(L"op", JsonValue::CreateStringValue(L"nativeEditorOpen"));
        open.GetNamedObject(L"data").Insert(L"kind", JsonValue::CreateStringValue(L"editor"));
        editor.Receive(open);
        co_await NextNativeFrame();
        const auto edit = editor.impl_;
        const auto footer = edit->displayed.as<Grid>().Children().GetAt(1).as<Border>();
        const auto accent = Application::Current().Resources().Lookup(winrt::box_value(L"AccentButtonStyle"));
        winrt::check_hresult(!edit->body.Background() && edit->formTitle.Text() == L"编辑文本" &&
            belowCaption(edit->form->resultTitle, edit->root, 12) &&
            edit->form->resultTitle.Text() == L"文字内容" &&
            edit->form->field.TransformToVisual(edit->form->resultTitle).TransformPoint({0, 0}).Y >=
                edit->form->resultTitle.ActualHeight() + 7 &&
            edit->captionIcon.Visibility() == Visibility::Visible && edit->captionIcon.try_as<FontIcon>() &&
            edit->windowClose.Visibility() == Visibility::Visible && footer.BorderThickness().Top == 1 &&
            edit->form->primary.Style() == accent &&
            edit->form->cancel.ReadLocalValue(FrameworkElement::StyleProperty()) == DependencyProperty::UnsetValue() &&
            edit->form->primary.ReadLocalValue(Control::CornerRadiusProperty()) == DependencyProperty::UnsetValue() &&
            edit->form->cancel.ReadLocalValue(Control::PaddingProperty()) == DependencyProperty::UnsetValue() &&
            edit->form->primary.MinHeight() == AuxiliaryActionHeight &&
            edit->form->primary.ActualWidth() > 0 ? S_OK : E_FAIL);
        if (formArtifacts) {
            editor.SetAppearance(false, ElementTheme::Light);
            co_await CaptureNativeView(edit->root, formArtifacts, L"edit-light.png");
            editor.SetAppearance(false, ElementTheme::Dark);
            co_await CaptureNativeView(edit->root, formArtifacts, L"edit-dark.png");
        }
        winrt::check_hresult(editor.Generation() == 12 && edit->window != handle &&
            ReaderWindowHandle() == reinterpret_cast<std::uintptr_t>(handle) &&
            !edit->form->primary.IsEnabled() && edit->form->field.Text() == L"原始文本" ? S_OK : E_FAIL);
        stage = 12470;
        winrt::check_hresult(captionMovesWithoutModalTracking(edit) ? S_OK : E_FAIL);
        stage = 12471;
        auto draft = edit->form->field;
        draft.Text(L"新文本\r\n第二行");
        for (int frame = 0; frame < 15 && !edit->form->primary.IsEnabled(); ++frame) co_await NextNativeFrame();
        winrt::check_hresult(edit->form->primary.IsEnabled() ? S_OK : E_FAIL);
        stage = 12472;
        edit->CloseForm();
        co_await NextNativeFrame();
        winrt::check_hresult(edit->form->discard ? S_OK : E_FAIL);
        edit->form->discard.Hide();
        for (int frame = 0; frame < 30 && edit->form->discard; ++frame) co_await NextNativeFrame();
        winrt::check_hresult(!edit->form->discard && NormalizedLines(draft.Text()) == L"新文本\n第二行" ? S_OK : E_FAIL);
        stage = 12473;
        Peers::ButtonAutomationPeer(edit->form->primary).GetPattern(Peers::PatternInterface::Invoke).as<Provider::IInvokeProvider>().Invoke();
        co_await NextNativeFrame();
        winrt::check_hresult(writeRequest && events.at(writeRequest - 1) == std::pair<std::wstring, std::uint64_t>{L"nativeEditorSave", 12} &&
            sentText == L"新文本\n第二行" && draft.IsReadOnly() ? S_OK : E_FAIL);
        stage = 12474;
        auto error = JsonObject::Parse(LR"({"op":"nativeEditorSave","error":"editor.changed"})");
        error.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(writeRequest)));
        editor.Receive(error);
        winrt::check_hresult(edit->form->status.IsOpen() && !draft.IsReadOnly() &&
            NormalizedLines(draft.Text()) == L"新文本\n第二行" ? S_OK : E_FAIL);
    }
    stage = 12475;
    winrt::check_hresult(ReaderWindowHandle() == reinterpret_cast<std::uintptr_t>(handle) ? S_OK : E_FAIL);
}
#endif
}
