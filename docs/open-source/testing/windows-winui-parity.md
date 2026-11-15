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
   Opening the queue is the selection-mode entry point and closing it exits
   selection, matching the shipping WebView's `pasteQueueActive` state; there is
   no separate selection command in toolbar overflow. Leaving selection restores the previous browsing selection when still present,
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
Files/PowerToys research Markdown was present in this checkout at that time. This review
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
automatic selection entry and the bounded bottom action bar. Opening the queue
is the only selection-mode entry point, matching the shipping WebView. Successful
additions retain selection mode; failed requests retain the selection. Tag management now recovers its controls
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

### Main-panel follow-up — 2026-11-15

- The toolbar now puts Settings last, after the conditional update action, and
  hides the persistent overflow affordance. Copy, paste, favorite, tag
  management and queue selection remain reachable from card actions, the
  trailing tag menu and the queue entry flow. This follows the user's requested
  Settings-last order; the shipping WebView places its conditional update action
  after Settings.
- Category and custom-tag labels are centered through the realized native
  template, with zero vertical padding. The regression measures rendered label
  bounds, not just the assigned alignment properties.
- The tutorial auxiliary window is positioned over the bottom-docked panel area
  on the panel's monitor, with physical-pixel clamping and small-monitor bounds.
  It remains a separate auxiliary window rather than content inside the native
  panel, so its windowing structure is not identical to the WebView tutorial.
- Panel-size preview now updates the WinUI layout without creating a clipboard
  WebView, disables hit testing without activation, and restores the previous
  geometry and visibility on finish/cancel. The XAML regression exercises the
  temporary layout, non-activation, hit testing and restoration.
- Card geometry matches the WebView's 220×230 size, 14-DIP radius and outside
  selection outline. WinUI retains a 1-DIP native surface stroke and ThemeShadow
  elevation (4 DIP at rest, 8 DIP on pointer hover); WebView uses a subtle CSS
  shadow without a separate hover elevation. Those remaining material
  differences require visual review.
- Manual checks still required: actual WinUI layout at 100/150/200% scaling and
  mixed-DPI monitors, bottom-panel tutorial placement, toolbar narrow-width
  behavior, and selected/hovered card appearance in light/dark themes.

### Rendered parity and settings audit — 2026-11-15

This record supersedes the earlier padding-only tab approach and the November 14
statement that the native selection pill was intentional. The pinned WinUI template has two
Auto rows: setting outer content alignment did not center its rendered label.
The realized template now uses the full 48-DIP header height, with one shared
3-DIP composition underline. Built-in and custom tabs have 8-DIP gaps, bounded
single-line labels, automatic selected-tab scrolling and a trailing 36-DIP add
button. The regression measures actual template bounds across Chinese/English,
light/dark and 640/960-DIP headers; the padding-only version failed by 14 DIP.

The outside card outline also supersedes the earlier overlay-only geometry:
the selected border is 2 DIP thick with a 2-DIP gap, and its outer radius is
18 DIP around the unchanged 14-DIP card. It occupies a separate non-interactive
sibling beside the card's rounded content, with an explicit gutter. An outline
inside that content could have correct bounds yet be clipped away; regression
coverage therefore checks rendered pixels as well as bounds and stable content
position. Ordinary selection and keyboard focus share this outline; contrast
themes retain the native system selection/focus presentation.

The supplied Files/PowerToys research document was available and consulted in
this audit. It remains a reference for native controls, visible-item loading,
focus and physical geometry; it does not replace the shipping vPaste layout or
override the pinned SDK. No SDK or framework upgrade is part of this change.

#### Settings-to-native matrix

| Setting or operation | Existing owner / native consumer | Result of this audit |
| --- | --- | --- |
| Language and system/light/dark theme | Config save events; `apply_language`, `apply_theme`, XAML theme resources | Retained. Language/theme apply to native controls and are reapplied on show. |
| Main-panel height | `panel_size` preview session; native canonical `PanelLayout` | Added a synchronous native-only preview route. It snapshots geometry/visibility, shows without activation or hit testing, and restores before save/cancel. Existing settings commands and config shape are unchanged. |
| Retain search, category and position | `behavior::from_config`; `PrepareMainShow` and history viewport state | Retained, with Rust projection and native fresh-show/search/viewport regressions. |
| Single/double-click paste, quick input, Tab selection and plain-text shortcut | Existing config projection; native click/key routing | Retained; normal control editing, menus and IME composition retain key ownership. |
| Hover preview | Existing preference; native hover timer and Rust preview session | Retained. Manual/pinned preview protection and cancellation remain in the same session owner. |
| Automatic link preview | Existing `BackgroundResources` preference, cache and cancellation | Connected native visible-card requests and visibility to this service; query changes reset its link view. Config changes refresh card data. No independent fetcher was added. |
| OCR and completed clipboard resources | Existing OCR/resource workers and Tauri notifications | Native refresh now also receives notifications addressed to the absent clipboard WebView and OCR completion. |
| Import, clear and storage-directory changes | Existing Rust data operations; `history-reset` | Native reset now cancels the old preview, clears the previous dataset's queue-selection draft, reloads tag/filter metadata and requests fresh history rather than retaining old rows. |
| Saved filters changed outside the native editor | Existing `custom-tabs-changed` event and stored filters | Added native metadata reload for events addressed to the clipboard WebView. |
| Privacy, capture filters, retention/cleanup, startup, tray and updates | Existing Rust capture, storage, shortcut, startup, tray and updater services | Still owned by those services. The native UI uses their existing results/events; no parallel settings store or business rules were introduced. |
| Settings window lifetime | Existing auxiliary-window creation and close/destroy path | Retained React/MUI settings created on demand; no resident main WebView was introduced for these fixes. |

