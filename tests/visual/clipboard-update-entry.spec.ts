import { expect, test, type Page } from "@playwright/test";

type ProbeWindow = Window & {
    __updateCalls: Array<{ command: string; args: Record<string, unknown> }>;
};

const commandCount = (page: Page, command: string) => page.evaluate(command =>
    (window as ProbeWindow).__updateCalls.filter(call => call.command === command).length, command);

async function openClipboardWithUpdate(page: Page, status: "ready" | "downloading") {
    await page.addInitScript(status => {
        let callbackId = 0;
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        Object.assign(window, {
            __updateCalls: calls,
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    calls.push({ command, args });
                    if (command === "search") return JSON.stringify({
                        list: [{
                            id: 1, hash: "update-entry-item", itemType: "Text",
                            content: "Selected clipboard item", previewContent: "",
                            textContent: "", richHtml: "",
                            time: 1, label: 0, appSource: "", appIconPath: "", tags: [],
                        }],
                        consumed: 1, hasMore: false, nextId: 0, nextTime: 0,
                    });
                    if (command === "get_config") return JSON.stringify({
                        multilingual: "English", onboarding_completed: true, tab_quick_select_enabled: false,
                    });
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "get_developer_mode") return false;
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "check_paste_accessibility_permission") return { granted: true, needs_settings: false };
                    if (command === "get_update_state") return {
                        revision: 3, status, currentVersion: "1.6.0", availableVersion: "1.7.0",
                        downloadedBytes: 10, totalBytes: 20, portable: false, feedEnabled: true, releaseUrl: "",
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
    }, status);
    await page.goto("/clipboard");
    await expect(page.getByText("Selected clipboard item", { exact: true }).first()).toBeVisible();
}

const updateButtonName = /1\.7\.0/;

test("ready update shows a round icon right of settings without growing the header", async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 600 });
    await openClipboardWithUpdate(page, "ready");

    const settings = page.getByRole("button", { name: "Settings", exact: true });
    const update = page.getByRole("button", { name: updateButtonName });
    await expect(update).toBeVisible();
    await expect(update).toHaveAttribute("title", /1\.7\.0/);
    await expect(update).toHaveCSS("border-radius", "50%");

    const settingsBox = (await settings.boundingBox())!;
    const updateBox = (await update.boundingBox())!;
    expect(updateBox.x).toBeGreaterThan(settingsBox.x + settingsBox.width - 1);
    expect(Math.abs(updateBox.y - settingsBox.y)).toBeLessThanOrEqual(1);
    expect(updateBox.width).toBe(settingsBox.width);
    expect(updateBox.height).toBe(settingsBox.height);
    await expect(page.locator("[class*='clipboard-header']").first()).toHaveCSS("height", "48px");

    const settingsBackground = await settings.evaluate(element => getComputedStyle(element).backgroundColor);
    await expect(update).not.toHaveCSS("background-color", settingsBackground);
});

test("update icon stays readable in the dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openClipboardWithUpdate(page, "ready");
    const update = page.getByRole("button", { name: updateButtonName });
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    const settingsBackground = await settings.evaluate(element => getComputedStyle(element).backgroundColor);
    await expect(update).not.toHaveCSS("background-color", settingsBackground);
    await expect(update).toHaveCSS("border-radius", "50%");
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`Enter, Space and click install without pasting (reduced motion: ${reducedMotion})`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion });
        await openClipboardWithUpdate(page, "ready");
        const update = page.getByRole("button", { name: updateButtonName });

        await update.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => commandCount(page, "restart_and_install_app_update")).toBe(1);
        await page.keyboard.press(" ");
        await expect.poll(() => commandCount(page, "restart_and_install_app_update")).toBe(2);
        await update.click();
        await expect.poll(() => commandCount(page, "restart_and_install_app_update")).toBe(3);

        expect(await commandCount(page, "copy")).toBe(0);
        expect(await commandCount(page, "paste")).toBe(0);
        expect(await commandCount(page, "show_preview_window")).toBe(0);
    });
}

test("a download in progress does not show the install icon", async ({ page }) => {
    await openClipboardWithUpdate(page, "downloading");
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: updateButtonName })).toHaveCount(0);
});
