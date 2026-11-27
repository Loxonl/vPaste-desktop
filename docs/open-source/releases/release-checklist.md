# Release Checklist

Use this checklist together with the detailed [Windows Packaging Runbook](windows-packaging-runbook.md). The runbook is the source of truth for commands, expected artifacts, validation coverage, signing order, and rollback behavior.

Use the shared [Release Notes Format and Template](release-notes-template.md)
for the release body on every platform and channel.

For clipboard verification, follow the [Office regression profiles](../testing/office-regressions.md).
Reuse valid automated evidence for unchanged source/platform inputs; verify the
final installed candidate with the listed real-Office smoke cases on Windows and
macOS. Record package/source identity, Office version, outcomes, and any tests not
run. Packaging now rejects the new Office fixtures in Release assets; this
isolation check does not execute Office or establish functional acceptance.

## One-time repository setup

1. Create a protected GitHub Environment named `release` with **Required reviewers** enabled for maintainer approval.
2. Add updater secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only to that Environment.
3. Windows packages are currently released without Authenticode signing. Do not configure Windows certificate secrets; release notes must retain the Unknown publisher and SmartScreen warning.
4. Add macOS certificate secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_KEYCHAIN_PASSWORD` when public signing is enabled. The workflow derives `APPLE_SIGNING_IDENTITY` from the imported Developer ID certificate.
5. Add App Store Connect secrets `APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_PRIVATE_KEY`; the tag workflow writes the private `.p8` key to the runner temporarily and exposes its path through `APPLE_API_KEY_PATH`.
6. Add `VPASTE_WEBSITE_RELEASE_TOKEN` (fine-grained token scoped solely to `Loxonl/vPaste-website` with **Contents: read and write**) to the `release` Environment for verified channel-manifest publication.
7. Verify the updater private key matches `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, and keep an encrypted offline backup.
8. Keep Actions tokens read-only by default. Only jobs that create private Draft Releases or upload assets may use `contents: write`.
9. Keep immutable GitHub Releases disabled while packages are uploaded after publication; GitHub rejects asset uploads to immutable published releases.
10. Before commercial use, review the current Inno Setup terms and purchase the requested commercial license so release builds are not marked non-commercial.

## Prepare a version

1. Keep the checked-in npm, Cargo, Tauri, and lockfile versions internally consistent. The tag workflow derives the effective Stable or RC version from the tag and synchronizes all five version sources in each runner before building.
2. Build an RC tag (for example `X.Y.Z-rc.1`) first, complete install/update/uninstall validation, then prepare the final Stable tag (`X.Y.Z`) without replacing published assets.
3. Run:

```powershell
npm ci
npm run build
npm run check:release
npm run check:licenses
cargo fmt --all --check --manifest-path src-tauri/Cargo.toml
cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo check --release --locked --features winui --bin vPaste --manifest-path src-tauri/Cargo.toml
cargo test --release --locked --features winui --bin vPaste --manifest-path src-tauri/Cargo.toml -- winui_startup winui_default_startup_tests main_panel_mode::tests startup_panel::tests app_updater::tests
npm run build:windows
```

## Build a Draft Release

1. Open Actions and run `Build draft release`.
2. Enter the exact package version and full reviewed source commit SHA.
3. Confirm the resulting Draft Release is marked unsigned and contains no public updater manifest.
4. Add a separately reviewed signing workflow before the first public Stable release; signing secrets must be scoped only to its signing steps.

The workflow creates a Draft Release only. It never creates a tag-triggered release, commits code, or opens a Bot PR.

## Build packages for a published release

