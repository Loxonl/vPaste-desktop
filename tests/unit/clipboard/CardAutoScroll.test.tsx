import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClipboardCardPreview from "../../../src/clipboard/ClipboardCardPreview";
import { Item, ItemType } from "../../../src/clipboard/Item";
import { motionTokens } from "../../../src/ui/motion/tokens";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("../../../src/ui/motion", async importOriginal => ({
    ...await importOriginal<object>(),
    useReducedMotion: () => preference.reduced,
}));

describe("card automatic text preview", () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    beforeEach(() => {
        vi.useFakeTimers(); preference.reduced = false;
        vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
        vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
        Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) {
            if (typeof options === "object") this.scrollTop = options.top ?? 0;
        }});
    });
    afterEach(() => {
        cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
        if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
        else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    });

    const item = new Item(1, "long-text", ItemType.Text, "long text\n".repeat(60), 1);
    const preview = (active: boolean) => <ClipboardCardPreview item={item} active={active} refreshKey={0}
        searchQuery="" mediaPlaybackReady={true} t={((key: string) => key) as never} onGifFormatChange={() => {}} />;

    it("waits before scrolling and returns to the top when inactive", () => {
        const view = render(preview(true));
        const element = view.getByText(/long text/);
        act(() => vi.advanceTimersByTime(motionTokens.cardPreview.delay * 1000 - 1));
        expect(element.scrollTop).toBe(0);
        act(() => vi.advanceTimersByTime(700));
        expect(element.scrollTop).toBeGreaterThan(0);
        view.rerender(preview(false));
        expect(element.scrollTop).toBe(0);
        act(() => vi.advanceTimersByTime(10_000));
        expect(element.scrollTop).toBe(0);
    });

    it("does not start a scrolling loop in reduced motion and cancels on unmount", () => {
        preference.reduced = true;
        const view = render(preview(true));
        const element = view.getByText(/long text/);
        act(() => vi.advanceTimersByTime(10_000));
        expect(element.scrollTop).toBe(0);
        preference.reduced = false; view.rerender(preview(true));
        act(() => vi.advanceTimersByTime(1000));
        expect(element.scrollTop).toBeGreaterThan(0);
        view.unmount(); const position = element.scrollTop;
        act(() => vi.advanceTimersByTime(10_000));
        expect(element.scrollTop).toBe(position);
    });
});
