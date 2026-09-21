import { expect, test, type Page } from "@playwright/test";

type ProbeWindow = Window & {
    __pasteCalls: Array<{ command: string; args: Record<string, unknown> }>;
    __setHeld: (value: boolean) => void;
};

const commandCount = (page: Page, command: string) => page.evaluate(command =>
    (window as ProbeWindow).__pasteCalls.filter(call => call.command === command).length, command);

for (const separatePresses of [false, true]) {
test(`quick input hides before release and pastes once (${separatePresses ? "separate presses" : "auto repeat"})`, async ({ page }) => {
    await page.addInitScript(() => {
        let callbackId = 0;
        let held = true;
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        Object.assign(window, {
            __pasteCalls: calls,
            __setHeld: (value: boolean) => { held = value; },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    calls.push({ command, args });
                    if (command === "is_quick_input_modifier_pressed") return held;
                    if (command === "begin_hide_clipboard_window") return 1;
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
    await expect(page.getByText("Search paste regression", { exact: true }).first()).toBeVisible();
    await page.keyboard.down("Alt");
    for (let index = 0; index < 5; index++) {
        await page.keyboard.down("1");
        if (separatePresses) await page.keyboard.up("1");
    }
    await expect.poll(() => commandCount(page, "is_quick_input_modifier_pressed")).toBeGreaterThan(0);
    expect(await commandCount(page, "finish_hide_clipboard_window")).toBe(1);
    expect(await commandCount(page, "copy")).toBe(0);
    expect(await commandCount(page, "paste")).toBe(0);
    await page.keyboard.up("1");
    await page.keyboard.up("Alt");
    await page.evaluate(() => (window as ProbeWindow).__setHeld(false));
    await expect.poll(() => commandCount(page, "paste")).toBeGreaterThan(0);
    expect(await commandCount(page, "check_paste_accessibility_permission")).toBe(1);
    expect(await commandCount(page, "copy")).toBe(1);
    expect(await commandCount(page, "paste")).toBe(1);
    expect(await commandCount(page, "finish_hide_clipboard_window")).toBe(1);

    await page.evaluate(() => (window as ProbeWindow).__setHeld(true));
    await page.keyboard.down("Alt");
    await page.keyboard.down("1");
    await expect.poll(() => commandCount(page, "check_paste_accessibility_permission")).toBe(2);
    expect(await commandCount(page, "paste")).toBe(1);
    await page.keyboard.up("1");
    await page.keyboard.up("Alt");
    await page.evaluate(() => (window as ProbeWindow).__setHeld(false));
    await expect.poll(() => commandCount(page, "paste")).toBe(2);
    expect(await commandCount(page, "copy")).toBe(2);
});
}
