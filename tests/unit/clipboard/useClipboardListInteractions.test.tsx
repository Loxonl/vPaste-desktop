import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useClipboardListInteractions } from "../../../src/clipboard/useClipboardListInteractions";

type HarnessProps = {
    tutorialActive?: boolean;
    draggableCard?: boolean;
    onActivateCard?: (hash: string, plainText: boolean, doubleClick?: boolean) => void;
    onLoadMore?: (force?: boolean) => void;
    onPointerStart?: () => void;
    onWheelStart?: () => void;
    onHoverCard?: (hash: string, target: Element) => void;
};

function Harness({
    tutorialActive = false,
    draggableCard = false,
    onActivateCard = () => undefined,
    onLoadMore = () => undefined,
    onPointerStart = () => undefined,
    onWheelStart = () => undefined,
    onHoverCard = () => undefined,
}: HarnessProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const interactions = useClipboardListInteractions({
        containerRef,
        tutorialActive,
        draggingClassName: "dragging",
        wheelScrollingClassName: "wheel-scrolling",
        cardSelector: ".card",
        contextMenuSelector: ".context-menu",
        onActivateCard,
        onLoadMore,
        onPointerStart,
        onWheelStart,
        onHoverCard,
    });

    return (
        <div
            ref={containerRef}
            data-testid="cards"
            onPointerDown={interactions.handlePointerDown}
            onPointerMove={interactions.handlePointerMove}
            onPointerUp={interactions.finishPointerDrag}
            onPointerCancel={interactions.finishPointerDrag}
            onLostPointerCapture={interactions.finishPointerDrag}
            onClickCapture={interactions.handleClickCapture}
            onDoubleClickCapture={interactions.handleDoubleClick}
            onScroll={interactions.handleScroll}
            onPointerLeave={interactions.handlePointerLeave}
            onKeyDown={interactions.suspendPointerSelection}
        >
            <div className="card" data-hash="item-1" draggable={draggableCard}>Card</div>
            <div className="card" data-hash="item-2">Second card</div>
        </div>
    );
}

