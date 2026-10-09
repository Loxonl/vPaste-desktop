import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import { ItemType } from "./Item";
import { FileTypePresentation } from "./FileTypePresentation";
import { isImagePath, type FilePreviewInfo } from "./itemPresentation";
import { richHtmlHasVisibleContent, sanitizeRichHtml } from "./richPreview";
import { useLanguage } from "../lang";
import { AnimatePresence, m, useMotionPreset } from "../ui/motion";
import styles from "./Preview.module.css";

type HistoryImageMetadata = {
    width: number;
    height: number;
    isGif: boolean;
};

type PreviewPayload = {
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
};

type PreviewNavigationDirection = -1 | 0 | 1;

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

export function PreviewBody({ payload, t }: { payload: PreviewPayload, t: (key: string, params?: Record<string, string | number>) => string }) {
    const [fileInfo, setFileInfo] = useState<FilePreviewInfo | null>(null);
    const [fileError, setFileError] = useState("");
    const [fileText, setFileText] = useState("");
    const [imageSrc, setImageSrc] = useState("");
    const [filePreviewSrc, setFilePreviewSrc] = useState("");
    const [linkDocument, setLinkDocument] = useState<{ url: string; html: string } | null>(null);
    const [linkError, setLinkError] = useState("");
    const type = payloadType(payload);
    const linkUrl = type === ItemType.Link ? normalizeLinkUrl(payload.content.split("|||")[0]) : "";
    const richHtml = useMemo(() => sanitizeRichHtml(payloadRichHtml(payload), 720), [payload]);
    const linkPreviewHtml = useMemo(
        () => linkDocument ? disableDocumentNavigation(linkDocument.html) : "",
        [linkDocument],
    );
    const text = useMemo(() => {
        if (type === ItemType.Link) return linkUrl;
        return payloadTextContent(payload) || payload.content;
    }, [linkUrl, payload.content, payload.text_content, type]);

    useEffect(() => {
        let cancelled = false;
        setFileInfo(null);
        setFileError("");
        setFileText("");
        setFilePreviewSrc("");
        if (type !== ItemType.File) return;
        invoke<FilePreviewInfo>("file_preview_info", { content: payload.content })
            .then(info => {
                if (!cancelled) setFileInfo(info);
                if (info.kind === "text-preview" && info.display_path) {
                    return invoke<string>("read_preview_text_file", { path: info.display_path })
                        .then(text => {
                            if (!cancelled) setFileText(text);
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
                        return invoke<string>("history_file_data_url", { path: sourcePath })
                            .then(src => {
                                if (!cancelled) setImageSrc(src);
                            })
                            .catch(() => {
                                if (!cancelled) setImageSrc(convertFileSrc(sourcePath));
                            });
                    });
            })
            .catch(() => {
                invoke<string>("history_file_data_url", { path: sourcePath })
                    .then(src => {
                        if (!cancelled) setImageSrc(src);
                    })
                    .catch(() => {
                        if (!cancelled) setImageSrc(convertFileSrc(sourcePath));
                    });
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
                if (!cancelled) setLinkError(String(e));
                error(`Failed to fetch link preview document: ${e}`);
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
                invoke<string>("history_file_data_url", { path: fileInfo.preview_path })
                    .then(src => {
                        if (!cancelled) setFilePreviewSrc(src);
                    })
                    .catch(() => {
                        if (!cancelled) setFilePreviewSrc(convertFileSrc(fileInfo.preview_path));
                    });
            });
        return () => {
            cancelled = true;
        };
    }, [fileInfo?.preview_path]);

    if (type === ItemType.Image) {
        return (
            <div className={styles["preview-image-stage"]}>
                <img
                    src={imageSrc}
                    alt=""
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
                        {linkError || t("preview.generating")}
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
            return (
                <div className={styles["preview-file-stage"]}>
                    <div className={styles["preview-file-image-wrap"]}>
                        <img
                            src={filePreviewSrc}
                            alt=""
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
                className={styles["preview-rich"]}
                dangerouslySetInnerHTML={{ __html: richHtml }}
            />
        );
    }

    return (
        <pre className={styles["preview-text"]}>{text || t("preview.noText")}</pre>
    );
}

export default function Preview() {
    const { t } = useLanguage();
    const contentMotion = useMotionPreset("preview");
    const waitingMotion = useMotionPreset("fade");
    const [payload, setPayload] = useState<PreviewPayload | null>(null);
    const [payloadRevision, setPayloadRevision] = useState(0);
    const [navigationDirection, setNavigationDirection] = useState<PreviewNavigationDirection>(0);
    const [pinned, setPinned] = useState(false);
    const openedAtRef = useRef(0);
    const pinnedRef = useRef(false);
    const pendingNavigationDirectionRef = useRef<PreviewNavigationDirection>(0);

    useEffect(() => {
        const unlisten = listen<PreviewPayload>("preview-item", event => {
            openedAtRef.current = Date.now();
            pinnedRef.current = false;
            setPinned(false);
            setNavigationDirection(pendingNavigationDirectionRef.current);
            pendingNavigationDirectionRef.current = 0;
            setPayloadRevision(revision => revision + 1);
            setPayload(event.payload);
        });
        const unlistenClear = listen("preview-clear", () => {
            pendingNavigationDirectionRef.current = 0;
            setNavigationDirection(0);
            setPayload(null);
        });
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "Tab") {
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
            if (event.key === "Escape" || event.key === " ") {
                event.preventDefault();
                void invoke("hide_preview_window").catch(e => error(`Failed to hide preview: ${e}`));
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten preview: ${e}`));
            unlistenClear.then(fn => fn()).catch(e => error(`Failed to unlisten preview clear: ${e}`));
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, []);

    const togglePinned = () => {
        const next = !pinnedRef.current;
        pinnedRef.current = next;
        setPinned(next);
        void invoke("set_preview_pinned", { pinned: next }).catch(e => error(`Failed to set preview pinned: ${e}`));
    };

    return (
        <div className={styles["preview-shell"]}>
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
                <AnimatePresence mode="wait" initial={false} custom={navigationDirection}>
                    <m.div
                        key={payload ? `preview-content-${payloadRevision}` : "preview-waiting"}
                        className={styles["preview-state"]}
                        data-motion-preset={payload ? "preview" : "fade"}
                        data-preview-direction={navigationDirection < 0
                            ? "backward"
                            : navigationDirection > 0
                                ? "forward"
                                : "neutral"}
                        custom={navigationDirection}
                        variants={payload ? contentMotion : waitingMotion}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                    >
                        {payload
                            ? <PreviewBody payload={payload} t={t} />
                            : <div className={styles["preview-empty"]}>{t("preview.waiting")}</div>}
                    </m.div>
                </AnimatePresence>
            </div>
        </div>
    );
}
