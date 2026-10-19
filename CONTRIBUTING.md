# Contributing to vPaste Desktop

Thank you for your interest in contributing to vPaste Desktop.

## License and contribution rights

By opening a pull request, you confirm that:

- You have the right to submit the changes.
- Your contribution is licensed under GPL-3.0-only as part of this project.
- You did not include secrets, private data, real clipboard contents, or third-party assets without redistribution rights.

DCO / `Signed-off-by` is not required for the initial public launch.

## Branches and pull requests

- Treat `main` as stable.
- Use focused branches such as `feature/...`, `fix/...`, `docs/...`, or `release/...`.
- Keep pull requests small and focused.
- Prefer PR titles in this form:
  - `vPaste-#<issue-number>: <English summary>`
  - `MINOR: <English summary>` when there is no related issue.
- Resolve review comments before merge.
- Include a documentation decision in each PR: update docs when public behavior changes, or state why docs are not needed.
- Open a PR once the relevant code compiles: run `npm run build` for frontend changes and `cargo check --locked --all-targets --manifest-path src-tauri\Cargo.toml` for Rust/Tauri changes. Documentation-only PRs do not need a build. Local unit, visual, style, formatting, and manual tests are not prerequisites for creating a PR; report which checks were run or left for review. Required GitHub Actions checks still run after the PR opens and must pass before merge.

## Development checks

Install dependencies:

```powershell
npm ci
```

Frontend type/build check:

```powershell
npm run build
```

Rust/Tauri compile check:

```powershell
cargo check --locked --all-targets --manifest-path src-tauri\Cargo.toml
```

## Optional local checks

These checks can be run for deeper review but are not required before opening a PR:

```powershell
cargo test --locked --all-targets --manifest-path src-tauri\Cargo.toml
```

Rust formatting check:

```powershell
Push-Location src-tauri
cargo fmt --all --check
Pop-Location
```

Release metadata and dependency-license checks:

```powershell
npm run check:release
npm run check:licenses
```

## Privacy and security

Do not include real clipboard data in issues, tests, screenshots, logs, or fixtures. Use synthetic examples.

Do not commit:

- Secrets, passwords, tokens, or API keys.
- `.env` files.
- Local clipboard history databases.
- Generated logs, build outputs, installers, or signing artifacts.
- Third-party assets unless their license allows redistribution under the project's license.

Security-sensitive reports should follow [SECURITY.md](SECURITY.md), not public issue details.

## Public/private boundary

This public repository is for source code, public documentation, and public collaboration. Maintainer-only planning, private fixtures, local AI/tool state, and historical internal workflow notes do not belong in this repository.
