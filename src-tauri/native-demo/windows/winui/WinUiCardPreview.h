#pragma once
#include "WinUiMotion.h"
#include "WinUiAppearance.h"
#include <memory>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Text.h>
#ifdef _DEBUG
#include <cstdio>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {

// Card-only viewport. Readers retain the interactive RenderRichContent surface.
class AutoScrollCardPreview : public std::enable_shared_from_this<AutoScrollCardPreview> {
    winrt::Microsoft::UI::Xaml::FrameworkElement content_{nullptr};
    winrt::Microsoft::UI::Composition::Vector3KeyFrameAnimation animation_{nullptr};
    bool active_ = false, visible_ = false, motionEnabled_ = false;
    double overflow_ = -1;

    void Refresh() {
        const auto overflow = std::max(0.0, content_.ActualHeight() - viewport.ViewportHeight());
        if (!active_ || !visible_ || !viewport.IsLoaded() || !motionEnabled_ || viewport.ViewportHeight() <= 0) {
            Stop(); return;
        }
        const auto timing = MotionTokens().GetNamedObject(L"cardPreview");
        if (overflow <= timing.GetNamedNumber(L"overflowThreshold")) { Stop(); return; }
        if (animation_ && std::abs(overflow_ - overflow) < 0.5) return;
        Stop(); overflow_ = overflow;
        const auto compositor = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::GetCompositorForCurrentThread();
        const auto linear = compositor.CreateLinearEasingFunction();
        const auto scroll = std::clamp(overflow * timing.GetNamedNumber(L"secondsPerDip"),
            timing.GetNamedNumber(L"minDuration"), timing.GetNamedNumber(L"maxDuration"));
        const auto pause = timing.GetNamedNumber(L"bottomPause");
        const auto reset = MotionTokens().GetNamedObject(L"duration").GetNamedNumber(L"fast");
        const auto total = scroll + pause + reset + timing.GetNamedNumber(L"restartPause");
        animation_ = compositor.CreateVector3KeyFrameAnimation();
        animation_.Target(L"Translation");
        animation_.InsertKeyFrame(0, {0, 0, 0});
        animation_.InsertKeyFrame(static_cast<float>(scroll / total), {0, static_cast<float>(-overflow), 0}, linear);
        animation_.InsertKeyFrame(static_cast<float>((scroll + pause) / total), {0, static_cast<float>(-overflow), 0}, linear);
        const auto curve = MotionTokens().GetNamedObject(L"easing").GetNamedArray(L"standard");
        const auto ease = compositor.CreateCubicBezierEasingFunction(
            {static_cast<float>(curve.GetNumberAt(0)), static_cast<float>(curve.GetNumberAt(1))},
            {static_cast<float>(curve.GetNumberAt(2)), static_cast<float>(curve.GetNumberAt(3))});
        animation_.InsertKeyFrame(static_cast<float>((scroll + pause + reset) / total), {0, 0, 0}, ease);
        animation_.InsertKeyFrame(1, {0, 0, 0}, linear);
        animation_.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(std::chrono::duration<double>{total}));
        animation_.DelayTime(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
            std::chrono::duration<double>{timing.GetNamedNumber(L"delay")}));
        animation_.IterationBehavior(winrt::Microsoft::UI::Composition::AnimationIterationBehavior::Forever);
        content_.StartAnimation(animation_);
    }
public:
    winrt::Microsoft::UI::Xaml::Controls::ScrollViewer viewport;
    static std::shared_ptr<AutoScrollCardPreview> Create(winrt::Microsoft::UI::Xaml::FrameworkElement content) {
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        auto self = std::make_shared<AutoScrollCardPreview>();
        self->content_ = content;
        content.Translation({0, 0, 0});
        self->viewport.Content(content);
        self->viewport.HorizontalScrollMode(ScrollMode::Disabled);
        self->viewport.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
        self->viewport.VerticalScrollMode(ScrollMode::Enabled);
        self->viewport.VerticalScrollBarVisibility(ScrollBarVisibility::Hidden);
        self->viewport.ZoomMode(ZoomMode::Disabled);
        self->viewport.IsTabStop(false);
        self->viewport.IsHitTestVisible(false);
        const auto weak = std::weak_ptr<AutoScrollCardPreview>{self};
        self->viewport.Loaded([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Refresh(); });
        self->viewport.Unloaded([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Stop(); });
        self->viewport.SizeChanged([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Refresh(); });
        content.SizeChanged([weak](auto const &, auto const &) { if (auto s = weak.lock()) s->Refresh(); });
        return self;
    }
    ~AutoScrollCardPreview() { Stop(); }
    void Stop() {
        if (!animation_) return;
        content_.StopAnimation(animation_);
        animation_ = nullptr; overflow_ = -1;
        if (content_) content_.Translation({0, 0, 0});
    }
    void SetActive(bool active, bool visible, bool motionEnabled = NativeAnimationsEnabled()) {
        active_ = active; visible_ = visible; motionEnabled_ = motionEnabled; Refresh();
    }
    void ContentChanged() { Stop(); Refresh(); }
#ifdef _DEBUG
    bool Animating() const { return animation_ != nullptr; }
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
    Border fixture; fixture.Width(200); fixture.Height(120);
    fixture.HorizontalAlignment(HorizontalAlignment::Left); fixture.VerticalAlignment(VerticalAlignment::Top);
    owner.Children().Append(fixture);
    struct Remove { Grid owner; Border fixture; ~Remove() {
        std::uint32_t index = 0; if (owner.Children().IndexOf(fixture, index)) owner.Children().RemoveAt(index);
    }} remove{owner, fixture};
    stage = 256;
    TextBlock text; text.Text(L"Long card\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10");
    text.LineHeight(20); text.TextWrapping(TextWrapping::Wrap);
    const auto preview = AutoScrollCardPreview::Create(text); fixture.Child(preview->viewport);
    for (int frame = 0; frame < 10 && (!preview->viewport.IsLoaded() || preview->viewport.ViewportHeight() <= 0); ++frame) {
        co_await NextNativeFrame(); fixture.UpdateLayout();
    }
    std::fprintf(stderr, "WinUI card preview readiness: loaded=%d viewport=%.1f content=%.1f\n",
        preview->viewport.IsLoaded(), preview->viewport.ViewportHeight(), text.ActualHeight());
    winrt::check_hresult(preview->viewport.IsLoaded() && preview->viewport.ViewportHeight() > 0 ? S_OK : E_FAIL);
    preview->SetActive(false, true, true);
    winrt::check_hresult(!preview->Animating() && !preview->viewport.IsHitTestVisible() &&
        preview->viewport.VerticalScrollBarVisibility() == ScrollBarVisibility::Hidden ? S_OK : E_FAIL);
    preview->SetActive(true, true, true);
    stage = 2561;
    winrt::check_hresult(preview->Animating() && text.ActualHeight() > preview->viewport.ViewportHeight() + 8 ? S_OK : E_FAIL);
    preview->SetActive(true, true, false);
    stage = 2562;
    winrt::check_hresult(!preview->Animating() && text.Translation().y == 0 ? S_OK : E_FAIL);
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
