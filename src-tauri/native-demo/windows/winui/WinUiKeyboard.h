#pragma once
#include <cstdint>
#include <string>
#include <string_view>

namespace vpaste::winui {
struct KeyBinding {
    std::uint32_t key = 0;
    bool control = false, shift = false, alt = false, meta = false;
};
KeyBinding ParseKeyBinding(std::wstring_view value);

struct PanelBehavior {
    bool retainSearch = false, retainCategory = false;
    bool retainPosition = false;
    bool quickInput = true, tabSelection = true;
    bool hoverPreview = false;
    std::wstring plainShortcut = L"Shift+Enter";
    KeyBinding plainBinding = ParseKeyBinding(plainShortcut);
};
enum class InputArea { History, Search, Other };
struct MainKeyInput {
    std::uint32_t key = 0;
    bool control = false, shift = false, alt = false, meta = false;
    bool repeated = false, composing = false, blocked = false;
    InputArea area = InputArea::History;
    bool searchHasText = false;
};
enum class MainKeyAction {
    None, Ignore, ShowHints, FocusSearch, NextCategory, PreviousCategory,
    NextCard, PreviousCard, PastePlain, SearchPaste, SearchPastePlain,
    QuickAll, QuickFavorite, QuickItem, ClearSearch, CloseSearch,
    FirstCard, LastCard, NextPage, PreviousPage, OpenCardMenu,
};
struct MainKeyResult { MainKeyAction action = MainKeyAction::None; int index = -1; };
MainKeyResult ResolveMainKey(PanelBehavior const &behavior, MainKeyInput const &input);
std::wstring ShortcutLabel(std::wstring_view value);
}
