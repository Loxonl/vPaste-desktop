// @ts-ignore
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./Clipboard.css";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopDir, downloadDir } from "@tauri-apps/api/path";
import { error } from "@tauri-apps/plugin-log";
import { listen } from "@tauri-apps/api/event";
import { Item, ItemTag, ItemType } from "./Item.tsx";
import { formatRelativeTime, useLanguage } from "../lang";
import { formatShortcutLabel, isMacPlatform } from "../shortcutDisplay";
import FolderCopyOutlinedIcon from "@mui/icons-material/FolderCopyOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import AppleIcon from "@mui/icons-material/Apple";
import WindowOutlinedIcon from "@mui/icons-material/WindowOutlined";
import AddIcon from "@mui/icons-material/Add";
import LinkOutlinedIcon from "@mui/icons-material/LinkOutlined";
import AppsOutlinedIcon from "@mui/icons-material/AppsOutlined";
import StarBorderOutlinedIcon from "@mui/icons-material/StarBorderOutlined";
import TutorialOverlay, { TutorialFilterId, TutorialFilterTab, TutorialPermission, TutorialPermissionId, TutorialPlatform } from "./TutorialOverlay.tsx";
import aboutLogo from "../assets/about-logo.png";

const CLIPBOARD_ANIMATION_MS = 120;
const DEFAULT_PASTE_AS_TEXT_SHORTCUT = "Shift+Enter";
const HISTORY_PAGE_LIMIT = 36;
const HISTORY_DATA_URL_CACHE_LIMIT = 80;
const ACTIVE_IMAGE_LOAD_DELAY_MS = 140;
const IMAGE_EXPORT_DIR_KEY = "vpaste.imageExportDir.v1";
const PENDING_ITEM_TAGS_CHANGED_KEY = "vpaste.pendingItemTagsChangedPayload";
const PENDING_PERMISSION_WINDOW_KEY = "vpaste.pendingOnboardingPermission.v1";
const historyDataUrlCache = new Map<string, string>();
const historyPreviewSrcCache = new Map<string, string>();
const historyOriginalSrcCache = new Map<string, string>();
const historyImageMetadataCache = new Map<string, HistoryImageMetadata>();

type HistoryImageMetadata = {
    width: number;
    height: number;
    isGif: boolean;
};

type ToastKind = 'info' | 'warning' | 'error';

type ToastState = {
    id: number;
    message: string;
    kind: ToastKind;
    actionLabel?: string;
    onAction?: () => void;
} | null;

type FilePreviewInfo = {
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

type DominantColor = {
    color: string;
    textColor: string;
};

type ClipboardBehaviorConfig = {
    display_tray_icon?: boolean;
    onboarding_completed?: boolean;
    retain_search_history?: boolean;
    retain_last_position?: boolean;
    retain_tab_position?: boolean;
    link_auto_preview?: boolean;
    quick_input_enabled?: boolean;
    tab_quick_select_enabled?: boolean;
    shortcut_keys?: {
        main_window?: string | null;
        paste_into_plain_text?: string | null;
    };
};

type PasteAccessibilityPermissionStatus = {
    granted: boolean;
    needs_settings: boolean;
};

type TutorialPermissionStatus = {
    background: { done: boolean; error?: string | null };
    paste: { done: boolean; needs_settings: boolean; error?: string | null };
};

type LinkPreviewUpdate = {
    url: string;
    title: string;
    image_path: string;
    image_kind?: string;
};

function normalizeShortcutKey(key: string): string {
    const normalized = key.toLowerCase();
    if (normalized === "control") return "ctrl";
    if (normalized === "cmd" || normalized === "command" || normalized === "meta") return "meta";
    if (normalized === "return") return "enter";
    if (normalized === "escape") return "esc";
    return normalized;
}

function matchesKeyboardShortcut(event: KeyboardEvent, shortcut?: string | null): boolean {
    const parts = (shortcut || "").split("+").map(part => normalizeShortcutKey(part.trim())).filter(Boolean);
    if (parts.length === 0) return false;

    const key = normalizeShortcutKey(event.key);
    const expectedKey = parts[parts.length - 1];
    const modifiers = new Set(parts.slice(0, -1));
    return key === expectedKey
        && event.ctrlKey === modifiers.has("ctrl")
        && event.metaKey === modifiers.has("meta")
        && event.altKey === modifiers.has("alt")
        && event.shiftKey === modifiers.has("shift");
}

function isTextInputTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
}

type QuickInputAction =
    | { kind: "tab"; tabId: "all" | "favorite" }
    | { kind: "item"; index: number };

function quickInputAction(event: KeyboardEvent): QuickInputAction | null {
    if (isMacPlatform()) {
        if (event.code === "KeyA") return { kind: "tab", tabId: "all" };
        if (event.code === "KeyF") return { kind: "tab", tabId: "favorite" };

        const digitCode = /^Digit([1-9])$/.exec(event.code);
        if (digitCode) return { kind: "item", index: Number(digitCode[1]) - 1 };

        return null;
    }

    const key = event.key.toLowerCase();
    if (key === "a") return { kind: "tab", tabId: "all" };
    if (key === "f") return { kind: "tab", tabId: "favorite" };
    if (/^[1-9]$/.test(key)) return { kind: "item", index: Number(key) - 1 };

    return null;
}

async function loadHistoryDataUrl(path: string): Promise<string> {
    if (!path) return "";
    const cached = historyDataUrlCache.get(path);
    if (cached) return cached;

    let src: string;
    try {
        src = await invoke<string>("history_file_data_url", { path });
    } catch {
        src = convertFileSrc(path);
    }

    historyDataUrlCache.set(path, src);
    if (historyDataUrlCache.size > HISTORY_DATA_URL_CACHE_LIMIT) {
        const oldestKey = historyDataUrlCache.keys().next().value;
        if (oldestKey) {
            historyDataUrlCache.delete(oldestKey);
        }
    }
    return src;
}

async function loadHistoryPreviewSrc(path: string): Promise<string> {
    if (!path) return "";
    const cached = historyPreviewSrcCache.get(path);
    if (cached) return cached;

    let src: string;
    try {
        const assetPath = await invoke<string>("history_image_card_preview_asset_path", { path });
        src = convertFileSrc(assetPath);
    } catch {
        src = await loadHistoryDataUrl(path);
    }

    historyPreviewSrcCache.set(path, src);
    if (historyPreviewSrcCache.size > HISTORY_DATA_URL_CACHE_LIMIT) {
        const oldestKey = historyPreviewSrcCache.keys().next().value;
        if (oldestKey) {
            historyPreviewSrcCache.delete(oldestKey);
        }
    }
    return src;
}

async function loadHistoryOriginalSrc(path: string): Promise<string> {
    if (!path) return "";
    const cached = historyOriginalSrcCache.get(path);
    if (cached) return cached;

    let src: string;
    try {
        const assetPath = await invoke<string>("history_file_preview_asset_path", { path });
        src = convertFileSrc(assetPath);
    } catch {
        src = await loadHistoryDataUrl(path);
    }

    historyOriginalSrcCache.set(path, src);
    if (historyOriginalSrcCache.size > HISTORY_DATA_URL_CACHE_LIMIT) {
        const oldestKey = historyOriginalSrcCache.keys().next().value;
        if (oldestKey) {
            historyOriginalSrcCache.delete(oldestKey);
        }
    }
    return src;
}

async function loadHistoryImageMetadata(path: string): Promise<HistoryImageMetadata> {
    const cached = historyImageMetadataCache.get(path);
    if (cached) return cached;

    const metadata = await invoke<HistoryImageMetadata>("history_image_metadata", { path });
    historyImageMetadataCache.set(path, metadata);
    if (historyImageMetadataCache.size > HISTORY_DATA_URL_CACHE_LIMIT) {
        const oldestKey = historyImageMetadataCache.keys().next().value;
        if (oldestKey) {
            historyImageMetadataCache.delete(oldestKey);
        }
    }
    return metadata;
}

type ColorCopyOption = {
    format: string;
    value: string;
};

type ContextMenuState = {
    item: Item;
    x: number;
    y: number;
    originX: number;
    originY: number;
    submenuSide: "left" | "right";
    itemTags: ItemTag[];
    colorOptions: ColorCopyOption[];
} | null;

type ContextMenuOption = {
    label: string;
    action?: () => void | Promise<void>;
    children?: ContextMenuOption[];
    danger?: boolean;
};

type TabContextMenuState = {
    kind: "filter";
    tab: CustomTab;
    x: number;
    y: number;
    originX: number;
    originY: number;
} | {
    kind: "record";
    tag: ItemTag;
    x: number;
    y: number;
    originX: number;
    originY: number;
} | null;

type PreviewNavigationPayload = {
    direction?: number;
    key?: string;
};

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type FavoriteFilter = "any" | "yes" | "no";
type DateUnit = "minute" | "hour" | "day" | "week" | "month";

type CustomTabFilter = {
    itemType: string;
    appSource: string;
    appSources: string[];
    favorite: FavoriteFilter;
    relativeAmount: string;
    relativeUnit: DateUnit;
};

type CustomTab = {
    id: string;
    name: string;
    filter: CustomTabFilter;
};

type DynamicTabEntry = {
    kind: "filter";
    id: string;
    tab: CustomTab;
} | {
    kind: "record";
    id: string;
    tag: ItemTag;
};

type TabEditorMode = "add" | "edit";
type TagEditorKind = "filter" | "record";
type ItemTagsChangedPayload = {
    activeId?: string;
    tag?: ItemTag;
};
type TagCreateChoiceState = {
    x: number;
    y: number;
    originX: number;
    originY: number;
} | null;
const RECORD_TAG_TAB_PREFIX = "record:";
const TAB_EDITOR_WIDTH = 286;
const FILTER_TAG_EDITOR_HEIGHT = 398;
const RECORD_TAG_EDITOR_HEIGHT = 178;
const TAG_CREATE_CHOICE_WIDTH = 252;
const TAG_CREATE_CHOICE_HEIGHT = 142;

const CUSTOM_TABS_STORAGE_KEY = "vpaste.customTabs.v1";
const TAB_ORDER_STORAGE_KEY = "vpaste.tabOrder.v1";
const DEFAULT_CUSTOM_FILTER: CustomTabFilter = {
    itemType: "",
    appSource: "",
    appSources: [],
    favorite: "any",
    relativeAmount: "",
    relativeUnit: "day",
};
const DEFAULT_MAIN_SHORTCUT = "Alt+V";
const TUTORIAL_FILTER_TABS: Array<{ id: TutorialFilterId; emoji: string; titleKey: string; itemType: ItemType }> = [
    { id: "text", emoji: "📝", titleKey: "type.text", itemType: ItemType.Text },
    { id: "image", emoji: "🖼️", titleKey: "type.image", itemType: ItemType.Image },
    { id: "link", emoji: "🔗", titleKey: "type.link", itemType: ItemType.Link },
    { id: "color", emoji: "🎨", titleKey: "type.color", itemType: ItemType.Color },
    { id: "file", emoji: "📁", titleKey: "type.file", itemType: ItemType.File },
];

function tutorialFilterTabId(id: TutorialFilterId): string {
    return `tutorial-filter-${id}`;
}

function normalizeAppSources(filter: Partial<CustomTabFilter> & { appSource?: unknown; appSources?: unknown }): string[] {
    if (Array.isArray(filter.appSources)) {
        return filter.appSources.filter(source => typeof source === "string" && source.trim()).map(source => source.trim());
    }
    return typeof filter.appSource === "string" && filter.appSource.trim() ? [filter.appSource.trim()] : [];
}

function loadCustomTabs(): CustomTab[] {
    return normalizeCustomTabs(localStorage.getItem(CUSTOM_TABS_STORAGE_KEY));
}

function normalizeStringArray(raw: unknown): string[] {
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed)
            ? parsed.filter(value => typeof value === "string" && value.trim()).map(value => value.trim())
            : [];
    } catch {
        return [];
    }
}

function loadTabOrder(): string[] {
    return normalizeStringArray(localStorage.getItem(TAB_ORDER_STORAGE_KEY));
}

function saveTabOrder(order: string[]) {
    localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
}

function normalizeCustomTabs(raw: unknown): CustomTab[] {
    try {
        if (!raw) return [];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed)
            ? parsed
                .filter(tab => typeof tab?.id === "string" && typeof tab?.name === "string")
                .map(tab => {
                    const filter = { ...DEFAULT_CUSTOM_FILTER, ...(tab.filter || {}) };
                    const { tagName: _legacyRecordTagName, ...filterWithoutRecordTag } = filter as typeof DEFAULT_CUSTOM_FILTER & { tagName?: unknown };
                    return {
                        id: tab.id,
                        name: tab.name,
                        filter: { ...filterWithoutRecordTag, appSources: normalizeAppSources(filter) },
                    };
                })
            : [];
    } catch {
        return [];
    }
}

function saveCustomTabs(tabs: CustomTab[]) {
    localStorage.setItem(CUSTOM_TABS_STORAGE_KEY, JSON.stringify(tabs));
}

function persistCustomTabs(tabs: CustomTab[]) {
    saveCustomTabs(tabs);
    void invoke('save_custom_tabs', { tabs })
        .catch(e => error(`Failed to persist custom tabs: ${e}`));
}

function customTabFilterPayload(tab: CustomTab): string {
    const filter = tab.filter;
    const payload: Record<string, string | number | boolean | string[]> = { mode: "custom" };
    if (filter.itemType) payload.item_type = filter.itemType;
    const appSources = normalizeAppSources(filter);
    if (appSources.length > 0) payload.app_sources = appSources;
    if (filter.favorite === "yes") payload.favorite = true;
    if (filter.favorite === "no") payload.favorite = false;
    const amount = Number(filter.relativeAmount);
    if (Number.isFinite(amount) && amount > 0) {
        payload.relative_amount = amount;
        payload.relative_unit = filter.relativeUnit;
    }
    return `__filter:${JSON.stringify(payload)}`;
}

function recordTagTabId(id: number): string {
    return `${RECORD_TAG_TAB_PREFIX}${id}`;
}

function recordTagIdFromTab(tabId: string): number | null {
    if (!tabId.startsWith(RECORD_TAG_TAB_PREFIX)) return null;
    const id = Number(tabId.slice(RECORD_TAG_TAB_PREFIX.length));
    return Number.isInteger(id) && id > 0 ? id : null;
}

function orderedDynamicTabs(customTabs: CustomTab[], itemTags: ItemTag[], order: string[]): DynamicTabEntry[] {
    const defaultEntries: DynamicTabEntry[] = [
        ...customTabs.map(tab => ({ kind: "filter" as const, id: tab.id, tab })),
        ...itemTags.map(tag => ({ kind: "record" as const, id: recordTagTabId(tag.id), tag })),
    ];
    const entryMap = new Map(defaultEntries.map(entry => [entry.id, entry]));
    const seen = new Set<string>();
    const ids = [
        ...order.filter(id => {
            if (seen.has(id) || !entryMap.has(id)) return false;
            seen.add(id);
            return true;
        }),
        ...defaultEntries.map(entry => entry.id).filter(id => !seen.has(id)),
    ];
    return ids.map(id => entryMap.get(id)).filter((entry): entry is DynamicTabEntry => Boolean(entry));
}

function arraysEqual(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseTagSearch(value: string): { keywords: string; tagNames: string[] } {
    const tagNames: string[] = [];
    const keywords = value
        .replace(/(?:^|\s)tag:("[^"]+"|\S+)/gi, (_match, raw: string) => {
            const name = raw.startsWith('"') && raw.endsWith('"')
                ? raw.slice(1, -1)
                : raw;
            const trimmed = name.trim();
            if (trimmed && !tagNames.some(tag => tag.toLowerCase() === trimmed.toLowerCase())) {
                tagNames.push(trimmed);
            }
            return " ";
        })
        .replace(/\s+/g, " ")
        .trim();
    return { keywords, tagNames };
}

function mergeTagSearchFilter(label: string, tagNames: string[]): string {
    if (tagNames.length === 0) return label;
    const payload: Record<string, unknown> = label.startsWith("__filter:")
        ? JSON.parse(label.slice("__filter:".length))
        : label === "__favorite"
            ? { mode: "favorite", favorite: true }
            : { mode: "all" };
    const existing = Array.isArray(payload.tag_names)
        ? payload.tag_names.filter(name => typeof name === "string")
        : [];
    payload.tag_names = [...existing, ...tagNames].filter((name, index, list) =>
        list.findIndex(candidate => String(candidate).toLowerCase() === String(name).toLowerCase()) === index
    );
    return `__filter:${JSON.stringify(payload)}`;
}

const CONTEXT_MENU_WIDTH = 188;
const CONTEXT_SUBMENU_WIDTH = 312;
const TAB_CONTEXT_MENU_WIDTH = 126;
const CONTEXT_MENU_PADDING = 5;
const CONTEXT_MENU_ROW_HEIGHT = 34;
const CONTEXT_MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;

