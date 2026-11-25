#pragma once
#include "WinUiMotion.h"
#include "WinUiAppearance.h"
#include <memory>
#include <utility>
#include <vector>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Text.h>
#ifdef _DEBUG
#include <cstdio>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {

// Card-only viewport. Readers retain the interactive RenderRichContent surface.
class AutoScrollCardPreview : public std::enable_shared_from_this<AutoScrollCardPreview> {
    winrt::Microsoft::UI::Dispatching::DispatcherQueueTimer phaseTimer_{nullptr};
    bool active_ = false, visible_ = false, motionEnabled_ = false;
    bool toBottom_ = true, resetOnLoad_ = false;
    double overflow_ = 0;
    std::int32_t request_ = -1;

    static winrt::Windows::Foundation::TimeSpan Duration(double seconds) {
        return std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(std::chrono::duration<double>{seconds});
    }
    std::int32_t Scroll(double offset, bool animate) {
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        return viewport.ScrollTo(0, offset, ScrollingScrollOptions{
            animate ? ScrollingAnimationMode::Enabled : ScrollingAnimationMode::Disabled,
            ScrollingSnapPointsMode::Ignore});
    }
    void Schedule(bool toBottom, double delay) {
        toBottom_ = toBottom;
        if (!phaseTimer_) {
            phaseTimer_ = viewport.DispatcherQueue().CreateTimer();
            phaseTimer_.IsRepeating(false);
            phaseTimer_.Tick([weak = weak_from_this()](auto const &sender, auto const &) {
                if (const auto self = weak.lock(); self && self->phaseTimer_ == sender) {
                    self->request_ = self->Scroll(self->toBottom_ ? self->overflow_ : 0, true);
                    if (self->request_ < 0) self->Stop();
                }
            });
        }
        phaseTimer_.Interval(Duration(delay));
        phaseTimer_.Start();
    }
    void SetScrollAnimation(winrt::Microsoft::UI::Xaml::Controls::ScrollingScrollAnimationStartingEventArgs const &args) {
        if (request_ < 0 || args.CorrelationId() != request_) return;
        const auto animation = args.Animation().try_as<winrt::Microsoft::UI::Composition::Vector3KeyFrameAnimation>();
        if (!animation) return;
        const auto end = args.EndPosition();
        const auto compositor = animation.Compositor();
        if (toBottom_) {
            const auto timing = MotionTokens().GetNamedObject(L"cardPreview");
            animation.Duration(Duration(std::clamp(overflow_ * timing.GetNamedNumber(L"secondsPerDip"),
                timing.GetNamedNumber(L"minDuration"), timing.GetNamedNumber(L"maxDuration"))));
            animation.InsertKeyFrame(1, {end.x, end.y, 0}, compositor.CreateLinearEasingFunction());
            return;
        }
        animation.Duration(Duration(MotionTokens().GetNamedObject(L"duration").GetNamedNumber(L"fast")));
        const auto curve = MotionTokens().GetNamedObject(L"easing").GetNamedArray(L"standard");
        animation.InsertKeyFrame(1, {end.x, end.y, 0}, compositor.CreateCubicBezierEasingFunction(
            {static_cast<float>(curve.GetNumberAt(0)), static_cast<float>(curve.GetNumberAt(1))},
            {static_cast<float>(curve.GetNumberAt(2)), static_cast<float>(curve.GetNumberAt(3))}));
    }
    void Refresh() {
        if (!active_ || !visible_ || !viewport.IsLoaded() || !motionEnabled_ || viewport.ViewportHeight() <= 0) {
            Stop(); return;
        }
        const auto overflow = viewport.ScrollableHeight();
        if (overflow_ > 0 && std::abs(overflow_ - overflow) < 0.5) return;
        Stop();
        const auto timing = MotionTokens().GetNamedObject(L"cardPreview");
        if (overflow <= timing.GetNamedNumber(L"overflowThreshold")) return;
        overflow_ = overflow;
        Schedule(true, timing.GetNamedNumber(L"delay"));
    }
public:
    winrt::Microsoft::UI::Xaml::Controls::ScrollView viewport;
    static std::shared_ptr<AutoScrollCardPreview> Create(winrt::Microsoft::UI::Xaml::FrameworkElement content) {
        using namespace winrt::Microsoft::UI::Xaml;
        using namespace Controls;
        auto self = std::make_shared<AutoScrollCardPreview>();
        self->viewport.Content(content);
        self->viewport.ContentOrientation(ScrollingContentOrientation::Vertical);
        self->viewport.HorizontalScrollMode(ScrollingScrollMode::Disabled);
        self->viewport.HorizontalScrollBarVisibility(ScrollingScrollBarVisibility::Hidden);
        self->viewport.VerticalScrollMode(ScrollingScrollMode::Enabled);
        self->viewport.VerticalScrollBarVisibility(ScrollingScrollBarVisibility::Hidden);
        self->viewport.ZoomMode(ScrollingZoomMode::Disabled);
        self->viewport.IsTabStop(false);
        self->viewport.IsHitTestVisible(false);
        // The scroll presenter moves content within its viewport. Do not
        // animate the text element independently of that clipping boundary.
        const Media::RectangleGeometry clip;
        self->viewport.Clip(clip);
        const auto weak = std::weak_ptr<AutoScrollCardPreview>{self};
        self->viewport.Loaded([weak](auto const &, auto const &) {
            if (auto s = weak.lock()) {
                if (std::exchange(s->resetOnLoad_, false)) (void)s->Scroll(0, false);
                s->Refresh();
            }
        });
        self->viewport.ScrollAnimationStarting([weak](auto const &, auto const &args) {
            if (auto s = weak.lock()) s->SetScrollAnimation(args);
        });
        self->viewport.ScrollCompleted([weak](auto const &, auto const &args) {
            if (auto s = weak.lock(); s && s->request_ >= 0 && args.CorrelationId() == s->request_) {
                s->request_ = -1;
                const auto timing = MotionTokens().GetNamedObject(L"cardPreview");
                s->Schedule(!s->toBottom_, timing.GetNamedNumber(s->toBottom_ ? L"bottomPause" : L"restartPause"));
            }
        });
        self->viewport.Unloaded([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Stop(); });
        self->viewport.SizeChanged([weak, clip](auto const &, SizeChangedEventArgs const &args) {
            const auto size = args.NewSize();
            clip.Rect({0, 0, size.Width, size.Height});
            if (auto s = weak.lock()) s->Refresh();
        });
        self->viewport.ExtentChanged([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Refresh(); });
        return self;
    }
    ~AutoScrollCardPreview() { if (phaseTimer_) phaseTimer_.Stop(); }
    void Stop() {
        if (phaseTimer_) { phaseTimer_.Stop(); phaseTimer_ = nullptr; }
        request_ = -1;
        if (std::exchange(overflow_, 0) <= 0) return;
        resetOnLoad_ = !viewport.IsLoaded();
        if (!resetOnLoad_) (void)Scroll(0, false);
    }
    void SetActive(bool active, bool visible, bool motionEnabled = NativeAnimationsEnabled()) {
        active_ = active; visible_ = visible; motionEnabled_ = motionEnabled; Refresh();
    }
    void ContentChanged() { Stop(); Refresh(); }
#ifdef _DEBUG
    bool Animating() const { return overflow_ > 0; }
#endif
};

