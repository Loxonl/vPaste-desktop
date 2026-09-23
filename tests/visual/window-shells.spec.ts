import { expect, test, type Page } from "@playwright/test";

async function expectPasteQueueFrame(page: Page) {
    const panel = page.getByTestId("paste-queue").locator("section");
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.y).toBeGreaterThanOrEqual(8);
    await expect(panel).toHaveCSS("box-shadow", "none");
    await expect(page.getByRole("button", { name: /退出粘贴队列|Exit Paste Queue/ })).toBeVisible();
}

const windows = [
    { name: "tray", path: "/tray-menu", width: 216, height: 184, ready: "[class*='tray-menu-shell']" },
    { name: "emoji", path: "/emoji-picker", width: 278, height: 164, ready: "[role='menu']" },
    { name: "paste-notice", path: "/paste-fallback-notice", width: 560, height: 76, ready: "section[class*='paste-fallback-notice']" },
    { name: "paste-queue", path: "/paste-queue", width: 360, height: 448, ready: "[data-testid='paste-queue']" },
    { name: "preview", path: "/clipboard/preview", width: 640, height: 480, ready: "button" },
    { name: "tab-editor", path: "/tab-editor", width: 302, height: 416, ready: "button" },
    { name: "permission", path: "/onboarding-permission?permission=background", width: 720, height: 560, ready: "button" },
    { name: "clipboard", path: "/clipboard", width: 960, height: 600, ready: "button" },
] as const;

const darkAuxiliaryWindows = windows.filter(window => (
    window.name === "tray"
    || window.name === "emoji"
    || window.name === "paste-notice"
    || window.name === "preview"
    || window.name === "tab-editor"
    || window.name === "permission"
    || window.name === "clipboard"
));

