import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const native = (name: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", name), "utf8");
const contains = (source: string, token: string) => expect(source.includes(token), token).toBe(true);

describe("WinUI complete native presentation", () => {
    it("uses the shipping WebView composition rather than a generic Windows card", () => {
        const panel = native("WinUiPanel.cpp");
        contains(panel, "constexpr double kCardHeaderHeight = 48");
        contains(panel, "constexpr double kCardRadius = 14");
        contains(panel, "sourceIcon.Width(54)");
        contains(panel, "titleBlock.Children().Append(timeText)");
        contains(panel, 'ApplyStyle(row.type, contrast ? L"VPaste.ContrastCardTitle" : L"VPaste.CardTitle")');
        contains(panel, 'ApplyStyle(g_panel.searchButton, L"VPaste.RoundToolbarButton")');
        contains(panel, "tagChip.Margin(Thickness{10, 44, 10, 0})");
    });
    it("shares theme-aware Fluent surfaces, type icons and text hierarchy", () => {
        const appearance = native("WinUiAppearance.h");
        contains(appearance, "InstallAppearanceResources(");
        contains(appearance, "{ThemeResource TextFillColorPrimaryBrush}");
        contains(appearance, "{ThemeResource ControlStrokeColorDefaultBrush}");
        contains(appearance, "TypeGlyph(");
        for (const name of ["WinUiPanel.cpp", "WinUiQueueView.cpp", "WinUiTagManager.cpp"]) {
            contains(native(name), "ApplyStyle(");
        }
    });

    it("does not mistake aggregate WinRT geometry for uniform XAML shorthand", () => {
        for (const file of ["WinUiPanel.cpp", "WinUiQueueView.cpp", "WinUiTagManager.cpp", "WinUiAppearance.h"]) {
            expect(native(file).match(/\b(?:Thickness|CornerRadius)\{(?!0\})[^,{}]+\}/g), file).toBeNull();
        }
    });

    it("presents different clipboard content without changing the shared bridge", () => {
        const panel = native("WinUiPanel.cpp");
        contains(panel, "UpdateCardContent(");
        contains(panel, "FormatCardTime(");
        contains(panel, "colorSwatch");
        contains(panel, "KeyboardAcceleratorTextOverride");
        contains(panel, "ToggleMenuFlyoutItem tagOption");
    });

    it("loads stored source icons and colors through the existing lazy card request", () => {
        const bridge = readFileSync(resolve("src-tauri/src/winui_panel.rs"), "utf8");
        contains(bridge, '"appIconPath": source_icon');
        contains(bridge, "crate::clipboard::color::parse_color(input)");
        contains(native("WinUiPanel.cpp"), 'GetNamedString(L"appIconPath"');
        contains(native("WinUiPanel.cpp"), 'GetNamedString(L"titleColor"');
        contains(native("WinUiPanel.cpp"), 'GetNamedValue(L"swatchColor"');
    });

    it("provides loading, filtered-empty and error recovery states", () => {
        const panel = native("WinUiPanel.cpp");
        contains(panel, "UpdateHistoryState(");
        contains(panel, "g_panel.loading.IsIndeterminate(true)");
        contains(panel, "g_panel.resetFilters");
        contains(panel, "g_panel.retry");
        contains(panel, "g_panel.cancelSelection");
        contains(panel, "ShowFeedback(");
        contains(panel, "InfoBarSeverity::Success");
        contains(panel, "InfoBarSeverity::Error");
    });

    it("releases every new XAML owner on the UI thread before COM shutdown", () => {
        const panel = native("WinUiPanel.cpp");
        const cleanup = panel.slice(panel.indexOf("// Release UI objects on their STA"), panel.indexOf("CoUninitialize();"));
        for (const owner of ["loading", "emptyState", "resetFilters", "retry", "cancelSelection", "deletionDialog", "feedback", "filterStrip", "customTabs", "addTag", "tagFilterButton"]) {
            contains(cleanup, `g_panel.${owner} = nullptr;`);
        }
        contains(cleanup, "g_panel.queueWindow.reset();");
        expect(panel.includes("TryEnqueue([completion]() -> winrt::fire_and_forget")).toBe(false);
        contains(panel, "RunNativePresentationRegression(completion)");
    });

    it("finishes management context and feedback with native primitives", () => {
        const queue = native("WinUiQueueView.cpp");
        const tags = native("WinUiTagManager.cpp");
        contains(queue, "TypeLabel(item.itemType, english)");
        contains(queue, "std::to_wstring(index + 1)");
        contains(queue, "InfoBar feedback");
        contains(tags, "InfoBar feedback");
        contains(tags, "TextBlock count");
        contains(tags, "EmptyState(");
    });
});
