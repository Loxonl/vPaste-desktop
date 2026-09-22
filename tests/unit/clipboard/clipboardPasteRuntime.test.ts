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
        pasteInFlight: { current: false },
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

    const entries = ["ordinary", "quick", "plain"] as const;
    const startPaste = (
        runtime: ReturnType<typeof createClipboardPasteRuntime>,
        target: Item,
        entry: typeof entries[number],
    ) => entry === "plain"
        ? runtime.pastePlainTextItem(target)
        : runtime.pasteItem(target.getHash(), false, entry === "quick", entry === "quick" ? "1" : "");

    it.each(entries.flatMap(first => entries.map(second => [first, second] as const)))(
        "blocks overlapping %s / %s operations across renders and permits the next paste",
        async (firstEntry, secondEntry) => {
            const target = item();
            const callbacks = options([target]);
            let release!: () => void;
            const permission = new Promise<void>(resolve => { release = resolve; });
            tauri.invoke.mockImplementation(async (command: string) => {
                if (command === "check_paste_accessibility_permission") {
                    await permission;
                    return { granted: true };
                }
                return false;
            });
            const first = startPaste(createClipboardPasteRuntime(callbacks), target, firstEntry);
            const second = startPaste(createClipboardPasteRuntime(callbacks), target, secondEntry);
            release();
            await Promise.all([first, second]);
            expect(tauri.invoke.mock.calls.filter(([command]) => command === "check_paste_accessibility_permission")).toHaveLength(1);
            expect(tauri.invoke.mock.calls.filter(([command]) => command === "copy" || command === "copy_history_item")).toHaveLength(1);
            expect(tauri.invoke.mock.calls.filter(([command]) => command === "paste")).toHaveLength(1);
            await startPaste(createClipboardPasteRuntime(callbacks), target, secondEntry);
            expect(tauri.invoke.mock.calls.filter(([command]) => command === "paste")).toHaveLength(2);
        },
    );

    it("coalesces quick presses across runtime recreation and unlocks after completion", async () => {
        const target = item();
        const callbacks = options([target]);
        let release!: (pressed: boolean) => void;
        const held = new Promise<boolean>(resolve => { release = resolve; });
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") return { granted: true };
            if (command === "is_quick_input_modifier_pressed") return held;
        });
        const first = createClipboardPasteRuntime(callbacks).pasteItem(target.getHash(), false, true, "1");
        const second = createClipboardPasteRuntime(callbacks).pasteItem(target.getHash(), false, true, "1");
        release(false);
        await Promise.all([first, second]);
        expect(tauri.invoke.mock.calls.filter(([command]) => command === "paste")).toHaveLength(1);
        expect(callbacks.hideWindow).toHaveBeenCalledTimes(1);
        await createClipboardPasteRuntime(callbacks).pasteItem(target.getHash(), false, true, "1");
        expect(tauri.invoke.mock.calls.filter(([command]) => command === "paste")).toHaveLength(2);
    });

    it.each([ItemType.Text, ItemType.TextFile, ItemType.Image])(
        "hides quick input before waiting without changing the copy path for %s",
        async type => {
            const target = item(type);
            const callbacks = options([target]);
            const calls: string[] = [];
            callbacks.hideWindow.mockImplementation(async () => { calls.push("hide"); });
            tauri.invoke.mockImplementation(async (command: string) => {
                if (command === "check_paste_accessibility_permission") return { granted: true };
                calls.push(command);
                return false;
            });
            await createClipboardPasteRuntime(callbacks).pasteItem(target.getHash(), false, true, "1");
            expect(calls).toEqual([
                "hide", "is_quick_input_modifier_pressed",
                type === ItemType.TextFile ? "copy_history_item" : "copy", "paste",
            ]);
        },
    );

    it.each(entries)("keeps %s input locked during native paste and unlocks after failure", async entry => {
        const target = item();
        const callbacks = options([target]);
        let rejectPaste!: (reason: Error) => void;
        let pasteStarted!: () => void;
        const started = new Promise<void>(resolve => { pasteStarted = resolve; });
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") return { granted: true };
            if (command === "is_quick_input_modifier_pressed") return false;
            if (command === "paste") {
                pasteStarted();
                return new Promise<void>((_, reject) => { rejectPaste = reject; });
            }
        });
        const first = startPaste(createClipboardPasteRuntime(callbacks), target, entry);
        await started;
        await startPaste(createClipboardPasteRuntime(callbacks), target, entry);
        expect(tauri.invoke.mock.calls.filter(([command]) => command === "paste")).toHaveLength(1);
        rejectPaste(new Error("native paste failed"));
        await first;
        expect(callbacks.pasteInFlight.current).toBe(false);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") return { granted: true };
            return false;
        });
        await startPaste(createClipboardPasteRuntime(callbacks), target, entry);
        expect(tauri.invoke.mock.calls.filter(([command]) => command === "paste")).toHaveLength(2);
    });

    it("does not hide invalid quick input or leave it locked", async () => {
        const target = item(ItemType.File, "missing.txt");
        const callbacks = options([target]);
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "check_paste_accessibility_permission") return { granted: true };
            if (command === "validate_file_item") return ["missing.txt"];
        });
        const runtime = createClipboardPasteRuntime(callbacks);
        await runtime.pasteItem(target.getHash(), false, true, "1");
        await runtime.pasteItem("unknown-hash", false, true, "1");
        expect(callbacks.hideWindow).not.toHaveBeenCalled();
        expect(callbacks.pasteInFlight.current).toBe(false);
        expect(callbacks.showToast).toHaveBeenCalledWith("clipboard.sourceMissingOne", "warning");
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
