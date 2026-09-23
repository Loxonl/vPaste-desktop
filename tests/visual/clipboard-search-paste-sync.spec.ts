import { expect, test, type Page } from "@playwright/test";

type ProbeWindow = Window & {
    __emit: (event: string) => void;
    __releaseSearch: () => void;
    __pasteCalls: Array<{ command: string; args: Record<string, unknown> }>;
};

const commandCount = (page: Page, command: string) => page.evaluate(command =>
    (window as ProbeWindow).__pasteCalls.filter(call => call.command === command).length, command);

for (const scenario of ["ready", "pending", "plain", "quick", "empty", "failed", "edit", "hide", "navigate", "debounce", "queue"] as const) {
    test(`search Enter uses current results (${scenario})`, async ({ page }) => {
        await page.addInitScript(scenario => {
            let callbackId = 0;
            const callbacks = new Map<number, (event: unknown) => void>();
            const listeners = new Map<string, number>();
            let releaseSearch!: () => void;
            const searchReady = new Promise<void>(resolve => { releaseSearch = resolve; });
            const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
            Object.assign(window, {
                __pasteCalls: calls,
                __emit: (event: string) => callbacks.get(listeners.get(event)!)?.({ payload: null }),
                __releaseSearch: () => releaseSearch(),
                __TAURI_INTERNALS__: {
                    invoke: async (command: string, args: Record<string, unknown> = {}) => {
                        calls.push({ command, args });
                        if (command === "is_quick_input_modifier_pressed") return false;
                        if (command === "begin_hide_clipboard_window") {
                            callbacks.get(listeners.get("window-hide")!)?.({ payload: null });
                            return 1;
                        }
                        if (command === "finish_hide_clipboard_window") {
                            await Promise.resolve();
                            callbacks.get(listeners.get("window-hidden")!)?.({ payload: null });
                        }
                        if (command === "search" && args.keywords) await searchReady;
                        if (command === "search" && args.keywords && scenario === "failed") throw new Error("Search failed");
                        if (command === "search") return JSON.stringify({
                            list: args.keywords && scenario === "empty" ? [] : [{
                                id: 1, hash: args.keywords ? "matching-result" : "old-result", itemType: "Text",
                                content: args.keywords ? "needle matching text" : "Previous unrelated text", previewContent: "",
                                textContent: "", richHtml: "",
                                time: 1, label: 0, appSource: "", appIconPath: "", tags: [],
                            }],
                            consumed: 1, hasMore: false, nextId: 0, nextTime: 0,
                        });
                        if (command === "get_config") return JSON.stringify({
                            multilingual: "Chinese", onboarding_completed: true,
                        });
                        if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                        if (command === "get_developer_mode") return false;
                        if (command === "get_paste_queue_state") return { active: scenario === "queue", revision: 0 };
                        if (command === "check_paste_accessibility_permission") return { granted: true, needs_settings: false };
                        if (command === "get_update_state") return {
                            status: "disabled", currentVersion: "", downloadedBytes: 0,
                            portable: false, feedEnabled: false, releaseUrl: "",
                        };
                        if (command === "plugin:event|listen") {
                            listeners.set(args.event as string, args.handler as number);
                            return ++callbackId;
                        }
                        return null;
                    },
                    transformCallback: (callback: (event: unknown) => void) => {
                        callbacks.set(++callbackId, callback);
                        return callbackId;
                    },
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: {
                        currentWindow: { label: "clipboard" },
                        currentWebview: { label: "clipboard" },
                    },
                },
            });
        }, scenario);
        await page.goto("/clipboard");
        await expect(page.getByText("Previous unrelated text", { exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: "搜索", exact: true }).click();
        await page.getByRole("textbox", { name: "搜索" }).fill("needle");
        if (scenario !== "debounce") {
            await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__pasteCalls.some(call => call.command === "search" && call.args.keywords === "needle"))).toBe(true);
        }
        if (scenario === "ready") {
            await page.evaluate(() => (window as ProbeWindow).__releaseSearch());
            await expect(page.getByText("needle matching text", { exact: true }).first()).toBeVisible();
        }
        const key = scenario === "plain" ? "Shift+Enter" : scenario === "quick" ? "Alt+1" : "Enter";
        await page.keyboard.press(key);
        if (scenario !== "ready") {
            await page.keyboard.press(key);
            await page.waitForTimeout(150);
            expect(await commandCount(page, "copy")).toBe(0);
            expect(await commandCount(page, "paste")).toBe(0);
        }
        if (scenario === "edit") await page.getByRole("textbox", { name: "搜索" }).fill("changed");
        if (scenario === "hide") await page.evaluate(() => (window as ProbeWindow).__emit("window-hide"));
        if (scenario === "navigate") {
            await page.getByRole("textbox", { name: "搜索" }).evaluate(input => (input as HTMLElement).blur());
            await page.keyboard.press("ArrowRight");
        }
        await page.evaluate(() => (window as ProbeWindow).__releaseSearch());
        if (scenario === "queue") {
            await expect(page.locator('[data-hash="matching-result"] [data-motion-state="queue-selection"]')).toBeVisible();
            expect(await commandCount(page, "copy")).toBe(0);
            expect(await commandCount(page, "paste")).toBe(0);
        } else if (["empty", "failed", "edit", "hide", "navigate"].includes(scenario)) {
            await page.waitForTimeout(300);
            expect(await commandCount(page, "copy")).toBe(0);
            expect(await commandCount(page, "paste")).toBe(0);
        } else {
            await expect.poll(() => commandCount(page, "paste")).toBe(1);
            const writes = await page.evaluate(() => (window as ProbeWindow).__pasteCalls.filter(call => call.command === "copy" || call.command === "paste"));
            expect(writes.find(call => call.command === "copy")?.args.item).toBe("needle matching text");
            expect(writes.find(call => call.command === "copy")?.args.hash).toBe(scenario === "plain" ? null : "matching-result");
            expect(writes.find(call => call.command === "paste")?.args.hash).toBe("matching-result");
            expect(await commandCount(page, "copy")).toBe(1);
        }
    });
}
