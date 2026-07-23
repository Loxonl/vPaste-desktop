import { error, info } from "@tauri-apps/plugin-log";

type DiagnosticDetails = Record<string, unknown>;

let snapshotSequence = 0;

function serializeReason(reason: unknown): string {
    if (reason instanceof Error) {
        return `${reason.name}: ${reason.message}\n${reason.stack || ""}`.trim();
    }
    if (typeof reason === "string") return reason;
    try {
        return JSON.stringify(reason);
    } catch {
        return String(reason);
    }
}

export function logRendererSnapshot(reason: string, details: DiagnosticDetails = {}) {
    const root = document.getElementById("root");
    const clipboard = document.querySelector<HTMLElement>(".clipboard-container");
    const clipboardHeader = document.querySelector<HTMLElement>(".clipboard-header");
    const cardsGrid = document.querySelector<HTMLElement>(".cards-grid");
    const target = clipboard || root;
    const rect = target?.getBoundingClientRect();
    const headerRect = clipboardHeader?.getBoundingClientRect();
    const style = target ? window.getComputedStyle(target) : null;
    const headerStyle = clipboardHeader ? window.getComputedStyle(clipboardHeader) : null;
    const snapshot = {
        sequence: ++snapshotSequence,
        reason,
        path: window.location.pathname,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        documentFocused: document.hasFocus(),
        rootChildren: root?.childElementCount ?? -1,
        rootHtmlLength: root?.innerHTML.length ?? -1,
        clipboardPresent: Boolean(clipboard),
        clipboardClass: clipboard?.className || "missing",
        headerPresent: Boolean(clipboardHeader),
        headerWidth: headerRect ? Math.round(headerRect.width) : -1,
        headerHeight: headerRect ? Math.round(headerRect.height) : -1,
        headerDisplay: headerStyle?.display || "missing",
        headerVisibility: headerStyle?.visibility || "missing",
        headerOpacity: headerStyle?.opacity || "missing",
        cardsGridPresent: Boolean(cardsGrid),
        cardsCount: cardsGrid?.childElementCount ?? -1,
        width: rect ? Math.round(rect.width) : -1,
        height: rect ? Math.round(rect.height) : -1,
        display: style?.display || "missing",
        visibility: style?.visibility || "missing",
        opacity: style?.opacity || "missing",
        bodyBackground: window.getComputedStyle(document.body).backgroundColor,
        ...details,
    };
    const looksBlank = window.location.pathname === "/clipboard"
        && (
            !root
            || root.childElementCount === 0
            || !clipboard
            || !rect
            || rect.width < 1
            || rect.height < 1
            || !clipboardHeader
            || !headerRect
            || headerRect.width < 1
            || headerRect.height < 1
            || headerStyle?.display === "none"
            || headerStyle?.visibility === "hidden"
            || headerStyle?.opacity === "0"
        );
    const message = `[renderer-diagnostic] ${JSON.stringify({ ...snapshot, looksBlank })}`;
    if (looksBlank) {
        void error(message);
    } else {
        void info(message);
    }
}

export function installRendererDiagnostics() {
    window.addEventListener("error", event => {
        void error(`[renderer-error] ${JSON.stringify({
            path: window.location.pathname,
            message: event.message,
            filename: event.filename,
            line: event.lineno,
            column: event.colno,
            error: serializeReason(event.error),
        })}`);
        logRendererSnapshot("window-error");
    });
    window.addEventListener("unhandledrejection", event => {
        void error(`[renderer-unhandled-rejection] ${JSON.stringify({
            path: window.location.pathname,
            reason: serializeReason(event.reason),
        })}`);
        logRendererSnapshot("unhandled-rejection");
    });
    window.addEventListener("pageshow", event => {
        logRendererSnapshot("page-show", { persisted: event.persisted });
    });
    window.addEventListener("pagehide", event => {
        logRendererSnapshot("page-hide", { persisted: event.persisted });
    });
    document.addEventListener("visibilitychange", () => {
        logRendererSnapshot("visibility-change");
    });
}
