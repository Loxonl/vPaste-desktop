import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("WinUI history viewport wiring", () => {
    const directory = "src-tauri/native-demo/windows/winui/";
    it("builds viewport policy and projects the existing position setting", () => {
        const project = readFileSync(`${directory}WinUiPanel.vcxproj`, "utf8");
        const build = readFileSync("src-tauri/build.rs", "utf8");
        for (const file of ["WinUiHistoryViewport.cpp", "WinUiHistoryViewport.h"]) {
            expect(project).toContain(file);
            expect(build).toContain(file);
        }
        expect(readFileSync("src-tauri/src/winui_panel/behavior.rs", "utf8"))
            .toContain('"retainPosition":config.retain_last_position');
    });
    it("keeps scroll ownership native with guarded incremental loading", () => {
        const host = readFileSync(`${directory}WinUiPanel.cpp`, "utf8");
        for (const token of ["g_panel.historyScroll.ChangeView(", "scroll.ViewChanged(winrt::auto_revoke",
            "g_historyView.lastAutoCursor == cursor", "g_hasMore && !g_historyLoading",
            "sameRange ? g_hashes.size() : 0",
            "ScrollViewer::SetVerticalScrollBarVisibility(g_panel.history, ScrollBarVisibility::Disabled)"])
            expect(host).toContain(token);
        const policy = readFileSync(`${directory}WinUiHistoryViewport.cpp`, "utf8");
        for (const forbidden of ["SendInput", "SetWindowsHookEx", "SetCursor", "RegisterHotKey", "Transform("])
            expect(policy).not.toContain(forbidden);
    });
});
