import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipboardAltHints } from "../../../src/clipboard/useClipboardAltHints";

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const logger = vi.hoisted(() => ({
    error: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/plugin-log", () => ({
    error: logger.error,
}));

describe("useClipboardAltHints", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        tauri.invoke.mockReset();
        logger.error.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not show hints when quick input is disabled", () => {
        const quickInputEnabledRef = { current: false };
        const { result } = renderHook(() =>
            useClipboardAltHints(quickInputEnabledRef),
        );

        act(() => {
            result.current.showWhilePressed();
            vi.advanceTimersByTime(80);
        });

        expect(result.current.visible).toBe(false);
        expect(tauri.invoke).not.toHaveBeenCalled();
    });

    it("polls native Alt state while the key remains pressed", async () => {
        const quickInputEnabledRef = { current: true };
        tauri.invoke
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const { result } = renderHook(() =>
            useClipboardAltHints(quickInputEnabledRef),
        );

        act(() => {
            result.current.showWhilePressed();
        });
        expect(result.current.visible).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(40);
        });
        expect(tauri.invoke).toHaveBeenCalledWith("is_alt_key_pressed");
        expect(result.current.visible).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(40);
        });
        expect(tauri.invoke).toHaveBeenCalledTimes(2);
        expect(result.current.visible).toBe(false);
    });

    it("synchronizes once from native state and hides on demand", async () => {
        const quickInputEnabledRef = { current: true };
        tauri.invoke.mockResolvedValue(true);
        const { result } = renderHook(() =>
            useClipboardAltHints(quickInputEnabledRef),
        );

        await act(async () => {
            result.current.syncFromNative();
            await Promise.resolve();
        });
        expect(result.current.visible).toBe(true);

        act(() => {
            result.current.hide();
            vi.advanceTimersByTime(80);
        });
        expect(result.current.visible).toBe(false);
        expect(tauri.invoke).toHaveBeenCalledTimes(1);
    });

    it("clears polling on unmount and reports native failures", async () => {
        const quickInputEnabledRef = { current: true };
        tauri.invoke.mockRejectedValue(new Error("native unavailable"));
        const { result, unmount } = renderHook(() =>
            useClipboardAltHints(quickInputEnabledRef),
        );

        act(() => {
            result.current.showWhilePressed();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(40);
        });
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to read Alt key state"),
        );

        act(() => {
            result.current.showWhilePressed();
        });
        unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(80);
        });
        expect(tauri.invoke).toHaveBeenCalledTimes(1);
    });
});
