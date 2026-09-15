import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import { Item } from "./Item";
import type { FilePreviewInfo } from "./itemPresentation";

type Translate = (
    key: string,
    params?: Record<string, string | number>,
) => string;

type HistoryImageMetadata = {
    previewLimited?: boolean;
    animationLimited?: boolean;
};

type ClipboardPreviewRuntimeOptions = {
    closeContextMenu: () => void;
    requestSequence: { current: number };
    selectItem: (hash: string) => void;
    showToast: (
        message: string,
        kind?: "info" | "warning" | "error",
    ) => void;
    t: Translate;
};

export function createClipboardPreviewRuntime(
    options: ClipboardPreviewRuntimeOptions,
) {
    const openPreviewItem = async (
        item: Item,
        requestSeq: number = ++options.requestSequence.current,
    ) => {
        options.closeContextMenu();
        if (item.getType() === "File") {
            try {
                const info = await invoke<FilePreviewInfo>("file_preview_info", {
                    content: item.getContent(),
                });
                if (requestSeq !== options.requestSequence.current) return;
                const previewableFile = (
                    info.kind === "single-preview" && !!info.preview_path
                ) || info.kind === "pdf-preview" || info.kind === "text-preview";
                const simpleFileInfo = info.kind === "multiple"
                    || info.kind === "single-folder"
                    || info.kind === "single-icon";
                if (!previewableFile && !simpleFileInfo) {
                    options.showToast(options.t("clipboard.previewUnsupported"), "warning");
                    return;
                }
            } catch (previewError) {
                error(`Failed to prepare file preview: ${previewError}`);
                options.showToast(options.t("clipboard.previewUnsupported"), "warning");
                return;
            }
        }
        if (item.getType() === "Image") {
            try {
                const metadata = await invoke<HistoryImageMetadata>(
                    "history_image_metadata",
                    { path: item.getContent() },
                );
                if (requestSeq !== options.requestSequence.current) return;
                if (metadata.previewLimited || metadata.animationLimited) {
                    try {
                        await invoke("hide_preview_window");
                    } catch (previewError) {
                        error("Failed to close resource-limited preview: " + previewError);
                    }
                    options.showToast(
                        options.t("clipboard.resourceLimitedPreview"),
                        "warning",
                    );
                    return;
                }
            } catch (previewError) {
                error("Failed to check image preview budget: " + previewError);
                if (requestSeq !== options.requestSequence.current) return;
                options.showToast(
                    options.t("clipboard.previewUnsupported"),
                    "warning",
                );
                return;
            }
        }
        if (requestSeq !== options.requestSequence.current) return;
        options.selectItem(item.getHash());
        try {
            const textContent = item.getType() === "TextFile"
                ? await invoke<string>("plain_text_content", { hash: item.getHash() })
                : item.getTextContent();
            if (requestSeq !== options.requestSequence.current) return;
            await invoke("show_preview_window", {
                itemType: item.getType(),
                content: item.getContent(),
                previewContent: item.getPreviewContent(),
                textContent,
                richHtml: item.getRichHtml(),
                appSource: item.getAppSource(),
            });
        } catch (previewError) {
            if (requestSeq !== options.requestSequence.current) return;
            error(`Failed to open preview: ${previewError}`);
            options.showToast(
                options.t("clipboard.previewFailed", {
                    error: String(previewError),
                }),
                "error",
            );
        }
    };

    const refreshPreviewIfVisible = (item: Item) => {
        const requestSeq = ++options.requestSequence.current;
        void invoke<boolean>("is_preview_window_visible")
            .then(visible => {
                if (!visible || requestSeq !== options.requestSequence.current) {
                    return;
                }
                return openPreviewItem(item, requestSeq);
            })
            .catch(previewError => {
                error(
                    `Failed to refresh preview after selection: ${previewError}`,
                );
            });
    };

    const togglePreview = (item: Item | undefined) => {
        void invoke<boolean>("is_preview_window_visible")
            .then(visible => {
                if (visible) {
                    options.requestSequence.current += 1;
                    return invoke("hide_preview_window");
                }
                if (item) {
                    return openPreviewItem(item);
                }
            })
            .catch(previewError => {
                error(`Failed to toggle preview: ${previewError}`);
            });
    };

    return {
        openPreviewItem,
        refreshPreviewIfVisible,
        togglePreview,
    };
}
