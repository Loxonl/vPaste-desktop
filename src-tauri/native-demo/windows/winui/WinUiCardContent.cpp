#include <windows.h>
#undef GetCurrentTime
#include "WinUiCardContent.h"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <winrt/Microsoft.UI.Xaml.Markup.h>
#include <winrt/Windows.Foundation.Collections.h>
#ifdef _DEBUG
#include "WinUiRichContent.h"
#include <winrt/Microsoft.UI.Xaml.Media.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml::Documents;

std::vector<TextRange> FindSearchRanges(std::wstring_view text, SearchTerms const &terms) {
    std::vector<TextRange> result;
    if (text.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) return result;
    std::size_t start = 0;
    while (start < text.size() && result.size() < 256) {
        auto first = text.npos;
        std::size_t length = 0;
        for (std::size_t i = 0; i < std::min<std::size_t>(8, terms.size()); ++i) {
            const auto &term = terms[i];
            if (term.empty() || term.size() > text.size() - start) continue;
            const auto found = FindStringOrdinal(FIND_FROMSTART, text.data() + start, static_cast<int>(text.size() - start),
                term.data(), static_cast<int>(term.size()), TRUE);
            if (found < 0) continue;
            const auto position = start + static_cast<std::size_t>(found);
            if (position < first || (position == first && term.size() > length)) { first = position; length = term.size(); }
        }
        if (first == text.npos) break;
        result.push_back(TextRange{static_cast<std::int32_t>(first), static_cast<std::int32_t>(length)});
        start = first + length;
    }
    return result;
}

TextHighlighter SearchHighlighter(std::wstring_view text, SearchTerms const &terms) {
    const auto ranges = FindSearchRanges(text, terms);
    if (ranges.empty()) return nullptr;
    // Use the same live foreground/background pair as a native accent control,
    // rather than another per-page palette. Stored rich runs stay unchanged.
    const auto highlight = winrt::Microsoft::UI::Xaml::Markup::XamlReader::Load(
        LR"(<TextHighlighter xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Background="{ThemeResource AccentFillColorDefaultBrush}" Foreground="{ThemeResource TextOnAccentFillColorPrimaryBrush}"/>)").as<TextHighlighter>();
    for (const auto &range : ranges) highlight.Ranges().Append(range);
    return highlight;
}

void HighlightText(winrt::Microsoft::UI::Xaml::Controls::TextBlock const &block, SearchTerms const &terms) {
    block.TextHighlighters().Clear();
    if (const auto highlight = SearchHighlighter(std::wstring_view{block.Text()}, terms)) block.TextHighlighters().Append(highlight);
}

winrt::Windows::Foundation::Size NaturalImageBounds(double width, double height, double frameWidth, double frameHeight) {
    if (std::isfinite(width) && std::isfinite(height) && width > 0 && height > 0 &&
        ((width < 100 && height < 100) || (width >= 100 && height >= 100 && width <= frameWidth && height <= frameHeight)))
        return {static_cast<float>(width), static_cast<float>(height)};
    return {std::numeric_limits<float>::infinity(), std::numeric_limits<float>::infinity()};
}

