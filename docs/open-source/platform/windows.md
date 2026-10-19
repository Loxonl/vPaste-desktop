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
- Capture raw snapshots immediately, but allow a plain-text-only snapshot up to 50ms for an adjacent rich-format completion with identical text, source, and queue session. Preserve different copies in order; do not globally deduplicate rich text by its plain fallback.
- Serialize native clipboard reads and restores with the shared process-level clipboard lock. Publish text and the internal marker before releasing it; keep decoding and database work outside this lock. Do not assume `OpenClipboard(NULL)` coordinates our own threads (see the [Windows Terminal clipboard implementation](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/TerminalPage.cpp)).
- When pasting a selected history item, record the foreground window before showing vPaste, restore it after hiding vPaste, then send native Ctrl+V. Browser page inputs are more focus-sensitive than address bars or chat boxes.

## Main-window Win+V Shortcut

In Settings > Shortcuts, record Win+V for the main window to replace Windows
clipboard history while vPaste is running. Choosing another shortcut or exiting
vPaste restores the Windows shortcut. The stored value is `Super+V`; existing
`Command+V` aliases are also displayed as Win+V on Windows. The paste queue cannot
use Win+V, and Command+V remains reserved on macOS.

Win+V uses a second instance of the same executable with `--win-v-helper`, entered
before Tauri, WebView, single-instance checks, or clipboard initialization. This
native helper owns its keyboard hook and tracks physical Windows-key transitions.
Inherited anonymous pipes carry recording modes and captured events. It exits
when the parent closes the pipe; the parent restarts an unexpectedly exited helper
while Win+V is needed. Ordinary shortcuts and the paste-queue hook keep their
existing paths. No registry changes or Explorer restart are needed.

The process separation and physical-key approach were informed by
[Cubby Clipboard's shortcut design](https://github.com/btsouth/cubby-clipboard/blob/d79f1036367a95ef348aed9484f4e608bbabd307/docs/SHORTCUT_BEHAVIOR.md).
vPaste uses its own anonymous-pipe protocol and input state machine.

For a manual regression check, record Win+V, use it to open/close the panel, restart
with the setting saved, then switch back to Alt+V and check Windows clipboard
history. Also check Escape/focus-loss cancellation, both Windows keys, holding
Win between repeated V presses, and an unrelated chord such as Win+E. Physical-key
testing must run without an additional observer hook because that can mask hook
delivery failures. Foreground administrator windows are outside the verified
normal-permission path.

## Windows Release

The reproducible Windows packaging and signing process is documented in [Windows Release Flow](../releases/windows-release-flow.md).
