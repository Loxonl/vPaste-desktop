import * as m from "motion/react-m";

export { AnimatePresence, LazyMotion, MotionConfig, useReducedMotion } from "motion/react";
export { m };
export { motionPresetFor, useMotionPreset, type MotionPresetName } from "./presets";
export { motionDurationsMs, motionSprings, motionTokens, syncMotionCssVariables } from "./tokens";

export const loadMotionFeatures = () => import("./features").then(module => module.default);
