import { expect, test, type Page } from "@playwright/test";
import type { CustomTab } from "../../src/clipboard/customTabs";
import { installHistoryMockBridge } from "../helpers/historyMockBridge";

type TutorialProbe = Window & { __tutorial: { emit: (name: string) => void } };
const storedTabs = (page: Page) => page.evaluate(() =>
    JSON.parse(localStorage.getItem("test.nativeTabs") || "[]") as CustomTab[]);
const headerTabs = (page: Page) => page.locator('[class*="header-tabs"] [class*="tab-item"]');

async function openClipboard(page: Page, mac = false, completed = false, tabs: unknown[] = [], developerMode = false) {
    await page.emulateMedia({ reducedMotion: mac ? "reduce" : "no-preference" });
    await page.addInitScript(installHistoryMockBridge);
    await page.addInitScript(({ mac, completed, tabs, developerMode }) => {
        Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32" });
        Object.defineProperty(navigator, "userAgentData", { value: { platform: mac ? "macOS" : "Windows" } });
        if (!localStorage.getItem("test.seeded")) {
            localStorage.setItem("test.seeded", "true");
            localStorage.setItem("test.completed", String(completed));
            localStorage.setItem("test.nativeTabs", JSON.stringify(tabs));
        }
        let nextId = 0;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        Object.assign(window, {
            __tutorial: { emit: (name: string) => callbacks.get(listeners.get(name)!)?.({ payload: null }) },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    if (command === "get_config") return JSON.stringify({
                        multilingual: mac ? "English" : "Chinese",
                        onboarding_completed: localStorage.getItem("test.completed") === "true",
                    });
                    if (command === "get_custom_tabs") {
                        await new Promise(resolve => setTimeout(resolve, 150));
                        return JSON.parse(localStorage.getItem("test.nativeTabs") || "[]");
                    }
                    if (command === "save_custom_tabs") localStorage.setItem("test.nativeTabs", JSON.stringify(args.tabs));
                    if (command === "complete_onboarding") localStorage.setItem("test.completed", "true");
                    if (command === "get_onboarding_permission_status") return {
                        background: { done: true, needs_settings: false }, paste: { done: true, needs_settings: false },
                    };
                    if (command === "search") return JSON.stringify({ list: [], consumed: 0, hasMore: false });
                    if (["list_language_packs", "list_item_tags", "refresh_link_previews"].includes(command)) return [];
                    if (command === "get_developer_mode") return developerMode;
                    if (command === "is_preview_window_visible") return false;
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
    }, { mac, completed, tabs, developerMode });
    await page.goto("/clipboard");
}

async function showFilters(page: Page, mac = false) {
    if (mac) await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { name: mac ? "Add filters" : "添加筛选标签" })).toBeVisible({ timeout: 15_000 });
}

for (const mac of [false, true]) {
    test(`first-run defaults, empty selection, restart and reopening (${mac ? "macOS English reduced motion" : "Windows Chinese"})`, async ({ page }) => {
        await openClipboard(page, mac);
        await showFilters(page, mac);
        const names = mac ? ["📝 Text", "🖼️ Image", "🔗 Link", "📁 File", "🎨 Color"] : ["📝 文本", "🖼️ 图片", "🔗 链接", "📁 文件", "🎨 颜色"];
        const switches = page.getByRole("checkbox");
        await expect(switches).toHaveCount(5);
        for (let index = 0; index < names.length; index++) {
            await expect(switches.nth(index)).toHaveAccessibleName(names[index]);
            await expect(switches.nth(index)).toBeChecked({ checked: index < 4 });
        }
        await expect(page.getByText(mac ? "Quickly find copied content by type" : "按类型快速查找复制内容", { exact: true })).toBeVisible();
        await expect(page.locator('label[class*="tutorial-toggle"]').last()).toHaveCSS("opacity", "1");
        await page.screenshot({ path: test.info().outputPath("filters.png") });
        await expect.poll(async () => (await storedTabs(page)).map(tab => tab.name)).toEqual(names.slice(0, 4));
        await expect(headerTabs(page)).toHaveText([...(mac ? ["All", "Favorites"] : ["全部", "收藏"]), ...names.slice(0, 4)]);
        for (const name of names.slice(0, 4)) await page.getByRole("checkbox", { name, exact: true }).uncheck();
        await expect.poll(() => storedTabs(page)).toEqual([]);

        // Restart before finishing setup must respect an intentionally empty selection.
        await page.reload();
        await showFilters(page, mac);
        for (const checkbox of await switches.all()) await expect(checkbox).not.toBeChecked();
        const next = mac ? "Next" : "下一步";
        await page.getByRole("button", { name: next, exact: true }).click();
        await expect(page.getByRole("heading", { name: mac ? "Keep the shortcut close" : "记住默认快捷键" })).toBeVisible();
        await page.getByRole("button", { name: mac ? "Previous" : "上一步", exact: true }).click();
        for (const checkbox of await switches.all()) await expect(checkbox).not.toBeChecked();
        await page.getByRole("button", { name: next, exact: true }).click();
        await page.getByRole("button", { name: mac ? "Finish" : "完成", exact: true }).click();
        await expect(switches).toHaveCount(0);
        await page.evaluate(() => (window as TutorialProbe).__tutorial.emit("tutorial-started"));
        await showFilters(page, mac);
        for (const checkbox of await switches.all()) await expect(checkbox).not.toBeChecked();
        await page.getByRole("checkbox", { name: names[4], exact: true }).check();
        await expect.poll(async () => (await storedTabs(page)).map(tab => tab.name)).toEqual([names[4]]);
    });
}

