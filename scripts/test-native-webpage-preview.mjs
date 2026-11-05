// Local Windows WebView2 check. Requires an isolated --memory-profile-inspector
// Debug with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9344.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const endpoint = process.env.VPASTE_NATIVE_PREVIEW_CDP || "http://127.0.0.1:9344";
const artifacts = path.resolve(".codex/native-webpage-preview/native-smoke");
const origin = "https://preview-fixture.example";
await until(async () => {
    try { return (await fetch(`${endpoint}/json/version`)).ok; } catch { return false; }
}, "WebView debugging endpoint");
const browser = await chromium.connectOverCDP(endpoint);
const pages = () => browser.contexts().flatMap(context => context.pages());
async function until(predicate, description) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Native preview timed out: ${description}`);
}
const clipboard = await until(() => pages().find(page => new URL(page.url()).pathname === "/clipboard"), "trusted clipboard page");
const invoke = (command, args = {}) => clipboard.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
// This command rejects outside an isolated profiling process. Never inspect a user's real history.
await invoke("memory_profile_parking_state", { toggle: false });
await mkdir(artifacts, { recursive: true });
let success = false;
let activeWeb;
try {
    for (const context of browser.contexts()) {
        await context.route(/^https:\/\/(?:assets\.)?preview-fixture\.example\//, route => {
            const file = new URL(route.request().url()).pathname;
            if (file === "/picture.svg") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#1681ff"/></svg>' });
            if (file === "/page.js") return route.fulfill({ contentType: "text/javascript", body: 'document.querySelector("#script").textContent="JavaScript loaded";' });
            if (file === "/page.css") return route.fulfill({ contentType: "text/css", body: "body { color: rgb(30, 70, 150); background: white; }" });
            return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><link rel="stylesheet" href="https://assets.preview-fixture.example/page.css"></head><body tabindex="-1"><h1>Native webpage preview</h1><img id="picture" src="https://assets.preview-fixture.example/picture.svg"><p id="script"></p><input id="entry" aria-label="Fixture input"><script src="https://assets.preview-fixture.example/page.js"></script></body></html>' });
        });
    }
    await invoke("memory_profile_parking_state", { toggle: true });
    await invoke("plugin:window|set_focus", { label: "clipboard" });
    const show = async (type = "Link", content = `${origin}/page`) => {
        // Profiling intentionally disables automatic app activation; supply the
        // same foreground precondition as a user pressing Space in the panel.
        await invoke("plugin:window|set_focus", { label: "clipboard" });
        return invoke("show_preview_window", {
            itemType: type, content, previewContent: "", textContent: "", richHtml: "", appSource: "",
            mode: "manual", navigationDirection: 0,
        });
    };
    await show();
    const web = await until(() => pages().find(page => page.url().startsWith(origin)), "native webpage navigation");
    activeWeb = web;
    // Check the natural first-show handoff before any test focus call can
    // conceal a native-window/WebView focus mismatch.
    await until(async () => {
        if (await invoke("plugin:window|is_focused", { label: "clipboard" })) {
            return clipboard.evaluate(() => document.hasFocus());
        }
        if (await invoke("plugin:window|is_focused", { label: "previewBrowser" })) {
            return web.evaluate(() => document.hasFocus());
        }
        return false;
    }, "first show restores keyboard focus without moving the pointer");
    await invoke("plugin:window|set_focus", { label: "previewBrowser" });
    assert.equal(await invoke("plugin:window|is_focused", { label: "previewBrowser" }), true, "native webpage did not obtain focus for keyboard testing");
    await invoke("set_preview_pinned", { pinned: true });
    await web.locator("#script").filter({ hasText: "JavaScript loaded" }).waitFor();
    await web.waitForFunction(() => document.querySelector("#picture")?.naturalWidth === 120);
    assert.equal(await web.evaluate(() => getComputedStyle(document.body).color), "rgb(30, 70, 150)");
    const parentPosition = await invoke("plugin:window|inner_position", { label: "clipboardPreview" });
    const parentSize = await invoke("plugin:window|inner_size", { label: "clipboardPreview" });
    const contentPosition = await invoke("plugin:window|outer_position", { label: "previewBrowser" });
    const contentSize = await invoke("plugin:window|outer_size", { label: "previewBrowser" });
    assert(contentPosition.x >= parentPosition.x && contentPosition.y > parentPosition.y);
    assert(contentPosition.x + contentSize.width <= parentPosition.x + parentSize.width + 2);
    assert(contentPosition.y + contentSize.height <= parentPosition.y + parentSize.height + 2);
    const permission = await web.evaluate(async () => {
        if (!window.__TAURI_INTERNALS__?.invoke) return "absent";
        try { await window.__TAURI_INTERNALS__.invoke("get_config", { skipAutostartRefresh: true }); return "allowed"; }
        catch { return "denied"; }
    });
    assert.notEqual(permission, "allowed", "remote website gained access to app configuration");
    await web.locator("#entry").fill("hello");
    await web.locator("#entry").press("End");
    await web.locator("#entry").press("Space");
    assert.equal(await web.locator("#entry").inputValue(), "hello ");
    await web.screenshot({ path: path.join(artifacts, "webpage.png") });
    await invoke("set_preview_pinned", { pinned: true });
    assert.equal(web.url(), `${origin}/page`, "pinning cleared the webpage");
    const visible = await invoke("plugin:window|is_visible", { label: "previewBrowser" });
    assert.equal(visible, true);
    await show("Text", "Native preview text switch");
    await until(() => web.url() === "about:blank", "page cleared after text selection");
    await web.waitForFunction(() => document.querySelector("#picture") === null);
    assert.equal(await invoke("plugin:window|is_visible", { label: "previewBrowser" }), false);
    await invoke("plugin:window|set_focus", { label: "clipboard" });
    await show();
    await web.waitForURL(`${origin}/page`);
    await web.locator("#script").filter({ hasText: "JavaScript loaded" }).waitFor();
    if (process.env.VPASTE_NATIVE_PREVIEW_LIVE === "1") {
        await show("Link", "https://example.com/");
        await web.waitForURL("https://example.com/");
        await web.getByText(/This domain is for use in documentation examples/).waitFor({ timeout: 8000 });
        await show();
        await web.waitForURL(`${origin}/page`);
        await web.locator("#script").filter({ hasText: "JavaScript loaded" }).waitFor();
    }
    await invoke("plugin:window|set_focus", { label: "previewBrowser" });
    await web.locator("body").focus();
    await web.keyboard.press("Space");
    await until(() => web.url() === "about:blank", "page cleared after Space");
    assert.equal(await invoke("plugin:window|is_visible", { label: "previewBrowser" }), false);
    assert.equal(await invoke("plugin:window|is_visible", { label: "clipboardPreview" }), false);
    await show();
    await web.waitForURL(`${origin}/page`);
    await web.locator("#script").filter({ hasText: "JavaScript loaded" }).waitFor();
    await invoke("plugin:window|set_focus", { label: "previewBrowser" });
    await web.locator("body").focus();
    await web.keyboard.press("Escape");
    await until(() => web.url() === "about:blank", "page cleared after Escape");
    await web.waitForFunction(() => document.querySelector("#picture") === null);
    assert.equal(await invoke("plugin:window|is_visible", { label: "previewBrowser" }), false);
    assert(pages().includes(web), "closing destroyed the warm native view");
    success = true;
    console.log(JSON.stringify({ passed: true, imageDecoded: true, websiteJavaScript: true, websiteCss: true,
        remoteAppAccess: permission, inputSpace: true, pinRetainsPage: true, textSwitchClearsPage: true,
        naturalWebViewFocus: true, spaceCloses: true, escapeCloses: true, blankViewRetained: true, nativeBoundsInsideShell: true,
        liveHttps: process.env.VPASTE_NATIVE_PREVIEW_LIVE === "1", artifacts }));
} catch (error) {
    if (activeWeb && !activeWeb.isClosed()) {
        console.error(JSON.stringify({ phase: "native failure snapshot", url: activeWeb.url(),
            title: await activeWeb.title().catch(() => "unavailable"),
            browserError: await activeWeb.evaluate(() => document.body?.innerText.match(/ERR_[A-Z_]+/)?.[0] || null).catch(() => null),
            browserVisible: await invoke("plugin:window|is_visible", { label: "previewBrowser" }).catch(() => null) }));
        await activeWeb.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
    }
    throw error;
} finally {
    await invoke("quit_app").catch(() => {});
    if (!success) console.error("Native preview smoke failed; isolated app was asked to quit.");
}
