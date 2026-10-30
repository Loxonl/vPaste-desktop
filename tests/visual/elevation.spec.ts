import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
    test(`${theme} preview media and pin keep restrained elevation`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.route("**/__elevation-image.svg", route => route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#1976d2"/></svg>',
        }));
        await page.addInitScript(() => {
            let nextId = 0;
            Object.assign(window, { __TAURI_INTERNALS__: {
                invoke: async (command: string) => {
                    if (command === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true });
                    if (command === "pending_preview_item") return { item_type: "Image", content: "/__elevation-image.svg" };
                    if (command === "resolve_history_media") return { assetPath: "/__elevation-image.svg" };
                    if (command === "history_image_metadata") return { isGif: false, width: 320, height: 200 };
                    if (command === "list_language_packs") return [];
                    if (command === "plugin:event|listen") return ++nextId;
                    return null;
                },
                transformCallback: () => ++nextId,
                unregisterCallback: () => undefined,
                convertFileSrc: (path: string) => path,
                metadata: { currentWindow: { label: "clipboardPreview" }, currentWebview: { label: "clipboardPreview" } },
            } });
        });
        await page.setViewportSize({ width: 640, height: 480 });
        await page.goto("/clipboard/preview");
        const shell = page.locator('[class*="preview-shell"]');
        const image = page.locator('[data-preview-phase="current"] img');
        const alpha = theme === "light" ? "0.08" : "0.18";
        const pinShadow = `rgba(0, 0, 0, ${alpha}) 0px 1px 3px 0px`;
        await expect(image).toBeVisible();
        await expect(image).toHaveJSProperty("naturalWidth", 320);
        await expect(image).toHaveCSS("box-shadow", `rgba(0, 0, 0, ${alpha}) 0px 2px 8px 0px`);
        await expect(shell).toHaveCSS("border-radius", "12px");
        await expect(shell).toHaveCSS("box-shadow", "none");
        const pin = page.getByRole("button", { name: "固定预览", exact: true });
        await expect(pin).toHaveCSS("box-shadow", pinShadow);
        await expect(pin).toHaveCSS("background-color", theme === "light"
            ? "rgba(255, 255, 255, 0.82)" : "rgba(35, 40, 48, 0.86)");
        await pin.click();
        const pinned = page.getByRole("button", { name: "取消固定", exact: true });
        await expect(pinned).toHaveAttribute("aria-pressed", "true");
        await expect(pinned).toHaveCSS("box-shadow", pinShadow);
        await expect(pinned).toHaveCSS("background-color", theme === "light" ? "rgb(30, 99, 214)" : "rgb(74, 168, 255)");
        await expect(page.locator('[data-preview-phase="current"]')).toHaveCSS("opacity", "1");
        await page.screenshot({ path: testInfo.outputPath("preview-pinned.png") });
        await pinned.click();
        await expect(pin).toHaveAttribute("aria-pressed", "false");
    });

    test(`${theme} menu and dialog elevations preserve controls and window edges`, async ({ page }) => {
        const menuShadow = `rgba(0, 0, 0, ${theme === "light" ? "0.12" : "0.28"}) 0px 4px 12px 0px`;
        const dialogShadow = `rgba(0, 0, 0, ${theme === "light" ? "0.14" : "0.32"}) 0px 8px 24px 0px`;
        const edgeColor = theme === "light" ? "rgba(26, 35, 46, 0.09)" : "rgba(255, 255, 255, 0.11)";

        await page.goto("/__ui-lab");
        await page.getByRole("button", { name: "中文", exact: true }).click();
        await page.getByRole("button", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
        await expect(page.getByRole("menu").locator("..")).toHaveCSS("box-shadow", menuShadow);

        const select = page.getByRole("combobox").first();
        await select.click();
        await expect(page.locator(".MuiMenu-paper")).toHaveCSS("box-shadow", menuShadow);
        await expect(page.locator(".MuiMenu-paper")).toHaveCSS("border-radius", "8px");
        await page.keyboard.press("Escape");
        await expect(select).toBeFocused();

        const trigger = page.getByTestId("dialog-trigger");
        await trigger.click();
        const confirmation = page.getByRole("alertdialog", { name: "确认操作" });
        await expect(confirmation).toHaveCSS("box-shadow", dialogShadow);
        await expect(confirmation).toHaveCSS("border-top-color", edgeColor);
        await expect(confirmation).toHaveCSS("border-radius", "14px");
        await expect(confirmation).toHaveJSProperty("offsetWidth", 282);
        await page.keyboard.press("Escape");
        await expect(confirmation).toBeHidden();
        await expect(trigger).toBeFocused();

        await page.setViewportSize({ width: 640, height: 520 });
        await page.goto(`/__settings-preview?theme=${theme}&lang=zh-CN&platform=windows`);
        const windowSurface = page.getByTestId("settings-root");
        await expect(windowSurface).toHaveCSS("margin", "8px");
        await expect(windowSurface).toHaveCSS("border-radius", "12px");
        const windowShadow = await windowSurface.evaluate(element => getComputedStyle(element).boxShadow);

        await page.getByRole("tab", { name: "数据", exact: true }).click();
        const manage = page.getByRole("button", { name: "管理保护应用", exact: true });
        await manage.click();
        const manager = page.getByRole("dialog", { name: "管理保护应用" });
        await expect(manager).toHaveCSS("box-shadow", dialogShadow);
        await expect(manager).toHaveCSS("border-top-width", "1px");
        await expect(manager).toHaveCSS("border-top-color", edgeColor);
        await expect(manager).toHaveCSS("border-radius", "14px");
        await expect(page.locator(".MuiBackdrop-root")).toHaveCSS("border-radius", "12px");
        await expect(windowSurface).toHaveCSS("box-shadow", windowShadow);
        await page.keyboard.press("Escape");
        await expect(manager).toBeHidden();
        await expect(manage).toBeFocused();
    });
}
