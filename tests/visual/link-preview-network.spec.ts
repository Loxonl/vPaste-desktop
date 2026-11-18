import { expect, test, type Page } from "@playwright/test";

async function installPreviewBridge(page: Page, language: "Chinese" | "English", failure: string | null) {
    await page.addInitScript(({ language, failure }) => {
        let callbackId = 0;
        let listenerId = 0;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<number, { event: string; handler: number }>();
        const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
        Object.assign(window, {
            __linkPreviewCalls: calls,
            __previewListenerCount: () => [...listeners.values()].filter(value => value.event === "preview-item").length,
            __browserLocationListenerCount: () => [...listeners.values()].filter(value => value.event === "preview-browser-location").length,
            __sendLinkPreview: (requestId = 1, url = "https://example.com/page") => {
                for (const [id, listener] of listeners) {
                    if (listener.event === "preview-item") callbacks.get(listener.handler)?.({
                        event: "preview-item", id,
                        payload: { request_id: requestId, item_type: "Link", content: url },
                    });
                }
            },
            __sendBrowserLocation: (requestId: number, url: string) => {
                for (const [id, listener] of listeners) {
                    if (listener.event === "preview-browser-location") callbacks.get(listener.handler)?.({
                        event: "preview-browser-location", id, payload: { requestId, url },
                    });
                }
            },
            __clearLinkPreview: () => {
                for (const [id, listener] of listeners) {
                    if (listener.event === "preview-clear") callbacks.get(listener.handler)?.({
                        event: "preview-clear", id, payload: null,
                    });
                }
            },
            __TAURI_EVENT_PLUGIN_INTERNALS__: {
                unregisterListener: (_event: string, id: number) => { listeners.delete(id); },
            },
            __TAURI_INTERNALS__: {
                invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
                    calls.push({ cmd, args });
                    if (cmd === "get_config") return JSON.stringify({ multilingual: language, theme_mode: "system" });
                    if (cmd === "list_language_packs") return [];
                    if (cmd === "commit_preview_window") return true;
                    if (cmd === "plugin:event|listen") {
                        const id = ++listenerId;
                        listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
                        return id;
                    }
                    if (cmd === "plugin:event|unlisten") {
                        listeners.delete(Number(args.eventId));
                        return null;
                    }
                    if (cmd === "sync_preview_browser") {
                        if (failure) throw failure;
                        return true;
                    }
                    return null;
                },
                transformCallback: (callback: (event: unknown) => void) => {
                    callbacks.set(++callbackId, callback);
                    return callbackId;
                },
                unregisterCallback: (id: number) => { callbacks.delete(id); },
                convertFileSrc: (value: string) => value,
                metadata: { currentWindow: { label: "clipboardPreview" }, currentWebview: { label: "clipboardPreview" } },
            },
        });
    }, { language, failure });
    await page.goto("/clipboard/preview");
    await expect.poll(() => page.evaluate(() => (window as typeof window & {
        __previewListenerCount: () => number;
    }).__previewListenerCount())).toBeGreaterThan(0);
    await page.evaluate(() => (window as typeof window & { __sendLinkPreview: () => void }).__sendLinkPreview());
}

type LinkPreviewWindow = Window & {
    __linkPreviewCalls: Array<{ cmd: string; args: Record<string, unknown> }>;
    __sendLinkPreview: (requestId: number, url: string) => void;
    __sendBrowserLocation: (requestId: number, url: string) => void;
    __clearLinkPreview: () => void;
    __browserLocationListenerCount: () => number;
};

async function finishAnimations(page: Page) {
    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await Promise.all(document.getAnimations()
            .filter(animation => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
            .map(animation => animation.finished.catch(() => undefined)));
    });
}

