import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import MenuItem from "@mui/material/MenuItem";
import MenuList from "@mui/material/MenuList";
import Paper from "@mui/material/Paper";
import { useLanguage } from "../lang";
import { restartReady, useAppUpdateState } from "../update";
import styles from "./TrayMenu.module.css";

type TrayAction = "show_main_panel" | "open_config_window" | "quit_app";
type PauseChangedPayload = { paused: boolean };

const TRAY_MENU_CONTENT_WIDTH = 200;
const WINDOW_SURFACE_GUTTER = 8;
const MACOS_TRAY_MENU_GUTTER_X = 10;
const isMacOS = navigator.userAgent.toLowerCase().includes("macintosh");

const items: Array<{ labelKey: string; action: TrayAction }> = [
    { labelKey: "tray.showMain", action: "show_main_panel" },
    { labelKey: "tray.settings", action: "open_config_window" },
    { labelKey: "tray.quit", action: "quit_app" },
];

export default function TrayMenu() {
    const { t } = useLanguage();
    const { state: updateState, restartToUpdate } = useAppUpdateState();
    const [paused, setPaused] = React.useState(false);
    const [toggleWorking, setToggleWorking] = React.useState(false);
    const menuRef = React.useRef<HTMLDivElement | null>(null);

    const resizeToContent = React.useCallback(() => {
        requestAnimationFrame(() => {
            const height = Math.ceil(menuRef.current?.getBoundingClientRect().height ?? 0);
            if (height > 0) {
                const width = isMacOS
                    ? TRAY_MENU_CONTENT_WIDTH + MACOS_TRAY_MENU_GUTTER_X * 2
                    : TRAY_MENU_CONTENT_WIDTH + WINDOW_SURFACE_GUTTER * 2;
                void invoke("resize_tray_menu", { width, height })
                    .catch(e => error(`Failed to resize tray menu: ${e}`));
            }
        });
    }, []);

    React.useEffect(() => {
        resizeToContent();
    }, [paused, updateState.status, resizeToContent]);

    React.useEffect(() => {
        void invoke<boolean>("get_clipboard_history_paused")
            .then(setPaused)
            .catch(e => error(`Failed to load clipboard history pause state: ${e}`));
        const unlisten = listen<PauseChangedPayload>("clipboard-history-pause-changed", event => {
            setPaused(event.payload.paused);
        });
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten pause state: ${e}`));
        };
    }, []);

    React.useEffect(() => {
        const handleBlur = () => {
            void invoke("hide_tray_menu").catch(e => error(`Failed to hide tray menu: ${e}`));
        };
        const preventContextMenu = (event: MouseEvent) => {
            event.preventDefault();
        };
        window.addEventListener("blur", handleBlur);
        window.addEventListener("contextmenu", preventContextMenu);
        return () => {
            window.removeEventListener("blur", handleBlur);
            window.removeEventListener("contextmenu", preventContextMenu);
        };
    }, []);

    const togglePause = async () => {
        if (toggleWorking) return;
        setToggleWorking(true);
        try {
            const nextPaused = await invoke<boolean>("toggle_clipboard_history_paused");
            setPaused(nextPaused);
        } catch (e) {
            error(`Failed to toggle clipboard history pause state: ${e}`);
        } finally {
            setToggleWorking(false);
        }
    };

    const runAction = async (action: TrayAction) => {
        try {
            await invoke(action);
            if (action !== "quit_app") {
                await invoke("hide_tray_menu");
            }
        } catch (e) {
            error(`Failed to run tray action ${action}: ${e}`);
        }
    };

    const restartForUpdate = async () => {
        try {
            await restartToUpdate();
        } catch (e) {
            error(`Failed to restart and install update: ${e}`);
        }
    };

    return (
        <div ref={menuRef} className={[styles["tray-menu-frame"], isMacOS ? styles.macos : ""].join(" ")}>
            <Paper component="nav" square elevation={0} className={styles["tray-menu-shell"]} aria-label={t("tray.menu")}>
                <MenuList disablePadding className={styles["tray-menu-list"]}>
                <MenuItem
                    className={[styles["tray-status-card"], styles[paused ? "paused" : "recording"]].join(" ")}
                    onClick={() => void togglePause()}
                    disabled={toggleWorking}
                    aria-pressed={paused}
                >
                    <span className={styles["tray-status-indicator"]} />
                    <span className={styles["tray-status-copy"]}>
                        {t(paused ? "tray.resumeHistory" : "tray.pauseHistory")}
                    </span>
                    <span className={styles["tray-status-state"]}>
                        {t(paused ? "tray.historyPausedShort" : "tray.historyRecordingShort")}
                    </span>
                </MenuItem>
                {restartReady(updateState) && (
                    <MenuItem
                        className={`${styles["tray-menu-item"]} ${styles["update-ready"]}`}
                        onClick={() => void restartForUpdate()}
                    >
                        <span>{t("tray.updateReady", { version: updateState.availableVersion || "" })}</span>
                        <strong>{t("tray.updateRestart")}</strong>
                    </MenuItem>
                )}
                {items.map(item => (
                    <MenuItem
                        key={item.action}
                        className={styles["tray-menu-item"]}
                        onClick={() => void runAction(item.action)}
                    >
                        {t(item.labelKey)}
                    </MenuItem>
                ))}
                </MenuList>
            </Paper>
        </div>
    );
}
