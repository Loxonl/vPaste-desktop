import { beforeEach, describe, expect, it } from "vitest";
import { ItemType } from "../../../src/clipboard/Item";
import {
    TUTORIAL_FILTER_DEFINITIONS,
    buildTutorialFilterTabs,
    buildTutorialPermissions,
    initializeTutorialFilterTabs,
    tutorialFilterTabId,
    updateTutorialFilterTabs,
} from "../../../src/clipboard/clipboardTutorial";

const t = (key: string) => `translated:${key}`;

describe("clipboard tutorial model", () => {
    beforeEach(() => localStorage.clear());

    it("keeps the persisted tutorial filter identifiers stable", () => {
        expect(TUTORIAL_FILTER_DEFINITIONS.map(filter => [
            filter.id,
            tutorialFilterTabId(filter.id),
        ])).toEqual([
            ["text", "tutorial-filter-text"],
            ["image", "tutorial-filter-image"],
            ["link", "tutorial-filter-link"],
            ["file", "tutorial-filter-file"],
            ["color", "tutorial-filter-color"],
        ]);
    });

    it("initializes the four common first-run filters in display order", () => {
        const tabs = initializeTutorialFilterTabs([], true, t);

        expect(tabs.map(tab => [tab.id, tab.filter.itemType])).toEqual([
            ["tutorial-filter-text", ItemType.Text],
            ["tutorial-filter-image", ItemType.Image],
            ["tutorial-filter-link", ItemType.Link],
            ["tutorial-filter-file", ItemType.File],
        ]);
        expect(buildTutorialFilterTabs(tabs, t).map(tab => tab.enabled))
            .toEqual([true, true, true, true, false]);
    });

    it("does not recreate filters after the user turns all of them off", () => {
        initializeTutorialFilterTabs([], true, t);
        const empty: ReturnType<typeof initializeTutorialFilterTabs> = [];

        expect(initializeTutorialFilterTabs(empty, true, t)).toBe(empty);
    });

    it("preserves an existing user's empty selection", () => {
        const empty: ReturnType<typeof initializeTutorialFilterTabs> = [];

        expect(initializeTutorialFilterTabs(empty, false, t)).toBe(empty);
    });

    it("preserves existing filters and does not reseed them after deletion", () => {
        const existing = updateTutorialFilterTabs([], "color", true, t);
        existing[0].name = "My colors";

        expect(initializeTutorialFilterTabs(existing, true, t)).toBe(existing);
        expect(initializeTutorialFilterTabs([], true, t)).toEqual([]);
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
            { id: "file", name: "📁 translated:type.file", enabled: false },
            { id: "color", name: "🎨 translated:type.color", enabled: false },
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
