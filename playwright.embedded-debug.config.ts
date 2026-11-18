import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Local only. Build with `npm run build -- --mode native-debug` first.
export default defineConfig({
    ...base,
    testMatch: "embedded-debug-tools.spec.ts",
    outputDir: "./test-results/embedded-debug",
    use: { ...base.use, baseURL: "http://127.0.0.1:1430" },
    webServer: {
        command: "npm run preview -- --host 127.0.0.1 --port 1430 --strictPort",
        url: "http://127.0.0.1:1430",
        reuseExistingServer: false,
    },
});
