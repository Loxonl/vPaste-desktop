// Actual-App IPC/DOM checks. A marked, isolated profile is mandatory;
// this deliberately does not inject desktop mouse input or claim a drag pass.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const [fixture, endpoint = "http://127.0.0.1:9345"] = process.argv.slice(2);
if (!fixture) throw new Error("Usage: node scripts/check-winui-media-settings.mjs <memory-fixture> [CDP endpoint]");
const root = path.resolve(fixture);
assert.equal(readFileSync(path.join(root, ".vpaste-memory-profile"), "utf8"), "vpaste-memory-v1\n");
const normalized = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const browser = await chromium.connectOverCDP(endpoint);
let files;
try {
    const pages = () => browser.contexts().flatMap(context => context.pages());
    const control = pages().find(page => new URL(page.url()).pathname === "/config");
    assert(control, "Open the isolated profile's settings first");
    const invoke = (command, args = {}) => control.evaluate(
        ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
    assert.equal(normalized(await invoke("get_app_data_dir")), normalized(root), "Refuse a non-fixture process");
    assert(!pages().some(page => new URL(page.url()).pathname === "/clipboard"));

    const drag = await control.evaluate(async () => {
        const handles = ["dragRegion", "sidebarDragRegion", "contentTitleBar"]
            .map(name => document.querySelector(`[class*="${name}"]`));
        const calls = [];
        const original = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = function (command, ...args) {
            calls.push(command);
            return original.call(this, command, ...args);
        };
        try {
            for (const handle of handles) {
                if (!handle) throw new Error("Missing settings caption region");
                handle.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
                handle.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
            return {
                captionRegions: handles.map(handle => getComputedStyle(handle).webkitAppRegion),
                closeRegion: getComputedStyle(document.querySelector('[class*="windowsWindowControls"]')).webkitAppRegion,
                manualDragRequests: calls.filter(command => /start_config_window_drag|start_dragging/.test(command)),
            };
        } finally { window.__TAURI_INTERNALS__.invoke = original; }
    });
    assert.deepEqual(drag.captionRegions, ["drag", "drag", "drag"]);
    assert.equal(drag.closeRegion, "no-drag");
    assert.deepEqual(drag.manualDragRequests, []);

    const storage = await invoke("get_storage_paths");
    const cacheEntries = () => existsSync(storage.file_previews_dir)
        ? readdirSync(storage.file_previews_dir).sort() : [];
    const cacheBefore = cacheEntries();
    files = mkdtempSync(path.join(root, "media-settings-check-"));
    const mediaKinds = {};
    for (const extension of ["mp4", "mov", "mp3", "zip", "docx", "txt", "pdf"]) {
        const file = path.join(files, `sample.${extension}`);
        writeFileSync(file, "Synthetic preview fixture");
        const info = await invoke("file_preview_info", { content: JSON.stringify([file]) });
        mediaKinds[extension] = info.kind;
        assert.equal(info.kind, extension === "txt" ? "text-preview" : extension === "pdf" ? "pdf-preview" : "single-icon");
        assert.equal(info.preview_path, "");
    }
    assert.deepEqual(cacheEntries(), cacheBefore, "Ordinary files initialized or changed the Shell cache");
    const image = path.join(files, "pixel.png");
    writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const info = await invoke("file_preview_info", { content: JSON.stringify([image]) });
    assert.equal(info.kind, "single-preview");
    assert.equal(info.preview_path, image);
    assert.equal(info.image_width, 1); assert.equal(info.image_height, 1);
    const multiple = await invoke("file_preview_info", { content: JSON.stringify([image, path.join(files, "sample.mp4")]) });
    assert.equal(multiple.kind, "multiple"); assert.equal(multiple.preview_path, "");
    console.log(JSON.stringify({ drag, mediaKinds, imagePreviewPreserved: true, multipleFileSemanticsPreserved: true,
        mainWebViewCreated: false, physicalDraggingTested: false, dwmTransparencyTested: false }));
} finally {
    if (files) {
        for (const file of readdirSync(files)) unlinkSync(path.join(files, file));
        rmdirSync(files);
    }
    await browser.close();
}
