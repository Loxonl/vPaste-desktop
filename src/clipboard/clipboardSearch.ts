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
