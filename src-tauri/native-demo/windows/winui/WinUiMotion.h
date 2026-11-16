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

inline bool NativeAnimationsEnabled() {
    return winrt::Windows::UI::ViewManagement::UISettings().AnimationsEnabled();
}

inline winrt::Microsoft::UI::Composition::SpringVector2NaturalMotionAnimation SelectionSpring(
    winrt::Microsoft::UI::Composition::Compositor const &compositor) {
    const auto spring = MotionTokens().GetNamedObject(L"spring").GetNamedObject(L"tabIndicator");
    const auto stiffness = spring.GetNamedNumber(L"stiffness");
    const auto mass = spring.GetNamedNumber(L"mass");
    const auto animation = compositor.CreateSpringVector2Animation();
    animation.DampingRatio(static_cast<float>(std::min(1.0, spring.GetNamedNumber(L"damping") /
        (2 * std::sqrt(stiffness * mass)))));
    animation.Period(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
        std::chrono::duration<double>{2 * std::acos(-1.0) * std::sqrt(mass / stiffness)}));
    return animation;
}

inline constexpr wchar_t FeedbackAnimationResource[] = L"VPaste.FeedbackAnimation";

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
    const auto tokens = MotionTokens();
    const auto curve = tokens.GetNamedObject(L"easing").GetNamedArray(L"enter");
    const auto easing = compositor.CreateCubicBezierEasingFunction(
        {static_cast<float>(curve.GetNumberAt(0)), static_cast<float>(curve.GetNumberAt(1))},
        {static_cast<float>(curve.GetNumberAt(2)), static_cast<float>(curve.GetNumberAt(3))});
    const auto animation = compositor.CreateScalarKeyFrameAnimation();
    animation.Target(L"Opacity");
    animation.InsertKeyFrame(0, 0);
    animation.InsertKeyFrame(1, 1, easing);
    animation.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
        std::chrono::duration<double>{tokens.GetNamedObject(L"duration").GetNamedNumber(L"fast")}));
    element.StartAnimation(animation);
    element.Resources().Insert(winrt::box_value(FeedbackAnimationResource), animation);
    return true;
}
}