function clampToViewport(value: number, size: number, viewportSize: number): number {
    return Math.max(VIEWPORT_MARGIN, Math.min(value, viewportSize - size - VIEWPORT_MARGIN));
}

function contextMenuHeight(rowCount: number): number {
    return CONTEXT_MENU_PADDING * 2 + Math.max(1, rowCount) * CONTEXT_MENU_ROW_HEIGHT;
}

function floatingPositionFromClick(clientX: number, clientY: number, width: number, height: number) {
    return {
        x: clampToViewport(clientX + CONTEXT_MENU_GAP, width, window.innerWidth),
        y: clampToViewport(clientY - height - CONTEXT_MENU_GAP, height, window.innerHeight),
    };
}

function clampToScreen(value: number, size: number, min: number, maxSize: number): number {
    return Math.max(min + VIEWPORT_MARGIN, Math.min(value, min + maxSize - size - VIEWPORT_MARGIN));
}

function screenFloatingPositionFromClick(clientX: number, clientY: number, width: number, height: number) {
    const screenBounds = window.screen as Screen & { availLeft?: number; availTop?: number };
    const availLeft = screenBounds.availLeft ?? 0;
    const availTop = screenBounds.availTop ?? 0;
    return {
        x: clampToScreen(window.screenX + clientX + CONTEXT_MENU_GAP, width, availLeft, window.screen.availWidth),
        y: clampToScreen(window.screenY + clientY - height - CONTEXT_MENU_GAP, height, availTop, window.screen.availHeight),
    };
}

function screenAnchoredPositionFromClick(clientX: number, clientY: number, width: number, height: number) {
    const screenBounds = window.screen as Screen & { availLeft?: number; availTop?: number };
    const availLeft = screenBounds.availLeft ?? 0;
    const availTop = screenBounds.availTop ?? 0;
    return {
        x: clampToScreen(window.screenX + clientX + CONTEXT_MENU_GAP, width, availLeft, window.screen.availWidth),
        y: clampToScreen(window.screenY + clientY - height, height, availTop, window.screen.availHeight),
    };
}

function screenFloatingPositionFromAnchor(anchor: HTMLElement | null | undefined, width: number, height: number) {
    const rect = anchor?.getBoundingClientRect();
    if (!rect) {
        return screenFloatingPositionFromClick(window.innerWidth - width - VIEWPORT_MARGIN, VIEWPORT_MARGIN, width, height);
    }
    return screenAnchoredPositionFromClick(rect.right, rect.bottom, width, height);
}

class ClipboardPage {
    list: Item[];
    consumed: number;

    constructor(list: Item[], consumed: number) {
        this.list = list;
        this.consumed = consumed;
    }
}


// Helper function to get type label
function getTypeLabel(type: ItemType, t: TFunction): string {
    switch (type) {
        case ItemType.Text: return t("type.text");
        case ItemType.Image: return t("type.image");
        case ItemType.TextFile: return t("type.text");
        case ItemType.Link: return t("type.link");
        case ItemType.Color: return t("type.color");
        case ItemType.File: return t("type.file");
        default: return t("type.text");
    }
}

function getBackendTypeLabel(type: ItemType): string {
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

// Helper function to get type class
function getTypeClass(type: ItemType): string {
    switch (type) {
        case ItemType.Text: return "type-text";
        case ItemType.Image: return "type-image";
        case ItemType.TextFile: return "type-text";
        case ItemType.Link: return "type-link";
        case ItemType.Color: return "type-color";
        case ItemType.File: return "type-file";
        default: return "type-text";
    }
}

function getTypeAccentColor(type: ItemType): string {
    switch (type) {
        case ItemType.Text: return "#4CAF50";
        case ItemType.Image: return "#FF9800";
        case ItemType.TextFile: return "#4CAF50";
        case ItemType.Link: return "#2f6fed";
        case ItemType.Color: return "#2196F3";
        case ItemType.File: return "#00BCD4";
        default: return "#4CAF50";
    }
}

const APP_ICON_HEADER_ACCENT_COLOR = "#637083";

function getFormatTagColor(type: ItemType, headerColor: DominantColor | null, hasAppIcon: boolean): string {
    if (headerColor) return headerColor.color;
    if (hasAppIcon) return APP_ICON_HEADER_ACCENT_COLOR;
    return getTypeAccentColor(type);
}

function compactPath(path: string, maxLength: number = 28): string {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.length <= maxLength) return normalized;
    return `...${normalized.slice(-(maxLength - 3))}`;
}

function parseFilePaths(content: string): string[] {
    try {
        const paths = JSON.parse(content);
        return Array.isArray(paths) ? paths.filter(path => typeof path === "string") : [];
    } catch {
        return [];
    }
}

function isImagePath(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|svg)$/i.test(path);
}

