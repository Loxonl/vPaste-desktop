import { useEffect } from "react";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import Button from "@mui/material/Button";
import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import { notifyAuxiliaryWindowReady } from "../auxiliaryWindowReady";
import styles from "./PasteFallbackNotice.module.css";

type PasteFallbackNoticeProps = {
    showSettingsAction?: boolean;
};

export default function PasteFallbackNotice({
    showSettingsAction = true,
}: PasteFallbackNoticeProps) {
    const { t } = useLanguage();
    useEffect(() => notifyAuxiliaryWindowReady(), []);

    const openPermissionCenter = async () => {
        try {
            // Dispatch navigation while this webview can still send commands.
            await invoke("open_config_window", { target: "permissions" });
            await invoke("hide_paste_fallback_notice");
        } catch (e) {
            error(`Failed to open permission settings from paste fallback notice: ${e}`);
        }
    };

    return (
        <main className={styles["paste-fallback-notice-root"]}>
            <section className={styles["paste-fallback-notice"]} role="status" aria-live="polite">
                <span className={styles["paste-fallback-notice-icon"]} aria-hidden="true">
                    <ContentCopyRoundedIcon />
                </span>
                <span className={styles["paste-fallback-notice-message"]}>
                    {t("clipboard.copyFallbackNotice")}
                </span>
                {showSettingsAction ? (
                    <Button variant="contained" className={styles["paste-fallback-notice-action"]} onClick={() => void openPermissionCenter()}>
                        {t("common.settings")}
                    </Button>
                ) : null}
            </section>
        </main>
    );
}
