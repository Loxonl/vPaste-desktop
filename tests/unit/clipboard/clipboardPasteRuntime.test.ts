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

    it("shows the copy-only fallback when native paste fails", async () => {
        const target = item();
        const callbacks = options([target]);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") {
                return { granted: true, needs_settings: false };
            }
            if (command === "paste") {
                throw new Error("native paste failed");
            }
            return undefined;
        });
        const runtime = createClipboardPasteRuntime(callbacks);

        await runtime.pasteItem(target.getHash());

        expect(tauri.invoke).toHaveBeenCalledWith(
            "show_paste_fallback_notice",
        );
        expect(callbacks.refreshHistory).not.toHaveBeenCalled();
        expect(callbacks.showToast).toHaveBeenCalledWith(
            "clipboard.actionFailed",
            "error",
        );
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

    it("pastes a large text item entirely in the backend without transferring its body", async () => {
        const target = item(ItemType.TextFile, "file.txt", "");
        const callbacks = options([target]);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") {
                return { granted: true, needs_settings: false };
            }
            return undefined;
        });
        const runtime = createClipboardPasteRuntime(callbacks);

        await runtime.pasteItem(target.getHash());

        expect(tauri.invoke).toHaveBeenCalledWith("copy_history_item", {
            hash: "item-hash",
            plainText: false,
        });
        expect(tauri.invoke).not.toHaveBeenCalledWith("plain_text_content", expect.anything());
        expect(tauri.invoke).not.toHaveBeenCalledWith("copy", expect.anything());
        expect(tauri.invoke).toHaveBeenCalledWith("paste", {
            hash: "item-hash",
            restoreAlt: false,
            triggerKey: "",
        });
    });

    it("pastes the plain-text projection through the same backend-only path", async () => {
        const target = item(ItemType.TextFile, "file.txt", "");
        const callbacks = options([target]);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") {
                return { granted: true, needs_settings: false };
            }
            return undefined;
        });
        const runtime = createClipboardPasteRuntime(callbacks);

        await runtime.pastePlainTextItem(target);

        expect(callbacks.closeContextMenu).toHaveBeenCalledOnce();
        expect(tauri.invoke).toHaveBeenCalledWith("copy_history_item", {
            hash: "item-hash",
            plainText: true,
        });
        expect(tauri.invoke).not.toHaveBeenCalledWith("plain_text_content", expect.anything());
        expect(tauri.invoke).not.toHaveBeenCalledWith("copy", expect.anything());
        expect(tauri.invoke).toHaveBeenCalledWith("paste", {
            hash: "item-hash",
            triggerKey: "",
        });
    });
});
