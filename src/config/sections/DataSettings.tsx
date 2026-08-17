import * as React from "react";
import { Box, Button, CircularProgress, Divider, LinearProgress, List, ListItem, ListItemText, MenuItem, Select, Stack, TextField, Typography, type SelectChangeEvent } from "@mui/material";
import AutoDeleteOutlinedIcon from "@mui/icons-material/AutoDeleteOutlined";
import FileDownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import FileUploadIcon from "@mui/icons-material/FileUploadOutlined";
import { error } from "@tauri-apps/plugin-log";
import { displayAppSource, type AppSourceOption } from "../../clipboard/appSource";
import type { HistoryArchiveInfo, HistoryArchiveProgressPayload, SettingsBlockingOperation, SettingsSectionProps, StorageCleanupInfo, StoragePaths, TFunction } from "../settingsTypes";
import { classes } from "../../ui/classNames";
import styles from "../Config.module.css";

export default function DataSettings({ bridge, config, storagePaths, t, onSave, onBlockingOperationChange }: SettingsSectionProps & { storagePaths: StoragePaths | null, onBlockingOperationChange: (operation: SettingsBlockingOperation | null) => void }) {
    const [legacyHistoryBlocked, setLegacyHistoryBlocked] = React.useState(false);
    const [storageDirDraft, setStorageDirDraft] = React.useState(config.storage_dir || "");
    const [cleanupDays, setCleanupDays] = React.useState<string>("");
    const [cleanupInfo, setCleanupInfo] = React.useState<StorageCleanupInfo | null>(null);
    const [storageSummary, setStorageSummary] = React.useState<StorageCleanupInfo | null>(null);
    const [recentAppSources, setRecentAppSources] = React.useState<AppSourceOption[]>([]);
    const [selectedPrivacyApp, setSelectedPrivacyApp] = React.useState("");
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

    React.useEffect(() => {
        setStorageDirDraft(config.storage_dir || "");
    }, [config.storage_dir]);

    const loadRecentAppSources = React.useCallback(() => {
        bridge.invoke<AppSourceOption[]>('list_recent_app_source_options', { days: 30 })
            .then(setRecentAppSources)
            .catch(e => error(`Failed to load recent app sources: ${e}`));
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
        if (!window.confirm(t("settings.legacyHistory.confirm"))) return;
        try {
            await bridge.invoke('clear_legacy_history', { confirmation: 'CLEAR_LEGACY_HISTORY' });
            setLegacyHistoryBlocked(false);
            refreshStorageSummary();
        } catch (e) {
            error(`Failed to clear legacy history: ${e}`);
        }
    };

    React.useEffect(() => {
        if (selectedPrivacyApp && config.ignored_app_sources.includes(selectedPrivacyApp)) {
            setSelectedPrivacyApp("");
        }
    }, [config.ignored_app_sources, selectedPrivacyApp]);

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

    const handleCleanupDaysChange = (event: SelectChangeEvent<string>) => {
        setCleanupDays(event.target.value);
    };

    const handleCleanupStorage = async () => {
        if (!cleanupDays || cleanupWorking || historyWorking) return;
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

    const ignoredAppSources = Array.isArray(config.ignored_app_sources) ? config.ignored_app_sources : [];
    const recentAppSourceMap = new Map(recentAppSources.map(option => [option.source, option]));
    const privacyAppOptions = recentAppSources.filter(option => !ignoredAppSources.includes(option.source));

    const handleAddPrivacyApp = () => {
        if (!selectedPrivacyApp || ignoredAppSources.includes(selectedPrivacyApp)) return;
        void onSave({
            ...config,
            ignored_app_sources: [...ignoredAppSources, selectedPrivacyApp]
        }).then(() => setSelectedPrivacyApp(""));
    };

    const handleRemovePrivacyApp = (source: string) => {
        void onSave({
            ...config,
            ignored_app_sources: ignoredAppSources.filter(item => item !== source)
        });
    };

    const renderPrivacyAppIcon = (source: string, iconPath?: string) => {
        if (iconPath) {
            return <img className={classes(styles, "privacy-app-option-icon")} src={bridge.convertFileSrc(iconPath)} alt="" />;
        }
        return <span className={classes(styles, "privacy-app-option-icon placeholder")}>{displayAppSource(source, t).slice(0, 1).toUpperCase()}</span>;
    };

    return (
        <Stack spacing={2.15} className={classes(styles, "settings-page-stack")}>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.section.dataSecurity")}
                </Typography>
                <List>
                    <ListItem sx={{ alignItems: 'flex-start' }}>
                        <Stack spacing={1.05} sx={{ width: '100%' }}>
                            <ListItemText
                                primary={t("settings.privacyApps")}
                                secondary={t("settings.privacyApps.desc")}
                            />
                            {ignoredAppSources.length > 0 ? (
                                <div className={classes(styles, "privacy-app-list")}>
                                    {ignoredAppSources.map(source => {
                                        const option = recentAppSourceMap.get(source);
                                        return (
                                            <div className={classes(styles, "privacy-app-chip")} key={source} title={source}>
                                                {option?.icon_path ? (
                                                    <img className={classes(styles, "privacy-app-option-icon")} src={bridge.convertFileSrc(option.icon_path)} alt="" />
                                                ) : (
                                                    <span className={classes(styles, "privacy-app-option-icon placeholder")}>{displayAppSource(source, t).slice(0, 1).toUpperCase()}</span>
                                                )}
                                                <span className={classes(styles, "privacy-app-chip__text")}>
                                                    <strong>{displayAppSource(source, t)}</strong>
                                                    <small>{source}</small>
                                                </span>
                                                <button type="button" onClick={() => handleRemovePrivacyApp(source)}>
                                                    {t("common.remove")}
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className={classes(styles, "privacy-app-empty")}>{t("settings.privacyApps.empty")}</div>
                            )}
                            <Stack direction="row" spacing={1} alignItems="center">
                                <Select
                                    value={selectedPrivacyApp}
                                    onChange={(event: SelectChangeEvent<string>) => setSelectedPrivacyApp(event.target.value)}
                                    size="small"
                                    displayEmpty
                                    sx={{
                                        minWidth: 240,
                                        flex: '1 1 auto'
                                    }}
                                >
                                    <MenuItem value="" disabled>{t("settings.privacyApps.selectPlaceholder")}</MenuItem>
                                    {privacyAppOptions.map(option => (
                                        <MenuItem key={option.source} value={option.source}>
                                            <span className={classes(styles, "privacy-app-option")}>
                                                {renderPrivacyAppIcon(option.source, option.icon_path)}
                                                <span>{displayAppSource(option.source, t)}</span>
                                            </span>
                                        </MenuItem>
                                    ))}
                                    <MenuItem disabled className={classes(styles, "privacy-app-menu-hint")}>
                                        {t("settings.privacyApps.help")}
                                    </MenuItem>
                                </Select>
                                <Button
                                    variant="contained"
                                    color="inherit"
                                    size="small"
                                    onClick={handleAddPrivacyApp}
                                    disabled={!selectedPrivacyApp}
                                    sx={{ flex: '0 0 auto' }}
                                >
                                    {t("settings.privacyApps.add")}
                                </Button>
                                <Button variant="text" size="small" onClick={loadRecentAppSources} sx={{ flex: '0 0 auto' }}>
                                    {t("common.refresh")}
                                </Button>
                            </Stack>
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
                                <Button color="error" variant="contained" size="small" onClick={handleClearLegacyHistory} sx={{ alignSelf: 'flex-start' }}>
                                    {t("settings.legacyHistory.clear")}
                                </Button>
                            </Stack>
                        </ListItem>
                    )}
                    {legacyHistoryBlocked && <Divider component="li" />}
                    <ListItem sx={{ alignItems: 'flex-start' }}>
                        <Stack spacing={0.75} sx={{ width: '100%' }}>
                            <ListItemText
                                primary={t("settings.storageDir")}
                                secondary={t("settings.storageDir.desc")}
                            />
                            <Stack direction="row" spacing={1} alignItems="center">
                                <TextField
                                    value={storageDirDraft || storagePaths?.history_storage_dir || ""}
                                    placeholder={t("settings.defaultAppDataDir")}
                                    size="small"
                                    fullWidth
                                    InputProps={{ readOnly: true }}
                                    inputProps={{ className: styles["storage-path-input"] }}
                                    disabled={historyWorking || legacyHistoryBlocked}
                                />
                                <Button disabled={historyWorking || legacyHistoryBlocked} variant="contained" color="inherit" size="small" onClick={handleChooseStorageDir} sx={{ flex: '0 0 auto' }}>{t("common.modify")}</Button>
                            </Stack>
                            {(historyWorkingArea === 'storage' || historyMessage) && (
                                <div className={classes(styles, `storage-migration-status ${historyMessage?.kind || 'working'}`)}>
                                    {historyWorkingArea === 'storage' && <CircularProgress size={14} thickness={5} />}
                                    <span>{historyWorkingArea === 'storage' ? t("settings.historyWorking") : historyMessage?.text}</span>
                                </div>
                            )}
                        </Stack>
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={{ alignItems: 'flex-start' }}>
                        <Stack spacing={0.75} sx={{ width: '100%' }}>
                            <Stack direction="row" spacing={1.5} alignItems="center">
                                <ListItemText
                                    primary={t("settings.cleanupHistory")}
                                    secondary={cleanupInfo
                                        ? t("settings.cleanupEstimate", { bytes: formatBytes(cleanupInfo.bytes), items: cleanupInfo.items })
                                        : storageSummary
                                            ? t("settings.cleanupSummary", { bytes: formatBytes(storageSummary.bytes), items: storageSummary.items })
                                            : t("settings.cleanupSummaryLoading")}
                                />
                                <Select
                                    value={cleanupDays}
                                    onChange={handleCleanupDaysChange}
                                    disabled={cleanupWorking || historyWorking || legacyHistoryBlocked}
                                    size="small"
                                    displayEmpty
                                    sx={{
                                        minWidth: 136
                                    }}
                                >
                                    <MenuItem value="" disabled>{t("settings.cleanupSelect")}</MenuItem>
                                    <MenuItem value="0">{t("settings.cleanup.all")}</MenuItem>
                                    <MenuItem value="30">{t("settings.cleanup.30")}</MenuItem>
                                    <MenuItem value="90">{t("settings.cleanup.90")}</MenuItem>
                                    <MenuItem value="365">{t("settings.cleanup.365")}</MenuItem>
                                </Select>
                                <Button
                                    variant="contained"
                                    color="inherit"
                                    size="small"
                                    onClick={handleCleanupStorage}
                                    disabled={cleanupWorking || historyWorking || legacyHistoryBlocked || !cleanupInfo || cleanupInfo.items === 0}
                                    startIcon={cleanupWorking ? <CircularProgress size={14} thickness={5} /> : <AutoDeleteOutlinedIcon fontSize="small" />}
                                    sx={{ flex: '0 0 auto' }}
                                >
                                    {cleanupWorking ? t("settings.cleanupWorking") : t("common.cleanup")}
                                </Button>
                            </Stack>
                        </Stack>
                    </ListItem>
                </List>
            </Box>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.historyTransfer")}
                </Typography>
                <div className={classes(styles, "history-transfer-panel")}>
                    <div className={classes(styles, "history-transfer-grid")}>
                        <button
                            className={classes(styles, "history-transfer-card")}
                            type="button"
                            disabled={historyWorking || cleanupWorking || legacyHistoryBlocked}
                            onClick={handleImportHistory}
                        >
                            <FileUploadIcon className={classes(styles, "history-transfer-card__icon")} fontSize="large" />
                            <span className={classes(styles, "history-transfer-card__title")}>{t("settings.importHistory")}</span>
                            <span className={classes(styles, "history-transfer-card__desc")}>{t("settings.importHistory.desc")}</span>
                        </button>
                        <button
                            className={classes(styles, "history-transfer-card")}
                            type="button"
                            disabled={historyWorking || cleanupWorking || legacyHistoryBlocked}
                            onClick={handleExportHistory}
                        >
                            <FileDownloadIcon className={classes(styles, "history-transfer-card__icon")} fontSize="large" />
                            <span className={classes(styles, "history-transfer-card__title")}>{t("settings.exportHistory")}</span>
                            <span className={classes(styles, "history-transfer-card__desc")}>{t("settings.exportHistory.desc")}</span>
                        </button>
                    </div>
                    {(transferWorking || transferMessage) && (
                        <div className={classes(styles, `history-transfer-progress ${transferMessage?.kind || 'working'}`)}>
                            <div className={classes(styles, "history-transfer-progress__line")}>
                                {transferWorking && <CircularProgress size={14} thickness={5} />}
                                <span>{transferWorking ? transferWorkingText : transferMessage?.text}</span>
                            </div>
                            {transferWorking && (
                                <LinearProgress
                                    className={classes(styles, "history-transfer-progress__bar")}
                                    variant={transferProgressValue != null ? "determinate" : "indeterminate"}
                                    value={transferProgressValue ?? undefined}
                                />
                            )}
                        </div>
                    )}
                </div>
            </Box>
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
