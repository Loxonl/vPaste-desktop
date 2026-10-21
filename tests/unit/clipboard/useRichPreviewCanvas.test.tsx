import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeRichHtml } from "../../../src/clipboard/richPreview";
import { useRichPreviewCanvas } from "../../../src/clipboard/useRichPreviewCanvas";

function RichCanvas({ html }: { html: string }) {
    const safeHtml = sanitizeRichHtml(html);
    const ref = useRichPreviewCanvas(safeHtml);
    return <div ref={ref} data-testid="canvas" dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}

afterEach(cleanup);

describe("rich preview default canvas", () => {
    it.each([
        ["unstyled", "<p>Text</p>", "light"],
        ["dark ink", '<p style="color: black">Text</p>', "light"],
        ["light ink", '<p style="color: white">Text</p>', "dark"],
        ["inherited light ink", '<div style="color: #eee"><b><span>Text</span></b></div>', "dark"],
        ["transparent background", '<p style="color: white; background: rgba(255,255,255,0)">Text</p>', "dark"],
        ["complete light page", '<p style="color: #222; background: white">Text</p>', "light"],
        ["complete dark page", '<p style="color: white; background: #222">Text</p>', "light"],
        ["highlight", '<p><span style="color: purple; background: yellow">Text</span></p>', "light"],
        ["missing ink on a dark background", '<p style="background: #222">Text</p>', "dark"],
        ["missing ink on a light background", '<p style="background: white">Text</p>', "light"],
        ["text fill", '<p style="color: black; -webkit-text-fill-color: white">Text</p>', "dark"],
    ])("chooses a paired fallback for %s", (_name, html, tone) => {
        const { getByTestId } = render(<RichCanvas html={html} />);
        expect(getByTestId("canvas")).toHaveAttribute("data-rich-canvas", tone);
        expect(getByTestId("canvas").innerHTML).toBe(sanitizeRichHtml(html));
    });

    it("weights actual uncovered text instead of letting a short white highlight change the canvas", () => {
        const html = '<div style="color: black">A longer passage of dark body text.</div>'
            + '<span style="color: white; background: purple">Highlight</span>';
        const { getByTestId } = render(<RichCanvas html={html} />);
        expect(getByTestId("canvas")).toHaveAttribute("data-rich-canvas", "light");
    });

    it("re-evaluates a reused surface without changing source formatting", () => {
        const { getByTestId, rerender } = render(<RichCanvas html='<p style="color: white">First</p>' />);
        expect(getByTestId("canvas")).toHaveAttribute("data-rich-canvas", "dark");
        rerender(<RichCanvas html='<p style="color: black">Second</p>' />);
        expect(getByTestId("canvas")).toHaveAttribute("data-rich-canvas", "light");
        expect(getByTestId("canvas").querySelector("p")?.style.color).toBe("black");
    });
});
