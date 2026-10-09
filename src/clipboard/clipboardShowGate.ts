// One deferred keyboard intent per capture/search synchronization. Never replay
// it after hide, explicit navigation/editing, or failed synchronization.
export function createClipboardShowGate(onError: (error: unknown) => void) {
    let generation = 0;
    let pending = false;
    let needsSync = true;
    let failed = false;
    let deferred: (() => void) | undefined;
    let navigation: Array<() => void> = [];
    return {
        get pending() { return pending; },
        get failed() { return failed; },
        get needsSync() { return needsSync; },
        start(work: (isCurrent: () => boolean) => Promise<void>) {
            const current = ++generation;
            pending = true;
            needsSync = false;
            failed = false;
            deferred = undefined;
            navigation = [];
            void work(() => current === generation).then(() => {
                if (current !== generation) return;
                pending = false;
                const queuedNavigation = navigation;
                navigation = [];
                const action = deferred;
                deferred = undefined;
                queuedNavigation.forEach(navigate => navigate());
                action?.();
            }).catch(error => {
                if (current !== generation) return;
                pending = false;
                failed = true;
                deferred = undefined;
                const queuedNavigation = navigation;
                navigation = [];
                queuedNavigation.forEach(navigate => navigate());
                onError(error);
            });
        },
        defer(action: () => void) {
            if (failed) return true;
            if (!pending) return false;
            deferred ??= action;
            return true;
        },
        queueNavigation(action: () => void) {
            if (!pending) return false;
            deferred = undefined;
            navigation.push(action);
            return true;
        },
        discardIntents() {
            deferred = undefined;
            navigation = [];
            if (!pending) needsSync = true;
        },
        cancel(requireSync = false) {
            generation += 1;
            pending = false;
            needsSync = requireSync;
            failed = false;
            deferred = undefined;
            navigation = [];
        },
    };
}
