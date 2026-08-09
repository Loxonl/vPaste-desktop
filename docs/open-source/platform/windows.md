# Windows Platform Notes

## Current Status

Windows is the primary implemented and tested platform.

## Implemented Capabilities

- Tauri 2 Windows desktop app.
- Inno Setup current-user installer, Portable ZIP, and Tauri updater artifacts.
- Global shortcut to open the main panel.
- Bottom floating main panel with keyboard navigation.
- Custom tray menu in Chinese/English language flow.
- Local clipboard history for text, links, colors, images, screenshots, files, folders, multi-file items, HTML, RTF, and PNG-rich clipboard payloads.
- Image and screenshot cards with preview and resolution overlay.
- File/folder cards with path display, source existence checks, and path actions.
- Favorites and custom filter tabs.
- Search, including cached link titles.
- Preview window for text, rich text, images, files, and links.
- Paste recovery restores the previous foreground window and uses native `SendInput` for Ctrl+V.
- Settings window with language, theme, shortcuts, personalization, data migration, cleanup, and update checks.
- Export/import history.
- Local-first storage and basic sensitive clipboard protection.
- App source icon capture and card header color extraction.

## Known Limitations

- Dragging image history items into some external chat/note apps is still not fully reliable.
- Some Office, OneNote, browser, QQ/WeChat, and GIF clipboard combinations need real-app regression testing after clipboard changes.
- Link preview depends on public site metadata and may fall back to the default link icon.
- Updater signature verifies package integrity, but Windows SmartScreen trust still depends on code signing reputation.
- Windows installers are currently distributed without Authenticode signing and can show Unknown publisher or SmartScreen warnings.

## Windows Clipboard Notes

Important formats and concepts:

- `CF_UNICODETEXT`
- `CF_TEXT`
- `CF_HDROP`
- `CF_DIB`
- `CF_DIBV5`
- `PNG`
- `HTML Format`
- `Rich Text Format`
- Windows privacy markers such as `Clipboard Viewer Ignore`, `ExcludeClipboardContentFromMonitorProcessing`, and `CanIncludeInClipboardHistory=0`.

Implementation expectations:

- Do not classify file lists as plain text just because file paths are also present.
- Do not let HTML clipboard headers become visible card text.
- For browser image copies, continue probing bitmap formats when HTML only describes an image.
- Treat very long text as text semantically even if stored in an asset file internally.
- Refresh duplicate items by recency instead of silently ignoring the copy.
- When pasting a selected history item, record the foreground window before showing vPaste, restore it after hiding vPaste, then send native Ctrl+V. Browser page inputs are more focus-sensitive than address bars or chat boxes.

## Windows Release

The reproducible Windows packaging and signing process is documented in [Windows Release Flow](../releases/windows-release-flow.md).
