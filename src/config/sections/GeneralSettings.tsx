import * as React from "react";
import { Box, Button, ButtonBase, Divider, List, ListItem, ListItemText, MenuItem, Select, Stack, Switch, Typography, type SelectChangeEvent } from "@mui/material";
import { error } from "@tauri-apps/plugin-log";
import { isMacPlatform } from "../../shortcutDisplay";
import type { ThemeMode } from "../../theme";
import { useAppUpdateState } from "../../update";
import type { LanguageOption, PermissionId, PermissionStatus, SettingsSectionProps } from "../settingsTypes";
import { classes } from "../../ui/classNames";
import styles from "../Config.module.css";

const PENDING_PERMISSION_WINDOW_KEY = "vpaste.pendingOnboardingPermission.v1";

export default function GeneralSettings({ bridge, config, languages, t, onSave }: SettingsSectionProps & { languages: LanguageOption[] }) {
    const [permissionStatus, setPermissionStatus] = React.useState<PermissionStatus | null>(null);
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
        void bridge.invoke("open_onboarding_window").catch(e => error(`Failed to open onboarding: ${e}`));
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
        <Stack spacing={2.15} className={classes(styles, "settings-page-stack")}>
            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.section.system")}
                </Typography>
                <List>
                    <ListItem>
                        <ListItemText
                            primary={t("settings.startup")}
                            secondary={updateState.portable ? t("settings.startupPortable") : undefined}
                        />
                        <Switch
                            checked={!updateState.portable && config.startup}
                            disabled={updateState.portable}
                            onChange={handleStartupChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <ListItemText primary={t("settings.trayIcon")} />
                        <Switch checked={config.display_tray_icon} onChange={handleTrayChange} />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <ListItemText primary={t("settings.language")} />
                        <Select
                            value={config.multilingual}
                            onChange={handleLanguageChange}
                            size="small"
                            sx={{
                                minWidth: 160
                            }}
                        >
                            {languageChoices.map(language => (
                                <MenuItem key={language.value} value={language.value}>{language.label}</MenuItem>
                            ))}
                        </Select>
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <ListItemText primary={t("settings.themeMode")} />
                        <Select
                            value={config.theme_mode || "system"}
                            onChange={handleThemeChange}
                            size="small"
                            sx={{
                                minWidth: 160
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
                                <ListItem>
                                    <ListItemText
                                        primary={t(`settings.permissions.${permission}`)}
                                    />
                                    <ButtonBase
                                        className={classes(styles, `permission-status-button ${done ? 'enabled' : 'required'}`)}
                                        disabled={permissionStatus === null || done}
                                        onClick={() => openPermissionGuide(permission)}
                                    >
                                        <span className={classes(styles, "permission-status-dot")} aria-hidden="true" />
                                        {label}
                                    </ButtonBase>
                                </ListItem>
                                <Divider component="li" />
                            </React.Fragment>
                        );
                    })}
                    <ListItem>
                        <ListItemText primary={t("settings.onboarding")} />
                        <Button variant="outlined" size="small" onClick={openOnboarding} sx={{ flex: '0 0 auto' }}>
                            {t("settings.onboardingOpen")}
                        </Button>
                    </ListItem>
                </List>
            </Box>

            <Box>
                <Typography variant="subtitle2" className={classes(styles, "settings-section-title")}>
                    {t("settings.section.personalization")}
                </Typography>
                <List>
                    <ListItem>
                        <ListItemText
                            primary={t("settings.linkAutoPreview")}
                            secondary={t("settings.linkAutoPreview.desc")}
                        />
                        <Switch
                            edge="end"
                            checked={config.link_auto_preview}
                            onChange={handleLinkAutoPreviewChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <ListItemText
                            primary={t("settings.retainSearch")}
                            secondary={t("settings.retainSearch.desc")}
                        />
                        <Switch
                            edge="end"
                            checked={config.retain_search_history}
                            onChange={handleRetainSearchHistoryChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <ListItemText
                            primary={t("settings.retainTabPosition")}
                            secondary={t("settings.retainTabPosition.desc")}
                        />
                        <Switch
                            edge="end"
                            checked={config.retain_tab_position}
                            onChange={handleRetainTabPositionChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <ListItemText
                            primary={t("settings.retainPosition")}
                            secondary={t("settings.retainPosition.desc")}
                        />
                        <Switch
                            edge="end"
                            checked={config.retain_last_position}
                            onChange={handleRetainLastPositionChange}
                        />
                    </ListItem>
                    <Divider component="li" />
                    <ListItem>
                        <ListItemText
                            primary={t("settings.sensitiveContentProtection")}
                            secondary={t("settings.sensitiveContentProtection.desc")}
                        />
                        <Switch
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
