export function searchDebounceDelay(
    keywords: string,
    isComposing: boolean,
): number | null {
    if (isComposing) return null;
    return keywords.trim() ? 120 : 40;
}

export function shouldMaskSearchResults(
    keywords: string,
    isSearching: boolean,
): boolean {
    return isSearching && Boolean(keywords.trim());
}

export type ClipboardEmptyState = "history" | "filtered" | null;
export type LoadedClipboardRequest = {
    keywords: string;
    activeTab: string;
};

export function resolveClipboardEmptyState({
    loadedRequest,
    resultCount,
    keywords,
    activeTab,
    isSearching,
}: {
    loadedRequest: LoadedClipboardRequest | null;
    resultCount: number;
    keywords: string;
    activeTab: string;
    isSearching: boolean;
}): ClipboardEmptyState {
    const currentRequestLoaded = loadedRequest?.keywords === keywords
        && loadedRequest.activeTab === activeTab;
    if (!currentRequestLoaded || isSearching || resultCount > 0) return null;
    return keywords.trim() || activeTab !== "all" ? "filtered" : "history";
}
