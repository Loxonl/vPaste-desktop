import { expect, test } from "@playwright/test";
import { installHistoryMockBridge } from "../helpers/historyMockBridge";

test.beforeEach(async ({ page }) => { await page.addInitScript(installHistoryMockBridge); });

for (const reduced of [false, true]) {
    test(`image OCR reuses the external preview and records explicit copies, reduced motion=${reduced}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: reduced ? 480 : 760, height: reduced ? 360 : 560 });
        await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await page.addInitScript(({ reduced }) => {
            let nextId = 0;
            const callbacks = new Map<number, (event: unknown) => void>();
            const listeners = new Map<string, number>();
            const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
            let ready = false;
            const preview = location.pathname.endsWith("/preview");
            const emit = (name: string, payload: unknown = null) => callbacks.get(listeners.get(name)!)?.({ payload });
            const rows = [{
                id: 1, hash: "image", itemType: "Image", content: "sample.png", previewContent: "",
                textContent: "", richHtml: "", time: 1, label: 0, appSource: "", appIconPath: "", tags: [],
            }];
            Object.assign(window, {
                __ocrProbe: {
                    calls,
                    complete: () => { ready = true; },
                    emit,
                },
                __TAURI_INTERNALS__: {
                    invoke: async (command: string, args: Record<string, unknown> = {}) => {
                        calls.push({ command, args });
                        if (command === "get_config") return JSON.stringify({ multilingual: reduced ? "English" : "Chinese", theme_mode: reduced ? "dark" : "light", onboarding_completed: true });
                        if (command === "search") return JSON.stringify({ list: rows, consumed: 1, hasMore: false, nextId: 0, nextTime: 0 });
                        if (command === "recognize_image_text" || command === "get_image_ocr") return {
                            status: ready ? "complete" : "pending",
                            text: ready ? "发票编号 invoice 2048\n项目费用 800 元\n".repeat(40) : "",
                            error: null,
                        };
                        if (command === "copy") await new Promise(resolve => setTimeout(resolve, 100));
                        if (command === "pending_preview_item" && preview) return { request_id: 1, item_type: "ImageText", content: "image" };
                        if (command === "commit_preview_window") return true;
                        if (command === "hide_preview_window") emit("preview-clear");
                        if (["list_language_packs", "list_item_tags", "get_custom_tabs"].includes(command)) return [];
                        if (command === "get_developer_mode" || command === "is_quick_input_modifier_pressed") return false;
                        if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                        if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                        if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++nextId; }
                        return null;
                    },
                    transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++nextId, callback); return nextId; },
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: { currentWindow: { label: preview ? "clipboardPreview" : "clipboard" }, currentWebview: { label: preview ? "clipboardPreview" : "clipboard" } },
                },
            });
        }, { reduced });
        await page.goto("/clipboard");
        const card = page.locator('[data-results-active="true"] [data-hash="image"][class*="clipboard-card"]');
        await expect(card).toBeVisible({ timeout: 15_000 });
        await card.click({ button: "right" });
        const title = reduced ? "View image text" : "查看图片文字";
        const copy = reduced ? "Copy all" : "复制全部";
        const close = reduced ? "Close" : "关闭";
        await page.getByText(title, { exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).__ocrProbe.calls.some((call: any) => call.command === "show_image_text_window" && call.args.hash === "image"))).toBe(true);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.goto("/clipboard/preview");
        const dialog = page.getByRole("dialog", { name: title });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(reduced ? "Recognizing text…" : "正在识别文字…")).toBeVisible();
        await expect(dialog.getByRole("button", { name: copy })).toBeDisabled();
        await expect.poll(() => page.evaluate(() => (window as any).__ocrProbe.calls.some((call: any) => call.command === "commit_preview_window"))).toBe(true);
        await page.evaluate(() => (window as any).__ocrProbe.complete());
        const text = dialog.getByRole("textbox", { name: title });
        await expect(text).toHaveValue(/invoice 2048/);
        await expect(text).toHaveAttribute("readonly");
        await expect(dialog.getByRole("heading")).toHaveCount(0);
        await expect(dialog.getByRole("button")).toHaveCount(2);
        await expect(dialog.getByRole("button", { name: copy })).toBeInViewport();
        await expect(dialog.getByRole("button", { name: close })).toBeInViewport();
        await expect(dialog.getByRole("button", { name: close })).toHaveClass(/MuiButton-containedPrimary/);
        const fieldBox = (await text.boundingBox())!;
        expect(fieldBox.height).toBeGreaterThan((reduced ? 360 : 560) * 0.5);
        expect(await text.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        const copyBox = (await dialog.getByRole("button", { name: copy }).boundingBox())!;
        const closeBox = (await dialog.getByRole("button", { name: close }).boundingBox())!;
        expect(copyBox.x).toBeGreaterThan((reduced ? 480 : 760) / 2);
        expect(closeBox.x - copyBox.x - copyBox.width).toBeCloseTo(8, 0);
        await page.screenshot({ path: testInfo.outputPath("image-text-window.png"), animations: "disabled" });
        await text.focus();
        await page.keyboard.press("Space");
        await page.keyboard.press("Enter");
        expect(await page.evaluate(() => (window as any).__ocrProbe.calls.filter((call: any) => ["paste", "copy", "show_history_preview", "show_preview_window"].includes(call.command)))).toEqual([]);
        await dialog.getByRole("button", { name: copy }).click();
        await expect.poll(() => page.evaluate(() => (window as any).__ocrProbe.calls.filter((call: any) => call.command === "record_text_history").length)).toBe(1);
        await expect(dialog.getByRole("button", { name: close })).toBeFocused();
        const selected = await text.evaluate(node => {
            const field = node as HTMLTextAreaElement;
            const start = field.value.indexOf("invoice");
            field.setSelectionRange(start, start + 12);
            const clipboardData = new DataTransfer();
            const copyEvent = new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true });
            field.dispatchEvent(copyEvent);
            return {
                text: field.value.slice(start, start + 12),
                browserPayload: clipboardData.getData("text/plain"),
                defaultPrevented: copyEvent.defaultPrevented,
            };
        });
        expect(selected).toEqual({ text: "invoice 2048", browserPayload: "", defaultPrevented: true });
        await expect.poll(() => page.evaluate(() => (window as any).__ocrProbe.calls.filter((call: any) => call.command === "record_text_history").map((call: any) => call.args.content))).toEqual([
            "发票编号 invoice 2048\n项目费用 800 元\n".repeat(40), selected.text,
        ]);
        expect(await page.evaluate(() => (window as any).__ocrProbe.calls
            .filter((call: any) => ["copy", "record_text_history"].includes(call.command))
            .map((call: any) => ({ command: call.command, text: call.args.item ?? call.args.content })))).toEqual([
                { command: "copy", text: "发票编号 invoice 2048\n项目费用 800 元\n".repeat(40) },
                { command: "record_text_history", text: "发票编号 invoice 2048\n项目费用 800 元\n".repeat(40) },
                { command: "copy", text: selected.text },
                { command: "record_text_history", text: selected.text },
            ]);
        if (reduced) await page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: close }).click();
        await expect(dialog).toHaveCount(0);
        await page.evaluate(() => (window as any).__ocrProbe.emit("preview-item", { request_id: 2, item_type: "Text", content: "Ordinary preview after OCR" }));
        await expect(page.locator('[data-preview-phase="current"]')).toHaveText("Ordinary preview after OCR");
        await expect(page.getByRole("button", { name: reduced ? "Pin preview" : "固定预览" })).toBeVisible();
    });
}
