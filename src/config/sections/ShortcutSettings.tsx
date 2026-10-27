import * as React from "react";
import { ButtonBase, Stack, Switch } from "@mui/material";
import { error } from "@tauri-apps/plugin-log";
import { formatShortcutLabel, getModifierDisplayLabel, isMacPlatform, isWindowsPlatform } from "../../shortcutDisplay";
import type { SettingsBridge } from "../SettingsBridge";
import type { SettingsSectionProps, Shortcutkey, ShortcutRegistrationInfo, SettingsSaveInfo, TFunction } from "../settingsTypes";
import { classes } from "../../ui/classNames";
import { SettingsRow, SettingsSection } from "../../ui/settings/SettingsPrimitives";
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
    return (normalized === "super+v" && !isWindowsPlatform())
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
    if (normalizeShortcutForPolicy(value) === (isMacPlatform() ? "backspace" : "delete")) return true;

    return parts.some(part => ["space", "arrowdown", "arrowleft", "arrowright", "tab", "esc"].includes(part))
        || ["enter", "f2"].includes(normalizeShortcutForPolicy(value));
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
        <Stack spacing={6}>
            <SettingsSection title={t("settings.shortcuts.global")}>
                    <ShortcutItem
                        label={t("settings.shortcuts.main")}
                        value={config.shortcut_keys.main_window}
                        nativeRecordingBridge={isWindowsPlatform() ? bridge : undefined}
                        onChange={(v) => handleShortcutChange('main_window', v)}
                        onRecordingStart={() => bridge.invoke('begin_main_shortcut_recording')}
                        onRecordingCancel={() => bridge.invoke('end_main_shortcut_recording')}
                        checkRegistration={(v) => bridge.invoke<ShortcutRegistrationInfo>('check_main_shortcut_registration', { shortcut: v })}
                        validate={validateMainWindowShortcut}
                        t={t}
                    />
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
            </SettingsSection>
            <SettingsSection title={t("settings.shortcuts.mainWindow")}>
                    <FixedShortcutItem
                        label={t("settings.shortcuts.quickSelect")}
                        value={t("settings.shortcuts.key.arrowsHorizontal")}
                    />
                    <SettingsRow
                        labelId="settings-tab-quick-select-label"
                        descriptionId="settings-tab-quick-select-description"
                        label={t("settings.tabQuickSelectSupport")}
                        description={t("settings.tabQuickSelect.desc")}
                        control={<span className={classes(styles, "shortcut-static")}>
                            <Switch
                                checked={config.tab_quick_select_enabled}
                                onChange={handleTabQuickSelectChange}
                                inputProps={{
                                    "aria-labelledby": "settings-tab-quick-select-label",
                                    "aria-describedby": "settings-tab-quick-select-description",
                                }}
                            />
                        </span>}
                    />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.actionMenu")}
                        value={t("settings.shortcuts.key.arrowDown")}
                    />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.search")}
                        value="Ctrl + F"
                    />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.preview")}
                        value={t("settings.shortcuts.key.space")}
                    />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.deleteRecord")}
                        value={isMacPlatform() ? "⌫" : "Delete"}
                    />
                    <FixedShortcutItem label={t("menu.editText")} value="F2" />
                    <ShortcutItem
                        label={t("settings.shortcuts.pasteText")}
                        value={config.shortcut_keys.paste_into_plain_text}
                        onChange={(v) => handleShortcutChange('paste_into_plain_text', v)}
                        validate={validatePasteAsTextShortcut}
                        t={t}
                    />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.quickInput")}
                        secondary={t("settings.quickInput.enabled.desc", { modifier: quickInputModifier })}
                        value={t("settings.shortcuts.key.holdAlt", { modifier: quickInputModifier })}
                    />
            </SettingsSection>
        </Stack>
    )
}

function FixedShortcutItem({ label, secondary, value }: { label: string, secondary?: string, value: string }) {
    return (
        <SettingsRow
            label={label}
            description={secondary}
            control={<span className={classes(styles, "shortcut-static")}>{value}</span>}
        />
    );
}

