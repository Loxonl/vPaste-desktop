import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { formatRelativeTime } from "../lang";
import { Item, ItemType } from "./Item";
import ClipboardCardPreview from "./ClipboardCardPreview";
import { ensureWhiteTextContrast, WHITE_HEADER_TEXT_COLOR } from "./clipboardHeaderColor";
import { isSingleImageFileItem } from "./itemPresentation";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type ClipboardCardProps = {
    item: Item;
    selected: boolean;
    simulatedHover: boolean;
    refreshKey: number;
    searchQuery: string;
    shortcutHint?: string;
    mediaPlaybackReady: boolean;
    t: TFunction;
    onContextMenu: (item: Item, x: number, y: number) => void;
};

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

const TYPE_HEADER_COLORS: Record<ItemType, string> = {
    [ItemType.Text]: ensureWhiteTextContrast("#4CAF50"),
    [ItemType.Image]: ensureWhiteTextContrast("#FF9800"),
    [ItemType.TextFile]: ensureWhiteTextContrast("#4CAF50"),
    [ItemType.Link]: ensureWhiteTextContrast("#2f6fed"),
    [ItemType.Color]: ensureWhiteTextContrast("#2196F3"),
    [ItemType.File]: ensureWhiteTextContrast("#00BCD4"),
};

const APP_ICON_HEADER_ACCENT_COLOR = ensureWhiteTextContrast("#637083");
const APP_ICON_HEADER_BACKGROUND = `linear-gradient(135deg, ${
    ensureWhiteTextContrast("#747c87")
}, ${ensureWhiteTextContrast("#565e68")})`;
const LINK_HEADER_BACKGROUND = `linear-gradient(135deg, ${
    TYPE_HEADER_COLORS[ItemType.Link]
}, ${ensureWhiteTextContrast("#66c2ff")})`;

function getTypeAccentColor(type: ItemType): string {
    return TYPE_HEADER_COLORS[type] ?? TYPE_HEADER_COLORS[ItemType.Text];
}

function getFormatTagColor(
    type: ItemType,
    headerColor: string | null,
    hasAppIcon: boolean,
): string {
    if (headerColor) return headerColor;
    if (hasAppIcon) return APP_ICON_HEADER_ACCENT_COLOR;
    return getTypeAccentColor(type);
}

function getHeaderBackground(
    type: ItemType,
    headerColor: string | null,
    hasAppIcon: boolean,
): string {
    if (headerColor) return headerColor;
    if (hasAppIcon) return APP_ICON_HEADER_BACKGROUND;
    if (type === ItemType.Link) return LINK_HEADER_BACKGROUND;
    return getTypeAccentColor(type);
}

function headerColorFromSource(color: string | undefined): string | null {
    return color ? ensureWhiteTextContrast(color) : null;
}

function dominantColorFromImage(image: HTMLImageElement): string | null {
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
        return ensureWhiteTextContrast(`rgb(${r}, ${g}, ${b})`);
    } catch {
        return null;
    }
}

function ClipboardCardComponent({
    item,
    selected,
    simulatedHover,
    refreshKey,
    searchQuery,
    shortcutHint,
    mediaPlaybackReady,
    t,
    onContextMenu,
}: ClipboardCardProps) {
    const dragStateRef = useRef<{ x: number, y: number, dragging: boolean } | null>(null);
    const visualType = isSingleImageFileItem(item) ? ItemType.Image : item.getType();
    const typeLabel = getTypeLabel(visualType, t);
    const timestamp = formatRelativeTime(item.getTime(), t);
    const itemTagList = item.getTags();
    const [isGifFormat, setIsGifFormat] = useState(false);
    const formatTags = [
        item.isRichText() ? { key: "rich", label: t("clipboard.richFormat") } : null,
        isGifFormat ? { key: "gif", label: t("clipboard.gifFormat") } : null,
    ].filter((tag): tag is { key: string; label: string } => Boolean(tag));
    const initialHeaderColor = headerColorFromSource(item.getTitleColor());
    const [headerColor, setHeaderColor] = useState<string | null>(initialHeaderColor);
    const appIconPath = item.getAppIconPath();
    const appIconSrc = appIconPath ? convertFileSrc(appIconPath) : "";
    const formatTagColor = getFormatTagColor(visualType, headerColor, Boolean(appIconSrc));
    const headerBackground = getHeaderBackground(visualType, headerColor, Boolean(appIconSrc));
    const [hovered, setHovered] = useState(false);
    const isMacosAppIcon = appIconPath.endsWith("-macos.png");
    const previewActive = selected || hovered || simulatedHover;
    const updateGifFormat = useCallback((gif: boolean) => {
        setIsGifFormat(gif);
    }, []);

    useEffect(() => {
        setHeaderColor(headerColorFromSource(item.getTitleColor()));
    }, [item.getHash(), item.getTitleColor()]);

    return (
        <div
            className={classes(styles, `clipboard-card ${selected ? 'selected' : ''} ${simulatedHover ? 'simulated-hover' : ''}`)}
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
                <div className={classes(styles, `card-item-tags ${itemTagList.length > 2 ? 'scrolling' : ''}`)} title={itemTagList.map(tag => tag.name).join(", ")}>
                    <div className={classes(styles, "card-item-tags-track")}>
                        {(itemTagList.length > 2 ? [...itemTagList, ...itemTagList] : itemTagList).map((tag, index) => (
                            <span key={`${tag.id}-${index}`} className={classes(styles, "card-item-tag")}>
                                {tag.name}
                            </span>
                        ))}
                    </div>
                </div>
            )}
            <div
                className={classes(styles, `card-header ${appIconSrc ? 'with-app-icon' : ''}`)}
                style={{ background: headerBackground, color: WHITE_HEADER_TEXT_COLOR }}
            >
                <div className={classes(styles, "card-title-block")}>
                    <span className={classes(styles, "card-title-row")}>
                        <span className={classes(styles, "card-title")}>{typeLabel}</span>
                        {formatTags.map(tag => (
                            <span
                                key={tag.key}
                                className={classes(styles, `card-format-tag ${tag.key}-format-tag`)}
                                style={{ color: formatTagColor }}
                            >
                                {tag.label}
                            </span>
                        ))}
                    </span>
                    <span className={classes(styles, "card-timestamp")}>{timestamp}</span>
                </div>
                <span className={classes(styles, "card-meta")}>
                    {item.isFavorite() && <span className={classes(styles, "favorite-icon")} title={t("clipboard.favorite")}>★</span>}
                </span>
                {appIconSrc && (
                    <div className={classes(styles, `app-icon-crop ${isMacosAppIcon ? 'macos-app-icon-crop' : ''}`)} title={t("clipboard.source", { source: item.getAppSource() || t("clipboard.unknownApp") })}>
                        <img
                            className={classes(styles, `app-header-icon ${isMacosAppIcon ? 'macos-app-icon' : ''}`)}
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
            <div className={classes(styles, "card-content")}>
                <ClipboardCardPreview
                    item={item}
                    active={previewActive}
                    refreshKey={refreshKey}
                    searchQuery={searchQuery}
                    mediaPlaybackReady={mediaPlaybackReady}
                    t={t}
                    onGifFormatChange={updateGifFormat}
                />
                {shortcutHint && <div className={classes(styles, "alt-card-hint")}>{shortcutHint}</div>}
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

export default ClipboardCard;
