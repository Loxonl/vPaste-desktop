import type { Transition } from "motion/react";

export const motionTokens = {
    duration: {
        quick: 0.12,
        fast: 0.18,
        standard: 0.24,
        slow: 0.32,
    },
    distance: {
        subtle: 6,
        standard: 10,
        emphasis: 16,
    },
    continuous: {
        marquee: 8,
    },
    easing: {
        enter: [0.22, 1, 0.36, 1],
        exit: [0.4, 0, 1, 1],
        standard: [0.4, 0, 0.2, 1],
        linear: "linear",
    },
} as const;

export const motionSprings = {
    snappy: { type: "spring", stiffness: 420, damping: 32, mass: 0.8 },
    layout: { type: "spring", stiffness: 320, damping: 34, mass: 0.9 },
    gentle: { type: "spring", stiffness: 220, damping: 28, mass: 1 },
} as const satisfies Record<string, Transition>;

export const motionDurationsMs = {
    quick: motionTokens.duration.quick * 1000,
    fast: motionTokens.duration.fast * 1000,
    standard: motionTokens.duration.standard * 1000,
    slow: motionTokens.duration.slow * 1000,
} as const;

export function syncMotionCssVariables(root: HTMLElement = document.documentElement) {
    root.style.setProperty("--motion-duration-quick", `${motionDurationsMs.quick}ms`);
    root.style.setProperty("--motion-duration-fast", `${motionDurationsMs.fast}ms`);
    root.style.setProperty("--motion-duration-standard", `${motionDurationsMs.standard}ms`);
    root.style.setProperty("--motion-duration-slow", `${motionDurationsMs.slow}ms`);
    root.style.setProperty("--motion-distance-subtle", `${motionTokens.distance.subtle}px`);
    root.style.setProperty("--motion-distance-standard", `${motionTokens.distance.standard}px`);
    root.style.setProperty("--motion-distance-emphasis", `${motionTokens.distance.emphasis}px`);
    root.style.setProperty("--motion-duration-marquee", `${motionTokens.continuous.marquee}s`);
    root.style.setProperty("--motion-ease-enter", `cubic-bezier(${motionTokens.easing.enter.join(", ")})`);
    root.style.setProperty("--motion-ease-exit", `cubic-bezier(${motionTokens.easing.exit.join(", ")})`);
    root.style.setProperty("--motion-ease-standard", `cubic-bezier(${motionTokens.easing.standard.join(", ")})`);
    root.style.setProperty("--motion-ease-linear", motionTokens.easing.linear);
}
