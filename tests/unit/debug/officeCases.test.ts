import { describe, expect, it } from "vitest";
import { caseStateFromResult, caseStatusLabel, OFFICE_CASES } from "../../../src/debug/officeCases";

describe("Test Room verification results", () => {
    it("does not report prepared Office or cross-app fixtures as automatic passes", () => {
        const result = { passed: true, message: "ready", durationMs: 1 };
        for (const id of [OFFICE_CASES[0].id, "external-drag-png", "paste-queue-target"]) {
            expect(caseStateFromResult(id, result).status).toBe("prepared");
            expect(caseStateFromResult(id, result).passed).toBe(false);
        }
        expect(caseStateFromResult("clipboard-text", result).status).toBe("passed");
        expect(caseStateFromResult(OFFICE_CASES[0].id, { ...result, passed: false }).status).toBe("failed");
    });

    it("distinguishes automatic, prepared, and manually confirmed outcomes", () => {
        const base = { passed: true, message: "", durationMs: 1 };
        expect(caseStatusLabel({ ...base, status: "prepared" })).toContain("待人工确认");
        expect(caseStatusLabel({ ...base, status: "passed" })).toBe("自动通过");
        expect(caseStatusLabel({ ...base, status: "passed", manual: true })).toBe("人工通过");
        expect(caseStatusLabel({ ...base, status: "failed", manual: true })).toBe("人工未通过");
    });
});
