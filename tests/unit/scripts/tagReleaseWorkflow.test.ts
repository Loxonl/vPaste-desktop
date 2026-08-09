import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(".github/workflows/tag-release.yml", "utf8");
const draftReleaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const macOSReleaseScript = readFileSync("scripts/build-macos-release.sh", "utf8");
const windowsReleaseScript = readFileSync("scripts/build-windows-release.ps1", "utf8");
const windowsInstallerScript = readFileSync("installer/windows/vpaste.iss", "utf8");
const workflows = [".github/workflows/tag-release.yml", ".github/workflows/tag-build-macos.yml"].map(path => ({
  path,
  contents: readFileSync(path, "utf8"),
}));

describe("tag release signing workflow", () => {
  it.each(workflows)("derives the macOS signing identity in $path", ({ contents }) => {
    expect(contents).not.toContain("secrets.APPLE_SIGNING_IDENTITY");
    expect(contents).toContain('security list-keychains -d user -s "$keychain_path"');
    expect(contents).toContain('echo "APPLE_SIGNING_IDENTITY=$identity_hash"');
  });

  it.each(workflows)("verifies codesign discovery before building in $path", ({ contents }) => {
    expect(contents).toContain("Imported Developer ID identity is not discoverable");
    expect(contents).toContain("security find-identity -v -p codesigning");
  });

  it.each(workflows)("validates the notarized app ticket and signed DMG in $path", ({ contents }) => {
    expect(contents).toContain('xcrun stapler validate "$app"');
    expect(contents).toContain('codesign --verify --strict --verbose=2 "$dmg"');
    expect(contents).not.toContain('xcrun stapler validate "$dmg"');
  });

  it("keeps the updater manifest verifier out of desktop application binary targets", () => {
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--locked", "--no-deps", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml"],
        { encoding: "utf8" },
      ),
    );
    const appPackage = metadata.packages.find((item: { name: string }) => item.name === "vpaste-desktop");
    const binaryNames = appPackage.targets
      .filter((target: { kind: string[] }) => target.kind.includes("bin"))
      .map((target: { name: string }) => target.name);

    expect(binaryNames).toEqual(["vPaste"]);
    expect(releaseWorkflow).toContain("tools/verify-updater-manifest/Cargo.toml");
  });

  it("checks the independent verifier in the draft release validation job", () => {
    expect(draftReleaseWorkflow).toContain(
      "cargo test --manifest-path tools/verify-updater-manifest/Cargo.toml --locked",
    );
  });

  it("keeps the updater private key in the variable consumed by Tauri builds", () => {
    expect(macOSReleaseScript).not.toContain("TAURI_SIGNING_PRIVATE_KEY_PATH");
    expect(macOSReleaseScript).not.toContain("unset TAURI_SIGNING_PRIVATE_KEY");
    expect(macOSReleaseScript).toContain('export TAURI_SIGNING_PRIVATE_KEY="$(< "${private_key_path}")"');
  });

  it("uses the numeric file version for prerelease Windows installer metadata", () => {
    expect(windowsInstallerScript).toContain("VersionInfoProductVersion={#VersionInfoVersion}");
    expect(windowsInstallerScript).not.toContain("VersionInfoProductVersion={#AppVersion}");
  });

  it("passes exactly one updater private-key source to the Windows signer", () => {
    expect(windowsReleaseScript).not.toContain("$temporaryKeyPath");
    expect(windowsReleaseScript).toContain("$env:TAURI_SIGNING_PRIVATE_KEY_PATH = $null");
    expect(windowsReleaseScript).toContain("$env:TAURI_SIGNING_PRIVATE_KEY = $null");
  });
});
