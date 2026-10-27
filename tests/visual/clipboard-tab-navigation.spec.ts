import { expect, test, type Page } from "@playwright/test";

type NavigationProbe = Window & { __tabNavigation: {
    calls: Array<{ command: string; args: Record<string, unknown> }>;
    emit: (name: string, payload?: unknown) => void;
    setPreviewVisible: () => void;
} };

const cards = (page: Page) => page.locator('[data-results-active="true"] [data-hash][class*="clipboard-card"]');
const activeTab = (page: Page) => page.locator('[class*="header-tabs"] [class*="tab-item"][class*="active"]');
const categoryNames = (page: Page) => page.locator('[class*="header-tabs"] [class*="tab-item"]').allTextContents();

async function openClipboard(page: Page, mac: boolean, extraTabs = 0) {
    await page.setViewportSize({ width: 760, height: 520 });
    await page.emulateMedia({ reducedMotion: mac ? "reduce" : "no-preference" });
    await page.addInitScript(({ mac, extraTabs }) => {
        Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32", configurable: true });
        Object.defineProperty(navigator, "userAgentData", { value: { platform: mac ? "macOS" : "Windows" }, configurable: true });
        const tabs = [
            { id: "text", name: "文字分类", filter: { itemType: "Text" } },
            { id: "empty", name: "空分类", filter: { itemType: "Image" } },
            ...Array.from({ length: extraTabs }, (_, i) => ({ id: `extra-${i}`, name: `更多分类${i}`, filter: {} })),
        ];
        localStorage.setItem("vpaste.customTabs.v1", JSON.stringify(tabs));
        localStorage.setItem("vpaste.tabOrder.v1", JSON.stringify(["empty", "record:7", "text"]));
        let nextId = 0;
        let previewVisible = false;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        const emit = (name: string, payload: unknown = null) => callbacks.get(listeners.get(name)!)?.({ payload });
        Object.assign(window, {
            __tabNavigation: { calls, emit, setPreviewVisible: () => { previewVisible = true; } },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    calls.push({ command, args });
                    if (command === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true, tab_quick_select_enabled: true });
                    if (command === "search") {
                        const label = args.label as string;
                        const filter = label.startsWith("__filter:") ? JSON.parse(label.slice(9)) : {};
                        const group = label === "__favorite" ? "favorite" : filter.record_tag_ids ? "tag" : filter.item_type === "Text" ? "text" : "all";
                        const list = filter.item_type === "Image" ? [] : Array.from({ length: 20 }, (_, i) => ({
                            id: 20 - i, hash: `${group}-${i}`, itemType: "Text", content: `${args.keywords || ""} ${group} record ${i}`,
                            previewContent: "", textContent: "", richHtml: "", time: 20 - i, label: 0, appSource: "", appIconPath: "", tags: [],
                        }));
                        return JSON.stringify({ list, consumed: list.length, hasMore: false, nextId: 0, nextTime: 0 });
                    }
                    if (command === "get_custom_tabs") return tabs;
                    if (command === "list_item_tags") return [{ id: 7, name: "记录标签" }];
                    if (command === "is_preview_window_visible") return previewVisible;
                    if (command === "hide_preview_window") { previewVisible = false; return null; }
                    if (command === "is_quick_input_modifier_pressed" || command === "get_developer_mode") return false;
                    if (["list_language_packs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                    if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++nextId; }
                    return null;
                },
                transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++nextId, callback); return nextId; },
                unregisterCallback: () => undefined,
                convertFileSrc: (value: string) => value,
                metadata: { currentWindow: { label: "clipboard" }, currentWebview: { label: "clipboard" } },
            },
        });
    }, { mac, extraTabs });
    await page.goto("/clipboard");
    await expect(cards(page).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "记录标签", exact: true })).toBeVisible();
    const previousSearches = await page.evaluate(() => (window as NavigationProbe).__tabNavigation.calls.filter(call => call.command === "search").length);
    await page.evaluate(() => (window as NavigationProbe).__tabNavigation.emit("window-show"));
    await expect.poll(() => page.evaluate(() => (window as NavigationProbe).__tabNavigation.calls.filter(call => call.command === "search").length)).toBeGreaterThan(previousSearches);
    await expect(activeTab(page)).toContainText("全部");
    await cards(page).first().focus();
}

