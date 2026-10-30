export type ClipboardGeometry = {
    scrollLeft: number;
    viewportWidth: number;
    gridLeft: number;
    cardWidth: number;
    gap: number;
};

export function clipboardViewport({ count, scrollLeft, viewportWidth, gridLeft, cardWidth, gap }: ClipboardGeometry & { count: number }) {
    const stride = Math.max(1, cardWidth + gap);
    const left = Math.max(0, scrollLeft - gridLeft);
    const right = Math.max(0, scrollLeft + viewportWidth - gridLeft);
    const visibleStart = Math.min(count, Math.max(0, Math.floor((left + gap) / stride)));
    const visibleEnd = Math.min(count, Math.max(visibleStart, Math.ceil(right / stride)));
    return { visibleStart, visibleEnd, start: Math.max(0, visibleStart - 2), end: Math.min(count, visibleEnd + 2) };
}

export function clipboardSpacerWidth(count: number, cardWidth: number, gap: number) {
    return Math.max(0, count * cardWidth + (count - 1) * gap);
}

/** Exiting DOM uses the same budget as new cards; gestures and visible cards win. */
export function clipboardResidentIndices(
    range: ReturnType<typeof clipboardViewport>, retained: number[], retiringCount: number, visibleCapacity: number,
): number[] {
    const available = Math.max(0, visibleCapacity + 6 - retiringCount);
    const indices = new Set<number>();
    const admit = (index: number) => { if (indices.size < available) indices.add(index); };
    retained.forEach(admit);
    for (let index = range.visibleStart; index < range.visibleEnd; index += 1) admit(index);
    for (let index = range.start; index < range.end; index += 1) admit(index);
    return [...indices].sort((left, right) => left - right);
}

export function clipboardIndexScrollLeft(index: number, geometry: ClipboardGeometry) {
    const { scrollLeft, viewportWidth, gridLeft, cardWidth, gap } = geometry;
    const left = gridLeft + index * (cardWidth + gap);
    if (left - 24 < scrollLeft) return Math.max(0, left - 24);
    if (left + cardWidth + 24 > scrollLeft + viewportWidth) return left + cardWidth + 24 - viewportWidth;
    return scrollLeft;
}

/** The OS allows one drag; keep a second lease for a retiring capture. */
export class InteractionLeases {
    private readonly tokens = new Map<string, symbol>();
    acquire(hash: string): () => void {
        const token = Symbol(hash);
        this.tokens.delete(hash);
        this.tokens.set(hash, token);
        while (this.tokens.size > 2) this.tokens.delete(this.tokens.keys().next().value!);
        return () => { if (this.tokens.get(hash) === token) this.tokens.delete(hash); };
    }
    has(hash: string) { return this.tokens.has(hash); }
    hashes() { return [...this.tokens.keys()]; }
}
