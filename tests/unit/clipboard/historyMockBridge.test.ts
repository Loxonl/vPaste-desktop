import { afterEach, expect, it, vi } from "vitest";
import { installHistoryMockBridge } from "../../helpers/historyMockBridge";

afterEach(() => vi.unstubAllGlobals());

it("supplies native payload byte accounting for legacy text-only browser fixtures", async () => {
    const item = { id: 1, hash: "minimal-text", itemType: "Text", content: "Synthetic" };
    const internals: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } = {
        invoke: async command => command === "search"
            ? JSON.stringify({ list: [item], hasMore: false, knownCount: 1 })
            : null,
    };
    vi.stubGlobal("__TAURI_INTERNALS__", internals);
    installHistoryMockBridge();
    const page = await internals.invoke("open_history_view", { query: {} }) as { token: { viewId: string } };
    const response = await internals.invoke("read_history_card_payloads", { viewId: page.token.viewId, hashes: [item.hash] });
    expect(response).toMatchObject({ cards: [{ item, richRender: null, mimeBytes: item.content.length * 2 }] });
});
