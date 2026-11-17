import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";

const platform = vi.hoisted(() => ({ mac: false, windows: true, setLanguageCode: vi.fn() }));
vi.mock("../../../src/shortcutDisplay", () => ({ isMacPlatform: () => platform.mac, isWindowsPlatform: () => platform.windows }));
vi.mock("../../../src/lang", () => ({ DEFAULT_LANGUAGE: "Chinese", useLanguage: () => ({ t: (key: string) => key, languages: [], setLanguageCode: platform.setLanguageCode }) }));
vi.mock("../../../src/auxiliaryWindowReady", () => ({ notifyAuxiliaryWindowReady: () => () => undefined }));
vi.mock("../../../src/theme", () => ({ applyThemeMode: vi.fn() }));
vi.mock("../../../src/config/sections/GeneralSettings", () => ({ default: () => null }));
vi.mock("../../../src/config/sections/DataSettings", () => ({ default: () => null }));
vi.mock("../../../src/config/sections/ShortcutSettings", () => ({ default: () => null }));
vi.mock("../../../src/config/sections/AboutSettings", () => ({ default: () => null }));
vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn(), error: vi.fn() }));
import Config from "../../../src/config/Config";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function settings(mac: boolean, windows = !mac) {
    platform.mac = mac;
    platform.windows = windows;
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const bridge = {
        invoke: vi.fn(async (command: string) => command === "get_config" ? JSON.stringify(DEFAULT_CONFIG) : null),
        listen: vi.fn(async () => () => undefined),
        startWindowDragging: vi.fn(async () => undefined),
        hideWindow: vi.fn(), open: vi.fn(), save: vi.fn(), convertFileSrc: vi.fn(),
    } as unknown as SettingsBridge;
    const view = render(<MotionTestProvider><Config bridge={bridge} /></MotionTestProvider>);
    const handles = ["dragRegion", "sidebarDragRegion", "contentTitleBar"]
        .map(name => view.container.querySelector(`[class*="${name}"]`)!);
    expect(handles.every(Boolean)).toBe(true);
    return { bridge, handles };
}

describe("settings caption dragging", () => {
    it("lets WebView2 own Windows caption dragging without an IPC mouse-down", () => {
        const { bridge, handles } = settings(false);
        handles.forEach(handle => fireEvent.mouseDown(handle, { button: 0 }));
        expect(bridge.startWindowDragging).not.toHaveBeenCalled();
    });
    it("retains the existing macOS drag route and ignores other mouse buttons", () => {
        const { bridge, handles } = settings(true);
        handles.forEach(handle => fireEvent.mouseDown(handle, { button: 2 }));
        expect(bridge.startWindowDragging).not.toHaveBeenCalled();
        handles.forEach(handle => fireEvent.mouseDown(handle, { button: 0 }));
        expect(bridge.startWindowDragging).toHaveBeenCalledTimes(3);
    });
    it("does not disable the drag bridge on other platforms", () => {
        const { bridge, handles } = settings(false, false);
        handles.forEach(handle => fireEvent.mouseDown(handle, { button: 0 }));
        expect(bridge.startWindowDragging).toHaveBeenCalledTimes(3);
    });
});
