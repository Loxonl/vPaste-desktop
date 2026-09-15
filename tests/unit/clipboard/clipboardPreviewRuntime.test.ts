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
    it("loads the full disk-backed text before opening its preview", async () => {
        const callbacks = options();
        const body = "long text\n".repeat(2000) + "THE END";
        const target = new Item(2, "long-text", ItemType.TextFile, "C:\\history\\data\\long-text", 0, undefined, body.slice(0, 1800));
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "plain_text_content") return body;
            return undefined;
        });
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(target);
        expect(tauri.invoke).toHaveBeenCalledWith("plain_text_content", { hash: "long-text" });
        expect(tauri.invoke).toHaveBeenLastCalledWith("show_preview_window", expect.objectContaining({ textContent: body }));
        expect(target.getPreviewContent()).toBe(body.slice(0, 1800));
    });

    it("reports a missing text body without opening a path-only preview", async () => {
        const callbacks = options();
        tauri.invoke.mockRejectedValue(new Error("history file missing"));
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(item(ItemType.TextFile));
        expect(tauri.invoke).toHaveBeenCalledWith("plain_text_content", { hash: "preview-hash" });
        expect(tauri.invoke).not.toHaveBeenCalledWith("show_preview_window", expect.anything());
        expect(callbacks.showToast).toHaveBeenCalledWith("clipboard.previewFailed", "error");
    });

    it.each([false, true])("ignores an obsolete text read (reject: %s)", async reject => {
        const callbacks = options();
        let finish: () => void = () => undefined;
        tauri.invoke.mockImplementation((command: string) => {
            if (command === "plain_text_content") return new Promise((resolve, fail) => {
                finish = () => reject ? fail(new Error("old read failed")) : resolve("old body");
            });
            return Promise.resolve(undefined);
        });
        const runtime = createClipboardPreviewRuntime(callbacks);
        const pending = runtime.openPreviewItem(item(ItemType.TextFile));
        await runtime.openPreviewItem(item());
        finish();
        await pending;
        expect(tauri.invoke.mock.calls.filter(([command]) => command === "show_preview_window")).toHaveLength(1);
        expect(callbacks.showToast).not.toHaveBeenCalled();
    });

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

    it.each([
        [
            "oversized static image",
            {
                width: 0,
                height: 0,
                isGif: false,
                sourceBytes: 48 * 1024 * 1024,
                previewLimited: true,
                animationLimited: false,
            },
        ],
        [
            "oversized animated GIF",
            {
                width: 96,
                height: 64,
                isGif: true,
                sourceBytes: 24 * 1024 * 1024,
                previewLimited: false,
                animationLimited: true,
            },
        ],
    ])("blocks %s preview before the full image is read", async (_name, metadata) => {
        const callbacks = options();
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "history_image_metadata") return metadata;
            if (command === "hide_preview_window") return undefined;
            throw new Error("Unexpected command: " + command);
        });
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item(ItemType.Image));

        expect(tauri.invoke).toHaveBeenNthCalledWith(1, "history_image_metadata", {
            path: "content",
        });
        expect(tauri.invoke).toHaveBeenNthCalledWith(2, "hide_preview_window");
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            "show_preview_window",
            expect.anything(),
        );
        expect(callbacks.showToast).toHaveBeenCalledWith(
            "clipboard.resourceLimitedPreview",
            "warning",
        );
    });

    it("keeps opening ordinary images after the budget check passes", async () => {
        const callbacks = options();
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "history_image_metadata") {
                return {
                    width: 640,
                    height: 480,
                    isGif: false,
                    sourceBytes: 128 * 1024,
                    previewLimited: false,
                    animationLimited: false,
                };
            }
            if (command === "show_preview_window") return undefined;
            throw new Error("Unexpected command: " + command);
        });
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item(ItemType.Image));

        expect(tauri.invoke).toHaveBeenNthCalledWith(1, "history_image_metadata", {
            path: "content",
        });
        expect(tauri.invoke).toHaveBeenNthCalledWith(2, "show_preview_window", {
            itemType: ItemType.Image,
            content: "content",
            previewContent: "preview",
            textContent: "plain",
            richHtml: "<p>rich</p>",
            appSource: "source",
        });
        expect(callbacks.showToast).not.toHaveBeenCalled();
    });

    it("does not fall back to an unbounded preview when image metadata fails", async () => {
        const callbacks = options();
        tauri.invoke.mockRejectedValue(new Error("metadata unavailable"));
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item(ItemType.Image));

        expect(tauri.invoke).toHaveBeenCalledOnce();
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            "show_preview_window",
            expect.anything(),
        );
        expect(callbacks.showToast).toHaveBeenCalledWith(
            "clipboard.previewUnsupported",
            "warning",
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
