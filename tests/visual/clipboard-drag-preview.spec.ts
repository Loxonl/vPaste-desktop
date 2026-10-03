import { expect, test, type Locator, type Page } from "@playwright/test";

type DragKind = "Text" | "TextFile" | "Link" | "Color" | "Image" | "File";
type FileCase = "image" | "document" | "folder" | "multiple";
const text = "  git clone\nhttps://example.test/repository.git  \n";
const richHtml = "<p><strong>Rich clipboard content</strong></p>";
const imageSrc = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="#1b83ff"/><circle cx="100" cy="80" r="48" fill="#ffc857"/></svg>')}`;
const filePaths: Record<FileCase, string[]> = {
    image: ["/image.png"], document: ["/report.pdf"], folder: ["/project"],
    multiple: ["/report.pdf", "/notes.txt", "/image.png"],
};

async function openDragCard(page: Page, kind: DragKind, options: {
    native?: boolean; captureFails?: boolean; fileCase?: FileCase; rich?: boolean;
} = {}) {
    const { native = false, captureFails = false, fileCase = "document", rich = false } = options;
    await page.addInitScript(({ kind, text, richHtml, imageSrc, native, captureFails, fileCase, paths, rich }) => {
        let callbackId = 0;
        Object.defineProperty(navigator, "platform", { value: native ? "MacIntel" : "Linux" });
        Object.defineProperty(navigator, "userAgent", { value: native ? "Macintosh native drag fixture" : "Linux browser drag fixture" });
        const content = kind === "Text" ? text : kind === "TextFile" ? "/full-text-data"
            : kind === "Link" ? "https://example.test||||||Example repository"
            : kind === "Color" ? "#1b83ff" : kind === "File" ? JSON.stringify(paths) : "/image.png";
        Object.assign(window, {
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: unknown) => {
                    if (command === "search") return JSON.stringify({
                        list: [{
                            id: 1, hash: "drag-thumbnail-item", itemType: kind, content,
                            time: Date.now(), previewContent: kind === "Image" ? "/image.png" : kind === "TextFile" ? "git clone preview" : "",
                            textContent: kind === "Text" || kind === "Color" ? content : "",
                            label: 0, appSource: native ? "Preview" : "", appIconPath: native ? imageSrc : "", richHtml: rich ? richHtml : "", tags: [],
                        }], consumed: 1, hasMore: false, nextId: 0, nextTime: 0,
                    });
                    if (command === "get_config") return JSON.stringify({ multilingual: "English", onboarding_completed: true });
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "plain_text_content") {
                        Object.assign(window, { __fullTextPrepared: true });
                        return text;
                    }
                    if (command === "capture_native_drag_preview") {
                        const source = document.querySelector('[data-native-drag-preview]') as HTMLElement;
                        const review = source.cloneNode(true) as HTMLElement;
                        review.removeAttribute("data-native-drag-preview");
                        review.dataset.testid = "native-card-review";
                        review.style.left = "700px";
                        review.style.top = "72px";
                        document.body.appendChild(review);
                        Object.assign(window, { __capturedNativeCardRect: args });
                        if (captureFails) throw new Error("fixture snapshot failure");
                        return new Promise<number[]>(resolve => Object.assign(window, { __resolveNativeCardSnapshot: resolve }));
                    }
                    if (command === "native_drag_file") {
                        Object.assign(window, { __nativeDragArguments: args });
                        return true;
                    }
                    if (command === "file_preview_info") return {
                        kind: fileCase === "image" ? "single-preview" : fileCase === "folder" ? "single-folder" : fileCase === "multiple" ? "multiple" : "single-icon",
                        paths, exists: true, missing_paths: [], display_path: paths[0],
                        secondary_text: fileCase === "multiple" ? "3 files" : "",
                        extension: fileCase === "image" ? "PNG" : fileCase === "document" ? "PDF" : "",
                        preview_path: fileCase === "image" ? "/image.png" : "", contains_directories: fileCase === "folder",
                        image_width: fileCase === "image" ? 200 : null, image_height: fileCase === "image" ? 160 : null,
                    };
                    if (command === "history_image_metadata") return { width: 200, height: 160, isGif: false };
                    if (["history_image_card_preview_asset_path", "history_file_data_url"].includes(command)) return imageSrc;
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                    if (command === "plugin:event|listen") return ++callbackId;
                    return null;
                },
                transformCallback: () => ++callbackId, unregisterCallback: () => undefined,
                convertFileSrc: (value: string) => value,
                metadata: { currentWindow: { label: "clipboard" }, currentWebview: { label: "clipboard" } },
            },
        });
        const setDragImage = DataTransfer.prototype.setDragImage;
        DataTransfer.prototype.setDragImage = function(image, x, y) {
            // Review the exact DOM passed to the real browser drag-image API.
            const review = image.cloneNode(true) as HTMLElement;
            review.dataset.testid = "drag-thumbnail-review";
            review.style.top = "72px";
            review.style.left = "700px";
            document.body.appendChild(review);
            Object.assign(window, { __sourceDragPreviewConnected: () => image.isConnected });
            setDragImage.call(this, image, x, y);
        };
    }, { kind, text, richHtml, imageSrc, native, captureFails, fileCase, paths: filePaths[fileCase], rich });
    await page.setViewportSize({ width: 960, height: 600 });
    await page.goto("/clipboard");
    const card = page.locator('[data-hash="drag-thumbnail-item"]');
    await expect(card).toBeVisible();
    if (kind === "Image" || (kind === "File" && fileCase === "image")) {
        await expect.poll(() => card.locator('[class*="card-content"] img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(200);
    } else if (kind === "File") {
        await expect(card.locator('[class*="file-path-line"]').first()).toContainText(filePaths[fileCase][0]);
        const mode = fileCase === "folder" ? "folder" : fileCase === "multiple" ? "multiple" : "known";
        await expect(card.locator('[data-file-presentation]')).toHaveAttribute("data-file-presentation", mode);
    }
    if (native) await expect.poll(() => card.locator('[class*="app-header-icon"]').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(200);
    if (kind === "TextFile") {
        await card.hover();
        await expect.poll(() => page.evaluate(() => (window as typeof window & { __fullTextPrepared?: boolean }).__fullTextPrepared)).toBe(true);
    }
    await page.evaluate(() => {
        const target = document.createElement("div");
        target.dataset.testid = "drop-target";
        target.style.cssText = "position:fixed;left:580px;top:390px;width:160px;height:120px";
        target.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer!.dropEffect = "copy"; });
        target.addEventListener("drop", event => {
            event.preventDefault();
            Object.assign(window, { __droppedClipboardData: Object.fromEntries(
                Array.from(event.dataTransfer!.types).map(type => [type, event.dataTransfer!.getData(type)]),
            ) });
        });
        document.body.appendChild(target);
    });
    return card;
}

