import { expect, test, type Page } from "@playwright/test";
import { installHistoryMockBridge } from "../helpers/historyMockBridge";

test.beforeEach(async ({ page }) => { await page.addInitScript(installHistoryMockBridge); });


type Update = { id: number; revision: string; text: string; html: string; rtf: string };
type Probe = Window & { __editorProbe: { saves: Update[]; opened: string[]; hidden: number; searches: number; text: string; emit: (event: string, payload?: unknown) => void } };

async function openEditor(page: Page, rich = false, rejectSave = false, clipboard = false) {
    await page.setViewportSize({ width: 596, height: 476 });
    await page.addInitScript(({ rich, rejectSave }) => {
        Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
        let sequence = 0;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<string, number>();
        const probe = {
            saves: [] as Update[], opened: [] as string[], hidden: 0, searches: 0, text: "完整正文\n".repeat(2500),
            emit: (event: string, payload?: unknown) => callbacks.get(listeners.get(event)!)?.({ payload }),
        };
        const row = { id: 1, hash: "original", itemType: "Text", content: "原文", previewContent: "原文", textContent: "", richHtml: "", time: 1, label: 1, tags: [], appSource: "Browser", appIconPath: "" };
        Object.assign(window, {
            __editorProbe: probe,
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: Record<string, unknown> = {}) => {
                    if (command === "get_config") return JSON.stringify({ multilingual: "Chinese", onboarding_completed: true });
                    if (command === "get_text_editor_document") return { id: 1, hash: "original", revision: "version-1", text: rich ? "原文 link" : probe.text,
                        html: rich ? '<p><strong style="color:rgb(255,0,0)">原文</strong> <a href="https://example.com/">link</a></p>' : "" };
                    if (command === "save_clipboard_text") {
                        const update = args.update as Update;
                        probe.saves.push(update);
                        if (rejectSave) throw "editor.duplicate";
                        probe.text = update.text;
                        return { ...row, hash: "edited", content: update.text };
                    }
                    if (command === "hide_text_editor_window") probe.hidden += 1;
                    if (command === "open_text_editor_window") probe.opened.push(args.hash as string);
                    if (command === "search") { probe.searches += 1; return JSON.stringify({ list: [row], consumed: 1, hasMore: false, nextId: 0, nextTime: 0 }); }
                    if (["list_language_packs", "list_item_tags", "get_custom_tabs", "refresh_link_previews"].includes(command)) return [];
                    if (command === "get_paste_queue_state") return { active: false, revision: 0 };
                    if (command === "get_update_state") return { status: "disabled", currentVersion: "", downloadedBytes: 0, portable: false, feedEnabled: false, releaseUrl: "" };
                    if (command === "plugin:event|listen") { listeners.set(args.event as string, args.handler as number); return ++sequence; }
                    return null;
                },
                transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++sequence, callback); return sequence; },
                unregisterCallback: () => undefined,
                convertFileSrc: (value: string) => value,
                metadata: { currentWindow: { label: "textEditor" }, currentWebview: { label: "textEditor" } },
            },
        });
    }, { rich, rejectSave });
    await page.goto(clipboard ? "/clipboard" : "/text-editor");
    if (!clipboard) await expect(page.getByRole("textbox", { name: "文字内容" })).toBeEnabled();
}

const state = (page: Page) => page.evaluate(() => ({ saves: (window as Probe).__editorProbe.saves, hidden: (window as Probe).__editorProbe.hidden, opened: (window as Probe).__editorProbe.opened }));

test("loads complete long text and saves only by explicitly activating Save", async ({ page }) => {
    await openEditor(page);
    const field = page.getByRole("textbox", { name: "文字内容" });
    await expect(field).toHaveValue("完整正文\n".repeat(2500));
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await field.fill("  修改中文\n第二行  ");
    await field.press("Control+Enter");
    await field.press("Meta+Enter");
    await field.press("F2");
    expect((await state(page)).saves).toHaveLength(0);
    await field.fill("  修改中文\n第二行  ");
    const save = page.getByRole("button", { name: "保存", exact: true });
    const bounds = await save.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(476);
    await save.click();
    await expect.poll(async () => (await state(page)).hidden).toBe(1);
    expect((await state(page)).saves[0]).toMatchObject({ id: 1, revision: "version-1", text: "  修改中文\n第二行  ", html: "", rtf: "" });
});

