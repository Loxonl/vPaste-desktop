# Windows Release Flow

Windows x64 is built with Inno Setup 6.7.3. The source installer definition and release script are public; signing keys remain outside the repository.

Maintainers should follow the complete [Windows Packaging Runbook](windows-packaging-runbook.md) for version preparation, reproducible builds, artifact validation, signing order, Draft Release review, and failure recovery.

## Local package

Run on Windows:

```powershell
npm ci
npm run build:windows
```

Outputs under `src-tauri/target/release/bundle/windows/`:

- `vPaste_<version>_windows_x64_setup.exe`
- `vPaste_<version>_windows_x64_portable.zip`
- `SHA256SUMS.txt`
- a validated WinGet singleton manifest for later manual submission

The script pins Inno Setup 6.7.3, downloads the matching official Simplified Chinese translation from an immutable source tag, verifies its SHA-256, compiles the installer, and rejects installer overhead above 2 MiB relative to the Portable ZIP.

## Updater package

`npm run build:windows:signed-updater` signs the final Inno EXE with the local updater key and writes `latest.windows.json` for the debug-only local update feed. It does not enable the public feed in the app and is not a public release command.

Authenticode and updater signing are separate. Authenticode establishes Windows publisher trust; minisign prevents the app from installing modified updater bytes. Authenticode must happen before the final updater signature and checksum.

## Draft Release

Run `.github/workflows/release.yml` manually with the exact version and full source SHA. Build jobs are read-only. Only the final job has `contents: write`, and it can only create or update a Draft Release. The workflow does not push code, create branches, or open pull requests.

Private-stage drafts leave the public updater feed disabled and are marked unsigned. The workflow intentionally exposes no public-feed switch until Authenticode/SignPath, Apple notarization, and step-scoped protected secrets are integrated. WinGet submission remains a separate manual review after the GitHub Release is public.
