import { useLayoutEffect, useRef } from "react";
import { getContrastRatio } from "@mui/material/styles";

function prefersDarkCanvas(color: string): boolean | null {
    // Computed CSS resolves named colors and HSL to RGB. Leave unsupported color
    // spaces alone rather than rewriting copied formatting to guess at them.
    if (!/^rgba?\(/.test(color)) return null;
    return getContrastRatio(color, "#000") > getContrastRatio(color, "#fff");
}

function hasOpaqueBackground(color: string): boolean {
    if (!color || color === "transparent") return false;
    return !color.startsWith("rgba(") || /,\s*1\s*\)$/.test(color);
}

function defaultCanvas(root: HTMLElement): "light" | "dark" {
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (element: Element) => {
        let style = styles.get(element);
        if (!style) {
            style = getComputedStyle(element);
            styles.set(element, style);
        }
        return style;
    };
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let light = 0;
    let dark = 0;
    let sampled = 0;
    let node: Node | null;
    // Only new rich HTML triggers this bounded sample, not hover or theme changes.
    while ((node = walker.nextNode()) && sampled < 128) {
        const weight = node.textContent?.trim().length || 0;
        if (!weight || !node.parentElement) continue;
        sampled += 1;
        let hasInk = false;
        let background: string | null = null;
        for (let element: HTMLElement | null = node.parentElement; element && element !== root; element = element.parentElement) {
            const ink = element.style.color;
            const fill = element.style.getPropertyValue("-webkit-text-fill-color");
            hasInk ||= Boolean(ink && !["inherit", "unset", "currentcolor"].includes(ink.toLowerCase()))
                || Boolean(fill && !["inherit", "unset", "currentcolor"].includes(fill.toLowerCase()));
            const color = styleOf(element).backgroundColor;
            if (!background && hasOpaqueBackground(color)) background = color;
        }
        // A copied foreground/background pair already supplies its own canvas.
        if (hasInk && background) continue;
        const style = styleOf(node.parentElement);
        const fill = style.getPropertyValue("-webkit-text-fill-color");
        const ink = fill && fill !== "currentcolor" ? fill : style.color;
        const prefersDark = background
            ? prefersDarkCanvas(background) === false
            : hasInk && prefersDarkCanvas(ink) === true;
        if (prefersDark) dark += weight;
        else light += weight;
    }
    return dark > light ? "dark" : "light";
}

export function applyRichPreviewCanvas(root: HTMLElement) {
    root.dataset.richCanvas = defaultCanvas(root);
}

export function useRichPreviewCanvas(html?: string) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (html !== undefined && ref.current) {
            applyRichPreviewCanvas(ref.current);
        }
    }, [html]);
    return ref;
}
