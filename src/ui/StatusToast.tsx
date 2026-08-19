import type { MouseEvent, ReactNode } from "react";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import { classes } from "./classNames";
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
    const handleAction = (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onAction?.();
    };

    return (
        <Paper
            component="div"
            role={kind === "error" ? "alert" : "status"}
            aria-live={kind === "error" ? "assertive" : "polite"}
            elevation={0}
            className={classes(styles, `root ${kind} ${className ?? ""}`)}
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
    );
}
