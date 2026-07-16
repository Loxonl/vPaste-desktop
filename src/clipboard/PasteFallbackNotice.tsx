import React from "react";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import "./PasteFallbackNotice.css";

const NOTICE_DURATION_MS = 4000;

export default function PasteFallbackNotice() {
    const { t } = useLanguage();
    const [visible, setVisible] = React.useState(false);
    const timerRef = React.useRef<number | null>(null);

    const scheduleHide = React.useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
        }
        setVisible(true);
        timerRef.current = window.setTimeout(() => {
            setVisible(false);
            timerRef.current = null;
            void invoke("hide_paste_fallback_notice")
                .catch(e => error(`Failed to hide paste fallback notice: ${e}`));
        }, NOTICE_DURATION_MS);
    }, []);

    React.useEffect(() => {
        const unlisten = listen("paste-fallback-notice-show", scheduleHide);
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten paste fallback notice: ${e}`));
            if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current);
            }
        };
    }, [scheduleHide]);

    const openPermissionCenter = async () => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setVisible(false);
        try {
            await invoke("hide_paste_fallback_notice");
            await invoke("open_config_window", { target: "permissions" });
        } catch (e) {
            error(`Failed to open permission settings from paste fallback notice: ${e}`);
        }
    };

    return (
        <main className={`paste-fallback-notice-root ${visible ? "visible" : ""}`}>
            <section className="paste-fallback-notice" role="status" aria-live="polite">
                <span className="paste-fallback-notice-icon" aria-hidden="true">
                    <ContentCopyRoundedIcon />
                </span>
                <span className="paste-fallback-notice-message">
                    {t("clipboard.copyFallbackNotice")}
                </span>
                <button type="button" onClick={() => void openPermissionCenter()}>
                    {t("clipboard.enableAutoPaste")}
                </button>
            </section>
        </main>
    );
}
