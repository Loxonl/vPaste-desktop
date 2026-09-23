import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { formatRelativeTime } from "../lang";
import { Item, ItemType } from "./Item";
import ClipboardCardPreview from "./ClipboardCardPreview";
import {
    dominantColorFromPixels,
    ensureWhiteTextContrast,
    WHITE_HEADER_TEXT_COLOR,
} from "./clipboardHeaderColor";
import { isSingleImageFileItem } from "./itemPresentation";
import {
    configureClipboardDrag,
    isExternalDragExcludedTarget,
    externalDragFilePaths,
    isNativeFileDragItem,
} from "./clipboardDrag";
import {
    AnimatePresence,
    m,
    motionSprings,
    motionTokens,
    useAnimate,
    useMotionPreset,
    useReducedMotionConfig,
} from "../ui/motion";

const FILTER_RESULT_STAGGER_GROUP_SIZE = 12;

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type ClipboardCardProps = {
    item: Item;
    selected: boolean;
    selectionMode?: boolean;
    dragDisabled?: boolean;
    simulatedHover: boolean;
    refreshKey: number;
    searchQuery: string;
    shortcutHint?: string;
    filterMotionRequestSeq?: number;
    filterMotionIndex: number;
    mediaPlaybackReady: boolean;
    t: TFunction;
    onContextMenu: (item: Item, x: number, y: number) => void;
    onActivate?: (hash: string, plainText: boolean) => void;
    onDragUnavailable?: () => void;
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
        const dominant = dominantColorFromPixels(data);
        return dominant ? ensureWhiteTextContrast(dominant) : null;
    } catch {
        return null;
    }
}

