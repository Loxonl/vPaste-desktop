import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clampRetainedScrollLeft,
    loadClipboardBehaviorConfig,
    mainShortcutFromConfig,
    resolveClipboardShowPreferences,
    resolveClipboardShowPlan,
} from "../../../src/clipboard/clipboardBehavior";
import {
    DEFAULT_MAIN_SHORTCUT,
    DEFAULT_PASTE_AS_TEXT_SHORTCUT,
} from "../../../src/config/shortcutDefaults";

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const logger = vi.hoisted(() => ({
    error: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/plugin-log", () => ({
    error: logger.error,
}));

describe("clipboard behavior preferences", () => {
    beforeEach(() => {
        tauri.invoke.mockReset();
        logger.error.mockReset();
    });

    it("loads the existing get_config payload without changing its shape", async () => {
        tauri.invoke.mockResolvedValue(JSON.stringify({
            onboarding_completed: true,
            retain_search_history: true,
            shortcut_keys: { main_window: "Ctrl+Space" },
        }));

        await expect(loadClipboardBehaviorConfig()).resolves.toEqual({
            onboarding_completed: true,
            retain_search_history: true,
            shortcut_keys: { main_window: "Ctrl+Space" },
        });
        expect(tauri.invoke).toHaveBeenCalledWith("get_config");
    });

    it("keeps the previous empty fallback when config cannot be read", async () => {
        tauri.invoke.mockResolvedValue("{invalid json");

        await expect(loadClipboardBehaviorConfig()).resolves.toEqual({});
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to load clipboard behavior config"),
        );
    });

    it("uses the established defaults when optional behavior fields are absent", () => {
        expect(resolveClipboardShowPreferences({}, "old search", "favorite")).toEqual({
            activeTab: "all",
            linkAutoPreview: true,
            pasteAsTextShortcut: DEFAULT_PASTE_AS_TEXT_SHORTCUT,
            quickInputEnabled: true,
            retainLastPosition: false,
            retainSearchHistory: false,
            retainTabPosition: false,
            searchWord: "",
            tabQuickSelectEnabled: true,
        });
        expect(mainShortcutFromConfig({})).toBe(DEFAULT_MAIN_SHORTCUT);
    });

    it("preserves retained search, tab, position, and custom shortcuts", () => {
        const config = {
            link_auto_preview: false,
            quick_input_enabled: false,
            retain_last_position: true,
            retain_search_history: true,
            retain_tab_position: true,
            tab_quick_select_enabled: false,
            shortcut_keys: {
                main_window: "Ctrl+Space",
                paste_into_plain_text: "Ctrl+Shift+V",
            },
        };

        expect(resolveClipboardShowPreferences(
            config,
            "retained search",
            "record-tag-5",
        )).toEqual({
            activeTab: "record-tag-5",
            linkAutoPreview: false,
            pasteAsTextShortcut: "Ctrl+Shift+V",
            quickInputEnabled: false,
            retainLastPosition: true,
            retainSearchHistory: true,
            retainTabPosition: true,
            searchWord: "retained search",
            tabQuickSelectEnabled: false,
        });
        expect(mainShortcutFromConfig(config)).toBe("Ctrl+Space");
    });

    it("resets only the panel state whose retention setting is disabled", () => {
        expect(resolveClipboardShowPlan({
            activeTab: "all",
            linkAutoPreview: true,
            pasteAsTextShortcut: "Shift+Enter",
            quickInputEnabled: true,
            retainLastPosition: true,
            retainSearchHistory: true,
            retainTabPosition: true,
            searchWord: "needle",
            tabQuickSelectEnabled: true,
        }, true)).toEqual({
            clearSearch: false,
            resetPosition: false,
            resetTab: false,
            restorePosition: true,
            selectFirstWithoutScrolling: false,
        });

        expect(resolveClipboardShowPlan({
            activeTab: "all",
            linkAutoPreview: true,
            pasteAsTextShortcut: "Shift+Enter",
            quickInputEnabled: true,
            retainLastPosition: false,
            retainSearchHistory: false,
            retainTabPosition: false,
            searchWord: "",
            tabQuickSelectEnabled: true,
        }, true)).toEqual({
            clearSearch: true,
            resetPosition: true,
            resetTab: true,
            restorePosition: false,
            selectFirstWithoutScrolling: false,
        });

        expect(resolveClipboardShowPlan({
            activeTab: "favorites",
            linkAutoPreview: true,
            pasteAsTextShortcut: "Shift+Enter",
            quickInputEnabled: true,
            retainLastPosition: true,
            retainSearchHistory: false,
            retainTabPosition: true,
            searchWord: "needle",
            tabQuickSelectEnabled: true,
        }, true)).toEqual({
            clearSearch: true,
            resetPosition: false,
            resetTab: false,
            restorePosition: true,
            selectFirstWithoutScrolling: false,
        });
    });

    it("keeps a valid retained scroll offset and selects without scrolling only when needed", () => {
        const preferences = resolveClipboardShowPreferences(
            { retain_last_position: true },
            "",
            "all",
        );

        expect(resolveClipboardShowPlan(preferences, false))
            .toMatchObject({
                restorePosition: true,
                selectFirstWithoutScrolling: true,
            });
        expect(clampRetainedScrollLeft(420, 1200, 600)).toBe(420);
        expect(clampRetainedScrollLeft(900, 1200, 600)).toBe(600);
        expect(clampRetainedScrollLeft(-20, 1200, 600)).toBe(0);
    });
});
