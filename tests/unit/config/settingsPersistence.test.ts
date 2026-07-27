import { describe, expect, it, vi } from "vitest";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { persistSettings } from "../../../src/config/settingsPersistence";

function createBridge(invoke: SettingsBridge["invoke"]): SettingsBridge {
    return {
        invoke,
        listen: vi.fn(),
        open: vi.fn(),
        save: vi.fn(),
        convertFileSrc: vi.fn(),
        startWindowDragging: vi.fn(),
        hideWindow: vi.fn(),
    };
}

describe("persistSettings", () => {
    it("applies the new value and refreshes storage paths after saving", async () => {
        const invoke = vi.fn()
            .mockResolvedValueOnce({ migrated: false })
            .mockResolvedValueOnce({ history_storage_dir: "D:/vPaste" });
        const applyConfig = vi.fn();
        const applyStoragePaths = vi.fn();

        const result = await persistSettings({
            bridge: createBridge(invoke as SettingsBridge["invoke"]),
            previousConfig: { theme: "light" },
            nextConfig: { theme: "dark" },
            applyConfig,
            applyStoragePaths,
            serialize: JSON.stringify,
        });

        expect(result).toEqual({ migrated: false });
        expect(applyConfig).toHaveBeenCalledWith({ theme: "dark" });
        expect(invoke).toHaveBeenNthCalledWith(1, "save_config", {
            config: JSON.stringify({ theme: "dark" }),
        });
        expect(applyStoragePaths).toHaveBeenCalledWith({
            history_storage_dir: "D:/vPaste",
        });
    });

    it("restores the previous value when persistence fails", async () => {
        const failure = new Error("save failed");
        const bridge = createBridge(vi.fn().mockRejectedValue(failure) as SettingsBridge["invoke"]);
        const applyConfig = vi.fn();

        await expect(persistSettings({
            bridge,
            previousConfig: { theme: "light" },
            nextConfig: { theme: "dark" },
            applyConfig,
            applyStoragePaths: vi.fn(),
            serialize: JSON.stringify,
        })).rejects.toBe(failure);

        expect(applyConfig).toHaveBeenNthCalledWith(1, { theme: "dark" });
        expect(applyConfig).toHaveBeenNthCalledWith(2, { theme: "light" });
    });
});
