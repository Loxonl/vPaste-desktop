# Security Policy

## Reporting Security Issues

Please do not open a public issue for sensitive security reports.

If you find a security issue, contact the maintainer privately first. If no private contact channel is available yet, open a minimal GitHub issue asking for a private security contact without including exploit details.

## Clipboard Privacy

vPaste is local-first and stores clipboard history on the user's device. System-marked sensitive clipboard content is ignored by default where supported.

Do not commit:

- Tauri updater private keys
- GitHub tokens
- `.env` files
- Local clipboard history databases
- Generated logs, build outputs, or installers
