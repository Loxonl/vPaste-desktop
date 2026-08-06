export const TEST_ROOM_SCHEMA_VERSION = 1;

export type SampleItemType = "Text" | "RichText" | "Excel" | "Color" | "Link" | "Image" | "File" | "TextFile";

export type SampleItem = {
    id: string;
    name: string;
    itemType: SampleItemType;
    value: string;
    presetId?: string;
    appSource: string;
    timeOffsetMs?: number;
};

export type SampleGroup = {
    id: string;
    name: string;
    builtIn: boolean;
    items: SampleItem[];
};

export type TestRoomConfig = {
    schemaVersion: number;
    groups: SampleGroup[];
    deletedBuiltInGroupIds: string[];
    deletedBuiltInItemIds: string[];
};

export type SamplePreset = {
    id: string;
    label: string;
    value: string;
};

export const APP_SOURCE_OPTIONS = [
    "",
    "Google Chrome",
    "Microsoft Edge",
    "Microsoft Word",
    "Microsoft Excel",
    "Microsoft OneNote",
    "Figma",
    "Notepad3",
    "PixPin",
    "OBS Studio",
    "Tabby",
    "QQ",
    "WeChat",
    "File Explorer",
    "vPaste",
] as const;

export const SAMPLE_PRESETS: Record<Exclude<SampleItemType, "Text">, SamplePreset[]> = {
    RichText: [
        { id: "rich-launch", label: "产品发布说明", value: "vPaste 让常用内容触手可及\n更快整理，更安心粘贴。" },
        { id: "rich-meeting", label: "会议纪要", value: "本周重点\n• 完成体验验证\n• 准备产品演示" },
        { id: "rich-release-en", label: "English release note", value: "A calmer clipboard workflow\n• Local by default\n• Ready when you need it" },
    ],
    Excel: [
        { id: "excel-sales", label: "销售概览", value: "产品\t区域\t销售额\t环比\nWorkspace\t华东\t¥128,600\t+12.4%\nStarter\t华南\t¥86,240\t+8.1%\nTeam\t华北\t¥64,900\t-2.3%" },
        { id: "excel-projects", label: "项目进度", value: "项目\t负责人\t状态\t截止日期\n桌面端演示\t林晓\t进行中\t2026-08-18\n素材整理\t陈雨\t已完成\t2026-08-12\n发布检查\t周宁\t待开始\t2026-08-22" },
        { id: "excel-budget", label: "月度预算", value: "类别\t预算\t实际\t差额\n设计\t¥20,000\t¥18,500\t+¥1,500\n制作\t¥35,000\t¥36,200\t-¥1,200\n投放\t¥50,000\t¥46,800\t+¥3,200" },
        { id: "excel-inventory", label: "库存清单", value: "SKU\t品名\t库存\t状态\nDEMO-101\t便携支架\t128\t充足\nDEMO-205\t收纳包\t34\t补货中\nDEMO-318\t数据线\t76\t正常" },
        { id: "excel-campaign", label: "Campaign performance", value: "Channel\tImpressions\tClicks\tConversion\nSearch\t128,400\t6,320\t4.9%\nSocial\t96,800\t4,210\t4.3%\nNewsletter\t42,600\t3,180\t7.5%" },
    ],
    Color: [
        { id: "color-indigo", label: "品牌靛蓝 #5B67F1", value: "#5B67F1" },
        { id: "color-mint", label: "薄荷绿 #4CBF9B", value: "#4CBF9B" },
        { id: "color-coral", label: "珊瑚橙 #F47B62", value: "#F47B62" },
    ],
    Link: [
        { id: "link-vpaste", label: "vPaste 官网", value: "https://vpaste.app" },
        { id: "link-example", label: "示例链接", value: "https://example.com/product-demo" },
    ],
    Image: [
        { id: "image-logo", label: "vPaste 产品 Logo", value: "image-logo" },
        { id: "image-gradient", label: "渐变宣传图", value: "image-gradient" },
        { id: "image-grid", label: "样片网格", value: "image-grid" },
    ],
    File: [
        { id: "file-brief", label: "vPaste Intro.pdf", value: "file-brief" },
        { id: "file-assets", label: "多文件宣传素材", value: "file-assets" },
    ],
    TextFile: [
        { id: "textfile-notes", label: "Release-Notes.txt", value: "vPaste Demo Release Notes\n\n- Smooth clipboard history\n- Safe local storage\n- Fast keyboard workflow\n" },
        { id: "textfile-readme", label: "Demo-README.md", value: "# vPaste Demo\n\nThis file contains non-sensitive sample content for screenshots.\n" },
    ],
};

