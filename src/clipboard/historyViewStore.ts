import { invoke } from "@tauri-apps/api/core";
import { Item } from "./Item";
import type { CardResponse, HistoryQuery, HistoryRef, HistoryViewPage, ViewToken } from "./historyViewTypes";

const PAGE_SIZE = 36;
type Card = { index: number; item: Item; mimeBytes: number };
type Range = { start: number; end: number };
export type HistoryInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Metadata pages are reusable; complete records belong only to the current viewport/gesture. */
export class HistoryViewStore {
    private token: ViewToken | null = null;
    private generation = 0;
    private pages = new Map<number, HistoryViewPage>();
    private cards = new Map<string, Card>();
    private held = new Map<string, symbol>();
    private desired: Range = { start: 0, end: 0 };
    private completed: Range | null = null;
    private running: Promise<void> | null = null;
    private pageRequests = new Map<number, Promise<HistoryViewPage | null>>();
    private listeners = new Set<() => void>();
    knownCount = 0;
    hasMore = false;
    resourceEpoch = 0;
    enteringHashes: ReadonlySet<string> = new Set();
    private terminalCount: number | null = null;

    constructor(private readonly call: HistoryInvoker = invoke) {}

    subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private emit() { this.listeners.forEach(listener => listener()); }
    private args() { return this.token ? { ...this.token } : {}; }
    private current(generation: number, token: ViewToken) {
        return this.generation === generation && this.token?.viewId === token.viewId && this.token.revision === token.revision;
    }

    async open(query: HistoryQuery, initial: Range) {
        const previousHashes = new Set(this.cards.keys());
        this.close();
        const generation = this.generation;
        const page = await this.call<HistoryViewPage>("open_history_view", { query });
        if (generation !== this.generation) {
            void this.call("close_history_view", { viewId: page.token.viewId }).catch(() => {});
            return false;
        }
        this.token = page.token;
        this.resourceEpoch = page.resourceEpoch;
        this.acceptPage(page);
        await this.ensureRange(initial.start, initial.end);
        if (generation !== this.generation) return false;
        this.enteringHashes = new Set([...this.cards.keys()].filter(hash => !previousHashes.has(hash)));
        this.emit();
        return generation === this.generation;
    }

    close() {
        const token = this.token;
        this.generation += 1;
        this.token = null;
        this.pages.clear(); this.cards.clear(); this.held.clear(); this.pageRequests.clear();
        this.knownCount = 0; this.hasMore = false; this.terminalCount = null; this.completed = null; this.running = null;
        this.enteringHashes = new Set();
        if (token) void this.call("close_history_view", { viewId: token.viewId }).catch(() => {});
    }

    private acceptPage(page: HistoryViewPage, expose = true) {
        this.pages.delete(page.pageIndex);
        this.pages.set(page.pageIndex, page);
        if (expose) this.knownCount = Math.max(this.knownCount, page.startIndex + page.items.length);
        if (!page.hasMore) {
            this.terminalCount = Math.min(page.knownCount, page.startIndex + page.items.length);
        }
        if (this.terminalCount !== null) this.knownCount = Math.min(this.knownCount, this.terminalCount);
        this.hasMore = this.terminalCount === null || this.knownCount < this.terminalCount;
        this.trimPages();
    }

    private async page(index: number, expose = true): Promise<HistoryViewPage | null> {
        const token = this.token;
        if (!token) return null;
        const generation = this.generation;
        const cached = this.pages.get(index);
        if (cached) { this.acceptPage(cached, expose); return cached; }
        const pending = this.pageRequests.get(index);
        if (pending) {
            const page = await pending;
            if (!this.current(generation, token)) return null;
            if (page && expose) this.acceptPage(page);
            return page;
        }
        const request = this.call<HistoryViewPage>("read_history_view_page", { ...token, pageIndex: index })
            .then(page => {
                if (!this.current(generation, token)) return null;
                this.acceptPage(page, expose);
                return page;
            }).finally(() => { if (this.current(generation, token)) this.pageRequests.delete(index); });
        this.pageRequests.set(index, request);
        return request;
    }

    async loadMore() {
        if (!this.hasMore) return;
        await this.page(Math.floor(this.knownCount / PAGE_SIZE));
        this.trimPages(); this.emit();
    }

    getRef(index: number): HistoryRef | undefined {
        return this.pages.get(Math.floor(index / PAGE_SIZE))?.items[index % PAGE_SIZE];
    }
    async ensureRef(index: number): Promise<HistoryRef | undefined> {
        if (index < 0) return undefined;
        const token = this.token;
        if (!token) return undefined;
        const generation = this.generation;
        const page = await this.page(Math.floor(index / PAGE_SIZE));
        if (!this.current(generation, token)) return undefined;
        const ref = page?.items[index - page.startIndex];
        this.trimPages();
        return ref;
    }
    async navigationRef(index: number) {
        let target = Math.max(0, index);
        if (!this.hasMore && this.knownCount > 0) target = Math.min(target, this.knownCount - 1);
        let ref = await this.ensureRef(target);
        if (!ref && !this.hasMore && this.knownCount > 0) {
            target = this.knownCount - 1;
            ref = await this.ensureRef(target);
        }
        return ref ? { index: target, ref } : undefined;
    }
    indexOf(hash: string): number {
        const card = this.cards.get(hash);
        if (card) return card.index;
        for (const page of this.pages.values()) {
            const index = page.items.findIndex(item => item.hash === hash);
            if (index >= 0) return page.startIndex + index;
        }
        return -1;
    }
    getCard(index: number): Item | undefined {
        const ref = this.getRef(index);
        return ref ? this.cards.get(ref.hash)?.item : undefined;
    }
    residentItems(): Item[] { return [...this.cards.values()].sort((a, b) => a.index - b.index).map(card => card.item); }

