import { expect, test, type Page } from "@playwright/test";

async function expectControlLabelsToFit(page: Page) {
    const clipped = await page.locator("button, [role='menuitem'], [role='combobox']").evaluateAll(elements =>
        elements.flatMap(element => {
            if (!element.textContent?.trim() || !element.getClientRects().length) return [];
            const control = element.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const text = range.getBoundingClientRect();
            return text.left < control.left - 1 || text.right > control.right + 1
                ? [element.textContent.trim()]
                : [];
        }),
    );
    expect(clipped, "English control labels must not be horizontally clipped").toEqual([]);
}

test.describe("localized layout", () => {
    for (const lang of ["en-US", "zh-CN"]) {
        for (const platform of ["windows", "macos"]) {
            for (const theme of ["light", "dark"]) {
                test(`settings branding ${lang} ${platform} ${theme}`, async ({ page }) => {
                    await page.addInitScript(platform => {
                        const value = platform === "macos" ? "MacIntel" : "Win32";
                        Object.defineProperty(navigator, "platform", { configurable: true, get: () => value });
                        Object.defineProperty(navigator, "userAgentData", { configurable: true, get: () => undefined });
                    }, platform);
                    for (const width of [640, 720]) {
                        await page.setViewportSize({ width, height: 700 });
                        await page.goto(`/__settings-preview?lang=${lang}&platform=${platform}&theme=${theme}`);
                        const brand = page.locator("[class*='sidebarBrand']");
                        await expect(brand).toHaveText(lang === "en-US" ? "Settings" : "设置");
                        if (platform === "macos") {
                            await expect(brand.locator("..")).toHaveClass(/sidebarMac/);
                        }
                        await page.evaluate(() => document.fonts.ready);

                        const geometry = await brand.evaluate(element => {
                            const sidebar = element.parentElement!.getBoundingClientRect();
                            const logo = element.querySelector("img")!.getBoundingClientRect();
                            const label = element.querySelector("span")!;
                            const text = document.createRange();
                            text.selectNodeContents(label);
                            const bounds = text.getBoundingClientRect();
                            return {
                                sidebarWidth: sidebar.width,
                                leftSpace: logo.left - sidebar.left,
                                rightSpace: sidebar.right - bounds.right,
                                gap: bounds.left - logo.right,
                                lines: text.getClientRects().length,
                                textFits: label.scrollWidth <= label.clientWidth,
                            };
                        });

                        expect(geometry.rightSpace, `${lang} title needs breathing room`).toBeGreaterThanOrEqual(15.5);
                        expect(geometry.leftSpace).toBeGreaterThanOrEqual(15.5);
                        expect(geometry.sidebarWidth).toBe(148);
                        expect(geometry.gap).toBeGreaterThanOrEqual(7.5);
                        expect(geometry.lines).toBe(1);
                        expect(geometry.textFits).toBe(true);
                    }
                });
            }
        }
    }

    test("English settings controls fit at the minimum window size", async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 520 });
        await page.goto("/__settings-preview?lang=en-US&platform=windows&theme=light");
        for (let section = 0; section < 4; section++) {
            await page.getByRole("tab").nth(section).click();
            await expect(page.getByRole("tabpanel")).toHaveAttribute("id", `vertical-tabpanel-${section}`);
            await expectControlLabelsToFit(page);
        }
        await page.getByRole("tab").nth(1).click();
        await page.getByRole("button", { name: "Manage protected apps" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expectControlLabelsToFit(page);
    });

    test("English auxiliary window controls and queue actions fit", async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
            Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });
        });
        const surfaces = [
            { path: "/tray-menu", width: 216, height: 184, ready: "nav" },
            { path: "/tab-editor", width: 302, height: 416, ready: "button" },
            { path: "/paste-fallback-notice", width: 560, height: 76, ready: "[role='status']" },
            { path: "/onboarding-permission?permission=background", width: 720, height: 560, ready: "button" },
            { path: "/paste-queue", width: 360, height: 448, ready: "button" },
        ];
        for (const surface of surfaces) {
            await page.setViewportSize({ width: surface.width, height: surface.height });
            await page.goto(surface.path);
            await expect(page.locator(surface.ready).first()).toBeVisible();
            await expectControlLabelsToFit(page);
        }
        await page.getByRole("button", { name: "More queue actions" }).click();
        await expect(page.getByRole("menuitem", { name: "Clear queue" })).toBeVisible();
        await expectControlLabelsToFit(page);
        await page.getByRole("menuitem", { name: "Clear queue" }).click();
        await expect(page.getByRole("alertdialog")).toBeVisible();
        await expectControlLabelsToFit(page);
    });
});