test("reopening an existing user's setup does not enable empty filters", async ({ page }) => {
    await openClipboard(page, false, true);
    await expect(page.getByText("添加筛选标签", { exact: true })).toHaveCount(0);
    await expect(headerTabs(page)).toHaveCount(2);
    await page.evaluate(() => (window as TutorialProbe).__tutorial.emit("tutorial-started"));
    await showFilters(page);
    for (const checkbox of await page.getByRole("checkbox").all()) await expect(checkbox).not.toBeChecked();
    expect(await storedTabs(page)).toEqual([]);
});

test("first-run setup preserves delayed native filters and their custom names and order", async ({ page }) => {
    const tabs = [
        { id: "tutorial-filter-color", name: "My colors", filter: { itemType: "Color" } },
        { id: "tutorial-filter-text", name: "My notes", filter: { itemType: "Text" } },
    ];
    await openClipboard(page, false, false, tabs);
    await showFilters(page);
    await expect(headerTabs(page)).toHaveText(["全部", "收藏", "My colors", "My notes"]);
    expect((await storedTabs(page)).map(tab => tab.name)).toEqual(["My colors", "My notes"]);
    await expect(page.getByRole("checkbox", { name: "🎨 颜色", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "🖼️ 图片", exact: true })).not.toBeChecked();
});

for (const platform of ["Windows", "macOS"]) {
    test(`Debug ${platform} button previews fresh defaults without changing saved filters`, async ({ page }) => {
        const tabs = platform === "Windows" ? [] : [
            { id: "tutorial-filter-color", name: "My colors", filter: { itemType: "Color" } },
        ];
        await openClipboard(page, false, true, tabs, true);
        await expect(headerTabs(page)).toHaveCount(2 + tabs.length);
        const saved = await storedTabs(page);
        const savedPreferences = await page.evaluate(() => [
            localStorage.getItem("vpaste.tabOrder.v1"),
            localStorage.getItem("vpaste.onboardingFiltersInitialized.v1"),
        ]);
        const previewButton = page.getByRole("button", { name: `测试 ${platform} 向导`, exact: true });
        const names = ["📝 文本", "🖼️ 图片", "🔗 链接", "📁 文件", "🎨 颜色"];
        for (let run = 0; run < 2; run++) {
            await previewButton.click();
            if (platform === "macOS") await page.getByRole("button", { name: "下一步", exact: true }).click();
            await showFilters(page);
            for (let index = 0; index < names.length; index++) {
                await expect(page.getByRole("checkbox", { name: names[index], exact: true })).toBeChecked({ checked: index < 4 });
            }
            await expect(headerTabs(page)).toHaveText(["全部", "收藏", ...names.slice(0, 4)]);
            await page.getByRole("checkbox", { name: names[0], exact: true }).uncheck();
            await page.getByRole("checkbox", { name: names[4], exact: true }).check();
            await expect(headerTabs(page)).toHaveText(["全部", "收藏", ...names.slice(1)]);
            expect(await storedTabs(page)).toEqual(saved);
            expect(await page.evaluate(() => [
                localStorage.getItem("vpaste.tabOrder.v1"),
                localStorage.getItem("vpaste.onboardingFiltersInitialized.v1"),
            ])).toEqual(savedPreferences);
        }
        await page.getByRole("button", { name: "下一步", exact: true }).click();
        await page.getByRole("button", { name: "完成", exact: true }).click();
        await expect(headerTabs(page)).toHaveText(["全部", "收藏", ...tabs.map(tab => tab.name)]);
        expect(await storedTabs(page)).toEqual(saved);
        await page.evaluate(() => (window as TutorialProbe).__tutorial.emit("tutorial-started"));
        await showFilters(page);
        await expect(page.getByRole("checkbox", { name: names[0], exact: true })).not.toBeChecked();
        await expect(page.getByRole("checkbox", { name: names[4], exact: true })).toBeChecked({ checked: tabs.length > 0 });
    });
}
