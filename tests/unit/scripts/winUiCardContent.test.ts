import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const directory = "src-tauri/native-demo/windows/winui/";
const read = (path: string) => readFileSync(path, "utf8");

describe("native card content feedback", () => {
    it("uses native ranges and the accepted query rather than HTML or a second renderer", () => {
        const content = read(`${directory}WinUiCardContent.cpp`);
        expect(content.includes("FindStringOrdinal")).toBe(true);
        expect(content.includes("TextHighlighter")).toBe(true);
        for (const forbidden of ["WebView", "SetClipboardData", "SendInput", "SetWindowPos"])
            expect(content.includes(forbidden)).toBe(false);
        expect(read("src-tauri/src/winui_panel.rs").includes('"highlightTerms"')).toBe(true);
    });
    it("builds the shared card policy and keeps retry in the native request path", () => {
        for (const file of ["WinUiCardContent.h", "WinUiCardContent.cpp"]) {
            expect(read(`${directory}WinUiPanel.vcxproj`).includes(file)).toBe(true);
            expect(read("src-tauri/build.rs").includes(file)).toBe(true);
        }
        const panel = read(`${directory}WinUiPanel.cpp`);
        expect(panel.includes('L"重试预览"')).toBe(true);
        expect(panel.includes("RequestCardDetails(")).toBe(true);
    });
    it("excludes child actions from both card paste gestures", () => {
        const panel = read(`${directory}WinUiPanel.cpp`);
        for (const event of ["Tapped", "DoubleTapped"]) {
            const handler = panel.match(new RegExp(`surface\\.${event}\\([\\s\\S]*?\\n            \\}\\);`))?.[0];
            expect(handler).toContain("IsCardAction(args.OriginalSource())");
        }
    });
});
