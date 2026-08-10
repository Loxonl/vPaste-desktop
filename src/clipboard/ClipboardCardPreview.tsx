import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import LinkOutlinedIcon from "@mui/icons-material/LinkOutlined";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { Item, ItemType } from "./Item";
import { FileTypePresentation } from "./FileTypePresentation";
import { richHtmlHasVisibleContent, sanitizeRichHtml } from "./richPreview";
import {
    compactPath,
    isSingleImageFileItem,
    itemHasGifFormat,
    parseFilePaths,
    parseLinkContent,
    type FilePreviewInfo,
} from "./itemPresentation";

const HISTORY_IMAGE_CACHE_LIMIT = 96;
const ACTIVE_IMAGE_LOAD_DELAY_MS = 140;

const historyDataUrlCache = new Map<string, string>();
const historyPreviewSrcCache = new Map<string, string>();
const historyOriginalSrcCache = new Map<string, string>();
const historyImageMetadataCache = new Map<string, HistoryImageMetadata>();
const historyDataUrlPending = new Map<string, Promise<string>>();
const historyPreviewSrcPending = new Map<string, Promise<string>>();
const historyOriginalSrcPending = new Map<string, Promise<string>>();
const historyImageMetadataPending = new Map<string, Promise<HistoryImageMetadata>>();

type HistoryImageMetadata = {
    width: number;
    height: number;
    isGif: boolean;
    sourceBytes?: number;
    previewLimited?: boolean;
    animationLimited?: boolean;
};

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type ClipboardCardPreviewProps = {
    item: Item;
    active: boolean;
    refreshKey: number;
    searchQuery: string;
    mediaPlaybackReady: boolean;
    t: TFunction;
    onGifFormatChange: (isGif: boolean) => void;
};

function cachedValue<T>(cache: Map<string, T>, key: string): T | undefined {
    const value = cache.get(key);
    if (value === undefined) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function rememberValue<T>(cache: Map<string, T>, key: string, value: T) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > HISTORY_IMAGE_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
}

function loadSingleFlight<T>(
    cache: Map<string, T>,
    pending: Map<string, Promise<T>>,
    key: string,
    loader: () => Promise<T>,
): Promise<T> {
    const cached = cachedValue(cache, key);
    if (cached !== undefined) return Promise.resolve(cached);
    const active = pending.get(key);
    if (active) return active;

    const request = loader()
        .then(value => {
            rememberValue(cache, key, value);
            return value;
        })
        .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
}

async function loadHistoryDataUrl(path: string): Promise<string> {
    if (!path) return "";
    return loadSingleFlight(historyDataUrlCache, historyDataUrlPending, path, async () => {
        try {
            return await invoke<string>("history_file_data_url", { path });
        } catch {
            return convertFileSrc(path);
        }
    });
}

async function loadHistoryPreviewSrc(path: string): Promise<string> {
    if (!path) return "";
    return loadSingleFlight(historyPreviewSrcCache, historyPreviewSrcPending, path, async () => {
        try {
            const assetPath = await invoke<string>("history_image_card_preview_asset_path", { path });
            return convertFileSrc(assetPath);
        } catch {
            return loadHistoryDataUrl(path);
        }
    });
}

async function loadHistoryOriginalSrc(path: string): Promise<string> {
    if (!path) return "";
    return loadSingleFlight(historyOriginalSrcCache, historyOriginalSrcPending, path, async () => {
        try {
            const assetPath = await invoke<string>("history_file_preview_asset_path", { path });
            return convertFileSrc(assetPath);
        } catch {
            return loadHistoryDataUrl(path);
        }
    });
}

async function loadHistoryImageMetadata(path: string): Promise<HistoryImageMetadata> {
    return loadSingleFlight(
        historyImageMetadataCache,
        historyImageMetadataPending,
        path,
        () => invoke<HistoryImageMetadata>("history_image_metadata", { path }),
    );
}

