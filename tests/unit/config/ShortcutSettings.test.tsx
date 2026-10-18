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

describe("Win + V main window shortcut", () => {
    const WINDOWS = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" };
    const MACOS = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", platform: "MacIntel" };

    function renderSettings(platform: typeof WINDOWS) {
        vi.stubGlobal("navigator", { ...navigator, ...platform });
        const listeners = new Map<string, (event: { payload: string }) => void>();
        const unlisten = vi.fn();
        const invoke = vi.fn(async (command: string) => {
            if (command === "check_main_shortcut_registration") return { registered: true, conflict: false };
            return null;
        });
        const bridge: SettingsBridge = {
            invoke: invoke as SettingsBridge["invoke"],
            listen: vi.fn(async (name: string, handler: (event: { payload: string }) => void) => {
                listeners.set(name, handler);
                return () => {
                    listeners.delete(name);
                    unlisten();
                };
            }) as unknown as SettingsBridge["listen"],
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
        return { listeners, unlisten, onSave };
    }

    afterEach(() => vi.unstubAllGlobals());

    it("saves Win + V reported by the keyboard hook while recording on Windows", async () => {
        const { listeners, unlisten, onSave } = renderSettings(WINDOWS);
        expect(screen.getByText("settings.shortcuts.main.winVHint")).toBeInTheDocument();
        expect(listeners.has("win-v-shortcut-recorded")).toBe(false);

        await userEvent.setup().click(screen.getByRole("button", { name: /settings\.shortcuts\.main.*Alt \+ V/ }));
        await waitFor(() => expect(listeners.has("win-v-shortcut-recorded")).toBe(true));
        listeners.get("win-v-shortcut-recorded")?.({ payload: "Super+V" });

        await waitFor(() => expect(onSave).toHaveBeenCalledWith({
            ...DEFAULT_CONFIG,
            shortcut_keys: {
                ...DEFAULT_CONFIG.shortcut_keys,
                main_window: "Super+V",
            },
        }));
        await waitFor(() => expect(unlisten).toHaveBeenCalled());
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps Command + V blocked on macOS", async () => {
        const { listeners, onSave } = renderSettings(MACOS);
        expect(screen.queryByText("settings.shortcuts.main.winVHint")).toBeNull();

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /settings\.shortcuts\.main/ }));
        await user.keyboard("{Meta>}v{/Meta}");

        expect(await screen.findByRole("alert")).toHaveTextContent("settings.shortcut.unsupportedSystem");
        expect(onSave).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
    });

    it("keeps Win + V blocked for the Paste Queue shortcut on Windows", async () => {
        const { onSave } = renderSettings(WINDOWS);

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /settings\.shortcuts\.pasteQueue/ }));
        await user.keyboard("{Meta>}v{/Meta}");

        expect(await screen.findByRole("alert")).toHaveTextContent("settings.shortcut.unsupportedSystem");
        expect(onSave).not.toHaveBeenCalled();
    });
});
