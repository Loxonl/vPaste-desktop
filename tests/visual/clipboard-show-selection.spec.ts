import { expect, test, type Page } from "@playwright/test";

type ProbeWindow = Window & { __showProbe: {
    captureCalls: () => number;
    configCalls: () => number;
    emit: (event: string, payload?: { x: number; y: number } | null) => void;
    holdConfig: () => void;
    releaseConfig: () => void;
    releaseCapture: () => void;
} };

const card = (page: Page, hash: string) => page.locator(`[data-hash="${hash}"][class*="clipboard-card"]`);

async function openClipboard(page: Page, retainLastPosition = false, retainSearchHistory = false) {
    await page.addInitScript(({ retainLastPosition, retainSearchHistory }) => {
        let nextId = 0;
        let captureCalls = 0;
        let configCalls = 0;
        let releaseConfig = () => undefined;
        let releaseCapture!: () => void;
        let configReady = Promise.resolve();
        const captureReady = new Promise<void>(resolve => { releaseCapture = resolve; });
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        Object.assign(window, {
            __showProbe: {
                captureCalls: () => captureCalls,
                configCalls: () => configCalls,
                emit: (event: string, payload: { x: number; y: number } | null = null) =>
                    callbacks.get(listeners.get(event)!)?.({ event, payload }),
                holdConfig: () => {
                    configReady = new Promise<void>(resolve => { releaseConfig = resolve; });
                },
                releaseConfig: () => releaseConfig(),
                releaseCapture,
            },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    if (command === "get_config") {
                        configCalls += 1;
                        await configReady;
                        return JSON.stringify({
                            multilingual: "Chinese", onboarding_completed: true,
                            retain_last_position: retainLastPosition,
                            retain_search_history: retainSearchHistory,
                        });
                    }
                    if (command === "wait_for_clipboard_capture") {
                        captureCalls += 1;
                        await captureReady;
                        return null;
                    }
                    if (command === "search") return JSON.stringify({
                        list: ["first", "second", "third"].map((hash, index) => ({
                            id: 3 - index, hash, itemType: "Text", content: `${hash} content`,
                            previewContent: "", textContent: "", time: 3 - index,
                            label: 0, appSource: "", appIconPath: "", tags: [],
                        })),
                        consumed: 3, hasMore: false, nextId: 0, nextTime: 0,
                    });
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
    }, { retainLastPosition, retainSearchHistory });
    await page.goto("/clipboard");
    await expect(card(page, "first")).toBeVisible();
}

test("quick navigation after show starts from the first card", async ({ page }) => {
    await openClipboard(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(card(page, "third")).toHaveClass(/selected/);

    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.holdConfig();
        (window as ProbeWindow).__showProbe.emit("window-show");
    });
    await page.keyboard.press("ArrowRight");
    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.releaseConfig();
        (window as ProbeWindow).__showProbe.releaseCapture();
    });

    await expect(card(page, "second")).toHaveClass(/selected/);
    await expect(card(page, "third")).not.toHaveClass(/selected/);
});

test("keyboard focus follows the selected card", async ({ page }) => {
    await openClipboard(page);
    await page.keyboard.press("ArrowLeft");
    await card(page, "first").focus();
    await page.keyboard.press("ArrowRight");

    await expect(card(page, "second")).toHaveClass(/selected/);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.hash)).toBe("second");
});

test("reopening moves a previously focused card back to the first selection", async ({ page }) => {
    await openClipboard(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await card(page, "third").focus();

    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.emit("window-show");
        (window as ProbeWindow).__showProbe.releaseConfig();
        (window as ProbeWindow).__showProbe.releaseCapture();
    });

    await expect(card(page, "first")).toHaveClass(/selected/);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.hash)).toBe("first");
});

for (const retainLastPosition of [false, true]) {
    test(`reopening immediately applies known position preference (retain: ${retainLastPosition})`, async ({ page }) => {
        await openClipboard(page, retainLastPosition);
        await page.evaluate(() => {
            (window as ProbeWindow).__showProbe.releaseCapture();
            (window as ProbeWindow).__showProbe.emit("window-show");
        });
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await expect(card(page, "third")).toHaveClass(/selected/);

        await page.evaluate(() => {
            const probe = (window as ProbeWindow).__showProbe;
            probe.emit("window-hide");
            probe.emit("window-hidden");
            probe.holdConfig();
            probe.emit("window-show");
        });

        await expect(card(page, retainLastPosition ? "third" : "first")).toHaveClass(/selected/);
        await page.evaluate(() => (window as ProbeWindow).__showProbe.releaseConfig());
    });
}

test("first reopening resets selection before the show-time config request returns", async ({ page }) => {
    await openClipboard(page);
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.configCalls())).toBeGreaterThan(0);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(card(page, "third")).toHaveClass(/selected/);

    await page.evaluate(() => {
        const probe = (window as ProbeWindow).__showProbe;
        probe.emit("window-hide");
        probe.emit("window-hidden");
        probe.holdConfig();
        probe.emit("window-show");
    });

    await expect(card(page, "first")).toHaveClass(/selected/);
    await page.evaluate(() => (window as ProbeWindow).__showProbe.releaseConfig());
});

test("retained position still navigates from the previous selection", async ({ page }) => {
    await openClipboard(page, true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(card(page, "third")).toHaveClass(/selected/);

    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.holdConfig();
        (window as ProbeWindow).__showProbe.emit("window-show");
    });
    await page.keyboard.press("ArrowLeft");
    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.releaseConfig();
        (window as ProbeWindow).__showProbe.releaseCapture();
    });

    await expect(card(page, "second")).toHaveClass(/selected/);
});

test("show selection does not steal focus from retained search", async ({ page }) => {
    await openClipboard(page, false, true);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const search = page.getByRole("textbox", { name: "搜索" });
    await expect(search).toBeFocused();

    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.emit("window-show");
        (window as ProbeWindow).__showProbe.releaseConfig();
        (window as ProbeWindow).__showProbe.releaseCapture();
    });

    await expect(card(page, "first")).toHaveClass(/selected/);
    await expect(search).toBeFocused();
});
