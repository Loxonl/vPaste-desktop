#pragma once
#include "WinUiAppearance.h"
#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <string>
#include <string_view>

namespace vpaste::winui {
namespace HeaderArtwork {
// Exact 24-unit Material SVG paths used by ClipboardHeader.tsx.
inline constexpr wchar_t PlaylistAddCheckRounded[] = LR"(M13 10H3c-.55 0-1 .45-1 1s.45 1 1 1h10c.55 0 1-.45 1-1s-.45-1-1-1m0-4H3c-.55 0-1 .45-1 1s.45 1 1 1h10c.55 0 1-.45 1-1s-.45-1-1-1M3 16h6c.55 0 1-.45 1-1s-.45-1-1-1H3c-.55 0-1 .45-1 1s.45 1 1 1m19.21-3.79.09.09c.39.39.39 1.02 0 1.41l-5.58 5.59c-.39.39-1.02.39-1.41 0l-3.09-3.09a.9959.9959 0 0 1 0-1.41l.09-.09c.39-.39 1.02-.39 1.41 0l2.3 2.3 4.78-4.79c.38-.4 1.02-.4 1.41-.01)";
inline constexpr wchar_t SettingsOutlined[] = LR"(M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.09-.16-.26-.25-.44-.25-.06 0-.12.01-.17.03l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.06-.02-.12-.03-.18-.03-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.09.16.26.25.44.25.06 0 .12-.01.17-.03l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.06.02.12.03.18.03.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64zm-1.98-1.71c.04.31.05.52.05.73 0 .21-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4m0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2)";
inline constexpr wchar_t SyncRounded[] = LR"(M12 4V2.21c0-.45-.54-.67-.85-.35l-2.8 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.32.31.86.09.86-.36V6c3.31 0 6 2.69 6 6 0 .79-.15 1.56-.44 2.25-.15.36-.04.77.23 1.04.51.51 1.37.33 1.64-.34.37-.91.57-1.91.57-2.95 0-4.42-3.58-8-8-8m0 14c-3.31 0-6-2.69-6-6 0-.79.15-1.56.44-2.25.15-.36.04-.77-.23-1.04-.51-.51-1.37-.33-1.64.34C4.2 9.96 4 10.96 4 12c0 4.42 3.58 8 8 8v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36z)";
inline constexpr wchar_t VisibilityOutlined[] = LR"(M12 6c3.79 0 7.17 2.13 8.82 5.5C19.17 14.87 15.79 17 12 17s-7.17-2.13-8.82-5.5C4.83 8.13 8.21 6 12 6m0-2C7 4 2.73 7.11 1 11.5 2.73 15.89 7 19 12 19s9.27-3.11 11-7.5C21.27 7.11 17 4 12 4m0 5c1.38 0 2.5 1.12 2.5 2.5S13.38 14 12 14s-2.5-1.12-2.5-2.5S10.62 9 12 9m0-2c-2.48 0-4.5 2.02-4.5 4.5S9.52 16 12 16s4.5-2.02 4.5-4.5S14.48 7 12 7)";
inline constexpr wchar_t Apple[] = LR"(M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z)";
inline constexpr wchar_t ScienceOutlined[] = LR"(M13 11.33 18 18H6l5-6.67V6h2m2.96-2H8.04c-.42 0-.65.48-.39.81L9 6.5v4.17L3.2 18.4c-.49.66-.02 1.6.8 1.6h16c.82 0 1.29-.94.8-1.6L15 10.67V6.5l1.35-1.69c.26-.33.03-.81-.39-.81)";
inline constexpr wchar_t MemoryOutlined[] = LR"(M15 9H9v6h6zm-2 4h-2v-2h2zm8-2V9h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2zm-4 6H7V7h10z)";
inline constexpr wchar_t DashboardCustomizeOutlined[] = LR"(M3 11h8V3H3zm2-6h4v4H5zm8-2v8h8V3zm6 6h-4V5h4zM3 21h8v-8H3zm2-6h4v4H5zm13-2h-2v3h-3v2h3v3h2v-3h3v-2h-3z)";
inline constexpr wchar_t DarkModeRounded[] = LR"(M11.01 3.05C6.51 3.54 3 7.36 3 12c0 4.97 4.03 9 9 9 4.63 0 8.45-3.5 8.95-8 .09-.79-.78-1.42-1.54-.95-.84.54-1.84.85-2.91.85-2.98 0-5.4-2.42-5.4-5.4 0-1.06.31-2.06.84-2.89.45-.67-.04-1.63-.93-1.56)";
inline constexpr wchar_t LightModeRounded[] = LR"(M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5M2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1m18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1M11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1m0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1M5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0z)";
}

// 24 单位 SVG 画布的光学对齐与缩放参数，确保与槽位大小解耦且不发生裁剪。
struct HeaderIconMetrics {
    double slotSize = CompactIconSize;
    double opticalScale = 1.0;
    double offsetX = 0.0;
    double offsetY = 0.0;
};

namespace detail {
inline void SkipSvgSeparators(std::string_view input, std::size_t &pos) {
    while (pos < input.size() &&
           (input[pos] == ' ' || input[pos] == '\t' || input[pos] == '\r' ||
            input[pos] == '\n' || input[pos] == ',')) {
        ++pos;
    }
}

inline bool HasSvgNumber(std::string_view input, std::size_t pos) {
    SkipSvgSeparators(input, pos);
    if (pos >= input.size()) return false;
    const char c = input[pos];
    return (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.';
}

inline double ReadSvgNumber(std::string_view input, std::size_t &pos) {
    SkipSvgSeparators(input, pos);
    const std::size_t start = pos;
    if (pos < input.size() && (input[pos] == '+' || input[pos] == '-')) ++pos;
    while (pos < input.size() && input[pos] >= '0' && input[pos] <= '9') ++pos;
    if (pos < input.size() && input[pos] == '.') {
        ++pos;
        while (pos < input.size() && input[pos] >= '0' && input[pos] <= '9') ++pos;
    }
    if (pos < input.size() && (input[pos] == 'e' || input[pos] == 'E')) {
        ++pos;
        if (pos < input.size() && (input[pos] == '+' || input[pos] == '-')) ++pos;
        while (pos < input.size() && input[pos] >= '0' && input[pos] <= '9') ++pos;
    }
    double value = 0.0;
    if (pos > start) {
        std::from_chars(input.data() + start, input.data() + pos, value);
    }
    return value;
}

inline int ReadSvgFlag(std::string_view input, std::size_t &pos) {
    SkipSvgSeparators(input, pos);
    if (pos < input.size() && (input[pos] == '0' || input[pos] == '1')) {
        return input[pos++] == '1' ? 1 : 0;
    }
    return 0;
}

inline void AppendNumber(std::string &out, double value) {
    if (std::abs(value) < 1e-6) value = 0.0;
    char buffer[32]{};
    const auto [ptr, ec] = std::to_chars(buffer, buffer + sizeof(buffer), value, std::chars_format::fixed, 4);
    if (ec != std::errc{}) return;
    std::string_view formatted{buffer, static_cast<std::size_t>(ptr - buffer)};
    if (formatted.find('.') != std::string_view::npos) {
        while (!formatted.empty() && formatted.back() == '0') formatted.remove_suffix(1);
        if (!formatted.empty() && formatted.back() == '.') formatted.remove_suffix(1);
    }
    if (formatted == "-0") formatted = "0";
    out.append(formatted);
}
} // namespace detail

// 将 SVG Path 数据转换为 XAML Geometry 绝对路径：
// 1. 按 SVG 规范在 Z/z 后重置当前点至子路径起点，彻底修复相对 m 在 XAML 中的错位。
// 2. 将所有相对指令及平滑反射指令（S/s/T/t）展开为显式绝对指令，同时支持中心光学缩放与平移。
inline std::wstring NormalizeSvgPathForXaml(std::wstring_view svgPath,
    double opticalScale = 1.0, double offsetX = 0.0, double offsetY = 0.0) {
    std::string input;
    input.reserve(svgPath.size());
    for (wchar_t ch : svgPath) {
        input.push_back(static_cast<char>(ch));
    }
    const auto mapX = [&](double x) { return (x - 12.0 + offsetX) * opticalScale + 12.0; };
    const auto mapY = [&](double y) { return (y - 12.0 + offsetY) * opticalScale + 12.0; };

    std::string out;
    out.reserve(input.size() * 2);
    std::size_t pos = 0;
    char cmd = 0;
    char prevCmd = 0;
    double cx = 0.0, cy = 0.0;
    double sx = 0.0, sy = 0.0;
    double lastCpX = 0.0, lastCpY = 0.0;

    while (true) {
        detail::SkipSvgSeparators(input, pos);
        if (pos >= input.size()) break;
        if (std::isalpha(static_cast<unsigned char>(input[pos]))) {
            cmd = input[pos++];
        } else if (cmd == 'M') {
            cmd = 'L';
        } else if (cmd == 'm') {
            cmd = 'l';
        }

        const auto emitSpace = [&]() {
            if (!out.empty() && out.back() != ' ') out.push_back(' ');
        };

        if (cmd == 'M' || cmd == 'm') {
            bool first = true;
            while (detail::HasSvgNumber(input, pos)) {
                double x = detail::ReadSvgNumber(input, pos);
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 'm') { x += cx; y += cy; }
                cx = x; cy = y;
                if (first) {
                    sx = cx; sy = cy;
                    out.push_back('M');
                    first = false;
                } else {
                    emitSpace();
                    out.push_back('L');
                }
                detail::AppendNumber(out, mapX(cx));
                out.push_back(',');
                detail::AppendNumber(out, mapY(cy));
            }
            cmd = (cmd == 'm') ? 'l' : 'L';
            lastCpX = cx; lastCpY = cy;
            prevCmd = 'M';
        } else if (cmd == 'L' || cmd == 'l') {
            while (detail::HasSvgNumber(input, pos)) {
                double x = detail::ReadSvgNumber(input, pos);
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 'l') { x += cx; y += cy; }
                cx = x; cy = y;
                emitSpace();
                out.push_back('L');
                detail::AppendNumber(out, mapX(cx));
                out.push_back(',');
                detail::AppendNumber(out, mapY(cy));
            }
            lastCpX = cx; lastCpY = cy;
            prevCmd = 'L';
        } else if (cmd == 'H' || cmd == 'h') {
            while (detail::HasSvgNumber(input, pos)) {
                double x = detail::ReadSvgNumber(input, pos);
                if (cmd == 'h') x += cx;
                cx = x;
                emitSpace();
                out.push_back('L');
                detail::AppendNumber(out, mapX(cx));
                out.push_back(',');
                detail::AppendNumber(out, mapY(cy));
            }
            lastCpX = cx; lastCpY = cy;
            prevCmd = 'L';
        } else if (cmd == 'V' || cmd == 'v') {
            while (detail::HasSvgNumber(input, pos)) {
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 'v') y += cy;
                cy = y;
                emitSpace();
                out.push_back('L');
                detail::AppendNumber(out, mapX(cx));
                out.push_back(',');
                detail::AppendNumber(out, mapY(cy));
            }
            lastCpX = cx; lastCpY = cy;
            prevCmd = 'L';
        } else if (cmd == 'C' || cmd == 'c') {
            while (detail::HasSvgNumber(input, pos)) {
                double x1 = detail::ReadSvgNumber(input, pos);
                double y1 = detail::ReadSvgNumber(input, pos);
                double x2 = detail::ReadSvgNumber(input, pos);
                double y2 = detail::ReadSvgNumber(input, pos);
                double x = detail::ReadSvgNumber(input, pos);
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 'c') {
                    x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy;
                }
                lastCpX = x2; lastCpY = y2;
                cx = x; cy = y;
                emitSpace();
                out.push_back('C');
                detail::AppendNumber(out, mapX(x1)); out.push_back(','); detail::AppendNumber(out, mapY(y1));
                out.push_back(' ');
                detail::AppendNumber(out, mapX(x2)); out.push_back(','); detail::AppendNumber(out, mapY(y2));
                out.push_back(' ');
                detail::AppendNumber(out, mapX(cx)); out.push_back(','); detail::AppendNumber(out, mapY(cy));
            }
            prevCmd = 'C';
        } else if (cmd == 'S' || cmd == 's') {
            while (detail::HasSvgNumber(input, pos)) {
                double x1 = (prevCmd == 'C') ? (2.0 * cx - lastCpX) : cx;
                double y1 = (prevCmd == 'C') ? (2.0 * cy - lastCpY) : cy;
                double x2 = detail::ReadSvgNumber(input, pos);
                double y2 = detail::ReadSvgNumber(input, pos);
                double x = detail::ReadSvgNumber(input, pos);
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 's') {
                    x2 += cx; y2 += cy; x += cx; y += cy;
                }
                lastCpX = x2; lastCpY = y2;
                cx = x; cy = y;
                emitSpace();
                out.push_back('C');
                detail::AppendNumber(out, mapX(x1)); out.push_back(','); detail::AppendNumber(out, mapY(y1));
                out.push_back(' ');
                detail::AppendNumber(out, mapX(x2)); out.push_back(','); detail::AppendNumber(out, mapY(y2));
                out.push_back(' ');
                detail::AppendNumber(out, mapX(cx)); out.push_back(','); detail::AppendNumber(out, mapY(cy));
                prevCmd = 'C';
            }
        } else if (cmd == 'Q' || cmd == 'q') {
            while (detail::HasSvgNumber(input, pos)) {
                double x1 = detail::ReadSvgNumber(input, pos);
                double y1 = detail::ReadSvgNumber(input, pos);
                double x = detail::ReadSvgNumber(input, pos);
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 'q') { x1 += cx; y1 += cy; x += cx; y += cy; }
                lastCpX = x1; lastCpY = y1;
                cx = x; cy = y;
                emitSpace();
                out.push_back('Q');
                detail::AppendNumber(out, mapX(x1)); out.push_back(','); detail::AppendNumber(out, mapY(y1));
                out.push_back(' ');
                detail::AppendNumber(out, mapX(cx)); out.push_back(','); detail::AppendNumber(out, mapY(cy));
                prevCmd = 'Q';
            }
        } else if (cmd == 'T' || cmd == 't') {
            while (detail::HasSvgNumber(input, pos)) {
                double x1 = (prevCmd == 'Q') ? (2.0 * cx - lastCpX) : cx;
                double y1 = (prevCmd == 'Q') ? (2.0 * cy - lastCpY) : cy;
                double x = detail::ReadSvgNumber(input, pos);
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 't') { x += cx; y += cy; }
                lastCpX = x1; lastCpY = y1;
                cx = x; cy = y;
                emitSpace();
                out.push_back('Q');
                detail::AppendNumber(out, mapX(x1)); out.push_back(','); detail::AppendNumber(out, mapY(y1));
                out.push_back(' ');
                detail::AppendNumber(out, mapX(cx)); out.push_back(','); detail::AppendNumber(out, mapY(cy));
                prevCmd = 'Q';
            }
        } else if (cmd == 'A' || cmd == 'a') {
            while (detail::HasSvgNumber(input, pos)) {
                double rx = detail::ReadSvgNumber(input, pos) * opticalScale;
                double ry = detail::ReadSvgNumber(input, pos) * opticalScale;
                double rot = detail::ReadSvgNumber(input, pos);
                int largeArc = detail::ReadSvgFlag(input, pos);
                int sweep = detail::ReadSvgFlag(input, pos);
                double x = detail::ReadSvgNumber(input, pos);
                double y = detail::ReadSvgNumber(input, pos);
                if (cmd == 'a') { x += cx; y += cy; }
                cx = x; cy = y;
                emitSpace();
                out.push_back('A');
                detail::AppendNumber(out, rx); out.push_back(','); detail::AppendNumber(out, ry);
                out.push_back(' ');
                detail::AppendNumber(out, rot);
                out.push_back(' ');
                out.push_back(largeArc ? '1' : '0');
                out.push_back(' ');
                out.push_back(sweep ? '1' : '0');
                out.push_back(' ');
                detail::AppendNumber(out, mapX(cx)); out.push_back(','); detail::AppendNumber(out, mapY(cy));
                lastCpX = cx; lastCpY = cy;
                prevCmd = 'A';
            }
        } else if (cmd == 'Z' || cmd == 'z') {
            out.push_back('Z');
            cx = sx; cy = sy;
            lastCpX = cx; lastCpY = cy;
            prevCmd = 'Z';
        } else {
            ++pos;
        }
    }

    std::wstring result;
    result.reserve(out.size());
    for (char ch : out) result.push_back(static_cast<wchar_t>(ch));
    return result;
}

inline winrt::Microsoft::UI::Xaml::Controls::PathIcon HeaderIcon(
    const wchar_t *path, HeaderIconMetrics metrics) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    // Preserve the source viewBox, winding rule and padding instead of sizing
    // a symbol-font glyph or fitting the tight bounds of the individual path.
    const auto normalized = NormalizeSvgPathForXaml(path, metrics.opticalScale, metrics.offsetX, metrics.offsetY);
    const auto xaml = std::wstring{LR"(<PathIcon xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Data="F1 )"} + normalized + LR"("/>)";
    auto icon = Markup::XamlReader::Load(winrt::hstring{xaml}).as<PathIcon>();
    const double size = metrics.slotSize;
    Media::ScaleTransform scale;
    scale.ScaleX(size / 24.0); scale.ScaleY(size / 24.0);
    icon.Data().Transform(scale);
    icon.Width(size); icon.Height(size);
    return icon;
}

inline winrt::Microsoft::UI::Xaml::Controls::PathIcon HeaderIcon(const wchar_t *path, double size = CompactIconSize) {
    return HeaderIcon(path, HeaderIconMetrics{size, 1.0, 0.0, 0.0});
}
}
