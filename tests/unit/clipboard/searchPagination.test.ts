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
    it("follows scan cursors until a logical page is filled", async () => {
        const search = vi.fn<(request: SearchRequest) => Promise<string>>()
            .mockResolvedValueOnce(JSON.stringify({
                list: [itemPayload(10, "first")],
                consumed: 5000,
                hasMore: true,
                nextId: 7,
                nextTime: 70,
            }))
            .mockResolvedValueOnce(JSON.stringify({
                list: [itemPayload(3, "second")],
                consumed: 120,
                hasMore: false,
                nextId: 0,
                nextTime: 0,
            }));

        const result = await fetchSearchPage(
            "needle",
            "__all",
            0,
            0,
            2,
            () => true,
            search,
        );

        expect(result?.items.map(item => item.getHash())).toEqual(["first", "second"]);
        expect(result?.items[0].getTags()).toEqual([{ id: 1, name: "Work" }]);
        expect(result).toMatchObject({ consumed: 5120, hasMore: false });
        expect(search).toHaveBeenNthCalledWith(1, {
            keywords: "needle",
            lastId: 0,
            lastTime: 0,
            limit: 2,
            label: "__all",
        });
        expect(search).toHaveBeenNthCalledWith(2, {
            keywords: "needle",
            lastId: 7,
            lastTime: 70,
            limit: 1,
            label: "__all",
        });
    });

    it("stops when the backend cursor makes no progress", async () => {
        const search = vi.fn<(request: SearchRequest) => Promise<string>>()
            .mockResolvedValue(JSON.stringify({
                list: [],
                consumed: 5000,
                hasMore: true,
                nextId: 9,
                nextTime: 90,
            }));

        const result = await fetchSearchPage(
            "needle",
            "__all",
            9,
            90,
            36,
            () => true,
            search,
        );

        expect(result).toEqual({ items: [], consumed: 5000, hasMore: false });
        expect(search).toHaveBeenCalledTimes(1);
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
