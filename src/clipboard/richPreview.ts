const SAFE_RICH_ATTRIBUTES = new Set([
    "alt", "align", "border", "cellpadding", "cellspacing", "class", "colspan",
    "dir", "height", "lang", "rowspan", "style", "title", "valign", "width",
]);

function safeRichImageSource(value: string): boolean {
    const source = value.trim();
    return /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,[a-z0-9+/=]+$/i.test(source);
}

function hasExternalCssResource(value: string): boolean {
    return /\\|\/\*|url\s*\(|image-set\s*\(|expression\s*\(|@import/i.test(value);
}

export function sanitizeRichHtml(html: string, maxWidthPx = 160): string {
    if (!html.trim()) return "";
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    document.querySelectorAll(
        "script, iframe, frame, object, embed, link, meta, base, svg, math, template, audio, video, source, track, canvas, input, button, select, textarea",
    ).forEach(node => node.remove());
    document.querySelectorAll("style").forEach(node => {
        node.textContent = (node.textContent || "")
            .replace(/mso-pattern\s*:[^;{}]+;?/gi, "");
    });
    document.querySelectorAll("form").forEach(node => {
        node.replaceWith(...Array.from(node.childNodes));
    });
    applyRichClassStyles(document);
    document.querySelectorAll("style").forEach(node => node.remove());
    document.querySelectorAll<HTMLElement>("*").forEach(element => {
        const tag = element.tagName.toLowerCase();
        Array.from(element.attributes).forEach(attribute => {
            const name = attribute.name.toLowerCase();
            if (tag === "img" && name === "src" && !safeRichImageSource(attribute.value)) {
                element.remove();
                return;
            }
            if (name === "style" && hasExternalCssResource(attribute.value)) {
                element.removeAttribute(attribute.name);
                return;
            }
            if (!(tag === "img" && name === "src" && safeRichImageSource(attribute.value))
                && !SAFE_RICH_ATTRIBUTES.has(name)) {
                element.removeAttribute(attribute.name);
            }
        });
        normalizeRichPreviewStyle(element, maxWidthPx);
    });
    const root = document.body.firstElementChild;
    if (root) {
        unwrapSingleLeadingLayoutContainers(root);
        trimLeadingEmptyRichBlocks(root);
    }
    return document.body.firstElementChild?.innerHTML || "";
}

function normalizeRichPreviewStyle(element: HTMLElement, maxWidthPx: number) {
    const style = element.getAttribute("style");
    if (!style) return;
    const nextStyle = style
        .split(";")
        .map(rule => rule.trim())
        .filter(Boolean)
        .filter(rule => {
            const [rawName, ...rawValue] = rule.split(":");
            const name = rawName.trim().toLowerCase();
            const value = rawValue.join(":").trim().toLowerCase();
            if (name === "width" && value.endsWith("in")) return false;
            if (name === "min-width" && value.endsWith("in")) return false;
            if (name === "max-width" && value.endsWith("in")) return false;
            if (name === "width" && value.endsWith("pt")) return false;
            if (
                name === "width"
                && value.endsWith("px")
                && Number.parseFloat(value) > maxWidthPx
            ) {
                return false;
            }
            if (name === "margin-left" && value.endsWith("in")) return false;
            if (name === "margin-right" && value.endsWith("in")) return false;
            if (name === "text-indent" && value.startsWith("-")) return false;
            if (name === "border-width" && value.includes("%")) return false;
            return true;
        })
        .join("; ");
    if (nextStyle) {
        element.setAttribute("style", nextStyle);
    } else {
        element.removeAttribute("style");
    }
}

function extractRichClassStyles(document: Document): Map<string, string[]> {
    const classStyles = new Map<string, string[]>();
    document.querySelectorAll("style").forEach(styleNode => {
        const css = styleNode.textContent || "";
        const classRuleRegex = /\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
        let match: RegExpExecArray | null;
        while ((match = classRuleRegex.exec(css)) !== null) {
            const className = match[1];
            const rules = match[2]
                .split(";")
                .map(rule => rule.trim())
                .filter(Boolean)
                .filter(rule => {
                    const [rawName, ...rawValue] = rule.split(":");
                    const name = rawName.trim().toLowerCase();
                    const value = rawValue.join(":").trim();
                    if (!name || !value || hasExternalCssResource(value)) return false;
                    return [
                        "background",
                        "background-color",
                        "color",
                        "font-weight",
                        "font-style",
                        "text-decoration",
                        "text-align",
                        "vertical-align",
                        "border",
                        "border-top",
                        "border-right",
                        "border-bottom",
                        "border-left",
                    ].includes(name);
                });
            if (rules.length > 0) {
                classStyles.set(className, rules);
            }
        }
    });
    return classStyles;
}

function applyRichClassStyles(document: Document) {
    const classStyles = extractRichClassStyles(document);
    if (classStyles.size === 0) return;

    document.querySelectorAll<HTMLElement>("[class]").forEach(element => {
        const existingStyle = element.getAttribute("style") || "";
        const existingNames = new Set(
            existingStyle
                .split(";")
                .map(rule => rule.split(":")[0]?.trim().toLowerCase())
                .filter(Boolean),
        );
        const nextRules: string[] = [];
        element.classList.forEach(className => {
            classStyles.get(className)?.forEach(rule => {
                const name = rule.split(":")[0]?.trim().toLowerCase();
                if (name && !existingNames.has(name)) {
                    existingNames.add(name);
                    nextRules.push(rule);
                }
            });
        });
        if (nextRules.length > 0) {
            element.setAttribute(
                "style",
                [existingStyle.trim().replace(/;$/, ""), ...nextRules]
                    .filter(Boolean)
                    .join("; "),
            );
        }
    });
}

function isEmptyLeadingRichBlock(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (!["p", "div", "span"].includes(tag)) return false;
    if (element.querySelector("img,svg,table,canvas,video")) return false;
    return (element.textContent || "").replace(/\u00a0/g, "").trim().length === 0;
}

function unwrapSingleLeadingLayoutContainers(container: Element) {
    let current = container.firstElementChild;
    while (current && current.tagName.toLowerCase() === "div") {
        const children = Array.from(current.children)
            .filter(child => child.tagName.toLowerCase() !== "style");
        const text = (current.textContent || "").replace(/\u00a0/g, "").trim();
        const style = (current.getAttribute("style") || "").toLowerCase();
        const layoutOnly = !text
            && children.length === 1
            && /direction|width|margin-left|border-width/.test(style);
        if (!layoutOnly) break;
        const child = children[0];
        current.replaceWith(child);
        current = child;
    }
}

function trimLeadingEmptyRichBlocks(container: Element) {
    let changed = true;
    while (changed) {
        changed = false;
        const firstContentChild = Array.from(container.children)
            .find(child => child.tagName.toLowerCase() !== "style");
        if (!firstContentChild) return;

        if (isEmptyLeadingRichBlock(firstContentChild)) {
            firstContentChild.remove();
            changed = true;
            continue;
        }

        const tag = firstContentChild.tagName.toLowerCase();
        if (["div", "section", "article", "blockquote", "ul", "ol"].includes(tag)) {
            const before = firstContentChild.innerHTML;
            trimLeadingEmptyRichBlocks(firstContentChild);
            if (before !== firstContentChild.innerHTML) {
                changed = true;
            }
            if (isEmptyLeadingRichBlock(firstContentChild)) {
                firstContentChild.remove();
                changed = true;
            }
        }
    }
}

export function richHtmlHasVisibleContent(html: string): boolean {
    if (!html.trim()) return false;
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = document.body.firstElementChild;
    if (!root) return false;
    const cloned = root.cloneNode(true) as HTMLElement;
    cloned.querySelectorAll("style").forEach(node => node.remove());
    return Boolean(cloned.textContent?.trim())
        || Boolean(cloned.querySelector("table,img,svg,canvas,video"));
}
