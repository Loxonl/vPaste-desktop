#pragma once

#include <functional>
#include <memory>
#include <utility>
#include <windows.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Windows.System.h>

namespace vpaste::winui {

inline void CloseEditorFlyout(winrt::Microsoft::UI::Xaml::Controls::Flyout const &flyout, std::function<void()> restoreFocus) {
    if (flyout && flyout.IsOpen()) {
        if (restoreFocus) flyout.Closed([restoreFocus = std::move(restoreFocus)](auto const &, auto const &) { restoreFocus(); });
        flyout.Hide();
    } else if (restoreFocus) {
        restoreFocus();
    }
}

template<typename Action>
void BindSingleLineEditorKeys(winrt::Microsoft::UI::Xaml::Controls::TextBox const &box, Action action) {
    const auto composing = std::make_shared<bool>(false);
    box.TextCompositionStarted([composing](auto const &, auto const &) { *composing = true; });
    box.TextCompositionEnded([composing](auto const &, auto const &) { *composing = false; });
    box.PreviewKeyDown([composing, action](auto const &sender, auto const &args) {
        using winrt::Windows::System::VirtualKey;
        if (*composing || static_cast<unsigned>(args.OriginalKey()) == VK_PROCESSKEY) return;
        if (args.Key() != VirtualKey::Enter && args.Key() != VirtualKey::Escape) return;
        args.Handled(true);
        if (!args.KeyStatus().WasKeyDown) action(sender, args.Key() == VirtualKey::Enter);
    });
}

} // namespace vpaste::winui
