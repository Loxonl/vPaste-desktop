import { useEffect, useRef, useState } from "react";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import CloseIcon from "@mui/icons-material/Close";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLanguage } from "../lang";
import { loadAndApplyTheme } from "../theme";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { OperationStatus } from "../ui/OperationStatus";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import { prepareRichEditorHtml, sanitizeEditorHtml, serializeRichDraft, type TextDocument } from "./textEditorContent";
import styles from "./TextEditor.module.css";
import { applyRichPreviewCanvas } from "./useRichPreviewCanvas";

const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export default function TextEditor() {
    const { t } = useLanguage();
    const [entry, setEntry] = useState<TextDocument | null>(null);
    const [draft, setDraft] = useState("");
    const [initial, setInitial] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [composing, setComposing] = useState(false);
    const [failure, setFailure] = useState("");
    const [confirmClose, setConfirmClose] = useState(false);
    const richRef = useRef<HTMLDivElement>(null);
    const plainRef = useRef<HTMLTextAreaElement>(null);
    const generation = useRef(0);
    const saveInFlight = useRef(false);
    const closeRef = useRef(() => {});
    const rich = Boolean(entry?.html);
    const dirty = draft !== initial;

    const close = async () => {
        if (saveInFlight.current) return;
        try {
            await invoke("hide_text_editor_window");
            generation.current += 1;
            setEntry(null);
            setDraft("");
            setInitial("");
            setFailure("");
            setConfirmClose(false);
        } catch (reason) { setFailure(errorMessage(reason)); }
    };
    closeRef.current = () => {
        if (saveInFlight.current) return;
        if (dirty) setConfirmClose(true);
        else void close();
    };

    useEffect(() => {
        let disposed = false;
        const load = async () => {
            const request = ++generation.current;
            setLoading(true);
            setFailure("");
            setConfirmClose(false);
            void loadAndApplyTheme();
            try {
                const document = await invoke<TextDocument | null>("get_text_editor_document");
                if (disposed || request !== generation.current) return;
                if (document) {
                    const content = document.html ? prepareRichEditorHtml(document.html) : document.text;
                    setEntry({ ...document, html: document.html ? content : "" });
                    setDraft(content);
                    setInitial(content);
                }
            } catch (reason) {
                if (!disposed && request === generation.current) setFailure(errorMessage(reason));
            } finally {
                if (!disposed && request === generation.current) setLoading(false);
            }
        };
        const unlistenOpen = listen("text-editor-open", () => { void load(); });
        const unlistenClose = listen("text-editor-close-requested", () => closeRef.current());
        void Promise.all([unlistenOpen, unlistenClose]).then(() => {
            if (!disposed) void load();
        });
        const keyDown = (event: KeyboardEvent) => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === "F2") event.preventDefault();
            if (event.key === "Escape" && !document.querySelector('[role="alertdialog"]')) {
                event.preventDefault();
                closeRef.current();
            }
        };
        window.addEventListener("keydown", keyDown);
        return () => {
            disposed = true;
            generation.current += 1;
            window.removeEventListener("keydown", keyDown);
            void unlistenOpen.then(unlisten => unlisten());
            void unlistenClose.then(unlisten => unlisten());
        };
    }, []);

    useEffect(() => {
        if (!entry) return;
        if (entry.html && richRef.current) {
            richRef.current.innerHTML = entry.html;
            applyRichPreviewCanvas(richRef.current);
            richRef.current.focus();
        } else plainRef.current?.focus();
    }, [entry]);

    const save = async () => {
        if (!entry || !dirty || composing || saveInFlight.current) return;
        saveInFlight.current = true;
        setSaving(true);
        setFailure("");
        try {
            const content = rich ? serializeRichDraft(richRef.current?.innerHTML || draft) : { text: draft, html: "", rtf: "" };
            if (!content.text.replace(/[\s\u200b\u200c\u200d\ufeff]/g, "")) { setFailure("editor.blank"); return; }
            await invoke("save_clipboard_text", { update: { id: entry.id, revision: entry.revision, ...content } });
            saveInFlight.current = false;
            await close();
        } catch (reason) { setFailure(errorMessage(reason)); }
        finally { saveInFlight.current = false; setSaving(false); }
    };

    const failureMessage = failure.startsWith("editor.")
        ? t(failure) : t("editor.failed", { error: failure });

    return (
        <div className={styles.window}>
            <section className={styles.panel} aria-labelledby="text-editor-title">
                <header className={styles.header} data-tauri-drag-region>
                    <strong id="text-editor-title" data-tauri-drag-region>{t("menu.editText")}</strong>
                    <ToolbarIconButton label={t("common.close")} size="small" disabled={saving} onClick={() => closeRef.current()}><CloseIcon /></ToolbarIconButton>
                </header>
                {rich ? <div
                    ref={richRef}
                    className={styles.rich}
                    role="textbox"
                    aria-label={t("editor.content")}
                    aria-multiline="true"
                    aria-busy={saving}
                    contentEditable={!loading && !saving}
                    suppressContentEditableWarning
                    spellCheck={false}
                    onInput={event => setDraft(event.currentTarget.innerHTML)}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={event => { setComposing(false); setDraft(event.currentTarget.innerHTML); }}
                    onClick={event => { if ((event.target as Element).closest("a")) event.preventDefault(); }}
                    onDrop={event => event.preventDefault()}
                    onPaste={event => {
                        event.preventDefault();
                        const html = event.clipboardData.getData("text/html");
                        // Editing commands preserve WebView's native undo history.
                        document.execCommand(html ? "insertHTML" : "insertText", false,
                            html ? sanitizeEditorHtml(html) : event.clipboardData.getData("text/plain"));
                        setDraft(event.currentTarget.innerHTML);
                        applyRichPreviewCanvas(event.currentTarget);
                    }}
                /> : <TextField
                    className={styles.plain}
                    fullWidth multiline minRows={13} maxRows={13}
                    value={draft}
                    disabled={!entry || loading || saving}
                    inputRef={plainRef}
                    inputProps={{ "aria-label": t("editor.content"), spellCheck: false }}
                    onChange={event => setDraft(event.target.value)}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={() => setComposing(false)}
                />}
                {loading && <OperationStatus busy message={t("editor.loading")} />}
                {failure && <OperationStatus tone="error" message={failureMessage} />}
                <footer className={styles.actions}>
                    <Button disabled={saving} onClick={() => closeRef.current()}>{t("common.cancel")}</Button>
                    <Button variant="contained" disabled={!entry || !dirty || !draft.trim() || loading || saving || composing} onClick={() => { void save(); }}>{t("editor.save")}</Button>
                </footer>
            </section>
            <ConfirmDialog open={confirmClose} title={t("editor.discardTitle")} description={t("editor.discardDescription")}
                cancelLabel={t("editor.keepEditing")} confirmLabel={t("editor.discard")}
                onCancel={() => setConfirmClose(false)} onConfirm={() => { void close(); }} />
        </div>
    );
}
