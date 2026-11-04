import { describe, expect, it } from "vitest";
import { clipboardViewport, clipboardSpacerWidth, clipboardIndexScrollLeft, clipboardResidentIndices, InteractionLeases } from "../../../src/clipboard/clipboardViewport";

describe("clipboard viewport geometry", () => {
    it("bounds mounted cards independently of 500 loaded records", () => {
        for (const scrollLeft of [0, 2000, 50000, 116200]) {
            const range = clipboardViewport({ count: 500, scrollLeft, viewportWidth: 1944, gridLeft: 24, cardWidth: 220, gap: 16 });
            expect(range.end - range.start).toBeLessThanOrEqual(range.visibleEnd - range.visibleStart + 4);
            expect(range.start).toBeGreaterThanOrEqual(0);
            expect(range.end).toBeLessThanOrEqual(500);
        }
    });

    it("counts visible deletion exits and a drag source before admitting replacements", () => {
        const range = { start: 90, end: 104, visibleStart: 92, visibleEnd: 102 };
        expect(clipboardResidentIndices(range, [0], 5, 10)).toEqual([
            0, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101,
        ]);
        expect(clipboardResidentIndices(range, [0], 0, 10)).toEqual([
            0, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103,
        ]);
    });

    it("keeps exactly the same flex width when a run becomes a spacer", () => {
        expect(clipboardSpacerWidth(100, 220, 16) + 16 + clipboardSpacerWidth(400, 220, 16))
            .toBe(clipboardSpacerWidth(500, 220, 16));
        expect(clipboardSpacerWidth(0, 220, 16)).toBe(0);
    });

    it("navigates to logical offscreen indices with the existing 24px edge inset", () => {
        expect(clipboardIndexScrollLeft(400, { scrollLeft: 0, viewportWidth: 1944, gridLeft: 24, cardWidth: 220, gap: 16 }))
            .toBe(400 * 236 + 24 + 220 + 24 - 1944);
        expect(clipboardIndexScrollLeft(0, { scrollLeft: 80000, viewportWidth: 1944, gridLeft: 24, cardWidth: 220, gap: 16 }))
            .toBe(0);
    });

    it("does not let an old drag completion release the next gesture", () => {
        const leases = new InteractionLeases();
        const first = leases.acquire("same");
        const second = leases.acquire("same");
        first();
        expect(leases.has("same")).toBe(true);
        second();
        expect(leases.has("same")).toBe(false);
        leases.acquire("one");
        leases.acquire("two");
        leases.acquire("three");
        expect(leases.hashes()).toEqual(["two", "three"]);
    });
});
