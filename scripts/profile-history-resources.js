// Isolated Debug diagnostic: real Rust resources, DOM decoding and synchronous drag MIME.
(() => {
    if (window.top !== window || window.__vpasteMemoryProfileRunning) return;
    window.__vpasteMemoryProfileRunning = true;
    const started = performance.now();
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
    const active = () => document.querySelector('[data-results-active="true"]');
    const container = () => active()?.closest('[class*="cards-container"]');
    const record = (phase, diagnostics, error = null) => invoke('memory_profile_record', { metrics: {
        phase, diagnostics, error, elapsedMs: performance.now() - started,
        domCount: active()?.querySelectorAll('[data-hash]').length || 0,
        imageCount: active()?.querySelectorAll('img').length || 0,
        loadedCount: Number(container()?.dataset.historyCount || 0),
        scrollLeft: container()?.scrollLeft || 0, viewportWidth: container()?.clientWidth || innerWidth,
        dpr: devicePixelRatio, svgModuleCount: 0, misses: 0,
    } });
    const run = async () => {
        await invoke('show_main_panel');
        const deadline = performance.now() + 30000;
        let card;
        while (performance.now() < deadline) {
            card = active()?.querySelector('[data-hash]');
            const images = [...(card?.querySelectorAll('[class*="card-preview-rich"] img') || [])];
            if (images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)) break;
            await pause(100);
        }
        const images = [...(card?.querySelectorAll('[class*="card-preview-rich"] img') || [])];
        if (images.length !== 2 || images.some(image => !image.complete || !image.naturalWidth || /^(?:data:|blob:)/i.test(image.getAttribute('src') || ''))) {
            throw new Error('rich file images did not decode: ' + images.length);
        }
        const hash = card.dataset.hash;
        const render = await invoke('read_history_rich_render', { hash });
        if (/(?:data:image|base64,|blob:)/i.test(render.html) || render.resources.length !== 1) {
            throw new Error('rich render still contains inline bytes or failed deduplication');
        }
        const history = JSON.parse(container().dataset.historyMemory);
        const response = await invoke('read_history_card_payloads', { viewId: history.viewId, revision: history.revision, hashes: [hash] });
        const mime = response.cards[0].item.richHtml;
        if (!mime.includes('data:image/') || mime.includes('vpaste-rich-image:')) throw new Error('original synchronous drag MIME was lost');
        await record('complete', { history, resources: {
            richImages: images.length, decoded: images.filter(image => image.complete && image.naturalWidth > 0).length,
            uniqueFiles: render.resources.length, inlineDisplayBytes: 0, displayHtmlBytes: new TextEncoder().encode(render.html).length,
            dragMimeBytes: new TextEncoder().encode(mime).length,
        } });
    };
    window.addEventListener('DOMContentLoaded', () => {
        run().catch(error => record('error', {}, String(error)).catch(() => {}));
    }, { once: true });
})();
