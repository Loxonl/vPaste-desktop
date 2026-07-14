# vPaste Desktop

vPaste is a local-first desktop clipboard manager for Windows and macOS. It keeps clipboard history on your device, supports quick search and preview, and focuses on preserving useful clipboard context without sending your clipboard data to a cloud service.

This repository is the GPL-3.0-only public source and reproducible release definition for the desktop app.

## Features

- Local-first clipboard history.
- Text, image, file, link, color, and rich clipboard item handling.
- Search-oriented clipboard storage.
- Tray/menu controls and global shortcut support.
- Windows and macOS desktop shell via Tauri.
- English and Simplified Chinese UI strings.

## Screenshots

![vPaste main clipboard panel](docs/assets/readme/main-panel.png)

![Tabs, favorites, and category filters](docs/assets/readme/tabs-categories.png)

![Image, link, file, and rich text preview](docs/assets/readme/preview.png)

![Settings window](docs/assets/readme/settings.png)

## Privacy

vPaste is designed to run locally. Clipboard data is stored on the user's device. System-marked sensitive clipboard content is ignored by default where supported.

Do not paste secrets, passwords, tokens, private messages, or sensitive clipboard contents into public issues. See [SECURITY.md](SECURITY.md) for security reporting guidance.

## Requirements

- Node.js 24.11.1 and npm 11.
- Rust 1.91.1.
- Platform requirements for Tauri 2 development on Windows or macOS.

## Development

Install dependencies:

```powershell
npm ci
```

Run frontend development server only:

```powershell
npm run dev
```

Run the desktop app in development mode:

```powershell
npm run dev:app
```

Build the frontend:

```powershell
npm run build
```

Check the Rust/Tauri side:

```powershell
cargo check --manifest-path src-tauri\Cargo.toml
```

Check Rust formatting:

```powershell
Push-Location src-tauri
cargo fmt --all --check
Pop-Location
```

Create a local installer without updater signing:

```powershell
# Windows x64 NSIS
npm run build:windows

# macOS DMG (run on macOS)
npm run build:macos
```

Local packages are for development and are not official signed releases.

## Releases

Pushing a version tag such as `v1.5.0` runs the public release workflow and creates a draft GitHub Release containing:

- Windows x64 NSIS installer.
- macOS DMGs and updater packages for Apple silicon and Intel.
- Tauri updater signatures and `latest.json`.
- SHA-256 checksums, a CycloneDX SBOM, dependency-license inventory, and build provenance attestations.
- GitHub-generated source archives plus the GPL license.

Official packages must pass Windows Authenticode signing and Apple Developer ID signing/notarization; a maintainer reviews installation and update smoke tests before publishing the draft. See the [release checklist](docs/open-source/releases/release-checklist.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). By opening a pull request, contributors confirm they have the right to submit the change and agree that contributions are licensed under GPL-3.0-only as part of this project.

## License

vPaste Desktop is licensed under GPL-3.0-only. See [LICENSE](LICENSE).

Third-party dependency notices and attribution notes are tracked in [docs/open-source/third-party-notices.md](docs/open-source/third-party-notices.md).
