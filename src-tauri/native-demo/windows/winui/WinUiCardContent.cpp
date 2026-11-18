#include <windows.h>
#undef GetCurrentTime
#include "WinUiCardContent.h"
#include "WinUiAppearance.h"
#include <winrt/Microsoft.UI.Text.h>
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Markup.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Foundation.Collections.h>
#ifdef _DEBUG
#include "WinUiRichContent.h"
#include "WinUiResourceProbe.h"
#include <winrt/Microsoft.UI.Xaml.Media.h>
winrt::Windows::Foundation::IAsyncAction NextNativeFrame();
#endif

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml::Documents;

namespace {
winrt::fire_and_forget LoadFileSvg(winrt::Microsoft::UI::Xaml::Media::Imaging::SvgImageSource source,
    winrt::hstring svg) {
    try {
        winrt::Windows::Storage::Streams::InMemoryRandomAccessStream stream;
        winrt::Windows::Storage::Streams::DataWriter writer{stream};
        writer.WriteString(svg); co_await writer.StoreAsync(); writer.DetachStream(); stream.Seek(0);
        const auto result = co_await source.SetSourceAsync(stream);
#ifdef _DEBUG
        if (TraceCardMedia()) std::fprintf(stderr, "WinUI media probe: file SVG status=%d\n", static_cast<int>(result));
#endif
        winrt::check_hresult(result == winrt::Microsoft::UI::Xaml::Media::Imaging::SvgImageSourceLoadStatus::Success ? S_OK : E_FAIL);
    } catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
}

winrt::Microsoft::UI::Xaml::Media::Imaging::SvgImageSource SharedFileIcon(
    winrt::Windows::Data::Json::JsonObject const &icon) {
    using winrt::Microsoft::UI::Xaml::Media::Imaging::SvgImageSource;
    struct Entry { winrt::hstring name; winrt::weak_ref<SvgImageSource> source; };
    // A file type names one immutable asset (including light variants). Share
    // it on the owning XAML thread without keeping unloaded images alive.
    static thread_local std::vector<Entry> icons;
    const auto name = icon.GetNamedString(L"name");
    std::erase_if(icons, [](auto const &entry) { return !entry.source.get(); });
    for (auto const &entry : icons) if (entry.name == name) {
        if (auto source = entry.source.get()) return source;
    }
    SvgImageSource source;
    if (icons.size() == 32) icons.erase(icons.begin());
    icons.push_back({name, winrt::make_weak(source)});
    LoadFileSvg(source, icon.GetNamedString(L"svg"));
    return source;
}

winrt::fire_and_forget LoadTransparencyGrid(winrt::Microsoft::UI::Xaml::Media::Imaging::SvgImageSource source, bool dark) {
    try {
        std::wstring cells;
        for (int y = 0; y < 256; y += 8) for (int x = (y / 8 % 2) * 8; x < 256; x += 16)
            cells += L"M" + std::to_wstring(x) + L"," + std::to_wstring(y) + L"h8v8h-8z";
        const auto svg = std::wstring{L"<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><rect width='256' height='256' fill='"} +
            (dark ? L"#505050" : L"#f2f2f2") + L"'/><path fill='" + (dark ? L"#3c3c3c" : L"#d8d8d8") +
            L"' d='" + cells + L"'/></svg>";
        winrt::Windows::Storage::Streams::InMemoryRandomAccessStream stream;
        winrt::Windows::Storage::Streams::DataWriter writer{stream};
        writer.WriteString(svg); co_await writer.StoreAsync(); writer.DetachStream(); stream.Seek(0);
        const auto status = co_await source.SetSourceAsync(stream);
        winrt::check_hresult(status == winrt::Microsoft::UI::Xaml::Media::Imaging::SvgImageSourceLoadStatus::Success ? S_OK : E_FAIL);
    } catch (winrt::hresult_error const &error) { OutputDebugStringW(error.message().c_str()); }
}
}

