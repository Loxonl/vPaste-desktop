import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(resolve(name), "utf8");
const has = (text: string, token: string) => expect(text.includes(token), token).toBe(true);

describe("WinUI native drag contract", () => {
    it("connects native gestures to a bounded Rust preparation request, not clipboard paste", () => {
        const panel = source("src-tauri/native-demo/windows/winui/WinUiPanel.cpp");
        const bridge = source("src-tauri/src/winui_panel.rs");
        for (const token of ["CardDragSource", ".DragStarting(", ".DropCompleted(", "g_historyRefreshAfterDrag"]) has(panel, token);
        has(bridge, '"dragPrepare"');
        has(bridge, '"dragBegin" | "dragEnd"');
        has(source("src-tauri/src/main.rs"), "winui_panel::dragging()");
    });

    it("uses standard storage items and always cancels pending deferrals on shutdown", () => {
        const drag = source("src-tauri/native-demo/windows/winui/WinUiDrag.cpp");
        for (const token of ["SetStorageItems", "SetText", "SetWebLink", "CreateHtmlFormat", "deferral.Complete()", "session->ended", "GetAsyncKeyState"]) has(drag, token);
        for (const forbidden of ["SetCursor(", "SetWindowsHookEx", "SHDoDragDrop", "SetCapture("]) expect(drag.includes(forbidden)).toBe(false);
    });

    it("configures system drag visuals before deferring data preparation", () => {
        const drag = source("src-tauri/native-demo/windows/winui/WinUiDrag.cpp");
        const start = drag.slice(drag.indexOf("void CardDragSource::Start("), drag.indexOf("void CardDragSource::Receive("));
        const deferred = drag.slice(drag.indexOf("static winrt::fire_and_forget Populate("), drag.indexOf("CardDragSource::CardDragSource("));
        const deferral = start.indexOf("args.GetDeferral()");
        expect(deferral).toBeGreaterThanOrEqual(0);
        for (const configuration of ["args.AllowedOperations(", "args.DragUI().SetContentFromDataPackage()"]) {
            const position = start.indexOf(configuration);
            expect(position, configuration).toBeGreaterThanOrEqual(0);
            expect(position, configuration).toBeLessThan(deferral);
            expect(deferred, configuration).not.toContain(configuration);
        }
    });

    it("retains queue move menus while adding a local-only reorder grip", () => {
        const queue = source("src-tauri/native-demo/windows/winui/WinUiQueueView.cpp");
        for (const token of ["QueueDropOrder", "QueueDragFormat", "pendingDragState", ".DragOver(", ".Drop(", ".DragLeave(", "queueReorder", "MenuFlyout rowMenu"]) has(queue, token);
    });

    it("releases the drag owner before closing the XAML apartment", () => {
        const panel = source("src-tauri/native-demo/windows/winui/WinUiPanel.cpp");
        const cleanup = panel.slice(panel.indexOf("// Release UI objects on their STA"), panel.indexOf("CoUninitialize();"));
        has(cleanup, "g_panel.cardDrag.reset()");
        expect(cleanup.indexOf("g_panel.cardDrag.reset()") < cleanup.indexOf("g_panel.xamlSource.Close()")).toBe(true);
        const prepare = source("src-tauri/src/winui_panel/drag.rs");
        has(prepare, "MAX_DRAG_JSON_BYTES");
        has(prepare, "crate::materialize_native_drag_image");
        has(prepare, "crate::parse_file_clipboard_content");
    });
});
