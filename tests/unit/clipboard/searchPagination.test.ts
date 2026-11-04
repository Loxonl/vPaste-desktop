import { describe, expect, it, vi } from "vitest";
import { ItemType } from "../../../src/clipboard/Item";
import {
    fetchSearchPage,
    type SearchRequest,
} from "../../../src/clipboard/searchPagination";

function itemPayload(id: number, hash: string) {
    return {
        id,
        hash,
        itemType: ItemType.Text,
        content: `item-${id}`,
        time: id * 10,
        titleColor: null,
        previewContent: "",
        textContent: "",
        label: 0,
        appSource: "",
        appIconPath: "",
        richHtml: "",
        tags: [{ id: 1, name: "Work" }],
    };
}

describe("clipboard search pagination", () => {
    it("converts one complete native page and preserves tags and the scan cursor", async () => {
        const search = vi.fn<(request: SearchRequest) => Promise<string>>()
            .mockResolvedValue(JSON.stringify({
                list: [itemPayload(10, "first"), itemPayload(3, "second")],
                consumed: 120, hasMore: true, nextId: 2, nextTime: 20, resourceEpoch: 7,
            }));
        const result = await fetchSearchPage("needle", "__all", 0, 0, 2, () => true, search);
        expect(result?.items.map(item => item.getHash())).toEqual(["first", "second"]);
        expect(result?.items[0].getTags()).toEqual([{ id: 1, name: "Work" }]);
        expect(result).toMatchObject({ consumed: 120, hasMore: true, nextId: 2, nextTime: 20, resourceEpoch: 7 });
        expect(search).toHaveBeenCalledExactlyOnceWith({ keywords: "needle", lastId: 0, lastTime: 0, limit: 2, label: "__all" });
    });

    it("marks resource completion reads as background so they cannot schedule another batch", async () => {
        const search = vi.fn<(request: SearchRequest) => Promise<string>>()
            .mockResolvedValue(JSON.stringify({ list: [], consumed: 1, hasMore: false, nextId: 0, nextTime: 0 }));
        const result = await fetchSearchPage("", "__all", 0, 0, 36, () => true, search, { background: true });
        expect(result?.items).toEqual([]);
        expect(result?.hasMore).toBe(false);
        expect(search).toHaveBeenCalledExactlyOnceWith({ keywords: "", lastId: 0, lastTime: 0, limit: 36, label: "__all", background: true });
    });

    it("does not start an obsolete search request", async () => {
        const search = vi.fn<(request: SearchRequest) => Promise<string>>();

        const result = await fetchSearchPage(
            "old",
            "__all",
            0,
            0,
            36,
            () => false,
            search,
        );

        expect(result).toBeNull();
        expect(search).not.toHaveBeenCalled();
    });

    it("drops a response that becomes obsolete while IPC is in flight", async () => {
        let current = true;
        const search = vi.fn<(request: SearchRequest) => Promise<string>>()
            .mockImplementation(async () => {
                current = false;
                return JSON.stringify({
                    list: [itemPayload(1, "stale")],
                    consumed: 1,
                    hasMore: false,
                    nextId: 0,
                    nextTime: 0,
                });
            });

        const result = await fetchSearchPage(
            "old",
            "__all",
            0,
            0,
            36,
            () => current,
            search,
        );

        expect(result).toBeNull();
        expect(search).toHaveBeenCalledTimes(1);
    });
});
