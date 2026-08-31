import * as React from "react";
import { Button, MenuItem, Select, Stack, Switch, type SelectChangeEvent } from "@mui/material";
import { error } from "@tauri-apps/plugin-log";
import { isMacPlatform } from "../../shortcutDisplay";
import type { ThemeMode } from "../../theme";
import { useAppUpdateState } from "../../update";
import type { LanguageOption, PermissionId, PermissionStatus, SettingsSectionProps } from "../settingsTypes";
import { SettingsRow, SettingsSection } from "../../ui/settings/SettingsPrimitives";
import StatusBadge from "../../ui/StatusBadge";
import { AnimatePresence, m, useMotionPreset } from "../../ui/motion";

const PENDING_PERMISSION_WINDOW_KEY = "vpaste.pendingOnboardingPermission.v1";

export default function GeneralSettings({ bridge, config, languages, t, onSave }: SettingsSectionProps & { languages: LanguageOption[] }) {
    const [permissionStatus, setPermissionStatus] = React.useState<PermissionStatus | null>(null);
    const permissionStatusMotion = useMotionPreset("stateIndicator");
    const { state: updateState } = useAppUpdateState(bridge);
    const languageChoices = languages.some(language => language.value === config.multilingual)
        ? languages
        : [{ value: config.multilingual, label: config.multilingual }, ...languages];

    const refreshPermissionStatus = React.useCallback(() => {
        if (!isMacPlatform()) return;
        void bridge.invoke<PermissionStatus>('get_onboarding_permission_status')
            .then(setPermissionStatus)
            .catch(e => error(`Failed to load permission status: ${e}`));
    }, [bridge]);

    React.useEffect(() => {
        if (!isMacPlatform()) return;
        refreshPermissionStatus();
        const unlistenStatus = bridge.listen('onboarding-permission-status-changed', refreshPermissionStatus);
        const unlistenConfigOpened = bridge.listen('config-opened', refreshPermissionStatus);
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
    }, [bridge, refreshPermissionStatus]);

    const openPermissionGuide = (permission: PermissionId) => {
        const themePreview = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        const payload = {
            permission,
            languageCode: config.multilingual,
            themePreview,
        };
        localStorage.setItem(PENDING_PERMISSION_WINDOW_KEY, JSON.stringify(payload));
        void bridge.invoke('open_onboarding_permission_window', payload)
            .catch(e => error(`Failed to open ${permission} permission guide: ${e}`));
    };

    const handleStartupChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        void onSave({ ...config, startup: event.target.checked })
            .catch(e => error(`Failed to change startup setting: ${e}`));
    };

    const saveSetting = (nextConfig: typeof config, setting: string) => {
        void onSave(nextConfig).catch(e => error(`Failed to change ${setting} setting: ${e}`));
    };

    const handleTrayChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        saveSetting({ ...config, display_tray_icon: event.target.checked }, "tray icon");
    };

    const handleLanguageChange = (event: SelectChangeEvent<string>) => {
        saveSetting({ ...config, multilingual: event.target.value }, "language");
    };

    const handleThemeChange = (event: SelectChangeEvent<string>) => {
        saveSetting({ ...config, theme_mode: event.target.value as ThemeMode }, "theme");
    };

    const openOnboarding = () => {
        void bridge.invoke("open_onboarding_window").catch(e => error(`Failed to open onboarding: ${e}`));
    };

    const handleRetainSearchHistoryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        saveSetting({ ...config, retain_search_history: event.target.checked }, "search history retention");
    };

    const handleRetainLastPositionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        saveSetting({ ...config, retain_last_position: event.target.checked }, "scroll position retention");
    };

    const handleRetainTabPositionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        saveSetting({ ...config, retain_tab_position: event.target.checked }, "tab position retention");
    };

    const handleLinkAutoPreviewChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        saveSetting({ ...config, link_auto_preview: event.target.checked }, "link preview");
    };

    const handleSensitiveContentProtectionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        saveSetting({ ...config, sensitive_content_protection: event.target.checked }, "sensitive content protection");
    };

    return (
        <Stack spacing={6}>
            <SettingsSection title={t("settings.section.system")}>
                    <SettingsRow
                        labelId="settings-startup-label"
                        descriptionId={updateState.portable ? "settings-startup-description" : undefined}
                        label={t("settings.startup")}
                        description={updateState.portable ? t("settings.startupPortable") : undefined}
                        control={(
                        <Switch
                            checked={!updateState.portable && config.startup}
                            disabled={updateState.portable}
                            onChange={handleStartupChange}
                            inputProps={{
                                "aria-labelledby": "settings-startup-label",
                                "aria-describedby": updateState.portable ? "settings-startup-description" : undefined,
                            }}
                        />
                        )}
                    />
                    <SettingsRow
                        labelId="settings-tray-label"
                        label={t("settings.trayIcon")}
                        control={<Switch checked={config.display_tray_icon} onChange={handleTrayChange} inputProps={{ "aria-labelledby": "settings-tray-label" }} />}
                    />
                    <SettingsRow
                        labelId="settings-language-label"
                        label={t("settings.language")}
                        control={(
                        <Select
                            value={config.multilingual}
                            onChange={handleLanguageChange}
                            size="small"
                            SelectDisplayProps={{ "aria-labelledby": "settings-language-label" }}
                            sx={{
                                minWidth: 160
                            }}
                        >
                            {languageChoices.map(language => (
                                <MenuItem key={language.value} value={language.value}>{language.label}</MenuItem>
                            ))}
                        </Select>
                        )}
                    />
                    <SettingsRow
                        labelId="settings-theme-label"
                        label={t("settings.themeMode")}
                        control={(
                        <Select
                            value={config.theme_mode || "system"}
                            onChange={handleThemeChange}
                            size="small"
                            SelectDisplayProps={{ "aria-labelledby": "settings-theme-label" }}
                            sx={{
                                minWidth: 160
                            }}
                        >
                            <MenuItem value="system">{t("settings.theme.system")}</MenuItem>
                            <MenuItem value="light">{t("settings.theme.light")}</MenuItem>
                            <MenuItem value="dark">{t("settings.theme.dark")}</MenuItem>
                        </Select>
                        )}
                    />
                    {isMacPlatform() && (['background', 'paste'] as PermissionId[]).map(permission => {
                        const done = permissionStatus?.[permission].done === true;
                        const label = permissionStatus === null
                            ? t("settings.permissions.checking")
                            : t(done ? "settings.permissions.enabled" : "settings.permissions.required");
                        return (
                            <SettingsRow
                                key={permission}
                                label={t(`settings.permissions.${permission}`)}
                                control={(
                                    <AnimatePresence mode="wait" initial={false}>
                                        <m.div
                                            key={permissionStatus === null ? "checking" : done ? "enabled" : "required"}
                                            data-motion-preset="stateIndicator"
                                            data-motion-state={done ? "permission-granted" : "permission-status"}
                                            variants={permissionStatusMotion}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                        >
                                            {done || permissionStatus === null
                                                ? <StatusBadge tone={done ? "success" : "neutral"} role="status">{label}</StatusBadge>
                                                : (
                                                    <Button color="warning" variant="outlined" size="small" onClick={() => openPermissionGuide(permission)}>
                                                        {label}
                                                    </Button>
                                                )}
                                        </m.div>
                                    </AnimatePresence>
                                )}
                            />
                        );
                    })}
                    <SettingsRow
                        label={t("settings.onboarding")}
                        control={<Button variant="outlined" size="small" onClick={openOnboarding} sx={{ flex: '0 0 auto' }}>
                            {t("settings.onboardingOpen")}
                        </Button>}
                    />
            </SettingsSection>

            <SettingsSection title={t("settings.section.personalization")}>
                    <SettingsRow
                        labelId="settings-link-preview-label"
                        descriptionId="settings-link-preview-description"
                        label={t("settings.linkAutoPreview")}
                        description={t("settings.linkAutoPreview.desc")}
                        control={(
                        <Switch
                            checked={config.link_auto_preview}
                            onChange={handleLinkAutoPreviewChange}
                            inputProps={{ "aria-labelledby": "settings-link-preview-label", "aria-describedby": "settings-link-preview-description" }}
                        />
                        )}
                    />
                    <SettingsRow
                        labelId="settings-retain-search-label"
                        descriptionId="settings-retain-search-description"
                        label={t("settings.retainSearch")}
                        description={t("settings.retainSearch.desc")}
                        control={(
                        <Switch
                            checked={config.retain_search_history}
                            onChange={handleRetainSearchHistoryChange}
                            inputProps={{ "aria-labelledby": "settings-retain-search-label", "aria-describedby": "settings-retain-search-description" }}
                        />
                        )}
                    />
                    <SettingsRow
                        labelId="settings-retain-tab-label"
                        descriptionId="settings-retain-tab-description"
                        label={t("settings.retainTabPosition")}
                        description={t("settings.retainTabPosition.desc")}
                        control={(
                        <Switch
                            checked={config.retain_tab_position}
                            onChange={handleRetainTabPositionChange}
                            inputProps={{ "aria-labelledby": "settings-retain-tab-label", "aria-describedby": "settings-retain-tab-description" }}
                        />
                        )}
                    />
                    <SettingsRow
                        labelId="settings-retain-position-label"
                        descriptionId="settings-retain-position-description"
                        label={t("settings.retainPosition")}
                        description={t("settings.retainPosition.desc")}
                        control={(
                        <Switch
                            checked={config.retain_last_position}
                            onChange={handleRetainLastPositionChange}
                            inputProps={{ "aria-labelledby": "settings-retain-position-label", "aria-describedby": "settings-retain-position-description" }}
                        />
                        )}
                    />
                    <SettingsRow
                        labelId="settings-sensitive-protection-label"
                        descriptionId="settings-sensitive-protection-description"
                        label={t("settings.sensitiveContentProtection")}
                        description={t("settings.sensitiveContentProtection.desc")}
                        control={(
                        <Switch
                            checked={config.sensitive_content_protection}
                            onChange={handleSensitiveContentProtectionChange}
                            inputProps={{ "aria-labelledby": "settings-sensitive-protection-label", "aria-describedby": "settings-sensitive-protection-description" }}
                        />
                        )}
                    />
            </SettingsSection>
        </Stack>
    );
}
