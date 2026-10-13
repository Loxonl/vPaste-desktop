import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";

export type UpdateStatus =
    | "disabled"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "manualDownload"
    | "failed";

export type UpdateErrorStage = "check" | "download" | "restore" | "install";

export interface UpdateState {
    /** Monotonic backend counter; a lower value is an older snapshot. */
    revision?: number;
    status: UpdateStatus;
    currentVersion: string;
    availableVersion?: string | null;
    date?: string | null;
    body?: string | null;
    downloadedBytes: number;
    totalBytes?: number | null;
    error?: string | null;
    errorStage?: UpdateErrorStage | null;
    portable: boolean;
    feedEnabled: boolean;
    releaseUrl: string;
}

const INITIAL_STATE: UpdateState = {
    revision: -1,
    status: "disabled",
    currentVersion: "",
    availableVersion: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    errorStage: null,
    portable: false,
    feedEnabled: false,
    releaseUrl: "https://github.com/Loxonl/vPaste-desktop/releases",
};

export interface UpdateBridge {
    invoke: typeof invoke;
    listen: typeof listen;
}

const tauriUpdateBridge: UpdateBridge = { invoke, listen };

/**
 * Keeps the newest backend snapshot. Command results, the initial snapshot and
 * pushed events can arrive in any order, so an older revision never replaces
 * a newer one (for example a late "available" after "ready").
 */
export function newerUpdateState(current: UpdateState, next: UpdateState): UpdateState {
    const currentRevision = current.revision ?? -1;
    const nextRevision = next.revision ?? currentRevision;
    return nextRevision >= currentRevision ? next : current;
}

export function useAppUpdateState(bridge: UpdateBridge = tauriUpdateBridge) {
    const [state, setState] = React.useState<UpdateState>(INITIAL_STATE);
    const apply = React.useCallback((next: UpdateState) => {
        setState(current => newerUpdateState(current, next));
    }, []);

    React.useEffect(() => {
        let active = true;
        // Subscribe before reading the snapshot so no event between the two is
        // missed; revisions resolve whichever arrives last.
        const unlisten = bridge.listen<UpdateState>("app-update-state-changed", event => {
            if (active) apply(event.payload);
        });
        void bridge.invoke<UpdateState>("get_update_state")
            .then(next => {
                if (active) apply(next);
            })
            .catch(reason => error(`Failed to load update state: ${reason}`));
        return () => {
            active = false;
            unlisten.then(stop => stop()).catch(reason => error(`Failed to unlisten update state: ${reason}`));
        };
    }, [bridge, apply]);

    const check = React.useCallback(async () => {
        const next = await bridge.invoke<UpdateState>("check_for_app_update");
        apply(next);
        return next;
    }, [bridge, apply]);

    const prepare = React.useCallback(async () => {
        const next = await bridge.invoke<UpdateState>("prepare_app_update");
        apply(next);
        return next;
    }, [bridge, apply]);

    const restartToUpdate = React.useCallback(async () => {
        await bridge.invoke("restart_and_install_app_update");
    }, [bridge]);

    return { state, check, prepare, restartToUpdate };
}

export function restartReady(state: UpdateState): boolean {
    return state.status === "ready" && !state.portable;
}

/** The main panel entry stays visible (disabled) while the install starts. */
export function updateEntryVisible(state: UpdateState): boolean {
    return !state.portable && (state.status === "ready" || state.status === "installing");
}
