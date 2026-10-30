import type { ItemTag, ItemType } from "./Item";
import type { SearchItemPayload } from "./searchPagination";
import type { RichRenderPayload } from "./historyResourceTypes";

export type HistoryQuery = { keywords: string; label: string };
export type ViewToken = { viewId: string; revision: number };
export type HistoryRef = {
    id: number; hash: string; itemType: ItemType; time: number; label: number; tags: ItemTag[];
    appSource: string; appIconPath: string; titleColor: string;
};
export type HistoryViewPage = {
    token: ViewToken; pageIndex: number; startIndex: number; items: HistoryRef[];
    knownCount: number; hasMore: boolean; resourceEpoch: number;
};
export type HistoryCardPayload = { item: SearchItemPayload; richRender?: RichRenderPayload | null; mimeBytes?: number };
export type CardResponse = { token: ViewToken; resourceEpoch: number; cards: HistoryCardPayload[] };
