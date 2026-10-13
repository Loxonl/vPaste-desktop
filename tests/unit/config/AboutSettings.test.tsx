import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AboutSettings from "../../../src/config/sections/AboutSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import type { UpdateState } from "../../../src/update";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

afterEach(cleanup);

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

function renderAbout(bridge: SettingsBridge) {
    render(
        <MotionTestProvider>
            <AboutSettings
                bridge={bridge}
                config={DEFAULT_CONFIG}
                dir="ltr"
                onSave={vi.fn()}
                t={(key: string) => key}
            />
        </MotionTestProvider>,
    );
}

describe("About update controls", () => {
    it("downloads after a manual check and then offers one restart action", async () => {
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
        await user.click(await screen.findByRole("button", { name: "settings.updateRestart" }));
        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("restart_and_install_app_update");
        });
    });

    it("opens shared link cards through the existing browser command", async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === "get_update_state") return baseState;
            return undefined;
        });
        renderAbout(createBridge(invoke as SettingsBridge["invoke"]));

        await userEvent.click(screen.getByRole("button", { name: /settings\.about\.changelog/ }));

        expect(invoke).toHaveBeenCalledWith("open_url_in_browser", {
            url: "https://github.com/Loxonl/vPaste-desktop/releases",
        });
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
        await userEvent.click(screen.getByRole("button", { name: "settings.updateRestart" }));
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
});
