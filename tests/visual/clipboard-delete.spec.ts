import { expect, test, type Page } from "@playwright/test";

type DeleteProbe = Window & { __deleteProbe: {
    deleted: string[];
    searches: number;
    emitShow: () => void;
    finishDelete: () => void;
    finishSearch: () => void;
} };

const card = (page: Page, hash: string) => page.locator(`[data-results-active="true"] [data-hash="${hash}"][class*="clipboard-card"]`);
const deletions = (page: Page) => page.evaluate(() => (window as DeleteProbe).__deleteProbe.deleted);

async function openClipboard(page: Page, mac: boolean, holdDelete = false, holdSearch = false) {
    await page.emulateMedia({ reducedMotion: mac ? "reduce" : "no-preference" });
    await page.addInitScript(({ mac, holdDelete, holdSearch }) => {
        Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32", configurable: true });
        Object.defineProperty(navigator, "userAgentData", { value: { platform: mac ? "macOS" : "Windows" }, configurable: true });
        let nextId = 0;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        const deleted: string[] = [];
        let finishDelete!: () => void;
        let finishSearch!: () => void;
        const deleteReady = new Promise<void>(resolve => { finishDelete = resolve; });
        const searchReady = new Promise<void>(resolve => { finishSearch = resolve; });
        let rows = ["first", "second", "third"].map((hash, index) => ({
            id: 3 - index, hash, itemType: "Text", content: `${hash} record`, previewContent: "",
            textContent: "", richHtml: "", time: 3 - index, label: 0, appSource: "", appIconPath: "", tags: [],
        }));
        const probe = {
            deleted, searches: 0, finishDelete, finishSearch,
            emitShow: () => callbacks.get(listeners.get("window-show")!)?.({ payload: null }),
        };
        Object.assign(window, {
            __deleteProbe: probe,
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    if (command === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true });
                    if (command === "is_quick_input_modifier_pressed") return false;
                    if (command === "search") {
                        probe.searches += 1;
                        if (holdSearch && args.keywords) await searchReady;
                        const list = args.keywords ? rows.map(row => ({ ...row, content: `${args.keywords} ${row.content}` })) : rows;
                        return JSON.stringify({ list, consumed: rows.length, hasMore: false, nextId: 0, nextTime: 0 });
                    }
                    if (command === "delete_clipboard_item") {
                        deleted.push(args.hash as string);
                        if (holdDelete) await deleteReady;
                        rows = rows.filter(row => row.hash !== args.hash);
                    }
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "get_developer_mode") return false;
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                    if (command === "plugin:event|listen") {
                        listeners.set(args.event as string, args.handler as number);
                        return ++nextId;
                    }
                    return null;
                },
                transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++nextId, callback); return nextId; },
                unregisterCallback: () => undefined,
                convertFileSrc: (value: string) => value,
                metadata: { currentWindow: { label: "clipboard" }, currentWebview: { label: "clipboard" } },
            },
        });
    }, { mac, holdDelete, holdSearch });
    await page.goto("/clipboard");
    await expect(card(page, "first")).toBeVisible();
    await page.evaluate(() => (window as DeleteProbe).__deleteProbe.emitShow());
    await expect.poll(() => page.evaluate(() => (window as DeleteProbe).__deleteProbe.searches)).toBeGreaterThan(1);
    await card(page, "first").focus();
}

for (const mac of [false, true]) {
    const key = mac ? "Backspace" : "Delete";

    test(`fixed ${key} deletes selected records and follows the next/previous selection`, async ({ page }) => {
        await openClipboard(page, mac);
        await page.keyboard.press(mac ? "Delete" : "Backspace");
        expect(await deletions(page)).toEqual([]);
        await page.keyboard.press("ArrowRight");
        await expect(card(page, "second")).toHaveClass(/selected/);
        await card(page, "second").click({ button: "right" });
        await expect(page.getByText("删除记录", { exact: true })).toBeVisible();
        await page.keyboard.press(key);
        expect(await deletions(page)).toEqual([]);
        await page.keyboard.press("Escape");
        await page.keyboard.press(key);
        await expect(card(page, "second")).toHaveCount(0);
        await expect(card(page, "third")).toHaveClass(/selected/);
        await expect(card(page, "third")).toBeFocused();
        await page.keyboard.press(key);
        await expect(card(page, "third")).toHaveCount(0);
        await expect(card(page, "first")).toHaveClass(/selected/);
        await page.keyboard.press(key);
        await expect(card(page, "first")).toHaveCount(0);
        await page.keyboard.press(key);
        expect(await deletions(page)).toEqual(["second", "third", "first"]);
    });

    test(`fixed ${key} ignores repeats and overlapping deletion`, async ({ page }) => {
        await openClipboard(page, mac, true);
        await page.keyboard.press(key);
        await page.keyboard.press(key);
        expect(await deletions(page)).toEqual(["first"]);
        await page.evaluate(() => (window as DeleteProbe).__deleteProbe.finishDelete());
        await expect(card(page, "first")).toHaveCount(0);
        await page.keyboard.down(key);
        await expect(card(page, "second")).toHaveCount(0);
        await page.keyboard.down(key);
        expect(await deletions(page)).toEqual(["first", "second"]);
        await page.keyboard.up(key);
        await page.keyboard.press(key);
        await expect(card(page, "third")).toHaveCount(0);
    });

    test(`fixed ${key} protects search editing and pending search results`, async ({ page }) => {
        await openClipboard(page, mac, false, true);
        await page.keyboard.press("Control+f");
        const search = page.getByRole("textbox");
        await expect(search).toBeFocused();
        await page.keyboard.press(key);
        expect(await deletions(page)).toEqual([]);
        await search.fill("needle");
        await page.keyboard.press(mac ? "Backspace" : "Home");
        if (!mac) await page.keyboard.press("Delete");
        await expect(search).toHaveValue(mac ? "needl" : "eedle");
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await page.keyboard.press(key);
        expect(await deletions(page)).toEqual([]);
        await page.evaluate(() => (window as DeleteProbe).__deleteProbe.finishSearch());
        await expect(page.getByText(`${mac ? "needl" : "eedle"} first record`, { exact: true }).first()).toBeVisible();
        expect(await deletions(page)).toEqual([]);
    });
}

test("settings show the platform deletion key without a recorder", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        const mac = new URL(window.location.href).searchParams.get("platform") === "macos";
        Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32", configurable: true });
        Object.defineProperty(navigator, "userAgentData", { value: { platform: mac ? "macOS" : "Windows" }, configurable: true });
    });
    for (const [platform, value] of [["windows", "Delete"], ["macos", "⌫"]]) {
        await page.goto(`/__settings-preview?platform=${platform}&lang=zh-CN`);
        await page.getByRole("tab").nth(2).click();
        const row = page.getByText("删除选中记录", { exact: true }).locator("../..");
        await expect(row).toContainText(value);
        await expect(row.getByRole("button")).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath(`settings-delete-${platform}.png`), animations: "disabled" });
    }
});
