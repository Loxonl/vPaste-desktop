export const WHEEL_LINE_DELTA_PX = 40;
export const WHEEL_MOUSE_TIME_CONSTANT_MS = 60;
export const WHEEL_PRECISION_TIME_CONSTANT_MS = 24;
export const WHEEL_SCROLL_IDLE_MS = 100;
export const WHEEL_SCROLL_STOP_EPSILON_PX = 0.35;
export const WHEEL_SCROLL_MAX_FRAME_MS = 34;

export type QuickInputAction =
    | { kind: "tab"; tabId: "all" | "favorite" }
    | { kind: "item"; index: number };

export type PointerDragIntent = "pending" | "vertical" | "horizontal";

function normalizeShortcutKey(key: string): string {
    const normalized = key.toLowerCase();
    if (normalized === "control") return "ctrl";
    if (normalized === "cmd" || normalized === "command" || normalized === "meta") return "meta";
    if (normalized === "return") return "enter";
    if (normalized === "escape") return "esc";
    return normalized;
}

export function matchesKeyboardShortcut(
    event: KeyboardEvent,
    shortcut?: string | null,
): boolean {
    const parts = (shortcut || "")
        .split("+")
        .map(part => normalizeShortcutKey(part.trim()))
        .filter(Boolean);
    if (parts.length === 0) return false;

    const key = normalizeShortcutKey(event.key);
    const expectedKey = parts[parts.length - 1];
    const modifiers = new Set(parts.slice(0, -1));
    return key === expectedKey
        && event.ctrlKey === modifiers.has("ctrl")
        && event.metaKey === modifiers.has("meta")
        && event.altKey === modifiers.has("alt")
        && event.shiftKey === modifiers.has("shift");
}

export function isTextInputTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
}

export function quickInputAction(
    event: KeyboardEvent,
    isMac: boolean,
): QuickInputAction | null {
    if (isMac) {
        if (event.code === "KeyA") return { kind: "tab", tabId: "all" };
        if (event.code === "KeyF") return { kind: "tab", tabId: "favorite" };

        const digitCode = /^Digit([1-9])$/.exec(event.code);
        if (digitCode) return { kind: "item", index: Number(digitCode[1]) - 1 };

        return null;
    }

    const key = event.key.toLowerCase();
    if (key === "a") return { kind: "tab", tabId: "all" };
    if (key === "f") return { kind: "tab", tabId: "favorite" };
    if (/^[1-9]$/.test(key)) return { kind: "item", index: Number(key) - 1 };

    return null;
}

export function normalizeWheelDelta(
    event: WheelEvent,
    pageSize: number,
): { delta: number; rawDelta: number } {
    const rawDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX;
    const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_DELTA_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(1, pageSize)
            : 1;
    return { delta: rawDelta * multiplier, rawDelta };
}

export function nextWheelScrollTarget(
    target: number,
    scrollLeft: number,
    scrollAmount: number,
    maxScroll: number,
): number {
    const remaining = target - scrollLeft;
    const baseTarget = remaining !== 0 && Math.sign(remaining) !== Math.sign(scrollAmount)
        ? scrollLeft
        : target;
    return Math.max(0, Math.min(maxScroll, baseTarget + scrollAmount));
}

export function wheelTimeConstant(
    rawDelta: number,
    deltaMode: number,
    eventInterval: number,
): number {
    const precisionInput = deltaMode === WheelEvent.DOM_DELTA_PIXEL && (
        Math.abs(rawDelta) < 50
        || !Number.isInteger(rawDelta)
        || (eventInterval > 0 && eventInterval < 24 && Math.abs(rawDelta) < 100)
    );
    return precisionInput
        ? WHEEL_PRECISION_TIME_CONSTANT_MS
        : WHEEL_MOUSE_TIME_CONSTANT_MS;
}

export function wheelAnimationFrame(
    scrollLeft: number,
    target: number,
    elapsed: number,
    timeConstant: number,
): { scrollLeft: number; complete: boolean } {
    const remaining = target - scrollLeft;
    if (Math.abs(remaining) <= WHEEL_SCROLL_STOP_EPSILON_PX) {
        return { scrollLeft: target, complete: true };
    }

    const progress = 1 - Math.exp(-elapsed / timeConstant);
    return {
        scrollLeft: scrollLeft + remaining * progress,
        complete: false,
    };
}

export function pointerDragIntent(
    startX: number,
    startY: number,
    clientX: number,
    clientY: number,
): PointerDragIntent {
    const totalX = clientX - startX;
    const totalY = clientY - startY;
    if (Math.hypot(totalX, totalY) < 5) return "pending";
    return Math.abs(totalX) < Math.abs(totalY) ? "vertical" : "horizontal";
}

export function pointerDragVelocity(deltaX: number, elapsed: number): number {
    return (-deltaX / Math.max(8, elapsed)) * 16;
}

export function clampDragVelocity(velocity: number): number {
    return Math.max(-42, Math.min(42, velocity));
}
