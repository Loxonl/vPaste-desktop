import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const native = readFileSync("src-tauri/native-demo/windows/winui/WinUiQueueView.cpp", "utf8");
const reference = readFileSync("src/clipboard/PasteQueue.tsx", "utf8");
const commands = readFileSync("src-tauri/src/main.rs", "utf8");

describe("native queue feedback follows the shipping queue", () => {
    it("keeps busy state quiet instead of inserting a working message on every action", () => {
        expect(reference).not.toContain("Working…");
        expect(native).not.toContain('Text(L"正在处理…", L"Working…")');
    });

    it("uses a named text action for Undo outside the scrollable queue rows", () => {
        expect(reference).toContain('actionLabel={t("pasteQueue.undo")}');
        expect(native).toContain('L"queue-undo"');
        expect(native).toContain("Grid::SetRow(undoToast, 3)");
        expect(native).not.toContain("undo = AppBarButton{}");
    });

    it("prepares click targets only for queue-window input and relies on the owned queue window staying visible", () => {
        const prepare = commands.slice(commands.indexOf("fn prepare_paste_queue_click_target("), commands.indexOf("fn wait_for_empty_paste_queue_capture("));
        const paste = commands.slice(commands.indexOf("fn process_paste_queue_request_inner("), commands.indexOf("fn process_paste_queue_request("));
        expect(prepare.indexOf("should_prepare_paste_queue_click_target(origin,")).toBeLessThan(prepare.indexOf("if winui_queue_ui_enabled()"));
        expect(paste).not.toContain("show_queue_no_activate()");
    });
});
