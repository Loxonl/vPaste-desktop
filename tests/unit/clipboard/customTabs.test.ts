import { beforeEach, describe, expect, it } from "vitest";
import type { ItemTag } from "../../../src/clipboard/Item";
import {
    customTabFilterPayload,
    loadCustomTabs,
    loadTabOrder,
    mergeTagSearchFilter,
    normalizeAppSources,
    normalizeCustomTabs,
    orderedDynamicTabs,
    parseTagSearch,
    recordTagIdFromTab,
    recordTagTabId,
    saveCustomTabs,
    saveTabOrder,
    type CustomTab,
} from "../../../src/clipboard/customTabs";

const customTabs: CustomTab[] = [
    {
        id: "filter-images",
        name: "Images",
        filter: {
            itemType: "Image",
            appSource: "",
            appSources: ["Explorer"],
            favorite: "yes",
            relativeAmount: "7",
            relativeUnit: "day",
        },
    },
    {
        id: "filter-links",
        name: "Links",
        filter: {
            itemType: "Link",
            appSource: "",
            appSources: [],
            favorite: "any",
            relativeAmount: "",
            relativeUnit: "day",
        },
    },
];

describe("custom tab model", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("normalizes stored app sources and removes the retired record-tag field", () => {
        expect(normalizeCustomTabs([{
            id: "legacy",
            name: "Legacy",
            filter: {
                appSource: "  Finder  ",
                appSources: [" Finder ", 7, ""],
                tagName: "retired",
            },
        }])).toEqual([{
            id: "legacy",
            name: "Legacy",
            filter: {
                itemType: "",
                appSource: "  Finder  ",
                appSources: ["Finder"],
                favorite: "any",
                relativeAmount: "",
                relativeUnit: "day",
            },
        }]);
    });

    it("supports the legacy single app source at the normalization boundary", () => {
        expect(normalizeAppSources({ appSource: "  Finder  " })).toEqual(["Finder"]);
    });

    it("rejects malformed persisted values without throwing", () => {
        expect(normalizeCustomTabs("{not-json")).toEqual([]);
        expect(normalizeCustomTabs([{ id: 1, name: "Invalid" }])).toEqual([]);
    });

    it("persists custom tabs and ordering through the existing storage keys", () => {
        saveCustomTabs(customTabs);
        saveTabOrder(["record:4", "filter-images"]);

        expect(loadCustomTabs()).toEqual(customTabs);
        expect(loadTabOrder()).toEqual(["record:4", "filter-images"]);
    });

    it("keeps valid saved order, removes stale duplicates, and appends new tabs", () => {
        const itemTags: ItemTag[] = [
            { id: 4, name: "Work" },
            { id: 7, name: "Later" },
        ];

        expect(orderedDynamicTabs(
            customTabs,
            itemTags,
            ["record:4", "missing", "record:4", "filter-links"],
        ).map(entry => entry.id)).toEqual([
            "record:4",
            "filter-links",
            "filter-images",
            "record:7",
        ]);
    });

    it("builds the unchanged backend filter payload", () => {
        const payload = customTabFilterPayload(customTabs[0]);

        expect(payload.startsWith("__filter:")).toBe(true);
        expect(JSON.parse(payload.slice("__filter:".length))).toEqual({
            mode: "custom",
            item_type: "Image",
            app_sources: ["Explorer"],
            favorite: true,
            relative_amount: 7,
            relative_unit: "day",
        });
    });

    it("extracts quoted tags while preserving non-tag search text", () => {
        expect(parseTagSearch('invoice tag:Work tag:"Needs Review" TAG:work 2026')).toEqual({
            keywords: "invoice 2026",
            tagNames: ["Work", "Needs Review"],
        });
    });

    it("merges tag filters without case-insensitive duplicates", () => {
        const label = '__filter:{"mode":"custom","tag_names":["Work"]}';
        const merged = mergeTagSearchFilter(label, ["work", "Later"]);

        expect(JSON.parse(merged.slice("__filter:".length))).toEqual({
            mode: "custom",
            tag_names: ["Work", "Later"],
        });
    });

    it("round-trips record-tag tab ids and rejects invalid ids", () => {
        expect(recordTagTabId(12)).toBe("record:12");
        expect(recordTagIdFromTab("record:12")).toBe(12);
        expect(recordTagIdFromTab("record:0")).toBeNull();
        expect(recordTagIdFromTab("filter-images")).toBeNull();
    });
});
