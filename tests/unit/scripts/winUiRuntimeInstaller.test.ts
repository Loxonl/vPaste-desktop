import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("WinUI offline runtime installation", () => {
    for (const scenario of ["missing", "corrupt", "identity", "valid", "installed", "what-if"]) {
        it(`validates the whole bundle before installing (${scenario})`, () => {
            const result = spawnSync("powershell.exe", [
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                "tests/windows/winui-runtime-installer.ps1", "-Scenario", scenario,
            ], { encoding: "utf8", timeout: 20_000 });
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain('"passed":true');
        });
    }
});
