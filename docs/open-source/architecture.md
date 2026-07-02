# vPaste Architecture

## Overview

vPaste is a Tauri 2 desktop client with a React UI and Rust native backend. The frontend owns presentation and interaction state. The Rust side owns desktop integration, clipboard collection and restoration, local storage, indexing, link preview fetching, filesystem operations, and platform-specific behavior.

## Main Layers

### Frontend

- React 18 + TypeScript + Vite.
- Routes:
  - `/clipboard` - main history panel.
  - `/clipboard/preview` - preview window.
  - `/config` - settings window.
  - `/tray-menu` - custom Windows tray menu.
- Key areas:
  - `src/clipboard/Clipboard.tsx` - panel shell, tabs, search, selection, keyboard control.
  - `src/clipboard/Item.tsx` - item card rendering and right-click actions.
  - `src/clipboard/Preview.tsx` - image, text, rich text, file, and link preview.
  - `src/config/Config.tsx` - settings and preferences.
  - `src/lang/` - language packs.

### Tauri / Rust Backend

- `src-tauri/src/main.rs` registers windows, tray/menu bar behavior, global shortcuts, Tauri commands, updater, config, and app lifecycle.
- `src-tauri/src/clipboard/` owns history records, storage, cleanup, migration, link previews, encryption helpers, and restore logic.
- `src-tauri/src/clipboard/windows/` and `src-tauri/src/clipboard/macos/` contain platform-specific clipboard code.
- `src-tauri/src/search/` owns Tantivy indexing and queries.
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

History consists of metadata plus local assets:

- SQLite metadata.
- Text or long-text payloads.
- Images, screenshots, rich HTML/RTF/PNG payloads.
- Link preview title and image/icon cache.
- Source app metadata and icon cache.
- Custom tabs and user-facing organization data.
- Search index.

File history normally stores source paths. It does not copy original files unless a feature explicitly exports or packages them.

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
