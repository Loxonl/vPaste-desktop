import { expect, test } from "@playwright/test";

test.describe("about page", () => {
    test("shows one update button, the star prompt and three link buttons", async ({ page }) => {
        await page.setViewportSize({ width: 720, height: 560 });
        await page.goto("/__settings-preview?theme=light&lang=zh-CN");
        await page.getByRole("tab").nth(3).click();

        await expect(page.getByRole("button", { name: "检查更新" })).toBeVisible();
        await expect(page.getByText("版本 1.6.0")).toBeVisible();
        for (const name of ["官方网站", "GitHub 主页", "更新记录"]) {
            await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
        }
        const prompt = page.getByRole("note");
        await expect(prompt).toContainText("如果觉得 vPaste 好用");
        await expect(prompt.getByRole("button", { name: "去点 Star" })).toBeVisible();

        const linkTops = await Promise.all(["官方网站", "GitHub 主页", "更新记录"].map(async name =>
            (await page.getByRole("button", { name, exact: true }).boundingBox())!.y));
        expect(new Set(linkTops.map(Math.round)).size).toBe(1);
    });

    for (const reducedMotion of ["no-preference", "reduce"] as const) {
        test(`the star icon spins only without reduced motion (${reducedMotion})`, async ({ page }) => {
            await page.emulateMedia({ reducedMotion });
            await page.goto("/__settings-preview?theme=light&lang=zh-CN");
            await page.getByRole("tab").nth(3).click();
            const star = page.getByRole("note").locator("svg").first();
            await expect(star).toHaveCSS("animation-name", /aboutStarSpin/);
            await expect(star).toHaveCSS("animation-iteration-count", reducedMotion === "reduce" ? "1" : "infinite");
        });
    }

    test("the star prompt stays dismissed after reopening settings", async ({ page }) => {
        await page.goto("/__settings-preview?theme=dark&lang=en-US");
        await page.getByRole("tab").nth(3).click();
        await page.getByRole("button", { name: "Don't show again" }).click();
        await expect(page.getByRole("note")).toHaveCount(0);

        await page.reload();
        await page.getByRole("tab").nth(3).click();
        await expect(page.getByRole("button", { name: "Check for Updates" })).toBeVisible();
        await expect(page.getByRole("note")).toHaveCount(0);
    });
});
