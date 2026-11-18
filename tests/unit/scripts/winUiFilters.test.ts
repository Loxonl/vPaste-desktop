import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const native = "src-tauri/native-demo/windows/winui/";

describe("WinUI custom filter architecture", () => {
    it("uses a native unconstrained flyout without resizing the dock or creating a WebView", () => {
        const editor = read(`${native}WinUiFilterEditor.cpp`);
        expect(editor).toContain("ShouldConstrainToRootBounds(false)");
        expect(editor).toContain("FlyoutPlacementMode::TopEdgeAlignedLeft");
        for (const forbidden of ["WebView", "SetWindowPos", "CreateWindow", "SetClipboardData"])
            expect(editor).not.toContain(forbidden);
    });
    it("routes saved filters and pagination through the existing Rust history engine", () => {
        const bridge = read("src-tauri/src/winui_panel.rs");
        expect(bridge).toContain('filter.strip_prefix("custom:")');
        expect(bridge).toContain("filters::history_label(id, &tag_name)");
        const store = read("src-tauri/src/winui_panel/filters.rs");
        expect(store).toContain("crate::get_custom_tabs");
        expect(store).toContain("crate::save_custom_tabs");
        expect(store).not.toContain("std::fs::write");
        const panel = read(`${native}WinUiPanel.cpp`);
        const requestBuilder = panel.slice(panel.indexOf("std::uint64_t SendRequest("), panel.indexOf("std::uint64_t SendCardAction("));
        expect(requestBuilder.match(/L"custom:" \+ g_selectedFilterId/g)).toHaveLength(2);
    });
    it("builds the editor and releases it on the XAML apartment before closing the island", () => {
        expect(read(`${native}WinUiPanel.vcxproj`)).toContain('ClCompile Include="WinUiFilterEditor.cpp"');
        const panel = read(`${native}WinUiPanel.cpp`);
        const cleanup = panel.slice(panel.indexOf("// Release UI objects on their STA"));
        expect(cleanup.indexOf("g_panel.filterEditor.reset()"))
            .toBeLessThan(cleanup.indexOf("g_panel.xamlSource.Close()"));
    });
});
