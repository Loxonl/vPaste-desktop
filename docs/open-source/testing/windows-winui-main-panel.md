# Windows WinUI 3 main-panel MVP

## Native presentation acceptance (local experiment)

### Native name-emoji follow-up

- Share the shipping 112-name-prefix emoji catalog with the WebView. Embed that
  same UTF-8 JSON as a native DLL resource; do not keep a second hand-maintained
  list, fetch a remote catalog or create an emoji WebView.
- Reuse one native Flyout/GridView picker for record-tag creation/rename and
  custom-filter names. Prefer placement above the input, with native selection,
  scrolling, keyboard/focus and theme states. Retain a named 32px trigger beside
  the name and the existing compact typography/spacing and parent layouts.
- Match the existing longest-known-prefix replacement and 'No emoji' rules,
  including keycap/variation-selector sequences. Preserve the rest of the name
  and prefixes that do not match the catalog. Reject an over-limit replacement without truncation;
  choosing changes only the draft, not persistence. Escape/light-dismiss must
  leave the draft unchanged; disabled/unloaded owners must not accept a choice.
- Verify prefix behavior and real native controls with synthetic data; inspect
  Chinese/light and English/dark XAML locally. Actual nested popup positioning,
  physical keyboard navigation, DPI and tag/filter saves remain manual checks.
  Keep native docking, drag, Rust commands, stored formats, macOS and installers
  unchanged. No GitHub Actions or submission in this batch.

Local verification (2026-11-12): 23 Rust/native tests passed; native regression
reached stage 45. The new checks load the embedded catalog, exercise actual
GridView item and clear-button automation peers in the synthetic island, and
verify UTF-16 limits without truncation, disabled/unloaded owner rejection,
no persistence requests on choice, and scrolling to the final catalog item.
39 focused UI-script checks, style architecture, TypeScript/Vite build, Rust
format and whitespace checks passed. The catalog's 112 entries and order were
verified unchanged from the previous TypeScript array. Ten XAML artifacts now
include the picker contents and both consuming editors in Chinese/light and
English/dark; they do not prove native popup chrome, placement or real key input.

The full frontend suite reported 756 passes and 6 release-uploader test failures
with the default WSL Bash interpreting Windows fixture paths. Retesting that
unchanged file with process-local Git Bash passed 2 cases; the remaining 4 were
blocked by missing jq. No release/test sources or persistent environment were
changed. Posted Space still reports a foreground-denial skip in this environment.

Manual acceptance: choose/replace/clear emoji for a new tag, a renamed tag and
a filter; cancel each editor and verify no saved name changes. Check a nearly
20-character name, scrolling, arrows/Enter/Escape and focus return, parent hide/
reopen, both themes/languages and the actual DPI. In particular, the nested
picker must open above the filter editor without dismissing that parent.

### Native custom-filter follow-up

- Show saved custom filter tabs beside categories and saved-record tags. Resolve
  type, source-app, favorite and relative-time conditions through the existing
  Rust history search; keep pagination and optional record-tag composition.
- Add/edit filters in a compact native Flyout above the dock. Reuse system
  TextBox, ComboBox, CheckBox and buttons and shared appearance resources. Keep
  a bounded scrolling form and persistent save/cancel actions; do not resize the
  dock or create a main/editor WebView. Source selection includes saved sources
  even when no longer present in the recent-app list.
- Persist through the existing custom_tabs.json helpers, preserving unrelated
  entries, IDs, order and unknown fields. Cancel never writes; failed save keeps
  the draft; duplicate clicks and stale responses cannot save or close a new draft.
  Deletion requires a separate confirmation and does not delete clipboard items.
- Verify Rust projection/mutations and native control/request routing locally;
  manual review covers popup placement, IME, keyboard and physical DPI behavior.
  Keep drag, native docking, macOS, stored formats and installer paths unchanged.

Local verification (2026-11-12): 23 Rust/native tests and 37 focused script checks
passed, plus style architecture, TypeScript/Vite build, Rust format and whitespace
checks. Five Rust tests cover filter projection, legacy sources, single-entry
mutations, unknown-field/order preservation, invalid/stale edits and storage
failure. Native regression reached stage 43: tab selection/pagination, Ctrl+Tab,
saved-but-no-longer-recent sources, repeated save/delete suppression, stale
responses, retained failed-save drafts and explicit delete confirmation.

Eight XAML review images include the editor in Chinese/light and English/dark.
The synthetic capture host is enlarged only during editor capture, not in the
product. The queue scroll regression now waits for its actual completed
ViewChanged event instead of assuming twelve frames include a timer tick; the
scroll/cancel assertions and product timing are unchanged. Posted Space remains
skipped when Windows denies the test foreground focus. None of these checks
prove physical popup placement, IME or end-to-end disk writes through the UI.

Manual acceptance: use **+ → New filter tab**, save and select a type/source/
favorite/time filter, reopen via right-click or double-click, cancel edits, and
cancel/confirm deletion. Reopen the app to check persistence and exercise
Ctrl+Tab/Shift+Ctrl+Tab across categories, custom filters and record tags. Check
popup placement and scrolling at the actual DPI, plus ordinary drag/Space usage.

### Native drag interaction batch

- History cards use WinUI `CanDrag` / `DragStarting` / `DropCompleted` and the
  system `DataPackage`: text/color as text, links as text + WebLink, rich text as
  text + HTML, files/folders/images as read-only StorageItems, copy only.
  Rust resolves the current history record at gesture time, uses the existing
  file parser, shell-path normalization and PNG/GIF materializer. Do not change
  the validated WebView/OLE path or any macOS path. Do not write the clipboard,
  synthesize a paste, activate the old paste target, move originals or install
  mouse/cursor hooks.
- Preparation is async and bounded. Cancel, early mouse release, stale responses,
  missing files, errors, hide/view change and shutdown must restore source state
  and finish the native deferral exactly once. Defer list refresh while dragging;
  suppress preview focus-follow while an actual drag is active. An accepted drop
  means the target accepted the package, not proof that it saved/pasted the data.
