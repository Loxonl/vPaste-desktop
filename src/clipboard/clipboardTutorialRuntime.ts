import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import { isMacPlatform } from "../shortcutDisplay";
import { getThemePreview } from "../theme";
import {
    loadClipboardBehaviorConfig,
    mainShortcutFromConfig,
} from "./clipboardBehavior";
import {
    PENDING_PERMISSION_WINDOW_KEY,
    type TutorialPermissionId,
    type TutorialPermissionStatus,
    type TutorialPlatform,
} from "./clipboardTutorial";

type ClipboardTutorialRuntimeOptions = {
    incrementRunId: () => void;
    isActive: () => boolean;
    languageCode: string;
    onActionError: (actionError: unknown) => void;
    onBeforeStart: () => void;
    onComplete: () => void;
    onHideWindow: () => Promise<void>;
    setActive: (active: boolean) => void;
    setMainShortcut: (shortcut: string) => void;
    setPermissionStatus: (
        status: TutorialPermissionStatus | null,
    ) => void;
    setPlatform: (platform: TutorialPlatform) => void;
};

export function createClipboardTutorialRuntime(
    options: ClipboardTutorialRuntimeOptions,
) {
    const refreshPermissionStatus =
        async (): Promise<TutorialPermissionStatus | null> => {
            try {
                const status = await invoke<TutorialPermissionStatus>(
                    "get_onboarding_permission_status",
                );
                options.setPermissionStatus(status);
                return status;
            } catch (refreshError) {
                error(
                    `Failed to refresh tutorial permission status: ${refreshError}`,
                );
                return null;
            }
        };

    const refreshConfig = async () => {
        const config = await loadClipboardBehaviorConfig();
        options.setMainShortcut(mainShortcutFromConfig(config));
        return config;
    };

    const start = async (
        platform: TutorialPlatform =
            isMacPlatform() ? "mac" : "windows",
    ) => {
        options.onBeforeStart();
        options.setPlatform(platform);
        options.incrementRunId();
        options.setActive(true);
        void refreshConfig();
        if (platform === "mac") {
            options.setPermissionStatus(null);
            void refreshPermissionStatus();
        }
    };

    const openPermission = async (id: TutorialPermissionId) => {
        try {
            const payload = {
                permission: id,
                languageCode: options.languageCode,
                themePreview: getThemePreview(),
            };
            localStorage.setItem(
                PENDING_PERMISSION_WINDOW_KEY,
                JSON.stringify(payload),
            );
            await options.onHideWindow();
            await invoke("open_onboarding_permission_window", payload);
        } catch (actionError) {
            options.onActionError(actionError);
        }
    };

    const complete = async () => {
        try {
            await invoke("complete_onboarding");
            options.setActive(false);
            options.onComplete();
        } catch (actionError) {
            options.onActionError(actionError);
        }
    };

    const markCompleted = () => {
        options.setActive(false);
    };

    const initialize = () => {
        if (isMacPlatform()) {
            void refreshPermissionStatus();
        }
        void loadClipboardBehaviorConfig()
            .then(config => {
                if (
                    config.onboarding_completed === false
                    && !options.isActive()
                ) {
                    void start();
                }
            })
            .catch(initializeError => {
                error(`Failed to check tutorial state: ${initializeError}`);
            });
    };

    return {
        complete,
        initialize,
        markCompleted,
        openPermission,
        refreshPermissionStatus,
        start,
    };
}
