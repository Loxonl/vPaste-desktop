import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
    join(process.cwd(), "src-tauri", "src", "main.rs"),
    "utf8",
);
const pasteQueueStyles = readFileSync(
    join(process.cwd(), "src", "clipboard", "PasteQueue.module.css"),
    "utf8",
);

describe("paste queue native window", () => {
    it("inherits the app font for queue content and native controls", () => {
        expect(pasteQueueStyles).toMatch(
            /\.shell\s+button\s*\{[^}]*font-family:\s*inherit;/s,
        );
        expect(pasteQueueStyles).toMatch(
            /\.itemText\s*>\s*span\s*\{[^}]*font-family:\s*inherit;/s,
        );
        expect(pasteQueueStyles).not.toContain("ui-monospace");
    });

    it("accepts mouse-moved events so row hover actions update without focusing", () => {
        const start = mainSource.indexOf("fn build_paste_queue_window");
        const end = mainSource.indexOf("fn show_startup_error", start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);

        const creation = mainSource.slice(start, end);
        expect(creation).toContain(".focusable(false)");
        expect(creation).toContain("enable_macos_mouse_moved_events(&window);");
        expect(mainSource).toContain("watch_paste_queue_pointer(app.clone(), generation);");
        expect(mainSource).toContain('window.emit("paste-queue-pointer-position", payload)');
        expect(pasteQueueStyles).not.toContain(".row:hover");
        expect(pasteQueueStyles).toContain(".row.pointerInside");
    });

    it("uses a native mouse-state watcher to dismiss menus after outside-window clicks", () => {
        expect(mainSource).toContain("fn set_paste_queue_menu_open(");
        expect(mainSource).toContain("watch_paste_queue_menu_outside_click");
        expect(mainSource).toContain("mouse_button_pressed()");
        expect(mainSource).toContain("!cursor_inside_window(&window)");
        expect(mainSource).toContain('window.emit("paste-queue-dismiss-menu", ())');
    });

    it("restores the previous target app for queue-window item clicks only", () => {
        expect(mainSource).toContain("enum PasteQueueRequestOrigin");
        expect(mainSource).toContain("PasteQueueRequestOrigin::QueueWindow");
        expect(mainSource).toContain("prepare_paste_queue_click_target(app, request.origin)");
        expect(mainSource).toContain("PasteQueueRequestOrigin::Shortcut");
    });

    it("verifies the original Windows target before the clipboard write and again before sending keys", () => {
        const worker = mainSource.split("fn process_paste_queue_request_inner")[1]
            .split("fn process_paste_queue_request(")[0];
        expect(worker).toMatch(/target\.require_foreground\(\)\?;[\s\S]*restore_paste_queue_item[\s\S]*target\.require_foreground\(\)\?;[\s\S]*simulate_paste_shortcut\(\)/);
    });

    it("does not intercept a normal Ctrl+V inside a vPaste surface", () => {
        const hook = mainSource.split("fn paste_queue_windows_keyboard_callback")[1]
            .split("fn run_paste_queue_interceptor")[0];
        expect(hook).toContain("Target::external_foreground");
        expect(hook).toContain("target.is_some()");
        expect(hook).toContain("enqueue_paste_queue_request(None, PasteQueueRequestOrigin::Shortcut, target)");
    });

    it("restores WinUI queue click focus using the same target recorded before enqueueing", () => {
        const click = mainSource.split("fn paste_queue_item(")[1].split("fn undo_paste_queue_consume")[0];
        const prepare = mainSource.split("fn prepare_paste_queue_click_target(")[1]
            .split("fn wait_for_empty_paste_queue_capture")[0];
        expect(click).toMatch(/winui_queue_ui_enabled\(\)[\s\S]*capture_foreground\(\)[\s\S]*enqueue_paste_queue_request\([\s\S]*Target::recorded\(\)/);
        expect(prepare).not.toContain("capture_foreground()");
        expect(prepare).toContain("restore_before_paste(target)?;");
        expect(mainSource).toContain("prepare_paste_queue_click_target(app, request.origin, target)?;");
    });

    it("keeps ordinary Windows paste bound to the recorded window even without a UI Automation snapshot", () => {
        const paste = mainSource.split("fn paste(\n")[1].split("fn record_text_history")[0];
        expect(paste).toMatch(/Target::recorded\(\)[\s\S]*restore_before_paste\(target\)\?;[\s\S]*target\.require_foreground\(\)\?;[\s\S]*simulate_paste_shortcut\(\)/);
    });
});
