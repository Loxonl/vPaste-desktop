# Changelog

All notable public changes to vPaste Desktop will be documented in this file.

## Unreleased

### Changed

- Allowed public Windows tag releases without an Authenticode certificate while retaining updater signatures, artifact-integrity checks, and an explicit publisher warning.
- Added Cargo dependency and pinned Inno Setup installer caching to the tag release workflow.

## 1.6.0 - 2026-07-24

### Added

- Added an in-window cross-platform tutorial with clearer Windows and macOS permission guidance.
- Added a development-only tutorial preview mode for platform, language, and theme testing.
- Added a compact Inno Setup installer, a true Portable ZIP, and session-aware update controls for Windows.

### Changed

- Refined onboarding timing, permission visuals, tray menus, native panel animation, and clipboard history scrolling.
- Refreshed the desktop logo and tray assets.
- Replaced the GSAP tutorial animation dependency with the browser-native Web Animations API.
- Moved the frontend build toolchain to Vite 7 for compatibility with the current MUI integration.
- Added a manual, source-pinned Draft Release workflow for unsigned private-stage Windows and macOS packages.

### Fixed

- Fixed Windows clipboard image restoration, stale text during image paste, and the settings close button.
- Fixed search pagination so older matching clipboard records remain discoverable.
- Fixed cleanup of shared clipboard preview assets.
- Fixed macOS background authorization, autostart state, tray placement, panel behavior, and paste fallback notices.

## Initial clean open-source baseline

- Created the clean GPL-3.0-only public baseline with fresh Git history.
- Included the core desktop app source, required build metadata, Tauri source/configuration, minimal GitHub Check workflow, and public security/contribution materials.
- Excluded old Git history, local AI/tooling state, private/team materials, generated build outputs, release artifacts, signing/updater secrets, and unreviewed release automation.
