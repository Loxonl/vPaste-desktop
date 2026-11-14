import { expect, test, type Page } from "@playwright/test";

async function finishAnimations(page: Page) {
    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await Promise.all(document.getAnimations()
            .filter(animation => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
            .map(animation => animation.finished.catch(() => undefined)));
    });
}

for (const language of ["Chinese", "English"]) {
    for (const theme of ["light", "dark"] as const) {
        for (const reducedMotion of ["no-preference", "reduce"] as const) {
            test(`native-session tutorial ${language} ${theme} ${reducedMotion}`, async ({ page }) => {
                await page.setViewportSize({ width: 1000, height: 360 });
                await page.emulateMedia({ colorScheme: theme, reducedMotion });
                await page.addInitScript(({ language, theme }) => {
                    let nextId = 0;
                    let tabs: unknown[] = [];
                    Object.assign(window, {
                        __nativeGuide: { completed: false, demo: false },
                        __TAURI_INTERNALS__: {
                            invoke: async (command: string, args: Record<string, unknown> = {}) => {
                                if (command === "get_config") return JSON.stringify({
                                    multilingual: language, theme_mode: theme, onboarding_completed: false,
                                });
                                if (command === "get_custom_tabs") return tabs;
                                if (command === "save_custom_tabs") tabs = args.tabs as unknown[];
                                const state = (window as unknown as { __nativeGuide: { completed: boolean; demo: boolean } }).__nativeGuide;
                                if (command === "complete_onboarding") state.completed = true;
                                if (command === "set_onboarding_shortcut_demo_enabled") state.demo = args.enabled === true;
                                if (command === "list_language_packs") return [];
                                return null;
                            },
                            transformCallback: () => ++nextId,
                            unregisterCallback: () => undefined,
                            metadata: { currentWindow: { label: "nativeOnboarding" }, currentWebview: { label: "nativeOnboarding" } },
                        },
                    });
                }, { language, theme });
                await page.goto("/native-onboarding");
                const english = language === "English";
                await expect(page.getByRole("heading", { name: english ? "Add filters" : "添加筛选标签" })).toBeVisible();
                await expect(page.getByRole("checkbox")).toHaveCount(5);
                for (let index = 0; index < 5; index++) {
                    await expect(page.getByRole("checkbox").nth(index)).toBeChecked({ checked: index < 4 });
                }
                await finishAnimations(page);
                await page.screenshot({ path: test.info().outputPath("filters.png") });
                await page.getByRole("button", { name: english ? "Next" : "下一步", exact: true }).click();
                await expect(page.getByRole("heading", { name: english ? "Keep the shortcut close" : "记住默认快捷键" })).toBeVisible();
                await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeGuide: { demo: boolean } }).__nativeGuide.demo)).toBe(true);
                await finishAnimations(page);
                await page.screenshot({ path: test.info().outputPath("shortcut.png") });
                await page.setViewportSize({ width: 640, height: 520 });
                const finish = page.getByRole("button", { name: english ? "Finish" : "完成", exact: true });
                await finish.scrollIntoViewIfNeeded();
                await expect(finish).toBeInViewport();
                await finishAnimations(page);
                await page.screenshot({ path: test.info().outputPath("compact-shortcut.png") });
                await finish.click();
                await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeGuide: { completed: boolean } }).__nativeGuide.completed)).toBe(true);
            });
        }
    }
}
