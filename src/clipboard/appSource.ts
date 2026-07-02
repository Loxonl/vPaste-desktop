export type AppSourceOption = {
    source: string;
    icon_path?: string;
};

export type Translate = (key: string) => string;

export const APP_SOURCE_NAME_KEYS: Record<string, string> = {
    "360chrome": "appSource.360chrome",
    "360se": "appSource.360chrome",
    "acrobat": "appSource.acrobat",
    "acrord32": "appSource.acrobatReader",
    "chrome": "appSource.chrome",
    "cursor": "appSource.cursor",
    "dingtalk": "appSource.dingtalk",
    "discord": "appSource.discord",
    "everything": "appSource.everything",
    "excel": "appSource.excel",
    "explorer": "appSource.explorer",
    "feishu": "appSource.feishu",
    "firefox": "appSource.firefox",
    "idea64": "appSource.idea",
    "lark": "appSource.lark",
    "listary": "appSource.listary",
    "msedge": "appSource.edge",
    "notion": "appSource.notion",
    "obsidian": "appSource.obsidian",
    "onenote": "appSource.onenote",
    "photoshop": "appSource.photoshop",
    "pixpin": "appSource.pixpin",
    "potplayer": "appSource.potplayer",
    "potplayermini64": "appSource.potplayer",
    "powerpnt": "appSource.powerpoint",
    "pycharm64": "appSource.pycharm",
    "qq": "appSource.qq",
    "slack": "appSource.slack",
    "snipaste": "appSource.snipaste",
    "sumatrapdf": "appSource.sumatrapdf",
    "teams": "appSource.teams",
    "telegram": "appSource.telegram",
    "ticktick": "appSource.ticktick",
    "tim": "appSource.tim",
    "vpaste": "appSource.vpaste",
    "wechat": "appSource.wechat",
    "weixin": "appSource.wechat",
    "winword": "appSource.word",
    "wxwork": "appSource.wxwork",
};

export function displayAppSource(source: string, t: Translate): string {
    const processName = source.trim().replace(/\.exe$/i, "");
    const normalized = processName.toLowerCase();
    const nameKey = APP_SOURCE_NAME_KEYS[normalized];
    if (!nameKey) return processName;
    const officialName = t(nameKey);
    if (!officialName || officialName === nameKey) return processName;
    return officialName;
}

export function compactAppSourceName(source: string, t: Translate): string {
    return displayAppSource(source, t).trim();
}