winrt::Microsoft::UI::Xaml::Controls::Grid FileTypePresentation(
    winrt::Windows::Data::Json::JsonObject const &file, bool dark, FilePresentationVariant variant) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    // Same canvas, icon and badge dimensions as FileTypePresentation.module.css.
    const bool preview = variant == FilePresentationVariant::Preview;
    Grid presentation; presentation.Width(preview ? 104 : 88); presentation.Height(preview ? 72 : 64);
    const auto icon = file.GetNamedObject(dark ? L"dark" : L"light");
    presentation.Tag(winrt::box_value(icon.GetNamedString(L"name")));
    Image image; image.Width(file.GetNamedBoolean(L"multiple", false) ? (preview ? 86 : 76) : (preview ? 72 : 64));
    image.Height(file.GetNamedBoolean(L"multiple", false) ? (preview ? 68 : 60) : (preview ? 72 : 64)); image.Stretch(Media::Stretch::Uniform);
    image.Source(SharedFileIcon(icon));
    presentation.Children().Append(image);
    if (preview) presentation.ActualThemeChanged([file](auto const &sender, auto const &) {
        const auto host = sender.as<Grid>();
        const auto themed = file.GetNamedObject(host.ActualTheme() == ElementTheme::Dark ? L"dark" : L"light");
        host.Tag(winrt::box_value(themed.GetNamedString(L"name")));
        host.Children().GetAt(0).as<Image>().Source(SharedFileIcon(themed));
    });
    const auto label = file.GetNamedString(L"label", L"");
    if (!label.empty()) {
        Border badge; ApplyStyle(badge, L"VPaste.Surface");
        badge.CornerRadius(UniformRadius(8)); badge.Padding(Thickness{5, 1, 5, 1});
        badge.MaxWidth(preview ? 98 : 82); badge.HorizontalAlignment(HorizontalAlignment::Center);
        badge.VerticalAlignment(VerticalAlignment::Top); badge.Margin(Thickness{0, preview ? 66.0 : 58.0, 0, -20});
        TextBlock text; ApplyStyle(text, L"VPaste.Secondary"); text.Text(label); text.FontSize(10);
        text.LineHeight(13); text.FontWeight(winrt::Microsoft::UI::Text::FontWeights::Medium());
        text.TextWrapping(TextWrapping::NoWrap); text.TextTrimming(TextTrimming::CharacterEllipsis);
        badge.Child(text); presentation.Children().Append(badge);
    }
    return presentation;
}

