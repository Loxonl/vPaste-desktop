import type { PropsWithChildren, ReactNode } from "react";
import styles from "./SettingsPrimitives.module.css";

export function SettingsSection({
    title,
    children,
}: PropsWithChildren<{ title: ReactNode }>) {
    return (
        <section className={styles.section}>
            <h2 className={styles.sectionTitle}>{title}</h2>
            <div className={styles.rows}>{children}</div>
        </section>
    );
}

export function SettingsRow({
    labelId,
    descriptionId,
    label,
    description,
    control,
}: {
    labelId?: string;
    descriptionId?: string;
    label: ReactNode;
    description?: ReactNode;
    control: ReactNode;
}) {
    return (
        <div className={styles.row}>
            <div className={styles.copy}>
                <span id={labelId} className={styles.label}>{label}</span>
                {description ? <span id={descriptionId} className={styles.description}>{description}</span> : null}
            </div>
            <div className={styles.control}>{control}</div>
        </div>
    );
}
