import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import GeneralSettings from "../../../src/config/sections/GeneralSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const bridge: SettingsBridge = {
    invoke: vi.fn(async (command: string) => {
        if (command === "get_update_state") {
            return {
                status: "idle",
                currentVersion: "1.6.0",
                availableVersion: null,
                downloadedBytes: 0,
                totalBytes: null,
                error: null,
                portable: false,
                feedEnabled: true,
                releaseUrl: "",
            };
        }
        return null;
    }) as SettingsBridge["invoke"],
    listen: vi.fn(async () => () => undefined) as unknown as SettingsBridge["listen"],
    open: vi.fn(),
    save: vi.fn(),
    convertFileSrc: vi.fn(path => path),
    startWindowDragging: vi.fn(),
    hideWindow: vi.fn(),
};

describe("General settings accessibility", () => {
    it("lets a portable user opt in to launch at startup", async () => {
        vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
        const portableBridge = {
            ...bridge,
            invoke: vi.fn(async (command: string) => {
                if (command === "get_update_state") {
                    return {
                        status: "idle",
                        currentVersion: "1.6.0",
                        availableVersion: null,
                        downloadedBytes: 0,
                        totalBytes: null,
                        error: null,
                        portable: true,
                        feedEnabled: true,
                        releaseUrl: "",
                    };
                }
                return null;
            }) as SettingsBridge["invoke"],
        };
        const onSave = vi.fn(async () => null);
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <GeneralSettings
                        bridge={portableBridge}
                        config={{ ...DEFAULT_CONFIG, startup: false }}
                        languages={[]}
                        onSave={onSave}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        const startup = await screen.findByRole("checkbox", { name: "settings.startup" });
        expect(startup).toBeEnabled();
        await userEvent.click(startup);
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ startup: true }));
    });

    it("keeps portable startup unavailable outside Windows", async () => {
        const portableBridge = {
            ...bridge,
            invoke: vi.fn(async (command: string) => command === "get_update_state"
                ? { portable: true, status: "idle", currentVersion: "1.6.0", availableVersion: null, downloadedBytes: 0, totalBytes: null, error: null, feedEnabled: true, releaseUrl: "" }
                : null) as SettingsBridge["invoke"],
        };
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <GeneralSettings
                        bridge={portableBridge}
                        config={{ ...DEFAULT_CONFIG, startup: false }}
                        languages={[]}
                        onSave={vi.fn(async () => null)}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        expect(await screen.findByRole("checkbox", { name: "settings.startup" })).toBeDisabled();
    });

    it("associates standard switches and selects with their visible setting labels", async () => {
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <GeneralSettings
                        bridge={bridge}
                        config={DEFAULT_CONFIG}
                        languages={[
                            { value: "zh-CN", label: "简体中文 (大陆)" },
                            { value: "en-US", label: "English (US)" },
                        ]}
                        onSave={vi.fn(async () => null)}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        expect(await screen.findByRole("checkbox", { name: "settings.startup" })).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "settings.trayIcon" })).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "settings.linkAutoPreview" })).toHaveAccessibleDescription("settings.linkAutoPreview.desc");
        expect(screen.getByRole("combobox", { name: "settings.language" })).toBeVisible();
        expect(screen.getByRole("combobox", { name: "settings.themeMode" })).toBeVisible();
    });

    it("uses a status badge for completed macOS permissions and a MUI action for missing permission", async () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
        const macBridge = {
            ...bridge,
            invoke: vi.fn(async (command: string) => {
                if (command === "get_update_state") {
                    return {
                        status: "idle",
                        currentVersion: "1.6.0",
                        availableVersion: null,
                        downloadedBytes: 0,
                        totalBytes: null,
                        error: null,
                        portable: false,
                        feedEnabled: true,
                        releaseUrl: "",
                    };
                }
                if (command === "get_onboarding_permission_status") {
                    return {
                        background: { done: true },
                        paste: { done: false },
                    };
                }
                return null;
            }) as SettingsBridge["invoke"],
        };

        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <GeneralSettings
                        bridge={macBridge}
                        config={DEFAULT_CONFIG}
                        languages={[]}
                        onSave={vi.fn(async () => null)}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        const enabled = await screen.findByRole("status");
        expect(enabled).toHaveTextContent("settings.permissions.enabled");
        expect(enabled.closest("[data-motion-state='permission-granted']")).toHaveAttribute(
            "data-motion-preset",
            "stateIndicator",
        );
        expect(screen.getByRole("button", { name: "settings.permissions.required" })).toHaveClass("MuiButton-outlinedWarning");
    });
});