test.describe("window shells", () => {
    for (const window of windows) {
        test(window.name, async ({ page }) => {
            await page.setViewportSize({ width: window.width, height: window.height });
            await page.goto(window.path);
            await expect(page.locator(window.ready).first()).toBeVisible();
            await expect(page.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(page.locator("#root")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(page).toHaveScreenshot(`${window.name}-shell.png`);
        });
    }

    for (const window of darkAuxiliaryWindows) {
        test(`${window.name} dark`, async ({ page }) => {
            await page.emulateMedia({ colorScheme: "dark" });
            await page.setViewportSize({ width: window.width, height: window.height });
            await page.goto(window.path);
            await expect(page.locator(window.ready).first()).toBeVisible();
            await expect(page).toHaveScreenshot(`${window.name}-shell-dark.png`);
        });
    }

    test("preview keeps a restrained translucent window surface", async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 480 });
        await page.goto("/clipboard/preview");
        await expect(page.locator("[class*='preview-shell']")).toHaveCSS(
            "background-color",
            "rgba(246, 246, 244, 0.88)",
        );
    });

    test("auxiliary popups share one inset rounded surface", async ({ page }) => {
        const cases = [
            { path: "/tray-menu", width: 216, height: 184, surface: "[class*='tray-menu-shell']" },
            { path: "/emoji-picker", width: 278, height: 164, surface: "[role='menu']" },
            { path: "/tab-editor", width: 302, height: 416, surface: "[class*='tab-editor-panel']" },
            { path: "/paste-fallback-notice", width: 560, height: 76, surface: "[role='status']" },
        ];

        let sharedSurfaceColor = "";
        for (const popup of cases) {
            await page.setViewportSize({ width: popup.width, height: popup.height });
            await page.goto(popup.path);
            const surface = page.locator(popup.surface).first();
            await expect(surface).toHaveCSS("border-radius", "12px");
            await expect(surface).not.toHaveCSS("box-shadow", "none");
            const surfaceColor = await surface.evaluate(element => getComputedStyle(element).backgroundColor);
            if (!sharedSurfaceColor) sharedSurfaceColor = surfaceColor;
            expect(surfaceColor).toBe(sharedSurfaceColor);
            await expect.poll(async () => (await surface.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(8);
            await expect.poll(async () => (await surface.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(8);
            const box = await surface.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.x).toBeGreaterThanOrEqual(8);
            expect(box!.y).toBeGreaterThanOrEqual(8);
        }
        await expect(page.getByRole("button").first()).toHaveCSS("border-radius", "8px");
    });

    test("tab editor uses the shared MUI select menu", async ({ page }) => {
        await page.setViewportSize({ width: 302, height: 416 });
        await page.goto("/tab-editor");

        await page.getByRole("combobox", { name: /类型|Type/ }).click();
        const listbox = page.getByRole("listbox");
        await expect(listbox).toBeVisible();
        await expect(listbox.getByRole("option")).toHaveCount(6);
        await expect(page).toHaveScreenshot("tab-editor-type-select.png");
    });

    test("tab editor recent-source menu remains scrollable to its last option", async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("vpaste.pendingTabEditorPayload", JSON.stringify({
                mode: "add",
                kind: "filter",
                tabs: [],
                languageCode: "Chinese",
            }));
            let callbackId = 0;
            Object.assign(window, {
                __TAURI_INTERNALS__: {
                    invoke: async (cmd: string) => {
                        if (cmd === "list_recent_app_source_options") {
                            return Array.from({ length: 10 }, (_, index) => ({
                                source: `Example App ${index + 1}`,
                            }));
                        }
                        if (cmd === "list_language_packs") return [];
                        if (cmd === "get_config") return JSON.stringify({ multilingual: "Chinese" });
                        return null;
                    },
                    transformCallback: () => ++callbackId,
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: {
                        currentWindow: { label: "tabEditor" },
                        currentWebview: { label: "tabEditor" },
                    },
                },
            });
        });
        await page.setViewportSize({ width: 302, height: 416 });
        await page.goto("/tab-editor");

        await page.getByRole("button", { name: /来源 App|Source App/ }).click();
        const sourceMenu = page.getByRole("menu");
        await expect(sourceMenu.getByRole("menuitem")).toHaveCount(11);
        const lastOption = sourceMenu.getByRole("menuitem", { name: "Example App 10" });
        await lastOption.scrollIntoViewIfNeeded();
        await expect(lastOption).toBeInViewport();
        await expect(page).toHaveScreenshot("tab-editor-source-menu.png");
    });

    test("developer mode exposes the UI lab and test room launchers", async ({ page }) => {
        await page.addInitScript(() => {
            let callbackId = 0;
            const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
            Object.assign(window, {
                __uiLabTestCalls: calls,
                __TAURI_INTERNALS__: {
                    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
                        calls.push({ cmd, args });
                        if (cmd === "get_developer_mode") return true;
                        if (cmd === "open_url_in_browser" || cmd === "open_test_room_window") return null;
                        throw new Error(`Unhandled test command: ${cmd}`);
                    },
                    transformCallback: () => ++callbackId,
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: {
                        currentWindow: { label: "clipboard" },
                        currentWebview: { label: "clipboard" },
                    },
                },
            });
        });

        await page.goto("/clipboard");
        const developerToolbar = page.getByRole("group", { name: /developer preview tools|开发者预览工具/i });
        await expect(developerToolbar).toBeVisible();
        const launcher = developerToolbar.getByRole("button", { name: /component UI lab|组件样板间/i });
        await expect(launcher).toBeVisible();
        await launcher.click();

        const expectedUrl = new URL("/__ui-lab", page.url()).toString();
        await expect.poll(() => page.evaluate(() => {
            const calls = (window as typeof window & {
                __uiLabTestCalls?: Array<{ cmd: string; args: { url?: string } }>;
            }).__uiLabTestCalls;
            return calls?.find(call => call.cmd === "open_url_in_browser")?.args.url;
        })).toBe(expectedUrl);

        const testRoomLauncher = developerToolbar.getByRole("button", { name: /open test room|打开测试间/i });
        await expect(testRoomLauncher).toBeVisible();
        await testRoomLauncher.click();
        await expect.poll(() => page.evaluate(() => {
            const calls = (window as typeof window & {
                __uiLabTestCalls?: Array<{ cmd: string }>;
            }).__uiLabTestCalls;
            return calls?.some(call => call.cmd === "open_test_room_window");
        })).toBe(true);

        const hideButton = page.getByRole("button", { name: /hide developer tools|隐藏开发者工具/i });
        await expect(hideButton).toHaveAttribute("aria-pressed", "true");
        await hideButton.click();
        await expect(developerToolbar).toBeHidden();
        await expect(page.getByRole("button", { name: /settings|设置/i })).toBeVisible();
        const showButton = page.getByRole("button", { name: /show developer tools|显示开发者工具/i });
        await expect(showButton).toHaveAttribute("aria-pressed", "false");
        await expect(showButton).toHaveCSS("opacity", "0");
        await showButton.hover();
        await expect(showButton).toHaveCSS("opacity", "0");
        await showButton.click();
        await expect(developerToolbar).toBeVisible();
    });

    test("clipboard tag menu keeps click-relative placement and shared surface", async ({ page }) => {
        await page.setViewportSize({ width: 960, height: 600 });
        await page.goto("/clipboard");

        await page.getByRole("button", { name: /添加标签|Add Tab/ }).click();
        const tagMenu = page.getByRole("menu");
        const popoverRadius = await page.evaluate(() => (
            getComputedStyle(document.documentElement).getPropertyValue("--ui-radius-popover").trim()
        ));
        await expect(tagMenu).toHaveCSS("border-radius", popoverRadius);
        await expect(tagMenu.getByRole("menuitem")).toHaveCount(2);
        await expect(page).toHaveScreenshot("clipboard-tag-create-menu.png");
    });

    test("clipboard distinguishes empty history from an empty search", async ({ page }) => {
        await page.addInitScript(() => {
            let callbackId = 0;
            let listenerId = 0;
            const searchCalls: Array<{ keywords?: string }> = [];
            Object.assign(window, {
                __clipboardSearchCalls: searchCalls,
                __TAURI_INTERNALS__: {
                    invoke: async (cmd: string, args: { keywords?: string } = {}) => {
                        if (cmd === "search") {
                            searchCalls.push(args);
                            return JSON.stringify({
                                list: [],
                                consumed: 0,
                                hasMore: false,
                                nextId: 0,
                                nextTime: 0,
                            });
                        }
                        if (cmd === "get_config") {
                            return JSON.stringify({
                                multilingual: "Chinese",
                                onboarding_completed: true,
                            });
                        }
                        if (cmd === "list_item_tags") return [];
                        if (cmd === "get_custom_tabs") return [];
                        if (cmd === "get_developer_mode") return false;
                        if (cmd === "get_paste_queue_state") {
                            return { active: false, revision: 0 };
                        }
                        if (cmd === "get_update_state") {
                            return {
                                status: "disabled",
                                currentVersion: "",
                                downloadedBytes: 0,
                                portable: false,
                                feedEnabled: false,
                                releaseUrl: "",
                            };
                        }
                        if (cmd === "plugin:event|listen") return ++listenerId;
                        return null;
                    },
                    transformCallback: () => ++callbackId,
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: {
                        currentWindow: { label: "clipboard" },
                        currentWebview: { label: "clipboard" },
                    },
                },
            });
        });
        await page.setViewportSize({ width: 960, height: 600 });
        await page.goto("/clipboard");

        await expect(page.getByText("剪贴板里还没有内容")).toBeVisible();
        const searchLayout = page.getByTestId("clipboard-search-layout");
        await expect(searchLayout).toHaveCSS("transform", "none");
        await expect(searchLayout).toHaveCSS("transition-property", "width");
        await expect(searchLayout).toHaveCSS("transition-duration", "0.18s");
        await page.getByRole("button", { name: "搜索" }).click();
        const searchInput = page.getByRole("textbox", { name: "搜索" });
        await expect(searchInput).toBeVisible();
        expect(await searchInput.evaluate(element => element.getBoundingClientRect().width)).toBe(276);
        await expect(searchLayout).toHaveCSS("transform", "none");
        await searchInput.fill("missing");
        await expect.poll(() => page.evaluate(() => (
            window as typeof window & { __clipboardSearchCalls?: Array<{ keywords?: string }> }
        ).__clipboardSearchCalls?.some(call => call.keywords === "missing"))).toBe(true);
        await expect(page.getByText("没有找到匹配内容")).toBeVisible();
        await expect(page).toHaveScreenshot("clipboard-empty-search.png");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect.poll(() => searchLayout.evaluate(element => (
            Number.parseFloat(getComputedStyle(element).transitionDuration)
        ))).toBeLessThan(0.001);
        await searchInput.fill("");
        await expect(page.getByText("剪贴板里还没有内容")).toBeVisible();
        await searchInput.fill("missing-again");
        await expect(page.getByText("没有找到匹配内容")).toBeVisible();
        await expect(page.getByTestId("clipboard-results")).not.toHaveAttribute("aria-hidden", "true");
    });

    test("clipboard filters recent and older loaded results with one bounded staggered motion", async ({ page }) => {
        await page.addInitScript(() => {
            let callbackId = 0;
            let listenerId = 0;
            const now = Date.now();
            const filteredHistory = Array.from({ length: 36 }, (_, index) => ({
                id: index + 1,
                hash: `motion-${index + 1}`,
                itemType: "Text",
                content: `Motion item ${index + 1}`,
                time: index < 3
                    ? now - index * 60_000
                    : now - (2 * 24 * 60 * 60 * 1_000) - index * 60_000,
                previewContent: "",
                textContent: `Motion item ${index + 1}`,
                label: 0,
                appSource: "",
                appIconPath: "",
                richHtml: "",
                tags: [],
            }));
            const initialHistory = [
                ...filteredHistory.slice(0, 3),
                ...Array.from({ length: 33 }, (_, index) => ({
                    ...filteredHistory[index + 3],
                    id: 100 + index,
                    hash: `filler-${index + 1}`,
                    content: `Filler item ${index + 1}`,
                    textContent: `Filler item ${index + 1}`,
                    time: now - (index + 3) * 60_000,
                })),
            ];
            let releaseFilteredSearch: (() => void) | null = null;
            Object.assign(window, {
                __filteredSearchPending: false,
                __releaseFilteredSearch: () => releaseFilteredSearch?.(),
                __TAURI_INTERNALS__: {
                    invoke: async (cmd: string, args: { keywords?: string; label?: string } = {}) => {
                        if (cmd === "search") {
                            if (args.label === "__favorite") {
                                return JSON.stringify({
                                    list: filteredHistory,
                                    consumed: 36,
                                    hasMore: false,
                                    nextId: 0,
                                    nextTime: 0,
                                });
                            }
                            if (args.keywords === "match") {
                                await new Promise<void>(resolve => {
                                    releaseFilteredSearch = resolve;
                                    Object.assign(window, { __filteredSearchPending: true });
                                });
                                return JSON.stringify({
                                    list: filteredHistory,
                                    consumed: 36,
                                    hasMore: false,
                                    nextId: 0,
                                    nextTime: 0,
                                });
                            }
                            return JSON.stringify({
                                list: initialHistory,
                                consumed: initialHistory.length,
                                hasMore: false,
                                nextId: 0,
                                nextTime: 0,
                            });
                        }
                        if (cmd === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true });
                        if (cmd === "list_item_tags" || cmd === "get_custom_tabs") return [];
                        if (cmd === "get_developer_mode") return false;
                        if (cmd === "get_paste_queue_state") return { active: false, revision: 0 };
                        if (cmd === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                        if (cmd === "plugin:event|listen") return ++listenerId;
                        return null;
                    },
                    transformCallback: () => ++callbackId,
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: {
                        currentWindow: { label: "clipboard" },
                        currentWebview: { label: "clipboard" },
                    },
                },
            });
        });
        await page.setViewportSize({ width: 960, height: 600 });
        await page.goto("/clipboard");

        const cards = page.locator('[data-motion-preset="gridItem"]');
        const startMotionSampling = () => page.evaluate(() => {
            const motionSamples: Record<string, number> = {};
            Object.assign(window, { __filterMotionSamples: motionSamples });
            const startedAt = performance.now();
            const sample = () => {
                document.querySelectorAll<HTMLElement>('[data-filter-motion-hash]').forEach(card => {
                    const matrix = new DOMMatrixReadOnly(getComputedStyle(card).transform);
                    const hash = card.dataset.filterMotionHash || "";
                    motionSamples[hash] = Math.max(motionSamples[hash] || 0, Math.abs(matrix.m41));
                });
                if (performance.now() - startedAt < 900) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        const readMotionOffsets = () => page.evaluate(() => {
            const samples = (window as typeof window & { __filterMotionSamples?: Record<string, number> })
                .__filterMotionSamples || {};
            return Array.from({ length: 36 }, (_, index) => samples[`motion-${index + 1}`] || 0);
        });
        const readCurrentOffsets = () => page.evaluate(() => (
            Array.from(document.querySelectorAll<HTMLElement>('[data-filter-motion-hash]')).map(card => (
                Math.abs(new DOMMatrixReadOnly(getComputedStyle(card).transform).m41)
            ))
        ));
        await expect(cards).toHaveCount(36, { timeout: 15_000 });
        await page.getByRole("button", { name: "搜索" }).click();
        await page.getByRole("textbox", { name: "搜索" }).fill("match");

        const results = page.getByTestId("clipboard-results");
        await expect(page.getByRole("status", { name: "" }).filter({ hasText: "加载中" })).toBeVisible();
        await expect(results).toHaveAttribute("aria-hidden", "true");
        await expect(cards).toHaveCount(36);
        await expect.poll(() => page.evaluate(() => (
            window as typeof window & { __filteredSearchPending?: boolean }
        ).__filteredSearchPending)).toBe(true);

        await page.evaluate(() => {
            const state = window as typeof window & { __filterOverlapDetected?: boolean };
            state.__filterOverlapDetected = false;
            const detectOverlap = () => {
                const oldCard = document.querySelector('[data-card-hash="filler-1"]');
                const newCard = document.querySelector('[data-card-hash="motion-4"]');
                if (oldCard && newCard) state.__filterOverlapDetected = true;
            };
            new MutationObserver(detectOverlap).observe(document.body, { childList: true, subtree: true });
            detectOverlap();
        });
        await startMotionSampling();
        await page.evaluate(() => (
            window as typeof window & { __releaseFilteredSearch?: () => void }
        ).__releaseFilteredSearch?.());
        await expect(cards).toHaveCount(36);
        await page.waitForTimeout(950);
        const maximumOffsets = await readMotionOffsets();
        expect(maximumOffsets).toHaveLength(36);
        expect(maximumOffsets.every(offset => offset >= 4 && offset <= 17)).toBe(true);
        expect((await readCurrentOffsets()).every(offset => offset < 0.1)).toBe(true);
        expect(await page.evaluate(() => (
            window as typeof window & { __filterOverlapDetected?: boolean }
        ).__filterOverlapDetected)).toBe(false);
        await expect(page.getByText("Motion item 1", { exact: true })).toBeVisible();
        await expect(page.getByText("Motion item 36")).toBeAttached();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

        await page.getByRole("textbox", { name: "搜索" }).fill("");
        await expect(page.getByText("Filler item 1", { exact: true })).toBeAttached();
        await page.waitForTimeout(950);
        await startMotionSampling();
        await page.getByRole("button", { name: "收藏" }).click();
        await expect(page.getByText("Motion item 36")).toBeAttached();
        await page.waitForTimeout(950);
        const tabMaximumOffsets = await readMotionOffsets();
        expect(tabMaximumOffsets.every(offset => offset >= 4 && offset <= 17)).toBe(true);
        expect((await readCurrentOffsets()).every(offset => offset < 0.1)).toBe(true);
        expect(await page.evaluate(() => (
            window as typeof window & { __filterOverlapDetected?: boolean }
        ).__filterOverlapDetected)).toBe(false);
    });

    test("settings content follows forward and backward tab direction", async ({ page }) => {
        await page.goto("/__settings-preview?lang=zh&theme=light");

        const tabs = page.getByRole("tab");
        await tabs.nth(1).click();
        await expect(page.getByRole("tabpanel")).toHaveAttribute("data-motion-preset", "panelForward");
        await tabs.nth(0).click();
        await expect(page.getByRole("tabpanel")).toHaveAttribute("data-motion-preset", "panelBackward");
    });

    test("test room shows grouped cases and persistent sample tabs", async ({ page }) => {
        await page.addInitScript(() => {
            let callbackId = 0;
            const calls: string[] = [];
            Object.assign(window, {
                __testRoomCalls: calls,
                __TAURI_INTERNALS__: {
                    invoke: async (cmd: string, args?: Record<string, unknown>) => {
                        calls.push(cmd);
                        if (cmd === "get_test_room_config") return null;
                        if (cmd === "save_test_room_config") {
                            Object.assign(window, { __lastSavedTestRoomConfig: args?.config });
                            return null;
                        }
                        if (cmd === "cleanup_test_room_history") {
                            return { affectedItems: 5, message: "已清理 5 条测试历史" };
                        }
                        if (cmd === "copy_test_room_item_to_clipboard") {
                            Object.assign(window, { __lastCopiedTestRoomItem: args?.item });
                            return { affectedItems: 1, message: "已写入当前剪贴板" };
                        }
                        throw new Error(`Unhandled test command: ${cmd}`);
                    },
                    transformCallback: () => ++callbackId,
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: {
                        currentWindow: { label: "testRoom" },
                        currentWebview: { label: "testRoom" },
                    },
                },
            });
        });

        await page.setViewportSize({ width: 1080, height: 760 });
        await page.goto("/__test-room");
        await expect(page.getByTestId("test-room")).toBeVisible();
        const casesTab = page.getByRole("tab", { name: "测试用例" });
        const samplesTab = page.getByRole("tab", { name: "写入样板" });
        await expect(casesTab).toBeInViewport();
        await expect(samplesTab).toBeInViewport();
        await expect(page.getByRole("heading", { name: "vPaste 测试间" })).toHaveCount(0);
        await expect(page.getByText("Debug 专用的本地测试与样板工具。")).toHaveCount(0);
        const tabsTop = await page.getByRole("tablist", { name: "测试间功能" }).evaluate(element => (
            element.getBoundingClientRect().top
        ));
        expect(tabsTop).toBeLessThanOrEqual(32);
        const tabBounds = await page.getByRole("tablist", { name: "测试间功能" }).boundingBox();
        const cleanupBounds = await page.getByRole("button", { name: "清理测试历史" }).boundingBox();
        expect(tabBounds?.width).toBeLessThan(320);
        expect(cleanupBounds?.x).toBeGreaterThan((tabBounds?.x ?? 0) + (tabBounds?.width ?? 0));
        const pagePadding = await page.getByTestId("test-room").evaluate(element => (
            Number.parseFloat(getComputedStyle(element).paddingLeft)
        ));
        expect(pagePadding).toBeGreaterThanOrEqual(24);
        await expect(page.getByRole("heading", { name: "文本与富文本" })).toBeVisible();
        await expect(page.getByText("TC-TEXT-01 · 纯文本写入与读回")).toBeVisible();
        await expect(page.getByText("TC-FILE-01 · TXT、PNG、PSD 单文件")).toBeVisible();
        await expect(page.getByText("TC-FILE-02 · TXT、PNG、PSD 多文件")).toBeVisible();
        await expect(page.getByText("TC-FILE-03 · 单文件夹")).toBeVisible();
        await expect(page.getByText("TC-FILE-04 · 文件夹与文件")).toBeVisible();
        await expect(page.getByText("TC-FILE-05 · 已删除文件")).toBeVisible();
        await expect(page.getByText("TC-EXCEL-01 · Excel 图表与表格")).toBeVisible();
        await expect(page.getByText("TC-IMAGE-02 · QQ 双图消息")).toBeVisible();
        await expect(page.getByText("TC-IMAGE-03 · GIF 历史预览")).toBeVisible();
        await expect(page.getByText("TC-BOUNDARY-01 · 超长文本")).toBeVisible();
        await expect(page.getByText("TC-BOUNDARY-02 · 超大图片")).toBeVisible();
        await expect(page.getByText("TC-BOUNDARY-03 · 大型 GIF")).toBeVisible();
        await expect(page.getByText("TC-QUEUE-01 · 多类型入队")).toBeVisible();
        await expect(page.getByText("TC-QUEUE-02 · 顺序与重新入队")).toBeVisible();
        await expect(page.getByText("TC-QUEUE-03 · 消耗与撤销")).toBeVisible();
        await expect(page.getByText("TC-QUEUE-04 · 外部目标与系统粘贴")).toBeVisible();
        await expect(page.getByText("TC-DRAG-01 · 文本、链接与颜色")).toBeVisible();
        await expect(page.getByText("TC-DRAG-02 · PNG 图片")).toBeVisible();
        await expect(page.getByText("TC-DRAG-03 · GIF 动图")).toBeVisible();
        await expect(page.getByText("TC-DRAG-04 · 单文件")).toBeVisible();
        await expect(page.getByText("TC-DRAG-05 · 多文件")).toBeVisible();
        await expect(page.locator("article h2").allTextContents()).resolves.toEqual([
            "文本与富文本",
            "Excel 与表格",
            "图片",
            "链接",
            "文件",
            "颜色",
            "粘贴队列",
            "拖拽复制",
            "边界测试",
            "主窗口生命周期",
            "功能与元数据",
        ]);
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "清理测试历史" }).click();
        await expect.poll(() => page.evaluate(() => (
            window as typeof window & { __testRoomCalls?: string[] }
        ).__testRoomCalls?.includes("cleanup_test_room_history"))).toBe(true);
        await expect(page.getByRole("button", { name: "拉起主面板" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "关闭测试间" })).toHaveCount(0);

        await samplesTab.click();
        await expect(page.getByRole("region", { name: "写入样板" })).toBeVisible();
        await expect(page.getByRole("button", { name: /^中文样板/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /^英文样板/ })).toBeVisible();
        await expect(page.getByRole("button", { name: "写入当前组" })).toBeVisible();
        await expect(page.getByRole("button", { name: "清理测试历史" })).toBeVisible();
        const sampleNames = page.getByRole("textbox", { name: "名称（可留空）" });
        expect(await sampleNames.evaluateAll(inputs => inputs.filter(input => (
            input as HTMLInputElement
        ).value === "").length)).toBe(2);
        await expect(page.getByRole("button", { name: "写入剪贴板 Image 样板" })).toHaveCount(2);
        const copyToClipboard = page.getByRole("button", { name: "写入剪贴板 vPaste" });
        await expect(copyToClipboard).toBeVisible();
        await copyToClipboard.click();
        await expect.poll(() => page.evaluate(() => (
            window as typeof window & { __lastCopiedTestRoomItem?: { name?: string } }
        ).__lastCopiedTestRoomItem?.name)).toBe("vPaste");
        await expect(page.getByRole("button", { name: "复制 vPaste" })).toHaveCount(0);
        const timeInput = page.getByRole("spinbutton", { name: "距现在 vPaste（秒）" });
        await expect(timeInput).toHaveValue("0");
        await timeInput.fill("90");
        await timeInput.blur();
        await expect.poll(() => page.evaluate(() => {
            const saved = (window as typeof window & {
                __lastSavedTestRoomConfig?: { groups?: Array<{ items?: Array<{ name?: string; timeOffsetMs?: number }> }> };
            }).__lastSavedTestRoomConfig;
            return saved?.groups?.[0]?.items?.find(item => item.name === "vPaste")?.timeOffsetMs;
        })).toBe(90_000);
        const excelEditor = page.getByRole("textbox", { name: "编辑 销售概览 内容" });
        await expect(excelEditor).toBeVisible();
        await excelEditor.fill("产品\t区域\t销售额\nWorkspace\t华东\t¥138,000");
        await excelEditor.blur();
        await expect.poll(() => page.evaluate(() => {
            const saved = (window as typeof window & {
                __lastSavedTestRoomConfig?: { groups?: Array<{ items?: Array<{ name?: string; value?: string }> }> };
            }).__lastSavedTestRoomConfig;
            return saved?.groups?.[0]?.items?.find(item => item.name === "销售概览")?.value;
        })).toBe("产品\t区域\t销售额\nWorkspace\t华东\t¥138,000");
        await expect(page.getByRole("button", { name: "写入全部组" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "清理当前组" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "清理全部" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /管理分组 中文样板/ })).toBeVisible();
        await page.getByRole("button", { name: /管理分组 中文样板/ }).click();
        await expect(page.getByRole("menuitem", { name: "复制分组" })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "删除分组" })).toBeVisible();
    });
});

