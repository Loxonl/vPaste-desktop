import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";

// A newly created native window must not receive its opening payload until its
// React page has registered the listeners that consume it.
export function notifyAuxiliaryWindowReady(
    listeners: Promise<unknown>[] = [],
    notify: () => Promise<unknown> = () => "__TAURI_INTERNALS__" in window
        ? invoke("auxiliary_window_ready")
        : Promise.resolve(),
): () => void {
    let disposed = false;
    void Promise.all(listeners)
        .then(() => {
            if (!disposed) return notify();
        })
        .catch(reason => error(`Failed to prepare auxiliary window: ${reason}`));
    return () => { disposed = true; };
}
