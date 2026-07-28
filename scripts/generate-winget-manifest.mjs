#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [version, installer, installerUrl, output] = process.argv.slice(2);
if (!version || !installer || !installerUrl || !output) {
  throw new Error("Usage: generate-winget-manifest.mjs <version> <installer> <installer-url> <output>");
}
if (!fs.existsSync(installer)) throw new Error(`Installer not found: ${installer}`);

const sha256 = createHash("sha256").update(fs.readFileSync(installer)).digest("hex").toUpperCase();
const manifest = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.singleton.1.10.0.schema.json
# Submit this generated manifest manually after the GitHub Release is public.
PackageIdentifier: Loxonl.vPaste
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Loxonl
PublisherUrl: https://vpaste.app
PublisherSupportUrl: https://github.com/Loxonl/vPaste-desktop/issues
PackageName: vPaste
PackageUrl: https://github.com/Loxonl/vPaste-desktop
License: GPL-3.0-only
LicenseUrl: https://github.com/Loxonl/vPaste-desktop/blob/v${version}/LICENSE
ShortDescription: Local-first clipboard manager for Windows and macOS
Tags:
- clipboard
- productivity
InstallerType: inno
Scope: user
UpgradeBehavior: install
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
- Architecture: x64
  InstallerUrl: ${installerUrl}
  InstallerSha256: ${sha256}
ManifestType: singleton
ManifestVersion: 1.10.0
`;

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, manifest, "utf8");
console.log(`WinGet manifest written to ${output}`);