test.describe("paste queue states", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 448 });
    });

    test("empty light zh", async ({ page }) => {
        await page.goto("/paste-queue?state=empty");
        await expect(page.getByText("队列为空")).toBeVisible();
        await expectPasteQueueFrame(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page).toHaveScreenshot("paste-queue-empty-light-zh.png");
    });

    test("panel is opaque in light and dark themes", async ({ page }) => {
        await page.goto("/paste-queue?state=empty");
        const panel = page.getByTestId("paste-queue").locator("section");
        await expect(panel).toHaveCSS("background-color", "rgb(248, 248, 246)");
        await expect(panel).toHaveCSS("backdrop-filter", "none");

        await page.emulateMedia({ colorScheme: "dark" });
        await page.reload();
        await expect(panel).toHaveCSS("background-color", "rgb(27, 30, 36)");
        await expect(panel).toHaveCSS("backdrop-filter", "none");
    });

    test("error dark zh", async ({ page }) => {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.goto("/paste-queue?state=error");
        await expect(page.getByRole("alert")).toBeVisible();
        await expectPasteQueueFrame(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page).toHaveScreenshot("paste-queue-error-dark-zh.png");
    });

    test("normal dark en", async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "language", { value: "en-US" });
            Object.defineProperty(navigator, "languages", { value: ["en-US"] });
        });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.goto("/paste-queue");
        await expect(page.getByText("Paste Queue")).toBeVisible();
        await expectPasteQueueFrame(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page).toHaveScreenshot("paste-queue-normal-dark-en.png");
    });

    test("shows the row delete action on pointer hover", async ({ page }) => {
        await page.goto("/paste-queue");
        const firstRow = page.getByRole("listitem").first();
        const deleteButton = firstRow.getByRole("button", { name: /从队列移除|Remove from queue/ });
        await expect(deleteButton).toHaveCSS("opacity", "0");
        await firstRow.hover();
        await expect(deleteButton).toHaveCSS("opacity", "1");
    });

    test("drags the entire row vertically and animates neighboring space", async ({ page }) => {
        await page.goto("/paste-queue");
        const rows = page.getByRole("listitem");
        const handles = page.getByRole("button", { name: /拖动调整顺序|Drag to reorder/ });
        const firstRow = rows.nth(0);
        const secondRow = rows.nth(1);
        const firstBounds = await firstRow.boundingBox();
        const secondHandleBounds = await handles.nth(1).boundingBox();
        expect(firstBounds).not.toBeNull();
        expect(secondHandleBounds).not.toBeNull();

        await page.mouse.move(
            secondHandleBounds!.x + secondHandleBounds!.width / 2,
            secondHandleBounds!.y + secondHandleBounds!.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
            secondHandleBounds!.x + secondHandleBounds!.width / 2,
            firstBounds!.y + 2,
            { steps: 4 },
        );

        await expect.poll(() => secondRow.locator("[data-drag-surface]").evaluate(element => (element as HTMLElement).style.transform))
            .toMatch(/^translate3d\(0(px)?, -\d+(\.\d+)?px, 0(px)?\)$/);
        await expect.poll(() => firstRow.locator("[data-drag-surface]").evaluate(element => (element as HTMLElement).style.transform))
            .toMatch(/^translate3d\(0(px)?, \d+(\.\d+)?px, 0(px)?\)$/);
        await page.mouse.up();
    });

    test("undo light en", async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "language", { value: "en-US" });
            Object.defineProperty(navigator, "languages", { value: ["en-US"] });
        });
        await page.goto("/paste-queue?state=undo");
        await expect(page.getByText("Pasted from queue")).toBeVisible();
        await expectPasteQueueFrame(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page).toHaveScreenshot("paste-queue-undo-light-en.png");
    });

    test("menu and clear confirmation share the standard overlay components", async ({ page }) => {
        await page.goto("/paste-queue");
        await page.getByRole("button", { name: /更多队列操作|More queue actions/ }).click();
        const clearMenuItem = page.getByRole("menuitem", { name: /清空队列|Clear queue/ });
        await expect(clearMenuItem).toBeVisible();
        await expect(page).toHaveScreenshot("paste-queue-menu.png");

        await clearMenuItem.click();
        const dialog = page.getByRole("alertdialog", { name: /清空队列|Clear queue/ });
        await expect(dialog).toBeVisible();
        const backdrop = page.locator(".MuiBackdrop-root");
        await expect(backdrop).toHaveCSS("top", "10px");
        await expect(backdrop).toHaveCSS("right", "10px");
        await expect(backdrop).toHaveCSS("bottom", "10px");
        await expect(backdrop).toHaveCSS("left", "10px");
        await expect(backdrop).toHaveCSS("border-radius", "14px");
        await expect(page).toHaveScreenshot("paste-queue-clear-dialog.png");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
    });
});
