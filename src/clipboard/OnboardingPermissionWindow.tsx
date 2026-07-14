import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import aboutLogo from "../assets/about-logo.png";
import authorizeTips from "../assets/tutorial/authorize-tips.png";
import { useLanguage } from "../lang";
import { loadAndApplyTheme } from "../theme";
import type { TutorialPermissionId } from "./TutorialOverlay";
import "./TutorialOverlay.css";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type PermissionWindowPayload = {
    permission: TutorialPermissionId;
    languageCode?: string;
};

type PermissionStatus = {
    background: { done: boolean };
    paste: { done: boolean };
};

type PermissionItemStatus = { done: boolean; needs_settings?: boolean };

const PENDING_PERMISSION_WINDOW_KEY = "vpaste.pendingOnboardingPermission.v1";

function isPermissionId(value: unknown): value is TutorialPermissionId {
    return value === "background" || value === "paste";
}

function PermissionGuideVisual({ id, t }: { id: TutorialPermissionId; t: TFunction }) {
    const isBackground = id === "background";
    if (!isBackground) {
        return (
            <div className="tutorial-guide-art tutorial-guide-art-paste" aria-hidden="true">
                <img className="tutorial-guide-authorize-tips" src={authorizeTips} alt="" />
            </div>
        );
    }

    const panelTitle = t(`tutorial.permission.guide.${id}.panel`);
    const settingLabel = t(`tutorial.permission.guide.${id}.setting`);

    return (
        <div className={`tutorial-guide-art tutorial-guide-art-${id}`} aria-hidden="true">
            <div className="tutorial-guide-window">
                <div className="tutorial-guide-toolbar">
                    <span className="tutorial-guide-traffic-lights"><i /><i /><i /></span>
                    <strong>{t("tutorial.permission.guide.systemSettings")}</strong>
                    <span />
                </div>
                <div className="tutorial-guide-background-stage">
                    <div className="tutorial-guide-background-heading">
                        <small>{t("tutorial.permission.guide.general")}</small>
                        <strong>{panelTitle}</strong>
                    </div>
                    <span className="tutorial-guide-background-section">{settingLabel}</span>
                    <div className="tutorial-guide-settings-card">
                        <span className="tutorial-guide-brand-icon"><img src={aboutLogo} alt="" /></span>
                        <span className="tutorial-guide-setting-copy">
                            <strong>vPaste</strong>
                            <small>{t("tutorial.permission.guide.background.itemDesc")}</small>
                        </span>
                        <span className="tutorial-guide-switch on"><i /></span>
                    </div>
                    <span className="tutorial-guide-callout">{t("tutorial.permission.guide.background.callout")}</span>
                </div>
            </div>
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
        return <main className="permission-guide-window-root" />;
    }

    return (
        <main className="permission-guide-window-root">
            <section
                className="tutorial-guide-dialog permission-guide-standalone-dialog"
                aria-labelledby="tutorial-guide-title"
                aria-describedby="tutorial-guide-description"
            >
                <button
                    type="button"
                    className="tutorial-guide-close"
                    aria-label={t("tutorial.permission.guide.close")}
                    disabled={pending}
                    onClick={() => void closeWindow(true)}
                >
                    <CloseRoundedIcon />
                </button>
                <div className="tutorial-guide-copy">
                    <span className="tutorial-guide-logo"><img src={aboutLogo} alt="vPaste" /></span>
                    <div>
                        <span className="tutorial-guide-kicker">{t(`tutorial.permission.${permission}`)}</span>
                        <h1 id="tutorial-guide-title">{t(`tutorial.permission.guide.${permission}.title`)}</h1>
                        <p id="tutorial-guide-description">{t(`tutorial.permission.guide.${permission}.desc`)}</p>
                    </div>
                </div>
                <PermissionGuideVisual id={permission} t={t} />
                <div className="tutorial-guide-actions">
                    <button
                        type="button"
                        className="tutorial-guide-primary"
                        disabled={pending}
                        onClick={() => void runAction()}
                    >
                        {pending
                            ? t("tutorial.permission.guide.working")
                            : t(`tutorial.permission.guide.${permission}.action`)}
                        <ArrowOutwardRoundedIcon />
                    </button>
                    <button
                        type="button"
                        className="tutorial-guide-later"
                        disabled={pending}
                        onClick={() => void closeWindow(true)}
                    >
                        {t("tutorial.permission.guide.notNow")}
                    </button>
                    {actionError && <p className="permission-guide-error" role="alert">{actionError}</p>}
                </div>
            </section>
        </main>
    );
}
