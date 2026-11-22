import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", file), "utf8");

describe("WinUI command flyout opening focus", () => {
    it("applies pointer-opening focus to the same native menus and their existing triggers", () => {
        const panel = read("WinUiPanel.cpp");
        const queue = read("WinUiQueueView.cpp");
        expect(/BindMenuOpeningFocus\(menu, g_panel\.menuInput\);\s*tab\.ContextFlyout\(menu\)/.test(panel)).toBe(true);
        expect(/BindMenuOpeningFocus\(addMenu, g_panel\.menuInput\);\s*g_panel\.addTag\.Flyout\(addMenu\)/.test(panel)).toBe(true);
        expect(/BindMenuOpeningFocus\(flyout, g_panel\.menuInput\);\s*surface\.ContextFlyout\(flyout\)/.test(panel)).toBe(true);
        expect(/BindMenuOpeningFocus\(rowMenu, menuInput\);\s*paste\.ContextFlyout\(rowMenu\)/.test(queue)).toBe(true);
        expect(queue.includes("handle.ContextFlyout(rowMenu)")).toBe(true);
        expect(panel).toContain("row.surface.ContextFlyout().ShowAt(row.surface)");
    });

    it("gates native paint before Opened without replacing focus or menu key routing", () => {
        const focus = read("WinUiMenuFocus.h");
        expect(focus).toContain("root.PreviewKeyDown(markKeyboard)");
        expect(focus).toContain("root.PreviewKeyUp(markKeyboard)");
        expect(focus).toMatch(/menu\.Opening\(.*\n(?:[^\n]*\n){1,12}[^\n]*cues->Hide\(/);
        expect(focus).toContain("FocusVisualPrimaryBrush(clear)");
        expect(focus).toContain("FocusVisualSecondaryBrush(clear)");
        expect(focus).toContain("ClearValue(FrameworkElement::FocusVisualPrimaryBrushProperty())");
        expect(focus).toContain("ClearValue(FrameworkElement::FocusVisualSecondaryBrushProperty())");
        expect(focus).toContain("menu.Closed(");
        expect(focus).not.toContain(".Focus(FocusState::");
        expect(focus).not.toContain("UseSystemFocusVisuals(false)");
        expect(focus).not.toContain("FlyoutShowMode::Transient");
        expect(read("WinUiTrayWindow.cpp")).toContain("Focus(FocusState::Pointer)");
    });
});
