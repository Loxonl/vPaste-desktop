import React from "react";
import { gsap } from "gsap";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RocketLaunchOutlinedIcon from "@mui/icons-material/RocketLaunchOutlined";
import SettingsSuggestOutlinedIcon from "@mui/icons-material/SettingsSuggestOutlined";
import KeyboardCommandKeyOutlinedIcon from "@mui/icons-material/KeyboardCommandKeyOutlined";
import startupVisual from "../assets/tutorial/permission-startup.svg";
import backgroundVisual from "../assets/tutorial/permission-background.svg";
import pasteVisual from "../assets/tutorial/permission-paste.svg";
import "./TutorialOverlay.css";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

export type TutorialPermissionId = "startup" | "background" | "paste";
export type TutorialFilterId = "text" | "image" | "link" | "color" | "file";

export type TutorialPermission = {
    id: TutorialPermissionId;
    title: string;
    description: string;
    done: boolean;
    actionLabel: string;
};

export type TutorialFilterTab = {
    id: TutorialFilterId;
    name: string;
    enabled: boolean;
};

type TutorialOverlayProps = {
    t: TFunction;
    logoSrc: string;
    shortcutText: string;
    permissions: TutorialPermission[];
    filters: TutorialFilterTab[];
    onPermissionAction: (id: TutorialPermissionId) => void;
    onToggleFilter: (id: TutorialFilterId, enabled: boolean) => void;
    onComplete: () => void;
};

const permissionVisuals: Record<TutorialPermissionId, string> = {
    startup: startupVisual,
    background: backgroundVisual,
    paste: pasteVisual,
};

