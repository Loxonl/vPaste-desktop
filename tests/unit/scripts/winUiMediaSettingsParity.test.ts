import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tokens from "../../../src/ui/motion/tokens.json";
import { ensureWhiteTextContrast } from "../../../src/clipboard/clipboardHeaderColor";

const source = (path: string) => readFileSync(resolve(path), "utf8");

describe("native media and settings parity contracts", () => {
    it("retains the reference neutral header when source artwork has no dominant color", () => {
        const panel = source("src-tauri/native-demo/windows/winui/WinUiPanel.cpp");
        expect(panel.includes("CardHeaderBrush(")).toBe(true);
        for (const color of ["#747c87", "#565e68"]) {
            const rgb = ensureWhiteTextContrast(color).match(/\d+/g)!.map(Number);
            expect(panel.includes(`Rgb(${rgb.join(", ")})`)).toBe(true);
        }
    });
    it("keeps the quick tab spring with less than one percent overshoot", () => {
        const { stiffness, damping, mass } = tokens.spring.tabIndicator;
        const ratio = damping / (2 * Math.sqrt(stiffness * mass));
        const overshoot = Math.exp(-Math.PI * ratio / Math.sqrt(1 - ratio * ratio));
        expect(overshoot).toBeLessThan(0.01);
        expect(ratio).toBeLessThan(1);
        expect(2 * Math.PI * Math.sqrt(mass / stiffness)).toBeLessThan(0.13);
    });

    it("uses WebView2 caption regions without a second Windows mouse-down drag owner", () => {
        const config = source("src/config/Config.tsx");
        const css = source("src/config/ConfigLayout.module.css");
        expect(config).toContain("nativeWindowsSurface ? undefined :");
        expect(css).toContain(".nativeWindowsSurface .dragRegion");
        expect(css).toContain("-webkit-app-region: drag");
        expect(source("src-tauri/src/main.rs")).not.toContain("config_window_drag::start_config_window_drag");
    });
});
