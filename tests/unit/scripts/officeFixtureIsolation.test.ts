import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Office fixture Release isolation", () => {
    it("accepts production assets and rejects fixture text or image data", () => {
        const directory = mkdtempSync(join(tmpdir(), "vpaste-office-isolation-"));
        try {
            const dist = join(directory, "dist");
            const binary = join(directory, "app.bin");
            mkdirSync(dist);
            writeFileSync(join(dist, "app.js"), "console.log('production');");
            writeFileSync(binary, "MZ synthetic executable stand-in");
            const run = () => spawnSync(process.execPath, [
                resolve("scripts/check-office-release-isolation.mjs"),
                "--dist", dist, "--binary", binary,
            ], { encoding: "utf8", windowsHide: true });
            expect(run().status).toBe(0);
            writeFileSync(join(dist, "app.js"), "VPASTE_SYNTHETIC_OFFICE_V1");
            expect(run().status).not.toBe(0);
            writeFileSync(join(dist, "app.js"), "production");
            writeFileSync(binary, readFileSync(resolve("tests/fixtures/office/large-picture.png")));
            expect(run().status).not.toBe(0);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
