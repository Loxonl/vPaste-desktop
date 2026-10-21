import { expect, test, type Page } from "@playwright/test";

const samples = [
    { id: "light-page", html: '<p style="color: #222; background-color: #fff">Light page</p>', text: "Light page", color: "rgb(34, 34, 34)", background: "rgb(255, 255, 255)" },
    { id: "dark-page", html: '<p style="color: #eee; background-color: #222">Dark page</p>', text: "Dark page", color: "rgb(238, 238, 238)", background: "rgb(34, 34, 34)" },
    { id: "dark-ink", html: '<p style="color: black">Transparent dark ink</p>', text: "Transparent dark ink", color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)" },
    { id: "light-ink", html: '<p style="color: white">Transparent light ink</p>', text: "Transparent light ink", color: "rgb(255, 255, 255)", background: "rgba(0, 0, 0, 0)" },
    { id: "highlight", html: '<p><span style="color: #800080; background-color: #ffff00; font-weight: 700">Colored highlight</span></p>', text: "Colored highlight", color: "rgb(128, 0, 128)", background: "rgb(255, 255, 0)" },
    { id: "nested", html: '<div style="color: #123456; background-color: #fff"><b><span>Inherited ink</span></b></div>', text: "Inherited ink", color: "rgb(18, 52, 86)", background: "rgba(0, 0, 0, 0)" },
    { id: "fill", html: '<p style="color: red; -webkit-text-fill-color: #123456; background: white">Original text fill</p>', text: "Original text fill", color: "rgb(255, 0, 0)", fill: "rgb(18, 52, 86)", background: "rgb(255, 255, 255)" },
    { id: "unstyled", html: '<p>Unstyled rich text</p>', text: "Unstyled rich text", color: "rgb(38, 42, 48)", background: "rgba(0, 0, 0, 0)" },
    { id: "missing-ink", html: '<p style="background: #222">Dark background without ink</p>', text: "Dark background without ink", color: "rgb(242, 243, 245)", background: "rgb(34, 34, 34)", tone: "dark" },
    { id: "class-ink", html: '<style>.bright { color: hsl(0, 0%, 100%); }</style><p class="bright">Class-based light ink</p>', text: "Class-based light ink", color: "rgb(255, 255, 255)", background: "rgba(0, 0, 0, 0)", tone: "dark" },
    { id: "table", html: '<table><tbody><tr><td style="color: #123456; background: #ffff00; border: 1px solid red">Table cell</td></tr></tbody></table>', text: "Table cell", color: "rgb(18, 52, 86)", background: "rgb(255, 255, 0)" },
] as const;

async function openFixture(page: Page, theme: "light" | "dark") {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1200, height: 302 });
    await page.addInitScript(({ samples, theme }) => {
        let id = 0;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        Object.assign(window, {
            __richPreviewFixture: { callbacks, listeners, calls },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    calls.push({ command, args });
                    if (command === "search") return JSON.stringify({
                        list: [...samples.map((sample, index) => ({
                            id: index + 1, hash: sample.id, itemType: "Text", content: sample.text,
                            richHtml: sample.html, time: 1, label: 0, previewContent: "", textContent: "",
                            appSource: "", appIconPath: "", tags: [],
                        })), { id: 100, hash: "plain", itemType: "Text", content: "Plain text", richHtml: "", time: 1, label: 0, tags: [] }],
                        consumed: samples.length + 1, hasMore: false, nextId: 0, nextTime: 0,
                    });
                    if (command === "get_config") return JSON.stringify({ multilingual: "English", theme_mode: theme, onboarding_completed: true });
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "get_developer_mode") return false;
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "get_update_state") return { status: "disabled", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                    if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++id; }
                    return null;
                },
                transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++id, callback); return id; },
                unregisterCallback: () => undefined,
                convertFileSrc: (value: string) => value,
                metadata: { currentWindow: { label: "clipboard" }, currentWebview: { label: "clipboard" } },
            },
        });
    }, { samples, theme });
    await page.goto("/clipboard");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator('[data-hash="light-page"]')).toBeVisible({ timeout: 15000 });
}

