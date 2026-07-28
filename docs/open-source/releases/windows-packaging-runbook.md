# Windows Packaging Runbook

This runbook is the maintainer procedure for producing, validating, and
publishing vPaste Windows artifacts. Follow it for release candidates and
stable releases. Do not reconstruct the process from shell history.

## Release contract

Windows x64 publishes two application packages:

- `vPaste_<version>_windows_x64_setup.exe`: current-user Inno Setup installer
- `vPaste_<version>_windows_x64_portable.zip`: self-contained Portable package

The installer must install without elevation under
`%LOCALAPPDATA%\Programs\vPaste` by default. The Portable package must keep its
configuration, database, cache, and WebView2 data under its own `data`
directory. Both packages are built from the same reviewed source commit.

The following files define the packaging contract:

| File | Responsibility |
| --- | --- |
| `installer/windows/vpaste.iss` | Install, repair, legacy migration, shortcuts, WebView2, and uninstall behavior |
| `scripts/build-windows-release.ps1` | Application build, Portable staging, Inno compilation, hashes, and size policy |
| `scripts/generate-inno-assets.ps1` | Installer and uninstaller image assets |
| `scripts/generate-winget-manifest.mjs` | Local WinGet singleton manifest |
| `scripts/generate-updater-manifest.mjs` | Platform updater manifest |
| `.github/workflows/release.yml` | Manually approved cross-platform Draft Release |
| `src-tauri/src/runtime_mode.rs` | Installed versus Portable runtime behavior |
| `src-tauri/src/app_updater.rs` | Update state, download, verification, and install scheduling |

Do not hand-edit generated files under
`src-tauri/target/release/bundle/windows/`.

## Supported environment

Use a Windows 10 22H2 or Windows 11 x64 build machine with:

- Node.js 24.11.1 and npm 11
- Rust 1.91.1 with the repository lockfile
- the Visual Studio C++ and Windows SDK requirements for Tauri 2
- WebView2 for local application smoke tests
- Inno Setup 6.7.3

The Windows release script locates an already installed copy of the pinned
Inno version and verifies the downloaded Simplified Chinese message file. The
GitHub workflow downloads the immutable official installer, verifies its
SHA-256, installs it, and exports the compiler path. A different compiler
version is a release-process change and requires its own review.

Start from a clean checkout of the exact commit intended for release:

```powershell
git fetch origin --prune
git switch main
git pull --ff-only origin main
git status --short
npm ci
```

Stop if the working tree is dirty or if dependency installation changes a
lockfile unexpectedly.

## Prepare the version

Keep these version sources aligned:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md`

Verify them before compiling:

```powershell
npm run check:release
npm run check:licenses
```

Build and validate an RC such as `1.6.0-rc.1` before the final stable version.
Never replace artifacts attached to an already published version.

## Quality gate

Run the complete quality gate from the repository root:

```powershell
npm run build
npm run check:release
npm run check:licenses
cargo fmt --all --check --manifest-path src-tauri/Cargo.toml
cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
npm run build:windows
```

`npm run build:windows` is the official local packaging entry point. It:

1. builds the Tauri release binary without a Tauri bundle;
2. creates a clean Portable staging directory;
3. adds `portable.flag`, `LICENSE`, and `vPaste.exe`;
4. creates the Portable ZIP;
5. generates the Inno visual assets;
6. compiles the Inno installer;
7. creates SHA-256 checksums;
8. creates and validates the WinGet manifest; and
9. rejects installer overhead greater than 2 MiB relative to the Portable ZIP.

During installer UI development only, the existing release binary can be
repackaged without rebuilding the application:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\build-windows-release.ps1 -SkipAppBuild
```

`-SkipAppBuild` is not a release command. Never publish its output unless the
existing `src-tauri/target/release/vPaste.exe` was independently proven to come
from the exact reviewed source commit.

## Expected outputs

Inspect `src-tauri/target/release/bundle/windows/`:

```text
vPaste_<version>_windows_x64_setup.exe
vPaste_<version>_windows_x64_portable.zip
SHA256SUMS.txt
winget/Loxonl.vPaste.yaml
```

Confirm the hashes against the final bytes:

```powershell
Get-FileHash -Algorithm SHA256 `
  .\src-tauri\target\release\bundle\windows\vPaste_<version>_windows_x64_setup.exe
Get-FileHash -Algorithm SHA256 `
  .\src-tauri\target\release\bundle\windows\vPaste_<version>_windows_x64_portable.zip
Get-Content `
  .\src-tauri\target\release\bundle\windows\SHA256SUMS.txt
