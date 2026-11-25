import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const native = "src-tauri/native-demo/windows/winui/";
const panel = readFileSync(native + "WinUiPanel.cpp", "utf8");
const appActions = readFileSync(native + "WinUiAppActions.cpp", "utf8");
const reference = readFileSync("src/clipboard/Clipboard.module.css", "utf8");

it("centers the A/F hint with the shipping bounds and reserved tab padding", () => {
    const rule = reference.match(/\.alt-tab-hint\s*\{([^}]+)\}/)?.[1];
    expect(rule).toContain("right: 5px");
    expect(rule).toContain("width: 14px");
    expect(reference).toContain("padding-right: 23px");
    const hints = panel.slice(panel.indexOf("void UpdateCategoryShortcutHints("), panel.indexOf("void UpdateFilterLabels("));
    expect(hints).toContain("hint.VerticalAlignment(VerticalAlignment::Center)");
    expect(hints).toContain("hint.Margin({0, 0, 5, 0})");
    expect(hints).toContain("hint.Width(14); hint.Height(14)");
    expect(panel).toContain("index < 2 ? 23.0 : 10.0");
});

it("uses one live WinUI editor for search text rather than a deferred suggestion wrapper", () => {
    expect(panel).toContain("g_panel.search = TextBox()");
    expect(panel).toContain("g_panel.search.TextChanging(");
    expect(panel).not.toContain("AutoSuggestBox::TextProperty()");
    expect(panel).toContain("g_panel.search.TextCompositionEnded(");
});

it("uses explicit reference toolbar spacing and the shipped Material update artwork", () => {
    expect(reference.match(/\.header-actions\s*\{([^}]+)\}/)?.[1]).toContain("gap: 8px");
    expect(panel).toContain("g_panel.commands.Spacing(8)");
    const syncPath = readFileSync("node_modules/@mui/icons-material/SyncRounded.js", "utf8").match(/d: "([^"]+)"/)?.[1];
    const artwork = readFileSync(native + "WinUiHeaderArtwork.h", "utf8");
    expect(syncPath).toBeTruthy();
    expect(artwork).toContain(syncPath);
    expect(appActions).toContain("HeaderArtwork::SyncRounded");
});

it("bounds offscreen history prefetch and reuses live file icon sources", () => {
    const cardContent = readFileSync(native + "WinUiCardContent.cpp", "utf8");
    expect(panel.includes('CacheLength="0.5"')).toBe(true);
    expect(cardContent.includes("image.Source(SharedFileIcon(icon))")).toBe(true);
});
