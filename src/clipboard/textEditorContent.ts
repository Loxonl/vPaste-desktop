import { sanitizeRichHtml } from "./richPreview";

export type TextDocument = { id: number; hash: string; revision: string; text: string; html: string };

export const sanitizeEditorHtml = (html: string) => sanitizeRichHtml(html, Number.POSITIVE_INFINITY, true);

export function prepareRichEditorHtml(html: string): string {
    const content = sanitizeEditorHtml(html);
    if (!content.trim()) throw new Error("editor.richUnavailable");
    const original = new DOMParser().parseFromString(html, "text/html");
    original.querySelectorAll("script,style").forEach(node => node.remove());
    const comparable = (text: string) => text.replace(/\s+/g, "");
    // text/plain may contain Markdown while HTML contains its rendered document.
    if (comparable(serializeRichDraft(content).text) !== comparable(original.body.textContent || "")) {
        throw new Error("editor.richUnavailable");
    }
    return content;
}

function rtfEscape(text: string): string {
    let result = "";
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        const character = text[index];
        if (character === "\r") continue;
        if (character === "\n") result += "\\line ";
        else if (character === "\t") result += "\\tab ";
        else if (/[\\{}]/.test(character)) result += `\\${character}`;
        else if (code > 127) result += `\\u${code > 32767 ? code - 65536 : code}?`;
        else result += character;
    }
    return result;
}

// One traversal produces matching text and RTF, including Chinese UTF-16 escapes.
export function serializeRichDraft(rawHtml: string): { html: string; text: string; rtf: string } {
    const html = sanitizeEditorHtml(rawHtml);
    const root = new DOMParser().parseFromString(html, "text/html").body;
    const fonts = ["Segoe UI"];
    const colors: string[] = [];
    const colorIds = new Map<string, number>();
    const colorId = (value: string) => {
        if (!value || value === "transparent") return 0;
        if (colorIds.has(value)) return colorIds.get(value)!;
        const probe = document.createElement("span");
        probe.style.color = value;
        probe.hidden = true;
        document.body.appendChild(probe);
        const components = getComputedStyle(probe).color.match(/[\d.]+/g);
        probe.remove();
        if (!components || components.length < 3) return 0;
        colors.push(`\\red${Math.round(+components[0])}\\green${Math.round(+components[1])}\\blue${Math.round(+components[2])};`);
        colorIds.set(value, colors.length);
        return colors.length;
    };
    let text = "";
    let body = "";
    let trailingBlockBreak = false;
    const append = (value: string) => {
        text += value;
        body += rtfEscape(value);
        trailingBlockBreak = false;
    };
    const blockBreak = () => {
        if (text && !text.endsWith("\n")) {
            append("\n");
            trailingBlockBreak = true;
        }
    };
    const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) { append(node.textContent || ""); return; }
        if (!(node instanceof HTMLElement)) return;
        const tag = node.tagName.toLowerCase();
        if (tag === "br") { append("\n"); return; }
        if (tag === "img") {
            const match = (node.getAttribute("src") || "").match(/^data:image\/(png|jpeg);base64,(.+)$/i);
            if (!match) throw new Error("editor.richImageUnsupported");
            const hex = Array.from(atob(match[2]), character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
            body += `{\\pict\\${match[1].toLowerCase() === "png" ? "pngblip" : "jpegblip"} ${hex}}`;
            return;
        }
        const block = /^(?:div|p|h[1-6]|li|blockquote|pre|tr)$/.test(tag);
        if (block) blockBreak();
        if ((tag === "td" || tag === "th") && node.previousElementSibling) append("\t");
        const style = node.style;
        let commands = "";
        if (tag === "b" || tag === "strong" || style.fontWeight) commands += `\\b${tag === "b" || tag === "strong" || style.fontWeight === "bold" || +style.fontWeight >= 600 ? 1 : 0}`;
        if (tag === "i" || tag === "em" || style.fontStyle) commands += `\\i${tag === "i" || tag === "em" || style.fontStyle === "italic" ? 1 : 0}`;
        if (["u", "s", "strike", "del"].includes(tag) || style.textDecoration) {
            commands += `\\ul${tag === "u" || style.textDecoration.includes("underline") ? 1 : 0}`;
            commands += `\\strike${["s", "strike", "del"].includes(tag) || style.textDecoration.includes("line-through") ? 1 : 0}`;
        }
        const color = style.color || node.getAttribute("color") || "";
        if (color) commands += `\\cf${colorId(color)}`;
        if (style.backgroundColor) commands += `\\highlight${colorId(style.backgroundColor)}`;
        const font = (style.fontFamily || node.getAttribute("face") || "").split(",")[0].replace(/["';{}\\]/g, "").trim();
        if (font) {
            if (!fonts.includes(font)) fonts.push(font);
            commands += `\\f${fonts.indexOf(font)}`;
        }
        const size = Number.parseFloat(style.fontSize);
        if (size > 0) commands += `\\fs${Math.round(size * (style.fontSize.endsWith("px") ? 1.5 : 2))}`;
        if (style.textAlign) commands += ({ center: "\\qc", right: "\\qr", justify: "\\qj", left: "\\ql" }[style.textAlign] || "");
        const href = tag === "a" ? node.getAttribute("href") : null;
        body += href ? `{\\field{\\*\\fldinst HYPERLINK "${rtfEscape(href)}"}{\\fldrslt ` : "{";
        if (commands) body += `${commands} `;
        node.childNodes.forEach(visit);
        body += href ? "}}" : "}";
        if (block) blockBreak();
    };
    root.childNodes.forEach(visit);
    if (trailingBlockBreak) {
        text = text.slice(0, -1);
        // Leave the final paragraph terminator in RTF, as native editors do.
    }
    const fontTable = fonts.map((font, index) => `{\\f${index} ${rtfEscape(font)};}`).join("");
    return { html, text, rtf: `{\\rtf1\\ansi\\deff0\\uc1{\\fonttbl${fontTable}}{\\colortbl;${colors.join("")}}${body}}` };
}
