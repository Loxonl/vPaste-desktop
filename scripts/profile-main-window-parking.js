// Isolated Debug diagnostic for the actual native collapse/toggle path.
(() => {
    if (window.top !== window || window.__vpasteMemoryProfileRunning) return;
    window.__vpasteMemoryProfileRunning = true;
    const started = performance.now();
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
    const state = (toggle = false) => invoke('memory_profile_parking_state', { toggle });
    const results = () => document.querySelector('[data-results-active="true"]');
    const cards = () => [...(results()?.querySelectorAll('[data-hash]') || [])];
    const container = () => results()?.closest('[class*="cards-container"]');
    const phase = () => document.querySelector('[class*="clipboard-container"]')?.className || '';
    const history = () => JSON.parse(container()?.dataset.historyMemory || '{}');
    const record = (diagnostics, error = null) => invoke('memory_profile_record', { metrics: {
        phase: error ? 'error' : 'complete', diagnostics, error, elapsedMs: performance.now() - started,
        domCount: cards().length, imageCount: results()?.querySelectorAll('img').length || 0,
        loadedCount: Number(container()?.dataset.historyCount || 0), scrollLeft: container()?.scrollLeft || 0,
        viewportWidth: container()?.clientWidth || innerWidth, dpr: devicePixelRatio, svgModuleCount: 0, misses: 0,
    } });
    const until = async predicate => {
        const deadline = performance.now() + 20000;
        while (performance.now() < deadline) {
            if (await predicate()) return;
            await pause(80);
        }
        throw new Error('parking diagnostic timed out: ' + phase());
    };
    const run = async () => {
        await invoke('show_main_panel');
        await until(() => cards().length > 0 && /entered/.test(phase()));
        await pause(700);
        const rounds = [];
        for (let index = 0; index < 2; index += 1) {
            const before = cards();
            const token = history().viewId;
            await state(true);
            await until(async () => {
                const current = await state();
                return !current.presented && !current.hiding && /parked/.test(phase());
            });
            const parked = await state();
            const retained = before.every(node => node.isConnected);
            if (!parked.nativeVisible || !parked.outsideDisplays || !retained || history().viewId !== token) {
                throw new Error('parking did not retain the native window and bounded DOM: ' + JSON.stringify({ parked, retained, history: history() }));
            }
            const parkedCards = cards().length;
            await state(true);
            await until(async () => (await state()).presented && /entered/.test(phase()) && cards().length > 0);
            const reopened = await state();
            if (!reopened.nativeVisible || reopened.outsideDisplays || !before.every(node => node.isConnected)) {
                throw new Error('reopen failed to reuse card DOM: ' + JSON.stringify(reopened));
            }
            rounds.push({ parked, reopened, parkedCards, domRetained: true, history: history() });
        }
        await state(true);
        await pause(25);
        const interrupted = await state();
        await state(true);
        await until(async () => (await state()).presented && /entered/.test(phase()));
        await pause(200);
        const final = await state();
        if (!final.presented || final.hiding || final.outsideDisplays) throw new Error('stale collapse won after reopening');
        await record({ parking: { rounds, interruptedDuringHide: interrupted.hiding, final } });
    };
    window.addEventListener('DOMContentLoaded', () => {
        run().catch(error => record({}, String(error)).catch(() => {}));
    }, { once: true });
})();
