import { describe, expect, it } from "vitest";
import {
    clampQueueDragOffset,
    queueOrderForOffset,
    queueVerticalTransforms,
    type QueueRowMetric,
} from "../../../src/clipboard/pasteQueueDrag";

const metrics: QueueRowMetric[] = [
    { hash: "first", top: 10, height: 60 },
    { hash: "second", top: 70, height: 70 },
    { hash: "third", top: 140, height: 50 },
];

describe("paste queue vertical dragging", () => {
    it("clamps the dragged row to the vertical list bounds", () => {
        expect(clampQueueDragOffset(metrics, "second", -200)).toBe(-60);
        expect(clampQueueDragOffset(metrics, "second", 200)).toBe(50);
    });

    it("reorders continuously when the dragged center crosses another row", () => {
        expect(queueOrderForOffset(metrics, "first", 80)).toEqual([
            "second",
            "first",
            "third",
        ]);
        expect(queueOrderForOffset(metrics, "third", -200)).toEqual([
            "third",
            "first",
            "second",
        ]);
    });

    it("moves every row on the Y axis while neighboring rows make space", () => {
        const order = ["second", "first", "third"];
        expect(queueVerticalTransforms(metrics, order, "first", 80)).toEqual({
            first: 80,
            second: -60,
            third: 0,
        });
    });
});
