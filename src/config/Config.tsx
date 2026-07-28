import * as React from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import { CircularProgress, LinearProgress } from "@mui/material";
import Typography from '@mui/material/Typography';
import { info, error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import { isMacPlatform } from "../shortcutDisplay";
import { applyThemeMode } from "../theme";
import { tauriSettingsBridge, type SettingsBridge } from "./SettingsBridge";
import { persistSettings } from "./settingsPersistence";
import layout from "./ConfigLayout.module.css";
import { DEFAULT_CONFIG, parseSettingsConfig, type ConfigData, type SettingsBlockingOperation, type StorageMigrationInfo, type StoragePaths } from "./settingsTypes";
import GeneralSettings from "./sections/GeneralSettings";
import DataSettings from "./sections/DataSettings";
import ShortcutSettings from "./sections/ShortcutSettings";
import AboutSettings from "./sections/AboutSettings";

// Icons
import TuneIcon from '@mui/icons-material/Tune'; // For General/Common
import StorageIcon from '@mui/icons-material/StorageOutlined'; // For Data
import KeyboardIcon from '@mui/icons-material/Keyboard'; // For Shortcuts
import InfoIcon from '@mui/icons-material/InfoOutlined'; // For About
import CloseIcon from '@mui/icons-material/Close';

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

function startConfigWindowDrag(event: React.MouseEvent<HTMLElement>, bridge: SettingsBridge) {
    if (event.button !== 0) return;
    event.preventDefault();
    void bridge.startWindowDragging().catch(e => error(`Failed to drag config window: ${e}`));
}

function WindowControls({ bridge }: { bridge: SettingsBridge }) {
    const hideWindow = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        void bridge.hideWindow().catch(e => error(`Failed to hide config window: ${e}`));
    };

    if (!isMacPlatform()) {
        return (
            <div className={layout.windowsWindowControls} data-tauri-no-drag="true">
                <button className={layout.windowsWindowClose} type="button" aria-label="Close" onClick={hideWindow}>
                    <CloseIcon fontSize="small" />
                </button>
            </div>
        );
    }

    return (
        <div className={layout.windowControls} data-tauri-no-drag="true">
            <button className={`${layout.windowControl} ${layout.close}`} type="button" aria-label="Close" onClick={hideWindow}>
                <b />
            </button>
            <button className={layout.windowControl} type="button" aria-label="Minimize disabled" disabled />
            <button className={layout.windowControl} type="button" aria-label="Zoom disabled" disabled />
        </div>
    );
}

function a11yProps(index: number) {
    return {
        id: `vertical-tab-${index}`,
        'aria-controls': `vertical-tabpanel-${index}`,
    };
}

