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

    test("switch geometry and select menu states stay aligned", async ({ page }) => {
        const switchRoot = page.locator(".MuiSwitch-root").first();
        const switchTrack = switchRoot.locator(".MuiSwitch-track");
        const switchThumb = switchRoot.locator(".MuiSwitch-thumb");

        const rootBox = await switchRoot.boundingBox();
        const trackBox = await switchTrack.boundingBox();
        const thumbBox = await switchThumb.boundingBox();

        expect(rootBox).not.toBeNull();
        expect(trackBox).toEqual(rootBox);
        expect(thumbBox?.x).toBe(rootBox!.x + rootBox!.width - thumbBox!.width - 2);
        expect(thumbBox?.y).toBe(rootBox!.y + 2);

        await page.getByRole("combobox").first().click();
        const selectedOption = page.getByRole("option", { name: "简体中文" });
        const hoveredOption = page.getByRole("option", { name: "English" });
        await hoveredOption.hover();

        await expect.poll(async () => hoveredOption.evaluate(
            element => getComputedStyle(element).backgroundColor,
        )).not.toBe("rgba(0, 0, 0, 0)");

        await expect(selectedOption).toHaveCSS("border-radius", "0px");
        await expect(selectedOption).toHaveCSS("box-shadow", "none");
        await expect(selectedOption).toHaveCSS("outline-style", "none");
        await expect(page.locator(".MuiMenu-paper")).toHaveCSS("border-radius", "8px");

        await expect(page).toHaveScreenshot("ui-lab-select-open.png", {
            fullPage: true,
        });
    });
});
