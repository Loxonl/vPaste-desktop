import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const clipboardSource = readFileSync(
    join(process.cwd(), "src", "clipboard", "Clipboard.tsx"),
    "utf8",
);
const clipboardStyles = readFileSync(
    join(process.cwd(), "src", "clipboard", "Clipboard.module.css"),
    "utf8",
);

describe("paste queue selection toolbar lifecycle", () => {
    it("toggles queue activation from the main panel button", () => {
        const toggleStart = clipboardSource.indexOf("const openPasteQueueSelection");
        const toggleEnd = clipboardSource.indexOf("const addSelectedItemsToPasteQueue", toggleStart);
        const toggleSource = clipboardSource.slice(toggleStart, toggleEnd);

        expect(toggleSource).toContain('"set_paste_queue_active"');
        expect(toggleSource).toContain("{ active: !pasteQueueActive }");
        expect(toggleSource).not.toContain("if (!pasteQueueActive)");
    });

    it("is controlled by queue activation and has no independent cancel action", () => {
        expect(clipboardSource).toContain("const queueSelectionMode = pasteQueueActive;");
        expect(clipboardSource).not.toContain("cancelPasteQueueSelection");
        expect(clipboardSource).not.toContain('t("pasteQueue.cancelSelection")');
    });

    it("clears submitted selections without closing the active queue toolbar", () => {
        const submitStart = clipboardSource.indexOf("const addSelectedItemsToPasteQueue");
        const submitEnd = clipboardSource.indexOf("const restartForUpdate", submitStart);
        const submitSource = clipboardSource.slice(submitStart, submitEnd);

        expect(submitSource).toContain('await invoke("add_paste_queue_items"');
        expect(submitSource).toContain("setQueueSelectedHashes([])");
        expect(submitSource).not.toContain("setPasteQueueActive(false)");
        expect(submitSource).not.toContain("setQueueSelectionMode(false)");
    });

    it("uses only the outer outline for selected queue cards", () => {
        const rules = [...clipboardStyles.matchAll(
            /(?:^|\s)\.cards-container\.queue-selection-mode \.clipboard-card\.selected\s*\{([^}]*)\}/gm,
        )].map(match => match[1]);

        expect(rules.length).toBeGreaterThan(0);
        expect(rules.every(rule => rule.includes("box-shadow:"))).toBe(true);
        expect(rules.every(rule => !rule.includes("inset"))).toBe(true);
    });
});
