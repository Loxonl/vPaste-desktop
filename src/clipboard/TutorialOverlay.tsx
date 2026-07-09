import React from "react";
import { gsap } from "gsap";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RocketLaunchOutlinedIcon from "@mui/icons-material/RocketLaunchOutlined";
import SettingsSuggestOutlinedIcon from "@mui/icons-material/SettingsSuggestOutlined";
import KeyboardCommandKeyOutlinedIcon from "@mui/icons-material/KeyboardCommandKeyOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
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
    copied: boolean;
    onPermissionAction: (id: TutorialPermissionId) => void;
    onToggleFilter: (id: TutorialFilterId, enabled: boolean) => void;
    onComplete: () => void;
};

export default function TutorialOverlay({
    t,
    logoSrc,
    shortcutText,
    permissions,
    filters,
    copied,
    onPermissionAction,
    onToggleFilter,
    onComplete,
}: TutorialOverlayProps) {
    const rootRef = React.useRef<HTMLDivElement>(null);
    const [step, setStep] = React.useState(0);
    const [shortcutVisible, setShortcutVisible] = React.useState(true);

    React.useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let reduceMotionTimer: number | null = null;
        const ctx = gsap.context(() => {
            if (step === 0) {
                if (reduceMotion) {
                    reduceMotionTimer = window.setTimeout(() => setStep(1), 600);
                    return;
                }

                gsap.timeline({ defaults: { ease: "power3.inOut" } })
                    .fromTo(
                        ".tutorial-welcome",
                        { xPercent: 120, autoAlpha: 0 },
                        { xPercent: 0, autoAlpha: 1, duration: 0.72 },
                    )
                    .to(".tutorial-welcome", { xPercent: -120, autoAlpha: 0, duration: 0.64 }, "+=0.85")
                    .call(() => setStep(1));
                return;
            }

            if (reduceMotion) return;
            gsap.fromTo(
                ".tutorial-panel",
                { x: 72, autoAlpha: 0 },
                { x: 0, autoAlpha: 1, duration: 0.46, ease: "power2.out" },
            );
        }, root);

        return () => {
            if (reduceMotionTimer !== null) {
                window.clearTimeout(reduceMotionTimer);
            }
            ctx.revert();
        };
    }, [step]);

    const allPermissionsDone = permissions.every(permission => permission.done);

    return (
        <div className="tutorial-root" ref={rootRef}>
            {step === 0 && (
                <section className="tutorial-welcome" aria-live="polite">
                    <img src={logoSrc} alt="vPaste" />
                    <div>
                        <h1>Welcome to vPaste</h1>
                        <p>Your clipboard, always one shortcut away.</p>
                    </div>
                </section>
            )}

            {step === 1 && (
                <section className="tutorial-panel tutorial-permissions">
                    <div className="tutorial-panel-heading">
                        <RocketLaunchOutlinedIcon fontSize="small" />
                        <div>
                            <h2>{t("tutorial.permissions.title")}</h2>
                            <p>{t("tutorial.permissions.desc")}</p>
                        </div>
                    </div>
                    <div className="tutorial-card-row">
                        {permissions.map(permission => (
                            <article className={`tutorial-card ${permission.done ? "done" : ""}`} key={permission.id}>
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
                    <div className="tutorial-actions">
                        <button type="button" className="tutorial-primary" disabled={!allPermissionsDone} onClick={() => setStep(2)}>
                            {t("tutorial.continue")}
                        </button>
                    </div>
                </section>
            )}

            {step === 2 && (
                <section className="tutorial-panel tutorial-filters">
                    <div className="tutorial-panel-heading">
                        <SettingsSuggestOutlinedIcon fontSize="small" />
                        <div>
                            <h2>{t("tutorial.filters.title")}</h2>
                            <p>{t("tutorial.filters.desc")}</p>
                        </div>
                    </div>
                    <div className="tutorial-toggle-grid">
                        {filters.map(filter => (
                            <label className="tutorial-toggle" key={filter.id}>
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
                    <div className="tutorial-actions">
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
                    <div className="tutorial-panel-heading">
                        <KeyboardCommandKeyOutlinedIcon fontSize="small" />
                        <div>
                            <h2>{t("tutorial.shortcut.title")}</h2>
                            <p>{t("tutorial.shortcut.desc")}</p>
                        </div>
                    </div>
                    {shortcutVisible && (
                        <div className="tutorial-shortcut-key">
                            <span>{t("tutorial.shortcut.default")}</span>
                            <strong>{shortcutText}</strong>
                        </div>
                    )}
                    <div className={`tutorial-copy-check ${copied ? "done" : ""}`}>
                        {copied ? <CheckCircleIcon /> : <ContentCopyOutlinedIcon />}
                        <span>{copied ? t("tutorial.copy.done") : t("tutorial.copy.try")}</span>
                    </div>
                    <div className="tutorial-actions">
                        <button type="button" onClick={() => setShortcutVisible(value => !value)}>
                            {shortcutVisible ? t("tutorial.shortcut.hide") : t("tutorial.shortcut.show")}
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
