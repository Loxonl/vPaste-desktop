import { Item, ItemType } from "./Item";

export type FilePreviewInfo = {
    kind: 'single-preview' | 'single-icon' | 'single-folder' | 'multiple' | 'pdf-preview' | 'text-preview';
    paths: string[];
    exists: boolean;
    missing_paths: string[];
    display_path: string;
    secondary_text: string;
    extension: string;
    preview_path: string;
    image_width?: number | null;
    image_height?: number | null;
};

export function getBackendTypeLabel(type: ItemType): string {
    switch (type) {
        case ItemType.Text: return "Text";
        case ItemType.Image: return "Image";
        case ItemType.TextFile: return "Text";
        case ItemType.Link: return "Link";
        case ItemType.Color: return "Color";
        case ItemType.File: return "File";
        default: return "Text";
    }
}

export function compactPath(path: string, maxLength: number = 28): string {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.length <= maxLength) return normalized;
    return `...${normalized.slice(-(maxLength - 3))}`;
}

export function parseFilePaths(content: string): string[] {
    try {
        const paths = JSON.parse(content);
        return Array.isArray(paths) ? paths.filter(path => typeof path === "string") : [];
    } catch {
        return [];
    }
}

export function isImagePath(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|svg)$/i.test(path);
}

export function isGifPath(path: string): boolean {
    return /\.gif(?:[?#].*)?$/i.test(path.trim());
}

export function isSingleImageFileItem(item: Item): boolean {
    if (item.getType() !== ItemType.File) return false;
    const paths = parseFilePaths(item.getContent());
    return paths.length === 1 && isImagePath(paths[0]);
}

export function itemHasGifFormat(item: Item): boolean {
    if (item.getType() === ItemType.Image) {
        return isGifPath(item.getContent()) || isGifPath(item.getPreviewContent());
    }
    if (item.getType() === ItemType.File) {
        const paths = parseFilePaths(item.getContent());
        if (paths.length === 1) return isGifPath(paths[0]);
    }
    return false;
}

export function imageExportSourcePath(item: Item): string {
    if (item.getType() === ItemType.Image) {
        return item.getPreviewContent();
    }
    if (item.getType() === ItemType.File) {
        const paths = parseFilePaths(item.getContent());
        if (paths.length === 1 && isImagePath(paths[0])) {
            return paths[0];
        }
    }
    return "";
}

export function joinPath(base: string, name: string): string {
    if (!base) return name;
    const separator = base.lastIndexOf("\\") > base.lastIndexOf("/") ? "\\" : "/";
    return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function dirName(path: string): string {
    const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return index >= 0 ? path.slice(0, index) : "";
}

export function isTextLikeItem(item: Item): boolean {
    return [ItemType.Text, ItemType.TextFile, ItemType.Link].includes(item.getType());
}

export function parseLinkContent(content: string): {
    url: string;
    imagePath: string;
    title: string;
    imageKind: string;
} {
    const [url = "", imagePath = "", title = "", imageKind = ""] = content.split("|||");
    return { url, imagePath, title, imageKind };
}