```

The ZIP root must contain only:

```text
vPaste.exe
LICENSE
portable.flag
```

Do not accept application data, logs, WebView2 data, or developer files in the
ZIP.

## Manual Windows validation

Test both Windows 10 22H2 and Windows 11 where release risk warrants it. Cover
Simplified Chinese and English, light and dark themes, and 100%, 150%, and
200% display scaling.

### Installer

- Fresh install to the default directory
- Fresh install to a selected parent directory; the picker must append
  `vPaste`
- Install with and without the optional desktop shortcut
- Start menu shortcut and launch-after-install behavior
- Missing WebView2 download, Microsoft signature verification, retry, and
  failure guidance
- Same-version repair with vPaste running and already closed
- Upgrade while the tray process is running
- Default downgrade block and explicit development-only downgrade confirmation
- Keyboard navigation, close actions, progress state, and completion action

### Legacy migration

Install the local 1.5.0 NSIS package, create representative data, and then run
the Inno package. Confirm that it:

- reuses the previous installation directory;
- preserves history, settings, shortcuts, startup preference, and custom data
  locations;
- does not launch the legacy uninstaller;
- removes the legacy uninstall registration only after success; and
- restores the previous executable if replacement fails.

### Uninstall

- Default uninstall preserves history and settings
- Interactive data removal deletes the default managed data
- A custom history root requires path confirmation and deletes only
  vPaste-managed entries, never the selected root recursively
- Silent uninstall preserves all user data
- Program files, shortcuts, startup registration, update cache, and uninstall
  registration are removed

### Portable

- Move the extracted folder and run it again
- Confirm all data follows the folder under `data`
- Confirm an unwritable folder produces a clear error instead of falling back
  to AppData
- Confirm there is no uninstall registration, startup registration, or
  vPaste-specific AppData residue
- Confirm automatic self-update is disabled and the Release link is offered

Record the tested OS version, language, theme, DPI, old version, new version,
artifact SHA-256, result, and any retained logs in the release notes or QA
record.

## Update validation

Public update delivery remains disabled while packages are unsigned and the
repository is private. Never embed a GitHub token in the client.

For a debug-only local signed feed:

```powershell
npm run build:windows:signed-updater
```

Set `VPASTE_DEBUG_UPDATE_ENDPOINT` only in a debug build. Validate:

- RC1 to RC2 and RC to stable version ordering
- valid minisign download and install
- bad signature and corrupted bytes
- interrupted download and retry
- low disk space and locked executable
- immediate update
- update on explicit tray exit
- defer for 24 hours
- installer launch failure and recovery

A failed download, signature check, or installer launch must leave the existing
version runnable.

## Signing order for a public release

Unsigned private-stage packages must clearly state `Unknown publisher`. Do not
use a self-signed certificate to imitate publisher trust.

When protected signing is enabled, preserve this order:

1. build `vPaste.exe`;
2. Authenticode-sign `vPaste.exe` with timestamping;
3. compile the Inno installer;
4. Authenticode-sign the final installer with timestamping;
5. generate the updater/minisign signature from the final installer bytes;
6. generate SHA-256 checksums from those same final bytes; and
7. create `latest.json` with the final immutable asset URLs.

Changing a signed artifact after step 4 invalidates the downstream signature,
checksum, and manifest. Rebuild the entire chain instead of patching an asset.

## Draft Release and publication

The GitHub Actions workflow is intentionally manual:

1. Open **Actions → Build draft release**.
2. Enter the exact version and full reviewed source commit SHA.
3. Approve the protected `release` Environment when signing is enabled.
4. Wait for all Windows and macOS jobs.
5. Confirm the Draft Release is still unpublished.
6. Download and smoke-test the actual attached artifacts.
7. Compare every artifact with `SHA256SUMS.txt`.
8. Review the SBOM, dependency inventory, licenses, and release notes.
9. Publish manually only after the checklist is complete.

The workflow must not use `workflow_run` or `pull_request_target`, push code,
create branches, or open Bot pull requests. Build jobs are read-only; only the
final Draft Release job receives `contents: write`.

The release should contain:

- Windows installer and Portable ZIP
- Apple silicon and Intel macOS artifacts
- shared updater metadata and updater signatures when public updating is
  enabled
- `SHA256SUMS.txt`
- SBOM and dependency/license inventory
- third-party notices and GPL license
- GitHub source archives

Submit WinGet metadata manually only after the corresponding Stable GitHub
Release is public and immutable.

## Failure handling

If any quality gate or manual test fails:

1. keep the Draft Release unpublished;
2. preserve the failing installer log and exact artifact hash;
3. fix the source or packaging definition;
4. create a new RC version;
5. rebuild every affected artifact; and
6. repeat the full validation matrix.

Do not overwrite a public Release asset, retag a published version, or update
`latest.json` to an unverified package.

For installer diagnosis, use the Inno-generated setup log. Common checks are:

- confirm `package.json` and Tauri versions match;
- confirm `src-tauri/target/release/vPaste.exe` exists before using
  `-SkipAppBuild`;
- confirm the selected install directory is writable by the current user;
- confirm old vPaste tray processes have exited;
- confirm `SHA256SUMS.txt` was regenerated after the final package bytes; and
- confirm the build script used the pinned Inno compiler and translation.

If an update reaches users and installation fails, stop publishing the updater
manifest, keep the previous verified Release available, and ship a new patch
version. Never force-install or silently downgrade users.
