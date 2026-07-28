import { describe, expect, it } from "vitest";
import {
    WHEEL_MOUSE_TIME_CONSTANT_MS,
    WHEEL_PRECISION_TIME_CONSTANT_MS,
    clampDragVelocity,
    nextWheelScrollTarget,
    normalizeWheelDelta,
    pointerDragIntent,
    pointerDragVelocity,
    quickInputAction,
    wheelAnimationFrame,
    wheelTimeConstant,
    isTextInputTarget,
    matchesKeyboardShortcut,
} from "../../../src/clipboard/clipboardInteractions";

describe("clipboard input interactions", () => {
    it("normalizes pixel, line, and page wheel deltas", () => {
        expect(normalizeWheelDelta(new WheelEvent("wheel", {
            deltaX: 3,
            deltaY: 12,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        }), 800)).toEqual({ delta: 12, rawDelta: 12 });

        expect(normalizeWheelDelta(new WheelEvent("wheel", {
            deltaY: -2,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
        }), 800)).toEqual({ delta: -80, rawDelta: -2 });

        expect(normalizeWheelDelta(new WheelEvent("wheel", {
            deltaY: 1,
            deltaMode: WheelEvent.DOM_DELTA_PAGE,
        }), 800)).toEqual({ delta: 800, rawDelta: 1 });
    });

    it("resets opposing wheel momentum and clamps the target", () => {
        expect(nextWheelScrollTarget(500, 400, -80, 1000)).toBe(320);
        expect(nextWheelScrollTarget(500, 400, 80, 1000)).toBe(580);
        expect(nextWheelScrollTarget(980, 970, 80, 1000)).toBe(1000);
        expect(nextWheelScrollTarget(20, 30, -80, 1000)).toBe(0);
    });

    it("uses precision timing for trackpad-like input", () => {
        expect(wheelTimeConstant(12.5, WheelEvent.DOM_DELTA_PIXEL, 30))
            .toBe(WHEEL_PRECISION_TIME_CONSTANT_MS);
        expect(wheelTimeConstant(70, WheelEvent.DOM_DELTA_PIXEL, 10))
            .toBe(WHEEL_PRECISION_TIME_CONSTANT_MS);
        expect(wheelTimeConstant(120, WheelEvent.DOM_DELTA_PIXEL, 30))
            .toBe(WHEEL_MOUSE_TIME_CONSTANT_MS);
        expect(wheelTimeConstant(1, WheelEvent.DOM_DELTA_LINE, 10))
            .toBe(WHEEL_MOUSE_TIME_CONSTANT_MS);
    });

    it("calculates wheel animation progress and completion", () => {
        const moving = wheelAnimationFrame(100, 200, 16, WHEEL_MOUSE_TIME_CONSTANT_MS);
        expect(moving.complete).toBe(false);
        expect(moving.scrollLeft).toBeGreaterThan(100);
        expect(moving.scrollLeft).toBeLessThan(200);

        expect(wheelAnimationFrame(199.8, 200, 16, WHEEL_MOUSE_TIME_CONSTANT_MS))
            .toEqual({ scrollLeft: 200, complete: true });
    });

    it("classifies pointer movement without changing the drag threshold", () => {
        expect(pointerDragIntent(10, 10, 13, 13)).toBe("pending");
        expect(pointerDragIntent(10, 10, 12, 20)).toBe("vertical");
        expect(pointerDragIntent(10, 10, 20, 12)).toBe("horizontal");
        expect(pointerDragVelocity(16, 4)).toBe(-32);
        expect(clampDragVelocity(100)).toBe(42);
        expect(clampDragVelocity(-100)).toBe(-42);
    });

    it("matches configured shortcuts with exact modifiers", () => {
        expect(matchesKeyboardShortcut(new KeyboardEvent("keydown", {
            key: "Enter",
            shiftKey: true,
        }), "Shift+Enter")).toBe(true);
        expect(matchesKeyboardShortcut(new KeyboardEvent("keydown", {
            key: "Enter",
            shiftKey: true,
            ctrlKey: true,
        }), "Shift+Enter")).toBe(false);
        expect(matchesKeyboardShortcut(new KeyboardEvent("keydown", {
            key: "Escape",
        }), "Esc")).toBe(true);
    });

    it("recognizes text-entry targets", () => {
        const input = document.createElement("input");
        const textarea = document.createElement("textarea");
        const select = document.createElement("select");
        const editable = document.createElement("div");
        Object.defineProperty(editable, "isContentEditable", { value: true });

        expect(isTextInputTarget(input)).toBe(true);
        expect(isTextInputTarget(textarea)).toBe(true);
        expect(isTextInputTarget(select)).toBe(true);
        expect(isTextInputTarget(editable)).toBe(true);
        expect(isTextInputTarget(document.createElement("button"))).toBeFalsy();
    });

    it("keeps Windows and macOS quick-input mappings distinct", () => {
        expect(quickInputAction(new KeyboardEvent("keydown", {
            key: "a",
            code: "KeyA",
        }), false)).toEqual({ kind: "tab", tabId: "all" });
        expect(quickInputAction(new KeyboardEvent("keydown", {
            key: "f",
            code: "KeyF",
        }), true)).toEqual({ kind: "tab", tabId: "favorite" });
        expect(quickInputAction(new KeyboardEvent("keydown", {
            key: "1",
            code: "Digit1",
        }), true)).toEqual({ kind: "item", index: 0 });
        expect(quickInputAction(new KeyboardEvent("keydown", {
            key: "0",
            code: "Digit0",
        }), false)).toBeNull();
    });
});
