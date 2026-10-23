import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = process.argv[2] ?? "logic";
const cargo = (filter) => ["cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "vPaste", filter]];
const profiles = {
    logic: [
        [process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/unit/debug/officeCases.test.ts", "tests/unit/debug/officeCatalog.test.ts", "tests/unit/clipboard/richPreview.test.ts"]],
        cargo("clipboard::"),
        cargo("paste_queue::tests::"),
        cargo("test_room::tests::office_catalog_history_roundtrip"),
        cargo("office_test_fixtures::tests::"),
    ],
    ui: [[process.execPath, ["node_modules/@playwright/test/cli.js", "test", "tests/visual/clipboard-rich-contrast.spec.ts", "tests/visual/window-shells.spec.ts", "--grep", "office pictures|test room shows grouped cases"]]],
};
if (!(profile in profiles)) throw new Error("Use logic or ui.");
const logs = mkdtempSync(join(tmpdir(), "vpaste-office-checks-"));
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
if (commit.status !== 0) throw new Error("Cannot identify the tested revision.");
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true });
if (dirty.status !== 0) throw new Error("Cannot inspect the tested working tree.");
const report = {
    profile, platform: process.platform, node: process.version,
    commit: commit.stdout.trim(), dirty: Boolean(dirty.stdout.trim()),
    catalogSha256: createHash("sha256").update(readFileSync(join(root, "tests/fixtures/office/catalog.json"))).digest("hex"),
    results: [],
};
for (const [index, [command, args]] of profiles[profile].entries()) {
    const log = join(logs, `${index + 1}.log`);
    const output = openSync(log, "w");
    const start = performance.now();
    let result;
    try {
        result = spawnSync(command, args, { cwd: root, stdio: ["ignore", output, output], windowsHide: true });
    } finally {
        closeSync(output);
    }
    const summary = { command: [command, ...args], exitCode: result.status ?? 1, seconds: Number(((performance.now() - start) / 1000).toFixed(2)), log };
    report.results.push(summary);
    writeFileSync(join(logs, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(summary));
    if (result.status !== 0) {
        if (result.error) console.error(result.error.message);
        console.error(readFileSync(log, "utf8").split(/\r?\n/).slice(-35).join("\n"));
        process.exit(result.status ?? 1);
    }
}
console.log(`Office ${profile} checks passed. Evidence: ${join(logs, "result.json")}`);
