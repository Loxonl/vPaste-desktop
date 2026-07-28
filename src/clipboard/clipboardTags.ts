import { Item, type ItemTag } from "./Item";

export const PENDING_ITEM_TAGS_CHANGED_KEY =
    "vpaste.pendingItemTagsChangedPayload";

export type ItemTagsChangedPayload = {
    activeId?: string;
    tag?: ItemTag;
};

export function parseItemTagsChangedPayload(
    raw: string,
): ItemTagsChangedPayload {
    return JSON.parse(raw) as ItemTagsChangedPayload;
}

export function assignItemTag(
    tags: ItemTag[],
    tag: ItemTag,
): ItemTag[] {
    return [...tags.filter(candidate => candidate.id !== tag.id), tag];
}

export function removeItemTag(
    tags: ItemTag[],
    tagId: number,
): ItemTag[] {
    return tags.filter(tag => tag.id !== tagId);
}

export function upsertItemTag(
    tags: ItemTag[],
    updatedTag: ItemTag,
): ItemTag[] {
    return tags.some(tag => tag.id === updatedTag.id)
        ? tags.map(tag => tag.id === updatedTag.id ? updatedTag : tag)
        : [...tags, updatedTag];
}

export function updateItemTagsForPage(
    items: Item[],
    targetHash: string,
    nextTags: ItemTag[],
    activeRecordTagId: number | null,
): Item[] {
    let nextItems = items.map(item =>
        item.getHash() === targetHash ? item.withTags(nextTags) : item
    );
    if (
        activeRecordTagId !== null
        && !nextTags.some(tag => tag.id === activeRecordTagId)
    ) {
        nextItems = nextItems.filter(item => item.getHash() !== targetHash);
    }
    return nextItems;
}

export function removeRecordTagFromItems(
    items: Item[],
    tagId: number,
): Item[] {
    return items.map(item => {
        const nextTags = item.getTags().filter(tag => tag.id !== tagId);
        return nextTags.length === item.getTags().length
            ? item
            : item.withTags(nextTags);
    });
}

export function updateRecordTagInItems(
    items: Item[],
    updatedTag: ItemTag,
): Item[] {
    return items.map(item => {
        const nextTags = item.getTags().map(tag =>
            tag.id === updatedTag.id ? updatedTag : tag
        );
        return nextTags.some((tag, index) => tag !== item.getTags()[index])
            ? item.withTags(nextTags)
            : item;
    });
}
