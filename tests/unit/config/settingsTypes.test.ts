import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseSettingsConfig } from "../../../src/config/settingsTypes";

describe("parseSettingsConfig", () => {
    it("uses automatic sizing for missing preferences and preserves existing manual sizes", () => {
        for (const clipboard_panel_size of [undefined, null, "extra_large", 0.8]) {
            expect(parseSettingsConfig(JSON.stringify({ clipboard_panel_size })).clipboard_panel_size).toBeNull();
        }
        for (const clipboard_panel_size of ["small", "medium", "large"]) {
            expect(parseSettingsConfig(JSON.stringify({ clipboard_panel_size })).clipboard_panel_size).toBe(clipboard_panel_size);
        }
    });
    it("merges persisted values with safe defaults", () => {
        expect(parseSettingsConfig(JSON.stringify({
            multilingual: "en-US",
            theme_mode: "dark",
            ignored_app_sources: null,
            shortcut_keys: { main_window: "Ctrl+Space" },
        }))).toMatchObject({
            multilingual: "en-US",
            theme_mode: "dark",
            ignored_app_sources: [],
            shortcut_keys: {
                main_window: "Ctrl+Space",
                paste_queue_toggle: DEFAULT_CONFIG.shortcut_keys.paste_queue_toggle,
                paste_into_plain_text: DEFAULT_CONFIG.shortcut_keys.paste_into_plain_text,
            },
        });
    });
});
