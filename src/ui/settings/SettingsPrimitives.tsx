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
    label,
    description,
    control,
}: {
    label: ReactNode;
    description?: ReactNode;
    control: ReactNode;
}) {
    return (
        <div className={styles.row}>
            <div className={styles.copy}>
                <span className={styles.label}>{label}</span>
                {description ? <span className={styles.description}>{description}</span> : null}
            </div>
            <div className={styles.control}>{control}</div>
        </div>
    );
}
