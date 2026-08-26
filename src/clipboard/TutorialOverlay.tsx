import React from "react";
import Button from "@mui/material/Button";
import Switch from "@mui/material/Switch";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import backgroundVisual from "../assets/tutorial/permission-background.svg";
import pasteVisual from "../assets/tutorial/permission-paste.svg";
import shortcutVisual from "../assets/tutorial/shortcut-popover.svg";
import styles from "./TutorialOverlay.module.css";
import {
    AnimatePresence,
    m,
    motionTokens,
    stagger,
    useAnimate,
    useMotionPreset,
    useReducedMotionConfig,
} from "../ui/motion";
import type {
    TutorialFilterId,
    TutorialFilterTab,
    TutorialPermission,
    TutorialPermissionId,
    TutorialPlatform,
} from "./clipboardTutorial";

export type {
    TutorialFilterId,
    TutorialFilterTab,
    TutorialPermission,
    TutorialPermissionId,
    TutorialPlatform,
} from "./clipboardTutorial";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type TutorialOverlayProps = {
    t: TFunction;
    logoSrc: string;
    shortcutText: string;
    platform: TutorialPlatform;
    permissions: TutorialPermission[];
    filters: TutorialFilterTab[];
    onPermissionAction: (id: TutorialPermissionId) => void | Promise<void>;
    onToggleFilter: (id: TutorialFilterId, enabled: boolean) => void;
    onShortcutDemoAvailabilityChange: (enabled: boolean) => void;
    onComplete: () => void;
};

const permissionVisuals: Record<TutorialPermissionId, string> = {
    background: backgroundVisual,
    paste: pasteVisual,
};

