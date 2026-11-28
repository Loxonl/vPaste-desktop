#include <windows.h>
#undef GetCurrentTime
#undef GetClassName
#include "WinUiOnboarding.h"
#include "WinUiAppearance.h"
#include "WinUiMotion.h"
#include <algorithm>
#include <array>
#include <optional>
#include <string_view>
#include <utility>
#include <winrt/Microsoft.UI.Text.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.Storage.Streams.h>

namespace vpaste::winui {
namespace {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Microsoft::UI::Xaml::Media;
using namespace winrt::Windows::Data::Json;
using winrt::Microsoft::UI::Xaml::Automation::AutomationProperties;
using winrt::Microsoft::UI::Text::FontWeights;
using Seconds = std::chrono::duration<double>;
using TimeSpan = winrt::Windows::Foundation::TimeSpan;
enum class Step { Welcome, Permissions, Filters, Shortcut };
constexpr Seconds WelcomeHold{0.9};
// Match TutorialOverlay.module.css in the actual in-panel viewport.
constexpr double CompactGuideWidth = 900, WideGuideWidth = 1080, NarrowGuideWidth = 560;

bool GuideAnimationsEnabled() {
#ifdef _DEBUG
    // Run the same view on an isolated desktop without changing system policy.
    if (GetEnvironmentVariableW(L"VPASTE_WINUI_TEST_GUIDE_REDUCE_MOTION", nullptr, 0)) return false;
#endif
    return NativeAnimationsEnabled() && !HighContrastEnabled();
}

RowDefinition AutoRow() {
    RowDefinition row; row.Height(GridLength{1, GridUnitType::Auto}); return row;
}

TextBlock Label(winrt::hstring const &text, double size, bool muted = false) {
    TextBlock label;
    ApplyStyle(label, muted ? L"VPaste.GuideMuted" : L"VPaste.GuideText");
    label.Text(text); label.FontSize(size);
    return label;
}

std::string_view ResourceBytes(wchar_t const *name) {
    const auto module = GetModuleHandleW(L"VPasteWinUiPanel.dll");
    const auto resource = FindResourceW(module, name, RT_RCDATA);
    winrt::check_bool(resource != nullptr);
    const auto bytes = static_cast<char const *>(LockResource(LoadResource(module, resource)));
    winrt::check_bool(bytes != nullptr);
    return {bytes, SizeofResource(module, resource)};
}

void InstallGuideStyles() {
    auto resources = Application::Current().Resources();
    if (!resources.TryLookup(winrt::box_value(L"VPaste.GuideText")))
        resources.MergedDictionaries().Append(Markup::XamlReader::Load(
            winrt::to_hstring(ResourceBytes(L"VPASTE_TUTORIAL_STYLES"))).as<ResourceDictionary>());
}

template<typename ImageSource>
winrt::fire_and_forget LoadArtwork(ImageSource source, wchar_t const *name) {
    try {
        const auto artwork = ResourceBytes(name);
        const auto bytes = reinterpret_cast<std::uint8_t const *>(artwork.data());
        winrt::Windows::Storage::Streams::InMemoryRandomAccessStream stream;
        winrt::Windows::Storage::Streams::DataWriter writer{stream};
        writer.WriteBytes(winrt::array_view<std::uint8_t const>{bytes, bytes + artwork.size()});
        co_await writer.StoreAsync();
        writer.DetachStream(); stream.Seek(0);
        co_await source.SetSourceAsync(stream);
    } catch (winrt::hresult_error const &error) {
        OutputDebugStringW(error.message().c_str());
    }
}

Image Artwork(wchar_t const *name, double height, bool logo = false) {
    Image image; image.Height(height); image.Stretch(Stretch::Uniform);
    AutomationProperties::SetAccessibilityView(image, Automation::Peers::AccessibilityView::Raw);
    if (logo) {
        Imaging::BitmapImage bitmap; image.Source(bitmap); LoadArtwork(bitmap, name);
    } else {
        Imaging::SvgImageSource svg; image.Source(svg); LoadArtwork(svg, name);
    }
    return image;
}

void Animate(FrameworkElement const &element, float x, float y, Seconds duration,
             Seconds delay = Seconds{0}, bool outgoing = false, bool underline = false) {
    if (!GuideAnimationsEnabled()) return;
    // Loaded runs after the element joins the XAML tree and has a compositor.
    const auto play = [x, y, duration, delay, outgoing, underline](FrameworkElement const &target) {
        const auto compositor = CompositionTarget::GetCompositorForCurrentThread();
        const auto &timing = CachedMotionTiming();
        const auto &curve = outgoing ? timing.easingExit : timing.easingEnter;
        const auto easing = compositor.CreateCubicBezierEasingFunction({curve[0], curve[1]}, {curve[2], curve[3]});
        const auto configure = [duration, delay](auto const &animation, wchar_t const *property) {
            animation.Target(property);
            animation.Duration(std::chrono::duration_cast<TimeSpan>(duration));
            animation.DelayTime(std::chrono::duration_cast<TimeSpan>(delay));
            animation.DelayBehavior(winrt::Microsoft::UI::Composition::AnimationDelayBehavior::SetInitialValueBeforeDelay);
        };
        const auto fade = compositor.CreateScalarKeyFrameAnimation();
        configure(fade, L"Opacity"); fade.InsertKeyFrame(0, outgoing ? 1.f : 0.f);
        fade.InsertKeyFrame(1, outgoing ? 0.f : 1.f, easing);
        const auto move = compositor.CreateVector3KeyFrameAnimation();
        configure(move, underline ? L"Scale" : L"Translation");
        if (underline) {
            move.InsertKeyFrame(0, {0, 1, 1}); move.InsertKeyFrame(1, {1, 1, 1}, easing);
        } else {
            using winrt::Windows::Foundation::Numerics::float3;
            move.InsertKeyFrame(0, outgoing ? float3{0, 0, 0} : float3{x, y, 0});
            move.InsertKeyFrame(1, outgoing ? float3{x, y, 0} : float3{0, 0, 0}, easing);
        }
        target.StartAnimation(fade); target.StartAnimation(move);
    };
    if (element.IsLoaded()) play(element);
    else element.Loaded([play](auto const &sender, auto const &) { play(sender.as<FrameworkElement>()); });
}
}

struct OnboardingView::Impl : std::enable_shared_from_this<Impl> {
    Impl(JsonObject const &data, Request callback)
        : request(std::move(callback)), snapshot(data),
          session(static_cast<std::uint64_t>(data.GetNamedNumber(L"session"))),
          preview(data.GetNamedBoolean(L"preview")), mac(data.GetNamedBoolean(L"mac")),
          english(data.GetNamedBoolean(L"english")), ready(data.GetNamedBoolean(L"ready")) {}
    Request request;
    JsonObject snapshot;
    const std::uint64_t session;
    const bool preview, mac;
    bool english;
    bool ready, shown = false, leavingWelcome = false, finished = false, syncing = false;
    Step step = Step::Welcome;
    std::uint64_t latestRequest = 0;
    ContentControl root;
    Grid page{nullptr};
    Grid stage{nullptr};
    ScrollViewer scroller{nullptr};
    StackPanel welcome{nullptr}, side{nullptr};
    TextBlock welcomeTitle{nullptr}, welcomeSlogan{nullptr}, shortcutValue{nullptr};
    Border welcomeUnderline{nullptr};
    Button primary{nullptr};
    InfoBar info{nullptr};
    DispatcherTimer welcomeTimer{nullptr};
    struct FilterTile {
        ToggleSwitch control{nullptr};
        Border surface{nullptr};
    };
    std::array<FilterTile, 5> switches{};
    std::optional<bool> compactLayout;
    std::array<bool, 5> switchValues{};

