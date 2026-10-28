import { expect, test, type Page } from "@playwright/test";

type MousePreviewWindow = Window & { __mousePreview: {
    calls: Array<{ command: string; args: Record<string, unknown> }>;
    emit: (name: string, payload?: unknown) => void;
    setMode: (mode: string | null) => void;
    mode: () => string | null;
} };
const card = (page: Page, hash: string) => page.locator(`[data-results-active="true"] [data-hash="${hash}"][class*="clipboard-card"]`);
const callCount = (page: Page, command: string) => page.evaluate(command => (window as MousePreviewWindow).__mousePreview.calls.filter(call => call.command === command).length, command);

async function openPanel(page: Page, mode: "single" | "double", hover: boolean, mac = false, linkCard = false, recordCount = 3) {
    await page.emulateMedia({ reducedMotion: mac ? "reduce" : "no-preference" });
    await page.addInitScript(({ mode, hover, mac, linkCard, recordCount }) => {
        Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32", configurable: true });
        Object.defineProperty(navigator, "userAgentData", { value: { platform: mac ? "macOS" : "Windows" }, configurable: true });
        let nextId = 0;
        let previewMode: string | null = null;
        let hoverRequest = 0;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        const emit = (name: string, payload: unknown = null) => callbacks.get(listeners.get(name)!)?.({ payload });
        Object.assign(window, {
            __mousePreview: { calls, emit, mode: () => previewMode, setMode: (value: string | null) => { previewMode = value; } },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    calls.push({ command, args });
                    if (command === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true, mouse_paste_mode: mode, hover_preview_enabled: hover });
                    if (command === "search") return JSON.stringify({
                        list: Array.from({ length: recordCount }, (_, i) => ["first", "second", "third"][i] || `record-${i + 1}`).map((hash, i) => ({
                            id: recordCount - i, hash, itemType: linkCard && i === 1 ? "Link" : "Text",
                            content: linkCard && i === 1 ? "https://example.com/page" : `${hash} local record`, richHtml: i === 1 ? "<b>second rich text</b>" : "",
                            textContent: "", previewContent: "", time: 3 - i, label: 0, appSource: "", appIconPath: "", tags: [],
                        })), consumed: recordCount, hasMore: false, nextId: 0, nextTime: 0,
                    });
                    if (command === "show_preview_window") {
                        if (args.mode === "hover") {
                            if ((args.hoverRequest as number) < hoverRequest || (previewMode !== null && previewMode !== "hover")) return null;
                            hoverRequest = args.hoverRequest as number;
                        }
                        if (args.mode === "selection" && previewMode !== "manual") return null;
                        previewMode = args.mode === "hover" ? "hover" : "manual";
                    }
                    if (command === "dismiss_hover_preview_window") {
                        if (args.request !== undefined && (args.request as number) < hoverRequest) return null;
                        hoverRequest = args.request as number || hoverRequest + 1;
                        if (previewMode === "hover") previewMode = null;
                    }
                    if (command === "is_preview_window_visible") return previewMode !== null;
                    if (command === "hide_preview_window") previewMode = null;
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "is_quick_input_modifier_pressed" || command === "get_developer_mode") return false;
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "check_paste_accessibility_permission") return { granted: true, needs_settings: false };
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
    }, { mode, hover, mac, linkCard, recordCount });
    await page.goto("/clipboard");
    await expect(card(page, "first")).toBeVisible({ timeout: 15_000 });
    const searches = await callCount(page, "search");
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.emit("window-show"));
    await expect.poll(() => callCount(page, "search")).toBeGreaterThan(searches);
    await expect(card(page, "first")).toHaveClass(/selected/);
}

