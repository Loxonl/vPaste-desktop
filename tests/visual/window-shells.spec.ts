import { expect, test } from "@playwright/test";

const windows = [
    { name: "tray", path: "/tray-menu", width: 220, height: 320, ready: "[class*='tray-menu-shell']" },
    { name: "emoji", path: "/emoji-picker", width: 360, height: 260, ready: "[role='menu']" },
    { name: "paste-notice", path: "/paste-fallback-notice", width: 560, height: 90, ready: "[role='status']" },
    { name: "preview", path: "/clipboard/preview", width: 640, height: 480, ready: "button" },
    { name: "tab-editor", path: "/tab-editor", width: 520, height: 420, ready: "button" },
    { name: "permission", path: "/onboarding-permission?permission=background", width: 720, height: 560, ready: "button" },
    { name: "clipboard", path: "/clipboard", width: 960, height: 600, ready: "button" },
] as const;

test.describe("window shells", () => {
    for (const window of windows) {
        test(window.name, async ({ page }) => {
            await page.setViewportSize({ width: window.width, height: window.height });
            await page.goto(window.path);
            await expect(page.locator(window.ready).first()).toBeVisible();
            await expect(page).toHaveScreenshot(`${window.name}-shell.png`);
        });
    }
});
