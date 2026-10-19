import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShortcutSettings from "../../../src/config/sections/ShortcutSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("Shortcut settings recorder", () => {
    it("records Windows + V from the native interceptor and releases recording on completion", async () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
        let recorded: ((event: { payload: string }) => void) | undefined;
        const unlisten = vi.fn();
        const invoke = vi.fn(async () => ({ registered: true, conflict: false }));
        const bridge: SettingsBridge = {
            invoke: invoke as SettingsBridge["invoke"],
            listen: vi.fn(async (_name, handler) => {
                recorded = handler;
                return unlisten;
            }) as SettingsBridge["listen"],
            open: vi.fn(), save: vi.fn(), convertFileSrc: vi.fn(path => path),
            startWindowDragging: vi.fn(), hideWindow: vi.fn(),
        };
        const onSave = vi.fn(async () => null);
        render(<AppThemeProvider><ShortcutSettings bridge={bridge} config={DEFAULT_CONFIG} onSave={onSave} t={key => key} /></AppThemeProvider>);
        await userEvent.setup().click(screen.getByRole("button", { name: /settings\.shortcuts\.main.*Alt \+ V/ }));
        await screen.findByRole("button", { name: /settings\.shortcuts\.main.*settings\.shortcut\.recording/ });
        expect(bridge.listen).toHaveBeenCalledWith("main-shortcut-recorded", expect.any(Function));
        fireEvent.keyDown(screen.getByRole("button", { name: /settings\.shortcuts\.main.*settings\.shortcut\.recording/ }), {
            key: "Unidentified", code: "", keyCode: 0xE8, metaKey: true,
        });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        act(() => recorded?.({ payload: "Super+V" }));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            shortcut_keys: { ...DEFAULT_CONFIG.shortcut_keys, main_window: "Super+V" },
        })));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("end_main_shortcut_recording"));
        expect(unlisten).toHaveBeenCalled();
    });

    it.each(["Win32", "MacIntel"])("applies the Win+V policy on %s", async platform => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
        const bridge: SettingsBridge = {
            invoke: vi.fn(async () => ({ registered: true, conflict: false })) as SettingsBridge["invoke"],
            listen: vi.fn(async () => () => undefined) as SettingsBridge["listen"],
            open: vi.fn(), save: vi.fn(), convertFileSrc: vi.fn(path => path),
            startWindowDragging: vi.fn(), hideWindow: vi.fn(),
        };
        const onSave = vi.fn(async () => null);
        render(<AppThemeProvider><ShortcutSettings bridge={bridge} config={DEFAULT_CONFIG} onSave={onSave} t={key => key} /></AppThemeProvider>);
        await userEvent.setup().click(screen.getByRole("button", { name: /settings\.shortcuts\.main/ }));
        const recorder = await screen.findByRole("button", { name: /settings\.shortcuts\.main.*settings\.shortcut\.recording/ });
        fireEvent.keyDown(recorder, { key: "v", code: "KeyV", metaKey: true });
        if (platform === "Win32") {
            await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
                shortcut_keys: { ...DEFAULT_CONFIG.shortcut_keys, main_window: "Super+V" },
            })));
        } else {
            expect(await screen.findByRole("alert")).toHaveTextContent("settings.shortcut.unsupportedSystem");
            expect(onSave).not.toHaveBeenCalled();
        }
    });

    it.each(["escape", "blur", "window-blur", "unmount"])("releases native recording on %s and ignores late events", async action => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
        let recorded: ((event: { payload: string }) => void) | undefined;
        const unlisten = vi.fn();
        const invoke = vi.fn(async () => ({ registered: true, conflict: false }));
        const bridge: SettingsBridge = {
            invoke: invoke as SettingsBridge["invoke"],
            listen: vi.fn(async (_name, handler) => { recorded = handler; return unlisten; }) as SettingsBridge["listen"],
            open: vi.fn(), save: vi.fn(), convertFileSrc: vi.fn(path => path),
            startWindowDragging: vi.fn(), hideWindow: vi.fn(),
        };
        const onSave = vi.fn(async () => null);
        const view = render(<AppThemeProvider><ShortcutSettings bridge={bridge} config={DEFAULT_CONFIG} onSave={onSave} t={key => key} /></AppThemeProvider>);
        await userEvent.setup().click(screen.getByRole("button", { name: /settings\.shortcuts\.main/ }));
        const recorder = await screen.findByRole("button", { name: /settings\.shortcuts\.main.*settings\.shortcut\.recording/ });
        if (action === "escape") fireEvent.keyDown(recorder, { key: "Escape" });
        if (action === "blur") fireEvent.blur(recorder);
        if (action === "window-blur") fireEvent.blur(window);
        if (action === "unmount") view.unmount();
        expect(unlisten).toHaveBeenCalledOnce();
        expect(invoke).toHaveBeenCalledWith("end_main_shortcut_recording");
        act(() => recorded?.({ payload: "Super+V" }));
        expect(onSave).not.toHaveBeenCalled();
    });

    it("keeps Win+V unavailable for the paste queue", async () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
        const bridge: SettingsBridge = {
            invoke: vi.fn(async () => null) as SettingsBridge["invoke"],
            listen: vi.fn(async () => () => undefined) as SettingsBridge["listen"],
            open: vi.fn(), save: vi.fn(), convertFileSrc: vi.fn(path => path),
            startWindowDragging: vi.fn(), hideWindow: vi.fn(),
        };
        const onSave = vi.fn(async () => null);
        render(<AppThemeProvider><ShortcutSettings bridge={bridge} config={DEFAULT_CONFIG} onSave={onSave} t={key => key} /></AppThemeProvider>);
        await userEvent.setup().click(screen.getByRole("button", { name: /settings\.shortcuts\.pasteQueue/ }));
        const recorder = await screen.findByRole("button", { name: /settings\.shortcuts\.pasteQueue.*settings\.shortcut\.recording/ });
        fireEvent.keyDown(recorder, { key: "v", metaKey: true });
        expect(await screen.findByRole("alert")).toHaveTextContent("settings.shortcut.unsupportedSystem");
        expect(onSave).not.toHaveBeenCalled();
    });

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