class CardRecordTags : public std::enable_shared_from_this<CardRecordTags> {
    winrt::Microsoft::UI::Xaml::Controls::StackPanel track_;
    winrt::Microsoft::UI::Xaml::Controls::StackPanel first_;
    winrt::Microsoft::UI::Composition::Vector3KeyFrameAnimation animation_{nullptr};
    bool visible_ = false, scrolling_ = false, motionEnabled_ = false;
    double distance_ = 0;
    void Refresh() {
        using namespace winrt::Microsoft::UI::Xaml;
        Media::RectangleGeometry clip;
        clip.Rect({0, 0, static_cast<float>(surface.ActualWidth()), 19}); surface.Clip(clip);
        const bool enabled = scrolling_ && visible_ && surface.IsLoaded() && motionEnabled_;
        if (track_.Children().Size() > 1) track_.Children().GetAt(1).as<UIElement>().Visibility(enabled ? Visibility::Visible : Visibility::Collapsed);
        const auto distance = first_.ActualWidth() + 4;
        if (!enabled || first_.ActualWidth() <= 0) { Stop(); return; }
        if (animation_ && std::abs(distance_ - distance) < 0.5) return;
        Stop(); distance_ = distance;
        const auto compositor = Media::CompositionTarget::GetCompositorForCurrentThread();
        animation_ = compositor.CreateVector3KeyFrameAnimation(); animation_.Target(L"Translation");
        animation_.InsertKeyFrame(0, {0, 0, 0});
        animation_.InsertKeyFrame(1, {static_cast<float>(-distance), 0, 0}, compositor.CreateLinearEasingFunction());
        animation_.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
            std::chrono::duration<double>{MotionTokens().GetNamedObject(L"continuous").GetNamedNumber(L"marquee")}));
        animation_.IterationBehavior(winrt::Microsoft::UI::Composition::AnimationIterationBehavior::Forever);
        track_.StartAnimation(animation_);
    }
