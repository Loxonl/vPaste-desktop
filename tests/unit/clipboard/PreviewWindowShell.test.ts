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
const uiTokens = readFileSync(
    join(process.cwd(), "src", "ui", "tokens.css"),
    "utf8",
);
const startupSource = readFileSync(join(process.cwd(), "src-tauri", "src", "startup_panel.rs"), "utf8");
const auxiliarySource = readFileSync(join(process.cwd(), "src-tauri", "src", "auxiliary_windows.rs"), "utf8");

function sourceBetween(start: string, end: string): string {
    const startIndex = mainSource.indexOf(start);
    const endIndex = mainSource.indexOf(end, startIndex + start.length);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return mainSource.slice(startIndex, endIndex);
}

describe("preview window outer shell", () => {
    it("keeps one cleared hidden preview resident without an idle destruction timer", () => {
        const closing = sourceBetween("fn hide_preview_window", "fn show_main_panel_for_app");
        expect(closing).toContain("retain_preview_window(&app)");
        const retention = sourceBetween("fn retain_preview_window", "fn hide_preview_and_clipboard");
        expect(retention).toContain("clear_preview_content(&preview_window)");
        expect(retention).toContain("preview_window.hide()");
        expect(retention).not.toContain("auxiliary_windows::destroy");
        expect(mainSource).not.toContain("PREVIEW_IDLE_RETENTION");
        expect(mainSource).not.toContain("PREVIEW_IDLE_RELEASE");
    });

    it("warms only a blank unfocused preview after the primary page is ready", () => {
        const warming = sourceBetween("fn prewarm_preview_window", "fn build_preview_window");
        expect(warming).toContain("tauri::async_runtime::spawn");
        expect(warming).toContain("auxiliary_windows::ensure");
        expect(warming).toContain("WindowKind::ClipboardPreview");
        for (const forbidden of [".show()", ".hide()", "set_focus", "clear_preview_content", "PREVIEW_REQUESTS.begin", "fetch_link", "image_preview_asset_path", "emit("]) {
            expect(warming).not.toContain(forbidden);
        }
        expect(startupSource).toContain("take_preview_warmup");
        expect(startupSource).toContain("crate::prewarm_preview_window");
        expect(auxiliarySource).toContain("state.creation.lock()");
    });

    it("ignores cancelled content without discarding the resident window and preserves close paths", () => {
        const opening = sourceBetween("async fn show_preview_window", "fn resize_preview_image_window");
        expect(opening).toContain("PREVIEW_REQUESTS.current(request_id)");
        expect(opening).not.toContain("destroy");
        expect(mainSource).not.toContain("discard_cancelled_preview_window");
        const mainHide = sourceBetween("fn finish_hide_window_locked", "fn finish_hide_window(");
        expect(mainHide).toContain("retain_preview_window");
        expect(mainHide).toContain("!PREVIEW_PINNED.load");
        const closeEvent = sourceBetween('if window.label() == "clipboardPreview" {', 'if window.label() == "tabEditor" {');
        expect(closeEvent).toContain("retain_preview_window");
        expect(closeEvent).not.toContain("auxiliary_windows::destroy_native");
    });

    it("records native readiness, preparation and visible commit timings without content fields", () => {
        const commit = sourceBetween("fn commit_preview_window", "async fn show_preview_window");
        expect(commit).toContain("preview timing:");
        for (const metric of ["window_ready_ms", "prepare_ms", "render_wait_ms", "commit_ms", "total_ms"]) {
            expect(commit).toContain(metric);
        }
        expect(auxiliarySource).toContain("native_create_ms");
        expect(auxiliarySource).toContain("page_ready_ms");
    });

    it("uses one CSS-owned rounded surface without a competing Win32 region", () => {
        const creation = sourceBetween(
            "fn build_preview_window",
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
        expect(shellRule).toContain("border-radius: var(--ui-radius-window)");
        expect(uiTokens).toContain("--ui-radius-window: 12px");
        expect(shellRule).toContain("overflow: hidden");
    });
});
