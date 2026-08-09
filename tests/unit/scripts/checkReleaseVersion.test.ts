import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];
const temporaryRoots: string[] = [];

const createVersionFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "vpaste-release-version-"));
  temporaryRoots.push(root);
  for (const relativePath of versionFiles) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, relativePath), destination);
  }
  return root;
};

const runCheck = (root: string, tag: string) =>
  spawnSync(process.execPath, [join(repositoryRoot, "scripts/check-release-version.mjs"), tag], {
    cwd: root,
    encoding: "utf8",
  });

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release version preparation", () => {
  it("writes an RC tag version to every application version source", () => {
    const root = createVersionFixture();
    const setResult = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts/set-release-version.mjs"), "1.6.0-rc.2", "--root", root],
      { encoding: "utf8" },
    );

    expect(setResult.status, setResult.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("1.6.0-rc.2");
    const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    expect(packageLock.version).toBe("1.6.0-rc.2");
    expect(packageLock.packages[""].version).toBe("1.6.0-rc.2");
    expect(JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version).toBe(
      "1.6.0-rc.2",
    );
    expect(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8")).toMatch(
      /^version = "1\.6\.0-rc\.2"$/m,
    );
    expect(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8")).toMatch(
      /name = "vpaste-desktop"\nversion = "1\.6\.0-rc\.2"/,
    );

    const checkResult = runCheck(root, "v1.6.0-rc.2");
    expect(checkResult.status, checkResult.stderr).toBe(0);
  });

  it.each(["1.6", "v1.6.0", "1.6.0-beta.2"])("rejects unsupported release version %s", version => {
    const root = createVersionFixture();
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts/set-release-version.mjs"), version, "--root", root],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported release version");
  });

  it("rejects inconsistent source versions before writing any release version", () => {
    const root = createVersionFixture();
    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJson.version = "1.6.1";
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts/set-release-version.mjs"), "1.6.0-rc.2", "--root", root],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Version mismatch before release preparation");
    expect(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).version).toBe("1.6.0");
  });

  it("keeps tag validation strict before the version sources are prepared", () => {
    const root = createVersionFixture();
    const result = runCheck(root, "v1.6.0-rc.2");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match application version v1.6.0");
  });
});
