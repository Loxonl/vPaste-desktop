import type { ReactNode } from "react";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import { classes } from "./classNames";
import { m, useMotionPreset } from "./motion";
import styles from "./OperationStatus.module.css";

export type OperationStatusTone = "neutral" | "success" | "error";

export type OperationStatusProps = {
    message: ReactNode;
    tone?: OperationStatusTone;
    busy?: boolean;
    progress?: number | null;
    progressLabel?: string;
    variant?: "compact" | "block";
    className?: string;
};

export function OperationStatus({
    message,
    tone = "neutral",
    busy = false,
    progress,
    progressLabel,
    variant = "compact",
    className,
}: OperationStatusProps) {
    const motion = useMotionPreset("fade");
    const showProgress = progress !== undefined;

    return (
        <m.div
            className={classes(styles, `root ${variant} ${tone} ${className ?? ""}`)}
            variants={motion}
            data-motion-preset="fade"
            initial="initial"
            animate="animate"
            exit="exit"
            role={tone === "error" ? "alert" : "status"}
            aria-live={tone === "error" ? "assertive" : "polite"}
            aria-atomic="true"
        >
            <div className={styles.line}>
                {busy && <CircularProgress size={14} thickness={5} aria-hidden="true" />}
                <span className={styles.message}>{message}</span>
            </div>
            {showProgress && (
                <LinearProgress
                    variant={progress == null ? "indeterminate" : "determinate"}
                    value={progress ?? undefined}
                    aria-label={progressLabel ?? String(message)}
                />
            )}
        </m.div>
    );
}
