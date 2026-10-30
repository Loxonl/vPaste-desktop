import { useSyncExternalStore } from "react";

const subscribers = new Set<() => void>();
let query: MediaQueryList | undefined;
let queryDpr = 0;
const dpr = () => window.devicePixelRatio || 1;

export function cardPreviewPixelWidth(): number {
    const pixels = 220 * dpr();
    return pixels <= 240 ? 240 : pixels <= 480 ? 480 : 720;
}

function changed() {
    if (dpr() !== queryDpr) bindQuery();
    subscribers.forEach(notify => notify());
}
function bindQuery() {
    query?.removeEventListener("change", changed);
    queryDpr = dpr();
    query = window.matchMedia(`(resolution: ${queryDpr}dppx)`);
    query.addEventListener("change", changed);
}
function subscribe(notify: () => void) {
    subscribers.add(notify);
    if (subscribers.size === 1) {
        bindQuery();
        window.addEventListener("resize", changed);
    }
    return () => {
        subscribers.delete(notify);
        if (subscribers.size === 0) {
            query?.removeEventListener("change", changed);
            query = undefined;
            window.removeEventListener("resize", changed);
        }
    };
}

export function useCardPreviewPixelWidth() {
    return useSyncExternalStore(subscribe, cardPreviewPixelWidth, cardPreviewPixelWidth);
}
