import { type RefObject, useState } from "react";
import ButtonBase from "@mui/material/ButtonBase";
import AddIcon from "@mui/icons-material/Add";
import AppleIcon from "@mui/icons-material/Apple";
import AppsOutlinedIcon from "@mui/icons-material/AppsOutlined";
import DashboardCustomizeOutlinedIcon from "@mui/icons-material/DashboardCustomizeOutlined";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import PlaylistAddCheckRoundedIcon from "@mui/icons-material/PlaylistAddCheckRounded";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import StarBorderOutlinedIcon from "@mui/icons-material/StarBorderOutlined";
import SystemUpdateAltOutlinedIcon from "@mui/icons-material/SystemUpdateAltOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import WindowOutlinedIcon from "@mui/icons-material/WindowOutlined";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import { AnimatePresence, m, motionSprings, useMotionPreset } from "../ui/motion";
import { type DynamicTabEntry } from "./customTabs";
import { type TutorialPlatform } from "./TutorialOverlay";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type ClipboardTabBarProps = {
    activeTab: string;
    dynamicTabs: DynamicTabEntry[];
    draggingTabId: string;
    tutorialActive: boolean;
    altHintsVisible: boolean;
    addButtonRef: RefObject<HTMLButtonElement>;
    t: TFunction;
    onSelectTab: (tabId: string) => void;
    onBlockedNavigation: () => void;
    onEditTab: (entry: DynamicTabEntry, anchor: HTMLButtonElement) => void;
    onOpenContextMenu: (entry: DynamicTabEntry, clientX: number, clientY: number) => void;
    onDragStart: (tabId: string) => void;
    onDragEnd: () => void;
    onDrop: (tabId: string) => void;
    onAdd: (clientX: number, clientY: number) => void;
};

export function ClipboardTabBar({
    activeTab,
    dynamicTabs,
    draggingTabId,
    tutorialActive,
    altHintsVisible,
    addButtonRef,
    t,
    onSelectTab,
    onBlockedNavigation,
    onEditTab,
    onOpenContextMenu,
    onDragStart,
    onDragEnd,
    onDrop,
    onAdd,
}: ClipboardTabBarProps) {
    const selectionIndicator = useMotionPreset("selectionIndicator");

    const activeIndicator = (active: boolean) => active ? (
        <m.span
            className={classes(styles, "tab-selection-indicator")}
            layoutId="clipboard-tab-selection-indicator"
            variants={selectionIndicator}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ layout: motionSprings.layout }}
            aria-hidden="true"
        />
    ) : null;

    const selectTab = (tabId: string) => {
        if (tutorialActive) {
            onBlockedNavigation();
        } else {
            onSelectTab(tabId);
        }
    };

    return (
        <div className={classes(styles, "header-tabs")} onDragOver={event => event.preventDefault()}>
            <button
                type="button"
                className={classes(styles, `tab-item fixed ${activeTab === "all" ? 'active' : ''}`)}
                onClick={() => selectTab("all")}
            >
                {activeIndicator(activeTab === "all")}
                <AppsOutlinedIcon className={classes(styles, "tab-icon tab-icon-all")} fontSize="inherit" />
                <span className={classes(styles, "tab-label")}>{t("tabs.all")}</span>
                {altHintsVisible && <span className={classes(styles, "alt-tab-hint")}>A</span>}
            </button>
            <button
                type="button"
                className={classes(styles, `tab-item fixed ${activeTab === "favorite" ? 'active' : ''}`)}
                onClick={() => selectTab("favorite")}
            >
                {activeIndicator(activeTab === "favorite")}
                <StarBorderOutlinedIcon className={classes(styles, "tab-icon tab-icon-favorite")} fontSize="inherit" />
                <span className={classes(styles, "tab-label")}>{t("tabs.favorite")}</span>
                {altHintsVisible && <span className={classes(styles, "alt-tab-hint")}>F</span>}
            </button>
            {dynamicTabs.map(entry => {
                const label = entry.kind === "filter" ? entry.tab.name : entry.tag.name;
                return (
                    <button
                        key={entry.id}
                        type="button"
                        className={classes(styles, `tab-item ${entry.kind === "filter" ? 'custom' : 'record'} ${tutorialActive ? 'tutorial-locked' : ''} ${activeTab === entry.id ? 'active' : ''} ${draggingTabId === entry.id ? 'dragging' : ''}`)}
                        draggable={!tutorialActive}
                        onClick={() => selectTab(entry.id)}
                        onDoubleClick={tutorialActive ? undefined : event => onEditTab(entry, event.currentTarget)}
                        onContextMenu={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (tutorialActive) {
                                onBlockedNavigation();
                                return;
                            }
                            onOpenContextMenu(entry, event.clientX, event.clientY);
                        }}
                        onDragStart={() => {
                            if (!tutorialActive) onDragStart(entry.id);
                        }}
                        onDragEnd={onDragEnd}
                        onDrop={event => {
                            event.preventDefault();
                            onDrop(entry.id);
                        }}
                    >
                        {activeIndicator(activeTab === entry.id)}
                        <span className={classes(styles, "tab-label")}>{label}</span>
                    </button>
                );
            })}
            {!tutorialActive && (
                <ToolbarIconButton
                    ref={addButtonRef}
                    className={classes(styles, "tab-add-button")}
                    label={t("tabs.add")}
                    aria-haspopup="menu"
                    onClick={event => {
                        event.stopPropagation();
                        onAdd(event.clientX, event.clientY);
                    }}
                >
                    <AddIcon fontSize="small" />
                </ToolbarIconButton>
            )}
        </div>
    );
}