export default function TutorialOverlay({
    t,
    logoSrc,
    shortcutText,
    permissions,
    filters,
    onPermissionAction,
    onToggleFilter,
    onComplete,
}: TutorialOverlayProps) {
    const rootRef = React.useRef<HTMLDivElement>(null);
    const [step, setStep] = React.useState(0);

    React.useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let reduceMotionTimer: number | null = null;
        const ctx = gsap.context(() => {
            if (step === 0) {
                if (reduceMotion) {
                    reduceMotionTimer = window.setTimeout(() => setStep(1), 1400);
                    return;
                }

                gsap.timeline({ defaults: { ease: "power3.inOut" } })
                    .fromTo(
                        ".tutorial-welcome",
                        { xPercent: 120, autoAlpha: 0, scale: 0.98 },
                        { xPercent: 0, autoAlpha: 1, scale: 1, duration: 0.82 },
                    )
                    .fromTo(
                        ".tutorial-welcome-orbit",
                        { rotate: -8, scale: 0.92 },
                        { rotate: 0, scale: 1, duration: 0.72, ease: "back.out(1.3)" },
                        "<0.12",
                    )
                    .to(".tutorial-welcome", { xPercent: -120, autoAlpha: 0, duration: 0.7 }, "+=1.65")
                    .call(() => setStep(1));
                return;
            }

            if (reduceMotion) return;
            gsap.timeline({ defaults: { ease: "power3.out" } })
                .fromTo(
                    ".tutorial-panel",
                    { x: 72, autoAlpha: 0 },
                    { x: 0, autoAlpha: 1, duration: 0.48 },
                )
                .fromTo(
                    ".tutorial-animate-item",
                    { y: 18, autoAlpha: 0, scale: 0.98 },
                    { y: 0, autoAlpha: 1, scale: 1, duration: 0.42, stagger: 0.06 },
                    "<0.12",
                );
        }, root);

        return () => {
            if (reduceMotionTimer !== null) {
                window.clearTimeout(reduceMotionTimer);
            }
            ctx.revert();
        };
    }, [step]);

    return (
        <div className="tutorial-root" ref={rootRef}>
            {step === 0 && (
                <section className="tutorial-welcome" aria-live="polite">
                    <div className="tutorial-welcome-orbit">
                        <img src={logoSrc} alt="vPaste" />
                    </div>
                    <div>
                        <h1>Welcome to vPaste</h1>
                        <p>Your clipboard, always one shortcut away.</p>
                    </div>
                </section>
            )}

            {step === 1 && (
                <section className="tutorial-panel tutorial-permissions">
                    <div className="tutorial-panel-heading tutorial-animate-item">
                        <RocketLaunchOutlinedIcon fontSize="small" />
                        <div>
                            <h2>{t("tutorial.permissions.title")}</h2>
                            <p>{t("tutorial.permissions.desc")}</p>
                        </div>
                    </div>
                    <div className="tutorial-card-row">
                        {permissions.map(permission => (
                            <article className={`tutorial-card tutorial-animate-item ${permission.done ? "done" : ""}`} key={permission.id}>
                                <div className="tutorial-card-visual">
                                    <img src={permissionVisuals[permission.id]} alt="" aria-hidden="true" />
                                </div>
                                <div className="tutorial-card-status">
                                    {permission.done ? <CheckCircleIcon fontSize="small" /> : <span />}
                                </div>
                                <div>
                                    <h3>{permission.title}</h3>
                                    <p>{permission.description}</p>
                                </div>
                                <button type="button" onClick={() => onPermissionAction(permission.id)}>
                                    {permission.done ? t("tutorial.done") : permission.actionLabel}
                                </button>
                            </article>
                        ))}
                    </div>
                    <div className="tutorial-actions tutorial-animate-item">
                        <button type="button" className="tutorial-primary" onClick={() => setStep(2)}>
                            {t("tutorial.continue")}
                        </button>
                    </div>
                </section>
            )}

            {step === 2 && (
                <section className="tutorial-panel tutorial-filters">
                    <div className="tutorial-panel-heading tutorial-animate-item">
                        <SettingsSuggestOutlinedIcon fontSize="small" />
                        <div>
                            <h2>{t("tutorial.filters.title")}</h2>
                            <p>{t("tutorial.filters.desc")}</p>
                        </div>
                    </div>
                    <div className="tutorial-toggle-grid">
                        {filters.map(filter => (
                            <label className="tutorial-toggle tutorial-animate-item" key={filter.id}>
                                <span>{filter.name}</span>
                                <input
                                    type="checkbox"
                                    checked={filter.enabled}
                                    onChange={event => onToggleFilter(filter.id, event.target.checked)}
                                />
                                <i aria-hidden="true" />
                            </label>
                        ))}
                    </div>
                    <div className="tutorial-actions tutorial-animate-item">
                        <button type="button" onClick={() => setStep(1)}>
                            {t("tutorial.back")}
                        </button>
                        <button type="button" className="tutorial-primary" onClick={() => setStep(3)}>
                            {t("tutorial.continue")}
                        </button>
                    </div>
                </section>
            )}

            {step === 3 && (
                <section className="tutorial-panel tutorial-shortcut">
                    <div className="tutorial-panel-heading tutorial-animate-item">
                        <KeyboardCommandKeyOutlinedIcon fontSize="small" />
                        <div>
                            <h2>{t("tutorial.shortcut.title")}</h2>
                            <p>{t("tutorial.shortcut.desc")}</p>
                        </div>
                    </div>
                    <div className="tutorial-shortcut-hero tutorial-animate-item">
                        <span>{t("tutorial.shortcut.default")}</span>
                        <strong>{shortcutText}</strong>
                        <p>{t("tutorial.shortcut.hint")}</p>
                    </div>
                    <div className="tutorial-shortcut-steps tutorial-animate-item" aria-hidden="true">
                        <span>{t("tutorial.shortcut.open")}</span>
                        <i />
                        <span>{t("tutorial.shortcut.hideWindow")}</span>
                    </div>
                    <div className="tutorial-actions tutorial-animate-item">
                        <button type="button" onClick={() => setStep(2)}>
                            {t("tutorial.back")}
                        </button>
                        <button type="button" className="tutorial-primary" onClick={onComplete}>
                            {t("tutorial.finish")}
                        </button>
                    </div>
                </section>
            )}
        </div>
    );
}
