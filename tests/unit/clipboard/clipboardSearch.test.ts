import { describe, expect, it } from "vitest";
import {
    resolveClipboardEmptyState,
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

    it("shows an empty state only after a completed empty result", () => {
        expect(resolveClipboardEmptyState({
            loadedRequest: null,
            resultCount: 0,
            keywords: "",
            activeTab: "all",
            isSearching: false,
        })).toBeNull();
        expect(resolveClipboardEmptyState({
            loadedRequest: { keywords: "", activeTab: "all" },
            resultCount: 0,
            keywords: "",
            activeTab: "all",
            isSearching: true,
        })).toBeNull();
        expect(resolveClipboardEmptyState({
            loadedRequest: { keywords: "", activeTab: "all" },
            resultCount: 1,
            keywords: "",
            activeTab: "all",
            isSearching: false,
        })).toBeNull();
        expect(resolveClipboardEmptyState({
            loadedRequest: { keywords: "", activeTab: "all" },
            resultCount: 0,
            keywords: "",
            activeTab: "all",
            isSearching: false,
        })).toBe("history");
    });

    it("distinguishes keyword and tab-filtered empty results", () => {
        expect(resolveClipboardEmptyState({
            loadedRequest: { keywords: "missing", activeTab: "all" },
            resultCount: 0,
            keywords: "missing",
            activeTab: "all",
            isSearching: false,
        })).toBe("filtered");
        expect(resolveClipboardEmptyState({
            loadedRequest: { keywords: "", activeTab: "favorite" },
            resultCount: 0,
            keywords: "",
            activeTab: "favorite",
            isSearching: false,
        })).toBe("filtered");
    });

    it("does not reuse an empty result for a new keyword or tab", () => {
        expect(resolveClipboardEmptyState({
            loadedRequest: { keywords: "previous", activeTab: "all" },
            resultCount: 0,
            keywords: "next",
            activeTab: "all",
            isSearching: false,
        })).toBeNull();
        expect(resolveClipboardEmptyState({
            loadedRequest: { keywords: "", activeTab: "all" },
            resultCount: 0,
            keywords: "",
            activeTab: "favorite",
            isSearching: false,
        })).toBeNull();
    });
});
