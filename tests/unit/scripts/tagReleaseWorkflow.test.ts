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
  it("builds only after a release is published and attaches to that release", () => {
    expect(releaseWorkflow).toMatch(/^on:\n  release:\n    types: \[published\]/m);
    expect(releaseWorkflow).not.toMatch(/^  push:/m);
    expect(releaseWorkflow).toContain("scripts/upload-published-release-assets.sh");
    expect(releaseWorkflow).not.toContain("gh release create");
    expect(releaseWorkflow).not.toContain("gh release edit");
  });

  it.each([
    ".github/workflows/tag-release.yml",
    ".github/workflows/tag-build-windows.yml",
    ".github/workflows/tag-build-macos.yml",
  ])("does not save tag-scoped caches that later releases cannot restore in %s", path => {
    const contents = readFileSync(path, "utf8");
    expect(contents).not.toContain("actions/cache");
    expect(contents).not.toMatch(/^\s+cache: npm$/m);
  });

  it("publishes the channel updater manifest for every published release after asset verification", () => {
    const publishStep = releaseWorkflow.indexOf("- name: Publish website updater manifest");
    expect(publishStep).toBeGreaterThan(releaseWorkflow.indexOf("- name: Verify release assets referenced by manifest"));
    expect(publishStep).toBeGreaterThan(releaseWorkflow.indexOf("scripts/upload-published-release-assets.sh"));
    const step = releaseWorkflow.slice(publishStep, releaseWorkflow.indexOf("- name:", publishStep + 1));
    expect(step).not.toContain("if:");
    expect(step).toContain("UPDATE_CHANNEL: ${{ needs.validate.outputs.channel }}");
    expect(step).toContain('--public-url "https://vpaste.app/download/${UPDATE_CHANNEL}/latest.json"');
    expect(step).toContain("VPASTE_WEBSITE_RELEASE_TOKEN: ${{ secrets.VPASTE_WEBSITE_RELEASE_TOKEN }}");
    expect(step).not.toContain("GH_TOKEN");
    expect(step).toContain("scripts/publish-updater-manifest.mjs");
    expect(releaseWorkflow.match(/secrets\.VPASTE_WEBSITE_RELEASE_TOKEN/g)).toHaveLength(1);
    expect(releaseWorkflow).not.toContain("Commit updater manifest to website");
  });

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

  it.each(workflows)("adds a download-only universal DMG beside the per-architecture packages in $path", ({ contents }) => {
    expect(contents).toContain("- target: aarch64-apple-darwin\n            arch: aarch64\n            updater-platform: darwin-aarch64");
    expect(contents).toContain("- target: x86_64-apple-darwin\n            arch: x86_64\n            updater-platform: darwin-x86_64");
    expect(contents).toContain('- target: universal-apple-darwin\n            arch: universal\n            updater-platform: ""');
    expect(contents).toContain("rustup target add aarch64-apple-darwin x86_64-apple-darwin");
    expect(contents).toContain('SKIP_UPDATER="$skip_updater"');
    expect(contents).toContain('lipo "$app/Contents/MacOS/vPaste" -verify_arch arm64 x86_64');
    const staging = contents.slice(contents.indexOf("- name: Verify and stage macOS packages"));
    expect(staging.indexOf('cp "$dmg" "$staged_dmg"')).toBeLessThan(staging.indexOf('if [[ -n "$updater_platform" ]]; then\n            staged_updater='));
    expect(staging.indexOf('if [[ -n "$updater_platform" ]]; then\n            staged_updater=')).toBeLessThan(
      staging.indexOf("scripts/generate-updater-manifest.mjs"),
    );
  });

  it("keeps the universal DMG out of the updater feed", () => {
    expect(releaseWorkflow).toContain(
      "for fragment in latest.windows.json latest.macos-aarch64.json latest.macos-x86_64.json; do",
    );
    expect(releaseWorkflow).not.toContain("latest.macos-universal.json");
    expect(releaseWorkflow.match(/--platforms windows-x86_64,darwin-aarch64,darwin-x86_64/g)).toHaveLength(3);
  });

  it("builds an unsigned universal DMG in the draft release workflow", () => {
    expect(draftReleaseWorkflow).toContain("- target: universal-apple-darwin\n            arch: universal");
    expect(draftReleaseWorkflow).toContain("rustup target add aarch64-apple-darwin x86_64-apple-darwin");
    expect(draftReleaseWorkflow).toContain(
      'lipo "$bundle/macos/vPaste.app/Contents/MacOS/vPaste" -verify_arch arm64 x86_64',
    );
  });

  it("lets signed macOS builds skip updater artifacts without the updater key", () => {
    expect(macOSReleaseScript).toContain('if [[ "${unsigned_build}" == true || "${SKIP_UPDATER}" == "1" || "${SKIP_UPDATER}" == "true" ]]; then');
    expect(macOSReleaseScript).toContain('if [[ "${skip_updater}" == false && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then');
    expect(macOSReleaseScript).toContain(`build_args+=("--config" '{"bundle":{"createUpdaterArtifacts":false}}')`);
    const skipExit = macOSReleaseScript.indexOf('if [[ "${skip_updater}" == true ]]; then\n  echo "Signed macOS package build complete."');
    expect(skipExit).toBeGreaterThan(macOSReleaseScript.indexOf('bash scripts/package-macos-dmg.sh'));
    expect(skipExit).toBeLessThan(macOSReleaseScript.indexOf('updater_artifact="$(find'));
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
