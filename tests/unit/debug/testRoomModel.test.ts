import { describe, expect, it } from "vitest";
import {
    APP_SOURCE_OPTIONS,
    BUILT_IN_SAMPLE_GROUPS,
    SAMPLE_PRESETS,
    sampleTimeOffsetMs,
    mergeTestRoomConfig,
    type TestRoomConfig,
} from "../../../src/debug/testRoomModel";

describe("test room sample model", () => {
    it("only offers app sources backed by bundled icons", () => {
        expect(APP_SOURCE_OPTIONS).toEqual([
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
        ]);
        expect(APP_SOURCE_OPTIONS).not.toContain("Notion");
        expect(APP_SOURCE_OPTIONS).not.toContain("Cursor");
    });

    it("ships sanitized Excel table presets in both built-in sample groups", () => {
        expect(SAMPLE_PRESETS.Excel.map(preset => preset.id)).toEqual([
            "excel-sales",
            "excel-projects",
            "excel-budget",
            "excel-inventory",
            "excel-campaign",
        ]);
        expect(BUILT_IN_SAMPLE_GROUPS.every(group => group.items.some(item => (
            item.itemType === "Excel" && item.appSource === "Microsoft Excel"
        )))).toBe(true);
        expect(BUILT_IN_SAMPLE_GROUPS.every(group => group.items.some(item => (
            item.itemType === "Excel"
            && item.presetId?.startsWith("excel-")
            && item.value.includes("\t")
        )))).toBe(true);
    });

    it("uses repository-backed product logo and vPaste intro PDF defaults", () => {
        expect(SAMPLE_PRESETS.Image[0]).toMatchObject({
            id: "image-logo",
            label: "vPaste 产品 Logo",
        });
        expect(SAMPLE_PRESETS.File[0]).toMatchObject({
            id: "file-brief",
            label: "vPaste Intro.pdf",
        });
        expect(BUILT_IN_SAMPLE_GROUPS.every(group => group.items.some(item => (
            item.itemType === "Image" && item.value === "image-logo" && item.name === ""
        )))).toBe(true);
    });

    it("clears former built-in image names while preserving custom names", () => {
        const local: TestRoomConfig = {
            schemaVersion: 1,
            groups: BUILT_IN_SAMPLE_GROUPS.map((group, groupIndex) => ({
                ...group,
                items: group.items.map(item => item.itemType === "Image" ? {
                    ...item,
                    name: groupIndex === 0 ? "宣传图片" : "Campaign image",
                } : item),
            })),
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: [],
        };
        const custom: TestRoomConfig = {
            ...local,
            groups: [{
                ...local.groups[0],
                items: local.groups[0].items.map(item => item.itemType === "Image"
                    ? { ...item, name: "我的 Logo" }
                    : item),
            }],
        };

        expect(mergeTestRoomConfig(local).groups.every(group => (
            group.items.find(item => item.itemType === "Image")?.name === ""
        ))).toBe(true);
        expect(mergeTestRoomConfig(custom).groups[0].items.find(item => (
            item.itemType === "Image"
        ))?.name).toBe("我的 Logo");
    });

    it("keeps default sample times contiguous and within the latest five minutes", () => {
        expect(Array.from({ length: 14 }, (_, index) => sampleTimeOffsetMs(index))).toEqual([
            0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000,
            7_000, 8_000, 9_000, 10_000, 11_000, 12_000, 13_000,
        ]);
        expect(sampleTimeOffsetMs(300)).toBe(300_000);
        expect(sampleTimeOffsetMs(301)).toBe(300_000);
    });

    it("ships stable Chinese and English built-in groups", () => {
        expect(BUILT_IN_SAMPLE_GROUPS.map(group => [group.id, group.name])).toEqual([
            ["builtin-zh", "中文样板"],
            ["builtin-en", "English Sample"],
        ]);
        expect(BUILT_IN_SAMPLE_GROUPS.every(group => group.items.length > 0)).toBe(true);
    });

    it("keeps local edits and appends newly introduced built-in groups", () => {
        const local: TestRoomConfig = {
            schemaVersion: 1,
            groups: [{
                ...BUILT_IN_SAMPLE_GROUPS[0],
                name: "我的中文样板",
                items: BUILT_IN_SAMPLE_GROUPS[0].items.slice(0, 2),
            }],
            deletedBuiltInGroupIds: ["builtin-en"],
            deletedBuiltInItemIds: [],
        };
        const nextBuiltIns = [
            ...BUILT_IN_SAMPLE_GROUPS,
            { ...BUILT_IN_SAMPLE_GROUPS[1], id: "builtin-new", name: "New Built-in" },
        ];

        const merged = mergeTestRoomConfig(local, nextBuiltIns);

        expect(merged.groups.find(group => group.id === "builtin-zh")?.name).toBe("我的中文样板");
        expect(merged.groups.some(group => group.id === "builtin-en")).toBe(false);
        expect(merged.groups.some(group => group.id === "builtin-new")).toBe(true);
    });

    it("appends new built-in items without restoring locally deleted ones", () => {
        const original = BUILT_IN_SAMPLE_GROUPS[0];
        const deletedItemId = original.items[1].id;
        const local: TestRoomConfig = {
            schemaVersion: 1,
            groups: [{ ...original, items: [original.items[0]] }],
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: [deletedItemId],
        };
        const newItem = { ...original.items[0], id: "builtin-zh-future", name: "未来新增项" };
        const nextBuiltIns = [{ ...original, items: [...original.items, newItem] }];

        const merged = mergeTestRoomConfig(local, nextBuiltIns);

        expect(merged.groups[0].items.some(item => item.id === deletedItemId)).toBe(false);
        expect(merged.groups[0].items.some(item => item.id === newItem.id)).toBe(true);
    });

    it("migrates removed app sources to bundled alternatives", () => {
        const original = BUILT_IN_SAMPLE_GROUPS[0];
        const local: TestRoomConfig = {
            schemaVersion: 1,
            groups: [{
                ...original,
                items: original.items.map((item, index) => ({
                    ...item,
                    appSource: index === 0 ? "Notion" : item.appSource,
                })),
            }, {
                id: "custom",
                name: "Custom",
                builtIn: false,
                items: [{
                    id: "custom-item",
                    name: "Legacy",
                    itemType: "Text",
                    value: "safe",
                    appSource: "Cursor",
                }],
            }],
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: [],
        };

        const merged = mergeTestRoomConfig(local);

        expect(merged.groups[0].items[0].appSource).toBe("Microsoft OneNote");
        expect(merged.groups[1].items[0].appSource).toBe("");
    });

    it("migrates preset ids into directly editable content without losing custom values", () => {
        const local: TestRoomConfig = {
            schemaVersion: 1,
            groups: [{
                id: "custom",
                name: "Custom",
                builtIn: false,
                items: [{
                    id: "rich-preset",
                    name: "Rich preset",
                    itemType: "RichText",
                    value: "rich-launch",
                    presetId: "",
                    appSource: "Microsoft Word",
                }, {
                    id: "custom-link",
                    name: "Custom link",
                    itemType: "Link",
                    value: "https://example.com/custom",
                    appSource: "Google Chrome",
                }],
            }],
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: [],
        };

        const merged = mergeTestRoomConfig(local);

        expect(merged.groups[0].items[0]).toMatchObject({
            presetId: "rich-launch",
            value: "vPaste 让常用内容触手可及\n更快整理，更安心粘贴。",
        });
        expect(merged.groups[0].items[1]).toMatchObject({
            presetId: "",
            value: "https://example.com/custom",
        });
    });

    it("migrates the former built-in gradient image to the product logo", () => {
        const original = BUILT_IN_SAMPLE_GROUPS[0];
        const local: TestRoomConfig = {
            schemaVersion: 1,
            groups: [{
                ...original,
                items: original.items.map(item => item.itemType === "Image" ? {
                    ...item,
                    value: "image-gradient",
                    presetId: "image-gradient",
                } : item),
            }],
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: [],
        };

        const migrated = mergeTestRoomConfig(local);
        const image = migrated.groups[0].items.find(item => item.itemType === "Image");

        expect(image).toMatchObject({ value: "image-logo", presetId: "image-logo" });
    });

    it("migrates an older schema while preserving local content", () => {
        const local: TestRoomConfig = {
            schemaVersion: 0,
            groups: [{ ...BUILT_IN_SAMPLE_GROUPS[0], name: "长期保留的样板" }],
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: [],
        };

        const migrated = mergeTestRoomConfig(local);

        expect(migrated.schemaVersion).toBe(1);
        expect(migrated.groups.find(group => group.id === "builtin-zh")?.name).toBe("长期保留的样板");
    });

    it("preserves valid manual time offsets and fills missing or invalid values by order", () => {
        const original = BUILT_IN_SAMPLE_GROUPS[0];
        const local: TestRoomConfig = {
            schemaVersion: 1,
            groups: [{
                ...original,
                items: original.items.slice(0, 3).map((item, index) => ({
                    ...item,
                    timeOffsetMs: index === 0 ? 90_000 : index === 1 ? undefined : 301_000,
                })),
            }],
            deletedBuiltInGroupIds: [],
            deletedBuiltInItemIds: original.items.slice(3).map(item => item.id),
        };

        const migrated = mergeTestRoomConfig(local);

        expect(migrated.groups[0].items.map(item => item.timeOffsetMs)).toEqual([
            90_000,
            1_000,
            2_000,
        ]);
    });
});
