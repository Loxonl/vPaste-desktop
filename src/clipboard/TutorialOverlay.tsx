import React from "react";
import { gsap } from "gsap";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import startupVisual from "../assets/tutorial/permission-startup.svg";
import backgroundVisual from "../assets/tutorial/permission-background.svg";
import pasteVisual from "../assets/tutorial/permission-paste.svg";
import shortcutVisual from "../assets/tutorial/shortcut-popover.svg";
import "./TutorialOverlay.css";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

export type TutorialPermissionId = "startup" | "background" | "paste";
export type TutorialFilterId = "text" | "image" | "link" | "color" | "file";
export type TutorialPlatform = "windows" | "mac";

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
    platform: TutorialPlatform;
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
    platform,
    permissions,
    filters,
    onPermissionAction,
    onToggleFilter,
    onComplete,
}: TutorialOverlayProps) {
    const rootRef = React.useRef<HTMLDivElement>(null);
    const [step, setStep] = React.useState(0);
    const previousPermissionState = React.useRef(
        new Map(permissions.map(permission => [permission.id, permission.done])),
    );
    const hasPermissionStep = platform === "mac";
    const filterStepIndex = hasPermissionStep ? 2 : 1;
    const shortcutStepIndex = hasPermissionStep ? 3 : 2;

    React.useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let reduceMotionTimer: number | null = null;
        const ctx = gsap.context(() => {
            if (step === 0) {
                if (reduceMotion) {
                    reduceMotionTimer = window.setTimeout(() => setStep(hasPermissionStep ? 1 : 2), 900);
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
                    .fromTo(
                        ".tutorial-welcome-logo",
                        { rotate: -14, scale: 0.76 },
                        { rotate: 0, scale: 1, duration: 0.68, ease: "elastic.out(1, 0.55)" },
                        "<0.02",
                    )
                    .fromTo(
                        ".tutorial-welcome-word",
                        { y: 24, autoAlpha: 0, rotateX: -24 },
                        { y: 0, autoAlpha: 1, rotateX: 0, duration: 0.48, stagger: 0.07 },
                        "<0.12",
                    )
                    .fromTo(
                        ".tutorial-welcome-accent",
                        { scaleX: 0, transformOrigin: "left center" },
                        { scaleX: 1, duration: 0.46, ease: "expo.out" },
                        "<0.12",
                    )
                    .to(".tutorial-welcome-orbit", { y: -5, duration: 0.32, ease: "sine.inOut", yoyo: true, repeat: 1 }, "+=0.2")
                    .to(".tutorial-welcome", { xPercent: -120, autoAlpha: 0, duration: 0.7 }, "+=1.15")
                    .call(() => setStep(hasPermissionStep ? 1 : 2));
                return;
            }

            if (reduceMotion) return;
            const timeline = gsap.timeline({ defaults: { ease: "power3.out" } })
                .fromTo(
                    ".tutorial-panel",
                    { x: 84, autoAlpha: 0, rotateY: -4, transformPerspective: 900 },
                    { x: 0, autoAlpha: 1, rotateY: 0, duration: 0.52 },
                )
                .fromTo(
                    ".tutorial-step-copy",
                    { x: -24, autoAlpha: 0 },
                    { x: 0, autoAlpha: 1, duration: 0.42 },
                    "<0.08",
                )
                .fromTo(
                    ".tutorial-actions",
                    { x: 28, autoAlpha: 0 },
                    { x: 0, autoAlpha: 1, duration: 0.4, ease: "back.out(1.45)" },
                    "<0.08",
                )
                .fromTo(
                    ".tutorial-primary",
                    { scale: 0.82 },
                    { scale: 1, duration: 0.42, ease: "elastic.out(1, 0.62)" },
                    "<0.12",
                );

            if (step === 1) {
                timeline
                    .fromTo(
                        ".tutorial-permission-card",
                        { y: 34, autoAlpha: 0, rotateY: -9, scale: 0.94, transformPerspective: 700 },
                        { y: 0, autoAlpha: 1, rotateY: 0, scale: 1, duration: 0.52, stagger: 0.075, ease: "back.out(1.3)" },
                        "<0.02",
                    )
                    .fromTo(
                        ".tutorial-card-visual img",
                        { scale: 1.16, y: 9 },
                        { scale: 1, y: 0, duration: 0.56, stagger: 0.06, ease: "expo.out" },
                        "<0.1",
                    )
                    .fromTo(
                        ".tutorial-status-pill",
                        { scale: 0.72, autoAlpha: 0, y: -8 },
                        { scale: 1, autoAlpha: 1, y: 0, duration: 0.34, stagger: 0.05, ease: "back.out(2)" },
                        "<0.05",
                    );
            } else if (step === 2) {
                timeline.fromTo(
                    ".tutorial-toggle",
                    { y: 28, autoAlpha: 0, rotate: -2.5, scale: 0.9 },
                    { y: 0, autoAlpha: 1, rotate: 0, scale: 1, duration: 0.46, stagger: 0.065, ease: "back.out(1.5)" },
                    "<0.02",
                );
            } else if (step === 3) {
                timeline
                    .fromTo(
                        ".tutorial-shortcut-art",
                        { x: -36, autoAlpha: 0, rotate: -2 },
                        { x: 0, autoAlpha: 1, rotate: 0, duration: 0.55, ease: "expo.out" },
                        "<0.02",
                    )
                    .fromTo(
                        ".tutorial-shortcut-keycap",
                        { x: 42, autoAlpha: 0, scale: 0.82 },
                        { x: 0, autoAlpha: 1, scale: 1, duration: 0.52, ease: "back.out(1.7)" },
                        "<0.08",
                    )
                    .to(
                        ".tutorial-shortcut-keycap strong",
                        { scale: 1.06, duration: 0.3, ease: "sine.inOut", yoyo: true, repeat: 1 },
                        ">-0.08",
                    );
            }
        }, root);

        return () => {
            if (reduceMotionTimer !== null) {
                window.clearTimeout(reduceMotionTimer);
            }
            ctx.revert();
        };
    }, [hasPermissionStep, step]);

    React.useEffect(() => {
        const currentState = new Map(permissions.map(permission => [permission.id, permission.done]));
        const newlyEnabled = permissions.filter(permission => (
            permission.done && previousPermissionState.current.get(permission.id) === false
        ));
        previousPermissionState.current = currentState;

        const root = rootRef.current;
        if (!root || step !== 1 || newlyEnabled.length === 0) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

        const ctx = gsap.context(() => {
            newlyEnabled.forEach((permission, index) => {
                const card = root.querySelector<HTMLElement>(`[data-permission-id="${permission.id}"]`);
                if (!card) return;

                gsap.timeline({ delay: index * 0.06 })
                    .to(card, { y: -7, scale: 1.025, duration: 0.22, ease: "power2.out" })
                    .fromTo(
                        card.querySelector(".tutorial-status-pill"),
                        { scale: 0.45, autoAlpha: 0, rotate: -8 },
                        { scale: 1, autoAlpha: 1, rotate: 0, duration: 0.42, ease: "back.out(2.4)" },
                        "<",
                    )
                    .fromTo(
                        card.querySelector(".tutorial-status-burst"),
                        { scale: 0.25, autoAlpha: 0.75 },
                        { scale: 2.1, autoAlpha: 0, duration: 0.5, ease: "power2.out" },
                        "<",
                    )
                    .to(card, { y: 0, scale: 1, duration: 0.32, ease: "elastic.out(1, 0.65)", clearProps: "transform" });
            });
        }, root);

        return () => ctx.revert();
    }, [permissions, step]);

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
                        <img className="tutorial-welcome-logo" src={logoSrc} alt="vPaste" />
                    </div>
                    <div className="tutorial-welcome-copy">
                        <h1 aria-label="Welcome to vPaste">
                            <span className="tutorial-welcome-word">Welcome</span>{" "}
                            <span className="tutorial-welcome-word">to</span>{" "}
                            <span className="tutorial-welcome-word">vPaste</span>
                        </h1>
                        <p className="tutorial-welcome-word">Your clipboard, always one shortcut away.</p>
                        <i className="tutorial-welcome-accent" aria-hidden="true" />
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
                            <article
                                className={`tutorial-permission-card ${permission.done ? "done" : ""}`}
                                data-permission-id={permission.id}
                                key={permission.id}
                            >
                                <div className="tutorial-card-visual">
                                    <img src={permissionVisuals[permission.id]} alt="" aria-hidden="true" />
                                    <span className={`tutorial-status-pill ${permission.done ? "done" : ""}`}>
                                        <i className="tutorial-status-burst" aria-hidden="true" />
                                        {permission.done && <CheckCircleIcon fontSize="inherit" />}
                                        <span>{permission.done ? t("tutorial.permission.ready") : t("tutorial.permission.pending")}</span>
                                    </span>
                                </div>
                                <div className="tutorial-card-body">
                                    <h3>{permission.title}</h3>
                                    <p>{permission.description}</p>
                                </div>
                                {!permission.done && (
                                    <button type="button" className="tutorial-card-action" onClick={() => onPermissionAction(permission.id)}>
                                        <span>{permission.actionLabel}</span>
                                        <ArrowOutwardRoundedIcon fontSize="inherit" />
                                    </button>
                                )}
                            </article>
                        ))}
                    </div>
                    ),
                })
            )}

            {step === 2 && (
                renderStep({
                    index: filterStepIndex,
                    title: t("tutorial.filters.title"),
                    description: t("tutorial.filters.desc"),
                    onBack: hasPermissionStep ? () => setStep(1) : undefined,
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
                    index: shortcutStepIndex,
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
                    </div>
                    ),
                })
            )}
        </div>
    );
}
