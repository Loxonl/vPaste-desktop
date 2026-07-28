import type { HTMLAttributes, PropsWithChildren } from "react";
import styles from "./StatusBadge.module.css";

export type StatusTone = "neutral" | "success" | "warning" | "danger";

type StatusBadgeProps = PropsWithChildren<HTMLAttributes<HTMLSpanElement>> & {
    tone?: StatusTone;
};

export default function StatusBadge({
    tone = "neutral",
    className = "",
    children,
    ...props
}: StatusBadgeProps) {
    return (
        <span
            className={[styles.badge, styles[tone], className].filter(Boolean).join(" ")}
            {...props}
        >
            {children}
        </span>
    );
}
