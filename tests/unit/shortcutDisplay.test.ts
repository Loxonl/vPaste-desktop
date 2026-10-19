import { describe, expect, it } from "vitest";
import { formatShortcutLabel, getModifierDisplayLabel } from "../../src/shortcutDisplay";

describe("shortcut display labels", () => {
    it("shows the Windows key as Win on Windows", () => {
        expect(formatShortcutLabel("Command+Shift+V", false)).toBe("Win + Shift + V");
        expect(formatShortcutLabel("Meta+V", false)).toBe("Win + V");
        expect(formatShortcutLabel("Super+V", false)).toBe("Win + V");
        expect(getModifierDisplayLabel("cmd", false)).toBe("Win");
    });

    it("keeps Command on macOS", () => {
        expect(formatShortcutLabel("Command+Shift+V", true)).toBe("Command + Shift + V");
        expect(formatShortcutLabel("Super+V", true)).toBe("Command + V");
    });
});

describe("Windows-key shortcut labels", () => {
    it.each(["Command", "Meta", "Cmd", "Super", "Win", "Windows"])("shows the persisted %s alias as Win on Windows", modifier => {
        expect(formatShortcutLabel(`${modifier}+V`, false)).toBe("Win + V");
        expect(formatShortcutLabel(`${modifier}+V`, true)).toBe("Command + V");
    });
});
