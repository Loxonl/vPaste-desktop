import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAppTheme } from "../../../src/ui/appTheme";

const [lightCss, darkCss] = readFileSync("src/ui/tokens.css", "utf8")
    .split(':root[data-theme="dark"]');

function tokens(css: string) {
    return Object.fromEntries(
        Array.from(css.matchAll(/(--[\w-]+):\s*([^;]+);/g), match => [match[1], match[2].trim()]),
    );
}

describe.each([
    { mode: "light" as const, css: lightCss, cardAlpha: "0.06", menuAlpha: "0.12", dialogAlpha: "0.14" },
    { mode: "dark" as const, css: darkCss, cardAlpha: "0.18", menuAlpha: "0.28", dialogAlpha: "0.32" },
])("$mode elevation", ({ mode, css, cardAlpha, menuAlpha, dialogAlpha }) => {
    it("keeps clipboard selection at card elevation without a colored glow", () => {
        const values = tokens(css);
        expect(values["--ui-clipboard-card-shadow"]).toBe(`0 2px 6px rgba(0, 0, 0, ${cardAlpha})`);
        expect(values["--ui-clipboard-card-selected-shadow"]).toBe("var(--ui-clipboard-card-shadow)");
        expect(values["--ui-clipboard-queue-selected-shadow"]).toBe("var(--ui-clipboard-card-shadow)");
    });

    it("keeps circular toolbar surfaces with restrained default and hover elevation", () => {
        const values = { ...tokens(lightCss), ...tokens(css) };
        const dark = mode === "dark";
        const edge = dark ? "rgba(255, 255, 255, 0.08)" : "rgba(31, 38, 36, 0.05)";
        expect(values["--ui-clipboard-header-control-surface"]).toBe(dark
            ? "rgba(33, 38, 45, 0.64)" : "rgba(255, 255, 255, 0.72)");
        expect(values["--ui-clipboard-header-control-hover-surface"]).toBe(dark
            ? "rgba(45, 51, 60, 0.82)" : "rgba(255, 255, 255, 0.92)");
        expect(values["--ui-clipboard-header-control-shadow"]).toBe(
            `0 1px 3px rgba(0, 0, 0, ${dark ? "0.24" : "0.09"}), inset 0 0 0 1px ${edge}`,
        );
        expect(values["--ui-clipboard-header-control-hover-shadow"]).toBe(
            `0 2px 5px rgba(0, 0, 0, ${dark ? "0.28" : "0.10"}), inset 0 0 0 1px ${edge}`,
        );
        expect(createAppTheme(mode).components?.MuiIconButton?.styleOverrides?.root).toMatchObject({
            "&.Mui-focusVisible:hover": { boxShadow: "var(--ui-focus-ring)" },
        });
    });

    it("keeps preview media and pinned controls at small elevations", () => {
        const values = { ...tokens(lightCss), ...tokens(css) };
        const alpha = mode === "dark" ? "0.18" : "0.08";
        expect(values["--ui-preview-media-shadow"]).toBe(`0 2px 8px rgba(0, 0, 0, ${alpha})`);
        expect(values["--ui-preview-pin-shadow"]).toBe(`0 1px 3px rgba(0, 0, 0, ${alpha})`);
        expect(values["--ui-preview-pin-active-shadow"]).toBe("var(--ui-preview-pin-shadow)");
    });

    it("separates compact menu shadows from dialog shadows", () => {
        const values = tokens(css);
        expect(values["--ui-shadow-menu"]).toBe(`0 4px 12px rgba(0, 0, 0, ${menuAlpha})`);
        expect(values["--ui-shadow-dialog"]).toBe(`0 8px 24px rgba(0, 0, 0, ${dialogAlpha})`);
    });

    it("applies the shared elevation and edge to MUI menus and dialogs", () => {
        const theme = createAppTheme(mode);
        expect(theme.components?.MuiMenu?.styleOverrides?.paper).toMatchObject({
            boxShadow: "var(--ui-shadow-menu)",
            borderRadius: "var(--ui-radius-control)",
        });
        expect(theme.components?.MuiDialog?.styleOverrides?.paper).toMatchObject({
            boxShadow: "var(--ui-shadow-dialog)",
            border: "1px solid var(--ui-border)",
            borderRadius: "var(--ui-radius-surface)",
        });
    });

    it("preserves the narrow auxiliary-window shadow and focus visibility", () => {
        const values = tokens(css);
        expect(values["--ui-window-shadow"]).toBe(mode === "light"
            ? "0 2px 6px rgba(17, 24, 39, 0.24), 0 0 0 1px rgba(26, 35, 46, 0.10)"
            : "0 2px 6px rgba(0, 0, 0, 0.48), 0 0 0 1px rgba(255, 255, 255, 0.10)");
        expect(values["--ui-focus-ring"]).toContain("0 0 0 3px");
        expect(tokens(lightCss)["--ui-radius-window"]).toBe("12px");
    });
});
