// Injected only by the isolated Debug profile startup, into the real WKWebView.
(() => {
    if (window.top !== window || window.__vpasteMemoryProfileRunning) return;
    window.__vpasteMemoryProfileRunning = true;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const started = performance.now();
    let misses = 0;
    const results = () => document.querySelector('[data-results-active="true"]');
    const cards = () => [...(results()?.querySelectorAll('[data-hash]') || [])];
    const container = () => results()?.closest('[class*="cards-container"]');
    const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
    const record = async (phase, error = null) => {
        const list = cards();
        const target = container();
        await invoke('memory_profile_record', {metrics: {
            phase, elapsedMs: performance.now() - started,
            domCount: list.length, imageCount: results()?.querySelectorAll('img').length || 0,
            loadedCount: Number(target?.dataset.historyCount || list.length),
            scrollLeft: target?.scrollLeft || 0, viewportWidth: target?.clientWidth || innerWidth,
            dpr: devicePixelRatio, svgModuleCount: performance.getEntriesByType('resource').filter(entry => /material-icon-theme\/icons\/.*\?.*(?:import|no-inline)/.test(entry.name)).length,
            misses, error,
        }});
    };
    const sampleFor = async (phase, seconds) => {
        for (let index = 0; index < seconds; index += 1) {
            await record(phase);
            await sleep(1000);
        }
    };
    const run = async () => {
        const deadline = performance.now() + 90000;
        const loaded = () => Number(container()?.dataset.historyCount || cards().length);
        while (loaded() < 36 && performance.now() < deadline) await sleep(100);
        if (loaded() < 36) throw new Error('real main window did not load its first 36 records');
        await invoke('show_main_panel');
        await sleep(30000);
        await sampleFor('s1', 30);
        const target = container();
        const stride = target.clientWidth - 48;
        let desired = 0;
        let direction = 1;
        let previousCount = cards().length;
        let stalled = 0;
        let tick = 0;
        const browseDeadline = performance.now() + 180000;
        while (performance.now() < browseDeadline) {
            const frameStart = performance.now();
            desired = Math.max(0, desired + stride * direction);
            target.scrollTo({left: desired, behavior: 'instant'});
            target.dispatchEvent(new Event('scroll', {bubbles:true}));
            if (tick % 2 === 0) await record('s2-active');
            const count = Number(target.dataset.historyCount || cards().length);
            const end = target.scrollWidth - target.clientWidth;
            if (direction > 0 && desired >= end && count >= 500) direction = -1;
            if (direction > 0 && desired > end && count === previousCount) {
                stalled += 1;
                desired = Math.min(desired, end);
                if (stalled > 8) misses += 1;
                if (stalled > 20) throw new Error(`pagination stalled at ${count}`);
            } else stalled = 0;
            previousCount = count;
            tick += 1;
            if (direction < 0 && desired === 0) break;
            await sleep(Math.max(0, 500 - (performance.now() - frameStart)));
        }
        if (direction !== -1 || target.scrollLeft > 2) throw new Error('500-record browse trace did not complete');
        await sampleFor('s2-settled', 30);
        const generation = await invoke('begin_hide_clipboard_window');
        await invoke('finish_hide_clipboard_window', {generation});
        await sampleFor('s3-hidden', 60);
        await invoke('show_main_panel');
        await sleep(2000);
        await record('complete');
    };
    window.addEventListener('DOMContentLoaded', () => {
        run().catch(async error => {
            try { await record('error', String(error)); }
            catch (failure) { console.error('memory profile failed', error, failure); }
        });
    }, {once:true});
})();
