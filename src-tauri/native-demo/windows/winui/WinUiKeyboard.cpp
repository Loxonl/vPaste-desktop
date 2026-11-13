#include "WinUiKeyboard.h"
#include <windows.h>
#include <algorithm>
#include <cwctype>
#include <vector>
#include <utility>

namespace vpaste::winui {
namespace {
std::vector<std::wstring> Parts(std::wstring_view value) {
    std::vector<std::wstring> parts;
    for (std::size_t start = 0; start <= value.size();) {
        const auto end = value.find(L'+', start);
        auto part = std::wstring{value.substr(start, end == value.npos ? value.npos : end - start)};
        const auto first = part.find_first_not_of(L" \t\r\n");
        if (first == part.npos) return {};
        part = part.substr(first, part.find_last_not_of(L" \t\r\n") - first + 1);
        std::transform(part.begin(), part.end(), part.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
        parts.push_back(std::move(part));
        if (end == value.npos) break;
        start = end + 1;
    }
    return parts;
}
bool IsMeta(std::wstring const &part) {
    return part == L"super" || part == L"meta" || part == L"cmd" || part == L"command" || part == L"win" || part == L"windows";
}
}

KeyBinding ParseKeyBinding(std::wstring_view value) {
    const auto parts = Parts(value);
    if (parts.empty()) return {};
    KeyBinding binding;
    for (std::size_t i = 0; i + 1 < parts.size(); ++i) {
        const auto &part = parts[i];
        if (part == L"control" || part == L"ctrl") binding.control = true;
        else if (part == L"shift") binding.shift = true;
        else if (part == L"alt" || part == L"option") binding.alt = true;
        else if (IsMeta(part)) binding.meta = true;
        else return {};
    }
    const auto &key = parts.back();
    const std::pair<const wchar_t *, std::uint32_t> named[] = {
        {L"enter", VK_RETURN}, {L"return", VK_RETURN}, {L"esc", VK_ESCAPE}, {L"escape", VK_ESCAPE},
        {L"space", VK_SPACE}, {L"tab", VK_TAB}, {L"backspace", VK_BACK}, {L"delete", VK_DELETE},
        {L"insert", VK_INSERT}, {L"home", VK_HOME}, {L"end", VK_END}, {L"pageup", VK_PRIOR}, {L"pagedown", VK_NEXT},
        {L"arrowleft", VK_LEFT}, {L"arrowright", VK_RIGHT}, {L"arrowup", VK_UP}, {L"arrowdown", VK_DOWN}};
    for (auto const &[name, code] : named) if (key == name) { binding.key = code; return binding; }
    if (key.size() > 1 && key.front() == L'f') {
        unsigned number = 0;
        for (std::size_t i = 1; i < key.size(); ++i) {
            if (key[i] < L'0' || key[i] > L'9' || number > 24) return {};
            number = number * 10 + static_cast<unsigned>(key[i] - L'0');
        }
        if (number >= 1 && number <= 24) binding.key = VK_F1 + number - 1;
        return binding;
    }
    if (key.size() != 1) return {};
    if ((key[0] >= L'a' && key[0] <= L'z') || (key[0] >= L'0' && key[0] <= L'9')) {
        binding.key = static_cast<std::uint32_t>(std::towupper(key[0]));
        return binding;
    }
    const auto translated = VkKeyScanExW(key[0], GetKeyboardLayout(0));
    if (translated == -1) return {};
    const auto modifiers = HIBYTE(translated);
    if (((modifiers & 1) && !binding.shift) || ((modifiers & 2) && !binding.control) ||
        ((modifiers & 4) && !binding.alt) || (modifiers & ~7)) return {};
    binding.key = LOBYTE(translated);
    return binding;
}

MainKeyResult ResolveMainKey(PanelBehavior const &behavior, MainKeyInput const &input) {
    using Action = MainKeyAction;
    if (input.blocked || input.composing) return {};
    if (input.key == VK_MENU && !input.control && !input.meta) return {behavior.quickInput ? Action::ShowHints : Action::Ignore};
    if (input.control && !input.alt && !input.meta && input.key == VK_TAB)
        return {input.shift ? Action::PreviousCategory : Action::NextCategory};
    if (input.area != InputArea::Other && behavior.quickInput && input.alt && !input.control && !input.meta) {
        if (input.key == 'A') return {Action::QuickAll};
        if (input.key == 'F') return {Action::QuickFavorite};
        int index = -1;
        if (!input.shift && input.key >= '1' && input.key <= '9') index = static_cast<int>(input.key - '1');
        if (index >= 0) return input.repeated ? MainKeyResult{Action::Ignore} : MainKeyResult{Action::QuickItem, index};
    }
    if (input.control && !input.alt && !input.meta && input.key == 'F') return {Action::FocusSearch};
    if (input.area == InputArea::Other) return {};
    const auto &binding = behavior.plainBinding;
    if (binding.key && input.key == binding.key && input.control == binding.control && input.shift == binding.shift &&
        input.alt == binding.alt && input.meta == binding.meta) {
        if (input.repeated) return {Action::Ignore};
        return {input.area == InputArea::Search ? Action::SearchPastePlain : Action::PastePlain};
    }
    if (input.area == InputArea::Search) {
        if (input.key == VK_RETURN) return {input.repeated ? Action::Ignore : Action::SearchPaste};
        if (!input.control && !input.shift && !input.alt && !input.meta) {
            if (input.key == VK_ESCAPE) return {input.searchHasText ? Action::ClearSearch : Action::CloseSearch};
        }
        return {};
    }
    if (behavior.tabSelection && input.key == VK_TAB && !input.control && !input.alt && !input.meta)
        return {input.shift ? Action::PreviousCard : Action::NextCard};
    if (!input.control && !input.alt && !input.meta &&
        ((input.key == VK_APPS && !input.shift) || (input.key == VK_F10 && input.shift)))
        return {input.repeated ? Action::Ignore : Action::OpenCardMenu};
    if (!input.control && !input.shift && !input.alt && !input.meta) {
        if (input.key == VK_HOME) return {Action::FirstCard};
        if (input.key == VK_END) return {Action::LastCard};
        if (input.key == VK_NEXT) return {Action::NextPage};
        if (input.key == VK_PRIOR) return {Action::PreviousPage};
    }
    return {};
}

std::wstring ShortcutLabel(std::wstring_view value) {
    std::wstring label;
    const auto parts = Parts(value);
    for (std::size_t i = 0; i < parts.size(); ++i) {
        auto part = parts[i];
        if (part == L"ctrl" || part == L"control") part = L"Ctrl";
        else if (IsMeta(part)) part = L"Win";
        else if (part == L"return") part = L"Enter";
        else if (part == L"escape") part = L"Esc";
        else if (!part.empty()) part[0] = static_cast<wchar_t>(std::towupper(part[0]));
        if (i) label += L'+';
        label += part;
    }
    return label;
}
}
