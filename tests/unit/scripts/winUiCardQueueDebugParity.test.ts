import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const native = (name: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", name), "utf8");
const rust = (name: string) => readFileSync(resolve("src-tauri/src", name), "utf8");

describe("card, queue and developer reference parity", () => {
    it("keeps complete developer actions inline instead of a three-item menu", () => {
        const actions = native("WinUiAppActions.cpp");
        expect(actions).toContain('L"tutorial-windows"');
        expect(actions).toContain('L"tutorial-mac"');
        expect(actions).toContain('L"language"');
        expect(actions).toContain('L"theme"');
        expect(actions).not.toContain('L"native-window"');
        expect(actions).not.toContain("tools.Flyout(toolsMenu)");
        expect(actions).toContain("developer && toolsVisible");
    });
    it("exposes reverse directly and uses the reference queue list hierarchy", () => {
        const queue = native("WinUiQueueView.cpp");
        expect(queue).toContain("toolbar.PrimaryCommands().Append(reverse)");
        expect(queue).not.toContain("position.Children().Append(ordinal)");
        expect(queue).toContain("container.BorderThickness(Thickness{0, 0, 0, 1})");
    });
    it("automatically scrolls card text without changing reader scroll behavior", () => {
        const panel = native("WinUiPanel.cpp");
        expect(panel).toContain("AutoScrollCardPreview");
        expect(panel).toContain("UpdateCardPreviewMotion()");
        expect(panel).toContain("SetCardRichContent(");
        expect(native("WinUiRichContent.cpp")).toContain("viewport.VerticalScrollMode(ScrollMode::Enabled)");
    });
    it("renders individual record-tag pills in a non-interactive clipped track", () => {
        const panel = native("WinUiPanel.cpp");
        expect(panel).toContain("CardRecordTags");
        expect(panel).not.toContain('tagNames += L" · "');
        expect(panel).toContain("recordTags->SetVisible(");
    });
    it("only suppresses main-card internal feedback while preserving external providers", () => {
        const panel = native("WinUiPanel.cpp");
        expect(panel).toContain("SuppressInternalCardDrag(");
        expect(panel).toContain("g_panel.cardDrag->Start(");
        expect(native("WinUiDrag.cpp")).toContain("DeclareDragFormats(args.Data()");
    });
    it("keeps tutorial preview available on both native platforms", () => {
        const auxiliary = rust("auxiliary_windows.rs");
        expect(auxiliary).not.toMatch(/cfg\(all\(debug_assertions, target_os = "macos"\)\)\]\s*DevTutorial/);
        expect(rust("main.rs")).toContain("WindowKind::DevTutorial => return build_dev_tutorial_window(handle)");
    });
});
