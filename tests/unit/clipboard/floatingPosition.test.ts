import { describe, expect, it } from "vitest";
import {
    CONTEXT_MENU_GAP,
    VIEWPORT_MARGIN,
    clampToScreen,
    clampToViewport,
    contextMenuHeight,
    floatingPositionFromClick,
    screenAnchoredPositionFromClick,
    screenFloatingPositionFromClick,
    type ScreenMetrics,
} from "../../../src/clipboard/floatingPosition";

const screenMetrics: ScreenMetrics = {
    screenX: -1500,
    screenY: 100,
    availLeft: -1920,
    availTop: 0,
    availWidth: 1920,
    availHeight: 1080,
};

describe("clipboard floating positioning", () => {
    it("keeps floating surfaces inside viewport margins", () => {
        expect(clampToViewport(-20, 188, 1000)).toBe(VIEWPORT_MARGIN);
        expect(clampToViewport(980, 188, 1000)).toBe(804);
        expect(clampToViewport(400, 188, 1000)).toBe(400);
    });

    it("uses one row as the minimum context-menu height", () => {
        expect(contextMenuHeight(0)).toBe(44);
        expect(contextMenuHeight(1)).toBe(44);
        expect(contextMenuHeight(3)).toBe(112);
    });

    it("places click popovers above the click and clamps both axes", () => {
        expect(floatingPositionFromClick(990, 10, 188, 112, {
            width: 1000,
            height: 700,
        })).toEqual({ x: 804, y: VIEWPORT_MARGIN });

        expect(floatingPositionFromClick(300, 500, 188, 112, {
            width: 1000,
            height: 700,
        })).toEqual({
            x: 300 + CONTEXT_MENU_GAP,
            y: 500 - 112 - CONTEXT_MENU_GAP,
        });
    });

    it("clamps coordinates within a screen that starts at a negative origin", () => {
        expect(clampToScreen(-2000, 286, -1920, 1920)).toBe(-1912);
        expect(clampToScreen(0, 286, -1920, 1920)).toBe(-294);
    });

    it("preserves floating and anchored multi-screen coordinate formulas", () => {
        expect(screenFloatingPositionFromClick(200, 300, 286, 398, screenMetrics))
            .toEqual({ x: -1294, y: VIEWPORT_MARGIN });
        expect(screenAnchoredPositionFromClick(200, 300, 286, 178, screenMetrics))
            .toEqual({ x: -1294, y: 222 });
    });
});
