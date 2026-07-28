import { invoke } from "@tauri-apps/api/core";
import { Item, type ItemTag, type ItemType } from "./Item";

type SearchItemPayload = {
    id: number;
    hash: string;
    itemType: ItemType;
    content: string;
    time: number;
    titleColor?: string;
    previewContent: string;
    textContent: string;
    label: number;
    appSource: string;
    appIconPath: string;
    richHtml: string;
    tags?: ItemTag[];
};

type SearchPagePayload = {
    list: SearchItemPayload[];
    consumed: number;
    hasMore: boolean;
    nextId: number;
    nextTime: number;
};

export type SearchPageResult = {
    items: Item[];
    consumed: number;
    hasMore: boolean;
};

export type SearchRequest = {
    keywords: string;
    lastId: number;
    lastTime: number;
    limit: number;
    label: string;
};

export type SearchInvoker = (request: SearchRequest) => Promise<string>;

function itemFromPayload(item: SearchItemPayload): Item {
    return new Item(
        item.id,
        item.hash,
        item.itemType,
        item.content,
        item.time,
        item.titleColor,
        item.previewContent,
        item.textContent,
        item.label,
        item.appSource,
        item.appIconPath,
        item.richHtml,
        Array.isArray(item.tags) ? item.tags : [],
    );
}

const invokeSearch: SearchInvoker = request => invoke<string>("search", request);

export async function fetchSearchPage(
    keywords: string,
    label: string,
    lastId: number,
    lastTime: number,
    limit: number,
    isCurrent: () => boolean,
    search: SearchInvoker = invokeSearch,
): Promise<SearchPageResult | null> {
    const items: Item[] = [];
    let consumed = 0;
    let hasMore = true;
    let cursorId = lastId;
    let cursorTime = lastTime;

    while (items.length < limit && hasMore) {
        if (!isCurrent()) return null;
        const response = await search({
            keywords,
            lastId: cursorId,
            lastTime: cursorTime,
            limit: limit - items.length,
            label,
        });
        if (!isCurrent()) return null;

        const page = JSON.parse(response) as SearchPagePayload;
        items.push(...page.list.map(itemFromPayload));
        consumed += page.consumed;
        hasMore = page.hasMore;
        if (!hasMore || items.length >= limit) break;
        if (
            (page.nextId === 0 && page.nextTime === 0)
            || (page.nextId === cursorId && page.nextTime === cursorTime)
        ) {
            hasMore = false;
            break;
        }
        cursorId = page.nextId;
        cursorTime = page.nextTime;
    }

    return { items, consumed, hasMore };
}
