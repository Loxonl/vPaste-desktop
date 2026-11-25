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
                    const callbacks = new Map<number, (event: unknown) => void>();
                    const listeners = new Map<string, number>();
                    Object.assign(window, {
                        __nativeGuide: { completed: false, demo: false, ready: false,
                            show: () => callbacks.get(listeners.get("native-onboarding-shown")!)?.({ payload: null }) },
                        __TAURI_INTERNALS__: {
                            invoke: async (command: string, args: Record<string, unknown> = {}) => {
                                if (command === "get_config") return JSON.stringify({
                                    multilingual: language, theme_mode: theme, onboarding_completed: false,
                                });
                                if (command === "get_custom_tabs") return tabs;
                                if (command === "save_custom_tabs") tabs = args.tabs as unknown[];
                                const state = (window as unknown as { __nativeGuide: { completed: boolean; demo: boolean; ready: boolean } }).__nativeGuide;
                                if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++nextId; }
                                if (command === "auxiliary_window_ready") state.ready = true;
                                if (command === "complete_onboarding") state.completed = true;
                                if (command === "set_onboarding_shortcut_demo_enabled") state.demo = args.enabled === true;
                                if (command === "list_language_packs") return [];
                                return null;
                            },
                            transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++nextId, callback); return nextId; },
                            unregisterCallback: () => undefined,
                            metadata: { currentWindow: { label: "nativeOnboarding" }, currentWebview: { label: "nativeOnboarding" } },
                        },
                    });
                }, { language, theme });
                await page.goto("/native-onboarding");
                const english = language === "English";
                await page.waitForFunction(() => (window as unknown as { __nativeGuide: { ready: boolean } }).__nativeGuide.ready);
                await page.waitForTimeout(1800); // Longer than the old hidden welcome sequence.
                await expect(page.locator('[class*="tutorial-welcome"]')).toHaveCount(0);
                const firstWelcomePaint = page.evaluate(() => new Promise<number>(resolve => {
                    const sample = () => {
                        const welcome = document.querySelector('section[class*="tutorial-welcome"]');
                        if (welcome) resolve(Number(getComputedStyle(welcome).opacity));
                        else requestAnimationFrame(sample);
                    };
                    requestAnimationFrame(sample);
                }));
                await page.evaluate(() => (window as unknown as { __nativeGuide: { show: () => void } }).__nativeGuide.show());
                expect(await firstWelcomePaint).toBe(reducedMotion === "reduce" ? 1 : 0);
                await expect(page.locator('[class*="tutorial-welcome"]').first()).toBeVisible();
                if (reducedMotion === "no-preference") {
                    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
                        (animation.effect as KeyframeEffect | null)?.target instanceof Element &&
                        ((animation.effect as KeyframeEffect).target as Element).closest('[class*="tutorial-welcome"]')).length)).toBeGreaterThan(0);
                    await expect.poll(() => page.locator('section[class*="tutorial-welcome"] img')
                        .evaluateAll(elements => elements.reduce((count, element) => count + element.getAnimations().length, 0)))
                        .toBeGreaterThan(0);
                }
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
                await expect(finish).toBeHidden();
                await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeGuide: { completed: boolean } }).__nativeGuide.completed)).toBe(true);
            });
        }
    }
}
