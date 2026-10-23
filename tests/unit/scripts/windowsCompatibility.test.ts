import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = readFileSync("installer/windows/vpaste.iss", "utf8");
const temporaryDirectories: string[] = [];

function minimumVersion() {
  const match = installer.match(/^MinVersion=(\d+(?:\.\d+)+)\s*$/m);
  expect(match, "The native Setup gate must define the Windows version floor").not.toBeNull();
  return match![1].split(".").map(Number);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows installation compatibility policy (not guest OS smoke tests)", () => {
  it("uses the WebView2 Windows 10 1709 floor for interactive and silent setup", () => {
    expect(minimumVersion()).toEqual([10, 0, 16299]);
  });

  it("does not separately reject 21H2 on the welcome page (#257)", () => {
    expect(/WindowsVersion\.Build\s*</.test(installer)).toBe(false);
    expect(installer.includes("vPaste supports Windows 10 22H2 and Windows 11")).toBe(false);
  });

  it.each([
    ["Windows 7", [6, 1, 7601], false],
    ["Windows 8.1", [6, 3, 9600], false],
    ["Windows 10 1507", [10, 0, 10240], false],
    ["Windows 10 1607", [10, 0, 14393], false],
    ["Windows 10 1703", [10, 0, 15063], false],
    ["immediately below the minimum build", [10, 0, 16298], false],
    ["Windows 10 1709", [10, 0, 16299], true],
    ["Windows 10 1809 / LTSC 2019", [10, 0, 17763], true],
    ["Windows 10 2004", [10, 0, 19041], true],
    ["Windows 10 20H2", [10, 0, 19042], true],
    ["Windows 10 21H1", [10, 0, 19043], true],
    ["Windows 10 21H2 / LTSC 2021 (#257)", [10, 0, 19044], true],
    ["Windows 10 22H2", [10, 0, 19045], true],
    ["Windows 11 21H2", [10, 0, 22000], true],
    ["Windows 11 24H2", [10, 0, 26100], true],
  ])("evaluates the declared version floor for %s", (_label, version, accepted) => {
    const minimum = minimumVersion();
    const firstDifference = version.findIndex((part, index) => part !== (minimum[index] ?? 0));
    expect(firstDifference < 0 || version[firstDifference] > (minimum[firstDifference] ?? 0)).toBe(accepted);
  });

  it("retains x64 packaging and the existing WebView2 installation requirement", () => {
    expect(installer).toMatch(/^ArchitecturesAllowed=x64compatible$/m);
    expect(installer).toMatch(/^ArchitecturesInstallIn64BitMode=x64compatible$/m);
    expect(installer).toContain("Result := EnsureWebView2;");
  });

  it("generates a WinGet manifest with the same Windows version floor", () => {
    const directory = mkdtempSync(join(tmpdir(), "vpaste-windows-compatibility-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "fixture.exe");
    const output = join(directory, "Loxonl.vPaste.yaml");
    writeFileSync(binary, "synthetic installer fixture");
    execFileSync(process.execPath, [
      "scripts/generate-winget-manifest.mjs", "1.6.0", binary,
      "https://example.com/vPaste_setup.exe", output,
    ], { stdio: "pipe" });

    const manifest = readFileSync(output, "utf8");
    expect(manifest).toContain(`MinimumOSVersion: ${minimumVersion().join(".")}.0\n`);
    expect(manifest).toContain("InstallerType: inno\n");
    expect(manifest).toContain("- Architecture: x64\n");
  });
});