test("retains dirty drafts on focus loss, supports native undo and confirms discard", async ({ page }) => {
    await openEditor(page, true);
    const field = page.getByRole("textbox", { name: "文字内容" });
    await field.focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" changed");
    await page.keyboard.press("Control+z");
    await expect(field).not.toContainText("changed");
    await page.keyboard.type(" draft");
    await page.mouse.click(1, 1);
    expect((await state(page)).hidden).toBe(0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(field).toContainText("draft");
    await page.evaluate(() => (window as Probe).__editorProbe.emit("text-editor-close-requested"));
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    expect((await state(page)).saves).toHaveLength(0);
    await expect.poll(async () => (await state(page)).hidden).toBe(1);
});

test("preserves bold, color and links and emits edited HTML plus fresh RTF", async ({ page }) => {
    await openEditor(page, true);
    await page.getByRole("textbox", { name: "文字内容" }).evaluate(element => {
        const strong = element.querySelector("strong")!;
        const range = document.createRange();
        range.selectNodeContents(strong);
        const selection = window.getSelection()!;
        selection.removeAllRanges(); selection.addRange(range);
        (element as HTMLElement).focus();
    });
    await page.keyboard.insertText("更新中文😀");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await state(page)).saves.length).toBe(1);
    const saved = (await state(page)).saves[0];
    expect(saved.text).toBe("更新中文😀 link");
    expect(saved.html).toContain("更新中文😀</strong>");
    expect(saved.html).toContain('href="https://example.com/"');
    expect(saved.rtf).toContain("\\b1");
    expect(saved.rtf).toContain("\\red255\\green0\\blue0;");
    expect(saved.rtf).toContain("HYPERLINK");
    expect(saved.rtf).not.toContain("原文");
});

test("keeps the draft and editor open when saving is rejected", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openEditor(page, false, true);
    const field = page.getByRole("textbox", { name: "文字内容" });
    await field.fill("duplicate draft");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("相同内容已存在");
    await expect(field).toHaveValue("duplicate draft");
    expect((await state(page)).hidden).toBe(0);
});

test("sanitizes pasted rich content and keeps it in native undo history", async ({ page }) => {
    await openEditor(page, true);
    const field = page.getByRole("textbox", { name: "文字内容" });
    await field.focus();
    await field.press("Control+End");
    await field.evaluate(element => {
        const data = new DataTransfer();
        data.setData("text/html", '<b onclick="alert(1)">safe paste</b><script>window.compromised=true</script><img src="https://example.com/tracker">');
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(field).toContainText("safe paste");
    expect(await field.innerHTML()).not.toMatch(/script|onclick|tracker/);
    await field.press("Control+z");
    await expect(field).not.toContainText("safe paste");
});

test("F2 and the context menu open the same selected record", async ({ page }) => {
    await openEditor(page, false, false, true);
    const card = page.locator('[data-results-active="true"] [data-hash="original"][class*="clipboard-card"]');
    await expect(card).toBeVisible();
    await page.evaluate(() => (window as Probe).__editorProbe.emit("window-show"));
    await expect.poll(() => page.evaluate(() => (window as Probe).__editorProbe.searches)).toBeGreaterThan(1);
    await card.focus();
    await page.keyboard.press("F2");
    await expect.poll(async () => (await state(page)).opened).toEqual(["original"]);
    await card.click({ button: "right" });
    const edit = page.getByRole("menuitem", { name: "编辑文字", exact: true });
    await expect(edit).not.toContainText("F2");
    await edit.click();
    expect((await state(page)).opened).toEqual(["original", "original"]);
});
