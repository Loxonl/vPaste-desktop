import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClipboardPasteRuntime } from "../../../src/clipboard/clipboardPasteRuntime";
import { Item, ItemType } from "../../../src/clipboard/Item";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const logger = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: logger.error }));

function item(
    type: ItemType = ItemType.Text,
    content = "content",
    textContent = "plain content",
) {
    return new Item(
        1,
        "item-hash",
        type,
        content,
        0,
        undefined,
        "",
        textContent,
    );
}

function options(items: Item[]) {
    return {
        closeContextMenu: vi.fn(),
        getItems: vi.fn(() => items),
        hideWindow: vi.fn(async () => undefined),
        refreshHistory: vi.fn(async () => undefined),
        selectItem: vi.fn(),
        showToast: vi.fn(),
        t: vi.fn((key: string) => key),
    };
}

describe("clipboard paste runtime", () => {
    beforeEach(() => {
        tauri.invoke.mockReset();
        logger.error.mockReset();
    });

    it("validates file sources and stops before copying missing files", async () => {
        const target = item(ItemType.File, "missing.txt");
        const callbacks = options([target]);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") {
                return { granted: true, needs_settings: false };
            }
            if (command === "validate_file_item") return ["C:\\missing.txt"];
            return undefined;
        });
        const runtime = createClipboardPasteRuntime(callbacks);

        await runtime.pasteItem(target.getHash());

        expect(callbacks.showToast).toHaveBeenCalledWith(
            "clipboard.sourceMissingOne",
            "warning",
        );
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            "copy",
            expect.anything(),
        );
        expect(callbacks.hideWindow).not.toHaveBeenCalled();
    });

    it("copies and pastes after hiding when accessibility is available", async () => {
        const target = item();
        const callbacks = options([target]);
        const calls: string[] = [];
        callbacks.hideWindow.mockImplementation(async () => {
            calls.push("hide");
        });
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") {
                return { granted: true, needs_settings: false };
            }
            calls.push(command);
            return undefined;
        });
        const runtime = createClipboardPasteRuntime(callbacks);

        await runtime.pasteItem(target.getHash());

        expect(calls).toEqual(["copy", "hide", "paste"]);
        expect(tauri.invoke).toHaveBeenCalledWith("paste", {
            hash: "item-hash",
            restoreAlt: false,
            triggerKey: "",
        });
        expect(callbacks.refreshHistory).toHaveBeenCalledOnce();
    });

    it("uses the copy-only fallback when accessibility is unavailable", async () => {
        const target = item();
        const callbacks = options([target]);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") {
                return { granted: false, needs_settings: true };
            }
            return undefined;
        });
        const runtime = createClipboardPasteRuntime(callbacks);

        await runtime.pasteItem(target.getHash());

        expect(tauri.invoke).toHaveBeenCalledWith("copy", {
            item: "content",
            itemType: "Text",
            hash: "item-hash",
        });
        expect(tauri.invoke).toHaveBeenCalledWith("show_paste_fallback_notice");
        expect(tauri.invoke).toHaveBeenCalledWith("restore_foreground_app");
        expect(tauri.invoke).not.toHaveBeenCalledWith("paste", expect.anything());
        expect(callbacks.hideWindow).toHaveBeenCalledOnce();
    });

    it("pastes the backend plain-text projection without recording a new hash", async () => {
        const target = item(ItemType.TextFile, "file.txt", "");
        const callbacks = options([target]);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") {
                return { granted: true, needs_settings: false };
            }
            if (command === "plain_text_content") return "file body";
            return undefined;
        });
        const runtime = createClipboardPasteRuntime(callbacks);

        await runtime.pastePlainTextItem(target);

        expect(callbacks.closeContextMenu).toHaveBeenCalledOnce();
        expect(tauri.invoke).toHaveBeenCalledWith("copy", {
            item: "file body",
            itemType: "Text",
            hash: null,
        });
        expect(tauri.invoke).toHaveBeenCalledWith("paste", {
            hash: "item-hash",
            triggerKey: "",
        });
    });
});
