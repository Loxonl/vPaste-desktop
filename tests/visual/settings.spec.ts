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

            if (variant.tab !== 0) {
                await tabs.nth(variant.tab).click();
            }

            await expect(page).toHaveScreenshot(`settings-${variant.name}.png`);
        });
    }
});
