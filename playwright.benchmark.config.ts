import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/benchmarks",
    outputDir: "./test-results/benchmarks",
    fullyParallel: false,
    retries: 0,
    workers: 1,
    reporter: "line",
    use: {
        baseURL: "http://127.0.0.1:1420",
        browserName: "chromium",
        colorScheme: "light",
        locale: "zh-CN",
        viewport: { width: 960, height: 600 },
    },
    webServer: {
        command: "npm run dev -- --host 127.0.0.1",
        url: "http://127.0.0.1:1420/__ui-lab",
        reuseExistingServer: true,
        timeout: 120_000,
    },
});