const ClipboardCardComponent = forwardRef<HTMLDivElement, ClipboardCardProps>(function ClipboardCardComponent({
    item,
    selected,
    selectionMode = false,
    dragDisabled = false,
    simulatedHover,
    refreshKey,
    searchQuery,
    shortcutHint,
    filterMotionRequestSeq,
    filterMotionIndex,
    mediaPlaybackReady,
    t,
    onContextMenu,
    onActivate,
    onDragUnavailable,
}: ClipboardCardProps, ref) {
    const cardMotion = useMotionPreset("gridItem");
    const shortcutHintMotion = useMotionPreset("shortcutHint");
    const stateIndicatorMotion = useMotionPreset("stateIndicator");
    const reduceMotion = Boolean(useReducedMotionConfig());
    const [filterMotionRef, animateFilterMotion] = useAnimate<HTMLDivElement>();
    const [dragging, setDragging] = useState(false);
    const [dragCompleted, setDragCompleted] = useState(false);
    const dragFeedbackTimerRef = useRef<number | null>(null);
    const dragStartedRef = useRef(false);
    const dragTextRef = useRef<string | null>(null);
    const dragTextLoadRef = useRef<Promise<void> | null>(null);
    const dragTextHoveredRef = useRef(false);
    const nativeDragStateRef = useRef<{ x: number; y: number; started: boolean } | null>(null);
    const visualType = isSingleImageFileItem(item) ? ItemType.Image : item.getType();
    const nativeFileDrag = isNativeFileDragItem(item);
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

    const prepareDragText = useCallback(() => {
        if (item.getType() !== ItemType.TextFile || dragTextRef.current !== null || dragTextLoadRef.current) return;
        dragTextLoadRef.current = invoke<string>("plain_text_content", { hash: item.getHash() })
            .then(text => {
                if (dragTextHoveredRef.current) dragTextRef.current = text;
            })
            .catch(error => console.warn("Could not prepare full text for dragging", error))
            .finally(() => { dragTextLoadRef.current = null; });
    }, [item]);

    const showDragCompleted = useCallback(() => {
        setDragCompleted(true);
        if (dragFeedbackTimerRef.current !== null) {
            window.clearTimeout(dragFeedbackTimerRef.current);
        }
        dragFeedbackTimerRef.current = window.setTimeout(() => {
            setDragCompleted(false);
            dragFeedbackTimerRef.current = null;
        }, 420);
    }, []);

    const startNativeFileDrag = useCallback((): boolean => {
        if (!nativeFileDrag) return false;
        const paths = externalDragFilePaths(item);
        if (paths.length === 0) return false;

        void invoke<boolean>("native_drag_file", {
            paths,
            isImage: item.getType() === ItemType.Image,
        })
            .then((dropped) => {
                if (dropped) showDragCompleted();
            })
            .catch((error) => console.warn("Native file drag failed", error))
            .finally(() => {
                setDragging(false);
                nativeDragStateRef.current = null;
            });
        return true;
    }, [item, nativeFileDrag, showDragCompleted]);

    useEffect(() => () => {
        if (dragFeedbackTimerRef.current !== null) {
            window.clearTimeout(dragFeedbackTimerRef.current);
        }
    }, []);

    useEffect(() => {
        setHeaderColor(headerColorFromSource(item.getTitleColor()));
    }, [item.getHash(), item.getTitleColor()]);

    useLayoutEffect(() => {
        if (filterMotionRequestSeq === undefined || reduceMotion) {
            filterMotionRef.current.style.transform = "";
            return;
        }

        const controls = animateFilterMotion(
            filterMotionRef.current,
            { x: [motionTokens.distance.emphasis, 0] },
            {
                ...motionSprings.gentle,
                delay: (filterMotionIndex % FILTER_RESULT_STAGGER_GROUP_SIZE) * motionTokens.stagger.tight,
            },
        );
        return () => {
            controls.stop();
            filterMotionRef.current.style.transform = "";
        };
    }, [
        animateFilterMotion,
        filterMotionIndex,
        filterMotionRef,
        filterMotionRequestSeq,
        reduceMotion,
    ]);

    return (
        <m.div
            ref={ref}
            className={classes(styles, "card-motion-item")}
            variants={cardMotion}
            data-motion-preset="gridItem"
            data-card-hash={item.getHash() as string}
            initial={filterMotionRequestSeq === undefined ? "initial" : false}
            animate="animate"
            exit="exit"
        >
            <div
                ref={filterMotionRef}
                className={classes(styles, "card-filter-motion-item")}
                data-filter-motion-hash={item.getHash() as string}
            >
            <div
            className={classes(styles, `clipboard-card ${selected ? 'selected' : ''} ${simulatedHover ? 'simulated-hover' : ''} ${dragging ? 'external-dragging' : ''}`)}
            data-hash={item.getHash() as string}
            data-external-dragging={dragging || undefined}
            data-native-file-drag={nativeFileDrag ? "true" : undefined}
            tabIndex={-1}
            draggable={!dragDisabled && !selectionMode && !nativeFileDrag}
            onMouseEnter={() => {
                setHovered(true);
                dragTextHoveredRef.current = true;
                if (!dragDisabled && !selectionMode) prepareDragText();
            }}
            onMouseLeave={() => {
                setHovered(false);
                dragTextHoveredRef.current = false;
                dragTextRef.current = null;
                if (!nativeDragStateRef.current?.started) {
                    nativeDragStateRef.current = null;
                }
            }}
            onMouseDown={(event) => {
                dragStartedRef.current = false;
                nativeDragStateRef.current = null;
                if (!dragDisabled && !selectionMode && event.button === 0) {
                    dragTextHoveredRef.current = true;
                    prepareDragText();
                }
                if (
                    nativeFileDrag
                    && !dragDisabled
                    && !selectionMode
                    && event.button === 0
                    && !isExternalDragExcludedTarget(event.target)
                ) {
                    event.stopPropagation();
                    nativeDragStateRef.current = {
                        x: event.clientX,
                        y: event.clientY,
                        started: false,
                    };
                }
            }}
            onMouseMove={(event) => {
                const state = nativeDragStateRef.current;
                if (!nativeFileDrag || !state || state.started) return;
                if (event.buttons !== 0 && (event.buttons & 1) !== 1) {
                    nativeDragStateRef.current = null;
                    return;
                }
                const distance = Math.hypot(event.clientX - state.x, event.clientY - state.y);
                if (distance < 6) return;
                event.preventDefault();
                event.stopPropagation();
                if (!startNativeFileDrag()) {
                    nativeDragStateRef.current = null;
                    return;
                }
                state.started = true;
                dragStartedRef.current = true;
                setDragCompleted(false);
                setDragging(true);
            }}
            onMouseUp={() => {
                nativeDragStateRef.current = null;
                setDragging(false);
            }}
            onClick={(event) => {
                if (dragDisabled || selectionMode || isExternalDragExcludedTarget(event.target)) return;
                if (dragStartedRef.current) {
                    dragStartedRef.current = false;
                    return;
                }
                event.preventDefault();
                onActivate?.(item.getHash() as string, event.shiftKey);
            }}
            onDragStart={(event) => {
                if (dragDisabled || selectionMode || isExternalDragExcludedTarget(event.target)) {
                    event.preventDefault();
                    return;
                }

                if (!configureClipboardDrag(event, item, dragTextRef.current ?? undefined)) {
                    event.preventDefault();
                    prepareDragText();
                    onDragUnavailable?.();
                    return;
                }

                setDragCompleted(false);
                setDragging(true);
                dragStartedRef.current = true;

                const dragImage = document.createElement("div");
                dragImage.className = classes(styles, "clipboard-drag-preview");
                dragImage.dataset.type = visualType.toLowerCase();
                dragImage.textContent = t("clipboard.dragging");
                document.body.appendChild(dragImage);
                event.dataTransfer.setDragImage?.(dragImage, 18, 18);
                window.requestAnimationFrame(() => dragImage.remove());
            }}
            onDragEnd={(event) => {
                setDragging(false);
                if (event.dataTransfer.dropEffect === "none") return;
                showDragCompleted();
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(item, event.clientX, event.clientY);
            }}
        >
            <AnimatePresence mode="wait" initial={false}>
                {selectionMode && selected && (
                    <m.span
                        key="queue-selection"
                        className={classes(styles, "queue-selection-indicator")}
                        data-motion-preset="stateIndicator"
                        data-motion-state="queue-selection"
                        variants={stateIndicatorMotion}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        aria-hidden="true"
                    >
                        <CheckCircleRoundedIcon fontSize="inherit" />
                    </m.span>
                )}
                {dragCompleted && (
                    <m.span
                        key="external-drag-complete"
                        className={classes(styles, "external-drag-success")}
                        data-motion-preset="stateIndicator"
                        data-motion-state="external-drag-complete"
                        variants={stateIndicatorMotion}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        aria-hidden="true"
                    >
                        <CheckCircleRoundedIcon fontSize="inherit" />
                    </m.span>
                )}
            </AnimatePresence>
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
                    <AnimatePresence mode="wait" initial={false}>
                        {item.isFavorite() && (
                            <m.span
                                key="favorite"
                                className={classes(styles, "favorite-icon")}
                                data-motion-preset="stateIndicator"
                                data-motion-state="favorite"
                                variants={stateIndicatorMotion}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                title={t("clipboard.favorite")}
                            >
                                ★
                            </m.span>
                        )}
                    </AnimatePresence>
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
                {shortcutHint && (
                    <m.div
                        className={classes(styles, "alt-card-hint")}
                        variants={shortcutHintMotion}
                        data-motion-preset="shortcutHint"
                        initial="initial"
                        animate="animate"
                    >
                        {shortcutHint}
                    </m.div>
                )}
            </div>
            </div>
            </div>
        </m.div>
    );
});

ClipboardCardComponent.displayName = "ClipboardCardComponent";

const ClipboardCard = React.memo(ClipboardCardComponent, (prev, next) => (
    prev.item === next.item
    && prev.selected === next.selected
    && prev.selectionMode === next.selectionMode
    && prev.dragDisabled === next.dragDisabled
    && prev.simulatedHover === next.simulatedHover
    && prev.refreshKey === next.refreshKey
    && prev.searchQuery === next.searchQuery
    && prev.shortcutHint === next.shortcutHint
    && prev.filterMotionRequestSeq === next.filterMotionRequestSeq
    && prev.filterMotionIndex === next.filterMotionIndex
    && prev.mediaPlaybackReady === next.mediaPlaybackReady
    && prev.t === next.t
    && prev.onActivate === next.onActivate
));

export default ClipboardCard;
