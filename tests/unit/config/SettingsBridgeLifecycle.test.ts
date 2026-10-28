import { describe, expect, it, vi } from "vitest";

const { invoke, hide } = vi.hoisted(() => ({
    invoke: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ hide, startDragging: vi.fn() }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { tauriSettingsBridge } from "../../../src/config/SettingsBridge";

describe("settings window lifecycle", () => {
    it("closes through the backend so the webview is destroyed", async () => {
        await tauriSettingsBridge.hideWindow();
        expect(invoke).toHaveBeenCalledWith("close_config_window");
        expect(hide).not.toHaveBeenCalled();
    });
});
