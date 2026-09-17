import { expect, test } from "@playwright/test";

for (const plainText of [false, true]) {
    test(`search submits rich text with plainText=${plainText}`, async ({ page }) => {
        await page.addInitScript(() => {
            let callbackId = 0;
            const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
            Object.assign(window, {
                __pasteCalls: calls,
                __TAURI_INTERNALS__: {
                    invoke: async (command: string, args: Record<string, unknown> = {}) => {
                        calls.push({ command, args });
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
                        if (command === "plugin:event|listen") return ++callbackId;
                        return null;
                    },
                    transformCallback: () => ++callbackId,
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
        await page.getByRole("button", { name: "搜索", exact: true }).click();
        const search = page.getByRole("textbox", { name: "搜索" });
        await search.fill("regression");
        await expect(page.getByText("Search paste regression", { exact: true }).first()).toBeVisible();
        await search.press(plainText ? "Shift+Enter" : "Enter");
        await expect.poll(() => page.evaluate(() => (
            window as typeof window & {
                __pasteCalls: Array<{ command: string; args: Record<string, unknown> }>;
            }
        ).__pasteCalls.filter(call => call.command === "copy" || call.command === "paste")))
            .toEqual([
                { command: "copy", args: {
                    item: "Search paste regression", itemType: "Text",
                    hash: plainText ? null : "rich-search-result",
                } },
                { command: "paste", args: {
                    hash: "rich-search-result", restoreAlt: false, triggerKey: "",
                } },
            ]);
    });
}
