import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCardPreviewPixelWidth } from "../../../src/clipboard/useCardPreviewPixelWidth";

const original = Object.getOwnPropertyDescriptor(window, "devicePixelRatio")!;
afterEach(() => { cleanup(); Object.defineProperty(window, "devicePixelRatio", original); });
describe("card image resolution across displays", () => {
    it("requests a new sufficient pixel tier after moving from standard to Retina and higher DPI", () => {
        function Probe() { return <output data-testid="pixels">{useCardPreviewPixelWidth()}</output>; }
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
        render(<Probe />);
        expect(screen.getByTestId("pixels")).toHaveTextContent("240");
        act(() => { Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 }); window.dispatchEvent(new Event("resize")); });
        expect(screen.getByTestId("pixels")).toHaveTextContent("480");
        act(() => { Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 }); window.dispatchEvent(new Event("resize")); });
        expect(screen.getByTestId("pixels")).toHaveTextContent("720");
    });
});
