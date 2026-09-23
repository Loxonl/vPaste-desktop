import { Item, ItemType } from "./Item";
import { parseFilePaths, parseLinkContent } from "./itemPresentation";

export const CLIPBOARD_DRAG_MIME = "application/x-vpaste-item";

/** Windows and macOS file targets require a native OS drag session from the Tauri helper. */
export function isWindowsPlatform(): boolean {
    if (typeof navigator === "undefined") return false;
    const userAgentData = (navigator as Navigator & {
        userAgentData?: { platform?: string };
    }).userAgentData;
    return /Windows|Win32|Win64/i.test(
        `${navigator.userAgent} ${navigator.platform} ${userAgentData?.platform ?? ""}`,
    );
}

export function isMacOSPlatform(): boolean {
    if (typeof navigator === "undefined") return false;
    const userAgentData = (navigator as Navigator & {
        userAgentData?: { platform?: string };
    }).userAgentData;
    return /Macintosh|MacIntel|MacPPC|Mac68K/i.test(
        `${navigator.userAgent} ${navigator.platform} ${userAgentData?.platform ?? ""}`,
    );
}

export function isTauriRuntime(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isNativeFileDragItem(item: Item): boolean {
    return isTauriRuntime()
        && (isWindowsPlatform() || isMacOSPlatform())
        && (item.getType() === ItemType.File || item.getType() === ItemType.Image);
}

function encodePathSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

export function filePathToUri(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || /^(data|blob):/i.test(trimmed)) return trimmed;

    const normalized = trimmed.replace(/\\/g, "/");
    if (normalized.startsWith("//")) {
        return `file:${normalized.split("/").map(encodePathSegment).join("/")}`;
    }
    if (normalized.startsWith("/")) {
        return `file://${normalized.split("/").map(encodePathSegment).join("/")}`;
    }
    return `file:///${normalized.split("/").map(encodePathSegment).join("/")}`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character] ?? character);
}

function fileNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || "vPaste-item";
}

function mimeTypeFromPath(path: string): string {
    const extension = path.split(".").pop()?.toLowerCase();
    if (extension === "png") return "image/png";
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "gif") return "image/gif";
    if (extension === "webp") return "image/webp";
    if (extension === "svg") return "image/svg+xml";
    if (extension === "pdf") return "application/pdf";
    return "application/octet-stream";
}

function itemPlainText(item: Item, textFileContent?: string): string {
    switch (item.getType()) {
        case ItemType.Link:
            return parseLinkContent(item.getContent()).url.trim();
        case ItemType.TextFile:
            return textFileContent ?? "";
        case ItemType.Text:
            return item.getTextContent() || item.getContent();
        case ItemType.Color:
            return (item.getTextContent() || item.getContent()).trim();
        default:
            return "";
    }
}

export function externalDragFilePaths(item: Item): string[] {
    if (item.getType() === ItemType.File) {
        return parseFilePaths(item.getContent()).map(path => path.trim()).filter(path => (
            Boolean(path)
            && !/^(?:data|blob|https?):/i.test(path)
            && !/^[a-z][a-z\d+.-]*:\/\//i.test(path)
        ));
    }
    if (item.getType() === ItemType.Image) {
        const path = item.getPreviewContent().trim();
        return path && !/^(?:data|blob|https?):/i.test(path) && !/^[a-z][a-z\d+.-]*:\/\//i.test(path)
            ? [path]
            : [];
    }
    return [];
}

function itemFileUris(item: Item): string[] {
    return externalDragFilePaths(item).map(filePathToUri).filter(Boolean);
}

export function configureClipboardDrag(
    event: Pick<DragEvent, "dataTransfer">,
    item: Item,
    textFileContent?: string,
): boolean {
    const transfer = event.dataTransfer;
    if (!transfer || (item.getType() === ItemType.TextFile && textFileContent === undefined)) return false;

    const plainText = itemPlainText(item, textFileContent);
    transfer.effectAllowed = "copy";
    transfer.setData("text/plain", plainText);

    if (item.isRichText()) {
        transfer.setData("text/html", item.getRichHtml());
    }

    if (item.getType() === ItemType.Link) {
        const url = parseLinkContent(item.getContent()).url.trim();
        if (url) {
            transfer.setData("text/uri-list", url);
            transfer.setData("text/html", `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
        }
    }

    const fileUris = itemFileUris(item);
    if (fileUris.length > 0) {
        transfer.setData("text/uri-list", fileUris.join("\r\n"));

        // Chromium/WebView targets and several Windows applications recognize
        // DownloadURL as a file-backed drag payload. Keep text/uri-list above
        // for standards-compliant targets and use the first file for the
        // single-download fallback when a target does not understand it.
        const filePaths = externalDragFilePaths(item);
        const firstPath = filePaths[0];
        if (firstPath) {
            transfer.setData(
                "DownloadURL",
                `${mimeTypeFromPath(firstPath)}:${fileNameFromPath(firstPath)}:${fileUris[0]}`,
            );
            transfer.setData(
                "text/x-moz-url",
                `${fileUris.join("\n")}\n${fileNameFromPath(firstPath)}`,
            );
        }
    }

    transfer.setData(CLIPBOARD_DRAG_MIME, JSON.stringify({
        hash: item.getHash(),
        type: item.getType(),
    }));
    return true;
}

export function isExternalDragExcludedTarget(target: EventTarget | null): boolean {
    return target instanceof Element
        && Boolean(target.closest("button, a, input, textarea, select, [role='button'], [contenteditable='true']"));
}
