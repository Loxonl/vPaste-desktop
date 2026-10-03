import { invoke } from "@tauri-apps/api/core";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";

/** Reuse the rendered item preview without its selection or drag feedback. */
export function createClipboardDragPreview(card: HTMLElement): HTMLDivElement {
    const preview = document.createElement("div");
    preview.className = styles["clipboard-drag-preview"];
    preview.setAttribute("aria-hidden", "true");
    preview.inert = true;

    const snapshot = card.cloneNode(true) as HTMLElement;
    snapshot.className = classes(styles, "clipboard-card clipboard-drag-preview-card");
    for (const attribute of ["id", "tabindex", "draggable", "data-hash", "data-external-dragging"]) {
        snapshot.removeAttribute(attribute);
    }
    snapshot.querySelectorAll(
        `.${styles["alt-card-hint"]}, .${styles["external-drag-success"]}, .${styles["queue-selection-indicator"]}`,
    ).forEach(element => element.remove());
    preview.appendChild(snapshot);
    return preview;
}

/** Snapshot the same miniature used by browser drags before starting an AppKit session. */
export async function captureNativeClipboardDragPreview(card: HTMLElement, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    const preview = createClipboardDragPreview(card);
    const removePreview = () => preview.remove();
    signal?.addEventListener("abort", removePreview, { once: true });
    preview.dataset.nativeDragPreview = "true";
    document.body.appendChild(preview);
    const bounds = preview.getBoundingClientRect();
    const source = card.getBoundingClientRect();
    preview.style.left = `${Math.round(Math.min(Math.max(source.left, 0), Math.max(0, window.innerWidth - bounds.width)))}px`;
    preview.style.top = `${Math.round(Math.min(Math.max(source.top, 0), Math.max(0, window.innerHeight - bounds.height)))}px`;
    try {
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
        signal?.throwIfAborted();
        const rect = preview.getBoundingClientRect();
        const cornerRadius = Number.parseFloat(window.getComputedStyle(preview).borderTopLeftRadius) || 0;
        const png = await invoke<number[]>("capture_native_drag_preview", {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, cornerRadius },
        });
        signal?.throwIfAborted();
        return png;
    } finally {
        signal?.removeEventListener("abort", removePreview);
        preview.remove();
    }
}
