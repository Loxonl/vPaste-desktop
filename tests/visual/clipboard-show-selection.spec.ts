import { expect, test, type Page } from "@playwright/test";

type ProbeWindow = Window & { __showProbe: {
    calls: Array<{ command: string; args: Record<string, unknown> }>;
    captureCalls: () => number;
    configCalls: () => number;
    emit: (event: string, payload?: unknown) => void;
    failConfig: () => void;
    holdConfig: () => void;
    releaseConfig: () => void;
    releaseCapture: () => void;
} };

const card = (page: Page, hash: string) => page.locator(`[data-hash="${hash}"][class*="clipboard-card"]`);

async function openClipboard(page: Page, retainLastPosition = false, retainSearchHistory = false, retainTabPosition = false, holdInitialConfig = false, itemCount = 3) {
    await page.addInitScript(({ retainLastPosition, retainSearchHistory, retainTabPosition, holdInitialConfig, itemCount }) => {
        let nextId = 0;
        let captureCalls = 0;
        let configCalls = 0;
        let releaseConfig = () => undefined;
        let failConfig = () => undefined;
        let releaseCapture!: () => void;
        let configReady = Promise.resolve();
        if (holdInitialConfig) {
            configReady = new Promise<void>((resolve, reject) => {
                releaseConfig = resolve;
                failConfig = () => reject(new Error("Temporary config failure"));
            });
        }
        const captureReady = new Promise<void>(resolve => { releaseCapture = resolve; });
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        Object.assign(window, {
            __showProbe: {
                calls,
                captureCalls: () => captureCalls,
                configCalls: () => configCalls,
                emit: (event: string, payload: unknown = null) =>
                    callbacks.get(listeners.get(event)!)?.({ event, payload }),
                failConfig: () => failConfig(),
                holdConfig: () => {
                    configReady = new Promise<void>(resolve => { releaseConfig = resolve; });
                },
                releaseConfig: () => releaseConfig(),
                releaseCapture,
            },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    calls.push({ command, args });
                    if (command === "get_config") {
                        configCalls += 1;
                        await configReady;
                        return JSON.stringify({
                            multilingual: "Chinese", onboarding_completed: true,
                            retain_last_position: retainLastPosition,
                            retain_search_history: retainSearchHistory,
                            retain_tab_position: retainTabPosition,
                        });
                    }
                    if (command === "wait_for_clipboard_capture") {
                        captureCalls += 1;
                        await captureReady;
                        return null;
                    }
                    if (command === "search") return JSON.stringify({
                        list: Array.from({ length: itemCount }, (_, index) => {
                            const hash = ["first", "second", "third"][index] ?? `extra-${index}`;
                            return {
                                id: itemCount - index, hash, itemType: "Text", content: `${hash} content`,
                                previewContent: "", textContent: "", time: itemCount - index,
                                label: 0, appSource: "", appIconPath: "", tags: [],
                            };
                        }),
                        consumed: itemCount, hasMore: false, nextId: 0, nextTime: 0,
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
    }, { retainLastPosition, retainSearchHistory, retainTabPosition, holdInitialConfig, itemCount });
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

for (const holdInitialConfig of [false, true]) {
    for (const retainTabPosition of [false, true]) {
        test(`tab retention survives interrupted opening (retain: ${retainTabPosition}, cold: ${holdInitialConfig})`, async ({ page }) => {
            await openClipboard(page, false, false, retainTabPosition, holdInitialConfig);
            const favorite = page.getByRole("button", { name: "收藏", exact: true });
            const all = page.getByRole("button", { name: "全部", exact: true });
            await favorite.click();
            await expect(favorite).toHaveClass(/active/);

            await page.evaluate(cold => {
                const probe = (window as ProbeWindow).__showProbe;
                probe.emit("window-hide");
                probe.emit("window-hidden");
                if (!cold) probe.holdConfig();
                probe.emit("window-show");
                window.dispatchEvent(new Event("blur"));
                window.dispatchEvent(new Event("focus"));
                probe.releaseConfig();
                probe.releaseCapture();
            }, holdInitialConfig);

            await expect(retainTabPosition ? favorite : all).toHaveClass(/active/);
            await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
        });
    }
}

for (const retainSearchHistory of [false, true]) {
    test(`search retention survives interrupted opening (retain: ${retainSearchHistory})`, async ({ page }) => {
        await openClipboard(page, false, retainSearchHistory);
        await page.getByRole("button", { name: "搜索", exact: true }).click();
        const search = page.getByRole("textbox", { name: "搜索", exact: true });
        await search.fill("second");
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.calls
            .some(call => call.command === "search" && call.args.keywords === "second"))).toBe(true);

        await page.evaluate(() => {
            const probe = (window as ProbeWindow).__showProbe;
            probe.emit("window-hide");
            probe.emit("window-hidden");
            probe.holdConfig();
            probe.emit("window-show");
            window.dispatchEvent(new Event("blur"));
            window.dispatchEvent(new Event("focus"));
            probe.releaseConfig();
            probe.releaseCapture();
        });

        if (retainSearchHistory) await expect(search).toHaveValue("second");
        else await expect(search).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
    });
}

test("immediate search input keeps the opening's tab reset", async ({ page }) => {
    await openClipboard(page);
    const favorite = page.getByRole("button", { name: "收藏", exact: true });
    await favorite.click();

    await page.evaluate(() => {
        const probe = (window as ProbeWindow).__showProbe;
        probe.emit("window-hide");
        probe.emit("window-hidden");
        probe.holdConfig();
        probe.emit("window-show");
    });
    await page.keyboard.press("Control+f");
    const search = page.getByRole("textbox", { name: "搜索", exact: true });
    await search.fill("second");
    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.releaseConfig();
        (window as ProbeWindow).__showProbe.releaseCapture();
    });

    await expect(page.getByRole("button", { name: "全部", exact: true })).toHaveClass(/active/);
    await expect(search).toHaveValue("second");
});

test("keyboard resynchronization preserves this opening's search and tab", async ({ page }) => {
    await openClipboard(page);
    await page.evaluate(() => {
        (window as ProbeWindow).__showProbe.releaseCapture();
        (window as ProbeWindow).__showProbe.emit("window-show");
    });
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
    const favorite = page.getByRole("button", { name: "收藏", exact: true });
    await favorite.click();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const search = page.getByRole("textbox", { name: "搜索", exact: true });
    await search.fill("second");
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.calls
        .filter(call => call.command === "search").at(-1)?.args.keywords)).toBe("second");
    const previousSearch = await page.evaluate(() => (window as ProbeWindow).__showProbe.calls
        .filter(call => call.command === "search").at(-1)?.args);

    await page.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
    });
    await page.keyboard.press("Enter");

    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.calls
        .filter(call => call.command === "search").at(-1)?.args)).toEqual(previousSearch);
    await expect(favorite).toHaveClass(/active/);
    await expect(search).toHaveValue("second");
});

