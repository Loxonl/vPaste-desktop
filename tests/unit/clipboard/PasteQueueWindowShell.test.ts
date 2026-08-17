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
});
