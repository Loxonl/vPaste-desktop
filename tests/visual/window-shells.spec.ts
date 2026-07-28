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
            await expect(page.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(page.locator("#root")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(page).toHaveScreenshot(`${window.name}-shell.png`);
        });
    }

    test("preview keeps a restrained translucent window surface", async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 480 });
        await page.goto("/clipboard/preview");
        await expect(page.locator("[class*='preview-shell']")).toHaveCSS(
            "background-color",
            "rgba(246, 246, 244, 0.88)",
        );
    });

    test("developer mode opens the UI lab in the external browser", async ({ page }) => {
        await page.addInitScript(() => {
            let callbackId = 0;
            const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
            Object.assign(window, {
                __uiLabTestCalls: calls,
                __TAURI_INTERNALS__: {
                    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
                        calls.push({ cmd, args });
                        if (cmd === "get_developer_mode") return true;
                        if (cmd === "open_url_in_browser") return null;
                        throw new Error(`Unhandled test command: ${cmd}`);
                    },
                    transformCallback: () => ++callbackId,
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: {
                        currentWindow: { label: "clipboard" },
                        currentWebview: { label: "clipboard" },
                    },
                },
            });
        });

        await page.goto("/clipboard");
        const launcher = page.getByRole("button", { name: /component UI lab|组件样板间/i });
        await expect(launcher).toBeVisible();
        await launcher.click();

        const expectedUrl = new URL("/__ui-lab", page.url()).toString();
        await expect.poll(() => page.evaluate(() => {
            const calls = (window as typeof window & {
                __uiLabTestCalls?: Array<{ cmd: string; args: { url?: string } }>;
            }).__uiLabTestCalls;
            return calls?.find(call => call.cmd === "open_url_in_browser")?.args.url;
        })).toBe(expectedUrl);
    });
});
