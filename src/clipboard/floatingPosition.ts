export const CONTEXT_MENU_WIDTH = 188;
export const CONTEXT_SUBMENU_WIDTH = 312;
export const TAB_CONTEXT_MENU_WIDTH = 126;
export const CONTEXT_MENU_PADDING = 5;
export const CONTEXT_MENU_ROW_HEIGHT = 34;
export const CONTEXT_MENU_GAP = 6;
export const VIEWPORT_MARGIN = 8;

export type ViewportMetrics = {
    width: number;
    height: number;
};

export type ScreenMetrics = {
    screenX: number;
    screenY: number;
    availLeft: number;
    availTop: number;
    availWidth: number;
    availHeight: number;
};

function currentViewportMetrics(): ViewportMetrics {
    return {
        width: window.innerWidth,
        height: window.innerHeight,
    };
}

function currentScreenMetrics(): ScreenMetrics {
    const screenBounds = window.screen as Screen & { availLeft?: number; availTop?: number };
    return {
        screenX: window.screenX,
        screenY: window.screenY,
        availLeft: screenBounds.availLeft ?? 0,
        availTop: screenBounds.availTop ?? 0,
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight,
    };
}

export function clampToViewport(value: number, size: number, viewportSize: number): number {
    return Math.max(VIEWPORT_MARGIN, Math.min(value, viewportSize - size - VIEWPORT_MARGIN));
}

export function contextMenuHeight(rowCount: number): number {
    return CONTEXT_MENU_PADDING * 2 + Math.max(1, rowCount) * CONTEXT_MENU_ROW_HEIGHT;
}

export function floatingPositionFromClick(
    clientX: number,
    clientY: number,
    width: number,
    height: number,
    viewport: ViewportMetrics = currentViewportMetrics(),
) {
    return {
        x: clampToViewport(clientX + CONTEXT_MENU_GAP, width, viewport.width),
        y: clampToViewport(clientY - height - CONTEXT_MENU_GAP, height, viewport.height),
    };
}

export function clampToScreen(
    value: number,
    size: number,
    min: number,
    maxSize: number,
): number {
    return Math.max(min + VIEWPORT_MARGIN, Math.min(value, min + maxSize - size - VIEWPORT_MARGIN));
}

export function screenFloatingPositionFromClick(
    clientX: number,
    clientY: number,
    width: number,
    height: number,
    metrics: ScreenMetrics = currentScreenMetrics(),
) {
    return {
        x: clampToScreen(metrics.screenX + clientX + CONTEXT_MENU_GAP, width, metrics.availLeft, metrics.availWidth),
        y: clampToScreen(metrics.screenY + clientY - height - CONTEXT_MENU_GAP, height, metrics.availTop, metrics.availHeight),
    };
}

export function screenAnchoredPositionFromClick(
    clientX: number,
    clientY: number,
    width: number,
    height: number,
    metrics: ScreenMetrics = currentScreenMetrics(),
) {
    return {
        x: clampToScreen(metrics.screenX + clientX + CONTEXT_MENU_GAP, width, metrics.availLeft, metrics.availWidth),
        y: clampToScreen(metrics.screenY + clientY - height, height, metrics.availTop, metrics.availHeight),
    };
}

export function screenFloatingPositionFromAnchor(
    anchor: HTMLElement | null | undefined,
    width: number,
    height: number,
) {
    const rect = anchor?.getBoundingClientRect();
    if (!rect) {
        return screenFloatingPositionFromClick(
            window.innerWidth - width - VIEWPORT_MARGIN,
            VIEWPORT_MARGIN,
            width,
            height,
        );
    }
    return screenAnchoredPositionFromClick(rect.right, rect.bottom, width, height);
}
