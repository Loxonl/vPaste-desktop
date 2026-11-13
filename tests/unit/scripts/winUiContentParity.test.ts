import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const native = (name: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", name), "utf8");

describe("WinUI content and compact management parity", () => {
    it("reuses the existing bounded Rust projection instead of introducing another HTML renderer", () => {
        const bridge = readFileSync(resolve("src-tauri/src/winui_panel.rs"), "utf8");
        expect(bridge).toContain('#[path = "native_panel/rich_text.rs"]');
        expect(bridge).toContain("presentation::rich_content");
        expect(bridge).toContain('"displayTitle"');
        expect(bridge).toContain('"displaySubtitle"');
        expect(bridge).toContain('"fileCount"');
    });

    it("constructs native rich content and counts text highlights as UTF-16", () => {
        const panel = native("WinUiPanel.cpp");
        expect(panel).toContain("RenderRichContent(");
        expect(panel).toContain("row.richFrame.Child(");
        const rich = native("WinUiRichContent.cpp");
        for (const api of ["RichTextBlock", "TextHighlighter", "InlineUIContainer", "Grid table", "text.size()", "LocalAssetUri("]) {
            expect(rich).toContain(api);
        }
        expect(rich).not.toContain("XamlReader");
        const build = readFileSync(resolve("src-tauri/build.rs"), "utf8");
        expect(build).toContain("WinUiRichContent.cpp");
        expect(native("WinUiPanel.vcxproj")).toContain('ClCompile Include="WinUiRichContent.cpp"');
    });

    it("uses compact DPI-adjusted client sizes without losing queue actions", () => {
        const appearance = native("WinUiAppearance.h");
        expect(appearance).toContain("QueueContentWidth = 360");
        expect(appearance).toContain("QueueContentHeight = 448");
        expect(appearance).toContain("TagContentHeight = 420");
        expect(native("WinUiPanel.cpp")).toContain("AdjustWindowRectExForDpi");
        expect(native("WinUiPanel.cpp").includes("case WM_GETMINMAXINFO:")).toBe(true);
        const queue = native("WinUiQueueView.cpp");
        expect(queue).toContain("MenuFlyout rowMenu");
        for (const op of ["queuePaste", "queueRemove", "queueReorder", "queueReverse", "queueClear", "queueUndo"]) {
            expect(queue).toContain(op);
        }
        expect(queue).toContain("container.Padding(UniformThickness(8))");
        expect(native("WinUiTagManager.cpp")).not.toContain("surface.MinHeight(56)");
    });
});
