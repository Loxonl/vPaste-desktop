import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { HistoryMediaImage } from "../../../src/clipboard/HistoryMediaImage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("history media resource lifetime", () => {
    it("loads the Rust file URL directly and clears src when its card leaves the viewport", () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        const view = render(<StrictMode><HistoryMediaImage src="asset://localhost/preview.png" alt="" /></StrictMode>);
        const image = view.container.querySelector("img")!;
        expect(image.src).toBe("asset://localhost/preview.png");
        expect(fetch).not.toHaveBeenCalled();
        view.unmount();
        expect(image.hasAttribute("src")).toBe(false);
    });

    it("keeps the new source when the same mounted card changes resource", () => {
        const view = render(<HistoryMediaImage src="asset://localhost/old.gif" alt="" />);
        const image = view.container.querySelector("img")!;
        view.rerender(<HistoryMediaImage src="asset://localhost/new.gif" alt="" />);
        expect(image.src).toBe("asset://localhost/new.gif");
    });
});