for (const mac of [false, true]) {
    test(`Control+Tab follows visible category order and wraps (${mac ? "macOS reduced motion" : "Windows"})`, async ({ page }) => {
        await openClipboard(page, mac);
        const list = page.locator('[class*="cards-container"]');
        await list.evaluate(element => { element.scrollLeft = 500; });
        const names = await categoryNames(page);
        expect(names).toEqual(expect.arrayContaining(["全部", "收藏", "空分类", "记录标签", "文字分类"]));
        for (const name of [...names.slice(1), names[0]]) {
            await page.keyboard.press("Control+Tab");
            await expect(activeTab(page)).toContainText(name);
            if (name === "空分类") await expect(cards(page)).toHaveCount(0);
            else await expect(cards(page).first()).toHaveClass(/selected/);
        }
        await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBe(0);
        await page.keyboard.press("Control+Shift+Tab");
        await expect(activeTab(page)).toContainText(names.at(-1)!);
        await expect(cards(page).first()).toHaveClass(/selected/);
        await page.evaluate(() => (window as NavigationProbe).__tabNavigation.emit("clipboard-behavior-config-changed", { tab_quick_select_enabled: false }));
        await page.keyboard.press("Control+Tab");
        await expect(activeTab(page)).toContainText("全部");
        await page.keyboard.press("Control+Shift+Tab");
        await expect(activeTab(page)).toContainText(names.at(-1)!);
        const pasted = await page.evaluate(() => (window as NavigationProbe).__tabNavigation.calls.filter(call => /^(paste|add_to_paste_queue|set_paste_queue)/.test(call.command)));
        expect(pasted).toEqual([]);
    });

    test(`category shortcuts retain search focus and protect menus and composition (${mac ? "macOS" : "Windows"})`, async ({ page }) => {
        await openClipboard(page, mac);
        await page.keyboard.press("Control+f");
        const search = page.getByRole("textbox");
        await search.fill("needle");
        await page.keyboard.press("Control+Tab");
        await expect(activeTab(page)).toContainText("收藏");
        await expect(cards(page).first()).toContainText("needle favorite record 0");
        await expect(search).toHaveValue("needle");
        await expect(search).toBeFocused();
        await search.dispatchEvent("compositionstart");
        await page.keyboard.press("Control+Tab");
        await expect(activeTab(page)).toContainText("收藏");
        await search.dispatchEvent("compositionend");
        await page.keyboard.press("Control+Tab");
        await expect(activeTab(page)).toContainText("空分类");
        await expect(cards(page)).toHaveCount(0);
        await expect(search).toBeFocused();
        await page.keyboard.press("Control+Tab");
        await expect(activeTab(page)).toContainText("文字分类");
        await expect(cards(page).first()).toContainText("needle text record 0");
        await cards(page).first().click({ button: "right" });
        await expect(page.getByText("删除记录", { exact: true })).toBeVisible();
        await page.keyboard.press("Control+Tab");
        await expect(activeTab(page)).toContainText("文字分类");
    });
}

test("preview category events use current categories and close the old preview", async ({ page }) => {
    await openClipboard(page, false);
    await page.keyboard.press("Tab");
    await expect(cards(page).nth(1)).toHaveClass(/selected/);
    await page.keyboard.press("Shift+Tab");
    await expect(cards(page).first()).toHaveClass(/selected/);
    await page.evaluate(() => {
        const probe = (window as NavigationProbe).__tabNavigation;
        probe.emit("clipboard-behavior-config-changed", { tab_quick_select_enabled: false });
        probe.setPreviewVisible();
        probe.emit("preview-navigate-selection", { key: "Tab", ctrlKey: true, direction: -1 });
    });
    await expect(activeTab(page)).toContainText("记录标签");
    await expect(cards(page).first()).toHaveAttribute("data-hash", "tag-0");
    await expect.poll(() => page.evaluate(() => (window as NavigationProbe).__tabNavigation.calls.filter(call => call.command === "hide_preview_window").length)).toBe(1);
    await page.evaluate(() => (window as NavigationProbe).__tabNavigation.emit("preview-navigate-selection", { key: "Tab", direction: 1 }));
    await expect(cards(page).first()).toHaveClass(/selected/);
    const reopened = await page.evaluate(() => (window as NavigationProbe).__tabNavigation.calls.some(call => call.command === "show_preview_window"));
    expect(reopened).toBe(false);
});

test("keyboard-selected categories scroll into view", async ({ page }) => {
    await openClipboard(page, false, 10);
    const names = await categoryNames(page);
    await page.keyboard.press("Control+Shift+Tab");
    await expect(activeTab(page)).toContainText(names.at(-1)!);
    const bounds = await activeTab(page).evaluate(element => {
        const tab = element.getBoundingClientRect();
        const bar = element.parentElement!.getBoundingClientRect();
        return { tabLeft: tab.left, tabRight: tab.right, barLeft: bar.left, barRight: bar.right };
    });
    expect(bounds.tabLeft).toBeGreaterThanOrEqual(bounds.barLeft - 1);
    expect(bounds.tabRight).toBeLessThanOrEqual(bounds.barRight + 1);
});

test("settings display one compact fixed category shortcut on each platform", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        const mac = new URL(window.location.href).searchParams.get("platform") === "macos";
        Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32", configurable: true });
        Object.defineProperty(navigator, "userAgentData", { value: { platform: mac ? "macOS" : "Windows" }, configurable: true });
    });
    for (const [platform, key] of [["windows", "Ctrl + Tab"], ["macos", "⌃Tab"]]) {
        await page.setViewportSize({ width: 720, height: 700 });
        await page.goto(`/__settings-preview?platform=${platform}&lang=zh-CN`);
        await page.getByRole("tab").nth(2).click();
        const label = page.getByText("切换分类", { exact: true });
        await expect(label).toHaveCount(1);
        const row = label.locator("../..");
        await expect(row.locator("xpath=preceding-sibling::*[1]")).toContainText("Tab 键选择");
        await expect(row).toContainText(key);
        await expect(row).not.toContainText("Shift");
        await expect(row.getByRole("button")).toHaveCount(0);
        const value = row.locator('[class*="shortcut-static"]');
        await expect(value).toHaveCSS("width", "148px");
        expect(await value.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`category-shortcut-${platform}.png`), animations: "disabled" });
    }
});