describe("useClipboardListInteractions", () => {
    it("forwards a captured card double-click separately from its two selection clicks", () => {
        const activate = vi.fn();
        render(<Harness onActivateCard={activate} />);
        const container = screen.getByTestId("cards");
        const card = screen.getByText("Card");
        fireEvent.pointerDown(card, { pointerId: 1, isPrimary: true, button: 0 });
        fireEvent.pointerUp(container, { pointerId: 1, isPrimary: true, button: 0 });
        fireEvent.doubleClick(container, { shiftKey: true });
        expect(activate).toHaveBeenLastCalledWith("item-1", true, true);
    });

    let animationFrameId = 0;

    beforeEach(() => {
        animationFrameId = 0;
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
            animationFrameId += 1;
            return animationFrameId;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
        Object.defineProperties(HTMLElement.prototype, {
            setPointerCapture: {
                configurable: true,
                value: vi.fn(),
            },
            hasPointerCapture: {
                configurable: true,
                value: vi.fn(() => true),
            },
            releasePointerCapture: {
                configurable: true,
                value: vi.fn(),
            },
        });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        delete (document as Partial<Document>).elementFromPoint;
        delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
        delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
        delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
    });

    it("selects the card under a moving mouse without activating it, ignoring touch and pressed buttons", () => {
        const hover = vi.fn();
        const activate = vi.fn();
        render(<Harness onHoverCard={hover} onActivateCard={activate} />);
        const card = screen.getByText("Card");
        const second = screen.getByText("Second card");
        fireEvent.pointerMove(card, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        expect(hover).toHaveBeenLastCalledWith("item-1", card);
        fireEvent.pointerMove(second, { pointerType: "touch", buttons: 0, clientX: 200, clientY: 20 });
        fireEvent.pointerMove(second, { pointerType: "mouse", buttons: 1, clientX: 201, clientY: 20 });
        expect(hover).toHaveBeenCalledOnce();
        fireEvent.pointerMove(second, { pointerType: "mouse", buttons: 0, clientX: 202, clientY: 20 });
        expect(hover).toHaveBeenLastCalledWith("item-2", second);
        expect(activate).not.toHaveBeenCalled();
    });

    it("does not take keyboard selection back until the mouse actually moves", () => {
        const hover = vi.fn();
        render(<Harness onHoverCard={hover} />);
        const card = screen.getByText("Card");
        const second = screen.getByText("Second card");
        fireEvent.pointerMove(card, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        expect(hover).toHaveBeenCalledOnce();
        fireEvent.keyDown(screen.getByTestId("cards"), { key: "ArrowRight" });
        fireEvent.pointerOver(second, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        fireEvent.pointerMove(second, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        expect(hover).toHaveBeenCalledOnce();
        fireEvent.pointerMove(second, { pointerType: "mouse", buttons: 0, clientX: 101, clientY: 20 });
        expect(hover).toHaveBeenLastCalledWith("item-2", second);
    });

    it("reselects the card under the stationary pointer only after user scrolling settles", () => {
        vi.useFakeTimers();
        vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
        const hover = vi.fn();
        render(<Harness onHoverCard={hover} />);
        const container = screen.getByTestId("cards");
        const card = screen.getByText("Card");
        const second = screen.getByText("Second card");
        Object.defineProperties(container, {
            clientWidth: { configurable: true, value: 400 },
            scrollWidth: { configurable: true, value: 1000 },
        });
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => second) });
        fireEvent.pointerMove(card, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        expect(hover).toHaveBeenCalledOnce();
        hover.mockClear();
        fireEvent.wheel(container, { deltaY: 300, clientX: 100, clientY: 20 });
        fireEvent.scroll(container);
        fireEvent.pointerMove(second, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        vi.advanceTimersByTime(99);
        expect(hover).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(hover).toHaveBeenLastCalledWith("item-2", second);
        hover.mockClear();
        fireEvent.keyDown(container, { key: "ArrowRight" });
        fireEvent.scroll(container);
        vi.advanceTimersByTime(200);
        expect(hover).not.toHaveBeenCalled();
    });

    it("recognizes real movement back into the list even at the same card coordinates", () => {
        const hover = vi.fn();
        render(<Harness onHoverCard={hover} />);
        const card = screen.getByText("Card");
        fireEvent.pointerMove(card, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        fireEvent.pointerOut(card, { pointerType: "mouse", clientX: 0, clientY: 0, relatedTarget: document.body });
        fireEvent.pointerMove(card, { pointerType: "mouse", buttons: 0, clientX: 100, clientY: 20 });
        expect(hover).toHaveBeenCalledTimes(2);
    });

    it("activates the pressed card when the pointer is released without dragging", () => {
        const onActivateCard = vi.fn();
        const onPointerStart = vi.fn();
        const onWheelStart = vi.fn();
        render(
            <Harness
                onActivateCard={onActivateCard}
                onPointerStart={onPointerStart}
                onWheelStart={onWheelStart}
            />,
        );
        const card = screen.getByText("Card");

        fireEvent.pointerDown(card, {
            isPrimary: true,
            button: 0,
            pointerId: 7,
            clientX: 100,
            clientY: 20,
        });
        fireEvent.pointerUp(card, {
            isPrimary: true,
            button: 0,
            pointerId: 7,
            clientX: 100,
            clientY: 20,
            shiftKey: true,
        });

        expect(onActivateCard).toHaveBeenCalledWith("item-1", true);
        expect(onPointerStart).toHaveBeenCalledOnce();
        expect(onWheelStart).not.toHaveBeenCalled();
    });

    it("leaves pointer ownership to a draggable card", () => {
        const onPointerStart = vi.fn();
        render(<Harness draggableCard onPointerStart={onPointerStart} />);
        const card = screen.getByText("Card");

        fireEvent.pointerDown(card, {
            isPrimary: true,
            button: 0,
            pointerId: 70,
            clientX: 100,
            clientY: 20,
        });

        expect(onPointerStart).not.toHaveBeenCalled();
        expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
    });

    it("applies pending horizontal drag distance and requests more history", () => {
        const onLoadMore = vi.fn();
        render(<Harness onLoadMore={onLoadMore} />);
        const container = screen.getByTestId("cards");
        const card = screen.getByText("Card");
        container.scrollLeft = 100;

        fireEvent.pointerDown(card, {
            isPrimary: true,
            button: 0,
            pointerId: 8,
            clientX: 100,
            clientY: 20,
        });
        fireEvent.pointerMove(card, {
            isPrimary: true,
            pointerId: 8,
            clientX: 80,
            clientY: 20,
        });
        fireEvent.pointerUp(card, {
            isPrimary: true,
            pointerId: 8,
            clientX: 80,
            clientY: 20,
        });

        expect(container.scrollLeft).toBe(120);
        expect(onLoadMore).toHaveBeenCalled();
        expect(container).not.toHaveClass("dragging");
    });

    it("uses immediate wheel scrolling when reduced motion is enabled", () => {
        vi.spyOn(window, "matchMedia").mockReturnValue({
            matches: true,
        } as MediaQueryList);
        const onLoadMore = vi.fn();
        const onPointerStart = vi.fn();
        const onWheelStart = vi.fn();
        render(
            <Harness
                onLoadMore={onLoadMore}
                onPointerStart={onPointerStart}
                onWheelStart={onWheelStart}
            />,
        );
        const container = screen.getByTestId("cards");
        Object.defineProperties(container, {
            clientWidth: { configurable: true, value: 400 },
            scrollWidth: { configurable: true, value: 1000 },
        });
        container.scrollLeft = 100;

        fireEvent.wheel(container, {
            deltaY: 30,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        });

        expect(container.scrollLeft).toBe(130);
        expect(container).toHaveClass("wheel-scrolling");
        expect(onWheelStart).toHaveBeenCalledOnce();
        expect(onPointerStart).not.toHaveBeenCalled();
        expect(onLoadMore).toHaveBeenCalledOnce();
    });
});
