import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmojiPicker from "../../../src/clipboard/EmojiPicker";
import PasteFallbackNotice from "../../../src/clipboard/PasteFallbackNotice";
import Preview from "../../../src/clipboard/Preview";
import TabEditor from "../../../src/clipboard/TabEditor";
import TrayMenu from "../../../src/tray/TrayMenu";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

const render = (ui: ReactElement) => renderUi(<MotionTestProvider>{ui}</MotionTestProvider>);

const tauri = vi.hoisted(() => ({
    emit: vi.fn(),
    emitTo: vi.fn(),
    invoke: vi.fn(),
    listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
    emit: tauri.emit,
    emitTo: tauri.emitTo,
    listen: tauri.listen,
}));

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

vi.mock("../../../src/lang", () => ({
    useLanguage: () => ({
        languageCode: "Chinese",
        setLanguageCode: vi.fn(),
        t: (key: string) => key,
    }),
}));

vi.mock("../../../src/theme", () => ({
    loadAndApplyTheme: vi.fn(async () => undefined),
    setThemePreview: vi.fn(),
}));

vi.mock("../../../src/update", () => ({
    restartReady: () => false,
    useAppUpdateState: () => ({
        state: { status: "idle" },
        restartToUpdate: vi.fn(),
    }),
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("auxiliary window controls", () => {
    beforeEach(() => {
        localStorage.clear();
        tauri.emit.mockReset().mockResolvedValue(undefined);
        tauri.emitTo.mockReset().mockResolvedValue(undefined);
        tauri.invoke.mockReset().mockImplementation(async (command: string) => {
            if (command === "get_clipboard_history_paused") return false;
            if (command === "list_recent_app_source_options") return [];
            return undefined;
        });
        tauri.listen.mockReset().mockResolvedValue(() => undefined);
    });

    it("opens the permission settings from the fallback notice in the established order", async () => {
        const user = userEvent.setup();
        render(<PasteFallbackNotice />);

        await user.click(screen.getByRole("button", { name: "common.settings" }));

        expect(tauri.invoke.mock.calls.slice(-2)).toEqual([
            ["hide_paste_fallback_notice"],
            ["open_config_window", { target: "permissions" }],
        ]);
    });

    it("renders generic paste failure guidance without a permission action", () => {
        render(<PasteFallbackNotice showSettingsAction={false} />);

        expect(screen.getByRole("status")).toHaveTextContent(
            "clipboard.copyFallbackNotice",
        );
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("keeps Emoji selection on the existing event and close path", async () => {
        const user = userEvent.setup();
        render(<EmojiPicker />);

        await user.pointer({
            keys: "[MouseLeft]",
            target: screen.getByRole("menuitem", { name: "tabs.emojiPrefix 📋" }),
        });

        await waitFor(() => expect(tauri.emitTo).toHaveBeenCalledWith("tabEditor", "emoji-prefix-selected", "📋"));
        expect(tauri.emit).toHaveBeenCalledWith("emoji-prefix-selected", "📋");
        await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("hide_emoji_picker_window"));
    });

    it("keeps preview pin state and its Tauri command synchronized", async () => {
        const user = userEvent.setup();
        render(<Preview />);

        const pin = screen.getByRole("button", { name: "preview.pin" });
        await user.click(pin);
        expect(tauri.invoke).toHaveBeenLastCalledWith("set_preview_pinned", { pinned: true });
        expect(screen.getByRole("button", { name: "preview.unpin" })).toHaveAttribute("aria-pressed", "true");
    });

    it("uses the requested direction when preview content moves backward and forward", async () => {
        const listeners = new Map<string, (event: { payload: unknown }) => void>();
        tauri.listen.mockImplementation(async (event: string, callback: (event: { payload: unknown }) => void) => {
            listeners.set(event, callback);
            return () => undefined;
        });
        render(<Preview />);
        await waitFor(() => expect(listeners.has("preview-item")).toBe(true));

        act(() => {
            listeners.get("preview-item")?.({
                payload: { itemType: "Text", content: "First preview" },
            });
        });
        expect((await screen.findByText("First preview")).closest("[data-preview-direction]"))
            .toHaveAttribute("data-preview-direction", "neutral");

        fireEvent.keyDown(window, { key: "ArrowLeft" });
        expect(tauri.emitTo).toHaveBeenLastCalledWith(
            "clipboard",
            "preview-navigate-selection",
            { direction: -1, key: "ArrowLeft" },
        );
        act(() => {
            listeners.get("preview-item")?.({
                payload: { itemType: "Text", content: "Previous preview" },
            });
        });

        await waitFor(() => expect(screen.getByText("Previous preview")).toBeVisible());
        expect(screen.getByText("Previous preview").closest("[data-preview-direction]"))
            .toHaveAttribute("data-preview-direction", "backward");
        expect(screen.getByText("Previous preview").closest("[data-motion-preset]"))
            .toHaveAttribute("data-motion-preset", "preview");

        fireEvent.keyDown(window, { key: "ArrowRight" });
        act(() => {
            listeners.get("preview-item")?.({
                payload: { itemType: "Text", content: "Next preview" },
            });
        });
        await waitFor(() => expect(screen.getByText("Next preview")).toBeVisible());
        expect(screen.getByText("Next preview").closest("[data-preview-direction]"))
            .toHaveAttribute("data-preview-direction", "forward");
    });

    it("keeps the Emoji picker anchored to the editor trigger rectangle", async () => {
        const user = userEvent.setup();
        localStorage.setItem("vpaste.pendingTabEditorPayload", JSON.stringify({
            mode: "add",
            kind: "filter",
            tabs: [],
            languageCode: "Chinese",
        }));
        render(<TabEditor />);

        const trigger = await screen.findByRole("button", { name: "tabs.emojiPrefix" });
        vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
            x: 10,
            y: 20,
            width: 34,
            height: 32,
            top: 20,
            right: 44,
            bottom: 52,
            left: 10,
            toJSON: () => ({}),
        });
        await user.click(trigger);

        expect(tauri.invoke).toHaveBeenCalledWith("open_emoji_picker_window", expect.objectContaining({
            anchorLeft: 10,
            anchorTop: 20,
            anchorRight: 44,
            anchorBottom: 52,
        }));
    });

    it("keeps tray commands and dismissal in sequence", async () => {
        const user = userEvent.setup();
        const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
            const height = this.className.includes("tray-menu-frame") ? 184 : 168;
            return {
                x: 0,
                y: 0,
                width: 216,
                height,
                top: 0,
                right: 216,
                bottom: height,
                left: 0,
                toJSON: () => ({}),
            };
        });
        render(<TrayMenu />);

        await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("resize_tray_menu", {
            width: 216,
            height: 184,
        }));
        tauri.invoke.mockClear();

        await user.click(await screen.findByRole("menuitem", { name: "tray.settings" }));

        expect(tauri.invoke.mock.calls.slice(-2)).toEqual([
            ["open_config_window"],
            ["hide_tray_menu"],
        ]);
        bounds.mockRestore();
    });
});
