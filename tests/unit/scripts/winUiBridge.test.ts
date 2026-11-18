import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const nativeRoot = "src-tauri/native-demo/windows/winui/";

describe("private WinUI transport and shared motion source", () => {
    it("keeps the isolated WinUI memory run out of the WebView creation path", () => {
        const profile = read("src-tauri/src/memory_profile.rs");
        const setup = profile.slice(profile.indexOf("pub fn setup("));
        const beforeWebview = setup.slice(0, setup.indexOf("crate::build_clipboard_window"));
        expect(beforeWebview).toContain("main_panel_mode::winui()");
        expect(beforeWebview).toContain("winui_panel::initialize");
    });

    it("keeps the synthetic first-page run independent of live capture and preview warmup", () => {
        const main = read("src-tauri/src/main.rs");
        const capture = main.slice(main.indexOf("async fn wait_for_clipboard_capture()"));
        const beforeLiveCapture = capture.slice(0, capture.indexOf("spawn_blocking"));
        expect(beforeLiveCapture).toMatch(/if memory_profile_active\(\)\s*\{\s*return Ok\(None\);/);
        const preview = main.slice(main.indexOf("fn prewarm_preview_window("));
        const beforePreviewCreation = preview.slice(0, preview.indexOf("tauri::async_runtime::spawn"));
        expect(beforePreviewCreation).toMatch(/if memory_profile_active\(\)\s*\{\s*return;/);
    });

    it("keeps both sides of the bounded ABI compatible", () => {
        const rust = read("src-tauri/src/winui_panel/bridge.rs");
        const cpp = read(nativeRoot + "WinUiBridge.h");
        for (const [rustName, cppName] of [
            ["PROTOCOL_VERSION", "BridgeVersion"],
            ["MAX_REQUEST_BYTES", "MaxRequestBytes"],
            ["MAX_RESPONSE_BYTES", "MaxResponseBytes"],
        ]) {
            const rustValue = rust.match(new RegExp(`${rustName}: \\w+ = ([\\d *]+);`))?.[1];
            const cppValue = cpp.match(new RegExp(`${cppName} = ([\\d *]+);`))?.[1];
            expect(rustValue).toBeDefined();
            expect(cppValue?.replaceAll(" ", "")).toEqual(rustValue?.replaceAll(" ", ""));
        }
    });

    it("embeds the same motion data rather than another native timing scale", () => {
        expect(read(nativeRoot + "WinUiMotion.rc")).toContain("src/ui/motion/tokens.json");
        expect(read("src/ui/motion/tokens.ts")).toContain('from "./tokens.json"');
        expect(read("src-tauri/src/winui_panel/reader.rs")).toContain("src/ui/motion/tokens.json");
        expect(read(nativeRoot + "WinUiPanel.vcxproj")).toContain('ResourceCompile Include="WinUiMotion.rc"');
    });
});
