import type { HTMLAttributes, PropsWithChildren } from "react";
import styles from "./Surface.module.css";

type SurfaceProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>> & {
    padded?: boolean;
};

export default function Surface({
    padded = false,
    className = "",
    children,
    ...props
}: SurfaceProps) {
    const classes = [styles.surface, padded ? styles.padded : "", className]
        .filter(Boolean)
        .join(" ");

    return (
        <div className={classes} {...props}>
            {children}
        </div>
    );
}
