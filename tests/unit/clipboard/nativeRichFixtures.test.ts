import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeRichHtml } from "../../../src/clipboard/richPreview";

const fixture = (name: string) => readFileSync(`src-tauri/tests/fixtures/winui-rich/${name}.html`, "utf8");
const documentFor = (name: string) => new DOMParser().parseFromString(
    sanitizeRichHtml(fixture(name), 188, false, new Map([["trusted-small", "asset://localhost/approved.png"]])), "text/html");

describe("shipping WebView reference for native rich fixtures", () => {
    it("keeps Office class emphasis and nested numbered/list structure", () => {
        const document = documentFor("office");
        expect(document.querySelector("p")?.getAttribute("style")).toContain("font-size:12pt");
        expect(document.querySelector("p")?.getAttribute("style")).toContain("color:#17365d");
        expect(document.querySelectorAll("ol > li")).toHaveLength(3);
        expect(document.querySelector("ol ul li")?.textContent).toBe("确认结论");
    });
    it("retains inline precedence, decoration and approved image identity", () => {
        const document = documentFor("webpage");
        expect(document.querySelector("span")?.getAttribute("style")).toContain("color:#112233");
        expect(document.querySelectorAll("img")).toHaveLength(1);
        expect(document.querySelector("img")?.getAttribute("width")).toBe("16");
        expect(document.body.textContent).toContain("网页链接");
    });
    it("preserves code whitespace and table merged-cell structure", () => {
        expect(documentFor("code").querySelector("pre")?.textContent).toContain("\n    let label");
        const table = documentFor("table");
        expect(table.querySelector("th")?.getAttribute("colspan")).toBe("2");
        expect(table.querySelector("td")?.getAttribute("rowspan")).toBe("2");
        expect(table.body.textContent).toContain("表前");
        expect(table.body.textContent).toContain("表后");
    });
});
