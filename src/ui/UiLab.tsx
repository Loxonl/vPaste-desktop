import { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import LaunchOutlinedIcon from "@mui/icons-material/LaunchOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import { setThemePreview, type ResolvedTheme } from "../theme";
import ActionCard from "./ActionCard";
import { ConfirmDialog } from "./ConfirmDialog";
import { InlineMenuItem, InlineMenuSurface } from "./InlineMenu";
import StatusBadge from "./StatusBadge";
import { StatusToast } from "./StatusToast";
import Surface from "./Surface";
import { ToolbarIconButton } from "./ToolbarIconButton";
import { SettingsRow, SettingsSection } from "./settings/SettingsPrimitives";
import styles from "./UiLab.module.css";

type LabLanguage = "zh" | "en";

const longMenuItems = Array.from({ length: 18 }, (_, index) => index + 1);

const copy = {
    zh: {
        title: "vPaste 组件样板间",
        subtitle: "仅用于开发和视觉回归，不会出现在正式软件中。",
        actions: "按钮与状态",
        fields: "输入状态",
        selections: "选择与长内容",
        toggles: "开关与复选框",
        navigation: "导航与反馈",
        overlays: "菜单、Toast 与工具栏",
        settings: "设置行",
        actionCards: "操作卡片",
        normal: "正常",
        disabled: "禁用",
        loading: "处理中",
        save: "保存",
        cancel: "取消",
        remove: "删除",
        success: "已启用",
        warning: "需要授权",
        defaultField: "普通输入",
        errorField: "错误输入",
        errorHelper: "请输入有效的名称。",
        readOnlyField: "只读输入",
        disabledField: "禁用输入",
        language: "界面语言",
        standardSelect: "普通选择",
        longValueSelect: "超长选中内容",
        longValue: "这是一条用于验证截断与布局稳定性的超长选项内容",
        longList: "长列表选择",
        longListItem: "最近来源应用",
        disabledSelect: "禁用选择",
        startup: "开机启动",
        startupDesc: "登录系统后自动运行 vPaste",
        on: "开启",
        off: "关闭",
        checked: "已勾选",
        unchecked: "未勾选",
        firstTab: "常规",
        secondTab: "数据",
        disabledTab: "不可用",
        tabPanel: "方向键可以在可用标签之间移动。",
        openDialog: "打开对话框",
        dialogTitle: "确认操作",
        dialogDescription: "对话框打开后应限制焦点，按 Escape 可关闭并把焦点还给触发按钮。",
        close: "关闭",
        confirm: "确认",
        edit: "编辑标签",
        undo: "撤销",
        saved: "标签已保存",
        tooltipAction: "查看提示",
        tooltipContent: "工具提示同时支持鼠标悬停和键盘焦点。",
        progress: "进度反馈",
        determinate: "确定进度",
        indeterminate: "未知进度",
        languageDesc: "更改 vPaste 内置界面的显示语言",
        importTitle: "导入历史记录",
        importDescription: "从 vPaste 归档恢复历史记录",
        changelogTitle: "更新日志",
        changelogDescription: "查看每个版本的改动内容",
    },
    en: {
        title: "vPaste UI Lab",
        subtitle: "Development and visual regression only; never shown in production.",
        actions: "Buttons and status",
        fields: "Input states",
        selections: "Selection and long content",
        toggles: "Switches and checkboxes",
        navigation: "Navigation and feedback",
        overlays: "Menus, toasts, and toolbar",
        settings: "Settings rows",
        actionCards: "Action cards",
        normal: "Default",
        disabled: "Disabled",
        loading: "Working",
        save: "Save",
        cancel: "Cancel",
        remove: "Delete",
        success: "Enabled",
        warning: "Permission required",
        defaultField: "Default input",
        errorField: "Invalid input",
        errorHelper: "Enter a valid name.",
        readOnlyField: "Read-only input",
        disabledField: "Disabled input",
        language: "Interface language",
        standardSelect: "Default selection",
        longValueSelect: "Long selected value",
        longValue: "A deliberately long option used to verify truncation and stable layout",
        longList: "Long list selection",
        longListItem: "Recent source app",
        disabledSelect: "Disabled selection",
        startup: "Launch at login",
        startupDesc: "Start vPaste automatically after signing in",
        on: "On",
        off: "Off",
        checked: "Checked",
        unchecked: "Unchecked",
        firstTab: "General",
        secondTab: "Data",
        disabledTab: "Unavailable",
        tabPanel: "Arrow keys move between the available tabs.",
        openDialog: "Open dialog",
        dialogTitle: "Confirm action",
        dialogDescription: "The dialog traps focus, closes with Escape, and restores focus to its trigger.",
        close: "Close",
        confirm: "Confirm",
        edit: "Edit tag",
        undo: "Undo",
        saved: "Tag saved",
        tooltipAction: "Show tooltip",
        tooltipContent: "The tooltip works with both pointer hover and keyboard focus.",
        progress: "Progress feedback",
        determinate: "Known progress",
        indeterminate: "Unknown progress",
        languageDesc: "Choose the language used by the built-in vPaste interface",
        importTitle: "Import history",
        importDescription: "Restore history from a vPaste archive",
        changelogTitle: "Changelog",
        changelogDescription: "Review changes included in each release",
    },
} as const;

export default function UiLab() {
    const [language, setLanguage] = useState<LabLanguage>("zh");
    const [theme, setTheme] = useState<ResolvedTheme>("light");
    const [enabled, setEnabled] = useState(true);
    const [selectedValue, setSelectedValue] = useState("long");
    const [longListValue, setLongListValue] = useState("1");
    const [tabValue, setTabValue] = useState(0);
    const [dialogOpen, setDialogOpen] = useState(false);
    const text = copy[language];

    useEffect(() => {
        setThemePreview(theme);
        return () => setThemePreview(null);
    }, [theme]);

    return (
        <main className={styles.page} data-testid="ui-lab">
            <header className={styles.header}>
                <div>
                    <h1>{text.title}</h1>
                    <p>{text.subtitle}</p>
                </div>
                <div className={styles.toolbar} aria-label="Preview controls">
                    <Button
                        variant={language === "zh" ? "contained" : "outlined"}
                        onClick={() => setLanguage("zh")}
                    >
                        中文
                    </Button>
                    <Button
                        variant={language === "en" ? "contained" : "outlined"}
                        onClick={() => setLanguage("en")}
                    >
                        English
                    </Button>
                    <Button
                        variant={theme === "light" ? "contained" : "outlined"}
                        onClick={() => setTheme("light")}
                    >
                        Light
                    </Button>
                    <Button
                        variant={theme === "dark" ? "contained" : "outlined"}
                        onClick={() => setTheme("dark")}
                    >
                        Dark
                    </Button>
                </div>
            </header>

            <div className={styles.grid}>
                <Surface padded className={styles.panel}>
                    <h2>{text.actions}</h2>
                    <div className={styles.stateMatrix}>
                        <span className={styles.stateLabel}>{text.normal}</span>
                        <div className={styles.row}>
                            <Button variant="contained">{text.save}</Button>
                            <Button variant="outlined">{text.cancel}</Button>
                            <Button color="error" variant="text">{text.remove}</Button>
                        </div>
                        <span className={styles.stateLabel}>{text.disabled}</span>
                        <div className={styles.row}>
                            <Button variant="contained" disabled>{text.save}</Button>
                            <Button variant="outlined" disabled>{text.cancel}</Button>
                        </div>
                        <span className={styles.stateLabel}>{text.loading}</span>
                        <div className={styles.row}>
                            <Button
                                variant="contained"
                                disabled
                                startIcon={<CircularProgress color="inherit" size={14} thickness={5} />}
                            >
                                {text.loading}
                            </Button>
                        </div>
                    </div>
                    <div className={styles.row}>
                        <StatusBadge tone="success">{text.success}</StatusBadge>
                        <StatusBadge tone="warning">{text.warning}</StatusBadge>
                        <StatusBadge tone="danger">{text.remove}</StatusBadge>
                    </div>
                </Surface>

                <Surface padded className={styles.panel}>
                    <h2>{text.toggles}</h2>
                    <div className={styles.toggleGrid}>
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={enabled}
                                    onChange={event => setEnabled(event.target.checked)}
                                />
                            }
                            label={`${text.startup} · ${text.on}`}
                        />
                        <FormControlLabel control={<Switch />} label={`${text.startup} · ${text.off}`} />
                        <FormControlLabel
                            control={<Switch checked disabled />}
                            label={`${text.disabled} · ${text.on}`}
                        />
                        <FormControlLabel
                            control={<Switch disabled />}
                            label={`${text.disabled} · ${text.off}`}
                        />
                        <FormControlLabel control={<Checkbox defaultChecked />} label={text.checked} />
                        <FormControlLabel control={<Checkbox />} label={text.unchecked} />
                        <FormControlLabel control={<Checkbox defaultChecked disabled />} label={`${text.disabled} · ${text.checked}`} />
                        <FormControlLabel control={<Checkbox disabled />} label={`${text.disabled} · ${text.unchecked}`} />
                    </div>
                </Surface>

                <Surface padded className={`${styles.panel} ${styles.widePanel}`}>
                    <h2>{text.fields}</h2>
                    <div className={styles.fieldGrid}>
                        <TextField
                            size="small"
                            label={text.defaultField}
                            defaultValue="vPaste"
                        />
                        <TextField
                            id="lab-error-field"
                            size="small"
                            label={text.errorField}
                            defaultValue="?"
                            error
                            helperText={text.errorHelper}
                        />
                        <TextField
                            size="small"
                            label={text.readOnlyField}
                            defaultValue="vPaste"
                            InputProps={{ readOnly: true }}
                        />
                        <TextField
                            size="small"
                            label={text.disabledField}
                            defaultValue="vPaste"
                            disabled
                        />
                    </div>
                </Surface>

                <Surface padded className={`${styles.panel} ${styles.widePanel}`}>
                    <h2>{text.selections}</h2>
                    <div className={styles.fieldGrid}>
                        <label className={styles.controlSample}>
                            <span>{text.standardSelect}</span>
                            <Select
                                size="small"
                                value={language}
                                onChange={event => setLanguage(event.target.value as LabLanguage)}
                                inputProps={{ "aria-label": text.standardSelect }}
                            >
                                <MenuItem value="zh">简体中文</MenuItem>
                                <MenuItem value="en">English</MenuItem>
                            </Select>
                        </label>
                        <label className={styles.controlSample}>
                            <span>{text.longValueSelect}</span>
                            <Select
                                size="small"
                                value={selectedValue}
                                onChange={event => setSelectedValue(event.target.value)}
                                inputProps={{ "aria-label": text.longValueSelect }}
                            >
                                <MenuItem value="standard">vPaste</MenuItem>
                                <MenuItem value="long">{text.longValue}</MenuItem>
                            </Select>
                        </label>
                        <label className={styles.controlSample}>
                            <span>{text.longList}</span>
                            <Select
                                data-testid="lab-long-select"
                                size="small"
                                value={longListValue}
                                onChange={event => setLongListValue(event.target.value)}
                                inputProps={{ "aria-label": text.longList }}
                            >
                                {longMenuItems.map(item => (
                                    <MenuItem key={item} value={String(item)}>
                                        {text.longListItem} {item}
                                    </MenuItem>
                                ))}
                            </Select>
                        </label>
                        <label className={styles.controlSample}>
                            <span>{text.disabledSelect}</span>
                            <Select
                                size="small"
                                value="disabled"
                                disabled
                                inputProps={{ "aria-label": text.disabledSelect }}
                            >
                                <MenuItem value="disabled">{text.disabled}</MenuItem>
                            </Select>
                        </label>
                    </div>
                </Surface>

                <Surface padded className={`${styles.panel} ${styles.widePanel}`}>
                    <h2>{text.navigation}</h2>
                    <div className={styles.feedbackGrid}>
                        <div className={styles.tabsDemo}>
                            <Tabs
                                orientation="vertical"
                                value={tabValue}
                                onChange={(_event, value) => setTabValue(value)}
                                aria-label={text.navigation}
                            >
                                <Tab label={text.firstTab} />
                                <Tab label={text.secondTab} />
                                <Tab label={text.disabledTab} disabled />
                            </Tabs>
                            <div className={styles.tabPanel} role="tabpanel">
                                <strong>{tabValue === 0 ? text.firstTab : text.secondTab}</strong>
                                <span>{text.tabPanel}</span>
                            </div>
                        </div>
                        <div className={styles.feedbackActions}>
                            <div className={styles.row}>
                                <Button
                                    data-testid="dialog-trigger"
                                    variant="outlined"
                                    onClick={() => setDialogOpen(true)}
                                >
                                    {text.openDialog}
                                </Button>
                                <Tooltip describeChild title={text.tooltipContent}>
                                    <Button variant="text">{text.tooltipAction}</Button>
                                </Tooltip>
                            </div>
                            <div className={styles.progressStack}>
                                <span>{text.progress}</span>
                                <div className={styles.progressItem}>
                                    <span>{text.determinate}</span>
                                    <LinearProgress
                                        aria-label={text.determinate}
                                        variant="determinate"
                                        value={58}
                                    />
                                </div>
                                <div className={styles.progressItem}>
                                    <span>{text.indeterminate}</span>
                                    <LinearProgress
                                        aria-label={text.indeterminate}
                                        variant="indeterminate"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </Surface>

                <Surface padded className={`${styles.panel} ${styles.widePanel}`}>
                    <h2>{text.overlays}</h2>
                    <div className={styles.overlayGrid}>
                        <InlineMenuSurface className={styles.inlineMenuSample}>
                            <InlineMenuItem selected>{text.edit}</InlineMenuItem>
                            <InlineMenuItem danger>{text.remove}</InlineMenuItem>
                        </InlineMenuSurface>
                        <StatusToast
                            className={styles.toastSample}
                            message={text.saved}
                            actionLabel={text.undo}
                            onAction={() => undefined}
                        />
                        <ToolbarIconButton label={text.settings}>
                            <SettingsOutlinedIcon fontSize="small" />
                        </ToolbarIconButton>
                    </div>
                </Surface>

                <Surface padded className={styles.settingsPreview}>
                    <h2>{text.settings}</h2>
                    <SettingsSection title={text.settings}>
                        <SettingsRow
                            label={text.language}
                            description={text.languageDesc}
                            control={
                                <Select
                                    size="small"
                                    value={language}
                                    onChange={event => setLanguage(event.target.value as LabLanguage)}
                                    inputProps={{ "aria-label": text.language }}
                                >
                                    <MenuItem value="zh">简体中文</MenuItem>
                                    <MenuItem value="en">English</MenuItem>
                                </Select>
                            }
                        />
                        <SettingsRow
                            label={text.startup}
                            description={text.startupDesc}
                            control={
                                <Switch
                                    checked={enabled}
                                    onChange={event => setEnabled(event.target.checked)}
                                    inputProps={{ "aria-label": text.startup }}
                                />
                            }
                        />
                    </SettingsSection>
                </Surface>

                <Surface padded className={styles.settingsPreview}>
                    <h2>{text.actionCards}</h2>
                    <div className={styles.actionCardGrid}>
                        <ActionCard
                            icon={<ArticleOutlinedIcon fontSize="small" />}
                            title={text.changelogTitle}
                            description={text.changelogDescription}
                            endAdornment={<LaunchOutlinedIcon fontSize="small" />}
                            onClick={() => undefined}
                        />
                        <ActionCard
                            layout="vertical"
                            icon={<FileUploadOutlinedIcon fontSize="large" />}
                            title={text.importTitle}
                            description={text.importDescription}
                            onClick={() => undefined}
                        />
                        <ActionCard
                            layout="vertical"
                            icon={<FileUploadOutlinedIcon fontSize="large" />}
                            title={text.importTitle}
                            description={text.disabled}
                            disabled
                            onClick={() => undefined}
                        />
                    </div>
                </Surface>
            </div>

            <ConfirmDialog
                open={dialogOpen}
                title={text.dialogTitle}
                description={text.dialogDescription}
                cancelLabel={text.close}
                confirmLabel={text.confirm}
                onCancel={() => setDialogOpen(false)}
                onConfirm={() => setDialogOpen(false)}
            />
        </main>
    );
}
