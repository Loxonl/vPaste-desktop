# macOS Adaptation Plan

## Goal

Bring vPaste to macOS while preserving the core product model: local-first clipboard history, visual cards, search, favorites, custom tabs, preview, and keyboard-first workflows.

The macOS implementation should be native where the platform requires it. Do not force Windows clipboard or tray assumptions into shared code.

## First Milestone

The first milestone should be small and verifiable:

1. App starts on macOS.
2. Main panel opens with a global shortcut.
3. Plain text clipboard history works.
4. Image clipboard history works.
5. File path history from Finder works.
6. Search and activate/paste work.
7. A local unsigned dev build can be produced.

Do not start with notarization, full rich text fidelity, or plugin architecture.

## Platform Areas

### Clipboard Listener

Use `NSPasteboard` and change count polling or a reliable platform watcher. macOS does not expose clipboard events the same way as Windows.

Initial target formats:

- `public.utf8-plain-text`
- `public.html`
- `public.rtf`
- `public.png`
- `public.tiff`
- `public.file-url`
- Finder file promises and file URL arrays if applicable.

Current implementation notes:

- The listener polls `NSPasteboard.changeCount` to process each clipboard change once.
- Finder file URLs and legacy filename lists are detected before plain text so copied files, folders, and multi-file selections stay as File records.
- `public.html` and `public.rtf` are read before plain text so rich table/link/color snippets are stored as rich records instead of flattened text.
- Plain text and image capture remain fallbacks when no supported file or rich format is present.

### Clipboard Restore

Restore should preserve semantic type:

- Text as text.
- Rich text as HTML/RTF when available.
- Images as PNG/TIFF or file representation when needed.
- Files as Finder-compatible file URLs.

Current implementation notes:

- Rich records write `public.utf8-plain-text` plus stored `public.html` and `public.rtf` payloads back to `NSPasteboard`.
- File records are restored by writing `NSURL` file objects plus legacy `NSFilenamesPboardType` payloads to `NSPasteboard`, matching Finder-style file paste semantics.
- PNG/TIFF-native rich payload restoration should still be validated separately from normal image paste.

### Source App

Use frontmost application metadata for local clipboard changes:

- Bundle identifier.
- Localized display name.
- App icon.

The listener reads `NSWorkspace.shared.frontmostApplication`, caches the app icon under the runtime `app_icons` directory, and stores the source name/icon through the shared clipboard data model.

If the pasteboard exposes the private `com.apple.is-remote-clipboard` marker, treat the item as a remote synced Universal Clipboard item and do not record frontmost app name or icon. In that case the Mac foreground app is only the receiving context and is not a reliable content source.

### Shortcuts And Focus

Validate global shortcut behavior with macOS accessibility/security constraints. The main panel should receive focus when opened, and user keyboard actions should work without an extra click.

When the main panel is shown from a global shortcut or menu-bar/tray action, vPaste should activate the macOS app, make the panel the key window, and keep clipboard cards clickable with the mouse immediately after wake.

### Menu Bar

macOS should use a menu bar item instead of Windows tray assumptions. Menu item labels and actions should map to:

- Show main panel.
- Settings.
- Quit.

### Launch At Login

Use a macOS-safe launch-at-login mechanism. Avoid Windows startup registry assumptions in shared code.

### Packaging

Public macOS releases target macOS 11 Big Sur or newer. Apple silicon support starts at macOS 11, and Intel/universal release builds use the same `MACOSX_DEPLOYMENT_TARGET=11.0` baseline unless a separate legacy Intel build is explicitly created and tested.

Local ad-hoc `.app` / `.dmg` packaging is available through `npm run build:macos`. The public Release workflow implements the following requirements and will fail until its protected credentials are configured:

- Apple Developer account.
- Developer ID Application certificate.
- Notarization.
- Stapling.
- Gatekeeper validation.

### Updater

Stable builds use `https://vpaste.app/download/stable/latest.json`; RC builds use the separate `https://vpaste.app/download/rc/latest.json`. Each manifest contains separate `darwin-aarch64` and `darwin-x86_64` entries pointing to signed `.app.tar.gz` packages. The tag release workflow merges those entries with the Windows updater fragment and commits the combined `latest.json` to `Loxonl/vPaste-website` under `download/<channel>/latest.json`. The app downloads and verifies an available package in the background, then exposes one “Restart to update” action in settings, the main panel, and the menu-bar/tray menu. That action installs the prepared bundle and restarts the app. Installation behavior must still be smoke-tested on both architectures before a public Release is published.

## Expected Risks

- Clipboard format names and priority differ from Windows.
- Finder file copy and drag semantics differ from `CF_HDROP`.
- App focus and overlay window behavior may require macOS-specific tuning.
- Menu bar apps have different user expectations than Windows tray apps.
- Notarization and code signing introduce a separate release pipeline.
- Accessibility permissions may affect automated paste or focus behavior.

## Recommended Work Breakdown

1. Build and run baseline Tauri app on macOS.
2. Implement text listener and restore.
3. Implement image listener and restore.
4. Implement Finder file URL listener and restore.
5. Implement source app name/icon.
6. Validate main panel focus, outside click behavior, and keyboard navigation.
7. Add macOS settings differences.
8. Validate local `.app`/`.dmg` packaging.
9. Configure and validate the protected signing/notarization environment.
10. Validate clean install and updater flow on both architectures.

## Verification Matrix

At minimum, test:

- Copy/paste text from Safari, Chrome, Notes, TextEdit, Finder file names, and terminal.
- Copy/paste rich HTML table content from a browser or another public HTML sample and verify vPaste shows the rich label instead of a plain Text card.
- Copy image from browser and screenshot tool.
- Copy a file and a folder from Finder.
- Open panel via global shortcut.
- Click a clipboard card with the mouse immediately after opening the panel.
- Navigate items with keyboard.
- Preview text and images.
- Restore clipboard into Notes, browser input, and a chat app.
- Quit and restart without losing history.
