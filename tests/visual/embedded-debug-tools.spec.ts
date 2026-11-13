import { expect, test } from "@playwright/test";
import { installHistoryMockBridge } from "../helpers/historyMockBridge";

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installHistoryMockBridge);
    await page.addInitScript(() => {
        const calls: string[] = [];
        let sequence = 0;
        Object.assign(window, { __embeddedToolCalls: calls, __TAURI_INTERNALS__: {
            invoke: async (command: string) => {
                calls.push(command);
                if (command === "get_config") return JSON.stringify({ multilingual: "English", onboarding_completed: true });
                if (command === "list_language_packs") return [];
                if (command === "load_tab_order") return { order: [], revision: -1 };
                if (command === "get_dev_memory_report") return { running: true, platform: "windows", accountedMetric: "privateBytes", samples: [] };
                if (command === "plugin:event|listen") return ++sequence;
                return null;
            },
            transformCallback: () => ++sequence,
            unregisterCallback: () => undefined,
            convertFileSrc: (value: string) => value,
            metadata: { currentWindow: { label: "devMemory" }, currentWebview: { label: "devMemory" } },
        } });
    });
});

test("direct memory route renders embedded controls and routes close to Rust", async ({ page }) => {
    await page.goto("/__dev-memory");
    await expect(page.getByRole("heading", { name: "Memory monitor" })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const calls = await page.evaluate(() => (window as unknown as { __embeddedToolCalls: string[] }).__embeddedToolCalls);
    expect(calls).toContain("get_dev_memory_report");
    expect(calls).toContain("close_dev_memory_window");
    expect(calls).not.toContain("open_history_view");
    expect(calls).not.toContain("search");
});

test("direct test-room route renders its controls without loading history", async ({ page }) => {
    await page.goto("/__test-room");
    await expect(page.getByTestId("test-room")).toBeVisible();
    await page.getByRole("tab", { name: "写入样板", exact: true }).click();
    await expect(page.getByRole("tab", { name: "写入样板", exact: true })).toHaveAttribute("aria-selected", "true");
    const calls = await page.evaluate(() => (window as unknown as { __embeddedToolCalls: string[] }).__embeddedToolCalls);
    expect(calls).toContain("get_test_room_config");
    expect(calls).not.toContain("open_history_view");
    expect(calls).not.toContain("search");
});
