# Release Checklist

Use this checklist together with the detailed [Windows Packaging Runbook](windows-packaging-runbook.md). The runbook is the source of truth for commands, expected artifacts, validation coverage, signing order, and rollback behavior.

## One-time repository setup

1. Create a protected GitHub Environment named `release` with maintainer approval.
2. Add updater secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only to that Environment.
3. Add macOS certificate secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and `APPLE_KEYCHAIN_PASSWORD` when public signing is enabled.
4. Add App Store Connect secrets `APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_PRIVATE_KEY`; the tag workflow writes the private `.p8` key to the runner temporarily and exposes its path through `APPLE_API_KEY_PATH`.
5. Verify the updater private key matches `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, and keep an encrypted offline backup.
6. Keep Actions tokens read-only by default. Only the final Draft Release job may use `contents: write`.
7. Before commercial use, review the current Inno Setup terms and purchase the requested commercial license so release builds are not marked non-commercial.

## Prepare a version

1. Update npm, Cargo, Tauri, lockfile, and changelog versions together.
2. Build `1.6.0-rc.1` first, complete install/update/uninstall validation, then prepare `1.6.0` without replacing published assets.
3. Run:

```powershell
npm ci
npm run build
npm run check:release
npm run check:licenses
cargo fmt --all --check --manifest-path src-tauri/Cargo.toml
cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
npm run build:windows
```

## Build a Draft Release

1. Open Actions and run `Build draft release`.
2. Enter the exact package version and full reviewed source commit SHA.
3. Confirm the resulting Draft Release is marked unsigned and contains no public updater manifest.
4. Add a separately reviewed signing workflow before the first public Stable release; signing secrets must be scoped only to its signing steps.

The workflow creates a Draft Release only. It never creates a tag-triggered release, commits code, or opens a Bot PR.

## Windows validation

- Windows 10 22H2 and Windows 11; Chinese/English; light/dark; 100/150/200% DPI.
- Fresh install, custom writable directory, desktop shortcut, missing WebView2, same-version repair, blocked downgrade, and running-app update.
- Upgrade local 1.5.0 NSIS in place and preserve history, settings, startup preference, shortcuts, and install directory.
- Test background download, restart-to-update from settings/main panel/tray, restart recovery from a verified cached installer, bad signature, interrupted download, low disk, locked file, and recovery.
- Uninstall while preserving data, deleting default data, confirming managed deletion in a custom history directory, and silent uninstall preserving data.
- Move Portable between writable directories and confirm no AppData, uninstall registry, or startup residue.

## Publish review

- Private drafts contain the Windows installer/Portable, two macOS DMGs, checksums, SBOM, dependency inventory, notices, GPL license, and source archives.
- Private drafts clearly say unsigned/Unknown publisher. Public packages must additionally include updater archives/signatures and shared `latest.json`, and pass platform signature and notarization checks.
- Publish manually only after smoke tests; never replace assets under an already published version.
