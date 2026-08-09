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

The script pins Inno Setup 6.7.3, downloads the matching official Simplified Chinese translation from an immutable source tag, verifies its SHA-256, compiles the installer, and rejects installer overhead above 2 MiB relative to the Portable ZIP. Local builds keep the public updater feed disabled unless the caller explicitly sets `VPASTE_PUBLIC_UPDATE_FEED=1`.

For public tag releases, the tag is the effective application version. Each isolated build runner synchronizes `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` to that Stable or RC version before running the strict version check and compiling artifacts. These temporary changes are not committed back to the tagged source.

## Updater package

`npm run build:windows:signed-updater` signs the final Inno EXE with the updater key and writes `latest.windows.json`. The public tag workflow uses that fragment with the macOS fragments to publish the merged channel manifest through `Loxonl/vPaste-website`:

- Stable: `download/stable/latest.json` → `https://vpaste.app/download/stable/latest.json`
- RC: `download/rc/latest.json` → `https://vpaste.app/download/rc/latest.json`

Authenticode and updater signing are separate. Authenticode establishes Windows publisher trust; minisign prevents the app from installing modified updater bytes. Public Windows packages are currently not Authenticode-signed, so Windows can show Unknown publisher or SmartScreen warnings. The updater signature and checksum are still generated from the final installer bytes.

## Draft Release

Run `.github/workflows/release.yml` manually with the exact version and full source SHA. Build jobs are read-only. Only the final job has `contents: write`, and it can only create or update a Draft Release. The workflow does not push code, create branches, or open pull requests.

Private-stage drafts leave the public updater feed disabled and are marked unsigned. Public tag releases are handled by `.github/workflows/tag-release.yml`, which verifies that Windows artifacts are unsigned, signs updater payloads, uploads release assets to a draft GitHub Release, commits the merged updater manifest directly to `Loxonl/vPaste-website` using the protected `VPASTE_WEBSITE_RELEASE_TOKEN`, and only then publishes the GitHub Release. WinGet submission remains a separate manual review after the GitHub Release is public.
