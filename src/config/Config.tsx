import * as React from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import "./Config.css"
import Stack from '@mui/material/Stack';
import { Button, CircularProgress, Divider, LinearProgress, ListItemText, styled, TextField } from "@mui/material";
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Switch from '@mui/material/Switch';
import Select, { SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { info, error } from "@tauri-apps/plugin-log";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../assets/vpaste-app-icon.png";
import { DEFAULT_LANGUAGE, useLanguage } from "../lang";
import { formatShortcutLabel, getModifierDisplayLabel, isMacPlatform } from "../shortcutDisplay";
import { applyThemeMode, type ThemeMode } from "../theme";
import { type AppSourceOption, displayAppSource } from "../clipboard/appSource";
import { useAppUpdateState, type UpdateState } from "../update";

// Icons
import TuneIcon from '@mui/icons-material/Tune'; // For General/Common
import StorageIcon from '@mui/icons-material/StorageOutlined'; // For Data
import KeyboardIcon from '@mui/icons-material/Keyboard'; // For Shortcuts
import InfoIcon from '@mui/icons-material/InfoOutlined'; // For About
import FileDownloadIcon from '@mui/icons-material/FileDownloadOutlined';
import FileUploadIcon from '@mui/icons-material/FileUploadOutlined';
import AutoDeleteOutlinedIcon from '@mui/icons-material/AutoDeleteOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import GitHubIcon from '@mui/icons-material/GitHub';
import LaunchOutlinedIcon from '@mui/icons-material/LaunchOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import UpdateRoundedIcon from '@mui/icons-material/UpdateRounded';
import AccessTimeOutlinedIcon from '@mui/icons-material/AccessTimeOutlined';
import CloseIcon from '@mui/icons-material/Close';

interface Shortcutkey {
    main_window?: string;
    copy_and_show_shortcut?: string;
    copy_and_exec_shortcut?: string;
    translate?: string;
    preview?: string;
    paste_into_plain_text?: string;
    quick_selection?: string;
}

interface ConfigData {
    startup: boolean;
    display_tray_icon: boolean;
    multilingual: string;
    theme_mode: ThemeMode;
    storage_history: number;
    storage_dir: string;
    retain_search_history: boolean;
    retain_last_position: boolean;
    retain_tab_position: boolean;
    link_auto_preview: boolean;
    sensitive_content_protection: boolean;
    quick_input_enabled: boolean;
    tab_quick_select_enabled: boolean;
    onboarding_completed: boolean;
    update_check_enabled: boolean;
    last_update_check_at: string;
    ignored_update_version: string;
    ignored_app_sources: string[];
    shortcut_keys: Shortcutkey;
}

interface StoragePaths {
    app_data_dir: string;
    history_storage_dir: string;
}

interface StorageCleanupInfo {
    bytes: number;
    items: number;
}

interface StorageMigrationInfo {
    migrated: boolean;
    source_dir: string;
    target_dir: string;
    merged_items: number;
    skipped_items: number;
    copied_files: number;
    backup_dir: string;
    message: string;
    shortcut_conflict?: boolean;
}

interface ShortcutRegistrationInfo {
    registered: boolean;
    conflict: boolean;
}

interface HistoryArchiveInfo {
    archive_path: string;
    merged_items: number;
    skipped_items: number;
    copied_files: number;
    message: string;
}

interface HistoryArchiveProgressPayload {
    operation: 'export' | 'import';
    stage: string;
    processed_files: number;
    total_files: number;
    processed_bytes: number;
    total_bytes: number;
}

type PermissionId = 'background' | 'paste';

interface PermissionItemStatus {
    done: boolean;
    needs_settings: boolean;
    error?: string | null;
}

interface PermissionStatus {
    background: PermissionItemStatus;
    paste: PermissionItemStatus;
}

type TFunction = (key: string, params?: Record<string, string | number>) => string;
type LanguageOption = { value: string; label: string };
type SettingsBlockingOperation = { title: string; description: string; progress?: number | null };

const APP_REPOSITORY_URL = "https://github.com/Loxonl/vPaste-desktop";
const APP_CHANGELOG_URL = `${APP_REPOSITORY_URL}/releases`;
const PENDING_PERMISSION_WINDOW_KEY = "vpaste.pendingOnboardingPermission.v1";
const PAGE_STACK_SX = { maxWidth: '100%', margin: 0 };
const PAGE_TITLE_SX = { fontWeight: 650, color: '#15191f', letterSpacing: 0, fontSize: '24px', lineHeight: 1.16 };
const SECTION_TITLE_SX = { color: '#1f242b', mb: 0.8, ml: 1.1, fontSize: '13px', fontWeight: 480, letterSpacing: 0 };
const LIST_SX = {
    bgcolor: 'rgba(255,255,255,0.72)',
    borderRadius: '14px',
    boxShadow: '0 8px 24px rgba(35, 43, 54, 0.045), 0 1px 2px rgba(35, 43, 54, 0.035)',
    padding: 0,
    overflow: 'hidden'
};
const LIST_ITEM_SX = { py: 1.08, px: 2.05, minHeight: 52 };
const PRIMARY_TEXT_PROPS = { fontSize: '14px', fontWeight: 380, color: '#1f242b', letterSpacing: 0, lineHeight: 1.35 };
const SECONDARY_TEXT_PROPS = { fontSize: '12px', color: '#7f7f7f', letterSpacing: 0, lineHeight: 1.35, mt: 0.15, fontWeight: 350 };

const DEFAULT_CONFIG: ConfigData = {
    startup: true,
    display_tray_icon: true,
    multilingual: DEFAULT_LANGUAGE,
    theme_mode: "system",
    storage_history: 0,
    storage_dir: "",
    retain_search_history: false,
    retain_last_position: false,
    retain_tab_position: false,
    link_auto_preview: true,
    sensitive_content_protection: true,
    quick_input_enabled: true,
    tab_quick_select_enabled: true,
    onboarding_completed: false,
    update_check_enabled: true,
    last_update_check_at: "",
    ignored_update_version: "",
    ignored_app_sources: [],
    shortcut_keys: {
        main_window: "Alt+V",
        paste_into_plain_text: "Shift+Enter"
    }
};

interface TabPanelProps {
    children?: React.ReactNode;
    index: number;
    value: number;
}

function TabPanel(props: TabPanelProps) {
    const { children, value, index, ...other } = props;

    return (
        <div
            role="tabpanel"
            hidden={value !== index}
            id={`vertical-tabpanel-${index}`}
            aria-labelledby={`vertical-tab-${index}`}
            style={{ width: '100%', height: '100%' }}
            {...other}
        >
            {value === index && (
                <Box sx={{ p: 0, height: '100%' }}>
                    {children}
                </Box>
            )}
        </div>
    );
}

const StyledTab = styled(Tab)({
    textTransform: 'none',
    fontWeight: 420,
    fontSize: '15px',
    color: '#333',
    minHeight: '40px',
    justifyContent: 'flex-start',
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
    paddingLeft: '13px',
    paddingRight: '12px',
    borderRadius: '8px',
    margin: '3px 0',
    letterSpacing: 0,
    transition: 'background-color 140ms ease, color 140ms ease, transform 140ms ease',
    '& .MuiTab-iconWrapper': {
        marginRight: '10px',
        color: 'inherit',
    },
    '&.Mui-selected': {
        color: '#111820',
        backgroundColor: 'rgba(32, 43, 54, 0.10)',
        fontWeight: 420,
    },
    '&:hover': {
        backgroundColor: 'rgba(30, 42, 54, 0.075)',
    },
});

const QQSwitch = styled(Switch)({
    width: 34,
    height: 20,
    padding: 0,
    '& .MuiSwitch-switchBase': {
        padding: 2,
        transitionDuration: '160ms',
        '&.Mui-checked': {
            transform: 'translateX(14px)',
            color: '#fff',
            '& + .MuiSwitch-track': {
                backgroundColor: '#1e92ee',
                opacity: 1,
            },
        },
    },
    '& .MuiSwitch-thumb': {
        width: 16,
        height: 16,
        boxShadow: '0 1px 4px rgba(31, 42, 55, 0.20)',
    },
    '& .MuiSwitch-track': {
        borderRadius: 13,
        backgroundColor: '#aeb4bc',
        opacity: 1,
    },
});

function normalizeShortcutForPolicy(value: string) {
    return value
        .split("+")
        .map(part => {
            const normalized = part.trim().toLowerCase();
            if (normalized === "control" || normalized === "ctrl") return "ctrl";
            if (normalized === "option" || normalized === "alt") return "alt";
            if (normalized === "shift") return "shift";
            if (["command", "cmd", "meta", "super", "win", "windows"].includes(normalized)) return "super";
            if (["enter", "return"].includes(normalized)) return "enter";
            if (["escape", "esc"].includes(normalized)) return "esc";
            if ([" ", "space", "spacebar"].includes(normalized)) return "space";
            return normalized;
        })
        .filter(Boolean)
        .sort()
        .join("+");
}

function hasShortcutModifier(value: string) {
    return normalizeShortcutForPolicy(value)
        .split("+")
        .some(part => ["ctrl", "alt", "shift", "super"].includes(part));
}

function isBlockedMainShortcut(value: string) {
    const normalized = normalizeShortcutForPolicy(value);
    return normalized === "super+v"
        || normalized === "alt+space"
        || normalized === "space+super"
        || normalized === "super+tab"
        || normalized === "q+super";
}

function isReservedQuickInputShortcut(value: string) {
    if (!isMacPlatform()) return false;

    const parts = normalizeShortcutForPolicy(value).split("+");
    const hasAlt = parts.includes("alt");
    const hasNonQuickInputModifier = parts.includes("ctrl") || parts.includes("super");
    if (!hasAlt || hasNonQuickInputModifier) return false;

    return parts.some(part => ["a", "f", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(part));
}

function isReservedQuickInputShortcutEvent(event?: React.KeyboardEvent) {
    if (!isMacPlatform() || !event?.altKey || event.ctrlKey || event.metaKey) return false;
    return event.code === "KeyA" || event.code === "KeyF" || /^Digit[1-9]$/.test(event.code);
}

function isReservedPasteAsTextShortcut(value: string) {
    const parts = normalizeShortcutForPolicy(value).split("+");
    const hasCtrlOrSuper = parts.includes("ctrl") || parts.includes("super");
    if (hasCtrlOrSuper && parts.includes("f")) return true;

    return parts.some(part => ["space", "arrowdown", "arrowleft", "arrowright", "tab", "esc"].includes(part))
        || normalizeShortcutForPolicy(value) === "enter";
}

function isUnsupportedRecordedKey(event?: React.KeyboardEvent) {
    return event?.key === "Dead" || event?.key === "Unidentified" || event?.key === "Process";
}

function getErrorText(errorValue: unknown): string {
    if (errorValue instanceof Error) return errorValue.message;
    if (typeof errorValue === "string") return errorValue;
    return String(errorValue);
}

function startConfigWindowDrag(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging().catch(e => error(`Failed to drag config window: ${e}`));
}

function WindowControls() {
    const currentWindow = getCurrentWindow();
    const hideWindow = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        void currentWindow.hide().catch(e => error(`Failed to hide config window: ${e}`));
    };

    if (!isMacPlatform()) {
        return (
            <div className="windows-window-controls" data-tauri-no-drag="true">
                <button className="windows-window-close" type="button" aria-label="Close" onClick={hideWindow}>
                    <CloseIcon fontSize="small" />
                </button>
            </div>
        );
    }

    return (
        <div className="window-controls" data-tauri-no-drag="true">
            <button className="window-control close" type="button" aria-label="Close" onClick={hideWindow}>
                <b />
            </button>
            <button className="window-control disabled" type="button" aria-label="Minimize disabled" disabled />
            <button className="window-control disabled" type="button" aria-label="Zoom disabled" disabled />
        </div>
    );
}

function a11yProps(index: number) {
    return {
        id: `vertical-tab-${index}`,
        'aria-controls': `vertical-tabpanel-${index}`,
    };
}

export default function Config() {
    const { t, languages, setLanguageCode } = useLanguage();
    const [value, setValue] = React.useState(0);
    const [dir, setDir] = React.useState("");
    const [config, setConfig] = React.useState<ConfigData>(DEFAULT_CONFIG);
    const [storagePaths, setStoragePaths] = React.useState<StoragePaths | null>(null);
    const [blockingOperation, setBlockingOperation] = React.useState<SettingsBlockingOperation | null>(null);
    const [windowsControlsHoverReady, setWindowsControlsHoverReady] = React.useState(false);
    const blockingOperationRef = React.useRef<SettingsBlockingOperation | null>(null);

    React.useEffect(() => {
        blockingOperationRef.current = blockingOperation;
    }, [blockingOperation]);

    React.useEffect(() => {
        invoke('get_app_data_dir', {}).then(v => {
            setDir(v as string);
        });
        invoke('get_storage_paths', {}).then(v => {
            setStoragePaths(v as StoragePaths);
        }).catch(e => error(`Failed to load storage paths: ${e}`));
        invoke('get_config', {}).then(v => {
            info(`Loaded config: ${v}`);
            try {
                const parsed = JSON.parse(v as string);
                setConfig({
                    ...DEFAULT_CONFIG,
                    ...parsed,
                    ignored_app_sources: Array.isArray(parsed.ignored_app_sources) ? parsed.ignored_app_sources : [],
                    theme_mode: parsed.theme_mode || DEFAULT_CONFIG.theme_mode,
                    shortcut_keys: {
                        ...DEFAULT_CONFIG.shortcut_keys,
                        ...(parsed.shortcut_keys || {}),
                        paste_into_plain_text: parsed.shortcut_keys?.paste_into_plain_text ?? DEFAULT_CONFIG.shortcut_keys.paste_into_plain_text
                    }
                });
                setLanguageCode(parsed.multilingual || DEFAULT_CONFIG.multilingual);
                applyThemeMode(parsed.theme_mode || DEFAULT_CONFIG.theme_mode);
            } catch (e) {
                error(`Failed to parse config: ${e}`);
            }
        });
    }, []);

    React.useEffect(() => {
        const refreshStartupStatus = () => {
            void invoke<string>('get_config', {}).then(raw => {
                const latest = JSON.parse(raw) as Partial<ConfigData>;
                setConfig(current => ({ ...current, startup: latest.startup === true }));
            }).catch(e => error(`Failed to refresh startup status: ${e}`));
        };
        const applyTarget = (target: unknown) => {
            setWindowsControlsHoverReady(false);
            if (blockingOperationRef.current) return;
            refreshStartupStatus();
            if (target === "about" || localStorage.getItem("vpaste.config.target") === "about") {
                localStorage.removeItem("vpaste.config.target");
                setValue(3);
            } else if (target === "permissions") {
                setValue(0);
            }
        };
        applyTarget(null);
        const unlisten = listen<string>("config-opened", event => applyTarget(event.payload));
        const handleFocus = () => refreshStartupStatus();
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') refreshStartupStatus();
        };
        window.addEventListener('focus', handleFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten config-opened target: ${e}`));
            window.removeEventListener('focus', handleFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    const saveConfig = async (newConfig: ConfigData): Promise<StorageMigrationInfo | null> => {
        const previousConfig = config;
        setConfig(newConfig);
        setLanguageCode(newConfig.multilingual || DEFAULT_CONFIG.multilingual);
        applyThemeMode(newConfig.theme_mode || DEFAULT_CONFIG.theme_mode);
        try {
            const migrationInfo = await invoke<StorageMigrationInfo>('save_config', { config: JSON.stringify(newConfig) });
            info("Config saved");
            const paths = await invoke<StoragePaths>('get_storage_paths', {});
            setStoragePaths(paths);
            return migrationInfo;
        } catch (e) {
            setConfig(previousConfig);
            setLanguageCode(previousConfig.multilingual || DEFAULT_CONFIG.multilingual);
            applyThemeMode(previousConfig.theme_mode || DEFAULT_CONFIG.theme_mode);
            error(`Failed to save config: ${e}`);
            throw e;
        }
    };

    const handleChange = (_: React.SyntheticEvent, newValue: number) => {
        if (blockingOperation) return;
        setValue(newValue);
    };

    const isSettingsBlocked = blockingOperation !== null;

    return (
        <>
            <div
                className={`config-container ${windowsControlsHoverReady ? "windows-controls-hover-ready" : ""}`}
                onMouseMoveCapture={() => {
                    if (!windowsControlsHoverReady) {
                        setWindowsControlsHoverReady(true);
                    }
                }}
            >
                <div className="config-drag-region" onMouseDown={startConfigWindowDrag} />
                <WindowControls />
                <div className="sidebar">
                    <div className="sidebar-drag-region" onMouseDown={startConfigWindowDrag} />
                    <Tabs
                        orientation="vertical"
                        value={value}
                        onChange={handleChange}
                        aria-label="Configuration tabs"
                        TabIndicatorProps={{ style: { display: 'none' } }} // Hide default indicator
                        sx={{
                            borderRight: 0,
                            width: '100%',
                            minWidth: 0,
                            '& .MuiTabs-flexContainer': {
                                gap: '4px'
                            },
                            '& .MuiTab-root': {
                                maxWidth: '100%'
                            }
                        }}
                        data-tauri-no-drag="true"
                    >
                        <StyledTab disabled={isSettingsBlocked} icon={<TuneIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.general")} {...a11yProps(0)} data-tauri-no-drag="true" />
                        <StyledTab disabled={isSettingsBlocked} icon={<StorageIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.data")} {...a11yProps(1)} data-tauri-no-drag="true" />
                        <StyledTab disabled={isSettingsBlocked} icon={<KeyboardIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.shortcuts")} {...a11yProps(2)} data-tauri-no-drag="true" />
                        <StyledTab disabled={isSettingsBlocked} icon={<InfoIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.about")} {...a11yProps(3)} data-tauri-no-drag="true" />
                    </Tabs>
                </div>
                <div className="content-area">
                    <div className="content-title-bar" onMouseDown={startConfigWindowDrag}>
                        <Typography variant="h5" sx={PAGE_TITLE_SX}>
                            {value === 0 ? t("settings.general.title") : value === 1 ? t("settings.data.title") : value === 2 ? t("settings.shortcuts.title") : t("settings.about.title")}
                        </Typography>
                    </div>
                    <div className="content-scroll">
                        <div className="content-inner">
                    <TabPanel value={value} index={0}>
                        <GeneralSettings config={config} languages={languages} t={t} onSave={saveConfig} />
                    </TabPanel>
                    <TabPanel value={value} index={1}>
                        <DataSettings config={config} storagePaths={storagePaths} t={t} onSave={saveConfig} onBlockingOperationChange={setBlockingOperation} />
                    </TabPanel>
                    <TabPanel value={value} index={2}>
                        <ShortcutSettings config={config} t={t} onSave={saveConfig} />
                    </TabPanel>
                    <TabPanel value={value} index={3}>
                        <AboutSettings config={config} dir={dir} t={t} onSave={saveConfig} />
                    </TabPanel>
                        </div>
                    </div>
                </div>
                {blockingOperation && (
                    <div className="settings-blocking-overlay" role="alert" aria-live="assertive">
                        <div className="settings-blocking-dialog">
                            <div className="settings-blocking-dialog__spinner">
                                <CircularProgress size={28} thickness={4.5} />
                            </div>
                            <div className="settings-blocking-dialog__title">{blockingOperation.title}</div>
                            <div className="settings-blocking-dialog__desc">{blockingOperation.description}</div>
                            <LinearProgress
                                className="settings-blocking-progress"
                                variant={blockingOperation.progress != null ? "determinate" : "indeterminate"}
                                value={blockingOperation.progress ?? undefined}
                            />
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}

interface SettingsProps {
    config: ConfigData;
    onSave: (config: ConfigData) => Promise<StorageMigrationInfo | null>;
    t: TFunction;
}

function GeneralSettings({ config, languages, t, onSave }: SettingsProps & { languages: LanguageOption[] }) {
    const [permissionStatus, setPermissionStatus] = React.useState<PermissionStatus | null>(null);
    const { state: updateState } = useAppUpdateState();
    const languageChoices = languages.some(language => language.value === config.multilingual)
        ? languages
        : [{ value: config.multilingual, label: config.multilingual }, ...languages];

    const refreshPermissionStatus = React.useCallback(() => {
        if (!isMacPlatform()) return;
        void invoke<PermissionStatus>('get_onboarding_permission_status')
            .then(setPermissionStatus)
            .catch(e => error(`Failed to load permission status: ${e}`));
    }, []);

    React.useEffect(() => {
        if (!isMacPlatform()) return;
        refreshPermissionStatus();
        const unlistenStatus = listen('onboarding-permission-status-changed', refreshPermissionStatus);
        const unlistenConfigOpened = listen('config-opened', refreshPermissionStatus);
        const handleFocus = () => refreshPermissionStatus();
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') refreshPermissionStatus();
        };
        window.addEventListener('focus', handleFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            unlistenStatus.then(fn => fn()).catch(e => error(`Failed to unlisten permission status: ${e}`));
            unlistenConfigOpened.then(fn => fn()).catch(e => error(`Failed to unlisten config permission refresh: ${e}`));
            window.removeEventListener('focus', handleFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [refreshPermissionStatus]);

    const openPermissionGuide = (permission: PermissionId) => {
        const themePreview = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        const payload = {
            permission,
            languageCode: config.multilingual,
            themePreview,
        };
        localStorage.setItem(PENDING_PERMISSION_WINDOW_KEY, JSON.stringify(payload));
        void invoke('open_onboarding_permission_window', payload)
            .catch(e => error(`Failed to open ${permission} permission guide: ${e}`));
    };

    const handleStartupChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        void onSave({ ...config, startup: event.target.checked })
            .catch(e => error(`Failed to change startup setting: ${e}`));
    };

    const handleTrayChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, display_tray_icon: event.target.checked });
    };

    const handleLanguageChange = (event: SelectChangeEvent<string>) => {
        onSave({ ...config, multilingual: event.target.value });
    };

    const handleThemeChange = (event: SelectChangeEvent<string>) => {
        onSave({ ...config, theme_mode: event.target.value as ThemeMode });
    };

    const openOnboarding = () => {
        void invoke("open_onboarding_window").catch(e => error(`Failed to open onboarding: ${e}`));
    };

    const handleRetainSearchHistoryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, retain_search_history: event.target.checked });
    };

    const handleRetainLastPositionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, retain_last_position: event.target.checked });
    };

    const handleRetainTabPositionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, retain_tab_position: event.target.checked });
    };

    const handleLinkAutoPreviewChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, link_auto_preview: event.target.checked });
    };

    const handleSensitiveContentProtectionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, sensitive_content_protection: event.target.checked });
    };

    return (
        <Stack spacing={2.15} sx={PAGE_STACK_SX}>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.section.system")}
                </Typography>
                <List sx={LIST_SX}>
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText
                            primary={t("settings.startup")}
                            secondary={updateState.portable ? t("settings.startupPortable") : undefined}
                            primaryTypographyProps={PRIMARY_TEXT_PROPS}
                            secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                        />
                        <QQSwitch
                            checked={!updateState.portable && config.startup}
                            disabled={updateState.portable}
                            onChange={handleStartupChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText primary={t("settings.trayIcon")} primaryTypographyProps={PRIMARY_TEXT_PROPS} />
                        <QQSwitch checked={config.display_tray_icon} onChange={handleTrayChange} />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText primary={t("settings.language")} primaryTypographyProps={PRIMARY_TEXT_PROPS} />
                        <Select
                            value={config.multilingual}
                            onChange={handleLanguageChange}
                            size="small"
                            sx={{
                                minWidth: 160,
                                fontSize: '14px',
                                height: '34px',
                                borderRadius: '7px',
                                bgcolor: 'rgba(255,255,255,0.7)',
                                '.MuiOutlinedInput-notchedOutline': { borderColor: '#e1e5ea' }
                            }}
                        >
                            {languageChoices.map(language => (
                                <MenuItem key={language.value} value={language.value}>{language.label}</MenuItem>
                            ))}
                        </Select>
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText primary={t("settings.themeMode")} primaryTypographyProps={PRIMARY_TEXT_PROPS} />
                        <Select
                            value={config.theme_mode || "system"}
                            onChange={handleThemeChange}
                            size="small"
                            sx={{
                                minWidth: 160,
                                fontSize: '14px',
                                height: '34px',
                                borderRadius: '7px',
                                bgcolor: 'rgba(255,255,255,0.7)',
                                '.MuiOutlinedInput-notchedOutline': { borderColor: '#e1e5ea' }
                            }}
                        >
                            <MenuItem value="system">{t("settings.theme.system")}</MenuItem>
                            <MenuItem value="light">{t("settings.theme.light")}</MenuItem>
                            <MenuItem value="dark">{t("settings.theme.dark")}</MenuItem>
                        </Select>
                    </ListItem>
                    <Divider component="li" />
                    {isMacPlatform() && (['background', 'paste'] as PermissionId[]).map(permission => {
                        const done = permissionStatus?.[permission].done === true;
                        const label = permissionStatus === null
                            ? t("settings.permissions.checking")
                            : t(done ? "settings.permissions.enabled" : "settings.permissions.required");
                        return (
                            <React.Fragment key={permission}>
                                <ListItem sx={LIST_ITEM_SX}>
                                    <ListItemText
                                        primary={t(`settings.permissions.${permission}`)}
                                        primaryTypographyProps={PRIMARY_TEXT_PROPS}
                                    />
                                    <button
                                        type="button"
                                        className={`permission-status-button ${done ? 'enabled' : 'required'}`}
                                        disabled={permissionStatus === null || done}
                                        onClick={() => openPermissionGuide(permission)}
                                    >
                                        <span className="permission-status-dot" aria-hidden="true" />
                                        {label}
                                    </button>
                                </ListItem>
                                <Divider component="li" />
                            </React.Fragment>
                        );
                    })}
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText primary={t("settings.onboarding")} primaryTypographyProps={PRIMARY_TEXT_PROPS} />
                        <Button variant="outlined" size="small" onClick={openOnboarding} sx={{ textTransform: 'none', flex: '0 0 auto', borderRadius: '8px', px: 2.2, fontWeight: 600 }}>
                            {t("settings.onboardingOpen")}
                        </Button>
                    </ListItem>
                </List>
            </Box>

            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.section.personalization")}
                </Typography>
                <List sx={LIST_SX}>
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText
                            primary={t("settings.linkAutoPreview")}
                            secondary={t("settings.linkAutoPreview.desc")}
                            primaryTypographyProps={PRIMARY_TEXT_PROPS}
                            secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                        />
                        <QQSwitch
                            edge="end"
                            checked={config.link_auto_preview}
                            onChange={handleLinkAutoPreviewChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText
                            primary={t("settings.retainSearch")}
                            secondary={t("settings.retainSearch.desc")}
                            primaryTypographyProps={PRIMARY_TEXT_PROPS}
                            secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                        />
                        <QQSwitch
                            edge="end"
                            checked={config.retain_search_history}
                            onChange={handleRetainSearchHistoryChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText
                            primary={t("settings.retainTabPosition")}
                            secondary={t("settings.retainTabPosition.desc")}
                            primaryTypographyProps={PRIMARY_TEXT_PROPS}
                            secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                        />
                        <QQSwitch
                            edge="end"
                            checked={config.retain_tab_position}
                            onChange={handleRetainTabPositionChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText
                            primary={t("settings.retainPosition")}
                            secondary={t("settings.retainPosition.desc")}
                            primaryTypographyProps={PRIMARY_TEXT_PROPS}
                            secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                        />
                        <QQSwitch
                            edge="end"
                            checked={config.retain_last_position}
                            onChange={handleRetainLastPositionChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={LIST_ITEM_SX}>
                        <ListItemText
                            primary={t("settings.sensitiveContentProtection")}
                            secondary={t("settings.sensitiveContentProtection.desc")}
                            primaryTypographyProps={PRIMARY_TEXT_PROPS}
                            secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                        />
                        <QQSwitch
                            edge="end"
                            checked={config.sensitive_content_protection}
                            onChange={handleSensitiveContentProtectionChange}
                        />
                    </ListItem>
                </List>
            </Box>
        </Stack>
    );
}

function DataSettings({ config, storagePaths, t, onSave, onBlockingOperationChange }: SettingsProps & { storagePaths: StoragePaths | null, onBlockingOperationChange: (operation: SettingsBlockingOperation | null) => void }) {
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
        invoke<AppSourceOption[]>('list_recent_app_source_options', { days: 30 })
            .then(setRecentAppSources)
            .catch(e => error(`Failed to load recent app sources: ${e}`));
    }, []);

    React.useEffect(() => {
        loadRecentAppSources();
    }, [loadRecentAppSources]);

    const refreshStorageSummary = React.useCallback(() => {
        invoke<StorageCleanupInfo>('estimate_storage_cleanup', { days: 0 })
            .then(setStorageSummary)
            .catch(e => error(`Failed to load storage summary: ${e}`));
    }, []);

    React.useEffect(() => {
        refreshStorageSummary();
    }, [refreshStorageSummary]);

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
        const unlisten = listen("config-opened", resetCleanup);
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten config-opened: ${e}`));
        };
    }, [refreshStorageSummary]);

    React.useEffect(() => {
        const unlisten = listen<HistoryArchiveProgressPayload>("history-archive-progress", event => {
            setArchiveProgress(event.payload);
        });
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten history archive progress: ${e}`));
        };
    }, []);

    React.useEffect(() => {
        if (!transferWorking || !transferOperation) return;
        onBlockingOperationChange({
            title: t(transferOperation === 'export' ? "settings.exportWorkingTitle" : "settings.importWorkingTitle"),
            description: transferWorkingText,
            progress: transferProgressValue
        });
    }, [onBlockingOperationChange, t, transferOperation, transferProgressValue, transferWorking, transferWorkingText]);

    const refreshCleanupInfo = React.useCallback((days: number) => {
        invoke('estimate_storage_cleanup', { days })
            .then(v => setCleanupInfo(v as StorageCleanupInfo))
            .catch(e => error(`Failed to estimate storage cleanup: ${e}`));
    }, []);

    React.useEffect(() => {
        if (!cleanupDays) {
            setCleanupInfo(null);
            return;
        }
        refreshCleanupInfo(Number(cleanupDays));
    }, [cleanupDays, refreshCleanupInfo]);

    const handleChooseStorageDir = async () => {
        try {
            const selected = await open({
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
            const target = await save({
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
            await invoke<HistoryArchiveInfo>('export_history_archive', { archivePath: target });
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
            const selected = await open({
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
            const result = await invoke<HistoryArchiveInfo>('import_history_archive', { archivePath: selected });
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
            const info = await invoke<StorageCleanupInfo>('cleanup_storage_history', { days: Number(cleanupDays) });
            setCleanupInfo(info);
            const nextInfo = await invoke<StorageCleanupInfo>('estimate_storage_cleanup', { days: Number(cleanupDays) });
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
            return <img className="privacy-app-option-icon" src={convertFileSrc(iconPath)} alt="" />;
        }
        return <span className="privacy-app-option-icon placeholder">{displayAppSource(source, t).slice(0, 1).toUpperCase()}</span>;
    };

    return (
        <Stack spacing={2.15} sx={PAGE_STACK_SX}>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.section.dataSecurity")}
                </Typography>
                <List sx={LIST_SX}>
                    <ListItem sx={{ ...LIST_ITEM_SX, alignItems: 'flex-start' }}>
                        <Stack spacing={1.05} sx={{ width: '100%' }}>
                            <ListItemText
                                primary={t("settings.privacyApps")}
                                secondary={t("settings.privacyApps.desc")}
                                primaryTypographyProps={PRIMARY_TEXT_PROPS}
                                secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                            />
                            {ignoredAppSources.length > 0 ? (
                                <div className="privacy-app-list">
                                    {ignoredAppSources.map(source => {
                                        const option = recentAppSourceMap.get(source);
                                        return (
                                            <div className="privacy-app-chip" key={source} title={source}>
                                                {option?.icon_path ? (
                                                    <img className="privacy-app-option-icon" src={convertFileSrc(option.icon_path)} alt="" />
                                                ) : (
                                                    <span className="privacy-app-option-icon placeholder">{displayAppSource(source, t).slice(0, 1).toUpperCase()}</span>
                                                )}
                                                <span className="privacy-app-chip__text">
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
                                <div className="privacy-app-empty">{t("settings.privacyApps.empty")}</div>
                            )}
                            <Stack direction="row" spacing={1} alignItems="center">
                                <Select
                                    value={selectedPrivacyApp}
                                    onChange={(event: SelectChangeEvent<string>) => setSelectedPrivacyApp(event.target.value)}
                                    size="small"
                                    displayEmpty
                                    sx={{
                                        minWidth: 240,
                                        flex: '1 1 auto',
                                        fontSize: '14px',
                                        height: '34px',
                                        borderRadius: '7px',
                                        bgcolor: 'rgba(255,255,255,0.7)',
                                        '.MuiOutlinedInput-notchedOutline': { borderColor: '#e1e5ea' }
                                    }}
                                >
                                    <MenuItem value="" disabled>{t("settings.privacyApps.selectPlaceholder")}</MenuItem>
                                    {privacyAppOptions.map(option => (
                                        <MenuItem key={option.source} value={option.source}>
                                            <span className="privacy-app-option">
                                                {renderPrivacyAppIcon(option.source, option.icon_path)}
                                                <span>{displayAppSource(option.source, t)}</span>
                                            </span>
                                        </MenuItem>
                                    ))}
                                    <MenuItem disabled className="privacy-app-menu-hint">
                                        {t("settings.privacyApps.help")}
                                    </MenuItem>
                                </Select>
                                <Button
                                    variant="contained"
                                    color="inherit"
                                    size="small"
                                    onClick={handleAddPrivacyApp}
                                    disabled={!selectedPrivacyApp}
                                    sx={{ textTransform: 'none', boxShadow: 'none', flex: '0 0 auto', borderRadius: '8px', fontWeight: 600, bgcolor: 'rgba(31, 36, 43, 0.08)', color: '#26303a', '&:hover': { bgcolor: 'rgba(31, 36, 43, 0.12)' } }}
                                >
                                    {t("settings.privacyApps.add")}
                                </Button>
                                <Button variant="text" size="small" onClick={loadRecentAppSources} sx={{ textTransform: 'none', flex: '0 0 auto', borderRadius: '8px', fontWeight: 600 }}>
                                    {t("common.refresh")}
                                </Button>
                            </Stack>
                        </Stack>
                    </ListItem>
                </List>
            </Box>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.section.history")}
                </Typography>
                <List sx={LIST_SX}>
                    <ListItem sx={{ ...LIST_ITEM_SX, alignItems: 'flex-start' }}>
                        <Stack spacing={0.75} sx={{ width: '100%' }}>
                            <ListItemText
                                primary={t("settings.storageDir")}
                                secondary={t("settings.storageDir.desc")}
                                primaryTypographyProps={PRIMARY_TEXT_PROPS}
                                secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                            />
                            <Stack direction="row" spacing={1} alignItems="center">
                                <TextField
                                    value={storageDirDraft || storagePaths?.history_storage_dir || ""}
                                    placeholder={t("settings.defaultAppDataDir")}
                                    size="small"
                                    fullWidth
                                    InputProps={{ readOnly: true }}
                                    disabled={historyWorking}
                                    sx={{
                                        '& .MuiInputBase-input': {
                                            fontSize: '13px',
                                            fontFamily: 'Consolas, monospace'
                                        }
                                    }}
                                />
                                <Button disabled={historyWorking} variant="contained" color="inherit" size="small" onClick={handleChooseStorageDir} sx={{ textTransform: 'none', boxShadow: 'none', flex: '0 0 auto', borderRadius: '8px', fontWeight: 600, bgcolor: 'rgba(31, 36, 43, 0.08)', color: '#26303a', '&:hover': { bgcolor: 'rgba(31, 36, 43, 0.12)' } }}>{t("common.modify")}</Button>
                            </Stack>
                            {(historyWorkingArea === 'storage' || historyMessage) && (
                                <div className={`storage-migration-status ${historyMessage?.kind || 'working'}`}>
                                    {historyWorkingArea === 'storage' && <CircularProgress size={14} thickness={5} />}
                                    <span>{historyWorkingArea === 'storage' ? t("settings.historyWorking") : historyMessage?.text}</span>
                                </div>
                            )}
                        </Stack>
                    </ListItem>
                    <Divider component="li" />
                    <ListItem sx={{ ...LIST_ITEM_SX, alignItems: 'flex-start' }}>
                        <Stack spacing={0.75} sx={{ width: '100%' }}>
                            <Stack direction="row" spacing={1.5} alignItems="center">
                                <ListItemText
                                    primary={t("settings.cleanupHistory")}
                                    secondary={cleanupInfo
                                        ? t("settings.cleanupEstimate", { bytes: formatBytes(cleanupInfo.bytes), items: cleanupInfo.items })
                                        : storageSummary
                                            ? t("settings.cleanupSummary", { bytes: formatBytes(storageSummary.bytes), items: storageSummary.items })
                                            : t("settings.cleanupSummaryLoading")}
                                    primaryTypographyProps={PRIMARY_TEXT_PROPS}
                                    secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                                />
                                <Select
                                    value={cleanupDays}
                                    onChange={handleCleanupDaysChange}
                                    disabled={cleanupWorking || historyWorking}
                                    size="small"
                                    displayEmpty
                                    sx={{
                                        minWidth: 136,
                                        fontSize: '14px',
                                        height: '34px',
                                        borderRadius: '7px',
                                        bgcolor: 'rgba(255,255,255,0.7)',
                                        '.MuiOutlinedInput-notchedOutline': { borderColor: '#e1e5ea' }
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
                                    disabled={cleanupWorking || historyWorking || !cleanupInfo || cleanupInfo.items === 0}
                                    startIcon={cleanupWorking ? <CircularProgress size={14} thickness={5} /> : <AutoDeleteOutlinedIcon fontSize="small" />}
                                    sx={{ textTransform: 'none', boxShadow: 'none', flex: '0 0 auto', borderRadius: '8px', fontWeight: 600, bgcolor: 'rgba(31, 36, 43, 0.08)', color: '#26303a', '&:hover': { bgcolor: 'rgba(31, 36, 43, 0.12)' } }}
                                >
                                    {cleanupWorking ? t("settings.cleanupWorking") : t("common.cleanup")}
                                </Button>
                            </Stack>
                        </Stack>
                    </ListItem>
                </List>
            </Box>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.historyTransfer")}
                </Typography>
                <div className="history-transfer-panel">
                    <div className="history-transfer-grid">
                        <button
                            className="history-transfer-card"
                            type="button"
                            disabled={historyWorking || cleanupWorking}
                            onClick={handleImportHistory}
                        >
                            <FileUploadIcon className="history-transfer-card__icon" />
                            <span className="history-transfer-card__title">{t("settings.importHistory")}</span>
                            <span className="history-transfer-card__desc">{t("settings.importHistory.desc")}</span>
                        </button>
                        <button
                            className="history-transfer-card"
                            type="button"
                            disabled={historyWorking || cleanupWorking}
                            onClick={handleExportHistory}
                        >
                            <FileDownloadIcon className="history-transfer-card__icon" />
                            <span className="history-transfer-card__title">{t("settings.exportHistory")}</span>
                            <span className="history-transfer-card__desc">{t("settings.exportHistory.desc")}</span>
                        </button>
                    </div>
                    {(transferWorking || transferMessage) && (
                        <div className={`history-transfer-progress ${transferMessage?.kind || 'working'}`}>
                            <div className="history-transfer-progress__line">
                                {transferWorking && <CircularProgress size={14} thickness={5} />}
                                <span>{transferWorking ? transferWorkingText : transferMessage?.text}</span>
                            </div>
                            {transferWorking && (
                                <LinearProgress
                                    className="history-transfer-progress__bar"
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

function ShortcutSettings({ config, t, onSave }: SettingsProps) {
    const quickInputModifier = getModifierDisplayLabel("alt");

    const validateMainWindowShortcut = (value: string, event?: React.KeyboardEvent) => {
        if (isUnsupportedRecordedKey(event)) {
            return t("settings.shortcut.invalid");
        }
        if (!hasShortcutModifier(value)) {
            return t("settings.shortcut.requiresModifier");
        }
        if (isBlockedMainShortcut(value)) {
            return t("settings.shortcut.unsupportedSystem");
        }
        if (isReservedQuickInputShortcut(value) || isReservedQuickInputShortcutEvent(event)) {
            return t("settings.shortcut.quickInputConflict", { modifier: quickInputModifier });
        }
        return null;
    };

    const validatePasteAsTextShortcut = (value: string, event?: React.KeyboardEvent) => {
        if (isUnsupportedRecordedKey(event)) {
            return t("settings.shortcut.invalid");
        }
        if (isReservedQuickInputShortcut(value) || isReservedQuickInputShortcutEvent(event)) {
            return t("settings.shortcut.quickInputConflict", { modifier: quickInputModifier });
        }
        if (isReservedPasteAsTextShortcut(value)) {
            return t("settings.shortcut.panelConflict");
        }
        return null;
    };

    const handleShortcutChange = async (key: keyof Shortcutkey, value: string) => {
        return await onSave({
            ...config,
            shortcut_keys: {
                ...config.shortcut_keys,
                [key]: value
            }
        });
    };

    const handleTabQuickSelectChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onSave({ ...config, tab_quick_select_enabled: event.target.checked });
    };

    return (
        <Stack spacing={2.15} sx={PAGE_STACK_SX}>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.shortcuts.global")}
                </Typography>
                <List sx={LIST_SX}>
                    <ShortcutItem
                        label={t("settings.shortcuts.main")}
                        value={config.shortcut_keys.main_window}
                        onChange={(v) => handleShortcutChange('main_window', v)}
                        onRecordingStart={() => invoke('begin_main_shortcut_recording')}
                        onRecordingCancel={() => invoke('end_main_shortcut_recording')}
                        checkRegistration={(v) => invoke<ShortcutRegistrationInfo>('check_main_shortcut_registration', { shortcut: v })}
                        validate={validateMainWindowShortcut}
                        t={t}
                    />
                </List>
            </Box>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.shortcuts.mainWindow")}
                </Typography>
                <List sx={LIST_SX}>
                    <FixedShortcutItem
                        label={t("settings.shortcuts.quickSelect")}
                        value={t("settings.shortcuts.key.arrowsHorizontal")}
                    />
                    <Divider component="li" />
                    <ListItem
                        secondaryAction={
                            <QQSwitch
                                checked={config.tab_quick_select_enabled}
                                onChange={handleTabQuickSelectChange}
                            />
                        }
                        sx={{ ...LIST_ITEM_SX, pl: 4 }}
                    >
                        <ListItemText
                            primary={t("settings.tabQuickSelectSupport")}
                            secondary={t("settings.tabQuickSelect.desc")}
                            primaryTypographyProps={PRIMARY_TEXT_PROPS}
                            secondaryTypographyProps={SECONDARY_TEXT_PROPS}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.actionMenu")}
                        value={t("settings.shortcuts.key.arrowDown")}
                    />
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.search")}
                        value="Ctrl + F"
                    />
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.preview")}
                        value={t("settings.shortcuts.key.space")}
                    />
                    <Divider component="li" />
                    <ShortcutItem
                        label={t("settings.shortcuts.pasteText")}
                        value={config.shortcut_keys.paste_into_plain_text}
                        onChange={(v) => handleShortcutChange('paste_into_plain_text', v)}
                        validate={validatePasteAsTextShortcut}
                        t={t}
                    />
                    <Divider component="li" />
                    <FixedShortcutItem
                        label={t("settings.shortcuts.quickInput")}
                        secondary={t("settings.quickInput.enabled.desc", { modifier: quickInputModifier })}
                        value={t("settings.shortcuts.key.holdAlt", { modifier: quickInputModifier })}
                    />
                </List>
            </Box>
        </Stack>
    )
}

function FixedShortcutItem({ label, secondary, value }: { label: string, secondary?: string, value: string }) {
    return (
        <ListItem sx={{ ...LIST_ITEM_SX, py: 1.12, alignItems: 'center' }}>
            <ListItemText
                primary={label}
                secondary={secondary}
                primaryTypographyProps={PRIMARY_TEXT_PROPS}
                secondaryTypographyProps={SECONDARY_TEXT_PROPS}
            />
            <span className="shortcut-static">{value}</span>
        </ListItem>
    );
}

function ShortcutItem({ label, value, onChange, onRecordingStart, onRecordingCancel, checkRegistration, validate, t }: {
    label: string,
    value?: string,
    onChange: (v: string) => void | Promise<StorageMigrationInfo | null | void>,
    onRecordingStart?: () => void | Promise<unknown>,
    onRecordingCancel?: () => void | Promise<unknown>,
    checkRegistration?: (v: string) => Promise<ShortcutRegistrationInfo>,
    validate?: (v: string, event: React.KeyboardEvent) => string | null,
    t: TFunction
}) {
    const [recording, setRecording] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const recorderRef = React.useRef<HTMLButtonElement | null>(null);

    React.useEffect(() => {
        if (recording) {
            requestAnimationFrame(() => recorderRef.current?.focus());
        }
    }, [recording]);

    const restoreRecordedShortcut = () => {
        if (!onRecordingCancel) return;
        void Promise.resolve(onRecordingCancel()).catch(e => error(`Failed to restore shortcut after recording: ${e}`));
    };

    const stopRecordingAndRestore = () => {
        setRecording(false);
        restoreRecordedShortcut();
    };

    const startRecording = () => {
        setErrorMessage(null);
        void Promise.resolve(onRecordingStart?.())
            .then(() => setRecording(true))
            .catch((startError: unknown) => {
                setErrorMessage(t("settings.shortcut.saveFailed", { error: getErrorText(startError) }));
                setRecording(false);
            });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === "Escape" || e.key === "Esc") {
            setErrorMessage(null);
            stopRecordingAndRestore();
            return;
        }

        const modifiers = [];
        if (e.metaKey) modifiers.push('Command');
        if (e.ctrlKey) modifiers.push('Control');
        if (e.altKey) modifiers.push('Alt');
        if (e.shiftKey) modifiers.push('Shift');

        const rawKey = e.key;
        const keyUpper = rawKey.toUpperCase();
        if (['META', 'CONTROL', 'ALT', 'SHIFT'].includes(keyUpper)) return;

        const key = rawKey === " " ? "Space" : rawKey.length === 1 ? rawKey.toUpperCase() : formatShortcutLabel(rawKey).replace(/\s\+\s/g, "+");
        const shortcut = [...modifiers, key].join('+');
        const validationError = validate?.(shortcut, e);
        if (validationError) {
            setErrorMessage(validationError);
            stopRecordingAndRestore();
            return;
        }

        void Promise.resolve(checkRegistration?.(shortcut))
            .then(registrationInfo => {
                const conflictMessage = registrationInfo?.conflict ? t("settings.shortcut.occupiedConflict") : null;
                return Promise.resolve(onChange(shortcut)).then(saveInfo => ({ conflictMessage, saveInfo }));
            })
            .then(({ conflictMessage, saveInfo }) => {
                const nextErrorMessage = saveInfo?.shortcut_conflict
                    ? t("settings.shortcut.occupiedConflict")
                    : conflictMessage;
                setErrorMessage(nextErrorMessage);
                setRecording(false);
            })
            .catch((saveError: unknown) => {
                restoreRecordedShortcut();
                setErrorMessage(t("settings.shortcut.saveFailed", { error: getErrorText(saveError) }));
                setRecording(false);
            });
    };

    return (
        <ListItem sx={{ ...LIST_ITEM_SX, py: 1.12, alignItems: 'center' }}>
            <ListItemText
                primary={label}
                primaryTypographyProps={PRIMARY_TEXT_PROPS}
            />
            <div className="shortcut-control">
                <button
                    ref={recorderRef}
                    className={`shortcut-recorder ${recording ? "recording" : ""} ${value ? "" : "empty"} ${errorMessage ? "has-error" : ""}`}
                    type="button"
                    onClick={startRecording}
                    onKeyDown={recording ? handleKeyDown : undefined}
                    onBlur={() => {
                        if (recording) {
                            stopRecordingAndRestore();
                        }
                    }}
                >
                    {recording ? t("settings.shortcut.recording") : formatShortcutLabel(value) || t("settings.shortcut.clickToSet")}
                </button>
                {errorMessage && <span className="shortcut-error-text">{errorMessage}</span>}
            </div>
        </ListItem>
    );
}

function AboutSettings({ config, dir: _dir, t, onSave }: SettingsProps & { dir: string }) {
    const { state: updateState, check, prepare, schedule } = useAppUpdateState();
    const [checkedManually, setCheckedManually] = React.useState(false);
    const updateBusy = updateState.status === "checking"
        || updateState.status === "downloading"
        || updateState.status === "installing";

    const openExternal = (url: string) => {
        void invoke("open_url_in_browser", { url }).catch(e => error(`Failed to open external link: ${e}`));
    };

    const handleCheckUpdate = async () => {
        try {
            setCheckedManually(true);
            await check();
        } catch (e) {
            error(`Failed to check update: ${e}`);
        }
    };

    const handlePrepareUpdate = async () => {
        try {
            await prepare();
        } catch (e) {
            error(`Failed to prepare update: ${e}`);
        }
    };

    const handleScheduleUpdate = async (timing: "immediate" | "onQuit" | "later") => {
        try {
            await schedule(timing);
        } catch (e) {
            error(`Failed to schedule update: ${e}`);
        }
    };

    const handleAutomaticCheckChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        void onSave({ ...config, update_check_enabled: event.target.checked })
            .catch(e => error(`Failed to change automatic update setting: ${e}`));
    };

    const displayVersion = updateState.currentVersion || t("settings.versionUnknown");
    const statusText = updateStatusText(updateState, checkedManually, t);
    const progressValue = updateState.totalBytes && updateState.totalBytes > 0
        ? Math.min(100, (updateState.downloadedBytes / updateState.totalBytes) * 100)
        : undefined;
    const updatePrepared = updateState.status === "ready" || updateState.status === "deferred";

    return (
        <Stack spacing={2.25} sx={PAGE_STACK_SX}>
            <Box className="about-hero">
                <div className="about-logo-tile">
                    <img src={appIcon} alt="vPaste" />
                </div>
                <div className="about-copy">
                    <Typography variant="h5" sx={{ fontWeight: 700, color: 'var(--settings-title)', letterSpacing: 0 }}>
                        vPaste
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.65, color: 'var(--settings-muted)', lineHeight: 1.55 }}>
                        {t("settings.about.subtitle")}
                    </Typography>
                    <div className="about-version-actions">
                        <span className="about-version-pill">
                            {t("common.version", { version: displayVersion })}
                        </span>
                        <Button
                            variant="contained"
                            color="inherit"
                            size="small"
                            disabled={updateBusy || !updateState.feedEnabled}
                            onClick={handleCheckUpdate}
                            sx={{ textTransform: 'none', boxShadow: 'none', flex: '0 0 auto', borderRadius: '999px', minHeight: 26, px: 1.35, fontSize: 12, fontWeight: 650, bgcolor: 'rgba(31, 36, 43, 0.08)', color: '#26303a', '&:hover': { bgcolor: 'rgba(31, 36, 43, 0.12)' } }}
                        >
                            {updateState.status === "checking" ? t("settings.updateChecking") : t("settings.updateCheck")}
                        </Button>
                    </div>
                </div>
            </Box>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.about.updateSection")}
                </Typography>
                <div className="about-update-panel">
                    <div className="about-update-panel__header">
                        <div>
                            <div className="about-update-panel__title">{t("settings.updateTitle")}</div>
                            <div className="about-update-panel__desc">
                                {updateState.portable
                                    ? t("settings.updatePortableDesc")
                                    : !updateState.feedEnabled
                                        ? t("settings.updateDisabled")
                                        : t("settings.updateAutoCheckDesc")}
                            </div>
                        </div>
                        <Switch
                            size="small"
                            checked={!updateState.portable && updateState.feedEnabled && config.update_check_enabled}
                            disabled={updateState.portable || !updateState.feedEnabled}
                            onChange={handleAutomaticCheckChange}
                            inputProps={{ 'aria-label': t("settings.updateAutoCheck") }}
                        />
                    </div>
                    {statusText && (
                        <div className={`about-update-status ${updateState.status === 'failed' ? 'error' : updateState.status === 'ready' ? 'success' : 'working'}`}>
                            {statusText}
                        </div>
                    )}
                    {updateState.status === "downloading" && (
                        <LinearProgress
                            className="about-update-progress"
                            variant={progressValue === undefined ? "indeterminate" : "determinate"}
                            value={progressValue}
                        />
                    )}
                    <div className="about-update-actions">
                        {updateState.status === "available" && (
                            <Button size="small" variant="contained" startIcon={<FileDownloadIcon />} onClick={() => void handlePrepareUpdate()}>
                                {t("settings.updateDownload")}
                            </Button>
                        )}
                        {updateState.status === "manualDownload" && (
                            <Button size="small" variant="contained" startIcon={<LaunchOutlinedIcon />} onClick={() => openExternal(updateState.releaseUrl)}>
                                {t("settings.updateOpenRelease")}
                            </Button>
                        )}
                        {updatePrepared && (
                            <>
                                <Button size="small" variant="contained" startIcon={<UpdateRoundedIcon />} onClick={() => void handleScheduleUpdate("immediate")}>
                                    {t("settings.updateInstallNow")}
                                </Button>
                                <Button size="small" variant="outlined" startIcon={<ScheduleOutlinedIcon />} onClick={() => void handleScheduleUpdate("onQuit")}>
                                    {t("settings.updateOnQuit")}
                                </Button>
                                <Button size="small" variant="text" startIcon={<AccessTimeOutlinedIcon />} onClick={() => void handleScheduleUpdate("later")}>
                                    {t("settings.updateLater")}
                                </Button>
                            </>
                        )}
                        {updateState.status === "failed" && updateState.feedEnabled && (
                            <Button size="small" variant="outlined" startIcon={<UpdateRoundedIcon />} onClick={() => void handleCheckUpdate()}>
                                {t("settings.updateRetry")}
                            </Button>
                        )}
                    </div>
                </div>
            </Box>
            <Box>
                <Typography variant="subtitle2" sx={SECTION_TITLE_SX}>
                    {t("settings.about.linksSection")}
                </Typography>
                <div className="about-link-grid">
                    <button className="about-link-card" type="button" onClick={() => openExternal(APP_CHANGELOG_URL)}>
                        <span className="about-link-card__icon"><ArticleOutlinedIcon fontSize="small" /></span>
                        <span className="about-link-card__body">
                            <span className="about-link-card__title">{t("settings.about.changelog")}</span>
                            <span className="about-link-card__desc">{t("settings.about.changelog.desc")}</span>
                        </span>
                        <LaunchOutlinedIcon className="about-link-card__launch" fontSize="small" />
                    </button>
                    <button className="about-link-card" type="button" onClick={() => openExternal(APP_REPOSITORY_URL)}>
                        <span className="about-link-card__icon"><GitHubIcon fontSize="small" /></span>
                        <span className="about-link-card__body">
                            <span className="about-link-card__title">{t("settings.about.github")}</span>
                            <span className="about-link-card__desc">Loxonl/vPaste-desktop</span>
                        </span>
                        <LaunchOutlinedIcon className="about-link-card__launch" fontSize="small" />
                    </button>
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
            return state.installTiming === "onQuit"
                ? t("settings.updateScheduled", { version })
                : t("settings.updateReady", { version });
        case "deferred":
            return t("settings.updateDeferred", { version });
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
