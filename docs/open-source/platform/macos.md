# macOS Platform Notes

## Current Status

macOS is a supported desktop platform targeting **macOS 11 Big Sur or newer** across Apple silicon (`aarch64`), Intel (`x86_64`), and Universal direct-download DMGs, plus a separate Mac App Store build path (macOS 13+).

In v2.0 RC / `main`, macOS defaults to the native **AppKit / SwiftUI main panel** (using Liquid Glass on macOS 26+ when built with a compatible SDK and `NSVisualEffectView` frosted glass on earlier versions), a **native menu bar menu**, and a **native tab editor**, while retaining `--main-ui=webview` as a per-launch fallback. See [macOS native main panel](../testing/native-main-panel.md) for detailed architecture and behavior notes.

The macOS implementation uses native platform APIs where required instead of forcing Windows clipboard or tray assumptions into shared code.

## Implemented Capabilities

- Native AppKit / SwiftUI bottom floating main panel (default in Debug and Release), with `--main-ui=webview` fallback.
- Native menu bar menu for Show/Hide, Pause/Resume capture, Update and restart, Settings, and Quit.
- `NSPasteboard` clipboard listener and restore for plain text, rich HTML/RTF, images/GIFs, colors, and Finder files/folders/multi-file items.
- Source app attribution via `NSWorkspace` (with Universal Clipboard remote-item detection).
- Image OCR (editable side-by-side and searchable in history), saved-text editing (`F2`), favorites, tags, custom filter tabs, paste queue, and native `NSDraggingSession` external drag.
- Active Space / fullscreen app support and Accessibility-guided automatic pasting (with manual `⌘ + V` fallback notice).
- Developer ID signed and notarized DMG + `.app.tar.gz` updater releases, plus a separate sandboxed [Mac App Store build](../mac-app-store-build.md).

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
- Rich HTML previews resolve local `file:` URLs with macOS path separators and URL decoding, then cache readable images inline so previews survive removal of the source file. Windows drive-path handling remains platform-specific.
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

Local ad-hoc `.app` / `.dmg` packaging is available through `npm run build:macos`. The public Release workflow (`.github/workflows/tag-release.yml`, running on `macos-15`) signs, notarizes, staples, and verifies every DMG and updater archive using credentials stored in the protected GitHub `release` environment:

- Apple Developer account.
- Developer ID Application certificate.
- Notarization.
- Stapling.
- Gatekeeper validation.

### Updater

Stable builds use `https://vpaste.app/download/stable/latest.json`; RC builds use the separate `https://vpaste.app/download/rc/latest.json`. Each manifest contains separate `darwin-aarch64` and `darwin-x86_64` entries pointing to signed `.app.tar.gz` packages. The tag release workflow merges those entries with the Windows updater fragment; it writes the combined `latest.json` to `Loxonl/vPaste-website` under `download/<channel>/latest.json` after verifying every package (see [update-feed-publication.md](../releases/update-feed-publication.md)). The app downloads, verifies, and caches an available package in the background, then exposes one “Update and restart” action in settings, the main panel (a round blue sync icon right of the settings button that asks for confirmation first), and the menu-bar/tray menu. That action re-verifies the cached bundle, installs it with the Tauri updater, and restarts the app. After a restart, the first successful manifest check restores the cached bundle without downloading it again; while offline the bundle is kept but not offered. Installation behavior must still be smoke-tested on both architectures before a public Release is published.

## Platform Risks & Watchpoints

- Clipboard format names and priority differ from Windows.
- Finder file copy and drag semantics differ from `CF_HDROP`.
- App focus, Liquid Glass / frosted-glass appearance, and overlay window behavior require macOS-specific verification across active Spaces and fullscreen apps.
- Menu bar apps have different user expectations than Windows tray apps.
- Notarization and code signing introduce a separate release pipeline.
- Accessibility permissions affect automated paste and focus restoration.

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