    ~Impl() { if (welcomeTimer) welcomeTimer.Stop(); }

    winrt::hstring Text(wchar_t const *zh, wchar_t const *en) const { return english ? en : zh; }
    Seconds Duration(wchar_t const *name) const { return Seconds{CachedMotionTiming().DurationByName(name)}; }
    float Distance(wchar_t const *name) const { return CachedMotionTiming().DistanceByName(name); }

    std::uint64_t Send(wchar_t const *op, winrt::hstring const &filter = {}, bool enabled = false) {
        JsonObject payload;
        payload.Insert(L"session", JsonValue::CreateNumberValue(static_cast<double>(session)));
        if (!filter.empty()) payload.Insert(L"filter", JsonValue::CreateStringValue(filter));
        payload.Insert(L"enabled", JsonValue::CreateBooleanValue(enabled));
        return request(op, payload);
    }

    void Focus() {
        if (primary && !finished && primary.IsLoaded()) primary.Focus(FocusState::Programmatic);
        else if (!finished && root.IsLoaded()) root.Focus(FocusState::Programmatic);
    }

    void Go(Step next) {
        if (finished) return;
        step = next;
        (void)Send(L"tutorialDemo", {}, step == Step::Shortcut);
        Render();
        Focus();
    }

    bool Finish(bool cancelled) {
        if (finished || (cancelled && !preview)) return false;
        if (!Send(cancelled ? L"tutorialCancel" : L"tutorialFinish")) return false;
        finished = true;
        // Remove content before the dock is restored; no final illustration
        // can be painted between hiding the guide and restoring history focus.
        if (welcomeTimer) welcomeTimer.Stop();
        root.Content(nullptr);
        return true;
    }

