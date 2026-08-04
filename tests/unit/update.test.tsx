import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { restartReady, useAppUpdateState, type UpdateBridge, type UpdateState } from "../../src/update";

const readyState: UpdateState = {
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
});
