import { describe, expect, it } from "vitest";
import { HistoryViewStore, type HistoryInvoker } from "../../../src/clipboard/historyViewStore";
import { ItemType } from "../../../src/clipboard/Item";

function backend(total = 5000) {
    let view = 0;
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const row = (index: number) => ({ id: index, hash: `record-${index}`, itemType: ItemType.Text,
        time: total - index, label: 0, tags: [], appSource: "fixture", appIconPath: "", titleColor: "" });
    const call: HistoryInvoker = async <T,>(command: string, input?: Record<string, unknown>) => {
        const args = input ?? {};
        calls.push({ command, args });
        if (command === "open_history_view") view += 1;
        const token = { viewId: String(view), revision: 1 };
        if (command === "open_history_view" || command === "read_history_view_page") {
            const pageIndex = Number(args.pageIndex ?? 0);
            const startIndex = pageIndex * 36;
            const count = Math.max(0, Math.min(36, total - startIndex));
            return { token, pageIndex, startIndex, items: Array.from({ length: count }, (_, i) => row(startIndex + i)),
                knownCount: Math.min(total, startIndex + 36), hasMore: startIndex + 36 < total, resourceEpoch: 1 } as T;
        }
        if (command === "read_history_card_payloads") {
            return { token, resourceEpoch: 1, cards: (args.hashes as string[]).map(hash => {
                const index = Number(hash.split("-")[1]);
                return { item: { ...row(index), content: `complete ${index}`, previewContent: `complete ${index}`, textContent: "", richHtml: "" } };
            }) } as T;
        }
        return undefined as T;
    };
    return { call, calls };
}

describe("bounded history data", () => {
    it("does not return a cached navigation record after its view closes in the same turn", async () => {
        const store = new HistoryViewStore(backend().call);
        await store.open({ keywords: "", label: "all" }, { start: 0, end: 14 });
        const selected = store.ensureRef(0);
        store.close();
        expect(await selected).toBeUndefined();
        expect(store.diagnostics().refCount).toBe(0);
    });
    it("clamps a queued navigation target beyond EOF to the final valid record", async () => {
        const store = new HistoryViewStore(backend(50).call);
        await store.open({ keywords: "", label: "all" }, { start: 0, end: 14 });
        const target = await store.navigationRef(57);
        expect(target?.index).toBe(49);
        expect(target?.ref.hash).toBe("record-49");
    });
    it("evicts bodies and metadata after long browsing and re-reads an evicted first page", async () => {
        const native = backend();
        const store = new HistoryViewStore(native.call);
        await store.open({ keywords: "", label: "all" }, { start: 0, end: 14 });
        for (let start = 36; start < 1000; start += 36) {
            await store.ensureRange(start, start + 14);
            expect(store.diagnostics().refCount).toBeLessThanOrEqual(108);
            expect(store.residentItems()).toHaveLength(14);
        }
        expect(store.getRef(0)).toBeUndefined();
        expect((await store.ensureRef(0))?.hash).toBe("record-0");
        expect(store.diagnostics().refCount).toBeLessThanOrEqual(108);
        expect(store.residentItems().some(item => item.getHash() === "record-0")).toBe(false);
        await store.ensureRange(0, 14);
        expect(store.getCard(0)?.getContent()).toBe("complete 0");
        expect(native.calls.filter(call => call.command === "read_history_view_page" && call.args.pageIndex === 0)).toHaveLength(2);
    });

    it("holds only an active drag source outside the viewport, then releases it", async () => {
        const store = new HistoryViewStore(backend().call);
        await store.open({ keywords: "", label: "all" }, { start: 0, end: 14 });
        const release = store.retainForInteraction("record-0");
        await store.ensureRange(360, 374);
        expect(store.residentItems()).toHaveLength(15);
        release();
        expect(store.residentItems()).toHaveLength(14);
        store.close();
        expect(store.residentItems()).toEqual([]);
        expect(store.diagnostics().refCount).toBe(0);
    });

    it("does not refill the closed view when its native open completes late", async () => {
        const native = backend();
        let finish!: () => void;
        const delayed: HistoryInvoker = async <T,>(command: string, args?: Record<string, unknown>) => {
            if (command === "open_history_view") await new Promise<void>(resolve => { finish = resolve; });
            return native.call<T>(command, args);
        };
        const store = new HistoryViewStore(delayed);
        const opening = store.open({ keywords: "old", label: "all" }, { start: 0, end: 14 });
        store.close(); finish();
        expect(await opening).toBe(false);
        expect(store.residentItems()).toEqual([]);
        expect(store.diagnostics().refCount).toBe(0);
    });
});
