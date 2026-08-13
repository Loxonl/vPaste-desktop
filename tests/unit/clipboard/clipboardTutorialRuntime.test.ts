import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    PENDING_PERMISSION_WINDOW_KEY,
    type TutorialPermissionStatus,
} from "../../../src/clipboard/clipboardTutorial";
import { createClipboardTutorialRuntime } from "../../../src/clipboard/clipboardTutorialRuntime";

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const logger = vi.hoisted(() => ({
    error: vi.fn(),
}));

const behavior = vi.hoisted(() => ({
    load: vi.fn(),
    mainShortcut: vi.fn(),
}));

const platform = vi.hoisted(() => ({
    isMac: vi.fn(),
}));

const theme = vi.hoisted(() => ({
    preview: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/plugin-log", () => ({
    error: logger.error,
}));

vi.mock("../../../src/clipboard/clipboardBehavior", () => ({
    loadClipboardBehaviorConfig: behavior.load,
    mainShortcutFromConfig: behavior.mainShortcut,
}));

vi.mock("../../../src/shortcutDisplay", () => ({
    isMacPlatform: platform.isMac,
}));

vi.mock("../../../src/theme", () => ({
    getThemePreview: theme.preview,
}));

function runtimeOptions() {
    return {
        incrementRunId: vi.fn(),
        isActive: vi.fn(() => false),
        languageCode: "Chinese",
        onActionError: vi.fn(),
        onBeforeStart: vi.fn(),
        onComplete: vi.fn(),
        setActive: vi.fn(),
        setMainShortcut: vi.fn(),
        setPermissionStatus: vi.fn(),
        setPlatform: vi.fn(),
    };
}

describe("clipboard tutorial runtime", () => {
    beforeEach(() => {
        localStorage.clear();
        tauri.invoke.mockReset();
        logger.error.mockReset();
        behavior.load.mockReset();
        behavior.mainShortcut.mockReset();
        platform.isMac.mockReset();
        theme.preview.mockReset();
        behavior.load.mockResolvedValue({ onboarding_completed: true });
        behavior.mainShortcut.mockReturnValue("Alt+V");
        platform.isMac.mockReturnValue(false);
        theme.preview.mockReturnValue(null);
    });

    it("starts the selected platform after resetting main-window state", async () => {
        const options = runtimeOptions();
        const runtime = createClipboardTutorialRuntime(options);

        await runtime.start("windows");
        await vi.waitFor(() => {
            expect(options.setMainShortcut).toHaveBeenCalledWith("Alt+V");
        });

        expect(options.onBeforeStart).toHaveBeenCalledOnce();
        expect(options.setPlatform).toHaveBeenCalledWith("windows");
        expect(options.incrementRunId).toHaveBeenCalledOnce();
        expect(options.setActive).toHaveBeenCalledWith(true);
        expect(options.setPermissionStatus).not.toHaveBeenCalled();
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            "get_onboarding_permission_status",
        );
    });

    it("clears and refreshes permission state for a mac tutorial", async () => {
        const options = runtimeOptions();
        const status: TutorialPermissionStatus = {
            background: { done: true, needs_settings: false },
            paste: { done: false, needs_settings: true },
        };
        tauri.invoke.mockResolvedValue(status);
        const runtime = createClipboardTutorialRuntime(options);

        await runtime.start("mac");
        await vi.waitFor(() => {
            expect(options.setPermissionStatus).toHaveBeenLastCalledWith(status);
        });

        expect(options.setPermissionStatus.mock.calls[0][0]).toBeNull();
        expect(tauri.invoke).toHaveBeenCalledWith(
            "get_onboarding_permission_status",
        );
    });

    it("stores permission context and opens the permission window without hiding the main window", async () => {
        const calls: string[] = [];
        const options = runtimeOptions();
        theme.preview.mockReturnValue("dark");
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "open_onboarding_permission_window") {
                calls.push("open");
            }
        });
        const runtime = createClipboardTutorialRuntime(options);

        await runtime.openPermission("paste");

        expect(JSON.parse(
            localStorage.getItem(PENDING_PERMISSION_WINDOW_KEY) || "{}",
        )).toEqual({
            permission: "paste",
            languageCode: "Chinese",
            themePreview: "dark",
        });
        expect(calls).toEqual(["open"]);
        expect(tauri.invoke).toHaveBeenCalledWith(
            "open_onboarding_permission_window",
            {
                permission: "paste",
                languageCode: "Chinese",
                themePreview: "dark",
            },
        );
    });

    it("locks main-window visibility before activating the tutorial", async () => {
        const calls: string[] = [];
        const options = runtimeOptions();
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "begin_onboarding") {
                calls.push("lock");
            }
        });
        options.setActive.mockImplementation(() => {
            calls.push("activate");
        });
        const runtime = createClipboardTutorialRuntime(options);

        await runtime.start("windows");

        expect(calls).toEqual(["lock", "activate"]);
    });

    it("does not activate the tutorial when the visibility lock cannot be established", async () => {
        const options = runtimeOptions();
        const failure = new Error("lock failed");
        tauri.invoke.mockRejectedValue(failure);
        const runtime = createClipboardTutorialRuntime(options);

        await runtime.start("windows");

        expect(options.setActive).not.toHaveBeenCalled();
        expect(options.onActionError).toHaveBeenCalledWith(failure);
    });

    it("completes through the established command before leaving tutorial mode", async () => {
        const options = runtimeOptions();
        tauri.invoke.mockResolvedValue(undefined);
        const runtime = createClipboardTutorialRuntime(options);

        await runtime.complete();

        expect(tauri.invoke).toHaveBeenCalledWith("complete_onboarding");
        expect(options.setActive).toHaveBeenCalledWith(false);
        expect(options.onComplete).toHaveBeenCalledOnce();
        expect(options.onActionError).not.toHaveBeenCalled();
    });

    it("keeps tutorial state visible when completion fails", async () => {
        const options = runtimeOptions();
        const failure = new Error("save failed");
        tauri.invoke.mockRejectedValue(failure);
        const runtime = createClipboardTutorialRuntime(options);

        await runtime.complete();

        expect(options.setActive).not.toHaveBeenCalled();
        expect(options.onComplete).not.toHaveBeenCalled();
        expect(options.onActionError).toHaveBeenCalledWith(failure);
    });

    it("starts first-run onboarding only when it is incomplete and inactive", async () => {
        const options = runtimeOptions();
        behavior.load
            .mockResolvedValueOnce({ onboarding_completed: false })
            .mockResolvedValueOnce({ onboarding_completed: false });
        const runtime = createClipboardTutorialRuntime(options);

        runtime.initialize();
        await vi.waitFor(() => {
            expect(options.setActive).toHaveBeenCalledWith(true);
        });

        expect(options.onBeforeStart).toHaveBeenCalledOnce();
        expect(options.setPlatform).toHaveBeenCalledWith("windows");
    });
});
