import { invoke } from "@tauri-apps/api/core";
import { Item, type ItemTag, type ItemType } from "./Item";

export type SearchItemPayload = {
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
    resourceEpoch?: number;
};

export type SearchPageResult = {
    items: Item[];
    consumed: number;
    hasMore: boolean;
    nextId: number;
    nextTime: number;
    resourceEpoch?: number;
};

export type SearchRequest = {
    keywords: string;
    lastId: number;
    lastTime: number;
    limit: number;
    label: string;
    background?: boolean;
};

export type SearchInvoker = (request: SearchRequest) => Promise<string>;

export function itemFromPayload(item: SearchItemPayload): Item {
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
    options: { background?: boolean } = {},
): Promise<SearchPageResult | null> {
    if (!isCurrent()) return null;
    const response = await search({
        keywords, lastId, lastTime, limit, label,
        ...(options.background ? { background: true } : {}),
    });
    if (!isCurrent()) return null;
    const page = JSON.parse(response) as SearchPagePayload;
    return {
        items: page.list.map(itemFromPayload),
        consumed: page.consumed,
        hasMore: page.hasMore,
        nextId: page.nextId,
        nextTime: page.nextTime,
        resourceEpoch: page.resourceEpoch,
    };
}
