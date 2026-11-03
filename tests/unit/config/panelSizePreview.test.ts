import { describe, expect, it, vi } from "vitest";
import { createPanelSizePreview, type PanelSize, type PanelSizeState } from "../../../src/config/panelSizePreview";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const state = (size: PanelSize, automatic = false): PanelSizeState => ({
    preference: automatic ? null : size, effective: size, recommended: size, display: null,
});

describe("panel size preview ownership", () => {
    it("closes a slow begin and saves the last choice once without replaying late updates", async () => {
        const begin = deferred<number>();
        const invoke = vi.fn(async (command: string) => command === "begin_clipboard_size_preview" ? begin.promise : state("medium"));
        const preview = createPanelSizePreview({ invoke: invoke as SettingsBridge["invoke"] }, "large", vi.fn());
        preview.update("small");
        preview.update("medium");
        const finished = preview.finish(true);
        expect(preview.finish(true)).toBe(finished);
        preview.update("large");
        begin.resolve(7);
        expect(await finished).toEqual(state("medium"));
        expect(invoke.mock.calls.map(([command]) => command)).toEqual([
            "begin_clipboard_size_preview", "finish_clipboard_size_preview",
        ]);
        expect(invoke).toHaveBeenLastCalledWith("finish_clipboard_size_preview", { sessionId: 7, size: "medium" });
    });

    it("waits for an in-flight resize before cancelling and never persists that resize", async () => {
        const entered = deferred<void>();
        const resized = deferred<void>();
        const invoke = vi.fn(async (command: string) => {
            if (command === "begin_clipboard_size_preview") return 11;
            if (command === "update_clipboard_size_preview") {
                entered.resolve();
                await resized.promise;
                return undefined;
            }
            return state("large", true);
        });
        const preview = createPanelSizePreview({ invoke: invoke as SettingsBridge["invoke"] }, "large", vi.fn());
        preview.update("small");
        await entered.promise;
        const finished = preview.finish(false);
        preview.update("medium");
        resized.resolve();
        expect(await finished).toEqual(state("large", true));
        expect(invoke).toHaveBeenLastCalledWith("finish_clipboard_size_preview", { sessionId: 11, size: null });
        expect(invoke.mock.calls.filter(([command]) => command === "update_clipboard_size_preview")).toHaveLength(1);
    });

    it("ends a failed resize as cancellation instead of saving a size that could not be previewed", async () => {
        const failed = deferred<void>();
        const invoke = vi.fn(async (command: string) => {
            if (command === "begin_clipboard_size_preview") return 19;
            if (command === "update_clipboard_size_preview") throw new Error("native resize failed");
            return state("large");
        });
        const preview = createPanelSizePreview({ invoke: invoke as SettingsBridge["invoke"] }, "large", () => failed.resolve());
        preview.update("small");
        await failed.promise;
        expect(await preview.finish(true)).toEqual(state("large"));
        expect(invoke).toHaveBeenLastCalledWith("finish_clipboard_size_preview", { sessionId: 19, size: null });
    });

    it("keeps the backend's automatic mode when native focus loss cancelled the session before release", async () => {
        const invoke = vi.fn(async (command: string) => command === "begin_clipboard_size_preview" ? 23 : state("small", true));
        const preview = createPanelSizePreview({ invoke: invoke as SettingsBridge["invoke"] }, "medium", vi.fn());
        expect(await preview.finish(true)).toEqual(state("small", true));
    });
});
