import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { Button, TextField } from "@mui/material";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { OperationStatus } from "../ui/OperationStatus";
import type { TFunction } from "../config/settingsTypes";
import styles from "./ImageTextView.module.css";

type OcrRecord = {
    status: "unrecognized" | "pending" | "running" | "complete" | "empty" | "failed";
    text: string;
    error: "language_unavailable" | "unsupported" | "resource_limit" | "timeout" | "failed" | null;
};

export default function ImageTextView({ hash, t, onClose, active = true }: {
    hash: string;
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
    const generation = useRef(0);

    useEffect(() => {
        if (!active) return;
        const current = ++generation.current;
        let timer: ReturnType<typeof setTimeout> | undefined;
        setLoading(true);
        setRecord(null);
        setLoadError(null);
        setCopying(false);
        setCopyFailed(false);
        const load = async (first: boolean) => {
            try {
                const result = await (first
                    ? invoke<OcrRecord>("recognize_image_text", { hash, force: false })
                    : invoke<OcrRecord>("get_image_ocr", { hash }));
                if (current !== generation.current) return;
                setRecord(result);
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
        if (!record?.text || copying) return;
        closeButton.current?.focus();
        const current = generation.current;
        setCopying(true);
        setCopyFailed(false);
        try {
            await copyText(record.text);
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
            <div className={styles.body}>
                {record?.text && (
                    <TextField
                        autoFocus
                        fullWidth
                        multiline
                        label={t("ocr.title")}
                        InputLabelProps={{ shrink: true }}
                        className={styles.field}
                        value={record.text}
                        onCopy={copySelection}
                        InputProps={{ readOnly: true, inputComponent: "textarea", className: styles.input }}
                        inputProps={{ spellCheck: false, className: styles.text }}
                    />
                )}
                {message && <OperationStatus message={t(message)} busy={busy} tone={loadError || record?.error ? "error" : "neutral"} />}
                {copyFailed && <OperationStatus message={t("ocr.copyFailed")} tone="error" />}
            </div>
            <div className={styles.actions}>
                <Button variant="outlined" disabled={!record?.text || copying} onClick={() => { void copyAll(); }}>{t("ocr.copy")}</Button>
                <Button ref={closeButton} variant="contained" onClick={onClose}>{t("common.close")}</Button>
            </div>
        </section>
    );
}
