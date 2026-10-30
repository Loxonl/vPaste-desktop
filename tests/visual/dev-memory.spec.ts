import { expect, test } from "@playwright/test";
import { installHistoryMockBridge } from "../helpers/historyMockBridge";

test.beforeEach(async ({ page }) => { await page.addInitScript(installHistoryMockBridge); });

type Preview = { languageCode: string; themePreview: string };
type ProbeWindow = Window & { __memoryWindowProbe: { opened: unknown[]; sent: Preview[]; closed: number; preview: (payload: Preview) => void; theme: (theme: string) => void } };

for (const reducedMotion of [false, true]) {
    test(`DEV memory panel controls and focus (reduced motion: ${reducedMotion})`, async ({ page, context }) => {
        await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
        await context.addInitScript(() => {
            let sequence = 0;
            const callbacks = new Map<number, (event: unknown) => void>();
            let running = true;
            const opened: unknown[] = []; const sent: Preview[] = []; let closed = 0;
            const listeners = new Map<string, number>();
            const sample = {
                timestamp: Date.now(), totalResidentBytes: 201 * 1048576, totalAccountedBytes: 133 * 1048576, partial: false,
                windows: [{ label: "clipboard", visible: true, rendererPids: [42], error: null }, { label: "config", visible: false, rendererPids: [42], error: null }, { label: "devMemory", visible: true, rendererPids: [44], error: null }],
                processes: [
                    { pid: 1, kind: "core", windowLabels: [], retained: false, residentBytes: 80 * 1048576, accountedBytes: 40 * 1048576, error: null },
                    { pid: 42, kind: "renderer", windowLabels: ["clipboard", "config"], retained: false, residentBytes: 100 * 1048576, accountedBytes: 80 * 1048576, error: null },
                    { pid: 43, kind: "renderer", windowLabels: ["textEditor"], retained: true, residentBytes: 1048576, accountedBytes: 1048576, error: null },
                    { pid: 44, kind: "renderer", windowLabels: ["devMemory"], retained: false, residentBytes: 20 * 1048576, accountedBytes: 12 * 1048576, error: null },
                ],
            };
            Object.assign(window, { __memoryWindowProbe: {
                opened, sent, get closed() { return closed; },
                preview: (payload: unknown) => callbacks.get(listeners.get("dev-memory-open")!)?.({ payload }),
                theme: (payload: unknown) => callbacks.get(listeners.get("theme-changed")!)?.({ payload }),
            }, __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    if (command === "get_config") return JSON.stringify({ multilingual: "English", onboarding_completed: true });
                    if (command === "get_developer_mode") return true;
                    if (command === "open_dev_memory_window") opened.push(args);
                    if (command === "plugin:event|emit_to" && args.event === "dev-memory-open") sent.push(args.payload as Preview);
                    if (command === "close_dev_memory_window") closed += 1;
                    if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++sequence; }
                    if (command === "search") return JSON.stringify({ list: [], consumed: 0, hasMore: false, nextId: 0, nextTime: 0 });
                    if (command === "set_dev_memory_monitoring") running = Boolean(args.enabled);
                    if (["get_dev_memory_report", "set_dev_memory_monitoring"].includes(command)) return { running, platform: "macos", accountedMetric: "physicalFootprint", samples: [sample] };
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                    return null;
                },
                transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++sequence, callback); return sequence; },
                unregisterCallback: () => undefined,
                convertFileSrc: (value: string) => value,
                metadata: { currentWindow: { label: "clipboard" }, currentWebview: { label: "clipboard" } },
            } });
        });
        await page.goto("/clipboard");
        const trigger = page.getByRole("button", { name: "Memory monitor", exact: true });
        await trigger.click();
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.opened.length)).toBe(1);
        expect(await page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.opened[0])).toMatchObject({ languageCode: "English", themePreview: "light" });
        await expect(page.getByRole("dialog", { name: "Memory monitor" })).toHaveCount(0);
        const monitor = await context.newPage();
        await monitor.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
        await monitor.goto("/__dev-memory");
        const dialog = monitor.getByRole("dialog", { name: "Memory monitor" });
        await expect(dialog.getByText("clipboard, config", { exact: true })).toBeVisible();
        await expect(dialog.getByRole("table", { name: "Process memory" }).getByText("devMemory", { exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Set baseline" }).click();
        await expect(dialog.getByText("+0.0 MiB")).toBeVisible();
        await dialog.getByRole("button", { name: "Refresh now" }).click();
        await dialog.getByRole("checkbox", { name: "Background sampling" }).uncheck();
        await expect(dialog.getByRole("checkbox", { name: "Background sampling" })).not.toBeChecked();
        const windows = dialog.getByRole("table", { name: "Current windows", exact: true });
        await windows.getByText("clipboard", { exact: true }).scrollIntoViewIfNeeded();
        await expect(windows.getByText("clipboard", { exact: true })).toBeVisible();
        await monitor.screenshot({ path: `/tmp/vpaste-memory-window-${reducedMotion ? "reduced" : "normal"}.png`, animations: "disabled" });
        await page.bringToFront();
        await expect(monitor.getByRole("dialog", { name: "Memory monitor" })).toBeVisible();
        expect(await monitor.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.closed)).toBe(0);
        await page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.theme("dark"));
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await trigger.click();
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.opened.length)).toBe(2);
        expect(await page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.opened[1])).toMatchObject({ themePreview: "dark" });
        await page.getByRole("group", { name: "Developer preview tools" }).getByText("EN", { exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.sent.length)).toBe(1);
        const languagePreview = await page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.sent[0]);
        expect(languagePreview).toMatchObject({ languageCode: "Chinese", themePreview: "dark" });
        await monitor.evaluate(payload => (window as ProbeWindow).__memoryWindowProbe.preview(payload), languagePreview);
        await expect(monitor.locator("html")).toHaveAttribute("data-theme", "dark");
        await page.getByRole("button", { name: "浅色主题预览" }).click();
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.sent.length)).toBe(2);
        const preview = await page.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.sent[1]);
        expect(preview).toMatchObject({ languageCode: "Chinese", themePreview: "light" });
        await monitor.evaluate(payload => (window as ProbeWindow).__memoryWindowProbe.preview(payload), preview);
        await expect(monitor.getByRole("dialog", { name: "内存监测" })).toBeVisible();
        await expect(monitor.locator("html")).toHaveAttribute("data-theme", "light");
        await monitor.keyboard.press("Escape");
        await expect.poll(() => monitor.evaluate(() => (window as ProbeWindow).__memoryWindowProbe.closed)).toBe(1);
        await monitor.close();
    });
}
