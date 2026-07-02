import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import "./TrayMenu.css";

type TrayAction = "show_main_panel" | "open_config_window" | "quit_app";
type PauseChangedPayload = { paused: boolean };

const TRAY_MENU_WIDTH = 184;

const items: Array<{ labelKey: string; action: TrayAction }> = [
    { labelKey: "tray.showMain", action: "show_main_panel" },
    { labelKey: "tray.settings", action: "open_config_window" },
    { labelKey: "tray.quit", action: "quit_app" },
];

export default function TrayMenu() {
    const { t } = useLanguage();
    const [paused, setPaused] = React.useState(false);
    const [toggleWorking, setToggleWorking] = React.useState(false);
    const menuRef = React.useRef<HTMLDivElement | null>(null);

    const resizeToContent = React.useCallback(() => {
        requestAnimationFrame(() => {
            const height = Math.ceil(menuRef.current?.getBoundingClientRect().height ?? 0);
            if (height > 0) {
                void invoke("resize_tray_menu", { width: TRAY_MENU_WIDTH, height })
                    .catch(e => error(`Failed to resize tray menu: ${e}`));
            }
        });
    }, []);

    React.useEffect(() => {
        resizeToContent();
    }, [paused, resizeToContent]);

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

    return (
        <div ref={menuRef} className="tray-menu-shell">
            <button
                type="button"
                className={`tray-status-card ${paused ? "paused" : "recording"}`}
                onClick={() => void togglePause()}
                disabled={toggleWorking}
                aria-pressed={paused}
            >
                <span className="tray-status-indicator" />
                <span className="tray-status-copy">
                    {t(paused ? "tray.resumeHistory" : "tray.pauseHistory")}
                </span>
                <span className="tray-status-state">
                    {t(paused ? "tray.historyPausedShort" : "tray.historyRecordingShort")}
                </span>
            </button>
            {items.map(item => (
                <button
                    key={item.action}
                    type="button"
                    className="tray-menu-item"
                    onClick={() => void runAction(item.action)}
                >
                    {t(item.labelKey)}
                </button>
            ))}
        </div>
    );
}
