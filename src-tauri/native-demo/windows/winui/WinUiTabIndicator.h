#pragma once
#include "WinUiMotion.h"
#include <winrt/Windows.Foundation.Numerics.h>

namespace vpaste::winui {
// One composition-owned line crosses both SelectorBars. Native items still own
// keyboard selection, focus, hover and press; no history/card transform is used.
class TabIndicator {
public:
    explicit TabIndicator(winrt::Microsoft::UI::Xaml::FrameworkElement const &element) : host(element) {}
    ~TabIndicator() {
        if (host.IsLoaded()) winrt::Microsoft::UI::Xaml::Hosting::ElementCompositionPreview::SetElementChildVisual(host, nullptr);
    }
    void Move(winrt::Windows::Foundation::Rect const &bounds, winrt::Windows::UI::Color color,
              bool animate, bool enabled = NativeAnimationsEnabled()) {
        using namespace winrt::Microsoft::UI::Xaml::Hosting;
        if (!host.IsLoaded() || bounds.Width <= 0) { Hide(); return; }
        if (!visual) {
            const auto compositor = ElementCompositionPreview::GetElementVisual(host).Compositor();
            visual = compositor.CreateShapeVisual(); visual.RelativeSizeAdjustment({1, 1});
            line = compositor.CreateRoundedRectangleGeometry(); line.CornerRadius({1.5f, 1.5f});
            const auto shape = compositor.CreateSpriteShape(line);
            brush = compositor.CreateColorBrush(color); shape.FillBrush(brush);
            visual.Shapes().Append(shape);
            ElementCompositionPreview::SetElementChildVisual(host, visual);
        }
        brush.Color(color); visual.Opacity(1);
        const winrt::Windows::Foundation::Numerics::float2 offset{bounds.X + 10, bounds.Y + bounds.Height - 3};
        const winrt::Windows::Foundation::Numerics::float2 size{std::max(4.0f, bounds.Width - 20), 3};
        if (positioned && animate && enabled && (target.X != bounds.X || target.Width != bounds.Width)) {
            const auto move = SelectionSpring(visual.Compositor()); move.FinalValue(winrt::box_value(offset).as<winrt::Windows::Foundation::IReference<winrt::Windows::Foundation::Numerics::float2>>());
            const auto resize = SelectionSpring(visual.Compositor()); resize.FinalValue(winrt::box_value(size).as<winrt::Windows::Foundation::IReference<winrt::Windows::Foundation::Numerics::float2>>());
            // An omitted InitialValue resumes from the current presentation
            // value, including a spring interrupted by another tab selection.
            line.StartAnimation(L"Offset", move); line.StartAnimation(L"Size", resize);
        } else if (!positioned || !enabled || target != bounds) {
            line.StopAnimation(L"Offset"); line.StopAnimation(L"Size");
            line.Offset(offset); line.Size(size);
        }
        target = bounds; positioned = true;
    }
    void Hide() {
        if (visual) { visual.Opacity(0); line.StopAnimation(L"Offset"); line.StopAnimation(L"Size"); }
        positioned = false;
    }
    winrt::Windows::Foundation::Rect Target() const { return target; }
#ifdef _DEBUG
    auto TestGeometry() const { return line; }
#endif
private:
    winrt::Microsoft::UI::Xaml::FrameworkElement host{nullptr};
    winrt::Microsoft::UI::Composition::ShapeVisual visual{nullptr};
    winrt::Microsoft::UI::Composition::CompositionRoundedRectangleGeometry line{nullptr};
    winrt::Microsoft::UI::Composition::CompositionColorBrush brush{nullptr};
    winrt::Windows::Foundation::Rect target{};
    bool positioned = false;
};
}
