import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const native = (name: string) => read(`src-tauri/native-demo/windows/winui/${name}`);
const panel = native("WinUiPanel.cpp");

describe("reported native continuity parity", () => {
    it("leaves dock visibility animation to the shipping dock controller", () => {
        expect(panel).toContain("DWMWA_TRANSITIONS_FORCEDISABLED");
    });
    it("does not rebuild an unchanged custom strip on every summon", () => {
        expect(panel).toContain("g_renderedDynamicTabs");
    });
    it("projects format presence independently of rich rendering", () => {
        expect(read("src-tauri/src/winui_panel.rs")).toContain('"isRichText"');
        expect(panel).toContain("row.gifBadge");
        expect(panel).toContain('GetNamedBoolean(L"isRichText"');
    });
    it("previews tab insertion over the strip rather than requiring a tab hit", () => {
        expect(panel).toContain("PreviewTabDrop(");
        expect(panel).toContain("g_panel.customTabs.DragOver(");
        expect(panel).toContain("g_panel.customTabs.DragLeave(");
        expect(panel).toContain("DropCompleted(");
    });
    it("embeds the shipping tutorial in the native panel area", () => {
        const tutorial = read("src-tauri/src/winui_panel/onboarding.rs");
        expect(tutorial).toContain("set_tutorial_active");
        expect(tutorial).not.toContain("super::hide()?;");
        expect(tutorial).not.toContain("fit_window_in_panel");
        const css = read("src/clipboard/NativeOnboardingWindow.module.css");
        expect(css).not.toContain("box-shadow:");
        expect(css).not.toContain("border-radius:");
    });
    it("keeps preview layers continuous while replacing content", () => {
        const reader = native("WinUiReader.cpp");
        const commit = reader.slice(reader.indexOf("void Commit("), reader.indexOf("void ImageError("));
        expect(commit).not.toContain("body.Children().Clear()");
        expect(commit).not.toContain("FadeFeedback(");
        expect(commit).toContain("if (!visible) {");
        expect(commit).toContain("ShowWindow(window, SW_SHOWNOACTIVATE)");
        expect(reader).toContain("outgoing");
    });
});
