import { expect, test, type Page } from "@playwright/test";

type PreviewBridge = {
    calls: Array<{ command: string; args: Record<string, unknown>; fileReady?: boolean }>;
    emit: (name: string, payload?: unknown) => void;
    finishImage: () => void;
};
type PreviewWindow = Window & { __residentPreview: PreviewBridge };
const current = (page: Page) => page.locator('[data-preview-phase="current"]');
const committed = (page: Page, id: number) => page.evaluate(id => (window as PreviewWindow).__residentPreview.calls
    .some(call => call.command === "commit_preview_window" && call.args.requestId === id), id);
const emit = (page: Page, payload: Record<string, unknown>) => page.evaluate(payload =>
    (window as PreviewWindow).__residentPreview.emit("preview-item", payload), payload);

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`resident preview stays empty until requested and preserves deferred files (${reducedMotion})`, async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion });
        const requests: string[] = [];
        page.on("request", request => requests.push(request.url()));
        await page.addInitScript(() => {
            let nextId = 0;
            let finishImage: () => void = () => undefined;
            const callbacks = new Map<number, (event: unknown) => void>();
            const listeners = new Map<string, number>();
            const calls: PreviewBridge["calls"] = [];
            Object.assign(window, {
                __residentPreview: {
                    calls,
                    emit: (name: string, payload: unknown = null) => callbacks.get(listeners.get(name)!)?.({ payload }),
                    finishImage: () => finishImage(),
                },
                __TAURI_INTERNALS__: {
                    invoke: async (command: string, args: Record<string, unknown> = {}) => {
                        calls.push({ command, args, fileReady: !!document.querySelector("[data-file-presentation]") });
                        if (command === "get_config") return JSON.stringify({ multilingual: "English", onboarding_completed: true });
                        if (command === "list_language_packs") return [];
                        if (command === "pending_preview_item") return null;
                        if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++nextId; }
                        if (command === "commit_preview_window") return true;
                        if (command === "fetch_link_preview_document") return { url: "https://example.com", html: "<p>Synthetic page</p>" };
                        if (command === "file_preview_info") return {
                            kind: "single-icon", paths: ["C:\\synthetic\\demo.doc"], display_path: "C:\\synthetic\\demo.doc",
                            extension: "DOC", exists: true, preview_path: "", contains_directories: false,
                        };
                        if (command === "resolve_history_media") return new Promise(resolve => {
                            finishImage = () => { resolve({ assetPath: "late-image.png" }); };
                        });
                        return null;
                    },
                    transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++nextId, callback); return nextId; },
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: { currentWindow: { label: "clipboardPreview" }, currentWebview: { label: "clipboardPreview" } },
                },
            });
        });
        await page.goto("/clipboard/preview");
        await expect.poll(() => page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .some(call => call.command === "auxiliary_window_ready"))).toBe(true);
        expect(await page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .filter(call => ["file_preview_info", "resolve_history_media", "fetch_link_preview_document", "search"].includes(call.command)))).toEqual([]);
        expect(requests.filter(url => url.includes("/material-icon-theme/icons/"))).toHaveLength(0);
        await expect(page.locator("[data-preview-phase]")).toHaveCount(0);

        await emit(page, { request_id: 1, item_type: "Text", content: "First synthetic preview" });
        await expect(current(page)).toHaveText("First synthetic preview");
        await emit(page, { request_id: 2, item_type: "Color", content: "#336699" });
        await expect(current(page)).toHaveText("#336699");
        const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
        await emit(page, { request_id: 3, item_type: "Image", content: "synthetic.png", preview_asset_path: pixel });
        await expect.poll(() => committed(page, 3)).toBe(true);
        await expect(current(page).locator("img")).toHaveAttribute("src", pixel);
        await emit(page, { request_id: 4, item_type: "Link", content: "https://example.com" });
        await expect(current(page).locator("iframe")).toHaveAttribute("srcdoc", /Synthetic page/);
        expect(requests.filter(url => url.includes("/material-icon-theme/icons/"))).toHaveLength(0);

        await emit(page, { request_id: 5, item_type: "File", content: '["C:\\synthetic\\demo.doc"]' });
        await expect(current(page).locator("[data-file-presentation='known']")).toHaveText("DOC");
        await expect.poll(() => committed(page, 5)).toBe(true);
        expect(await page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .find(call => call.command === "commit_preview_window" && call.args.requestId === 5)?.fileReady)).toBe(true);
        await expect(current(page).locator("[data-file-presentation] img")).toHaveJSProperty("complete", true);
        await page.screenshot({ path: testInfo.outputPath("resident-file.png"), animations: "disabled" });
        const pin = page.locator('button[aria-pressed]');
        await pin.click();
        await expect(pin).toHaveAttribute("aria-pressed", "true");
        await page.evaluate(() => (window as PreviewWindow).__residentPreview.emit("preview-clear"));
        await expect(page.locator("[data-preview-phase]")).toHaveCount(0);
        await expect(pin).toHaveAttribute("aria-pressed", "false");

        await emit(page, { request_id: 6, item_type: "Image", content: "slow-image.png" });
        await expect.poll(() => page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .some(call => call.command === "resolve_history_media"))).toBe(true);
        await page.evaluate(() => (window as PreviewWindow).__residentPreview.emit("preview-clear"));
        await emit(page, { request_id: 7, item_type: "Text", content: "Reopened synthetic preview" });
        await expect(current(page)).toHaveText("Reopened synthetic preview");
        await page.evaluate(() => (window as PreviewWindow).__residentPreview.finishImage());
        expect(await committed(page, 6)).toBe(false);
        await expect(page.locator("img")).toHaveCount(0);
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .filter(call => call.command === "plugin:event|emit_to").at(-1)?.args.payload)).toMatchObject({ direction: 1, key: "ArrowRight" });
        await page.screenshot({ path: testInfo.outputPath("resident-reopened.png"), animations: "disabled" });
    });
}
