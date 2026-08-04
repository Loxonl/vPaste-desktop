import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AboutSettings from "../../../src/config/sections/AboutSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import type { UpdateState } from "../../../src/update";

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
        <AboutSettings
            bridge={bridge}
            config={DEFAULT_CONFIG}
            dir="ltr"
            onSave={vi.fn()}
            t={(key: string) => key}
        />,
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
});