function formatByteSize(bytes: number | undefined): string {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function naturalSizeFromMetadata(metadata: HistoryImageMetadata | undefined) {
    return metadata && metadata.width > 0 && metadata.height > 0
        ? { width: metadata.width, height: metadata.height }
        : null;
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
                    ? <mark className={classes(styles, "search-highlight")} key={`${part}-${index}`}>{part}</mark>
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
                mark.className = styles["search-highlight"];
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

        if (html !== undefined) {
            element.setAttribute("inert", "");
        }

        let frame = 0;
        let timeout = 0;
        let cancelled = false;
        const cleanup = () => {
            cancelled = true;
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timeout);
            if (html !== undefined) {
                element.removeAttribute("inert");
            }
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

export function ImagePreview({
    item,
    active,
    t,
    onGifFormatChange,
}: {
    item: Item;
    active: boolean;
    t: TFunction;
    onGifFormatChange: (isGif: boolean) => void;
}) {
    const sourcePath = item.getContent();
    const previewPath = item.getPreviewContent() || sourcePath;
    const stableIdentity = `${item.getHash()}\u0000${sourcePath}\u0000${previewPath}`;
    const initialMetadata = cachedValue(historyImageMetadataCache, sourcePath);
    const [naturalSize, setNaturalSize] = useState<{ width: number, height: number } | null>(null);
    const [stageSize, setStageSize] = useState<{ width: number, height: number }>({ width: 0, height: 0 });
    const [imageSrc, setImageSrc] = useState(() => cachedValue(historyPreviewSrcCache, previewPath) || "");
    const [previewLimited, setPreviewLimited] = useState(Boolean(initialMetadata?.previewLimited));
    const [sourceBytes, setSourceBytes] = useState(initialMetadata?.sourceBytes || 0);
    const [isVisible, setIsVisible] = useState(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const fallbackAttemptedRef = useRef(false);
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
            root: stage.closest(`.${styles["cards-container"]}`),
            rootMargin: '0px 420px',
            threshold: 0.25,
        });
        observer.observe(stage);
        return () => observer.disconnect();
    }, [stableIdentity]);

    useEffect(() => {
        const cachedMetadata = cachedValue(historyImageMetadataCache, sourcePath);
        setImageSrc(cachedValue(historyPreviewSrcCache, previewPath) || "");
        setNaturalSize(naturalSizeFromMetadata(cachedMetadata));
        setPreviewLimited(Boolean(cachedMetadata?.previewLimited));
        setSourceBytes(cachedMetadata?.sourceBytes || 0);
        onGifFormatChange(itemHasGifFormat(item));
    }, [stableIdentity, sourcePath, previewPath, onGifFormatChange]);

    useEffect(() => {
        fallbackAttemptedRef.current = false;
    }, [stableIdentity]);

    useEffect(() => {
        if (!isVisible) return;

        let cancelled = false;
        let timeout = 0;
        if (!sourcePath) return;

        const load = (metadata: HistoryImageMetadata) => {
            if (metadata.previewLimited) return;
            const loadOriginal = metadata.isGif && active && !metadata.animationLimited;
            const loader = loadOriginal ? loadHistoryOriginalSrc : loadHistoryPreviewSrc;
            loader(loadOriginal ? sourcePath : previewPath)
                .then(src => {
                    if (!cancelled && !fallbackAttemptedRef.current) setImageSrc(src);
                });
        };

        const loadWithMetadata = (metadata: HistoryImageMetadata) => {
            if (!cancelled) {
                onGifFormatChange(metadata.isGif);
                setPreviewLimited(Boolean(metadata.previewLimited));
                setSourceBytes(metadata.sourceBytes || 0);
                if (metadata.previewLimited) setImageSrc("");
            }
            if (active) {
                timeout = window.setTimeout(() => load(metadata), ACTIVE_IMAGE_LOAD_DELAY_MS);
            } else {
                load(metadata);
            }
        };

        void loadHistoryImageMetadata(sourcePath)
            .then(metadata => {
                if (!cancelled) {
                    setNaturalSize(naturalSizeFromMetadata(metadata));
                }
                loadWithMetadata(metadata);
            })
            .catch(() => loadWithMetadata({ width: 0, height: 0, isGif: false }));

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [stableIdentity, sourcePath, previewPath, isVisible, active, onGifFormatChange]);

    const recoverImageSource = () => {
        if (!sourcePath || previewLimited || fallbackAttemptedRef.current) return;
        fallbackAttemptedRef.current = true;
        historyPreviewSrcCache.delete(previewPath);
        historyOriginalSrcCache.delete(sourcePath);
        historyDataUrlCache.delete(sourcePath);
        void invoke<string>("history_file_data_url", { path: sourcePath })
            .then(setImageSrc)
            .catch(e => error(`Failed to recover history image preview: ${e}`));
    };

    return (
        <div className={classes(styles, "image-preview")}>
            <div className={classes(styles, "image-preview-stage")} ref={stageRef}>
                {imageSrc && (
                    <img
                        src={imageSrc}
                        alt=""
                        draggable={false}
                        decoding="async"
                        className={classes(styles, "image-preview-img transparency-grid")}
                        style={imageStyle}
                        onError={recoverImageSource}
                    />
                )}
                {previewLimited && (
                    <div className={classes(styles, "image-preview-limited")} data-image-preview-limited="true">
                        <WarningAmberOutlinedIcon />
                        <span>{t("clipboard.largeImagePreview")}</span>
                        {sourceBytes > 0 && <small>{formatByteSize(sourceBytes)}</small>}
                    </div>
                )}
                {naturalSize && (
                    <div className={classes(styles, "image-resolution preview-metadata")}>
                        {`${naturalSize.width} x ${naturalSize.height}`}
                    </div>
                )}
            </div>
            {item.getTextContent() && (
                <div className={classes(styles, "mixed-content-badge")}>{t("clipboard.mixedText")}</div>
            )}
        </div>
    );
}