1. Merge the workflow and upload script before choosing the source commit. Before creating the Release, verify that the protected GitHub `release` Environment has **Required reviewers** active and all required secrets configured (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_KEYCHAIN_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY`, and `VPASTE_WEBSITE_RELEASE_TOKEN`).
2. Create a GitHub Release with a reviewed tag matching `vX.Y.Z` for Stable or `vX.Y.Z-rc.N` for RC. Set the Release title to exactly the tag (for example, `v2.0.0-rc.6` or `v2.0.0`), without a product-name prefix, and add the release notes. The notes must include the Windows Unknown publisher and SmartScreen warning (and any release-specific runtime or fallback notes such as Windows App Runtime 2.6.5+ / `--main-ui=webview`).
3. Verify the footer links at the bottom of the Release notes before publishing: confirm `[Source / 源码]` points to the exact full 40-character commit SHA targeted by this tag, and `[Full changelog / 完整变更]` compares against this exact tag (`<previous-tag>...<this-tag>`). Do not leave an earlier RC's SHA or tag behind when iterating across consecutive RCs (for example `rc.4` → `rc.5` → `rc.6`).
4. Publish the Release to trigger `.github/workflows/tag-release.yml`. Pushing a tag alone does not start this workflow.
5. Approve the protected `release` Environment for platform signing and asset upload.
6. Wait for all platform jobs to finish and attach packages to that same Release: Windows x64 (`windows-2022`, built with `--features winui`, unsigned + minisign updater signature + WinUI payload rollback) and macOS (`macos-15`, `aarch64`, `x86_64`, and `universal`, Developer ID signed and notarized). Existing assets with different contents are never replaced.
7. Confirm the merged updater manifest contains `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64` entries with non-empty signatures. The workflow then publishes the channel manifest (`download/stable/latest.json` for `vX.Y.Z`, `download/rc/latest.json` for `vX.Y.Z-rc.N`) to the website; confirm the public URL serves the new version. See [update-feed-publication.md](update-feed-publication.md).
8. Smoke-test the attached packages before advertising the Release and confirm anonymous users can download them. Private Release assets are not suitable for the public updater feed.
9. Write bilingual notes from the [shared template](release-notes-template.md), with `## English` first and `## 中文` second. Group changes under emoji-prefixed New features, Improvements, and Fixes headings; omit empty categories. Use bold feature names and one-sentence descriptions. Keep the unsigned Windows warning under Notes in each language, and include other warnings only when relevant to this release. Do not add a product/version heading or a `Packages / 安装包` section.
10. Confirm the English-first bilingual download table is at the end of the Release notes, immediately above Assets. It must link directly to the five manual-install packages and contain only the table, without a Downloads heading, resource links, or explanatory text. The workflow refreshes its marked section without replacing handwritten notes.

Release-note presentation checks:

- Write user-facing English and Chinese summaries from the reviewed changes. An automatically generated list of PR titles is supporting reference, not a substitute for bilingual notes; preserve source/compare links and historical maintenance warnings.
- Name the feature directly, such as `**Mouse controls**` / `**鼠标操作**`, instead of promotional or comparative labels. Do not automatically repeat obsolete history-format or backup reminders in later releases.
- Put label punctuation outside bold: `**Mouse controls**: choose an action` and `**鼠标操作**：选择操作`. Avoid `**鼠标操作：**选择操作`, whose closing delimiter is not recognized by GitHub Markdown. The existing download-table helper normalizes this unsafe list-label pattern without rewriting code examples.
- Preview the final body with GitHub's Markdown renderer before publishing or editing a Release. Check that category headings and bold text render, the Windows warning remains concise in both languages, and the table-only download block is last and links only uploaded assets. Checksums and metadata stay in Assets and retain their existing validation.
- When correcting historical notes, change presentation only. Do not replace assets, signatures, checksums, tags, release dates, Stable/RC status, maintenance status, or updater feeds.

## Windows validation

- Windows 10 22H2 (and 1709 / 21H2 LTSC when changing compatibility gates) and Windows 11; Chinese/English; light/dark; 100/150/200% DPI.
- WinUI 3 default startup with x64 Windows App Runtime 2.6.5+ installed, automatic WebView fallback with actionable warning when the runtime is absent, explicit `--main-ui=webview` override without loading WinUI, and explicit `--main-ui=winui` non-zero diagnostic exit when the runtime is absent.
- Fresh install, custom writable directory, desktop shortcut, missing WebView2, WinUI payload + `.installer/winui-payload.sha256` staging and rollback on missing/unwritable WinUI DLLs, same-version repair, blocked downgrade, and running-app update.
- Upgrade local 1.5.0 NSIS or v1.7.0 Stable in place and preserve history, settings, startup preference, shortcuts, and install directory.
- Test background download, restart-to-update from settings, the main panel update icon and its confirmation dialog (mouse, Enter, Space, Escape), and the tray, restart recovery from a verified cached installer while offline, the ready notification appearing once per version across restarts, bad signature, interrupted download, low disk, locked file, a cache deleted or modified before installing, an installer that fails to start, and recovery.
- Uninstall while preserving data, deleting default data, confirming managed deletion in a custom history directory, and silent uninstall preserving data.
- Move Portable between writable directories and confirm no AppData, uninstall registry, or startup residue by default. Opt in to startup, confirm the separate Portable entry follows the moved EXE after one manual launch even while another instance is open, then opt out and confirm the installed app's entry is untouched. Launch an unconfigured second Portable copy and confirm it preserves the first copy's entry.

## Publish review

- Published releases contain **nine uploaded assets** (plus GitHub's two source archives, giving eleven download entries):
  1. `vPaste_<version>_windows_x64_setup.exe`
  2. `vPaste_<version>_windows_x64_portable.zip`
  3. `vPaste_<version>_macos_aarch64.dmg`
  4. `vPaste_<version>_macos_x86_64.dmg`
  5. `vPaste_<version>_macos_universal.dmg`
  6. `vPaste_<version>_macos_aarch64.app.tar.gz`
  7. `vPaste_<version>_macos_x86_64.app.tar.gz`
  8. `SHA256SUMS.txt`
  9. `vPaste_<version>_release-metadata.zip`
- The metadata ZIP preserves `LICENSE`, third-party notices, the dependency inventory, SBOM, the three updater signatures, and a version-specific `latest.json` snapshot. The client reads signatures from the channel manifest; updater packages remain directly downloadable. Checksums cover the final public packages and metadata ZIP.
- WinGet YAML remains in the Windows Actions artifact for maintainers and is not uploaded as a separate Release asset. Local packaging output is unchanged.
- Private drafts use the same metadata ZIP and download table, but contain no updater signatures or manifest snapshot.
- macOS packages must pass signature and notarization checks. The published-release workflow verifies updater signatures before packaging metadata, then publishes the website channel manifest after upload verification.
- Never replace assets under an already published version; create a new version for changed package bytes.
- Apply compact packaging to new releases. Existing releases may receive the download table without replacing their packages or checksums.
