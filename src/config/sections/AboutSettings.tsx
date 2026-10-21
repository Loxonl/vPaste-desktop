import * as React from "react";
import { Button, CircularProgress, IconButton, Typography } from "@mui/material";
import ArrowCircleUpRoundedIcon from "@mui/icons-material/ArrowCircleUpRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import GitHubIcon from "@mui/icons-material/GitHub";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import { error } from "@tauri-apps/plugin-log";
import aboutLogo from "../../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import { restartReady, storeUpdateAvailable, useAppUpdateState, type UpdateState } from "../../update";
import type { SettingsSectionProps, TFunction } from "../settingsTypes";
import { classes } from "../../ui/classNames";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { AnimatePresence, m, useMotionPreset } from "../../ui/motion";
import styles from "../Config.module.css";

const APP_WEBSITE_URL = "https://vpaste.app/";
const APP_REPOSITORY_URL = "https://github.com/Loxonl/vPaste-desktop";
const APP_CHANGELOG_URL = `${APP_REPOSITORY_URL}/releases`;
const STAR_PROMPT_DISMISSED_KEY = "vpaste.about.githubStarPromptDismissed";

function readStarPromptDismissed(): boolean {
    try {
        return localStorage.getItem(STAR_PROMPT_DISMISSED_KEY) === "1";
    } catch {
        return false;
    }
}

function rememberStarPromptDismissed() {
    try {
        localStorage.setItem(STAR_PROMPT_DISMISSED_KEY, "1");
    } catch {
        // Storage can be unavailable; the prompt then only hides for this session.
    }
}

type UpdateAction = "check" | "prepare" | "install" | "manualDownload" | "store";

