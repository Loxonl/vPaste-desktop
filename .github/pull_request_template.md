## Summary

<!-- What changed and why? -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor
- [ ] Release / build
- [ ] Other:

## Local verification

<!-- List successful compile/build commands for code changes. For docs-only changes, write "Not needed". Other local checks are optional; say "Not run" when applicable. -->

- Build / compile:
- Other local checks (optional):
- Manual test (optional):

## Platforms tested

- [ ] Windows
- [ ] macOS
- [ ] Not platform-specific
- [ ] Not tested locally

## Clipboard formats affected

- [ ] Text
- [ ] Link / URL
- [ ] Image
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

<!-- Known risks, migration notes, or follow-up work. -->

## UI governance (when applicable)

- [ ] Standard controls use MUI or the existing raw-control baseline was reduced; the baseline was not increased.
- [ ] Motion is imported only through `src/ui/motion`, uses shared presets, and every `AnimatePresence` declares `mode`.
- [ ] One element has one animation owner; Tauri window motion and manual drag transforms were not duplicated.
- [ ] Normal and reduced-motion behavior were checked, or the pending check is noted above.
- [ ] User-visible behavior changes and removed UI mechanisms are listed in the summary.
- [ ] Windows installer and release scripts are unchanged.
- [ ] Build results and any other local checks are written in the PR; visual tests for this UI workstream remain local-only.
