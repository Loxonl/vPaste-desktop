import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import { ItemType } from "./Item";
import { FileTypePresentation } from "./FileTypePresentation";
import { isImagePath, type FilePreviewInfo } from "./itemPresentation";
import { useLanguage } from "../lang";
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
    parsed.querySelectorAll("meta[http-equiv]").forEach(node => {
        if (node.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
            node.remove();
        }
    });
    parsed.querySelectorAll("base").forEach(node => node.removeAttribute("target"));
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
            if (name === "width" && value.endsWith("px") && Number.parseFloat(value) > 720) return false;
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

function isEmptyLeadingRichBlock(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (!["p", "div", "span"].includes(tag)) return false;
    if (element.querySelector("img,svg,table,canvas,video")) return false;
    return (element.textContent || "").replace(/\u00a0/g, "").trim().length === 0;
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

function sanitizeRichHtml(html: string): string {
    if (!html.trim()) return "";
    const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    parsed.querySelectorAll("script, iframe, object, embed, link, meta, base").forEach(node => node.remove());
    parsed.querySelectorAll("style").forEach(node => {
        node.textContent = (node.textContent || "")
            .replace(/mso-pattern\s*:[^;{}]+;?/gi, "");
    });
    parsed.querySelectorAll("form").forEach(node => {
        node.replaceWith(...Array.from(node.childNodes));
    });
    parsed.querySelectorAll<HTMLElement>("*").forEach(element => {
        Array.from(element.attributes).forEach(attribute => {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim().toLowerCase();
            const tag = element.tagName.toLowerCase();
            if (name.startsWith("on") || name === "srcdoc" || value.startsWith("javascript:")) {
                element.removeAttribute(attribute.name);
            }
            if (
                (["a", "area"].includes(tag) && ["href", "xlink:href", "target", "download", "ping"].includes(name))
                || name === "formaction"
            ) {
                element.removeAttribute(attribute.name);
            }
            if (name === "style" && /url\s*\(/i.test(attribute.value)) {
                element.removeAttribute(attribute.name);
            }
        });
        normalizeRichPreviewStyle(element);
    });
    const root = parsed.body.firstElementChild;
    if (root) {
        unwrapSingleLeadingLayoutContainers(root);
        trimLeadingEmptyRichBlocks(root);
    }
    return parsed.body.firstElementChild?.innerHTML || "";
}

function richHtmlHasVisibleContent(html: string): boolean {
    if (!html.trim()) return false;
    const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = parsed.body.firstElementChild;
    if (!root) return false;
    const cloned = root.cloneNode(true) as HTMLElement;
    cloned.querySelectorAll("style").forEach(node => node.remove());
    return Boolean(cloned.textContent?.trim())
        || Boolean(cloned.querySelector("table,img,svg,canvas,video"));
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
    const richHtml = useMemo(() => sanitizeRichHtml(payloadRichHtml(payload)), [payload]);
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
                        referrerPolicy="no-referrer-when-downgrade"
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
    const [payload, setPayload] = useState<PreviewPayload | null>(null);
    const [pinned, setPinned] = useState(false);
    const openedAtRef = useRef(0);
    const pinnedRef = useRef(false);

    useEffect(() => {
        const unlisten = listen<PreviewPayload>("preview-item", event => {
            openedAtRef.current = Date.now();
            pinnedRef.current = false;
            setPinned(false);
            setPayload(event.payload);
        });
        const unlistenClear = listen("preview-clear", () => {
            setPayload(null);
        });
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "Tab") {
                event.preventDefault();
                const direction = event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
                void emitTo("clipboard", "preview-navigate-selection", { direction, key: event.key })
                    .catch(e => error(`Failed to navigate preview selection: ${e}`));
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
            <button
                type="button"
                className={[styles["preview-pin"], pinned ? styles.pinned : ""].join(" ")}
                title={pinned ? t("preview.unpin") : t("preview.pin")}
                aria-label={pinned ? t("preview.unpin") : t("preview.pin")}
                onClick={togglePinned}
            >
                {pinned ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
            </button>
            <div className={styles["preview-content"]}>
                {payload ? <PreviewBody payload={payload} t={t} /> : <div className={styles["preview-empty"]}>{t("preview.waiting")}</div>}
            </div>
        </div>
    );
}
