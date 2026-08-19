import * as React from "react";
import { Box, ButtonBase, Divider, List, ListItem, ListItemText, Stack, Switch, Typography } from "@mui/material";
import { error } from "@tauri-apps/plugin-log";
import { formatShortcutLabel, getModifierDisplayLabel, isMacPlatform } from "../../shortcutDisplay";
import type { SettingsSectionProps, Shortcutkey, ShortcutRegistrationInfo, StorageMigrationInfo, TFunction } from "../settingsTypes";
import { classes } from "../../ui/classNames";
import styles from "../Config.module.css";

function normalizeShortcutForPolicy(value: string) {
    return value
        .split("+")
        .map(part => {
            const normalized = part.trim().toLowerCase();
            if (normalized === "control" || normalized === "ctrl") return "ctrl";
            if (normalized === "option" || normalized === "alt") return "alt";
            if (normalized === "shift") return "shift";
            if (["command", "cmd", "meta", "super", "win", "windows"].includes(normalized)) return "super";
            if (["enter", "return"].includes(normalized)) return "enter";
            if (["escape", "esc"].includes(normalized)) return "esc";
            if ([" ", "space", "spacebar"].includes(normalized)) return "space";
            return normalized;
        })
        .filter(Boolean)
        .sort()
        .join("+");
}

function hasShortcutModifier(value: string) {
    return normalizeShortcutForPolicy(value)
        .split("+")
        .some(part => ["ctrl", "alt", "shift", "super"].includes(part));
}

function isBlockedMainShortcut(value: string) {
    const normalized = normalizeShortcutForPolicy(value);
    return normalized === "super+v"
        || normalized === "alt+space"
        || normalized === "space+super"
        || normalized === "super+tab"
        || normalized === "q+super";
}