#### Workflow audit

| Workflow | Code and automated evidence | Physical acceptance still needed |
| --- | --- | --- |
| Auto-hide and focus return | `focus.rs` delayed/generation-checked blur; protects internal windows, drag, modal and pinned preview | Actual outside click, foreground paste target and auxiliary close/reopen |
| Search/filter and selection | Stale-query protection, Enter cancellation, IME key ownership, lazy detail requests, mixed tab order and viewport restoration | Real IME and pointer/keyboard comfort at different scale factors |
| Queue | Existing Rust state; native batch selection, duplicate/error preservation, reorder/remove/clear/Undo and 100-item lifecycle checks | Real capture/paste target and dragging |
| Card menu, editing and external drag | Existing authoritative Rust actions and native `DataPackage`; complete file/image payload and source-state tests | Explorer, OneNote and other actual targets; clipboard format negotiation |
| Preview | Versioned Rust session, native reader reuse, navigation and physical owner-relative geometry; existing rich HTML/PDF fallback | Held Space, rapid arrow navigation, hover/pinning and focus on real windows |
| Motion and monitor placement | Single native dock-motion owner, shared tab indicator, animation-disabled branch, physical geometry/DPI-context restoration and interrupted-slide tests | Windows animation setting, 100/150/200%, negative-origin/mixed-DPI displays and display removal |

#### Remaining visual/architectural decisions

- Onboarding now opens in the bottom-panel area on the native panel's monitor,
  reusing the shipping tutorial and shortcut-practice logic. It remains a
  temporary auxiliary WebView, not an inline reproduction of the full shipping
  header/filter composition. Fully native or inline onboarding is a separate
  design decision; it must not recreate a resident main WebView.
- Native `AutoSuggestBox`, flyouts, dialogs, editing controls and queue
  checkboxes retain Windows interaction and focus behavior. Their exact glyphs,
  typography and checkbox placement need not mimic browser pixels. The dock,
  actions, cards and tab hierarchy still follow the shipping interface.
- Card ThemeShadow elevation remains 4 DIP at rest / 8 DIP on hover. Real DWM
  window shadows and backdrop appearance require desktop review; XAML bitmap
  captures do not include the complete OS composition.

#### Local verification for this batch

- Style architecture, TypeScript/Vite production build, Rust formatting,
  default Windows `cargo check`, WinUI `cargo check` and the actual WinUI Debug
  executable/DLL build passed. Production frontend output was kept in the
  ignored evidence directory rather than replacing the Debug frontend assets.
- The WinUI Rust module suite passed 60 tests; its two desktop-dependent tests
  were then run separately and passed on the real Windows App SDK: shell stage
  18 and history/queue stage 131. The two shared panel-size config tests also
  passed in the default Windows build.
- Failing-first checks reproduced the 14-DIP tab-label offset, outside outline
  geometry, invisible/clipped outline pixels, and stale history-reset queue
  selection. The corrected rendered outline matched the actual theme accent.
  The broader native suite caught an intermediate selection-content cast after
  the outline became a sibling; selection now uses item identity/index, and
  the complete queue/history suite passed again.
- Submission verification on `20a5fa7` plus this batch passed all 803 frontend
  unit tests. Six release-upload shell fixtures had initially failed because
  this host resolved `bash` through WSL, which cannot use their Windows temporary
  paths. Re-running with Git Bash and the official Windows `jq` executable
  passed all six, then the complete suite. Only the test-process environment
  changed; release scripts and fixtures were not modified. The five focused
  native-presentation source checks also passed.
- All 30 selected local Playwright cases passed: onboarding in both languages,
  both themes and normal/reduced motion; compact panel-height controls; search
  submission; deletion; and tab/preview navigation. These are browser-based
  checks with Tauri mocks, not proof of physical native focus or macOS behavior.
- Inspected actual XAML captures for header alignment, ordinary/multiple card
  selection and auxiliary editors. Evidence is under ignored
  `src-tauri/tmp/winui-main-parity-20261115/`; no snapshots were auto-approved.
