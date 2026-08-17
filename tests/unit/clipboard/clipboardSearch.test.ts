import { describe, expect, it } from "vitest";
import {
    searchDebounceDelay,
    shouldMaskSearchResults,
} from "../../../src/clipboard/clipboardSearch";

describe("clipboard search state", () => {
    it("waits for IME composition to finish before scheduling a search", () => {
        expect(searchDebounceDelay("n", true)).toBeNull();
        expect(searchDebounceDelay("needle", true)).toBeNull();
        expect(searchDebounceDelay("needle", false)).toBe(120);
        expect(searchDebounceDelay("", false)).toBe(40);
    });

    it("masks stale history only while a keyword search is pending", () => {
        expect(shouldMaskSearchResults("needle", true)).toBe(true);
        expect(shouldMaskSearchResults("needle", false)).toBe(false);
        expect(shouldMaskSearchResults("", true)).toBe(false);
    });
});
