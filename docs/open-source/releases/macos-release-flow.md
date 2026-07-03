# macOS Release Flow

> Maintainer-only. Official macOS packaging, signing, notarization, and updater tooling run in the maintainer environment and are not part of this public repository. Contributors do not need this flow; the contributor build/check commands are in the README and CONTRIBUTING.

## Scope

This document records the maintainer macOS release package path for vPaste. It uses Tauri 2, `.app` / `.dmg` bundles, and Tauri updater artifacts. The packaging script referenced below lives in the maintainer's private release environment, not in this repository.

Public distribution still requires a properly configured Apple Developer signing and notarization environment on the build machine.

## Supported macOS Versions

The public macOS release target is macOS 11 Big Sur or newer.

- Apple silicon builds require macOS 11+.
- Intel and universal builds are also built with `MACOSX_DEPLOYMENT_TARGET=11.0` by default.
- Older macOS versions are not part of the supported release matrix unless a dedicated legacy Intel build is created and tested separately.

## Artifacts

Host architecture builds write artifacts under:

- DMG: `src-tauri/target/release/bundle/dmg/*.dmg`
- App bundle: `src-tauri/target/release/bundle/macos/vPaste.app`
- Updater archive: `src-tauri/target/release/bundle/macos/*.app.tar.gz`
- Updater signature: `src-tauri/target/release/bundle/macos/*.app.tar.gz.sig`
- Updater manifest: `src-tauri/target/release/bundle/updater/latest.json`

When `MACOS_BUILD_TARGET` is set, artifacts are written under `src-tauri/target/<target>/release/bundle/`.

## Build Command (maintainer environment)

Official macOS packaging is produced by a maintainer-side release script (not present in this repository) that builds the frontend and Tauri app, creates `.app` and `.dmg` bundles, verifies or signs the updater archive, and writes a macOS updater manifest.

The maintainer script also supports an unsigned local smoke-test mode (`UNSIGNED=1`) without Apple signing or Tauri updater signing.

Unsigned mode uses ad-hoc macOS code signing with identity `-`, disables updater artifact creation for that build, and only produces local `.app` / `.dmg` artifacts. Its DMG background includes a quarantine-removal command for trusted local smoke testing. It is for development or manual smoke testing, not public distribution or app updates. A publicly distributed macOS package still needs Developer ID signing and notarization.

Default updater base URL:

```text
https://downloads.vpaste.app/macos
```

Override it when needed by setting `BASE_URL` in the maintainer environment before running the release script, for example:

```bash
BASE_URL=https://downloads.example.com/macos
```

## Environment

Required for Tauri updater signing:

- `TAURI_SIGNING_PRIVATE_KEY_PATH`, or
- `TAURI_SIGNING_PRIVATE_KEY`

If neither is set, the script looks for:

```text
~/.tauri/vpaste-updater-ci.key
```

Optional:

- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `VERSION` to override `package.json` version.
- `NOTES_PATH` to include release notes in `latest.json`.
- `BASE_URL` to override the updater artifact URL base.
- `MACOS_BUILD_TARGET`, such as `aarch64-apple-darwin`, `x86_64-apple-darwin`, or `universal-apple-darwin`.
- `MACOSX_DEPLOYMENT_TARGET` to override the minimum macOS version for experimental local builds. Public releases default to `11.0`.
- `OUTPUT_PATH` to override the manifest output path.
- `SKIP_STAPLING=1` to pass `--skip-stapling` to Tauri build.
- `UNSIGNED=1` to create local ad-hoc signed `.app` / `.dmg` artifacts without updater signing.
- `MACOS_RELEASE_LTO=true` to opt back into release LTO. The script defaults to `false` on macOS packaging to avoid stale dependency bitcode failures.

Apple signing and notarization inputs are read by Tauri and Apple tooling from the local environment. Do not commit certificates, API keys, keychain exports, passwords, or local absolute paths.

## Updater Manifest

The manifest generator uses Tauri's static updater JSON shape. Platform keys use the `OS-ARCH` format:

- `darwin-aarch64` for Apple silicon builds.
- `darwin-x86_64` for Intel builds.
- both keys for `universal-apple-darwin`.

The generated manifest points each key to the same `.app.tar.gz` updater archive for the selected build.

## Version Files

Keep these aligned:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src/config/Config.tsx`

## Pre-Release Checks

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
# then run the maintainer-side macOS release script in the maintainer environment
```

Check:

- DMG filename and app version match.
- `.app.tar.gz` exists.
- `.app.tar.gz.sig` exists.
- `latest.json` version matches the app version.
- `latest.json` URL points to the intended macOS update feed.
- Release notes do not contain local paths or secrets.

## Troubleshooting

If a release build fails while loading bitcode for `window_vibrancy`, the release LTO step is usually reading stale Cargo object files after a Rust or Xcode toolchain change. The build script disables release LTO by default for macOS packaging, removes stale `window_vibrancy` release artifacts before building, and retries this specific failure once.

To force the same cleanup manually:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml -p window-vibrancy
rm -rf src-tauri/target/release/.fingerprint/window-vibrancy-*
rm -f src-tauri/target/release/deps/libwindow_vibrancy-* src-tauri/target/release/deps/window_vibrancy-*.d
```

If the error persists, remove the platform release target directory and rebuild.

If a local `UNSIGNED=1` package opens with `"vPaste" is damaged and can't be opened`, first rebuild with the current script and remount the newly generated DMG. Older unsigned bundles can have incomplete bundle signatures. The fixed local path signs the `.app` bundle with ad-hoc identity `-`, so `codesign --verify --deep --strict` should pass.

For local smoke testing only, a package that was copied through a browser, chat app, or file-sharing service may also have macOS quarantine attributes. Remove quarantine only on artifacts you built or trust:

```bash
xattr -dr com.apple.quarantine /Applications/vPaste.app
```

Do not use this as a release workaround. Public macOS distribution must use Developer ID signing and notarization so Gatekeeper can accept the app without manual override.

## GitHub Release

Create or update tag `v<version>`.

Upload:

- DMG artifact.
- `.app.tar.gz` updater archive.
- `.app.tar.gz.sig` updater signature.
- `latest.json`.

The `.sig` and `latest.json` are public updater artifacts. They must not contain the private signing key.

## Release Checks

- Clean install on a fresh macOS user account.
- Upgrade from previous macOS build.
- Gatekeeper opens the app without manual override after notarization.
- Menu bar item works.
- Global shortcut works.
- Clipboard history survives restart.
- Updater feed points to the intended macOS artifacts.
