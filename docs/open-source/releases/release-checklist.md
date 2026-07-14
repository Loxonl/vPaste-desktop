# Release Checklist

The release workflow is reproducible from this repository. A maintainer supplies signing credentials through a protected GitHub Environment named `release`; contributors and pull-request workflows never receive them. Official Release jobs intentionally require the repository to be public.

## One-time repository setup

1. Create the `release` Environment and require a maintainer review before jobs can access it.
2. Add these Environment secrets:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Signs Tauri updater packages. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater key, if configured. |
| `WINDOWS_CERTIFICATE` | Base64-encoded Authenticode PFX. |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX password. |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password. |
| `KEYCHAIN_PASSWORD` | Temporary CI keychain password. |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID. |
| `APPLE_API_KEY` | App Store Connect API key ID. |
| `APPLE_API_KEY_CONTENT` | Contents of the App Store Connect `.p8` key. |

3. Confirm the private updater key matches the public key committed at `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Keep an encrypted offline backup; losing or silently replacing this key prevents installed versions from accepting future updates.
4. Protect `main` and `v*` tags with repository rules. Require Check, Build, Dependency Review, and CodeQL before merge where the GitHub plan supports those rules.
5. Keep the Actions default token read-only, require Actions to use full commit SHAs, and allow write permissions only where a workflow declares them.
6. Enable private vulnerability reporting after the repository becomes public.

## Prepare a version

1. Update the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.
2. Update `CHANGELOG.md` and user-facing documentation.
3. Run:

```powershell
npm ci
npm run check:release
npm run check:licenses
npm run build
cargo fmt --all --check --manifest-path src-tauri/Cargo.toml
cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml
```

4. Merge through a reviewed pull request and wait for required checks.

## Build the draft Release

Create and push a tag that exactly matches the application version:

```powershell
git tag -s v1.5.0 -m "vPaste 1.5.0"
git push origin v1.5.0
```

The Release workflow fails closed if any signing secret is absent or a system signature cannot be verified. It creates a draft; it does not publish automatically.

## Review before publishing

1. Confirm the Windows x64, macOS Apple silicon, and macOS Intel assets are present, together with updater signatures and `latest.json`.
2. Confirm `SHA256SUMS.txt`, `THIRD_PARTY_LICENSES.json`, `SBOM.cdx.json`, `LICENSE`, and GitHub source archives are present.
3. Verify a downloaded artifact with `sha256sum` or `Get-FileHash` and, when needed, `gh attestation verify <artifact> --repo Loxonl/vPaste-desktop`.
4. Test clean install, launch, clipboard capture/search, global shortcut, upgrade from the previous stable version, in-app update, and uninstall on supported systems.
5. Confirm Windows reports the intended publisher and macOS Gatekeeper accepts both architectures without a manual bypass.
6. Review generated release notes, document known issues, and only then publish the draft.
7. Keep or roll back the tag and draft together if validation fails; never replace assets under a published version tag.
