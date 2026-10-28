import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClipboardHoverPreview } from "../../../src/clipboard/clipboardHoverPreview";
import { Item, ItemType } from "../../../src/clipboard/Item";

const item = (hash = "a", type = ItemType.Text) => new Item(1, hash, type, "local body", 0);
function fixture() {
    const options = {
        allowed: vi.fn(() => true), requestSequence: { current: 0 },
        open: vi.fn(async (_item: Item, _sequence: number, _request: number, _current: () => boolean) => undefined),
        dismiss: vi.fn(async () => undefined), onError: vi.fn(),
    };
    return { options, hover: createClipboardHoverPreview(options) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("transient hover preview", () => {
    it("opens Link cards through the shared preview callback after the same hover delay", async () => {
        const { options, hover } = fixture();
        hover.enter(item("link", ItemType.Link));
        await vi.advanceTimersByTimeAsync(499);
        expect(options.open).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(options.open).toHaveBeenCalledWith(expect.objectContaining({}), 0, expect.any(Number), expect.any(Function));
        expect(options.open.mock.calls[0][0].getType()).toBe(ItemType.Link);
    });

    it("waits 500ms and does not invalidate an explicit preview request", async () => {
        const { options, hover } = fixture();
        hover.enter(item());
        await vi.advanceTimersByTimeAsync(499);
        expect(options.open).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(options.open).toHaveBeenCalledOnce();
        hover.cancel();
        expect(options.requestSequence.current).toBe(0);
    });

    it("never opens after a quick pass, cancellation, a newer card, or a manual action", async () => {
        const { options, hover } = fixture();
        hover.enter(item());
        await vi.advanceTimersByTimeAsync(200);
        hover.leave();
        await vi.advanceTimersByTimeAsync(700);
        expect(options.open).not.toHaveBeenCalled();
        hover.enter(item());
        await vi.advanceTimersByTimeAsync(300);
        hover.enter(item("b"));
        await vi.advanceTimersByTimeAsync(500);
        expect(options.open).toHaveBeenCalledWith(expect.objectContaining({}), 0, expect.any(Number), expect.any(Function));
        expect(options.open.mock.calls[0][0].getHash()).toBe("b");
        options.open.mockClear();
        hover.enter(item("c"));
        options.requestSequence.current += 1;
        await vi.advanceTimersByTimeAsync(500);
        expect(options.open).not.toHaveBeenCalled();
    });

    it("retains the preview while crossing into it, then closes after leaving both", async () => {
        const { options, hover } = fixture();
        hover.enter(item());
        await vi.advanceTimersByTimeAsync(500);
        hover.leave();
        await vi.advanceTimersByTimeAsync(100);
        hover.previewHover(true);
        await vi.advanceTimersByTimeAsync(400);
        expect(options.dismiss).not.toHaveBeenCalled();
        hover.previewHover(false);
        await vi.advanceTimersByTimeAsync(250);
        expect(options.dismiss).toHaveBeenCalledOnce();
    });

    it("ignores inactive cleanup, unsupported content, and disabled hover", async () => {
        const { options, hover } = fixture();
        hover.cancel(); hover.leave(); hover.previewHover(false);
        for (const type of [ItemType.File, ItemType.Color]) hover.enter(item("a", type));
        await vi.advanceTimersByTimeAsync(1000);
        expect(options.open).not.toHaveBeenCalled();
        expect(options.dismiss).not.toHaveBeenCalled();
        options.allowed.mockReturnValue(false);
        hover.enter(item());
        await vi.advanceTimersByTimeAsync(500);
        expect(options.open).not.toHaveBeenCalled();
    });

    it("invalidates a running hover load without cancelling a newer manual request", async () => {
        const { options, hover } = fixture();
        hover.enter(item());
        await vi.advanceTimersByTimeAsync(500);
        const valid = options.open.mock.calls[0][3];
        expect(valid()).toBe(true);
        hover.cancel();
        expect(valid()).toBe(false);
        options.requestSequence.current = 10;
        hover.cancel();
        expect(options.requestSequence.current).toBe(10);
    });
});
