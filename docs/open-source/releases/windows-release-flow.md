# Windows Release Flow

Windows x64 is an official release target. The complete build definition is public in `.github/workflows/release.yml`; only certificates and private keys remain outside the repository.

## Local package

Run on Windows:

```powershell
npm ci
npm run build:windows
```

This creates a standard Tauri NSIS current-user installer under `src-tauri/target/release/bundle/nsis/`. The local override disables updater artifact generation, so no updater private key is needed. The result is not an official signed release.

## Official package

Pushing a matching `v<version>` tag starts the Release workflow. It:

1. Confirms the versions in npm, Cargo, and Tauri metadata match the tag.
2. Reinstalls dependencies from lockfiles and reruns the public checks.
3. Imports the base64-encoded PFX from the protected `release` environment.
4. Builds the standard Tauri NSIS installer for `x86_64-pc-windows-msvc`.
5. Applies Windows Authenticode signing and timestamps the installer.
6. Creates the Tauri updater signature and adds the Windows entry to `latest.json`.
7. Verifies Authenticode, generates SHA-256 checksums, and records build provenance.
8. Uploads everything to a draft GitHub Release for manual smoke testing.

Windows code signing and Tauri updater signing are separate. Authenticode establishes Windows publisher trust; the updater signature lets the installed app verify an update package.

## Expected assets

- `vPaste_<version>_windows_x86_64-setup.exe`
- Matching `.exe.sig`
- Shared `latest.json`
- `SHA256SUMS.txt`
- `THIRD_PARTY_LICENSES.json`
- `SBOM.cdx.json`
- `LICENSE`
- GitHub-generated source `.zip` and `.tar.gz`

The public build intentionally uses Tauri's reproducible NSIS path. No private installer shell or patched binary payload is part of the release contract.
