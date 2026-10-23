import catalog from "../../tests/fixtures/office/catalog.json";

export type OfficeCase = {
    id: string;
    code: string;
    group: string;
    name: string;
    description: string;
    manualSteps: string[];
};

export const OFFICE_CASES: readonly OfficeCase[] = catalog.cases;

export type CaseResult = {
    passed: boolean;
    status?: "passed" | "prepared" | "failed";
    message: string;
    durationMs: number;
};

export type CaseState = CaseResult & {
    status: "passed" | "prepared" | "failed";
    manual?: boolean;
};

export function caseNeedsManualCheck(caseId: string): boolean {
    return OFFICE_CASES.some(testCase => testCase.id === caseId)
        || caseId.startsWith("external-drag-")
        || caseId === "paste-queue-target";
}

export function caseStateFromResult(caseId: string, result: CaseResult): CaseState {
    // A successful fixture preparation cannot confirm a cross-app operation.
    const reported = result.status ?? (result.passed ? "passed" : "failed");
    const status = reported === "passed" && caseNeedsManualCheck(caseId) ? "prepared" : reported;
    return { ...result, passed: status === "passed", status };
}

export function caseStatusLabel(state: CaseState): string {
    if (state.status === "prepared") return "已准备 · 待人工确认";
    if (state.manual) return state.status === "passed" ? "人工通过" : "人工未通过";
    return state.status === "passed" ? "自动通过" : "运行失败";
}