test("retained horizontal position survives transient focus loss", async ({ page }) => {
    await openClipboard(page, true, false, false, false, 12);
    await page.evaluate(() => {
        const container = document.querySelector<HTMLElement>('[class*="cards-container"]')!;
        container.scrollLeft = 400;
    });
    await expect.poll(() => page.locator('[class*="cards-container"]').evaluate(element => element.scrollLeft)).toBe(400);
    await page.evaluate(() => {
        const probe = (window as ProbeWindow).__showProbe;
        probe.emit("window-hide");
        probe.emit("window-hidden");
        probe.holdConfig();
        probe.emit("window-show");
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
        probe.releaseConfig();
        probe.releaseCapture();
    });

    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
    await expect.poll(() => page.locator('[class*="cards-container"]').evaluate(element => element.scrollLeft)).toBe(400);
});

for (const retain of [false, true]) {
    test(`saved retention settings update the opening's cached preferences (retain: ${retain})`, async ({ page }) => {
        await openClipboard(page, !retain, !retain, !retain);
        const favorite = page.getByRole("button", { name: "收藏", exact: true });
        await favorite.click();
        await page.getByRole("button", { name: "搜索", exact: true }).click();
        const search = page.getByRole("textbox", { name: "搜索", exact: true });
        await search.fill("second");
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.calls
            .some(call => call.command === "search" && call.args.keywords === "second"))).toBe(true);
        await expect(page.getByTestId("clipboard-results")).not.toHaveAttribute("aria-hidden", "true");
        await card(page, "first").focus();
        await expect(card(page, "first")).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await expect(card(page, "third")).toHaveClass(/selected/);

        await page.evaluate(retain => {
            const probe = (window as ProbeWindow).__showProbe;
            probe.emit("clipboard-behavior-config-changed", {
                retain_last_position: retain,
                retain_search_history: retain,
                retain_tab_position: retain,
            });
            probe.emit("window-hide");
            probe.emit("window-hidden");
            probe.holdConfig();
            probe.emit("window-show");
            probe.releaseCapture();
        }, retain);

        await expect(retain ? favorite : page.getByRole("button", { name: "全部", exact: true })).toHaveClass(/active/);
        if (retain) await expect(search).toHaveValue("second");
        else await expect(search).toHaveCount(0);
        await expect(card(page, retain ? "third" : "first")).toHaveClass(/selected/);
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
    });
}

test("saved retention settings are not overwritten by a delayed initial config load", async ({ page }) => {
    await openClipboard(page, false, false, false, true);
    const favorite = page.getByRole("button", { name: "收藏", exact: true });
    await favorite.click();
    await page.evaluate(() => {
        const probe = (window as ProbeWindow).__showProbe;
        probe.emit("window-hide");
        probe.emit("window-hidden");
        probe.emit("window-show");
        probe.emit("clipboard-behavior-config-changed", { retain_tab_position: true });
        probe.releaseConfig();
        probe.releaseCapture();
    });

    await expect(favorite).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
});

test("a temporary initial config failure is retried on the next opening", async ({ page }) => {
    await openClipboard(page, false, false, true, true);
    await page.evaluate(() => (window as ProbeWindow).__showProbe.failConfig());
    const favorite = page.getByRole("button", { name: "收藏", exact: true });
    await favorite.click();
    await expect(favorite).toHaveClass(/active/);
    await page.evaluate(() => {
        const probe = (window as ProbeWindow).__showProbe;
        probe.emit("window-hide");
        probe.emit("window-hidden");
        probe.holdConfig();
        probe.emit("window-show");
        probe.releaseConfig();
        probe.releaseCapture();
    });

    await expect(favorite).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__showProbe.captureCalls())).toBe(1);
});