export default function Config({ bridge = tauriSettingsBridge }: { bridge?: SettingsBridge }) {
    const { t, languages, setLanguageCode } = useLanguage(bridge);
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
        bridge.invoke('get_app_data_dir', {}).then(v => {
            setDir(v as string);
        });
        bridge.invoke('get_storage_paths', {}).then(v => {
            setStoragePaths(v as StoragePaths);
        }).catch(e => error(`Failed to load storage paths: ${e}`));
        bridge.invoke('get_config', {}).then(v => {
            info(`Loaded config: ${v}`);
            try {
                const parsed = parseSettingsConfig(v as string);
                setConfig(parsed);
                setLanguageCode(parsed.multilingual);
                applyThemeMode(parsed.theme_mode);
            } catch (e) {
                error(`Failed to parse config: ${e}`);
            }
        });
    }, [bridge, setLanguageCode]);

    React.useEffect(() => {
        const refreshStartupStatus = () => {
            void bridge.invoke<string>('get_config', {}).then(raw => {
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
        const unlisten = bridge.listen<string>("config-opened", event => applyTarget(event.payload));
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
    }, [bridge]);

    const saveConfig = async (newConfig: ConfigData): Promise<StorageMigrationInfo | null> => {
        const previousConfig = config;
        const applyConfig = (nextConfig: ConfigData) => {
            setConfig(nextConfig);
            setLanguageCode(nextConfig.multilingual || DEFAULT_CONFIG.multilingual);
            applyThemeMode(nextConfig.theme_mode || DEFAULT_CONFIG.theme_mode);
        };

        try {
            const migrationInfo = await persistSettings<ConfigData, StorageMigrationInfo, StoragePaths>({
                bridge,
                previousConfig,
                nextConfig: newConfig,
                applyConfig,
                applyStoragePaths: setStoragePaths,
                serialize: JSON.stringify,
            });
            info("Config saved");
            return migrationInfo;
        } catch (e) {
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
                className={`${layout.container} ${windowsControlsHoverReady ? layout.windowsControlsHoverReady : ""}`}
                data-testid="settings-root"
                onMouseMoveCapture={() => {
                    if (!windowsControlsHoverReady) {
                        setWindowsControlsHoverReady(true);
                    }
                }}
            >
                <div className={layout.dragRegion} onMouseDown={event => startConfigWindowDrag(event, bridge)} />
                <WindowControls bridge={bridge} />
                <div className={layout.sidebar}>
                    <div className={layout.sidebarDragRegion} onMouseDown={event => startConfigWindowDrag(event, bridge)} />
                    <Tabs
                        orientation="vertical"
                        value={value}
                        onChange={handleChange}
                        aria-label="Configuration tabs"
                        TabIndicatorProps={{ style: { display: 'none' } }} // Hide default indicator
                        sx={{ borderRight: 0, width: '100%', minWidth: 0 }}
                        data-tauri-no-drag="true"
                    >
                        <Tab disabled={isSettingsBlocked} icon={<TuneIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.general")} {...a11yProps(0)} data-tauri-no-drag="true" />
                        <Tab disabled={isSettingsBlocked} icon={<StorageIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.data")} {...a11yProps(1)} data-tauri-no-drag="true" />
                        <Tab disabled={isSettingsBlocked} icon={<KeyboardIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.shortcuts")} {...a11yProps(2)} data-tauri-no-drag="true" />
                        <Tab disabled={isSettingsBlocked} icon={<InfoIcon fontSize="small" />} iconPosition="start" label={t("settings.tabs.about")} {...a11yProps(3)} data-tauri-no-drag="true" />
                    </Tabs>
                </div>
                <div className={layout.contentArea}>
                    <div className={layout.contentTitleBar} onMouseDown={event => startConfigWindowDrag(event, bridge)}>
                        <Typography variant="h5">
                            {value === 0 ? t("settings.general.title") : value === 1 ? t("settings.data.title") : value === 2 ? t("settings.shortcuts.title") : t("settings.about.title")}
                        </Typography>
                    </div>
                    <div className={layout.contentScroll}>
                        <div className={layout.contentInner}>
                    <TabPanel value={value} index={0}>
                        <GeneralSettings bridge={bridge} config={config} languages={languages} t={t} onSave={saveConfig} />
                    </TabPanel>
                    <TabPanel value={value} index={1}>
                        <DataSettings bridge={bridge} config={config} storagePaths={storagePaths} t={t} onSave={saveConfig} onBlockingOperationChange={setBlockingOperation} />
                    </TabPanel>
                    <TabPanel value={value} index={2}>
                        <ShortcutSettings bridge={bridge} config={config} t={t} onSave={saveConfig} />
                    </TabPanel>
                    <TabPanel value={value} index={3}>
                        <AboutSettings bridge={bridge} config={config} dir={dir} t={t} onSave={saveConfig} />
                    </TabPanel>
                        </div>
                    </div>
                </div>
                {blockingOperation && (
                    <div className={layout.blockingOverlay} role="alert" aria-live="assertive">
                        <div className={layout.blockingDialog}>
                            <div className={layout.blockingSpinner}>
                                <CircularProgress size={28} thickness={4.5} />
                            </div>
                            <div className={layout.blockingTitle}>{blockingOperation.title}</div>
                            <div className={layout.blockingDescription}>{blockingOperation.description}</div>
                            <LinearProgress
                                className={layout.blockingProgress}
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
