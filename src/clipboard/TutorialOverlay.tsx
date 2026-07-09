import React from "react";
import { gsap } from "gsap";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import startupVisual from "../assets/tutorial/permission-startup.svg";
import backgroundVisual from "../assets/tutorial/permission-background.svg";
import pasteVisual from "../assets/tutorial/permission-paste.svg";
import shortcutVisual from "../assets/tutorial/shortcut-popover.svg";
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

type StepShellProps = {
    index: number;
    title: string;
    description: string;
    children: React.ReactNode;
    onBack?: () => void;
    onNext: () => void;
    nextLabel?: string;
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
                    { y: 16, autoAlpha: 0, scale: 0.98 },
                    { y: 0, autoAlpha: 1, scale: 1, duration: 0.42, stagger: 0.055 },
                    "<0.12",
                )
                .fromTo(
                    ".tutorial-orbit-item",
                    { y: 10, rotate: -1.5, scale: 0.96 },
                    { y: 0, rotate: 0, scale: 1, duration: 0.42, stagger: 0.045, ease: "back.out(1.35)" },
                    "<0.08",
                )
                .fromTo(
                    ".tutorial-status-pill.done",
                    { scale: 0.86, autoAlpha: 0 },
                    { scale: 1, autoAlpha: 1, duration: 0.28, stagger: 0.04, ease: "back.out(1.8)" },
                    "<0.16",
                )
                .fromTo(
                    ".shortcut-motion-line",
                    { scaleX: 0, transformOrigin: "left center", autoAlpha: 0 },
                    { scaleX: 1, autoAlpha: 1, duration: 0.42 },
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

    const renderStep = ({
        index,
        title,
        description,
        children,
        onBack,
        onNext,
        nextLabel = t("tutorial.continue"),
    }: StepShellProps) => (
        <section className="tutorial-panel">
            <div className="tutorial-step-copy tutorial-animate-item">
                <span className="tutorial-step-index">{String(index).padStart(2, "0")}</span>
                <h2>{title}</h2>
                <p>{description}</p>
                {onBack && (
                    <button type="button" className="tutorial-nav-button tutorial-back-action" onClick={onBack}>
                        {t("tutorial.back")}
                    </button>
                )}
            </div>
            <div className="tutorial-main tutorial-animate-item">
                {children}
            </div>
            <div className="tutorial-actions tutorial-animate-item">
                <button type="button" className="tutorial-nav-button tutorial-primary" onClick={onNext}>
                    {nextLabel}
                </button>
            </div>
        </section>
    );

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
                renderStep({
                    index: 1,
                    title: t("tutorial.permissions.title"),
                    description: t("tutorial.permissions.desc"),
                    onNext: () => setStep(2),
                    children: (
                    <div className="tutorial-permission-row">
                        {permissions.map(permission => (
                            <article className={`tutorial-permission-card tutorial-orbit-item ${permission.done ? "done" : ""}`} key={permission.id}>
                                <div className="tutorial-card-visual">
                                    <img src={permissionVisuals[permission.id]} alt="" aria-hidden="true" />
                                </div>
                                <div className="tutorial-card-body">
                                    <h3>{permission.title}</h3>
                                    <p>{permission.description}</p>
                                </div>
                                <div className="tutorial-card-footer">
                                    <span className={`tutorial-status-pill ${permission.done ? "done" : ""}`}>
                                        {permission.done && <CheckCircleIcon fontSize="inherit" />}
                                        {permission.done ? t("tutorial.permission.ready") : t("tutorial.permission.pending")}
                                    </span>
                                    {!permission.done && (
                                        <button type="button" className="tutorial-card-action" onClick={() => onPermissionAction(permission.id)}>
                                            {permission.actionLabel}
                                        </button>
                                    )}
                                </div>
                            </article>
                        ))}
                    </div>
                    ),
                })
            )}

            {step === 2 && (
                renderStep({
                    index: 2,
                    title: t("tutorial.filters.title"),
                    description: t("tutorial.filters.desc"),
                    onBack: () => setStep(1),
                    onNext: () => setStep(3),
                    children: (
                    <div className="tutorial-toggle-grid">
                        {filters.map(filter => (
                            <label className="tutorial-toggle tutorial-orbit-item" key={filter.id}>
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
                    ),
                })
            )}

            {step === 3 && (
                renderStep({
                    index: 3,
                    title: t("tutorial.shortcut.title"),
                    description: t("tutorial.shortcut.desc"),
                    onBack: () => setStep(2),
                    onNext: onComplete,
                    nextLabel: t("tutorial.finish"),
                    children: (
                    <div className="tutorial-shortcut-stage">
                        <img className="tutorial-shortcut-art tutorial-orbit-item" src={shortcutVisual} alt="" aria-hidden="true" />
                        <div className="tutorial-shortcut-keycap tutorial-orbit-item">
                            <span>{t("tutorial.shortcut.default")}</span>
                            <strong>{shortcutText}</strong>
                        </div>
                        <div className="tutorial-shortcut-flow tutorial-orbit-item" aria-hidden="true">
                            <span>{t("tutorial.shortcut.open")}</span>
                            <i className="shortcut-motion-line" />
                            <span>{t("tutorial.shortcut.hideWindow")}</span>
                        </div>
                    </div>
                    ),
                })
            )}
        </div>
    );
}
