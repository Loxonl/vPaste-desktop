import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClipboardPreviewRuntime } from "../../../src/clipboard/clipboardPreviewRuntime";
import { Item, ItemType } from "../../../src/clipboard/Item";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const logger = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: logger.error }));

function item(type: ItemType = ItemType.Text) {
    return new Item(
        1,
        "preview-hash",
        type,
        "content",
        0,
        undefined,
        "preview",
        "plain",
        0,
        "source",
        "",
        "<p>rich</p>",
    );
}

function options() {
    return {
        closeContextMenu: vi.fn(),
        requestSequence: { current: 0 },
        selectItem: vi.fn(),
        showToast: vi.fn(),
        t: vi.fn((key: string) => key),
    };
}

describe("clipboard preview runtime", () => {
    beforeEach(() => {
        tauri.invoke.mockReset();
        logger.error.mockReset();
    });

    it("opens a preview with the full established item payload", async () => {
        const callbacks = options();
        tauri.invoke.mockResolvedValue(undefined);
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item());

        expect(callbacks.closeContextMenu).toHaveBeenCalledOnce();
        expect(callbacks.selectItem).toHaveBeenCalledWith("preview-hash");
        expect(tauri.invoke).toHaveBeenCalledWith("show_preview_window", {
            itemType: ItemType.Text,
            content: "content",
            previewContent: "preview",
            textContent: "plain",
            richHtml: "<p>rich</p>",
            appSource: "source",
        });
    });

    it("shows the established unsupported notice for non-previewable files", async () => {
        const callbacks = options();
        tauri.invoke.mockResolvedValue({ kind: "unsupported" });
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item(ItemType.File));

        expect(callbacks.showToast).toHaveBeenCalledWith(
            "clipboard.previewUnsupported",
            "warning",
        );
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            "show_preview_window",
            expect.anything(),
        );
    });

    it("does not let an older file request open after a newer request wins", async () => {
        const callbacks = options();
        let resolveFileInfo: (value: unknown) => void = () => undefined;
        tauri.invoke.mockImplementation((command: string) => {
            if (command === "file_preview_info") {
                return new Promise(resolve => {
                    resolveFileInfo = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        const runtime = createClipboardPreviewRuntime(callbacks);
        const first = runtime.openPreviewItem(item(ItemType.File));
        await runtime.openPreviewItem(item());
        resolveFileInfo({ kind: "single-preview", preview_path: "C:\\file.png" });
        await first;

        expect(tauri.invoke).toHaveBeenCalledTimes(2);
        expect(tauri.invoke).toHaveBeenLastCalledWith("show_preview_window", {
            itemType: ItemType.Text,
            content: "content",
            previewContent: "preview",
            textContent: "plain",
            richHtml: "<p>rich</p>",
            appSource: "source",
        });
    });

    it("hides an existing preview without opening another one", async () => {
        const callbacks = options();
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "is_preview_window_visible") return true;
            return undefined;
        });
        const runtime = createClipboardPreviewRuntime(callbacks);

        runtime.togglePreview(item());
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("hide_preview_window");
        });

        expect(callbacks.requestSequence.current).toBe(1);
    });
});
