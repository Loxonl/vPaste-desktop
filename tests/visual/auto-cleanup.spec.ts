import { expect, test } from "@playwright/test";

for (const variant of [
    { theme: "light", language: "zh-CN", reducedMotion: "no-preference" as const },
    { theme: "dark", language: "en-US", reducedMotion: "reduce" as const },
]) {
    test(`automatic cleanup settings ${variant.theme} ${variant.language}`, async ({ page }, testInfo) => {
        const zh = variant.language === "zh-CN";
        await page.setViewportSize({ width: 640, height: 520 });
        await page.emulateMedia({ reducedMotion: variant.reducedMotion });
        await page.goto(`/__settings-preview?theme=${variant.theme}&lang=${variant.language}`);
        await page.getByRole("tab").nth(1).click();
        const mode = page.getByRole("combobox", { name: zh ? "自动清理数据" : "Automatic data cleanup" });
        await expect(mode).toHaveText(zh ? "不自动清理" : "Do not clean automatically");
        await expect(page.getByText(zh ? "手动清理数据" : "Manual data cleanup")).toBeVisible();
        await mode.click();
        await page.getByRole("option", { name: zh ? "按时间保留" : "Keep by age" }).click();
        await page.getByRole("combobox", { name: zh ? "保留范围" : "Retention range" }).click();
        await page.getByRole("option", { name: zh ? "自定义" : "Custom", exact: true }).click();
        await expect(page.getByRole("listbox")).toHaveCount(0);
        const amount = page.getByRole("spinbutton", { name: zh ? "保留天数" : "Days to keep" });
        await amount.fill("45");
        await page.getByTestId("automatic-cleanup").scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("custom-retention.png"), animations: "disabled" });
        await page.getByRole("button", { name: zh ? "应用" : "Apply", exact: true }).click();
        const confirmation = page.getByRole("alertdialog");
        await expect(confirmation).toBeVisible();
        await expect(confirmation).toContainText("148");
        await page.screenshot({ path: testInfo.outputPath("confirmation.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        await expect(confirmation).not.toBeVisible();
        await page.getByRole("button", { name: zh ? "应用" : "Apply", exact: true }).click();
        await confirmation.getByRole("button", { name: zh ? "应用并开启" : "Apply and enable" }).click();
        await expect(confirmation).not.toBeVisible();
        await page.getByRole("tab").nth(0).click();
        await page.getByRole("tab").nth(1).click();
        await expect(amount).toHaveValue("45");
        await mode.click();
        await page.getByRole("option", { name: zh ? "不自动清理" : "Do not clean automatically" }).click();
        await expect(amount).toHaveCount(0);
        await page.getByRole("tab").nth(0).click();
        await page.getByRole("tab").nth(1).click();
        await expect(mode).toHaveText(zh ? "不自动清理" : "Do not clean automatically");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
}
