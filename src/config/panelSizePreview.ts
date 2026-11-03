import type { SettingsBridge } from "./SettingsBridge";

export const PANEL_SIZES = ["small", "medium", "large"] as const;
export type PanelSize = typeof PANEL_SIZES[number];
export type PanelSizePreference = PanelSize | null;
export interface PanelSizeState {
    preference: PanelSizePreference;
    recommended: PanelSize;
    effective: PanelSize;
    display: {
        pixel_width: number;
        pixel_height: number;
        scale_factor: number;
        logical_width: number;
        logical_height: number;
        work_width: number;
        work_height: number;
    } | null;
}
export const panelSizePercent = (size: PanelSize) => 80 + PANEL_SIZES.indexOf(size) * 10;

export function isPanelSize(value: unknown): value is PanelSize {
    return PANEL_SIZES.some(size => size === value);
}

export function isPanelSizeState(value: unknown): value is PanelSizeState {
    if (!value || typeof value !== "object") return false;
    const state = value as Partial<PanelSizeState>;
    return (state.preference === null || isPanelSize(state.preference))
        && isPanelSize(state.recommended) && isPanelSize(state.effective);
}

/** One gesture owns one native session. Finishing closes its pending updates. */
export function createPanelSizePreview(
    bridge: Pick<SettingsBridge, "invoke">,
    initial: PanelSize,
    onError: (cause: unknown) => void,
) {
    let desired = initial;
    let applied = initial;
    let closed = false;
    let failed = false;
    let finishing: Promise<PanelSizeState | undefined> | undefined;
    const session = bridge.invoke<number>("begin_clipboard_size_preview", { size: initial });
    const fail = (cause: unknown) => {
        failed = true;
        if (!closed) onError(cause);
    };
    let pending = session.then(() => undefined).catch(fail);
    return {
        update(size: PanelSize) {
            if (closed || failed) return;
            desired = size;
            pending = pending.then(async () => {
                if (closed || failed || desired === applied) return;
                const size = desired;
                const sessionId = await session;
                if (closed) return;
                await bridge.invoke("update_clipboard_size_preview", { sessionId, size });
                applied = size;
            }).catch(fail);
        },
        finish(commit: boolean): Promise<PanelSizeState | undefined> {
            if (finishing) return finishing;
            closed = true;
            finishing = pending.then(async () => {
                const sessionId = await session.catch(() => undefined);
                if (sessionId === undefined) return undefined;
                const result = await bridge.invoke<PanelSizeState>("finish_clipboard_size_preview", {
                    sessionId, size: commit && !failed ? desired : null,
                });
                if (!isPanelSizeState(result)) throw new Error("Invalid panel size preview result");
                return result;
            });
            return finishing;
        },
    };
}
