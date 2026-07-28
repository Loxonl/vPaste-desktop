import { expect, test } from "@playwright/test";

const variants = [
    { name: "light-zh-regular", theme: "light", lang: "zh-CN", width: 720, height: 700, tab: 0 },
    { name: "dark-en-regular", theme: "dark", lang: "en-US", width: 720, height: 700, tab: 0 },
    { name: "light-zh-minimum", theme: "light", lang: "zh-CN", width: 640, height: 520, tab: 1 },
    { name: "dark-en-minimum", theme: "dark", lang: "en-US", width: 640, height: 520, tab: 1 },
] as const;

test.describe("settings preview", () => {
    for (const variant of variants) {
        test(variant.name, async ({ page }) => {
            await page.setViewportSize({ width: variant.width, height: variant.height });
            await page.goto(`/__settings-preview?theme=${variant.theme}&lang=${variant.lang}`);

            const tabs = page.getByRole("tab");
            await expect(tabs).toHaveCount(4);
            await expect(page.locator("html")).toHaveAttribute("data-theme", variant.theme);
            await expect(page.getByTestId("settings-root")).toHaveCSS("border-radius", "12px");
            await expect(page.getByTestId("settings-root")).toHaveCSS("overflow", "hidden");

            if (variant.tab !== 0) {
                await tabs.nth(variant.tab).click();
            }

            await expect(page).toHaveScreenshot(`settings-${variant.name}.png`);
        });
    }

    test("select focus, long-menu scrolling, and compact about layout remain consistent", async ({ page }) => {
        await page.setViewportSize({ width: 720, height: 700 });
        await page.goto("/__settings-preview?theme=light&lang=zh-CN");

        const tabs = page.getByRole("tab");
        await expect(tabs).toHaveCount(4);

        await page.locator(".MuiSelect-select").first().click();
        const selectedLanguage = page.getByRole("option", {
            name: "简体中文 (大陆)",
            exact: true,
        });
        await expect(selectedLanguage).toHaveCSS("outline-style", "none");
        await expect(page).toHaveScreenshot("settings-select-first-open.png");
        await page.keyboard.press("Escape");

        await tabs.nth(1).click();
        const recentSourceSelect = page.locator(".MuiSelect-select").first();
        await recentSourceSelect.click();

        const menuPaper = page.locator(".MuiMenu-paper");
        const menuCanScroll = await menuPaper.evaluate(
            element => element.scrollHeight > element.clientHeight,
        );
        expect(menuCanScroll).toBe(true);
        await expect(menuPaper).toHaveCSS("overflow-y", "auto");

        await menuPaper.hover();
        await page.mouse.wheel(0, 10_000);

        const menuHint = page.getByRole("option", {
            name: "如果没有看到目标应用，请先切换到该应用复制一次非敏感内容，再回到这里刷新并添加。",
        });
        await expect.poll(async () => menuPaper.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await expect(menuHint).toBeInViewport();
        await expect(page).toHaveScreenshot("settings-recent-source-menu-bottom.png");
        await page.keyboard.press("Escape");

        await tabs.nth(3).click();
        await expect(page.getByRole("button", { name: "检查更新" })).toBeVisible();
        await expect(page.getByText("版本 1.6.0")).toBeVisible();
        await expect(page.getByText("版本与更新")).toHaveCount(0);
        await expect(page).toHaveScreenshot("settings-about-switch.png");
    });
});
