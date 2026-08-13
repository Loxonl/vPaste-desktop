import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseSettingsConfig } from "../../../src/config/settingsTypes";

describe("parseSettingsConfig", () => {
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
