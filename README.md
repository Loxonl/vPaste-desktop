# vPaste Desktop

vPaste is a local-first desktop clipboard manager for Windows and macOS. It keeps clipboard history on your device, supports quick search and preview, and focuses on preserving useful clipboard context without sending your clipboard data to a cloud service.

This repository is the clean GPL-3.0-only public baseline for the desktop app.

> Status: early clean open-source baseline. Source builds are available now; signed public release artifacts are not promised yet.

## Features

- Local-first clipboard history.
- Text, image, file, link, color, and rich clipboard item handling.
- Search-oriented clipboard storage.
- Tray/menu controls and global shortcut support.
- Windows and macOS desktop shell via Tauri.
- English and Simplified Chinese UI strings.

## Privacy

vPaste is designed to run locally. Clipboard data is stored on the user's device. System-marked sensitive clipboard content is ignored by default where supported.

Do not paste secrets, passwords, tokens, private messages, or sensitive clipboard contents into public issues. See [SECURITY.md](SECURITY.md) for security reporting guidance.

## Requirements

- Node.js 24 or another currently supported Node.js version compatible with the tooling.
- Rust stable toolchain.
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

## Releases

Official signed release artifacts are not part of this initial clean baseline yet. Release, signing, updater, and installer automation will be reviewed before being documented as a public contract.

Until public releases are available, build from source for testing and development.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). By opening a pull request, contributors confirm they have the right to submit the change and agree that contributions are licensed under GPL-3.0-only as part of this project.

## License

vPaste Desktop is licensed under GPL-3.0-only. See [LICENSE](LICENSE).
