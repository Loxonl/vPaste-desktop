import ButtonBase from "@mui/material/ButtonBase";
import { useId, type ReactNode } from "react";
import styles from "./ActionCard.module.css";

export type ActionCardLayout = "horizontal" | "vertical";

export default function ActionCard({
    title,
    description,
    icon,
    endAdornment,
    layout = "horizontal",
    disabled = false,
    onClick,
}: {
    title: ReactNode;
    description: ReactNode;
    icon: ReactNode;
    endAdornment?: ReactNode;
    layout?: ActionCardLayout;
    disabled?: boolean;
    onClick: () => void;
}) {
    const titleId = useId();
    const descriptionId = useId();

    return (
        <ButtonBase
            className={`${styles.root} ${styles[layout]}`}
            disabled={disabled}
            onClick={onClick}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
        >
            <span className={styles.icon} aria-hidden="true">{icon}</span>
            <span className={styles.body}>
                <span className={styles.title} id={titleId}>{title}</span>
                <span className={styles.description} id={descriptionId}>{description}</span>
            </span>
            {endAdornment ? <span className={styles.endAdornment} aria-hidden="true">{endAdornment}</span> : null}
        </ButtonBase>
    );
}
