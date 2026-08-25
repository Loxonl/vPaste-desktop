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

        const languageSelect = page.locator(".MuiSelect-select").first();
        await languageSelect.click();
        const focusedSelect = languageSelect.locator("xpath=..");
        await expect(focusedSelect.locator("fieldset")).toHaveCSS("border-top-width", "1px");
        const selectedLanguage = page.getByRole("option", {
            name: "简体中文 (大陆)",
            exact: true,
        });
        await expect(selectedLanguage).toHaveCSS("outline-style", "none");
        await expect(page).toHaveScreenshot("settings-select-first-open.png");
        await page.keyboard.press("Escape");

        await tabs.nth(1).click();
        await page.getByRole("button", { name: "管理保护应用" }).click();
        const privacyDialog = page.getByRole("dialog", { name: "管理保护应用" });
        await expect(privacyDialog).toBeVisible();

        const managerList = privacyDialog.locator("[class*='privacy-manager-list']");
        const menuCanScroll = await managerList.evaluate(
            element => element.scrollHeight > element.clientHeight,
        );
        expect(menuCanScroll).toBe(true);
        await expect(managerList).toHaveCSS("overflow-y", "auto");

        await managerList.hover();
        await page.mouse.wheel(0, 10_000);

        const managerHelp = privacyDialog.getByText("如果没有看到目标应用，请先切换到该应用复制一次非敏感内容，再重新打开管理窗口。");
        await expect.poll(async () => managerList.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await expect(managerHelp).toBeVisible();
        await expect(page).toHaveScreenshot("settings-privacy-manager-bottom.png");
        await page.keyboard.press("Escape");

        await tabs.nth(3).click();
        await expect(page.getByRole("button", { name: "检查更新" })).toBeVisible();
        await expect(page.getByText("版本 1.6.0")).toBeVisible();
        await expect(page.getByText("版本与更新")).toHaveCount(0);
        await expect(page).toHaveScreenshot("settings-about-switch.png");
    });

    test("data settings keep aligned actions and scroll protected apps after three rows", async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 520 });
        await page.goto("/__settings-preview?theme=light&lang=zh-CN&privacy=overflow");
        await page.getByRole("tab").nth(1).click();

        const privacyHeading = page.locator("[class*='privacy-app-heading']");
        await expect(privacyHeading).toHaveCSS("align-items", "center");
        const privacyCopyBox = await privacyHeading.locator(".MuiListItemText-root").boundingBox();
        const manageButtonBox = await privacyHeading.getByRole("button", { name: "管理保护应用" }).boundingBox();
        expect(privacyCopyBox).not.toBeNull();
        expect(manageButtonBox).not.toBeNull();
        expect(Math.abs(
            privacyCopyBox!.y + privacyCopyBox!.height / 2
            - (manageButtonBox!.y + manageButtonBox!.height / 2),
        )).toBeLessThan(1);

        const protectedApps = page.locator("[class*='privacy-app-list']");
        await expect(protectedApps).toHaveCSS("overflow-y", "auto");
        expect(await protectedApps.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        await expect(page).toHaveScreenshot("settings-data-protected-apps-overflow.png");

        const importButton = page.getByRole("button", { name: "导入数据" });
        const exportButton = page.getByRole("button", { name: "导出数据" });
        await expect(importButton).toHaveClass(/MuiButton-outlined/);
        await expect(exportButton).toHaveClass(/MuiButton-outlined/);

        const historySection = page.getByText("历史数据", { exact: true }).locator("xpath=..");
        await expect(historySection.getByText("数据迁移", { exact: true })).toBeVisible();
        await expect(historySection.locator("ul")).toHaveCount(1);
    });

    test("Tab support switch stays centered in the shortcut key column", async ({ page }) => {
        await page.setViewportSize({ width: 720, height: 700 });
        await page.goto("/__settings-preview?theme=light&lang=zh-CN");
        await page.getByRole("tab").nth(2).click();

        const valueColumns = page.locator("[class*='shortcut-static']");
        await expect(valueColumns).toHaveCount(6);
        const columnBoxes = await valueColumns.evaluateAll(elements => elements.map(element => {
            const box = element.getBoundingClientRect();
            return { center: box.left + box.width / 2 };
        }));
        const referenceCenter = columnBoxes[0].center;
        for (const box of columnBoxes) {
            expect(Math.abs(box.center - referenceCenter)).toBeLessThan(1);
        }

        const tabSwitch = page.getByRole("checkbox", { name: "增加Tab键支持" });
        await expect(tabSwitch).toBeVisible();
        const switchBox = await valueColumns.nth(1).locator(".MuiSwitch-root").boundingBox();
        expect(switchBox).not.toBeNull();
        expect(Math.abs(switchBox!.x + switchBox!.width / 2 - referenceCenter)).toBeLessThan(1);
        await expect(page).toHaveScreenshot("settings-shortcuts-aligned.png");
    });

    test("Windows settings use one inset rounded surface and CSS shadow", async ({ page }) => {
        await page.setViewportSize({ width: 720, height: 700 });
        await page.goto("/__settings-preview?theme=light&lang=zh-CN&platform=windows");
        await page.addStyleTag({
            content: "html, body, #root { background: #20242a !important; }",
        });

        const settingsRoot = page.getByTestId("settings-root");
        await expect(settingsRoot).toHaveCSS("border-radius", "12px");
        await expect(settingsRoot).toHaveCSS("background-color", "rgb(246, 246, 244)");
        await expect(settingsRoot).not.toHaveCSS("box-shadow", "none");
        await expect(settingsRoot).toHaveCSS("width", "704px");
        await expect(settingsRoot).toHaveCSS("height", "684px");

        const rootBox = await settingsRoot.boundingBox();
        expect(rootBox).not.toBeNull();
        expect(rootBox!.x).toBe(8);
        expect(rootBox!.y).toBe(8);
        await expect(page).toHaveScreenshot("settings-windows-single-surface.png");

        await page.getByRole("tab").nth(1).click();
        await page.getByRole("button", { name: "管理保护应用" }).click();
        await expect(page.getByRole("dialog", { name: "管理保护应用" })).toBeVisible();
        const backdrop = page.locator(".MuiBackdrop-root");
        await expect(backdrop).toHaveCSS("top", "8px");
        await expect(backdrop).toHaveCSS("right", "8px");
        await expect(backdrop).toHaveCSS("bottom", "8px");
        await expect(backdrop).toHaveCSS("left", "8px");
        await expect(backdrop).toHaveCSS("border-radius", "12px");
        await expect(page).toHaveScreenshot("settings-windows-dialog-surface.png");
    });
});
