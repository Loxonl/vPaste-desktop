import { expect, test } from "@playwright/test";

const variants = [
    { theme: "light", lang: "zh-CN", width: 640, height: 520, recommended: "medium", title: "主面板高度", marker: "默认", next: "鼠标粘贴" },
    { theme: "dark", lang: "zh-CN", width: 720, height: 700, recommended: "large", title: "主面板高度", marker: "默认", next: "鼠标粘贴" },
    { theme: "light", lang: "en-US", width: 720, height: 700, recommended: "small", title: "Main panel height", marker: "Default", next: "Mouse paste" },
    { theme: "dark", lang: "en-US", width: 640, height: 520, recommended: "medium", title: "Main panel height", marker: "Default", next: "Mouse paste" },
] as const;

test.describe("compact panel height", () => {
    for (const variant of variants) {
        test(`${variant.theme} ${variant.lang}`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width: variant.width, height: variant.height });
            await page.goto(`/__settings-preview?theme=${variant.theme}&lang=${variant.lang}&panel-recommendation=${variant.recommended}`);
            const slider = page.getByRole("slider", { name: variant.title, exact: true });
            await expect(slider).toBeEnabled();
            await expect(slider).toHaveAttribute("aria-valuenow", String(["small", "medium", "large"].indexOf(variant.recommended)));
            const row = page.getByText(variant.title, { exact: true }).locator("xpath=../..");
            const nextRow = page.getByText(variant.next, { exact: true }).locator("xpath=../..");
            await row.scrollIntoViewIfNeeded();
            const rowBox = (await row.boundingBox())!;
            const nextBox = (await nextRow.boundingBox())!;
            expect(Math.abs(rowBox.height - nextBox.height)).toBeLessThan(1);
            await expect(row.getByRole("button")).toHaveCount(0);
            await expect(row.getByText(/自动跟随|恢复自动|当前屏幕推荐|Follow screen|Restore automatic|Recommended for/)).toHaveCount(0);

            const rail = row.locator(".MuiSlider-rail");
            const marker = row.getByText(variant.marker, { exact: true });
            const thumb = row.locator(".MuiSlider-thumb");
            const railBox = (await rail.boundingBox())!;
            const markerBox = (await marker.boundingBox())!;
            const thumbBox = (await thumb.boundingBox())!;
            expect(railBox.width).toBeLessThanOrEqual(160);
            expect(thumbBox.width).toBeGreaterThan(thumbBox.height);
            expect(thumbBox.width).toBeLessThanOrEqual(32);
            expect(thumbBox.height).toBeLessThanOrEqual(16);
            expect(markerBox.y).toBeGreaterThan(railBox.y + railBox.height);
            expect(markerBox.y).toBeGreaterThan(thumbBox.y + thumbBox.height);
            expect(markerBox.height).toBeLessThan(16);
            expect(markerBox.y + markerBox.height).toBeLessThan(rowBox.y + rowBox.height);
            expect(Math.abs(markerBox.x + markerBox.width / 2 - railBox.x - railBox.width)).toBeLessThan(1);
            expect(markerBox.x + markerBox.width).toBeLessThan(rowBox.x + rowBox.width);
            const ticks = await row.locator(".MuiSlider-mark").all();
            expect(ticks).toHaveLength(3);
            for (const [index, tick] of ticks.entries()) {
                const box = (await tick.boundingBox())!;
                expect(box.height).toBeGreaterThanOrEqual(8);
                expect(box.width).toBeLessThanOrEqual(3);
                expect(Math.abs(box.x + box.width / 2 - railBox.x - index * railBox.width / 2)).toBeLessThan(1);
            }

            for (const [key, value] of [["Home", "0"], ["ArrowRight", "1"], ["End", "2"]]) {
                await slider.focus();
                await page.keyboard.press(key);
                await expect(slider).toHaveAttribute("aria-valuenow", value);
                await expect(slider).toBeEnabled();
                await expect.poll(async () => {
                    const box = (await thumb.boundingBox())!;
                    return Math.abs(box.x + box.width / 2 - railBox.x - Number(value) * railBox.width / 2);
                }).toBeLessThan(1);
            }
            await expect(slider).toHaveAttribute("aria-valuetext", new RegExp(variant.marker));
            await row.screenshot({ path: testInfo.outputPath("panel-height.png") });

            const start = (await thumb.boundingBox())!;
            const target = (await rail.boundingBox())!;
            await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
            await page.mouse.down();
            await page.mouse.move(target.x, target.y + target.height / 2, { steps: 4 });
            await page.mouse.up();
            await expect(slider).toHaveAttribute("aria-valuenow", "0");
        });
    }
});
