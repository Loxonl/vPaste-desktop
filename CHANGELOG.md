# Changelog

All notable public changes to vPaste Desktop will be documented in this file.

## Unreleased

### Changed

- Synchronized public READMEs, architecture and platform notes, native parity documentation, release checklists, and GitHub issue/PR templates with the v2.0.0 RC state.

## 2.0.0-rc.6 - 2026-11-27 (Pre-release)

### Added

- Added image OCR to recognize text in clipboard images, edit recognized text alongside the source image, and search recognized text in clipboard history.
- Added a native macOS tab editor directly accessible from the native main panel.
- Added a Windows x64 WinUI 3 native main panel, native tray menu, native preview reader (plain text, images, colors, and common files), and native paste queue.
- Added a native macOS AppKit / SwiftUI main panel (with Liquid Glass on macOS 26+ and frosted-glass fallback on earlier macOS versions) and native menu bar menu.

### Changed

- Switched official Windows x64 Release packages (`--features winui`) to default to WinUI 3 when x64 Windows App Runtime 2.6.5+ is available, with automatic fallback to WebView and per-launch `--main-ui=webview` override.
- Switched macOS builds to default to the native AppKit main panel and native menu bar menu, while keeping `--main-ui=webview` available as a fallback.
- Integrated WinUI payload staging, checksum receipts, and rollback protection into the Windows Inno Setup installer and Portable ZIP.
- Updated native main panels to apply incremental history updates without reloading the full list and to preserve completed link previews as additional previews arrive.
- Upgraded macOS release packaging in `.github/workflows/tag-release.yml` to `macos-15`.

### Fixed

- Prevented native search actions from operating on stale search results and kept queued pastes tied to the intended destination application.
- Fixed HTTP/2 negotiation for link previews on Windows and macOS and rejected corrupt PNG pixels before publishing previews.
- Fixed macOS native card clipping, PDF Escape dismissal, OCR draft editor pinning, and pending preview cancellation when closing the main panel.

## 1.7.0 - 2026-11-04

### Added

- Added single-click and double-click paste options and an optional hover preview.
- Added a three-step main-panel height slider with live preview.

### Changed

- Kept Space previews ready when switching between clipboard records.
- Set default panel height based on screen size and used native Windows/macOS show and hide animations.
- Enabled Text, Image, Link, and File filters by default while keeping Color optional and preserving existing user selections.
- Loaded auxiliary windows on demand and bounded clipboard, history, and preview caches.
- Followed system language preferences on first launch on macOS and showed the main panel in the active Space, including fullscreen apps.
- Refined English settings layouts, cleanup confirmations, and update feedback.

### Fixed

- Fixed blank cards during scrolling and kept arrow-key navigation aligned with visible cards.
- Restored keyboard focus when returning the pointer to the main panel and aligned Space/pinned preview pointer focus without interrupting settings or editor windows.
- Fixed a Windows bitmap-capture deadlock, restored destination editing focus before pasting, and fixed interface clipping under increased Windows text scaling.
- Removed blocking process-shutdown waits in the Windows installer and fit the file-in-use prompt to the compact installer.
- Kept the first visible record after reopening aligned with the Enter-to-paste target.
- Preserved supported rich-content images when exporting and importing history backups.
- Fixed missing link-preview images and inline icons, followed system proxies, and retained completed results during refreshes.

## 1.6.5 - 2026-10-23

### Fixed

- Removed the overly strict Windows 10 22H2 installer gate that blocked installation on Windows 10 21H2 / LTSC 2021, unifying the minimum installation target at Windows 10 1709 (build 16299) x64 with WebView2 across interactive install, silent update, and WinGet metadata.

## 1.6.4 - 2026-10-23

### Added

- Added optional automatic history cleanup by age or item count (disabled by default, with preview confirmation, preserving favorites, tagged records, and original user files).
- Added editing for saved plain and basic rich clipboard text via the context menu or `F2`.
- Added keyboard record deletion (`Delete` on Windows, `Backspace` on macOS) in the focused main panel.
- Added a separate Mac App Store packaging and update-handoff build path.

### Changed

- Improved rich-text card and Space preview contrast across light and dark themes while preserving copied text colors, backgrounds, and highlights.

### Fixed

- Improved Windows Excel clipboard capture recovery for delayed data and transient native read errors.
- Fixed Windows Word image capture, mixed text-and-picture records, thumbnail visibility, and consecutive picture deduplication.

## 1.6.3 - 2026-10-20

### Added

- Allowed recording `Win + V` as the main-window shortcut on Windows to take over Windows clipboard history while vPaste is running, restoring the system shortcut when changed or exited.
- Added optional launch-at-sign-in support for the Windows Portable edition via a separate current-user startup entry.

### Fixed

- Displayed the Windows key as `Win` instead of `Command` in recorded shortcuts on Windows and fixed `Win + V` recording and recovery edge cases.

## 1.6.2 - 2026-10-15

### Changed

- Redesigned Settings → About with a compact header card and a single unified check/download/install update button.
- Consolidated release metadata (licenses, SBOM, updater signatures, and `latest.json` snapshot) into one ZIP and added an English-first bilingual download table at the end of release notes.

## 1.6.1 - 2026-10-13

### Added

- Added a download-only Universal macOS DMG (Apple silicon and Intel) alongside per-architecture DMGs and updater packages.

### Changed

- Refined update entry points and Settings → About update presentation.
- Allowed public Windows tag releases without an Authenticode certificate while retaining updater signatures, artifact-integrity checks, and an explicit publisher warning.

### Fixed

- Removed the unused MQTT dependency and updated updater TLS dependencies to patched releases.
- Fixed macOS rich-content previews failing to cache images referenced by local `file:` URLs, including paths with spaces or non-ASCII characters.
- Derived application version sources from the release tag and hardened macOS signing/notarization and Windows updater signing pipelines.

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
