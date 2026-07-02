# Clipboard Format Support Matrix

This matrix documents expected behavior across platforms. It should be updated whenever clipboard classification, storage, preview, search, or restore behavior changes.

| Content | Windows Status | macOS Target | Notes |
|---|---|---|---|
| Plain text | Supported | Phase 1 | Preserve text semantics even for long text stored as assets. |
| Unicode text | Supported | Phase 1 | Primary text path. |
| URL/link text | Supported | Phase 1 | Classify as Link when plain/rich content is effectively a URL. |
| Color value | Supported | Later | Detect CSS hex (`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`), RGB/RGBA, HSL/HSLA, and concrete named colors. Color actions show labeled HEX/RGB/HSL conversion values before copying. |
| Screenshot image | Supported | Phase 1 | Windows uses DIB/PNG; macOS likely PNG/TIFF. |
| Browser copied image | Supported with DIB/PNG fallback | Phase 2 | Do not let HTML wrapper block bitmap extraction. |
| Local image file | Supported | Supported first pass | Single copied image files render with image-style previews while staying File records, so restore writes file-list clipboard formats instead of image bytes. GIF files use the original asset for animated previews. |
| Generic file | Supported | Supported first pass | Windows `CF_HDROP`; macOS `public.file-url`, Finder pasteboard items, and legacy filename lists are captured before plain text. Restore writes Windows file lists or macOS `NSURL` file objects plus legacy filename lists. |
| Folder | Supported | Supported first pass | Show folder card and path. |
| Multiple files | Supported | Supported first pass | Show multi-file card and restore as file list. |
| HTML Format / `public.html` | Supported | Supported first pass | Needed for web and Office rich content. macOS captures `public.html` before plain text and writes it back on rich restore. |
| RTF / `public.rtf` | Supported | Supported first pass | Needed for Office/notes fidelity. macOS captures `public.rtf` before plain text and writes it back on rich restore. |
| PNG rich payload | Supported | Phase 2 | Used in mixed/rich clipboard scenarios. |
| Text + image mixed content | Supported | Phase 3 | QQ/WeChat text plus multiple images is supported and should stay in regression tests. |
| GIF | Partial | Phase 3 | Prefer file representation where animation must survive. |
| Office private formats | Partial | Phase 3 | Excel is partially supported through HTML/RTF; Word private formats are not complete yet. |
| OneNote block | Partial HTML/RTF | Phase 3 | Watch leading whitespace and layout artifacts. |
| Sensitive marked clipboard | Supported where markers exist | Phase 2 | Platform privacy markers differ. |
| Source app name/icon | Supported | Supported first pass | macOS uses frontmost bundle metadata for local copies and skips source app capture when the pasteboard is marked as a remote synced Universal Clipboard item. |
| Link title/preview image | Supported | Shared | Background fetch only; must not block copy or UI. |

## Priority Rules

- File lists are not plain text even if paths are present.
- Rich content that is effectively a single URL should be stored as Link.
- Text plus image should not lose either text or image.
- Old duplicate content should refresh recency when copied again.
- Failed link previews should not block the record from appearing.
- Sensitive clipboard markers should win over normal recording.

## Search Expectations

Search should include:

- Plain text.
- Long text fallback.
- URL.
- Cached link title.
- File name and path tail.
- Source app name where available.
- Rich text plain fallback.

Search should not require loading every heavy image/rich asset during typing.
