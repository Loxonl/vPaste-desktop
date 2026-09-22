import { expect, test } from "@playwright/test";

type ProbeWindow = Window & { __syncProbe: {
    calls: Array<{ command: string; args: Record<string, unknown> }>;
    emit: (event: string) => void;
    release: (fail: boolean) => void;
} };

for (const outcome of ["ready", "failed", "hide", "blur", "navigate", "retained", "filtered", "refresh-failed", "refocus", "late-show", "deleted", "missing-required"] as const) {
    test(`rapid Enter waits for fresh capture: ${outcome}`, async ({ page }) => {
        await page.addInitScript(scenario => {
            let nextId = 0;
            let fresh = false;
            const callbacks = new Map<number, (event: unknown) => void>();
            const listeners = new Map<string, number>();
            const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
            let resolveCapture!: (hash: string | null) => void;
            let rejectCapture!: (error: Error) => void;
            const capture = new Promise<string | null>((resolve, reject) => {
                resolveCapture = resolve;
                rejectCapture = reject;
            });
            Object.assign(window, {
                __syncProbe: {
                    calls,
                    emit: (event: string) => callbacks.get(listeners.get(event)!)?.({ event, payload: null }),
                    release: (fail: boolean) => {
                        fresh = !fail;
                        if (fail) rejectCapture(new Error("Capture timed out"));
                        else resolveCapture(scenario === "deleted" ? null : "new");
                    },
                },
                __TAURI_INTERNALS__: {
                    invoke: async (command: string, args: Record<string, unknown> = {}) => {
                        calls.push({ command, args });
                        if (command === "wait_for_clipboard_capture") return capture;
                        if (command === "search" && fresh && scenario === "refresh-failed") throw new Error("Search failed");
                        if (command === "search") return JSON.stringify({
                            list: (fresh && !args.keywords && scenario !== "deleted" && scenario !== "missing-required" ? ["new", "old"] : ["old"]).map((hash, index) => ({
                                id: 2 - index, hash, itemType: "Text", content: `${hash} content`,
                                previewContent: "", textContent: "", time: 2 - index,
                                label: 0, appSource: "", appIconPath: "", tags: [],
                            })), consumed: 1, hasMore: false, nextId: 0, nextTime: 0,
                        });
                        if (command === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true, retain_last_position: scenario === "retained", retain_search_history: scenario === "filtered" });
                        if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                        if (command === "get_developer_mode") return false;
                        if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                        if (command === "check_paste_accessibility_permission") return { granted: true };
                        if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                        if (command === "plugin:event|listen") {
                            listeners.set(args.event as string, args.handler as number);
                            return ++nextId;
                        }
                        return null;
                    },
                    transformCallback: (callback: (event: unknown) => void) => {
                        callbacks.set(++nextId, callback);
                        return nextId;
                    },
                    unregisterCallback: () => undefined,
                    convertFileSrc: (value: string) => value,
                    metadata: { currentWindow: { label: "clipboard" }, currentWebview: { label: "clipboard" } },
                },
            });
        }, outcome);
        await page.goto("/clipboard");
        await expect(page.getByText("old content", { exact: true }).first()).toBeVisible();
        if (outcome === "filtered") {
            await page.getByRole("button", { name: "搜索", exact: true }).click();
            await page.getByRole("textbox", { name: "搜索" }).fill("old");
            await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__syncProbe.calls.some(call => call.command === "search" && call.args.keywords === "old"))).toBe(true);
        }
        if (outcome !== "late-show") await page.evaluate(() => (window as ProbeWindow).__syncProbe.emit("window-show"));
        if (outcome === "refocus") await page.evaluate(() => {
            window.dispatchEvent(new Event("blur"));
            window.dispatchEvent(new Event("focus"));
        });
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        const pastes = () => page.evaluate(() => (window as ProbeWindow).__syncProbe.calls.filter(call => call.command === "paste"));
        expect(await pastes()).toEqual([]);
        if (outcome === "late-show") await page.evaluate(() => (window as ProbeWindow).__syncProbe.emit("window-show"));
        if (outcome === "hide") await page.evaluate(() => (window as ProbeWindow).__syncProbe.emit("window-hide"));
        if (outcome === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        if (outcome === "navigate") await page.keyboard.press("ArrowRight");
        await page.evaluate(fail => (window as ProbeWindow).__syncProbe.release(fail), outcome === "failed");
        if (["ready", "retained", "filtered", "refocus", "late-show", "deleted"].includes(outcome)) {
            await expect.poll(pastes).toHaveLength(1);
            expect((await pastes())[0].args.hash).toBe(outcome === "retained" || outcome === "filtered" || outcome === "deleted" ? "old" : "new");
        } else {
            await page.waitForTimeout(150);
            expect(await pastes()).toEqual([]);
        }
    });
}