export function sampleValueFromPreset(itemType: SampleItemType, preset: SamplePreset): string {
    return itemType === "Image" || itemType === "File" ? preset.id : preset.value;
}

export function isDirectlyEditableSampleType(itemType: SampleItemType): boolean {
    return itemType !== "Image" && itemType !== "File";
}

function presetItem(
    itemType: Exclude<SampleItemType, "Text">,
    presetId: string,
): Pick<SampleItem, "itemType" | "presetId" | "value"> {
    const preset = SAMPLE_PRESETS[itemType].find(candidate => candidate.id === presetId);
    if (!preset) throw new Error(`Unknown ${itemType} preset: ${presetId}`);
    return { itemType, presetId, value: sampleValueFromPreset(itemType, preset) };
}

const builtInItems = (language: "zh" | "en"): SampleItem[] => {
    const isZh = language === "zh";
    const prefix = `builtin-${language}`;
    return [
        {
            id: `${prefix}-text`,
            name: isZh ? "欢迎文案" : "Welcome copy",
            itemType: "Text",
            value: isZh ? "灵感随手复制，需要时即刻找回。" : "Copy freely. Find everything when you need it.",
            appSource: isZh ? "Microsoft OneNote" : "Figma",
        },
        {
            id: `${prefix}-excel`,
            name: isZh ? "销售概览" : "Campaign performance",
            ...presetItem("Excel", isZh ? "excel-sales" : "excel-campaign"),
            appSource: "Microsoft Excel",
        },
        {
            id: `${prefix}-rich`,
            name: isZh ? "产品说明" : "Product note",
            ...presetItem("RichText", isZh ? "rich-launch" : "rich-release-en"),
            appSource: "Microsoft Word",
        },
        {
            id: `${prefix}-color`,
            name: isZh ? "品牌色" : "Brand color",
            ...presetItem("Color", "color-indigo"),
            appSource: "vPaste",
        },
        {
            id: `${prefix}-link`,
            name: isZh ? "产品链接" : "Product link",
            ...presetItem("Link", "link-vpaste"),
            appSource: "Google Chrome",
        },
        {
            id: `${prefix}-image`,
            name: "",
            ...presetItem("Image", "image-logo"),
            appSource: "File Explorer",
        },
        {
            id: `${prefix}-file`,
            name: isZh ? "产品资料" : "Product brief",
            ...presetItem("File", "file-brief"),
            appSource: "File Explorer",
        },
        {
            id: `${prefix}-text-file`,
            name: isZh ? "发布记录" : "Release notes",
            ...presetItem("TextFile", "textfile-notes"),
            appSource: "Microsoft Word",
        },
        {
            id: `${prefix}-assets`,
            name: isZh ? "宣传素材组合" : "Campaign assets",
            ...presetItem("File", "file-assets"),
            appSource: "File Explorer",
        },
    ];
};

export const BUILT_IN_SAMPLE_GROUPS: SampleGroup[] = [
    { id: "builtin-zh", name: "中文样板", builtIn: true, items: builtInItems("zh") },
    { id: "builtin-en", name: "English Sample", builtIn: true, items: builtInItems("en") },
];

export const MAX_SAMPLE_TIME_OFFSET_MS = 5 * 60_000;

export function sampleTimeOffsetMs(index: number): number {
    return Math.min(Math.max(0, index) * 1_000, MAX_SAMPLE_TIME_OFFSET_MS);
}