function FilePreview({
    item,
    refreshKey,
    searchQuery,
    t,
}: {
    item: Item;
    refreshKey: number;
    searchQuery: string;
    t: TFunction;
}) {
    const [previewInfo, setPreviewInfo] = useState<FilePreviewInfo | null>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [imageSize, setImageSize] = useState<{ width: number, height: number } | null>(null);
    const [previewSrc, setPreviewSrc] = useState("");
    const previewRef = useRef<HTMLDivElement>(null);
    const fallbackPaths = parseFilePaths(item.getContent());
    const firstPath = previewInfo?.display_path || fallbackPaths[0] || item.getContent();
    const fileName = firstPath.split(/[\\/]/).filter(Boolean).pop() || "";
    const dotIndex = fileName.lastIndexOf(".");
    const extension = previewInfo?.extension || (
        dotIndex > 0 && dotIndex < fileName.length - 1
            ? fileName.slice(dotIndex + 1).toUpperCase()
            : "FILE"
    );
    const isImageFile = isSingleImageFileItem(item);
    const isGifFile = extension.toLowerCase() === "gif";
    const isMultiple = previewInfo?.kind === "multiple" || fallbackPaths.length > 1;
    const isInvalid = previewInfo ? !previewInfo.exists : false;
    const displayedImageSize = previewInfo?.image_width && previewInfo?.image_height
        ? { width: previewInfo.image_width, height: previewInfo.image_height }
        : imageSize;

    useEffect(() => {
        const element = previewRef.current;
        if (!element) return;

        const observer = new IntersectionObserver(([entry]) => {
            setIsVisible(entry.isIntersecting);
        }, {
            root: element.closest(`.${styles["cards-container"]}`),
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
                        contains_directories: false,
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
        <div className={classes(styles, `file-preview ${isInvalid ? 'invalid' : ''}`)} ref={previewRef}>
            <div className={classes(styles, `file-preview-stage ${isImageFile ? 'image-file-stage' : ''}`)}>
                {previewInfo?.kind === "single-preview" && previewInfo.preview_path ? (
                    <>
                        <img
                            key={previewSrc}
                            className={classes(styles, `file-preview-image ${isImageFile ? 'transparency-grid' : ''}`)}
                            src={previewSrc}
                            draggable={false}
                            alt=""
                            onLoad={(event) => {
                                setImageSize({
                                    width: event.currentTarget.naturalWidth,
                                    height: event.currentTarget.naturalHeight,
                                });
                            }}
                        />
                        {displayedImageSize && (
                            <div className={classes(styles, "image-resolution file-image-resolution preview-metadata")}>
                                {`${displayedImageSize.width} x ${displayedImageSize.height}`}
                            </div>
                        )}
                    </>
                ) : (
                    <FileTypePresentation
                        path={firstPath}
                        extension={extension}
                        kind={previewInfo?.kind || (isMultiple ? "multiple" : "single-icon")}
                        containsDirectories={previewInfo?.contains_directories}
                        multipleLabel={t("clipboard.fileCount", {
                            count: previewInfo?.paths.length || fallbackPaths.length,
                        })}
                        variant="card"
                    />
                )}
                {isInvalid && (
                    <div className={classes(styles, "file-invalid-badge")}>
                        <WarningAmberOutlinedIcon />
                    </div>
                )}
            </div>
            <div className={classes(styles, "file-paths")}>
                <div className={classes(styles, "file-path-line")} title={firstPath}>
                    <HighlightedText text={compactPath(firstPath)} query={searchQuery} />
                </div>
                {isMultiple && (
                    <div className={classes(styles, "file-path-line secondary")}>
                        <HighlightedText text={previewInfo?.secondary_text || t("clipboard.multipleFiles")} query={searchQuery} />
                    </div>
                )}
            </div>
        </div>
    );
}

function linkHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function LinkPreview({ item, searchQuery }: { item: Item; searchQuery: string }) {
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
        <div className={classes(styles, "link-preview")}>
            <div className={classes(styles, `link-preview-media ${showImage ? '' : 'fallback'} ${isSmallImage ? 'icon' : ''}`)}>
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
            <div className={classes(styles, "link-preview-text")}>
                <div className={classes(styles, "link-preview-title")} title={displayTitle}>
                    <HighlightedText text={displayTitle} query={searchQuery} />
                </div>
                <div className={classes(styles, "link-preview-url")} title={url}>
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
            <AutoScrollPreview active={active} className={classes(styles, "card-preview-text")}>
                <HighlightedText text={item.getContent().trimStart()} query={searchQuery} />
            </AutoScrollPreview>
        );
    }
    return (
        <AutoScrollPreview
            active={active}
            className={classes(styles, "card-preview-rich")}
            html={highlightRichHtml(html, searchQuery)}
        />
    );
}

export default function ClipboardCardPreview({
    item,
    active,
    refreshKey,
    searchQuery,
    mediaPlaybackReady,
    t,
    onGifFormatChange,
}: ClipboardCardPreviewProps) {
    if (item.getType() === ItemType.Image) {
        return (
            <ImagePreview
                item={item}
                active={active && mediaPlaybackReady}
                t={t}
                onGifFormatChange={onGifFormatChange}
            />
        );
    }
    if (item.getType() === ItemType.Color) {
        return (
            <div className={classes(styles, "card-preview-color")} style={{ background: item.getContent() }}>
                <span className={classes(styles, "color-value preview-metadata")}>
                    <HighlightedText text={item.getContent()} query={searchQuery} />
                </span>
            </div>
        );
    }
    if (item.getType() === ItemType.Link) {
        return <LinkPreview item={item} searchQuery={searchQuery} />;
    }
    if (item.getType() === ItemType.File) {
        return <FilePreview item={item} refreshKey={refreshKey} searchQuery={searchQuery} t={t} />;
    }
    if (item.isRichText()) {
        return <RichTextPreview item={item} active={active} searchQuery={searchQuery} />;
    }
    return (
        <AutoScrollPreview active={active} className={classes(styles, "card-preview-text")}>
            <HighlightedText
                text={(item.getType() === ItemType.TextFile ? item.getPreviewContent() : item.getContent()).trimStart()}
                query={searchQuery}
            />
        </AutoScrollPreview>
    );
}
