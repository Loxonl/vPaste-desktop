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

export interface UpdateState {
    status: UpdateStatus;
    currentVersion: string;
    availableVersion?: string | null;
    date?: string | null;
    body?: string | null;
    downloadedBytes: number;
    totalBytes?: number | null;
    error?: string | null;
    portable: boolean;
    feedEnabled: boolean;
    releaseUrl: string;
}

const INITIAL_STATE: UpdateState = {
    status: "disabled",
    currentVersion: "",
    availableVersion: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    portable: false,
    feedEnabled: false,
    releaseUrl: "https://github.com/Loxonl/vPaste-desktop/releases",
};

export interface UpdateBridge {
    invoke: typeof invoke;
    listen: typeof listen;
}

const tauriUpdateBridge: UpdateBridge = { invoke, listen };

export function useAppUpdateState(bridge: UpdateBridge = tauriUpdateBridge) {
    const [state, setState] = React.useState<UpdateState>(INITIAL_STATE);

    React.useEffect(() => {
        void bridge.invoke<UpdateState>("get_update_state")
            .then(setState)
            .catch(reason => error(`Failed to load update state: ${reason}`));
        const unlisten = bridge.listen<UpdateState>("app-update-state-changed", event => {
            setState(event.payload);
        });
        return () => {
            unlisten.then(stop => stop()).catch(reason => error(`Failed to unlisten update state: ${reason}`));
        };
    }, [bridge]);

    const check = React.useCallback(async () => {
        const next = await bridge.invoke<UpdateState>("check_for_app_update");
        setState(next);
        return next;
    }, [bridge]);

    const prepare = React.useCallback(async () => {
        const next = await bridge.invoke<UpdateState>("prepare_app_update");
        setState(next);
        return next;
    }, [bridge]);

    const restartToUpdate = React.useCallback(async () => {
        await bridge.invoke("restart_and_install_app_update");
    }, [bridge]);

    return { state, check, prepare, restartToUpdate };
}

export function restartReady(state: UpdateState): boolean {
    return state.status === "ready" && !state.portable;
}
