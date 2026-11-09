import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        if (command === "get_clipboard_panel_size_state") {
            return {
                preference: null,
                recommended: "medium",
                effective: "medium",
                display: {
                    pixel_width: 1920,
                    pixel_height: 1080,
                    scale_factor: 1.25,
                    logical_width: 1536,
                    logical_height: 864,
                    work_width: 1536,
                    work_height: 824,
                },
            };
        }
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
    it("renders one labeled OCR switch without explanatory text and saves its value", async () => {
        const onSave = vi.fn(async () => null);
        render(<AppThemeProvider><MotionTestProvider><GeneralSettings bridge={bridge} config={DEFAULT_CONFIG} languages={[]} t={key => key} onSave={onSave} /></MotionTestProvider></AppThemeProvider>);
        const control = screen.getByRole("checkbox", { name: "settings.imageOcr" });
        expect(control).toBeChecked();
        expect(control).not.toHaveAttribute("aria-describedby");
        await userEvent.click(control);
        expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_CONFIG, image_ocr_enabled: false });
    });
    it("loads the native automatic panel size without entering an error state", async () => {
        render(<AppThemeProvider><MotionTestProvider><GeneralSettings bridge={bridge} config={DEFAULT_CONFIG} languages={[]} onSave={vi.fn(async () => null)} t={key => key} /></MotionTestProvider></AppThemeProvider>);

        const slider = await screen.findByRole("slider", { name: "settings.panelSize" });
        await waitFor(() => expect(slider).toBeEnabled());
        expect(slider).toHaveAttribute("aria-valuenow", "1");
        expect(slider).toHaveAttribute("aria-valuetext", "settings.panelSize.medium · 90%");
        expect(screen.getByText("settings.panelSize.default")).toBeVisible();
        expect(screen.queryByText("settings.panelSize.recommendation")).not.toBeInTheDocument();
        expect(screen.queryByText("settings.panelSize.automatic")).not.toBeInTheDocument();
        expect(screen.queryByText("settings.panelSize.hint")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "settings.panelSize.restoreAuto" })).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it.each([false, true])("preserves keyboard height preview and release/escape handling (cancel=%s)", async cancel => {
        const onSaved = vi.fn();
        const invoke = vi.fn(async (command: string, args?: unknown) => {
            if (command === "begin_clipboard_size_preview") return 7;
            if (command === "update_clipboard_size_preview") return undefined;
            if (command === "finish_clipboard_size_preview") {
                const size = (args as { size: "large" | null }).size;
                return { preference: size, effective: size ?? "medium", recommended: "medium", display: null };
            }
            return bridge.invoke(command);
        }) as SettingsBridge["invoke"];
        render(<AppThemeProvider><MotionTestProvider><GeneralSettings bridge={{ ...bridge, invoke }} config={DEFAULT_CONFIG} languages={[]} onSave={vi.fn(async () => null)} onPanelSizeSaved={onSaved} t={key => key} /></MotionTestProvider></AppThemeProvider>);
        const slider = await screen.findByRole("slider", { name: "settings.panelSize" });
        await waitFor(() => expect(slider).toBeEnabled());
        fireEvent.keyDown(slider, { key: "End" });
        fireEvent.change(slider, { target: { value: "2" } });
        if (cancel) fireEvent.keyDown(slider, { key: "Escape" });
        fireEvent.keyUp(slider, { key: "End" });

        await waitFor(() => expect(invoke).toHaveBeenCalledWith("finish_clipboard_size_preview", { sessionId: 7, size: cancel ? null : "large" }));
        expect(invoke).toHaveBeenCalledWith("begin_clipboard_size_preview", { size: "medium" });
        await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(cancel ? null : "large"));
        expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "finish_clipboard_size_preview")).toHaveLength(1);
    });

    it("offers immediate single-click paste by default, double-click paste, and opt-in hover preview", async () => {
        const onSave = vi.fn(async () => null);
        render(<AppThemeProvider><MotionTestProvider><GeneralSettings bridge={bridge} config={DEFAULT_CONFIG} languages={[]} onSave={onSave} t={key => key} /></MotionTestProvider></AppThemeProvider>);
        const user = userEvent.setup();
        await user.click(screen.getByRole("combobox", { name: "settings.mousePaste" }));
        await user.click(screen.getByRole("option", { name: "settings.mousePaste.double" }));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mouse_paste_mode: "double" }));
        const hover = screen.getByRole("checkbox", { name: "settings.hoverPreview" });
        expect(hover).not.toBeChecked();
        await user.click(hover);
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ hover_preview_enabled: true }));
    });

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
                return bridge.invoke(command);
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
        vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
        const portableBridge = {
            ...bridge,
            invoke: vi.fn(async (command: string) => command === "get_update_state"
                ? { portable: true, status: "idle", currentVersion: "1.6.0", availableVersion: null, downloadedBytes: 0, totalBytes: null, error: null, feedEnabled: true, releaseUrl: "" }
                : bridge.invoke(command)) as SettingsBridge["invoke"],
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

        await waitFor(() => expect(screen.getByRole("checkbox", { name: "settings.startup" })).toBeDisabled());
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
                return bridge.invoke(command);
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
