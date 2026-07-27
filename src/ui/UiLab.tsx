import { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import { setThemePreview, type ResolvedTheme } from "../theme";
import StatusBadge from "./StatusBadge";
import Surface from "./Surface";
import { SettingsRow, SettingsSection } from "./settings/SettingsPrimitives";
import styles from "./UiLab.module.css";

type LabLanguage = "zh" | "en";

const copy = {
    zh: {
        title: "vPaste 组件样板间",
        subtitle: "仅用于开发和视觉回归，不会出现在正式软件中。",
        actions: "按钮与状态",
        fields: "输入控件",
        settings: "设置行",
        save: "保存",
        cancel: "取消",
        remove: "删除",
        loading: "处理中",
        success: "已启用",
        warning: "需要授权",
        language: "界面语言",
        languageDesc: "更改 vPaste 内置界面的显示语言",
        startup: "开机启动",
        startupDesc: "登录系统后自动运行 vPaste",
    },
    en: {
        title: "vPaste UI Lab",
        subtitle: "Development and visual regression only; never shown in production.",
        actions: "Buttons and status",
        fields: "Form controls",
        settings: "Settings rows",
        save: "Save",
        cancel: "Cancel",
        remove: "Delete",
        loading: "Working",
        success: "Enabled",
        warning: "Permission required",
        language: "Interface language",
        languageDesc: "Choose the language used by the built-in vPaste interface",
        startup: "Launch at login",
        startupDesc: "Start vPaste automatically after signing in",
    },
} as const;

export default function UiLab() {
    const [language, setLanguage] = useState<LabLanguage>("zh");
    const [theme, setTheme] = useState<ResolvedTheme>("light");
    const [enabled, setEnabled] = useState(true);
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
                    <div className={styles.row}>
                        <Button variant="contained">{text.save}</Button>
                        <Button variant="outlined">{text.cancel}</Button>
                        <Button color="error" variant="text">{text.remove}</Button>
                        <Button disabled>{text.loading}</Button>
                    </div>
                    <div className={styles.row}>
                        <StatusBadge tone="success">{text.success}</StatusBadge>
                        <StatusBadge tone="warning">{text.warning}</StatusBadge>
                        <StatusBadge tone="danger">{text.remove}</StatusBadge>
                    </div>
                    <LinearProgress variant="determinate" value={58} />
                </Surface>

                <Surface padded className={styles.panel}>
                    <h2>{text.fields}</h2>
                    <div className={styles.row}>
                        <TextField
                            className={styles.field}
                            size="small"
                            label={text.language}
                            defaultValue="vPaste"
                        />
                        <Select
                            className={styles.field}
                            size="small"
                            value={language}
                            onChange={event => setLanguage(event.target.value as LabLanguage)}
                            aria-label={text.language}
                        >
                            <MenuItem value="zh">简体中文</MenuItem>
                            <MenuItem value="en">English</MenuItem>
                        </Select>
                    </div>
                    <div className={styles.row}>
                        <FormControlLabel
                            control={<Switch checked={enabled} onChange={event => setEnabled(event.target.checked)} />}
                            label={text.startup}
                        />
                        <FormControlLabel control={<Checkbox defaultChecked />} label="Checkbox" />
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
                                    aria-label={text.language}
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
            </div>
        </main>
    );
}
