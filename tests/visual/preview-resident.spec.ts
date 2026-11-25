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
                        if (command === "sync_preview_browser") return true;
                        if (command === "file_preview_info" && String(args.content).includes("fixture.pdf")) return {
                            kind: "pdf-preview", paths: ["C:\\synthetic\\fixture.pdf"], display_path: "C:\\synthetic\\fixture.pdf",
                            extension: "PDF", exists: true, preview_path: "", contains_directories: false,
                        };
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
            .filter(call => ["file_preview_info", "resolve_history_media", "sync_preview_browser", "fetch_link_preview_document", "search"].includes(call.command)))).toEqual([]);
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
        await expect.poll(() => page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .find(call => call.command === "sync_preview_browser")?.args)).toMatchObject({
            requestId: 4, url: "https://example.com",
            bounds: { width: expect.any(Number), height: expect.any(Number) },
        });
        await expect(current(page)).toContainText("https://example.com");
        await expect(current(page).locator("iframe")).toHaveCount(0);
        expect(await page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .some(call => call.command === "fetch_link_preview_document"))).toBe(false);
        expect(requests.filter(url => url.includes("/material-icon-theme/icons/"))).toHaveLength(0);

        await emit(page, { request_id: 5, item_type: "File", content: '["C:\\synthetic\\demo.doc"]' });
        await expect.poll(() => page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .some(call => call.command === "hide_preview_browser" && call.args.requestId === 4))).toBe(true);
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
            .filter(call => call.command === "preview_navigate_selection").at(-1)?.args)).toMatchObject({ direction: 1, key: "ArrowRight" });
        await page.screenshot({ path: testInfo.outputPath("resident-reopened.png"), animations: "disabled" });

        await emit(page, { request_id: 8, item_type: "File", content: '["C:\\synthetic\\fixture.pdf"]', native_toolbar: true });
        await expect.poll(() => committed(page, 8)).toBe(true);
        const toolbar = page.locator("[data-preview-toolbar]");
        const pdf = current(page).locator("iframe");
        const toolbarPin = toolbar.locator("button[aria-pressed]");
        const shell = page.locator('[data-chrome="winui"]');
        const readingLayer = () => shell.locator('[class*="preview-content"]').evaluate(node =>
            getComputedStyle(node, "::before").backgroundColor);
        await expect(shell).toHaveCSS("border-radius", "0px");
        await expect(shell).toHaveCSS("backdrop-filter", "none");
        const title = toolbar.getByRole("heading", { name: "Preview", exact: true });
        await expect(title).toBeVisible();
        await expect(shell).toHaveCSS("background-color", "rgba(252, 252, 252, 0.92)");
        await expect(title).toHaveCSS("font-size", "16px");
        await expect(title).toHaveCSS("font-weight", "600");
        await expect(title).toHaveCSS("line-height", "22px");
        await expect(title).toHaveCSS("color", "rgba(0, 0, 0, 0.894)");
        await expect(toolbar).toHaveCSS("border-bottom-width", "1px");
        await expect(toolbarPin).toBeVisible();
        await expect(toolbar.getByRole("button")).toHaveCount(1);
        const pinBounds = await toolbarPin.boundingBox();
        expect(pinBounds).toMatchObject({ width: 32, height: 32 });
        const toolbarBounds = await toolbar.boundingBox();
        const pdfBounds = await pdf.boundingBox();
        expect(toolbarBounds!.height).toBe(40);
        expect(pdfBounds!.y).toBeGreaterThanOrEqual(toolbarBounds!.y + toolbarBounds!.height);
        expect(pdfBounds!.height).toBeGreaterThan(100);
        await toolbarPin.focus();
        const beforeToolbarKeys = await page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .filter(call => call.command === "preview_navigate_selection").length);
        await page.keyboard.press("ArrowRight");
        expect(await page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .filter(call => call.command === "preview_navigate_selection").length)).toBe(beforeToolbarKeys);

        await emit(page, { request_id: 9, item_type: "Link", content: "https://example.com/with-toolbar", native_toolbar: true });
        await expect.poll(() => page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .filter(call => call.command === "sync_preview_browser" && call.args.requestId === 9).at(-1)?.args.bounds)).toMatchObject({
            y: expect.any(Number), height: expect.any(Number),
        });
        const browserBounds = await page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .filter(call => call.command === "sync_preview_browser" && call.args.requestId === 9).at(-1)!.args.bounds as { y: number });
        await expect(toolbar.getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
        expect(browserBounds.y).toBeGreaterThanOrEqual(toolbarBounds!.y + toolbarBounds!.height);

        const rich = current(page).locator("[data-rich-canvas]");
        await expect.poll(readingLayer).toBe("rgba(255, 255, 255, 0.5)");
        await emit(page, { request_id: 10, item_type: "Text", content: "Dark ink", rich_html: '<b style="color:#242424">Dark ink</b>', native_toolbar: true });
        await expect(rich).toHaveAttribute("data-rich-canvas", "light");
        await expect(rich).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(rich.locator("b")).toHaveCSS("color", "rgb(36, 36, 36)");
        expect(await readingLayer()).toBe("rgba(255, 255, 255, 0.5)");
        await expect(rich).toHaveCSS("font-size", "14px");
        await expect(rich).toHaveCSS("line-height", "20px");
        await expect(rich).toHaveCSS("color", "rgba(0, 0, 0, 0.894)");
        // Composite the browser layers over the measured gray host. The
        // browser cannot capture Windows' system backdrop on its own.
        const colors = await shell.evaluate((element, reading) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d")!;
            const blend = (color: string) => {
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return context.getImageData(0, 0, 1, 1).data[0];
            };
            blend("#d3d3d3");
            return [blend(getComputedStyle(element).backgroundColor), blend(reading)];
        }, await readingLayer());
        expect(Math.abs(colors[0] - 249)).toBeLessThanOrEqual(1);
        expect(Math.abs(colors[1] - 252)).toBeLessThanOrEqual(1);

        await emit(page, { request_id: 11, item_type: "Text", content: "Light ink", rich_html: '<b style="color:#f0f0f0">Light ink</b>', native_toolbar: true });
        await expect(rich).toHaveAttribute("data-rich-canvas", "dark");
        await expect(rich).toHaveCSS("background-color", "rgb(36, 36, 36)");
        expect(await readingLayer()).toBe("rgba(255, 255, 255, 0.5)");
        await expect(shell).toHaveCSS("background-color", "rgba(252, 252, 252, 0.92)");

        await page.emulateMedia({ colorScheme: "dark" });
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await emit(page, { request_id: 12, item_type: "Text", content: "Dark ink in dark theme", rich_html: '<b style="color:#242424">Dark ink in dark theme</b>', native_toolbar: true });
        await expect(rich).toHaveAttribute("data-rich-canvas", "light");
        await expect(rich).toHaveCSS("background-color", "rgb(243, 243, 243)");
        await expect(rich.locator("b")).toHaveCSS("color", "rgb(36, 36, 36)");
        await expect(shell).toHaveCSS("background-color", "rgba(32, 32, 32, 0.92)");
        await expect(title).toHaveCSS("color", "rgb(255, 255, 255)");
        await toolbarPin.press("Escape");
        await expect.poll(() => page.evaluate(() => (window as PreviewWindow).__residentPreview.calls
            .some(call => call.command === "hide_preview_window"))).toBe(true);
        await page.screenshot({ path: testInfo.outputPath("resident-native-toolbar.png"), animations: "disabled" });
    });
}