for (const mac of [false, true]) {
    test(`double mode selects on click, previews with Space, follows selection, and pastes once (${mac})`, async ({ page }) => {
        await openPanel(page, "double", false, mac);
        await card(page, "second").click();
        await expect(card(page, "second")).toHaveClass(/selected/);
        expect(await callCount(page, "copy_history_item")).toBe(0);
        expect(await callCount(page, "copy")).toBe(0);
        expect(await callCount(page, "paste")).toBe(0);
        expect(await callCount(page, "show_preview_window")).toBe(0);
        await page.keyboard.press("Space");
        await expect.poll(() => callCount(page, "show_preview_window")).toBe(1);
        await card(page, "third").click();
        await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.calls.filter(call => call.command === "show_preview_window").at(-1)?.args)).toMatchObject({ mode: "selection", content: "third local record" });
        await card(page, "third").dblclick();
        await expect.poll(() => callCount(page, "paste")).toBe(1);
    });
}

test("single mode remains immediate and keyboard paste bypasses the mouse preference", async ({ page }) => {
    await openPanel(page, "single", false);
    await card(page, "second").click();
    await expect.poll(() => callCount(page, "paste")).toBe(1);
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.emit("clipboard-behavior-config-changed", { mouse_paste_mode: "double" }));
    await card(page, "third").click();
    expect(await callCount(page, "paste")).toBe(1);
    await page.keyboard.press("Enter");
    await expect.poll(() => callCount(page, "paste")).toBe(2);
});

test("hover links use the Space preview command without waiting for page contents", async ({ page }) => {
    await openPanel(page, "double", true, false, true);
    await card(page, "second").hover();
    await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("hover");
    const request = await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.calls.find(call => call.command === "show_preview_window"));
    expect(request?.args).toMatchObject({ itemType: "Link", content: "https://example.com/page", mode: "hover" });
    await expect(card(page, "second")).toHaveClass(/selected/);
    expect(await callCount(page, "paste")).toBe(0);
});

test("hover selects immediately, delays preview, preserves search focus and bridges to the preview window", async ({ page }) => {
    await openPanel(page, "double", true);
    await page.keyboard.press("Control+f");
    const search = page.getByRole("textbox");
    await expect(search).toBeFocused();
    await card(page, "second").hover();
    expect(await callCount(page, "show_preview_window")).toBe(0);
    await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("hover");
    await expect(card(page, "second")).toHaveClass(/selected/);
    await expect(search).toBeFocused();
    await page.mouse.move(0, 0);
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.emit("preview-hover", true));
    await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("hover");
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.emit("preview-hover", false));
    await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe(null);
});

