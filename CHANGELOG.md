# Changelog

All notable public changes to vPaste Desktop will be documented in this file.

## Unreleased

- Added reproducible, signed draft GitHub Releases for Windows x64 and macOS Apple silicon/Intel.
- Added updater metadata, checksums, CycloneDX SBOM, dependency-license inventory, provenance attestations, Dependabot, dependency review, and CodeQL workflows.
- Removed the privileged `workflow_run` checkout pattern and pinned GitHub Actions to immutable commits.
- Replaced the GSAP tutorial animation dependency with the browser-native Web Animations API to keep the GPL dependency boundary unambiguous.
- Upgraded the frontend build toolchain to Vite 8.

## Initial clean open-source baseline

- Created the clean GPL-3.0-only public baseline with fresh Git history.
- Included the core desktop app source, required build metadata, Tauri source/configuration, minimal GitHub Check workflow, and public security/contribution materials.
- Excluded old Git history, local AI/tooling state, private/team materials, generated build outputs, release artifacts, signing/updater secrets, and unreviewed release automation.
