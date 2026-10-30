import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import Button from "@mui/material/Button";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import { ItemType } from "./Item";
import { FileTypePresentation } from "./FileTypePresentation";
import { isImagePath, type FilePreviewInfo } from "./itemPresentation";
import { richHtmlHasVisibleContent, sanitizeRichHtml } from "./richPreview";
import { richResourceUrls, type RichImageResource } from "./historyResourceTypes";
import { useRichPreviewCanvas } from "./useRichPreviewCanvas";
import { clipboardTabNavigationDirection } from "./clipboardKeyboard";
import { useLanguage } from "../lang";
import { notifyAuxiliaryWindowReady } from "../auxiliaryWindowReady";
import { m, motionDurationsMs, motionTokens, useMotionPreset, useReducedMotionConfig } from "../ui/motion";
import styles from "./Preview.module.css";

type HistoryImageMetadata = {
    width: number;
    height: number;
    isGif: boolean;
};

type PreviewPayload = {
    request_id?: number;
    navigation_direction?: number;
    hover?: boolean;
    item_type?: ItemType | string;
    itemType?: ItemType | string;
    content: string;
    preview_content?: string;
    previewContent?: string;
    preview_asset_path?: string;
    previewAssetPath?: string;
    text_content?: string;
    textContent?: string;
    rich_html?: string;
    richHtml?: string;
    rich_resources?: RichImageResource[];
    richResources?: RichImageResource[];
};

type PreviewNavigationDirection = -1 | 0 | 1;

const LINK_PREVIEW_ERROR_MESSAGES = new Map<string, string>([
    ["link_preview_proxy_unavailable", "preview.linkProxyUnavailable"],
    ["link_preview_fake_ip", "preview.linkFakeIp"],
    ["link_preview_timeout", "preview.linkTimeout"],
    ["link_preview_blocked", "preview.linkBlocked"],
    ["link_preview_network", "preview.linkNetworkError"],
    ["link_preview_not_html", "preview.linkNotHtml"],
    ["link_preview_redirect_limit", "preview.linkRedirectLimit"],
    ["link_preview_http_status", "preview.linkHttpError"],
]);

function parseFilePaths(content: string): string[] {
    try {
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed.filter(v => typeof v === "string") : [];
    } catch {
        return [];
    }
}

function fileName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function compactPath(path: string): string {
    if (path.length <= 92) return path;
    return `...${path.slice(path.length - 89)}`;
}

function normalizeLinkUrl(url: string): string {
    const value = url.trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    return `https://${value}`;
}

function payloadType(payload: PreviewPayload): ItemType {
    return (payload.item_type || payload.itemType || ItemType.Text) as ItemType;
}

function payloadPreviewContent(payload: PreviewPayload): string {
    return payload.preview_content || payload.previewContent || "";
}

function payloadPreviewAssetPath(payload: PreviewPayload): string {
    return payload.preview_asset_path || payload.previewAssetPath || "";
}

function payloadTextContent(payload: PreviewPayload): string {
    return payload.text_content || payload.textContent || "";
}

function payloadRichHtml(payload: PreviewPayload): string {
    return payload.rich_html || payload.richHtml || "";
}

