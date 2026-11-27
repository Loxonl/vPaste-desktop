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

The script compiles the official Windows x64 Release with `--features winui`. Setup and Portable include `VPasteWinUiPanel.dll`, `Microsoft.WindowsAppRuntime.Bootstrap.dll`, and the Windows App SDK license and notice in `winui-licenses/`. Both use the system's installed Windows App Runtime. Inno records the installed WinUI files in `.installer/winui-payload.sha256`.

Packaging uses Inno Setup 6.7.3, verifies the SHA-256 of the Simplified Chinese translation from the pinned source tag, and checks that the installer overhead stays within 2 MiB of the Portable ZIP. Use `-WebViewOnly` for a comparison or downgrade package. Local builds enable the public updater feed only when the caller explicitly sets `VPASTE_PUBLIC_UPDATE_FEED=1`.

Runtime and OS floor: WinUI 3 is the default main UI on Windows x64 and dynamically requires Windows App Runtime 2.6.5 (x64) or a compatible 2.6 update (Windows 10 1809 / Build 17763+). The installer keeps `MinVersion=10.0.16299` so older supported Windows 10 builds or hosts without Windows App Runtime 2.6.5 automatically fall back to the retained `/clipboard` WebView UI with an actionable warning. `--main-ui=webview` remains a per-launch escape hatch without loading WinUI; explicit `--main-ui=winui` exits non-zero with diagnostics when the runtime is unavailable.

Exit the current vPaste instance before choosing a different main UI for the next launch. Subsequent launches are routed to the existing instance.

For public tag releases, the tag is the effective application version. Each isolated build runner synchronizes `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` to that Stable or RC version before running the strict version check and compiling artifacts. These temporary changes are not committed back to the tagged source.

## Internal Windows x64 WinUI RC

```powershell
npm run build:windows -- -WinUiCandidate -InternalRcVersion 2.0.0-rc.1
```

The internal trial builds a Portable ZIP and checksums under
`src-tauri/target/release/bundle/windows-internal-rc/<version>/`. Its
Windows-only `winui-rc` feature defaults to WinUI, and `--main-ui=webview`
selects WebView. The RC has a dedicated profile beside the executable and
uses manual updates and manual launch. The build rejects signing, a release
base URL and public updater settings. Regular Windows packaging uses the
official Inno installer and Portable ZIP with WinUI enabled by default and
safe WebView fallback.

The [internal trial guide](windows-winui-rc-trial.md) covers Runtime
requirements, profile isolation, fallback, testing limits, and the artifact
record for pairing with a separately built Mac trial.

## Updater package

`npm run build:windows:signed-updater` signs the final Inno EXE with the updater key and writes `latest.windows.json`. The Release workflow merges and validates that fragment with the macOS fragments. After the packages are uploaded and verified, the workflow publishes the merged manifest to the tag's channel in `Loxonl/vPaste-website`:

- Stable: `download/stable/latest.json` → `https://vpaste.app/download/stable/latest.json`
- RC: `download/rc/latest.json` → `https://vpaste.app/download/rc/latest.json`

Authenticode and updater signing are separate. Authenticode establishes Windows publisher trust; minisign prevents the app from installing modified updater bytes. Public Windows packages are currently not Authenticode-signed, so Windows can show Unknown publisher or SmartScreen warnings. The updater signature and checksum are still generated from the final installer bytes.

## Draft Release

Run `.github/workflows/release.yml` manually with the exact version and full source SHA. Build jobs are read-only. Only the final job has `contents: write`, and it can only create or update a Draft Release. The workflow does not push code, create branches, or open pull requests.

Private-stage drafts leave the public updater feed disabled and are marked unsigned. Publishing a new GitHub Release triggers `.github/workflows/tag-release.yml`, which verifies that Windows artifacts are unsigned, signs updater payloads, and attaches packages to the existing Release. It does not create or edit the Release; after verifying the packages it publishes the channel's website manifest. WinGet submission remains a separate manual review after packages have been verified.
