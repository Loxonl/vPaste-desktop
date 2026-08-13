import { describe, expect, it } from "vitest";
import { ItemType } from "../../../src/clipboard/Item";
import { emptyPasteQueueState, parsePasteQueueState } from "../../../src/clipboard/pasteQueueState";

describe("paste queue state", () => {
    it("materializes serialized history items", () => {
        const state = parsePasteQueueState({
            active: true,
            busy: false,
            capacity: 100,
            error: null,
            undoHash: null,
            undoExpiresAt: null,
            revision: 4,
            items: [{
                id: 1,
                hash: "hash-a",
                itemType: ItemType.Text,
                content: "first",
                time: 10,
                previewContent: "first",
                textContent: "",
                label: 0,
                appSource: "Notes",
                appIconPath: "",
                richHtml: "",
                tags: [],
            }],
        });

        expect(state.active).toBe(true);
        expect(state.items[0].getHash()).toBe("hash-a");
        expect(state.items[0].getContent()).toBe("first");
    });

    it("starts inactive with the fixed capacity", () => {
        expect(emptyPasteQueueState()).toMatchObject({
            active: false,
            busy: false,
            capacity: 100,
            items: [],
        });
    });
});