std::wstring MediaCaption(winrt::Windows::Data::Json::JsonObject const &media,
    winrt::hstring const &dimensions, bool english, bool includeFormat) {
    std::wstring caption{dimensions};
    const auto append = [&](std::wstring const &part) {
        if (part.empty()) return;
        if (!caption.empty()) caption += L" · ";
        caption += part;
    };
    if (includeFormat) append(std::wstring{media.GetNamedString(L"format", L"")});
    auto bytes = media.GetNamedNumber(L"sourceBytes", 0);
    if (std::isfinite(bytes) && bytes > 0) {
        constexpr const wchar_t *units[] = {L"B", L"KB", L"MB", L"GB", L"TB"};
        int unit = 0;
        while (bytes >= 1024 && unit < 4) { bytes /= 1024; ++unit; }
        std::wostringstream label; label.imbue(std::locale::classic());
        label << std::fixed << std::setprecision(bytes >= 10 || unit == 0 ? 0 : 1) << bytes << L" " << units[unit];
        append(label.str());
    }
    if (media.GetNamedBoolean(L"previewLimited", false)) append(english ? L"Reduced preview" : L"轻量预览");
    else if (media.GetNamedBoolean(L"isGif", false) && media.GetNamedBoolean(L"animationLimited", false))
        append(english ? L"Still preview" : L"静态预览");
    return caption;
}
#ifdef _DEBUG
winrt::Windows::Foundation::IAsyncAction TestCardContentControls(
    winrt::Microsoft::UI::Xaml::FrameworkElement host, std::uint32_t &stage) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    using namespace winrt::Windows::Data::Json;
    stage = 69;
    const auto ranges = FindSearchRanges(L"😀 HELLO a+b [x]", {L"hello", L"a+b", L"[x]"});
    winrt::check_hresult(ranges.size() == 3 && ranges[0].StartIndex == 3 && ranges[0].Length == 5 &&
        ranges[1].StartIndex == 9 && ranges[1].Length == 3 && ranges[2].StartIndex == 13 ? S_OK : E_FAIL);
    const auto overlapping = FindSearchRanges(L"clipboard clip", {L"clip", L"clipboard"});
    winrt::check_hresult(overlapping.size() == 2 && overlapping[0].Length == 9 && overlapping[1].StartIndex == 10 &&
        FindSearchRanges(L"unchanged", {}).empty() && FindSearchRanges(std::wstring(1000, L'a'), {L"a"}).size() == 256 ? S_OK : E_FAIL);
    const auto tiny = NaturalImageBounds(24, 16, 200, 120);
    const auto natural = NaturalImageBounds(100, 100, 200, 120);
    winrt::check_hresult(tiny.Width == 24 && tiny.Height == 16 && natural.Width == 100 &&
        std::isinf(NaturalImageBounds(400, 300, 200, 120).Width) && std::isinf(NaturalImageBounds(0, 0, 200, 120).Height) ? S_OK : E_FAIL);
    const auto media = JsonObject::Parse(LR"({"format":"PNG","sourceBytes":4096,"previewLimited":true})");
    winrt::check_hresult(MediaCaption(media, L"24 × 16", true, true) == L"24 × 16 · PNG · 4.0 KB · Reduced preview" &&
        MediaCaption(media, L"24 × 16", false, false) == L"24 × 16 · 4.0 KB · 轻量预览" ? S_OK : E_FAIL);

    stage = 70;
    const auto fixture = host.as<Border>();
    StackPanel plate; plate.Spacing(8);
    TextBlock plain; plain.Text(L"😀 HELLO a+b"); plain.FontSize(13);
    HighlightText(plain, {L"hello", L"a+b"}); plate.Children().Append(plain);
    const auto source = JsonArray::Parse(LR"([{"runs":[
        {"text":"😀 ","backgroundColor":{"r":255,"g":220,"b":0}},
        {"text":"Micro","bold":true,"foreground":{"r":210,"g":20,"b":20}},
        {"text":"soft","italic":true}],"rows":[[[{"text":"Table MICROSOFT"}]]]}])");
    const auto serialized = source.Stringify();
    auto rich = RenderRichContent(source, false, {L"microsoft"}); rich.MaxHeight(160); plate.Children().Append(rich);
    fixture.Child(plate); co_await NextNativeFrame();
    winrt::check_hresult(plain.TextHighlighters().Size() == 1 && plain.TextHighlighters().GetAt(0).Ranges().Size() == 2 ? S_OK : E_FAIL);
    const auto paragraph = rich.Content().as<StackPanel>().Children().GetAt(0).as<RichTextBlock>();
    const auto inlines = paragraph.Blocks().GetAt(0).as<Paragraph>().Inlines();
    const auto highlight = paragraph.TextHighlighters().GetAt(paragraph.TextHighlighters().Size() - 1);
    winrt::check_hresult(inlines.Size() == 3 && inlines.GetAt(1).as<Run>().Text() == L"Micro" &&
        inlines.GetAt(1).as<Run>().FontWeight().Weight == 700 &&
        inlines.GetAt(1).as<Run>().Foreground().as<Media::SolidColorBrush>().Color().R == 210 &&
        paragraph.TextHighlighters().Size() == 2 && highlight.Ranges().GetAt(0).StartIndex == 3 &&
        highlight.Ranges().GetAt(0).Length == 9 && source.Stringify() == serialized ? S_OK : E_FAIL);
    const auto table = rich.Content().as<StackPanel>().Children().GetAt(1).as<ScrollViewer>().Content().as<Grid>();
    winrt::check_hresult(table.Children().GetAt(0).as<Border>().Child().as<RichTextBlock>().TextHighlighters().Size() == 1 ? S_OK : E_FAIL);
    for (const auto theme : {ElementTheme::Light, ElementTheme::Dark}) {
        fixture.RequestedTheme(theme); co_await NextNativeFrame();
        const auto match = plain.TextHighlighters().GetAt(0);
        const auto background = match.Background().as<Media::SolidColorBrush>().Color();
        const auto foreground = match.Foreground().as<Media::SolidColorBrush>().Color();
        winrt::check_hresult(background.A > 0 && foreground.A > 0 &&
            (background.R != foreground.R || background.G != foreground.G || background.B != foreground.B) ? S_OK : E_FAIL);
    }
    HighlightText(plain, {});
    winrt::check_hresult(plain.TextHighlighters().Size() == 0 && plain.Text() == L"😀 HELLO a+b" ? S_OK : E_FAIL);
    fixture.Child(nullptr);
}
#endif
}
