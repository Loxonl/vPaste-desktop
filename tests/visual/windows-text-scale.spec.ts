import { expect, test, type Page } from "@playwright/test";
import { installHistoryMockBridge } from "../helpers/historyMockBridge";

type ProbeWindow = Window & { __textScaleProbe: {
    calls: Array<{ command: string; args: Record<string, unknown> }>;
    emit: (event: string, payload?: unknown) => void;
} };

async function installProbe(page: Page, label: string, nativeHeightLimit = 1000) {
    await page.exposeFunction("__resizeTextScaleProbe", async (size: { width: number; height: number }) => {
        await page.setViewportSize({ width: size.width, height: Math.min(size.height, nativeHeightLimit) });
    });
    await page.addInitScript(installHistoryMockBridge);
    await page.addInitScript(label => {
        let serial = 0;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        const calls: ProbeWindow["__textScaleProbe"]["calls"] = [];
        Object.assign(window, {
            __textScaleProbe: { calls, emit: (event: string, payload: unknown = null) => callbacks.get(listeners.get(event)!)?.({ event, payload }) },
            __TAURI_INTERNALS__: {
                metadata: { currentWindow: { label }, currentWebview: { label } },
                transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++serial, callback); return serial; },
                unregisterCallback: () => undefined,
                convertFileSrc: (value: string) => value,
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    calls.push({ command, args });
                    if (command === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true, retain_last_position: false });
                    if (command === "get_clipboard_history_paused") return false;
                    if (command === "get_developer_mode") return false;
                    if (command === "get_update_state") return { status: "disabled", currentVersion: "1.6.0", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "check_paste_accessibility_permission") return { granted: true };
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "search") return JSON.stringify({
                        list: Array.from({ length: 8 }, (_, index) => ({ id: 8 - index, hash: `text-scale-${index}`, itemType: "Text",
                            content: `Text scale fixture ${index}`, textContent: "", previewContent: "", time: 8 - index,
                            label: 0, appSource: "", appIconPath: "", tags: [] })),
                        consumed: 8, hasMore: false, nextId: 0, nextTime: 0,
                    });
                    if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++serial; }
                    if (command === "resize_tray_menu") {
                        await (window as Window & { __resizeTextScaleProbe: (size: unknown) => Promise<void> }).__resizeTextScaleProbe(args);
                    }
                    if (command === "commit_preview_window") return true;
                    return null;
                },
            },
        });
    }, label);
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test.describe(`Windows text scaling / ${reducedMotion}`, () => {
        test.use({ reducedMotion });

        for (const textScale of [1.25, 1.5, 2]) {
            test.describe(`${textScale * 100}% text`, () => {
                test.use({ deviceScaleFactor: 2 * textScale });

                test("settings navigation and controls stay reachable on a bounded screen", async ({ page }) => {
                    await page.setViewportSize({ width: Math.min(720, Math.floor(1920 / (2 * textScale))), height: Math.floor(1000 / (2 * textScale)) });
                    for (const language of ["zh-CN", "en-US"]) {
                        await page.goto(`/__settings-preview?platform=windows&lang=${language}`);
                        const tabs = page.getByRole("tablist", { name: "Configuration tabs" });
                        await expect(tabs).toBeVisible();
                        const sidebar = page.locator("[class*='sidebar']").filter({ has: tabs }).first();
                        await sidebar.hover();
                        await page.mouse.wheel(0, 600);
                        await expect(tabs.getByRole("tab").last()).toBeInViewport({ ratio: 1 });
                        await tabs.getByRole("tab").last().click();
                        await expect(page.getByRole("tabpanel")).toHaveAttribute("id", "vertical-tabpanel-3");
                        const control = page.getByRole("tabpanel").locator("button:visible").last();
                        await control.scrollIntoViewIfNeeded();
                        await expect(control).toBeInViewport({ ratio: 1 });
                    }
                });

                test("main cards keep their footer accessible and a fresh show resets vertical scrolling", async ({ page }) => {
                    const height = Math.min(302, Math.floor(1000 / (2 * textScale)));
                    await page.setViewportSize({ width: 800, height });
                    await installProbe(page, "clipboard");
                    await page.goto("/clipboard");
                    const card = page.locator('[data-hash="text-scale-0"][class*="clipboard-card"]');
                    const container = page.locator("[class*='cards-container']").first();
                    await expect(card).toBeVisible();
                    if (height < 302) {
                        await container.hover();
                        await page.mouse.wheel(0, 200);
                        await expect.poll(() => container.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
                        expect(await container.evaluate(node => node.scrollLeft)).toBe(0);
                    }
                    await expect.poll(async () => (await card.boundingBox())!.y + (await card.boundingBox())!.height).toBeLessThanOrEqual(height);
                    if (height < 302) {
                        await page.evaluate(() => {
                            const probe = (window as ProbeWindow).__textScaleProbe;
                            probe.emit("window-hide"); probe.emit("window-parked"); probe.emit("window-show");
                        });
                        await expect.poll(() => container.evaluate(node => node.scrollTop)).toBe(0);
                    }
                });
            });
        }

        test("tray remeasures content growth instead of dropping Quit below a transparent window", async ({ page }) => {
            await page.setViewportSize({ width: 216, height: 184 });
            await installProbe(page, "trayMenu");
            await page.goto("/tray-menu");
            const quit = page.getByRole("menuitem", { name: /退出|Quit|Exit/ });
            await expect(quit).toBeInViewport({ ratio: 1 });
            const initialHeight = page.viewportSize()!.height;
            await quit.evaluate(node => { node.style.height = "90px"; node.style.minHeight = "90px"; });
            await expect.poll(() => page.viewportSize()!.height).toBeGreaterThan(initialHeight);
            await expect(quit).toBeInViewport({ ratio: 1 });
            await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__textScaleProbe.calls.some(call => call.command === "auxiliary_window_ready"))).toBe(true);
        });

        test("a screen-limited tray can scroll all the way to Quit", async ({ page }) => {
            await page.setViewportSize({ width: 216, height: 140 });
            await installProbe(page, "trayMenu", 140);
            await page.goto("/tray-menu");
            const quit = page.getByRole("menuitem", { name: /退出|Quit|Exit/ });
            const frame = page.locator("[class*='tray-menu-frame']");
            await frame.hover();
            await page.mouse.wheel(0, 300);
            await expect(quit).toBeInViewport({ ratio: 1 });
        });

        test("the existing preview stays scrollable, pinnable and dismissible", async ({ page }) => {
            await page.setViewportSize({ width: 320, height: 240 });
            await installProbe(page, "clipboardPreview");
            await page.goto("/clipboard/preview");
            await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__textScaleProbe.calls.some(call => call.command === "auxiliary_window_ready"))).toBe(true);
            await page.evaluate(() => (window as ProbeWindow).__textScaleProbe.emit("preview-item", { request_id: 1, item_type: "Text", content: "Enlarged text preview\n".repeat(200) }));
            await expect(page.locator('[data-preview-phase="current"]')).toContainText("Enlarged text preview");
            const pin = page.getByRole("button", { name: /固定预览|Pin preview/ }).first();
            await expect(pin).toBeInViewport({ ratio: 1 });
            expect(await page.evaluate(() => {
                const scrollable = Array.from(document.querySelectorAll<HTMLElement>("*"))
                    .find(node => ["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight);
                if (!scrollable) return false;
                scrollable.scrollTop = scrollable.scrollHeight;
                return scrollable.scrollTop > 0;
            })).toBe(true);
            await page.keyboard.press("Escape");
            await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__textScaleProbe.calls.some(call => call.command === "hide_preview_window"))).toBe(true);
        });
    });
}