    void StartWelcome() {
        if (!ready || !shown || step != Step::Welcome || welcomeTimer) return;
        welcomeTimer = DispatcherTimer();
        const auto entryDuration = std::max(Duration(L"slow"), Duration(L"standard") + Duration(L"quick"));
        welcomeTimer.Interval(std::chrono::duration_cast<TimeSpan>(WelcomeHold +
            (GuideAnimationsEnabled() ? entryDuration : Seconds{0})));
        welcomeTimer.Tick([weak = weak_from_this()](auto const &, auto const &) {
            const auto self = weak.lock();
            if (!self) return;
            self->welcomeTimer.Stop();
            if (self->finished || self->step != Step::Welcome) return;
            if (!self->leavingWelcome && GuideAnimationsEnabled()) {
                self->leavingWelcome = true;
                Animate(self->page, -self->Distance(L"emphasis"), 0, self->Duration(L"standard"), Seconds{0}, true);
                self->welcomeTimer.Interval(std::chrono::duration_cast<TimeSpan>(self->Duration(L"standard")));
                self->welcomeTimer.Start();
            } else self->Go(self->mac ? Step::Permissions : Step::Filters);
        });
        welcomeTimer.Start();
    }

    void UpdateControls() {
        const bool savedSyncing = std::exchange(syncing, true);
        const auto filters = snapshot.GetNamedArray(L"filters");
        for (std::uint32_t i = 0; i < switches.size() && i < filters.Size(); ++i) {
            if (switches[i].control) {
                switchValues[i] = filters.GetObjectAt(i).GetNamedBoolean(L"enabled");
                switches[i].control.IsOn(switchValues[i]);
                PaintFilterTile(i, switchValues[i]);
            }
        }
        syncing = savedSyncing;
        if (info) {
            const auto error = snapshot.GetNamedString(L"error", L"");
            info.Message(error); info.IsOpen(!error.empty());
        }
    }

    void Layout(double width) {
        if (!page || !scroller) return;
        const bool compact = width > 0 && width <= CompactGuideWidth;
        if (width > 0) {
            const auto margin = compact ? 16.0 : 17.0;
            page.Width(std::clamp(width - 2 * margin, 0.0, compact ? NarrowGuideWidth : WideGuideWidth));
        }
        if (shortcutValue) shortcutValue.FontSize(std::clamp(width * 0.05, 34.0, 52.0));
        if (compactLayout == compact) return;
        compactLayout = compact;
        scroller.VerticalContentAlignment(compact ? VerticalAlignment::Top : VerticalAlignment::Center);
        page.Margin(compact ? Thickness{16, 16, 16, 16} : Thickness{17, 7, 17, 7});
        if (!ready) return;
        if (step == Step::Welcome) {
            welcome.Orientation(compact ? Orientation::Vertical : Orientation::Horizontal);
            welcome.Spacing(compact ? 14 : 30);
            welcomeTitle.FontSize(compact ? 34 : 42);
            welcomeTitle.TextAlignment(compact ? TextAlignment::Center : TextAlignment::Left);
            welcomeSlogan.TextAlignment(welcomeTitle.TextAlignment());
            return;
        }

        page.ColumnDefinitions().Clear(); page.RowDefinitions().Clear();
        page.RowSpacing(compact ? 14 : 4);
        page.RowDefinitions().Append(AutoRow());
        if (compact) {
            page.RowDefinitions().Append(AutoRow()); page.RowDefinitions().Append(AutoRow());
            primary.ClearValue(FrameworkElement::WidthProperty());
        } else {
            ColumnDefinition lead, end;
            lead.Width(GridLength{190, GridUnitType::Pixel}); end.Width(GridLength{112, GridUnitType::Pixel});
            page.ColumnDefinitions().Append(lead); page.ColumnDefinitions().Append(ColumnDefinition{});
            page.ColumnDefinitions().Append(end);
            primary.Width(106);
        }
        page.RowDefinitions().Append(AutoRow());
        Grid::SetColumn(stage, compact ? 0 : 1); Grid::SetRow(stage, compact ? 1 : 0);
        Grid::SetColumn(primary, compact ? 0 : 2); Grid::SetRow(primary, compact ? 2 : 0);
        primary.HorizontalAlignment(compact ? HorizontalAlignment::Stretch : HorizontalAlignment::Right);
        Grid::SetColumnSpan(info, compact ? 1 : 3); Grid::SetRow(info, compact ? 3 : 1);

        stage.ColumnDefinitions().Clear(); stage.RowDefinitions().Clear();
        for (std::uint32_t i = 0; i < stage.Children().Size(); ++i) {
            const auto tile = stage.Children().GetAt(i).as<FrameworkElement>();
            Grid::SetRow(tile, compact ? static_cast<int>(i) : 0);
            Grid::SetColumn(tile, compact ? 0 : static_cast<int>(i));
            if (compact) stage.RowDefinitions().Append(AutoRow());
            else {
                ColumnDefinition column;
                if (step == Step::Shortcut) {
                    column.MinWidth(i == 0 ? 190 : 170);
                    column.Width(GridLength{i == 0 ? 1.0 : 0.82, GridUnitType::Star});
                }
                stage.ColumnDefinitions().Append(column);
            }
        }
    }

