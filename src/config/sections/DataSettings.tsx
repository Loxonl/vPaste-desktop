import * as React from "react";
import { Avatar, Box, Button, ButtonGroup, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, List, ListItem, ListItemText, Menu, MenuItem, Stack, Switch, Typography } from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import AutoDeleteOutlinedIcon from "@mui/icons-material/AutoDeleteOutlined";
import CloseIcon from "@mui/icons-material/Close";
import FileDownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import FileUploadIcon from "@mui/icons-material/FileUploadOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import { error } from "@tauri-apps/plugin-log";
import { displayAppSource, type AppSourceOption } from "../../clipboard/appSource";
import type { HistoryArchiveInfo, HistoryArchiveProgressPayload, SettingsBlockingOperation, SettingsSectionProps, StorageCleanupInfo, StoragePaths, TFunction } from "../settingsTypes";
import { classes } from "../../ui/classNames";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { AnimatePresence, m, useMotionPreset } from "../../ui/motion";
import { OperationStatus } from "../../ui/OperationStatus";
import styles from "../Config.module.css";

export default function DataSettings({ bridge, config, storagePaths, t, onSave, onBlockingOperationChange, dialogBackdropClassName }: SettingsSectionProps & { storagePaths: StoragePaths | null, onBlockingOperationChange: (operation: SettingsBlockingOperation | null) => void, dialogBackdropClassName?: string }) {
    const [legacyHistoryBlocked, setLegacyHistoryBlocked] = React.useState(false);
    const [storageDirDraft, setStorageDirDraft] = React.useState(config.storage_dir || "");
    const [cleanupDays, setCleanupDays] = React.useState<string>("");
    const [cleanupInfo, setCleanupInfo] = React.useState<StorageCleanupInfo | null>(null);
    const [storageSummary, setStorageSummary] = React.useState<StorageCleanupInfo | null>(null);
    const [recentAppSources, setRecentAppSources] = React.useState<AppSourceOption[]>([]);
    const [privacyAppsDraft, setPrivacyAppsDraft] = React.useState<string[]>(Array.isArray(config.ignored_app_sources) ? config.ignored_app_sources : []);
    const [privacyAppsSaving, setPrivacyAppsSaving] = React.useState(false);
    const [privacyAppsLoading, setPrivacyAppsLoading] = React.useState(false);
    const [privacyManagerOpen, setPrivacyManagerOpen] = React.useState(false);
    const [cleanupMenuAnchor, setCleanupMenuAnchor] = React.useState<HTMLElement | null>(null);
    const [cleanupConfirmOpen, setCleanupConfirmOpen] = React.useState(false);
    const [legacyCleanupConfirmOpen, setLegacyCleanupConfirmOpen] = React.useState(false);
    const [legacyCleanupWorking, setLegacyCleanupWorking] = React.useState(false);
    const [legacyCleanupError, setLegacyCleanupError] = React.useState<string | null>(null);
    const [cleanupWorking, setCleanupWorking] = React.useState(false);
    const [historyWorkingArea, setHistoryWorkingArea] = React.useState<'storage' | 'export' | 'import' | null>(null);
    const [historyMessage, setHistoryMessage] = React.useState<{ kind: 'success' | 'error', text: string } | null>(null);
    const [transferMessage, setTransferMessage] = React.useState<{ kind: 'success' | 'error', text: string } | null>(null);
    const [archiveProgress, setArchiveProgress] = React.useState<HistoryArchiveProgressPayload | null>(null);
    const historyWorking = historyWorkingArea !== null;
    const transferWorking = historyWorkingArea === 'export' || historyWorkingArea === 'import';
    const transferOperation = historyWorkingArea === 'export' || historyWorkingArea === 'import' ? historyWorkingArea : null;
    const activeArchiveProgress = transferOperation && archiveProgress?.operation === transferOperation ? archiveProgress : null;
    const transferProgressValue = getHistoryArchiveProgressValue(activeArchiveProgress);
    const transferWorkingText = getHistoryArchiveProgressText(t, activeArchiveProgress, transferOperation);
    const fadeMotion = useMotionPreset("fade");
    const listItemMotion = useMotionPreset("listItem");

    React.useEffect(() => {
        setStorageDirDraft(config.storage_dir || "");
    }, [config.storage_dir]);

    React.useEffect(() => {
        if (!privacyAppsSaving) {
            setPrivacyAppsDraft(Array.isArray(config.ignored_app_sources) ? config.ignored_app_sources : []);
        }
    }, [config.ignored_app_sources, privacyAppsSaving]);

    const loadRecentAppSources = React.useCallback(async () => {
        setPrivacyAppsLoading(true);
        try {
            const sources = await bridge.invoke<AppSourceOption[]>('list_recent_app_source_options', { days: 30 });
            setRecentAppSources(sources);
        } catch (e) {
            error(`Failed to load recent app sources: ${e}`);
        } finally {
            setPrivacyAppsLoading(false);
        }
    }, [bridge]);

    React.useEffect(() => {
        loadRecentAppSources();
    }, [loadRecentAppSources]);

    const refreshStorageSummary = React.useCallback(() => {
        bridge.invoke<StorageCleanupInfo>('estimate_storage_cleanup', { days: 0 })
            .then(setStorageSummary)
            .catch(e => error(`Failed to load storage summary: ${e}`));
    }, [bridge]);

    React.useEffect(() => {
        refreshStorageSummary();
    }, [refreshStorageSummary]);

    React.useEffect(() => {
        bridge.invoke<{ migration_required: boolean }>('get_history_format_status')
            .then(status => setLegacyHistoryBlocked(status.migration_required))
            .catch(e => error(`Failed to load history format status: ${e}`));
        const unlisten = bridge.listen<{ migration_required: boolean }>('history-format-status-changed', event => {
            setLegacyHistoryBlocked(event.payload.migration_required);
        });
        return () => { unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten history format status: ${e}`)); };
    }, [bridge]);

    const handleClearLegacyHistory = async () => {
        if (legacyCleanupWorking) return;
        setLegacyCleanupWorking(true);
        setLegacyCleanupError(null);
        try {
            await bridge.invoke('clear_legacy_history', { confirmation: 'CLEAR_LEGACY_HISTORY' });
            setLegacyHistoryBlocked(false);
            setLegacyCleanupConfirmOpen(false);
            refreshStorageSummary();
        } catch (e) {
            void error(`Failed to clear legacy history: ${e}`).catch(() => undefined);
            setLegacyCleanupError(t("settings.legacyHistory.clearFailed", { error: String(e) }));
        } finally {
            setLegacyCleanupWorking(false);
        }
    };

    React.useEffect(() => {
        const resetCleanup = () => {
            setCleanupDays("");
            setCleanupInfo(null);
            refreshStorageSummary();
        };
        const unlisten = bridge.listen("config-opened", resetCleanup);
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten config-opened: ${e}`));
        };
    }, [bridge, refreshStorageSummary]);

    React.useEffect(() => {
        const unlisten = bridge.listen<HistoryArchiveProgressPayload>("history-archive-progress", event => {
            setArchiveProgress(event.payload);
        });
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten history archive progress: ${e}`));
        };
    }, [bridge]);

    React.useEffect(() => {
        if (!transferWorking || !transferOperation) return;
        onBlockingOperationChange({
            title: t(transferOperation === 'export' ? "settings.exportWorkingTitle" : "settings.importWorkingTitle"),
            description: transferWorkingText,
            progress: transferProgressValue
        });
    }, [onBlockingOperationChange, t, transferOperation, transferProgressValue, transferWorking, transferWorkingText]);

    const refreshCleanupInfo = React.useCallback((days: number) => {
        bridge.invoke('estimate_storage_cleanup', { days })
            .then(v => setCleanupInfo(v as StorageCleanupInfo))
            .catch(e => error(`Failed to estimate storage cleanup: ${e}`));
    }, [bridge]);

    React.useEffect(() => {
        if (!cleanupDays) {
            setCleanupInfo(null);
            return;
        }
        refreshCleanupInfo(Number(cleanupDays));
    }, [cleanupDays, refreshCleanupInfo]);

    const handleChooseStorageDir = async () => {
        try {
            const selected = await bridge.open({
                directory: true,
                multiple: false,
                defaultPath: storageDirDraft || storagePaths?.history_storage_dir || storagePaths?.app_data_dir,
            });
            if (typeof selected === "string" && selected) {
                setHistoryWorkingArea('storage');
                setHistoryMessage(null);
                setTransferMessage(null);
                setStorageDirDraft(selected);
                await onSave({ ...config, storage_dir: selected });
                setHistoryMessage({
                    kind: 'success',
                    text: t("settings.storageUpdated")
                });
            }
        } catch (e) {
            error(`Failed to choose storage directory: ${e}`);
            setHistoryMessage({ kind: 'error', text: t("settings.storageUpdateFailed", { error: String(e) }) });
        } finally {
            setHistoryWorkingArea(null);
        }
    };

    const handleExportHistory = async () => {
        try {
            const target = await bridge.save({
                defaultPath: "vpaste-history.vphistory",
                filters: [{ name: "vPaste History", extensions: ["vphistory"] }],
            });
            if (!target) return;
            setHistoryWorkingArea('export');
            setTransferMessage(null);
            setArchiveProgress(null);
            onBlockingOperationChange({
                title: t("settings.exportWorkingTitle"),
                description: t("settings.exportWorkingDesc")
            });
            await bridge.invoke<HistoryArchiveInfo>('export_history_archive', { archivePath: target });
            setTransferMessage({
                kind: 'success',
                text: t("settings.exportSuccess")
            });
        } catch (e) {
            error(`Failed to export history: ${e}`);
            setTransferMessage({ kind: 'error', text: t("settings.exportFailed", { error: String(e) }) });
        } finally {
            setHistoryWorkingArea(null);
            setArchiveProgress(null);
            onBlockingOperationChange(null);
        }
    };

    const handleImportHistory = async () => {
        try {
            const selected = await bridge.open({
                multiple: false,
                filters: [{ name: "vPaste History", extensions: ["vphistory"] }],
            });
            if (typeof selected !== "string" || !selected) return;
            setHistoryWorkingArea('import');
            setTransferMessage(null);
            setArchiveProgress(null);
            onBlockingOperationChange({
                title: t("settings.importWorkingTitle"),
                description: t("settings.importWorkingDesc")
            });
            const result = await bridge.invoke<HistoryArchiveInfo>('import_history_archive', { archivePath: selected });
            setTransferMessage({
                kind: 'success',
                text: t("settings.importSuccess", { merged: result.merged_items, skipped: result.skipped_items, files: result.copied_files })
            });
            if (cleanupDays) {
                refreshCleanupInfo(Number(cleanupDays));
            }
            refreshStorageSummary();
        } catch (e) {
            error(`Failed to import history: ${e}`);
            setTransferMessage({ kind: 'error', text: t("settings.importFailed", { error: String(e) }) });
        } finally {
            setHistoryWorkingArea(null);
            setArchiveProgress(null);
            onBlockingOperationChange(null);
        }
    };

    const handleCleanupStorage = async () => {
        if (!cleanupDays || cleanupWorking || historyWorking) return;
        setCleanupConfirmOpen(false);
        setCleanupWorking(true);
        try {
            const info = await bridge.invoke<StorageCleanupInfo>('cleanup_storage_history', { days: Number(cleanupDays) });
            setCleanupInfo(info);
            const nextInfo = await bridge.invoke<StorageCleanupInfo>('estimate_storage_cleanup', { days: Number(cleanupDays) });
            setCleanupInfo(nextInfo);
            refreshStorageSummary();
        } catch (e) {
            error(`Failed to cleanup storage history: ${e}`);
        } finally {
            setCleanupWorking(false);
        }
    };

    const ignoredAppSources = privacyAppsDraft;
    const recentAppSourceMap = new Map(recentAppSources.map(option => [option.source, option]));
    const handlePrivacyAppChange = async (source: string, enabled: boolean) => {
        if (!source || privacyAppsSaving) return;
        const previous = privacyAppsDraft;
        const next = enabled ? [...previous, source] : previous.filter(item => item !== source);
        if (next.length === previous.length) return;
        setPrivacyAppsDraft(next);
        setPrivacyAppsSaving(true);
        try {
            await onSave({ ...config, ignored_app_sources: next });
        } catch {
            setPrivacyAppsDraft(previous);
        } finally {
            setPrivacyAppsSaving(false);
        }
    };

    const handleOpenPrivacyManager = () => {
        setPrivacyManagerOpen(true);
        void loadRecentAppSources();
    };

    const managedPrivacyApps: AppSourceOption[] = [
        ...ignoredAppSources.map(source => recentAppSourceMap.get(source) || { source }),
        ...recentAppSources.filter(option => !ignoredAppSources.includes(option.source)),
    ];

    const cleanupRangeLabel = cleanupDays
        ? t(`settings.cleanup.${cleanupDays === "0" ? "all" : cleanupDays}`)
        : t("settings.cleanupSelect");
    const currentStoragePath = storageDirDraft || storagePaths?.history_storage_dir || t("settings.defaultAppDataDir");

    const renderPrivacyAppIcon = (source: string, iconPath?: string) => {
        return (
            <Avatar
                variant={iconPath ? "square" : "rounded"}
                src={iconPath ? bridge.convertFileSrc(iconPath) : undefined}
                alt=""
                className={classes(styles, `privacy-app-option-icon ${iconPath ? "app-icon" : "placeholder"}`)}
            >
                {displayAppSource(source, t).slice(0, 1).toUpperCase()}
            </Avatar>
        );
    };

    return (
        <Stack spacing={6}>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.section.dataSecurity")}
                </Typography>
                <List>
                    <ListItem sx={{ alignItems: 'flex-start' }}>
                        <Stack spacing={3} sx={{ width: '100%' }}>
                            <div className={styles["privacy-app-heading"]}>
                                <ListItemText
                                    primary={t("settings.privacyApps")}
                                    secondary={t("settings.privacyApps.desc")}
                                />
                                <Button
                                    variant="text"
                                    size="small"
                                    onClick={handleOpenPrivacyManager}
                                    className={classes(styles, "data-action-button")}
                                >
                                    {t("settings.privacyApps.manage")}
                                </Button>
                            </div>
                            <AnimatePresence mode="wait" initial={false}>
                                {ignoredAppSources.length > 0 ? (
                                    <m.div
                                        key="protected-app-list"
                                        variants={fadeMotion}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                        data-motion-preset="fade"
                                    >
                                        <List component="div" role="list" dense disablePadding className={styles["privacy-app-list"]}>
                                            <AnimatePresence mode="sync" initial={false}>
                                                {ignoredAppSources.map(source => {
                                                    const option = recentAppSourceMap.get(source);
                                                    return (
                                                        <m.div
                                                            key={source}
                                                            role="listitem"
                                                            className={styles["privacy-app-motion-item"]}
                                                            variants={listItemMotion}
                                                            initial="initial"
                                                            animate="animate"
                                                            exit="exit"
                                                            data-motion-preset="listItem"
                                                        >
                                                            <ListItem component="div" disableGutters className={styles["privacy-app-chip"]} title={source}>
                                                                {renderPrivacyAppIcon(source, option?.icon_path)}
                                                                <span className={classes(styles, "privacy-app-chip__text")}>
                                                                    <strong>{displayAppSource(source, t)}</strong>
                                                                </span>
                                                            </ListItem>
                                                        </m.div>
                                                    );
                                                })}
                                            </AnimatePresence>
                                        </List>
                                    </m.div>
                                ) : (
                                    <m.div
                                        key="protected-app-empty"
                                        className={styles["privacy-app-empty"]}
                                        variants={fadeMotion}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                        data-motion-preset="fade"
                                    >
                                        {t("settings.privacyApps.empty")}
                                    </m.div>
                                )}
                            </AnimatePresence>
                        </Stack>
                    </ListItem>
                </List>
            </Box>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.section.history")}
                </Typography>
                <List>
                    {legacyHistoryBlocked && (
                        <ListItem sx={{ alignItems: 'flex-start' }}>
                            <Stack spacing={1} sx={{ width: '100%' }}>
                                <ListItemText primary={t("settings.legacyHistory.title")} secondary={t("settings.legacyHistory.desc")} />
                                <Button color="error" variant="outlined" size="small" onClick={() => setLegacyCleanupConfirmOpen(true)} className={classes(styles, "data-action-button")}>
                                    {t("settings.legacyHistory.clear")}
                                </Button>
                            </Stack>
                        </ListItem>
                    )}
                    {legacyHistoryBlocked && <Divider component="li" />}
                    <ListItem sx={{ alignItems: 'flex-start' }}>
                        <Stack spacing={2} sx={{ width: '100%' }}>
                            <div className={styles["data-setting-row"]}>
                                <ListItemText
                                    className={styles["data-list-copy"]}
                                    primary={t("settings.storageDir")}
                                    secondary={currentStoragePath}
                                    secondaryTypographyProps={{
                                        className: styles["storage-path-value"],
                                        title: currentStoragePath,
                                    }}
                                />
                                <Button
                                    variant="outlined"
                                    size="small"
                                    startIcon={<FolderOutlinedIcon fontSize="small" />}
                                    onClick={handleChooseStorageDir}
                                    disabled={historyWorking || legacyHistoryBlocked}
                                    className={styles["data-action-button"]}
                                >
                                    {t("settings.storageDir.change")}
                                </Button>
                            </div>
                            <AnimatePresence mode="wait" initial={false}>
                                {(historyWorkingArea === 'storage' || historyMessage) && (
                                    <OperationStatus
                                        key={historyWorkingArea === 'storage' ? 'storage-working' : `storage-${historyMessage?.kind}-${historyMessage?.text}`}
                                        busy={historyWorkingArea === 'storage'}
                                        tone={historyMessage?.kind || 'neutral'}
                                        message={historyWorkingArea === 'storage' ? t("settings.historyWorking") : historyMessage?.text}
                                    />
                                )}
                            </AnimatePresence>
                        </Stack>
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <div className={styles["data-setting-row"]}>
                            <ListItemText
                                className={classes(styles, "data-list-copy")}
                                primary={t("settings.cleanupHistory")}
                                secondary={cleanupInfo
                                    ? t("settings.cleanupEstimate", { bytes: formatBytes(cleanupInfo.bytes), items: cleanupInfo.items })
                                    : storageSummary
                                        ? t("settings.cleanupSummary", { bytes: formatBytes(storageSummary.bytes), items: storageSummary.items })
                                        : t("settings.cleanupSummaryLoading")}
                            />
                            <ButtonGroup variant="outlined" color="error" size="small" className={classes(styles, "cleanup-button-group")}>
                                <Button
                                    onClick={() => setCleanupConfirmOpen(true)}
                                    disabled={cleanupWorking || historyWorking || legacyHistoryBlocked || !cleanupInfo || cleanupInfo.items === 0 || !cleanupDays}
                                    startIcon={cleanupWorking ? <CircularProgress size={14} thickness={5} aria-hidden="true" /> : <AutoDeleteOutlinedIcon fontSize="small" />}
                                >
                                    {cleanupWorking ? t("settings.cleanupWorking") : `${t("common.cleanup")} · ${cleanupRangeLabel}`}
                                </Button>
                                <Button
                                    aria-label={t("settings.cleanupSelect")}
                                    aria-haspopup="menu"
                                    onClick={event => setCleanupMenuAnchor(event.currentTarget)}
                                    disabled={cleanupWorking || historyWorking || legacyHistoryBlocked}
                                >
                                    <ArrowDropDownIcon fontSize="small" />
                                </Button>
                            </ButtonGroup>
                        </div>
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={{ alignItems: 'flex-start' }}>
                        <Stack spacing={2} sx={{ width: '100%' }}>
                            <div className={styles["data-setting-row"]}>
                                <ListItemText
                                    className={styles["data-list-copy"]}
                                    primary={t("settings.historyTransfer")}
                                    secondary={t("settings.historyTransfer.desc")}
                                />
                                <div className={styles["history-transfer-actions"]}>
                                    <Button
                                        variant="outlined"
                                        disabled={historyWorking || cleanupWorking || legacyHistoryBlocked}
                                        onClick={handleImportHistory}
                                        startIcon={<FileUploadIcon />}
                                    >
                                        {t("settings.importHistory")}
                                    </Button>
                                    <Button
                                        variant="outlined"
                                        disabled={historyWorking || cleanupWorking || legacyHistoryBlocked}
                                        onClick={handleExportHistory}
                                        startIcon={<FileDownloadIcon />}
                                    >
                                        {t("settings.exportHistory")}
                                    </Button>
                                </div>
                            </div>
                            <AnimatePresence mode="wait" initial={false}>
                                {(transferWorking || transferMessage) && (
                                    <OperationStatus
                                        key={transferWorking ? `transfer-${transferOperation}-working` : `transfer-${transferMessage?.kind}-${transferMessage?.text}`}
                                        variant="block"
                                        busy={transferWorking}
                                        tone={transferMessage?.kind || 'neutral'}
                                        message={transferWorking ? transferWorkingText : transferMessage?.text}
                                        progress={transferWorking ? transferProgressValue : undefined}
                                        progressLabel={transferWorking ? transferWorkingText : undefined}
                                    />
                                )}
                            </AnimatePresence>
                        </Stack>
                    </ListItem>
                </List>
            </Box>
            <Dialog
                open={privacyManagerOpen}
                onClose={() => setPrivacyManagerOpen(false)}
                fullWidth
                maxWidth="xs"
                aria-labelledby="privacy-manager-title"
                BackdropProps={{ className: dialogBackdropClassName }}
            >
                <DialogTitle id="privacy-manager-title" className={styles["privacy-manager-title"]}>
                    {t("settings.privacyApps.manage")}
                    <IconButton aria-label={t("common.close")} onClick={() => setPrivacyManagerOpen(false)} size="small">
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </DialogTitle>
                <DialogContent dividers className={styles["privacy-manager-content"]}>
                    <Stack spacing={2}>
                        <AnimatePresence mode="wait" initial={false}>
                            {privacyAppsLoading ? (
                                <m.div
                                    key="privacy-manager-loading"
                                    className={styles["privacy-manager-loading"]}
                                    variants={fadeMotion}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    data-motion-preset="fade"
                                >
                                    <CircularProgress size={24} aria-label={t("settings.privacyApps.loading")} />
                                </m.div>
                            ) : managedPrivacyApps.length > 0 ? (
                                <m.div
                                    key="privacy-manager-list"
                                    variants={fadeMotion}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    data-motion-preset="fade"
                                >
                                    <List dense disablePadding className={styles["privacy-manager-list"]}>
                                        {managedPrivacyApps.map(option => {
                                            const protectedApp = ignoredAppSources.includes(option.source);
                                            return (
                                                <ListItem key={option.source} className={styles["privacy-manager-item"]}>
                                                    {renderPrivacyAppIcon(option.source, option.icon_path)}
                                                    <ListItemText className={styles["privacy-manager-copy"]} primary={displayAppSource(option.source, t)} />
                                                    <Switch
                                                        checked={protectedApp}
                                                        disabled={privacyAppsSaving}
                                                        onChange={event => void handlePrivacyAppChange(option.source, event.target.checked)}
                                                        inputProps={{ "aria-label": displayAppSource(option.source, t) }}
                                                    />
                                                </ListItem>
                                            );
                                        })}
                                    </List>
                                </m.div>
                            ) : (
                                <m.div
                                    key="privacy-manager-empty"
                                    className={styles["privacy-app-empty"]}
                                    variants={fadeMotion}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    data-motion-preset="fade"
                                >
                                    {t("settings.privacyApps.noOptions")}
                                </m.div>
                            )}
                        </AnimatePresence>
                        <Typography variant="body2" color="text.secondary">
                            {t("settings.privacyApps.help")}
                        </Typography>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPrivacyManagerOpen(false)}>{t("common.close")}</Button>
                </DialogActions>
            </Dialog>
            <Menu
                anchorEl={cleanupMenuAnchor}
                open={Boolean(cleanupMenuAnchor)}
                onClose={() => setCleanupMenuAnchor(null)}
                MenuListProps={{ "aria-label": t("settings.cleanupSelect") }}
            >
                <MenuItem selected={cleanupDays === "0"} onClick={() => { setCleanupDays("0"); setCleanupMenuAnchor(null); }}>{t("settings.cleanup.all")}</MenuItem>
                <MenuItem selected={cleanupDays === "30"} onClick={() => { setCleanupDays("30"); setCleanupMenuAnchor(null); }}>{t("settings.cleanup.30")}</MenuItem>
                <MenuItem selected={cleanupDays === "90"} onClick={() => { setCleanupDays("90"); setCleanupMenuAnchor(null); }}>{t("settings.cleanup.90")}</MenuItem>
                <MenuItem selected={cleanupDays === "365"} onClick={() => { setCleanupDays("365"); setCleanupMenuAnchor(null); }}>{t("settings.cleanup.365")}</MenuItem>
            </Menu>
            <ConfirmDialog
                open={legacyCleanupConfirmOpen}
                title={t("settings.legacyHistory.confirmTitle")}
                description={t("settings.legacyHistory.confirm")}
                cancelLabel={t("common.cancel")}
                confirmLabel={t("settings.legacyHistory.clear")}
                backdropClassName={dialogBackdropClassName}
                cancelDisabled={legacyCleanupWorking}
                confirmDisabled={legacyCleanupWorking}
                status={(legacyCleanupWorking || legacyCleanupError) ? (
                    <OperationStatus
                        busy={legacyCleanupWorking}
                        tone={legacyCleanupError ? "error" : "neutral"}
                        message={legacyCleanupError ?? t("settings.legacyHistory.clearing")}
                        variant="block"
                    />
                ) : undefined}
                onCancel={() => {
                    if (!legacyCleanupWorking) setLegacyCleanupConfirmOpen(false);
                }}
                onConfirm={() => void handleClearLegacyHistory()}
            />
            <ConfirmDialog
                open={cleanupConfirmOpen}
                title={t("settings.cleanup.confirmTitle")}
                description={t("settings.cleanup.confirm", { range: cleanupRangeLabel })}
                cancelLabel={t("common.cancel")}
                confirmLabel={t("common.cleanup")}
                backdropClassName={dialogBackdropClassName}
                confirmDisabled={cleanupWorking}
                onCancel={() => setCleanupConfirmOpen(false)}
                onConfirm={() => void handleCleanupStorage()}
            />
        </Stack>
    );
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function getHistoryArchiveProgressValue(progress: HistoryArchiveProgressPayload | null): number | null {
    if (!progress) return null;
    if (progress.total_bytes > 0) {
        return Math.min(100, Math.max(0, (progress.processed_bytes / progress.total_bytes) * 100));
    }
    if (progress.total_files > 0) {
        return Math.min(100, Math.max(0, (progress.processed_files / progress.total_files) * 100));
    }
    return null;
}

function getHistoryArchiveProgressText(
    t: TFunction,
    progress: HistoryArchiveProgressPayload | null,
    operation: 'export' | 'import' | null
): string {
    if (!operation) return "";
    if (!progress) {
        return t(operation === 'export' ? "settings.exportWorkingInline" : "settings.importWorkingInline");
    }
    const stage = t(`settings.historyArchive.stage.${progress.stage}`);
    if (progress.total_bytes > 0) {
        return t("settings.historyArchiveProgress.bytes", {
            stage,
            processed: formatBytes(progress.processed_bytes),
            total: formatBytes(progress.total_bytes)
        });
    }
    if (progress.total_files > 0) {
        return t("settings.historyArchiveProgress.files", {
            stage,
            processed: progress.processed_files,
            total: progress.total_files
        });
    }
    return t("settings.historyArchiveProgress.stageOnly", { stage });
}
