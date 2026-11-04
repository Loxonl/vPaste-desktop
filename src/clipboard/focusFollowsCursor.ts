/** Minimum gap between focus requests while the pointer keeps moving. */
const FOCUS_REQUEST_INTERVAL_MS = 120;

export interface FocusFollowsCursorOptions {
    /** Asks the backend to focus this window if the cursor is inside it. */
    request: () => Promise<unknown>;
    hasFocus?: () => boolean;
    now?: () => number;
    onError?: (cause: unknown) => void;
}

/**
 * Returns a pointer-move handler that lets keyboard focus follow the cursor
 * between the clipboard window and a Space preview. The backend decides
 * whether focus may move; this only avoids flooding it with requests.
 */
export function createFocusFollowsCursor({
    request,
    hasFocus = () => document.hasFocus(),
    now = () => Date.now(),
    onError = () => undefined,
}: FocusFollowsCursorOptions) {
    let inFlight = false;
    let lastRequestAt = Number.NEGATIVE_INFINITY;
    return () => {
        if (inFlight || hasFocus()) return;
        const time = now();
        if (time - lastRequestAt < FOCUS_REQUEST_INTERVAL_MS) return;
        lastRequestAt = time;
        inFlight = true;
        request()
            .catch(onError)
            .finally(() => { inFlight = false; });
    };
}