    void BuildWelcome() {
        welcome = StackPanel{}; welcome.Padding(Thickness{24, 18, 24, 18});
        welcome.HorizontalAlignment(HorizontalAlignment::Center);
        AutomationProperties::SetLiveSetting(welcome, Automation::Peers::AutomationLiveSetting::Polite);
        Grid orbit; orbit.Width(148); orbit.Height(148);
        const auto logo = Artwork(L"VPASTE_TUTORIAL_LOGO", 118, true); logo.Width(118);
        orbit.Children().Append(logo);
        welcome.Children().Append(orbit);
        StackPanel copy; copy.VerticalAlignment(VerticalAlignment::Center);
        welcomeTitle = Label(Text(L"欢迎使用 vPaste", L"Welcome to vPaste"), 42);
        welcomeTitle.FontWeight(FontWeights::Bold());
        AutomationProperties::SetHeadingLevel(welcomeTitle, Automation::Peers::AutomationHeadingLevel::Level1);
        welcomeSlogan = Label(Text(L"剪贴捷径，一键即达", L"Your clipboard, always one shortcut away"), 18, true);
        welcomeSlogan.Margin(Thickness{0, 12, 0, 0});
        welcomeUnderline = Border{}; ApplyStyle(welcomeUnderline, L"VPaste.GuideUnderline");
        welcomeUnderline.Width(86); welcomeUnderline.Height(4);
        welcomeUnderline.HorizontalAlignment(HorizontalAlignment::Left);
        welcomeUnderline.Margin(Thickness{0, 12, 0, 0});
        copy.Children().Append(welcomeTitle); copy.Children().Append(welcomeSlogan); copy.Children().Append(welcomeUnderline);
        welcome.Children().Append(copy); page.Children().Append(welcome);
        Animate(page, Distance(L"emphasis"), 0, Duration(L"slow"));
        Animate(logo, 0, Distance(L"standard"), Duration(L"standard"));
        Animate(welcomeTitle, 0, Distance(L"standard"), Duration(L"standard"));
        Animate(welcomeSlogan, 0, Distance(L"standard"), Duration(L"standard"), Duration(L"quick"));
        Animate(welcomeUnderline, 0, 0, Duration(L"standard"), Seconds{0}, false, true);
    }

