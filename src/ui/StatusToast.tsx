import type { MouseEvent, ReactNode } from "react";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import { classes } from "./classNames";
import { m, useMotionPreset } from "./motion";
import styles from "./StatusToast.module.css";

export type StatusToastKind = "info" | "warning" | "error";

export type StatusToastProps = {
    message: ReactNode;
    kind?: StatusToastKind;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionDisabled?: boolean;
    onAction?: () => void;
    className?: string;
    actionClassName?: string;
};

export function StatusToast({
    message,
    kind = "info",
    actionLabel,
    actionIcon,
    actionDisabled = false,
    onAction,
    className,
    actionClassName,
}: StatusToastProps) {
    const variants = useMotionPreset("toast");
    const handleAction = (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onAction?.();
    };

    return (
        <div className={className}>
            <m.div
                variants={variants}
                data-motion-preset="toast"
                initial="initial"
                animate="animate"
                exit="exit"
            >
                <Paper
                    component="div"
                    role={kind === "error" ? "alert" : "status"}
                    aria-live={kind === "error" ? "assertive" : "polite"}
                    elevation={0}
                    className={classes(styles, `root ${kind}`)}
                >
                    <span className={styles.message}>{message}</span>
                    {actionLabel && onAction && (
                        <Button
                            className={classes(styles, `action ${actionClassName ?? ""}`)}
                            disabled={actionDisabled}
                            onClick={handleAction}
                        >
                            {actionIcon}
                            {actionLabel}
                        </Button>
                    )}
                </Paper>
            </m.div>
        </div>
    );
}