for (const language of ["Chinese", "English"] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
        for (const reducedMotion of ["no-preference", "reduce"] as const) {
            test(`native link preview failure ${language} ${colorScheme} ${reducedMotion}`, async ({ page }, testInfo) => {
                await page.setViewportSize({ width: 640, height: 480 });
                await page.emulateMedia({ colorScheme, reducedMotion });
                await installPreviewBridge(page, language, "link_preview_network");
                const message = page.getByRole("alert");
                await expect(message).toContainText(language === "Chinese" ? "无法加载网页" : "Cannot load the webpage");
                await expect(message).not.toContainText("error sending request");
                const open = page.getByRole("button", { name: language === "Chinese" ? "打开原链接" : "Open original link" });
                await expect(open).toBeVisible();
                await expect(open).toBeInViewport();
                await open.focus();
                await page.keyboard.press("Enter");
                await expect.poll(() => page.evaluate(() => (window as typeof window & {
                    __linkPreviewCalls: Array<{ cmd: string; args: { url?: string } }>;
                }).__linkPreviewCalls.find(call => call.cmd === "open_url_in_browser")?.args.url)).toBe("https://example.com/page");
                await expect(page.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
                await finishAnimations(page);
                await page.screenshot({ path: testInfo.outputPath("link-preview-native-error.png") });
            });
        }
    }
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`native link bridge follows size and active request (${reducedMotion})`, async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 480 });
        await page.emulateMedia({ reducedMotion });
        await installPreviewBridge(page, "English", null);
        const latestSync = () => page.evaluate(() => (window as LinkPreviewWindow).__linkPreviewCalls
            .filter(call => call.cmd === "sync_preview_browser").at(-1)?.args);
        await expect.poll(latestSync).toMatchObject({ requestId: 1, url: "https://example.com/page" });
        const firstBounds = (await latestSync())!.bounds as Record<string, number>;
        expect(firstBounds.width).toBeGreaterThan(0);
        expect(firstBounds.height).toBeGreaterThan(0);
        expect(firstBounds.x).toBeGreaterThanOrEqual(0);
        expect(firstBounds.y).toBeGreaterThanOrEqual(0);
        expect(firstBounds.x + firstBounds.width).toBeLessThanOrEqual(640);
        expect(firstBounds.y + firstBounds.height).toBeLessThanOrEqual(480);
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(page.getByRole("status")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Open original link" })).toHaveCount(0);
        await expect(page.locator("iframe")).toHaveCount(0);

        await page.evaluate(() => (window as LinkPreviewWindow).__sendBrowserLocation(0, "https://stale.example/"));
        await expect(page.getByTitle("https://example.com/page")).toBeVisible();
        await page.evaluate(() => (window as LinkPreviewWindow).__sendBrowserLocation(1, "https://redirect.example/"));
        await expect(page.getByTitle("https://redirect.example/")).toBeVisible();
        await page.setViewportSize({ width: 900, height: 600 });
        await expect.poll(latestSync).toMatchObject({ requestId: 1, bounds: { viewportWidth: 900, viewportHeight: 600 } });

        await page.evaluate(() => (window as LinkPreviewWindow).__sendLinkPreview(2, "https://example.org/next"));
        await expect.poll(latestSync).toMatchObject({ requestId: 2, url: "https://example.org/next" });
        await expect.poll(() => page.evaluate(() => (window as LinkPreviewWindow).__linkPreviewCalls
            .some(call => call.cmd === "hide_preview_browser" && call.args.requestId === 1))).toBe(true);
        await page.evaluate(() => (window as LinkPreviewWindow).__sendBrowserLocation(1, "https://late.example/"));
        await expect(page.getByTitle("https://example.org/next")).toBeVisible();
        await page.evaluate(() => (window as LinkPreviewWindow).__clearLinkPreview());
        await expect(page.locator("[data-preview-phase]")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as LinkPreviewWindow).__linkPreviewCalls
            .some(call => call.cmd === "hide_preview_browser" && call.args.requestId === 2))).toBe(true);
        await expect.poll(() => page.evaluate(() => (window as LinkPreviewWindow).__browserLocationListenerCount())).toBe(0);
        expect(await page.evaluate(() => (window as LinkPreviewWindow).__linkPreviewCalls
            .some(call => call.cmd === "fetch_link_preview_document"))).toBe(false);
        // The native browser's URL/permission policy is exercised by Rust/runtime
        // checks. This mock verifies the frontend contract, not browser isolation.
    });
}
