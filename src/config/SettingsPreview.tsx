import * as React from "react";
import Config from "./Config";
import type { SettingsBridge } from "./SettingsBridge";
import { DEFAULT_CONFIG } from "./settingsTypes";
import type { UpdateState } from "../update";

function readPreviewConfig() {
    const params = new URLSearchParams(window.location.search);
    const theme = params.get("theme");
    const language = params.get("lang");

    return {
        ...DEFAULT_CONFIG,
        multilingual: language === "en-US" ? "English" : "Chinese",
        theme_mode: theme === "dark" ? "dark" as const : "light" as const,
    };
}

const previewUpdateState: UpdateState = {
    status: "idle",
    currentVersion: "1.6.0",
    availableVersion: null,
    downloadedBytes: 0,
    totalBytes: null,
    installTiming: null,
    error: null,
    portable: false,
    feedEnabled: true,
    releaseUrl: "https://github.com/Loxonl/vPaste-desktop/releases",
};

function createPreviewBridge(): SettingsBridge {
    let config = readPreviewConfig();

    const invoke: SettingsBridge["invoke"] = async <T,>(
        command: string,
        args?: unknown,
    ): Promise<T> => {
        let result: unknown;

        switch (command) {
            case "get_config":
                result = JSON.stringify(config);
                break;
            case "list_language_packs":
                result = [];
                break;
            case "save_config":
                config = JSON.parse(String((args as { config?: unknown } | undefined)?.config));
                result = {
                    migrated: false,
                    source_dir: "",
                    target_dir: "",
                    merged_items: 0,
                    skipped_items: 0,
                    copied_files: 0,
                    backup_dir: "",
                    message: "",
                };
                break;
            case "get_app_data_dir":
                result = "C:\\Users\\demo\\AppData\\Roaming\\com.vpaste.app";
                break;
            case "get_storage_paths":
                result = {
                    app_data_dir: "C:\\Users\\demo\\AppData\\Roaming\\com.vpaste.app",
                    history_storage_dir: "C:\\Users\\demo\\Documents\\vPaste",
                };
                break;
            case "list_recent_app_source_options":
                result = [
                    { source: "Code.exe", icon_path: null },
                    { source: "chrome.exe", icon_path: null },
                    { source: "msedge.exe", icon_path: null },
                    { source: "firefox.exe", icon_path: null },
                    { source: "explorer.exe", icon_path: null },
                    { source: "winword.exe", icon_path: null },
                    { source: "excel.exe", icon_path: null },
                    { source: "powerpnt.exe", icon_path: null },
                    { source: "notion.exe", icon_path: null },
                    { source: "obsidian.exe", icon_path: null },
                    { source: "wechat.exe", icon_path: null },
                    { source: "dingtalk.exe", icon_path: null },
                    { source: "feishu.exe", icon_path: null },
                    { source: "slack.exe", icon_path: null },
                    { source: "teams.exe", icon_path: null },
                    { source: "telegram.exe", icon_path: null },
                    { source: "discord.exe", icon_path: null },
                    { source: "idea64.exe", icon_path: null },
                ];
                break;
            case "estimate_storage_cleanup":
                result = { bytes: 24_870_912, items: 148 };
                break;
            case "get_update_state":
            case "check_for_app_update":
            case "prepare_app_update":
            case "schedule_app_update":
                result = previewUpdateState;
                break;
            default:
                result = null;
        }

        return result as T;
    };

    return {
        invoke,
        listen: async () => () => undefined,
        open: async () => null,
        save: async () => null,
        convertFileSrc: path => path,
        startWindowDragging: async () => undefined,
        hideWindow: async () => undefined,
    };
}

export default function SettingsPreview() {
    const bridge = React.useMemo(createPreviewBridge, []);
    return <Config bridge={bridge} />;
}
