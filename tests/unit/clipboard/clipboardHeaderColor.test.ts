import { describe, expect, it } from "vitest";
import {
    ensureWhiteTextContrast,
    MIN_WHITE_TEXT_CONTRAST,
    whiteTextContrastRatio,
} from "../../../src/clipboard/clipboardHeaderColor";

describe("clipboard header colors", () => {
    it("minimally darkens a light color until white text is readable", () => {
        const result = ensureWhiteTextContrast("rgb(250, 220, 80)");

        expect(result).not.toBe("rgb(250, 220, 80)");
        expect(whiteTextContrastRatio(result)).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
    });

    it("keeps an already accessible dark color unchanged", () => {
        expect(ensureWhiteTextContrast("rgb(31, 41, 51)")).toBe("rgb(31, 41, 51)");
    });

    it.each(["#4CAF50", "#FF9800", "#2f6fed", "#66c2ff", "#2196F3", "#00BCD4"])(
        "makes the default %s header color safe for white text",
        color => {
            const result = ensureWhiteTextContrast(color);
            expect(whiteTextContrastRatio(result)).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
        },
    );

    it("uses an accessible dark fallback for an invalid color", () => {
        const result = ensureWhiteTextContrast("not-a-color");

        expect(result).toBe("rgb(86, 94, 104)");
        expect(whiteTextContrastRatio(result)).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
    });

    it("makes a translucent light color safe against a light card background", () => {
        const result = ensureWhiteTextContrast("rgba(40, 90, 140, 0.4)");

        expect(whiteTextContrastRatio(result)).toBeGreaterThanOrEqual(MIN_WHITE_TEXT_CONTRAST);
    });
});