    void BuildStep() {
        side = StackPanel{}; side.Spacing(7); side.VerticalAlignment(VerticalAlignment::Center);
        const bool filters = step == Step::Filters;
        const bool last = step == Step::Shortcut;
        const int index = last ? (mac ? 3 : 2) : filters ? (mac ? 2 : 1) : 1;
        Border badge; ApplyStyle(badge, L"VPaste.GuideIndex");
        badge.Width(42); badge.Height(24); badge.HorizontalAlignment(HorizontalAlignment::Left);
        auto number = Label(L"0" + winrt::to_hstring(index), 12, true);
        number.FontWeight(FontWeights::Bold()); number.HorizontalAlignment(HorizontalAlignment::Center);
        number.VerticalAlignment(VerticalAlignment::Center); badge.Child(number);
        side.Children().Append(badge);
        auto heading = Label(filters ? Text(L"添加筛选标签", L"Add filters") : last ?
            Text(L"记住默认快捷键", L"Keep the shortcut close") : Text(L"开启必要能力", L"Enable the essentials"), 20);
        heading.FontWeight(FontWeights::Bold());
        AutomationProperties::SetHeadingLevel(heading, Automation::Peers::AutomationHeadingLevel::Level1);
        side.Children().Append(heading);
        side.Children().Append(Label(filters ? Text(L"按类型快速查找复制内容", L"Quickly find copied content by type") : last ?
            Text(L"按一次呼出窗口，再按一次收起", L"Press once to summon vPaste, then again to tuck it away") :
            Text(L"建议现在开启这些能力；也可以先继续，之后在设置里补充",
                L"Enable these now for the best experience, or continue and finish them later in Settings"), 13, true));
        if (last || (mac && filters)) {
            Button previous; ApplyStyle(previous, L"VPaste.GuideNav");
            previous.Content(winrt::box_value(Text(L"上一步", L"Previous")));
            previous.MinWidth(76); previous.Margin(Thickness{0, 6, 0, 0});
            previous.Click([weak = weak_from_this()](auto const &, auto const &) {
                if (auto self = weak.lock()) self->Go(self->step == Step::Shortcut ? Step::Filters : Step::Permissions);
            });
            side.Children().Append(previous);
        }
        page.Children().Append(side);
        stage = filters ? FilterControls() : last ? ShortcutArt() : PermissionCards();
        stage.VerticalAlignment(VerticalAlignment::Center);
        page.Children().Append(stage);
        ErrorRow(1);
        AddNext(last ? Text(L"完成", L"Finish") : Text(L"下一步", L"Next"), 0, [last](Impl &self) {
            if (last) self.Finish(false);
            else self.Go(self.step == Step::Permissions ? Step::Filters : Step::Shortcut);
        });
        Animate(page, Distance(L"standard"), 0, Duration(L"slow"));
        Animate(side, -Distance(L"subtle"), 0, Duration(L"standard"));
        Animate(primary, Distance(L"subtle"), 0, Duration(L"standard"));
    }

    void Render() {
        page = Grid(); page.ColumnSpacing(14);
        page.HorizontalAlignment(HorizontalAlignment::Center);
        page.VerticalAlignment(VerticalAlignment::Center);
        compactLayout.reset(); switches.fill({});
        primary = nullptr; info = nullptr; stage = nullptr; side = nullptr;
        welcome = nullptr; welcomeTitle = nullptr; welcomeSlogan = nullptr; welcomeUnderline = nullptr; shortcutValue = nullptr;
        if (!ready) {
            page.RowDefinitions().Append(AutoRow()); page.RowDefinitions().Append(AutoRow());
            ErrorRow(0);
            AddNext(Text(L"重试", L"Retry"), 1, [](Impl &self) { self.latestRequest = self.Send(L"tutorialRetry"); });
        } else if (step == Step::Welcome) BuildWelcome();
        else BuildStep();
        scroller = ScrollViewer{};
        scroller.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
        scroller.HorizontalScrollMode(ScrollMode::Disabled);
        scroller.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
        scroller.HorizontalContentAlignment(HorizontalAlignment::Center);
        scroller.Content(page);
        Layout(root.ActualWidth());
        root.Content(scroller);
        UpdateControls();
        StartWelcome();
    }

    void ErrorRow(int row) {
        info = InfoBar(); info.IsClosable(false); info.Severity(InfoBarSeverity::Error);
        AutomationProperties::SetLiveSetting(info, Automation::Peers::AutomationLiveSetting::Polite);
        Grid::SetRow(info, row); page.Children().Append(info);
    }

    void AddNext(winrt::hstring const &label, int row, std::function<void(Impl &)> action) {
        const auto weak = weak_from_this();
        primary = Button(); primary.Content(winrt::box_value(label));
        ApplyStyle(primary, L"VPaste.GuidePrimary");
        primary.VerticalAlignment(VerticalAlignment::Center);
        AutomationProperties::SetAutomationId(primary, L"TutorialPrimaryAction");
        primary.Click([weak, action = std::move(action)](auto const &, auto const &) { if (auto self = weak.lock()) action(*self); });
        primary.Loaded([weak](auto const &sender, auto const &) {
            if (auto self = weak.lock(); self && self->primary == sender && self->shown) self->Focus();
        });
        Grid::SetRow(primary, row); page.Children().Append(primary);
    }

