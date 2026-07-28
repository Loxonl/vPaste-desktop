import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import type { ConfigData } from "../config/settingsTypes";
import {
    DEFAULT_MAIN_SHORTCUT,
    DEFAULT_PASTE_AS_TEXT_SHORTCUT,
} from "../config/shortcutDefaults";

export type ClipboardBehaviorConfig = Partial<ConfigData>;

export type ClipboardShowPreferences = {
    activeTab: string;
    linkAutoPreview: boolean;
    pasteAsTextShortcut: string;
    quickInputEnabled: boolean;
    retainLastPosition: boolean;
    retainSearchHistory: boolean;
    retainTabPosition: boolean;
    searchWord: string;
    tabQuickSelectEnabled: boolean;
};

export async function loadClipboardBehaviorConfig(): Promise<ClipboardBehaviorConfig> {
    try {
        return JSON.parse(
            await invoke<string>("get_config"),
        ) as ClipboardBehaviorConfig;
    } catch (loadError) {
        error(`Failed to load clipboard behavior config: ${loadError}`);
        return {};
    }
}

export function mainShortcutFromConfig(
    config: ClipboardBehaviorConfig,
): string {
    return config.shortcut_keys?.main_window || DEFAULT_MAIN_SHORTCUT;
}

export function resolveClipboardShowPreferences(
    config: ClipboardBehaviorConfig,
    currentSearchWord: string,
    currentActiveTab: string,
): ClipboardShowPreferences {
    const retainSearchHistory = Boolean(config.retain_search_history);
    const retainTabPosition = Boolean(config.retain_tab_position);

    return {
        activeTab: retainTabPosition ? currentActiveTab : "all",
        linkAutoPreview: config.link_auto_preview !== false,
        pasteAsTextShortcut:
            config.shortcut_keys?.paste_into_plain_text
            || DEFAULT_PASTE_AS_TEXT_SHORTCUT,
        quickInputEnabled: config.quick_input_enabled !== false,
        retainLastPosition: Boolean(config.retain_last_position),
        retainSearchHistory,
        retainTabPosition,
        searchWord: retainSearchHistory ? currentSearchWord : "",
        tabQuickSelectEnabled: config.tab_quick_select_enabled !== false,
    };
}
