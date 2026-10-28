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
        mode: "manual" | "selection" | "hover" = "manual",
        hoverRequest?: number,
        isCurrent: () => boolean = () => true,
        navigationDirection: -1 | 0 | 1 = 0,
    ) => {
        const current = () => requestSeq === options.requestSequence.current && isCurrent();
        if (mode !== "hover") options.closeContextMenu();
        if (item.getType() === "File") {
            try {
                const info = await invoke<FilePreviewInfo>("file_preview_info", {
                    content: item.getContent(),
                });
                if (!current()) return;
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
                if (!current()) return;
                if (metadata.previewLimited || metadata.animationLimited) {
                    if (mode !== "manual") return;
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
                if (mode !== "manual") return;
                if (!current()) return;
                options.showToast(
                    options.t("clipboard.previewUnsupported"),
                    "warning",
                );
                return;
            }
        }
        if (!current()) return;
        if (mode !== "hover") options.selectItem(item.getHash());
        try {
            const textContent = item.getType() === "TextFile"
                ? await invoke<string>("plain_text_content", { hash: item.getHash() })
                : item.getTextContent();
            if (!current()) return;
            await invoke("show_preview_window", {
                itemType: item.getType(),
                content: item.getContent(),
                previewContent: item.getPreviewContent(),
                textContent,
                richHtml: item.getRichHtml(),
                appSource: item.getAppSource(),
                ...(mode !== "manual" ? { mode } : {}),
                ...(mode === "selection" ? { navigationDirection } : {}),
                ...(hoverRequest !== undefined ? { hoverRequest } : {}),
            });
            if (mode === "hover" && !current()) {
                await invoke("dismiss_hover_preview_window", { request: hoverRequest });
            }
        } catch (previewError) {
            if (!current()) return;
            error(`Failed to open preview: ${previewError}`);
            if (mode === "hover") return;
            options.showToast(
                options.t("clipboard.previewFailed", {
                    error: String(previewError),
                }),
                "error",
            );
        }
    };

    const refreshPreviewIfVisible = (item: Item, navigationDirection: -1 | 0 | 1 = 0) => {
        const requestSeq = ++options.requestSequence.current;
        void invoke<boolean>("is_preview_window_visible")
            .then(visible => {
                if (!visible || requestSeq !== options.requestSequence.current) {
                    return;
                }
                return openPreviewItem(item, requestSeq, "selection", undefined, undefined, navigationDirection);
            })
            .catch(previewError => {
                error(
                    `Failed to refresh preview after selection: ${previewError}`,
                );
            });
    };

    const togglePreview = (item: Item | undefined) => {
        const requestSeq = ++options.requestSequence.current;
        void invoke("dismiss_hover_preview_window")
            .then(() => invoke<boolean>("is_preview_window_visible"))
            .then(visible => {
                if (requestSeq !== options.requestSequence.current) return;
                if (visible) {
                    return invoke("hide_preview_window");
                }
                if (item) {
                    return openPreviewItem(item, requestSeq);
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