    Grid FilterControls() {
        Grid choices; choices.ColumnSpacing(10); choices.RowSpacing(10);
        const auto filters = snapshot.GetNamedArray(L"filters");
        const auto weak = weak_from_this();
        for (std::uint32_t i = 0; i < switches.size() && i < filters.Size(); ++i) {
            const auto item = filters.GetObjectAt(i);
            const auto id = item.GetNamedString(L"id");
            ToggleSwitch toggle;
            toggle.MinWidth(0);
            toggle.OnContent(winrt::box_value(L"")); toggle.OffContent(winrt::box_value(L""));
            toggle.HorizontalAlignment(HorizontalAlignment::Center);
            const auto name = item.GetNamedString(L"name");
            AutomationProperties::SetName(toggle, name);
            AutomationProperties::SetAutomationId(toggle, L"TutorialFilter-" + id);
            StackPanel face; face.VerticalAlignment(VerticalAlignment::Center);
            auto label = Label(name, 14); label.FontWeight(FontWeights::Bold()); label.TextAlignment(TextAlignment::Center);
            AutomationProperties::SetAccessibilityView(label, Automation::Peers::AccessibilityView::Raw);
            face.Children().Append(label);
            face.Children().Append(toggle);
            Border tile;
            tile.MinHeight(112); tile.Padding(Thickness{6, 8, 6, 8});
            tile.CornerRadius(UniformRadius(12)); tile.Child(face);
            switches[i] = {toggle, tile};
            toggle.Toggled([weak, id, i](auto const &sender, auto const &) {
                if (auto self = weak.lock(); self && !self->syncing && !self->finished &&
                    self->step == Step::Filters && self->switches[i].control == sender) {
                    const bool on = self->switches[i].control.IsOn();
                    self->PaintFilterTile(i, on);
                    if (std::exchange(self->switchValues[i], on) != on)
                        self->latestRequest = self->Send(L"tutorialToggle", id, on);
                }
            });
            tile.Tapped([weak, i](auto const &, Input::TappedRoutedEventArgs const &args) {
                const auto self = weak.lock();
                if (!self || self->finished || self->step != Step::Filters) return;
                const auto &current = self->switches[i];
                for (auto source = args.OriginalSource().try_as<DependencyObject>(); source;
                     source = VisualTreeHelper::GetParent(source)) {
                    if (source == current.control) return; // Native switch handles its own gesture.
                    if (source == current.surface) {
                        current.control.IsOn(!current.control.IsOn());
                        args.Handled(true);
                        return;
                    }
                }
            });
            choices.Children().Append(tile);
            Animate(tile, 0, Distance(L"standard"), Duration(L"standard"), Duration(L"quick") * i);
        }
        return choices;
    }

    void PaintFilterTile(std::uint32_t index, bool on) {
        ApplyStyle(switches[index].surface, on ? L"VPaste.GuideSelectedSection" : L"VPaste.GuideSection");
    }

