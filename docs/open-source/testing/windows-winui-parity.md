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
| Space/hover preview, editing and OCR | Existing React preview window plus selection/edit flows | WinUI `Reader` handles supported text, image, color and simple file payloads; unsupported rich HTML/PDF and oversized payloads retain the existing WebView reader fallback. Native reader stays on one HWND while content and geometry transition. |
| Settings | Existing React/MUI window, destroyed on close | No migration in this batch |
| macOS and release | Independent native UI; WinUI remains Debug opt-in | No macOS UI, installer, release or workflow changes |

## Visual and native-control audit — 2026-11-14

The comparison available in this repository is the shipping React 18 WebView,
not a Vue implementation: `src/clipboard/ClipboardHeader.tsx` and
`Clipboard.module.css`. No Vue source or the previously uploaded
Files/PowerToys research Markdown was present in this checkout. This review
uses the checked-in React implementation and current Microsoft documentation;
it does not claim to have compared a separate deployed Vue build.

| Surface | Checked-in WebView | WinUI implementation | Finding |
| --- | --- | --- | --- |
| History card | 220×230px, 48px header, 54px source icon, 14px radius; selected state is a 2px accent outline with 2px offset | Same DIP geometry and custom XAML card surface inside a native `ListView` | Duplicate `ListViewItemPresenter` chrome was suppressing the card's rounded state. Normal themes now use the card surface for hover/selection; high contrast restores system presenter visuals. |
| Tabs and filters | `All`, `Favorites`, then saved filters and record tags; selected item uses a 3px underline | Native `SelectorBar` for `All`/`Favorites` and saved tabs; five content-type choices stay in the existing filter flyout | The SelectorBar pill/transition is an intentional Fluent visual difference. Keeping type choices in the flyout preserves the compact shipping tab strip while retaining the native type-filter shortcut. |
| Menus and confirmation | Shared React overlay/dialog primitives | `MenuFlyout`, `Flyout`, and `ContentDialog` | Native placement, dismissal, focus return and system corner treatment intentionally follow WinUI. |
| Queue and tag rows | React component/CSS layout | `ScrollViewer`/`StackPanel` rows with native buttons and menus | Custom row composition supports the ordered queue, drag insertion, inline tag editing and focus restoration. Queue is capped at 100; virtualization is not changed without profiling evidence. |
| Rich content and preview | WebView renders broader HTML/PDF/OCR cases | XAML `Grid`, `Border`, `TextBlock`, `Image`, and native controls in `WinUiReader`; established renderer remains fallback for rich HTML/PDF, unsupported payloads and oversized bridge messages | No generic WinUI card represents clipboard content, so history cards and preview bodies are intentionally composed from native XAML primitives. The fallback preserves unsupported WebView rendering rather than approximating it. |
| Settings | React + MUI, created on demand | Same existing WebView | Intentionally unchanged and behavior-identical. |

The native control inventory matches WinUI Gallery's intended roles: `SelectorBar`
for a small set of mutually exclusive views, `ListView` for the history
collection, `CommandBar`/`AppBarButton` for toolbar commands, `ComboBox`/`TextBox`
for selection and text entry, `GridView` for the emoji picker, `MenuFlyout` for
contextual actions, `ContentDialog` for destructive confirmation, and `InfoBar`
for non-modal feedback. The ordered 100-item queue uses a `ScrollViewer` with
custom row composition to retain its explicit drag insertion and reorder model;
changing it to a virtualized list requires profiling and dedicated reorder
regression first. The clipboard card and preview content are product-specific
XAML compositions, not web controls masquerading as WinUI.

References: [Microsoft SelectorBar guidance](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/selector-bar),
[item containers and templates](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/item-containers-templates),
[WinUI Gallery ListView sample](https://github.com/microsoft/WinUI-Gallery/blob/main/WinUIGallery/Samples/ListView/ListViewPage.xaml),
[Files source](https://github.com/files-community/Files), and
[PowerToys WinUI migration guidance](https://github.com/microsoft/PowerToys/tree/main/.github/skills/wpf-to-winui3-migration).

Local verification (2026-11-14):

- `npm run check:styles`, `cargo fmt --all --check`, and 782 frontend unit tests
  passed. The six release-asset shell tests could not run cleanly on this host:
  default `bash` resolves to unavailable WSL, while process-local Git Bash does
  not include `jq`; the other 782 tests pass when that environment-specific
  shell fixture is excluded. CI's Linux runner remains the verification path for
  those six release-script tests.
- `cargo check --features winui-debug --bin vPaste --quiet` passed and compiled
  the Windows WinUI native DLL. The focused Rust filter projection test passed.
- The actual XAML regression now covers the compact primary tab strip, native
  type-filter entries, normal-theme card surface and high-contrast system
  selection restoration (stage 131), but was not run because its ignored smoke
  test requires an interactive desktop. Physical pointer, focus, multi-select
  and contrast-theme presentation remain manual checks.
- No Actions were dispatched or changed. The attached historical research file
  was not available locally; references above are live Microsoft/Files/PowerToys
  sources, not a claim that the attachment was read.

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