public:
    winrt::Microsoft::UI::Xaml::Controls::Border surface;
    static std::shared_ptr<CardRecordTags> Create(std::vector<winrt::hstring> const &names) {
        using namespace winrt::Microsoft::UI::Xaml;
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        auto self = std::make_shared<CardRecordTags>();
        self->scrolling_ = names.size() > 2;
        self->track_.Orientation(Orientation::Horizontal); self->track_.Spacing(4);
        self->track_.Translation({0, 0, 0});
        self->track_.HorizontalAlignment(HorizontalAlignment::Left);
        self->surface.Child(self->track_); self->surface.Height(19);
        self->surface.IsHitTestVisible(false);
        self->surface.Visibility(names.empty() ? Visibility::Collapsed : Visibility::Visible);
        for (int copy = 0; copy < (self->scrolling_ ? 2 : 1); ++copy) {
            StackPanel group; group.Orientation(Orientation::Horizontal); group.Spacing(4);
            for (const auto &name : names) {
                TextBlock text; text.Text(name); ApplyStyle(text, L"VPaste.CardTag");
                text.TextWrapping(TextWrapping::NoWrap); text.TextTrimming(TextTrimming::CharacterEllipsis);
                text.FontWeight(winrt::Microsoft::UI::Text::FontWeights::Bold()); text.LineHeight(15);
                Border pill; ApplyStyle(pill, L"VPaste.CardTagSurface");
                pill.MaxWidth(92); pill.Padding(Thickness{7, 2, 7, 2}); pill.BorderThickness(Thickness{0}); pill.Child(text);
                group.Children().Append(pill);
            }
            self->track_.Children().Append(group);
            if (!copy) self->first_ = group;
        }
        const auto weak = std::weak_ptr<CardRecordTags>{self};
        self->surface.Loaded([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Refresh(); });
        self->surface.Unloaded([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Stop(); });
        self->surface.SizeChanged([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Refresh(); });
        self->first_.SizeChanged([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Refresh(); });
        return self;
    }
    ~CardRecordTags() { Stop(); }
    winrt::Microsoft::UI::Xaml::Controls::TextBlock FirstLabel() const {
        return first_.Children().Size() ? first_.Children().GetAt(0).as<winrt::Microsoft::UI::Xaml::Controls::Border>()
            .Child().as<winrt::Microsoft::UI::Xaml::Controls::TextBlock>() : winrt::Microsoft::UI::Xaml::Controls::TextBlock{};
    }
    void Stop() {
        if (!animation_) return;
        track_.StopAnimation(animation_);
        animation_ = nullptr; distance_ = 0; track_.Translation({0, 0, 0});
    }
    void SetVisible(bool visible, bool motionEnabled = NativeAnimationsEnabled()) { visible_ = visible; motionEnabled_ = motionEnabled; Refresh(); }
#ifdef _DEBUG
    bool Animating() const { return animation_ != nullptr; }
    winrt::Microsoft::UI::Xaml::Controls::StackPanel Pills() const { return first_; }
