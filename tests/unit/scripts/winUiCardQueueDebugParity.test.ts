import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const native = (name: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", name), "utf8");
const rust = (name: string) => readFileSync(resolve("src-tauri/src", name), "utf8");

describe("card, queue and developer reference parity", () => {
    it("keeps complete developer actions inline instead of a three-item menu", () => {
        const actions = native("WinUiAppActions.cpp");
        expect(actions).toContain('L"tutorial-windows"');
        expect(actions).toContain('L"tutorial-mac"');
        expect(actions).toContain('L"language"');
        expect(actions).toContain('L"theme"');
        expect(actions).not.toContain('L"native-window"');
        expect(actions).not.toContain("tools.Flyout(toolsMenu)");
        expect(actions).toContain("developer && toolsVisible");
    });
    it("exposes both queue commands without overflow and previews the actual sorted rows", () => {
        const queue = native("WinUiQueueView.cpp");
        expect(queue).toContain("toolbar.Children().Append(command)");
        expect(queue).toContain("{reverse, clear}");
        expect(queue).not.toContain("CommandBar");
        expect(queue).toContain('ApplyStyle(root, L"VPaste.QueueCanvas")');
        expect(queue).not.toContain("position.Children().Append(ordinal)");
        expect(queue).toContain('L"VPaste.QueueRow"');
        expect(queue).not.toContain('L"VPaste.QueueInsertionMark"');
        expect(queue).toContain('QueuePointerSlot(dragMetrics, dragFrom, offset)');
        expect(queue).toContain("visual.surface.Translation({0, shift, 0})");
    });
    it("uses the shipping queue wording in both languages", () => {
        const queue = native("WinUiQueueView.cpp");
        for (const [locale, shortcut] of [["zh-CN", "Ctrl + V"], ["en-US", "Ctrl + V"]]) {
            const translations = readFileSync(resolve("src/lang/locales", locale + ".ts"), "utf8");
            for (const key of ["reverse", "clear", "clearConfirm", "emptyIntercepting", "next", "keep", "pasted", "undo"]) {
                const label = translations.match(new RegExp(`"pasteQueue\\.${key}": "([^"]+)"`))?.[1];
                expect(label, key).toBeTruthy();
                expect(queue).toContain(`L"${label?.replace("{shortcut}", shortcut)}"`);
            }
        }
    });
    it("explains that ending the Windows queue clears its items", () => {
        for (const surface of ["WinUiPanel.cpp", "WinUiQueueView.cpp"]) {
            const source = native(surface);
            expect(source).toContain('L"退出并清空粘贴队列"');
            expect(source).toContain('L"Exit Paste Queue and clear items"');
        }
    });
    it("removes only Copy as plain text from the native card menu", () => {
        const actions = native("WinUiCardActions.cpp");
        expect(actions).not.toContain('L"copyPlain"');
        expect(actions).toContain('L"pastePlain"');
        expect(actions).toContain('L"copyFolder"');
    });
    it("keeps the queue nonactivating and suppresses the extra native frame border", () => {
        const window = native("WinUiQueueWindow.cpp");
        expect(window).toContain("DWMWA_BORDER_COLOR");
        expect(window).toContain("DWMWA_COLOR_NONE");
        expect(window).toContain("case WM_MOUSEACTIVATE: return MA_NOACTIVATE;");
        expect(window).toContain("DwmExtendFrameIntoClientArea");
    });
    it("automatically scrolls card text without changing reader scroll behavior", () => {
        const panel = native("WinUiPanel.cpp");
        expect(panel).toContain("AutoScrollCardPreview");
        expect(panel).toContain("UpdateCardPreviewMotion()");
        expect(panel).toContain("SetCardRichContent(");
        expect(native("WinUiRichContent.cpp")).toContain("viewport.VerticalScrollMode(ScrollMode::Enabled)");
    });
    it("animates native card scroll offsets within the fixed viewport and ignores retired operations", () => {
        const preview = native("WinUiCardPreview.h").split("class CardRecordTags")[0];
        expect(preview).toContain("self->viewport.Clip(clip)");
        expect(preview).toContain("const auto size = args.NewSize()");
        expect(preview).toContain("clip.Rect({0, 0, size.Width, size.Height})");
        expect(preview).toContain("viewport.ScrollTo(");
        expect(preview).toContain("ScrollCompleted(");
        expect(preview).toContain("args.CorrelationId()");
        expect(preview).not.toContain("content_.StartAnimation(");
    });
    it("renders individual record-tag pills in a non-interactive clipped track", () => {
        const panel = native("WinUiPanel.cpp");
        expect(panel).toContain("CardRecordTags");
        expect(panel).not.toContain('tagNames += L" · "');
        expect(panel).toContain("recordTags->SetVisible(");
    });
    it("only suppresses main-card internal feedback while preserving external providers", () => {
        const panel = native("WinUiPanel.cpp");
        expect(panel).toContain("SuppressInternalCardDrag(");
        expect(panel).toContain("g_panel.cardDrag->Start(");
        expect(native("WinUiDrag.cpp")).toContain("DeclareDragFormats(args.Data()");
    });
    it("keeps tutorial preview available on both native platforms", () => {
        const auxiliary = rust("auxiliary_windows.rs");
        expect(auxiliary).not.toMatch(/cfg\(all\(debug_assertions, target_os = "macos"\)\)\]\s*DevTutorial/);
        expect(rust("main.rs")).toContain("WindowKind::DevTutorial => return build_dev_tutorial_window(handle)");
    });
    it("routes Debug guides through the real native content host without hiding or centering a new window", () => {
        const tools = rust("winui_panel/app_actions.rs");
        const tutorial = tools.slice(tools.indexOf("Tool::TutorialWindows | Tool::TutorialMac =>"), tools.indexOf("Tool::Memory =>"));
        expect(tutorial).toContain("onboarding::open_preview");
        expect(tutorial).not.toContain("hide_on_ui_thread");
        expect(tutorial).not.toContain("center_window_on_monitor");
        const onboarding = rust("winui_panel/onboarding.rs");
        expect(onboarding).toContain('"nativeTutorialOpen"');
        expect(onboarding).not.toContain("WindowKind::DevTutorial");
        expect(onboarding).toContain("pub(crate) fn close_preview");
    });
});
