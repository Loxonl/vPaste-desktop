import { useEffect, useRef, useState } from "react";
import { Button, ListItem, MenuItem, Select, TextField, Typography } from "@mui/material";
import type { AutoCleanupPolicy, SettingsSectionProps, StorageCleanupInfo } from "../settingsTypes";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { OperationStatus } from "../../ui/OperationStatus";
import { SettingsRow } from "../../ui/settings/SettingsPrimitives";
import styles from "./AutoCleanupSettings.module.css";

const presets = { days: [7, 30, 90, 180, 365], count: [500, 1000, 5000, 10000] };

export default function AutoCleanupSettings({
    bridge, config, onSave, t, disabled, dialogBackdropClassName,
}: SettingsSectionProps & { disabled: boolean; dialogBackdropClassName?: string }) {
    const saved = config.auto_cleanup;
    const [mode, setMode] = useState<AutoCleanupPolicy["mode"]>(saved.mode);
    const [value, setValue] = useState(String(saved.mode === "disabled" ? 30 : saved.value));
    const [custom, setCustom] = useState(saved.mode !== "disabled" && !presets[saved.mode].includes(saved.value));
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [confirmation, setConfirmation] = useState<{ policy: AutoCleanupPolicy; items: number } | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    useEffect(() => {
        setMode(saved.mode);
        if (saved.mode !== "disabled") {
            setValue(String(saved.value));
            setCustom(!presets[saved.mode].includes(saved.value));
        }
    }, [saved]); // Draft edits stay local until the saved policy changes.

    const amount = Number(value);
    const maximum = mode === "days" ? 36500 : 1000000;
    const valid = /^\d+$/.test(value) && Number.isSafeInteger(amount) && amount >= 1 && amount <= maximum;
    const dirty = mode !== saved.mode || (saved.mode !== "disabled" && amount !== saved.value);
    const locked = disabled || busy;
    const policy: AutoCleanupPolicy = mode === "disabled" ? { mode } : { mode, value: amount };

    async function save(next: AutoCleanupPolicy) {
        setBusy(true);
        setMessage(null);
        try {
            await onSave({ ...config, auto_cleanup: next });
            if (mounted.current) {
                setMode(next.mode);
                setConfirmation(null);
            }
        } catch (cause) {
            if (mounted.current) {
                setMessage(t("settings.autoCleanup.failed", { error: String(cause) }));
                if (next.mode === "disabled") {
                    setMode(saved.mode);
                    if (saved.mode !== "disabled") {
                        setValue(String(saved.value));
                        setCustom(!presets[saved.mode].includes(saved.value));
                    }
                }
            }
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    async function apply() {
        if (locked || !valid || !dirty) return;
        setBusy(true);
        setMessage(null);
        try {
            const estimate = await bridge.invoke<StorageCleanupInfo>("estimate_auto_cleanup", { policy });
            if (mounted.current) setConfirmation({ policy, items: estimate.items });
        } catch (cause) {
            if (mounted.current) setMessage(t("settings.autoCleanup.failed", { error: String(cause) }));
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    return (
        <ListItem disablePadding className={styles.item}>
            <div className={styles.root} data-testid="automatic-cleanup">
                <SettingsRow
                    labelId="auto-cleanup-label"
                    label={t("settings.autoCleanup.title")}
                    control={(
                        <Select
                            size="small" value={mode} disabled={locked}
                            SelectDisplayProps={{ "aria-labelledby": "auto-cleanup-label" }}
                            onChange={event => {
                                const next = event.target.value as AutoCleanupPolicy["mode"];
                                setMessage(null);
                                if (next === "disabled") {
                                    setMode(next);
                                    if (saved.mode !== "disabled") void save({ mode: "disabled" });
                                } else {
                                    setMode(next);
                                    setValue(next === "days" ? "30" : "5000");
                                    setCustom(false);
                                }
                            }}
                        >
                            <MenuItem value="disabled">{t("settings.autoCleanup.disabled")}</MenuItem>
                            <MenuItem value="days">{t("settings.autoCleanup.days")}</MenuItem>
                            <MenuItem value="count">{t("settings.autoCleanup.count")}</MenuItem>
                        </Select>
                    )}
                />
                {mode !== "disabled" && (
                    <div className={styles.details}>
                        <div className={styles.controls}>
                            <Typography component="span" variant="body2">{t("settings.autoCleanup.keep")}</Typography>
                            <Select
                                size="small" value={custom ? "custom" : value} disabled={locked}
                                inputProps={{ "aria-label": t("settings.autoCleanup.range") }}
                                onChange={event => {
                                    setCustom(event.target.value === "custom");
                                    if (event.target.value !== "custom") setValue(event.target.value);
                                }}
                            >
                                {presets[mode].map(n => (
                                    <MenuItem value={String(n)} key={n}>
                                        {t(`settings.autoCleanup.${mode}Value`, { value: n })}
                                    </MenuItem>
                                ))}
                                <MenuItem value="custom">{t("settings.autoCleanup.custom")}</MenuItem>
                            </Select>
                            {custom && (
                                <TextField
                                    size="small" type="number" value={value} disabled={locked}
                                    className={styles.amount}
                                    label={t(mode === "days" ? "settings.autoCleanup.dayAmount" : "settings.autoCleanup.countAmount")}
                                    inputProps={{ min: 1, max: maximum, step: 1 }}
                                    error={!valid}
                                    helperText={!valid ? t("settings.autoCleanup.invalid", { max: maximum }) : undefined}
                                    onChange={event => setValue(event.target.value)}
                                />
                            )}
                            <Button variant="outlined" size="small" disabled={locked || !dirty || !valid} onClick={() => void apply()}>
                                {t("settings.autoCleanup.apply")}
                            </Button>
                        </div>
                    </div>
                )}
                {(busy || message) && (
                    <div className={styles.details}>
                        <OperationStatus busy={busy} tone={message ? "error" : "neutral"} message={message ?? t("settings.autoCleanup.working")} />
                    </div>
                )}
                <ConfirmDialog
                    open={confirmation !== null} title={t("settings.autoCleanup.confirmTitle")}
                    description={t("settings.autoCleanup.confirm", { items: confirmation?.items ?? 0 })}
                    cancelLabel={t("common.cancel")} confirmLabel={t("settings.autoCleanup.confirmApply")}
                    backdropClassName={dialogBackdropClassName}
                    cancelDisabled={busy} confirmDisabled={locked}
                    status={message ? <OperationStatus tone="error" message={message} /> : undefined}
                    onCancel={() => { if (!busy) setConfirmation(null); }}
                    onConfirm={() => { if (confirmation && !locked) void save(confirmation.policy); }}
                />
            </div>
        </ListItem>
    );
}
