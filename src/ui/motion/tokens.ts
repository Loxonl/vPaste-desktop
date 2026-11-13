import type { Transition } from "motion/react";
import sharedTokens from "./tokens.json";

type Bezier = [number, number, number, number];
// Data is also embedded by the Windows native reader; values stay identical
// across renderers without maintaining a second set of animation parameters.
export const motionTokens = sharedTokens as {
    duration: Record<"quick" | "fast" | "standard" | "slow", number>;
    distance: Record<"subtle" | "standard" | "emphasis", number>;
    stagger: { tight: number };
    continuous: { marquee: number };
    easing: { enter: Bezier; exit: Bezier; standard: Bezier; linear: "linear" };
};

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
