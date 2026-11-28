#pragma once
#include <windows.h>
#undef GetCurrentTime
#include <chrono>
#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>
#include <winrt/Microsoft.UI.Composition.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Hosting.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.UI.ViewManagement.h>

namespace vpaste::winui {
inline double BezierProgress(double progress, std::array<double, 4> const &curve) {
    if (progress <= 0 || progress >= 1) return std::clamp(progress, 0.0, 1.0);
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

// The DLL embeds the same source consumed by React and the Rust reader.
inline winrt::Windows::Data::Json::JsonObject MotionTokens() {
    // Only resource bytes may outlive the UI STA. A static JsonObject would be
    // released during DLL teardown, after COM and its implementation unload.
    static const auto json = [] {
        const auto module = GetModuleHandleW(L"VPasteWinUiPanel.dll");
        const auto resource = FindResourceW(module, L"VPASTE_MOTION_TOKENS", RT_RCDATA);
        winrt::check_bool(resource != nullptr);
        const auto loaded = LoadResource(module, resource);
        winrt::check_bool(loaded != nullptr);
        const auto bytes = static_cast<const char *>(LockResource(loaded));
        winrt::check_bool(bytes != nullptr);
        return std::string_view{bytes, SizeofResource(module, resource)};
    }();
    return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(json));
}

// 纯 C++ POD 数值缓存：仅在首次访问时解析嵌入的 tokens.json，绝不持有任何静态 WinRT 对象，
// 避免 DLL 卸载晚于 COM/Windows App Runtime 析构时发生进程退出崩溃。
struct MotionTiming {
    double durationQuick = 0.12;
    double durationFast = 0.18;
    double durationStandard = 0.24;
    double durationSlow = 0.32;
    float distanceSubtle = 6.0f;
    float distanceStandard = 10.0f;
    float distanceEmphasis = 16.0f;
    double staggerTight = 0.018;
    double continuousMarquee = 8.0;
    double cardPreviewDelay = 0.32;
    double cardPreviewMinDuration = 1.5;
    double cardPreviewMaxDuration = 8.5;
    double cardPreviewSecondsPerDip = 0.012;
    double cardPreviewBottomPause = 0.9;
    double cardPreviewRestartPause = 1.1;
    double cardPreviewOverflowThreshold = 8.0;
    double tabSpringStiffness = 1800.0;
    double tabSpringDamping = 59.0;
    double tabSpringMass = 0.65;
    std::array<float, 4> easingEnter{0.22f, 1.0f, 0.36f, 1.0f};
    std::array<float, 4> easingExit{0.4f, 0.0f, 1.0f, 1.0f};
    std::array<float, 4> easingStandard{0.4f, 0.0f, 0.2f, 1.0f};

    double DurationByName(std::wstring_view name) const noexcept {
        if (name == L"quick") return durationQuick;
        if (name == L"fast") return durationFast;
        if (name == L"standard") return durationStandard;
        if (name == L"slow") return durationSlow;
        return durationStandard;
    }

    float DistanceByName(std::wstring_view name) const noexcept {
        if (name == L"subtle") return distanceSubtle;
        if (name == L"standard") return distanceStandard;
        if (name == L"emphasis") return distanceEmphasis;
        return distanceStandard;
    }
};

inline MotionTiming const &CachedMotionTiming() {
    static const MotionTiming cached = [] {
        const auto tokens = MotionTokens();
        const auto duration = tokens.GetNamedObject(L"duration");
        const auto distance = tokens.GetNamedObject(L"distance");
        const auto stagger = tokens.GetNamedObject(L"stagger");
        const auto continuous = tokens.GetNamedObject(L"continuous");
        const auto cardPreview = tokens.GetNamedObject(L"cardPreview");
        const auto spring = tokens.GetNamedObject(L"spring").GetNamedObject(L"tabIndicator");
        const auto easing = tokens.GetNamedObject(L"easing");
        const auto readCurve = [&](wchar_t const *name) {
            const auto curve = easing.GetNamedArray(name);
            return std::array<float, 4>{
                static_cast<float>(curve.GetNumberAt(0)),
                static_cast<float>(curve.GetNumberAt(1)),
                static_cast<float>(curve.GetNumberAt(2)),
                static_cast<float>(curve.GetNumberAt(3)),
            };
        };
        MotionTiming timing{};
        timing.durationQuick = duration.GetNamedNumber(L"quick");
        timing.durationFast = duration.GetNamedNumber(L"fast");
        timing.durationStandard = duration.GetNamedNumber(L"standard");
        timing.durationSlow = duration.GetNamedNumber(L"slow");
        timing.distanceSubtle = static_cast<float>(distance.GetNamedNumber(L"subtle"));
        timing.distanceStandard = static_cast<float>(distance.GetNamedNumber(L"standard"));
        timing.distanceEmphasis = static_cast<float>(distance.GetNamedNumber(L"emphasis"));
        timing.staggerTight = stagger.GetNamedNumber(L"tight");
        timing.continuousMarquee = continuous.GetNamedNumber(L"marquee");
        timing.cardPreviewDelay = cardPreview.GetNamedNumber(L"delay");
        timing.cardPreviewMinDuration = cardPreview.GetNamedNumber(L"minDuration");
        timing.cardPreviewMaxDuration = cardPreview.GetNamedNumber(L"maxDuration");
        timing.cardPreviewSecondsPerDip = cardPreview.GetNamedNumber(L"secondsPerDip");
        timing.cardPreviewBottomPause = cardPreview.GetNamedNumber(L"bottomPause");
        timing.cardPreviewRestartPause = cardPreview.GetNamedNumber(L"restartPause");
        timing.cardPreviewOverflowThreshold = cardPreview.GetNamedNumber(L"overflowThreshold");
        timing.tabSpringStiffness = spring.GetNamedNumber(L"stiffness");
        timing.tabSpringDamping = spring.GetNamedNumber(L"damping");
        timing.tabSpringMass = spring.GetNamedNumber(L"mass");
        timing.easingEnter = readCurve(L"enter");
        timing.easingExit = readCurve(L"exit");
        timing.easingStandard = readCurve(L"standard");
        return timing;
    }();
    return cached;
}

inline bool NativeAnimationsEnabled() {
    return winrt::Windows::UI::ViewManagement::UISettings().AnimationsEnabled();
}

inline winrt::Microsoft::UI::Composition::SpringVector2NaturalMotionAnimation SelectionSpring(
    winrt::Microsoft::UI::Composition::Compositor const &compositor) {
    const auto &timing = CachedMotionTiming();
    const auto stiffness = timing.tabSpringStiffness;
    const auto mass = timing.tabSpringMass;
    const auto animation = compositor.CreateSpringVector2Animation();
    animation.DampingRatio(static_cast<float>(std::min(1.0, timing.tabSpringDamping /
        (2 * std::sqrt(stiffness * mass)))));
    animation.Period(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
        std::chrono::duration<double>{2 * std::acos(-1.0) * std::sqrt(mass / stiffness)}));
    return animation;
}

