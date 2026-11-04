import { expect, test } from "@playwright/test";

for (const platform of ["Win32", "MacIntel"]) {
    test.describe(platform, () => {
        test.beforeEach(async ({ page }) => {
            await page.addInitScript(platform => Object.defineProperty(navigator, "platform", { value: platform }), platform);
        });
        for (const retainPosition of [false, true]) {
            for (const reducedMotion of ["reduce", "no-preference"] as const) {
                for (const delayOldFirstPage of [false, true]) {
                    for (const freshCapture of [false, true]) {
                        test(`reopen retain=${retainPosition}, motion=${reducedMotion}, delay=${delayOldFirstPage}, fresh=${freshCapture}`, async ({ page }) => {
                            const depth = 120;
                            await page.emulateMedia({ reducedMotion });
                            await page.addInitScript(retainPosition => {
                                const rows = Array.from({ length: 180 }, (_, index) => ({
                                    id: 180 - index, hash: `audit-${index}`, itemType: "Text", content: `audit content ${index}`,
                                    previewContent: "", textContent: "", richHtml: "", time: 1000 - index,
                                    label: 0, tags: [], appSource: "", appIconPath: "", titleColor: "",
                                }));
                                let serial = 0;
                                let callbackId = 0;
                                let delayedView = "";
                                let delayedReads = 0;
                                let releaseFirst!: () => void;
                                let held = Promise.resolve();
                                let captured: string | null = null;
                                const views = new Set<string>();
                                const callbacks = new Map<number, (event: unknown) => void>();
                                const listeners = new Map<string, Set<number>>();
                                const calls: Array<{ command: string; args: any }> = [];
                                const emit = (event: string, payload: unknown = null) => {
                                    for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, payload });
                                };
                                const metadata = (viewId: string, index: number) => ({
                                    token: { viewId, revision: 1 }, pageIndex: index, startIndex: index * 36,
                                    items: rows.slice(index * 36, (index + 1) * 36).map(({ content, previewContent, textContent, richHtml, ...ref }) => ref),
                                    knownCount: Math.min(rows.length, (index + 1) * 36), hasMore: (index + 1) * 36 < rows.length,
                                    resourceEpoch: 1,
                                });
                                Object.assign(window, {
                                    __audit299: {
                                        calls, emit,
                                        delayedReads: () => delayedReads,
                                        holdFirstPage: () => {
                                            delayedView = String(serial);
                                            held = new Promise<void>(resolve => { releaseFirst = resolve; });
                                        },
                                        releaseFirstPage: () => releaseFirst?.(),
                                        capture: () => {
                                            captured = "audit-new";
                                            rows.unshift({ ...rows[0], id: 181, hash: captured, content: "new captured text", time: 1001 });
                                        },
                                    },
                                    __TAURI_INTERNALS__: {
                                        invoke: async (command: string, args: any = {}) => {
                                            calls.push({ command, args });
                                            if (command === "get_config") return JSON.stringify({
                                                multilingual: "Chinese", onboarding_completed: true, retain_last_position: retainPosition,
                                                retain_search_history: false, retain_tab_position: false, mouse_paste_mode: "double",
                                            });
                                            if (command === "open_history_view") {
                                                const viewId = String(++serial); views.add(viewId); return metadata(viewId, 0);
                                            }
                                            if (command === "read_history_view_page") {
                                                const response = metadata(args.viewId, args.pageIndex);
                                                if (args.viewId === delayedView && args.pageIndex === 0) {
                                                    delayedReads += 1;
                                                    await held;
                                                }
                                                return response;
                                            }
                                            if (command === "close_history_view") { views.delete(args.viewId); return; }
                                            if (command === "read_history_card_payloads") return {
                                                token: { viewId: args.viewId, revision: 1 }, resourceEpoch: 1,
                                                cards: args.hashes.map((hash: string) => rows.find(row => row.hash === hash)).filter(Boolean).map(item => ({ item })),
                                            };
                                            if (command === "wait_for_clipboard_capture") return captured;
                                            if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                                            if (command === "get_developer_mode" || command === "is_preview_window_visible" || command === "is_quick_input_modifier_pressed") return false;
                                            if (command === "get_paste_queue_state") return { active: false, revision: 0, items: [] };
                                            if (command === "check_paste_accessibility_permission") return { granted: true };
                                            if (command === "history_item_action_info") return { itemType: "Text", missingPaths: [] };
                                            if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                                            if (command === "begin_hide_clipboard_window") { emit("window-hide"); return 1; }
                                            if (command === "finish_hide_clipboard_window") { emit("window-parked"); return; }
                                            if (command === "plugin:event|listen") {
                                                const ids = listeners.get(args.event) ?? new Set<number>();
                                                ids.add(args.handler); listeners.set(args.event, ids); return ++callbackId;
                                            }
                                            return null;
                                        },
                                        transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
                                        unregisterCallback: () => undefined,
                                        convertFileSrc: (value: string) => value,
                                        metadata: { currentWindow: { label: "clipboard" }, currentWebview: { label: "clipboard" } },
                                    },
                                });
                            }, retainPosition);
                            await page.goto("/clipboard");
                            const container = page.locator('[class*="cards-container"]');
                            const card = (hash: string) => page.locator(`[data-hash="${hash}"][class*="clipboard-card"]`);
                            await expect(card("audit-0")).toBeVisible();
                            await expect.poll(async () => {
                                await container.evaluate(element => { element.scrollLeft = element.scrollWidth; });
                                return container.getAttribute("data-history-count");
                            }).toBe("180");
                            await container.evaluate((element, index) => { element.scrollLeft = index * 236; }, depth);
                            await expect(card(`audit-${depth}`)).toBeVisible();
                            await card(`audit-${depth}`).click();
                            await expect(card(`audit-${depth}`)).toHaveClass(/selected/);
                            await page.mouse.move(4, 4);
                            const previousOpens = await page.evaluate(() => (window as any).__audit299.calls.filter((call: any) => call.command === "open_history_view").length);
                            await page.evaluate(({ delayOldFirstPage, freshCapture }) => {
                                const probe = (window as any).__audit299;
                                if (delayOldFirstPage) probe.holdFirstPage();
                                probe.emit("window-hide"); probe.emit("window-parked");
                                if (freshCapture) probe.capture();
                                probe.emit("window-show"); probe.emit("window-show-complete");
                            }, { delayOldFirstPage, freshCapture });
                            await expect.poll(() => page.evaluate(() => (window as any).__audit299.calls.filter((call: any) => call.command === "open_history_view").length)).toBeGreaterThan(previousOpens);
                            const expected = retainPosition ? `audit-${depth}` : freshCapture ? "audit-new" : "audit-0";
                            await expect(card(expected)).toBeVisible();
                            if (delayOldFirstPage && !retainPosition) {
                                expect(await page.evaluate(() => (window as any).__audit299.delayedReads())).toBeGreaterThan(0);
                                await page.evaluate(() => (window as any).__audit299.releaseFirstPage());
                            }
                            await expect(card(expected)).toHaveClass(/selected/);
                            await page.keyboard.press("Enter");
                            await expect.poll(() => page.evaluate(() => (window as any).__audit299.calls.filter((call: any) => call.command === "copy_history_record").map((call: any) => call.args.hash))).toEqual([expected]);

                        });
                    }
                }
            }
        }
    });
}
