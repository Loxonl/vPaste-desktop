import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import Alert from "@mui/material/Alert";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { notifyAuxiliaryWindowReady } from "../auxiliaryWindowReady";
import TutorialOverlay from "../clipboard/TutorialOverlay";
import {
    buildTutorialFilterTabs,
    buildTutorialPermissions,
    createDefaultTutorialFilterTabs,
    updateTutorialFilterTabs,
    type TutorialPermissionStatus,
    type TutorialPlatform,
} from "../clipboard/clipboardTutorial";
import { useLanguage } from "../lang";
import { formatShortcutLabel } from "../shortcutDisplay";
import { setThemePreview, type ResolvedTheme } from "../theme";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import appIcon from "../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import styles from "./DeveloperTutorialWindow.module.css";

type Preview = {
    platform: TutorialPlatform;
    languageCode: string;
    themePreview: ResolvedTheme;
    shortcut: string;
};

// This preview leaves the real onboarding policy and user preferences alone.
const keepShortcutPolicy = () => {};

export default function DeveloperTutorialWindow() {
    const { t, setPreviewLanguageCode } = useLanguage();
    const [preview, setPreview] = useState<Preview | null>(null);
    const [run, setRun] = useState(0);
    const [tabs, setTabs] = useState(() => createDefaultTutorialFilterTabs(t));
    const [permissions, setPermissions] = useState<TutorialPermissionStatus | null>(null);
    const [message, setMessage] = useState("");
    const report = (reason: unknown) => setMessage(String(reason));
    const close = () => { void invoke("close_dev_tutorial_window").catch(report); };

    useEffect(() => {
        const unlisten = listen<Preview>("dev-tutorial-open", event => {
            const payload = event.payload;
            if (!["windows", "mac"].includes(payload.platform)) return;
            setPreviewLanguageCode(payload.languageCode);
            setThemePreview(payload.themePreview);
            setPreview(payload);
            setRun(value => value + 1);
            setTabs(createDefaultTutorialFilterTabs(t));
            setMessage("");
        });
        const cancelReady = notifyAuxiliaryWindowReady([unlisten]);
        return () => {
            cancelReady();
            void unlisten.then(remove => remove()).catch(reason => error(String(reason)));
        };
    }, [setPreviewLanguageCode]);

    useEffect(() => {
        let active = true;
        const refresh = () => {
            void invoke<TutorialPermissionStatus>("get_onboarding_permission_status")
                .then(status => { if (active) setPermissions(status); })
                .catch(reason => { if (active) report(reason); });
        };
        refresh();
        window.addEventListener("focus", refresh);
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") void invoke("close_dev_tutorial_window").catch(report);
        };
        window.addEventListener("keydown", onKey);
        return () => {
            active = false;
            window.removeEventListener("focus", refresh);
            window.removeEventListener("keydown", onKey);
        };
    }, []);

    return <main className={styles.window}>
        <div className={styles.header}>
            <span>DEV · {preview?.platform === "windows" ? "Windows" : "Mac"}</span>
            <ToolbarIconButton label={t("common.close")} onClick={close}><CloseRoundedIcon /></ToolbarIconButton>
        </div>
        {message ? <Alert severity="error">{message}</Alert> : null}
        <div className={styles.content}>
            {preview ? <TutorialOverlay key={run} t={t} logoSrc={appIcon}
                platform={preview.platform}
                shortcutText={formatShortcutLabel(preview.shortcut, preview.platform === "mac")}
                permissions={buildTutorialPermissions(permissions, t)}
                filters={buildTutorialFilterTabs(tabs, t)}
                onToggleFilter={(id, enabled) => setTabs(current => updateTutorialFilterTabs(current, id, enabled, t))}
                onPermissionAction={async permission => {
                    try {
                        await invoke("open_onboarding_permission_window", {
                            permission, languageCode: preview.languageCode, themePreview: preview.themePreview,
                        });
                    } catch (reason) { report(reason); }
                }}
                onShortcutDemoAvailabilityChange={keepShortcutPolicy}
                onComplete={close} /> : null}
        </div>
    </main>;
}
