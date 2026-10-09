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
    it("drops executable URL surfaces while keeping raster clipboard images", () => {
        const html = sanitizeRichHtml(`
            <svg><animate attributeName="href" values="javascript:alert(1)" /></svg>
            <img src="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;" alt="bad data">
            <img src="vbscript:msgbox(1)" alt="bad scheme">
            <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="svg image">
            <img src="data:image/png;base64,AA==" alt="safe image">
            <p>Visible text</p>
        `);

        const document = new DOMParser().parseFromString(html, "text/html");
        expect(document.querySelector("svg, animate")).toBeNull();
        expect(document.querySelectorAll("img")).toHaveLength(1);
        expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
        expect(document.body.textContent).toContain("Visible text");
    });

    it("does not carry CSS resource loads from copied markup", () => {
        const html = sanitizeRichHtml(`
            <style>.remote { background: image-set(url(https://example.com/track.png)); }</style>
            <p class="remote" style="background-image: u\\72l(https://example.com/track.png)">Text</p>
        `);

        const paragraph = firstElement(html);
        expect(paragraph.getAttribute("style")).toBeNull();
        expect(paragraph.textContent).toBe("Text");
    });

    it("does not request remote or local-network images while displaying copied rich text", () => {
        const html = sanitizeRichHtml(`
            <img src="http://127.0.0.1:8080/run" alt="local">
            <img src="https://example.com/track.png" alt="remote">
            <img src="data:image/png;base64,AA==" alt="embedded">
        `);

        const images = new DOMParser().parseFromString(html, "text/html").querySelectorAll("img");
        expect(images).toHaveLength(1);
        expect(images[0].getAttribute("alt")).toBe("embedded");
    });

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
