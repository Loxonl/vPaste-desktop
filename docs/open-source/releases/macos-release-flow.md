# macOS Release Flow

Official releases provide separate Apple silicon (`aarch64`) and Intel (`x86_64`) packages. Both target macOS 11 Big Sur or newer.

## Local package

Run on macOS:

```bash
npm ci
npm run build:macos
```

The local configuration uses ad-hoc identity `-` and disables updater artifacts. It is suitable for development smoke tests only; downloads will not have Developer ID trust or notarization.

## Official packages

Pushing a matching `v<version>` tag starts both macOS matrix jobs. Each job:

1. Installs the pinned Rust target and npm lockfile.
2. Imports a `Developer ID Application` certificate into an ephemeral keychain.
3. Writes the App Store Connect API key to an ephemeral runner file.
4. Builds a DMG and Tauri updater archive for one architecture.
5. Signs the app, submits it for notarization, and staples the notarization result.
6. Verifies the bundle with `codesign` and Gatekeeper `spctl`.
7. Creates updater signatures, checksums, and build provenance.
8. Removes the temporary keychain and key files even if the build fails.

## Expected assets

For both `aarch64` and `x86_64`:

- Signed and notarized `.dmg`
- `.app.tar.gz` updater package
- Matching `.app.tar.gz.sig`

The shared Release also contains `latest.json`, `SHA256SUMS.txt`, `THIRD_PARTY_LICENSES.json`, `SBOM.cdx.json`, `LICENSE`, and GitHub-generated source archives.

Do not publish a package that requires users to remove quarantine or bypass Gatekeeper. Those commands are only useful when testing a package built locally from trusted source.
