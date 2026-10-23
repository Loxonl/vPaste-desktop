import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import catalog from "../../fixtures/office/catalog.json";

describe("shared Office case catalog", () => {
    it("maps every scenario to maintained regressions and manual acceptance steps", () => {
        const sources = [
            "src-tauri/src/clipboard/mod.rs", "src-tauri/src/clipboard/windows/listen.rs",
            "src-tauri/src/paste_queue.rs", "src-tauri/src/test_room.rs",
            "tests/visual/clipboard-rich-contrast.spec.ts",
        ].map(path => readFileSync(resolve(path), "utf8")).join("\n");
        expect(new Set(catalog.cases.map(testCase => testCase.id)).size).toBe(catalog.cases.length);
        expect(new Set(catalog.cases.map(testCase => testCase.code)).size).toBe(catalog.cases.length);
        for (const testCase of catalog.cases) {
            expect(testCase.manualSteps.length).toBeGreaterThan(0);
            expect(testCase.automatedTests.length).toBeGreaterThan(0);
            for (const regression of testCase.automatedTests) {
                expect(sources, `${testCase.code} references a missing regression: ${regression}`).toContain(regression);
            }
        }
    });
});