function isGifPath(path: string): boolean {
    return /\.gif(?:[?#].*)?$/i.test(path.trim());
}

function isSingleImageFileItem(item: Item): boolean {
    if (item.getType() !== ItemType.File) return false;
    const paths = parseFilePaths(item.getContent());
    return paths.length === 1 && isImagePath(paths[0]);
}

function itemHasGifFormat(item: Item): boolean {
    if (item.getType() === ItemType.Image) {
        return isGifPath(item.getContent()) || isGifPath(item.getPreviewContent());
    }
    if (item.getType() === ItemType.File) {
        const paths = parseFilePaths(item.getContent());
        if (paths.length === 1) return isGifPath(paths[0]);
    }
    return false;
}

function imageExportSourcePath(item: Item): string {
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

function joinPath(base: string, name: string): string {
    if (!base) return name;
    const separator = base.lastIndexOf("\\") > base.lastIndexOf("/") ? "\\" : "/";
    return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function dirName(path: string): string {
    const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return index >= 0 ? path.slice(0, index) : "";
}

function isTextLikeItem(item: Item): boolean {
    return [ItemType.Text, ItemType.TextFile, ItemType.Link].includes(item.getType());
}

function dominantColorFromImage(image: HTMLImageElement): DominantColor | null {
    const canvas = document.createElement("canvas");
    const size = 24;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;

    try {
        context.drawImage(image, 0, 0, size, size);
        const data = context.getImageData(0, 0, size, size).data;
        const buckets = new Map<string, { r: number, g: number, b: number, weight: number }>();
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha < 40) continue;
            const red = data[i];
            const green = data[i + 1];
            const blue = data[i + 2];
            if (red > 245 && green > 245 && blue > 245) continue;
            if (red < 18 && green < 18 && blue < 18) continue;
            const max = Math.max(red, green, blue);
            const min = Math.min(red, green, blue);
            const saturation = max === 0 ? 0 : (max - min) / max;
            const weight = alpha / 255;
            const colorWeight = weight * (0.45 + saturation * 1.4);
            const key = `${Math.round(red / 24)},${Math.round(green / 24)},${Math.round(blue / 24)}`;
            const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, weight: 0 };
            bucket.r += red * colorWeight;
            bucket.g += green * colorWeight;
            bucket.b += blue * colorWeight;
            bucket.weight += colorWeight;
            buckets.set(key, bucket);
        }
        const dominant = Array.from(buckets.values()).sort((a, b) => b.weight - a.weight)[0];
        if (!dominant || dominant.weight <= 0) return null;
        const r = Math.round(dominant.r / dominant.weight);
        const g = Math.round(dominant.g / dominant.weight);
        const b = Math.round(dominant.b / dominant.weight);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return {
            color: `rgb(${r}, ${g}, ${b})`,
            textColor: luminance > 0.62 ? "#1f2933" : "#fff",
        };
    } catch {
        return null;
    }
}

function textColorForBackground(color: string): string {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return "#fff";
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
    return luminance > 0.62 ? "#1f2933" : "#fff";
}

function sanitizeRichHtml(html: string): string {
    if (!html.trim()) return "";
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    document.querySelectorAll("script, iframe, object, embed, link, meta, base").forEach(node => node.remove());
    document.querySelectorAll("style").forEach(node => {
        node.textContent = (node.textContent || "")
            .replace(/mso-pattern\s*:[^;{}]+;?/gi, "");
    });
    applyRichClassStyles(document);
    document.querySelectorAll<HTMLElement>("*").forEach(element => {
        Array.from(element.attributes).forEach(attribute => {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim().toLowerCase();
            if (name.startsWith("on") || name === "srcdoc" || value.startsWith("javascript:")) {
                element.removeAttribute(attribute.name);
            }
            if (name === "style" && /url\s*\(/i.test(attribute.value)) {
                element.removeAttribute(attribute.name);
            }
        });
        normalizeRichPreviewStyle(element);
    });
    const root = document.body.firstElementChild;
    if (root) {
        unwrapSingleLeadingLayoutContainers(root);
        trimLeadingEmptyRichBlocks(root);
    }
    return document.body.firstElementChild?.innerHTML || "";
}

function normalizeRichPreviewStyle(element: HTMLElement) {
    const style = element.getAttribute("style");
    if (!style) return;
        const nextStyle = style
        .split(";")
        .map(rule => rule.trim())
        .filter(Boolean)
        .filter(rule => {
            const [rawName, ...rawValue] = rule.split(":");
            const name = rawName.trim().toLowerCase();
            const value = rawValue.join(":").trim().toLowerCase();
            if (name === "width" && value.endsWith("in")) return false;
            if (name === "min-width" && value.endsWith("in")) return false;
            if (name === "max-width" && value.endsWith("in")) return false;
            if (name === "width" && value.endsWith("pt")) return false;
            if (name === "width" && value.endsWith("px") && Number.parseFloat(value) > 160) return false;
            if (name === "margin-left" && value.endsWith("in")) return false;
            if (name === "margin-right" && value.endsWith("in")) return false;
            if (name === "text-indent" && value.startsWith("-")) return false;
            if (name === "border-width" && value.includes("%")) return false;
            return true;
        })
        .join("; ");
    if (nextStyle) {
        element.setAttribute("style", nextStyle);
    } else {
        element.removeAttribute("style");
    }
}

function extractRichClassStyles(document: Document): Map<string, string[]> {
    const classStyles = new Map<string, string[]>();
    document.querySelectorAll("style").forEach(styleNode => {
        const css = styleNode.textContent || "";
        const classRuleRegex = /\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
        let match: RegExpExecArray | null;
        while ((match = classRuleRegex.exec(css)) !== null) {
            const className = match[1];
            const rules = match[2]
                .split(";")
                .map(rule => rule.trim())
                .filter(Boolean)
                .filter(rule => {
                    const [rawName, ...rawValue] = rule.split(":");
                    const name = rawName.trim().toLowerCase();
                    const value = rawValue.join(":").trim();
                    if (!name || !value || /url\s*\(/i.test(value)) return false;
                    return [
                        "background",
                        "background-color",
                        "color",
                        "font-weight",
                        "font-style",
                        "text-decoration",
                        "text-align",
                        "vertical-align",
                        "border",
                        "border-top",
                        "border-right",
                        "border-bottom",
                        "border-left",
                    ].includes(name);
                });
            if (rules.length > 0) {
                classStyles.set(className, rules);
            }
        }
    });
    return classStyles;
}

function applyRichClassStyles(document: Document) {
    const classStyles = extractRichClassStyles(document);
    if (classStyles.size === 0) return;

    document.querySelectorAll<HTMLElement>("[class]").forEach(element => {
        const existingStyle = element.getAttribute("style") || "";
        const existingNames = new Set(
            existingStyle
                .split(";")
                .map(rule => rule.split(":")[0]?.trim().toLowerCase())
                .filter(Boolean)
        );
        const nextRules: string[] = [];
        element.classList.forEach(className => {
            classStyles.get(className)?.forEach(rule => {
                const name = rule.split(":")[0]?.trim().toLowerCase();
                if (name && !existingNames.has(name)) {
                    existingNames.add(name);
                    nextRules.push(rule);
                }
            });
        });
        if (nextRules.length > 0) {
            element.setAttribute(
                "style",
                [existingStyle.trim().replace(/;$/, ""), ...nextRules].filter(Boolean).join("; ")
            );
        }
    });
}

function isEmptyLeadingRichBlock(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (!["p", "div", "span"].includes(tag)) return false;
    if (element.querySelector("img,svg,table,canvas,video")) return false;
    return (element.textContent || "").replace(/\u00a0/g, "").trim().length === 0;
}

function unwrapSingleLeadingLayoutContainers(container: Element) {
    let current = container.firstElementChild;
    while (current && current.tagName.toLowerCase() === "div") {
        const children = Array.from(current.children).filter(child => child.tagName.toLowerCase() !== "style");
        const text = (current.textContent || "").replace(/\u00a0/g, "").trim();
        const style = (current.getAttribute("style") || "").toLowerCase();
        const layoutOnly = !text && children.length === 1 && /direction|width|margin-left|border-width/.test(style);
        if (!layoutOnly) break;
        const child = children[0];
        current.replaceWith(child);
        current = child;
    }
}

function trimLeadingEmptyRichBlocks(container: Element) {
    let changed = true;
    while (changed) {
        changed = false;
        const firstContentChild = Array.from(container.children)
            .find(child => child.tagName.toLowerCase() !== "style");
        if (!firstContentChild) return;

        if (isEmptyLeadingRichBlock(firstContentChild)) {
            firstContentChild.remove();
            changed = true;
            continue;
        }

        const tag = firstContentChild.tagName.toLowerCase();
        if (["div", "section", "article", "blockquote", "ul", "ol"].includes(tag)) {
            const before = firstContentChild.innerHTML;
            trimLeadingEmptyRichBlocks(firstContentChild);
            if (before !== firstContentChild.innerHTML) {
                changed = true;
            }
            if (isEmptyLeadingRichBlock(firstContentChild)) {
                firstContentChild.remove();
                changed = true;
            }
        }
    }
}

function richHtmlHasVisibleContent(html: string): boolean {
    if (!html.trim()) return false;
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = document.body.firstElementChild;
    if (!root) return false;
    const cloned = root.cloneNode(true) as HTMLElement;
    cloned.querySelectorAll("style").forEach(node => node.remove());
    return Boolean(cloned.textContent?.trim())
        || Boolean(cloned.querySelector("table,img,svg,canvas,video"));
}

function searchTerms(query: string): string[] {
    const value = query.trim();
    if (!value) return [];
    const terms = value.includes(" ")
        ? value.split(/\s+/)
        : [value];
    return Array.from(new Set(terms.filter(Boolean)))
        .sort((a, b) => b.length - a.length)
        .slice(0, 8);
}

function highlightRegex(query: string): RegExp | null {
    const terms = searchTerms(query);
    if (terms.length === 0) return null;
    const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(${escaped.join("|")})`, "gi");
}

function HighlightedText({ text, query }: { text: string; query: string }) {
    const regex = highlightRegex(query);
    if (!regex) return <>{text}</>;
    const parts = text.split(regex);
    return (
        <>
            {parts.map((part, index) => (
                (() => {
                    regex.lastIndex = 0;
                    return regex.test(part);
                })()
                    ? <mark className="search-highlight" key={`${part}-${index}`}>{part}</mark>
                    : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
            ))}
        </>
    );
}

function highlightRichHtml(html: string, query: string): string {
    const regex = highlightRegex(query);
    if (!regex || !html.trim()) return html;
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = document.body.firstElementChild;
    if (!root) return html;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
        if (current.textContent?.trim()) nodes.push(current as Text);
        current = walker.nextNode();
    }
    nodes.forEach(node => {
        const text = node.textContent || "";
        regex.lastIndex = 0;
        if (!regex.test(text)) return;
        regex.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        text.split(regex).forEach(part => {
            if (!part) return;
            regex.lastIndex = 0;
            if (regex.test(part)) {
                const mark = document.createElement("mark");
                mark.className = "search-highlight";
                mark.textContent = part;
                fragment.appendChild(mark);
            } else {
                fragment.appendChild(document.createTextNode(part));
            }
        });
        node.replaceWith(fragment);
    });
    return root.innerHTML;
}

function AutoScrollPreview({
    active,
    className,
    html,
    children,
}: {
    active: boolean;
    className: string;
    html?: string;
    children?: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        let frame = 0;
        let timeout = 0;
        let cancelled = false;
        const cleanup = () => {
            cancelled = true;
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timeout);
        };

        if (!active) {
            element.scrollTo({ top: 0, behavior: "smooth" });
            return cleanup;
        }

        const maxScroll = element.scrollHeight - element.clientHeight;
        if (maxScroll <= 8) return cleanup;

        const start = () => {
            const startTime = performance.now();
            const duration = Math.min(8500, Math.max(1500, maxScroll * 12));
            const animate = (now: number) => {
                if (cancelled) return;
                const progress = Math.min(1, (now - startTime) / duration);
                element.scrollTop = maxScroll * progress;
                if (progress < 1) {
                    frame = window.requestAnimationFrame(animate);
                } else {
                    timeout = window.setTimeout(() => {
                        if (cancelled) return;
                        element.scrollTo({ top: 0, behavior: "smooth" });
                        timeout = window.setTimeout(() => {
                            if (!cancelled) start();
                        }, 1100);
                    }, 900);
                }
            };
            frame = window.requestAnimationFrame(animate);
        };

        timeout = window.setTimeout(start, 320);
        return cleanup;
    }, [active, html, children]);

    if (html !== undefined) {
        return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
    }
    return <div ref={ref} className={className}>{children}</div>;
}

function itemFromPayload(i: any): Item {
    return new Item(
        i.id,
        i.hash,
        i.itemType,
        i.content,
        i.time,
        i.titleColor,
        i.previewContent,
        i.textContent,
        i.label,
        i.appSource,
        i.appIconPath,
        i.richHtml,
        Array.isArray(i.tags) ? i.tags : [],
    );
}

function ImagePreview({ item, active, t, onGifFormatChange }: { item: Item, active: boolean, t: TFunction, onGifFormatChange: (isGif: boolean) => void }) {
    const [naturalSize, setNaturalSize] = useState<{ width: number, height: number } | null>(null);
    const [stageSize, setStageSize] = useState<{ width: number, height: number }>({ width: 0, height: 0 });
    const [imageSrc, setImageSrc] = useState("");
    const [isVisible, setIsVisible] = useState(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const width = naturalSize?.width || 0;
    const height = naturalSize?.height || 0;
    const stageWidth = stageSize.width;
    const stageHeight = stageSize.height;
    const smallImage = width > 0 && height > 0 && width < 100 && height < 100;
    const realSizeImage = width >= 100 && height >= 100 && width <= stageWidth && height <= stageHeight;
    const imageStyle: React.CSSProperties = realSizeImage
        ? { width: `${width}px`, height: `${height}px` }
        : smallImage
            ? { width: `${width}px`, height: `${height}px` }
            : { maxWidth: '100%', maxHeight: '100%' };

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;

        const updateStageSize = () => {
            setStageSize({
                width: stage.clientWidth,
                height: stage.clientHeight,
            });
        };
        updateStageSize();

        const resizeObserver = new ResizeObserver(updateStageSize);
        resizeObserver.observe(stage);
        return () => resizeObserver.disconnect();
    }, []);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;

        const observer = new IntersectionObserver(([entry]) => {
            setIsVisible(entry.isIntersecting);
        }, {
            root: stage.closest('.cards-container'),
            rootMargin: '0px 420px',
            threshold: 0.25,
        });
        observer.observe(stage);
        return () => observer.disconnect();
    }, [item.getHash()]);

    useEffect(() => {
        setImageSrc("");
        const sourcePath = item.getContent();
        const cachedMetadata = historyImageMetadataCache.get(sourcePath);
        setNaturalSize(cachedMetadata ? { width: cachedMetadata.width, height: cachedMetadata.height } : null);
        onGifFormatChange(itemHasGifFormat(item));
    }, [item, onGifFormatChange]);

    useEffect(() => {
        if (!isVisible) return;

        let cancelled = false;
        let timeout = 0;
        const sourcePath = item.getContent();
        const previewPath = item.getPreviewContent() || sourcePath;
        if (!sourcePath) return;

        const load = (gif: boolean) => {
            const loader = gif && active ? loadHistoryOriginalSrc : loadHistoryPreviewSrc;
            loader(gif && active ? sourcePath : previewPath)
                .then(src => {
                    if (!cancelled) setImageSrc(src);
                });
        };

        const loadWithGifState = (gif: boolean) => {
            if (!cancelled) onGifFormatChange(gif);
            if (active) {
                timeout = window.setTimeout(() => load(gif), ACTIVE_IMAGE_LOAD_DELAY_MS);
            } else {
                load(gif);
            }
        };

        void loadHistoryImageMetadata(sourcePath)
            .then(metadata => {
                if (!cancelled) {
                    setNaturalSize({ width: metadata.width, height: metadata.height });
                }
                loadWithGifState(metadata.isGif);
            })
            .catch(() => loadWithGifState(false));

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [item.getHash(), item.getContent(), item.getPreviewContent(), isVisible, active, onGifFormatChange]);

    return (
        <div className="image-preview">
            <div className="image-preview-stage" ref={stageRef}>
                <img
                    key={imageSrc}
                    src={imageSrc}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    className="image-preview-img"
                    style={imageStyle}
                />
                {naturalSize && (
                    <div className="image-resolution">
                        {`${naturalSize.width} x ${naturalSize.height}`}
                    </div>
                )}
            </div>
            {item.getTextContent() && (
                <div className="mixed-content-badge">{t("clipboard.mixedText")}</div>
            )}
        </div>
    );
}

function FilePreview({ item, refreshKey, searchQuery, t }: { item: Item, refreshKey: number, searchQuery: string, t: TFunction }) {
    const [previewInfo, setPreviewInfo] = useState<FilePreviewInfo | null>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [imageSize, setImageSize] = useState<{ width: number, height: number } | null>(null);
    const [previewSrc, setPreviewSrc] = useState("");
    const previewRef = useRef<HTMLDivElement>(null);
    const fallbackPaths = parseFilePaths(item.getContent());
    const firstPath = previewInfo?.display_path || fallbackPaths[0] || item.getContent();
    const extension = previewInfo?.extension || (firstPath.split(".").pop() || "FILE").toUpperCase();
    const isGifFile = extension.toLowerCase() === "gif";
    const isMultiple = previewInfo?.kind === "multiple" || fallbackPaths.length > 1;
    const isInvalid = previewInfo ? !previewInfo.exists : false;
    const displayedImageSize = previewInfo?.image_width && previewInfo?.image_height
        ? { width: previewInfo.image_width, height: previewInfo.image_height }
        : imageSize;
    const fileImageStyle: React.CSSProperties | undefined = displayedImageSize
        ? { width: `${displayedImageSize.width}px`, height: `${displayedImageSize.height}px` }
        : undefined;

    useEffect(() => {
        const element = previewRef.current;
        if (!element) return;

        const observer = new IntersectionObserver(([entry]) => {
            setIsVisible(entry.isIntersecting);
        }, {
            root: element.closest('.cards-container'),
            threshold: 0.35,
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [item.getHash()]);

    useEffect(() => {
        if (!isVisible) return;

        let cancelled = false;
        void invoke<FilePreviewInfo>("file_preview_info", { content: item.getContent() })
            .then(info => {
                if (!cancelled) setPreviewInfo(info);
            })
            .catch(e => {
                error(`Failed to load file preview info: ${e}`);
                if (!cancelled) {
                    setPreviewInfo({
                        kind: fallbackPaths.length > 1 ? "multiple" : "single-icon",
                        paths: fallbackPaths,
                        exists: true,
                        missing_paths: [],
                        display_path: firstPath,
                        secondary_text: fallbackPaths.length > 1 ? t("clipboard.multipleFiles") : "",
                        extension,
                        preview_path: "",
                        image_width: null,
                        image_height: null,
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [item.getHash(), isVisible, refreshKey]);

    useEffect(() => {
        setImageSize(null);
        setPreviewSrc("");
        let cancelled = false;
        if (previewInfo?.preview_path) {
            const loader = isGifFile ? loadHistoryOriginalSrc : loadHistoryPreviewSrc;
            loader(previewInfo.preview_path)
                .then(src => {
                    if (!cancelled) setPreviewSrc(src);
                });
        }
        return () => {
            cancelled = true;
        };
    }, [item.getHash(), previewInfo?.preview_path, isGifFile]);

    return (
        <div className={`file-preview ${isInvalid ? 'invalid' : ''}`} ref={previewRef}>
            <div className="file-preview-stage">
                {previewInfo?.kind === "single-preview" && previewInfo.preview_path ? (
                    <>
                        <img
                            key={previewSrc}
                            className="file-preview-image"
                            src={previewSrc}
                            draggable={false}
                            alt=""
                            style={fileImageStyle}
                            onLoad={(event) => {
                                setImageSize({
                                    width: event.currentTarget.naturalWidth,
                                    height: event.currentTarget.naturalHeight,
                                });
                            }}
                        />
                        {displayedImageSize && (
                            <div className="image-resolution file-image-resolution">
                                {`${displayedImageSize.width} x ${displayedImageSize.height}`}
                            </div>
                        )}
                    </>
                ) : isMultiple || previewInfo?.kind === "single-folder" ? (
                    <div className="file-preview-icon multiple">
                        <FolderCopyOutlinedIcon />
                    </div>
                ) : (
                    <div className="file-preview-icon single">
                        <InsertDriveFileOutlinedIcon />
                        <span className="file-extension">{extension}</span>
                    </div>
                )}
                {isInvalid && (
                    <div className="file-invalid-badge">
                        <WarningAmberOutlinedIcon />
                    </div>
                )}
            </div>
            <div className="file-paths">
                <div className="file-path-line" title={firstPath}>
                    <HighlightedText text={compactPath(firstPath)} query={searchQuery} />
                </div>
                {isMultiple && (
                    <div className="file-path-line secondary">
                        <HighlightedText text={previewInfo?.secondary_text || t("clipboard.multipleFiles")} query={searchQuery} />
                    </div>
                )}
            </div>
        </div>
    );
}

function parseLinkContent(content: string): { url: string; imagePath: string; title: string; imageKind: string } {
    const [url = "", imagePath = "", title = "", imageKind = ""] = content.split("|||");
    return { url, imagePath, title, imageKind };
}

function linkHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function LinkPreview({ item, searchQuery }: { item: Item, searchQuery: string }) {
    const { url, imagePath, title, imageKind } = parseLinkContent(item.getContent());
    const [imageFailed, setImageFailed] = useState(false);
    const [imageSrc, setImageSrc] = useState("");
    const [imageNaturalSize, setImageNaturalSize] = useState<{ width: number; height: number } | null>(null);
    const showImage = Boolean(imagePath) && Boolean(imageSrc) && !imageFailed;
    const displayTitle = title || linkHost(url);
    const isSmallImage = imageKind === "icon"
        || Boolean(imageNaturalSize && Math.max(imageNaturalSize.width, imageNaturalSize.height) <= 96);

    useEffect(() => {
        setImageFailed(false);
        setImageNaturalSize(null);
        let cancelled = false;
        setImageSrc("");
        if (imagePath) {
            loadHistoryPreviewSrc(imagePath)
                .then(src => {
                    if (!cancelled) setImageSrc(src);
                });
        }
        return () => {
            cancelled = true;
        };
    }, [item.getHash(), imagePath]);

    return (
        <div className="link-preview">
            <div className={`link-preview-media ${showImage ? '' : 'fallback'} ${isSmallImage ? 'icon' : ''}`}>
                {showImage ? (
                    <img
                        src={imageSrc}
                        alt=""
                        draggable={false}
                        onLoad={event => {
                            const image = event.currentTarget;
                            setImageNaturalSize({
                                width: image.naturalWidth,
                                height: image.naturalHeight,
                            });
                        }}
                        onError={() => setImageFailed(true)}
                    />
                ) : (
                    <LinkOutlinedIcon />
                )}
            </div>
            <div className="link-preview-text">
                <div className="link-preview-title" title={displayTitle}>
                    <HighlightedText text={displayTitle} query={searchQuery} />
                </div>
                <div className="link-preview-url" title={url}>
                    <HighlightedText text={url} query={searchQuery} />
                </div>
            </div>
        </div>
    );
}

function RichTextPreview({ item, active, searchQuery }: { item: Item; active: boolean; searchQuery: string }) {
    const html = sanitizeRichHtml(item.getRichHtml());
    if (!richHtmlHasVisibleContent(html)) {
        return (
            <AutoScrollPreview active={active} className="card-preview-text">
                <HighlightedText text={item.getContent().trimStart()} query={searchQuery} />
            </AutoScrollPreview>
        );
    }
    return (
        <AutoScrollPreview
            active={active}
            className="card-preview-rich"
            html={highlightRichHtml(html, searchQuery)}
        />
    );
}

// Card Component
function ClipboardCardComponent({ item, selected, simulatedHover, refreshKey, searchQuery, shortcutHint, mediaPlaybackReady, t, onContextMenu }: {
    item: Item,
    selected: boolean,
    simulatedHover: boolean,
    refreshKey: number,
    searchQuery: string,
    shortcutHint?: string,
    mediaPlaybackReady: boolean,
    t: TFunction,
    onContextMenu: (item: Item, x: number, y: number) => void
}) {
    const dragStateRef = useRef<{ x: number, y: number, dragging: boolean } | null>(null);
    const visualType = isSingleImageFileItem(item) ? ItemType.Image : item.getType();
    const typeLabel = getTypeLabel(visualType, t);
    const typeClass = getTypeClass(visualType);
    const timestamp = formatRelativeTime(item.getTime(), t);
    const itemTagList = item.getTags();
    const [isGifFormat, setIsGifFormat] = useState(false);
    const formatTags = [
        item.isRichText() ? { key: "rich", label: t("clipboard.richFormat") } : null,
        isGifFormat ? { key: "gif", label: t("clipboard.gifFormat") } : null,
    ].filter((tag): tag is { key: string; label: string } => Boolean(tag));
    const initialHeaderColor = item.getTitleColor()
        ? { color: item.getTitleColor() as string, textColor: textColorForBackground(item.getTitleColor() as string) }
        : null;
    const [headerColor, setHeaderColor] = useState<DominantColor | null>(initialHeaderColor);
    const appIconPath = item.getAppIconPath();
    const appIconSrc = appIconPath ? convertFileSrc(appIconPath) : "";
    const formatTagColor = getFormatTagColor(visualType, headerColor, Boolean(appIconSrc));
    const [hovered, setHovered] = useState(false);
    const isMacosAppIcon = appIconPath.endsWith("-macos.png");
    const previewActive = selected || hovered || simulatedHover;
    const updateGifFormat = useCallback((gif: boolean) => {
        setIsGifFormat(gif);
    }, []);

    useEffect(() => {
        setHeaderColor(item.getTitleColor()
            ? { color: item.getTitleColor() as string, textColor: textColorForBackground(item.getTitleColor() as string) }
            : null);
    }, [item.getHash(), item.getTitleColor()]);

    return (
        <div
            className={`clipboard-card ${selected ? 'selected' : ''} ${simulatedHover ? 'simulated-hover' : ''}`}
            data-hash={item.getHash() as string}
            tabIndex={-1}
            draggable={false}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onMouseDown={(event) => {
                if (item.getType() === ItemType.Image && event.button === 0) {
                    dragStateRef.current = {
                        x: event.clientX,
                        y: event.clientY,
                        dragging: false,
                    };
                }
            }}
            onMouseMove={(event) => {
                const dragState = dragStateRef.current;
                if (!dragState || dragState.dragging || item.getType() !== ItemType.Image) return;
                if ((event.buttons & 1) !== 1) {
                    dragStateRef.current = null;
                    return;
                }

                const deltaX = event.clientX - dragState.x;
                const deltaY = event.clientY - dragState.y;
                const distance = Math.hypot(deltaX, deltaY);
                if (distance < 6) return;
                if (Math.abs(deltaX) > Math.abs(deltaY)) return;

                event.preventDefault();
                dragState.dragging = true;
                void invoke('native_drag_file', { path: item.getPreviewContent() })
                    .catch(e => error(`Native image drag failed: ${e}`))
                    .finally(() => {
                        dragStateRef.current = null;
                    });
            }}
            onMouseUp={() => {
                if (dragStateRef.current && !dragStateRef.current.dragging) {
                    dragStateRef.current = null;
                }
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(item, event.clientX, event.clientY);
            }}
        >
            {itemTagList.length > 0 && (
                <div className={`card-item-tags ${itemTagList.length > 2 ? 'scrolling' : ''}`} title={itemTagList.map(tag => tag.name).join(", ")}>
                    <div className="card-item-tags-track">
                        {(itemTagList.length > 2 ? [...itemTagList, ...itemTagList] : itemTagList).map((tag, index) => (
                            <span key={`${tag.id}-${index}`} className="card-item-tag">
                                {tag.name}
                            </span>
                        ))}
                    </div>
                </div>
            )}
            <div
                className={`card-header ${typeClass} ${appIconSrc ? 'with-app-icon' : ''}`}
                style={headerColor
                    ? { background: headerColor.color, color: headerColor.textColor }
                    : appIconSrc
                        ? { background: "linear-gradient(135deg, #747c87, #565e68)", color: "#fff" }
                        : undefined}
            >
                <div className="card-title-block">
                    <span className="card-title-row">
                        <span className="card-title">{typeLabel}</span>
                        {formatTags.map(tag => (
                            <span
                                key={tag.key}
                                className={`card-format-tag ${tag.key}-format-tag`}
                                style={{ color: formatTagColor }}
                            >
                                {tag.label}
                            </span>
                        ))}
                    </span>
                    <span className="card-timestamp">{timestamp}</span>
                </div>
                <span className="card-meta">
                    {item.isFavorite() && <span className="favorite-icon" title={t("clipboard.favorite")}>★</span>}
                </span>
                {appIconSrc && (
                    <div className={`app-icon-crop ${isMacosAppIcon ? 'macos-app-icon-crop' : ''}`} title={t("clipboard.source", { source: item.getAppSource() || t("clipboard.unknownApp") })}>
                        <img
                            className={`app-header-icon ${isMacosAppIcon ? 'macos-app-icon' : ''}`}
                            src={appIconSrc}
                            alt=""
                            onLoad={(event) => {
                                if (item.getTitleColor()) return;
                                const color = dominantColorFromImage(event.currentTarget);
                                if (color) setHeaderColor(color);
                            }}
                        />
                    </div>
                )}
            </div>
            <div className="card-content">
                {item.getType() === ItemType.Image ? (
                    <ImagePreview item={item} active={previewActive && mediaPlaybackReady} t={t} onGifFormatChange={updateGifFormat} />
                ) : item.getType() === ItemType.Color ? (
                    <div className="card-preview-color" style={{ background: item.getContent() }}>
                        <span className="color-value">
                            <HighlightedText text={item.getContent()} query={searchQuery} />
                        </span>
                    </div>
                ) : item.getType() === ItemType.Link ? (
                    <LinkPreview item={item} searchQuery={searchQuery} />
                ) : item.getType() === ItemType.File ? (
                    <FilePreview item={item} refreshKey={refreshKey} searchQuery={searchQuery} t={t} />
                ) : item.isRichText() ? (
                    <RichTextPreview item={item} active={previewActive} searchQuery={searchQuery} />
                ) : (
                    <AutoScrollPreview active={previewActive} className="card-preview-text">
                        <HighlightedText
                            text={(item.getType() === ItemType.TextFile ? item.getPreviewContent() : item.getContent()).trimStart()}
                            query={searchQuery}
                        />
                    </AutoScrollPreview>
                )}
                {shortcutHint && <div className="alt-card-hint">{shortcutHint}</div>}
            </div>
        </div>
    );
}

const ClipboardCard = React.memo(ClipboardCardComponent, (prev, next) => (
    prev.item === next.item
    && prev.selected === next.selected
    && prev.simulatedHover === next.simulatedHover
    && prev.refreshKey === next.refreshKey
    && prev.searchQuery === next.searchQuery
    && prev.shortcutHint === next.shortcutHint
    && prev.mediaPlaybackReady === next.mediaPlaybackReady
    && prev.t === next.t
));

export default function Clipboard() {
    const { t, languageCode } = useLanguage();
    const [selected, setSelected] = useState<String>("");
    const [searchWord, setSearchWord] = useState<String>("");
    const [searchOpen, setSearchOpen] = useState<boolean>(false);
    const [activeTab, setActiveTab] = useState<string>("all");
    const [customTabs, setCustomTabs] = useState<CustomTab[]>(loadCustomTabs);
    const [tabOrder, setTabOrder] = useState<string[]>(loadTabOrder);
    const [draggingTabId, setDraggingTabId] = useState<string>("");
    const [toast, setToast] = useState<ToastState>(null);
    const [fileRefreshKey, setFileRefreshKey] = useState(0);
    const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
    const [contextMenuIndex, setContextMenuIndex] = useState(0);
    const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState>(null);
    const [tagCreateChoice, setTagCreateChoice] = useState<TagCreateChoiceState>(null);
    const [deleteConfirmTab, setDeleteConfirmTab] = useState<CustomTab | null>(null);
    const [deleteConfirmRecordTag, setDeleteConfirmRecordTag] = useState<ItemTag | null>(null);
    const [itemTags, setItemTags] = useState<ItemTag[]>([]);
    const [hasMoreHistory, setHasMoreHistory] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [altHintsVisible, setAltHintsVisible] = useState(false);
    const [simulatedHoverHash, setSimulatedHoverHash] = useState("");
    const [tutorialActive, setTutorialActive] = useState(false);
    const [tutorialRunId, setTutorialRunId] = useState(0);
    const [tutorialPermissionStatus, setTutorialPermissionStatus] = useState<TutorialPermissionStatus | null>(null);
    const [tutorialPlatform, setTutorialPlatform] = useState<TutorialPlatform>(() => isMacPlatform() ? "mac" : "windows");
    const [mainShortcut, setMainShortcut] = useState(DEFAULT_MAIN_SHORTCUT);

    // Initialize with mock data
    const [clipboardPage, setPage] = useState(() => {
        return new ClipboardPage([], 0);
    });

    const [animationState, setAnimationState] = useState<'hidden' | 'entering' | 'entered' | 'exiting'>('entered');
    const animationTimerRef = useRef<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const cardsContainerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const addTabButtonRef = useRef<HTMLButtonElement>(null);
    const toastTimerRef = useRef<number | null>(null);
    const altHintTimerRef = useRef<number | null>(null);
    const scrollRefreshTimerRef = useRef<number | null>(null);
    const imagePrewarmTimerRef = useRef<number | null>(null);
    const lastLoadMoreCheckRef = useRef(0);
    const wheelScrollDeltaRef = useRef(0);
    const wheelScrollFrameRef = useRef<number | null>(null);
    const searchDebounceTimerRef = useRef<number | null>(null);
    const searchRequestSeqRef = useRef(0);
    const lastHistoryFetchRef = useRef<{ keywords: string; tab: string } | null>(null);
    const dragScrollRef = useRef<{
        active: boolean;
        moved: boolean;
        cancelActivation: boolean;
        targetHash: string;
        startX: number;
        startY: number;
        lastX: number;
        lastTime: number;
        velocity: number;
        pendingDelta: number;
        frame: number | null;
    } | null>(null);
    const suppressClickAfterDragRef = useRef(false);
    const searchWordRef = useRef("");
    const activeTabRef = useRef("all");
    const tutorialActiveRef = useRef(false);
    const selectedRef = useRef("");
    const pageListRef = useRef<Item[]>([]);
    const pasteAsTextShortcutRef = useRef(DEFAULT_PASTE_AS_TEXT_SHORTCUT);
    const quickInputEnabledRef = useRef(true);
    const tabQuickSelectEnabledRef = useRef(true);
    const linkAutoPreviewRef = useRef(true);
    const linkPreviewRefreshingRef = useRef(false);
    const imageClipboardCachePrewarmRef = useRef<Set<string>>(new Set());
    const hasMoreHistoryRef = useRef(true);
    const isLoadingMoreRef = useRef(false);
    const customTabsStorageReadyRef = useRef(false);
    const pendingRecordTagAssignTargetRef = useRef<Item | null>(null);
    const previewRequestSeqRef = useRef(0);
    const activateClipboardCardRef = useRef<(hash: string, plainText: boolean) => void>(() => { });
    const dynamicTabs = useMemo(
        () => orderedDynamicTabs(customTabs, itemTags, tabOrder),
        [customTabs, itemTags, tabOrder],
    );
    const openClipboardContextMenuRef = useRef<(item: Item, clientX: number, clientY: number) => void>(() => { });

    const activateClipboardCard = useCallback((hash: string, plainText: boolean) => {
        activateClipboardCardRef.current(hash, plainText);
    }, []);

    const openClipboardContextMenu = useCallback((item: Item, clientX: number, clientY: number) => {
        openClipboardContextMenuRef.current(item, clientX, clientY);
    }, []);

    const clearAltHintTimer = () => {
        if (altHintTimerRef.current !== null) {
            window.clearTimeout(altHintTimerRef.current);
            altHintTimerRef.current = null;
        }
    };

    const hideAltHints = () => {
        clearAltHintTimer();
        setAltHintsVisible(false);
    };

    const pollAltKeyState = () => {
        clearAltHintTimer();
        altHintTimerRef.current = window.setTimeout(() => {
            void invoke<boolean>('is_alt_key_pressed')
                .then(pressed => {
                    altHintTimerRef.current = null;
                    if (pressed && quickInputEnabledRef.current) {
                        setAltHintsVisible(true);
                        pollAltKeyState();
                    } else {
                        setAltHintsVisible(false);
                    }
                })
                .catch(e => {
                    altHintTimerRef.current = null;
                    error(`Failed to read Alt key state: ${e}`);
                });
        }, 40);
    };

    const showAltHintsWhilePressed = () => {
        if (!quickInputEnabledRef.current) {
            hideAltHints();
            return;
        }
        setAltHintsVisible(true);
        pollAltKeyState();
    };

    const syncAltHintsFromNative = () => {
        void invoke<boolean>('is_alt_key_pressed')
            .then(pressed => {
                if (pressed && quickInputEnabledRef.current) {
                    showAltHintsWhilePressed();
                } else {
                    hideAltHints();
                }
            })
            .catch(e => error(`Failed to sync Alt key state: ${e}`));
    };

    const switchToTabWithShortcut = (tabId: string) => {
        setContextMenu(null);
        setTabContextMenu(null);
        activeTabRef.current = tabId;
        setActiveTab(tabId);
    };

    const activateItemShortcut = (index: number) => {
        const item = pageListRef.current[index];
        if (!item) return;
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash() as string);
        hideAltHints();
        void clickClipboardItem(item.getHash(), false, true, String(index + 1));
    };

    const selectFirstLoadedItem = (scroll: boolean = false) => {
        const firstHash = pageListRef.current[0]?.getHash() as string | undefined;
        if (!firstHash) return;
        selectedRef.current = firstHash;
        setSelected(firstHash);
        if (scroll && cardsContainerRef.current) {
            cardsContainerRef.current.scrollLeft = 0;
        }
    };

    useEffect(() => {
        searchWordRef.current = searchWord as string;
    }, [searchWord]);

    useEffect(() => {
        activeTabRef.current = activeTab;
    }, [activeTab]);

    useEffect(() => {
        tutorialActiveRef.current = tutorialActive;
    }, [tutorialActive]);

    useEffect(() => {
        const activeRecordTagId = recordTagIdFromTab(activeTab);
        if (activeRecordTagId === null) return;
        if (itemTags.some(tag => tag.id === activeRecordTagId)) return;
        activeTabRef.current = "all";
        setActiveTab("all");
    }, [activeTab, itemTags]);

    useEffect(() => {
        const localTabs = loadCustomTabs();
        void loadItemTags();
        void invoke<unknown>('get_custom_tabs')
            .then(value => {
                const storedTabs = normalizeCustomTabs(value);
                customTabsStorageReadyRef.current = true;
                if (storedTabs.length > 0) {
                    saveCustomTabs(storedTabs);
                    setCustomTabs(storedTabs);
                } else if (localTabs.length > 0) {
                    persistCustomTabs(localTabs);
                }
            })
            .catch(e => {
                customTabsStorageReadyRef.current = true;
                error(`Failed to load stored custom tabs: ${e}`);
            });
    }, []);

    useEffect(() => {
        saveCustomTabs(customTabs);
        if (customTabsStorageReadyRef.current) {
            void invoke('save_custom_tabs', { tabs: customTabs })
                .catch(e => error(`Failed to save stored custom tabs: ${e}`));
        }
        const activeRecordTagId = recordTagIdFromTab(activeTab);
        const activeRecordTagExists = activeRecordTagId !== null && itemTags.some(tag => tag.id === activeRecordTagId);
        if (activeTab !== "all" && activeTab !== "favorite" && !activeRecordTagExists && !customTabs.some(tab => tab.id === activeTab)) {
            setActiveTab("all");
        }
    }, [activeTab, customTabs, itemTags]);

    useEffect(() => {
        const normalizedOrder = dynamicTabs.map(tab => tab.id);
        if (!arraysEqual(tabOrder, normalizedOrder)) {
            setTabOrder(normalizedOrder);
        }
        saveTabOrder(normalizedOrder);
    }, [dynamicTabs, tabOrder]);

    useEffect(() => {
        selectedRef.current = selected as string;
    }, [selected]);

    useEffect(() => {
        pageListRef.current = clipboardPage.list;
    }, [clipboardPage]);

    useEffect(() => {
        hasMoreHistoryRef.current = hasMoreHistory;
    }, [hasMoreHistory]);

    useEffect(() => {
        isLoadingMoreRef.current = isLoadingMore;
    }, [isLoadingMore]);

    const clearAnimationTimer = () => {
        if (animationTimerRef.current !== null) {
            window.clearTimeout(animationTimerRef.current);
            animationTimerRef.current = null;
        }
    };

    const hideCurrentWindowWithAnimation = async () => {
        clearAnimationTimer();
        setAnimationState('exiting');
        const generation = await invoke<number>('begin_hide_clipboard_window')
            .catch(e => {
                error(`Failed to mark clipboard hiding: ${e}`);
                return 0;
            });
        await new Promise(resolve => window.setTimeout(resolve, CLIPBOARD_ANIMATION_MS));
        await invoke('finish_hide_clipboard_window', { generation });
        setAnimationState('hidden');
    };

    const focusSearchInput = () => {
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
    };

    const showToast = (
        message: string,
        kind: ToastKind = 'info',
        durationMs: number = 2500,
        actionLabel?: string,
        onAction?: () => void,
    ) => {
        if (toastTimerRef.current !== null) {
            window.clearTimeout(toastTimerRef.current);
        }
        setToast({ id: Date.now(), message, kind, actionLabel, onAction });
        toastTimerRef.current = window.setTimeout(() => {
            setToast(null);
            toastTimerRef.current = null;
        }, durationMs);
    };

    const loadItemTags = async (): Promise<ItemTag[]> => {
        try {
            const tags = await invoke<ItemTag[]>('list_item_tags');
            setItemTags(tags);
            return tags;
        } catch (e) {
            error(`Failed to load item tags: ${e}`);
            return itemTags;
        }
    };

    const openRecordTagCreateEditorForItem = (item: Item) => {
        setContextMenu(null);
        setTabContextMenu(null);
        pendingRecordTagAssignTargetRef.current = item;
        openTabEditorWindow("add", "record", undefined, undefined, addTabButtonRef.current);
    };

    const appendTabOrderId = (tabId: string) => {
        setTabOrder(order => {
            const next = [...order.filter(id => id !== tabId), tabId];
            saveTabOrder(next);
            return next;
        });
    };

    const removeTabOrderId = (tabId: string) => {
        setTabOrder(order => {
            const next = order.filter(id => id !== tabId);
            saveTabOrder(next);
            return next;
        });
    };

    const updateItemTagsInPage = (item: Item, nextTags: ItemTag[]) => {
        const hash = item.getHash() as string;
        const activeRecordTagId = recordTagIdFromTab(activeTabRef.current);
        setPage(page => {
            let nextList = page.list.map(candidate =>
                candidate.getHash() === hash ? candidate.withTags(nextTags) : candidate
            );
            if (activeRecordTagId !== null && !nextTags.some(tag => tag.id === activeRecordTagId)) {
                nextList = nextList.filter(candidate => candidate.getHash() !== hash);
            }
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const removeRecordTagFromPageItems = (tagId: number) => {
        setPage(page => {
            const nextList = page.list.map(item => {
                const nextTags = item.getTags().filter(tag => tag.id !== tagId);
                return nextTags.length === item.getTags().length ? item : item.withTags(nextTags);
            });
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const updateRecordTagOnPageItems = (updatedTag: ItemTag) => {
        setPage(page => {
            const nextList = page.list.map(item => {
                const nextTags = item.getTags().map(tag => tag.id === updatedTag.id ? updatedTag : tag);
                return nextTags.some((tag, index) => tag !== item.getTags()[index])
                    ? item.withTags(nextTags)
                    : item;
            });
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const assignPendingRecordTagToItem = async (tag: ItemTag) => {
        const target = pendingRecordTagAssignTargetRef.current;
        pendingRecordTagAssignTargetRef.current = null;
        if (!target) return;
        try {
            await invoke('assign_item_tag', { hash: target.getHash(), tagId: tag.id });
            updateItemTagsInPage(target, [...target.getTags().filter(candidate => candidate.id !== tag.id), tag]);
            showToast(t("tags.createdAndAssigned", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const applyItemTagsChanged = (payload: ItemTagsChangedPayload | null | undefined) => {
        if (payload?.tag) {
            setItemTags(tags => {
                const exists = tags.some(tag => tag.id === payload.tag?.id);
                return exists
                    ? tags.map(tag => tag.id === payload.tag?.id ? payload.tag as ItemTag : tag)
                    : [...tags, payload.tag as ItemTag];
            });
            updateRecordTagOnPageItems(payload.tag);
        }
        void loadItemTags();
        if (payload?.activeId) {
            appendTabOrderId(payload.activeId);
            activeTabRef.current = payload.activeId;
            setActiveTab(payload.activeId);
        }
        if (payload?.tag) {
            void assignPendingRecordTagToItem(payload.tag);
        }
    };

    const consumePendingItemTagsChanged = () => {
        const raw = localStorage.getItem(PENDING_ITEM_TAGS_CHANGED_KEY);
        if (!raw) return;
        localStorage.removeItem(PENDING_ITEM_TAGS_CHANGED_KEY);
        try {
            applyItemTagsChanged(JSON.parse(raw) as ItemTagsChangedPayload);
        } catch (e) {
            error(`Failed to consume pending item tag change: ${e}`);
            void loadItemTags();
        }
    };

    const deleteRecordTag = async (tag: ItemTag) => {
        try {
            await invoke('delete_item_tag', { id: tag.id });
            removeTabOrderId(recordTagTabId(tag.id));
            setItemTags(tags => tags.filter(candidate => candidate.id !== tag.id));
            removeRecordTagFromPageItems(tag.id);
            if (activeTabRef.current === recordTagTabId(tag.id)) {
                activeTabRef.current = "all";
                setActiveTab("all");
            }
            void loadItemTags();
            setDeleteConfirmRecordTag(null);
            setTabContextMenu(null);
            showToast(t("tags.deleted", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const openPasteAccessibilityGuide = async () => {
        const payload = { permission: "paste", languageCode };
        localStorage.setItem(PENDING_PERMISSION_WINDOW_KEY, JSON.stringify(payload));
        setContextMenu(null);
        await invoke("open_onboarding_permission_window", payload);
    };

    const ensurePasteAccessibilityPermission = async (): Promise<boolean> => {
        try {
            const status = await invoke<PasteAccessibilityPermissionStatus>('ensure_paste_accessibility_permission');
            if (status.granted) {
                return true;
            }
            await openPasteAccessibilityGuide();
            return false;
        } catch (e) {
            error(`Failed to check Accessibility permission: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
            return false;
        }
    };

    const loadBehaviorConfig = async (): Promise<ClipboardBehaviorConfig> => {
        try {
            const config = JSON.parse(await invoke<string>('get_config'));
            return config as ClipboardBehaviorConfig;
        } catch (e) {
            error(`Failed to load clipboard behavior config: ${e}`);
            return {};
        }
    };

    const refreshTutorialPermissionStatus = async (): Promise<TutorialPermissionStatus | null> => {
        try {
            const status = await invoke<TutorialPermissionStatus>('get_onboarding_permission_status');
            setTutorialPermissionStatus(status);
            return status;
        } catch (e) {
            error(`Failed to refresh tutorial permission status: ${e}`);
            return null;
        }
    };

    const refreshTutorialConfig = async () => {
        const config = await loadBehaviorConfig();
        setMainShortcut(config.shortcut_keys?.main_window || DEFAULT_MAIN_SHORTCUT);
        return config;
    };

    const startTutorial = async (platform: TutorialPlatform = isMacPlatform() ? "mac" : "windows") => {
        setContextMenu(null);
        setTabContextMenu(null);
        setTagCreateChoice(null);
        setDeleteConfirmTab(null);
        setDeleteConfirmRecordTag(null);
        setSearchWord("");
        setSearchOpen(false);
        hideAltHints();
        activeTabRef.current = "all";
        setActiveTab("all");
        suppressClickAfterDragRef.current = false;
        setTutorialPlatform(platform);
        setTutorialRunId(id => id + 1);
        setTutorialActive(true);
        void refreshTutorialConfig();
        if (platform === "mac") {
            setTutorialPermissionStatus(null);
            void refreshTutorialPermissionStatus();
        }
    };

    const handleTutorialPermissionAction = async (id: TutorialPermissionId) => {
        try {
            const payload = { permission: id, languageCode };
            localStorage.setItem(PENDING_PERMISSION_WINDOW_KEY, JSON.stringify(payload));
            await invoke("open_onboarding_permission_window", payload);
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const makeTutorialFilterTab = (id: TutorialFilterId): CustomTab | null => {
        const meta = TUTORIAL_FILTER_TABS.find(tab => tab.id === id);
        if (!meta) return null;
        return {
            id: tutorialFilterTabId(id),
            name: `${meta.emoji} ${t(meta.titleKey)}`,
            filter: { ...DEFAULT_CUSTOM_FILTER, itemType: meta.itemType },
        };
    };

    const handleTutorialFilterToggle = (id: TutorialFilterId, enabled: boolean) => {
        const tabId = tutorialFilterTabId(id);
        const tab = makeTutorialFilterTab(id);
        if (!tab) return;

        setCustomTabs(tabs => {
            const exists = tabs.some(candidate => candidate.id === tabId);
            if (enabled && !exists) return [...tabs, tab];
            if (!enabled && exists) return tabs.filter(candidate => candidate.id !== tabId);
            return tabs;
        });

        if (enabled) {
            appendTabOrderId(tabId);
        } else {
            removeTabOrderId(tabId);
            if (activeTabRef.current === tabId) {
                activeTabRef.current = "all";
                setActiveTab("all");
            }
        }
    };

    const completeTutorial = async () => {
        try {
            await invoke("complete_onboarding");
            setTutorialActive(false);
            void fetchHistory();
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };
    const tabLabelForBackend = (tabId: string): string => {
        if (tabId === "favorite") return "__favorite";
        if (tabId === "all") return "__all";
        const recordTagId = recordTagIdFromTab(tabId);
        if (recordTagId !== null) {
            return `__filter:${JSON.stringify({ mode: "record-tag", record_tag_ids: [recordTagId] })}`;
        }
        const tab = customTabs.find(candidate => candidate.id === tabId);
        return tab ? customTabFilterPayload(tab) : "__all";
    };

    const openTagCreateChoice = (clientX: number, clientY: number) => {
        const position = floatingPositionFromClick(clientX, clientY, TAG_CREATE_CHOICE_WIDTH, TAG_CREATE_CHOICE_HEIGHT);
        setContextMenu(null);
        setTabContextMenu(null);
        setTagCreateChoice({ ...position, originX: clientX, originY: clientY });
    };

    const openTabEditorWindow = (mode: TabEditorMode, kind: TagEditorKind, tab?: CustomTab, recordTag?: ItemTag, anchor?: HTMLElement | null) => {
        const popupHeight = kind === "record" ? RECORD_TAG_EDITOR_HEIGHT : FILTER_TAG_EDITOR_HEIGHT;
        const position = screenFloatingPositionFromAnchor(anchor, TAB_EDITOR_WIDTH, popupHeight);
        const payload = JSON.stringify({ mode, kind, tab, recordTag, tabs: customTabs, languageCode });
        localStorage.setItem("vpaste.pendingTabEditorPayload", payload);
        void invoke('open_tab_editor_window', { x: position.x, y: position.y, width: TAB_EDITOR_WIDTH, height: popupHeight, payload })
            .catch(e => {
                error(`Failed to open tab editor window: ${e}`);
                showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
            });
    };

    const openTabEditorWindowAt = (mode: TabEditorMode, kind: TagEditorKind, tab: CustomTab | undefined, recordTag: ItemTag | undefined, clientX: number, clientY: number) => {
        const popupHeight = kind === "record" ? RECORD_TAG_EDITOR_HEIGHT : FILTER_TAG_EDITOR_HEIGHT;
        const payload = JSON.stringify({ mode, kind, tab, recordTag, tabs: customTabs, languageCode });
        localStorage.setItem("vpaste.pendingTabEditorPayload", payload);
        const position = screenAnchoredPositionFromClick(clientX, clientY, TAB_EDITOR_WIDTH, popupHeight);
        void invoke('open_tab_editor_window', {
            x: position.x,
            y: position.y,
            width: TAB_EDITOR_WIDTH,
            height: popupHeight,
            payload,
        }).catch(e => {
            error(`Failed to open tab editor window: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        });
    };

    const openEditTabEditor = (tab: CustomTab, anchor?: HTMLElement | null) => {
        openTabEditorWindow("edit", "filter", tab, undefined, anchor);
    };

    const openEditRecordTagEditor = (tag: ItemTag, anchor?: HTMLElement | null) => {
        openTabEditorWindow("edit", "record", undefined, tag, anchor);
    };

    const deleteCustomTab = (tab: CustomTab) => {
        removeTabOrderId(tab.id);
        setCustomTabs(tabs => tabs.filter(candidate => candidate.id !== tab.id));
        if (activeTabRef.current === tab.id) {
            activeTabRef.current = "all";
            setActiveTab("all");
        }
        setDeleteConfirmTab(null);
        setTabContextMenu(null);
    };

    const handleTabDrop = (targetId: string) => {
        if (!draggingTabId || draggingTabId === targetId) return;
        setTabOrder(order => {
            const currentOrder = orderedDynamicTabs(customTabs, itemTags, order).map(tab => tab.id);
            const sourceIndex = currentOrder.indexOf(draggingTabId);
            const targetIndex = currentOrder.indexOf(targetId);
            if (sourceIndex === -1 || targetIndex === -1) return order;
            const next = [...currentOrder];
            const [moved] = next.splice(sourceIndex, 1);
            next.splice(targetIndex, 0, moved);
            saveTabOrder(next);
            return next;
        });
        setDraggingTabId("");
    };

    const scheduleFileRefresh = (delay: number = 320) => {
        if (scrollRefreshTimerRef.current !== null) {
            window.clearTimeout(scrollRefreshTimerRef.current);
        }
        scrollRefreshTimerRef.current = window.setTimeout(() => {
            setFileRefreshKey(key => key + 1);
            scrollRefreshTimerRef.current = null;
        }, delay);
    };

    const stopDragInertia = () => {
        if (dragScrollRef.current?.frame !== null && dragScrollRef.current?.frame !== undefined) {
            window.cancelAnimationFrame(dragScrollRef.current.frame);
        }
        if (dragScrollRef.current) {
            dragScrollRef.current.frame = null;
        }
    };

    const scrollCardIntoView = (index: number, behavior: ScrollBehavior = 'auto') => {
        const container = cardsContainerRef.current;
        const cards = container?.querySelectorAll<HTMLElement>('.clipboard-card');
        const card = cards?.item(index);
        if (!container || !card) return;

        const cardLeft = card.offsetLeft;
        const cardRight = cardLeft + card.offsetWidth;
        const visibleLeft = container.scrollLeft;
        const visibleRight = visibleLeft + container.clientWidth;
        const edgePadding = 24;
        let nextScrollLeft = visibleLeft;

        if (cardLeft - edgePadding < visibleLeft) {
            nextScrollLeft = Math.max(0, cardLeft - edgePadding);
        } else if (cardRight + edgePadding > visibleRight) {
            nextScrollLeft = cardRight + edgePadding - container.clientWidth;
        }

        if (nextScrollLeft !== visibleLeft) {
            container.scrollTo({ left: nextScrollLeft, behavior });
            maybeLoadMoreHistory();
        }
    };

    const selectCardAt = (index: number, behavior: ScrollBehavior = 'auto'): Item | null => {
        const list = pageListRef.current;
        if (list.length === 0) {
            setSelected("");
            selectedRef.current = "";
            return null;
        }
        const nextIndex = Math.max(0, Math.min(index, list.length - 1));
        const item = list[nextIndex];
        const nextHash = item.getHash() as string;
        selectedRef.current = nextHash;
        setSelected(nextHash);
        scrollCardIntoView(nextIndex, behavior);
        return item;
    };

    const isPreviewableDomainLink = (url: string) => {
        try {
            const parsed = new URL(url.trim());
            if (parsed.protocol !== "https:") return false;
            const host = parsed.hostname;
            if (!host.includes(".")) return false;
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
            return /^[a-z0-9.-]+$/i.test(host);
        } catch {
            return false;
        }
    };

    const scheduleLinkPreviewRefresh = (items: Item[]) => {
        if (!linkAutoPreviewRef.current || linkPreviewRefreshingRef.current) return;
        const urls = items
            .filter(item => item.getType() === ItemType.Link)
            .slice(0, 10)
            .map(item => parseLinkContent(item.getContent()).url)
            .filter(isPreviewableDomainLink);

        if (urls.length === 0) return;

        linkPreviewRefreshingRef.current = true;
        void invoke<LinkPreviewUpdate[]>("refresh_link_previews", { urls })
            .then(updates => {
                if (updates.length > 0) {
                    window.setTimeout(() => {
                        void fetchHistoryWith(searchWordRef.current, activeTabRef.current, { background: true });
                    }, 220);
                }
            })
            .catch(e => error(`Failed to refresh link previews: ${e}`))
            .finally(() => {
                linkPreviewRefreshingRef.current = false;
            });
    };

    const scheduleImageClipboardCachePrewarm = (items: Item[]) => {
        const paths = items
            .filter(item => item.getType() === ItemType.Image)
            .map(item => item.getContent())
            .filter(path => path && !imageClipboardCachePrewarmRef.current.has(path))
            .slice(0, 18);

        if (paths.length === 0) return;
        paths.forEach(path => imageClipboardCachePrewarmRef.current.add(path));
        if (imagePrewarmTimerRef.current !== null) {
            window.clearTimeout(imagePrewarmTimerRef.current);
        }
        imagePrewarmTimerRef.current = window.setTimeout(() => {
            imagePrewarmTimerRef.current = null;
            const firstWave = paths.slice(0, 8);
            const secondWave = paths.slice(8, 18);
            void Promise.all([
                invoke("prewarm_image_preview_cache", { paths: firstWave }),
                invoke("prewarm_image_clipboard_cache", { paths: firstWave.slice(0, 4) }),
            ])
                .catch(e => {
                    firstWave.forEach(path => imageClipboardCachePrewarmRef.current.delete(path));
                    error(`Failed to prewarm image caches: ${e}`);
                });
            if (secondWave.length > 0) {
                window.setTimeout(() => {
                    void invoke("prewarm_image_preview_cache", { paths: secondWave })
                        .catch(e => {
                            secondWave.forEach(path => imageClipboardCachePrewarmRef.current.delete(path));
                            error(`Failed to prewarm deferred image previews: ${e}`);
                        });
                }, 1400);
            }
        }, 900);
    };

    async function fetchHistoryWith(keywords: string, tab: string, options: { selectFirst?: boolean, background?: boolean } = {}) {
        const requestSeq = ++searchRequestSeqRef.current;
        try {
            const tagSearch = parseTagSearch(keywords);
            const label = mergeTagSearchFilter(tabLabelForBackend(tab), tagSearch.tagNames);
            const res = await invoke<string>('search', {
                keywords: tagSearch.keywords,
                lastId: 0,
                lastTime: 0,
                limit: HISTORY_PAGE_LIMIT,
                label,
            });
            if (requestSeq !== searchRequestSeqRef.current) {
                return;
            }
            const page = JSON.parse(res);
            const items = page.list.map(itemFromPayload);
            pageListRef.current = items;
            lastHistoryFetchRef.current = { keywords, tab };
            setPage(new ClipboardPage(items, page.consumed));
            setHasMoreHistory(items.length === HISTORY_PAGE_LIMIT);
            const selectedIndex = items.findIndex((item: Item) => item.getHash() === selectedRef.current);
            if (options.selectFirst || selectedIndex === -1) {
                const firstHash = items[0]?.getHash() as string | undefined;
                selectedRef.current = firstHash || "";
                setSelected(firstHash || "");
                if (firstHash) {
                    scrollCardIntoView(0);
                }
            } else if (selectedIndex >= 0) {
                scrollCardIntoView(selectedIndex);
            }
            if (!options.background) {
                scheduleLinkPreviewRefresh(items);
                scheduleImageClipboardCachePrewarm(items);
            }
        } catch (e) {
            error(`Failed to fetch history: ${e}`);
        }
    }

    const loadMoreHistory = async () => {
        const currentList = pageListRef.current;
        if (isLoadingMoreRef.current || !hasMoreHistoryRef.current || currentList.length === 0) {
            return;
        }

        const lastItem = currentList[currentList.length - 1];
        setIsLoadingMore(true);
        isLoadingMoreRef.current = true;
        try {
            const tagSearch = parseTagSearch(searchWordRef.current);
            const label = mergeTagSearchFilter(tabLabelForBackend(activeTabRef.current), tagSearch.tagNames);
            const res = await invoke<string>('search', {
                keywords: tagSearch.keywords,
                lastId: lastItem.getId(),
                lastTime: lastItem.getTime(),
                limit: HISTORY_PAGE_LIMIT,
                label,
            });
            const page = JSON.parse(res);
            const nextItems = page.list.map(itemFromPayload);
            const existingHashes = new Set(currentList.map(item => item.getHash()));
            const merged = currentList.concat(nextItems.filter((item: Item) => !existingHashes.has(item.getHash())));
            pageListRef.current = merged;
            setPage(new ClipboardPage(merged, page.consumed));
            setHasMoreHistory(nextItems.length === HISTORY_PAGE_LIMIT);
            scheduleImageClipboardCachePrewarm(nextItems);
        } catch (e) {
            error(`Failed to load more history: ${e}`);
        } finally {
            setIsLoadingMore(false);
            isLoadingMoreRef.current = false;
        }
    };

    const maybeLoadMoreHistory = (force: boolean = false) => {
        const now = performance.now();
        if (!force && now - lastLoadMoreCheckRef.current < 120) {
            return;
        }
        lastLoadMoreCheckRef.current = now;
        const container = cardsContainerRef.current;
        if (!container) return;
        const distanceToEnd = container.scrollWidth - container.scrollLeft - container.clientWidth;
        if (distanceToEnd < 360) {
            void loadMoreHistory();
        }
    };

    const fetchHistory = async () => {
        await fetchHistoryWith(searchWordRef.current, activeTabRef.current);
    };

    const applyShowPreferences = async () => {
        const config = await loadBehaviorConfig();
        pasteAsTextShortcutRef.current = config.shortcut_keys?.paste_into_plain_text || DEFAULT_PASTE_AS_TEXT_SHORTCUT;
        quickInputEnabledRef.current = config.quick_input_enabled !== false;
        if (!quickInputEnabledRef.current) {
            hideAltHints();
        }
        tabQuickSelectEnabledRef.current = config.tab_quick_select_enabled !== false;
        linkAutoPreviewRef.current = config.link_auto_preview !== false;
        const nextSearchWord = config.retain_search_history ? searchWordRef.current : "";
        const nextActiveTab = config.retain_tab_position ? activeTabRef.current : "all";

        if (!config.retain_search_history) {
            setSearchWord("");
            setSearchOpen(false);
        }

        if (!config.retain_tab_position) {
            activeTabRef.current = "all";
            setActiveTab("all");
        }

        if (!config.retain_last_position) {
            if (cardsContainerRef.current) {
                cardsContainerRef.current.scrollLeft = 0;
            }
            selectFirstLoadedItem(true);
        } else if (!selectedRef.current) {
            selectFirstLoadedItem(false);
        }

        const cachedFetch = lastHistoryFetchRef.current;
        if (
            cachedFetch?.keywords === nextSearchWord
            && cachedFetch?.tab === nextActiveTab
            && pageListRef.current.length > 0
        ) {
            return;
        }

        await fetchHistoryWith(nextSearchWord, nextActiveTab, { selectFirst: !config.retain_last_position });
    };

    const resetCardsPointerState = () => {
        const dragState = dragScrollRef.current;
        if (dragState?.frame !== null && dragState?.frame !== undefined) {
            window.cancelAnimationFrame(dragState.frame);
        }
        dragScrollRef.current = null;
        suppressClickAfterDragRef.current = false;
        cardsContainerRef.current?.classList.remove('dragging');
    };

    useEffect(() => {
        const unlistenShow = listen<{ x: number, y: number } | null>('window-show', event => {
            clearAnimationTimer();
            resetCardsPointerState();
            selectFirstLoadedItem(true);
            void applyShowPreferences();
            if (event.payload) {
                window.requestAnimationFrame(() => {
                    const card = document.elementFromPoint(event.payload!.x, event.payload!.y)?.closest<HTMLElement>('.clipboard-card');
                    setSimulatedHoverHash(card?.dataset.hash || "");
                });
            } else {
                setSimulatedHoverHash("");
            }
            syncAltHintsFromNative();
            window.setTimeout(syncAltHintsFromNative, 70);
            window.setTimeout(syncAltHintsFromNative, 160);
            scheduleFileRefresh(CLIPBOARD_ANIMATION_MS + 140);
            setAnimationState('entering');
            animationTimerRef.current = window.setTimeout(() => {
                setAnimationState('entered');
                animationTimerRef.current = null;
            }, CLIPBOARD_ANIMATION_MS);
        });

        const unlistenHide = listen('window-hide', () => {
            clearAnimationTimer();
            resetCardsPointerState();
            searchRequestSeqRef.current += 1;
            if (scrollRefreshTimerRef.current !== null) {
                window.clearTimeout(scrollRefreshTimerRef.current);
                scrollRefreshTimerRef.current = null;
            }
            if (imagePrewarmTimerRef.current !== null) {
                window.clearTimeout(imagePrewarmTimerRef.current);
                imagePrewarmTimerRef.current = null;
            }
            hideAltHints();
            setAnimationState('exiting');
            animationTimerRef.current = window.setTimeout(() => {
                setAnimationState('hidden');
                animationTimerRef.current = null;
            }, CLIPBOARD_ANIMATION_MS);
        });

        const unlistenClipboard = listen<string>('listen_new_clipboard', (_) => {
            void fetchHistory();
        });

        const unlistenTutorialStarted = listen('tutorial-started', () => {
            void startTutorial();
        });

        const unlistenTutorialCompleted = listen('tutorial-completed', () => {
            setTutorialActive(false);
        });

        const unlistenPermissionStatusChanged = listen('onboarding-permission-status-changed', () => {
            void refreshTutorialPermissionStatus();
        });

        const unlistenCustomTabs = listen<{ activeId?: string, tabs?: CustomTab[] } | string>('custom-tabs-changed', event => {
            const payload = typeof event.payload === "string"
                ? JSON.parse(event.payload || "{}") as { activeId?: string, tabs?: CustomTab[] }
                : event.payload;
            const tabs = Array.isArray(payload?.tabs) ? payload.tabs : loadCustomTabs();
            persistCustomTabs(tabs);
            setCustomTabs(tabs);
            if (payload?.activeId) {
                appendTabOrderId(payload.activeId);
                activeTabRef.current = payload.activeId;
                setActiveTab(payload.activeId);
            }
            void fetchHistoryWith(searchWordRef.current, activeTabRef.current);
        });

        const unlistenItemTags = listen<ItemTagsChangedPayload | string>('item-tags-changed', event => {
            const payload = typeof event.payload === "string"
                ? JSON.parse(event.payload || "{}") as ItemTagsChangedPayload
                : event.payload;
            localStorage.removeItem(PENDING_ITEM_TAGS_CHANGED_KEY);
            applyItemTagsChanged(payload);
        });

        const unlistenPreviewNavigation = listen<PreviewNavigationPayload>('preview-navigate-selection', event => {
            if (event.payload?.key === "Tab" && !tabQuickSelectEnabledRef.current) return;
            const direction = event.payload?.direction === -1 ? -1 : 1;
            navigateSelectedCard(direction);
        });

        const handleWindowBlur = () => {
            setContextMenu(null);
            setTabContextMenu(null);
            window.setTimeout(() => {
                void invoke('hide_clipboard_if_inactive').catch(e => error(`Failed to hide inactive clipboard window: ${e}`));
            }, 60);
        };
        const closeContextMenu = () => {
            setContextMenu(null);
            setTabContextMenu(null);
            setTagCreateChoice(null);
        };
        const handleWindowFocus = () => {
            consumePendingItemTagsChanged();
            if (tutorialActiveRef.current && isMacPlatform()) {
                void refreshTutorialPermissionStatus();
            }
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && tutorialActiveRef.current && isMacPlatform()) {
                void refreshTutorialPermissionStatus();
            }
        };
        const handleStorage = (event: StorageEvent) => {
            if (event.key === PENDING_ITEM_TAGS_CHANGED_KEY && event.newValue) {
                consumePendingItemTagsChanged();
            }
        };
        const clearSimulatedHover = () => setSimulatedHoverHash("");
        window.addEventListener('mousemove', clearSimulatedHover, { capture: true });
        window.addEventListener('focus', handleWindowFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('storage', handleStorage);
        window.addEventListener('blur', handleWindowBlur);
        window.addEventListener('click', closeContextMenu);
        window.addEventListener('resize', closeContextMenu);
        void loadBehaviorConfig()
            .then(config => {
                if (config.onboarding_completed === false && !tutorialActiveRef.current) {
                    void startTutorial();
                }
            })
            .catch(e => error(`Failed to check tutorial state: ${e}`));
        return () => {
            clearAnimationTimer();
            stopDragInertia();
            if (toastTimerRef.current !== null) {
                window.clearTimeout(toastTimerRef.current);
            }
            if (scrollRefreshTimerRef.current !== null) {
                window.clearTimeout(scrollRefreshTimerRef.current);
            }
            if (imagePrewarmTimerRef.current !== null) {
                window.clearTimeout(imagePrewarmTimerRef.current);
            }
            if (wheelScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(wheelScrollFrameRef.current);
                wheelScrollFrameRef.current = null;
            }
            if (searchDebounceTimerRef.current !== null) {
                window.clearTimeout(searchDebounceTimerRef.current);
            }
            clearAltHintTimer();
            unlistenShow.then(f => f()).catch(e => error(`Failed to unlisten show: ${e}`));
            unlistenHide.then(f => f()).catch(e => error(`Failed to unlisten hide: ${e}`));
            unlistenClipboard.then(f => f()).catch(e => error(`Failed to unlisten clipboard: ${e}`));
            unlistenCustomTabs.then(f => f()).catch(e => error(`Failed to unlisten custom tabs: ${e}`));
            unlistenItemTags.then(f => f()).catch(e => error(`Failed to unlisten item tags: ${e}`));
            unlistenPreviewNavigation.then(f => f()).catch(e => error(`Failed to unlisten preview navigation: ${e}`));
            unlistenTutorialStarted.then(f => f()).catch(e => error(`Failed to unlisten tutorial start: ${e}`));
            unlistenTutorialCompleted.then(f => f()).catch(e => error(`Failed to unlisten tutorial complete: ${e}`));
            unlistenPermissionStatusChanged.then(f => f()).catch(e => error(`Failed to unlisten onboarding permission status: ${e}`));
            window.removeEventListener('mousemove', clearSimulatedHover, { capture: true });
            window.removeEventListener('focus', handleWindowFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('storage', handleStorage);
            window.removeEventListener('blur', handleWindowBlur);
            window.removeEventListener('click', closeContextMenu);
            window.removeEventListener('resize', closeContextMenu);
        };
    }, []);

    useEffect(() => {
        if (searchDebounceTimerRef.current !== null) {
            window.clearTimeout(searchDebounceTimerRef.current);
        }
        const keywords = searchWord as string;
        const delay = keywords.trim() ? 120 : 40;
        searchDebounceTimerRef.current = window.setTimeout(() => {
            searchDebounceTimerRef.current = null;
            void fetchHistoryWith(keywords, activeTabRef.current, { selectFirst: true });
        }, delay);
        return () => {
            if (searchDebounceTimerRef.current !== null) {
                window.clearTimeout(searchDebounceTimerRef.current);
                searchDebounceTimerRef.current = null;
            }
        };
    }, [searchWord]);

    useEffect(() => {
        void fetchHistoryWith(searchWordRef.current, activeTab, { selectFirst: true });
    }, [activeTab, customTabs]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Alt') {
                event.preventDefault();
                event.stopPropagation();
                if (quickInputEnabledRef.current) {
                    showAltHintsWhilePressed();
                }
                return;
            }

            const targetIsTextInput = isTextInputTarget(event.target);
            const allowQuickInputInSearch = event.target === searchInputRef.current;
            if (
                quickInputEnabledRef.current
                && event.altKey
                && !event.ctrlKey
                && !event.metaKey
                && (!targetIsTextInput || allowQuickInputInSearch)
            ) {
                const action = quickInputAction(event);
                if (action?.kind === "tab") {
                    event.preventDefault();
                    switchToTabWithShortcut(action.tabId);
                    return;
                }
                if (action?.kind === "item") {
                    event.preventDefault();
                    activateItemShortcut(action.index);
                    return;
                }
            }

            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                focusSearchInput();
                return;
            }

            if (targetIsTextInput) {
                if (event.key === 'Enter' && event.target === searchInputRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    const firstHash = pageListRef.current[0]?.getHash() as string | undefined;
                    if (firstHash) {
                        void clickClipboardItem(firstHash, false);
                    }
                    return;
                }
                if (event.key === 'Escape' && searchOpen) {
                    event.preventDefault();
                    if (searchWord) {
                        setSearchWord("");
                    } else {
                        setSearchOpen(false);
                    }
                }
                return;
            }

            if (contextMenu) {
                const options = buildContextMenuOptions(contextMenu.item, contextMenu.itemTags, contextMenu.colorOptions);
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setContextMenuIndex(index => {
                        if (options.length === 0) return 0;
                        const direction = event.key === 'ArrowDown' ? 1 : -1;
                        return (index + direction + options.length) % options.length;
                    });
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    const option = options[Math.max(0, Math.min(contextMenuIndex, options.length - 1))];
                    if (option?.action) {
                        void option.action();
                    }
                    return;
                }

                if (event.key === 'Escape') {
                    event.preventDefault();
                    setContextMenu(null);
                    return;
                }
            }

            if (event.key === 'Escape' && searchOpen) {
                event.preventDefault();
                if (searchWord) {
                    setSearchWord("");
                } else {
                    setSearchOpen(false);
                }
                return;
            }

            if (event.key === 'Escape') {
                event.preventDefault();
                setContextMenu(null);
                void hideCurrentWindowWithAnimation();
                return;
            }

            if (tabQuickSelectEnabledRef.current && event.key === 'Tab') {
                event.preventDefault();
                setContextMenu(null);
                const direction = event.shiftKey ? -1 : 1;
                navigateSelectedCard(direction);
                return;
            }

            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                setContextMenu(null);
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                navigateSelectedCard(direction);
                return;
            }

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                openSelectedContextMenu();
                return;
            }

            if (event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault();
                setContextMenu(null);
                invoke<boolean>('is_preview_window_visible')
                    .then(visible => {
                        if (visible) {
                            previewRequestSeqRef.current += 1;
                            return invoke('hide_preview_window');
                        }
                        const selectedItem = pageListRef.current.find(item => item.getHash() === selectedRef.current)
                            || pageListRef.current[0];
                        if (selectedItem) {
                            return openPreviewItem(selectedItem);
                        }
                    })
                    .catch(e => error(`Failed to toggle preview: ${e}`));
                return;
            }

            if (matchesKeyboardShortcut(event, pasteAsTextShortcutRef.current)) {
                event.preventDefault();
                setContextMenu(null);
                const selectedItem = pageListRef.current.find(item => item.getHash() === selectedRef.current)
                    || pageListRef.current[0];
                if (selectedItem) {
                    void clickClipboardItem(selectedItem.getHash(), true);
                }
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                setContextMenu(null);
                const selectedHash = selectedRef.current || (pageListRef.current[0]?.getHash() as string | undefined);
                if (selectedHash) {
                    void clickClipboardItem(selectedHash, false);
                }
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.key === 'Alt') {
                event.preventDefault();
                hideAltHints();
            }
        };

        const handleBlur = () => {
            hideAltHints();
        };

        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('keyup', handleKeyUp, true);
        window.addEventListener('blur', handleBlur);
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('keyup', handleKeyUp, true);
            window.removeEventListener('blur', handleBlur);
        };
    }, [searchOpen, searchWord, contextMenu, contextMenuIndex, t]);

    const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setSearchWord(event.target.value);
    };

    const waitForQuickInputModifierRelease = async (triggerKey: string, timeoutMs: number = 3000): Promise<boolean> => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            try {
                const pressed = await invoke<boolean>('is_quick_input_modifier_pressed', { triggerKey });
                if (!pressed) return true;
            } catch (e) {
                error(`Failed to wait for quick input modifier release: ${e}`);
                return false;
            }
            await new Promise(resolve => window.setTimeout(resolve, 16));
        }
        return false;
    };

    const clickClipboardItem = async (hash: string, plainText: boolean = false, restoreAlt: boolean = false, triggerKey: string = "") => {
        const hasPermission = await ensurePasteAccessibilityPermission();
        if (!hasPermission) {
            return;
        }
        const item = pageListRef.current.find(i => i.getHash() === hash);
        if (item) {
            selectedRef.current = hash;
            setSelected(hash);
            let content = item.getContent();
            let itemType = getBackendTypeLabel(item.getType());
            if (plainText && item.getTextContent()) {
                content = item.getTextContent();
                itemType = "Text";
            } else if (item.getType() === ItemType.TextFile) {
                content = await invoke<string>('plain_text_content', { hash: item.getHash() });
                itemType = "Text";
            } else if (item.getType() === ItemType.Link) {
                content = content.split('|||')[0];
            } else if (item.getType() === ItemType.File) {
                const missingPaths = await invoke<string[]>('validate_file_item', { content });
                if (missingPaths.length > 0) {
                    const message = missingPaths.length === 1
                        ? t("clipboard.sourceMissingOne", { path: compactPath(missingPaths[0], 46) })
                        : t("clipboard.sourceMissingMany", { path: compactPath(missingPaths[0], 42) });
                    showToast(message, 'warning');
                    return;
                }
            }

            try {
                const copyHash = plainText ? null : hash;
                if (restoreAlt) {
                    await waitForQuickInputModifierRelease(triggerKey);
                }
                if (itemType === "Image") {
                    const hidePromise = hideCurrentWindowWithAnimation();
                    await invoke('copy', { item: content, itemType, hash: copyHash });
                    await hidePromise;
                } else {
                    await invoke('copy', { item: content, itemType, hash: copyHash });
                    await hideCurrentWindowWithAnimation();
                }
                await invoke('paste', { hash, restoreAlt, triggerKey });
                await fetchHistoryWith(searchWordRef.current, activeTabRef.current);
            } catch (e) {
                error(`Failed to copy/paste: ${e}`);
                showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
            }
        }
    };

    activateClipboardCardRef.current = (hash: string, plainText: boolean) => {
        void clickClipboardItem(hash, plainText);
    };

    const pastePlainTextItem = async (item: Item) => {
        const hasPermission = await ensurePasteAccessibilityPermission();
        if (!hasPermission) {
            return;
        }
        setContextMenu(null);
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash());
        try {
            const text = await invoke<string>('plain_text_content', { hash: item.getHash() });
            await invoke('copy', { item: text, itemType: 'Text', hash: null });
            await hideCurrentWindowWithAnimation();
            await invoke<unknown>('paste', { hash: item.getHash(), triggerKey: "" });
        } catch (e) {
            error(`Failed to paste plain text: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const openContextMenu = async (item: Item, clientX: number, clientY: number) => {
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash());
        const currentItemTags = await loadItemTags();
        const colorOptions = item.getType() === ItemType.Color
            ? await invoke<ColorCopyOption[]>('color_conversion_options', { content: item.getContent() }).catch(e => {
                error(`Failed to load color conversion options: ${e}`);
                return [];
            })
            : [];
        const options = buildContextMenuOptions(item, currentItemTags, colorOptions);
        const menuHeight = contextMenuHeight(options.length);
        const { x, y } = floatingPositionFromClick(clientX, clientY, CONTEXT_MENU_WIDTH, menuHeight);
        const submenuSide = x + CONTEXT_MENU_WIDTH + CONTEXT_MENU_GAP + CONTEXT_SUBMENU_WIDTH <= window.innerWidth - VIEWPORT_MARGIN
            ? "right"
            : "left";
        setContextMenuIndex(0);
        setContextMenu({
            item,
            x,
            y,
            originX: clientX,
            originY: clientY,
            submenuSide,
            itemTags: currentItemTags,
            colorOptions,
        });
    };

    openClipboardContextMenuRef.current = openContextMenu;

    const openSelectedContextMenu = () => {
        const item = pageListRef.current.find(i => i.getHash() === selectedRef.current)
            || pageListRef.current[0];
        if (!item) return;

        const cards = cardsContainerRef.current?.querySelectorAll<HTMLElement>('.clipboard-card');
        const index = pageListRef.current.findIndex(i => i.getHash() === item.getHash());
        const rect = cards?.item(Math.max(0, index))?.getBoundingClientRect();
        if (rect) {
            void openContextMenu(item, rect.left + 14, rect.top + 40);
        } else {
            void openContextMenu(item, Math.round(window.innerWidth / 2 - 94), 64);
        }
    };

    const openPreviewItem = async (item: Item, requestSeq: number = ++previewRequestSeqRef.current) => {
        setContextMenu(null);
        if (item.getType() === ItemType.File) {
            try {
                const info = await invoke<FilePreviewInfo>("file_preview_info", { content: item.getContent() });
                if (requestSeq !== previewRequestSeqRef.current) return;
                const previewableFile = (info.kind === "single-preview" && !!info.preview_path)
                    || info.kind === "pdf-preview"
                    || info.kind === "text-preview";
                const simpleFileInfo = info.kind === "multiple" || info.kind === "single-folder" || info.kind === "single-icon";
                if (!previewableFile && !simpleFileInfo) {
                    showToast(t("clipboard.previewUnsupported"), 'warning');
                    return;
                }
            } catch (e) {
                error(`Failed to prepare file preview: ${e}`);
                showToast(t("clipboard.previewUnsupported"), 'warning');
                return;
            }
        }
        if (requestSeq !== previewRequestSeqRef.current) return;
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash());
        try {
            await invoke('show_preview_window', {
                itemType: item.getType(),
                content: item.getContent(),
                previewContent: item.getPreviewContent(),
                textContent: item.getTextContent(),
                richHtml: item.getRichHtml(),
                appSource: item.getAppSource(),
            });
        } catch (e) {
            error(`Failed to open preview: ${e}`);
            showToast(t("clipboard.previewFailed", { error: String(e) }), 'error');
        }
    };

    const refreshPreviewIfVisible = (item: Item) => {
        const requestSeq = ++previewRequestSeqRef.current;
        void invoke<boolean>('is_preview_window_visible')
            .then(visible => {
                if (!visible || requestSeq !== previewRequestSeqRef.current) return;
                return openPreviewItem(item, requestSeq);
            })
            .catch(e => error(`Failed to refresh preview after selection: ${e}`));
    };

    const navigateSelectedCard = (direction: number) => {
        const list = pageListRef.current;
        if (list.length === 0) return;
        const currentIndex = list.findIndex(item => item.getHash() === selectedRef.current);
        const item = selectCardAt(currentIndex === -1 ? 0 : currentIndex + direction);
        if (item) {
            refreshPreviewIfVisible(item);
        }
    };

    const toggleFavorite = async (item: Item) => {
        setContextMenu(null);
        const favorite = !item.isFavorite();
        try {
            await invoke('set_item_favorite', { hash: item.getHash(), favorite });
            showToast(favorite ? t("clipboard.favoriteAdded") : t("clipboard.favoriteRemoved"));
            await fetchHistory();
        } catch (e) {
            error(`Failed to update favorite: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const assignExistingTag = async (item: Item, tag: ItemTag) => {
        setContextMenu(null);
        try {
            await invoke('assign_item_tag', { hash: item.getHash(), tagId: tag.id });
            updateItemTagsInPage(item, [...item.getTags().filter(candidate => candidate.id !== tag.id), tag]);
            showToast(t("tags.assigned", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const removeAllAssignedTags = async (item: Item) => {
        setContextMenu(null);
        try {
            await Promise.all(item.getTags().map(tag =>
                invoke('remove_item_tag', { hash: item.getHash(), tagId: tag.id })
            ));
            updateItemTagsInPage(item, []);
            showToast(t("tags.removedAll"));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const removeAssignedTag = async (item: Item, tag: ItemTag) => {
        setContextMenu(null);
        try {
            await invoke('remove_item_tag', { hash: item.getHash(), tagId: tag.id });
            updateItemTagsInPage(item, item.getTags().filter(candidate => candidate.id !== tag.id));
            showToast(t("tags.removed", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const deleteClipboardItem = async (item: Item) => {
        setContextMenu(null);
        const hash = item.getHash() as string;
        try {
            await invoke('delete_clipboard_item', { hash });
            const currentList = pageListRef.current;
            const deletedIndex = currentList.findIndex(candidate => candidate.getHash() === hash);
            const nextList = currentList.filter(candidate => candidate.getHash() !== hash);
            pageListRef.current = nextList;
            setPage(new ClipboardPage(nextList, clipboardPage.consumed));
            if (selectedRef.current === hash) {
                const nextIndex = Math.max(0, Math.min(deletedIndex, nextList.length - 1));
                const nextHash = nextList[nextIndex]?.getHash() as string | undefined;
                selectedRef.current = nextHash || "";
                setSelected(nextHash || "");
                if (nextHash) {
                    window.requestAnimationFrame(() => scrollCardIntoView(nextIndex));
                }
            }
            showToast(t("clipboard.recordDeleted"));
        } catch (e) {
            error(`Failed to delete clipboard item: ${e}`);
            showToast(t("clipboard.deleteFailed", { error: String(e) }), 'error');
        }
    };

    const exportImageItem = async (item: Item) => {
        setContextMenu(null);
        const sourcePath = imageExportSourcePath(item);
        if (!sourcePath) {
            showToast(t("clipboard.actionFailed", { error: t("clipboard.exportImageNoSource") }), "error");
            return;
        }

        try {
            const cachedDir = localStorage.getItem(IMAGE_EXPORT_DIR_KEY) || "";
            const fallbackDir = isMacPlatform() ? await downloadDir() : await desktopDir();
            const defaultDir = cachedDir || fallbackDir;
            const defaultPath = joinPath(defaultDir, `vpaste-image-${Date.now()}.png`);
            await invoke("set_clipboard_blur_hide_suppressed", { suppressed: true })
                .catch(e => error(`Failed to suppress clipboard blur hide: ${e}`));
            const targetPath = await save({
                defaultPath,
                filters: [
                    { name: "PNG Image", extensions: ["png"] },
                    { name: "JPEG Image", extensions: ["jpg", "jpeg"] },
                    { name: "WebP Image", extensions: ["webp"] },
                    { name: "Bitmap Image", extensions: ["bmp"] },
                ],
            }).finally(() => {
                void invoke("set_clipboard_blur_hide_suppressed", { suppressed: false })
                    .catch(e => error(`Failed to restore clipboard blur hide: ${e}`));
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
                showToast(t("clipboard.actionFailed", { error: String(revealError) }), "error");
                return;
            }
            await hideCurrentWindowWithAnimation();
            showToast(t("clipboard.imageExported"));
        } catch (e) {
            error(`Failed to export image item: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const openContainingFolder = async (item: Item) => {
        setContextMenu(null);
        try {
            await invoke('open_containing_folder', { content: item.getContent() });
        } catch (e) {
            error(`Failed to open containing folder: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const copyContainingFolderPath = async (item: Item) => {
        setContextMenu(null);
        try {
            const path = await invoke<string>('containing_folder_path', { content: item.getContent() });
            await invoke('copy', { item: path, itemType: 'Text', hash: null });
            await invoke('record_text_history', { content: path });
            await fetchHistory();
            showToast(t("clipboard.folderCopied"));
        } catch (e) {
            error(`Failed to copy containing folder path: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const copyColorValue = async (value: string) => {
        setContextMenu(null);
        try {
            await invoke('copy', { item: value, itemType: 'Text', hash: null });
            await invoke('record_text_history', { content: value });
            await fetchHistory();
            showToast(t("clipboard.colorCopied", { value }));
        } catch (e) {
            error(`Failed to copy converted color: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const buildContextMenuOptions = (
        item: Item,
        currentItemTags: ItemTag[] = itemTags,
        colorOptions: ColorCopyOption[] = [],
    ): ContextMenuOption[] => {
        const assignedTagIds = new Set(item.getTags().map(tag => tag.id));
        const currentTagIds = new Set(currentItemTags.map(tag => tag.id));
        const assignableTags = currentItemTags.filter(tag => !assignedTagIds.has(tag.id));
        const assignedTags = item.getTags().filter(tag => currentTagIds.has(tag.id));
        const options: ContextMenuOption[] = [
            { label: t("menu.preview"), action: () => openPreviewItem(item) },
            { label: item.isFavorite() ? t("menu.removeFavorite") : t("menu.addFavorite"), action: () => toggleFavorite(item) },
        ];
        options.push(currentItemTags.length === 0
            ? {
                label: t("menu.addRecordTag"),
                action: () => openRecordTagCreateEditorForItem(item),
            }
            : {
                label: t("menu.addRecordTag"),
                children: [
                    { label: t("tags.createRecord"), action: () => openRecordTagCreateEditorForItem(item) },
                    ...(assignableTags.length > 0
                        ? assignableTags.map(tag => ({
                            label: tag.name,
                            action: () => assignExistingTag(item, tag),
                        }))
                        : [{ label: t("tags.noAssignable"), action: () => undefined }]),
                ],
            });
        if (assignedTags.length > 0) {
            options.push({
                label: t("menu.removeRecordTag"),
                children: [
                    { label: t("menu.removeAllTags"), action: () => removeAllAssignedTags(item), danger: true },
                    ...assignedTags.map(tag => ({
                        label: tag.name,
                        action: () => removeAssignedTag(item, tag),
                    })),
                ],
            });
        }

        if (imageExportSourcePath(item)) {
            options.push({ label: t("menu.exportImage"), action: () => exportImageItem(item) });
        }

        if (item.getType() === ItemType.File) {
            options.push(
                { label: t("menu.openContainingFolder"), action: () => openContainingFolder(item) },
                { label: t("menu.copyContainingFolder"), action: () => copyContainingFolderPath(item) },
            );
        }

        if (item.getType() === ItemType.Color) {
            options.push({
                label: t("menu.convertColor"),
                children: colorOptions.length > 0
                    ? colorOptions.map(option => ({
                        label: `${option.format} ${option.value}`,
                        action: () => copyColorValue(option.value),
                    }))
                    : [{ label: t("clipboard.colorUnsupported"), action: () => undefined }],
            });
        }

        if (isTextLikeItem(item)) {
            options.push({ label: t("menu.pastePlainText"), action: () => pastePlainTextItem(item) });
        }

        options.push({ label: t("menu.deleteRecord"), action: () => deleteClipboardItem(item) });

        return options;
    };

    const startDragInertia = (initialVelocity: number) => {
        const container = cardsContainerRef.current;
        if (!container) return;
        let velocity = Math.max(-42, Math.min(42, initialVelocity));
        const startedAt = performance.now();

        const step = (now: number) => {
            if (Math.abs(velocity) < 0.45 || now - startedAt > 260) {
                stopDragInertia();
                maybeLoadMoreHistory(true);
                return;
            }

            container.scrollLeft += velocity;
            velocity *= 0.84;
            maybeLoadMoreHistory();
            if (dragScrollRef.current) {
                dragScrollRef.current.frame = window.requestAnimationFrame(step);
            }
        };

        if (Math.abs(velocity) >= 0.45) {
            dragScrollRef.current = {
                active: false,
                moved: false,
                cancelActivation: false,
                targetHash: "",
                startX: 0,
                startY: 0,
                lastX: 0,
                lastTime: performance.now(),
                velocity,
                pendingDelta: 0,
                frame: window.requestAnimationFrame(step),
            };
        }
    };

    const handleCardsPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary || isTextInputTarget(event.target)) return;
        const target = event.target as HTMLElement;
        if (target.closest('button') || target.closest('.context-menu')) return;
        const targetCard = target.closest<HTMLElement>('.clipboard-card');

        stopDragInertia();
        setContextMenu(null);
        event.currentTarget.setPointerCapture(event.pointerId);
        dragScrollRef.current = {
            active: true,
            moved: false,
            cancelActivation: false,
            targetHash: targetCard?.dataset.hash || "",
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastTime: performance.now(),
            velocity: 0,
            pendingDelta: 0,
            frame: null,
        };
    };

    const handleCardsPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const state = dragScrollRef.current;
        const container = cardsContainerRef.current;
        if (!state?.active || !container) return;

        const deltaX = event.clientX - state.lastX;
        const totalX = event.clientX - state.startX;
        const totalY = event.clientY - state.startY;
        if (!state.moved && Math.hypot(totalX, totalY) < 5) return;
        if (!state.moved && Math.abs(totalX) < Math.abs(totalY)) {
            state.cancelActivation = true;
            return;
        }

        event.preventDefault();
        state.moved = true;
        suppressClickAfterDragRef.current = true;
        container.classList.add('dragging');

        const now = performance.now();
        const elapsed = Math.max(8, now - state.lastTime);
        state.pendingDelta -= deltaX;
        state.velocity = (-deltaX / elapsed) * 16;
        state.lastX = event.clientX;
        state.lastTime = now;

        if (state.frame === null) {
            state.frame = window.requestAnimationFrame(() => {
                const nextState = dragScrollRef.current;
                const nextContainer = cardsContainerRef.current;
                if (!nextState || !nextContainer) return;
                nextState.frame = null;
                if (nextState.pendingDelta === 0) return;
                nextContainer.scrollLeft += nextState.pendingDelta;
                nextState.pendingDelta = 0;
                maybeLoadMoreHistory();
            });
        }
    };

    const finishCardsPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        const state = dragScrollRef.current;
        const container = cardsContainerRef.current;
        if (!state?.active) return;

        container?.classList.remove('dragging');
        if (state.frame !== null) {
            window.cancelAnimationFrame(state.frame);
            state.frame = null;
        }
        dragScrollRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (event.type === 'pointerup' && !state.moved && !state.cancelActivation && state.targetHash) {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            activateClipboardCard(state.targetHash, event.shiftKey);
            return;
        }
        if (state.moved) {
            event.preventDefault();
            if (state.pendingDelta !== 0 && container) {
                container.scrollLeft += state.pendingDelta;
                state.pendingDelta = 0;
                maybeLoadMoreHistory();
            }
            startDragInertia(state.velocity);
            window.setTimeout(() => {
                suppressClickAfterDragRef.current = false;
            }, 120);
        }
    };

    const handleCardsWheel = (event: WheelEvent) => {
        if (tutorialActiveRef.current) return;

        setContextMenu(null);
        setTabContextMenu(null);
        const container = cardsContainerRef.current;
        if (!container) return;

        const scrollAmount = Math.abs(event.deltaY) > Math.abs(event.deltaX)
            ? event.deltaY
            : event.deltaX;
        if (scrollAmount === 0) return;

        event.preventDefault();
        wheelScrollDeltaRef.current += scrollAmount;
        if (wheelScrollFrameRef.current !== null) {
            return;
        }
        wheelScrollFrameRef.current = window.requestAnimationFrame(() => {
            wheelScrollFrameRef.current = null;
            const nextDelta = wheelScrollDeltaRef.current;
            wheelScrollDeltaRef.current = 0;
            const nextContainer = cardsContainerRef.current;
            if (!nextContainer || nextDelta === 0) return;
            nextContainer.scrollLeft += nextDelta;
            maybeLoadMoreHistory();
        });
    };

    useEffect(() => {
        const container = cardsContainerRef.current;
        if (!container) return;

        container.addEventListener('wheel', handleCardsWheel, { passive: false });
        return () => {
            container.removeEventListener('wheel', handleCardsWheel);
        };
    });

    const openConfigWindow = () => {
        void invoke('open_config_window').catch(e => error(`Failed to open config window: ${e}`));
    };

    const openTutorialFromDebug = (platform: TutorialPlatform) => {
        void startTutorial(platform);
    };

    const blockTutorialNavigation = () => {
        showToast(t("tutorial.finishFirst"), "info", 2200);
    };

    const tutorialPermissions: TutorialPermission[] = [
        {
            id: "background",
            title: t("tutorial.permission.background"),
            description: t("tutorial.permission.background.desc"),
            done: tutorialPermissionStatus?.background.done === true,
            actionLabel: t("tutorial.permission.enable"),
        },
        {
            id: "paste",
            title: t("tutorial.permission.paste"),
            description: t("tutorial.permission.paste.desc"),
            done: tutorialPermissionStatus?.paste.done === true,
            actionLabel: t("tutorial.permission.openSettings"),
        },
    ];
    const tutorialFilters: TutorialFilterTab[] = TUTORIAL_FILTER_TABS.map(filter => ({
        id: filter.id,
        name: `${filter.emoji} ${t(filter.titleKey)}`,
        enabled: customTabs.some(tab => tab.id === tutorialFilterTabId(filter.id)),
    }));
    const tutorialShortcutText = formatShortcutLabel(mainShortcut, tutorialPlatform === "mac");

    const contextMenuOptions = contextMenu
        ? buildContextMenuOptions(contextMenu.item, contextMenu.itemTags, contextMenu.colorOptions)
        : [];
    const selectedContextOption = contextMenuOptions[Math.max(0, Math.min(contextMenuIndex, contextMenuOptions.length - 1))];
    const selectedSubmenuOptions = selectedContextOption?.children || [];
    const submenuHeight = contextMenuHeight(selectedSubmenuOptions.length);
    const submenuTop = contextMenu
        ? clampToViewport(
            contextMenu.y + CONTEXT_MENU_PADDING + contextMenuIndex * CONTEXT_MENU_ROW_HEIGHT,
            submenuHeight,
            window.innerHeight,
        )
        : 0;
    const submenuLeft = contextMenu
        ? contextMenu.submenuSide === "left"
            ? contextMenu.x - CONTEXT_SUBMENU_WIDTH - CONTEXT_MENU_GAP
            : contextMenu.x + CONTEXT_MENU_WIDTH + CONTEXT_MENU_GAP
        : 0;

    return (
        <div
            className={`clipboard-container ${animationState}`}
            ref={containerRef}
            tabIndex={-1}
            onContextMenu={event => event.preventDefault()}
        >
            {toast && (
                <div className={`clipboard-toast ${toast.kind}`} key={toast.id}>
                    <span>{toast.message}</span>
                    {toast.actionLabel && toast.onAction && (
                        <button
                            type="button"
                            className="clipboard-toast-action"
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (toastTimerRef.current !== null) {
                                    window.clearTimeout(toastTimerRef.current);
                                    toastTimerRef.current = null;
                                }
                                setToast(null);
                                toast.onAction?.();
                            }}
                        >
                            {toast.actionLabel}
                        </button>
                    )}
                </div>
            )}
            {/* Header */}
            <div className="clipboard-header">
                {tutorialActive ? (
                    <div className="tutorial-header-spacer" />
                ) : (
                    <div className={`search-box ${searchOpen || searchWord ? 'open' : ''}`}>
                        <button
                            type="button"
                            className="search-button"
                            title={t("common.search")}
                            onClick={focusSearchInput}
                        >
                            <SearchIcon className="search-icon" fontSize="inherit" />
                        </button>
                        {(searchOpen || searchWord) && (
                            <input
                                ref={searchInputRef}
                                type="text"
                                className="search-input"
                                placeholder={t("common.search")}
                                value={searchWord as string}
                                onChange={handleSearchChange}
                                onBlur={() => {
                                    if (!searchWord) {
                                        setSearchOpen(false);
                                    }
                                }}
                            />
                        )}
                    </div>
                )}
                <div className="header-tabs" onDragOver={event => event.preventDefault()}>
                    <button
                        type="button"
                        className={`tab-item fixed ${activeTab === "all" ? 'active' : ''}`}
                        onClick={() => tutorialActive ? blockTutorialNavigation() : setActiveTab("all")}
                    >
                        <AppsOutlinedIcon className="tab-icon tab-icon-all" fontSize="inherit" />
                        <span className="tab-label">{t("tabs.all")}</span>
                        {altHintsVisible && <span className="alt-tab-hint">A</span>}
                    </button>
                    <button
                        type="button"
                        className={`tab-item fixed ${activeTab === "favorite" ? 'active' : ''}`}
                        onClick={() => tutorialActive ? blockTutorialNavigation() : setActiveTab("favorite")}
                    >
                        <StarBorderOutlinedIcon className="tab-icon tab-icon-favorite" fontSize="inherit" />
                        <span className="tab-label">{t("tabs.favorite")}</span>
                        {altHintsVisible && <span className="alt-tab-hint">F</span>}
                    </button>
                    {dynamicTabs.map(entry => {
                        if (entry.kind === "filter") {
                            const tab = entry.tab;
                            return (
                                <button
                                    key={entry.id}
                                    type="button"
                                    className={`tab-item custom ${tutorialActive ? 'tutorial-locked' : ''} ${activeTab === entry.id ? 'active' : ''} ${draggingTabId === entry.id ? 'dragging' : ''}`}
                                    draggable={!tutorialActive}
                                    onClick={() => tutorialActive ? blockTutorialNavigation() : setActiveTab(entry.id)}
                                    onDoubleClick={tutorialActive ? undefined : event => openEditTabEditor(tab, event.currentTarget)}
                                    onContextMenu={event => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        if (tutorialActive) {
                                            blockTutorialNavigation();
                                            return;
                                        }
                                        setContextMenu(null);
                                        const position = floatingPositionFromClick(
                                            event.clientX,
                                            event.clientY,
                                            TAB_CONTEXT_MENU_WIDTH,
                                            contextMenuHeight(2),
                                        );
                                        setTabContextMenu({
                                            kind: "filter",
                                            tab,
                                            x: position.x,
                                            y: position.y,
                                            originX: event.clientX,
                                            originY: event.clientY,
                                        });
                                    }}
                                    onDragStart={() => {
                                        if (!tutorialActive) setDraggingTabId(entry.id);
                                    }}
                                    onDragEnd={() => setDraggingTabId("")}
                                    onDrop={event => {
                                        event.preventDefault();
                                        handleTabDrop(entry.id);
                                    }}
                                >
                                    <span className="tab-label">{tab.name}</span>
                                </button>
                            );
                        }
                        const tag = entry.tag;
                        return (
                            <button
                                key={entry.id}
                                type="button"
                                className={`tab-item record ${tutorialActive ? 'tutorial-locked' : ''} ${activeTab === entry.id ? 'active' : ''} ${draggingTabId === entry.id ? 'dragging' : ''}`}
                                draggable={!tutorialActive}
                                onClick={() => tutorialActive ? blockTutorialNavigation() : setActiveTab(entry.id)}
                                onDoubleClick={tutorialActive ? undefined : event => openEditRecordTagEditor(tag, event.currentTarget)}
                                onContextMenu={event => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (tutorialActive) {
                                        blockTutorialNavigation();
                                        return;
                                    }
                                    setContextMenu(null);
                                    const position = floatingPositionFromClick(
                                        event.clientX,
                                        event.clientY,
                                        TAB_CONTEXT_MENU_WIDTH,
                                        contextMenuHeight(2),
                                    );
                                    setTabContextMenu({
                                        kind: "record",
                                        tag,
                                        x: position.x,
                                        y: position.y,
                                        originX: event.clientX,
                                        originY: event.clientY,
                                    });
                                }}
                                onDragStart={() => {
                                    if (!tutorialActive) setDraggingTabId(entry.id);
                                }}
                                onDragEnd={() => setDraggingTabId("")}
                                onDrop={event => {
                                    event.preventDefault();
                                    handleTabDrop(entry.id);
                                }}
                            >
                                <span className="tab-label">{tag.name}</span>
                            </button>
                        );
                    })}
                    {!tutorialActive && (
                        <button
                            ref={addTabButtonRef}
                            type="button"
                            className="tab-add-button"
                            title={t("tabs.add")}
                            onClick={event => {
                                event.stopPropagation();
                                openTagCreateChoice(event.clientX, event.clientY);
                            }}
                        >
                            <AddIcon fontSize="small" />
                        </button>
                    )}
                </div>
                <div className="header-actions">
                    {!tutorialActive && (
                        <div className="tutorial-debug-group" aria-label={t("tutorial.debug")}>
                            <button
                                type="button"
                                className="settings-button tutorial-debug-button"
                                title={t("tutorial.debug.windows")}
                                onClick={() => openTutorialFromDebug("windows")}
                            >
                                <WindowOutlinedIcon className="settings-icon" fontSize="inherit" />
                                <span>Win</span>
                            </button>
                            <button
                                type="button"
                                className="settings-button tutorial-debug-button"
                                title={t("tutorial.debug.mac")}
                                onClick={() => openTutorialFromDebug("mac")}
                            >
                                <AppleIcon className="settings-icon" fontSize="inherit" />
                                <span>Mac</span>
                            </button>
                        </div>
                    )}
                    <button
                        type="button"
                        className="settings-button"
                        title={t("common.settings")}
                        onClick={tutorialActive ? blockTutorialNavigation : openConfigWindow}
                    >
                        <SettingsOutlinedIcon className="settings-icon" fontSize="inherit" />
                    </button>
                </div>
            </div>

            {/* Cards Grid */}
            <div
                className="cards-container"
                ref={cardsContainerRef}
                onScroll={() => {
                    if (!tutorialActive) maybeLoadMoreHistory();
                }}
                onPointerDown={(event) => {
                    if (!tutorialActive) handleCardsPointerDown(event);
                }}
                onPointerMove={(event) => {
                    if (!tutorialActive) handleCardsPointerMove(event);
                }}
                onPointerUp={(event) => {
                    if (!tutorialActive) finishCardsPointerDrag(event);
                }}
                onPointerCancel={(event) => {
                    if (!tutorialActive) finishCardsPointerDrag(event);
                }}
                onLostPointerCapture={(event) => {
                    if (!tutorialActive) finishCardsPointerDrag(event);
                }}
                onClickCapture={(event) => {
                    if (suppressClickAfterDragRef.current) {
                        event.preventDefault();
                        event.stopPropagation();
                        suppressClickAfterDragRef.current = false;
                    }
                }}
            >
                {tutorialActive ? (
                    <TutorialOverlay
                        key={tutorialRunId}
                        t={t}
                        logoSrc={aboutLogo}
                        shortcutText={tutorialShortcutText}
                        platform={tutorialPlatform}
                        permissions={tutorialPermissions}
                        filters={tutorialFilters}
                        onPermissionAction={handleTutorialPermissionAction}
                        onToggleFilter={handleTutorialFilterToggle}
                        onComplete={completeTutorial}
                    />
                ) : (
                    <div className="cards-grid">
                        {clipboardPage.list.map((item, index) => (
                            <ClipboardCard
                                key={item.getHash() as string}
                                item={item}
                                selected={selected === item.getHash()}
                                simulatedHover={simulatedHoverHash === item.getHash()}
                                refreshKey={fileRefreshKey}
                                searchQuery={searchWord as string}
                                shortcutHint={altHintsVisible && index < 9 ? String(index + 1) : undefined}
                                mediaPlaybackReady={animationState === 'entered'}
                                t={t}
                                onContextMenu={openClipboardContextMenu}
                            />
                        ))}
                        {isLoadingMore && (
                            <div className="history-loading-card">{t("common.loading")}</div>
                        )}
                    </div>
                )}
            </div>
            {tagCreateChoice && (
                <div
                    className="tag-create-choice-popover"
                    style={{ left: tagCreateChoice.x, top: tagCreateChoice.y }}
                    onClick={event => event.stopPropagation()}
                    onMouseDown={event => event.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            const { originX, originY } = tagCreateChoice;
                            setTagCreateChoice(null);
                            openTabEditorWindowAt("add", "filter", undefined, undefined, originX, originY);
                        }}
                    >
                        <strong>{t("tabs.filterTag")}</strong>
                        <span>{t("tabs.filterTagDesc")}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            const { originX, originY } = tagCreateChoice;
                            setTagCreateChoice(null);
                            openTabEditorWindowAt("add", "record", undefined, undefined, originX, originY);
                        }}
                    >
                        <strong>{t("tabs.recordTag")}</strong>
                        <span>{t("tabs.recordTagDesc")}</span>
                    </button>
                </div>
            )}
            {contextMenu && (
                <div
                    className="context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    role="menu"
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    {contextMenuOptions.map((option, index) => (
                        <button
                            key={option.label}
                            type="button"
                            role="menuitem"
                            className={`${index === contextMenuIndex ? 'selected' : ''} ${option.children ? 'has-submenu' : ''} ${option.danger ? 'danger' : ''}`}
                            onMouseEnter={() => setContextMenuIndex(index)}
                            onClick={() => {
                                if (option.action) void option.action();
                            }}
                        >
                            {option.label}
                            {option.children && <span className="context-menu-chevron">›</span>}
                        </button>
                    ))}
                </div>
            )}
            {contextMenu && selectedSubmenuOptions.length > 0 && (
                <div
                    className="context-submenu"
                    style={{ left: submenuLeft, top: submenuTop }}
                    role="menu"
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    {selectedSubmenuOptions.map(option => (
                        <button
                            key={option.label}
                            type="button"
                            role="menuitem"
                            title={option.label}
                            className={option.danger ? 'danger' : ''}
                            onClick={() => {
                                if (option.action) void option.action();
                            }}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
            {tabContextMenu && (
                <div
                    className="tab-context-menu"
                    style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
                    role="menu"
                    onClick={event => event.stopPropagation()}
                    onMouseDown={event => event.stopPropagation()}
                    onContextMenu={event => event.preventDefault()}
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={event => {
                            event.stopPropagation();
                            if (tabContextMenu.kind === "record") {
                                openTabEditorWindowAt("edit", "record", undefined, tabContextMenu.tag, tabContextMenu.originX, tabContextMenu.originY);
                            } else {
                                openTabEditorWindowAt("edit", "filter", tabContextMenu.tab, undefined, tabContextMenu.originX, tabContextMenu.originY);
                            }
                            setTabContextMenu(null);
                        }}
                    >
                        {t("tabs.edit")}
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={event => {
                            event.stopPropagation();
                            if (tabContextMenu.kind === "record") {
                                setDeleteConfirmRecordTag(tabContextMenu.tag);
                            } else {
                                setDeleteConfirmTab(tabContextMenu.tab);
                            }
                            setTabContextMenu(null);
                        }}
                    >
                        {t("tabs.delete")}
                    </button>
                </div>
            )}
            {deleteConfirmTab && (
                <div
                    className="tab-confirm-backdrop"
                    onClick={() => setDeleteConfirmTab(null)}
                >
                    <div
                        className="tab-confirm-dialog"
                        onClick={event => event.stopPropagation()}
                    >
                        <strong>{t("tabs.deleteConfirmTitle")}</strong>
                        <p>{t("tabs.deleteConfirmDesc", { name: deleteConfirmTab.name })}</p>
                        <div className="tab-confirm-actions">
                            <button type="button" onClick={() => setDeleteConfirmTab(null)}>
                                {t("tabs.cancel")}
                            </button>
                            <button type="button" className="danger" onClick={() => deleteCustomTab(deleteConfirmTab)}>
                                {t("tabs.delete")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {deleteConfirmRecordTag && (
                <div
                    className="tab-confirm-backdrop"
                    onClick={() => setDeleteConfirmRecordTag(null)}
                >
                    <div
                        className="tab-confirm-dialog"
                        onClick={event => event.stopPropagation()}
                    >
                        <strong>{t("tabs.deleteConfirmTitle")}</strong>
                        <p>{t("tags.deleteConfirm", { name: deleteConfirmRecordTag.name })}</p>
                        <div className="tab-confirm-actions">
                            <button type="button" onClick={() => setDeleteConfirmRecordTag(null)}>
                                {t("tabs.cancel")}
                            </button>
                            <button type="button" className="danger" onClick={() => void deleteRecordTag(deleteConfirmRecordTag)}>
                                {t("tabs.delete")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