function disableDocumentNavigation(html: string): string {
    if (!html.trim()) return "";
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const policy = parsed.createElement("meta");
    policy.setAttribute("http-equiv", "Content-Security-Policy");
    policy.setAttribute(
        "content",
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'",
    );
    parsed.head.prepend(policy);
    parsed.querySelectorAll("meta[http-equiv]").forEach(node => {
        if (node.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
            node.remove();
        }
    });
    parsed.querySelectorAll("base").forEach(node => node.remove());
    parsed.querySelectorAll("a, area").forEach(node => {
        ["href", "xlink:href", "target", "download", "ping"].forEach(name => {
            node.removeAttribute(name);
        });
        node.setAttribute("aria-disabled", "true");
    });
    parsed.querySelectorAll("[formaction]").forEach(node => {
        node.removeAttribute("formaction");
    });
    parsed.querySelectorAll("form").forEach(node => {
        node.replaceWith(...Array.from(node.childNodes));
    });
    parsed.querySelectorAll("iframe, frame, object, embed").forEach(node => node.remove());
    return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

export function PreviewBody({ payload, t, onReady }: {
    payload: PreviewPayload;
    t: (key: string, params?: Record<string, string | number>) => string;
    onReady?: () => void;
}) {
    const [fileInfo, setFileInfo] = useState<FilePreviewInfo | null>(null);
    const [fileError, setFileError] = useState("");
    const [fileText, setFileText] = useState("");
    const [fileTextReady, setFileTextReady] = useState(false);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageError, setImageError] = useState(false);
    const readySentRef = useRef(false);
    const [imageSrc, setImageSrc] = useState("");
    const [filePreviewSrc, setFilePreviewSrc] = useState("");
    const [linkDocument, setLinkDocument] = useState<{ url: string; html: string } | null>(null);
    const [linkError, setLinkError] = useState("");
    const type = payloadType(payload);
    const linkUrl = type === ItemType.Link ? normalizeLinkUrl(payload.content.split("|||")[0]) : "";
    const richHtml = useMemo(() => sanitizeRichHtml(payloadRichHtml(payload), 720, false,
        richResourceUrls(payload.rich_resources ?? payload.richResources ?? [])), [payload]);
    const richPreviewRef = useRichPreviewCanvas(richHtml);
    const linkPreviewHtml = useMemo(
        () => linkDocument ? disableDocumentNavigation(linkDocument.html) : "",
        [linkDocument],
    );
    const text = useMemo(() => {
        if (type === ItemType.Link) return linkUrl;
        return payloadTextContent(payload) || payload.content;
    }, [linkUrl, payload.content, payload.text_content, type]);

    const ready = type === ItemType.Image
        ? imageLoaded
        : type === ItemType.File
            ? !!fileError || (!!fileInfo && (fileInfo.kind === "single-preview"
                ? imageLoaded
                : fileInfo.kind === "text-preview" ? fileTextReady : true))
            : true;
    useEffect(() => {
        if (!ready || readySentRef.current) return;
        readySentRef.current = true;
        onReady?.();
    }, [ready, onReady]);

    const imageReady = (event: SyntheticEvent<HTMLImageElement>) => {
        const image = event.currentTarget;
        void Promise.resolve(image.decode?.()).catch(() => undefined)
            .then(() => setImageLoaded(true));
    };
    const imageFailed = () => {
        setImageError(true);
        setImageLoaded(true);
    };

    useEffect(() => {
        let cancelled = false;
        setFileInfo(null);
        setFileError("");
        setFileText("");
        setFileTextReady(false);
        setFilePreviewSrc("");
        if (type !== ItemType.File) return;
        invoke<FilePreviewInfo>("file_preview_info", { content: payload.content })
            .then(info => {
                if (!cancelled) setFileInfo(info);
                if (info.kind === "text-preview" && info.display_path) {
                    return invoke<string>("read_preview_text_file", { path: info.display_path })
                        .then(text => {
                            if (!cancelled) {
                                setFileText(text);
                                setFileTextReady(true);
                            }
                        });
                }
            })
            .catch(e => {
                if (!cancelled) setFileError(String(e));
                error(`Failed to load preview file info: ${e}`);
            });
        return () => {
            cancelled = true;
        };
    }, [payload.content, type]);

    useEffect(() => {
        let cancelled = false;
        setImageSrc("");
        if (type !== ItemType.Image) return;
        const sourcePath = payload.content || payloadPreviewContent(payload);
        const assetPath = payloadPreviewAssetPath(payload);
        if (!sourcePath) return;

        invoke<HistoryImageMetadata>("history_image_metadata", { path: sourcePath })
            .then(metadata => {
                if (metadata.isGif) {
                    return invoke<string>("history_file_preview_asset_path", { path: sourcePath })
                        .then(src => {
                            if (!cancelled) setImageSrc(convertFileSrc(src));
                        });
                }
                if (assetPath) {
                    if (!cancelled) setImageSrc(convertFileSrc(assetPath));
                    return;
                }
                const path = payloadPreviewContent(payload) || sourcePath;
                return invoke<string>("history_file_preview_asset_path", { path })
                    .then(src => {
                        if (!cancelled) setImageSrc(convertFileSrc(src));
                    })
                    .catch(() => {
                        if (!cancelled) setImageSrc(convertFileSrc(sourcePath));
                    });
            })
            .catch(() => {
                if (!cancelled) setImageSrc(convertFileSrc(sourcePath));
            });
        return () => {
            cancelled = true;
        };
    }, [payload, type]);

    useEffect(() => {
        let cancelled = false;
        setLinkDocument(null);
        setLinkError("");
        if (type !== ItemType.Link || !linkUrl) return;
        invoke<{ url: string; html: string }>("fetch_link_preview_document", { url: linkUrl })
            .then(document => {
                if (!cancelled) setLinkDocument(document);
            })
            .catch(e => {
                const message = LINK_PREVIEW_ERROR_MESSAGES.get(typeof e === "string" ? e : "") || "preview.linkNetworkError";
                if (!cancelled) setLinkError(message);
                error(`Link preview failed: ${message}`);
            });
        return () => {
            cancelled = true;
        };
    }, [linkUrl, type]);

    useEffect(() => {
        let cancelled = false;
        setFilePreviewSrc("");
        if (!fileInfo?.preview_path) return;
        invoke<string>("history_file_preview_asset_path", { path: fileInfo.preview_path })
            .then(src => {
                if (!cancelled) setFilePreviewSrc(convertFileSrc(src));
            })
            .catch(() => {
                if (!cancelled) setFilePreviewSrc(convertFileSrc(fileInfo.preview_path));
            });
        return () => {
            cancelled = true;
        };
    }, [fileInfo?.preview_path]);

    if (type === ItemType.Image) {
        if (imageError) return <div className={styles["preview-empty"]}>{t("preview.unsupported")}</div>;
        return (
            <div className={styles["preview-image-stage"]}>
                <img
                    src={imageSrc || undefined}
                    alt=""
                    onLoad={imageReady}
                    onError={imageFailed}
                    className={styles["transparency-grid"]}
                />
            </div>
        );
    }

    if (type === ItemType.Color) {
        return (
            <div className={styles["preview-color-stage"]} style={{ background: payload.content }}>
                <span>{payload.content}</span>
            </div>
        );
    }

    if (type === ItemType.Link) {
        return (
            <div className={styles["preview-link-stage"]}>
                <div className={styles["preview-link-bar"]} title={linkUrl}>
                    <span>{linkUrl}</span>
                </div>
                {linkDocument ? (
                    <iframe
                        className={styles["preview-link-frame"]}
                        srcDoc={linkPreviewHtml}
                        title={linkDocument.url}
                        referrerPolicy="no-referrer"
                        sandbox=""
                    />
                ) : (
                    <div className={styles["preview-link-loading"]}>
                        <span role={linkError ? "alert" : undefined}>{t(linkError || "preview.generating")}</span>
                        {linkError && (
                            <Button size="small" onClick={() => {
                                void invoke("open_url_in_browser", { url: linkUrl })
                                    .catch(() => error("Failed to open original preview link"));
                            }}>{t("preview.openOriginalLink")}</Button>
                        )}
                    </div>
                )}
            </div>
        );
    }

    if (type === ItemType.File) {
        if (fileError) {
            return <div className={styles["preview-empty"]}>{t("preview.unsupported")}</div>;
        }
        if (!fileInfo) {
            return <div className={styles["preview-empty"]}>{t("preview.generating")}</div>;
        }
        const paths = fileInfo.paths.length ? fileInfo.paths : parseFilePaths(payload.content);
        const mainPath = fileInfo.display_path || paths[0] || "";
        if (fileInfo.kind === "pdf-preview") {
            return (
                <div className={styles["preview-pdf-stage"]}>
                    <iframe src={convertFileSrc(mainPath)} title={fileName(mainPath)} />
                </div>
            );
        }
        if (fileInfo.kind === "text-preview") {
            return (
                <pre className={styles["preview-text"]}>{fileText || t("preview.readingText")}</pre>
            );
        }
        if (fileInfo.kind === "single-preview" && fileInfo.preview_path) {
            if (imageError) return <div className={styles["preview-empty"]}>{t("preview.unsupported")}</div>;
            return (
                <div className={styles["preview-file-stage"]}>
                    <div className={styles["preview-file-image-wrap"]}>
                        <img
                            src={filePreviewSrc || undefined}
                            alt=""
                            onLoad={imageReady}
                            onError={imageFailed}
                            className={isImagePath(mainPath) ? styles["transparency-grid"] : undefined}
                        />
                    </div>
                    <div className={styles["preview-file-caption"]}>
                        <strong>{fileName(mainPath)}</strong>
                        <span>{compactPath(mainPath)}</span>
                    </div>
                </div>
            );
        }
        return (
            <div className={styles["preview-file-info"]}>
                <FileTypePresentation
                    path={mainPath}
                    extension={fileInfo.extension}
                    kind={fileInfo.kind}
                    containsDirectories={fileInfo.contains_directories}
                    multipleLabel={t("clipboard.fileCount", { count: paths.length })}
                    variant="preview"
                />
                <div className={styles["preview-file-name"]}>{fileName(mainPath) || t("common.file")}</div>
                <div className={styles["preview-file-path"]}>{compactPath(mainPath)}</div>
                {fileInfo.kind === "multiple" && <div className={styles["preview-file-note"]}>{t("preview.multipleNote", { count: paths.length })}</div>}
                {!fileInfo.exists && <div className={styles["preview-file-warning"]}>{t("preview.fileMissing")}</div>}
            </div>
        );
    }

    if (richHtmlHasVisibleContent(richHtml)) {
        return (
            <div
                ref={richPreviewRef}
                className={styles["preview-rich"]}
                dangerouslySetInnerHTML={{ __html: richHtml }}
            />
        );
    }

    return (
        <pre className={styles["preview-text"]}>{text || t("preview.noText")}</pre>
    );
}

