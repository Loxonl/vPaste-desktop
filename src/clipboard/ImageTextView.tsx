import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { Button, TextField } from "@mui/material";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { OperationStatus } from "../ui/OperationStatus";
import type { TFunction } from "../config/settingsTypes";
import styles from "./ImageTextView.module.css";

type OcrRecord = {
    status: "unrecognized" | "pending" | "running" | "complete" | "empty" | "failed";
    text: string;
    error: "language_unavailable" | "unsupported" | "resource_limit" | "timeout" | "failed" | null;
};

export default function ImageTextView({ hash, imagePath, t, onClose, active = true }: {
    hash: string;
    imagePath: string;
    t: TFunction;
    onClose: () => void;
    active?: boolean;
}) {
    const closeButton = useRef<HTMLButtonElement>(null);
    const [record, setRecord] = useState<OcrRecord | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [copying, setCopying] = useState(false);
    const [copyFailed, setCopyFailed] = useState(false);
    const [text, setText] = useState("");
    const edited = useRef(false);
    const [imageSrc, setImageSrc] = useState("");
    const [imageError, setImageError] = useState(false);
    const generation = useRef(0);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        setImageSrc("");
        setImageError(false);
        if (!imagePath) return;
        void invoke<{ assetPath: string }>("resolve_history_media", { path: imagePath, intent: "preview" })
            .then(resource => {
                if (cancelled) return;
                if (resource.assetPath) setImageSrc(convertFileSrc(resource.assetPath));
                else setImageError(true);
            })
            .catch(() => { if (!cancelled) setImageError(true); });
        return () => { cancelled = true; };
    }, [imagePath, active]);

    useEffect(() => {
        if (!active) return;
        const current = ++generation.current;
        let timer: ReturnType<typeof setTimeout> | undefined;
        setLoading(true);
        setRecord(null);
        setLoadError(null);
        setCopying(false);
        setCopyFailed(false);
        setText("");
        edited.current = false;
        const load = async (first: boolean) => {
            try {
                const result = await (first
                    ? invoke<OcrRecord>("recognize_image_text", { hash, force: false })
                    : invoke<OcrRecord>("get_image_ocr", { hash }));
                if (current !== generation.current) return;
                setRecord(result);
                if (!edited.current) setText(result.text);
                setLoading(false);
                if (result.status === "pending" || result.status === "running") {
                    timer = setTimeout(() => { void load(false); }, 500);
                }
            } catch (error) {
                if (current !== generation.current) return;
                setLoading(false);
                setLoadError(String(error) === "image_missing" ? "ocr.imageMissing" : "ocr.failed");
            }
        };
        void load(true);
        return () => { ++generation.current; clearTimeout(timer); };
    }, [hash, active]);

    const copyText = async (content: string) => {
        await invoke("copy", { item: content, itemType: "Text", hash: null });
        // Native writes are excluded from automatic capture. Record explicit
        // user copies as new history.
        await invoke("record_text_history", { content });
        await emitTo("clipboard", "listen_new_clipboard", "");
    };
    const copyAll = async () => {
        if (!text || copying) return;
        closeButton.current?.focus();
        const current = generation.current;
        setCopying(true);
        setCopyFailed(false);
        try {
            await copyText(text);
        } catch {
            if (current === generation.current) setCopyFailed(true);
        } finally {
            if (current === generation.current) setCopying(false);
        }
    };
    const copySelection = (event: ClipboardEvent) => {
        const field = event.target;
        if (!(field instanceof HTMLTextAreaElement)) return;
        const selected = field.value.slice(field.selectionStart, field.selectionEnd);
        if (!selected) return;
        // Keep WebView from publishing its own clipboard payload and source.
        event.preventDefault();
        const current = generation.current;
        setCopyFailed(false);
        void copyText(selected).catch(() => {
            if (current === generation.current) setCopyFailed(true);
        });
    };
    const busy = loading || record?.status === "pending" || record?.status === "running";
    const message = loadError ?? (busy ? "ocr.recognizing"
        : record?.error ? `ocr.${record.error}`
        : record?.status === "empty" ? "ocr.empty" : null);

    return (
        <section className={styles.root} role="dialog" aria-label={t("ocr.title")} data-keyboard-passthrough="dialog">
            <div className={styles.imagePane}>
                {imageSrc && !imageError ? (
                    <img className={styles.image} src={imageSrc} alt={t("type.image")} draggable={false} onError={() => setImageError(true)} />
                ) : (
                    <OperationStatus message={t(imageError ? "ocr.imageMissing" : "type.image")} busy={Boolean(imagePath) && !imageError} />
                )}
            </div>
            <div className={styles.textPane}>
                <div className={styles.body}>
                    {record && (
                        <TextField
                            autoFocus
                            fullWidth
                            multiline
                            label={t("ocr.title")}
                            InputLabelProps={{ shrink: true }}
                            className={styles.field}
                            value={text}
                            onChange={event => { edited.current = true; setText(event.target.value); }}
                            onCopy={copySelection}
                            InputProps={{ inputComponent: "textarea", className: styles.input }}
                            inputProps={{ spellCheck: false, className: styles.text }}
                        />
                    )}
                    {message && <OperationStatus message={t(message)} busy={busy} tone={loadError || record?.error ? "error" : "neutral"} />}
                    {copyFailed && <OperationStatus message={t("ocr.copyFailed")} tone="error" />}
                </div>
                <div className={styles.actions}>
                    <Button className={styles.action} variant="text" color="inherit" disabled={!text || copying} onClick={() => { void copyAll(); }}>
                        <ContentCopyOutlinedIcon fontSize="small" />
                        {t("ocr.copy")}
                    </Button>
                    <Button ref={closeButton} className={styles.action} variant="text" color="inherit" onClick={onClose}>
                        <CloseIcon fontSize="small" />
                        {t("common.close")}
                    </Button>
                </div>
            </div>
        </section>
    );
}
