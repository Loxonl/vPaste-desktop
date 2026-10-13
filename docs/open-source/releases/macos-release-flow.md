# macOS Release Flow

Official releases provide separate Apple silicon (`aarch64`) and Intel (`x86_64`) packages, plus a download-only universal DMG that runs natively on both. All target macOS 11 Big Sur or newer.

The universal DMG is meant for website downloads. It has no updater archive and is not in `latest.json`: each slice of the universal binary reports its own architecture, so the first update moves an installed universal app onto the matching `darwin-aarch64` or `darwin-x86_64` package.

## Local package

Run on macOS:

```bash
npm ci
npm run build:macos
```

The local configuration uses ad-hoc identity `-` and disables updater artifacts. It is suitable for development smoke tests only; downloads will not have Developer ID trust or notarization. The first build installs pinned `dmgbuild` into `src-tauri/target/.macos-dmg-venv` using Python 3.10 or newer.

The installer artwork lives in `src-tauri/macos/dmg/background.svg`. Run `npm run generate:macos-dmg-background` after editing it to refresh the 1× and 2× PNG files. `layout.json` is the single source for the 660 × 400 point window, 128 point icons, and icon positions. The packaging script checks both PNG sizes and mounts each generated DMG to verify the app signature, Applications link, two-resolution background, and Finder layout records. Signed releases also validate the stapled ticket on the app inside the DMG.

## Official packages

Publishing a GitHub Release with a matching `v<version>` tag starts `.github/workflows/tag-release.yml`, including the `aarch64`, `x86_64`, and `universal` macOS matrix jobs. Each macOS job:

1. Installs the pinned Rust target, npm lockfile, Python 3.12, and pinned `dmgbuild`.
2. Imports a `Developer ID Application` certificate into an ephemeral keychain.
3. Writes the App Store Connect API key to an ephemeral runner file.
4. Builds the Tauri app and updater archive for one architecture (the universal job builds both architectures with `SKIP_UPDATER=1` and verifies both slices with `lipo`), signs the app, submits it for notarization, and staples the notarization result.
5. Builds the DMG from the notarized app with the shared Finder layout, signs the DMG with the same Developer ID identity, and verifies the mounted contents.
6. Verifies the bundle with `codesign` and Gatekeeper `spctl`.
7. Creates updater signatures, checksums, and build provenance.
8. Removes the temporary keychain and key files even if the build fails.

## Expected assets

For both `aarch64` and `x86_64`:

- Signed and notarized `.dmg`
- `.app.tar.gz` updater package
- Matching `.app.tar.gz.sig`

For `universal`: a signed and notarized `.dmg` only.

The shared Release also contains `SHA256SUMS.txt`, `THIRD_PARTY_LICENSES.json`, `SBOM.cdx.json`, `LICENSE`, and GitHub-generated source archives. The workflow merges and validates the Windows and macOS manifest fragments locally, then attaches packages to the already published Release. It then publishes the channel's website `latest.json` (Stable or RC, from the tag); see [update-feed-publication.md](update-feed-publication.md). Keep GitHub's immutable Release setting disabled while attaching assets after publication.

Do not publish a package that requires users to remove quarantine or bypass Gatekeeper. Those commands are only useful when testing a package built locally from trusted source.
