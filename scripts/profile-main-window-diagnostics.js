// Separate diagnostic run. These measurements never enter before/after acceptance.
(() => {
    if (window.top !== window) return;
    window.__vpasteMemoryProfileDiagnostics = true;
    performance.setResourceTimingBufferSize(10000);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
    const results = () => document.querySelector('[data-results-active="true"]');
    const record = async phase => {
        const target = results()?.closest('[class*="cards-container"]');
        const png = phase.startsWith('snapshot-') ? await invoke('capture_native_drag_preview', {rect:{x:600,y:0,width:256,height:256,cornerRadius:0}}) : undefined;
        await invoke('memory_profile_record', {metrics: {
            phase, elapsedMs: performance.now(), domCount: results()?.querySelectorAll('[data-hash]').length || 0,
            imageCount: results()?.querySelectorAll('img').length || 0,
            loadedCount: Number(target?.dataset.historyCount || 0), scrollLeft: target?.scrollLeft || 0,
            viewportWidth: target?.clientWidth || innerWidth, dpr: devicePixelRatio,
            svgModuleCount: 0, misses: 0, error: null,
            diagnostics: {
                nodes: document.querySelectorAll('*').length,
                height: innerHeight,
                images: [...(results()?.querySelectorAll('img') || [])].map(image => ({src:image.currentSrc,loaded:image.complete&&image.naturalWidth>0})),
                png,
                styles: phase === 'diagnostic-layers' ? [...document.querySelectorAll('*')].flatMap(element => {
                    const style = getComputedStyle(element);
                    const animations = element.getAnimations().map(animation => ({state:animation.playState, currentTime:animation.currentTime}));
                    const card = element.hasAttribute('data-card-hash') || element.className?.includes?.('clipboard-card');
                    if (!card && style.willChange === 'auto' && style.transform === 'none' && style.translate === 'none' && style.scale === 'none' && style.rotate === 'none' && style.backdropFilter === 'none' && !animations.length) return [];
                    const rect = element.getBoundingClientRect();
                    return [{tag:element.tagName, classes:element.className?.baseVal ?? element.className, inline:element.getAttribute('style'),width:rect.width,height:rect.height,willChange:style.willChange,transform:style.transform,translate:style.translate,scale:style.scale,rotate:style.rotate,position:style.position,zIndex:style.zIndex,opacity:style.opacity,backdrop:style.backdropFilter,contain:style.contain,animations}];
                }) : undefined,
                resources: phase === 'diagnostic-original' ? performance.getEntriesByType('resource').map(entry => ({name:entry.name, bytes:entry.decodedBodySize})) : undefined,
            },
        }});
    };
    window.addEventListener('DOMContentLoaded', () => void (async () => {
        while (!results()?.querySelector('[data-hash]')) await sleep(100);
        await invoke('show_main_panel');
        await sleep(15000);
        if (window.__vpasteMemoryProfileLayers) {
            await record('diagnostic-layers');
            await record('complete');
            return;
        }
        await record('diagnostic-original');
        if (window.__vpasteMemoryProfileTrimCache) {
            await invoke('memory_profile_trim_cache');
            await sleep(15000);
            await record('diagnostic-cache-pruned');
        }
        await record('snapshot-original');
        const surface = document.querySelector('[class*="clipboard-container"]');
        surface.style.backdropFilter = 'none';
        surface.style.webkitBackdropFilter = 'none';
        await sleep(15000);
        await record('diagnostic-no-backdrop');
        await record('snapshot-no-backdrop');
        for (const image of results().querySelectorAll('img')) image.removeAttribute('src');
        await sleep(15000);
        await record('diagnostic-no-images');
        window.__vpasteMemoryProfileUnmount();
        await sleep(15000);
        await record('diagnostic-unmounted');
        await record('complete');
    })().catch(console.error), {once:true});
})();
