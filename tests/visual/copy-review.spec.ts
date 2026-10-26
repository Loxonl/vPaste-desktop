import { expect, test, type Locator, type Page } from "@playwright/test";
import zhCN from "../../src/lang/locales/zh-CN";
import enUS from "../../src/lang/locales/en-US";

async function expectDialogFits(page: Page, dialog: Locator) {
    const viewport = page.viewportSize()!;
    const box = (await dialog.boundingBox())!;
    await expect(dialog).toHaveCSS("width", "280px");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const button of await dialog.getByRole("button").all()) {
        await expect(button).toBeInViewport({ ratio: 1 });
    }
}

for (const variant of [
    { lang: "zh-CN", theme: "light", motion: "no-preference", pack: zhCN },
    { lang: "en-US", theme: "dark", motion: "reduce", pack: enUS },
] as const) {
    test(`approved copy fits existing settings and cleanup dialogs (${variant.lang})`, async ({ page }, testInfo) => {
        const t = (key: string) => variant.pack.translations[key];
        await page.setViewportSize({ width: 640, height: 520 });
        await page.emulateMedia({ reducedMotion: variant.motion });
        await page.goto(`/__settings-preview?lang=${variant.lang}&theme=${variant.theme}`);
        await expect(page.getByRole("tab")).toHaveCount(4, { timeout: 15000 });
        for (const key of ["settings.language", "settings.retainTabPosition", "settings.retainPosition"]) {
            const label = page.getByText(t(key), { exact: true });
            await expect(label).toBeVisible();
            expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
        await page.getByRole("tab").nth(1).click();
        await page.getByRole("combobox", { name: t("settings.autoCleanup.title") }).click();
        await page.getByRole("option", { name: t("settings.autoCleanup.days"), exact: true }).click();
        const apply = page.getByRole("button", { name: t("settings.autoCleanup.apply"), exact: true });
        await apply.click();
        const automatic = page.getByRole("alertdialog", { name: t("settings.autoCleanup.confirmTitle") });
        await expect(automatic).toBeVisible();
        await expect(automatic.getByRole("listitem")).toHaveCount(3);
        await expect(automatic.getByText(t("settings.cleanup.irreversible"), { exact: true })).toBeVisible();
        await expectDialogFits(page, automatic);
        await automatic.screenshot({ path: testInfo.outputPath("automatic-cleanup.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        await expect(automatic).toBeHidden();
        await expect(apply).toBeEnabled();

        await page.getByRole("button", { name: t("settings.cleanupSelect"), exact: true }).click();
        await page.getByRole("menuitem", { name: t("settings.cleanup.all"), exact: true }).click();
        await page.getByRole("button", { name: new RegExp(`^${t("common.cleanup")}`) }).click();
        const manual = page.getByRole("alertdialog", { name: t("settings.cleanup.confirmTitle") });
        await expect(manual).toBeVisible();
        await expect(manual.getByRole("listitem")).toHaveCount(3);
        await expectDialogFits(page, manual);
        await manual.screenshot({ path: testInfo.outputPath("manual-cleanup.png"), animations: "disabled" });
    });
}
