import { Item } from "./Item";
import { itemFromPayload, type SearchItemPayload } from "./searchPagination";

export type PasteQueueError = {
    hash?: string | null;
    message: string;
};

export type PasteQueueState = {
    active: boolean;
    busy: boolean;
    capacity: number;
    items: Item[];
    error: PasteQueueError | null;
    undoHash: string | null;
    undoExpiresAt: number | null;
    revision: number;
};

type PasteQueueStatePayload = Omit<PasteQueueState, "items"> & {
    items: SearchItemPayload[];
};

export function parsePasteQueueState(payload: PasteQueueStatePayload): PasteQueueState {
    return {
        ...payload,
        items: Array.isArray(payload.items) ? payload.items.map(itemFromPayload) : [],
    };
}

export function emptyPasteQueueState(): PasteQueueState {
    return {
        active: false,
        busy: false,
        capacity: 100,
        items: [],
        error: null,
        undoHash: null,
        undoExpiresAt: null,
        revision: 0,
    };
}
