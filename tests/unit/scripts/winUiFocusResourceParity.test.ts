import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve("src-tauri/native-demo/windows/winui/WinUiPanel.cpp"), "utf8");
const section = (start: string, end: string) => panel.slice(panel.indexOf(start), panel.indexOf(end, panel.indexOf(start)));

describe("native focus and resource ownership", () => {
    it("does not reapply every card's theme when only selection changes", () => {
        const selection = section("g_panel.history.SelectionChanged(", "Grid::SetRow(g_panel.history, 1)");
        expect(selection).not.toContain("ApplyRowTheme()");
        expect(selection).toContain("UpdateCardOutline(");
    });
    it("retains file artwork across unchanged theme applications", () => {
        expect(panel).toContain("void UpdateFilePresentation(");
        expect(panel).toContain("row.filePresentationDark != dark");
        const theme = section("case kSetTheme: {", "case kSetBehavior:");
        expect(theme).toContain("g_themeMode == static_cast<std::uint32_t>(wparam)");
    });
    it("keeps tab/source names accessible without redundant hover text", () => {
        expect(panel).not.toMatch(/SetToolTip\((?:row\.sourceFrame|surface|tab),/);
        expect(panel).not.toMatch(/ToolTipService::SetToolTip\(\s*g_panel\.filter\.Items/);
        expect(panel).toContain("AutomationProperties::SetName(tab, name)");
        expect(panel).toContain("AutomationProperties::SetHelpText(surface, source)");
    });
    it("uses the same confirmation path for the two tab kinds", () => {
        expect(panel).toContain("ConfirmDeleteTab(");
        expect(panel).toContain('ConfirmDeleteTab(std::wstring{draft.GetNamedString(L"id")}');
        expect(panel).toContain('ConfirmDeleteTab(RecordTabId(tagId)');
    });
});