function cloneGroup(group: SampleGroup): SampleGroup {
    return { ...group, items: group.items.map(item => ({ ...item })) };
}

function sourceWithBundledIcon(source: string, fallback = ""): string {
    return (APP_SOURCE_OPTIONS as readonly string[]).includes(source) ? source : fallback;
}

function migrateItem(item: SampleItem, fallback?: SampleItem, index = 0): SampleItem {
    const presets = presetOptionsFor(item.itemType);
    const legacyPreset = presets.find(preset => preset.id === item.value);
    const migratesBuiltInGradient = item.itemType === "Image"
        && fallback?.itemType === "Image"
        && fallback.value === "image-logo"
        && item.value === "image-gradient"
        && (!item.presetId || item.presetId === "image-gradient");
    const presetId = migratesBuiltInGradient
        ? "image-logo"
        : item.presetId || legacyPreset?.id || "";
    const migratesBuiltInImageName = fallback?.itemType === "Image"
        && fallback.value === "image-logo"
        && (item.name === "宣传图片" || item.name === "Campaign image");
    return {
        ...item,
        name: migratesBuiltInImageName ? "" : item.name,
        value: migratesBuiltInGradient
            ? "image-logo"
            : legacyPreset ? sampleValueFromPreset(item.itemType, legacyPreset) : item.value,
        presetId,
        appSource: sourceWithBundledIcon(item.appSource, fallback?.appSource ?? ""),
        timeOffsetMs: typeof item.timeOffsetMs === "number"
            && Number.isFinite(item.timeOffsetMs)
            && item.timeOffsetMs >= 0
            && item.timeOffsetMs <= MAX_SAMPLE_TIME_OFFSET_MS
            ? item.timeOffsetMs
            : sampleTimeOffsetMs(index),
    };
}

export function createDefaultTestRoomConfig(): TestRoomConfig {
    return {
        schemaVersion: TEST_ROOM_SCHEMA_VERSION,
        groups: BUILT_IN_SAMPLE_GROUPS.map(cloneGroup),
        deletedBuiltInGroupIds: [],
        deletedBuiltInItemIds: [],
    };
}

export function mergeTestRoomConfig(
    local: TestRoomConfig | null | undefined,
    builtIns = BUILT_IN_SAMPLE_GROUPS,
): TestRoomConfig {
    if (!local || !Array.isArray(local.groups)) {
        return {
            schemaVersion: TEST_ROOM_SCHEMA_VERSION,
            groups: builtIns.map(cloneGroup),
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: [],
        };
    }
    const deleted = new Set(local.deletedBuiltInGroupIds ?? []);
    const deletedItems = new Set(local.deletedBuiltInItemIds ?? []);
    const groups = local.groups.map(group => {
        const builtIn = builtIns.find(candidate => candidate.id === group.id);
        if (!builtIn) return {
            ...cloneGroup(group),
            items: group.items.map((item, index) => migrateItem(item, undefined, index)),
        };
        const existingItemIds = new Set(group.items.map(item => item.id));
        return {
            ...cloneGroup(group),
            items: [
                ...group.items.map((item, index) => {
                    const builtInItem = builtIn.items.find(candidate => candidate.id === item.id);
                    return migrateItem(item, builtInItem, index);
                }),
                ...builtIn.items
                    .filter(item => !existingItemIds.has(item.id) && !deletedItems.has(item.id))
                    .map(item => ({ ...item })),
            ],
        };
    });
    const existingIds = new Set(groups.map(group => group.id));
    for (const builtIn of builtIns) {
        if (!existingIds.has(builtIn.id) && !deleted.has(builtIn.id)) groups.push(cloneGroup(builtIn));
    }
    return {
        schemaVersion: TEST_ROOM_SCHEMA_VERSION,
        groups,
        deletedBuiltInGroupIds: [...deleted],
        deletedBuiltInItemIds: [...deletedItems],
    };
}

export function presetOptionsFor(itemType: SampleItemType): SamplePreset[] {
    return itemType === "Text" ? [] : SAMPLE_PRESETS[itemType];
}
