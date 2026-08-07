import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
    join(process.cwd(), "src-tauri", "src", "main.rs"),
    "utf8",
);
const previewStyles = readFileSync(
    join(process.cwd(), "src", "clipboard", "Preview.module.css"),
    "utf8",
);

function sourceBetween(start: string, end: string): string {
    const startIndex = mainSource.indexOf(start);
    const endIndex = mainSource.indexOf(end, startIndex + start.length);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return mainSource.slice(startIndex, endIndex);
}

describe("preview window outer shell", () => {
    it("uses one CSS-owned rounded surface without a competing Win32 region", () => {
        const creation = sourceBetween(
            "fn get_or_create_preview_window",
            "fn preview_window_active",
        );
        const showing = sourceBetween(
            "fn show_preview_window",
            "fn resize_preview_image_window",
        );
        const preCloseWindowEvents = sourceBetween(
            ".on_window_event(|window, event| {",
            "if let tauri::WindowEvent::CloseRequested",
        );
        const shellRule = previewStyles.match(/\.preview-shell\s*\{([^}]*)\}/)?.[1];

        expect(creation).toContain(".transparent(true)");
        expect(creation).toContain(".background_color(tauri::window::Color(0, 0, 0, 0))");
        expect(creation).toContain(".shadow(false)");
        expect(creation).not.toContain("apply_windows_rounded_window_region");
        expect(showing).not.toContain("apply_windows_rounded_window_region");
        expect(preCloseWindowEvents).not.toContain('window.label() == "clipboardPreview"');
        expect(shellRule).toContain("border-radius: 12px");
        expect(shellRule).toContain("overflow: hidden");
    });
});