function isReservedQuickInputShortcut(value: string) {
    if (!isMacPlatform()) return false;

    const parts = normalizeShortcutForPolicy(value).split("+");
    const hasAlt = parts.includes("alt");
    const hasNonQuickInputModifier = parts.includes("ctrl") || parts.includes("super");
    if (!hasAlt || hasNonQuickInputModifier) return false;

    return parts.some(part => ["a", "f", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(part));
}

function isReservedQuickInputShortcutEvent(event?: React.KeyboardEvent) {
    if (!isMacPlatform() || !event?.altKey || event.ctrlKey || event.metaKey) return false;
    return event.code === "KeyA" || event.code === "KeyF" || /^Digit[1-9]$/.test(event.code);
}

function isReservedPasteAsTextShortcut(value: string) {
    const parts = normalizeShortcutForPolicy(value).split("+");
    const hasCtrlOrSuper = parts.includes("ctrl") || parts.includes("super");
    if (hasCtrlOrSuper && parts.includes("f")) return true;

    return parts.some(part => ["space", "arrowdown", "arrowleft", "arrowright", "tab", "esc"].includes(part))
        || normalizeShortcutForPolicy(value) === "enter";
}

function isUnsupportedRecordedKey(event?: React.KeyboardEvent) {
    return event?.key === "Dead" || event?.key === "Unidentified" || event?.key === "Process";
}

function getErrorText(errorValue: unknown): string {
    if (errorValue instanceof Error) return errorValue.message;
    if (typeof errorValue === "string") return errorValue;
    return String(errorValue);
}

export default function ShortcutSettings({ bridge, config, t, onSave }: SettingsSectionProps) {
    const quickInputModifier = getModifierDisplayLabel("alt");

    const validateMainWindowShortcut = (value: string, event?: React.KeyboardEvent) => {
        if (isUnsupportedRecordedKey(event)) {
            return t("settings.shortcut.invalid");
        }
        if (!hasShortcutModifier(value)) {
            return t("settings.shortcut.requiresModifier");
        }
        if (isBlockedMainShortcut(value)) {
            return t("settings.shortcut.unsupportedSystem");
        }
        if (isReservedQuickInputShortcut(value) || isReservedQuickInputShortcutEvent(event)) {
            return t("settings.shortcut.quickInputConflict", { modifier: quickInputModifier });
        }
        return null;
    };

    const validatePasteQueueShortcut = (value: string, event?: React.KeyboardEvent) => {
        const commonError = validateMainWindowShortcut(value, event);
        if (commonError) return commonError;
        const normalized = normalizeShortcutForPolicy(value);
        if (normalized === "ctrl+v" || normalized === "super+v") {
            return t("settings.shortcut.unsupportedSystem");
        }
        return null;
    };

    const validatePasteAsTextShortcut = (value: string, event?: React.KeyboardEvent) => {
        if (isUnsupportedRecordedKey(event)) {
            return t("settings.shortcut.invalid");
        }
        if (isReservedQuickInputShortcut(value) || isReservedQuickInputShortcutEvent(event)) {
            return t("settings.shortcut.quickInputConflict", { modifier: quickInputModifier });
        }
        if (isReservedPasteAsTextShortcut(value)) {
            return t("settings.shortcut.panelConflict");
        }
        return null;
    };

    const handleShortcutChange = async (key: keyof Shortcutkey, value: string) => {
        return await onSave({
            ...config,
            shortcut_keys: {
                ...config.shortcut_keys,
                [key]: value
            }
        });
    };

    const handleTabQuickSelectChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, tab_quick_select_enabled: event.target.checked });
    };

    return (
        <Stack spacing={2.15} className={classes(styles, "settings-page-stack")}>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.shortcuts.global")}
                </Typography>
                <List>
                    <ShortcutItem
                        label={t("settings.shortcuts.main")}
                        value={config.shortcut_keys.main_window}
                        onChange={(v) => handleShortcutChange('main_window', v)}
                        onRecordingStart={() => bridge.invoke('begin_main_shortcut_recording')}
                        onRecordingCancel={() => bridge.invoke('end_main_shortcut_recording')}
                        checkRegistration={(v) => bridge.invoke<ShortcutRegistrationInfo>('check_main_shortcut_registration', { shortcut: v })}
                        validate={validateMainWindowShortcut}
                        t={t}
                    />
                    <Divider component="li" />
                    <ShortcutItem
                        label={t("settings.shortcuts.pasteQueue")}
                        value={config.shortcut_keys.paste_queue_toggle}
                        onChange={(v) => handleShortcutChange('paste_queue_toggle', v)}
                        onRecordingStart={() => bridge.invoke('begin_paste_queue_shortcut_recording')}
                        onRecordingCancel={() => bridge.invoke('end_paste_queue_shortcut_recording')}
                        checkRegistration={(v) => bridge.invoke<ShortcutRegistrationInfo>('check_paste_queue_shortcut_registration', { shortcut: v })}
                        validate={validatePasteQueueShortcut}
                        t={t}
                    />
                </List>
            </Box>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.shortcuts.mainWindow")}
                </Typography>
                <List>
                    <FixedShortcutItem
                        label={t("settings.shortcuts.quickSelect")}
                        value={t("settings.shortcuts.key.arrowsHorizontal")}
                    />
                    <Divider component="li" />
                    <ListItem sx={{ alignItems: 'center' }}>
                        <ListItemText
                            primary={t("settings.tabQuickSelectSupport")}
                            secondary={t("settings.tabQuickSelect.desc")}
                        />
                        <span className={classes(styles, "shortcut-static")}>
                            <Switch
                                checked={config.tab_quick_select_enabled}
                                onChange={handleTabQuickSelectChange}
                                inputProps={{ "aria-label": t("settings.tabQuickSelectSupport") }}
                            />
                        </span>
                    </ListItem>
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.actionMenu")}
                        value={t("settings.shortcuts.key.arrowDown")}
                    />
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.search")}
                        value="Ctrl + F"
                    />
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.preview")}
                        value={t("settings.shortcuts.key.space")}
                    />
                    <Divider component="li" />
                    <ShortcutItem
                        label={t("settings.shortcuts.pasteText")}
                        value={config.shortcut_keys.paste_into_plain_text}
                        onChange={(v) => handleShortcutChange('paste_into_plain_text', v)}
                        validate={validatePasteAsTextShortcut}
                        t={t}
                    />
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.quickInput")}
                        secondary={t("settings.quickInput.enabled.desc", { modifier: quickInputModifier })}
                        value={t("settings.shortcuts.key.holdAlt", { modifier: quickInputModifier })}
                    />
                </List>
            </Box>
        </Stack>
    )
}

function FixedShortcutItem({ label, secondary, value }: { label: string, secondary?: string, value: string }) {
    return (
        <ListItem sx={{ alignItems: 'center' }}>
            <ListItemText
                primary={label}
                secondary={secondary}
            />
            <span className={classes(styles, "shortcut-static")}>{value}</span>
        </ListItem>
    );
}

