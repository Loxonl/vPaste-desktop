// Local runtime regression. Attach only to an explicitly marked Debug fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const [fixture, endpoint = "http://127.0.0.1:9345"] = process.argv.slice(2);
if (!fixture) throw new Error("Usage: node scripts/check-winui-auxiliary-lifecycle.mjs <memory-fixture> [CDP endpoint]");
const root = path.resolve(fixture);
assert.equal(readFileSync(path.join(root, ".vpaste-memory-profile"), "utf8"), "vpaste-memory-v1\n");
const normalized = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const browser = await chromium.connectOverCDP(endpoint);
const pages = () => browser.contexts().flatMap(context => context.pages());
const route = page => new URL(page.url()).pathname;
const until = async (read, name) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${name}`);
};
const invokeOn = page => (command, args = {}) => page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const preview = (content, mode = "manual") => ({
    itemType: "Text", content, mode, previewContent: "", textContent: "",
    richHtml: `<p>${content}</p>`, appSource: "",
});

try {
    const control = await until(() => pages().find(page => route(page) === "/config"), "fixture settings");
    const invoke = invokeOn(control);
    assert.equal(normalized(await invoke("get_app_data_dir")), normalized(root), "Refuse a non-fixture process");
    assert(!pages().some(page => route(page) === "/clipboard"), "Native session created a main WebView");
    await invoke("show_preview_window", preview("Auxiliary lifecycle fixture"));
    const shell = await until(() => pages().find(page => route(page) === "/clipboard/preview"), "preview shell");
    const visibleText = (page, text) => page.getByText(text, { exact: true }).isVisible().catch(() => false);
    await until(() => visibleText(shell, "Auxiliary lifecycle fixture"), "preview committed");
    await invoke("show_preview_window", preview("Continuous replacement", "selection"));
    await until(() => visibleText(shell, "Continuous replacement"), "visible replacement");
    assert.equal(pages().find(page => route(page) === "/clipboard/preview"), shell, "Visible switch replaced renderer");
    await invoke("set_preview_pinned", { pinned: true });
    await invoke("show_preview_window", preview("Must not replace pinned text", "selection"));
    assert(await visibleText(shell, "Continuous replacement"), "Selection overwrote pinned content");
    await invoke("hide_preview_window");
    await until(() => shell.isClosed(), "closed renderer retired");
    await until(() => pages().every(page => page === control), "browser renderer retired");

    for (let iteration = 0; iteration < 3; iteration++) {
        await Promise.all([invoke("show_preview_window", preview("Reopened fixture")), invoke("hide_preview_window")]);
        await until(() => !pages().some(page => route(page) === "/clipboard/preview"), "canceled cold creation retired");
        await invoke("show_preview_window", preview("Reopened fixture"));
        const reopened = await until(() => pages().find(page => route(page) === "/clipboard/preview"), "reopened shell");
        await until(() => visibleText(reopened, "Reopened fixture"), "reopened content");
        await invoke("hide_preview_window");
        await until(() => reopened.isClosed(), "reopened shell retired");
    }

    await invoke("open_onboarding_window");
    const guide = await until(() => pages().find(page => route(page) === "/native-onboarding"), "temporary guide");
    const guideInvoke = invokeOn(guide);
    await until(() => guide.getByRole("checkbox").count().then(count => count === 5), "guide initialized");
    await guideInvoke("show_main_panel");
    assert(!pages().some(page => route(page) === "/clipboard"), "Guide restore created a main WebView");
    await guideInvoke("close_config_window");
    await until(() => control.isClosed(), "settings released");
    await guideInvoke("open_config_window");
    const newSettings = await until(() => pages().find(page => route(page) === "/config"), "settings recreated");
    assert.notEqual(newSettings, control);
    await newSettings.waitForFunction(() => !!window.__TAURI_INTERNALS__);
    await invokeOn(newSettings)("complete_onboarding");
    await until(() => guide.isClosed(), "completed guide released");
    console.log(JSON.stringify({ visibleReuse: true, pinPreserved: true, coldCloseReopen: 3,
        settingsRecreated: true, guideReleased: true, mainWebViewCreated: false }));
} finally {
    await browser.close();
}