    private toItem(card: CardResponse["cards"][number]) {
        const row = card.item;
        return new Item(row.id, row.hash, row.itemType, row.content, row.time, row.titleColor,
            row.previewContent, row.textContent, row.label, row.appSource, row.appIconPath,
            row.richHtml, row.tags ?? [], card.richRender ?? undefined, true);
    }

    async actionItem(hash: string): Promise<Item | undefined> {
        const cached = this.cards.get(hash)?.item;
        if (cached) return cached;
        const token = this.token;
        if (!token) return undefined;
        const generation = this.generation;
        const response = await this.call<CardResponse>("read_history_card_payloads", { ...token, hashes: [hash] });
        if (!this.current(generation, token) || response.resourceEpoch !== this.resourceEpoch) return undefined;
        return response.cards[0] ? this.toItem(response.cards[0]) : undefined;
    }

    private trimPages() {
        const first = Math.floor(this.desired.start / PAGE_SIZE);
        const last = Math.floor(Math.max(this.desired.start, this.desired.end - 1) / PAGE_SIZE);
        const budget = Math.max(3, last - first + 1);
        const order = [...this.pages.keys()].sort((a, b) => {
            const distance = (page: number) => page < first ? first - page : page > last ? page - last : 0;
            return distance(a) - distance(b);
        });
        for (const index of order.slice(budget)) this.pages.delete(index);
    }

    private pruneCards() {
        for (const [hash, card] of this.cards) {
            if (!this.held.has(hash) && (card.index < this.desired.start || card.index >= this.desired.end)) this.cards.delete(hash);
        }
    }

    retainForInteraction(hash: string) {
        const lease = Symbol(hash);
        this.held.delete(hash); this.held.set(hash, lease);
        while (this.held.size > 2) this.held.delete(this.held.keys().next().value!);
        return () => {
            if (this.held.get(hash) !== lease) return;
            this.held.delete(hash); this.pruneCards(); this.emit();
        };
    }

    ensureRange(start: number, end: number): Promise<void> {
        this.desired = { start: Math.max(0, start), end: Math.max(start, end) };
        if (!this.token) return Promise.resolve();
        if (this.running) return this.running;
        if (this.completed?.start === this.desired.start && this.completed.end === this.desired.end) return Promise.resolve();
        const generation = this.generation;
        const run = this.pump(generation);
        this.running = run;
        void run.finally(() => { if (generation === this.generation && this.running === run) { this.running = null; this.emit(); } }).catch(() => {});
        return run;
    }

    private async pump(generation: number) {
        while (this.token && generation === this.generation) {
            const range = { ...this.desired };
            const token = this.token;
            const first = Math.floor(range.start / PAGE_SIZE);
            const last = Math.floor(Math.max(range.start, range.end - 1) / PAGE_SIZE);
            for (let index = first; index <= last; index += 1) {
                await this.page(index);
                if (!this.current(generation, token)) return;
            }
            const missing: Array<{ hash: string; index: number }> = [];
            for (let index = range.start; index < Math.min(range.end, this.knownCount); index += 1) {
                const ref = this.getRef(index);
                if (ref && !this.cards.has(ref.hash)) missing.push({ hash: ref.hash, index });
            }
            for (let offset = 0; offset < missing.length; offset += 32) {
                const batch = missing.slice(offset, offset + 32);
                const response = await this.call<CardResponse>("read_history_card_payloads", { ...token, hashes: batch.map(item => item.hash) });
                if (!this.current(generation, token)) return;
                if (range.start !== this.desired.start || range.end !== this.desired.end) break;
                for (const card of response.cards) {
                    const index = batch.find(item => item.hash === card.item.hash)?.index;
                    if (index !== undefined && response.resourceEpoch === this.resourceEpoch) this.cards.set(card.item.hash, { index, item: this.toItem(card),
                        mimeBytes: card.mimeBytes ?? (card.item.content.length + card.item.textContent.length + card.item.richHtml.length) * 2 });
                }
            }
            if (!this.current(generation, token)) return;
            if (range.start !== this.desired.start || range.end !== this.desired.end) continue;
            this.pruneCards();
            // Two neighboring pages are metadata only; no offscreen Item/HTML is materialized.
            if (first > 0) await this.page(first - 1, false);
            if (this.hasMore || (last + 1) * PAGE_SIZE < this.knownCount) await this.page(last + 1, false);
            if (!this.current(generation, token)) return;
            this.trimPages(); this.completed = range;
            void this.call("set_history_viewport", { ...this.args(), ...range }).catch(() => {});
            this.emit();
            if (range.start === this.desired.start && range.end === this.desired.end) return;
        }
    }

    diagnostics() {
        return { viewId: this.token?.viewId, revision: this.token?.revision,
            pageCount: this.pages.size, refCount: [...this.pages.values()].reduce((count, page) => count + page.items.length, 0),
            evictablePayloadCount: 0, evictablePayloadBytes: 0, activeMimeCount: this.cards.size,
            activeMimeBytes: [...this.cards.values()].reduce((sum, card) => sum + card.mimeBytes, 0),
            pendingLoads: this.pageRequests.size + Number(this.running !== null), previewMediaBodyBytesInJS: 0 };
    }
}
