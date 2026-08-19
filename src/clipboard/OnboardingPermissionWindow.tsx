import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import Button from "@mui/material/Button";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import appIcon from "../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import authorizeTips from "../assets/tutorial/authorize-tips.png";
import backgroundAuthorizeTips from "../assets/tutorial/background-authorize-tips.png";
import { useLanguage } from "../lang";
import { loadAndApplyTheme, setThemePreview, type ResolvedTheme } from "../theme";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import {
    PENDING_PERMISSION_WINDOW_KEY,
    type TutorialPermissionId,
} from "./clipboardTutorial";
import styles from "./TutorialOverlay.module.css";

type PermissionWindowPayload = {
    permission: TutorialPermissionId;
    languageCode?: string;
    themePreview?: ResolvedTheme | null;
};

type PermissionStatus = {
    background: { done: boolean };
    paste: { done: boolean };
};

type PermissionItemStatus = { done: boolean; needs_settings?: boolean };

function isPermissionId(value: unknown): value is TutorialPermissionId {
    return value === "background" || value === "paste";
}

function PermissionGuideVisual({ id }: { id: TutorialPermissionId }) {
    const image = id === "background" ? backgroundAuthorizeTips : authorizeTips;
    return (
        <div className={`${styles["tutorial-guide-art"]} ${styles["tutorial-guide-art-permission-image"]}`} aria-hidden="true">
            <img className={styles["tutorial-guide-authorize-tips"]} src={image} alt="" />
        </div>
    );
}

export default function OnboardingPermissionWindow() {
    const { t, setLanguageCode } = useLanguage();
    const initialPermission = new URLSearchParams(window.location.search).get("permission");
    const [permission, setPermission] = useState<TutorialPermissionId | null>(
        isPermissionId(initialPermission) ? initialPermission : null,
    );
    const [pending, setPending] = useState(false);
    const [actionError, setActionError] = useState("");

    const applyPayload = (payload: PermissionWindowPayload) => {
        if (!isPermissionId(payload.permission)) return;
        setPermission(payload.permission);
        setPending(false);
        setActionError("");
        if (payload.languageCode) {
            setLanguageCode(payload.languageCode);
        }
        setThemePreview(payload.themePreview === "light" || payload.themePreview === "dark"
            ? payload.themePreview
            : null);
        localStorage.removeItem(PENDING_PERMISSION_WINDOW_KEY);
        void loadAndApplyTheme();
    };

    const applyPendingPayload = () => {
        const raw = localStorage.getItem(PENDING_PERMISSION_WINDOW_KEY);
        if (!raw) return;
        try {
            applyPayload(JSON.parse(raw) as PermissionWindowPayload);
        } catch (e) {
            error(`Failed to parse onboarding permission payload: ${e}`);
        }
    };

    const closeWindow = async (restoreParent: boolean = true) => {
        await invoke("hide_onboarding_permission_window", { restoreParent });
    };

    const notifyStatusChanged = async () => {
        if (!permission) return;
        await invoke("notify_onboarding_permission_status_changed", { permission });
    };

    const finishIfGranted = async () => {
        if (!permission || pending) return false;
        try {
            const status = await invoke<PermissionStatus>("get_onboarding_permission_status");
            if (!status[permission].done) return false;
            await notifyStatusChanged();
            await closeWindow(true);
            return true;
        } catch (e) {
            error(`Failed to refresh onboarding permission window: ${e}`);
            return false;
        }
    };

    useEffect(() => {
        const queryLanguage = new URLSearchParams(window.location.search).get("languageCode");
        if (queryLanguage) {
            setLanguageCode(queryLanguage);
        }
        applyPendingPayload();
        const unlisten = listen<PermissionWindowPayload>("onboarding-permission-open", event => {
            applyPayload(event.payload);
        });
        const handleFocus = () => {
            applyPendingPayload();
            void finishIfGranted();
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                applyPendingPayload();
                void finishIfGranted();
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !pending) {
                event.preventDefault();
                void closeWindow(true);
            }
        };
        window.addEventListener("focus", handleFocus);
        window.addEventListener("keydown", handleKeyDown);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten onboarding permission window: ${e}`));
            window.removeEventListener("focus", handleFocus);
            window.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [pending, permission]);

    const runAction = async () => {
        if (!permission || pending) return;
        setPending(true);
        setActionError("");
        try {
            if (permission === "paste") {
                await invoke("ensure_paste_accessibility_permission");
                await invoke("open_accessibility_settings");
            } else {
                await invoke<PermissionItemStatus>("enable_onboarding_background_service");
                await notifyStatusChanged();
            }
        } catch (e) {
            setActionError(t("clipboard.actionFailed", { error: String(e) }));
            error(`Failed to enable onboarding permission ${permission}: ${e}`);
        } finally {
            setPending(false);
        }
    };

    if (!permission) {
        return <main className={styles["permission-guide-window-root"]} />;
    }

    return (
        <main className={styles["permission-guide-window-root"]}>
            <section
                className={`${styles["tutorial-guide-dialog"]} ${styles["permission-guide-standalone-dialog"]}`}
                aria-labelledby="tutorial-guide-title"
                aria-describedby="tutorial-guide-description"
            >
                <ToolbarIconButton
                    size="medium"
                    className={styles["tutorial-guide-close"]}
                    label={t("tutorial.permission.guide.close")}
                    disabled={pending}
                    onClick={() => void closeWindow(true)}
                >
                    <CloseRoundedIcon />
                </ToolbarIconButton>
                <div className={styles["tutorial-guide-copy"]}>
                    <span className={styles["tutorial-guide-logo"]}><img src={appIcon} alt="vPaste" /></span>
                    <div>
                        <h1 id="tutorial-guide-title">{t(`tutorial.permission.guide.${permission}.title`)}</h1>
                        <p id="tutorial-guide-description">{t(`tutorial.permission.guide.${permission}.desc`)}</p>
                    </div>
                </div>
                <PermissionGuideVisual id={permission} />
                <div className={styles["tutorial-guide-actions"]}>
                    <Button
                        variant="contained"
                        className={styles["tutorial-guide-primary"]}
                        disabled={pending}
                        onClick={() => void runAction()}
                    >
                        {pending
                            ? t("tutorial.permission.guide.working")
                            : t(`tutorial.permission.guide.${permission}.action`)}
                        <ArrowOutwardRoundedIcon />
                    </Button>
                    <Button
                        variant="text"
                        className={styles["tutorial-guide-later"]}
                        disabled={pending}
                        onClick={() => void closeWindow(true)}
                    >
                        {t("tutorial.permission.guide.notNow")}
                    </Button>
                    {actionError && <p className={styles["permission-guide-error"]} role="alert">{actionError}</p>}
                </div>
            </section>
        </main>
    );
}
