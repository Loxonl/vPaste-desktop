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
    it("delegates the bounded text read and truncation flag to Rust without reading the body in the main window", async () => {
        tauri.invoke.mockResolvedValue(undefined);
        await createClipboardPreviewRuntime(options()).openPreviewItem(item(ItemType.TextFile));
        expect(tauri.invoke).not.toHaveBeenCalledWith("plain_text_preview", expect.anything());
        expect(tauri.invoke).not.toHaveBeenCalledWith("plain_text_content", expect.anything());
        expect(tauri.invoke).toHaveBeenLastCalledWith("show_history_preview", { hash: "preview-hash", itemType: ItemType.TextFile });
    });
    it("refreshes keyboard selection without reopening or refocusing the preview", async () => {
        tauri.invoke.mockImplementation(async (command: string) => command === "is_preview_window_visible" ? true : undefined);
        createClipboardPreviewRuntime(options()).refreshPreviewIfVisible(item(), -1);
        await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("show_history_preview", expect.objectContaining({
            mode: "selection", navigationDirection: -1,
        })));
        expect(tauri.invoke).not.toHaveBeenCalledWith("hide_preview_window");
    });

    for (const outcome of ["limited", "failed"]) {
        it(`does not close an existing preview or toast during an automatic image selection (${outcome})`, async () => {
            const callbacks = options();
            if (outcome === "failed") tauri.invoke.mockRejectedValue(new Error("metadata unavailable"));
            else tauri.invoke.mockResolvedValue({ previewLimited: true });
            await createClipboardPreviewRuntime(callbacks).openPreviewItem(item(ItemType.Image), 0, "selection");
            expect(tauri.invoke).not.toHaveBeenCalledWith("hide_preview_window");
            expect(tauri.invoke).not.toHaveBeenCalledWith("show_history_preview", expect.anything());
            expect(callbacks.showToast).not.toHaveBeenCalled();
        });
    }

    it("uses the Space preview window command for hover links without fetching the webpage first", async () => {
        const callbacks = options();
        const link = new Item(1, "link-hash", ItemType.Link, "https://example.com/page", 0);
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(link, 0, "hover", 123);
        expect(tauri.invoke.mock.calls).toEqual([["show_history_preview", expect.objectContaining({
            hash: "link-hash", itemType: ItemType.Link, mode: "hover", hoverRequest: 123,
        })]]);
        expect(callbacks.selectItem).not.toHaveBeenCalled();
    });

    it("dismisses a disk-backed hover if the pointer leaves while Rust prepares it", async () => {
        let complete!: () => void;
        let valid = true;
        tauri.invoke.mockImplementation(async (command: string) => command === "show_history_preview"
            ? new Promise<void>(resolve => { complete = resolve; }) : undefined);
        const pending = createClipboardPreviewRuntime(options()).openPreviewItem(item(ItemType.TextFile), 0, "hover", 123, () => valid);
        valid = false; complete();
        await pending;
        expect(tauri.invoke).toHaveBeenCalledWith("dismiss_hover_preview_window", { request: 123 });
        expect(tauri.invoke).not.toHaveBeenCalledWith("plain_text_content", expect.anything());
    });

    it("opens hover content without changing selection or dismissing menus", async () => {
        const callbacks = options();
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(item(), 0, "hover", 123);
        expect(callbacks.selectItem).not.toHaveBeenCalled();
        expect(callbacks.closeContextMenu).not.toHaveBeenCalled();
        expect(tauri.invoke).toHaveBeenLastCalledWith("show_history_preview", expect.objectContaining({ mode: "hover", hoverRequest: 123 }));
    });

    it("updates an open preview without asking it to take focus on mouse selection", async () => {
        const callbacks = options();
        tauri.invoke.mockImplementation(async (command: string) => command === "is_preview_window_visible" ? true : undefined);
        createClipboardPreviewRuntime(callbacks).refreshPreviewIfVisible(item());
        await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("show_history_preview", expect.objectContaining({ mode: "selection" })));
    });

    it("does not toast or open a resource-limited hover image", async () => {
        const callbacks = options();
        tauri.invoke.mockResolvedValue({ previewLimited: true });
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(item(ItemType.Image), 0, "hover", 123);
        expect(callbacks.showToast).not.toHaveBeenCalled();
        expect(tauri.invoke).not.toHaveBeenCalledWith("hide_preview_window");
        expect(tauri.invoke).not.toHaveBeenCalledWith("show_history_preview", expect.anything());
    });

    it("asks Rust to prepare disk-backed text by hash without transferring its body", async () => {
        const callbacks = options();
        tauri.invoke.mockResolvedValue(undefined);
        const target = new Item(2, "long-text", ItemType.TextFile, "C:\\history\\long-text", 0, undefined, "short card preview");
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(target);
        expect(tauri.invoke).toHaveBeenLastCalledWith("show_history_preview", { hash: "long-text", itemType: ItemType.TextFile });
        expect(tauri.invoke).not.toHaveBeenCalledWith("plain_text_content", expect.anything());
        expect(target.getPreviewContent()).toBe("short card preview");
    });

    it("reports Rust's missing-body failure without sending a path-only preview", async () => {
        const callbacks = options();
        tauri.invoke.mockRejectedValue(new Error("history file missing"));
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(item(ItemType.TextFile));
        expect(tauri.invoke).toHaveBeenCalledWith("show_history_preview", { hash: "preview-hash", itemType: ItemType.TextFile });
        expect(tauri.invoke).not.toHaveBeenCalledWith("show_preview_window", expect.anything());
        expect(callbacks.showToast).toHaveBeenCalledWith("clipboard.previewFailed", "error");
    });

    it.each([false, true])("ignores obsolete Rust preview preparation (reject: %s)", async reject => {
        const callbacks = options();
        let finish: () => void = () => undefined;
        tauri.invoke.mockImplementation((command: string, args?: { itemType?: ItemType }) => {
            if (command === "show_history_preview" && args?.itemType === ItemType.TextFile) return new Promise((resolve, fail) => {
                finish = () => reject ? fail(new Error("old read failed")) : resolve(undefined);
            });
            return Promise.resolve(undefined);
        });
        const runtime = createClipboardPreviewRuntime(callbacks);
        const pending = runtime.openPreviewItem(item(ItemType.TextFile));
        await runtime.openPreviewItem(item());
        finish();
        await pending;
        expect(tauri.invoke.mock.calls.filter(([command]) => command === "show_history_preview")).toHaveLength(2);
        expect(callbacks.showToast).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        tauri.invoke.mockReset();
        logger.error.mockReset();
    });

    it("opens a preview by stable history identity", async () => {
        const callbacks = options();
        tauri.invoke.mockResolvedValue(undefined);
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item());

        expect(callbacks.closeContextMenu).toHaveBeenCalledOnce();
        expect(callbacks.selectItem).toHaveBeenCalledWith("preview-hash");
        expect(tauri.invoke).toHaveBeenCalledWith("show_history_preview", {
            hash: "preview-hash",
            itemType: ItemType.Text,
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
            "show_history_preview",
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
            "show_history_preview",
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
            if (command === "show_history_preview") return undefined;
            throw new Error("Unexpected command: " + command);
        });
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item(ItemType.Image));

        expect(tauri.invoke).toHaveBeenNthCalledWith(1, "history_image_metadata", {
            path: "content",
        });
        expect(tauri.invoke).toHaveBeenNthCalledWith(2, "show_history_preview", {
            hash: "preview-hash",
            itemType: ItemType.Image,
        });
        expect(callbacks.showToast).not.toHaveBeenCalled();
    });

    it("opens an animation-limited GIF so the native preview can show its static first frame", async () => {
        const callbacks = options();
        tauri.invoke.mockImplementation(async (command: string) => command === "history_image_metadata"
            ? { isGif: true, previewLimited: false, animationLimited: true } : undefined);
        await createClipboardPreviewRuntime(callbacks).openPreviewItem(item(ItemType.Image));
        expect(tauri.invoke).toHaveBeenCalledWith("show_history_preview", expect.objectContaining({ hash: "preview-hash", itemType: ItemType.Image }));
        expect(callbacks.showToast).not.toHaveBeenCalled();
    });

    it("does not fall back to an unbounded preview when image metadata fails", async () => {
        const callbacks = options();
        tauri.invoke.mockRejectedValue(new Error("metadata unavailable"));
        const runtime = createClipboardPreviewRuntime(callbacks);

        await runtime.openPreviewItem(item(ItemType.Image));

        expect(tauri.invoke).toHaveBeenCalledOnce();
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            "show_history_preview",
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
        expect(tauri.invoke).toHaveBeenLastCalledWith("show_history_preview", {
            hash: "preview-hash",
            itemType: ItemType.Text,
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
