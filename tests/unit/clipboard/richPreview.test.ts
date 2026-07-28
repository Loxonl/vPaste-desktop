import { describe, expect, it } from "vitest";
import {
    richHtmlHasVisibleContent,
    sanitizeRichHtml,
} from "../../../src/clipboard/richPreview";

function firstElement(html: string): HTMLElement {
    const document = new DOMParser().parseFromString(html, "text/html");
    const element = document.body.firstElementChild;
    if (!(element instanceof HTMLElement)) {
        throw new Error("Expected sanitized HTML to contain an element");
    }
    return element;
}

describe("rich clipboard preview", () => {
    it("removes active content and interaction attributes", () => {
        const html = sanitizeRichHtml(`
            <script>alert("x")</script>
            <form>
                <a
                    href="javascript:alert(1)"
                    onclick="alert(1)"
                    tabindex="0"
                    style="color: red; background-image: url(https://example.com/a.png)"
                >Safe text</a>
            </form>
        `);

        const document = new DOMParser().parseFromString(html, "text/html");
        const link = document.querySelector("a");
        expect(document.querySelector("script, form")).toBeNull();
        expect(link?.textContent).toContain("Safe text");
        expect(link?.hasAttribute("href")).toBe(false);
        expect(link?.hasAttribute("onclick")).toBe(false);
        expect(link?.hasAttribute("tabindex")).toBe(false);
        expect(link?.hasAttribute("style")).toBe(false);
    });

    it("inlines safe class styles without overriding existing inline rules", () => {
        const html = sanitizeRichHtml(`
            <style>
                .accent {
                    color: red;
                    font-weight: 700;
                    background-image: url(https://example.com/a.png);
                    width: 400px;
                }
            </style>
            <p class="accent" style="color: blue">Hello</p>
        `);

        const paragraph = firstElement(html);
        expect(paragraph.style.color).toBe("blue");
        expect(paragraph.style.fontWeight).toBe("700");
        expect(paragraph.style.backgroundImage).toBe("");
        expect(paragraph.style.width).toBe("");
    });

    it("removes oversized layout rules while preserving safe presentation", () => {
        const html = sanitizeRichHtml(
            '<p style="width: 400px; margin-left: 1in; text-indent: -10px; color: rgb(1, 2, 3)">Text</p>',
        );

        const paragraph = firstElement(html);
        expect(paragraph.style.width).toBe("");
        expect(paragraph.style.marginLeft).toBe("");
        expect(paragraph.style.textIndent).toBe("");
        expect(paragraph.style.color).toBe("rgb(1, 2, 3)");
    });

    it("trims empty leading blocks from nested clipboard layouts", () => {
        const html = sanitizeRichHtml(
            '<div style="width: 8in"><div><p>&nbsp;</p><p>Visible</p></div></div>',
        );

        expect(firstElement(html).textContent?.trim()).toBe("Visible");
        expect(html).not.toContain("&nbsp;");
    });

    it("distinguishes visible rich content from empty formatting", () => {
        expect(richHtmlHasVisibleContent("<style>.x { color: red; }</style>")).toBe(false);
        expect(richHtmlHasVisibleContent("<p>Visible</p>")).toBe(true);
        expect(richHtmlHasVisibleContent("<table><tbody><tr><td></td></tr></tbody></table>")).toBe(true);
    });
});
