import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClipboardItemActions } from "../../../src/clipboard/clipboardItemActions";
import { Item, ItemType, type ItemTag } from "../../../src/clipboard/Item";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const dialog = vi.hoisted(() => ({ save: vi.fn() }));
const paths = vi.hoisted(() => ({ desktop: vi.fn(), download: vi.fn() }));
const platform = vi.hoisted(() => ({ isMac: vi.fn() }));
const logger = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialog.save }));
vi.mock("@tauri-apps/api/path", () => ({
    desktopDir: paths.desktop,
    downloadDir: paths.download,
}));
vi.mock("../../../src/shortcutDisplay", () => ({
    isMacPlatform: platform.isMac,
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: logger.error }));

function item({
    favorite = false,
    tags = [],
    type = ItemType.Text,
    content = "content",
    previewContent = "",
}: {
    favorite?: boolean;
    tags?: ItemTag[];
    type?: ItemType;
    content?: string;
    previewContent?: string;
} = {}) {
    return new Item(
        1,
        "item-hash",
        type,
        content,
        0,
        undefined,
        previewContent,
        "",
        favorite ? 1 : 0,
        "",
        "",
        "",
        tags,
    );
}

function options() {
    return {
        closeContextMenu: vi.fn(),
        hideWindow: vi.fn(async () => undefined),
        onDelete: vi.fn(),
        refreshHistory: vi.fn(async () => undefined),
        showToast: vi.fn(),
        t: vi.fn((key: string) => key),
        updateItemTags: vi.fn(),
    };
}

describe("clipboard item actions", () => {
    beforeEach(() => {
        localStorage.clear();
        tauri.invoke.mockReset();
        dialog.save.mockReset();
        paths.desktop.mockReset().mockResolvedValue("C:\\Users\\me\\Desktop");
        paths.download.mockReset().mockResolvedValue("/Users/me/Downloads");
        platform.isMac.mockReset().mockReturnValue(false);
        logger.error.mockReset();
    });

    it("updates favorite through the established command and refreshes history", async () => {
        const callbacks = options();
        tauri.invoke.mockResolvedValue(undefined);
        const actions = createClipboardItemActions(callbacks);

        await actions.toggleFavorite(item());

        expect(callbacks.closeContextMenu).toHaveBeenCalledOnce();
        expect(tauri.invoke).toHaveBeenCalledWith("set_item_favorite", {
            hash: "item-hash",
            favorite: true,
        });
        expect(callbacks.refreshHistory).toHaveBeenCalledOnce();
        expect(callbacks.showToast).toHaveBeenCalledWith(
            "clipboard.favoriteAdded",
        );
    });

    it("assigns and removes tags only after backend commands succeed", async () => {
        const callbacks = options();
        const first = { id: 1, name: "First" };
        const second = { id: 2, name: "Second" };
        const target = item({ tags: [first] });
        tauri.invoke.mockResolvedValue(undefined);
        const actions = createClipboardItemActions(callbacks);

        await actions.assignExistingTag(target, second);
        await actions.removeAssignedTag(target, first);

        expect(callbacks.updateItemTags).toHaveBeenNthCalledWith(
            1,
            target,
            [first, second],
        );
        expect(callbacks.updateItemTags).toHaveBeenNthCalledWith(
            2,
            target,
            [],
        );
    });

    it("keeps local deletion state unchanged when the command fails", async () => {
        const callbacks = options();
        const failure = new Error("delete failed");
        tauri.invoke.mockRejectedValue(failure);
        const actions = createClipboardItemActions(callbacks);

        await actions.deleteClipboardItem(item());

        expect(callbacks.onDelete).not.toHaveBeenCalled();
        expect(callbacks.showToast).toHaveBeenCalledWith(
            "clipboard.deleteFailed",
            "error",
        );
        expect(logger.error).toHaveBeenCalledWith(
            `Failed to delete clipboard item: ${failure}`,
        );
    });

    it("exports an image, restores blur handling, reveals it, then hides", async () => {
        const callbacks = options();
        const target = item({
            type: ItemType.Image,
            content: "C:\\cache\\image.png",
        });
        dialog.save.mockResolvedValue("C:\\Exports\\image.png");
        tauri.invoke.mockResolvedValue(undefined);
        const actions = createClipboardItemActions(callbacks);

        await actions.exportImageItem(target);

        expect(tauri.invoke).toHaveBeenCalledWith("export_image_item", {
            sourcePath: "C:\\cache\\image.png",
            targetPath: "C:\\Exports\\image.png",
        });
        expect(tauri.invoke).toHaveBeenCalledWith(
            "set_clipboard_blur_hide_suppressed",
            { suppressed: false },
        );
        expect(tauri.invoke).toHaveBeenCalledWith("reveal_file_in_folder", {
            path: "C:\\Exports\\image.png",
        });
        expect(callbacks.hideWindow).toHaveBeenCalledOnce();
        expect(localStorage.getItem("vpaste.imageExportDir.v1"))
            .toBe("C:\\Exports");
    });
});
