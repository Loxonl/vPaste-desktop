# vPaste Architecture

## Overview

vPaste is a Tauri 2 desktop client with a Rust native backend, native main panels on Windows x64 (**WinUI 3**) and macOS (**AppKit / SwiftUI**), and a **React 18 + MUI 5 + Motion** frontend for shared auxiliary windows and the `--main-ui=webview` main-panel fallback. The Rust side owns desktop integration, clipboard collection and restoration, local storage, search indexing, image OCR, link preview fetching, filesystem operations, and platform-specific behavior.

## Main Layers

### Native Main Panels (Default in v2.0 RC / `main`)

- **Windows x64 WinUI 3 (`src-tauri/native-demo/windows/winui/`, `src-tauri/src/winui_panel/`)**: compiled with `--features winui`, default in official Windows x64 Release packages when x64 Windows App Runtime 2.6.5+ is available (with automatic fallback to WebView when unavailable). Provides the native main dock, native tray menu popup, native paste queue, native tag/filter editors, native plain-text editor, native OCR reader, and native preview reader for plain text, images, colors, and common files. See [Windows WinUI bridge ownership](development/windows-winui-bridge.md).
- **macOS AppKit / SwiftUI (`src-tauri/native-panel/`, `src-tauri/src/native_panel/`)**: default on macOS Debug and Release builds. Provides the native `NSPanel` / `NSCollectionView` main panel (with Liquid Glass on macOS 26+ and frosted-glass fallback on macOS 11–25), SwiftUI toolbar on macOS 12+ (AppKit fallback on macOS 11), native menu bar menu, and native tab editor. See [macOS native main panel](testing/native-main-panel.md).
- Process-local renderer selection (`src-tauri/src/main_panel_mode.rs`) supports `--main-ui=webview` on both platforms without persisting a backend choice to user configuration.

### Frontend (React WebView & Auxiliary Windows)

- React 18 + TypeScript + Vite + MUI 5 + Motion.
- Routes:
  - `/clipboard` - WebView main history panel (used by Stable v1.7.0, Windows WebView fallback, and `--main-ui=webview`).
  - `/clipboard/preview` - auxiliary preview window (always used for rich HTML, live webpages, and PDFs; also used for all previews in WebView mode).
  - `/config` - on-demand settings window (destroyed on close in both native and WebView modes).
  - `/tray-menu` - WebView tray menu (used on Windows in WebView mode).
  - `text-editor.html` - rich-text editor window (and plain-text editor in WebView mode).
- Key areas:
  - `src/clipboard/Clipboard.tsx` - WebView panel shell, tabs, search, selection, keyboard control (product reference).
  - `src/clipboard/Item.tsx` - item card rendering and right-click actions.
  - `src/clipboard/Preview.tsx` - image, text, rich text, file, OCR, and link preview.
  - `src/config/Config.tsx` - settings and preferences.
  - `src/lang/` - language packs.

### Tauri / Rust Backend

- `src-tauri/src/main.rs` registers windows, tray/menu bar behavior, global shortcuts, Tauri commands, updater, config, and app lifecycle.
- `src-tauri/src/main_panel_mode.rs` coordinates process-local renderer selection (`native`, `winui`, `webview`) and safe WinUI-to-WebView fallback.
- `src-tauri/src/clipboard/` owns history records, plaintext storage, cleanup, archive transfers, link previews, image OCR, and restore logic.
- `src-tauri/src/clipboard/windows/` and `src-tauri/src/clipboard/macos/` contain platform-specific clipboard code.
- `src-tauri/src/search/` owns Tantivy indexing and queries (including recognized OCR text).
- `src-tauri/src/config/` owns persisted settings and shortcut normalization.

## Data Flow

```text
Native clipboard event
  -> platform listener
  -> format probe and classification
  -> content extraction
  -> local storage/database
  -> search index update
  -> frontend history refresh
  -> user selects item
  -> restore clipboard formats
  -> optional paste into previous focused app
```

## History Data

History supports the plaintext v1.6.0 baseline and v3 archives. See
[History storage compatibility](history-storage.md) for the supported boundary.

History consists of metadata plus local assets:

- SQLite metadata.
- Text or long-text payloads.
- Images, screenshots, rich HTML/RTF/PNG payloads.
- Link preview title and image/icon cache.
- Source app metadata and icon cache.
- Custom tabs and user-facing organization data.
- Search index.

File history normally stores source paths. It does not copy original files unless a feature explicitly exports or packages them.

Automatic cleanup is disabled by default. Settings can retain ordinary history by
age (days since the last copy/use) or by count, with one rule active at a time.
Favorites and tagged records are excluded from both deletion and the count limit.
Editing a rule only changes a draft; applying it previews the eligible count and
requires confirmation. Disabling takes effect when the setting is saved.

The native worker checks at startup, after new records or rule changes, and hourly.
Requests are coalesced on a five-second interval and deletion is limited to 256
records per batch. It rereads the saved policy before each batch, defers while
history capture, settings writes, transfers, or paste operations are active, and
refreshes the history UI after deletion. Cleanup shares the manual path's asset
ownership checks, including queue and undo references; original user files are
never deleted. Enabling a rule only updates the in-memory configuration after
the configuration file is successfully persisted.

## UI Principles

- Main panel is a fast bottom floating panel.
- Keyboard-first operation must remain smooth.
- Cards should preserve type-specific previews instead of collapsing into plain text.
- Search, tabs, preview, and right-click actions should not block scrolling or selection.
- Rich previews should be useful but resilient when source websites, files, or formats are unavailable.

## Cross-Platform Boundary

Shared code should handle:

- Core item model.
- Search and filtering.
- UI rendering and language packs.
- Storage model where possible.
- Generic link preview logic.

Platform modules should handle:

- Clipboard listener and format extraction.
- Clipboard restore/write-back.
- Source app and icon detection.
- Global shortcuts and focus behavior.
- Tray/menu bar integration.
- Launch at login.
- Packaging, signing, and updater differences.

## Security And Privacy

- The app is local-first.
- System-marked sensitive clipboard content should be skipped where supported.
- Secrets, signing keys, private tokens, databases, logs, and local history must not be committed.
- Plugin/script command features must be permissioned before any community extension system is enabled.
