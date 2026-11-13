#include <windows.h>
#include <shlwapi.h>
#undef GetCurrentTime

#include "WinUiRichContent.h"
#include "WinUiAppearance.h"

#include <algorithm>
#include <cwctype>
#include <vector>
#include <winrt/Microsoft.UI.Xaml.Documents.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Text.h>

namespace vpaste::winui {
namespace {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Microsoft::UI::Xaml::Documents;
using namespace winrt::Microsoft::UI::Xaml::Media;
using namespace winrt::Windows::Data::Json;

SolidColorBrush ColorBrush(const JsonObject &color) {
    return SolidColorBrush{winrt::Windows::UI::Color{
        static_cast<std::uint8_t>(color.GetNamedNumber(L"a", 255)),
        static_cast<std::uint8_t>(color.GetNamedNumber(L"r", 0)),
        static_cast<std::uint8_t>(color.GetNamedNumber(L"g", 0)),
        static_cast<std::uint8_t>(color.GetNamedNumber(L"b", 0))}};
}

RichTextBlock RichParagraph(const JsonArray &runs, bool darkCanvas, SearchTerms const &terms) {
    RichTextBlock block;
    block.FontSize(13);
    block.LineHeight(19.5);
    block.IsTextSelectionEnabled(false);
    block.TextWrapping(TextWrapping::Wrap);
    block.Foreground(SolidColorBrush{darkCanvas ? winrt::Windows::UI::Color{255, 242, 243, 245}
        : winrt::Windows::UI::Color{255, 33, 33, 33}});
    Paragraph paragraph;
    std::int32_t offset = 0;
    std::wstring searchable;
    for (const auto &value : runs) {
        const auto data = value.GetObject();
        const auto imagePath = data.GetNamedString(L"image", L"");
        if (!imagePath.empty()) {
            // Rust supplies only cached, approved rich-image resources, never
            // arbitrary HTML URLs. A failed image must not discard other text.
            try {
                Image image;
                image.MaxWidth(188);
                image.MaxHeight(100);
                image.Stretch(Stretch::Uniform);
                Imaging::BitmapImage bitmap;
                bitmap.DecodePixelWidth(384);
                bitmap.UriSource(LocalAssetUri(imagePath));
                image.Source(bitmap);
                InlineUIContainer container;
                container.Child(image);
                paragraph.Inlines().Append(container);
                ++offset; // Inline object replacement character in the text stream.
            } catch (const winrt::hresult_error &) {
                Run fallback;
                fallback.Text(L"\uFFFC");
                paragraph.Inlines().Append(fallback);
                ++offset;
            }
            searchable += L'\uFFFC';
            continue;
        }
        const auto text = data.GetNamedString(L"text", L"");
        if (text.empty()) continue;
        searchable.append(text.c_str(), text.size());
        Run run;
        run.Text(text);
        run.FontSize(data.GetNamedNumber(L"size", 0) > 0
            ? std::clamp(data.GetNamedNumber(L"size"), 10.0, 26.0) : 13);
        if (data.GetNamedBoolean(L"bold", false)) run.FontWeight(winrt::Windows::UI::Text::FontWeights::Bold());
        if (data.GetNamedBoolean(L"italic", false)) run.FontStyle(winrt::Windows::UI::Text::FontStyle::Italic);
        if (data.GetNamedBoolean(L"underline", false)) run.TextDecorations(winrt::Windows::UI::Text::TextDecorations::Underline);
        if (data.GetNamedBoolean(L"mono", false)) run.FontFamily(FontFamily{L"Consolas"});
        const auto foreground = data.GetNamedValue(L"foreground", nullptr);
        if (foreground && foreground.ValueType() == JsonValueType::Object) run.Foreground(ColorBrush(foreground.GetObject()));
        paragraph.Inlines().Append(run);
        const auto background = data.GetNamedValue(L"backgroundColor", nullptr);
        if (background && background.ValueType() == JsonValueType::Object) {
            TextHighlighter highlight;
            highlight.Background(ColorBrush(background.GetObject()));
            // TextHighlighter overrides foreground too; preserve copied/default ink.
            highlight.Foreground(foreground && foreground.ValueType() == JsonValueType::Object
                ? ColorBrush(foreground.GetObject()) : block.Foreground());
            highlight.Ranges().Append(TextRange{offset, static_cast<std::int32_t>(text.size())});
            block.TextHighlighters().Append(highlight);
        }
        // hstring::size is UTF-16 code units; an emoji occupies two, not one.
        offset += static_cast<std::int32_t>(text.size());
    }
    block.Blocks().Append(paragraph);
    if (const auto search = SearchHighlighter(searchable, terms)) block.TextHighlighters().Append(search);
    return block;
}
} // namespace

winrt::Windows::Foundation::Uri LocalAssetUri(const winrt::hstring &path) {
    const bool drive = path.size() >= 3 && std::iswalpha(path[0]) && path[1] == L':' &&
        (path[2] == L'\\' || path[2] == L'/');
    const bool unc = path.size() > 2 && path[0] == L'\\' && path[1] == L'\\';
    winrt::check_hresult(drive || unc ? S_OK : E_INVALIDARG);
    std::vector<wchar_t> buffer(std::max<std::size_t>(2084, path.size() * 3 + 32));
    auto length = static_cast<DWORD>(buffer.size());
    winrt::check_hresult(UrlCreateFromPathW(path.c_str(), buffer.data(), &length, 0));
    return winrt::Windows::Foundation::Uri{winrt::hstring{buffer.data(), length}};
}

ScrollViewer RenderRichContent(const JsonArray &blocks, bool darkCanvas, SearchTerms const &terms) {
    StackPanel content;
    content.Spacing(4);
    for (const auto &value : blocks) {
        const auto data = value.GetObject();
        const auto runs = data.GetNamedArray(L"runs");
        if (runs.Size()) content.Children().Append(RichParagraph(runs, darkCanvas, terms));
        const auto rows = data.GetNamedArray(L"rows");
        if (!rows.Size()) continue;
        Grid table;
        std::uint32_t columns = 0;
        for (const auto &row : rows) columns = std::max(columns, row.GetArray().Size());
        table.MinWidth(columns * 80.0);
        for (std::uint32_t column = 0; column < columns; ++column) table.ColumnDefinitions().Append(ColumnDefinition{});
        for (std::uint32_t row = 0; row < rows.Size(); ++row) {
            RowDefinition definition;
            definition.Height(GridLength{1, GridUnitType::Auto});
            table.RowDefinitions().Append(definition);
            const auto cells = rows.GetArrayAt(row);
            for (std::uint32_t column = 0; column < cells.Size(); ++column) {
                Border cell;
                cell.Child(RichParagraph(cells.GetArrayAt(column), darkCanvas, terms));
                cell.BorderBrush(SolidColorBrush{darkCanvas ? winrt::Windows::UI::Color{51, 255, 255, 255}
                    : winrt::Windows::UI::Color{35, 0, 0, 0}});
                cell.BorderThickness(Thickness{1, 1, column + 1 == columns ? 1.0 : 0.0, row + 1 == rows.Size() ? 1.0 : 0.0});
                cell.Padding(Thickness{6, 4, 6, 4});
                Grid::SetRow(cell, row);
                Grid::SetColumn(cell, column);
                table.Children().Append(cell);
            }
        }
        ScrollViewer tableScroll;
        tableScroll.HorizontalScrollMode(ScrollMode::Enabled);
        tableScroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Auto);
        tableScroll.VerticalScrollMode(ScrollMode::Disabled);
        tableScroll.VerticalScrollBarVisibility(ScrollBarVisibility::Disabled);
        tableScroll.IsTabStop(false);
        tableScroll.Content(table);
        content.Children().Append(tableScroll);
    }
    ScrollViewer viewport;
    viewport.Background(SolidColorBrush{darkCanvas ? winrt::Windows::UI::Color{255, 36, 36, 36}
        : winrt::Windows::UI::Color{255, 255, 255, 255}});
    viewport.HorizontalScrollMode(ScrollMode::Disabled);
    viewport.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
    viewport.VerticalScrollMode(ScrollMode::Enabled);
    viewport.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
    viewport.IsTabStop(false);
    viewport.Content(content);
    return viewport;
}

} // namespace vpaste::winui
