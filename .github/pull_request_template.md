## Summary

<!-- What changed and why? Explicitly list user-visible behavior changes and any removed mechanisms. -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor
- [ ] Release / build
- [ ] Other:

## Local verification

- [ ] `npm run check:styles` run locally
- [ ] `npm run build` run locally
- [ ] `npm run test:unit` run locally
- [ ] `npm run test:visual` run locally when UI changed; screenshots inspected manually
- [ ] `npm run check:release` and `npm run check:licenses` run when metadata/dependencies changed
- [ ] `cargo check --locked --all-targets --manifest-path src-tauri\Cargo.toml`
- [ ] `cargo test --locked --all-targets --manifest-path src-tauri\Cargo.toml`
- [ ] `cargo fmt --all --check --manifest-path src-tauri\Cargo.toml`
- [ ] `cargo check --release --locked --features winui --bin vPaste --manifest-path src-tauri\Cargo.toml` (when Windows WinUI / startup changed)
- [ ] Manual test:

## Platforms tested

- [ ] Windows (WinUI 3)
- [ ] Windows (`--main-ui=webview`)
- [ ] macOS (AppKit / SwiftUI)
- [ ] macOS (`--main-ui=webview`)
- [ ] Not platform-specific

## Native UI parity & evidence (when applicable)

<!-- Record S / U / X / A / M evidence separately per AGENTS.md and docs/open-source/testing/windows-winui-acceptance-matrix.md. Do not mark physical motion, DPI, or focus as passed from synthetic tests. -->

- [ ] **S (Source):** traced reference React WebView, native UI, and shared Rust route
- [ ] **U (Unit):** focused Rust/frontend unit regressions added (failing-first for bug fixes)
- [ ] **X (Native XAML / AppKit):** loaded native control regression run locally (when applicable)
- [ ] **A (Actual App):** isolated actual-App verification run locally (when applicable)
- [ ] **M (Manual / Physical):** desktop motion, DPI, IME, and external-app focus verified (or explicitly listed as pending below)
- [ ] `--main-ui=webview` fallback path preserved; intentional differences documented

## Clipboard formats affected

- [ ] Text
- [ ] Link / URL
- [ ] Image
- [ ] Image OCR
- [ ] File
- [ ] Rich HTML / RTF
- [ ] Color
- [ ] Source app / icon metadata
- [ ] Not clipboard-related

## Documentation

- [ ] Public docs updated
- [ ] Changelog updated
- [ ] Docs not needed because:

## Contribution and privacy checklist

- [ ] I have the right to submit these changes and agree that they are contributed under the project's GPL-3.0-only license.
- [ ] I did not include secrets, private data, real clipboard contents, or third-party assets without redistribution rights.
- [ ] Security-sensitive details are not disclosed publicly in this PR.

## Risks / follow-up

<!-- Known risks, migration notes, pending M (physical) acceptance items, or follow-up work. -->

## UI governance (when applicable)

- [ ] Standard controls use MUI or the existing raw-control baseline was reduced; the baseline was not increased.
- [ ] Motion is imported only through `src/ui/motion`, uses shared presets, and every `AnimatePresence` declares `mode`.
- [ ] One element has one animation owner; Tauri window motion and manual drag transforms were not duplicated.
- [ ] Normal and reduced-motion behavior were checked.
- [ ] User-visible behavior changes and removed UI mechanisms are listed in the summary.
- [ ] Windows installer and release scripts are unchanged (unless explicitly scoped).
- [ ] Local verification results are written in the PR; this UI workstream does not rely on GitHub Actions quota.
