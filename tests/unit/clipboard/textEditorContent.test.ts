import { describe, expect, it } from "vitest";
import { sanitizeEditorHtml, serializeRichDraft } from "../../../src/clipboard/textEditorContent";

describe("rich text editing", () => {
    it("retains basic formatting, class styles, links and table structure while blocking active content", () => {
        const html = sanitizeEditorHtml('<style>.red{color:red;font-weight:bold}</style><p class="red" onclick="alert(1)">原文 <a href="https://example.com/">链接</a></p><script>alert(1)</script><iframe src="https://example.com"></iframe><img src="https://example.com/tracker"><a href="javascript:alert(1)">unsafe</a><table><tr><td>cell</td></tr></table>');
        const paragraph = new DOMParser().parseFromString(html, "text/html").querySelector("p")!;
        expect(paragraph.style.fontWeight).toBe("bold");
        expect(paragraph.style.color).toBe("red");
        expect(html).toContain('href="https://example.com/"');
        expect(html).toContain("<table>");
        expect(html).not.toMatch(/<script|<iframe|onclick|javascript:|tracker|class=/);
    });
    it("keeps leading blank lines and whitespace rather than trimming a preview", () => {
        const html = '<p><br></p><p>  缩进 </p>';
        expect(sanitizeEditorHtml(html)).toBe(html);
    });
    it("emits fresh matching text and RTF with color, bold, links and Chinese/surrogate escapes", () => {
        const result = serializeRichDraft('<p><strong style="color:rgb(255,0,0)">更新中文😀</strong> <a href="https://example.com/">link</a></p><p>second</p>');
        expect(result.text).toBe("更新中文😀 link\nsecond");
        expect(result.rtf).toContain("\\b1");
        expect(result.rtf).toContain("\\red255\\green0\\blue0;");
        expect(result.rtf).toContain("HYPERLINK");
        expect(result.rtf).toContain("\\u-10179?\\u-8704?");
        expect(result.html).toContain("更新中文😀");
    });
    it("keeps explicit trailing line breaks, tab-separated cells and literal RTF characters", () => {
        expect(serializeRichDraft('<div>one</div><div><br></div>').text).toBe("one\n\n");
        const result = serializeRichDraft('<table><tr><td>{a}</td><td>\\b</td></tr></table>');
        expect(result.text).toBe("{a}\t\\b");
        expect(result.rtf).toContain("\\{a\\}");
        expect(result.rtf).toContain("\\\\b");
    });
    it("retains inline PNG data in both formats and refuses to drop unsupported image formats", () => {
        const result = serializeRichDraft('<span>text</span><img src="data:image/png;base64,iVBORw0KGgo=">');
        expect(result.html).toContain("data:image/png;base64,");
        expect(result.rtf).toContain("\\pict\\pngblip 89504e470d0a1a0a");
        expect(() => serializeRichDraft('<span>text</span><img src="data:image/webp;base64,AAAA">')).toThrow("editor.richImageUnsupported");
    });
});
