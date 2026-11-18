import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_SOURCE_NAME_KEYS, displayAppSource } from "../../../src/clipboard/appSource";
import enUS from "../../../src/lang/locales/en-US";
import zhCN from "../../../src/lang/locales/zh-CN";

const read = (path: string) => readFileSync(path, "utf8");
const native = "src-tauri/native-demo/windows/winui/";

describe("WinUI custom filter architecture", () => {
    it("keeps every native source-app label aligned with the shipping localizations", () => {
        const editor = read(`${native}WinUiFilterEditor.cpp`);
        const mapping = editor.match(/constexpr AppSourceName AppSourceNames\[\] = \{([\s\S]*?)\n\};/)?.[1] ?? "";
        const labels = Array.from(mapping.matchAll(/\{L"([^"]+)", L"([^"]*)", L"([^"]*)"\}/g),
            ([, source, zh, en]) => [source, { zh, en }]);
        const expected = Object.fromEntries(Object.keys(APP_SOURCE_NAME_KEYS).map(source => [source, {
            zh: displayAppSource(`${source}.exe`, key => zhCN.translations[key]),
            en: displayAppSource(`${source}.exe`, key => enUS.translations[key]),
        }]));
        expect(labels).toHaveLength(Object.keys(APP_SOURCE_NAME_KEYS).length);
        expect(Object.fromEntries(labels)).toEqual(expected);
    });
    it("retains a source summary automation target when app icons accompany the text", () => {
        expect(read(`${native}WinUiFilterEditor.cpp`)).toContain('L"filter-source-summary"');
    });
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
