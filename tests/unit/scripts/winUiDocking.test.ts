import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(path), "utf8");

describe("WinUI shipping-layout parity", () => {
    it("uses a borderless tool window and a scaled single-header carousel", () => {
        const native = source("src-tauri/native-demo/windows/winui/WinUiPanel.cpp");
        expect(native.includes("WS_EX_TOOLWINDOW | WS_EX_TOPMOST")).toBe(true);
        expect(native.includes("g_panel.viewport = Viewbox()")).toBe(true);
        expect(native.includes("constexpr double kCardWidth = 220")).toBe(true);
        expect(native.includes("constexpr double kCardHeight = 230")).toBe(true);
        expect(native.includes("g_panel.history.Footer(g_panel.more)")).toBe(true);
    });

    it("keeps queue and settings on the right with the existing settings command", () => {
        const native = source("src-tauri/native-demo/windows/winui/WinUiPanel.cpp");
        const bridge = source("src-tauri/src/winui_panel.rs");
        expect(native.includes("PrimaryCommands().Append(g_panel.queueOpen)")).toBe(true);
        expect(native.includes("PrimaryCommands().Append(g_panel.settings)")).toBe(true);
        expect(bridge.includes('"settings" => crate::open_config_window_from_source')).toBe(true);
    });

    it("calibrates the hidden native window DPI before its first visible show", () => {
        const layout = source("src-tauri/src/winui_panel/layout.rs");
        const beforeShow = layout.slice(layout.indexOf("pub(super) fn before_show"), layout.indexOf('#[link(name = "user32")]'));
        expect(beforeShow.indexOf("apply(bounds, panel_scale)?;")).toBeGreaterThanOrEqual(0);
        expect(beforeShow.indexOf("refresh(app)")).toBeGreaterThan(beforeShow.indexOf("apply(bounds, panel_scale)?;"));
        expect(layout.includes("GetDpiForWindow(window)")).toBe(true);
    });
});
