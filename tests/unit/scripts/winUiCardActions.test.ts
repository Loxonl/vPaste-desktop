import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("WinUI card action wiring", () => {
    const native = "src-tauri/native-demo/windows/winui/";
    it("builds the native menu/picker and preserves shared auxiliary editors", () => {
        const project = readFileSync(`${native}WinUiPanel.vcxproj`, "utf8");
        const build = readFileSync("src-tauri/build.rs", "utf8");
        for (const file of ["WinUiCardActions.cpp", "WinUiCardActions.h"]) {
            expect(project).toContain(file);
            expect(build).toContain(file);
        }
        const bridge = readFileSync("src-tauri/src/winui_panel.rs", "utf8");
        expect(bridge).toContain("crate::open_text_editor_window(");
        expect(bridge).toContain("crate::show_image_text_window(");
        expect(bridge).toContain("search::resolve(&query, label)");
        expect(bridge).toContain("hash.clone(), plain_text");
    });
    it("uses an owned OS save dialog without creating a main WebView or touching drag", () => {
        const picker = readFileSync(`${native}WinUiCardActions.cpp`, "utf8");
        for (const token of ["CLSID_FileSaveDialog", "dialog_->Show(owner_)", "FOS_OVERWRITEPROMPT",
            "FOS_STRICTFILETYPES", "modalBegin", "modalEnd", "generation != generation_"])
            expect(picker).toContain(token);
        for (const forbidden of ["WebView", "SetCursor(", "SendInput(", "SetWindowPos(", "DoDragDrop("])
            expect(picker).not.toContain(forbidden);
        const core = readFileSync("src-tauri/src/winui_panel/actions.rs", "utf8");
        for (const helper of ["color_variants", "open_containing_folder", "containing_folder_path",
            "record_text_history", "export_image_item", "reveal_file_in_folder"])
            expect(core).toContain(`${helper}(`);
    });
});