type PreviewLayer = {
    id: number;
    payload: PreviewPayload;
    direction: PreviewNavigationDirection;
    phase: "pending" | "current" | "exiting";
};

function samePreviewContent(a: PreviewPayload, b: PreviewPayload) {
    return payloadType(a) === payloadType(b) && a.content === b.content
        && payloadPreviewContent(a) === payloadPreviewContent(b)
        && payloadPreviewAssetPath(a) === payloadPreviewAssetPath(b)
        && payloadTextContent(a) === payloadTextContent(b)
        && payloadRichHtml(a) === payloadRichHtml(b);
}

export default function Preview() {
    const { t } = useLanguage();
    const contentMotion = useMotionPreset("preview");
    const reducedMotionRef = useRef(false);
    reducedMotionRef.current = Boolean(useReducedMotionConfig());
    const [layers, setLayers] = useState<PreviewLayer[]>([]);
    const [pinned, setPinned] = useState(false);
    const pinnedRef = useRef(false);
    const hoverRef = useRef(false);
    const pendingNavigationDirectionRef = useRef<PreviewNavigationDirection>(0);
    const sequenceRef = useRef(0);
    const latestRequestRef = useRef(0);
    const currentLayerRef = useRef<PreviewLayer | null>(null);
    const pendingLayerRef = useRef<PreviewLayer | null>(null);

    const commitLayer = useCallback(async (layer: PreviewLayer, reuse = false) => {
        if (pendingLayerRef.current?.id !== layer.id) return;
        try {
            const accepted = layer.payload.request_id === undefined || await invoke<boolean>("commit_preview_window", {
                requestId: layer.payload.request_id,
                reducedMotion: reducedMotionRef.current,
                durationMs: motionDurationsMs.standard,
                easing: motionTokens.easing.enter,
            });
            if (pendingLayerRef.current?.id !== layer.id) return;
            pendingLayerRef.current = null;
            if (!accepted) {
                setLayers(current => current.filter(entry => entry.id !== layer.id));
                return;
            }
            const next = reuse
                ? { ...currentLayerRef.current!, phase: "current" as const }
                : { ...layer, phase: "current" as const };
            currentLayerRef.current = next;
            hoverRef.current = layer.payload.hover === true;
            pinnedRef.current = false;
            setPinned(false);
            setLayers(current => reuse ? [next] : current.map(entry => ({
                ...entry,
                phase: entry.id === layer.id ? "current" : "exiting",
            })));
        } catch (previewError) {
            if (pendingLayerRef.current?.id === layer.id) {
                pendingLayerRef.current = null;
                setLayers(current => current.filter(entry => entry.id !== layer.id));
            }
            error(`Failed to commit preview: ${previewError}`);
        }
    }, []);

    useEffect(() => {
        const receive = (payload: PreviewPayload) => {
            if (payload.request_id !== undefined && payload.request_id <= latestRequestRef.current) return;
            if (payload.request_id !== undefined) latestRequestRef.current = payload.request_id;
            const direction = payload.navigation_direction ?? pendingNavigationDirectionRef.current;
            pendingNavigationDirectionRef.current = 0;
            const layer: PreviewLayer = {
                id: ++sequenceRef.current, payload, phase: "pending",
                direction: direction < 0 ? -1 : direction > 0 ? 1 : 0,
            };
            pendingLayerRef.current = layer;
            if (currentLayerRef.current && samePreviewContent(currentLayerRef.current.payload, payload)) {
                void commitLayer(layer, true);
            } else {
                setLayers(current => [...current.filter(entry => entry.phase === "current"), layer]);
            }
        };
        const unlisten = listen<PreviewPayload>("preview-item", event => receive(event.payload));
        const unlistenClear = listen("preview-clear", () => {
            sequenceRef.current += 1;
            pendingLayerRef.current = null;
            currentLayerRef.current = null;
            hoverRef.current = false;
            pendingNavigationDirectionRef.current = 0;
            setLayers([]);
        });
        const unlistenPromoted = listen("preview-promoted", () => { hoverRef.current = false; });
        const cancelReady = notifyAuxiliaryWindowReady([unlisten, unlistenClear, unlistenPromoted]);
        // Replay a first request that arrived while this lazy route was still loading.
        const mountSequence = sequenceRef.current;
        void Promise.all([unlisten, unlistenClear]).then(() => invoke<PreviewPayload | null>("pending_preview_item"))
            .then(payload => {
                if (payload && sequenceRef.current === mountSequence) receive(payload);
            }).catch(e => error(`Failed to restore pending preview: ${e}`));
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.isComposing || event.keyCode === 229) return;
            const tabDirection = clipboardTabNavigationDirection(event);
            if (tabDirection !== null) {
                event.preventDefault();
                void emitTo("clipboard", "preview-navigate-selection", { direction: tabDirection, key: "Tab", ctrlKey: true })
                    .catch(e => error(`Failed to switch preview category: ${e}`));
                return;
            }
            const plainTab = event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey;
            if (event.key === "ArrowRight" || event.key === "ArrowLeft" || plainTab) {
                event.preventDefault();
                const direction = event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
                pendingNavigationDirectionRef.current = direction;
                void emitTo("clipboard", "preview-navigate-selection", { direction, key: event.key })
                    .catch(e => {
                        if (pendingNavigationDirectionRef.current === direction) {
                            pendingNavigationDirectionRef.current = 0;
                        }
                        error(`Failed to navigate preview selection: ${e}`);
                    });
                return;
            }
            if (event.key === "Escape" || event.key === " " || event.key === "Spacebar") {
                event.preventDefault();
                if (event.repeat) return;
                pendingLayerRef.current = null;
                void invoke("hide_preview_window").catch(e => error(`Failed to hide preview: ${e}`));
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            sequenceRef.current += 1;
            pendingLayerRef.current = null;
            cancelReady();
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten preview: ${e}`));
            unlistenClear.then(fn => fn()).catch(e => error(`Failed to unlisten preview clear: ${e}`));
            unlistenPromoted.then(fn => fn()).catch(e => error(`Failed to unlisten preview promotion: ${e}`));
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [commitLayer]);

    const togglePinned = () => {
        const next = !pinnedRef.current;
        pinnedRef.current = next;
        setPinned(next);
        void invoke("set_preview_pinned", { pinned: next }).catch(e => error(`Failed to set preview pinned: ${e}`));
    };

    return (
        <div className={styles["preview-shell"]}
            onMouseEnter={() => { if (hoverRef.current) void emitTo("clipboard", "preview-hover", true).catch(e => error(`Failed to retain hover preview: ${e}`)); }}
            onMouseLeave={() => { if (hoverRef.current) void emitTo("clipboard", "preview-hover", false).catch(e => error(`Failed to leave hover preview: ${e}`)); }}
        >
            <ToolbarIconButton
                size="medium"
                className={[styles["preview-pin"], pinned ? styles.pinned : ""].join(" ")}
                label={pinned ? t("preview.unpin") : t("preview.pin")}
                aria-pressed={pinned}
                onClick={togglePinned}
            >
                {pinned ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
            </ToolbarIconButton>
            <div className={styles["preview-content"]}>
                {layers.length === 0 && <div className={styles["preview-empty"]}>{t("preview.waiting")}</div>}
                {layers.map(layer => (
                    <m.div
                        key={layer.id}
                        className={styles["preview-state"]}
                        data-motion-preset="preview"
                        data-preview-phase={layer.phase}
                        aria-hidden={layer.phase !== "current"}
                        {...(layer.phase !== "current" ? { inert: "" } : {})}
                        data-preview-direction={layer.direction < 0
                            ? "backward"
                            : layer.direction > 0
                                ? "forward"
                                : "neutral"}
                        custom={layer.direction}
                        variants={contentMotion}
                        initial="initial"
                        animate={layer.phase === "current" ? "animate" : layer.phase === "exiting" ? "exit" : "initial"}
                        onAnimationComplete={definition => {
                            if (definition === "exit" && layer.phase === "exiting") {
                                setLayers(current => current.filter(entry => entry.id !== layer.id));
                            }
                        }}
                    >
                        <PreviewBody payload={layer.payload} t={t} onReady={() => { void commitLayer(layer); }} />
                    </m.div>
                ))}
            </div>
        </div>
    );
}