#endif
};
#ifdef _DEBUG
inline winrt::Windows::Foundation::IAsyncAction TestCardPreviewControls(
    winrt::Microsoft::UI::Xaml::Controls::Grid owner, std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    Border fixture; fixture.Width(200); fixture.Height(168);
    fixture.HorizontalAlignment(HorizontalAlignment::Left); fixture.VerticalAlignment(VerticalAlignment::Top);
    owner.Children().Append(fixture);
    struct Remove { Grid owner; Border fixture; ~Remove() {
        std::uint32_t index = 0; if (owner.Children().IndexOf(fixture, index)) owner.Children().RemoveAt(index);
    }} remove{owner, fixture};
    stage = 256;
    Grid card;
    RowDefinition header, body, footer;
    header.Height(GridLength{24, GridUnitType::Pixel});
    footer.Height(GridLength{24, GridUnitType::Pixel});
    for (const auto &row : {header, body, footer}) card.RowDefinitions().Append(row);
    card.Background(Media::SolidColorBrush{winrt::Windows::UI::Color{255, 255, 255, 255}});
    TextBlock text; text.Text(L"Long card\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10");
    text.LineHeight(20); text.TextWrapping(TextWrapping::Wrap);
    text.Foreground(Media::SolidColorBrush{winrt::Windows::UI::Color{255, 255, 0, 255}});
    const auto preview = AutoScrollCardPreview::Create(text);
    Grid::SetRow(preview->viewport, 1);
    card.Children().Append(preview->viewport);
    fixture.Child(card);
    for (int frame = 0; frame < 10 && (!preview->viewport.IsLoaded() || preview->viewport.ViewportHeight() <= 0); ++frame) {
        co_await NextNativeFrame(); fixture.UpdateLayout();
    }
    std::fprintf(stderr, "WinUI card preview readiness: loaded=%d viewport=%.1f content=%.1f\n",
        preview->viewport.IsLoaded(), preview->viewport.ViewportHeight(), text.ActualHeight());
    winrt::check_hresult(preview->viewport.IsLoaded() && preview->viewport.ViewportHeight() > 0 ? S_OK : E_FAIL);
    const auto clipMatchesViewport = [&]() {
        const auto clip = preview->viewport.Clip();
        if (!clip) return false;
        const auto bounds = clip.Rect();
        return bounds.X == 0 && bounds.Y == 0 && bounds.Width > 0 && bounds.Height > 0 &&
            std::abs(bounds.Width - preview->viewport.ActualWidth()) < 0.5 &&
            std::abs(bounds.Height - preview->viewport.ActualHeight()) < 0.5;
    };
    const auto shown = preview->viewport.Clip();
    stage = 2565;
    winrt::check_hresult(clipMatchesViewport() ? S_OK : E_FAIL);
    fixture.Width(164); fixture.Height(140);
    co_await NextNativeFrame();
    fixture.UpdateLayout();
    co_await NextNativeFrame();
    winrt::check_hresult(clipMatchesViewport() && preview->viewport.Clip() == shown &&
        std::abs(shown.Rect().Width - 164) < 0.5 && std::abs(shown.Rect().Height - 92) < 0.5 ? S_OK : E_FAIL);
    preview->SetActive(false, true, true);
    winrt::check_hresult(!preview->Animating() && !preview->viewport.IsHitTestVisible() &&
        preview->viewport.VerticalScrollBarVisibility() == ScrollingScrollBarVisibility::Hidden ? S_OK : E_FAIL);
    preview->SetActive(true, true, true);
    stage = 2561;
    winrt::check_hresult(preview->Animating() && text.ActualHeight() > preview->viewport.ViewportHeight() + 8 ? S_OK : E_FAIL);
    preview->SetActive(true, true, false);
    stage = 2562;
    winrt::check_hresult(!preview->Animating() && preview->viewport.VerticalOffset() <= 0.5 ? S_OK : E_FAIL);
    preview->SetActive(true, true, true); preview->SetActive(true, false, true);
    stage = 2563;
    winrt::check_hresult(!preview->Animating() ? S_OK : E_FAIL);
    preview->SetActive(true, true, true); fixture.Child(nullptr);
    // IsLoaded can clear before the queued Unloaded handler stops animation.
    for (int frame = 0; frame < 10 && (preview->viewport.IsLoaded() || preview->Animating()); ++frame) co_await NextNativeFrame();
    stage = 2564;
    winrt::check_hresult(!preview->viewport.IsLoaded() && !preview->Animating() ? S_OK : E_FAIL);
    stage = 257;
    fixture.Height(19);
    const auto tags = CardRecordTags::Create({L"Work", L"Notes", L"Third long record tag"});
    fixture.Child(tags->surface);
    for (int frame = 0; frame < 10 && (!tags->surface.IsLoaded() || tags->Pills().ActualWidth() <= 0); ++frame) {
        co_await NextNativeFrame(); fixture.UpdateLayout();
    }
    tags->SetVisible(true, true);
    winrt::check_hresult(tags->surface.IsLoaded() && tags->Animating() && tags->Pills().Children().Size() == 3 &&
        !tags->surface.IsHitTestVisible() && tags->surface.Clip() &&
        tags->Pills().Children().GetAt(2).as<Border>().ActualWidth() <= 92.5 ? S_OK : E_FAIL);
    tags->SetVisible(true, false);
    winrt::check_hresult(!tags->Animating() && tags->FirstLabel().Text() == L"Work" ? S_OK : E_FAIL);
    tags->SetVisible(true, true); fixture.Child(nullptr);
    for (int frame = 0; frame < 10 && (tags->surface.IsLoaded() || tags->Animating()); ++frame) co_await NextNativeFrame();
    winrt::check_hresult(!tags->surface.IsLoaded() && !tags->Animating() ? S_OK : E_FAIL);
    const auto two = CardRecordTags::Create({L"Work", L"Notes"}); fixture.Child(two->surface);
    for (int frame = 0; frame < 10 && !two->surface.IsLoaded(); ++frame) co_await NextNativeFrame();
    two->SetVisible(true, true);
    winrt::check_hresult(two->surface.IsLoaded() && !two->Animating() && two->Pills().Children().Size() == 2 ? S_OK : E_FAIL);
}
#endif
}
