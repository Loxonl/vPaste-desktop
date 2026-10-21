import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "vpaste-app-store-"));
    temporaryDirectories.push(directory);
    const profile = join(directory, "store.provisionprofile");
    writeFileSync(profile, "test profile");
    const output = join(directory, "output");
    const env = {
        ...process.env,
        APP_STORE_TEAM_ID: "ABCDE12345",
        APP_STORE_PROFILE: profile,
        VPASTE_APP_STORE_ID: "1234567890",
        APP_STORE_COPYRIGHT: "Copyright 2026 Example",
        APP_STORE_USES_NON_EXEMPT_ENCRYPTION: "false",
    };
    return { output, env };
}

function prepare(output: string, env: NodeJS.ProcessEnv) {
    execFileSync(process.execPath, ["scripts/prepare-macos-app-store.mjs", output], {
        cwd: process.cwd(),
        env,
        stdio: "pipe",
    });
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

it("generates a sandboxed App Store config without direct updater assets", () => {
    const { output, env } = fixture();
    prepare(output, env);

    const config = JSON.parse(readFileSync(join(output, "tauri.appstore.conf.json"), "utf8"));
    const directConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const directManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
    const storeManifest = readFileSync(join(output, "Cargo.appstore.toml"), "utf8");
    const entitlements = readFileSync(join(output, "Entitlements.plist"), "utf8");
    const infoPlist = readFileSync(join(output, "Info.plist"), "utf8");
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.bundle.macOS.minimumSystemVersion).toBe("13.0");
    expect(config.bundle.macOS.files).not.toHaveProperty("Library/LaunchAgents/com.loxonl.vpaste.background.plist");
    expect(config.bundle.macOS.files["embedded.provisionprofile"]).toBe(join(output, "embedded.provisionprofile"));
    expect(config.app.macOSPrivateApi).toBe(false);
    expect(directConfig.app.macOSPrivateApi).toBe(true);
    expect(directManifest).toContain('"macos-private-api"');
    expect(storeManifest).not.toContain('"macos-private-api"');
    expect(entitlements).toContain("com.apple.security.app-sandbox");
    expect(entitlements).toContain("ABCDE12345.com.loxonl.vpaste");
    expect(entitlements).toContain("com.apple.security.files.user-selected.read-write");
    expect(infoPlist).toContain("NSHumanReadableCopyright");
    expect(infoPlist).toContain("<key>LSMinimumSystemVersion</key><string>13.0</string>");
    expect(infoPlist).toContain("Copyright 2026 Example");
    expect(infoPlist).toContain("ITSAppUsesNonExemptEncryption");
});

it("requires export-compliance and copyright declarations", () => {
    const { output, env } = fixture();
    expect(() => prepare(output, { ...env, APP_STORE_COPYRIGHT: "" })).toThrow();
    expect(() => prepare(output, { ...env, APP_STORE_USES_NON_EXEMPT_ENCRYPTION: "" })).toThrow();
});

it("rejects an invalid App Store item ID before packaging", () => {
    const { output, env } = fixture();
    expect(() => prepare(output, { ...env, VPASTE_APP_STORE_ID: "not-an-id" })).toThrow();
});

it("rejects a missing provisioning profile before packaging", () => {
    const { output, env } = fixture();
    expect(() => prepare(output, { ...env, APP_STORE_PROFILE: join(output, "missing.provisionprofile") })).toThrow();
});
