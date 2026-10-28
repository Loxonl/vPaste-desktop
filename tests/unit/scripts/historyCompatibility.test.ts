import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "../../../src/lang/locales/en-US";
import zhCN from "../../../src/lang/locales/zh-CN";

describe("supported history baseline", () => {
    it("does not ship or build the retired archive converter", () => {
        expect(existsSync("tools/history-archive-converter/Cargo.toml")).toBe(false);
        for (const path of [
            ".github/workflows/release.yml",
            ".github/workflows/tag-build-windows.yml",
            ".github/workflows/tag-build-macos.yml",
        ]) {
            const workflow = readFileSync(path, "utf8");
            expect(workflow).not.toContain("history-archive-converter");
            expect(workflow).not.toContain("Build history archive converter");
            expect(workflow).not.toMatch(/then\s*\n\s*(?:else|fi)/);
            expect(workflow).not.toMatch(/else\s*\n\s*fi/);
        }
    });

    it("keeps current transfer and plaintext warnings without old migration copy", () => {
        for (const pack of [enUS, zhCN]) {
            expect(Object.keys(pack.translations).some(key => key.startsWith("settings.legacyHistory."))).toBe(false);
            expect(pack.translations["settings.importHistory"]).toBeTruthy();
            expect(pack.translations["settings.exportHistory.desc"]).toBeTruthy();
        }
    });
});
