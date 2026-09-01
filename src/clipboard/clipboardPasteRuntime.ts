import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import { Item, ItemType } from "./Item";
import { compactPath, getBackendTypeLabel } from "./itemPresentation";

type Translate = (
    key: string,
    params?: Record<string, string | number>,
) => string;

type PasteAccessibilityPermissionStatus = {
    granted: boolean;
    needs_settings: boolean;
};

type PasteCommandArgs = {
    hash: string;
    restoreAlt?: boolean;
    triggerKey: string;
};

type ClipboardPasteRuntimeOptions = {
    closeContextMenu: () => void;
    getItems: () => Item[];
    hideWindow: () => Promise<void>;
    refreshHistory: () => Promise<void>;
    selectItem: (hash: string) => void;
    showToast: (
        message: string,
        kind?: "info" | "warning" | "error",
    ) => void;
    t: Translate;
};

export function createClipboardPasteRuntime(
    options: ClipboardPasteRuntimeOptions,
) {
    const checkAccessibilityPermission = async (): Promise<boolean> => {
        try {
            const status = await invoke<PasteAccessibilityPermissionStatus>(
                "check_paste_accessibility_permission",
            );
            return status.granted;
        } catch (permissionError) {
            error(
                `Failed to check Accessibility permission: ${permissionError}`,
            );
            return false;
        }
    };

    const waitForQuickInputModifierRelease = async (
        triggerKey: string,
        timeoutMs: number = 3000,
    ): Promise<boolean> => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            try {
                const pressed = await invoke<boolean>(
                    "is_quick_input_modifier_pressed",
                    { triggerKey },
                );
                if (!pressed) return true;
            } catch (modifierError) {
                error(
                    `Failed to wait for quick input modifier release: ${modifierError}`,
                );
                return false;
            }
            await new Promise(resolve => window.setTimeout(resolve, 16));
        }
        return false;
    };

    const showPasteFallbackNotice = async () => {
        await invoke("show_paste_fallback_notice").catch(noticeError => {
            error(`Failed to show paste fallback notice: ${noticeError}`);
        });
    };

    const invokePaste = async (args: PasteCommandArgs) => {
        try {
            await invoke("paste", args);
        } catch (pasteError) {
            await showPasteFallbackNotice();
            throw pasteError;
        }
    };

    const finishCopyWithoutAutoPaste = async () => {
        await showPasteFallbackNotice();
        try {
            await options.hideWindow();
        } finally {
            await invoke("restore_foreground_app").catch(restoreError => {
                error(`Failed to restore foreground app: ${restoreError}`);
            });
        }
    };

    const pasteItem = async (
        hash: string,
        plainText: boolean = false,
        restoreAlt: boolean = false,
        triggerKey: string = "",
    ) => {
        const hasPermission = await checkAccessibilityPermission();
        const item = options.getItems().find(candidate =>
            candidate.getHash() === hash
        );
        if (!item) return;

        options.selectItem(hash);
        let content = item.getContent();
        let itemType = getBackendTypeLabel(item.getType());
        const copyFromHistory = item.getType() === ItemType.TextFile;
        if (plainText && item.getTextContent()) {
            content = item.getTextContent();
            itemType = "Text";
        } else if (item.getType() === ItemType.Link) {
            content = content.split("|||")[0];
        } else if (item.getType() === ItemType.File) {
            const missingPaths = await invoke<string[]>("validate_file_item", {
                content,
            });
            if (missingPaths.length > 0) {
                const message = missingPaths.length === 1
                    ? options.t("clipboard.sourceMissingOne", {
                        path: compactPath(missingPaths[0], 46),
                    })
                    : options.t("clipboard.sourceMissingMany", {
                        path: compactPath(missingPaths[0], 42),
                    });
                options.showToast(message, "warning");
                return;
            }
        }

        try {
            const copyHash = plainText ? null : hash;
            if (restoreAlt) {
                await waitForQuickInputModifierRelease(triggerKey);
            }
            if (copyFromHistory) {
                await invoke("copy_history_item", {
                    hash: item.getHash(),
                    plainText,
                });
                if (hasPermission) {
                    await options.hideWindow();
                }
            } else if (itemType === "Image" && hasPermission) {
                const hidePromise = options.hideWindow();
                await invoke("copy", { item: content, itemType, hash: copyHash });
                await hidePromise;
            } else {
                await invoke("copy", { item: content, itemType, hash: copyHash });
                if (hasPermission) {
                    await options.hideWindow();
                }
            }
            if (!hasPermission) {
                await finishCopyWithoutAutoPaste();
                return;
            }
            await invokePaste({ hash, restoreAlt, triggerKey });
            await options.refreshHistory();
        } catch (pasteError) {
            error(`Failed to copy/paste: ${pasteError}`);
            options.showToast(
                options.t("clipboard.actionFailed", {
                    error: String(pasteError),
                }),
                "error",
            );
        }
    };

    const pastePlainTextItem = async (item: Item) => {
        const hasPermission = await checkAccessibilityPermission();
        options.closeContextMenu();
        options.selectItem(item.getHash());
        try {
            await invoke("copy_history_item", {
                hash: item.getHash(),
                plainText: true,
            });
            if (!hasPermission) {
                await finishCopyWithoutAutoPaste();
                return;
            }
            await options.hideWindow();
            await invokePaste({ hash: item.getHash(), triggerKey: "" });
        } catch (pasteError) {
            error(`Failed to paste plain text: ${pasteError}`);
            options.showToast(
                options.t("clipboard.actionFailed", {
                    error: String(pasteError),
                }),
                "error",
            );
        }
    };

    return {
        pasteItem,
        pastePlainTextItem,
        waitForQuickInputModifierRelease,
    };
}