async function assertCardShape(preview: Locator) {
    await expect(preview).toHaveCSS("width", "132px");
    await expect(preview).toHaveCSS("height", "138px");
    for (const corner of ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"]) {
        await expect(preview).toHaveCSS(corner, "8.4px");
    }
    await expect(preview.locator('[class*="card-time"]')).not.toBeEmpty();
    await expect(preview.locator('[data-hash], [data-external-dragging], [data-motion-preset="shortcutHint"]')).toHaveCount(0);
    await expect(preview).not.toContainText("Dragging");
}

const browserScenarios = [
    ...(["Text", "TextFile", "Link", "Color", "Image", "File"] as const).map(kind => ({ kind, dark: false, rich: false })),
    { kind: "Text" as const, dark: true, rich: false },
    { kind: "Text" as const, dark: false, rich: true },
];
for (const { kind, dark, rich } of browserScenarios) {
    test(`browser ${kind} uses the shared card preview and preserves data (dark: ${dark}, rich: ${rich})`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
        const card = await openDragCard(page, kind, { rich });
        await card.dragTo(page.getByTestId("drop-target"), { sourcePosition: { x: 60, y: 80 } });
        const preview = page.getByTestId("drag-thumbnail-review");
        await expect(preview).toBeVisible();
        await assertCardShape(preview);
        await expect(preview.locator('[class*="clipboard-card"]')).toHaveCSS("content-visibility", "visible");
        const dropped = await page.evaluate(() => (window as typeof window & { __droppedClipboardData: Record<string, string> }).__droppedClipboardData);
        expect(JSON.parse(dropped["application/x-vpaste-item"])).toEqual({ hash: "drag-thumbnail-item", type: kind });
        if (kind === "Text" || kind === "TextFile") {
            await expect(preview).toContainText(rich ? "Rich clipboard content" : "git clone");
            expect(dropped["text/plain"]).toBe(text);
            if (rich) expect(dropped["text/html"]).toBe(richHtml);
        } else if (kind === "Link") {
            await expect(preview).toContainText("Example repository");
            expect(new URL(dropped["text/uri-list"]).href).toBe("https://example.test/");
        } else if (kind === "Color") {
            await expect(preview).toContainText("#1b83ff");
            await expect(preview.locator('[class*="card-preview-color"]')).toHaveCSS("background-color", "rgb(27, 131, 255)");
            expect(dropped["text/plain"]).toBe("#1b83ff");
        } else if (kind === "Image") {
            await expect.poll(() => preview.locator('[class*="card-content"] img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(200);
            expect(dropped["text/uri-list"]).toBe("file:///image.png");
        } else {
            await expect(preview.locator('[class*="card-header"]')).toContainText("File");
            await expect(preview).toContainText("/report.pdf");
            expect(dropped["text/uri-list"]).toBe("file:///report.pdf");
        }
        await expect(card).not.toHaveAttribute("data-external-dragging");
        await expect(card.locator('[data-motion-state="external-drag-complete"]')).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => (window as typeof window & { __sourceDragPreviewConnected: () => boolean }).__sourceDragPreviewConnected())).toBe(false);
        await expect(preview).toHaveCSS("background-color", await card.evaluate(element => getComputedStyle(element).backgroundColor));
        const screenshotPath = testInfo.outputPath(`${kind}-drag-thumbnail.png`);
        await preview.screenshot({ path: screenshotPath });
        await testInfo.attach(`${kind}-drag-thumbnail`, { path: screenshotPath, contentType: "image/png" });
    });
}

