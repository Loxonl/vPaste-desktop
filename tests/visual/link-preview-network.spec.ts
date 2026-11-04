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
            __sendLinkPreview: () => {
                for (const [id, listener] of listeners) {
                    if (listener.event === "preview-item") callbacks.get(listener.handler)?.({
                        event: "preview-item", id,
                        payload: { request_id: 1, item_type: "Link", content: "https://example.com/page" },
                    });
                }
            },
            __TAURI_INTERNALS__: {
                invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
                    calls.push({ cmd, args });
                    if (cmd === "get_config") return JSON.stringify({ multilingual: language, theme: "system" });
                    if (cmd === "list_language_packs") return [];
                    if (cmd === "commit_preview_window") return args.requestId === 1;
                    if (cmd === "plugin:event|listen") {
                        const id = ++listenerId;
                        listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
                        return id;
                    }
                    if (cmd === "plugin:event|unlisten") {
                        listeners.delete(Number(args.eventId));
                        return null;
                    }
                    if (cmd === "fetch_link_preview_document") {
                        if (failure) throw failure;
                        return { url: "https://example.com/page", html: "<html><head></head><body><p>Safe preview article</p></body></html>" };
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

for (const language of ["Chinese", "English"] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
        for (const reducedMotion of ["no-preference", "reduce"] as const) {
            test(`link preview proxy failure ${language} ${colorScheme} ${reducedMotion}`, async ({ page }, testInfo) => {
                await page.setViewportSize({ width: 640, height: 480 });
                await page.emulateMedia({ colorScheme, reducedMotion });
                await installPreviewBridge(page, language, "link_preview_proxy_unavailable");
                const message = page.getByRole("alert");
                await expect(message).toContainText(language === "Chinese" ? "系统代理" : "system proxy");
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
                await page.screenshot({ path: testInfo.outputPath("link-preview-proxy-error.png") });
            });
        }
    }
}

test("successful link previews retain the isolated document sandbox", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 });
    await installPreviewBridge(page, "Chinese", null);
    const frame = page.locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("srcdoc", /default-src 'none'/);
    await expect(frame.contentFrame().getByText("Safe preview article")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开原链接" })).toHaveCount(0);
});
