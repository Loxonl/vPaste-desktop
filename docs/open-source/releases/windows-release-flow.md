# Windows Release Flow

> Maintainer-only. Official Windows packaging, signing, updater, and installer-shell tooling run in the maintainer environment and are not part of this public repository. Contributors do not need this flow; the contributor build/check commands are in the README and CONTRIBUTING.

## Scope

This document records the maintainer Windows packaging path for vPaste. It assumes feature work, review, and broader validation already happen through the GitHub branch and PR workflow. The packaging scripts and installer shell referenced below live in the maintainer's private release environment, not in this repository.

## Build Command (maintainer environment)

Official Windows packaging is produced by a maintainer-side release script (not present in this repository) that builds the frontend and main Tauri app, patches the generated NSIS script, rebuilds the NSIS payload, builds the modern setup shell with that payload embedded, signs the public setup shell for updater verification, and writes `latest.json`.

## Artifacts

- Public installer: `src-tauri/target/release/bundle/nsis/vPaste_<version>_x64-setup.exe`
- Internal NSIS payload: `src-tauri/target/release/bundle/nsis/vPaste_<version>_x64-nsis-payload.exe`
- Updater signature: `src-tauri/target/release/bundle/nsis/vPaste_<version>_x64-setup.exe.sig`
- Updater manifest: `src-tauri/target/release/bundle/updater/latest.json`

## Version Files

Keep these aligned before packaging:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `installer-shell/src-tauri/Cargo.toml`
- `installer-shell/src-tauri/tauri.conf.json`
- `src/config/Config.tsx`

## Maintainer Packaging Steps

1. Confirm the release branch has gone through the normal PR path and required GitHub checks.
2. Confirm the version files above already contain the intended version.
3. Run the maintainer-side Windows release script in the maintainer environment.
4. Check the generated artifacts exist and use the intended version.
5. Check `latest.json` points to the intended stable update feed and does not contain local paths or secrets.
6. Keep the NSIS payload for troubleshooting only. Upload the public setup shell, `.sig`, and `latest.json`.

## GitHub Release

Create or update tag `v<version>`.

Upload:

- `vPaste_<version>_x64-setup.exe`
- `vPaste_<version>_x64-setup.exe.sig`
- `latest.json`

The public `setup.exe` is the modern setup shell. The NSIS payload should not be the default download entry. The `.sig` and `latest.json` are public updater artifacts. They must not contain the private signing key.

## Installer Notes

- The setup shell owns the visible install, update, and uninstall experience.
- NSIS remains the reliable hidden execution path for writing and removing the app.
- Default install mode is current user.
- Keep install path selection available from the setup shell advanced options.
- Preserve user data during upgrade.
- Start menu should include a direct uninstall shortcut that opens `vPasteSetup.exe --uninstall`.
- The Windows uninstall registry entry should point to the setup shell uninstall mode when supported.
- Do not describe default NSIS pages as a modern installer UI.
- Avoid fixed-size NSIS header/sidebar bitmaps that become blurry on high-DPI displays.
