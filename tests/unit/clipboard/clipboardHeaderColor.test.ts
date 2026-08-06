import { describe, expect, it } from "vitest";
import {
    dominantColorFromPixels,
    ensureWhiteTextContrast,
    MIN_WHITE_TEXT_CONTRAST,
    whiteTextContrastRatio,
} from "../../../src/clipboard/clipboardHeaderColor";

function pixels(...groups: Array<{ color: [number, number, number, number]; count: number }>): Uint8Array {
    return Uint8Array.from(groups.flatMap(group =>
        Array.from({ length: group.count }, () => group.color).flat(),
    ));
}

describe("clipboard header colors", () => {
    it("prefers a large representative area over a small vivid accent", () => {
        const data = pixels(
            { color: [168, 223, 233, 255], count: 400 },
            { color: [239, 190, 10, 255], count: 120 },
            { color: [210, 210, 210, 255], count: 1080 },
        );

        expect(dominantColorFromPixels(data)).toBe("rgb(168, 223, 233)");
    });

    it("prefers saturation when the top areas are within eighty percent", () => {
        const data = pixels(
            { color: [179, 209, 250, 255], count: 800 },
            { color: [51, 136, 255, 255], count: 720 },
            { color: [210, 210, 210, 255], count: 80 },
        );

        expect(dominantColorFromPixels(data)).toBe("rgb(51, 136, 255)");
    });

    it("uses a stable tie-breaker across all equal-area candidates", () => {
        const data = pixels(
            { color: [135, 79, 255, 255], count: 400 },
            { color: [255, 114, 55, 255], count: 400 },
            { color: [255, 55, 55, 255], count: 400 },
            { color: [210, 210, 210, 255], count: 400 },
        );

        expect(dominantColorFromPixels(data)).toBe("rgb(255, 55, 55)");
    });

    it("ignores a tiny accent on an otherwise neutral icon", () => {
        const data = pixels(
            { color: [230, 20, 40, 255], count: 20 },
            { color: [210, 210, 210, 255], count: 1580 },
        );

        expect(dominantColorFromPixels(data)).toBeNull();
    });

    it.each([
        ["WeChat green", "rgb(6, 199, 98)"],
        ["File Explorer yellow", "rgb(255, 207, 73)"],
    ])("keeps the %s brand color unchanged", (_name, color) => {
        expect(ensureWhiteTextContrast(color)).toBe(color);
    });

    it("minimally darkens a color below the header contrast floor", () => {
        const result = ensureWhiteTextContrast("rgb(255, 255, 255)");
        const contrast = whiteTextContrastRatio(result);

        expect(result).not.toBe("rgb(255, 255, 255)");
        expect(contrast).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
        expect(contrast).toBeLessThan(1.42);
    });

    it("keeps an already dark color unchanged", () => {
        expect(ensureWhiteTextContrast("rgb(31, 41, 51)")).toBe("rgb(31, 41, 51)");
    });

    it.each(["#4CAF50", "#FF9800", "#2f6fed", "#66c2ff", "#2196F3", "#00BCD4"])(
        "keeps the default %s header color above the visual contrast floor",
        color => {
            const result = ensureWhiteTextContrast(color);
            expect(whiteTextContrastRatio(result)).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
        },
    );

    it("uses a stable dark fallback for an invalid color", () => {
        const result = ensureWhiteTextContrast("not-a-color");

        expect(result).toBe("rgb(86, 94, 104)");
        expect(whiteTextContrastRatio(result)).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
    });

    it("keeps a translucent light color above the visual contrast floor", () => {
        const result = ensureWhiteTextContrast("rgba(40, 90, 140, 0.4)");

        expect(whiteTextContrastRatio(result)).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
    });
});
