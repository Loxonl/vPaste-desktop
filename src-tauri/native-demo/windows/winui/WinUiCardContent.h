#pragma once
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Documents.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>

namespace vpaste::winui {
using SearchTerms = std::vector<std::wstring>;
std::vector<winrt::Microsoft::UI::Xaml::Documents::TextRange> FindSearchRanges(
    std::wstring_view text, SearchTerms const &terms);
winrt::Microsoft::UI::Xaml::Documents::TextHighlighter SearchHighlighter(
    std::wstring_view text, SearchTerms const &terms);
void HighlightText(winrt::Microsoft::UI::Xaml::Controls::TextBlock const &block, SearchTerms const &terms);
winrt::Windows::Foundation::Size NaturalImageBounds(double width, double height, double frameWidth, double frameHeight);
std::wstring MediaCaption(winrt::Windows::Data::Json::JsonObject const &media,
    winrt::hstring const &dimensions, bool english, bool includeFormat);
#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestCardContentControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement fixture, std::uint32_t &stage);
#endif
}
