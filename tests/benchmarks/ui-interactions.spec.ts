import { expect, test, type Page } from "@playwright/test";
import { performance } from "node:perf_hooks";

type BenchmarkResult = {
    medianMs: number;
    p95Ms: number;
    samplesMs: number[];
};

function summarize(samples: number[]): BenchmarkResult {
    const sorted = [...samples].sort((left, right) => left - right);
    const percentile = (ratio: number) => sorted[Math.min(
        sorted.length - 1,
        Math.ceil(sorted.length * ratio) - 1,
    )];
    return {
        medianMs: Number(percentile(0.5).toFixed(2)),
        p95Ms: Number(percentile(0.95).toFixed(2)),
        samplesMs: samples.map(sample => Number(sample.toFixed(2))),
    };
}

async function installTauriMock(page: Page, options: { clipboardItems?: number; queueItems?: number }) {
    await page.addInitScript(({ clipboardItems = 0, queueItems = 0 }) => {
        const callbacks = new Map<number, (payload: unknown) => void>();
        const eventCallbacks = new Map<string, number>();
        const commands: string[] = [];
        let callbackId = 0;
        const now = Date.now();
        const item = (index: number) => ({
            id: index + 1,
            hash: `benchmark-${index + 1}`,
            itemType: index % 7 === 1 ? "Link" : "Text",
            content: index % 7 === 1 ? `https://example.com/${index + 1}` : `Benchmark item ${index + 1}`,
            time: now - index,
            previewContent: "",
            textContent: `Benchmark item ${index + 1}`,
            label: 0,
            appSource: "",
            appIconPath: "",
            richHtml: "",
            tags: [],
        });
        const history = Array.from({ length: clipboardItems }, (_, index) => item(index));
        const queue = Array.from({ length: queueItems }, (_, index) => item(index));
        const queueState = {
            active: queueItems > 0,
            busy: false,
            capacity: 100,
            items: queue,
            error: null,
            undoHash: null,
            undoExpiresAt: null,
            revision: 1,
        };

        Object.assign(window, {
            __benchmarkCommands: commands,
            __hasBenchmarkTauriEvent: (event: string) => eventCallbacks.has(event),
            __emitBenchmarkTauriEvent: (event: string, payload: unknown = null) => {
                const id = eventCallbacks.get(event);
                if (id !== undefined) callbacks.get(id)?.({ event, id, payload });
            },
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    commands.push(command);
                    if (command === "search") {
                        return JSON.stringify({
                            list: history,
                            consumed: history.length,
                            hasMore: false,
                            nextId: 0,
                            nextTime: 0,
                        });
                    }
                    if (command === "get_config") return "{}";
                    if (command === "list_language_packs") return [];
                    if (command === "get_update_state") {
                        return {
                            status: "disabled",
                            currentVersion: "",
                            availableVersion: null,
                            downloadedBytes: 0,
                            totalBytes: null,
                            error: null,
                            portable: false,
                            feedEnabled: false,
                            releaseUrl: "",
                        };
                    }
                    if (command === "get_custom_tabs") return [];
                    if (command === "list_item_tags") return [];
                    if (command === "get_developer_mode") return false;
                    if (command === "get_paste_queue_state") return queueState;
                    if (command === "refresh_link_previews") return [];
                    if (command === "is_alt_key_pressed") return false;
                    if (command === "plugin:event|listen") {
                        const event = String(args.event ?? "");
                        const handler = Number(args.handler);
                        eventCallbacks.set(event, handler);
                        return handler;
                    }
                    if (command === "plugin:event|unlisten") return null;
                    return null;
                },
                transformCallback: (callback: (payload: unknown) => void) => {
                    callbackId += 1;
                    callbacks.set(callbackId, callback);
                    return callbackId;
                },
                unregisterCallback: (id: number) => callbacks.delete(id),
                convertFileSrc: (value: string) => value,
                metadata: {
                    currentWindow: { label: queueItems > 0 ? "pasteQueue" : "clipboard" },
                    currentWebview: { label: queueItems > 0 ? "pasteQueue" : "clipboard" },
                },
            },
            __TAURI_EVENT_PLUGIN_INTERNALS__: {
                unregisterListener: () => undefined,
            },
        });
    }, options);
}

test("36-card keyboard selection baseline", async ({ page }) => {
    await installTauriMock(page, { clipboardItems: 36 });
    await page.goto("/clipboard");
    await expect.poll(() => page.evaluate(() => (
        window as typeof window & {
            __hasBenchmarkTauriEvent: (event: string) => boolean;
        }
    ).__hasBenchmarkTauriEvent("window-show"))).toBe(true);
    await page.evaluate(() => {
        (window as typeof window & {
            __emitBenchmarkTauriEvent: (event: string, payload?: unknown) => void;
        }).__emitBenchmarkTauriEvent("window-show");
    });
    await expect.poll(() => page.evaluate(() => (
        window as typeof window & { __benchmarkCommands: string[] }
    ).__benchmarkCommands)).toContain("search");

    const cards = page.locator("[class*='clipboard-card']");
    await expect(cards).toHaveCount(36);
    await cards.first().click();
    await expect(cards.first()).toHaveClass(/selected/);

    const samples: number[] = [];
    for (let index = 1; index <= 15; index += 1) {
        const startedAt = performance.now();
        await page.keyboard.press("ArrowRight");
        await expect(cards.nth(index)).toHaveClass(/selected/);
        samples.push(performance.now() - startedAt);
    }

    console.log(`UI_BENCHMARK clipboard-36 ${JSON.stringify(summarize(samples))}`);
});

test("100-row Paste Queue drag response baseline", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 448 });
    await installTauriMock(page, { queueItems: 100 });
    await page.goto("/paste-queue");

    const rows = page.getByRole("listitem");
    const handles = page.getByRole("button", { name: /拖动调整顺序|Drag to reorder/ });
    await expect(rows).toHaveCount(100);

    const samples: number[] = [];
    for (let sample = 0; sample < 10; sample += 1) {
        const firstBounds = await rows.nth(0).boundingBox();
        const secondHandleBounds = await handles.nth(1).boundingBox();
        expect(firstBounds).not.toBeNull();
        expect(secondHandleBounds).not.toBeNull();

        await page.mouse.move(
            secondHandleBounds!.x + secondHandleBounds!.width / 2,
            secondHandleBounds!.y + secondHandleBounds!.height / 2,
        );
        const startedAt = performance.now();
        await page.mouse.down();
        await page.mouse.move(
            secondHandleBounds!.x + secondHandleBounds!.width / 2,
            firstBounds!.y + 2,
        );
        await expect.poll(() => rows.nth(1).evaluate(element => element.style.transform))
            .not.toBe("translate3d(0, 0px, 0)");
        samples.push(performance.now() - startedAt);
        await page.mouse.up();
    }

    console.log(`UI_BENCHMARK paste-queue-100 ${JSON.stringify(summarize(samples))}`);
});
