import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    newerUpdateState,
    storeUpdateAvailable,
    restartReady,
    updateEntryVisible,
    useAppUpdateState,
    type UpdateBridge,
    type UpdateState,
} from "../../src/update";

const readyState: UpdateState = {
    revision: 5,
    status: "ready",
    currentVersion: "1.6.0",
    availableVersion: "1.7.0",
    downloadedBytes: 42,
    totalBytes: 42,
    error: null,
    portable: false,
    feedEnabled: true,
    releaseUrl: "https://github.com/Loxonl/vPaste-desktop/releases",
};

describe("app update state", () => {
    it("only offers restart after a verified download is ready", () => {
        expect(restartReady(readyState)).toBe(true);
        expect(restartReady({ ...readyState, status: "downloading" })).toBe(false);
        expect(restartReady({ ...readyState, portable: true })).toBe(false);
    });

    it("uses the single restart-and-install backend command", async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return readyState;
            return undefined;
        });
        const bridge: UpdateBridge = {
            invoke: invoke as UpdateBridge["invoke"],
            listen: vi.fn(async () => () => undefined) as unknown as UpdateBridge["listen"],
        };
        const { result } = renderHook(() => useAppUpdateState(bridge));

        await act(async () => {
            await result.current.restartToUpdate();
        });

        expect(invoke).toHaveBeenCalledWith("restart_and_install_app_update");
    });

    it("shows the main panel entry only for an installable or installing update", () => {
        expect(updateEntryVisible(readyState)).toBe(true);
        expect(updateEntryVisible({ ...readyState, status: "installing" })).toBe(true);
        for (const status of ["available", "downloading", "checking", "failed", "idle"] as const) {
            expect(updateEntryVisible({ ...readyState, status })).toBe(false);
        }
        expect(updateEntryVisible({ ...readyState, portable: true })).toBe(false);
    });

    it("shows App Store updates as an open-store action without offering restart", async () => {
        const storeState: UpdateState = { ...readyState, source: "macAppStore", status: "available" };
        expect(storeUpdateAvailable(storeState)).toBe(true);
        expect(updateEntryVisible(storeState)).toBe(true);
        expect(restartReady(storeState)).toBe(false);
        const invoke = vi.fn(async (command: string) => command === "get_update_state" ? storeState : undefined);
        const bridge: UpdateBridge = {
            invoke: invoke as UpdateBridge["invoke"],
            listen: vi.fn(async () => () => undefined) as unknown as UpdateBridge["listen"],
        };
        const { result } = renderHook(() => useAppUpdateState(bridge));
        await act(async () => { await result.current.openAppStore(); });
        expect(invoke).toHaveBeenCalledWith("open_app_store_update");
        expect(invoke).not.toHaveBeenCalledWith("prepare_app_update");
        expect(invoke).not.toHaveBeenCalledWith("restart_and_install_app_update");
    });

    it("never lets an older snapshot replace a newer one", () => {
        const staleAvailable = { ...readyState, revision: 3, status: "available" } as UpdateState;
        expect(newerUpdateState(readyState, staleAvailable)).toBe(readyState);
        const installing = { ...readyState, revision: 6, status: "installing" } as UpdateState;
        expect(newerUpdateState(readyState, installing)).toBe(installing);
    });

    it("subscribes before reading the snapshot and ignores late stale command results", async () => {
        const calls: string[] = [];
        let emit: ((state: UpdateState) => void) | null = null;
        let resolveCheck: ((state: UpdateState) => void) | null = null;
        const invoke = vi.fn((command: string) => {
            calls.push(`invoke:${command}`);
            if (command === "get_update_state") {
                return Promise.resolve({ ...readyState, revision: 1, status: "idle" });
            }
            if (command === "check_for_app_update") {
                return new Promise<UpdateState>(resolve => {
                    resolveCheck = resolve;
                });
            }
            return Promise.resolve(undefined);
        });
        const listen = vi.fn(async (_event: string, handler: (event: { payload: UpdateState }) => void) => {
            calls.push("listen");
            emit = state => handler({ payload: state });
            return () => undefined;
        });
        const bridge: UpdateBridge = {
            invoke: invoke as unknown as UpdateBridge["invoke"],
            listen: listen as unknown as UpdateBridge["listen"],
        };
        const { result } = renderHook(() => useAppUpdateState(bridge));
        await waitFor(() => expect(result.current.state.status).toBe("idle"));
        expect(calls.slice(0, 2)).toEqual(["listen", "invoke:get_update_state"]);

        let checkPromise: Promise<UpdateState> | null = null;
        act(() => {
            checkPromise = result.current.check();
        });
        act(() => emit!(readyState));
        expect(result.current.state.status).toBe("ready");

        await act(async () => {
            resolveCheck!({ ...readyState, revision: 2, status: "available" });
            await checkPromise;
        });
        expect(result.current.state.status).toBe("ready");
    });
});
