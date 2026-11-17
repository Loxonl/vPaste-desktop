import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const native = (file: string) => read(`src-tauri/native-demo/windows/winui/${file}`);

describe("queue input and category shortcut contracts", () => {
    it("uses captured pointer sorting rather than a system drag for an internal queue", () => {
        const source = native("WinUiQueueView.cpp");
        expect(source).toContain("CapturePointer(args.Pointer())");
        expect(source).toContain("self->root.CapturePointer(args.Pointer())");
        const release = source.indexOf("sender.as<Button>().ReleasePointerCapture(args.Pointer())");
        expect(release).toBeGreaterThan(-1);
        expect(release).toBeLessThan(source.indexOf("self->root.CapturePointer(args.Pointer())"));
        expect(source).toContain("root.AddHandler(UIElement::PointerReleasedEvent()");
        expect(source).not.toContain("button.CapturePointer(args.Pointer())");
        expect(source).toContain("PointerCaptureLost");
        expect(source).toContain("MovePointerReorder(");
        expect(source).not.toContain("handle.CanDrag(");
        expect(source).not.toContain("QueueDragFormat");
    });

    it("gives queue text a finite stretchable column and includes loaded geometry tests", () => {
        const source = native("WinUiQueueView.cpp");
        expect(source).toContain("TestQueuePointerReorderControls");
        expect(source).toContain("paste.ActualWidth()");
        expect(source).toContain("QueuePointerOrder(");
    });

    it("allows a fresh pointer press to paste after sorting while guarding the drag release", () => {
        const source = native("WinUiQueueView.cpp");
        expect(source).toContain("!self->suppressDragPaste && self->draggingHash.empty()");
        expect(source.includes("paste.PointerPressed(")).toBe(false);
        expect(/paste\.AddHandler\(UIElement::PointerPressedEvent\(\), winrt::box_value\(Input::PointerEventHandler\{[\s\S]*?self->suppressDragPaste = false;[\s\S]*?\}\}\), true\);/.test(source)).toBe(true);
    });

    it("shows All and Favorites hints and resolves Alt shortcuts from toolbar buttons", () => {
        expect(native("WinUiPanel.cpp")).toContain("UpdateCategoryShortcutHints(");
        const source = native("WinUiKeyboard.cpp");
        expect(source).not.toContain("input.area != InputArea::Other && behavior.quickInput");
    });

    it("reconciles unchanged visible cards across categories without rebuilding their controls", () => {
        const source = native("WinUiPanel.cpp");
        expect(source.includes("if (sameQuery) retainedRows = std::move(g_panel.rows)")).toBe(false);
        expect(source).toContain("HighlightCard(*retained)");
    });
});

describe("retired standalone native sample", () => {
    it("removes the routes and sample without deleting the real platform panels", () => {
        for (const path of ["src-tauri/src/main.rs", "src-tauri/src/winui_panel/app_actions.rs",
            "src-tauri/src/native_panel/developer.rs", "src/clipboard/Clipboard.tsx",
            "src/clipboard/ClipboardHeader.tsx"]) {
            expect(read(path)).not.toContain("open_native_demo_window");
        }
        expect(existsSync(join(process.cwd(), "src-tauri/src/native_demo.rs"))).toBe(false);
        expect(existsSync(join(process.cwd(), "src-tauri/native-demo/windows/winui/WinUiPanel.cpp"))).toBe(true);
        const build = read("src-tauri/build.rs");
        expect(build).not.toContain("build_native_demo");
        expect(build).toContain('"native-panel/NativePanelBridge.h"');
        expect(build).toContain("build_swift_native_panel()");
    });
});
