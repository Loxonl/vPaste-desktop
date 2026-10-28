import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
};
const binary = path.resolve(option('--binary', 'src-tauri/target/target/debug/vPaste'));
const output = path.resolve(option('--output', '.superpowers/sdd/2026-10-29-main-window-memory/artifacts/baseline'));
const runs = Number(option('--runs', '3'));
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('--runs must be between 1 and 5');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
const commit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd:repo, encoding:'utf8'}).stdout.trim();
await mkdir(output, {recursive:true});

async function markedDirectory() {
    const root = await mkdtemp(path.join(temporaryRoot, 'vpaste-memory-'));
    await writeFile(path.join(root, '.vpaste-memory-profile'), 'vpaste-memory-v1\n');
    return root;
}
async function launch(root, prepare) {
    const log = [];
    const child = spawn(binary, ['--dev-mode', '--memory-profile-dir', root, ...(prepare ? ['--memory-profile-prepare'] : [])], {cwd:repo});
    child.stdout.on('data', data => log.push(data));
    child.stderr.on('data', data => log.push(data));
    const timeout = setTimeout(() => child.kill('SIGTERM'), prepare ? 90000 : 360000);
    const progress = setInterval(async () => {
        try {
            const lines = (await readFile(path.join(root, 'samples.jsonl'), 'utf8')).trim().split('\n');
            const last = JSON.parse(lines.at(-1));
            const main = last.sample.processes.filter(process => process.windowLabels.includes('clipboard'));
            const mib = main.reduce((sum, process) => sum + (process.accountedBytes || 0), 0) / 1024 ** 2;
            console.log(`${path.basename(root)} ${last.phase}: ${last.loadedCount} records, ${last.domCount} DOM cards, ${mib.toFixed(1)} MiB main renderer`);
        } catch { console.log(`${path.basename(root)}: preparing real main window`); }
    }, 30000);
    try {
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
        });
        await writeFile(path.join(root, 'process.log'), Buffer.concat(log));
        if (code !== 0) throw new Error(`profile process exited ${code}; see ${root}/process.log`);
    } finally { clearTimeout(timeout); clearInterval(progress); }
}

const fixture = option('--fixture', null) || await markedDirectory();
if (!option('--fixture', null)) await launch(fixture, true);
const fixtureBytes = await readFile(path.join(fixture, 'fixture.json'));
const fixtureHash = createHash('sha256').update(fixtureBytes).update(await readFile(path.join(fixture, 'vpaste.db'))).digest('hex');
const manifest = {commit, buildMode:'dev', fixture, fixtureHash, binary, runs, startedAt:new Date().toISOString(), scenarios:['s1','s2-active','s2-settled','s3-hidden'], inspectorOpen:false, forcedGc:false};
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const summaries = [];
const percentile = values => {
    const sorted = [...values].sort((a,b) => a-b);
    return sorted[Math.ceil(sorted.length * .95) - 1];
};
for (let run = 1; run <= runs; run += 1) {
    const root = await markedDirectory();
    await cp(fixture, root, {recursive:true, preserveTimestamps:true});
    await launch(root, false);
    const text = await readFile(path.join(root, 'samples.jsonl'), 'utf8');
    await writeFile(path.join(output, `run-${run}.jsonl`), text);
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    if (rows.at(-1)?.phase !== 'complete' || rows.some(row => row.error || row.misses || row.sample.partial)) {
        throw new Error(`incomplete/partial/missed profile run ${run}; see ${root}`);
    }
    if (rows.filter(row => row.phase === 's1' || row.phase.startsWith('s2-')).some(row =>
        !row.sample.windows.some(window => window.label === 'clipboard' && window.visible))) {
        throw new Error(`hidden window in a visible interval for run ${run}`);
    }
    const phases = {};
    for (const phase of manifest.scenarios) {
        const selected = rows.filter(row => row.phase === phase);
        if (selected.length < 5) throw new Error(`too few samples for ${phase}`);
        const values = selected.map(row => row.sample.processes.filter(process => process.windowLabels.includes('clipboard')).reduce((sum, process) => sum + process.accountedBytes, 0));
        phases[phase] = {p95Bytes:percentile(values), samples:values.length, totalP95Bytes:percentile(selected.map(row => row.sample.totalAccountedBytes)), maxDomCards:Math.max(...selected.map(row => row.domCount))};
    }
    summaries.push({run, root, phases, peaks:rows.at(-1).osLifetimePeaks, viewportWidth:rows[0].viewportWidth, dpr:rows[0].dpr});
    await writeFile(path.join(output, 'summary.json'), JSON.stringify({manifest, runs:summaries}, null, 2));
    console.log(`run ${run}/${runs} finished: ${JSON.stringify(phases)}`);
    const pids = rows.at(-1).sample.processes.filter(process => process.kind === 'renderer').map(process => process.pid);
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const alive = pids.some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
        if (!alive) break;
        if (attempt === 59) throw new Error('old renderer has not exited; refusing to mix process lifetimes');
        await sleep(500);
    }
}
console.log(`Memory profile evidence: ${output}`);
