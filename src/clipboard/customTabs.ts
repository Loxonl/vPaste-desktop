import type { ItemTag } from "./Item";

export type FavoriteFilter = "any" | "yes" | "no";
export type DateUnit = "minute" | "hour" | "day" | "week" | "month";

export type CustomTabFilter = {
    itemType: string;
    appSource: string;
    appSources: string[];
    favorite: FavoriteFilter;
    relativeAmount: string;
    relativeUnit: DateUnit;
};

export type CustomTab = {
    id: string;
    name: string;
    filter: CustomTabFilter;
};

export type DynamicTabEntry = {
    kind: "filter";
    id: string;
    tab: CustomTab;
} | {
    kind: "record";
    id: string;
    tag: ItemTag;
};

const CUSTOM_TABS_STORAGE_KEY = "vpaste.customTabs.v1";
const TAB_ORDER_STORAGE_KEY = "vpaste.tabOrder.v1";
const RECORD_TAG_TAB_PREFIX = "record:";

export const DEFAULT_CUSTOM_FILTER: CustomTabFilter = {
    itemType: "",
    appSource: "",
    appSources: [],
    favorite: "any",
    relativeAmount: "",
    relativeUnit: "day",
};

export function normalizeAppSources(
    filter: Partial<CustomTabFilter> & { appSource?: unknown; appSources?: unknown },
): string[] {
    if (Array.isArray(filter.appSources)) {
        return filter.appSources
            .filter(source => typeof source === "string" && source.trim())
            .map(source => source.trim());
    }
    return typeof filter.appSource === "string" && filter.appSource.trim()
        ? [filter.appSource.trim()]
        : [];
}

export function normalizeCustomTabs(raw: unknown): CustomTab[] {
    try {
        if (!raw) return [];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed)
            ? parsed
                .filter(tab => typeof tab?.id === "string" && typeof tab?.name === "string")
                .map(tab => {
                    const filter = { ...DEFAULT_CUSTOM_FILTER, ...(tab.filter || {}) };
                    const { tagName: _legacyRecordTagName, ...filterWithoutRecordTag } = filter as typeof DEFAULT_CUSTOM_FILTER & { tagName?: unknown };
                    return {
                        id: tab.id,
                        name: tab.name,
                        filter: {
                            ...filterWithoutRecordTag,
                            appSources: normalizeAppSources(filter),
                        },
                    };
                })
            : [];
    } catch {
        return [];
    }
}

export function loadCustomTabs(): CustomTab[] {
    return normalizeCustomTabs(localStorage.getItem(CUSTOM_TABS_STORAGE_KEY));
}

export function saveCustomTabs(tabs: CustomTab[]) {
    localStorage.setItem(CUSTOM_TABS_STORAGE_KEY, JSON.stringify(tabs));
}

function normalizeStringArray(raw: unknown): string[] {
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed)
            ? parsed
                .filter(value => typeof value === "string" && value.trim())
                .map(value => value.trim())
            : [];
    } catch {
        return [];
    }
}

export function loadTabOrder(): string[] {
    return normalizeStringArray(localStorage.getItem(TAB_ORDER_STORAGE_KEY));
}

export function saveTabOrder(order: string[]) {
    localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
}

export function customTabFilterPayload(tab: CustomTab): string {
    const filter = tab.filter;
    const payload: Record<string, string | number | boolean | string[]> = {
        mode: "custom",
    };
    if (filter.itemType) payload.item_type = filter.itemType;
    const appSources = normalizeAppSources(filter);
    if (appSources.length > 0) payload.app_sources = appSources;
    if (filter.favorite === "yes") payload.favorite = true;
    if (filter.favorite === "no") payload.favorite = false;
    const amount = Number(filter.relativeAmount);
    if (Number.isFinite(amount) && amount > 0) {
        payload.relative_amount = amount;
        payload.relative_unit = filter.relativeUnit;
    }
    return `__filter:${JSON.stringify(payload)}`;
}

export function recordTagTabId(id: number): string {
    return `${RECORD_TAG_TAB_PREFIX}${id}`;
}

export function recordTagIdFromTab(tabId: string): number | null {
    if (!tabId.startsWith(RECORD_TAG_TAB_PREFIX)) return null;
    const id = Number(tabId.slice(RECORD_TAG_TAB_PREFIX.length));
    return Number.isInteger(id) && id > 0 ? id : null;
}

export function orderedDynamicTabs(
    customTabs: CustomTab[],
    itemTags: ItemTag[],
    order: string[],
): DynamicTabEntry[] {
    const defaultEntries: DynamicTabEntry[] = [
        ...customTabs.map(tab => ({ kind: "filter" as const, id: tab.id, tab })),
        ...itemTags.map(tag => ({
            kind: "record" as const,
            id: recordTagTabId(tag.id),
            tag,
        })),
    ];
    const entryMap = new Map(defaultEntries.map(entry => [entry.id, entry]));
    const seen = new Set<string>();
    const ids = [
        ...order.filter(id => {
            if (seen.has(id) || !entryMap.has(id)) return false;
            seen.add(id);
            return true;
        }),
        ...defaultEntries
            .map(entry => entry.id)
            .filter(id => !seen.has(id)),
    ];
    return ids
        .map(id => entryMap.get(id))
        .filter((entry): entry is DynamicTabEntry => Boolean(entry));
}

export function arraysEqual(left: string[], right: string[]): boolean {
    return left.length === right.length
        && left.every((value, index) => value === right[index]);
}

export function parseTagSearch(value: string): {
    keywords: string;
    tagNames: string[];
} {
    const tagNames: string[] = [];
    const keywords = value
        .replace(/(?:^|\s)tag:("[^"]+"|\S+)/gi, (_match, raw: string) => {
            const name = raw.startsWith('"') && raw.endsWith('"')
                ? raw.slice(1, -1)
                : raw;
            const trimmed = name.trim();
            if (
                trimmed
                && !tagNames.some(tag => tag.toLowerCase() === trimmed.toLowerCase())
            ) {
                tagNames.push(trimmed);
            }
            return " ";
        })
        .replace(/\s+/g, " ")
        .trim();
    return { keywords, tagNames };
}

export function mergeTagSearchFilter(label: string, tagNames: string[]): string {
    if (tagNames.length === 0) return label;
    const payload: Record<string, unknown> = label.startsWith("__filter:")
        ? JSON.parse(label.slice("__filter:".length))
        : label === "__favorite"
            ? { mode: "favorite", favorite: true }
            : { mode: "all" };
    const existing = Array.isArray(payload.tag_names)
        ? payload.tag_names.filter(name => typeof name === "string")
        : [];
    payload.tag_names = [...existing, ...tagNames].filter((name, index, list) =>
        list.findIndex(candidate =>
            String(candidate).toLowerCase() === String(name).toLowerCase()
        ) === index
    );
    return `__filter:${JSON.stringify(payload)}`;
}
