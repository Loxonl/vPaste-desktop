#pragma once

#include <string>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Controls.h>

namespace vpaste::winui {

const std::vector<std::wstring> &NameEmojiOptions();
std::wstring SelectedNameEmoji(const std::wstring &name);
std::wstring ApplyNameEmoji(const std::wstring &name, const std::wstring &emoji);
bool TryApplyNameEmoji(const winrt::Microsoft::UI::Xaml::Controls::TextBox &target, const std::wstring &emoji);
winrt::Microsoft::UI::Xaml::Controls::Button NameEmojiButton(
    const winrt::Microsoft::UI::Xaml::Controls::TextBox &target, bool english);
void SetNameEmojiLanguage(const winrt::Microsoft::UI::Xaml::Controls::Button &button, bool english);

} // namespace vpaste::winui
