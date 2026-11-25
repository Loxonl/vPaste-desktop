import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const root = "src-tauri/native-demo/windows/winui/";
const keyboard = readFileSync(root + "WinUiKeyboard.cpp", "utf8");
const panel = readFileSync(root + "WinUiPanel.cpp", "utf8");
const app = readFileSync("src-tauri/src/main.rs", "utf8");
const bridge = readFileSync("src-tauri/src/winui_panel.rs", "utf8");
const cardActions = readFileSync(root + "WinUiCardActions.cpp", "utf8");

it("routes card Enter from the root tunnel before the native ListView consumes it", () => {
    expect(keyboard.includes("Action::PasteCard")).toBe(true);
    expect(panel.includes("case MainKeyAction::PasteCard:")).toBe(true);
});

it("uses the focused native card for Enter in queue selection without sending a paste", () => {
    const action = panel.slice(panel.indexOf("case MainKeyAction::PasteCard:"), panel.indexOf("case MainKeyAction::SearchPaste:"));
    expect(action).toContain("HistoryIndexFromSource(source)");
    expect(action).toContain("ActivateHistoryIndex(index,");
    const lookup = panel.slice(panel.indexOf("int HistoryIndexFromSource("), panel.indexOf("void ToggleQueueCardPreview("));
    expect(lookup).toContain("g_panel.history.IndexFromContainer(container)");
    const activate = panel.slice(panel.indexOf("void ActivateHistoryIndex("), panel.indexOf("void SubmitSearch("));
    expect(activate).toMatch(/if \(g_queueSelectionMode\)[\s\S]*?SelectedItems\(\)\.Append\(item\);\s*return;/);
});

it("refreshes both format colors when card detail resolves its source accent", () => {
    const detail = panel.slice(panel.indexOf("row.accent = ParseColor"), panel.indexOf("const auto detail = data.GetNamedString"));
    expect(detail.includes("ApplyFormatBadgeColors(row, contrast)")).toBe(true);
});

it("keeps the native tag check column without adding an icon column", () => {
    const submenu = panel.slice(panel.indexOf("MenuFlyoutSubItem tagsItem;"), panel.indexOf("return tagsItem;", panel.indexOf("ToggleMenuFlyoutItem tagOption")));
    expect(submenu).toContain("ToggleMenuFlyoutItem tagOption");
    expect(submenu).not.toContain("clearTags.Icon(");
});

it("scopes the shared preview toolbar to Windows WinUI fallback windows", () => {
    expect(app).toContain('let native_toolbar = cfg!(target_os = "windows") && main_panel_mode::winui();');
    expect(app).toMatch(/PreviewPayload \{\s*text_truncated,\s*request_id,\s*navigation_direction: [^,]+, [^,]+,\s*hover: [^,]+,\s*native_toolbar,/);
});

it("gives image recognition its own text scan icon without changing its command", () => {
    expect(panel).toMatch(/else if \(type == L"Image"\) \{\s*flyout\.Items\(\)\.Append\(vpaste::winui::MakeImageTextAction/);
    expect(cardActions).toContain("MakeImageTextIcon() { return HeaderIcon(ScanText); }");
    expect(cardActions).toContain("item.Icon(MakeImageTextIcon());");
    expect(cardActions).toContain('request(L"imageText", hash, {})');
});

it("gives native image cards the original-source fallback used by WebView", () => {
    const card = bridge.slice(bridge.indexOf("async fn query_card("), bridge.indexOf("fn native_color("));
    expect(card).toContain("presentation::resolve_image_card(");
    expect(card).toContain("original_image");
});

it("routes OCR updates separately from unconditional native history refreshes", () => {
    expect(bridge).toMatch(/app\.listen_any\("image-ocr-updated"[\s\S]*?send_response\(0, "imageOcrUpdated"/);
    const refresh = panel.slice(panel.indexOf("void RequestHistory("), panel.indexOf("void AnimateResultBatch("));
    expect(refresh).toContain("RequestHistory(bool preserveSearchSubmit = false)");
    expect(panel).toContain('operation == L"imageOcrUpdated"');
    expect(panel).toContain("RequestHistory(true)");
});

it("leaves OCR refresh to the committed IME query while composing", () => {
    const update = panel.slice(panel.indexOf('if (operation == L"imageOcrUpdated")'), panel.indexOf('if (operation == L"filtersChanged")'));
    expect(update).toMatch(/if \(!g_searchComposing[\s\S]*?RequestHistory\(true\)/);
});

it("retires a pending search debounce when dispatching a history query with the latest text", () => {
    const refresh = panel.slice(panel.indexOf("void RequestHistory(bool preserveSearchSubmit) {"), panel.indexOf("void AnimateResultBatch("));
    expect(refresh).toMatch(/g_searchTimer\.Stop\(\)[\s\S]*?SendRequest\(L"query"\)/);
});
