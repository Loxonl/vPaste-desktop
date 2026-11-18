import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve("src-tauri/native-demo/windows/winui/WinUiPanel.cpp"), "utf8");
const host = readFileSync(resolve("src-tauri/src/winui_panel.rs"), "utf8");

describe("WinUI main panel presentation", () => {
    it("keeps the visible toolbar compact and removes the redundant overflow menu", () => {
        expect(panel.includes("g_panel.commands = StackPanel()")).toBe(true);
        expect(panel.includes("g_panel.commands.Spacing(8)")).toBe(true);
        expect(panel.includes("g_panel.commands.SecondaryCommands()")).toBe(false);
        for (const name of ["queueOpen", "settings"]) {
            expect(panel.includes(`g_panel.commands.Children().Append(g_panel.${name})`)).toBe(true);
        }
        for (const name of ["copy", "paste", "favorite", "manageTags", "queueSelect"]) {
            expect(panel.includes(`g_panel.commands.Children().Append(g_panel.${name})`)).toBe(false);
        }
        // Match ClipboardHeader: queue, settings, then the conditional update.
        // Settings is the final ordinary command, not the final conditional one.
        expect(panel).toMatch(/Children\(\)\.Append\(g_panel\.queueOpen\);[\s\S]*?Children\(\)\.Append\(g_panel\.settings\);\s*g_panel\.commands\.Children\(\)\.Append\(g_panel\.appActions->UpdateButton\(\)\);/);
        expect(panel).not.toContain("g_panel.commands.Children().Append(g_panel.queueAdd)");
        expect(panel).toContain("selectionActions.Children().Append(g_panel.queueAdd)");
        expect(panel).toContain("selectionActions.Children().Append(g_panel.cancelSelection)");
        expect(panel).toContain("addMenu.Items().Append(addFilter)");
        expect(panel).toContain("addMenu.Items().Append(addRecordTag)");
        expect(panel).not.toContain("addMenu.Items().Append(manageTags)");
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

    it("receives settings/import resets and resources addressed to the absent clipboard WebView", () => {
        expect(/app\.listen_any\(event, move \|_\| refresh\(\)\)/.test(host)).toBe(true);
        expect(host.includes('app.listen("history-reset"')).toBe(true);
        expect(host.includes('app.listen_any("custom-tabs-changed"')).toBe(true);
        expect(host.includes('send_response(0, "historyReset"')).toBe(true);
        expect(panel.includes('operation == L"historyReset"')).toBe(true);
        expect(panel.includes('operation == L"filtersChanged"')).toBe(true);
    });

    it("connects visible native cards to the existing cancellable resource service", () => {
        const visibility = host.slice(host.indexOf('extern "C" fn visibility_changed'), host.indexOf("pub(crate) fn show("));
        expect(visibility.includes("crate::background_resources::set_visible(app, visible)")).toBe(true);
        const card = host.slice(host.indexOf("async fn query_card("), host.indexOf("fn native_color("));
        expect(card.includes("resources.submit_refs(")).toBe(true);
        expect(card.includes("resources.epoch()")).toBe(true);
    });
});
