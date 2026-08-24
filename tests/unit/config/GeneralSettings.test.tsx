import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GeneralSettings from "../../../src/config/sections/GeneralSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";

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
    it("associates standard switches and selects with their visible setting labels", async () => {
        render(
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
            </AppThemeProvider>,
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
            <AppThemeProvider>
                <GeneralSettings
                    bridge={macBridge}
                    config={DEFAULT_CONFIG}
                    languages={[]}
                    onSave={vi.fn(async () => null)}
                    t={key => key}
                />
            </AppThemeProvider>,
        );

        expect(await screen.findByRole("status")).toHaveTextContent("settings.permissions.enabled");
        expect(screen.getByRole("button", { name: "settings.permissions.required" })).toHaveClass("MuiButton-outlinedWarning");
    });
});
