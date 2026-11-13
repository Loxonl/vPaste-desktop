# Windows WinUI parity: stages 1–3

The reference is the shipping WebView vPaste interface. Fluent/Files inform
native control behavior and materials, not a new layout. This batch builds on
PR #363; it does not repeat the already implemented migration.

## Acceptance criteria

1. **Main-panel composition:** retain the bottom dock, source-colored cards,
   inline tabs and trailing add button. Keep the ordinary toolbar compact.
   Queue selection uses a bounded bottom action bar with a visible count,
   named cancel action and a compact Add button. It must fit 640 logical pixels
   in Chinese and English without resizing the dock or creating a WebView.
   A theme-resource toolbar surface and single bottom edge separate controls
   from content without adding another backdrop or changing native shadows.
2. **Queue interaction:** opening the queue enters selection, matching the
   shipping entry. Closing it exits selection. Adding a batch clears only the
   successfully submitted selection, stays in selection mode, and accepts the
   next batch. Failed or duplicate requests cannot discard the draft selection.
   The existing separate selection command remains available in overflow.
   Leaving selection restores the previous browsing selection when still present,
   without moving the viewport or automatically opening a preview.
3. **Tags and filters:** keep the trailing add menu and above-trigger native
   editors, Emoji direction, draft retention and destructive confirmation.
   Management requests that fail to dispatch must restore the form and show an
   error. Enter during IME composition cannot create or rename a tag.
4. **Behavioral regression:** exercise actual XAML controls with synthetic data,
   plus the existing search/paging, keyboard, editing, menu, preview, drag,
   queue and tag tests. Preserve Rust storage/command semantics and platform
   isolation. Clearly distinguish automated evidence from physical acceptance.

## Parity inventory

| Surface | Current implementation | This batch / remaining verification |
| --- | --- | --- |
| Main dock and cards | Native, shipping geometry and source header composition | Preserve geometry; inspect normal and narrow XAML in both languages/themes |
| Search, filters and paging | Native query generations, viewport restoration, lazy card data | Regress search, stale results, empty/error recovery and keyboard routing |
| Tab strip and add | Mixed saved filters/tags, DB order, trailing add, native editors | Preserve placement, scrolling, current-draft loading and failed-save drafts |
| Queue entry and selection | Independent queue HWND, automatic selection on open and bottom action bar | Retain selection mode after a successful batch; restore the browsing selection on exit |
| Queue operations | Existing Rust capture/add/paste/reorder/remove/clear/Undo | Regress cancel, duplicate/error replies, 100-item scrolling and focus continuity |
| Tag management | Native form, Emoji and confirmations | Recover rejected dispatch and protect IME composition |
| Card actions and external drag | Native menus and system DataPackage; existing Rust actions | Regress payload/state ownership; real target negotiation remains manual |
| Space/hover preview, editing and OCR | Existing on-demand auxiliary renderers | Preserve focus/geometry and no-main-WebView routing; native preview replacement is stage 4 |
| Settings | Existing React/MUI window, destroyed on close | No migration in this batch |
| macOS and release | Independent native UI; WinUI remains Debug opt-in | No macOS UI, installer, release or workflow changes |

## Verification record

Local verification (2026-11-13):

- Style architecture and production TypeScript/Vite build passed. Production
  assets were built to a separate ignored directory so the native Debug assets
  were not replaced by a production build.
- 114 focused frontend tests passed across 20 files, including native UI routing,
  shipping header/keyboard behavior, tags and queue logic.
- 55 Rust/WinUI tests passed with the `winui-debug` feature. The actual XAML
  regression reached stage 116, covering queue entry, repeated selection batches,
  close/selection restoration, rejected or throwing tag dispatch, bilingual
  640/960-DIP action-bar bounds and above-trigger menu placement.
- The new queue test failed at stage 112 before implementation. The new rejected
  tag-dispatch test failed at stage 114 before the recovery fix. An existing
  selection-restoration assertion also caught a regression during development;
  the browsing-selection behavior was restored without weakening that assertion.
- 16 local Playwright cases passed for search/paste, deletion and tab navigation,
  including reduced-motion coverage. Their macOS cases use mocked platform
  routing; they do not establish native macOS acceptance. No Actions were added.
- Inspected actual XAML captures of the main panel and narrow selection layout
  in Chinese/light and English/dark. These captures exclude DWM and native
  backdrop composition, so they do not prove Acrylic, window shadows or DPI.
- Rebuilt and restarted Debug with `--dev-mode --main-ui=winui`. Verified the
  process is responding, uses this worktree's executable and loaded native DLL,
  and has no child processes with auxiliary windows closed. This is an idle
  process check, not a claim about every auxiliary-window lifecycle.

The queue's former primary-toolbar selection/Add commands are replaced by an
automatic selection entry and the bounded bottom action bar. Manual selection
entry remains available in overflow. Successful additions retain selection mode;
failed requests retain the selection. Tag management now recovers its controls
when dispatch returns no request ID or throws a WinRT error, without clearing the
draft. Name-entry handlers ignore IME-processed keys; real composition still
requires the manual check below.

Local logs and synthetic PNGs are under the ignored directory
`src-tauri/tmp/winui-parity-stages123-20261113/`. The work changes only Windows
native presentation, its checks and this record. Settings, macOS implementation,
Rust business commands/storage, installers and release workflows are unchanged.

### Consolidated manual acceptance

1. Open the dock, search, switch categories/tags, scroll and use Enter/Ctrl+C.
   Check the toolbar and cards at the normal width and at a narrow width in both
   languages/themes. The native dock must retain its position and size.
2. Open the queue, select multiple cards and add two consecutive batches. Check
   the selected count, cancel selection and close/reopen the queue. Closing must
   restore the previous browsing selection when that item remains in the list.
   Exercise queue capture, scrolling, reorder, remove, clear/cancel and Undo.
3. Use the trailing + menu, create/edit/cancel a filter and create/rename/delete
   a tag. The menus/editors and Emoji picker should open above the dock. Type a
   Chinese name with the actual IME: accepting a candidate with Enter must not
   submit the form; a subsequent ordinary Enter should submit once.
4. Use Space, preview navigation, text editing, external drag and paste into real
   target applications. Check focus return after each auxiliary window closes.
   Settings should open on demand and be destroyed on close; with auxiliary
   windows closed, the native main panel must not retain a main WebView.

The synthetic host was denied foreground focus for posted Space and some queue
focus assertions; those checks explicitly skip and remain manual. Physical
Windows 10, DWM/Acrylic, external target negotiation, real keyboard/IME input,
100/150/200% scaling, mixed monitors and native macOS have not been accepted by
these automated results. The earlier full-suite isolated-clipboard environment
failure is not reclassified as a pass by this focused run.
