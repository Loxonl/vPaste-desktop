import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve("src-tauri/native-demo/windows/winui/WinUiPanel.cpp"), "utf8");

describe("WinUI main panel presentation", () => {
    it("keeps ordinary commands compact and queue selection outside toolbar overflow", () => {
        expect(panel.includes("g_panel.commands = CommandBar()")).toBe(true);
        expect(panel.includes("g_panel.commands.IsDynamicOverflowEnabled(true)")).toBe(true);
        for (const name of ["queueOpen", "settings"]) {
            expect(panel.includes(`PrimaryCommands().Append(g_panel.${name})`)).toBe(true);
        }
        for (const name of ["copy", "paste", "favorite", "manageTags", "queueSelect"]) {
            expect(panel.includes(`SecondaryCommands().Append(g_panel.${name})`)).toBe(true);
        }
        expect(panel).not.toContain("PrimaryCommands().Append(g_panel.queueAdd)");
        expect(panel).toContain("selectionActions.Children().Append(g_panel.queueAdd)");
        expect(panel).toContain("selectionActions.Children().Append(g_panel.cancelSelection)");
    });

    it("uses a native selector with the existing history filter mapping", () => {
        expect(panel.includes("g_panel.filter = SelectorBar()")).toBe(true);
        expect(panel.includes("FilterValue(FilterIndex())")).toBe(true);
        expect(panel.includes("g_panel.filterScroll.Content(g_panel.filterStrip)")).toBe(true);
        expect(panel.includes("RadioButtons()")).toBe(false);
    });

    it("keeps one shipping-height header and the native card focus visuals", () => {
        expect(panel.includes("GetAt(0).Height(GridLength{kHeaderHeight, GridUnitType::Pixel})")).toBe(true);
        expect(panel.includes("g_panel.history.Footer(g_panel.more)")).toBe(true);
        expect(panel.includes("UIElement::UseSystemFocusVisualsProperty()")).toBe(true);
    });
});
