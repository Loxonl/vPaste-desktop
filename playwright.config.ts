import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/visual",
    outputDir: "./test-results",
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI
        ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
        : "list",
    expect: {
        toHaveScreenshot: {
            animations: "disabled",
            caret: "hide",
            maxDiffPixelRatio: 0.01,
        },
    },
    use: {
        baseURL: "http://127.0.0.1:1420",
        colorScheme: "light",
        locale: "zh-CN",
        screenshot: "only-on-failure",
        trace: "on-first-retry",
        viewport: { width: 960, height: 720 },
    },
    projects: [
        {
            name: "chromium",
            use: {
                browserName: "chromium",
            },
        },
    ],
    webServer: {
        command: "npm run dev -- --host 127.0.0.1",
        url: "http://127.0.0.1:1420/__ui-lab",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
