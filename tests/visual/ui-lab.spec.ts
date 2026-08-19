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

    test("light English component inventory", async ({ page }) => {
        await page.getByRole("button", { name: "English" }).click();
        await page.getByRole("button", { name: "Light" }).click();

        await expect(page).toHaveScreenshot("ui-lab-light-en.png", {
            fullPage: true,
        });
    });

    test("dark Chinese component inventory", async ({ page }) => {
        await page.getByRole("button", { name: "中文" }).click();
        await page.getByRole("button", { name: "Dark" }).click();

        await expect(page).toHaveScreenshot("ui-lab-dark-zh.png", {
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

    test("keyboard, validation, tooltip, tabs, and dialog states remain operable", async ({ page }) => {
        const saveButton = page.getByRole("button", { name: "保存", exact: true }).first();
        await page.locator("body").click({ position: { x: 1, y: 1 } });
        for (let index = 0; index < 5; index += 1) {
            await page.keyboard.press("Tab");
        }
        await expect(saveButton).toBeFocused();
        await expect(saveButton).toHaveCSS("outline-style", "none");
        await expect.poll(async () => saveButton.evaluate(
            element => getComputedStyle(element).boxShadow,
        )).not.toBe("none");

        const saveBox = await saveButton.boundingBox();
        expect(saveBox?.width).toBeGreaterThanOrEqual(24);
        expect(saveBox?.height).toBeGreaterThanOrEqual(24);

        const cancelButton = page.getByRole("button", { name: "取消", exact: true }).first();
        const initialCancelBackground = await cancelButton.evaluate(
            element => getComputedStyle(element).backgroundColor,
        );
        await cancelButton.hover();
        await expect.poll(async () => cancelButton.evaluate(
            element => getComputedStyle(element).backgroundColor,
        )).not.toBe(initialCancelBackground);
        await expect(page.getByRole("button", { name: "保存", exact: true }).nth(1)).toBeDisabled();

        const errorField = page.getByRole("textbox", { name: "错误输入" });
        await expect(errorField).toHaveAttribute("aria-invalid", "true");
        await expect(errorField).toHaveAccessibleDescription("请输入有效的名称。");
        await errorField.focus();
        await expect(errorField.locator("xpath=..")).toHaveCSS(
            "box-shadow",
            "rgba(217, 48, 37, 0.18) 0px 0px 0px 3px",
        );
        await expect(page.getByRole("textbox", { name: "只读输入" })).toHaveAttribute("readonly", "");
        await expect(page.getByRole("textbox", { name: "禁用输入" })).toBeDisabled();
        await expect(page.getByRole("combobox", { name: "禁用选择" })).toBeDisabled();

        const activeSwitch = page.getByRole("checkbox", { name: "开机启动 · 开启" });
        await activeSwitch.focus();
        await activeSwitch.press("Space");
        await expect(activeSwitch).not.toBeChecked();

        const checkedCheckbox = page.getByRole("checkbox", { name: "已勾选", exact: true });
        await checkedCheckbox.focus();
        await checkedCheckbox.press("Space");
        await expect(checkedCheckbox).not.toBeChecked();

        const longSelect = page.getByTestId("lab-long-select").getByRole("combobox");
        await longSelect.focus();
        await longSelect.press("Enter");
        const finalOption = page.getByRole("option", { name: "最近来源应用 18" });
        await page.keyboard.press("End");
        await expect(finalOption).toBeInViewport();
        await page.keyboard.press("Enter");
        await expect(longSelect).toContainText("最近来源应用 18");

        const firstTab = page.getByRole("tab", { name: "常规" });
        const secondTab = page.getByRole("tab", { name: "数据" });
        await firstTab.focus();
        await firstTab.press("ArrowDown");
        await expect(secondTab).toHaveAttribute("aria-selected", "true");

        const tooltipTrigger = page.getByRole("button", { name: "查看提示" });
        await tooltipTrigger.focus();
        await expect(page.getByRole("tooltip")).toContainText(
            "工具提示同时支持鼠标悬停和键盘焦点。",
        );
        await expect(tooltipTrigger).toHaveAccessibleDescription(
            "工具提示同时支持鼠标悬停和键盘焦点。",
        );

        const dialogTrigger = page.getByTestId("dialog-trigger");
        for (const control of [activeSwitch, longSelect, firstTab, dialogTrigger]) {
            const target = await control.boundingBox();
            expect(target?.width).toBeGreaterThanOrEqual(24);
            expect(target?.height).toBeGreaterThanOrEqual(24);
        }

        await dialogTrigger.click();
        const dialog = page.getByRole("alertdialog", { name: "确认操作" });
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Tab");
        await expect.poll(async () => dialog.evaluate(
            element => element.contains(document.activeElement),
        )).toBe(true);
        await expect(dialog).toHaveScreenshot("ui-lab-dialog.png");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(dialogTrigger).toBeFocused();

        await expect(page.getByRole("progressbar", { name: "确定进度" })).toBeVisible();
        await expect(page.getByRole("progressbar", { name: "未知进度" })).toBeVisible();
    });
});
