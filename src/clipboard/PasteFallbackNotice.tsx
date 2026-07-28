import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import styles from "./PasteFallbackNotice.module.css";

export default function PasteFallbackNotice() {
    const { t } = useLanguage();

    const openPermissionCenter = async () => {
        try {
            await invoke("hide_paste_fallback_notice");
            await invoke("open_config_window", { target: "permissions" });
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
                <button type="button" onClick={() => void openPermissionCenter()}>
                    {t("clipboard.enableAutoPaste")}
                </button>
            </section>
        </main>
    );
}
