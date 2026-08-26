import type { Variants } from "motion/react";
import { useReducedMotionConfig } from "motion/react";
import { motionSprings, motionTokens } from "./tokens";

export type MotionPresetName =
    | "fade"
    | "popover"
    | "toast"
    | "panel"
    | "panelForward"
    | "panelBackward"
    | "listItem"
    | "gridItem"
    | "shortcutHint"
    | "stateIndicator"
    | "preview"
    | "submenuLeft"
    | "submenuRight"
    | "selectionIndicator";

const enterTransition = {
    duration: motionTokens.duration.fast,
    ease: motionTokens.easing.enter,
} as const;

const exitTransition = {
    duration: motionTokens.duration.quick,
    ease: motionTokens.easing.exit,
} as const;

const reducedTransition = {
    duration: motionTokens.duration.quick,
    ease: motionTokens.easing.standard,
} as const;

const presets: Record<MotionPresetName, Variants> = {
    fade: {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: enterTransition },
        exit: { opacity: 0, transition: exitTransition },
    },
    popover: {
        initial: { opacity: 0, y: -motionTokens.distance.subtle, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1, transition: enterTransition },
        exit: { opacity: 0, y: -motionTokens.distance.subtle, scale: 0.98, transition: exitTransition },
    },
    toast: {
        initial: { opacity: 0, y: -motionTokens.distance.standard },
        animate: { opacity: 1, y: 0, transition: enterTransition },
        exit: { opacity: 0, y: -motionTokens.distance.standard, transition: exitTransition },
    },
    panel: {
        initial: { opacity: 0, x: motionTokens.distance.standard },
        animate: { opacity: 1, x: 0, transition: enterTransition },
        exit: { opacity: 0, x: -motionTokens.distance.standard, transition: exitTransition },
    },
    panelForward: {
        initial: { opacity: 0, x: motionTokens.distance.standard },
        animate: { opacity: 1, x: 0, transition: enterTransition },
        exit: { opacity: 0, x: -motionTokens.distance.standard, transition: exitTransition },
    },
    panelBackward: {
        initial: { opacity: 0, x: -motionTokens.distance.standard },
        animate: { opacity: 1, x: 0, transition: enterTransition },
        exit: { opacity: 0, x: motionTokens.distance.standard, transition: exitTransition },
    },
    listItem: {
        initial: { opacity: 0, y: motionTokens.distance.subtle },
        animate: { opacity: 1, y: 0, transition: enterTransition },
        exit: { opacity: 0, y: -motionTokens.distance.subtle, transition: exitTransition },
    },
    gridItem: {
        initial: { opacity: 0, x: motionTokens.distance.emphasis },
        animate: { opacity: 1, x: 0, transition: enterTransition },
        exit: { opacity: 0, x: -motionTokens.distance.subtle, transition: exitTransition },
    },
    shortcutHint: {
        initial: { opacity: 0, scale: 0.9 },
        animate: { opacity: 1, scale: 1, transition: enterTransition },
        exit: { opacity: 0, scale: 0.9, transition: exitTransition },
    },
    stateIndicator: {
        initial: { opacity: 0, scale: 0.86 },
        animate: { opacity: 1, scale: 1, transition: motionSprings.snappy },
        exit: { opacity: 0, scale: 0.9, transition: exitTransition },
    },
    preview: {
        initial: (direction: number = 0) => ({
            opacity: 0,
            x: direction < 0
                ? -motionTokens.distance.standard
                : direction > 0
                    ? motionTokens.distance.standard
                    : 0,
        }),
        animate: { opacity: 1, x: 0, transition: enterTransition },
        exit: { opacity: 0, transition: exitTransition },
    },
    submenuLeft: {
        initial: { opacity: 0, x: motionTokens.distance.subtle },
        animate: { opacity: 1, x: 0, transition: enterTransition },
        exit: { opacity: 0, x: motionTokens.distance.subtle, transition: exitTransition },
    },
    submenuRight: {
        initial: { opacity: 0, x: -motionTokens.distance.subtle },
        animate: { opacity: 1, x: 0, transition: enterTransition },
        exit: { opacity: 0, x: -motionTokens.distance.subtle, transition: exitTransition },
    },
    selectionIndicator: {
        initial: { opacity: 0, scaleX: 0.9 },
        animate: { opacity: 1, scaleX: 1, transition: enterTransition },
        exit: { opacity: 0, scaleX: 0.9, transition: exitTransition },
    },
};

function reducedPreset(): Variants {
    return {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: reducedTransition },
        exit: { opacity: 0, transition: reducedTransition },
    };
}

const reducedPresets: Record<MotionPresetName, Variants> = {
    fade: reducedPreset(),
    popover: reducedPreset(),
    toast: reducedPreset(),
    panel: reducedPreset(),
    panelForward: reducedPreset(),
    panelBackward: reducedPreset(),
    listItem: reducedPreset(),
    gridItem: reducedPreset(),
    shortcutHint: reducedPreset(),
    stateIndicator: reducedPreset(),
    preview: reducedPreset(),
    submenuLeft: reducedPreset(),
    submenuRight: reducedPreset(),
    selectionIndicator: reducedPreset(),
};

export function motionPresetFor(name: MotionPresetName, reducedMotion: boolean): Variants {
    return reducedMotion ? reducedPresets[name] : presets[name];
}

export function useMotionPreset(name: MotionPresetName): Variants {
    return motionPresetFor(name, Boolean(useReducedMotionConfig()));
}
