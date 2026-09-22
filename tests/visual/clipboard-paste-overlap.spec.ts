import { expect, test, type Page } from "@playwright/test";

type ProbeWindow = Window & {
    __finishHide: () => void;
    __pasteCalls: Array<{ command: string; args: Record<string, unknown> }>;
};

const commandCount = (page: Page, command: string) => page.evaluate(command =>
    (window as ProbeWindow).__pasteCalls.filter(call => call.command === command).length, command);

for (const repeat of [false, true]) {
    test(`ordinary Enter must not overlap an in-flight paste (${repeat})`, async ({ page }) => {
        await page.addInitScript(() => {
            let callbackId = 0;
            const callbacks = new Map<number, (event: unknown) => void>();
            const listeners = new Map<string, number>();
            let finishHide!: () => void;
            const hideFinished = new Promise<void>(resolve => { finishHide = resolve; });
            const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
            Object.assign(window, {
                __pasteCalls: calls,
                __finishHide: () => finishHide(),
                __TAURI_INTERNALS__: {
                    invoke: async (command: string, args: Record<string, unknown> = {}) => {
                        calls.push({ command, args });
                        if (command === "is_quick_input_modifier_pressed") return false;
                        if (command === "begin_hide_clipboard_window") {
                            callbacks.get(listeners.get("window-hide")!)?.({ payload: null });
                            return 1;
                        }
                        if (command === "finish_hide_clipboard_window") {
                            // Hold the native hide lifecycle until both key presses have been delivered.
                            await hideFinished;
                            callbacks.get(listeners.get("window-hidden")!)?.({ payload: null });
                        }
                        if (command === "search") return JSON.stringify({
                            list: [{
                                id: 1, hash: "rich-search-result", itemType: "Text",
                                content: "Search paste regression", previewContent: "",
                                textContent: "", richHtml: "<b>Search paste regression</b>",
                                time: 1, label: 0, appSource: "", appIconPath: "", tags: [],
                            }],
                            consumed: 1, hasMore: false, nextId: 0, nextTime: 0,
                        });
                        if (command === "get_config") return JSON.stringify({
                            multilingual: "Chinese", onboarding_completed: true,
                        });
                        if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                        if (command === "get_developer_mode") return false;
                        if (command === "get_paste_queue_state") return { active: false, revision: 0 };
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
        });
        await page.goto("/clipboard");
        await expect(page.getByText("Search paste regression", { exact: true }).first()).toBeVisible();
        await page.keyboard.press("Enter");
        await expect.poll(() => commandCount(page, "finish_hide_clipboard_window")).toBe(1);
        if (repeat) await page.keyboard.press("Enter");
        await page.evaluate(() => (window as ProbeWindow).__finishHide());
        await expect.poll(() => commandCount(page, "paste")).toBeGreaterThan(0);
        await page.waitForTimeout(200);
        const copies = await commandCount(page, "copy");
        const pastes = await commandCount(page, "paste");
        expect(copies).toBe(1);
        expect(pastes).toBe(1);
    });
}
