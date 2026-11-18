import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const directory = "src-tauri/native-demo/windows/winui/";
const read = (path: string) => readFileSync(path, "utf8");

describe("WinUI in-place record tags", () => {
    it("builds one native editor with the shared emoji picker and no extra window", () => {
        const editor = read(`${directory}WinUiRecordTagEditor.cpp`);
        expect(editor).toContain("NameEmojiButton(");
        expect(editor).toContain("FlyoutPlacementMode::TopEdgeAlignedLeft");
        expect(editor).toContain("ShouldConstrainToRootBounds(false)");
        for (const forbidden of ["CreateWindow", "SetWindowPos", "SetClipboardData", "WebView"])
            expect(editor).not.toContain(forbidden);
        for (const file of ["WinUiRecordTagEditor.cpp", "WinUiRecordTagEditor.h"]) {
            expect(read(`${directory}WinUiPanel.vcxproj`)).toContain(file);
            expect(read("src-tauri/build.rs")).toContain(file);
        }
    });
    it("routes isolated editor responses and releases the editor on its XAML apartment", () => {
        const host = read(`${directory}WinUiPanel.cpp`);
        expect(host.includes('L"recordTagCreate"')).toBe(true);
        expect(host.includes("g_panel.recordTagEditor->Receive(response)")).toBe(true);
        const cleanup = host.slice(host.indexOf("// Release UI objects on their STA"));
        expect(cleanup.includes("g_panel.recordTagEditor.reset()")).toBe(true);
        expect(cleanup.indexOf("g_panel.recordTagEditor.reset()"))
            .toBeLessThan(cleanup.indexOf("g_panel.xamlSource.Close()"));
        expect(read("src-tauri/src/winui_panel.rs")).toContain("crate::winui_tags::dispatch_editor");
    });
    it("exposes the selected card menu through standard Windows context-menu keys", () => {
        const keys = read(`${directory}WinUiKeyboard.cpp`);
        expect(keys.includes("VK_APPS")).toBe(true);
        expect(keys.includes("VK_F10")).toBe(true);
        expect(keys.includes("Action::OpenCardMenu")).toBe(true);
    });
});
