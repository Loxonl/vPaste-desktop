import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outputDirectory = resolve(process.argv[2] || "src-tauri/target/app-store-build");
const teamId = process.env.APP_STORE_TEAM_ID?.trim() || "";
const itemId = process.env.VPASTE_APP_STORE_ID?.trim() || "6824847075";
const profilePath = process.env.APP_STORE_PROFILE?.trim() || "";
const copyright = process.env.APP_STORE_COPYRIGHT?.trim() || "";
const usesNonExemptEncryption = process.env.APP_STORE_USES_NON_EXEMPT_ENCRYPTION?.trim() || "";
const bundleId = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).identifier;

if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("APP_STORE_TEAM_ID must be a ten-character Apple Team ID");
}
if (!/^[1-9][0-9]*$/.test(itemId)) {
    throw new Error("VPASTE_APP_STORE_ID must be a numeric App Store item ID");
}
if (!profilePath || !statSync(resolve(profilePath), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("APP_STORE_PROFILE must point to a provisioning profile file");
}
if (!copyright) {
    throw new Error("APP_STORE_COPYRIGHT is required for the App Store About panel");
}
if (!/^(true|false)$/.test(usesNonExemptEncryption)) {
    throw new Error("APP_STORE_USES_NON_EXEMPT_ENCRYPTION must be true or false");
}
if (typeof bundleId !== "string" || !/^[a-zA-Z0-9.-]+$/.test(bundleId)) {
    throw new Error("The Tauri bundle identifier is invalid");
}

mkdirSync(outputDirectory, { recursive: true });
const entitlementsPath = join(outputDirectory, "Entitlements.plist");
const embeddedProfilePath = join(outputDirectory, "embedded.provisionprofile");
const infoPlistPath = join(outputDirectory, "Info.plist");
const configPath = join(outputDirectory, "tauri.appstore.conf.json");
const storeManifestPath = join(outputDirectory, "Cargo.appstore.toml");
const directManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
const privateApiFeature = '"macos-private-api", ';
if (!directManifest.includes(privateApiFeature)) {
    throw new Error("The direct build must retain the macos-private-api feature");
}
writeFileSync(storeManifestPath, directManifest.replace(privateApiFeature, ""));
const escapeXml = value => value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[character]);
copyFileSync(resolve(profilePath), embeddedProfilePath);
writeFileSync(entitlementsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.application-identifier</key><string>${teamId}.${bundleId}</string>
  <key>com.apple.developer.team-identifier</key><string>${teamId}</string>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.files.user-selected.read-write</key><true/>
</dict>
</plist>
`);
writeFileSync(infoPlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>${escapeXml(copyright)}</string>
  <key>ITSAppUsesNonExemptEncryption</key><${usesNonExemptEncryption}/>
</dict>
</plist>
`);
const config = {
    bundle: {
        category: "Utility",
        createUpdaterArtifacts: false,
        macOS: {
            minimumSystemVersion: "13.0",
            entitlements: entitlementsPath,
            infoPlist: infoPlistPath,
            files: {
                "embedded.provisionprofile": embeddedProfilePath,
            },
        },
    },
    app: { macOSPrivateApi: false },
    plugins: { updater: null },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(`${configPath}\n`);
