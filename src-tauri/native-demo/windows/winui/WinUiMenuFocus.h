#pragma once

#include <cstdint>
#include <memory>
#include <utility>
#include <vector>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.UI.h>

namespace vpaste::winui {

struct MenuOpeningInput {
    std::uint64_t generation = 0;
    bool keyboardGesture = false;
};

inline std::shared_ptr<MenuOpeningInput> TrackMenuOpeningInput(winrt::Microsoft::UI::Xaml::UIElement const &root) {
    using namespace winrt::Microsoft::UI::Xaml;
    auto input = std::make_shared<MenuOpeningInput>();
    const Input::KeyEventHandler markKeyboard{[input](auto const &sender, auto const &) {
        input->keyboardGesture = true;
        // ContextRequested opens on key-down; a Button flyout can open on key-up.
        // Neither should inherit keyboard intent from a previous input dispatch.
        sender.template as<UIElement>().DispatcherQueue().TryEnqueue([input, generation = ++input->generation] {
            if (input->generation == generation) input->keyboardGesture = false;
        });
    }};
    root.PreviewKeyDown(markKeyboard);
    root.PreviewKeyUp(markKeyboard);
    root.AddHandler(UIElement::PointerPressedEvent(), winrt::box_value(Input::PointerEventHandler{
        [input](auto const &, auto const &) { input->keyboardGesture = false; }}), true);
    return input;
}

struct MenuFocusCues {
    using Item = winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItemBase;
    struct Row { Item item; winrt::event_token key; };
    std::vector<Row> rows;
    winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutPresenter presenter{nullptr};
    winrt::event_token presenterKey{};

    void Hide(auto const &items, winrt::Microsoft::UI::Xaml::Media::Brush const &clear,
              winrt::Microsoft::UI::Xaml::Input::KeyEventHandler const &reveal) {
        using namespace winrt::Microsoft::UI::Xaml::Controls;
        for (const auto &item : items) {
            if (item.template try_as<MenuFlyoutSeparator>()) continue;
            item.FocusVisualPrimaryBrush(clear);
            item.FocusVisualSecondaryBrush(clear);
            rows.push_back({item, item.PreviewKeyDown(reveal)});
            if (const auto child = item.template try_as<MenuFlyoutSubItem>()) Hide(child.Items(), clear, reveal);
        }
    }

    void Restore() {
        using winrt::Microsoft::UI::Xaml::FrameworkElement;
        if (presenter) { presenter.PreviewKeyDown(presenterKey); presenter = nullptr; }
        for (const auto &row : rows) {
            row.item.PreviewKeyDown(row.key);
            // Each owned menu uses the stock theme brushes. Resolve them again
            // instead of taking a snapshot of the old theme or contrast colors.
            row.item.ClearValue(FrameworkElement::FocusVisualPrimaryBrushProperty());
            row.item.ClearValue(FrameworkElement::FocusVisualSecondaryBrushProperty());
        }
        rows.clear();
    }
};

inline void BindMenuOpeningFocus(winrt::Microsoft::UI::Xaml::Controls::MenuFlyout const &menu,
                                 std::shared_ptr<MenuOpeningInput> const &input) {
    using namespace winrt::Microsoft::UI::Xaml;
    auto cues = std::make_shared<MenuFocusCues>();
    const Input::KeyEventHandler reveal{[weak = std::weak_ptr{cues}](auto const &, auto const &) {
        if (const auto scope = weak.lock()) scope->Restore();
    }};
    menu.Opening([input, cues, reveal](auto const &sender, auto const &) {
        cues->Restore();
        if (std::exchange(input->keyboardGesture, false)) return;
        // An island popup may apply its first keyboard focus after Opened.
        // Keep its native focus and navigation; gate only the stroke, before
        // the first render and until real keyboard input arrives in the menu.
        const auto flyout = sender.template as<Controls::MenuFlyout>();
        cues->Hide(flyout.Items(), Media::SolidColorBrush{winrt::Windows::UI::Color{}}, reveal);
    });
    menu.Opened([cues, reveal](auto const &, auto const &) {
        if (cues->rows.empty()) return;
        // The presenter can receive the first arrow before any row does.
        for (DependencyObject node = cues->rows.front().item; node; node = Media::VisualTreeHelper::GetParent(node)) {
            if (const auto presenter = node.try_as<Controls::MenuFlyoutPresenter>()) {
                cues->presenter = presenter;
                cues->presenterKey = presenter.PreviewKeyDown(reveal);
                break;
            }
        }
    });
    menu.Closed([cues](auto const &, auto const &) { cues->Restore(); });
}

}  // namespace vpaste::winui
