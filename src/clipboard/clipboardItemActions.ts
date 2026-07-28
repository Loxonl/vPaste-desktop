import { invoke } from "@tauri-apps/api/core";
import { desktopDir, downloadDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { error } from "@tauri-apps/plugin-log";
import { isMacPlatform } from "../shortcutDisplay";
import { Item, type ItemTag } from "./Item";
import {
    dirName,
    imageExportSourcePath,
    joinPath,
} from "./itemPresentation";
import { assignItemTag, removeItemTag } from "./clipboardTags";

const IMAGE_EXPORT_DIR_KEY = "vpaste.imageExportDir.v1";

type Translate = (
    key: string,
    params?: Record<string, string | number>,
) => string;

type ClipboardItemActionsOptions = {
    closeContextMenu: () => void;
    hideWindow: () => Promise<void>;
    onDelete: (item: Item) => void;
    refreshHistory: () => Promise<void>;
    showToast: (
        message: string,
        kind?: "info" | "warning" | "error",
    ) => void;
    t: Translate;
    updateItemTags: (item: Item, tags: ItemTag[]) => void;
};

export function createClipboardItemActions(
    options: ClipboardItemActionsOptions,
) {
    const actionFailed = (actionError: unknown) => {
        options.showToast(
            options.t("clipboard.actionFailed", {
                error: String(actionError),
            }),
            "error",
        );
    };

    const toggleFavorite = async (item: Item) => {
        options.closeContextMenu();
        const favorite = !item.isFavorite();
        try {
            await invoke("set_item_favorite", {
                hash: item.getHash(),
                favorite,
            });
            options.showToast(
                favorite
                    ? options.t("clipboard.favoriteAdded")
                    : options.t("clipboard.favoriteRemoved"),
            );
            await options.refreshHistory();
        } catch (actionError) {
            error(`Failed to update favorite: ${actionError}`);
            actionFailed(actionError);
        }
    };

    const assignExistingTag = async (item: Item, tag: ItemTag) => {
        options.closeContextMenu();
        try {
            await invoke("assign_item_tag", {
                hash: item.getHash(),
                tagId: tag.id,
            });
            options.updateItemTags(
                item,
                assignItemTag(item.getTags(), tag),
            );
            options.showToast(options.t("tags.assigned", { name: tag.name }));
        } catch (actionError) {
            actionFailed(actionError);
        }
    };

    const removeAllAssignedTags = async (item: Item) => {
        options.closeContextMenu();
        try {
            await Promise.all(item.getTags().map(tag =>
                invoke("remove_item_tag", {
                    hash: item.getHash(),
                    tagId: tag.id,
                }),
            ));
            options.updateItemTags(item, []);
            options.showToast(options.t("tags.removedAll"));
        } catch (actionError) {
            actionFailed(actionError);
        }
    };

    const removeAssignedTag = async (item: Item, tag: ItemTag) => {
        options.closeContextMenu();
        try {
            await invoke("remove_item_tag", {
                hash: item.getHash(),
                tagId: tag.id,
            });
            options.updateItemTags(
                item,
                removeItemTag(item.getTags(), tag.id),
            );
            options.showToast(options.t("tags.removed", { name: tag.name }));
        } catch (actionError) {
            actionFailed(actionError);
        }
    };

    const deleteClipboardItem = async (item: Item) => {
        options.closeContextMenu();
        try {
            await invoke("delete_clipboard_item", { hash: item.getHash() });
            options.onDelete(item);
            options.showToast(options.t("clipboard.recordDeleted"));
        } catch (actionError) {
            error(`Failed to delete clipboard item: ${actionError}`);
            options.showToast(
                options.t("clipboard.deleteFailed", {
                    error: String(actionError),
                }),
                "error",
            );
        }
    };

    const exportImageItem = async (item: Item) => {
        options.closeContextMenu();
        const sourcePath = imageExportSourcePath(item);
        if (!sourcePath) {
            options.showToast(
                options.t("clipboard.actionFailed", {
                    error: options.t("clipboard.exportImageNoSource"),
                }),
                "error",
            );
            return;
        }

        try {
            const cachedDir = localStorage.getItem(IMAGE_EXPORT_DIR_KEY) || "";
            const fallbackDir = isMacPlatform()
                ? await downloadDir()
                : await desktopDir();
            const defaultDir = cachedDir || fallbackDir;
            const defaultPath = joinPath(
                defaultDir,
                `vpaste-image-${Date.now()}.png`,
            );
            await invoke("set_clipboard_blur_hide_suppressed", {
                suppressed: true,
            }).catch(suppressError => {
                error(
                    `Failed to suppress clipboard blur hide: ${suppressError}`,
                );
            });
            const targetPath = await save({
                defaultPath,
                filters: [
                    { name: "PNG Image", extensions: ["png"] },
                    { name: "JPEG Image", extensions: ["jpg", "jpeg"] },
                    { name: "WebP Image", extensions: ["webp"] },
                    { name: "Bitmap Image", extensions: ["bmp"] },
                ],
            }).finally(() => {
                void invoke("set_clipboard_blur_hide_suppressed", {
                    suppressed: false,
                }).catch(restoreError => {
                    error(
                        `Failed to restore clipboard blur hide: ${restoreError}`,
                    );
                });
            });
            if (!targetPath) return;

            await invoke("export_image_item", { sourcePath, targetPath });
            const nextDir = dirName(targetPath);
            if (nextDir) {
                localStorage.setItem(IMAGE_EXPORT_DIR_KEY, nextDir);
            }
            try {
                await invoke("reveal_file_in_folder", { path: targetPath });
            } catch (revealError) {
                error(`Failed to reveal exported image file: ${revealError}`);
                actionFailed(revealError);
                return;
            }
            await options.hideWindow();
            options.showToast(options.t("clipboard.imageExported"));
        } catch (actionError) {
            error(`Failed to export image item: ${actionError}`);
            actionFailed(actionError);
        }
    };

    const openContainingFolder = async (item: Item) => {
        options.closeContextMenu();
        try {
            await invoke("open_containing_folder", {
                content: item.getContent(),
            });
        } catch (actionError) {
            error(`Failed to open containing folder: ${actionError}`);
            actionFailed(actionError);
        }
    };

    const copyContainingFolderPath = async (item: Item) => {
        options.closeContextMenu();
        try {
            const path = await invoke<string>("containing_folder_path", {
                content: item.getContent(),
            });
            await invoke("copy", { item: path, itemType: "Text", hash: null });
            await invoke("record_text_history", { content: path });
            await options.refreshHistory();
            options.showToast(options.t("clipboard.folderCopied"));
        } catch (actionError) {
            error(`Failed to copy containing folder path: ${actionError}`);
            actionFailed(actionError);
        }
    };

    const copyColorValue = async (value: string) => {
        options.closeContextMenu();
        try {
            await invoke("copy", { item: value, itemType: "Text", hash: null });
            await invoke("record_text_history", { content: value });
            await options.refreshHistory();
            options.showToast(options.t("clipboard.colorCopied", { value }));
        } catch (actionError) {
            error(`Failed to copy converted color: ${actionError}`);
            actionFailed(actionError);
        }
    };

    return {
        assignExistingTag,
        copyColorValue,
        copyContainingFolderPath,
        deleteClipboardItem,
        exportImageItem,
        openContainingFolder,
        removeAllAssignedTags,
        removeAssignedTag,
        toggleFavorite,
    };
}