export default function AboutSettings({ bridge, t, dialogBackdropClassName }: SettingsSectionProps & { dir: string, dialogBackdropClassName?: string }) {
    const { state: updateState, check, prepare, restartToUpdate, openAppStore } = useAppUpdateState(bridge);
    const [checkedManually, setCheckedManually] = React.useState(false);
    const [manualReleaseUrl, setManualReleaseUrl] = React.useState<string | null>(null);
    const [starPromptVisible, setStarPromptVisible] = React.useState(() => !readStarPromptDismissed());
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
            if (next.status === "available" && !next.portable && next.source !== "macAppStore") {
                await prepare();
            } else if (next.status === "manualDownload") {
                setManualReleaseUrl(next.releaseUrl);
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

    // One button checks for updates and, once a version is found, becomes "Update to X".
    const updateAction: UpdateAction = storeUpdateAvailable(updateState)
        ? "store"
        : restartReady(updateState)
        ? "install"
        : updateState.status === "available" && !updateState.portable
            ? "prepare"
            : updateState.status === "manualDownload"
                ? "manualDownload"
                : "check";
    const updateFound = updateAction !== "check";

    const handleUpdateAction = () => {
        switch (updateAction) {
            case "store":
                void openAppStore().catch(e => error(`Failed to open App Store: ${e}`));
                return;
            case "install":
                void handleRestartToUpdate();
                return;
            case "prepare":
                void prepare().catch(e => error(`Failed to download update: ${e}`));
                return;
            case "manualDownload":
                setManualReleaseUrl(updateState.releaseUrl);
                return;
            case "check":
                void handleCheckUpdate();
        }
    };

    const updateButtonText = updateState.status === "checking"
        ? t("settings.updateChecking")
        : updateState.status === "downloading"
            ? t("settings.updateDownloading")
            : updateState.status === "installing"
                ? t("settings.updateInstallingShort")
                : updateAction === "store"
                    ? t("settings.updateOpenAppStore")
                    : updateFound
                    ? t("settings.updateTo", { version: updateState.availableVersion || "" })
                    : updateState.status === "failed"
                        ? t("settings.updateRetry")
                        : t("settings.updateCheck");
    const updateButtonIcon = updateBusy
        ? <CircularProgress size={14} thickness={5} color="inherit" aria-hidden="true" />
        : updateFound
            ? <ArrowCircleUpRoundedIcon fontSize="small" />
            : <SyncRoundedIcon fontSize="small" />;

    const displayVersion = updateState.currentVersion || t("settings.versionUnknown");
    const statusText = updateStatusText(updateState, checkedManually, t);
    const statusMotion = useMotionPreset("fade");
    const promptMotion = useMotionPreset("listItem");
    const updateHasError = updateState.status === "failed"
        || (updateState.status === "ready" && Boolean(updateState.error));

    const dismissStarPrompt = () => {
        rememberStarPromptDismissed();
        setStarPromptVisible(false);
    };

    const links = [
        { key: "website", url: APP_WEBSITE_URL, icon: <LanguageRoundedIcon fontSize="small" />, label: t("settings.about.website") },
        { key: "github", url: APP_REPOSITORY_URL, icon: <GitHubIcon fontSize="small" />, label: t("settings.about.github") },
        { key: "changelog", url: APP_CHANGELOG_URL, icon: <HistoryRoundedIcon fontSize="small" />, label: t("settings.about.changelog") },
    ];

    return (
        <div className={classes(styles, "about-page")}>
            <section className={classes(styles, "about-hero")} aria-labelledby="about-product-name">
                <img className={classes(styles, "about-logo")} src={aboutLogo} alt="" />
                <div className={classes(styles, "about-copy")}>
                    <Typography id="about-product-name" variant="h5" className={classes(styles, "about-product-title")}>
                        vPaste
                    </Typography>
                    <Typography variant="body2" className={classes(styles, "about-version")}>
                        {t("common.version", { version: displayVersion })}
                    </Typography>
                    <AnimatePresence mode="wait" initial={false}>
                        {statusText && (
                            <m.div
                                key={`${updateState.status}-${updateState.errorStage ?? ""}`}
                                variants={statusMotion}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                data-motion-preset="fade"
                            >
                                <Typography
                                    variant="body2"
                                    className={classes(styles, `about-update-status${updateHasError ? " is-error" : ""}`)}
                                    role={updateHasError ? "alert" : "status"}
                                    aria-live={updateHasError ? "assertive" : "polite"}
                                >
                                    {statusText}
                                </Typography>
                            </m.div>
                        )}
                    </AnimatePresence>
                </div>
                <Button
                    className={classes(styles, "about-update-button")}
                    variant={updateFound ? "contained" : "outlined"}
                    disableElevation
                    startIcon={updateButtonIcon}
                    disabled={updateBusy || !updateState.feedEnabled}
                    onClick={handleUpdateAction}
                >
                    {updateButtonText}
                </Button>
            </section>

            <AnimatePresence mode="wait" initial={false}>
                {starPromptVisible && (
                    <m.div
                        key="github-star-prompt"
                        variants={promptMotion}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-motion-preset="listItem"
                    >
                        <div className={classes(styles, "about-star-prompt")} role="note">
                            <StarRoundedIcon className={classes(styles, "about-star-icon")} aria-hidden="true" />
                            <Typography variant="body2" className={classes(styles, "about-star-text")}>
                                {t("settings.about.starPrompt")}
                            </Typography>
                            <Button
                                size="small"
                                className={classes(styles, "about-star-action")}
                                variant="contained"
                                disableElevation
                                startIcon={<GitHubIcon fontSize="small" />}
                                onClick={() => openExternal(APP_REPOSITORY_URL)}
                            >
                                {t("settings.about.starAction")}
                            </Button>
                            <IconButton
                                size="small"
                                className={classes(styles, "about-star-dismiss")}
                                aria-label={t("settings.about.starDismiss")}
                                title={t("settings.about.starDismiss")}
                                onClick={dismissStarPrompt}
                            >
                                <CloseRoundedIcon fontSize="small" />
                            </IconButton>
                        </div>
                    </m.div>
                )}
            </AnimatePresence>

            <section className={classes(styles, "about-links-section")} aria-labelledby="about-links-title">
                <Typography id="about-links-title" variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.about.linksSection")}
                </Typography>
                <div className={classes(styles, "about-links")}>
                    {links.map(link => (
                        <Button
                            key={link.key}
                            variant="outlined"
                            startIcon={link.icon}
                            className={classes(styles, "about-link-button")}
                            onClick={() => openExternal(link.url)}
                        >
                            {link.label}
                        </Button>
                    ))}
                </div>
            </section>

            <ConfirmDialog
                open={manualReleaseUrl !== null}
                title={t("settings.updateOpenReleaseTitle")}
                description={t("settings.updateOpenReleasePrompt", {
                    version: updateState.availableVersion || "",
                })}
                cancelLabel={t("common.cancel")}
                confirmLabel={t("settings.updateOpenRelease")}
                backdropClassName={dialogBackdropClassName}
                destructive={false}
                onCancel={() => setManualReleaseUrl(null)}
                onConfirm={() => {
                    const releaseUrl = manualReleaseUrl;
                    setManualReleaseUrl(null);
                    if (releaseUrl) openExternal(releaseUrl);
                }}
            />
        </div>
    );
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
            // An install that failed to start leaves the verified package ready to retry.
            return state.errorStage === "install" && state.error
                ? t("settings.updateReadyInstallFailed", { error: state.error })
                : t("settings.updateReady", { version });
        case "installing":
            return t("settings.updateInstalling");
        case "failed": {
            const error = state.error || t("common.unknown");
            switch (state.errorStage) {
                case "download":
                    return t("settings.updateDownloadFailed", { error });
                case "restore":
                    return t("settings.updateRestoreFailed", { error });
                case "install":
                    return t("settings.updateInstallFailed", { error });
                default:
                    return t("settings.updateCheckFailed", { error });
            }
        }
        case "idle":
            return checkedManually ? t("settings.updateLatest") : "";
    }
}

function formatUpdateBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