winrt::Microsoft::UI::Xaml::Media::Brush TransparencyBrush(bool dark) {
    using namespace winrt::Microsoft::UI::Xaml;
    // One bitmap per theme, owned by the XAML application rather than every
    // card. Stretch=None keeps the reference 8 DIP squares at every image size.
    const auto resources = Application::Current().Resources();
    const auto key = winrt::box_value(dark ? L"VPaste.TransparencyDark" : L"VPaste.TransparencyLight");
    if (resources.HasKey(key)) return resources.Lookup(key).as<Media::Brush>();
    Media::Imaging::SvgImageSource source;
    source.RasterizePixelWidth(256); source.RasterizePixelHeight(256);
    Media::ImageBrush brush; brush.ImageSource(source); brush.Stretch(Media::Stretch::None);
    resources.Insert(key, brush); LoadTransparencyGrid(source, dark);
    return brush;
}

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
    winrt::Microsoft::UI::Xaml::FrameworkElement host, std::uint32_t &stage,
    winrt::Windows::Data::Json::JsonArray files) {
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
    const auto mergedSource = JsonArray::Parse(LR"([{"runs":[{"text":"Revised code","strike":true,"underline":true,"mono":true}],"rows":[[[{"text":"Header"}]],[[{"text":"Left"}],[{"text":"A"}]],[[{"text":"B"}]]],"spans":[[{"column":0,"columnSpan":2,"rowSpan":1}],[{"column":0,"columnSpan":1,"rowSpan":2},{"column":1,"columnSpan":1,"rowSpan":1}],[{"column":1,"columnSpan":1,"rowSpan":1}]]}])");
    auto merged = RenderRichContent(mergedSource, false); plate.Children().Append(merged); co_await NextNativeFrame();
    const auto mergedContent = merged.Content().as<StackPanel>();
    const auto revised = mergedContent.Children().GetAt(0).as<RichTextBlock>().Blocks().GetAt(0).as<Paragraph>().Inlines().GetAt(0).as<Run>();
    winrt::check_hresult(static_cast<unsigned>(revised.TextDecorations()) ==
        (static_cast<unsigned>(winrt::Windows::UI::Text::TextDecorations::Underline) | static_cast<unsigned>(winrt::Windows::UI::Text::TextDecorations::Strikethrough)) && revised.FontFamily().Source() == L"Consolas" ? S_OK : E_FAIL);
    const auto mergedTable = mergedContent.Children().GetAt(1).as<ScrollViewer>().Content().as<Grid>();
    stage = 701;
    std::fprintf(stderr, "WinUI merged table: columns=%u rows=%u headingRight=%.1f spanningBottom=%.1f\n",
        mergedTable.ColumnDefinitions().Size(), mergedTable.RowDefinitions().Size(),
        mergedTable.Children().GetAt(0).as<Border>().BorderThickness().Right,
        mergedTable.Children().GetAt(1).as<Border>().BorderThickness().Bottom);
    winrt::check_hresult(mergedTable.ColumnDefinitions().Size() == 2 && Grid::GetColumnSpan(mergedTable.Children().GetAt(0).as<FrameworkElement>()) == 2 &&
        Grid::GetRowSpan(mergedTable.Children().GetAt(1).as<FrameworkElement>()) == 2 && Grid::GetColumn(mergedTable.Children().GetAt(3).as<FrameworkElement>()) == 1 &&
        mergedTable.Children().GetAt(0).as<Border>().BorderThickness().Right == 1 &&
        mergedTable.Children().GetAt(1).as<Border>().BorderThickness().Bottom == 1 ? S_OK : E_FAIL);
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
    stage = 171;
    for (const bool dark : {false, true}) {
        Border swatch; swatch.Height(96); swatch.HorizontalAlignment(HorizontalAlignment::Left);
        swatch.Background(TransparencyBrush(dark)); fixture.Child(swatch);
        for (const auto width : {64, 160}) {
            swatch.Width(width);
            // The shared source must keep 8-DIP cells after another card size
            // has caused its first decode, in both theme caches.
            for (int frame = 0; frame < 6; ++frame) co_await NextNativeFrame();
            Media::Imaging::RenderTargetBitmap bitmap;
            co_await bitmap.RenderAsync(swatch, width, 96);
            const auto buffer = co_await bitmap.GetPixelsAsync();
            winrt::com_array<std::uint8_t> pixels(buffer.Length());
            winrt::Windows::Storage::Streams::DataReader::FromBuffer(buffer).ReadBytes(pixels);
            int transitions = 0;
            for (int x = 1; x < width; ++x) {
                const auto offset = (12 * width + x) * 4;
                if (std::abs(static_cast<int>(pixels[offset]) - pixels[offset - 4]) > 10) ++transitions;
            }
            std::fprintf(stderr, "WinUI transparency grid: dark=%d width=%d transitions=%d\n", dark, width, transitions);
            winrt::check_hresult(transitions >= width / 8 - 2 && transitions <= width / 8 + 1 ? S_OK : E_FAIL);
        }
    }
    stage = 172;
    // Use the real Rust-resolved, embedded library SVGs rather than testing a
    // replacement font glyph or treating a nonempty source string as a decode.
    for (const bool dark : {false, true}) for (auto const &value : files) {
        const auto file = value.GetObject();
        const auto presentation = FileTypePresentation(file, dark);
        fixture.Child(presentation);
        const auto image = presentation.Children().GetAt(0).as<Image>();
        const auto sameFile = FileTypePresentation(file, dark);
        winrt::check_hresult(image.Source() == sameFile.Children().GetAt(0).as<Image>().Source() ? S_OK : E_FAIL);
        unsigned opaque = 0;
        for (int frame = 0; frame < 20 && opaque < 100; ++frame) {
            co_await NextNativeFrame();
            Media::Imaging::RenderTargetBitmap bitmap;
            co_await bitmap.RenderAsync(image, 88, 64);
            const auto buffer = co_await bitmap.GetPixelsAsync();
            winrt::com_array<std::uint8_t> pixels(buffer.Length());
            winrt::Windows::Storage::Streams::DataReader::FromBuffer(buffer).ReadBytes(pixels);
            opaque = 0;
            for (std::size_t i = 3; i < pixels.size(); i += 4) if (pixels[i] > 128) ++opaque;
        }
        std::fprintf(stderr, "WinUI file SVG: dark=%d name=%ls opaque=%u\n", dark,
            file.GetNamedObject(dark ? L"dark" : L"light").GetNamedString(L"name").c_str(), opaque);
        winrt::check_hresult(opaque >= 100 && presentation.Width() == 88 && presentation.Height() == 64 ? S_OK : E_FAIL);
    }
    fixture.Child(nullptr);
}
#endif
}