const nativeScenarios = [
    { kind: "Image" as const, fileCase: "image" as const, dark: false, reduced: false },
    { kind: "Image" as const, fileCase: "image" as const, dark: true, reduced: false },
    { kind: "Image" as const, fileCase: "image" as const, dark: false, reduced: true },
    ...(["image", "document", "folder", "multiple"] as const).map(fileCase => ({ kind: "File" as const, fileCase, dark: false, reduced: false })),
    { kind: "File" as const, fileCase: "document" as const, dark: true, reduced: false },
    { kind: "File" as const, fileCase: "document" as const, dark: false, reduced: true },
];
async function startNativeCardDrag(page: Page, card: Locator) {
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 72, box.y + 80, { steps: 3 });
}
async function finishSnapshot(page: Page) {
    await page.evaluate(() => (window as typeof window & { __resolveNativeCardSnapshot: (bytes: number[]) => void }).__resolveNativeCardSnapshot([137, 80, 78, 71]));
}
for (const { kind, fileCase, dark, reduced } of nativeScenarios) {
    test(`macOS ${kind}/${fileCase} uses the shared card preview (dark: ${dark}, reduced: ${reduced})`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: reduced ? "reduce" : "no-preference" });
        const card = await openDragCard(page, kind, { native: true, fileCase });
        await startNativeCardDrag(page, card);
        const review = page.getByTestId("native-card-review");
        await expect(review).toBeVisible();
        await assertCardShape(review);
        await expect(review.locator('[class*="card-header"]')).toContainText(kind === "Image" || fileCase === "image" ? "Image" : "File");
        await expect(review.locator('[class*="app-header-icon"]')).toBeVisible();
        if (kind === "Image" || fileCase === "image") {
            await expect.poll(() => review.locator('[class*="card-content"] img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(200);
        } else {
            await expect(review).toContainText(filePaths[fileCase][0]);
            if (fileCase === "folder") await expect(review.locator('[data-file-presentation="folder"]')).toHaveCount(1);
            if (fileCase === "multiple") {
                await expect(review.locator('[data-file-presentation="multiple"]')).toHaveCount(1);
                await expect(review).toContainText("3 files");
            }
        }
        expect(await page.evaluate(() => (window as typeof window & { __capturedNativeCardRect: { rect: unknown } }).__capturedNativeCardRect.rect)).toMatchObject({ width: 132, height: 138, cornerRadius: 8.4 });
        await expect(review).toHaveCSS("background-color", await card.evaluate(element => getComputedStyle(element).backgroundColor));
        const screenshotPath = testInfo.outputPath("native-complete-card.png");
        await review.screenshot({ path: screenshotPath });
        await testInfo.attach("native-complete-card", { path: screenshotPath, contentType: "image/png" });
        await finishSnapshot(page);
        await expect(page.locator('[data-native-drag-preview]')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as typeof window & { __nativeDragArguments?: unknown }).__nativeDragArguments)).toEqual({ paths: kind === "Image" ? ["/image.png"] : filePaths[fileCase], isImage: kind === "Image", previewPng: [137, 80, 78, 71] });
        await expect(card).not.toHaveAttribute("data-external-dragging");
        await expect(card.locator('[data-motion-state="external-drag-complete"]')).toHaveCount(1);
        await page.mouse.up();
    });
}
for (const kind of ["Image", "File"] as const) {
    test(`macOS ${kind} releases outside the card cancel a pending snapshot`, async ({ page }) => {
        const card = await openDragCard(page, kind, { native: true });
        await startNativeCardDrag(page, card);
        await expect(page.getByTestId("native-card-review")).toBeVisible();
        await page.mouse.move(580, 390);
        await page.mouse.up();
        await expect(page.locator('[data-native-drag-preview]')).toHaveCount(0);
        await finishSnapshot(page);
        await expect(card).not.toHaveAttribute("data-external-dragging");
        expect(await page.evaluate(() => (window as typeof window & { __nativeDragArguments?: unknown }).__nativeDragArguments)).toBeUndefined();
    });
    test(`macOS ${kind} snapshot failure preserves the original payload`, async ({ page }) => {
        const card = await openDragCard(page, kind, { native: true, captureFails: true });
        await startNativeCardDrag(page, card);
        await expect.poll(() => page.evaluate(() => (window as typeof window & { __nativeDragArguments?: unknown }).__nativeDragArguments)).toEqual({ paths: kind === "Image" ? ["/image.png"] : filePaths.document, isImage: kind === "Image" });
        await expect(page.locator('[data-native-drag-preview]')).toHaveCount(0);
        await expect(card).not.toHaveAttribute("data-external-dragging");
        await page.mouse.up();
    });
}