- Windows denied the synthetic test foreground focus for posted Space and some
  queue-focus assertions. Those checks explicitly skipped. Physical keyboard,
  IME, outside-click/focus return, external-app drag, DWM/Acrylic, Windows 10,
  mixed monitors and 100/150/200% scaling remain manual acceptance.
- No GitHub Actions were manually dispatched and no release was published.
  This batch leaves macOS, installers, config formats, databases and the default
  WebView behavior unchanged. The latest macOS native-toolbar work was retained
  by basing submission on `20a5fa7`; the unrelated PR-template edit is excluded.

One consolidated desktop pass should check the tab strip/trailing add menu and
Settings-last toolbar, ordinary/queue selection rings, all three size presets
and cancellation/focus-loss restoration, bottom-panel onboarding/shortcut
practice, then search/Space/queue/paste/drag across the user's normal displays.
Use a disposable history fixture for destructive reset/import checks, not the
user's real history. Physical visual approval remains pending.

### Desktop size-preview and queue-density follow-up — 2026-11-15

This follow-up audits desktop ownership and visible parity after PR 377. It
retains the shipping WebView as the product reference and WinUI's native
control templates, input semantics and hover/pressed feedback.

| Reproduced difference | Correction | Regression evidence |
| --- | --- | --- |
| Selected tab text stayed black/white while the WebView marks it with the accent. | Supply the selected normal-state foreground through Light/Dark/HighContrast theme dictionaries and SDK color resources. Keep the native selected hover/pressed states. | Actual `SelectorBarItem` label foreground is compared with the rendered indicator brush in Chinese/English, light/dark and 640/960-DIP headers. The original failed at shell stage 16. |
| A size preview opened during a hide slide could keep moving or disappear. Display/DPI/work-area notifications, or their later Rust layout reply, could hide a preview whose ordinary dock state was hidden. | Stop and settle the old slide when entering preview. Preserve preview visibility during notifications and after layout replies, without activation or pointer input. Keep the existing Rust draft-size and cancellation/restoration mechanism. | Actual HWND visibility/bounds, stopped timer, disabled hit testing and layout-request/reply path are checked at shell stages 19–20. Each failing path was reproduced before its fix. |
| A queue constrained by a short work area compressed its contents vertically. At 80% density its unscaled minimum width also forced a 450-DIP logical root instead of 360 DIPs. | Derive queue content bounds and native minimum tracking size from both real HWND DPI and panel density. Let the existing Grid/ScrollViewer absorb reduced height. | Stage 21 first measured scale 1.000/0.750, then reproduced the 80% minimum-width mismatch. The test uses synthetic queue records and checks uniform scale, a shorter list viewport and 80/90/100% panel density. |

The focus audit retained the existing delayed, generation-checked blur path:
internal windows, active drag/dialog, protected preview and explicit hide
suppression remain guards. Native preview reuse/navigation and external-drag
ownership are unchanged. The shared Rust layout still supplies physical monitor
bounds and preserves draft size while previewing; no parallel size policy was
introduced.

The constrained-queue check changes only its isolated test HWND dimensions. The
DPI/display checks inject native notifications and apply a simulated layout
reply through the actual exported interface. These are regression evidence,
not physical mixed-monitor acceptance. Real 100/150/200% monitor scaling,
Windows 10/11 DWM shadows/backdrops, external paste targets and IME/focus still
need one consolidated desktop pass.

Local evidence is kept under ignored
`src-tauri/tmp/winui-desktop-parity-polish-20261115/`. No Actions, installer,
release, macOS UI, configuration-format or database changes are part of this
follow-up.

Local verification for this follow-up:

- Style architecture, the five frontend native-presentation contract checks,
  TypeScript/Vite production build and Rust formatting passed. Production
  frontend output used the ignored evidence directory, preserving Debug assets.
- All 60 WinUI/Rust module tests passed. The two desktop-dependent suites ran
  separately on the installed SDK and passed: shell stage 21 and history/queue
  stage 131. The latter includes repeated reader, 36-card and 100-item queue
  lifecycle checks; these synthetic cycles are not release memory benchmarks.
- Actual XAML header, selection-outline and constrained-queue captures were
  inspected. At 100% density the constrained queue retains scale 1.000/1.000
  while its list viewport reduces from 356 to 244 DIPs; 80/90% density keeps
  the normal 360×448-DIP logical content dimensions within rounding tolerance.
- Posted Space and foreground-dependent queue-focus assertions were explicitly
  skipped because Windows did not grant the test foreground focus. Physical
  Space/navigation, external-target drag/paste and focus return remain part of
  the consolidated manual pass.
- The standard `npm run dev:debug -- --main-ui=winui` launcher rebuilt the native
  Debug frontend/executable and passed native asset isolation. The responding
  process was confirmed to load this checkout's rebuilt WinUI DLL.
