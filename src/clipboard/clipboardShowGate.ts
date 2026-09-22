// One deferred keyboard intent per window opening. Never replay it after hide,
// explicit navigation, a newer opening, or failed capture/list synchronization.
export function createClipboardShowGate(onError: (error: unknown) => void) {
    let generation = 0;
    let pending = false;
    let needsSync = true;
    let failed = false;
    let deferred: (() => void) | undefined;
    return {
        get pending() { return pending; },
        get needsSync() { return needsSync; },
        start(work: (isCurrent: () => boolean) => Promise<void>) {
            const current = ++generation;
            pending = true;
            needsSync = false;
            failed = false;
            deferred = undefined;
            void work(() => current === generation).then(() => {
                if (current !== generation) return;
                pending = false;
                const action = deferred;
                deferred = undefined;
                action?.();
            }).catch(error => {
                if (current !== generation) return;
                pending = false;
                failed = true;
                deferred = undefined;
                onError(error);
            });
        },
        defer(action: () => void) {
            if (failed) return true;
            if (!pending) return false;
            deferred ??= action;
            return true;
        },
        cancel(requireSync = false) {
            generation += 1;
            pending = false;
            needsSync = requireSync;
            failed = false;
            deferred = undefined;
        },
    };
}
