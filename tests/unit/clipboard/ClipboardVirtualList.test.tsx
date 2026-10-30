import { createRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardVirtualList, type ClipboardVirtualListHandle } from "../../../src/clipboard/ClipboardVirtualList";
import { Item, ItemType } from "../../../src/clipboard/Item";
import { LazyMotion, loadMotionFeatures, m, motionPresetFor } from "../../../src/ui/motion";

const items = Array.from({ length: 500 }, (_, index) => new Item(index, `record-${index}`, ItemType.Text, `Original ${index}`, index));
let container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.className.includes("virtual-list-probe") || this.style.position === "absolute" ? 220 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        return parseFloat(this.style.left) || 0;
    });
    container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 1944 });
    container.scrollTo = vi.fn(({ left }: ScrollToOptions) => { container.scrollLeft = left ?? 0; });
    document.body.appendChild(container);
});
afterEach(() => { cleanup(); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("clipboard virtual DOM lifetime", () => {
    it("mounts only the viewport and overscan, and resolves an offscreen logical index by hash", () => {
        const handle = createRef<ClipboardVirtualListHandle>();
        const view = render(<ClipboardVirtualList ref={handle} items={items} containerRef={{ current: container }} active renderCard={(item, _index, ref) => <div ref={ref}><div data-hash={item.getHash()}>{item.getContent()}</div></div>} />, { container });
        expect(view.container.querySelectorAll("[data-hash]").length).toBeLessThanOrEqual(14);
        expect(handle.current!.getCard("record-400")).toBeNull();
        act(() => { handle.current!.scrollToIndex(400); });
        expect(handle.current!.getCard("record-400")).toHaveTextContent("Original 400");
        expect(view.container.querySelectorAll("[data-hash]").length).toBeLessThanOrEqual(14);
    });

    it("keeps deletion animations and a drag source inside the same resident budget", async () => {
        const features = await loadMotionFeatures();
        vi.useFakeTimers();
        try {
            let release: (() => void) | undefined;
            const handle = createRef<ClipboardVirtualListHandle>();
            const renderCard: React.ComponentProps<typeof ClipboardVirtualList>["renderCard"] = (item, _index, ref, retain, _entry, left) => (
                <m.div ref={ref} style={{ position: "absolute", left }} variants={motionPresetFor("gridItem", false)} initial={false} animate="animate" exit="exit">
                    <div data-hash={item.getHash()} onMouseDown={() => { release = retain(); }} />
                </m.div>
            );
            const tree = (current: Item[]) => <LazyMotion features={features} strict>
                <ClipboardVirtualList ref={handle} items={current} containerRef={{ current: container }} active renderCard={renderCard} />
            </LazyMotion>;
            const view = render(tree(items), { container });
            fireEvent.mouseDown(handle.current!.getCard("record-0")!);
            act(() => { handle.current!.scrollToIndex(100); });
            const removed = new Set(["record-92", "record-93", "record-94", "record-95", "record-96"]);
            view.rerender(tree(items.filter(item => !removed.has(item.getHash()))));
            expect(handle.current!.getCard("record-92")).not.toBeNull();
            expect(handle.current!.getCard("record-0")).not.toBeNull();
            // Ten card positions can intersect this viewport; six extra residents
            // cover both overscan, gestures and all still-visible deletion exits.
            expect(container.querySelectorAll("[data-hash]").length).toBeLessThanOrEqual(16);
            await act(async () => { vi.advanceTimersByTime(1000); });
            for (const hash of removed) expect(handle.current!.getCard(hash)).toBeNull();
            removed.add("record-0");
            view.rerender(tree(items.filter(item => !removed.has(item.getHash()))));
            await act(async () => { vi.advanceTimersByTime(1000); });
            expect(handle.current!.getCard("record-0")).not.toBeNull();
            act(() => { release!(); });
            expect(handle.current!.getCard("record-0")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps a drag source mounted while scrolling until its gesture releases it", () => {
        let release: (() => void) | undefined;
        const handle = createRef<ClipboardVirtualListHandle>();
        render(<ClipboardVirtualList ref={handle} items={items} containerRef={{ current: container }} active renderCard={(item, _index, ref, retain) => <div ref={ref}><div data-hash={item.getHash()} onMouseDown={() => { release = retain(); }} /></div>} />, { container });
        fireEvent.mouseDown(handle.current!.getCard("record-0")!);
        act(() => { handle.current!.scrollToIndex(400); });
        expect(handle.current!.getCard("record-0")).not.toBeNull();
        act(() => { release!(); });
        expect(handle.current!.getCard("record-0")).toBeNull();
    });

    it("releases all cards when hidden and restores the retained scroll range on show", () => {
        const handle = createRef<ClipboardVirtualListHandle>();
        const props = { items, containerRef: { current: container }, renderCard: (item: Item, _index: number, ref: React.Ref<HTMLDivElement>) => <div ref={ref}><div data-hash={item.getHash()} /></div> };
        const view = render(<ClipboardVirtualList ref={handle} {...props} active />, { container });
        act(() => { handle.current!.scrollToIndex(400); });
        const scrollLeft = container.scrollLeft;
        view.rerender(<ClipboardVirtualList ref={handle} {...props} active={false} />);
        expect(container.querySelectorAll("[data-hash]")).toHaveLength(0);
        view.rerender(<ClipboardVirtualList ref={handle} {...props} active />);
        expect(container.scrollLeft).toBe(scrollLeft);
        expect(handle.current!.getCard("record-400")).not.toBeNull();
    });
});
