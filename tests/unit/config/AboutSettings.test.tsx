import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AboutSettings from "../../../src/config/sections/AboutSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG, type TFunction } from "../../../src/config/settingsTypes";
import type { UpdateState } from "../../../src/update";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";
import type { EventCallback, EventName } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const baseState: UpdateState = {
    status: "idle",
    currentVersion: "1.6.0",
    availableVersion: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    portable: false,
    feedEnabled: true,
    releaseUrl: "https://github.com/Loxonl/vPaste-desktop/releases",
};

function createBridge(invoke: SettingsBridge["invoke"]): SettingsBridge {
    return {
        invoke,
        listen: vi.fn(async () => () => undefined) as unknown as SettingsBridge["listen"],
        open: vi.fn(),
        save: vi.fn(),
        convertFileSrc: vi.fn(),
        startWindowDragging: vi.fn(),
        hideWindow: vi.fn(),
    };
}

function renderAbout(bridge: SettingsBridge, t: TFunction = (key: string) => key) {
    return render(
        <MotionTestProvider>
            <AboutSettings
                bridge={bridge}
                config={DEFAULT_CONFIG}
                dir="ltr"
                onSave={vi.fn()}
                t={t}
            />
        </MotionTestProvider>,
    );
}

describe("About update controls", () => {
    it("keeps product identity to two lines while the initial update snapshot loads", async () => {
        let resolveSnapshot!: (state: UpdateState) => void;
        const snapshot = new Promise<UpdateState>(resolve => { resolveSnapshot = resolve; });
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return snapshot;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));
        const identity = screen.getByRole("heading", { name: "vPaste" }).parentElement!;

        expect(identity.children).toHaveLength(2);
        expect(identity).not.toHaveTextContent("settings.updateDisabled");
        await act(async () => resolveSnapshot(baseState));
        expect(identity.children).toHaveLength(2);
        expect(invoke).not.toHaveBeenCalledWith("check_for_app_update");
    });

    it("reports manual checks only in the button and briefly shows the latest-version result", async () => {
        vi.useFakeTimers();
        let resolveCheck!: (state: UpdateState) => void;
        const checked = new Promise<UpdateState>(resolve => { resolveCheck = resolve; });
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            if (command === "check_for_app_update") return checked;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));
        await act(async () => {});

        fireEvent.click(screen.getByRole("button", { name: "settings.updateCheck" }));
        const checking = screen.getByRole("button", { name: "settings.updateChecking" });
        expect(checking).toBeDisabled();
        fireEvent.click(checking);
        expect(invoke.mock.calls.filter(([command]) => command === "check_for_app_update")).toHaveLength(1);
        const identity = screen.getByRole("heading", { name: "vPaste" }).parentElement!;
        expect(identity.children).toHaveLength(2);

        await act(async () => resolveCheck(baseState));
        expect(screen.getByRole("button", { name: "settings.updateLatestShort" })).toBeEnabled();
        act(() => vi.advanceTimersByTime(3000));
        expect(screen.getByRole("button", { name: "settings.updateCheck" })).toBeEnabled();
        expect(identity.children).toHaveLength(2);
    });

    it("shows transport errors at the update action instead of leaving a check looking successful", async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            if (command === "check_for_app_update") throw new Error("offline");
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));
        await userEvent.click(await screen.findByRole("button", { name: "settings.updateCheck" }));

        expect(await screen.findByRole("button", { name: "settings.updateFailedShort" })).toBeEnabled();
        expect(screen.getByRole("alert")).toHaveTextContent("settings.updateCheckFailed");
        expect(screen.getByRole("heading", { name: "vPaste" }).parentElement!.children).toHaveLength(2);
    });

    it("lets a newer ready update replace temporary failed-check feedback", async () => {
        let emitState!: (state: UpdateState) => void;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            if (command === "check_for_app_update") throw new Error("offline");
            return undefined;
        });
        const bridge = createBridge(invoke as SettingsBridge["invoke"]);
        bridge.listen = vi.fn(async <T,>(event: EventName, callback: EventCallback<T>) => {
            emitState = payload => callback({ event, id: 0, payload: payload as T });
            return () => undefined;
        }) as SettingsBridge["listen"];
        renderAbout(bridge);
        await userEvent.click(await screen.findByRole("button", { name: "settings.updateCheck" }));
        expect(await screen.findByRole("button", { name: "settings.updateFailedShort" })).toBeEnabled();

        act(() => emitState({ ...baseState, revision: 2, status: "ready", availableVersion: "1.7.0" }));
        expect(screen.getByRole("button", { name: "settings.updateTo" })).toBeEnabled();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("settings.updateReady");
    });

    it.each(["checking", "downloading", "installing", "ready", "manualDownload", "failed", "disabled"] as const)(
        "keeps the left column stable when the backend reports %s",
        async status => {
            const state = { ...baseState, status, availableVersion: "1.7.0" };
            const invoke = vi.fn(async (command: string) => command === "get_update_state" ? state : undefined);
            renderAbout(createBridge(invoke as SettingsBridge["invoke"]));
            await act(async () => {});
            expect(screen.getByRole("heading", { name: "vPaste" }).parentElement!.children).toHaveLength(2);
        },
    );

    it.each([[42, 42], [120, 100]])("shows bounded download progress for %i bytes", async (downloadedBytes, percent) => {
        const state = { ...baseState, status: "downloading", downloadedBytes, totalBytes: 100 } as UpdateState;
        const invoke = vi.fn(async (command: string) => command === "get_update_state" ? state : undefined);
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]), (key, params) =>
            key === "settings.updateDownloadingPercent" ? `Downloading ${params?.percent}%` : key);
        expect(await screen.findByRole("button", { name: `Downloading ${percent}%` })).toBeDisabled();
    });

    it("restarts the feedback timer for a repeated check and clears it on unmount", async () => {
        vi.useFakeTimers();
        const invoke = vi.fn(async () => baseState);
        const { unmount } = renderAbout(createBridge(invoke as SettingsBridge["invoke"]));
        await act(async () => {});
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "settings.updateCheck" })));
        act(() => vi.advanceTimersByTime(2000));
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "settings.updateLatestShort" })));
        act(() => vi.advanceTimersByTime(2000));
        expect(screen.getByRole("button", { name: "settings.updateLatestShort" })).toBeEnabled();
        act(() => vi.advanceTimersByTime(1000));
        expect(screen.getByRole("button", { name: "settings.updateCheck" })).toBeEnabled();

        await act(async () => fireEvent.click(screen.getByRole("button", { name: "settings.updateCheck" })));
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("opens an available Mac App Store update without downloading it", async () => {
        const storeState = { ...baseState, source: "macAppStore", status: "available", availableVersion: "1.7.0" } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            if (command === "check_for_app_update") return storeState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "settings.updateCheck" }));
        await user.click(await screen.findByRole("button", { name: "settings.updateOpenAppStore" }));
        expect(invoke).toHaveBeenCalledWith("open_app_store_update");
        expect(invoke).not.toHaveBeenCalledWith("prepare_app_update");
        expect(invoke).not.toHaveBeenCalledWith("restart_and_install_app_update");
    });
    it("downloads after a manual check and turns the same button into the install action", async () => {
        const availableState = { ...baseState, status: "available", availableVersion: "1.7.0" } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            if (command === "check_for_app_update") return availableState;
            if (command === "prepare_app_update") return { ...availableState, status: "ready" };
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "settings.updateCheck" }));

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("prepare_app_update");
        });
        const updateButton = await screen.findByRole("button", { name: "settings.updateTo" });
        expect(screen.queryByRole("button", { name: "settings.updateCheck" })).not.toBeInTheDocument();
        await user.click(updateButton);
        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("restart_and_install_app_update");
        });
    });

    it.each([
        ["settings.about.website", "https://vpaste.app/"],
        ["settings.about.github", "https://github.com/Loxonl/vPaste-desktop"],
        ["settings.about.changelog", "https://github.com/Loxonl/vPaste-desktop/releases"],
    ])("opens %s through the existing browser command", async (name, url) => {
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        await userEvent.click(screen.getByRole("button", { name }));

        expect(invoke).toHaveBeenCalledWith("open_url_in_browser", { url });
    });

    it("uses the shared confirmation dialog before opening a manual update download", async () => {
        const manualState = {
            ...baseState,
            status: "manualDownload",
            availableVersion: "1.7.0",
        } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            if (command === "check_for_app_update") return manualState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        await userEvent.click(await screen.findByRole("button", { name: "settings.updateCheck" }));
        const dialog = await screen.findByRole("dialog", { name: "settings.updateOpenReleaseTitle" });
        await userEvent.click(screen.getByRole("button", { name: "settings.updateOpenRelease" }));

        expect(dialog).not.toBeVisible();
        expect(invoke).toHaveBeenCalledWith("open_url_in_browser", {
            url: manualState.releaseUrl,
        });
    });

    it.each([
        ["check", "settings.updateCheckFailed"],
        ["download", "settings.updateDownloadFailed"],
        ["restore", "settings.updateRestoreFailed"],
        ["install", "settings.updateInstallFailed"],
    ] as const)("names the failed %s stage and offers a retry", async (errorStage, message) => {
        const failedState = { ...baseState, status: "failed", error: "offline", errorStage } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return failedState;
            if (command === "check_for_app_update") return baseState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        expect(await screen.findByRole("alert")).toHaveTextContent(message);
        await userEvent.click(screen.getByRole("button", { name: "settings.updateRetry" }));
        expect(invoke).toHaveBeenCalledWith("check_for_app_update");
    });

    it("keeps a verified update installable after the installer failed to start", async () => {
        const readyWithError = {
            ...baseState,
            status: "ready",
            availableVersion: "1.7.0",
            error: "spawn failed",
            errorStage: "install",
        } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return readyWithError;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        expect(await screen.findByRole("alert")).toHaveTextContent("settings.updateReadyInstallFailed");
        await userEvent.click(screen.getByRole("button", { name: "settings.updateTo" }));
        expect(invoke).toHaveBeenCalledWith("restart_and_install_app_update");
    });

    it("explains a build without the online feed instead of reporting the latest version", async () => {
        const disabledState = { ...baseState, status: "disabled", feedEnabled: false } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return disabledState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        expect(await screen.findByText("settings.updateDisabled")).toBeInTheDocument();
        expect(screen.queryByText("settings.updateLatest")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "settings.updateCheck" })).toBeDisabled();
    });

    it("uses one update button that becomes the install action once an update is found", async () => {
        const readyState = { ...baseState, status: "ready", availableVersion: "1.7.0" } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return readyState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        await screen.findByRole("button", { name: "settings.updateTo" });
        expect(screen.queryByRole("button", { name: "settings.updateCheck" })).not.toBeInTheDocument();
        expect(screen.getByText("common.version")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "common.version" })).not.toBeInTheDocument();
    });

    it("downloads when the found update has not been prepared yet", async () => {
        const availableState = { ...baseState, status: "available", availableVersion: "1.7.0" } as UpdateState;
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return availableState;
            if (command === "prepare_app_update") return availableState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        await userEvent.click(await screen.findByRole("button", { name: "settings.updateTo" }));
        expect(invoke).toHaveBeenCalledWith("prepare_app_update");
        expect(invoke).not.toHaveBeenCalledWith("restart_and_install_app_update");
    });

    it("offers only the check button when no update is waiting and disables it while busy", async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        expect(await screen.findByRole("button", { name: "settings.updateCheck" })).toBeEnabled();
        expect(screen.queryByRole("button", { name: "settings.updateTo" })).not.toBeInTheDocument();

        cleanup();
        const checking = vi.fn(async (command: string) => {
            if (command === "get_update_state") return { ...baseState, status: "checking" };
            return undefined;
        });
        renderAbout(createBridge(checking as SettingsBridge["invoke"]));
        expect(await screen.findByRole("button", { name: "settings.updateChecking" })).toBeDisabled();
    });
});

describe("About GitHub star prompt", () => {
    afterEach(() => localStorage.clear());

    it("links to the repository and stays dismissed once closed", async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        expect(screen.getByText("settings.about.starPrompt")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "settings.about.starAction" }));
        expect(invoke).toHaveBeenCalledWith("open_url_in_browser", {
            url: "https://github.com/Loxonl/vPaste-desktop",
        });

        await userEvent.click(screen.getByRole("button", { name: "settings.about.starDismiss" }));
        await waitFor(() => expect(screen.queryByText("settings.about.starPrompt")).not.toBeInTheDocument());

        cleanup();
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));
        await screen.findByRole("button", { name: "settings.updateCheck" });
        expect(screen.queryByText("settings.about.starPrompt")).not.toBeInTheDocument();
    });
});