- Configure `AllowedOperations` and `DragUI.SetContentFromDataPackage` inside the
  synchronous `DragStarting` handler, before requesting a deferral. WinUI starts
  its core operation even while data preparation is deferred; configuring that
  visual after the Rust response throws `E_INVALID_OPERATION` (0x800710DD).
  Only populate the data and complete the deferral asynchronously. See the
  [WinUI event lifecycle](https://github.com/microsoft/microsoft-ui-xaml/blob/main/dxaml/xcp/dxaml/lib/DragStartingEventArgs_Partial.cpp)
  and [visual setter restriction](https://github.com/microsoft/microsoft-ui-xaml/blob/main/dxaml/xcp/dxaml/lib/DragUI_Partial.cpp).
- Reuse the private bridge's 4 MiB response budget; oversized drag text/HTML must
  fail explicitly with copy-as-an-alternative guidance, never silently truncate.
- Queue drag starts only at its position/grip area, reorders only a same-queue
  gesture, shows a thin accent insertion indicator, and invokes the existing
  `queueReorder`. Keep keyboard-accessible move menus. Reconcile incoming state
  before committing a drop; do not lose newly captured items or accept a deleted
  source. Cancel leaves ordering unchanged and removes drag feedback.
  Native ScrollViewer edge scrolling supports long lists; cancel stops its
  timer. Original clipboard actions stay disabled during the active gesture.
- Verify prepared payload formats with real native DataPackage views and local
  fixture files; test ordering, stale/cancel/error lifecycles and focus suppression
  without moving the mouse. External targets and system cursors require manual
  acceptance; no desktop automation, Actions, submission or release in this batch.

Interaction design intent: the same clipboard shelf and compact queue, now with
direct manipulation. Keep the existing source-color headers, paper/charcoal
surfaces, 13px content/12px metadata and 4/8/12px spacing unchanged. Only the
dragged source is dimmed; insertion uses the shared Fluent accent brush, with no
new shadows, palette, layout animation or custom pointer. The position area is
the grip; keep native named buttons and the move menu as the keyboard alternative.

### Content and compact management follow-up

- Reuse the macOS experiment's bounded, pure Rust rich-text projection on
  Windows; keep original clipboard HTML/RTF and all copy/paste actions unchanged.
  Render common emphasis, code, copied colors, tables and trusted cached images
  with native XAML, never an additional main/hidden WebView or HTML interpreter.
  Unsupported CSS/layout remains an explicit gap, not full browser parity.
- Keep a readable source-content canvas independent of the application theme.
  Use a dark canvas for predominantly uncovered light text; preserve explicit
  foreground/background pairs and UTF-16 highlight ranges, including emoji.
- Give links separate title/URL text, and files a filename/path/format or
  multi-file count. Retain thumbnail failures as meaningful native fallbacks.
- Match the shipping queue's 360×448 DIP content footprint and compact rows.
  Retain paste, move, remove, reverse, clear/confirmation and undo; move secondary
  row actions into native menus rather than removing them. Click the native item
  button to paste; use the row's more menu/right-click to move, with remove still
  visible. Long labels use one-line ellipsis and a full-content tooltip. The
  former always-visible paste/up/down icon strip is replaced, not duplicated.
  Queue-close guidance is retained in the back button's tooltip. Keep tag management
  compact at 360×420 DIP, with 32px actions and a stretching name field.
  Native interactive resizing keeps at least 360×320 DIP client content so the
  title/actions cannot be squeezed away; lists keep their own vertical scroll.
- These two management views retain a native caption/frame on the existing HWND
  for safe dialog/focus ownership. They are not yet the WebView's in-panel tag
  overlay. Size client content with DPI-aware frame adjustment and restore the
  unchanged dock when leaving either view.
- Check small-window bounds, bilingual/dark/light layouts, native rich controls,
  queue action routing and tag failed-save drafts with synthetic regression tests.
  Render actual XAML previews locally; no Actions or desktop automation.

Component intent: content is the focal point, not management chrome. Reuse the
shipping paper/charcoal reading canvases and source-app colors, quiet single row
edges and Fluent system type. Compact headings are 14px semibold; queue preview
text is 13px with 12px metadata. Use 4/8/12px spacing, 12px management insets,
8px row corners and native control states. Rich source formatting stays distinct
from the app's own typography. No new motion is introduced in this batch.

The visual reference is the shipping **WebView vPaste UI**, not the WinUI Gallery
or a newly designed Windows utility. `ClipboardHeader.tsx`, `ClipboardCard.tsx`,
`Clipboard.module.css` and `tokens.css` own that reference. Files/Fluent guide
native control behavior and platform materials, not replacement information
architecture. Function availability and visual parity are separate acceptance
criteria; passing the former does not close the latter.

This batch targets the existing native history, queue and tag-management surfaces.
It does not migrate settings, the auxiliary preview renderer or the installer,
change existing Rust requests or stored data. The private lazy-card response adds
source icons and normalized colors from the existing Rust parser and icon metadata.

- Keep the approved 302px dock, 220×230px cards and native focus/selection.
  Match the WebView's 48px colored card header, 14px card radius, 8px content
  padding, 13px preview text, 11px header time and 54px source icon treatment.
  Management actions remain 32px with 8px row corners.
- Restore the shipping composition: colored/source-derived header, white title
  and time, large unmasked source icon, content-dominant body and color-value
  overlay. Do not replace these with a generic icon/title/footer card.
- Keep category order, inline user tags, add/manage entry and circular toolbar
  surfaces close to the WebView reference. A native advanced tag-filter flyout
  retains category + tag composition without a permanent extra ComboBox in the bar.
- Share Fluent theme-resource text/surface styles across all three native views,
  retaining one host-owned Acrylic backdrop and opaque reading surfaces.
- Expose card actions through named native buttons and icon-bearing MenuFlyouts;
  preserve existing copy/paste, favorite, tag, editing and queue requests.
- Finish history loading, empty/filter-empty and query-error recovery states,
  and make leaving queue selection directly accessible without opening overflow.
- Give management views a heading, context/count, meaningful empty state and
  native inline feedback. Queue rows show order and localized content types;
  tag add/rename controls keep their keyboard and failed-save draft behavior.
- Verify native layouts, states and request routing with synthetic records;
  reserve final compositor appearance and physical interaction for manual review.

Design intent: an immediately available clipboard shelf, not a settings dashboard.
The domain is copied text, snippets, source apps, collected files, temporary queue
order and reusable tags. Its signature is the bottom-docked horizontal content
shelf. Paper-white/charcoal reading surfaces, Windows accent, muted metadata and
content-type colors provide the palette. Content gets the most space; Fluent
system typography (13px card/queue content, 14px compact management headings,
12px supporting text), quiet single edges and native interaction states
provide hierarchy. Preserve vPaste's colored card headers rather than erasing
its identity. Avoid large decorative shadows and repeated boxed chrome.
Shared styles belong in `WinUiAppearance.h`, not independent page palettes.

Not closed by this batch: pixel-identical complex HTML/rich-text rendering,
WebView-only tab ordering/hiding, native replacement of the
auxiliary preview/settings renderers, and physical mixed-DPI/contrast-theme
acceptance. Keep these gaps explicit; a plain-text fallback is not rich-text parity.

References: [Windows layout](https://learn.microsoft.com/en-us/windows/apps/design/basics/content-basics),
[typography](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography),
[Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic).

The Windows-only Debug experiment builds a WinUI 3 XAML Island window while
keeping clipboard capture, history storage, the tray icon, hotkey handling, and
clipboard actions in the existing Rust/Tauri process. It is the first real-data
vertical slice of the future Windows main panel, not a feature-complete
replacement yet.

## Requirements and launch

- Windows x64.
- Visual Studio 2022 Build Tools with the Desktop development with C++ workload,
  MSVC v143, Windows 10 SDK 10.0.22000 or newer, and MSBuild available to
  `vswhere.exe`.
- The Windows App SDK runtime compatible with the pinned WinUI package.
- Node 24, npm 11, and Rust toolchain required by the regular Debug build.

Close any running vPaste instance first. The standard single-instance behavior
is unchanged, so a second launch may otherwise be forwarded to the already-open
application instead of starting the selected experiment.

From the repository root, run:

```powershell
npm run dev:debug -- --main-ui=winui
```

This builds `vPaste.exe` with the `winui-debug` feature and launches it with
`--dev-mode --main-ui=winui`. The launcher skips Vite entirely for this mode.
It first builds the frontend and embeds those local assets (`custom-protocol`)
for auxiliary readers/editors. A failed frontend or native build stops startup
instead of silently running an older executable. No development server is
required for the auxiliary preview.
The ordinary Windows DEV path remains:

```powershell
npm run dev:debug -- --main-ui=webview
```

If `--main-ui` is omitted, the existing WebView mode remains the default.

## Expected behavior

- The WinUI experiment window appears at startup.
- The main list reads actual records from the existing Rust clipboard-history
  query and shows up to 36 entries at a time as horizontally scrolling cards
  with colored/source-derived headers, time, large source icons and favorite
  markers. Source names remain available through tooltips/accessibility help. Card
  details load on demand as cards enter the virtualized list: text/file/link
  details, tags, image thumbnails, and image dimensions come from existing Rust
  history and media-preview logic.
- Searching filters the Rust query; **All, Favorites, File, Link, Image, Color,
  and Text** switch between the existing history filters; the advanced tag picker can be
  combined with search and content filters; **Load more / 加载更多** reads the
  next bounded page. Text includes text-file records, matching the existing
  main-panel filter behavior.
- The first returned card is selected when no previous selection remains in the
  returned page; ordinary refresh preserves a selected hash that is still in
  that page. This does not move keyboard focus out of search or paste anything.
- Select an entry and choose **Copy / 复制** to write that saved item back to the
  system clipboard. **Paste / 粘贴** uses the existing Rust clipboard-copy,
  foreground restoration, permission check, and paste path. Enter pastes the
  selected item; Ctrl+C copies it. Include file and image entries in manual tests.
- Select an entry and choose **Add favorite / Remove favorite** (or the Chinese
  equivalent) to update its existing favorite state. The history list refreshes
  from Rust after the action.
- Right-click a card for **Copy / Paste / Favorite** actions. Clicking a card
  pastes according to the configured single-click or double-click paste mode;
  Enter and Ctrl+C continue to paste or copy the selected card.
- The card context menu also contains a **Tags** submenu. It offers each
  existing tag as an add/remove action for that item. **Manage tags / 管理标签**
  opens a native view where tag definitions can be created, renamed, and deleted.
- With the history list focused, **Space** toggles the selected item's shared
  preview; holding Space does not repeatedly open/close it. **Escape** closes
  the preview. Left/right moves selection and updates an open, unpinned preview;
  the preview itself routes left/right and Tab/Shift+Tab back to WinUI.
  Ctrl+Tab/Ctrl+Shift+Tab switches built-in filters from either surface.
  Closing the preview returns keyboard focus to the selected native card.
  These preview shortcuts do not consume typing in the search field or Space
  selection in queue multi-select mode.
- Preview placement uses the native owner's monitor work area and DPI, including
  negative-coordinate monitors. It uses a usable adjacent region when available,
  otherwise centers in that work area. Changing content reuses the existing
  readiness-gated preview transition rather than closing/reopening the window.
  Hiding the owner cancels pending work and dismisses an ordinary preview; a
  pinned preview remains, without accepting late work from the hidden owner.
  Switching to queue/tag management dismisses an unpinned preview.
- **Select for queue / 选择加入队列** enables multi-selection; add the selected
  items to the native paste queue. The queue supports paste, remove, move up/down,
  reverse, undo, and clear with confirmation. The queue shares the native panel
  and does not create the Tauri Paste Queue WebView.
- Queue selections preserve their order through background refreshes, filter
  changes, and loading more history. The count includes selected items outside
  the current filter/page. Canceling selection clears them; confirmed history
  deletion removes only the deleted selection, while deletion failure keeps it.
- The panel follows the configured `system/light/dark` theme and English/Chinese
  language for the controls in this slice. Changing either preference while the
  panel is open should update it without restarting the app. Cards use explicit
  readable foreground/surface colors for both light and dark themes, including
  when the OS theme changes in `system` mode.
- On supported systems, the native XAML host uses one system
  `DesktopAcrylicBackdrop`. History, queue and tag management share the same
  transparent canvas brush, while content cards keep opaque readable surfaces.
  The SDK owns inactive, transparency-off, battery-saver and high-contrast
  backdrop fallback. Unsupported systems keep an opaque light/dark canvas;
  no second UI framework or WebView is created. Management views retain a native
  title bar and follow the app's light/dark caption where Windows supports it.
- History uses the shipping panel's borderless, topmost, taskbar-hidden strip:
  the selected display's full physical width, anchored to its bottom edge.
  Rust reuses the shipping monitor-selection policy, 302px base height and saved
  panel-size preference. A native `Viewbox` applies that preference independently
  of monitor DPI; WinUI retains native accessibility text scaling. The layout
  export synchronously applies the bounds before showing, then calibrates against
  the HWND's actual DPI (which can differ from initial Tauri monitor metadata),
  without a main WebView or a visible first-show size correction.
- One 48px header places Search on the left, category/tag filtering in the
  middle (including user tags and an add/manage entry) and queue/settings icons
  on the right. Search expands on click or
  Ctrl+F; empty-field blur collapses it, and Escape clears it and returns focus
  to history. The native `CommandBar` keeps copy/paste/favorite, queue selection
  and tag management in **…**; adding selected items to the queue remains a
  conditional primary action. Queue selection has a direct entry/cancel action;
  Escape cancels it while ordinary Space selection remains native. Status is
  available through a tooltip rather than an extra visible counter; native
  InfoBar feedback shows successful actions briefly and errors until dismissed.
  **Load more /
  加载更多** stays at the end of the horizontal list rather than in a second bar.
- Queue and tag management reuse the same HWND but restore a centered, framed
  management layout (360×448 DIP queue / 360×420 DIP tags, plus a DPI-adjusted
  native frame and bounded to the monitor work area). Interactive resizing has
  a 360×320 DIP client minimum. Returning restores the saved docked client rectangle and history focus.
  DPI, display and work-area changes request refreshed Rust layout; no old
  floating-main-window rectangle is used to size Space previews.
- Both management surfaces use shared 32px named icon actions and one 8px-radius
  row edge. Queue reverse/clear/undo use a native overflow-capable command bar;
  clicking the item pastes, move up/down is in its more/context menu, and remove
  remains directly visible. All retain their existing Rust requests. The
  back button closes the queue using its existing close callback, or returns
  from tag management without changing its data.
- Clear queue and delete tag use shared native `ContentDialog` construction,
  defaulting to Cancel. Clearing affects only the queue; deleting a tag removes
  its associations, not clipboard content. A view unload hides its outstanding
  dialog, and only an explicit Primary result on the still-loaded owner can
  dispatch the mutation. Pending/busy operations disable the primary action.
- Tag creation and inline rename stretch within their rows, retaining the
  existing 20-character input limit and backend validation. Enter creates/saves;
  Escape cancels inline rename and returns focus. Failure keeps the draft; success
  returns to its renamed row. Dialog cancellation does not discard an edit draft.
- Cards keep source/type-colored headers, opaque content and native ListView selection
  and focus visuals. Their shared dimensions are 220×230 logical pixels with
  a 14px outer radius and a one-pixel edge. Header time/source imagery, content,
  tags and dimensions each have a bounded region; there is no separate source
  footer taking space from the WebView-style content area.
- Text cards with a prepared rich payload use native `RichTextBlock` runs and
  local images, with native grids for bounded tables. Common emphasis, code,
  inline colors and highlights survive; CSS classes, complex page layout and
  full browser equivalence are not claimed. Original HTML/RTF stays in Rust.
  Link title/URL and file name/path/count are separate bounded display fields.
- `Alt+V` and the tray show/toggle entry point can hide/show or restore the panel.
  Management title-bar closure retains the existing hide/queue-close behavior.
  Settings uses the existing on-demand auxiliary settings WebView and hides the
  native panel before activating it; it does not create a clipboard WebView.
- The Rust clipboard listener and tray remain active.
- The WinUI mode does not create the main Tauri clipboard WebView or onboarding
  window, and does not start a Vite server.
- The native panel does not create a WebView2 control or the Tauri clipboard
  WebView. The C++/WinRT project still restores WebView2 metadata at build time
  because the Windows App SDK XAML metadata references that type; this does not
  start a WebView2 process at runtime.

To confirm WebView2 is absent, inspect the process tree rooted at this
experiment's `vPaste.exe`; unrelated WebView2 processes from Windows or other
applications are not evidence that vPaste created one.

The local-only native regression test initializes the actual Windows App SDK
and DLL bridge, shows the native shell, and exercises history refresh, single/
multi-selection transitions, non-empty queue updates, nullable undo state,
non-empty/empty tag-result redraws, language/theme/error redraws, selection
restoration across refresh/filter/pagination and deletion success/failure,
repeated view switching, and shutdown using
synthetic records. It does not query user history. Run it from
`src-tauri` on an interactive Windows desktop with the runtime installed:

```powershell
cargo test --bin vPaste --features winui-debug winui_panel::tests -- --include-ignored --test-threads=1
```

This does not start the clipboard service or a WebView. The test is ignored by
ordinary unit runs and is not added to GitHub Actions. Verify rendering and
history behavior manually as described above.
The same test exercises actual native preview key routing (Space repeat,
left/right boundaries, preview-to-list navigation, filter navigation, Escape,
empty history, and multi-selection), without opening a WebView. It does not
replace the real-app auxiliary preview checks below.
It also forces the opaque material fallback in both themes, verifies the shared
canvas in all three views, reattaches Acrylic when the runtime supports it,
checks opaque card content and selection preservation, and closes the real XAML
host. This verifies material ownership, not the compositor's visual output.
It also checks all seven category-to-query mappings, localized command labels,
selection preservation during label refresh, measured 640/960px layouts in both
languages and themes, and card metadata separation with a visible image.
Rust tests compare 80/90/100% panel preferences at 100/150/200% monitor DPI,
including negative monitor origins, against the shipping sizing helper. The
native test applies the physical layout export, verifies matching client/outer
edges without a caption inset, and round-trips both management layouts back to
the original docked rectangle. These are not physical mixed-DPI acceptance tests.
Management checks additionally render 100 synthetic queued items, verify named
compact actions and single row boundaries, and measure both language layouts at
360/640/960px widths. Native dialog construction checks XamlRoot and safe defaults;
it does not replace manual focus/Escape/confirmation and cancellation testing.
Content checks additionally verify native emphasis/code/underline, UTF-16
highlight offsets after emoji, table cells, rich-image containers, local URI
escaping and remote URI rejection. Native automation peers invoke the queue
item's paste and move-menu actions through the real request callback, with
synthetic responses only. File/multi-file/link queue labels are checked without
touching the clipboard.

### Local verification — 2026-11-12 native drag batch

- Native suite: 18 passed, including actual DataPackage text/HTML/WebLink and
  two local StorageItems, rejection of a missing file without a partial package,
  and original input-file preservation. Synthetic XAML regression reached stage
  40. Queue checks cover concurrent captures, deleted sources, cancel, a 100-item
  list and edge scrolling that stops on cancellation.
- Focused UI scripts: 33 passed; style architecture, Rust format and whitespace
  checks passed. Chinese/light and English/dark XAML renders were regenerated.
- Existing Shell drag/path tests: 4 passed (including multi-file CF_HDROP);
  queue data-layer tests: 22 passed. The standard WinUI Debug launcher completed
  the frontend and Rust/native builds and restarted the experiment successfully.
- No external drop target or physical pointer was automated. The posted Space
  test was skipped for foreground denial, as in the preceding batch. Manually
  verify real DragStarting/DropCompleted, system cursors, early release/Escape,
  hide/show and target acceptance before declaring external drag complete.
- Local diagnostics log only stage/count/byte lengths under `[winui-drag]`, not
  clipboard contents. A begin without data-ready narrows preparation; data-ready
  without end narrows the native/target completion path. Preparation errors are
  also surfaced in the native panel.

Manual acceptance for this batch: drag text/link/color to suitable text/browser
targets; single image, single file, multiple files and folder to Explorer and
OneNote; cancel and immediately retry; check ordinary Explorer dragging after
vPaste use. In the queue, drag its left position area up/down and near the list
edges, cancel outside/with Escape, then test keyboard move menus and paste again.
Copy another item during queue dragging and confirm it survives the reorder.
The user, not synthetic tests, confirms actual target insertion and system cursor
behavior. No installer, macOS path, stored format, public Tauri command or CI was
changed for this drag batch.

Reference: [WinUI drag/drop data packages and deferrals](https://learn.microsoft.com/en-us/windows/apps/develop/data/drag-and-drop).

Follow-up for the reported "operation identifier is not valid" error: moved
system visual/operation configuration to the synchronous starting handler.
The call-order contract failed before the fix and passed afterward. All 34
focused script checks and 18 native-suite tests passed; the latter still skip
posted Space when foreground focus is denied. These checks cover the source
contract and prepared packages, not a physical drag gesture or target acceptance.
Manually recheck text/image/multi-file drops and cancel/retry in the rebuilt app.

### Local verification — 2026-11-12 content/layout batch

- `winui_panel::`: 15 passed, including actual XAML regression stage 35.
- Queue data-layer tests: 22 passed; tag request tests: 2 passed.
- Focused native UI script suite: 29 passed; style architecture, Rust format
  and whitespace checks passed.
- The standard `npm run dev:debug -- --main-ui=winui` launcher passed the
  TypeScript/Vite and Rust/native builds and restarted the experimental app.
  A read-only process check found it responding with the WinUI arguments and
  no child processes at idle, before opening auxiliary WebViews.
- Six actual XAML render artifacts were inspected: history, queue and tags,
  Chinese/light and English/dark. A real cached image with spaces, `#` and `%`
  in its filename loaded successfully. Captures exclude compositor Acrylic and
  the native caption/shadow, and are not user-data screenshots.
- The separately posted Space-key test reported `S_FALSE`/skipped because Windows
  did not grant foreground focus. Native key-handler checks passed; real keyboard,
  IME, physical scaling/contrast and Windows 10 checks remain manual.
- The complete frontend unit suite and unrelated clipboard integration suite
  were not rerun for this native-only batch. No CI workflow was changed or run.

Optional local-only XAML render artifacts (synthetic records, no user database):

```powershell
$artifactDirectory = Join-Path $env:TEMP 'vpaste-native-ui-review'
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$env:VPASTE_WINUI_ARTIFACT_DIR = $artifactDirectory
cargo test --bin vPaste --features winui-debug winui_panel::tests::native_history_queue_refresh_and_shutdown -- --include-ignored --test-threads=1 --nocapture
Remove-Item Env:\VPASTE_WINUI_ARTIFACT_DIR
```

Run from `src-tauri`. Ten PNGs cover history/queue/tags/custom filters/name emoji in light Chinese and dark
English. Captures wait for native layout frames and entrance transitions; they
use opaque fallback to capture XAML, not the compositor's Acrylic/native shadows.
They are manual review artifacts, not CI snapshots or proof of physical input.
Optional `sample-*.png` assets in that directory are synthetic test inputs only.

### Native control invariants

- Detach the system backdrop before destroying the native HWND. After
  `DestroyWindow`, the island is disconnected: call its idempotent `Close`,
  but do not set `SystemBackdrop` again during STA cleanup.
- Preview shortcuts use the history list's tunneling `PreviewKeyDown`, before
  `ListViewItem` consumes Space for selection. Keep ordinary typing outside this
  scope and preserve Space selection in queue multi-select mode. Forward the
  native host's `WM_SETFOCUS` to its XAML history surface when that view is active;
  showing/activating an HWND alone does not prove a card has keyboard focus.
- A content switch unloads history. Post focus return again from its `Loaded`
  event when the owner is foreground; focusing immediately after replacing
  `DesktopWindowXamlSource.Content` can fail even though the HWND is active.
- Docking and preview share one physical HWND/monitor snapshot. Read it inside a
  bounded per-monitor-v2 thread DPI scope, restoring the caller's context before
  returning or making Tauri calls. Otherwise an unaware caller can mix virtual
  monitor/window rectangles with the HWND's actual DPI (for example, reading a
  4K/150% monitor as 2560×1440). The failure-path regression checks restoration;
  read-only geometry probes must use the same physical-coordinate context.
- The posted-key regression needs Windows to grant the synthetic window
  foreground focus. If that is denied, it reports `S_FALSE`/`SKIPPED`, not a
  successful keyboard-route verification. The handler-helper tests still run,
  but they cannot prove that a real key reaches the handler. Manually verify
  Space on an activated WinUI window in that environment.
- Refreshing history uses `Items().Clear()`, which also resets selection. Do not
  additionally mutate `SelectedItems` in `Single` mode: WinUI rejects that with
  `0x8000FFFF`, leaving an empty list or terminating an uncaught event handler.
- When changing selection mode, clear selection using the **old actual mode**
  (`SelectedIndex(-1)` for single, `SelectedItems().Clear()` for multiple), then
  update the logical selection flag and `SelectionMode`. `SelectionChanged`
  runs synchronously, so the logical and control modes must stay consistent.
- Rust `Option` fields are JSON `null` when absent. `GetNamedString`'s default
  covers a missing key, not a present null; check the value type before reading
  `undoHash`. Keep the existing Rust state format unchanged.
- Release all XAML owners, including the queue and tag views, on their owning
  STA before closing the XAML manager and COM apartment.
- WinRT `Thickness` and `CornerRadius` are aggregates: one nonzero initializer
  sets only the first side/corner. Use `UniformThickness` / `UniformRadius` or
  four explicit values. Regression checks all four sides, not only TopLeft.
- Management roots are explicitly sized from the current HWND client area / DPI
  after content switches and resize. Otherwise an island can retain the 302px
  dock's old layout slot even though the framed HWND is taller.
- Async local render tests use a named coroutine with owned parameters. A
  capturing coroutine dispatcher lambda can outlive its destroyed closure.
- A XAML control may have only one visual parent. In particular, do not append
  a tag's name to both its details panel and its row. Test non-empty tag data,
  not just an empty manager.
- Keep logical queue selection separate from the visible SelectedItems
  projection. Suppress selection-change handling while rebuilding/restoring
  that projection, and remove a selected hash only on explicit deselection,
  cancellation, successful addition, or confirmed deletion. Failed operations
  must not silently discard the user's choices.

After native changes, manually verify these real-app paths in addition to the
synthetic test: copy text in another app and see it appear in history; select
existing records and add them to the queue; copy again while the queue is active
and see its count increase. The queue remains temporary: closing it clears it,
and opening it does not import all history automatically.

Also check tag create/rename/delete with a non-empty list; select queue items,
copy again externally, change filters, and load more history without losing
those choices. Delete an already-selected history item and verify only that
item is removed from the selection. Synthetic tag tests cover result rendering,
not real button-to-database CRUD or keyboard end-to-end behavior.

For the preview batch, manually check text, rich text, image, link, and file
records; repeated Space; rapid left/right; Escape followed by another arrow;
pinning while switching selections; and hiding/reopening the main panel while
content loads. Check normal and reduced-motion modes, plus mixed-DPI monitors
where available. Confirm the main clipboard WebView remains absent: the
`clipboardPreview` auxiliary WebView appears only on demand. Memory comparisons
after preview use must include that WebView's process tree. This is a shared
WebView preview bridge, not a fully native preview renderer.

For the material batch, inspect light and dark themes in front of a contrasting
desktop/app background, then switch between history, queue and tag management.
Check system Transparency effects on/off, activation between the panel and Space
preview, and minimize/restore. Where available, also check battery saver, high
contrast and Windows 10. System policy may deliberately replace blur with an
opaque surface; do not force transparency or always-active material to bypass it.

For the main-panel presentation batch, check the **…** menu before and after
narrowing the window, and confirm copy, paste, favorite, queue selection/add/open
and tag management remain reachable. Check category and tag filtering, Tab and
arrow-key focus, Ctrl+Tab, Space preview and English labels. Inspect long-text
and image cards with tags/dimensions in both themes. The synthetic measurement
checks do not replace visual review or physical 100/150/200% DPI checks.

For the management batch, paste, move, remove, reverse and undo queued items;
cancel/confirm clearing and verify clipboard history is kept. Create/rename tags
with mouse and Enter, cancel rename with Escape, and cancel/confirm tag deletion.
Check keyboard focus, Chinese IME entry, busy/error feedback and retained drafts.
Close/hide/switch a management view with a confirmation open and check that no
late clear/delete request is sent. Inspect both themes and languages at regular
and narrow sizes, then return to the docked panel and exercise Space again.

## Card action parity batch acceptance

- Text, link and full-length text-file records offer plain-text copy/paste,
  reusing the existing Rust copy/paste pipeline and its in-flight protection.
  File/image records must not be interpreted as plain text.
- File cards offer open/copy containing folder. Color cards offer HEX/RGB/HSL
  from the shared Rust parser. Copied paths/colors follow existing text-history
  recording rules. Assigned tags can be removed together without deleting tags.
- Image cards and single-image file cards offer export through an HWND-owned
  Windows save dialog (PNG/JPEG/WebP/BMP); cancellation writes nothing. Resolve
  the original source again in Rust before exporting. Do not create a main
  WebView for a file dialog. Keep the native dialog's last-folder behavior;
  the existing WebView localStorage export folder is not migrated.
- Image-text reading and rich-text editing continue to open the existing
  auxiliary WebViews on demand; do not replace their editing, IME, revision or
  unsaved-changes behavior with a plain native text field.
- Search understands multiple `tag:name` / `tag:"name with spaces"` tokens and
  composes them with the current category, favorite, custom and record-tag
  filters, including pagination. Search Enter acts on the selected result;
  ordinary typing and menu/dialog keyboard handling remain independent.
- Verify shared-core helpers with Rust unit tests and real native menu controls
  with synthetic action/cancellation tests. User acceptance still includes real
  clipboard paste, save-dialog cancellation/overwrite, OCR, external folder
  opening and keyboard behavior. No installer, macOS, config or database changes.

Local verification (2026-11-12): 31 WinUI Rust/native tests passed; the synthetic
native control regression reached stage 49. Added tests first exposed deferred
TextChanged allowing an old search selection to paste, and the lightweight
copy/paste record projection intentionally omitting tag membership. Search now
uses synchronous TextChanging, waits for the current query on Enter, and cancels
the pending submission on new input, panel hide, mode switch, query failure or
another action. Clear-all reads actual stored membership; its temporary-database
test preserves other records, favorite state and tag definitions.

Native menu tests invoke real menu-item automation peers and check text/file/
image/color actions. Picker-controller tests inject a path chooser (not desktop
automation), covering cancellation, duplicate starts, stale responses, failure
and cancellation while choosing. They do not exercise the actual OS save dialog.
The actual containing-folder/clipboard/paste/export helpers are reused. Twenty-one
additional core tests passed, including six real raster/SVG export tests, seven
color tests, generated text history, tag persistence and queue/tag request parsing.
41 focused UI-script tests, TypeScript/Vite build, style architecture, Rust format
and whitespace checks passed. Final posted-key verification was skipped because
Windows denied the synthetic window foreground focus; real key input remains
manual acceptance, not a synthetic pass. No full-suite or cross-platform pass is
claimed, and GitHub Actions were not run.

Batch manual acceptance:

1. Right-click / **…** on text, rich-text, link and long-text records: copy/paste
   as plain text into a real editor, retaining full content without rich styling.
2. On files, open/copy the containing folder. On a single-image file and an image
   record, export PNG/JPEG/WebP/BMP, cancel, overwrite and test a missing source.
   Check the owned save dialog does not disappear or steal focus repeatedly.
3. Open **Image text** on an image, then close it and use Space again. Verify the
   shared rich-text editor still has IME, unsaved-changes and revision behavior.
4. Copy HEX/RGB/HSL from a color card; remove all assigned tags on one card and
   verify the tag definitions and another tagged card remain unchanged.
5. Combine `tag:Work` / `tag:"name with spaces"` with category/custom/favorite
   filters and pagination. Quickly type and press Enter, continue typing, cancel
   with Escape, and check no old result is pasted later. Test Chinese IME Enter.
6. With a selected card, use Down to open its native menu and Escape to dismiss;
   preserve Space, Tab, Ctrl+F, queue selection, external drag and regular paste.
   Inspect both languages/themes at the actual DPI. Auxiliary OCR/editor/preview
   WebViews are still on demand; the main clipboard WebView must remain absent.

## Keyboard and show-preference batch acceptance

- Apply the existing quick-input, Tab-selection, plain-text shortcut, retained
  search and retained category settings before the native panel is first shown,
  on later shows, and after the existing behavior-config event. No new saved
  preferences or alternate shortcut registration/keyboard hooks.
- Alt+1–9 acts on the first nine results, including after a pending search;
  Alt+A/F selects All/Favorites. Holding Alt shows non-interactive native hints;
  releasing Alt, losing activation, hiding or disabling quick input clears them.
  In queue selection, quick-number actions toggle selection and never paste.
- The configured plain-text shortcut works on history and in search. Search
  Enter/its plain-text variant acts on the first fresh result, not an old selected
  record. Forward quick-input release handling to the existing Rust paste engine.
- Tab/Shift+Tab moves card selection only when enabled and history has focus;
  disabling it restores native focus navigation. Ctrl+Tab/Shift+Ctrl+Tab cycles
  categories/custom tabs/tags from history or search. Buttons, menus, dialogs,
  IME composition and management editors keep ownership of their keys.
- Search Escape first clears a non-empty query, then closes an empty search.
  Outside search, Escape closes an open preview; with no preview it hides the
  panel. Preserve queue-selection Escape and auxiliary-window behavior.
- On a fresh history show, independently honor retained search and category.
  Resetting category also clears custom and record-tag filters. Returning from
  queue/tag management is not a fresh show. Do not change native geometry,
  external drag, database/config formats, macOS, installer or release files.
- Test native keyboard policy, actual controls/request routing, live settings,
  stale query cancellation and show transitions locally. Real keyboard/IME,
  modifier release and external paste remain one consolidated manual batch.

Local verification (2026-11-12): 33 Rust/native tests passed, with native control
coverage through stage 56. Policy tests cover modifier matching/aliases,
repeat suppression, blocked controls, IME passthrough and disabled settings.
Actual-control tests exercise the synchronous byte-buffer setter (including
invalid-type rejection without partial state changes), menu shortcut labels,
nine non-hit-testable hints, activation-loss cleanup, Tab navigation, search
category cycling, queue quick-selection toggles, pending plain/quick actions,
two-step search Escape, and all four retained-search/category combinations.
Repeated shows and returns from queue/tag management preserve in-progress work.
The added pending-refresh test failed before history plain-text activation was
changed to wait for the accepted query and retain its still-valid selection.
Ordinary keyboard Enter uses that same wait path; search Enter explicitly uses
the first result. The numeric keypad remains available for Windows Alt-code
text input rather than being captured by quick paste.

108 focused frontend tests (native wiring plus the existing WebView keyboard,
show behavior, interactions and paste runtime), production frontend build,
style architecture, Rust formatting and whitespace checks passed. Twelve local
XAML artifacts now include shortcut hints in Chinese/light and English/dark;
these synthetic renders do not establish physical keyboard routing, live
desktop composition or mixed-DPI correctness. Posted Space remains skipped
when Windows denies the synthetic window foreground focus. No hosted Actions,
full-suite or cross-platform pass is claimed.

Batch manual acceptance:

1. In Settings → Shortcuts, test default Shift+Enter, change plain-text paste to
   Ctrl+Shift+V, and verify the native menu hint and history/search behavior.
   Test Enter while category/search results are still loading; no old result
   should paste. Normal Enter still pastes rich content, not plain text.
2. Hold Alt for hints; use top-row Alt+1–9 and Alt+A/F, release Alt, switch apps,
   and hide/reopen. Verify no hint gets stuck. In queue selection Alt+numbers
   toggle selection only. Check Windows numpad Alt codes are not intercepted.
3. Toggle quick input and Tab selection in Settings; check immediate behavior
   and normal native focus traversal when Tab selection is off. Ctrl+Tab and
   Shift+Ctrl+Tab should work from search without stealing menu/editor keys.
4. Test retained-search and retained-category switches independently. Hide and
   reopen using the main shortcut; then check queue/tag-management returns do
   not clear the current view. Inspect normal and minimum layouts at actual DPI.
5. Test Chinese IME candidate confirmation; Escape clears text, then collapses
   search, then closes a preview if present or hides the panel otherwise. Check
   normal Space, external drag, queue, copy/paste and both languages/themes.

## History viewport and incremental-loading acceptance

- Project the existing `retain_last_position` setting to WinUI without a new
  saved field/store. A fresh show restores selection/offset when enabled and
  starts at the first record when disabled. Queue/tag returns are not fresh
  shows. Queue multi-selection must never be cleared by a viewport reset.
- Preserve the horizontal offset across same-query history refreshes and page
  appends. An explicit search/category/tag change starts the viewport at the
  beginning. Clamp after deletion, shorter results, resize or DPI changes;
  obsolete deferred restores must not override newer queries or user navigation.
- Use the ListView's own horizontal ScrollViewer and native wheel/touchpad
  handling, not a new drag/pointer engine or app-authored scroll animation.
- Approaching the right edge loads the next existing Rust cursor page. Allow
  only one request at a time; suspend during native drag/management/restore and
  after a page error. Keep the explicit Load more retry. Do not request the same
  automatic cursor twice or eagerly load the whole database on End.
- Add Home/End and PageUp/PageDown for history only, preserving search editing,
  menus, dialogs, IME and native queue multi-selection. Keep selected keyboard
  targets visible and expose selected custom/tag tabs in the category strip.
- Test policy and real ScrollViewer changes, refresh/show combinations,
  incremental paging/duplicate/error guards and keyboard focus locally. Physical
  wheel/precision touchpad, multiple monitors and 100/150/200% DPI remain manual.
  Preserve window geometry, preview, external drag, Rust commands/storage,
  installers, macOS and the existing native-main/no-main-WebView mode.

Viewport recovery belongs to the accepted history request and is verified after
a real rendered layout, not from a matching pre-layout offset. Programmatic
focus must not queue an independent bring-into-view that overrides that recovery.
Keep focus-driven scrolling disabled until actual navigation/pointer input;
that input cancels an older recovery and restores native focus scrolling. Native
wheel and touchpad events are observed, not handled or captured by a new engine.

Same-query refresh requests include the already-loaded range (minimum 36), so
copying or reopening does not discard earlier appended pages. New filters start
with 36 again. Requests above 10,000 loaded references return an explicit error;
responses above the DLL's existing 4 MiB receive limit return a small error with
the same request identity rather than being silently dropped or truncated.

Local verification (2026-11-12): 36 Rust/native tests passed, including real
control coverage through stage 62. The viewport cases cover same-query refresh,
retained position on/off, queue/tag returns, Home/End/Page navigation, refresh
of 48 loaded records, range clamping, automatic-page deduplication, failed-page
retry and append continuity. New policy/setting regressions failed before their
implementation. The existing native-control regression was extended rather than
relaxing its assertions or timeout, and passed three further consecutive runs.
110 focused frontend tests, frontend
production build, style architecture, Rust formatting and whitespace checks
passed. Physical input, mixed DPI and external-target paste remain manual;
posted Space is skipped when Windows denies foreground focus to the test window.

Batch manual acceptance:

1. Scroll through more than one history page. Approaching the right edge should
   load more without duplicates, jumping back or requiring repeated clicks.
2. At a later position, copy another item or refresh. With position retention
   enabled, hide/reopen should retain the viewport; disabling it should start at
   the first card. New search/category/tag filters should start at the beginning.
3. Return from queue and tag management; keep the prior history position and
   queue multiselection. Verify native wheel and precision-touchpad scrolling.
4. Check Home/End/PageUp/PageDown, arrows and Tab, including after a refresh.
   Search editing, IME, menus and queue multiselection must retain their keys.
5. Smoke-test Space preview, external drag and normal paste; check minimum and
   normal layouts with real 100/150/200% DPI where available.

## In-place record-tag interaction acceptance

- Keep the shipping bottom shelf and existing native management view. Add a
  compact, native top-opening tag editor from the main + menu, record-tag tab
  context/double-click, and a card's Tags submenu. Reuse the shared emoji picker,
  compact controls and theme resources; no new window or WebView.
- Support create, rename and explicit delete confirmation. Delete removes tag
  associations, not clipboard records; initial confirmation focus is Cancel.
  Canceling an unsaved draft writes nothing. Failed requests retain the draft;
  repeated save/delete clicks issue only one request. Hide/view change/shutdown
  invalidate callbacks so an old result cannot close or overwrite a newer draft.
- Creating from the main + menu activates the returned tag only, without also
  highlighting All or changing the next Ctrl+Tab target. Card-initiated creation
  retains the current filter instead of navigating away from its source card.
- From a card, create a tag and then assign the returned tag ID to that captured
  card, never the subsequently selected card. Existing Rust tag helpers remain
  authoritative. If creation succeeds but assignment fails, say so explicitly
  and retry assignment without creating another tag or deleting the created tag.
- Record-tag tabs gain rename/delete access without entering management. Keep
  card tag badges passive, matching the shipping card click/paste surface, with
  a tooltip exposing their full names. Missing/deleted tag IDs cannot edit a
  different tag by stale index. Emoji/menu clicks must not trigger card paste
  or external drag. The Windows menu key and Shift+F10 open the selected card's
  existing context menu; search, other controls, IME and open editors keep keys.
- Check actual native controls, request identity, focus-safe cancellation,
  duplicate/error/stale responses, partial assignment and both languages/themes
  locally. Preserve queue selections, viewport recovery, external drag, native
  docking, configuration/database formats, macOS and installer/release files.
  Physical IME, nested popups, keyboard and DPI remain consolidated manual checks.

Local verification (2026-11-12): 43 Rust/native request and control tests passed,
including the native regression through stage 68 and the existing queue/tag
adapters. New Rust contract tests first failed for missing returned-tag metadata
and editor-operation mapping. A real-control regression also first reproduced
the All/new-tag double selection, then passed after the native selection fix.
The editor cases use actual TextBox/Button/InfoBar controls and automation peers
with synthetic responses: duplicate suppression, stale identity, failed-save
drafts, owner replacement, legacy names, partial create/assignment retry, delete
confirmation, language/theme changes and shared emoji read-only protection.
Host checks open the actual card menu and Tags submenu, follow its create entry,
exercise both Windows menu keys, verify passive full-name badge hints, reject
stale tag IDs and prevent a pending quick paste while the editor is open.
Native menu-reopen tests wait for Closed, not a guessed frame count or sleep.

118 focused frontend tests, style architecture, Rust formatting and whitespace
checks passed. Sixteen synthetic XAML images include the editor and delete
confirmation in Chinese/light and English/dark. These images do not verify live
popup chrome or placement. Posted Space still reports a foreground-denial skip;
physical keyboard/IME, popup placement and DPI require manual review. No hosted
Actions, full-suite, macOS or external-target pass is claimed for this batch.

Batch manual acceptance (use a disposable tag):

1. Use + → New tag, choose an emoji, save, and check only that tag is selected.
   Rename by double-click or the tag-tab menu. Cancel a draft and verify no save;
   also check a failed rename keeps its text and a long existing name is intact.
2. From a card's Tags submenu, create and assign a tag. Check it is added to that
   card, including when other cards refresh; normal card click/paste is unchanged.
   Existing tag add/remove and full-name badge tooltips should still work.
3. Cancel and confirm deletion of the disposable tag. Confirm its associations
   disappear but clipboard items remain. Keep the existing management entry too.
4. Open a card menu with the Windows menu key and Shift+F10; then check search,
   IME, Escape, emoji navigation, focus return and hide/reopen of an unsaved editor.
5. Check both languages/themes and popup positions at normal/minimum widths and
   actual DPI; smoke-test paging, position retention, queue selection, drag and
   Space preview. No global input or external-application automation was used.

## Search and card-preview feedback acceptance

- Match the shipping keyword highlighting in plain text, file names/paths, link
  title/URL and bounded rich paragraphs/tables. Use literal, case-insensitive
  UTF-16 ranges, longest-first terms and the existing eight-term limit. Project
  keywords from the accepted Rust query after tag-token extraction; never paint
  a pending/old query onto new results. Search markers do not modify stored text,
  copied formatting or drag payloads. Preserve original rich runs/highlights;
  use native theme-derived colors only for temporary match ranges, with at most
  256 ranges per text field to bound annotations, not the underlying content.
- Keep the current card size, source headers, tag badges and click/paste modes.
  Show media format/source size and the existing limited-preview state. Images
  smaller than 100 px in both dimensions keep their natural logical size;
  ordinary/large images continue to fit their frame. No eager original/GIF load.
  Reuse the shared 240/480/720 card cache tiers for the native monitor/panel scale;
  do not create a second image cache or change the media safety budgets.
- Track lazy-card request identity. Show local loading/error feedback and a
  named compact retry action without clearing the useful reference preview.
  Retry bypasses the existing derived-media cache only on explicit user action.
  Duplicate retries, old metadata and old bitmap decode callbacks must not
  replace a newer state. Accepted replacement metadata clears obsolete bitmap
  and rich surfaces; failed requests keep their useful reference content. A
  limited preview is not a decoder failure.
- Retry must not paste, start a drag, write the clipboard, move/delete originals
  or alter history. Keep search/selection/queue/viewport behavior, Tauri geometry,
  commands, configuration/database formats, macOS and installer/release paths.
  Native-control tests and synthetic renders are local; physical input, actual
  DPI and external targets remain one manual acceptance batch.

Local verification (2026-11-13): 45 focused Rust/native tests passed, including
the extended real-control regression through stage 76. Keyword projection and
media-metadata tests first failed before implementation; replacement-state
coverage first reproduced an obsolete bitmap surviving a limited response.
Native controls cover literal/overlapping/UTF-16 match ranges, unchanged rich
runs and copied highlights, table cells, both themes, duplicate/local/stale
errors, explicit retry payloads and replacement of obsolete rich/bitmap content.
A unique synthetic PNG exercises actual URI decoding; a separate empty local
file exercises decoder failure and recovery. Bitmap sources are attached to the
live Image before waiting for demand-driven decode events. Completion belongs
to that bitmap instance and card request, replacing the old Image-level hooks.
No test damages an original image, touches user history or automates global input.

121 focused frontend tests, production frontend and native builds, style
architecture, Rust formatting and whitespace checks passed. Eighteen synthetic
XAML renders include accepted search ranges and local loading/error/limited
states in Chinese/light and English/dark. Capture fixtures use current request
identities and wait for initial layout before delivering lazy-card responses;
tag-save tests wait for the editor's actual Loaded event, not a guessed frame.
Renders do not verify compositor materials/shadows or physical DPI. Posted Space
still reports a foreground-denial skip; actual keyboard input remains manual.
No hosted Actions, full-suite, macOS or external-target pass is claimed.

Batch manual acceptance:

1. Search a word shared by text, a file name/path and a link. Check matching
   ranges, mixed case, Chinese/emoji, clearing search and changing tabs. A
   tag-only search must not highlight the tag syntax in the card text.
2. Check a small image and a large photo, plus available GIF/limited previews.
   Tiny images should not stretch to fill a card; captions show available
   dimensions/format/source size without replacing the original file.
3. If an old image/file thumbnail is unavailable, check the local error and
   retry action. In both single- and double-click paste modes, retry must not
   paste or start a drag. Do not delete originals just to create a failure;
   failure/retry cases also have synthetic native-control coverage.
4. Smoke-test Space and left/right preview navigation, normal card paste,
   external drag, queue multiselection, paging and hide/reopen. Check light/dark
   and real 100/150/200% DPI where available. No macOS or external-target pass
   is implied by the local synthetic renders.

## Main, preview and queue consolidation acceptance

- Keep Settings in React/MUI. Its existing close command and native close event
  destroy the auxiliary WebView; reopening creates it on demand. No native
  Settings migration, hidden main WebView or new settings store.
- Clear filters resets search, custom filters and assigned-tag filters together
  with a single history query. Queue additions stay disabled until their own
  request completes, including history refreshes and selection changes; failure
  retains the user's selection and a retry cannot submit twice.
- Space continues using the existing auxiliary preview and continuous geometry.
  Ignore navigation after close; protect native selection from queued navigation
  older than its latest preview request. Repeated Space and unchanged selection
  must not create duplicate work. Preserve pinning, focus return and owner hide.
- Queue mutations wait for their own request identity. Background captures may
  update the list but cannot unlock duplicate actions or clear pending feedback.
  Reject old replies/errors, keep authoritative order on failed reorder, and
  retain scroll position and keyboard-reorder focus where the item survives.
  Expose available Undo without
  opening the overflow menu. Keep the reorder handle keyboard-accessible, with
  Up/Down moving its captured item and restoring that handle after completion.
  Reuse existing queue capacity, persistence and paste.
- Verify real native controls and synthetic responses locally, plus the existing
  shared preview/settings lifecycle and queue tests. No global input automation,
  hosted Actions, macOS changes, data/schema changes or installer/release changes.

Local verification (2026-11-13): 90 Rust/native tests passed: 45 WinUI bridge,
policy and real-control cases (extended through stage 84), 22 shared queue cases,
4 preview-motion cases, 11 preview-focus cases and 8 auxiliary lifecycle cases.
The real clear-filter action first reproduced the lingering custom filter;
keyboard reordering first failed before its implementation. Native tests cover
duplicate submission during refresh, failed/additional selections, duplicate and
stale results, preview navigation before/after dismissal, queue requests across
background capture, older state revisions, reorder failure, visible Undo,
captured menu identity after reordering/deletion, and 99-to-100 item scroll
retention. Queue mutations keep the acknowledged order until Rust confirms them,
replacing the unconfirmed local swap. Keyboard reorder restores focus only in
the active native UI thread; it must not activate vPaste after the user leaves.

131 focused frontend cases passed, including existing settings-close and preview
shell contracts. Eighteen local XAML images include the queue handle and direct
Undo action in Chinese/light and English/dark. No Settings React code was
changed: both its command and OS close already call the auxiliary destroy path.
The main view still creates no WebView; the preview remains a reused auxiliary
WebView. Native popup chrome, physical keyboard/drag, external paste targets,
focus return and real mixed DPI remain manual checks. Posted Space still skips
when Windows denies foreground access to the synthetic window; no full-suite,
macOS or hosted-Actions pass is claimed.

Consolidated manual acceptance:

1. Make a custom filter/search return no results and use Clear filters. Confirm
   All is selected and both search/tag conditions clear. Select items for the
   queue across refreshes/filters, then add them; repeated clicks must not submit
   again, and a failed request must keep the selection. Items additionally
   selected while a request runs remain selected after that request succeeds.
2. Use Space, hold/release it, navigate left/right or Ctrl+Tab, and close/reopen
   quickly. Check mixed media, pinning and focus return without reopening the
   main WebView or replacing the auxiliary preview for each item.
3. In the queue, use Tab to focus an icon/number handle and Up/Down to reorder;
   also drag it and use its item menu. Check the same item moves, Cancel/error
   keeps the acknowledged order, capture/refresh retains scrolling, and Undo is
   directly available after pasting. Normal item clicks still paste.
4. Open/close/reopen Settings and confirm saved theme/language/options remain.
   Check native/auxiliary placement at actual 100/150/200% DPI where available.
   Use normal file/image/text paste/drag as smoke checks; do not damage originals
   to force failures. Failure coverage uses synthetic local fixtures.

## Main-panel parity, editing and auxiliary-flow batch

Acceptance criteria for this batch:

- Keep the accepted dock/card layout and native main UI. Keep Settings in its
  existing on-demand, destroy-on-close WebView; keep rich-text editing in the
  existing sanitized editor rather than discarding its formatting.
- Keep Add/manage tags reachable outside the horizontally scrolling category
  strip. Bound long tab labels, expose their full names, and bring the selected
  tab back into view after a list refresh. Tab order follows the existing Rust
  lists; do not create a competing store for the WebView's local mixed order.
- Open a filter by its current ID rather than an old menu's captured draft.
  Display legacy long filter names intact, retaining the existing 20-character
  rule for new/changed names. Cancel/unload invalidates the editor session;
  mismatched, duplicate and late responses cannot close or overwrite a newer
  draft. Saving waits for its own operation and error feedback preserves input.
  A completed save still refreshes the main list if its flyout was dismissed.
- Preserve the selected record across a text edit that changes its hash, using
  its existing database ID when the hash no longer matches. Do not remap saved
  Paste Queue snapshots or change database/edit business rules.
- Text-editor loading must not leave an older document editable when the target
  is missing or fails to load. Escape/cancel keeps the existing discard
  confirmation. Closing returns to the native selection/search/filter context,
  including when the dock was hidden, without creating a main WebView.
- Verify these behaviors with real XAML controls and isolated editor tests,
  build locally, and provide one combined manual acceptance list. No hosted
  Actions, installer/release changes, macOS migration or data-format change.

Local verification (2026-11-13): 101 Rust/native cases passed: 47 WinUI bridge
and real-control cases (extended through stage 92), 22 queue, 4 preview-motion,
11 preview-focus, 8 auxiliary-lifecycle and 9 saved-text-editing cases. Another
145 focused frontend cases and 6 local Playwright editor cases passed. Existing
browser tests cover rich formatting, sanitized paste/native undo, explicit save,
discard confirmation and a rejected save, including reduced motion. Eighteen
Chinese/light and English/dark synthetic native renders were generated, with
representative main-panel and filter-editor images inspected. Styles,
formatting, whitespace and the frontend production build passed.

Regression tests first reproduced the legacy-long-name save rejection,
operation-mismatched filter response, and stale editable text after a failed
reload. Editor cancellation, unloading, duplicate/old responses and current-ID
menu lookup now have control coverage. A successful filter write requests an
authoritative list independently of whether its editor session still exists;
it never applies an abandoned response to a new draft. The close path now
restores WinUI's current context instead of looking only for a main WebView.
History summaries include the existing database record ID to restore an edited
selection; saved queue snapshots remain independent.

The many-tab test exposed two lifecycle assumptions: an off-screen
SelectorBarItem can have no arranged width yet, and a loaded SelectorBar can
precede its nested ItemsView template. Calling StartBringIntoView on that item
cannot realize it; calling ItemsView.StartBringItemIntoView before its template
exists throws `0x800710DD`. The selected-tab helper now verifies its weak owner
and current selection, applies both templates, and uses the native ItemsView
API without animation. Deferred callback exceptions are reported rather than
escaping the dispatcher. Tests require a nonzero-width selected tab to be
visible before and after refreshing 12 tabs. The standard tab template remains
in use, with a single-line ellipsis and full-name tooltip.

The native posted-Space test still reports a foreground-denial skip on this
desktop. Synthetic controls and browser tests do not prove physical keyboard,
external drag/paste, DWM materials/shadows, or real mixed-DPI behavior. The
optional first screenshot run timed out while exercising an additional overflow
capture; the final standard 18-image run completed successfully. No Actions,
macOS or full-suite pass is claimed. Mixed filter/tag ordering persisted only
in the shipping WebView's localStorage remains a later migration task.

Combined manual acceptance:

1. With several filters/tags, select the far-right entries, trigger a refresh,
   and check the selected entry stays visible while Add/manage tags remains
   reachable. Long names should stay on one line and reveal the full name on
   hover. Create, rename, cancel and delete filters/tags; check the existing
   Emoji direction and that cancel does not persist draft changes.
2. Edit a non-first plain-text card with F2 or its menu, save, and check that
   the edited record remains selected. Repeat with formatted text, cancel then
   keep editing, and confirm discard. Close the editor after hiding the dock;
   search/filter/selection should return without a new main WebView. Check
   physical arrow/Enter/Space use after returning.
3. Smoke-test queue selection, paste/Undo/reorder, normal paste and external
   text/image/file drag. Space and left/right navigation should keep using the
   same auxiliary preview with the existing continuous size transition.
4. Open/close/reopen Settings, check stored options, and check native/auxiliary
   surfaces in light/dark and actual 100/150/200% DPI where available. Settings
   stays React/MUI and destroys its WebView on close.

## Shipping-layout and independent-queue alignment batch

Acceptance criteria:

- Return the tag-add control to the end of the scrolling tab strip. Keep the
  accepted dock/card geometry and circular toolbar actions. Combine custom
  filters and assigned-record tags in one native dynamic strip, supporting
  interleaved drag ordering without changing the selected filter or record.
- Store only the shared tab-ID order in a separate Rust-owned UI-state file;
  do not alter configuration, history, custom-filter or database formats.
  Existing WebView localStorage remains a migration source. Existing WebView
  windows import it only if no shared order exists and then follow the shared
  value. Native mode never creates a hidden main WebView to read this data;
  an existing profile's legacy order becomes available when an updated normal
  or auxiliary WebView next opens. Failed writes keep the acknowledged order.
- Anchor filter/tag editors to the actual tab, add control or card/menu origin,
  retaining a stable native root while saving refreshes the tab controls. Keep
  above-dock placement, screen-edge avoidance, Emoji direction, Escape, focus
  return and the existing safe-close/save lifecycle.
- Host Paste Queue in its own native HWND/XAML island on the existing native
  UI thread. Opening it leaves the dock's geometry, content, selection and
  scroll unchanged. Its toolbar action toggles queue activation; while active,
  the dock offers the existing multi-item selection/add/cancel workflow.
  Queue activation must not set main-panel visibility or replace its content.
- Match the existing queue floating placement, 360x448 logical content size,
  theme/language and nonactivating paste-target behavior. Closing deactivates
  capture; main-panel hide/reopen leaves an active queue usable. Preserve
  queue additions, automatic captures, reorder, removal, paste, Undo, capacity,
  request/revision guards and drag state. Hide only the dock for queue paste;
  do not show the dock again as a replacement for restoring the queue.
- Keep Settings React/MUI with destruction on close. Keep auxiliary rich-text
  editing and Space preview. No hosted Actions, installer/release or macOS
  native UI changes. Add local regression coverage before replacing the old
  placement/queue-host behavior, then build and provide one manual checklist.

### Implementation and local verification — 2026-11-13

This batch completes the mixed-order migration deferred in the preceding batch.
The shipping-layout alignment includes the trailing add control, interleaved
filter/record tags, native internal drag ordering, and actual-trigger editor
anchors. The submission integration now uses main's history-database tab-order
table and shared atomic `reorder_tab` command. It replaces this batch's original
experimental `ui-tab-order.json` writer and frontend revision-sync mechanism.
An existing experimental file is read only to seed an empty database; an existing
database order always wins. Native drops send source, target and placement,
rather than replacing a potentially stale list. Failed saves retain the displayed
order, and a newer order event supersedes a pending initial read. The upstream
WebView localStorage migration remains unchanged. No hidden main WebView is
created for migration, and the old experimental file is left intact.

Paste Queue now has a separate HWND/XAML island on the existing native STA.
The old main-island content swap, return-visibility flags and queue-driven main
window resizing have been removed. Main selection, search, history scroll,
preview navigation and window visibility remain independent. Queue paste
restores only the queue and respects its existing activation epoch. The new
host retains fixed-size, nonactivating behavior, native frame shadow/corners,
monitor placement, DPI handling and automatic theme updates. Settings remains
React/MUI, created on demand and destroyed on close.

Regression coverage and implementation lessons:

- The original queue content swap failed the new stage-4 check that opening a
  queue must preserve the main island content and HWND bounds. The independent
  host passes it, along with hide/reopen, queue paste/Undo, 100-item scrolling,
  reorder, drag cancellation and pending-request identity checks.
- Hiding a retained HWND does not unload its XAML root. A regression first
  reproduced the old clear-confirmation state surviving close/reopen. Queue
  deactivation now explicitly dismisses its confirmation and menus, invalidates
  the old confirmation generation, and clears drag/focus transients without
  discarding an in-flight business request. The final stage-95 check exercises
  close/reopen while both row menus and a clear confirmation are in use.
- SelectorBar's default virtualized StackLayout estimates widths. Combining it
  with an outer scroller caused selected trailing tabs to remain clipped;
  repeatedly requesting realization from SizeChanged could starve rendering.
  The short dynamic tab strip now uses an eager horizontal layout while keeping
  native SelectorBar controls. Only the outer mixed-strip scroller positions it;
  the clipboard history retains its virtualized layout. Stages 91/911 check a
  selected trailing tab before and after rebuilding 12 tabs. Stage 912 confirms
  a subsequent manual scroll is not pulled back to the selection.
- Independent live surfaces can send card-detail requests during queue work.
  Tests associate replies with the matching operation and request ID, rather
  than assuming the global last callback is the operation under test. Mixed
  ordering additionally covers failed writes, retry, stale revisions, retained
  selection and unchanged history-query identity. Both editors retain an
  unsaved draft when their triggering tabs are rebuilt.

Local results:

- 107 focused Rust/native cases passed: 47 WinUI, 3 shared tab-order, 22 queue,
  3 queue-activation, 4 preview-motion, 11 preview-focus, 8 auxiliary-window and
  9 clipboard-editor tests. The actual native XAML regression completed stage
  95 successfully.
- 158 focused frontend unit tests across 26 files passed. The local browser
  suites cover 20 distinct cases: 8 category/order cases, 6 text-editor cases
  and 6 onboarding cases. The updated category suite includes a real mixed-tab
  drag followed by reload. Browser platform emulation is not a native macOS run.
- TypeScript/Vite production build, Rust/WinUI development build, style
  architecture, Rust formatting and whitespace checks passed. No dependency,
  hosted Actions, installer, release, icon or macOS native UI changes were made
  in this alignment batch.
- Eighteen synthetic XAML renders were generated and representative light/Chinese
  and dark/English views inspected in
  `src-tauri/tmp/native-alignment-final-20261113-131459/`. They show mixed tabs
  with the trailing add control and the independent 360x448 queue. These renders
  exclude compositor Acrylic and native DWM frame/shadow; they are not physical
  DPI or real-user-content screenshots.
- Posted Space-key routing remains explicitly skipped when Windows denies
  foreground focus. Handler tests pass, but actual keyboard/IME, external paste
  targets, physical dragging, Windows 10 and 100/150/200% scaling remain manual.
- The rebuilt experimental app was restarted once with `--dev-mode
  --main-ui=winui`. A read-only check found PID 42588 responding, loading this
  worktree's `VPasteWinUiPanel.dll`, with zero child processes at idle before
  opening auxiliary WebViews.

Consolidated manual review after the single restart:

1. Check the trailing add control, mixed filter/record order, drag ordering and
   persistence after restarting. With many tabs, select an off-screen tab and
   then confirm you can still scroll freely to inspect other tabs.
2. Create/edit/delete filters and record tags from both ends of the strip and
   from a card menu. Check above-dock placement, screen-edge avoidance, Emoji,
   cancel/Escape and keyboard focus return.
3. Open the queue while browsing/searching the dock. Check independent windows,
   multi-item selection/addition, newly copied captures, reorder/remove, paste
   and Undo. Hide/reopen the dock without losing the queue. Close/reopen the
   queue while a menu or clear confirmation is displayed.
4. Check real Space preview and left/right navigation, normal paste, drag to
   external applications and editing/return from the auxiliary text editor.
5. Check Chinese/English, system/light/dark, actual display scaling and Settings
   opening/closing. Settings should release its WebView; the main panel must
   remain native throughout.

## Native toolbar, update and capture-feedback batch

Acceptance criteria for this combined batch:

- Restore native access to the existing memory monitor, test room and external
  UI Lab behind Debug + `--dev-mode`. Group these actions in one compact Fluent
  menu; do not create a main/hidden-main WebView, persist preview settings or
  introduce another debug window. Open auxiliary tools on the native dock's
  monitor, reusing their current creation/destruction and foreground behavior.
- Read the existing updater snapshot and subscribe to its revisioned events.
  Show a compact toolbar action only when the same shipping conditions permit
  restart/install. Confirm with a native ContentDialog before calling the same
  Rust install command. Cancel/Escape/close must not install; repeated clicks,
  stale revisions, changed versions and failed installation must remain safe.
  Tests use synthetic state and request callbacks, never download/install.
- Deliver the existing over-limit clipboard-capture warning to the visible
  native dock, with Warning severity and explicit dismissal. Ignore old feedback
  after hiding the dock; do not enqueue surprising warnings for its next show.
  Keep failures readable instead of replacing them with a success auto-dismiss.
  Preserve normal copy/paste, queue selection, drag and preview behavior.
- Localize new controls in Chinese/English, follow app light/dark/system themes,
  use native focus/keyboard semantics, and keep Enter/Space on toolbar/menu/dialog
  controls from activating the history selection. Hiding/deactivating the dock
  closes transient menus/confirmation; shutdown cannot retain callbacks to dead
  controls. Settings remains React/MUI and is destroyed on close.
- Add regression coverage first, run native and relevant shared/frontend checks
  locally, and restart the experimental app only once for consolidated review.
  No hosted Actions, submission, installer/release, icon or macOS UI changes.

### Implementation and local verification — 2026-11-13

The native toolbar now groups the existing memory monitor, test room and external
UI Lab in one developer-only Fluent menu. Auxiliary creation helpers accept an
optional source WebView; native callers use the dock's monitor without creating
a main WebView. Existing Tauri command names and arguments remain unchanged.
The two auxiliary Debug pages are included only by the explicit `native-debug`
Vite build mode. The Windows native launcher builds and validates those assets
before compiling Rust, and stops on either build failure. Normal production
builds exclude these pages, UI Lab and Settings Preview. UI Lab remains served
by Vite: opening it first checks the configured development URL and explains how
to run `npm run dev` if the server is unavailable, instead of opening a dead page.

The update action follows the current updater's ready/installing, portable and
source conditions. Its native confirmation defaults to Cancel, follows language
and theme changes, and is dismissed when the dock hides or loses activation.
Closing a dialog still owns keyboard input until its close operation completes;
deferred focus return uses the existing visibility/editor guards. Request IDs,
snapshot revisions, confirmation generations and the confirmed version prevent
duplicate or stale actions. Rust checks that version against the actual pending
package under the existing operation guard. The public install command and
installer launch behavior remain unchanged; tests never download or install.

Over-limit clipboard captures now show the existing localized warning on a
visible native dock. Warning/error feedback requires dismissal, while success
feedback keeps its existing timer. Hidden docks discard these capture warnings.
Settings remains React/MUI with destruction on close. This batch does not change
the native window movement, drag engine, queue store or preview implementation.

Local evidence:

- New coverage first reproduced the missing warning at native stage 96, and a
  `native-debug` asset build first reproduced the missing auxiliary tool routes.
  Both now pass on their real rendering/build paths.
- 118 focused Rust/native cases passed: 50 WinUI, 17 updater, 8 auxiliary-window,
  22 queue, 3 queue-activation, 4 preview-motion, 11 preview-focus and 3 developer
  mode tests. The final actual XAML regression reached stage 106, including
  ready-update/developer controls at 640 and 960 logical widths, cancellation,
  stale state/replies, retries and keyboard ownership.
- 84 frontend unit cases across 20 files passed, plus 9 local browser cases:
  7 memory/update cases including reduced motion and 2 actual packed Debug-route
  cases. The latter verify direct tool loading, tab/close interactions and no
  main-history requests.
- Style architecture, TypeScript/Vite production and native-debug builds, both
  asset-isolation checks, Office release guard, Rust formatting, whitespace and
  the final Rust/WinUI executable build passed. No hosted Actions ran.
- Twenty-two synthetic XAML images were produced in
  `src-tauri/tmp/native-app-actions-final-20261113-140122/`. Light/Chinese and
  dark/English toolbar states and update confirmation were inspected. These
  images exclude DWM shadow/Acrylic and are not physical-DPI evidence.
- Posted Space routing was explicitly skipped because Windows did not grant
  foreground focus to the test window. Physical keyboard/IME, real external
  drag/paste targets, Windows 10 and 100/150/200% display scaling remain manual.
- The final experimental executable was restarted once with `--dev-mode
  --main-ui=winui`. A read-only check found PID 10036 responding and loading
  this worktree's `VPasteWinUiPanel.dll`, with zero child processes at idle
  before opening auxiliary tools.

Consolidated manual review:

1. Open/close the memory monitor and test room from the developer menu. Confirm
   both load their own content. UI Lab requires `npm run dev` in this checkout.
2. Smoke-test search/tags, queue capture/add/paste/Undo, Space/left-right preview,
   editing and external text/image/file dragging after using those tools.
3. Check Chinese/English and light/dark/system, narrow layout, Settings close
   behavior and actual monitor/scaling placement. A ready update is optional:
   synthetic coverage checks its confirmation without installing an update.
4. Check the native process tree at idle before opening auxiliary pages; those
   pages may create WebViews on demand, but the main panel must stay native.

## Hover browsing and queue continuity batch

Acceptance criteria:

- Project the existing hover-preview preference into native mode, with no new
  setting/default. Real mouse movement selects the card without stealing focus;
  text/text-file/image/link hover opens the existing preview after 500ms. Leaving
  allows a 250ms crossing to the preview. Entering the preview keeps it open.
  Manual/pinned previews cannot be replaced or dismissed by hover cancellation.
- Searching/filtering, scrolling, keyboard input, pointer press, menus/editors,
  queue selection, dragging, hiding and preference changes cancel pending hover
  work. Old requests cannot reopen a closed/newer preview. Stationary pointers
  over refreshed/recycled cards do not change the selection or open a preview.
  Continue using the shared auxiliary renderer and native monitor placement;
  no main/hidden-main WebView, clipboard write or new global mouse hook.
- Native queue Undo follows the existing Rust deadline and disappears at expiry
  without rebuilding the item list. Expired/missing deadlines cannot dispatch an
  Undo. Busy state, newer snapshots and close/reopen remain authoritative.
- Preserve the focused queue row/action through background capture and language
  refresh; keep a removed row's keyboard focus near its former position. Pending
  operations and refreshes must not take focus from another window. Keep existing
  scroll, reorder, paste-target and nonactivating-window behavior.
- Add failing regression coverage before implementation, verify locally, retain
  React/MUI Settings and the existing shipping layout, then restart once for one
  consolidated manual review. No Actions, submission, installers or macOS UI
  changes.

Implemented behavior:

- Native cards now select on real pointer movement without focusing the list.
  The existing opt-in hover preference uses a small native timer controller and
  the shared preview renderer. Moving into that reader keeps it open; leaving
  uses the shipping 250ms grace period. Unsupported types, missing images and
  images over the existing automatic-preview budget cannot open a hover reader.
- Search text changes cancel old hover work immediately, before the existing
  search debounce. Scrolling, card menus, keyboard/press actions, editors,
  dragging, configuration changes and owner hiding also cancel it. Native
  reservations and cancellation share the pending-preview lock, so an old failed
  preflight cannot close a newer request. Escape dispatches its ordinary dismiss
  before hover cleanup, preserving preview-first dismissal.
- Undo now uses the Rust-provided `undoExpiresAt`, rechecks it on activation and
  click, and expires by updating only its own affordance. Closing a still-loaded
  queue suspends that timer; reopening checks the current deadline. This replaces
  the previous hash-only visibility rule, without changing Rust's Undo lifetime.
- Queue refreshes retain row identity, action and keyboard focus intent. If the
  item was removed, the nearest remaining row receives that action's focus.
  This replaces the handle-only Loaded callback. Weak references, render versions,
  new-input cancellation and the actual queue HWND's foreground guard prevent
  stale restores, retained row trees and cross-window focus theft.

Local evidence:

- Failure-first tests reproduced the omitted hover preference and expired Undo
  visibility before implementation. The final 52 WinUI/Rust cases passed; the
  actual XAML history/queue regression reached stage 111. It covers the real
  Undo expiry timer without row replacement, missing/null deadlines, reopen,
  hover coalescing/cancellation/preview crossing, Escape request order and the
  synchronous search-text cancellation path.
- Shared preview-motion, preview-focus, preview-behavior, queue, queue-activation
  and auxiliary-window suites passed. All 116 selected frontend unit cases passed,
  including the existing hover, preview controls, queue, settings and native
  architecture coverage. The style check, TypeScript/Vite production and
  native-debug builds, both asset-isolation checks and final native executable
  build passed locally.
- Twenty-two mouse/preview browser cases passed, plus both normal/reduced-motion
  resident-reader cases. The latter's obsolete iframe/HTML mock and old keyboard
  event assertion were updated to the existing native-browser and navigation
  commands. They still verify idle isolation, image/file readiness, browser
  parking, reader reuse and rejection of late image work. Production link-preview
  behavior was not changed by that test maintenance.
- Twenty-two synthetic XAML images were generated in
  `src-tauri/tmp/native-hover-queue-final-20261113-145843/`. Chinese/light queue
  and English/dark history were inspected. These exclude DWM/Acrylic and are not
  physical display-scaling evidence.
- Windows denied foreground activation to the automated test host. The posted
  Space test and foreground-dependent queue-focus assertions explicitly skipped;
  the background no-focus-restore assertion passed. Actual mouse crossing,
  foreground keyboard continuity, external paste/drag, Windows 10 and display
  scaling remain manual. No hosted Actions ran.
- The rebuilt experimental executable was started once with `--dev-mode
  --main-ui=winui`. Read-only inspection found one responding instance (PID
  26156), the native DLL loaded from this worktree's `target/debug`, and zero
  child processes at idle before auxiliary pages were opened. The production
  Office-fixture guard passed against a separate production build directory;
  `dist` remains the native-debug build for the running experiment.

Consolidated manual review:

1. In Settings / General, test Hover preview off and on. Pointer movement should
   select without stealing search focus; enabled previews should wait about half
   a second. Cross into the reader, return to another card and leave both areas.
2. Check search, category/tag switching, scrolling, menus, dragging and hiding
   while a hover is pending. Space, arrow navigation, Escape and a pinned reader
   must retain their ordinary behavior; stale hover work must not reopen it.
3. Paste a queue item and use Undo within its existing deadline, then let another
   Undo expire. Check close/reopen, 100-item scrolling and handle-keyboard reorder.
   While a row action has keyboard focus, refresh/capture or remove that row;
   focus should stay with the item or move to its nearest surviving neighbor.
   Working in another app must not be interrupted by queue refreshes.

## Submission integration with current macOS work — 2026-11-13

Acceptance criteria for issue #362:

- Integrate on top of main `65e2f90`, preserving the macOS native/Liquid Glass
  sources, Swift tests, queue-selection changes and WebView tab-order contract.
- Keep WinUI compiled only for Windows Debug with the explicit feature and
  process-local opt-in. Ordinary WebView and macOS native startup stay available.
- Use the shared history-database tab order, including atomic moves and existing
  WebView migration. Preserve a legacy experimental native order only when the
  database is empty. Keep newer events authoritative over in-flight native reads.
- Include no installer/release assets, workflow changes, build outputs or private
  clipboard data. Keep Settings as an on-demand React/MUI window destroyed on close.

Integration verification:

- The macOS native source and test directories, WebView `Clipboard.tsx`, Settings,
  installer/icon assets and workflows have zero diff against the integration base.
  The upstream Swift build-source list is preserved. A Windows-only path in a new
  shared test fixture was replaced with the current platform's temporary path.
- All 782 frontend unit cases passed. The release-script tests needed Git Bash
  instead of WSL Bash and a checksum-verified official jq executable, installed
  only in ignored task output. No release was uploaded by those mocked tests.
- Style architecture, TypeScript/Vite production build, production asset isolation,
  Office release-fixture isolation, license inventory, release metadata and Rust
  formatting passed locally. Native Debug assets and packed tools are checked
  separately from production assets; both packed-tool browser cases and the final
  native Debug executable build passed.
- All 55 native Rust/XAML cases passed, including stage 111, the mixed-tag move
  payload, save-failure retention, stale read/reply rejection and three new shared
  database compatibility cases. The platform-neutral history-title case and the
  database tab-order tests also passed after the fixture adjustment.
- The nine category/order browser cases and two resident-reader cases passed,
  as did all 22 mouse/hover-preview browser cases. Platform browser mocks and
  reduced-motion coverage do not establish physical macOS native runtime behavior.
- The full default Windows Rust run had 511 passes, 5 existing ignored cases and
  7 failures before clipboard assertions: Windows denied creation of each private
  window station. A standalone station probe confirmed Win32 error 5 (access
  denied). Those seven cases remain unverified here; do not claim a green full
  suite. Do not remove isolation or run their writers against the user's desktop.
- The actual XAML test host also could not acquire foreground focus. Posted Space
  and foreground-dependent queue-focus assertions remain explicitly skipped.
  macOS native execution, physical keyboard focus, external drag/paste, Windows 10
  and 100/150/200% display scaling remain manual acceptance items.

Evidence is under `src-tauri/tmp/submission-362-20261113/` (ignored local output).

## Interpreting memory readings

Compare the same metric after the same idle time on the same machine, and measure
the full `vPaste.exe` process tree. Exclude the Vite/Node process from the
WebView development run. This slice includes the primary native history list,
tag management, and a basic native Paste Queue, but does not yet represent
feature parity for all rich-media interactions or auxiliary windows. Settings
intentionally stays an on-demand WebView destroyed on close; preview reuse has
its own lifetime. The result is still not an apples-to-apples memory comparison
of equivalent UI functionality and is not a production memory claim.

Do not run the WebView and WinUI variants simultaneously: they would both
capture the system clipboard and distort memory readings. The normal data
directory behavior is unchanged in this MVP, so use an isolated Windows account
or a disposable checkout/profile if testing with user data is a concern.
