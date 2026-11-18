import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("WinUI keyboard and show-preference wiring", () => {
    const native = "src-tauri/native-demo/windows/winui/";
    it("builds one keyboard policy and synchronously applies existing settings", () => {
        const project = readFileSync(`${native}WinUiPanel.vcxproj`, "utf8");
        const build = readFileSync("src-tauri/build.rs", "utf8");
        for (const file of ["WinUiKeyboard.cpp", "WinUiKeyboard.h"]) {
            expect(project).toContain(file);
            expect(build).toContain(file);
        }
        const bridge = readFileSync("src-tauri/src/winui_panel.rs", "utf8");
        expect(bridge).toContain("vpaste_winui_set_behavior");
        expect(bridge).toContain("behavior::from_config(&crate::config::get())");
        const host = readFileSync(`${native}WinUiPanel.cpp`, "utf8");
        expect(host).toContain("SendMessageW(window, kSetBehavior");
        expect(host).toContain("NativeControlOwnsKeys(args.OriginalSource())");
        expect(host).toContain("root.PreviewKeyUp(");
        expect(host).toContain("g_panel.queueWindow->Show(g_dockedLayout.panelScale");
        expect(host).not.toContain("SetVisible(returnVisible, false)");
    });
    it("keeps shortcut policy local and projects settings without a new store or hook", () => {
        const policy = readFileSync(`${native}WinUiKeyboard.cpp`, "utf8");
        for (const forbidden of ["RegisterHotKey", "SetWindowsHookEx", "SendInput", "keybd_event", "SetKeyboardState"])
            expect(policy).not.toContain(forbidden);
        const settings = readFileSync("src-tauri/src/winui_panel/behavior.rs", "utf8");
        for (const field of ["retain_search_history", "retain_tab_position", "quick_input_enabled",
            "tab_quick_select_enabled", "paste_into_plain_text"])
            expect(settings).toContain(field);
        expect(settings).not.toContain("std::fs::write");
    });
});
