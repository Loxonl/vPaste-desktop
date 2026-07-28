import { describe, expect, it } from "vitest";
import { ItemType } from "../../../src/clipboard/Item";
import {
    TUTORIAL_FILTER_DEFINITIONS,
    buildTutorialFilterTabs,
    buildTutorialPermissions,
    tutorialFilterTabId,
    updateTutorialFilterTabs,
} from "../../../src/clipboard/clipboardTutorial";

const t = (key: string) => `translated:${key}`;

describe("clipboard tutorial model", () => {
    it("keeps the persisted tutorial filter identifiers stable", () => {
        expect(TUTORIAL_FILTER_DEFINITIONS.map(filter => [
            filter.id,
            tutorialFilterTabId(filter.id),
        ])).toEqual([
            ["text", "tutorial-filter-text"],
            ["image", "tutorial-filter-image"],
            ["link", "tutorial-filter-link"],
            ["color", "tutorial-filter-color"],
            ["file", "tutorial-filter-file"],
        ]);
    });

    it("adds a translated tutorial filter once with the existing filter shape", () => {
        const enabled = updateTutorialFilterTabs([], "image", true, t);

        expect(enabled).toEqual([{
            id: "tutorial-filter-image",
            name: "🖼️ translated:type.image",
            filter: {
                appSource: "",
                appSources: [],
                favorite: "any",
                itemType: ItemType.Image,
                relativeAmount: "",
                relativeUnit: "day",
            },
        }]);
        expect(updateTutorialFilterTabs(enabled, "image", true, t)).toBe(enabled);
    });

    it("removes only the selected tutorial filter", () => {
        const enabled = TUTORIAL_FILTER_DEFINITIONS
            .slice(0, 2)
            .reduce(
                (tabs, filter) =>
                    updateTutorialFilterTabs(tabs, filter.id, true, t),
                [],
            );

        expect(updateTutorialFilterTabs(enabled, "text", false, t))
            .toEqual([expect.objectContaining({ id: "tutorial-filter-image" })]);
    });

    it("builds filter and permission presentation from current state", () => {
        const customTabs = updateTutorialFilterTabs([], "link", true, t);

        expect(buildTutorialFilterTabs(customTabs, t)).toEqual([
            { id: "text", name: "📝 translated:type.text", enabled: false },
            { id: "image", name: "🖼️ translated:type.image", enabled: false },
            { id: "link", name: "🔗 translated:type.link", enabled: true },
            { id: "color", name: "🎨 translated:type.color", enabled: false },
            { id: "file", name: "📁 translated:type.file", enabled: false },
        ]);
        expect(buildTutorialPermissions({
            background: { done: true, needs_settings: false },
            paste: { done: false, needs_settings: true },
        }, t)).toEqual([
            {
                id: "background",
                title: "translated:tutorial.permission.background",
                description: "translated:tutorial.permission.background.desc",
                done: true,
                actionLabel: "translated:tutorial.permission.enable",
            },
            {
                id: "paste",
                title: "translated:tutorial.permission.paste",
                description: "translated:tutorial.permission.paste.desc",
                done: false,
                actionLabel: "translated:tutorial.permission.openSettings",
            },
        ]);
    });
});
