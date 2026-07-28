import React from "react";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import backgroundVisual from "../assets/tutorial/permission-background.svg";
import pasteVisual from "../assets/tutorial/permission-paste.svg";
import shortcutVisual from "../assets/tutorial/shortcut-popover.svg";
import styles from "./TutorialOverlay.module.css";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

export type TutorialPermissionId = "background" | "paste";
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
    onPermissionAction: (id: TutorialPermissionId) => void | Promise<void>;
    onToggleFilter: (id: TutorialFilterId, enabled: boolean) => void;
    onComplete: () => void;
};

const permissionVisuals: Record<TutorialPermissionId, string> = {
    background: backgroundVisual,
    paste: pasteVisual,
};

function classSelector(name: string, descendant = "") {
    return `.${styles[name]}${descendant}`;
}

type StepShellProps = {
    index: number;
    title: string;
    description: string;
    children: React.ReactNode;
    onBack?: () => void;
    onNext: () => void;
    nextLabel?: string;
};

const WELCOME_REVEAL_MS = 680;
const WELCOME_HOLD_MS = 900;
const WELCOME_EXIT_MS = 500;

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

    React.useLayoutEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const animations: Animation[] = [];
        let stepTimer: number | null = null;
        const animate = (
            selector: string,
            keyframes: Keyframe[],
            options: KeyframeAnimationOptions,
            stagger = 0,
        ) => {
            root.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
                animations.push(element.animate(keyframes, {
                    fill: "both",
                    ...options,
                    delay: Number(options.delay ?? 0) + index * stagger,
                }));
            });
        };

        if (step === 0) {
            const welcomeDuration = reduceMotion
                ? WELCOME_HOLD_MS
                : WELCOME_REVEAL_MS + WELCOME_HOLD_MS + WELCOME_EXIT_MS;
            const revealOffset = WELCOME_REVEAL_MS / welcomeDuration;
            const exitOffset = (WELCOME_REVEAL_MS + WELCOME_HOLD_MS) / welcomeDuration;
            if (!reduceMotion) {
                animate(classSelector("tutorial-welcome", ""), [
                    {
                        transform: "translate3d(64px, 0, 0) scale(.965)",
                        opacity: 0,
                        easing: "cubic-bezier(.22,1,.36,1)",
                    },
                    { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1, offset: revealOffset },
                    {
                        transform: "translate3d(0, 0, 0) scale(1)",
                        opacity: 1,
                        offset: exitOffset,
                        easing: "cubic-bezier(.65,0,.35,1)",
                    },
                    { transform: "translate3d(-120%, 0, 0) scale(1)", opacity: 0 },
                ], { duration: welcomeDuration, easing: "linear" });
                animate(classSelector("tutorial-welcome-orbit", ""), [
                    { transform: "rotate(-5deg) scale(.96) translateY(0)" },
                    { transform: "rotate(1deg) scale(1.015) translateY(0)", offset: .72 },
                    { transform: "rotate(0) scale(1) translateY(0)" },
                ], { duration: 560, delay: 30, easing: "cubic-bezier(.22,1,.36,1)" });
                animate(classSelector("tutorial-welcome-logo", ""), [
                    { transform: "rotate(-7deg) scale(.84)", opacity: 0 },
                    { transform: "rotate(1deg) scale(1.025)", opacity: 1, offset: .78 },
                    { transform: "rotate(0) scale(1)", opacity: 1 },
                ], { duration: 520, delay: 50, easing: "cubic-bezier(.22,1,.36,1)" });
                animate(classSelector("tutorial-welcome-word", ""), [
                    { transform: "translateY(24px) rotateX(-24deg)", opacity: 0 },
                    { transform: "translateY(0) rotateX(0)", opacity: 1 },
                ], { duration: 420, delay: 180, easing: "cubic-bezier(.16,1,.3,1)" }, 55);
                animate(classSelector("tutorial-welcome-accent", ""), [
                    { transform: "scaleX(0)" },
                    { transform: "scaleX(1)" },
                ], { duration: 320, delay: 360, easing: "cubic-bezier(.16,1,.3,1)" });
            }
            stepTimer = window.setTimeout(() => setStep(hasPermissionStep ? 1 : 2), welcomeDuration);
        } else if (!reduceMotion) {
            animate(classSelector("tutorial-panel", ""), [
                { transform: "perspective(900px) translateX(84px) rotateY(-4deg)", opacity: 0 },
                { transform: "perspective(900px) translateX(0) rotateY(0)", opacity: 1 },
            ], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" });
            animate(classSelector("tutorial-step-copy", ""), [
                { transform: "translateX(-24px)", opacity: 0 },
                { transform: "translateX(0)", opacity: 1 },
            ], { duration: 420, delay: 80, easing: "cubic-bezier(.16,1,.3,1)" });
            animate(classSelector("tutorial-actions", ""), [
                { transform: "translateX(28px)", opacity: 0 },
                { transform: "translateX(0)", opacity: 1 },
            ], { duration: 400, delay: 100, easing: "cubic-bezier(.34,1.56,.64,1)" });
            animate(classSelector("tutorial-primary", ""), [
                { transform: "scale(.82)" },
                { transform: "scale(1)" },
            ], { duration: 420, delay: 180, easing: "cubic-bezier(.34,1.56,.64,1)" });

            if (step === 1) {
                animate(classSelector("tutorial-permission-card", ""), [
                    { transform: "perspective(700px) translateY(34px) rotateY(-9deg) scale(.94)", opacity: 0 },
                    { transform: "perspective(700px) translateY(0) rotateY(0) scale(1)", opacity: 1 },
                ], { duration: 520, delay: 160, easing: "cubic-bezier(.34,1.56,.64,1)" }, 75);
                animate(classSelector("tutorial-card-visual", " img"), [
                    { transform: "translateY(9px) scale(1.16)" },
                    { transform: "translateY(0) scale(1)" },
                ], { duration: 560, delay: 260, easing: "cubic-bezier(.16,1,.3,1)" }, 60);
                animate(classSelector("tutorial-status-pill", ""), [
                    { transform: "translateY(-8px) scale(.72)", opacity: 0 },
                    { transform: "translateY(0) scale(1)", opacity: 1 },
                ], { duration: 340, delay: 330, easing: "cubic-bezier(.34,1.56,.64,1)" }, 50);
            } else if (step === 2) {
                animate(classSelector("tutorial-toggle", ""), [
                    { transform: "translateY(28px) rotate(-2.5deg) scale(.9)", opacity: 0 },
                    { transform: "translateY(0) rotate(0) scale(1)", opacity: 1 },
                ], { duration: 460, delay: 160, easing: "cubic-bezier(.34,1.56,.64,1)" }, 65);
            } else if (step === 3) {
                animate(classSelector("tutorial-shortcut-art", ""), [
                    { transform: "translateX(-36px) rotate(-2deg)", opacity: 0 },
                    { transform: "translateX(0) rotate(0)", opacity: 1 },
                ], { duration: 550, delay: 160, easing: "cubic-bezier(.16,1,.3,1)" });
                animate(classSelector("tutorial-shortcut-keycap", ""), [
                    { transform: "translateX(42px) scale(.82)", opacity: 0 },
                    { transform: "translateX(0) scale(1)", opacity: 1 },
                ], { duration: 520, delay: 240, easing: "cubic-bezier(.34,1.56,.64,1)" });
                animate(classSelector("tutorial-shortcut-keycap", " strong"), [
                    { transform: "scale(1)" },
                    { transform: "scale(1.06)", offset: .5 },
                    { transform: "scale(1)" },
                ], { duration: 600, delay: 650, easing: "ease-in-out" });
            }
        }

        return () => {
            if (stepTimer !== null) {
                window.clearTimeout(stepTimer);
            }
            animations.forEach(animation => animation.cancel());
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

        const animations: Animation[] = [];
        newlyEnabled.forEach((permission, index) => {
            const card = root.querySelector<HTMLElement>(`[data-permission-id="${permission.id}"]`);
            if (!card) return;
            const delay = index * 60;
            animations.push(card.animate([
                { transform: "translateY(0) scale(1)" },
                { transform: "translateY(-7px) scale(1.025)", offset: .35 },
                { transform: "translateY(0) scale(1)" },
            ], { duration: 620, delay, easing: "cubic-bezier(.34,1.56,.64,1)" }));

            const status = card.querySelector<HTMLElement>(classSelector("tutorial-status-pill"));
            if (status) {
                animations.push(status.animate([
                    { transform: "scale(.45) rotate(-8deg)", opacity: 0 },
                    { transform: "scale(1) rotate(0)", opacity: 1 },
                ], { duration: 420, delay, easing: "cubic-bezier(.34,1.56,.64,1)" }));
            }

            const burst = card.querySelector<HTMLElement>(classSelector("tutorial-status-burst"));
            if (burst) {
                animations.push(burst.animate([
                    { transform: "scale(.25)", opacity: .75 },
                    { transform: "scale(2.1)", opacity: 0 },
                ], { duration: 500, delay, easing: "cubic-bezier(.16,1,.3,1)" }));
            }
        });

        return () => animations.forEach(animation => animation.cancel());
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
        <section className={styles["tutorial-panel"]}>
            <div className={`${styles["tutorial-step-copy"]} ${styles["tutorial-animate-item"]}`}>
                <span className={styles["tutorial-step-index"]}>{String(index).padStart(2, "0")}</span>
                <h2>{title}</h2>
                <p>{description}</p>
                {onBack && (
                    <button type="button" className={`${styles["tutorial-nav-button"]} ${styles["tutorial-back-action"]}`} onClick={onBack}>
                        {t("tutorial.back")}
                    </button>
                )}
            </div>
            <div className={`${styles["tutorial-main"]} ${styles["tutorial-animate-item"]}`}>
                {children}
            </div>
            <div className={`${styles["tutorial-actions"]} ${styles["tutorial-animate-item"]}`}>
                <button type="button" className={`${styles["tutorial-nav-button"]} ${styles["tutorial-primary"]}`} onClick={onNext}>
                    {nextLabel}
                </button>
            </div>
        </section>
    );

    return (
        <div className={styles["tutorial-root"]} ref={rootRef}>
            {step === 0 && (
                <section className={styles["tutorial-welcome"]} aria-live="polite">
                    <div className={styles["tutorial-welcome-orbit"]}>
                        <img className={styles["tutorial-welcome-logo"]} src={logoSrc} alt="vPaste" />
                    </div>
                    <div className={styles["tutorial-welcome-copy"]}>
                        <h1 aria-label={t("tutorial.welcome.title")}>
                            <span className={styles["tutorial-welcome-word"]}>{t("tutorial.welcome.title")}</span>
                        </h1>
                        <p className={styles["tutorial-welcome-word"]}>{t("tutorial.welcome.desc")}</p>
                        <i className={styles["tutorial-welcome-accent"]} aria-hidden="true" />
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
                    <div className={styles["tutorial-permission-row"]}>
                        {permissions.map(permission => (
                            <article
                                className={[styles["tutorial-permission-card"], permission.done ? styles.done : ""].join(" ")}
                                data-permission-id={permission.id}
                                key={permission.id}
                            >
                                <div className={styles["tutorial-card-visual"]}>
                                    <img src={permissionVisuals[permission.id]} alt="" aria-hidden="true" />
                                    <span className={styles["tutorial-card-brand"]} aria-hidden="true">
                                        <img src={logoSrc} alt="" />
                                    </span>
                                    <span className={[styles["tutorial-status-pill"], permission.done ? styles.done : ""].join(" ")}>
                                        <i className={styles["tutorial-status-burst"]} aria-hidden="true" />
                                        {permission.done && <CheckCircleIcon fontSize="inherit" />}
                                        <span>{permission.done ? t("tutorial.permission.ready") : t("tutorial.permission.pending")}</span>
                                    </span>
                                </div>
                                <div className={styles["tutorial-card-body"]}>
                                    <h3>{permission.title}</h3>
                                    <p>{permission.description}</p>
                                </div>
                                {!permission.done && (
                                    <button type="button" className={styles["tutorial-card-action"]} onClick={() => void onPermissionAction(permission.id)}>
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
                    <div className={styles["tutorial-toggle-grid"]}>
                        {filters.map(filter => (
                            <label className={`${styles["tutorial-toggle"]} ${styles["tutorial-orbit-item"]}`} key={filter.id}>
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
                    <div className={styles["tutorial-shortcut-stage"]}>
                        <img className={`${styles["tutorial-shortcut-art"]} ${styles["tutorial-orbit-item"]}`} src={shortcutVisual} alt="" aria-hidden="true" />
                        <div className={`${styles["tutorial-shortcut-keycap"]} ${styles["tutorial-orbit-item"]}`}>
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
