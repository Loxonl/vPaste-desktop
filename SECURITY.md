# Security Policy

## Supported Versions

Security fixes target the latest published stable release and the `main` branch. Older releases may be asked to upgrade before a fix is provided.

## Reporting Security Issues

Please do not open a public issue with sensitive security details.

Use GitHub private vulnerability reporting if it is enabled for this repository. If it is not available, open a minimal public issue asking for a private security contact, but do not include exploit details, secrets, private messages, logs with sensitive data, or sensitive clipboard contents.

## Clipboard Privacy

vPaste is local-first and stores clipboard history on the user's device. System-marked sensitive clipboard content is ignored by default where supported.

Do not paste secrets, passwords, tokens, private messages, or sensitive clipboard contents into public issues, discussions, pull requests, screenshots, logs, or fixtures. Use synthetic examples when reporting clipboard behavior.

## Do Not Commit

- Tauri updater private keys.
- Windows/macOS code-signing certificates, private keys, passwords, and notarization API keys.
- GitHub tokens.
- `.env` files.
- Local clipboard history databases.
- Generated logs, build outputs, installers, or signing artifacts.
- Third-party assets without redistribution rights.
