import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../src/lang/locales/en-US";
import zh from "../../../src/lang/locales/zh-CN";

const native = (name: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", name), "utf8");
const panel = native("WinUiPanel.cpp");

describe("reported native desktop parity", () => {
    it("uses the same two creation labels as the shipping WebView", () => {
        for (const key of ["tabs.filterTag", "tabs.recordTag"] as const) {
            expect(panel).toContain(`Text(L"${zh.translations[key]}", L"${en.translations[key]}")`);
        }
    });
    it("uses the shipping record-tag editor titles", () => {
        const editor = native("WinUiRecordTagEditor.cpp");
        for (const key of ["tabs.addRecordTag", "tabs.editRecordTag"] as const) {
            expect(editor).toContain(`Text(L"${zh.translations[key]}", L"${en.translations[key]}")`);
        }
    });
    it("replaces the search trigger inside one slot instead of keeping a duplicate icon", () => {
        const show = panel.slice(panel.indexOf("void ShowSearch()"), panel.indexOf("winrt::Windows::UI::Color Rgb"));
        expect(show).toContain("g_panel.searchButton.Visibility(Visibility::Collapsed)");
        expect(show).not.toContain("FadeFeedback(search)");
        expect(panel).toContain("UIElement::VisibilityProperty()");
    });
    it("does not flash an indeterminate stripe on every history query", () => {
        const state = panel.slice(panel.indexOf("void UpdateHistoryState() {"), panel.indexOf("bool IsCardAction("));
        expect(state).not.toContain("g_historyLoading ? Visibility::Visible");
        expect(panel).toContain("g_panel.history.ItemContainerTransitions(");
    });
    it("settles complete result batches separately from card drag and window movement", () => {
        expect(panel).toContain("AnimateResultBatch(");
        expect(panel).toContain("requestedQuery != g_historyView.visibleQuery");
        expect(native("WinUiMotion.h")).toContain("AnimateResultItem(");
        expect(native("WinUiMotion.h")).toContain('GetNamedNumber(L"tight")');
    });
    it("keeps normal editing free of extra destructive actions and nested source scrolling", () => {
        const editor = native("WinUiFilterEditor.cpp");
        expect(editor).not.toContain('Send(L"filtersDelete"');
        expect(native("WinUiRecordTagEditor.cpp")).not.toContain('Send(L"recordTagDelete"');
        expect(editor).toContain("sourceButton.Flyout(");
        expect(editor).toContain("scroll.Padding(Thickness{0, 0, 12, 0})");
    });
    it("makes the emoji trigger a visible standard button", () => {
        expect(native("WinUiNameEmoji.cpp")).toContain("button.Width(32)");
        expect(native("WinUiNameEmoji.cpp")).toContain('ApplyStyle(button, L"VPaste.RoundToolbarButton")');
    });
    it("keeps the dock frame clock independent from dispatcher timer cadence", () => {
        const dock = native("WinUiDockMotion.h");
        expect(dock).not.toContain("DispatcherQueueTimer");
        expect(dock).toContain("DwmFlush()");
        expect(dock).toContain("request_stop()");
    });
});