inline constexpr wchar_t FeedbackAnimationResource[] = L"VPaste.FeedbackAnimation";

// The dedicated outer frame owns filter motion; inner cards retain elevation,
// hover and native drag transforms. All ages use the same bounded batch stagger.
inline bool AnimateResultItem(winrt::Microsoft::UI::Xaml::FrameworkElement const &element,
                              std::size_t index, bool enabled = NativeAnimationsEnabled()) {
    const auto key = winrt::box_value(L"VPaste.ResultAnimation");
    if (const auto previous = element.Resources().TryLookup(key)) {
        element.StopAnimation(previous.as<winrt::Microsoft::UI::Composition::ICompositionAnimationBase>());
        element.Resources().Remove(key);
    }
    element.Translation({0, 0, 0});
    if (!enabled || !element.IsLoaded()) return false;
    const auto compositor = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::GetCompositorForCurrentThread();
    const auto &timing = CachedMotionTiming();
    const auto &curve = timing.easingEnter;
    const auto easing = compositor.CreateCubicBezierEasingFunction({curve[0], curve[1]}, {curve[2], curve[3]});
    const auto animation = compositor.CreateVector3KeyFrameAnimation();
    animation.Target(L"Translation");
    animation.InsertKeyFrame(0, {timing.distanceEmphasis, 0, 0});
    animation.InsertKeyFrame(1, {0, 0, 0}, easing);
    animation.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
        std::chrono::duration<double>{timing.durationSlow}));
    animation.DelayTime(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
        std::chrono::duration<double>{(index % 12) * timing.staggerTight}));
    animation.DelayBehavior(winrt::Microsoft::UI::Composition::AnimationDelayBehavior::SetInitialValueBeforeDelay);
    element.StartAnimation(animation);
    element.Resources().Insert(key, animation);
    return true;
}

inline void ResetFeedbackOpacity(winrt::Microsoft::UI::Xaml::FrameworkElement const &element) {
    if (!element || !element.IsLoaded()) return;
    const auto key = winrt::box_value(FeedbackAnimationResource);
    const auto resources = element.Resources();
    if (const auto active = resources.TryLookup(key)) {
        element.StopAnimation(active.as<winrt::Microsoft::UI::Composition::ICompositionAnimationBase>());
        resources.Remove(key);
    }
    element.Opacity(1);
}

// Only status/selection surfaces use this. Card drag and window geometry retain
// their existing owners; WinUI keeps its built-in control/menu transitions.
inline bool FadeFeedback(winrt::Microsoft::UI::Xaml::FrameworkElement const &element,
                         bool enabled = NativeAnimationsEnabled()) {
    if (!element || !element.IsLoaded()) return false;
    ResetFeedbackOpacity(element);
    if (!enabled) return false;
    // Keep opacity and ThemeShadow's Translation on the XAML animation facade.
    // Mixing it with GetElementVisual breaks hit testing on elevated surfaces.
    const auto compositor = winrt::Microsoft::UI::Xaml::Media::CompositionTarget::GetCompositorForCurrentThread();
    const auto &timing = CachedMotionTiming();
    const auto &curve = timing.easingEnter;
    const auto easing = compositor.CreateCubicBezierEasingFunction({curve[0], curve[1]}, {curve[2], curve[3]});
    const auto animation = compositor.CreateScalarKeyFrameAnimation();
    animation.Target(L"Opacity");
    animation.InsertKeyFrame(0, 0);
    animation.InsertKeyFrame(1, 1, easing);
    animation.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
        std::chrono::duration<double>{timing.durationFast}));
    element.StartAnimation(animation);
    element.Resources().Insert(winrt::box_value(FeedbackAnimationResource), animation);
    return true;
}
}