    Grid PermissionCards() {
        Grid cards; cards.ColumnSpacing(12); cards.RowSpacing(12);
        const auto permissions = snapshot.GetNamedObject(L"permissions");
        for (int i = 0; i < 2; ++i) {
            const bool granted = permissions.GetNamedObject(i == 0 ? L"background" : L"paste").GetNamedBoolean(L"done");
            Grid content; content.RowSpacing(9);
            content.RowDefinitions().Append(AutoRow()); content.RowDefinitions().Append(RowDefinition{});
            Grid artwork;
            artwork.Children().Append(Artwork(i == 0 ? L"VPASTE_TUTORIAL_BACKGROUND" : L"VPASTE_TUTORIAL_PASTE", 92));
            auto brand = Artwork(L"VPASTE_TUTORIAL_LOGO", 22, true);
            brand.Width(22); brand.Margin(UniformThickness(9));
            brand.HorizontalAlignment(HorizontalAlignment::Left); brand.VerticalAlignment(VerticalAlignment::Bottom);
            artwork.Children().Append(brand);
            Border status;
            ApplyStyle(status, granted ? L"VPaste.GuideStatus" : L"VPaste.GuideIndex");
            status.Margin(UniformThickness(7)); status.Padding(Thickness{8, 3, 8, 3});
            status.HorizontalAlignment(HorizontalAlignment::Right); status.VerticalAlignment(VerticalAlignment::Top);
            auto state = Label(granted ? Text(L"✓ 已开启", L"✓ Enabled") : Text(L"待开启", L"Not yet"), 10);
            if (granted) ApplyStyle(state, L"VPaste.GuideStatusText");
            state.FontWeight(FontWeights::SemiBold()); status.Child(state);
            AutomationProperties::SetLiveSetting(state, Automation::Peers::AutomationLiveSetting::Polite);
            artwork.Children().Append(status);
            Border imageFrame; ApplyStyle(imageFrame, L"VPaste.GuideIndex");
            imageFrame.Height(92); imageFrame.Child(artwork); content.Children().Append(imageFrame);
            StackPanel row; row.Spacing(4); row.Padding(Thickness{3, 0, 3, 0});
            row.VerticalAlignment(VerticalAlignment::Center);
            auto title = Label(i == 0 ? Text(L"后台运行授权", L"Run in background") : Text(L"自动粘贴权限", L"Auto paste permission"), 14);
            title.FontWeight(FontWeights::Bold()); row.Children().Append(title);
            row.Children().Append(Label(i == 0 ? Text(L"允许 vPaste 在窗口关闭后继续监听剪贴板",
                L"Allow vPaste to monitor clipboard changes after its window is closed")
                : Text(L"允许 vPaste 粘贴到当前应用", L"Allow vPaste to paste into the active app"), 12, true));
            Grid::SetRow(row, 1); content.Children().Append(row);
            Border card;
            ApplyStyle(card, granted ? L"VPaste.GuideSelectedSection" : L"VPaste.GuideSection");
            card.CornerRadius(UniformRadius(16)); card.MinHeight(184); card.Padding(UniformThickness(9)); card.Child(content);
            cards.Children().Append(card);
            Animate(card, 0, Distance(L"standard"), Duration(L"slow"), Duration(L"quick") * i);
            Animate(status, 0, -Distance(L"subtle"), Duration(L"standard"), Duration(L"quick") * i);
        }
        return cards;
    }

