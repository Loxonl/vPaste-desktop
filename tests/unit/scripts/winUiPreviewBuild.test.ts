import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("WinUI auxiliary preview without a development server", () => {
    it("embeds local frontend assets when the WinUI experiment is built", () => {
        const cargo = readFileSync(resolve("src-tauri/Cargo.toml"), "utf8");
        expect(cargo).toMatch(/winui-debug\s*=\s*\[[^\]]*"custom-protocol"/);
    });

    it("builds fresh frontend assets before compiling WinUI and stops on failure", () => {
        const launcher = readFileSync(resolve("scripts/run-dev-app.ps1"), "utf8");
        const build = launcher.indexOf("npm.cmd run build");
        expect(build).toBeGreaterThan(-1);
        expect(build).toBeLessThan(launcher.indexOf("cargo build --bin vPaste --features winui-debug"));
        expect(launcher.slice(build)).toMatch(/\$LASTEXITCODE -ne 0\)\s*\{\s*throw/);
        const cargoBuild = launcher.indexOf("cargo build --bin vPaste --features winui-debug");
        expect(launcher.slice(cargoBuild, launcher.indexOf("$Exe =")))
            .toMatch(/\$LASTEXITCODE -ne 0\)\s*\{\s*throw/);
    });

    it("does not synchronously query the Tauri UI from a native UI callback", () => {
        const bridge = readFileSync(resolve("src-tauri/src/winui_panel.rs"), "utf8");
        const callback = bridge.slice(bridge.indexOf('unsafe extern "C" fn panel_request('), bridge.indexOf("async fn query_history("));
        // Tauri getters wait for its event loop, which can be waiting for this
        // WinUI STA while showing the panel or switching views.
        expect(callback.includes("is_preview_window_visible(")).toBe(false);
    });

    it("handles preview keys before ListViewItem consumes Space", () => {
        const native = readFileSync(resolve("src-tauri/native-demo/windows/winui/WinUiPanel.cpp"), "utf8");
        const tunnel = native.indexOf("g_panel.history.PreviewKeyDown(");
        const bubble = native.indexOf("g_panel.history.KeyDown(");
        expect(tunnel).toBeGreaterThan(-1);
        expect(tunnel).toBeLessThan(bubble);
        expect(native.slice(tunnel, bubble)).toContain("HandlePreviewKey(");
        expect(native.slice(tunnel, bubble)).toContain("VirtualKey::Space");
        expect(native.slice(tunnel, bubble)).toContain("VirtualKey::Escape");
        expect(native.slice(bubble, native.indexOf("g_panel.history.SelectionChanged(")))
            .toContain("HandlePreviewKey(");
    });
});