type ClipboardHeaderActionsProps = {
    isMac: boolean;
    tutorialActive: boolean;
    tutorialPlatform: TutorialPlatform;
    permissionIncomplete: boolean;
    showDeveloperToolbar: boolean;
    languageCode: string;
    developerTheme: "light" | "dark";
    t: TFunction;
    pasteQueueActive: boolean;
    onOpenPasteQueue: () => void;
    onOpenPermissionCenter: () => void;
    onOpenTutorial: (platform: TutorialPlatform) => void;
    onToggleLanguage: () => void;
    onToggleTheme: () => void;
    onOpenUiLab: () => void;
    onOpenTestRoom: () => void;
    onOpenSettings: () => void;
};

export function ClipboardHeaderActions({
    isMac,
    tutorialActive,
    tutorialPlatform,
    permissionIncomplete,
    showDeveloperToolbar,
    languageCode,
    developerTheme,
    t,
    pasteQueueActive,
    onOpenPasteQueue,
    onOpenPermissionCenter,
    onOpenTutorial,
    onToggleLanguage,
    onToggleTheme,
    onOpenUiLab,
    onOpenTestRoom,
    onOpenSettings,
}: ClipboardHeaderActionsProps) {
    const [developerToolsVisible, setDeveloperToolsVisible] = useState(true);
    const statusMotion = useMotionPreset("listItem");

    return (
        <div className={classes(styles, "header-actions")}>
            <AnimatePresence mode="wait" initial={false}>
                {isMac && !tutorialActive && permissionIncomplete && (
                    <m.div
                        key="permission-summary"
                        className={classes(styles, "permission-summary-motion")}
                        variants={statusMotion}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                    >
                        <ButtonBase
                            className={classes(styles, "permission-summary-banner")}
                            onClick={onOpenPermissionCenter}
                        >
                            <WarningAmberOutlinedIcon fontSize="inherit" />
                            <span>{t("clipboard.permissionsIncomplete")}</span>
                        </ButtonBase>
                    </m.div>
                )}
            </AnimatePresence>
            {showDeveloperToolbar && developerToolsVisible && (
                <div
                    id="developer-toolbar"
                    role="group"
                    className={classes(styles, "developer-toolbar")}
                    aria-label={t("tutorial.debug.tools")}
                >
                    <span className={classes(styles, "developer-toolbar-badge")} aria-hidden="true">DEV</span>
                    <ButtonBase
                        className={classes(styles, `settings-button developer-toolbar-button${tutorialActive && tutorialPlatform === "windows" ? " is-active" : ""}`)}
                        title={t("tutorial.debug.windows")}
                        aria-label={t("tutorial.debug.windows")}
                        aria-pressed={tutorialActive && tutorialPlatform === "windows"}
                        onClick={() => onOpenTutorial("windows")}
                    >
                        <WindowOutlinedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
                        <span>Win</span>
                    </ButtonBase>
                    <ButtonBase
                        className={classes(styles, `settings-button developer-toolbar-button${tutorialActive && tutorialPlatform === "mac" ? " is-active" : ""}`)}
                        title={t("tutorial.debug.mac")}
                        aria-label={t("tutorial.debug.mac")}
                        aria-pressed={tutorialActive && tutorialPlatform === "mac"}
                        onClick={() => onOpenTutorial("mac")}
                    >
                        <AppleIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
                        <span>Mac</span>
                    </ButtonBase>
                    <span className={classes(styles, "developer-toolbar-divider")} aria-hidden="true" />
                    <ToolbarIconButton
                        className={classes(styles, "settings-button developer-toolbar-button developer-toolbar-icon-button")}
                        label={t("tutorial.debug.language")}
                        onClick={onToggleLanguage}
                    >
                        <span>{languageCode === "Chinese" ? "中" : "EN"}</span>
                    </ToolbarIconButton>
                    <ToolbarIconButton
                        className={classes(styles, "settings-button developer-toolbar-button developer-toolbar-icon-button")}
                        label={t(developerTheme === "dark" ? "tutorial.debug.theme.dark" : "tutorial.debug.theme.light")}
                        aria-pressed={developerTheme === "dark"}
                        onClick={onToggleTheme}
                    >
                        {developerTheme === "dark"
                            ? <DarkModeRoundedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
                            : <LightModeRoundedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />}
                    </ToolbarIconButton>
                    <span className={classes(styles, "developer-toolbar-divider")} aria-hidden="true" />
                    <ToolbarIconButton
                        className={classes(styles, "settings-button developer-toolbar-button developer-toolbar-icon-button")}
                        label={t("tutorial.debug.testRoom")}
                        onClick={onOpenTestRoom}
                    >
                        <ScienceOutlinedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
                    </ToolbarIconButton>
                    <ToolbarIconButton
                        className={classes(styles, "settings-button developer-toolbar-button developer-toolbar-icon-button")}
                        label={t("tutorial.debug.uiLab")}
                        onClick={onOpenUiLab}
                    >
                        <DashboardCustomizeOutlinedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
                    </ToolbarIconButton>
                </div>
            )}
            {showDeveloperToolbar && (
                <ToolbarIconButton
                    className={classes(styles, `settings-button developer-visibility-button${developerToolsVisible ? "" : " is-hidden"}`)}
                    label={t(developerToolsVisible ? "tutorial.debug.hideTools" : "tutorial.debug.showTools")}
                    aria-pressed={developerToolsVisible}
                    aria-controls="developer-toolbar"
                    onClick={() => setDeveloperToolsVisible(visible => !visible)}
                >
                    <VisibilityOutlinedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
                </ToolbarIconButton>
            )}
            {!tutorialActive && (
                <ToolbarIconButton
                    className={classes(styles, `settings-button${pasteQueueActive ? " is-active" : ""}`)}
                    label={t(pasteQueueActive ? "pasteQueue.close" : "pasteQueue.open")}
                    aria-pressed={pasteQueueActive}
                    onClick={onOpenPasteQueue}
                >
                    <PlaylistAddCheckRoundedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
                </ToolbarIconButton>
            )}
            <ToolbarIconButton
                className={classes(styles, "settings-button")}
                label={t("common.settings")}
                onClick={onOpenSettings}
            >
                <SettingsOutlinedIcon className={classes(styles, "settings-icon")} fontSize="inherit" />
            </ToolbarIconButton>
        </div>
    );
}

type ClipboardUpdateBannerProps = {
    version: string;
    t: TFunction;
    onRestart: () => void;
};

export function ClipboardUpdateBanner({
    version,
    t,
    onRestart,
}: ClipboardUpdateBannerProps) {
    return (
        <ButtonBase className={classes(styles, "app-update-banner")} onClick={onRestart}>
            <SystemUpdateAltOutlinedIcon fontSize="inherit" />
            <span>{t("clipboard.updateDownloaded", { version })}</span>
            <strong>{t("clipboard.updateRestart")}</strong>
        </ButtonBase>
    );
}