function ShortcutItem({ label, value, onChange, onRecordingStart, onRecordingCancel, checkRegistration, validate, t }: {
    label: string,
    value?: string,
    onChange: (v: string) => void | Promise<StorageMigrationInfo | null | void>,
    onRecordingStart?: () => void | Promise<unknown>,
    onRecordingCancel?: () => void | Promise<unknown>,
    checkRegistration?: (v: string) => Promise<ShortcutRegistrationInfo>,
    validate?: (v: string, event: React.KeyboardEvent) => string | null,
    t: TFunction
}) {
    const [recording, setRecording] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const recorderRef = React.useRef<HTMLButtonElement | null>(null);

    React.useEffect(() => {
        if (recording) {
            requestAnimationFrame(() => recorderRef.current?.focus());
        }
    }, [recording]);

    const restoreRecordedShortcut = () => {
        if (!onRecordingCancel) return;
        void Promise.resolve(onRecordingCancel()).catch(e => error(`Failed to restore shortcut after recording: ${e}`));
    };

    const stopRecordingAndRestore = () => {
        setRecording(false);
        restoreRecordedShortcut();
    };

    const startRecording = () => {
        setErrorMessage(null);
        void Promise.resolve(onRecordingStart?.())
            .then(() => setRecording(true))
            .catch((startError: unknown) => {
                setErrorMessage(t("settings.shortcut.saveFailed", { error: getErrorText(startError) }));
                setRecording(false);
            });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === "Escape" || e.key === "Esc") {
            setErrorMessage(null);
            stopRecordingAndRestore();
            return;
        }

        const modifiers = [];
        if (e.metaKey) modifiers.push('Command');
        if (e.ctrlKey) modifiers.push('Control');
        if (e.altKey) modifiers.push('Alt');
        if (e.shiftKey) modifiers.push('Shift');

        const rawKey = e.key;
        const keyUpper = rawKey.toUpperCase();
        if (['META', 'CONTROL', 'ALT', 'SHIFT'].includes(keyUpper)) return;

        const key = rawKey === " " ? "Space" : rawKey.length === 1 ? rawKey.toUpperCase() : formatShortcutLabel(rawKey).replace(/\s\+\s/g, "+");
        const shortcut = [...modifiers, key].join('+');
        const validationError = validate?.(shortcut, e);
        if (validationError) {
            setErrorMessage(validationError);
            stopRecordingAndRestore();
            return;
        }

        void Promise.resolve(checkRegistration?.(shortcut))
            .then(registrationInfo => {
                const conflictMessage = registrationInfo?.conflict ? t("settings.shortcut.occupiedConflict") : null;
                return Promise.resolve(onChange(shortcut)).then(saveInfo => ({ conflictMessage, saveInfo }));
            })
            .then(({ conflictMessage, saveInfo }) => {
                const nextErrorMessage = saveInfo?.shortcut_conflict
                    ? t("settings.shortcut.occupiedConflict")
                    : conflictMessage;
                setErrorMessage(nextErrorMessage);
                setRecording(false);
            })
            .catch((saveError: unknown) => {
                restoreRecordedShortcut();
                setErrorMessage(t("settings.shortcut.saveFailed", { error: getErrorText(saveError) }));
                setRecording(false);
            });
    };

    return (
        <ListItem sx={{ alignItems: 'center' }}>
            <ListItemText
                primary={label}
            />
            <div className={classes(styles, "shortcut-control")}>
                <ButtonBase
                    ref={recorderRef}
                    className={classes(styles, `shortcut-recorder ${recording ? "recording" : ""} ${value ? "" : "empty"} ${errorMessage ? "has-error" : ""}`)}
                    type="button"
                    onClick={startRecording}
                    onKeyDown={recording ? handleKeyDown : undefined}
                    onBlur={() => {
                        if (recording) {
                            stopRecordingAndRestore();
                        }
                    }}
                >
                    {recording ? t("settings.shortcut.recording") : formatShortcutLabel(value) || t("settings.shortcut.clickToSet")}
                </ButtonBase>
                {errorMessage && <span className={classes(styles, "shortcut-error-text")}>{errorMessage}</span>}
            </div>
        </ListItem>
    );
}