for (const theme of ["light", "dark"] as const) {
    test(`rich card colors and highlights survive the ${theme} app theme`, async ({ page }, testInfo) => {
        await openFixture(page, theme);
        for (const sample of samples) {
            const card = page.locator(`[data-hash="${sample.id}"]`);
            const text = card.getByText(sample.text, { exact: true });
            await expect(text).toHaveCSS("color", sample.color);
            await expect(text).toHaveCSS("-webkit-text-fill-color", "fill" in sample ? sample.fill : sample.color);
            await expect(text).toHaveCSS("background-color", sample.background);
            if (sample.id === "highlight") await expect(text).toHaveCSS("font-weight", "700");
        }
        const plain = page.locator('[data-hash="plain"]').getByText("Plain text", { exact: true });
        const expectedPlain = theme === "dark"
            ? await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-text").trim())
            : "#333333";
        await expect(plain).toHaveCSS("color", await page.evaluate(color => {
            const element = document.createElement("span");
            element.style.color = color;
            document.body.appendChild(element);
            const resolved = getComputedStyle(element).color;
            element.remove();
            return resolved;
        }, expectedPlain));
        await page.screenshot({ path: testInfo.outputPath(`rich-cards-${theme}.png`) });
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
        for (const sample of samples) {
            await expect(page.locator(`[data-hash="${sample.id}"]`).getByText(sample.text, { exact: true }))
                .toHaveCSS("color", sample.color);
        }
    });

    test(`transparent rich text gets a readable default canvas in the ${theme} app theme`, async ({ page }) => {
        await openFixture(page, theme);
        for (const id of ["dark-ink", "unstyled", "light-ink"]) {
            const canvas = page.locator(`[data-hash="${id}"] [class*="card-preview-rich"]`);
            await expect(canvas).toHaveAttribute("data-rich-canvas", id === "light-ink" ? "dark" : "light");
            await expect(canvas).toHaveCSS("color-scheme", id === "light-ink" ? "dark" : "light");
        }
    });

    test(`Space preview preserves the same rich formatting in the ${theme} app theme`, async ({ page }) => {
        await openFixture(page, theme);
        await page.goto("/clipboard/preview");
        await expect.poll(() => page.evaluate(() => (window as unknown as {
            __richPreviewFixture: { listeners: Map<string, number> };
        }).__richPreviewFixture.listeners.has("preview-item"))).toBe(true);
        for (const sample of samples) {
            await page.evaluate(sample => {
                const fixture = (window as unknown as { __richPreviewFixture: {
                    callbacks: Map<number, (event: unknown) => void>; listeners: Map<string, number>;
                } }).__richPreviewFixture;
                fixture.callbacks.get(fixture.listeners.get("preview-item")!)?.({
                    event: "preview-item", payload: { item_type: "Text", content: sample.text, rich_html: sample.html },
                });
            }, sample);
            const canvas = page.locator('[class*="preview-rich"]');
            const text = canvas.getByText(sample.text, { exact: true });
            await expect(text).toBeVisible();
            await expect(text).toHaveCSS("color", sample.color);
            await expect(text).toHaveCSS("-webkit-text-fill-color", "fill" in sample ? sample.fill : sample.color);
            await expect(text).toHaveCSS("background-color", sample.background);
            await expect(canvas).toHaveAttribute("data-rich-canvas", "tone" in sample ? sample.tone : sample.id === "light-ink" ? "dark" : "light");
        }
    });
}

test("opening Space preview sends the original rich HTML rather than its fallback canvas", async ({ page }) => {
    await openFixture(page, "dark");
    await page.keyboard.press("Space");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __richPreviewFixture: {
        calls: Array<{ command: string; args: Record<string, unknown> }>;
    } }).__richPreviewFixture.calls.find(call => call.command === "show_preview_window")?.args.richHtml))
        .toBe(samples[0].html);
});