for (const mac of [false, true]) {
    test(`pointer selection works without automatic preview and shares keyboard actions (${mac})`, async ({ page }, testInfo) => {
        await openPanel(page, "double", false, mac);
        if (mac) await page.evaluate(() => document.documentElement.dataset.theme = "dark");
        await card(page, "second").hover();
        await expect(card(page, "second")).toHaveClass(/selected/);
        await expect(card(page, "second")).toHaveCSS("transform", "none");
        await expect(page.locator('[data-results-active="true"] [data-hash][class*="selected"]')).toHaveCount(1);
        expect(await callCount(page, "paste")).toBe(0);
        expect(await callCount(page, "show_preview_window")).toBe(0);
        await page.screenshot({ path: testInfo.outputPath("pointer-selection.png"), animations: "disabled" });
        await page.keyboard.press("Space");
        await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.calls.filter(call => call.command === "show_preview_window").at(-1)?.args.content)).toBe("second local record");
        await card(page, "third").hover();
        await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.calls.filter(call => call.command === "show_preview_window").at(-1)?.args)).toMatchObject({ mode: "selection", content: "third local record" });
        await page.keyboard.press("ArrowLeft");
        await expect(card(page, "second")).toHaveClass(/selected/);
        const thirdBounds = (await card(page, "third").boundingBox())!;
        const thirdPoint = { x: thirdBounds.x + thirdBounds.width / 2, y: thirdBounds.y + thirdBounds.height / 2 };
        await card(page, "third").dispatchEvent("pointerover", { pointerType: "mouse", buttons: 0, clientX: thirdPoint.x, clientY: thirdPoint.y });
        await expect(card(page, "second")).toHaveClass(/selected/);
        await page.mouse.move(thirdPoint.x + 2, thirdPoint.y);
        await page.mouse.move(0, 0);
        await expect(card(page, "third")).toHaveClass(/selected/);
        await page.keyboard.press("ArrowLeft");
        await expect(card(page, "second")).toHaveClass(/selected/);
        await page.mouse.move(thirdPoint.x + 2, thirdPoint.y);
        await expect(card(page, "third")).toHaveClass(/selected/);
        await page.keyboard.press("Enter");
        await expect.poll(() => callCount(page, "paste")).toBe(1);
        await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.calls.filter(call => call.command === "copy").at(-1)?.args.item)).toBe("third local record");
    });

    test(`wheel idle selects under a stationary mouse while keyboard scrolling keeps its selection (${mac})`, async ({ page }) => {
        await openPanel(page, "double", false, mac, false, 12);
        const first = card(page, "first");
        await first.hover();
        const bounds = (await first.boundingBox())!;
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const container = page.locator('[class*="cards-container"]');
        await page.mouse.wheel(0, 560);
        await expect.poll(() => container.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
        const pointedHash = () => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-results-active="true"] [data-hash]')?.dataset.hash || "", point);
        await expect.poll(pointedHash).not.toBe("first");
        await expect.poll(async () => {
            const hash = await pointedHash();
            return hash && await card(page, hash).getAttribute("class");
        }).toMatch(/selected/);
        const previous = await pointedHash();
        for (let step = 0; step < 5; step += 1) await page.keyboard.press("ArrowRight");
        const expectedHash = `record-${["first", "second", "third"].includes(previous) ? ["first", "second", "third"].indexOf(previous) + 6 : Number(previous.split("-")[1]) + 5}`;
        await expect(card(page, expectedHash)).toHaveClass(/selected/);
        await expect(container).not.toHaveClass(/wheel-scrolling/);
        await page.mouse.move(point.x + 2, point.y);
        await expect.poll(async () => {
            const hash = await page.evaluate(({ x, y }) => document.elementFromPoint(x + 2, y)?.closest<HTMLElement>("[data-hash]")?.dataset.hash || "", point);
            return hash && await card(page, hash).getAttribute("class");
        }).toMatch(/selected/);
    });
}

test("menus lock pointer selection and pinned previews stay fixed", async ({ page }) => {
    await openPanel(page, "double", true);
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.setMode("pinned"));
    await card(page, "second").hover();
    await expect(card(page, "second")).toHaveClass(/selected/);
    expect(await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("pinned");
    await card(page, "first").click({ button: "right" });
    await expect(page.getByText("删除记录", { exact: true })).toBeVisible();
    await card(page, "third").dispatchEvent("pointermove", { pointerType: "mouse", buttons: 0, clientX: 300, clientY: 200 });
    await expect(card(page, "first")).toHaveClass(/selected/);
    expect(await callCount(page, "paste")).toBe(0);
});

test("queue membership remains click-controlled when the pointer moves between cards", async ({ page }) => {
    await openPanel(page, "double", true);
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.emit("paste-queue-state-changed", { active: true, revision: 1 }));
    await expect(page.getByRole("toolbar", { name: "选择要加入队列的项目" })).toBeVisible();
    await card(page, "second").hover();
    await expect(card(page, "second")).not.toHaveClass(/selected/);
    await card(page, "second").click();
    await expect(card(page, "second")).toHaveClass(/selected/);
    await card(page, "third").hover();
    await expect(card(page, "second")).toHaveClass(/selected/);
    await expect(card(page, "third")).not.toHaveClass(/selected/);
    expect(await callCount(page, "paste")).toBe(0);
    expect(await callCount(page, "show_preview_window")).toBe(0);
});

