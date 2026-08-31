import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useClipboardListInteractions } from "../../../src/clipboard/useClipboardListInteractions";

type HarnessProps = {
    tutorialActive?: boolean;
    draggableCard?: boolean;
    onActivateCard?: (hash: string, plainText: boolean) => void;
    onLoadMore?: (force?: boolean) => void;
    onPointerStart?: () => void;
    onWheelStart?: () => void;
};

function Harness({
    tutorialActive = false,
    draggableCard = false,
    onActivateCard = () => undefined,
    onLoadMore = () => undefined,
    onPointerStart = () => undefined,
    onWheelStart = () => undefined,
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
        >
            <div className="card" data-hash="item-1" draggable={draggableCard}>Card</div>
        </div>
    );
}

describe("useClipboardListInteractions", () => {
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
        vi.restoreAllMocks();
        delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
        delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
        delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
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
