import * as React from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import GitHubIcon from "@mui/icons-material/GitHub";
import LaunchOutlinedIcon from "@mui/icons-material/LaunchOutlined";
import { error } from "@tauri-apps/plugin-log";
import aboutLogo from "../../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import { restartReady, useAppUpdateState, type UpdateState } from "../../update";
import type { SettingsSectionProps, TFunction } from "../settingsTypes";
import ActionCard from "../../ui/ActionCard";
import { classes } from "../../ui/classNames";
import styles from "../Config.module.css";

const APP_REPOSITORY_URL = "https://github.com/Loxonl/vPaste-desktop";
const APP_CHANGELOG_URL = `${APP_REPOSITORY_URL}/releases`;

export default function AboutSettings({ bridge, t }: SettingsSectionProps & { dir: string }) {
    const { state: updateState, check, prepare, restartToUpdate } = useAppUpdateState(bridge);
    const [checkedManually, setCheckedManually] = React.useState(false);
    const updateBusy = updateState.status === "checking"
        || updateState.status === "downloading"
        || updateState.status === "installing";

    const openExternal = (url: string) => {
        void bridge.invoke("open_url_in_browser", { url }).catch(e => error(`Failed to open external link: ${e}`));
    };

    const handleCheckUpdate = async () => {
        try {
            setCheckedManually(true);
            const next = await check();
            if (next.status === "available" && !next.portable) {
                await prepare();
            } else if (
                next.status === "manualDownload"
                && window.confirm(t("settings.updateOpenReleasePrompt", {
                    version: next.availableVersion || "",
                }))
            ) {
                openExternal(next.releaseUrl);
            }
        } catch (e) {
            error(`Failed to check update: ${e}`);
        }
    };

    const handleRestartToUpdate = async () => {
        try {
            await restartToUpdate();
        } catch (e) {
            error(`Failed to restart and install update: ${e}`);
        }
    };

    const handlePrimaryUpdateAction = () => {
        if (restartReady(updateState)) {
            void handleRestartToUpdate();
        } else if (updateState.status === "available" && !updateState.portable) {
            void prepare().catch(e => error(`Failed to download update: ${e}`));
        } else {
            void handleCheckUpdate();
        }
    };

    const primaryActionText = restartReady(updateState)
        ? t("settings.updateRestart")
        : updateState.status === "checking"
            ? t("settings.updateChecking")
            : updateState.status === "available" && !updateState.portable
                ? t("settings.updateDownload")
                : t("settings.updateCheck");

    const displayVersion = updateState.currentVersion || t("settings.versionUnknown");
    const statusText = updateStatusText(updateState, checkedManually, t);

    return (
        <Stack spacing={2.25} className={classes(styles, "settings-page-stack")}>
            <Box className={classes(styles, "about-hero")}>
                <div className={classes(styles, "about-logo-tile")}>
                    <img src={aboutLogo} alt="vPaste" />
                </div>
                <div className={classes(styles, "about-copy")}>
                    <Typography variant="h5" className={classes(styles, "about-product-title")}>
                        vPaste
                    </Typography>
                    <Typography variant="body2" className={classes(styles, "about-product-subtitle")}>
                        {t("settings.about.subtitle")}
                    </Typography>
                    <div className={classes(styles, "about-version-actions")}>
                        <span className={classes(styles, "about-version-pill")}>
                            {t("common.version", { version: displayVersion })}
                        </span>
                        <Button
                            variant="contained"
                            color="inherit"
                            size="small"
                            disabled={updateBusy || !updateState.feedEnabled}
                            onClick={handlePrimaryUpdateAction}
                            sx={{ flex: '0 0 auto' }}
                        >
                            {primaryActionText}
                        </Button>
                    </div>
                    {statusText && (
                        <div className={classes(styles, `about-update-status ${updateState.status === 'failed' ? 'error' : updateState.status === 'available' || updateState.status === 'manualDownload' ? 'success' : 'working'}`)}>
                            {statusText}
                        </div>
                    )}
                </div>
            </Box>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.about.linksSection")}
                </Typography>
                <div className={classes(styles, "about-link-grid")}>
                    <ActionCard
                        icon={<ArticleOutlinedIcon fontSize="small" />}
                        title={t("settings.about.changelog")}
                        description={t("settings.about.changelog.desc")}
                        endAdornment={<LaunchOutlinedIcon fontSize="small" />}
                        onClick={() => openExternal(APP_CHANGELOG_URL)}
                    />
                    <ActionCard
                        icon={<GitHubIcon fontSize="small" />}
                        title={t("settings.about.github")}
                        description="Loxonl/vPaste-desktop"
                        endAdornment={<LaunchOutlinedIcon fontSize="small" />}
                        onClick={() => openExternal(APP_REPOSITORY_URL)}
                    />
                </div>
            </Box>
        </Stack>
    )
}

function updateStatusText(state: UpdateState, checkedManually: boolean, t: TFunction): string {
    const version = state.availableVersion || "";
    switch (state.status) {
        case "disabled":
            return t("settings.updateDisabled");
        case "checking":
            return t("settings.updateChecking");
        case "available":
            return t("settings.updateAvailable", { version });
        case "manualDownload":
            return t("settings.updatePortable", { version });
        case "downloading":
            return state.totalBytes
                ? t("settings.updateProgress", {
                    downloaded: formatUpdateBytes(state.downloadedBytes),
                    total: formatUpdateBytes(state.totalBytes),
                })
                : t("settings.updateProgressUnknown", { downloaded: formatUpdateBytes(state.downloadedBytes) });
        case "ready":
            return t("settings.updateReady", { version });
        case "installing":
            return t("settings.updateInstalling");
        case "failed":
            return t("settings.updateCheckFailed", { error: state.error || t("common.unknown") });
        case "idle":
            return checkedManually ? t("settings.updateLatest") : "";
    }
}

function formatUpdateBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