    Grid ShortcutArt() {
        Grid composition; composition.ColumnSpacing(14); composition.RowSpacing(14);
        const auto art = Artwork(L"VPASTE_TUTORIAL_SHORTCUT", 162);
        composition.Children().Append(art);
        Grid incoming, emphasis;
        incoming.VerticalAlignment(VerticalAlignment::Center);
        incoming.Children().Append(emphasis);
        Border keycap; ApplyStyle(keycap, L"VPaste.GuideSection");
        keycap.Padding(Thickness{18, 20, 18, 20});
        StackPanel label; label.Spacing(8);
        auto title = Label(Text(L"默认快捷键", L"Default shortcut"), 12, true);
        title.TextAlignment(TextAlignment::Center); title.FontWeight(FontWeights::Bold());
        shortcutValue = Label(snapshot.GetNamedString(L"shortcut"), 52);
        shortcutValue.TextAlignment(TextAlignment::Center); shortcutValue.FontWeight(FontWeights::Bold());
        AutomationProperties::SetAutomationId(shortcutValue, L"TutorialShortcut");
        label.Children().Append(title); label.Children().Append(shortcutValue); keycap.Child(label);
        Border pulse; ApplyStyle(pulse, L"VPaste.GuidePulse"); pulse.Margin(UniformThickness(-6));
        pulse.Opacity(0); pulse.IsHitTestVisible(false);
        emphasis.Children().Append(pulse); emphasis.Children().Append(keycap);
        composition.Children().Append(incoming);
        Animate(art, -Distance(L"standard"), 0, Duration(L"slow"));
        Animate(incoming, Distance(L"standard"), 0, Duration(L"slow"));
        emphasis.Loaded([weak = weak_from_this(), ring = winrt::make_weak(pulse)](auto const &sender, auto const &) {
            if (!GuideAnimationsEnabled()) return;
            const auto self = weak.lock();
            const auto pulse = ring.get();
            if (!self || !pulse) return;
            const auto fast = self->Duration(L"fast"), slow = self->Duration(L"slow"), full = slow + fast;
            const auto cap = sender.as<FrameworkElement>();
            cap.CenterPoint({static_cast<float>(cap.ActualWidth() / 2), static_cast<float>(cap.ActualHeight() / 2), 0});
            pulse.CenterPoint({static_cast<float>(pulse.ActualWidth() / 2), static_cast<float>(pulse.ActualHeight() / 2), 0});
            const auto compositor = CompositionTarget::GetCompositorForCurrentThread();
            const auto configure = [slow](auto const &animation, wchar_t const *target, Seconds duration) {
                animation.Target(target); animation.Duration(std::chrono::duration_cast<TimeSpan>(duration));
                animation.DelayTime(std::chrono::duration_cast<TimeSpan>(slow * 2));
            };
            auto press = compositor.CreateVector3KeyFrameAnimation();
            configure(press, L"Scale", full);
            press.InsertKeyFrame(0, {1, 1, 1}); press.InsertKeyFrame(static_cast<float>(fast / full), {0.97f, 0.97f, 1});
            press.InsertKeyFrame(static_cast<float>(slow / full), {0.97f, 0.97f, 1}); press.InsertKeyFrame(1, {1, 1, 1});
            const auto distance = self->Distance(L"subtle");
            const auto down = compositor.CreateVector3KeyFrameAnimation();
            configure(down, L"Translation", full);
            down.InsertKeyFrame(0, {0, 0, 0}); down.InsertKeyFrame(static_cast<float>(fast / full), {0, distance, 0});
            down.InsertKeyFrame(static_cast<float>(slow / full), {0, distance, 0}); down.InsertKeyFrame(1, {0, 0, 0});
            const auto ringFade = compositor.CreateScalarKeyFrameAnimation();
            configure(ringFade, L"Opacity", slow);
            ringFade.InsertKeyFrame(0, 0); ringFade.InsertKeyFrame(0.5f, 0.72f); ringFade.InsertKeyFrame(1, 0);
            const auto ringGrow = compositor.CreateVector3KeyFrameAnimation();
            configure(ringGrow, L"Scale", slow);
            ringGrow.InsertKeyFrame(0, {0.94f, 0.94f, 1}); ringGrow.InsertKeyFrame(0.5f, {1.06f, 1.06f, 1});
            ringGrow.InsertKeyFrame(1, {1.12f, 1.12f, 1});
            cap.StartAnimation(press); cap.StartAnimation(down); pulse.StartAnimation(ringFade); pulse.StartAnimation(ringGrow);
        });
        return composition;
    }
};

OnboardingView::OnboardingView(JsonObject const &data, Request request)
    : impl_(std::make_shared<Impl>(data, std::move(request))) {
    InstallGuideStyles();
    impl_->root.IsTabStop(true);
    impl_->root.TabFocusNavigation(Input::KeyboardNavigationMode::Cycle);
    impl_->root.HorizontalContentAlignment(HorizontalAlignment::Stretch);
    impl_->root.VerticalContentAlignment(VerticalAlignment::Stretch);
    AutomationProperties::SetAutomationId(impl_->root, L"NativeOnboarding");
    impl_->root.SizeChanged([weak = std::weak_ptr<Impl>{impl_}](auto const &, auto const &args) {
        if (const auto self = weak.lock()) self->Layout(args.NewSize().Width);
    });
    impl_->Render();
}

OnboardingView::~OnboardingView() = default;
FrameworkElement OnboardingView::Root() const { return impl_->root; }
std::uint64_t OnboardingView::Session() const { return impl_->session; }
bool OnboardingView::Preview() const { return impl_->preview; }
bool OnboardingView::CancelPreview() { return impl_->Finish(true); }
void OnboardingView::Shown() { impl_->shown = true; impl_->StartWelcome(); impl_->Focus(); }

void OnboardingView::Update(JsonObject const &data, std::uint64_t request) {
    if (impl_->finished || request < impl_->latestRequest) return;
    const bool loaded = data.GetNamedBoolean(L"ready");
    const bool nextEnglish = data.GetNamedBoolean(L"english", impl_->english);
    const bool changed = impl_->ready != loaded || impl_->english != nextEnglish;
    impl_->snapshot = data;
    impl_->ready = loaded;
    impl_->english = nextEnglish;
    if (changed) impl_->Render();
    else impl_->UpdateControls();
}

#ifdef _DEBUG
winrt::hstring OnboardingView::TestWelcomeTitle() const {
    return impl_->welcomeSlogan ? impl_->welcomeSlogan.Text() : L"";
}
#endif
}
