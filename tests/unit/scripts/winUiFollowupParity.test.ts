import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const panel = read("src-tauri/native-demo/windows/winui/WinUiPanel.cpp");

describe("reviewed reference artwork and native window contracts", () => {
    it("uses both original toolbar SVG paths rather than a different settings font glyph", () => {
        const artwork = read("src-tauri/native-demo/windows/winui/WinUiHeaderArtwork.h");
        for (const name of ["SettingsOutlined", "PlaylistAddCheckRounded"]) {
            const source = read(`node_modules/@mui/icons-material/${name}.js`);
            expect(artwork.includes(source.match(/d: "([^"]+)"/)![1])).toBe(true);
            expect(panel.includes("HeaderArtwork::" + name)).toBe(true);
        }
        expect(artwork).toContain("scale.ScaleX(size / 24.0)");
        expect(artwork).toContain("icon.Data().Transform(scale)");
        expect(panel).not.toContain("g_panel.settings.Icon(vpaste::winui::CompactSymbol(Symbol::Setting))");
    });
    it("keeps a cancellable animation object for a dragged tab instead of an unowned implicit transition", () => {
        const reset = panel.slice(panel.indexOf("void ResetTabDropOffsets()"), panel.indexOf("void BeginTabDropPreview("));
        expect(reset).toContain("tab.StopAnimation(");
        expect(reset).toContain('L"VPaste.TabDropAnimation"');
        const rebuild = panel.slice(panel.indexOf("void RebuildDynamicTabs()"), panel.indexOf("void ApplyFilters("));
        expect(rebuild).not.toContain("g_panel.customTabs.Items().Clear()");
    });
    it("retains the styled WebView tray and avoids destroying it at every dismissal on Windows", () => {
        const main = read("src-tauri/src/main.rs");
        expect(main).not.toContain("winui_panel::tray::build");
        expect(main).toContain('App("tray-menu".into())');
        const hide = main.slice(main.indexOf("fn hide_tray_menu("), main.indexOf("fn resize_tray_menu("));
        expect(hide).toContain("window.hide()");
        expect(hide).toContain('#[cfg(not(target_os = "windows"))]');
    });
    it("uses the shipping file icon manifest and same special product glyphs", () => {
        const file = read("src-tauri/src/winui_panel/file_icons.rs");
        expect(file).toContain("node_modules/material-icon-theme/dist/material-icons.json");
        const web = read("src/clipboard/FileTypePresentation.tsx");
        for (const glyph of ["DOCUMENT_GLYPH_PATH", "FOLDER_GLYPH_PATH"]) {
            const path = web.match(new RegExp(`const ${glyph} = "([^"]+)"`))![1];
            expect(file).toContain(path);
        }
        expect(panel).toContain("row.dimensionsFrame.Visibility(row.dimensions.Visibility())");
        expect(panel).not.toContain("GetParent(row.dimensions)");
    });
    it("gives Windows caption dragging to WebView2 rather than a competing IPC move loop", () => {
        const config = read("src/config/Config.tsx");
        expect(config).toContain("nativeWindowsSurface ? undefined :");
        expect(read("src/config/ConfigLayout.module.css")).toContain("-webkit-app-region: drag");
        expect(read("src-tauri/src/main.rs")).not.toContain("config_window_drag::start_config_window_drag");
    });
});