function ShortcutItem({ label, value, nativeRecordingBridge, onChange, onRecordingStart, onRecordingCancel, checkRegistration, validate, t }: {
    label: string,
    value?: string,
    nativeRecordingBridge?: SettingsBridge,
    onChange: (v: string) => void | Promise<SettingsSaveInfo | null | void>,
    onRecordingStart?: () => void | Promise<unknown>,
    onRecordingCancel?: () => void | Promise<unknown>,
    checkRegistration?: (v: string) => Promise<ShortcutRegistrationInfo>,
    validate?: (v: string, event?: React.KeyboardEvent) => string | null,
    t: TFunction
}) {
    const [recording, setRecording] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const recorderRef = React.useRef<HTMLButtonElement | null>(null);
    const session = React.useRef(0);
    const recordingActive = React.useRef(false);
    const saving = React.useRef(false);
    const nativeUnlisten = React.useRef<(() => void) | undefined>();
    const cancelRef = React.useRef(onRecordingCancel);
    cancelRef.current = onRecordingCancel;
    const labelId = React.useId();
    const errorId = React.useId();

    React.useEffect(() => () => {
        session.current += 1;
        nativeUnlisten.current?.();
        if (recordingActive.current) {
            recordingActive.current = false;
            void Promise.resolve(cancelRef.current?.()).catch(e => error(`Failed to restore shortcut after recording: ${e}`));
        }
    }, []);

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
        session.current += 1;
        recordingActive.current = false;
        nativeUnlisten.current?.();
        nativeUnlisten.current = undefined;
        setRecording(false);
        restoreRecordedShortcut();
    };

    React.useEffect(() => {
        if (!recording || !nativeRecordingBridge) return;
        const handleWindowBlur = () => {
            if (!saving.current) stopRecordingAndRestore();
        };
        window.addEventListener("blur", handleWindowBlur);
        return () => window.removeEventListener("blur", handleWindowBlur);
    }, [recording, nativeRecordingBridge]);

    const startRecording = () => {
        if (recordingActive.current || saving.current) return;
        const currentSession = ++session.current;
        recordingActive.current = true;
        setErrorMessage(null);
        void (async () => {
            if (nativeRecordingBridge) {
                const unlisten = await nativeRecordingBridge.listen<string>("main-shortcut-recorded", event => {
                    if (session.current === currentSession && recordingActive.current && event.payload === "Super+V") {
                        saveShortcut(event.payload);
                    }
                });
                if (session.current !== currentSession) { unlisten(); return; }
                nativeUnlisten.current = unlisten;
            }
            await onRecordingStart?.();
            if (session.current !== currentSession) { restoreRecordedShortcut(); return; }
            setRecording(true);
        })()
            .catch((startError: unknown) => {
                if (session.current !== currentSession) return;
                setErrorMessage(t("settings.shortcut.saveFailed", { error: getErrorText(startError) }));
                stopRecordingAndRestore();
            });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // The Windows interceptor uses unassigned VK_E8 to prevent opening Start.
        if (nativeRecordingBridge && e.keyCode === 0xE8) return;

        if (e.key === "Escape" || e.key === "Esc") {
            setErrorMessage(null);
            stopRecordingAndRestore();
            return;
        }

        const modifiers = [];
        if (e.metaKey) modifiers.push(isWindowsPlatform() ? 'Super' : 'Command');
        if (e.ctrlKey) modifiers.push('Control');
        if (e.altKey) modifiers.push('Alt');
        if (e.shiftKey) modifiers.push('Shift');

        const rawKey = e.key;
        const keyUpper = rawKey.toUpperCase();
        if (['META', 'CONTROL', 'ALT', 'SHIFT'].includes(keyUpper)) return;

        const key = rawKey === " " ? "Space" : rawKey.length === 1 ? rawKey.toUpperCase() : formatShortcutLabel(rawKey).replace(/\s\+\s/g, "+");
        const shortcut = [...modifiers, key].join('+');
        saveShortcut(shortcut, e);
    };

    const saveShortcut = (shortcut: string, event?: React.KeyboardEvent) => {
        if (!recordingActive.current || saving.current) return;
        const validationError = validate?.(shortcut, event);
        if (validationError) {
            setErrorMessage(validationError);
            stopRecordingAndRestore();
            return;
        }

        saving.current = true;
        const currentSession = session.current;
        void Promise.resolve(checkRegistration?.(shortcut))
            .then(registrationInfo => {
                if (session.current !== currentSession) return null;
                const conflictMessage = registrationInfo?.conflict ? t("settings.shortcut.occupiedConflict") : null;
                return Promise.resolve(onChange(shortcut)).then(saveInfo => ({ conflictMessage, saveInfo }));
            })
            .then(result => {
                if (!result || session.current !== currentSession) return;
                const { conflictMessage, saveInfo } = result;
                const nextErrorMessage = saveInfo?.shortcut_conflict
                    ? t("settings.shortcut.occupiedConflict")
                    : conflictMessage;
                setErrorMessage(nextErrorMessage);
            })
            .catch((saveError: unknown) => {
                if (session.current !== currentSession) return;
                setErrorMessage(t("settings.shortcut.saveFailed", { error: getErrorText(saveError) }));
            })
            .finally(() => {
                saving.current = false;
                if (session.current === currentSession) stopRecordingAndRestore();
            });
    };

    const displayedValue = recording
        ? t("settings.shortcut.recording")
        : formatShortcutLabel(value) || t("settings.shortcut.clickToSet");

    return (
        <SettingsRow
            labelId={labelId}
            label={label}
            control={<div className={classes(styles, "shortcut-control")}>
                <ButtonBase
                    ref={recorderRef}
                    className={classes(styles, `shortcut-recorder ${recording ? "recording" : ""} ${value ? "" : "empty"} ${errorMessage ? "has-error" : ""}`)}
                    type="button"
                    aria-label={`${label}: ${displayedValue}`}
                    aria-describedby={errorMessage ? errorId : undefined}
                    onClick={startRecording}
                    onKeyDown={recording ? handleKeyDown : undefined}
                    onBlur={() => {
                        if (recordingActive.current && !saving.current) {
                            stopRecordingAndRestore();
                        }
                    }}
                >
                    {displayedValue}
                </ButtonBase>
                {errorMessage && <span id={errorId} role="alert" className={classes(styles, "shortcut-error-text")}>{errorMessage}</span>}
            </div>}
        />
    );
}
