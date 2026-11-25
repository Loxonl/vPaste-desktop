import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const native = (name: string) => read(`src-tauri/src/winui_panel/${name}.rs`);
const panel = () => read("src-tauri/src/winui_panel.rs");

describe("WinUI auxiliary renderer migration", () => {
    it("routes the WinUI Edit action through the native editor adapter", () => {
        expect(panel()).toContain('"edit" => editor::open');
        expect(native("editor")).toContain("crate::clipboard::editor::load");
        expect(native("editor")).toContain("crate::save_clipboard_text_for_hash");
    });

    it("starts both WinUI guide variants without constructing either guide WebView", () => {
        const guide = native("onboarding");
        expect(guide).toContain('"nativeTutorialOpen"');
        expect(guide).not.toContain("WindowKind::NativeOnboarding");
        expect(guide).not.toContain("WindowKind::DevTutorial");
        expect(guide).toContain("crate::mark_onboarding_completed");
    });

    it("opens OCR in the native reader without routing it to the shared WebView", () => {
        expect(panel()).toContain('"imageText" => ocr::open');
        const ocr = native("ocr");
        expect(ocr).toContain("crate::image_text_preview_source");
        expect(ocr).toContain("crate::record_text_history");
        expect(ocr).not.toContain("WindowKind::ClipboardPreview");
    });

    it("does not cover the reader's window material with a second page canvas", () => {
        const reader = read("src-tauri/native-demo/windows/winui/WinUiReader.cpp");
        expect(reader).not.toContain('ApplyStyle(body, L"VPaste.ReaderCanvas")');
        expect(reader).toContain("AuxiliaryFooter");
        for (const name of ["FilterEditor", "RecordTagEditor"]) {
            const editor = read(`src-tauri/native-demo/windows/winui/WinUi${name}.cpp`);
            expect(editor).toContain("AuxiliaryFooter");
        }
    });

    it("does not restart a modal move loop from a routed caption event", () => {
        const reader = read("src-tauri/native-demo/windows/winui/WinUiReader.cpp");
        expect(reader).not.toMatch(/WM_NCLBUTTONDOWN|SC_MOVE/);
        expect(reader).toContain("captionBar.CapturePointer(");
        expect(reader).toContain("captionBar.PointerCaptureLost(");
    });

    it("uses the shipping permission illustrations in the native guide", () => {
        const reference = read("src/clipboard/TutorialOverlay.tsx");
        const resources = read("src-tauri/native-demo/windows/winui/WinUiOnboarding.rc");
        for (const artwork of ["permission-background.svg", "permission-paste.svg", "shortcut-popover.svg"]) {
            expect(reference).toContain(artwork);
            expect(resources).toContain(artwork);
        }
    });
});
