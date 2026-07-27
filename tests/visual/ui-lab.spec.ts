import { expect, test } from "@playwright/test";

test.describe("UI lab", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/__ui-lab");
        await expect(page.getByTestId("ui-lab")).toBeVisible();
    });

    test("light Chinese component inventory", async ({ page }) => {
        await page.getByRole("button", { name: "中文" }).click();
        await page.getByRole("button", { name: "Light" }).click();

        await expect(page).toHaveScreenshot("ui-lab-light-zh.png", {
            fullPage: true,
        });
    });

    test("dark English component inventory", async ({ page }) => {
        await page.getByRole("button", { name: "English" }).click();
        await page.getByRole("button", { name: "Dark" }).click();

        await expect(page).toHaveScreenshot("ui-lab-dark-en.png", {
            fullPage: true,
        });
    });
});