for (const { hover, target } of [{ hover: false, target: "third" }, { hover: true, target: "third" }, { hover: false, target: "second" }]) {
    test(`pointer selection resumes after a focused preview closes (${hover}, ${target})`, async ({ page }) => {
        await openPanel(page, "double", hover);
        await card(page, "second").hover();
        await page.keyboard.press("Space");
        await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("manual");
        await page.evaluate(async () => {
            window.dispatchEvent(new Event("blur"));
            const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
            await bridge.invoke("hide_preview_window");
            window.dispatchEvent(new Event("focus"));
        });
        await card(page, target).hover({ position: { x: 80, y: 120 } });
        await expect(card(page, target)).toHaveClass(/selected/);
        if (hover) await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("hover");
        await page.keyboard.press("Enter");
        await expect.poll(() => callCount(page, "paste")).toBe(1);
        await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.calls.filter(call => call.command === "copy").at(-1)?.args.item)).toBe(`${target} local record`);
    });
}

test("forwarded preview keyboard navigation keeps selection while the list scrolls under a stationary mouse", async ({ page }) => {
    await openPanel(page, "double", false, false, false, 12);
    await card(page, "first").hover();
    await page.clock.install();
    await page.evaluate(() => {
        const probe = (window as MousePreviewWindow).__mousePreview;
        probe.setMode("manual");
        for (let step = 0; step < 7; step += 1) probe.emit("preview-navigate-selection", { direction: 1, key: "ArrowRight" });
    });
    await page.locator('[class*="cards-container"]').dispatchEvent("scroll");
    await page.clock.runFor(350);
    await expect(card(page, "record-8")).toHaveClass(/selected/);
});

test("hover yields to explicit previews and cancels for menus, scrolling, categories and disable", async ({ page }) => {
    await openPanel(page, "double", true);
    await card(page, "second").hover();
    await page.mouse.move(0, 0);
    await page.keyboard.press("Control+Tab");
    await card(page, "third").hover();
    await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("hover");
    await page.mouse.wheel(0, 100);
    await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe(null);
    await page.clock.install();
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.setMode("manual"));
    await card(page, "second").hover();
    await page.clock.runFor(600);
    await page.mouse.move(0, 0);
    await page.clock.runFor(300);
    await expect.poll(() => page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe("manual");
    await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.setMode(null));
    await card(page, "first").click({ button: "right" });
    await expect(page.getByText("删除记录", { exact: true })).toBeVisible();
    const previousShows = await callCount(page, "show_preview_window");
    await card(page, "third").dispatchEvent("pointerover", { pointerType: "mouse", buttons: 0 });
    await page.clock.runFor(700);
    expect(await callCount(page, "show_preview_window")).toBe(previousShows);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        const probe = (window as MousePreviewWindow).__mousePreview;
        probe.setMode(null);
        probe.emit("clipboard-behavior-config-changed", { mouse_paste_mode: "double", hover_preview_enabled: false });
    });
    await card(page, "second").hover();
    await page.clock.runFor(700);
    await page.keyboard.press("Control+Tab");
    expect(await page.evaluate(() => (window as MousePreviewWindow).__mousePreview.mode())).toBe(null);
});

test("settings add just the two compact mouse controls", async ({ page }, testInfo) => {
    await page.goto("/__settings-preview?lang=zh-CN&platform=windows");
    await expect(page.getByRole("combobox", { name: "鼠标粘贴" })).toContainText("单击");
    await expect(page.getByRole("checkbox", { name: "悬停预览" })).not.toBeChecked();
    await page.getByRole("combobox", { name: "鼠标粘贴" }).click();
    await page.getByRole("option", { name: "双击", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "鼠标粘贴" })).toContainText("双击");
    await page.screenshot({ path: testInfo.outputPath("mouse-preferences.png"), animations: "disabled" });
});
