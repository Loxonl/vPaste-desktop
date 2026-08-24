import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShortcutSettings from "../../../src/config/sections/ShortcutSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";

afterEach(cleanup);

describe("Shortcut settings recorder", () => {
    it("still records and saves keyboard input through MUI ButtonBase", async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === "check_main_shortcut_registration") return { conflict: false };
            return null;
        });
        const bridge: SettingsBridge = {
            invoke: invoke as SettingsBridge["invoke"],
            listen: vi.fn(async () => () => undefined) as unknown as SettingsBridge["listen"],
            open: vi.fn(),
            save: vi.fn(),
            convertFileSrc: vi.fn(path => path),
            startWindowDragging: vi.fn(),
            hideWindow: vi.fn(),
        };
        const onSave = vi.fn(async () => null);
        render(
            <AppThemeProvider>
                <ShortcutSettings
                    bridge={bridge}
                    config={DEFAULT_CONFIG}
                    onSave={onSave}
                    t={key => key}
                />
            </AppThemeProvider>,
        );
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: /settings\.shortcuts\.main.*Alt \+ V/ }));
        const recorder = await screen.findByRole("button", { name: /settings\.shortcuts\.main.*settings\.shortcut\.recording/ });
        await user.type(recorder, "{Control>}k{/Control}");

        await waitFor(() => expect(onSave).toHaveBeenCalledWith({
            ...DEFAULT_CONFIG,
            shortcut_keys: {
                ...DEFAULT_CONFIG.shortcut_keys,
                main_window: "Control+K",
            },
        }));
    });

    it("associates validation errors with the shortcut recorder", async () => {
        const bridge: SettingsBridge = {
            invoke: vi.fn(async () => null) as SettingsBridge["invoke"],
            listen: vi.fn(async () => () => undefined) as unknown as SettingsBridge["listen"],
            open: vi.fn(),
            save: vi.fn(),
            convertFileSrc: vi.fn(path => path),
            startWindowDragging: vi.fn(),
            hideWindow: vi.fn(),
        };
        render(
            <AppThemeProvider>
                <ShortcutSettings
                    bridge={bridge}
                    config={DEFAULT_CONFIG}
                    onSave={vi.fn(async () => null)}
                    t={key => key}
                />
            </AppThemeProvider>,
        );

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /settings\.shortcuts\.main.*Alt \+ V/ }));
        await user.keyboard("k");

        const alert = await screen.findByRole("alert");
        const recorder = screen.getByRole("button", { name: /settings\.shortcuts\.main.*Alt \+ V/ });
        expect(alert).toHaveTextContent("settings.shortcut.requiresModifier");
        expect(recorder).toHaveAttribute("aria-describedby", alert.id);
    });
});