function classSelector(name: string) {
    return `.${styles[name]}`;
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

const WELCOME_HOLD_MS = 900;

export default function TutorialOverlay({
    t,
    logoSrc,
    shortcutText,
    platform,
    permissions,
    filters,
    onPermissionAction,
    onToggleFilter,
    onShortcutDemoAvailabilityChange,
    onComplete,
}: TutorialOverlayProps) {
    const [scope, animate] = useAnimate();
    const reduceMotion = Boolean(useReducedMotionConfig());
    const stateIndicatorMotion = useMotionPreset("stateIndicator");
    const [step, setStep] = React.useState(0);
    const previousPermissionState = React.useRef(
        new Map(permissions.map(permission => [permission.id, permission.done])),
    );
    const hasPermissionStep = platform === "mac";
    const filterStepIndex = hasPermissionStep ? 2 : 1;
    const shortcutStepIndex = hasPermissionStep ? 3 : 2;

    React.useLayoutEffect(() => {
        if (!scope.current) return;

        const controls: Array<{ stop: () => void }> = [];
        let cancelled = false;
        let holdTimer: number | null = null;
        let releaseHold: (() => void) | null = null;
        function track<T extends { stop: () => void }>(control: T): T {
            controls.push(control);
            return control;
        }
        const waitForWelcomeHold = () => new Promise<void>(resolve => {
            releaseHold = resolve;
            holdTimer = window.setTimeout(resolve, WELCOME_HOLD_MS);
        });

        if (step === 0) {
            const playWelcome = async () => {
                if (!reduceMotion) {
                    await Promise.all([
                        track(animate(
                            classSelector("tutorial-welcome"),
                            { opacity: [0, 1], x: [motionTokens.distance.emphasis, 0] },
                            { duration: motionTokens.duration.slow, ease: motionTokens.easing.enter },
                        )),
                        track(animate(
                            classSelector("tutorial-welcome-logo"),
                            { opacity: [0, 1], y: [motionTokens.distance.standard, 0] },
                            { duration: motionTokens.duration.standard, ease: motionTokens.easing.enter },
                        )),
                        track(animate(
                            classSelector("tutorial-welcome-word"),
                            { opacity: [0, 1], y: [motionTokens.distance.standard, 0] },
                            {
                                duration: motionTokens.duration.standard,
                                ease: motionTokens.easing.enter,
                                delay: stagger(motionTokens.duration.quick),
                            },
                        )),
                        track(animate(
                            classSelector("tutorial-welcome-accent"),
                            { opacity: [0, 1], scaleX: [0, 1] },
                            { duration: motionTokens.duration.standard, ease: motionTokens.easing.enter },
                        )),
                    ]);
                }
                await waitForWelcomeHold();
                if (!reduceMotion && !cancelled) {
                    await track(animate(
                        classSelector("tutorial-welcome"),
                        { opacity: 0, x: -motionTokens.distance.emphasis },
                        { duration: motionTokens.duration.standard, ease: motionTokens.easing.exit },
                    ));
                }
                if (!cancelled) setStep(hasPermissionStep ? 1 : 2);
            };
            void playWelcome();
        } else if (!reduceMotion) {
            track(animate(
                classSelector("tutorial-panel"),
                { opacity: [0, 1], x: [motionTokens.distance.standard, 0] },
                { duration: motionTokens.duration.slow, ease: motionTokens.easing.enter },
            ));
            track(animate(
                classSelector("tutorial-step-copy"),
                { opacity: [0, 1], x: [-motionTokens.distance.subtle, 0] },
                { duration: motionTokens.duration.standard, ease: motionTokens.easing.enter },
            ));
            track(animate(
                classSelector("tutorial-actions"),
                { opacity: [0, 1], x: [motionTokens.distance.subtle, 0] },
                { duration: motionTokens.duration.standard, ease: motionTokens.easing.enter },
            ));

            if (step === 1) {
                track(animate(
                    classSelector("tutorial-permission-card"),
                    { opacity: [0, 1], y: [motionTokens.distance.standard, 0] },
                    {
                        duration: motionTokens.duration.slow,
                        ease: motionTokens.easing.enter,
                        delay: stagger(motionTokens.duration.quick),
                    },
                ));
                track(animate(
                    classSelector("tutorial-status-pill"),
                    { opacity: [0, 1], y: [-motionTokens.distance.subtle, 0] },
                    {
                        duration: motionTokens.duration.standard,
                        ease: motionTokens.easing.enter,
                        delay: stagger(motionTokens.duration.quick),
                    },
                ));
            } else if (step === 2) {
                track(animate(
                    classSelector("tutorial-toggle"),
                    { opacity: [0, 1], y: [motionTokens.distance.standard, 0] },
                    {
                        duration: motionTokens.duration.standard,
                        ease: motionTokens.easing.enter,
                        delay: stagger(motionTokens.duration.quick),
                    },
                ));
            } else if (step === 3) {
                const playShortcutEmphasis = async () => {
                    await Promise.all([
                        track(animate(
                            classSelector("tutorial-shortcut-art"),
                            { opacity: [0, 1], x: [-motionTokens.distance.standard, 0] },
                            { duration: motionTokens.duration.slow, ease: motionTokens.easing.enter },
                        )),
                        track(animate(
                            classSelector("tutorial-shortcut-keycap"),
                            { opacity: [0, 1], x: [motionTokens.distance.standard, 0] },
                            { duration: motionTokens.duration.slow, ease: motionTokens.easing.enter },
                        )),
                    ]);
                    if (cancelled) return;
                    await Promise.all([
                        track(animate(
                            classSelector("tutorial-shortcut-keycap"),
                            {
                                y: motionTokens.distance.subtle,
                                scale: 0.97,
                            },
                            {
                                duration: motionTokens.duration.fast,
                                delay: motionTokens.duration.slow,
                                ease: motionTokens.easing.standard,
                            },
                        )),
                        track(animate(
                            classSelector("tutorial-shortcut-pulse"),
                            {
                                opacity: [0, 0.72, 0],
                                scale: [0.94, 1.06, 1.12],
                            },
                            {
                                duration: motionTokens.duration.slow,
                                delay: motionTokens.duration.slow,
                                ease: motionTokens.easing.enter,
                            },
                        )),
                    ]);
                    if (cancelled) return;
                    await track(animate(
                        classSelector("tutorial-shortcut-keycap"),
                        { y: 0, scale: 1 },
                        {
                            duration: motionTokens.duration.fast,
                            ease: motionTokens.easing.enter,
                        },
                    ));
                };
                void playShortcutEmphasis();
            }
        }

        return () => {
            cancelled = true;
            if (holdTimer !== null) window.clearTimeout(holdTimer);
            releaseHold?.();
            controls.forEach(control => control.stop());
        };
    }, [animate, hasPermissionStep, reduceMotion, scope, step]);

    React.useEffect(() => {
        if (step !== 3) return;
        onShortcutDemoAvailabilityChange(true);
        return () => onShortcutDemoAvailabilityChange(false);
    }, [onShortcutDemoAvailabilityChange, step]);

    React.useEffect(() => {
        const currentState = new Map(permissions.map(permission => [permission.id, permission.done]));
        const newlyEnabled = permissions.filter(permission => (
            permission.done && previousPermissionState.current.get(permission.id) === false
        ));
        previousPermissionState.current = currentState;

        const root = scope.current as HTMLElement | null;
        if (!root || step !== 1 || newlyEnabled.length === 0) return;
        if (reduceMotion) return;

        const controls: Array<{ stop: () => void }> = [];
        newlyEnabled.forEach((permission, index) => {
            const card = root.querySelector<HTMLElement>(`[data-permission-id="${permission.id}"]`);
            if (!card) return;
            const delay = index * motionTokens.duration.quick;
            controls.push(animate(
                card,
                { y: [0, -motionTokens.distance.subtle, 0] },
                { duration: motionTokens.duration.slow, delay, ease: motionTokens.easing.enter },
            ));

            const status = card.querySelector<HTMLElement>(classSelector("tutorial-status-pill"));
            if (status) {
                controls.push(animate(
                    status,
                    { opacity: [0, 1], y: [-motionTokens.distance.subtle, 0] },
                    { duration: motionTokens.duration.standard, delay, ease: motionTokens.easing.enter },
                ));
            }

            const burst = card.querySelector<HTMLElement>(classSelector("tutorial-status-burst"));
            if (burst) {
                controls.push(animate(
                    burst,
                    { opacity: [0.75, 0] },
                    { duration: motionTokens.duration.standard, delay, ease: motionTokens.easing.exit },
                ));
            }
        });

        return () => controls.forEach(control => control.stop());
    }, [animate, permissions, reduceMotion, scope, step]);

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
                    <Button variant="text" className={`${styles["tutorial-nav-button"]} ${styles["tutorial-back-action"]}`} onClick={onBack}>
                        {t("tutorial.back")}
                    </Button>
                )}
            </div>
            <div className={`${styles["tutorial-main"]} ${styles["tutorial-animate-item"]}`}>
                {children}
            </div>
            <div className={`${styles["tutorial-actions"]} ${styles["tutorial-animate-item"]}`}>
                <Button variant="contained" className={`${styles["tutorial-nav-button"]} ${styles["tutorial-primary"]}`} onClick={onNext}>
                    {nextLabel}
                </Button>
            </div>
        </section>
    );

    return (
        <div className={styles["tutorial-root"]} ref={scope}>
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
                                    <span
                                        className={[styles["tutorial-status-pill"], permission.done ? styles.done : ""].join(" ")}
                                        role="status"
                                        aria-live="polite"
                                    >
                                        <i className={styles["tutorial-status-burst"]} aria-hidden="true" />
                                        <AnimatePresence mode="sync" initial={false}>
                                            <m.span
                                                key={permission.done ? "ready" : "pending"}
                                                className={styles["tutorial-status-content"]}
                                                data-motion-preset="stateIndicator"
                                                data-motion-state="permission-status"
                                                variants={stateIndicatorMotion}
                                                initial="initial"
                                                animate="animate"
                                                exit="exit"
                                            >
                                                {permission.done && <CheckCircleIcon fontSize="inherit" />}
                                                <span>{permission.done ? t("tutorial.permission.ready") : t("tutorial.permission.pending")}</span>
                                            </m.span>
                                        </AnimatePresence>
                                    </span>
                                </div>
                                <div className={styles["tutorial-card-body"]}>
                                    <h3>{permission.title}</h3>
                                    <p>{permission.description}</p>
                                </div>
                                {!permission.done && (
                                    <Button variant="contained" className={styles["tutorial-card-action"]} onClick={() => void onPermissionAction(permission.id)}>
                                        <span>{permission.actionLabel}</span>
                                        <ArrowOutwardRoundedIcon fontSize="inherit" />
                                    </Button>
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
                                <Switch
                                    size="small"
                                    checked={filter.enabled}
                                    onChange={(_event, checked) => onToggleFilter(filter.id, checked)}
                                    inputProps={{ "aria-label": filter.name }}
                                />
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
                        <div
                            className={`${styles["tutorial-shortcut-keycap"]} ${styles["tutorial-orbit-item"]}`}
                            data-shortcut-emphasis={reduceMotion ? "reduced" : "press"}
                        >
                            <span className={styles["tutorial-shortcut-pulse"]} data-shortcut-pulse aria-hidden="true" />
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
