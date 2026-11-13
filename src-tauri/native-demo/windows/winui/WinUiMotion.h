#pragma once
#include <windows.h>
#undef GetCurrentTime
#include <chrono>
#include <string_view>
#include <winrt/Microsoft.UI.Composition.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Hosting.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.UI.ViewManagement.h>

namespace vpaste::winui {
// The DLL embeds the same source consumed by React and the Rust reader.
inline winrt::Windows::Data::Json::JsonObject MotionTokens() {
    static const auto tokens = [] {
        const auto module = GetModuleHandleW(L"VPasteWinUiPanel.dll");
        const auto resource = FindResourceW(module, L"VPASTE_MOTION_TOKENS", RT_RCDATA);
        winrt::check_bool(resource != nullptr);
        const auto loaded = LoadResource(module, resource);
        winrt::check_bool(loaded != nullptr);
        const auto bytes = static_cast<const char *>(LockResource(loaded));
        winrt::check_bool(bytes != nullptr);
        return winrt::Windows::Data::Json::JsonObject::Parse(
            winrt::to_hstring(std::string_view{bytes, SizeofResource(module, resource)}));
    }();
    return tokens;
}

inline bool NativeAnimationsEnabled() {
    return winrt::Windows::UI::ViewManagement::UISettings().AnimationsEnabled();
}

inline void ResetFeedbackOpacity(winrt::Microsoft::UI::Xaml::FrameworkElement const &element) {
    if (!element || !element.IsLoaded()) return;
    const auto visual = winrt::Microsoft::UI::Xaml::Hosting::ElementCompositionPreview::GetElementVisual(element);
    visual.StopAnimation(L"Opacity");
    visual.Opacity(1);
}

// Only status/selection surfaces use this. Card drag and window geometry retain
// their existing owners; WinUI keeps its built-in control/menu transitions.
inline bool FadeFeedback(winrt::Microsoft::UI::Xaml::FrameworkElement const &element,
                         bool enabled = NativeAnimationsEnabled()) {
    if (!element || !element.IsLoaded()) return false;
    ResetFeedbackOpacity(element);
    if (!enabled) return false;
    const auto visual = winrt::Microsoft::UI::Xaml::Hosting::ElementCompositionPreview::GetElementVisual(element);
    const auto compositor = visual.Compositor();
    const auto tokens = MotionTokens();
    const auto curve = tokens.GetNamedObject(L"easing").GetNamedArray(L"enter");
    const auto easing = compositor.CreateCubicBezierEasingFunction(
        {static_cast<float>(curve.GetNumberAt(0)), static_cast<float>(curve.GetNumberAt(1))},
        {static_cast<float>(curve.GetNumberAt(2)), static_cast<float>(curve.GetNumberAt(3))});
    const auto animation = compositor.CreateScalarKeyFrameAnimation();
    animation.InsertKeyFrame(0, 0);
    animation.InsertKeyFrame(1, 1, easing);
    animation.Duration(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
        std::chrono::duration<double>{tokens.GetNamedObject(L"duration").GetNamedNumber(L"fast")}));
    visual.StartAnimation(L"Opacity", animation);
    return true;
}
}
