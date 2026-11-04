import * as React from "react";
import Alert from "@mui/material/Alert";
import Slider from "@mui/material/Slider";
import { error } from "@tauri-apps/plugin-log";
import { SettingsRow } from "../../ui/settings/SettingsPrimitives";
import { createPanelSizePreview, isPanelSizeState, PANEL_SIZES, panelSizePercent, type PanelSize, type PanelSizePreference, type PanelSizeState } from "../panelSizePreview";
import type { SettingsBridge } from "../SettingsBridge";
import type { TFunction } from "../settingsTypes";
import styles from "./PanelSizeSetting.module.css";

type Gesture = ReturnType<typeof createPanelSizePreview>;
const navigationKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export default function PanelSizeSetting({ bridge, value, onSaved, t }: {
    bridge: SettingsBridge;
    value: PanelSizePreference;
    onSaved?: (size: PanelSizePreference) => void;
    t: TFunction;
}) {
    const [draft, setDraft] = React.useState<PanelSize>(value ?? "large");
    const [screen, setScreen] = React.useState<PanelSizeState | null>(null);
    const [ready, setReady] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const gesture = React.useRef<Gesture | null>(null);
    const mounted = React.useRef(true);
    const savingRef = React.useRef(false);
    const keyboardGesture = React.useRef(false);
    const requestSequence = React.useRef(0);
    const current = React.useRef({ value, onSaved, fallback: draft });
    current.current = { value, onSaved, fallback: value ?? screen?.recommended ?? "large" };

    const refresh = React.useCallback(() => {
        if (gesture.current || savingRef.current) return;
        const request = ++requestSequence.current;
        void bridge.invoke<PanelSizeState>("get_clipboard_panel_size_state").then(state => {
            if (!mounted.current || request !== requestSequence.current || gesture.current || savingRef.current) return;
            if (!isPanelSizeState(state)) throw new Error("Invalid panel size state");
            current.current.onSaved?.(state.preference);
            setScreen(state);
            setDraft(state.effective);
            setFailed(false);
            setReady(true);
        }).catch(cause => {
            if (!mounted.current || request !== requestSequence.current) return;
            error(`Failed to read panel size recommendation: ${cause}`);
            setFailed(true);
            setReady(true);
        });
    }, [bridge]);

    const finish = React.useCallback((commit: boolean) => {
        const active = gesture.current;
        if (!active) return;
        gesture.current = null;
        ++requestSequence.current;
        keyboardGesture.current = false;
        savingRef.current = true;
        if (mounted.current) setSaving(true);
        void active.finish(commit).then(state => {
            if (state) current.current.onSaved?.(state.preference);
            if (!mounted.current) return;
            if (state) setScreen(state);
            setDraft(state?.effective ?? current.current.fallback);
        }).catch(cause => {
            error(`Failed to finish main panel size preview: ${cause}`);
            if (mounted.current) { setDraft(current.current.fallback); setFailed(true); }
        }).finally(() => {
            savingRef.current = false;
            if (mounted.current) setSaving(false);
        });
    }, []);

    const begin = (size: PanelSize) => {
        if (!ready || gesture.current || savingRef.current) return;
        ++requestSequence.current;
        setFailed(false);
        setDraft(size);
        gesture.current = createPanelSizePreview(bridge, size, cause => {
            error(`Failed to preview main panel size: ${cause}`);
            if (mounted.current) setFailed(true);
            finish(false);
        });
    };

    React.useEffect(() => {
        if (!gesture.current && !savingRef.current) setDraft(value ?? screen?.recommended ?? "large");
    }, [value, screen?.recommended]);

    React.useEffect(() => {
        mounted.current = true;
        refresh();
        let refreshTimer: ReturnType<typeof window.setTimeout> | undefined;
        const refreshDisplay = () => {
            window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(refresh, 100);
        };
        const displayListener = bridge.listen("panel-size-display-changed", refreshDisplay);
        const openedListener = bridge.listen("config-opened", refreshDisplay);
        const release = () => {
            const active = gesture.current;
            window.setTimeout(() => { if (gesture.current === active) finish(true); }, 0);
        };
        const cancel = () => finish(false);
        const keydown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && gesture.current) {
                event.preventDefault();
                event.stopPropagation();
                cancel();
            }
        };
        const keyup = (event: KeyboardEvent) => { if (navigationKeys.has(event.key)) release(); };
        const visibility = () => { if (document.visibilityState !== "visible") cancel(); else refresh(); };
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("focus", refresh);
        window.addEventListener("keydown", keydown, true);
        window.addEventListener("keyup", keyup);
        document.addEventListener("visibilitychange", visibility);
        return () => {
            mounted.current = false;
            ++requestSequence.current;
            cancel();
            window.clearTimeout(refreshTimer);
            for (const listener of [displayListener, openedListener]) {
                void listener.then(unlisten => unlisten()).catch(cause => error(`Failed to remove panel size listener: ${cause}`));
            }
            window.removeEventListener("pointerup", release);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("blur", cancel);
            window.removeEventListener("focus", refresh);
            window.removeEventListener("keydown", keydown, true);
            window.removeEventListener("keyup", keyup);
            document.removeEventListener("visibilitychange", visibility);
        };
    }, [bridge, finish, refresh]);

    const text = (size: PanelSize) => `${t(`settings.panelSize.${size}`)} · ${panelSizePercent(size)}%${size === "large" ? ` · ${t("settings.panelSize.default")}` : ""}`;
    const change = (_event: Event, next: number | number[]) => {
        const size = PANEL_SIZES[Number(next)];
        if (!ready || !size || savingRef.current) return;
        if (!gesture.current) begin(size);
        setDraft(size);
        gesture.current?.update(size);
    };

    return <SettingsRow labelId="settings-panel-size-label" label={t("settings.panelSize")} control={<div className={styles.control}>
        <div className={styles.slider}>
            <Slider min={0} max={2} step={1} value={PANEL_SIZES.indexOf(draft)} disabled={!ready || saving}
                marks={PANEL_SIZES.map((_size, value) => ({ value }))}
                aria-labelledby="settings-panel-size-label"
                slotProps={{ input: { "aria-describedby": failed ? "settings-panel-size-error" : undefined } }}
                getAriaValueText={index => text(PANEL_SIZES[index])}
                valueLabelDisplay="off"
                onPointerDownCapture={event => {
                    if (!ready || event.button !== 0 || savingRef.current) return;
                    keyboardGesture.current = false;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const index = Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 2);
                    begin(PANEL_SIZES[index]);
                    if (event.target instanceof HTMLElement) event.target.setPointerCapture?.(event.pointerId);
                }}
                onKeyDownCapture={event => { if (navigationKeys.has(event.key)) { keyboardGesture.current = true; begin(draft); } }}
                onBlur={() => finish(false)} onChange={change}
                onChangeCommitted={() => { if (!keyboardGesture.current) finish(true); }} />
            <span className={styles.defaultMark} aria-hidden="true">{t("settings.panelSize.default")}</span>
        </div>
        {failed && <Alert id="settings-panel-size-error" severity="error">{t("settings.panelSize.error")}</Alert>}
    </div>} />;
}
