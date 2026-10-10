# Clipboard Test Cases

Use these cases for platform clipboard changes and release regression checks. Prefer real applications over synthetic-only tests.

## Manual Regression Suite

The public checklist below is self-contained and should be run with vPaste open on the target platform. It covers:

- Plain, multilingual, long, command, Markdown, checklist, and Unicode text.
- Links with normal URLs, release URLs, query parameters, and hashes.
- HEX, RGB/RGBA, HSL/HSLA, and named CSS colors.
- Rich HTML fragments for Excel-like tables, OneNote-like notes, chat messages, web articles, Word-like paragraphs, email digests, and code review snippets.
- Generated small, wide, tall, transparent PNG images, plus a generated GIF.

File/folder, window keyboard flow, import/export, and release installation checks are manual because browsers cannot reliably write native file-list clipboard formats.

## Core Text

- Copy short English text from Notepad/TextEdit.
- Copy Chinese text.
- Copy multiline text.
- Copy very long text.
- Copy text with leading/trailing whitespace.
- Re-copy an old record and verify it moves to the front.

Expected:

- Stored as Text.
- Searchable.
- Restores into a normal input.
- Long text remains semantically Text.

## Links

- Copy `https://www.bing.com`.
- Copy a link with query parameters.
- Copy a link from rich text where the visible text differs from URL.
- Copy a URL from a browser address bar.

Expected:

- Stored as Link when applicable.
- Record appears immediately.
- Title/icon/preview load in the background.
- Search finds cached title.

## Images

- Copy a distinctive text value, then restore several different image records in sequence.
- Copy a screenshot.
- Copy an image directly from a browser page.
- Copy a local PNG file.
- Copy a local JPG file.
- Copy a transparent PNG.
- Copy a GIF.
- Copy a large local image and hold Right Arrow through the main panel history.

Expected:

- Every restored image pastes as that image; the earlier text value must not remain as a fallback clipboard format.
- Image preview appears without blocking the panel.
- Main panel image cards keep using lightweight card previews during keyboard navigation; full-size image data should only load for preview, paste, or export actions.
- Transparent image cards use a clean background.
- GIF animation preservation is best effort and should be documented.

## Files And Folders

- Copy one file from Explorer/Finder.
- Copy one folder.
- Copy multiple files.
- Copy a missing/deleted file record after deleting the source file.

Expected:

- File/folder cards show type, icon/preview, and path tail.
- Multiple files show multi-file state.
- Missing sources show a clear toast or invalid state.

## Rich Content

- Copy formatted text from Word.
- Copy a small Excel table with bold and colors.
- Copy a public HTML table sample with bold text, a link, and a styled color value.
- Copy a OneNote block.
- Copy text + image from QQ/WeChat or another chat app.
- Copy a web article fragment with links and images.
- Preview rich HTML containing a local image whose filename includes spaces, `#`, or non-ASCII characters; remove the source image and open the preview again.
- Copy the same short emoji or symbol, such as `❓`, from Chrome several times.

Expected:

- Plain fallback is not empty.
- Rich text tag is shown where appropriate.
- On macOS, `public.html`/`public.rtf` content is detected before the plain text fallback.
- Preview uses HTML/RTF where available.
- Local file images remain visible in the cached rich HTML preview after the source image is removed, on Windows and macOS.
- Card previews show rich tables at natural width and clip overflow instead of squeezing columns into unreadable vertical text.
- Re-copying the same short emoji or symbol from Chrome updates the existing record instead of creating repeated records caused by volatile rich clipboard payloads.
- Restore preserves rich formats where supported.

## Colors

- Copy `#2F80ED`.
- Copy `#2F80EDCC`.
- Copy `rgb(47, 128, 237)`.
- Copy `rgba(47, 128, 237, 0.8)`.
- Copy `rgb(47 128 237 / 80%)`.
- Copy `hsl(214, 85%, 56%)`.
- Copy `hsl(214 85% 56% / 80%)`.
- Copy `rebeccapurple`.

Expected:

- Stored as Color.
- Card and preview window show a swatch and the original copied value.
- Context menu color conversion shows labeled HEX/RGB/HSL rows with the concrete value visible.
- Selecting a conversion row copies only the value shown after the label.

## Keyboard And Window Behavior

- Open the main panel with the global shortcut.
- Press `Ctrl+F` while the panel is focused.
- Click a clipboard card with the mouse immediately after opening the panel.
- Navigate with left/right.
- Navigate with Tab/Shift+Tab when enabled.
- Open preview with Space.
- Paste with Enter.
- Paste as text with configured shortcut.
- Press Esc to close.
- Click outside to close.

Expected:

- No extra click is required after opening.
- No global shortcut should steal common app shortcuts like Ctrl+F.
- UI remains responsive during navigation and search.

## Paste Queue Rapid Paste

- Enable the paste queue and copy five distinct values in order.
- Hold Ctrl on Windows or Command on macOS and rapidly tap V five times in Notepad/TextEdit and a browser input.
- Repeat while releasing the modifier between presses, then repeat with mixed text and image items.
- In QQ, select and copy `1`, `2`, `3`, `4`, `5` once each; compare with copying five values from a browser.
- Paste the queue into QQ repeatedly. Watch for a consumed item disappearing and returning at the tail; then deliberately copy that value again.
- Hold V without releasing it, test another application's Ctrl/Command+Shift+V, and undo the last queue paste.

Expected:

- Each separate Ctrl/Command+V press consumes the next queue item once, without repeating the current clipboard value or leaving an already-pasted item in the queue.
- Auto-repeat while V stays held does not consume additional items; other paste shortcuts are not intercepted.
- Undo restores the last consumed item, and pasted items remain in history. A failed restore keeps the item in the queue.
- QQ's plain-text and immediately following rich-text phases produce one rich item per copy, in both the queue and history. Different text, source apps, queue sessions, or already-rich formatting variants remain distinct captures.
- vPaste's clipboard restore must not re-enter the queue. A deliberate external re-copy is still captured; no time-based blanket suppression of external copies is used.

Automated Windows coverage replays the plain/rich QQ phases through the buffered worker and database. The native concurrent read/restore test runs in a child process with an isolated window station, so it cannot overwrite the user's clipboard.

## Settings And Migration

- Change language.
- Change theme.
- Export history.
- Import history on a different directory.
- Change history directory.
- Clean old history data.

Expected:

- User history remains usable.
- Exported v3 history archives are plaintext and should be stored securely.
- Toasts appear in the correct location and language.

## Release Smoke Test

- Install over the previous version.
- Verify app name, icon, taskbar title, and process name.
- Verify startup behavior.
- Verify tray/menu bar actions.
- Verify uninstall shortcut.
- Verify settings update check if an update feed is available.
