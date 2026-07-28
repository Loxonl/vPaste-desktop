import { DEFAULT_LANGUAGE } from "../lang";
import type { ThemeMode } from "../theme";
import type { SettingsBridge } from "./SettingsBridge";
import {
    DEFAULT_MAIN_SHORTCUT,
    DEFAULT_PASTE_AS_TEXT_SHORTCUT,
} from "./shortcutDefaults";

export interface Shortcutkey {
    main_window?: string;
    copy_and_show_shortcut?: string;
    copy_and_exec_shortcut?: string;
    translate?: string;
    preview?: string;
    paste_into_plain_text?: string;
    quick_selection?: string;
}

export interface ConfigData {
    startup: boolean;
    display_tray_icon: boolean;
    multilingual: string;
    theme_mode: ThemeMode;
    storage_history: number;
    storage_dir: string;
    retain_search_history: boolean;
    retain_last_position: boolean;
    retain_tab_position: boolean;
    link_auto_preview: boolean;
    sensitive_content_protection: boolean;
    quick_input_enabled: boolean;
    tab_quick_select_enabled: boolean;
    onboarding_completed: boolean;
    update_check_enabled: boolean;
    last_update_check_at: string;
    ignored_update_version: string;
    ignored_app_sources: string[];
    shortcut_keys: Shortcutkey;
}

export interface StoragePaths {
    app_data_dir: string;
    history_storage_dir: string;
}

export interface StorageCleanupInfo {
    bytes: number;
    items: number;
}

export interface StorageMigrationInfo {
    migrated: boolean;
    source_dir: string;
    target_dir: string;
    merged_items: number;
    skipped_items: number;
    copied_files: number;
    backup_dir: string;
    message: string;
    shortcut_conflict?: boolean;
}

export interface ShortcutRegistrationInfo {
    registered: boolean;
    conflict: boolean;
}

export interface HistoryArchiveInfo {
    archive_path: string;
    merged_items: number;
    skipped_items: number;
    copied_files: number;
    message: string;
}

export interface HistoryArchiveProgressPayload {
    operation: "export" | "import";
    stage: string;
    processed_files: number;
    total_files: number;
    processed_bytes: number;
    total_bytes: number;
}

export type PermissionId = "background" | "paste";

export interface PermissionItemStatus {
    done: boolean;
    needs_settings: boolean;
    error?: string | null;
}

export interface PermissionStatus {
    background: PermissionItemStatus;
    paste: PermissionItemStatus;
}

export type TFunction = (key: string, params?: Record<string, string | number>) => string;
export type LanguageOption = { value: string; label: string };
export type SettingsBlockingOperation = {
    title: string;
    description: string;
    progress?: number | null;
};

export interface SettingsSectionProps {
    bridge: SettingsBridge;
    config: ConfigData;
    onSave: (config: ConfigData) => Promise<StorageMigrationInfo | null>;
    t: TFunction;
}

export const DEFAULT_CONFIG: ConfigData = {
    startup: true,
    display_tray_icon: true,
    multilingual: DEFAULT_LANGUAGE,
    theme_mode: "system",
    storage_history: 0,
    storage_dir: "",
    retain_search_history: false,
    retain_last_position: false,
    retain_tab_position: false,
    link_auto_preview: true,
    sensitive_content_protection: true,
    quick_input_enabled: true,
    tab_quick_select_enabled: true,
    onboarding_completed: false,
    update_check_enabled: true,
    last_update_check_at: "",
    ignored_update_version: "",
    ignored_app_sources: [],
    shortcut_keys: {
        main_window: DEFAULT_MAIN_SHORTCUT,
        paste_into_plain_text: DEFAULT_PASTE_AS_TEXT_SHORTCUT,
    },
};

export function parseSettingsConfig(raw: string): ConfigData {
    const parsed = JSON.parse(raw) as Partial<ConfigData>;
    const shortcutKeys = parsed.shortcut_keys ?? {};

    return {
        ...DEFAULT_CONFIG,
        ...parsed,
        ignored_app_sources: Array.isArray(parsed.ignored_app_sources)
            ? parsed.ignored_app_sources
            : [],
        theme_mode: parsed.theme_mode || DEFAULT_CONFIG.theme_mode,
        shortcut_keys: {
            ...DEFAULT_CONFIG.shortcut_keys,
            ...shortcutKeys,
            paste_into_plain_text:
                shortcutKeys.paste_into_plain_text
                ?? DEFAULT_CONFIG.shortcut_keys.paste_into_plain_text,
        },
    };
}
