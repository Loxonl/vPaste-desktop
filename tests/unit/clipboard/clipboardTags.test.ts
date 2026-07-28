import { describe, expect, it } from "vitest";
import {
    Item,
    ItemType,
    type ItemTag,
} from "../../../src/clipboard/Item";
import {
    PENDING_ITEM_TAGS_CHANGED_KEY,
    assignItemTag,
    parseItemTagsChangedPayload,
    removeItemTag,
    removeRecordTagFromItems,
    updateItemTagsForPage,
    updateRecordTagInItems,
    upsertItemTag,
} from "../../../src/clipboard/clipboardTags";

const work: ItemTag = { id: 1, name: "Work" };
const renamedWork: ItemTag = { id: 1, name: "Projects" };
const personal: ItemTag = { id: 2, name: "Personal" };

function item(hash: string, tags: ItemTag[]) {
    return new Item(
        1,
        hash,
        ItemType.Text,
        hash,
        100,
        undefined,
        "",
        "",
        0,
        "",
        "",
        "",
        tags,
    );
}

describe("clipboard tag model", () => {
    it("owns the shared cross-window payload key and parser", () => {
        expect(PENDING_ITEM_TAGS_CHANGED_KEY)
            .toBe("vpaste.pendingItemTagsChangedPayload");
        expect(parseItemTagsChangedPayload(JSON.stringify({
            activeId: "record:1",
            tag: work,
        }))).toEqual({
            activeId: "record:1",
            tag: work,
        });
    });

    it("assigns and removes one tag without duplicating its id", () => {
        expect(assignItemTag([work, personal], renamedWork))
            .toEqual([personal, renamedWork]);
        expect(removeItemTag([work, personal], work.id))
            .toEqual([personal]);
    });

    it("updates the target card and removes it when it no longer matches the active tag", () => {
        const target = item("target", [work]);
        const other = item("other", [personal]);

        const updated = updateItemTagsForPage(
            [target, other],
            "target",
            [personal],
            null,
        );
        expect(updated[0].getTags()).toEqual([personal]);
        expect(updated[1]).toBe(other);

        expect(updateItemTagsForPage(
            [target, other],
            "target",
            [personal],
            work.id,
        )).toEqual([other]);
    });

    it("renames and removes record tags across loaded cards", () => {
        const tagged = item("tagged", [work, personal]);
        const untouched = item("untouched", [personal]);

        const renamed = updateRecordTagInItems(
            [tagged, untouched],
            renamedWork,
        );
        expect(renamed[0].getTags()).toEqual([renamedWork, personal]);
        expect(renamed[1]).toBe(untouched);

        const removed = removeRecordTagFromItems(renamed, work.id);
        expect(removed[0].getTags()).toEqual([personal]);
        expect(removed[1]).toBe(untouched);
    });

    it("upserts and removes tags in the available tag list", () => {
        expect(upsertItemTag([work], personal)).toEqual([work, personal]);
        expect(upsertItemTag([work, personal], renamedWork))
            .toEqual([renamedWork, personal]);
        expect(removeItemTag([work, personal], work.id))
            .toEqual([personal]);
    });
});
