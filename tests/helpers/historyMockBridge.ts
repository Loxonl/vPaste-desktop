/** Browser interaction fixtures keep their legacy fake backend; this adapts its IPC contract.
 * Never imported by the product or the real-WebKit memory profiler. */
export function installHistoryMockBridge() {
    type Row = Record<string, any>;
    type Args = Record<string, any>;
    type Invoke = (command: string, args?: Args) => Promise<any>;
    type Internals = { invoke: Invoke; convertFileSrc?: (path: string, protocol?: string) => string };
    const target = window as unknown as { __TAURI_INTERNALS__?: Internals };
    const installed = new WeakSet<object>();
    const install = (internals?: Internals) => {
        if (!internals || installed.has(internals)) return;
        installed.add(internals);
        const rows = new Map<string, Row>();
        const images = new Map<string, string>();
        const convert = internals.convertFileSrc;
        internals.convertFileSrc = (path, protocol) => images.get(path) ?? convert?.(path, protocol) ?? path;
        const render = (row: Row) => {
            if (!row.richHtml) return null;
            const document = new DOMParser().parseFromString(`<div>${row.richHtml}</div>`, "text/html");
            const resources: Array<{ token: string; assetPath: string; revision: string }> = [];
            document.querySelectorAll("img[src]").forEach((image, index) => {
                const src = image.getAttribute("src")!;
                if (!src.startsWith("data:image/")) return;
                const token = `vpaste-rich-image:fixture-${row.hash}-${index}`;
                const assetPath = `history-fixture:${row.hash}-${index}`;
                images.set(assetPath, src); image.setAttribute("src", token);
                resources.push({ token, assetPath, revision: "fixture" });
            });
            return { html: document.body.firstElementChild?.innerHTML ?? "", resources };
        };
        let serial = 0;
        let previewRevision = 0;
        const views = new Map<string, { query: Args; pages: Map<number, Row> }>();
        const wrap = (backend: Invoke): Invoke => async (command, args = {}) => {
            if (command === "open_history_view") {
                const viewId = String(++serial);
                views.set(viewId, { query: args.query, pages: new Map() });
                return page(viewId, 0);
            }
            if (command === "read_history_view_page") return page(args.viewId, args.pageIndex);
            if (command === "close_history_view") { views.delete(args.viewId); return; }
            if (command === "set_history_viewport") return;
            if (command === "read_history_card_payloads") return {
                token: { viewId: args.viewId, revision: 1 }, resourceEpoch: views.get(args.viewId)?.pages.get(0)?.resourceEpoch ?? 0,
                cards: args.hashes.map((hash: string) => rows.get(hash)).filter(Boolean).map((item: Row) => ({ item, richRender: render(item) })),
            };
            if (command === "read_history_rich_render") return render(rows.get(args.hash) ?? {});
            if (command === "history_item_action_info") {
                const row = rows.get(args.hash)!;
                const missing = row?.itemType === "File" ? await backend("validate_file_item", { content: row.content }) : [];
                return { itemType: row?.itemType, missingPaths: Array.isArray(missing) ? missing : [] };
            }
            if (command === "copy_history_record") {
                const row = rows.get(args.hash)!;
                if (row.itemType === "TextFile") return backend("copy_history_item", args);
                const plain = args.plainText && row.textContent;
                return backend("copy", { item: plain || (row.itemType === "Link" ? row.content.split("|||")[0] : row.content),
                    itemType: plain || row.itemType === "Link" || row.itemType === "Color" ? "Text" : row.itemType,
                    hash: args.plainText ? null : args.hash });
            }
            if (command === "show_history_preview") {
                const revision = ++previewRevision;
                const row = rows.get(args.hash)!;
                const textContent = row.itemType === "TextFile" ? await backend("plain_text_content", { hash: args.hash }) : row.textContent;
                if (revision !== previewRevision) return;
                const { hash: _hash, ...options } = args;
                return backend("show_preview_window", { ...options, content: row.content, previewContent: row.previewContent,
                    textContent, richHtml: row.richHtml, appSource: row.appSource });
            }
            if (command === "native_drag_history_file") {
                const row = rows.get(args.hash)!;
                const paths = row.itemType === "Image" ? [row.previewContent || row.content] : JSON.parse(row.content);
                const { hash: _hash, ...options } = args;
                return backend("native_drag_file", { ...options, paths });
            }
            if (["hide_preview_window", "dismiss_hover_preview_window"].includes(command)) previewRevision += 1;
            const result = await backend(command, args);
            if (command === "delete_clipboard_item") rows.delete(args.hash);
            return result;

            async function page(viewId: string, index: number): Promise<Row> {
                const view = views.get(viewId);
                if (!view) throw new Error("history fixture view expired");
                for (let i = 0; i <= index; i += 1) {
                    if (view.pages.has(i)) continue;
                    const previous = view.pages.get(i - 1);
                    if (previous && !previous.hasMore) break;
                    const value = await backend("search", { ...view.query, lastId: previous?.nextId ?? 0,
                        lastTime: previous?.nextTime ?? 0, limit: 36 });
                    const raw = typeof value === "string" ? JSON.parse(value) : value;
                    const stored = { ...raw, list: raw?.list ?? [] };
                    stored.list.forEach((row: Row) => rows.set(row.hash, row));
                    if (stored.list.length > 36) {
                        for (let offset = 0; offset < stored.list.length; offset += 36) {
                            const list = stored.list.slice(offset, offset + 36);
                            const last = list.at(-1);
                            view.pages.set(i + offset / 36, { ...stored, list,
                                hasMore: offset + 36 < stored.list.length || stored.hasMore,
                                nextId: last?.id ?? 0, nextTime: last?.time ?? 0 });
                        }
                    } else view.pages.set(i, stored);
                }
                const raw = view.pages.get(index);
                const knownCount = [...view.pages].reduce((count, [i, page]) => Math.max(count, i * 36 + page.list.length), 0);
                return { token: { viewId, revision: 1 }, pageIndex: index, startIndex: index * 36,
                    items: (raw?.list ?? []).map(({ content: _content, previewContent: _preview, textContent: _text, richHtml: _rich, ...ref }: Row) => ref),
                    knownCount, hasMore: Boolean(raw?.hasMore), resourceEpoch: raw?.resourceEpoch ?? 0 };
            }
        };
        let invoke = wrap(internals.invoke.bind(internals));
        Object.defineProperty(internals, "invoke", { configurable: true, get: () => invoke,
            set: (next: Invoke) => { invoke = wrap(next); } });
    };
    let value = target.__TAURI_INTERNALS__;
    install(value);
    if (Object.getOwnPropertyDescriptor(target, "__TAURI_INTERNALS__")?.configurable !== false) {
        Object.defineProperty(target, "__TAURI_INTERNALS__", { configurable: true, get: () => value,
            set: (next: Internals) => { value = next; install(next); } });
    }
}
