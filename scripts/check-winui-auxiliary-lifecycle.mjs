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
const seenRoutes = new Set(pages().map(route));
for (const context of browser.contexts()) {
    context.on("page", page => {
        seenRoutes.add(route(page));
        page.on("framenavigated", frame => {
            if (frame === page.mainFrame()) seenRoutes.add(route(page));
        });
    });
}
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
    const initialQueue = await invoke("get_paste_queue_state");
    assert(!initialQueue.active && !initialQueue.busy && !initialQueue.items.length,
        "Refuse to exercise a populated or active queue");
    // Activation installs an input interceptor in ordinary Debug. Keep this
    // no-capture fixture inactive and verify that real IPC rejects mutations.
    for (const [command, args] of [
        ["add_paste_queue_items", { hashes: ["inactive-fixture"] }],
        ["reorder_paste_queue", { hashes: [] }],
        ["reverse_paste_queue", {}],
        ["remove_paste_queue_item", { hash: "inactive-fixture" }],
        ["clear_paste_queue", {}],
        ["undo_paste_queue_consume", {}],
    ]) {
        await assert.rejects(() => invoke(command, args), /粘贴队列尚未激活/);
        assert.deepEqual(await invoke("get_paste_queue_state"), initialQueue,
            `Inactive ${command} changed queue state`);
    }
    await invoke("show_preview_window", preview("Auxiliary lifecycle fixture"));
    const shell = await until(() => pages().find(page => route(page) === "/clipboard/preview"), "preview shell");
    const visibleText = (page, text) => page.getByText(text, { exact: true }).isVisible().catch(() => false);
    await until(() => visibleText(shell, "Auxiliary lifecycle fixture"), "preview committed");
    const toolbar = shell.locator('[data-preview-toolbar="native"]');
    await toolbar.getByRole("heading", { name: /^(预览|Preview)$/ }).waitFor();
    assert.equal(await toolbar.getByRole("button").count(), 1, "Fallback preview should expose just the pin");
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
        const opening = invoke("show_preview_window", preview("Reopened fixture"));
        // This predicate includes in-flight requests. Wait for Rust to accept
        // the open so independent async IPC calls cannot test close-then-open.
        await until(() => invoke("is_preview_window_visible"), "cold open request accepted");
        await invoke("hide_preview_window");
        await opening;
        await until(() => !pages().some(page => route(page) === "/clipboard/preview"), "canceled cold creation retired");
        await invoke("show_preview_window", preview("Reopened fixture"));
        const reopened = await until(() => pages().find(page => route(page) === "/clipboard/preview"), "reopened shell");
        await until(() => visibleText(reopened, "Reopened fixture"), "reopened content");
        await invoke("hide_preview_window");
        await until(() => reopened.isClosed(), "reopened shell retired");
    }

    // A second existing auxiliary surface provides IPC after closing Settings.
    // Pin this control before the focus change; an ordinary preview would
    // correctly close. The native guide itself has no Chromium target.
    await invoke("show_preview_window", preview("Settings lifecycle fixture"));
    const settingsControl = await until(() => pages().find(page => route(page) === "/clipboard/preview"), "settings lifecycle control");
    await until(() => visibleText(settingsControl, "Settings lifecycle fixture"), "settings lifecycle content");
    await invoke("set_preview_pinned", { pinned: true });
    await invokeOn(settingsControl)("close_config_window");
    await until(() => control.isClosed(), "settings released");
    await invokeOn(settingsControl)("open_config_window");
    const newSettings = await until(() => pages().find(page => route(page) === "/config"), "settings recreated");
    assert.notEqual(newSettings, control);
    await newSettings.waitForFunction(() => !!window.__TAURI_INTERNALS__);
    const invokeNewSettings = invokeOn(newSettings);
    await invokeNewSettings("hide_preview_window");
    await until(() => settingsControl.isClosed(), "settings lifecycle renderer retired");
    const { onboarding_completed: wasCompleted } = JSON.parse(await invokeNewSettings("get_config", { skipAutostartRefresh: true }));
    const storedTabs = await invokeNewSettings("get_custom_tabs");
    await invokeNewSettings("open_onboarding_window");
    await invokeNewSettings("show_main_panel");
    if (!wasCompleted && !storedTabs.length) {
        const initialized = await until(async () => {
            const tabs = await invokeNewSettings("get_custom_tabs");
            return tabs.length ? tabs : null;
        }, "first-run tutorial defaults");
        assert.deepEqual(initialized.map(tab => tab.id), [
            "tutorial-filter-text", "tutorial-filter-image", "tutorial-filter-link", "tutorial-filter-file",
        ]);
    }
    await invokeNewSettings("complete_onboarding");
    assert.equal(JSON.parse(await invokeNewSettings("get_config", { skipAutostartRefresh: true })).onboarding_completed, true);
    for (const unexpected of ["/clipboard", "/native-onboarding", "/__dev-tutorial"]) {
        assert(!seenRoutes.has(unexpected), `Native session created a WebView for ${unexpected}`);
    }
    console.log(JSON.stringify({ inactiveQueueMutationGuards: 6,
        queueActivated: false, externalPasteTested: false,
        visibleReuse: true, pinPreserved: true, fallbackPreviewTitle: true, coldCloseReopen: 3,
        settingsRecreated: true, guideCompletionSaved: true, guideWebViewCreated: false, mainWebViewCreated: false }));
} finally {
    await browser.close();
}
