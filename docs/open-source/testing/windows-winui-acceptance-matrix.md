# Windows WinUI current parity and desktop acceptance

Audit date: 2026-11-15; latest desktop-report follow-up: 2026-11-17. Closeout base: `3153543` (PR 381), including the earlier
`c573d83` (PR 379) implementation. The follow-up is recorded below.
This is the current acceptance index; [windows-winui-parity.md](windows-winui-parity.md)
retains the chronological implementation and regression history.

The reference UI is the shipping **React WebView**, not Vue. Preserve its
layout, operations and Rust behavior; use actual WinUI controls for native
input, menus and dialogs. This audit does not switch the default renderer,
remove the WebView implementation, change distribution or benchmark Release.

For the next batch, see the [concrete differences and decision list](windows-winui-next-decisions.md).
It separates confirmed remaining differences from implemented scenarios awaiting
physical acceptance; it does not authorize further product changes.

## How to read the evidence

- **S**: the current reference, native implementation and shared Rust route were
  inspected. This establishes wiring, not successful physical interaction.
- **U**: focused Rust/native policy or payload tests. They do not operate an
  external target application.
- **X**: actual XAML/HWND regression. Its synthetic records and recording bridge
  callback do not prove live capture, external paste or physical keyboard input.
- **A**: this pass ran the actual App and Tauri IPC with a marked, isolated
  synthetic database. The auxiliary lifecycle check uses real WebViews, not
  browser mocks. It deliberately does not run live clipboard capture.
- **M**: desktop acceptance remains manual. Neither injected DPI notifications
  nor browser screenshots establish physical monitor, DWM or focus behavior.

An implemented row is not an unconditional desktop pass. The last column names
the remaining acceptance boundary. No physical-desktop row was auto-approved.

## 2026-11-17 queue sorting, category latency and shortcuts follow-up

This follow-up supersedes the queue-sorting limitations and eight-tool count in
the earlier card/queue entry below; that entry is retained as historical evidence.

| Scenario | Current implementation / evidence boundary |
| --- | --- |
| Queue sorting and layout | **S/X:** compare `PasteQueue.tsx` and its CSS with `WinUiQueueView`. Replace the queue-local OLE data package and insertion line with root-owned pointer capture and live row displacement. Release the handle Button's existing capture before the root captures it; ButtonBase also releases capture in its release class handler. Preserve keyboard moves, original-target paste, revisions, busy guards, concurrent captures/deletions and Undo. At 360 DIP the tested row is 336 DIP wide, with nonoverlapping 34-DIP handle, 254-DIP content and 32-DIP remove action; rows are 66 DIP high. Remove appears on hover/focus. Loaded tests cover begin/move/one commit, cancellation, missing source, busy state and 100 items. **M:** real pointer capture/release, edge scrolling and perceived motion remain manual; invoking sorting methods synthetically does not establish them. |
| Category response | **S/X:** category selection dispatches immediately; the 240-ms search timer is not used for tab selection. The indicator now starts before queued response/layout work. Retain unchanged card controls across category queries rather than clearing/rebuilding the list; update Alt indexes and plain search ranges, and rebuild rendered rich cards only when their search terms change. Preserve latest-request-wins, real Rust/database filtering, pending detail responses and the bounded result animation, including reused cards. No cross-view data cache is added. **M:** perceived latency against the user's live history remains unverified. |
| Alt categories and adjacent keys | **S/U/X:** restore visible A/F hints for All/Favorites alongside card 1-9 hints. Resolve those actions from ordinary toolbar-button focus too, while preserving quick-input opt-out, editor/menu/composition guards, repeat/modifier handling, Ctrl+Tab and search behavior. Loaded controls verify hint text, visibility, noninterception and deactivation cleanup; synthetic routing verifies A/F and card actions. **M:** physical keyboard/focus acceptance remains manual; posted Space explicitly skips if Windows denies foreground activation. |
| Retired native sample | **S/U/X/build:** remove the obsolete toolbar action, React/Rust commands, FFI and standalone Win32/Swift sample sources/build. Seven shared Debug tools remain. The real WinUI implementation remains under `native-demo/windows/winui`; the real mac native panel compiles directly against its own bridge as `VPasteNativePanel`. The mac toolbar test expectation is updated for the removed sample. **M:** macOS compilation/runtime was not available on this Windows host. |
| Material investigation | **S:** the main island uses SDK `DesktopAcrylicBackdrop`; cards retain readable surfaces and contrast/unsupported paths retain opaque fallbacks. Files additionally supports a custom Thin Acrylic recipe and explicit input-active updates. This pass does not change the backdrop or lower whole-window opacity. The comparison and pinned primary sources are in [the bridge notes](../development/windows-winui-bridge.md#material-comparison-files-2026-11-17). The local Files user's selected recipe was not inspected. |

The native category component benchmark uses synthetic text records and bypasses
database latency. In three alternating samples, applying 36-to-12 results fell
from 24.02-25.26 ms to 9.97-10.80 ms; 12-to-36 fell from 43.34-47.52 ms to
30.14-32.96 ms. Dispatch stayed below 1 ms. Those are synchronous component
timings, not proof that the reported end-to-end 300-ms delay is eliminated.
The 100-item queue benchmark measures 120 calls to the loaded pointer-move
path; it is diagnostic work cost, not a physical frame-rate gate.

Queue paste retains its guard against a drag-release click. A fresh press uses
`handledEventsToo` so ButtonBase cannot swallow the reset and leave subsequent
mouse paste blocked; the source regression failed before this change. Sorting
followed by a physical paste click remains in the manual acceptance list.

Local artifacts are under ignored
`.codex/tmp/winui-queue-shortcuts-20261117/`, including failing-before-fix logs,
native fixtures and settled light/Chinese and dark/English screenshots. Screenshot
fixtures assert their queue row count so stale revisions cannot silently produce
misleading captures. Native tests wait for measured viewport state, not a fixed
number of frames or a particular scroll-event edge. Optional screenshot settling
has its own overall test deadline; ordinary native deadlines are unchanged.

Source, unit, build and loaded-XAML evidence are kept separate from actual-App
and physical acceptance. Native windows are tested in one announced final interval;
ordinary Debug stays stopped. No hosted workflow, submission or release action
is part of this follow-up. The existing release-upload fixture file remains
excluded from the frontend run for the previously documented local Bash/jq
environment limitation; its implementation is unchanged.

## 2026-11-17 card, queue and Debug follow-up

The reference for this pass is `PasteQueue.tsx`/its CSS, `ClipboardHeader.tsx`,
`ClipboardCardPreview.tsx` and the card record-tag overlay in `ClipboardCard.tsx`.

| Scenario | Implementation and acceptance boundary |
| --- | --- |
| Queue presentation | **S/X:** centered title/count, directly available Reverse, Clear in More, separator rows, left drag handle, content artwork, one remove action and a bottom Undo toast now follow the reference hierarchy. Existing paste/remove/reverse/clear/undo, busy/error/retry, revision ordering, keyboard moves, cancellation and lifetime checks pass. **Remaining differences:** native handle sorting uses OLE plus an insertion line rather than WebView live displacement; Remove is always visible; errors retain a WinUI InfoBar. This is not complete visual/interaction parity. |
| Main-card internal drag | **S/build:** only the current main-card drag suppresses target-local content/glyph/caption while over the main panel; the panel still rejects an internal drop. Tab/queue sorting and external format providers are preserved. Existing native format regressions pass. **M:** the physical cursor inside/outside the panel, cancellation, and actual OneNote/QQ/WeChat/Explorer drops require a real pointer check; format tests cannot establish that result. |
| Long card text | **S/U/X:** plain, rich and text-file card previews use the reference delay, speed, pauses and restart cycle from shared `cardPreview` Motion tokens. A card-only non-interactive viewport replaces manual nested scrolling. Inactive/hidden/unloaded and disabled-animation states stop/reset the compositor animation; the full reader remains interactive. XAML checks exercise overflow and these lifecycle states; they do not measure perceived frame smoothness. |
| Developer controls | **S/U/X:** restore eight independent buttons: Windows/Mac tutorial previews, language/theme preview, Test Room, memory, native demo and UI Lab. The eye hides/shows the group, initially expanded. Runtime gating remains Debug plus exact `--dev-mode`; ordinary dev and Release do not expose the controls. Language/theme previews are session-only, including hide/show. Tutorial windows reuse the existing isolated draft and shared builder; no saved preferences or main WebView are created for these actions. Native tests check control routing, duplicate protection, errors/retry and hidden state. **A/M:** launching each tool from the ordinary App and macOS runtime acceptance remain unverified in this pass. |
| Card record tags | **S/X:** replace the joined summary with individual ordered pills, 92-DIP truncation, 4-DIP gaps and the reference overlay position. More than two tags use a duplicated clipped track and the shared eight-second marquee; hidden/unloaded/disabled-animation states stop it. The overlay does not intercept card input. Native tests verify individual content, geometry, animation state and cleanup; physical readability/motion remains manual. |

Local artifacts: `.codex/tmp/winui-card-queue-debug-20261117/` (ignored).
Focused frontend tests passed 7 files / 34 tests; WinUI Rust tests passed 64,
developer gating passed 3, and auxiliary lifecycle tests passed 8. Actual-XAML
shell regression passed stage 257 and history/queue/reader regression passed
stage 153. Foreground-dependent checks, including posted Space, explicitly
skipped when Windows denied activation. Production/native-debug frontend builds,
Debug asset isolation, style checks, the WinUI Release check and the
`winui-debug` App build passed. The App was built but not automatically started.
Five local headless Playwright checks passed for light/dark rich-card colors,
default canvases and the reference developer toolbar. These tests explicitly
scroll the virtualized list before checking nonresident card content; DOM
scroll-into-view alone cannot materialize a card outside the resident range.
No new actual-App or physical/macOS acceptance is claimed.

The full frontend run was not wholly green: six release-upload fixture tests
failed because the local Bash/WSL environment could not resolve Windows fixture
paths; a Git Bash retry also lacked `jq`. Release tooling was not modified.
Mapped native tests ran in one announced final interval; ordinary Debug remains
stopped, and no hosted workflow was changed or dispatched.

## 2026-11-17 file-focus and resource follow-up

| Scenario | Current implementation / evidence boundary |
| --- | --- |
| Loaded File cards flicker on focus | **S/X:** selection used to call the full row-theme pass, recreating file SVG presentation trees. Selection now updates outlines/queue controls only. File artwork retains its identity until an actual detail replacement or effective-theme change. The actual-XAML fixture first loads all 36 cards through viewport/detail responses; 12 subsequent selections plus identical theme messages create zero file presentations and send zero additional card-detail requests. Real dark-mode changes and explicit updated-file replies still replace the artwork. |
| Repeated summon work | **S/X:** the Rust show/toggle paths apply the configured theme on every show. Identical native theme messages now return before panel/auxiliary restyling. The same regression checks this with loaded cards. The former 36-card restyle replay created 432 SVG trees for 12 moves (239.28ms synchronous work); the retained-selection/theme path took 23.02ms in that run. These are component timings, **not** end-to-end summon latency or physical frame-rate acceptance. Native dock motion, geometry and fresh capture are unchanged. |
| Hover feedback | **S/X:** remove duplicate native tab, whole-card and source-icon tooltips as requested. The React reference does have a source-icon `title`; removing that native counterpart is intentional, not a claim that React had no tooltips. Preserve accessible names/help and the installed WinUI SelectorBarItem `CombinedStates` pointer-over/pressed transitions. Useful icon-command, missing-file/full-path and assigned-tag explanations remain. |
| Delete either tab kind | **S/X:** React uses the same DeleteConfirmDialog for filter and record tabs. Native context deletion now uses the same panel-owned ContentDialog, title, default Cancel, buttons and cancellation lifetime; descriptions retain the different effects. Tests cover both types, cancel without writes, duplicate suppression, error/retry, success refresh and history-reset retirement. Editing forms contain no Delete action and deletion no longer constructs an editor or queries source apps. |
| Test interruptions | Source/unit/build/read-only checks run silently. Announce and group mapped-window tests in one final interval, including any necessary failure investigation. No desktop input automation, ordinary Debug restart or hosted workflow is part of this check. Physical smoothness/input/DPI remain manual. |

Memory observations use **private committed bytes**, with the main process and
WebView descendants kept separate. These are Windows Debug observations, not
Release targets or macOS results:

- The ordinary App sample was about **554.8 MiB main process** and **787.5 MiB
  complete tree** (seven processes, including WebView descendants). Main-process
  memory includes WinUI/native resources; it is not a measurement of Rust-owned
  application data alone. The short idle samples did not establish a leak.
- With the same marked 500-record fixture and no WebView descendants, the
  baseline/updated cold medians were **370.6/371.8 MiB**. There is no demonstrated
  cold-memory reduction from this fix. Do not report the SVG work-count result
  as hundreds of MiB of proven savings; render/decoder allocation snapshots are
  asynchronous and varied across runs.
- Isolated startup instrumentation recorded roughly 3.3 MiB after core setup,
  4.1 MiB after opening history, 9.0 MiB after search initialization and 31.0 MiB
  after hidden WinUI initialization; the settled visible App measured about
  372.2 MiB. This narrows the large growth to first display/content/rendering,
  but does **not** attribute all allocations to a particular cache or graphics
  surface. No shadow/material was removed and no working-set trim was used.
- The final loaded-card selection sample changed by only 8 KiB, but that short
  component sample does not prove a long-running leak is absent. Continued
  render/heap attribution is needed before changing caches or rendering policy.

Local artifacts for this follow-up are under ignored
`.codex/tmp/winui-focus-resources-20261117/`. Style checks, production frontend
build, focused source tests (22 files / 91 tests), Rust formatting and WinUI Rust
tests (63 passed, two desktop suites run separately) passed. Debug and Release
native component builds passed; the Debug App build passed. The native shell
suite passed through the new focus/deletion cases and final tutorial stage 255.
The history/queue/reader suite passed stage 153 on retry: one preceding run
timed out in the existing stage-84 queue-scroll event wait. Foreground-dependent
keyboard assertions explicitly skipped where Windows denied activation. This
does not establish physical smoothness, external-App behavior or mixed DPI.

## 2026-11-17 media/settings follow-up

The user's physical settings-drag report invalidated the earlier workaround's
acceptance. The items below supersede its implementation, without upgrading
synthetic checks to desktop acceptance.

| Scenario | Current implementation / evidence boundary |
| --- | --- |
| Ordinary-file previews | Shared `build_file_preview_info` is image-allowlisted. MP4/MOV/audio/documents/archives remain icon-only; PDF/text/image/multiple-file routes are retained. This is an explicit requested policy change: public baseline `a35bef0` already called Windows Shell thumbnail handlers, so it is not described as a WinUI-only regression. The failing-first Rust cache regression proves the removed handler route was entered even for an undecodable MP4. |
| Image-file identity | React's `isSingleImageFileItem` changes the card's visual type, not the stored File identity or shared Image/File SQL filters. Native `visualType` now mirrors that header rule without changing drag, copy, delete, multi-file or category semantics. A two-category overlap is not silently added. |
| Settings drag | Existing caption regions use WebView2 non-client `app-region: drag`; Windows no longer attaches JS drag handlers or invokes the removed custom Rust move loop. macOS retains its bridge. Unit checks cover the handler split; the marked actual-App script checks computed regions and no duplicate IPC. **M:** real movement, release, unrelated-app input, resize and mixed DPI remain required. |
| Unknown source icons | Recent metadata was inspected without clipboard text. Several recent records have no reported app source/icon; this does not establish Orca or Notepad ownership. Empty detail responses now clear a prior decoded source icon. Artwork without a dominant color uses the reference neutral gray header instead of inheriting the green Text header. Native refresh/color regressions cover both cases; fallback tests require neutral grayscale artwork, never invented Notepad branding. No user history is rewritten. |
| Missing-file warning | Keep the 24-DIP badge with a centered 16-DIP glyph, explicit padding and a 6-DIP corner inset. The accepted toolbar artwork is unchanged. Actual XAML checks retain the missing-file route and measure the glyph/badge dimensions. |
| Tab spring | Keep stiffness/mass and the ~119ms period; increase damping from 42 to 59. The derived overshoot falls from ~8.7% to <1%; native checks cover the same spring and reduced-motion path. |
| Preview frame | The native reader keeps its HWND/content lifetime and uses a system Acrylic outer frame with an opaque content canvas, plus an opaque system-theme fallback. Rich WebView rendering retains its translucent shell. This aligns chrome without introducing a resident main WebView or sending all plain text to a browser renderer. **M:** actual desktop material, transparency settings and cross-render transitions require visual acceptance. |

Actual-App local command: `node scripts/check-winui-media-settings.mjs <marked-memory-fixture>`.
Run `check-winui-auxiliary-lifecycle.mjs` separately for settings destruction,
preview reuse/pinning/cancellation and main-WebView exclusion. Native-reader
geometry, theme, focus-target and content-lifetime checks remain X evidence.

Local verification for this follow-up (2026-11-17):

- **U/build:** style architecture, production and native-debug frontend builds,
  native-debug asset exclusion, WinUI Debug App build and ordinary Rust check
  passed. The relevant frontend suite passed 115 files / 827 tests; local
  Playwright passed 57 settings, panel-size, shell and onboarding cases.
- **U:** WinUI Rust tests passed 63 with two desktop suites ignored in that
  command. File-preview tests passed six; source-icon tests passed six with one
  preexisting ignored test; the shared category-filter regression passed.
- **X:** the separately executed shell suite passed stage 255, and the
  history/queue/reader suite passed stage 153, including the new frame, visual
  type, neutral-header and icon-reset checks. Windows denied foreground focus
  to some posted-key assertions; those were explicitly skipped, not passed.
- **A:** both marked-fixture scripts passed against the rebuilt App. The media
  check exercised actual file-preview IPC, unchanged Shell-cache entries and
  computed Windows caption regions with no competing JS drag requests. The
  lifecycle check verified settings destruction/recreation, preview reuse,
  pinning, three cold cancellation/reopen cycles, guide release and no main
  WebView. Neither script moved the physical mouse or tested DWM appearance.
- **Environment limitation:** the unfiltered frontend run has six failures in
  `uploadPublishedReleaseAssets.test.ts`: the local Bash/WSL process cannot
  resolve its Windows temporary asset paths. The 827-test result excludes that
  release-script file. Release tooling was not changed to bypass the failure.
- **M:** settings hold/move/release and subsequent unrelated-app input, actual
  Acrylic/transparency, mixed DPI, live source attribution and perceived spring
  motion remain pending. No hosted workflow was modified or dispatched.

## Scenario parity is required, not just command parity

For each changed feature, compare the shipping WebView's **conditions, event
sequence, geometry, and lifetime** before choosing native controls. Preserve
the observed product interaction; a native control's default transition is not
automatically equivalent. Record intentional differences explicitly.

Source assertions establish wiring only. They cannot close a row based on a
control name, callback, unchanged HWND, or screenshot of its resting state.
Use the same synthetic records, locale, theme and viewport for reference and
native checks, including these transitions:

| Scenario | Reference contract | Executable regression / physical boundary |
| --- | --- | --- |
| Hide, copy a new item, summon | Existing items do not replay loading/entry effects | Native shell retains controls, realized containers and decoded images when a response prepends an item; outstanding detail requests and multi-selection survive. Repeated tab refresh retains controls and keeps the selection visible. Check DWM appearance physically. |
| Rich fallback and GIF thumbnail | Format presence is independent of successful rich rendering; a GIF remains a GIF when its thumbnail is static | Real stored rich capture through `history_card_payload(false)` and the native format projection, plus native badge negative/refresh cases. Light payloads deliberately have empty drag HTML; that field cannot identify the format. |
| Move a custom tab both directions | A forgiving insertion target and a visible destination while dragging; cancel restores all visuals | Native repeated drop/rebuild/frame geometry, transition removal and midpoint assertions; actual pointer drag, overflow scrolling and rejected drops remain physical checks. Saving still uses the atomic shared move. |
| Start tutorial, practise shortcut, finish | The tutorial replaces the main content area while retaining the main-panel frame | Native owned-host tests, real auxiliary lifecycle, and local browser animation checks in both languages/themes/motion modes. The welcome mounts after the host's shown event, not hidden-page readiness. Physical shortcut practice remains manual. |
| Open preview, navigate quickly, close during preparation | Keep accepted content visible until the replacement is ready; at most two content layers; interpolate actual outer bounds | Native frame-by-frame content and intermediate HWND bounds, cancellation and reduced-motion settling. Renderer handoff inherits the currently visible rectangle before resizing. A stable HWND or content crossfade alone is insufficient. |
| Scroll, capture and refresh history | Fixed card slots and ordinary gaps survive insert/remove/reorder | Native 36-card repeated/scrolled refresh geometry, retaining existing controls and bitmaps. Exclude parked cached containers from viewport assertions. Physical large-gap report still requires review on the user's data. |
| Return focus after preview/navigation | Focus only live mounted controls; no forced synchronous layout in focus restoration | User crash dump identified an uncaught `E_INVALIDARG` from `UpdateLayout` in the focus message. That call is removed; native unloaded-view and exception-boundary regressions preserve the process and log failures. Physical focus behavior remains manual. |

Run these locally for touched paths; do not add hosted visual Actions. Report
S/U/X/A/M results separately. A user report remains open until its actual
presentation and interaction have been reviewed, even if all synthetic tests
pass. Reuse this matrix instead of repeatedly declaring generic phases done.

## Main panel, tabs and history

| Area | Reference and current native path | Evidence | Remaining acceptance / deliberate difference |
| --- | --- | --- | --- |
| Renderer ownership | [Window creation][main], [mode/bridge][bridge], [panel][panel] | S, A: no `/clipboard` WebView during the entire auxiliary run | Opt-in `--main-ui=winui`; WebView remains the default. This is not a renderer-default migration. |
| Bottom dock, height and monitor bounds | [Shared geometry][main], [native layout][layout], [dock motion][dock] | S, U, X: HWND bounds and size-preview regression | M: negative-origin mixed-DPI monitors, work-area changes and 100/150/200% scaling. |
| Right toolbar | [WebView header][web-header], [panel][panel], [app actions][app-actions] | S, X: realized header geometry, command order, rendered artwork and pointer targets | Match queue, settings, then the conditional update action. The migration-only combined-filter button is removed. Native command focus/press states remain native; conditional Debug/update tools are retained. |
| Tab text, icons, selected state and trailing `+` | [Header][web-header], [appearance][appearance], [panel][panel], [indicator][indicator] | S, X: Chinese/English, light/dark, 640/960-DIP headers; accent foreground, faster bounded spring and the two reference creation choices | The added Manage tags choice is removed; existing tags keep double-click/context-menu editing and deletion. Native `SelectorBar` feedback is retained. M: motion feel, font rendering and Windows contrast-theme appearance. |
| Custom filter creation/editing | [WebView filters][web-tabs], [native editor][filter-editor], [shared adapter][filters] | S, U, X: editor requests, replies, cancellation and stale-session checks | M: pointer anchor and IME entry on the displays in use. Existing filter file and field meanings are retained. |
| Record tags and mixed tab order | [WebView tabs][web-tabs], [record editor][record-editor], [tag adapter][tags], [atomic tab moves][tab-order] | S, U, X: create/assign, refresh, failed requests and editor lifetime; shared database order wins over legacy native order | M: actual tab drag/drop and emoji picker placement. No separate Windows tab-order store is introduced. |
| Search, category, favorite, source and `tag:` filters | [WebView search][web-search], [native search grammar][search], [query bridge][bridge] | S, U: quoted tag names, combined filters, UTF-16 highlight terms and existing Rust query | M: real data containing the user's source names and languages. |
| Search submission and stale results | [WebView keyboard][web-keys], [native keyboard][keys], [panel][panel] | S, X: synchronized search text, pending query/refresh guards and Enter handling | M: IME composition and quick Enter in the actual foreground App. Native `AutoSuggestBox` replaces the DOM search shell. |
| Pagination, fresh captures and retained position | [WebView lifecycle][web-lifecycle], [panel][panel], [viewport policy][viewport] | S, U, X: refresh loaded pages, retain/reset offsets and selection, stale replies and 36-card replacement | M: live capture while the panel is open/hidden. The isolated fixture intentionally has no capture listener. |
| Card content and media | [WebView card][web-card], [Rust projection][presentation], [native content][content] | S, U, X: text/emphasis/tables/colors, source metadata, image loading and card detail replacement | Native bounded card projection does not promise arbitrary HTML/CSS pixel parity. Full rich content remains available through the reader fallback. |
| Loading, empty and failure states | [Panel][panel], [queue][queue] | S, X: real control state, retry, cleared filters and stale/error responses | M: transient failures with real external resources. Failed requests must not delete history. |
| Rounded selection, hover, focus and elevation | [WebView styles][web-css], [appearance][appearance], [panel][panel] | S, X: realized rounded selection bounds and card/control surfaces | M: OS-composed shadows/backdrop, high contrast and physical mouse/keyboard focus. XAML captures exclude DWM. |

## Card operations, keyboard and queue

| Area | Reference and current native path | Evidence | Remaining acceptance / deliberate difference |
| --- | --- | --- | --- |
| Single/double-click paste and duplicate protection | [WebView item actions][web-actions], [panel bridge][bridge], [panel][panel] | S, U, X: saved click policy, child-action isolation and clipboard-action guard | M: actual target application and focus return. Core paste commands are shared, not reimplemented in XAML. |
| Standard navigation and context-menu keys | [WebView keyboard][web-keys], [native policy][keys], [panel][panel] | S, U, X: policy and control ownership; Apps/Shift+F10 menu path | M: foreground Space/arrows/Tab/Ctrl+Tab, Alt quick keys and custom plain-paste binding. Home/End/Page keys are additional native navigation. |
| Text entry, modal and menu key ownership | [WebView keyboard][web-keys], [native policy][keys], [panel][panel] | S, U, X: editor/menu/ComboBox/drag guards and repeat suppression | M: Chinese IME and actual focus transfer. A source guard alone is not proof that Windows dispatched composition events correctly. |
| Copy/paste/favorite/preview and assigned-tag menus | [WebView menu][web-menu], [panel][panel], [Rust actions][bridge] | S, U, X: actual control invocation with recorded requests, favorite/tag refresh and request identity | M: external clipboard/paste effects. Native `MenuFlyout` owns focus, keyboard and submenu behavior. |
| OCR, image export, containing folder and color formats | [WebView menu][web-menu], [native extras/picker][card-actions], [Rust adapter][actions] | S, U, X: action metadata, file picker cancellation/generation and color formats | M: real file picker, OCR availability and export files. Existing Rust operations and overwrite confirmation are retained. |
| Delete confirmation and text editing | [WebView actions][web-actions], [panel][panel], [bridge][bridge] | S, U, X: native confirmation, cancel/reply guards and edit request/identity handling | M: real editor save/close and focus return. Text editor remains an on-demand shared auxiliary window. Use disposable history for destructive checks. |
| Queue entry and repeated batch selection | [WebView queue][web-queue], [panel][panel], [Rust queue routes][queue-rust] | S, U, X: opening enters selection, successful Add clears only the submitted batch and retains mode, failure retains the draft; cancel/reenter isolates the new draft from old replies; enabled Add/Cancel topmost pointer hits and centered labels over cards in both languages/widths, with hovered cards and disabled motion/contrast overrides | M: physical pointer, live copy-to-queue and external paste target. Closing queue must leave selection mode. |
| Queue reorder, remove, reverse, clear and Undo | [WebView queue][web-queue], [native queue][queue], [Rust queue routes][queue-rust] | S, U, X: real native controls, revision/busy guards, local reorder and confirmation behavior | M: real drag handle and queue-paste/Undo flow. Existing shared queue storage and paste semantics remain authoritative. |
| Queue window, scroll and compact density | [Queue window][queue-window], [queue][queue], [appearance][appearance] | S, X: 100-item refresh, constrained viewport and 80/90/100% density | M: actual short monitors, scaling and focus continuity. Queue owns a separate HWND and does not resize/replace the main dock. |

## Preview, focus and auxiliary windows

| Area | Reference and current native path | Evidence | Remaining acceptance / deliberate difference |
| --- | --- | --- | --- |
| Common native reader and continuous navigation | [Shared preview][main], [reader routing][reader-route], [native reader][reader] | S, U, X: real history payloads, reused reader HWND, stale generations, sizing, content release and toolbar/glyph key ownership | M: hold Space, rapidly navigate across differently sized content, close and continue keyboard input. The synthetic posted-Space path explicitly skipped when Windows denied foreground activation. |
| Hover preview, pin and close races | [Shared preview][main], [preview adapter][preview], [reader route][reader-route] | S, U, X; A verifies WebView fallback pin protection and three cold close/reopen cycles | M: cross between the real card/reader, pin/unpin, switch apps and ensure no stale reopen. A fallback-window test does not establish native pointer hover. |
| Rich HTML, links, PDF, OCR and oversized content | [Shared preview][main], [native fallback decision][reader-route] | S, U; A: visible rich-preview replacement reuses its renderer, close retires it | On-demand WebView is intentional for fidelity. M: both native-to-WebView and WebView-to-native handoff with real files and links. |
| External text/link/image/multi-file drag | [WebView drag][web-drag], [native drag][drag], [Rust payload][drag-route] | S, U, X: original paths/full text, multi-file payloads, native data-package/deferral ownership and cancellation | M: Explorer/Directory Opus, OneNote and browser targets; cancel mid-drag and verify ordinary Windows file dragging still works. A cursor or accepted drop effect does not prove insertion. |
| Auto-hide and internal focus | [Shared focus/hide][main], [native blur policy][focus], [panel][panel] | S, U, X: generation, suppression, drag/modal/internal-window and protected-preview guards | M: outside click, app switching, taskbar/tray activation and auxiliary close. The isolated fixture suppresses blur hiding, so its lifecycle pass is not auto-hide acceptance. |
| React settings lifetime | [Settings window][main], [Config][config] | S, A: close destroys the window and reopening creates a new instance | Keep current React/MUI settings. No native settings migration or resident settings/main WebView. |
| Onboarding and shortcut practice | [Existing tutorial host][guide], [native positioning/shortcut route][guide-route] | S, U; native content-host regression covers ownership, bounds, movement, hide/restore and input restoration | The shipping tutorial is a temporary transparent owned content layer over the retained native dock, without a separate guide card or taskbar entry. Completion destroys that layer. M: actual tutorial layout, Alt+V practice and positioning on real monitors. |

## Settings propagation and platform contracts

| Area | Current ownership and route | Evidence | Remaining acceptance |
| --- | --- | --- | --- |
| Language, system/light/dark and click mode | [Settings][config], [save/event route][main], [native subscriptions][bridge] | S, X: theme/language control updates; existing config-change listener reapplies behavior, theme, click mode and layout | M: change settings in the App while native/auxiliary windows are open; check actual system-theme transitions. |
| Panel size, preview and cancellation | [Panel-size settings][size-setting], [shared size controller][size], [native layout][layout], [panel][panel] | S, U, X: entry during hide slide, DPI/display/work-area notifications and later layout replies, queue density | M: all three saved presets, cancel/close/focus-loss restoration and mixed-DPI screens. PR 379 contains the confirmed fixes. |
| Search/category/position retention and quick keys | [Saved preferences projection][behavior], [native keyboard][keys], [panel][panel] | S, U, X: existing values projected without a new store and show/reset policy | M: toggle each preference, hide/reopen and restart; check global shortcut registration in the ordinary App, not the no-capture fixture. |
| Storage, cleanup, privacy, OCR and update policy | [Existing settings][config], [shared Rust host][main], [app tools][app-actions] | S: native requests keep existing Rust commands/config; capture policies remain in the shared listener | M: storage/import/reset/cleanup only against disposable data; actual capture, permissions, updater and tray are not exercised by the fixture. No schema/default migration was made. |
| Motion and accessibility | [Shared motion data][motion-tokens], [native motion][motion], [dock][dock], [appearance][appearance] | S, U, X: shared parameters, animations-disabled feedback and contrast overrides; actual controls retain automation names | M: Windows animation preference, contrast theme, Narrator and physical keyboard focus. Native control transitions remain SDK-owned. |
| Platform/build isolation | [Private bridge contract][bridge-doc], [build][build], [renderer selection][mode] | S, U; required Windows/macOS CI passed for PR 379 | No macOS UI, installers, release files, database/config formats, or default-renderer changes in this pass. Windows 10 and clean-machine distribution remain untested here. |

## Confirmed fixes and remaining differences

Stage 1 submitted Issue 378 / PR 379 and synchronized local `main` to `c573d83`.
It fixes three reproduced defects: selected-tab foreground not following the
accent, size previews being interrupted/hidden by old dock motion or display
notifications, and constrained/density-scaled queue content bounds. Each has a
failing-before/passing-after actual-XAML/HWND regression recorded in the parity
history. Existing required frontend and Windows/macOS Rust checks passed.

The initial stage-2 source/route inventory and stage-3 isolated lifecycle run did
not reproduce an additional product defect. That run did not test actual pointer
hit targets for the queue action bar; the subsequent desktop report exposed the
gap and led to the follow-up below.
The tables retain the native control, bounded rich-card, reader fallback and
temporary tutorial differences explicitly. This is not a claim of complete
pixel parity or completed physical desktop acceptance. No new design decision
is required to preserve the currently approved boundaries.

### Desktop-report follow-up: queue hit testing and header parity

The queue Add and Cancel controls were enabled and visible, but XAML hit tests
at sampled button points selected the cards underneath.
Increasing `Canvas.ZIndex`, increasing elevation, and waiting for the fade to
settle did not fix the miss. Removing elevation isolated the interaction with
the feedback animation: the shared helper mixed XAML `Translation` with
`GetElementVisual` opacity. Feedback now uses `UIElement.StartAnimation` and
`StopAnimation` through the XAML facade, with no change to the approved shadow
elevations or window geometry. Its per-element active animation is stopped on
interruption/disabled motion. Title/count text is explicitly centered.

The native-only combined-filter button and third Manage tags choice are removed
to match the two WebView creation entries. Saved filters, tag assignment,
double-click/context-menu tag editing, and queue behavior remain intact. Header
columns close the removed button's gap. The shared `spring.tabIndicator` preset
gives the native underline a quicker, moderately underdamped response; existing
React spring presets and native dock motion are unchanged.

The follow-up inspected the remaining header command order/visibility, tab
editing/creation, selection-mode entry/exit, feedback dismissal, keyboard
ownership and existing card/queue menus. It retains previously agreed native
focus, menu and confirmation behavior instead of introducing another redesign.

### Consolidated closeout: selection-session ownership

A further real-XAML regression reproduced canceling an in-flight Add, reentering
selection and selecting the same card: the old success cleared the new draft.
Leaving selection now invalidates the pending request and submitted hashes.
This does not cancel an already committed Rust queue write. Its state can still
arrive, while only the current selection request may clear the current draft.
Late failure, current failure/retry and duplicate success are also regressed.

That closeout traced input/menu/IME guards, auto-hide generations, preview request
and owner lifetimes, configuration projection, native drag cleanup, physical
monitor geometry and interrupted dock motion. No further defect was demonstrated
in those inspected paths. Source inspection and injected HWND events do not
establish external-App, physical IME or multi-monitor acceptance.

### Extended continuity follow-up

Native reader focus handoffs now target its content surface, so content keys do
not land on the pin button. Explicit toolbar focus retains native activation.
Bare Escape on ordinary main-panel action buttons follows the existing dismiss
route; native menus, dialogs, editors, modified keys and IME retain ownership.

History dataset replacement now also retires an in-flight selection Add and
its busy/snapshot state. The Rust queue remains authoritative; an old write may
still finish, but its response cannot clear a new dataset's selection draft.
A reset closes and retires the old item-delete dialog. Its completion checks
dialog identity, so even a Primary result resolving during replacement cannot
delete from the new dataset or clear a later dialog's state.

### Search dismissal and dataset-owned editors

Visible search now retains two-step Escape priority after focus moves to cards
or ordinary toolbar buttons: clear text, then collapse search. Only a closed
search lets those buttons dismiss the dock. Native menus/editors, composition
and modified Escape retain their existing key ownership.

History reset now also retires record-tag and custom-filter flyouts, pending
replies and queued focus-return callbacks. Late tag creation cannot start an
assignment against replacement history. Late filter completion cannot apply an
old list or close a fresh editor; successful writes still request the current
authoritative list. This does not cancel or roll back submitted Rust writes.

### Pending actions and fresh-show search

History reset cancels the old image-export UI session and closes card and
dynamic-tag/filter context menus before replacement query results arrive.
Late export preparation cannot open a save picker; reset during its chooser
cannot send a new export request. Modal begin/end remain paired. Already
submitted Rust writes remain authoritative, and fresh export, failure/retry
and current-data menu actions retain their existing native controls.

Fresh main-panel shows now clear and collapse search when search retention is
off. Enabled retention preserves text and visibility; same-session restoration
does not reset search. This matches the React WebView show plan.

### Overlay cancellation and deferred search

Opening a custom-filter editor, item-delete confirmation, app-level native
modal or main-panel menu cancels a waiting Enter-to-paste action. Covered menus
are card, record-tag, filter-tag, creation and developer-tools flyouts, including
pointer-opened menus. Cancel-before-query-completion
must not revive it. Queries still refresh history, and a new explicit ordinary,
plain-text or quick submission remains usable once. Already dispatched Rust
operations are unchanged. Hiding the panel also cancels an unconfirmed item
deletion instead of revealing the old prompt on the next show. Actual native
card, dynamic-tag/filter and creation-menu hide/reopen already passed and retain
their automatic dismissal mechanism.

## Verification record

### Latest desktop-report follow-up, 2026-11-17

This batch preserves the user's accepted external drag implementation and the
existing React settings window. It does not introduce a native tray menu.

| Report | Correction and executable evidence | Physical acceptance still needed |
| --- | --- | --- |
| Tab labels remain after reorder | Reuse SelectorBarItem instances by stable ID, disable outgoing item transitions and cancel owned drop animations. XAML checks repeat mixed-width reorder, visual descendant counts and settled non-overlapping rectangles. | Repeated pointer dragging, including overflow and fast reversals. |
| Only tab text is clickable | The stretched template root has a transparent hit-test background. XAML verifies rectangle corners as well as the label. | Ordinary pointer clicks around the label. |
| Final tutorial illustration flashes | Hide the finishing content before completion IPC, ignore late shown events while completing, then hide the owned host before detaching/destroying it. Browser tests cover completion and retry; actual App checks guide release. | The final DWM-composed frame after clicking Finish. |
| Cards show dates | Match `formatRelativeTime`: seconds, minutes, hours, days, months and years, in both languages. Native boundary assertions cover the reference thresholds. | Check familiar old/new history against the shipping UI. |
| Queue/settings artwork differs | Reuse the shipping Material SVG paths on the existing round native commands. Explicitly scale the 24-unit geometry to 16 DIP: setting PathIcon dimensions alone clipped it. An actual rendered-centroid assertion failed before scaling and passes after it. Header captures were inspected. | Appearance at the user's actual DPI. |
| Tray should keep the WebView design | Preserve `src/tray` and its styled WebView. Windows warms it hidden and reuses it after dismissal; opening latency is logged. | Shell right-click latency, pause/update state and outside-click dismissal. |
| Settings dragging captures desktop input | Earlier packed-coordinate IPC workaround was rejected by the user's physical test and removed; see the media/settings follow-up above for WebView2 caption regions. Same-monitor display notifications remain deduplicated. | Real hold/move/release, followed by clicking another application without Alt+Tab. No physical pass is inferred from DOM/IPC or programmatic movement. |
| File cards differ from the reference | Reuse material-icon-theme filename/parent/extension/light-dark associations and the product's TXT/folder/multiple/mixed artwork, canvas, badge and compact path rules. Seven actual presentations render in both themes; file-card captures were inspected. | Real single/multiple/folder/missing-file cards and actual thumbnail availability. |

Verification artifacts are local in `.codex/tmp/winui-review-20261117/`:

- Style architecture, production and native-debug frontend builds, embedded
  native-debug assets, formatting and diff checks pass. Ordinary Windows
  compilation without the WinUI feature also passes.
- Frontend units: 113 files / 821 tests pass with the entire six-test
  `uploadPublishedReleaseAssets.test.ts` file excluded. Four release-script
  cases failed in the full run because this machine lacks `jq`; this work does
  not modify release scripts or claim those cases passed. After the final icon
  change, its focused group passes 3 files / 15 tests.
- WinUI Rust: 62 pass with two interactive suites excluded from that count;
  settings drag: 2 pass; panel-size policy: 3 pass. Separate actual-XAML runs
  pass shell stage 255 and history/queue stage 153. Posted-Space assertions
  explicitly skip when Windows refuses foreground activation.
- The latest actual App uses a marked synthetic profile under `src-tauri/tmp`.
  It passes six inactive-queue mutation guards, visible preview reuse/pinning,
  three close/reopen cycles, settings destruction/recreation and guide release;
  no main WebView is created. An earlier fixture under `.codex` could not write
  its search index because of that directory's ACL; no permissions were changed.
  The final writable fixture passed. Only that temporary process was stopped.

No submission, hosted workflow, ordinary user-data mutation, default renderer
change or macOS native UI change is included. Native XAML, actual-App and browser
results remain separate from physical-desktop acceptance.

### Reported regression batch, 2026-11-16

The user's reported differences are tracked as concrete scenarios, not closed
by the presence of similarly named native commands. The full configuration
inventory is in [Windows native settings parity](windows-winui-settings-parity.md).

| Report | Correction / evidence | Remaining physical boundary |
| --- | --- | --- |
| Reordered tabs leave duplicates | Remove the internal ItemsView transition provider; repeated rebuilds count actual SelectorBarItem descendants and check settled geometry | Drag across mixed-width/overflowing tabs using the mouse |
| Welcome appears all at once | Mount after the owned host's shown event, predecode the logo, and hide the normal-motion welcome before its first animation frame | Perceived sequence on the ordinary dock; reduced motion intentionally skips spatial emphasis |
| Preview size changes stutter | Replace the layout-dispatcher timer with a DWM-paced posting worker; only the owning STA changes HWND bounds | Frame cadence is measured, not a guarantee against all desktop scheduling stalls |
| Tutorial switches do not match the header | Emit the shared saved-tabs event after initial seeding and each saved toggle; actual-App toggles change and restore persisted fixture tabs | Pointer interaction with the ordinary native header |
| Hover/Space stops after filtering | Clear both hover hash and pointer position on cancellation; focus the live history after tab changes | Foreground-dependent posted-Space test explicitly skips if Windows denies focus |
| Photo/link layout differs | Restore centered downscale-only photos, image-bound checkerboard and dimension overlay; restore link icon/cover sizing, one-line title/URL and spacing | Real cached assets, GIF playback and failed external metadata; arbitrary rich HTML retains its reader fallback |
| Record-tag edit has Delete | Hide the extra edit-form action; test deletion through its existing explicit context action | Ordinary context-menu placement |
| Emoji choices arrive late | Remove GridView item entrance transitions and prepare theme/selection in Opening | Cold physical click latency is not inferred from a resting screenshot |
| OneNote rejects drag | Keep one WinUI session, announce formats before async Rust preparation, retain deferred values/cancellation, use the shared Shell data-object mechanism for files, and supply the reference link HTML | Every card type in OneNote; QQ/WeChat/Explorer must keep working. Package tests alone do not establish target insertion |
| Queue selection changes/crops cards | Disable native multi-select checkboxes/gutters; compare card surface X/width/height before and after selection | Ordinary pointer selection and Add |
| Toolbar differs | Reference order/meaning, 28-DIP round targets and 16-DIP content; use the existing queue icon geometry | Visual acceptance at the user's DPI |
| Tray takes about a second | Superseded by the 2026-11-17 correction: retain the styled WebView, prewarm hidden and reuse it after dismissal | Ordinary shell opening and pause/language/update refresh |
| Retain-category alternates | Use requested visibility for fresh-show preparation, including interrupted hide/reopen; on/off repeated HWND tests | The exact alternating symptom was not independently reproduced in the ordinary App |
| Settings drag stalls desktop | Deduplicate display notifications by HWND, monitor/work area and DPI; actual-App same-monitor movement emits no repeated notification | Programmatic movement did not reproduce the physical modal mouse-drag stall; manual acceptance is still required |

Verification artifacts for this batch stay in the ignored local task directory.
No GitHub Actions were added or dispatched. No ordinary history, storage path,
startup registration, release state or macOS native implementation is changed
by the isolated checks. Do not report this table as fourteen physical passes.

Local verification of this batch:

- Windows WinUI build and ordinary Windows `cargo check` both pass. Formatting,
  style architecture, native-debug frontend build and embedded asset isolation
  checks pass.
- Focused frontend unit tests: 20 passed. Rust WinUI tests: 70 passed, with the
  two desktop suites excluded from that count; panel-size policy tests: 3 passed.
  The separately run real-XAML suites pass history/queue stage 153 and shell
  stage 255. Posted Space remains explicitly skipped when foreground is denied.
- Welcome browser behavior tests cover two languages, two themes and both
  motion modes. A further failing regression identified the missing exported
  Logo CSS Module selector; the shared welcome now actually targets that image
  rather than only animating its parent and text.
- The actual isolated App passes first-paint opacity, two saved tutorial-filter
  toggles and their events, preview reuse/pinning/cold close-reopen, settings
  destruction/recreation and guide release, without creating a main WebView.
- Before the async drag fix, immediate OLE text-format negotiation failed with
  `0x8004006A`. All six card types now announce their applicable formats before
  data preparation. Deferred text/HTML/link/storage reads and canceled provider
  requests pass; the native file test reads both original paths from CF_HDROP.
- Reader resize moved from a 7-frame sample averaging 45.92ms to a final
  16-frame sample averaging 16.06ms (maximum 20.52ms). An intermediate run still
  had a 58.89ms scheduling gap; these samples are not a physical smoothness pass.
- Actual-App settings movement removes repeated display notifications. The
  [configuration report](windows-winui-settings-parity.md) records the timing
  and why that does not establish resolution of a physical modal-drag stall.
- The full frontend suite is not reported as green: its earlier run had 812
  passes and six unrelated release-upload fixture/environment failures. No
  hosted visual checks were run. macOS runtime and external OneNote insertion
  were not tested by this Windows isolated run.

Overlay/deferred-search evidence is under ignored
`src-tauri/tmp/winui-overlay-continuity-20261115/`:

- `history-red.log` fails at stage 151: all three canceled overlays retain
  deferred paste and the hidden-panel delete dialog remains active. Existing
  card/tag/filter/creation-menu hide/reopen checks already pass, so their
  automatic dismissal is unchanged.
- `history-menu-red.log` then reproduces deferred paste after cancellation for
  all five native menu origins: card, record tag, filter tag, creation and
  developer tools. The previously fixed dialog paths still pass in this run.
- `history-final.log` passes stage 151. All eight interrupted-search paths
  retire their action and prevent late paste. Fresh explicit submissions and
  duplicate replies are covered, including ordinary, plain-text and quick paste.
  Hidden delete cancellation sends no delete and a fresh confirmation works.
- `shell-final.log` passes stage 21; `rust-winui-final.log` has 68 passes and two
  ignored desktop suites, both executed separately above. Frontend/Motion has
  72 passes across 18 files. Production TypeScript/Vite build, style, formatting
  and diff checks pass. Frontend inputs are unchanged by the final menu fix.
- Synthetic recording-bridge data avoids real pastes, deletions and updates.
  Foreground-only reader/posted-Space assertions explicitly skip when Windows
  denies focus. Physical keyboard/IME, live capture/external targets, DPI/DWM,
  Windows 10 and macOS still require manual acceptance. Existing full-frontend
  release-upload environment limitations are not reclassified as passes.

Pending-action/fresh-show evidence is under ignored
`src-tauri/tmp/winui-pending-actions-20261115/`:

- Before the export fix, `history-red.log` fails at stage 144: the old session
  stays active, its delayed preparation opens a chooser, and reset inside that
  chooser still submits a stale export request. Choosers and writes are mocked;
  no real file picker or filesystem write occurs in these regression cases.
- After the export fix, `history-menu-red.log` reaches stage 147 and reproduces
  all three old context menus remaining open plus the fresh-show search mismatch.
- `history-final.log` passes stage 147 with both export reset paths, late
  replies, fresh export failure/retry, actual loaded card/tag/filter flyouts,
  replacement-data Copy and retained/reset/same-session search checks.
- `shell-final.log` passes stage 21; focused Rust has 68 passes and two ignored
  desktop suites, both executed separately above. Frontend/Motion has 72 passes
  across 18 files. Production TypeScript/Vite build, style, formatting and diff
  checks pass. Foreground-only reader/posted-Space assertions explicitly skip;
  physical keyboard/IME, external paste/drag, mixed-DPI and DWM remain manual.
- Tests use synthetic data and the recording bridge. No hosted workflow or
  changes to shared business/config/database, macOS, installers or renderer
  defaults are part of this follow-up. Earlier fixture/resource measurements
  are not Release benchmarks or physical-desktop acceptance.

Search/editor follow-up evidence is under ignored
`src-tauri/tmp/winui-search-editors-20261115/`:

- `history-red.log` reaches stage 143 and records all three failures: search
  Escape priority is false, the old tag editor remains active and chains an
  assignment, and the old filter editor overwrites the replacement projection.
- `history-final.log` passes stage 143 with loaded native flyouts, delayed old
  replies and fresh-session saves. Search checks include card/toolbar input
  areas and modifier, blocked-control and composition guards, using the same
  synchronized query state supplied by PreviewKeyDown.
- `shell-final.log` passes stage 21. `rust-winui-final.log` has 68 passes and two
  ignored desktop suites, which were separately run above. `frontend-final.log`
  has 72 passes across 18 files. Style architecture, formatting and diff checks
  pass. The existing synthetic reader/history/100-row queue cycles still run.
- All editor operations use the synthetic recording bridge, not user data.
  Foreground-dependent reader focus and posted-Space checks explicitly skip
  when Windows denies activation. Physical keyboard/IME, external paste/drag,
  real DPI and DWM acceptance remain manual. No hosted workflow was run.
- The normal launcher passes the native-debug TypeScript/Vite build, asset
  isolation and Rust/native Debug build with existing warnings. One ordinary
  WinUI Debug process and its exact checkout DLL were verified after launch;
  no fixture/CDP arguments remain.

Extended continuity evidence is under ignored
`src-tauri/tmp/winui-continuity-20261115/`:

- `reader-content-red.log` fails at stage 1182 for the missing content focus
  host; `queue-reset-red.log` fails at shell stage 181 for the retained Add
  request. `delete-reset-red.log` fails at stage 136 with the old confirmation
  still active. `toolbar-escape-red.log` fails at stage 139 for button-origin
  Escape. These are assertion stages, not individual test counts.
- `history-final.log` passes through stage 139, including replacement-data
  selection, reset during a dialog's Primary close, normal deletion, duplicate
  confirmation prevention, toolbar/glyph routing and modified/IME guards.
  `shell-final.log` passes through stage 21, including the reset request guard,
  interrupted motion, system-policy branches and constrained queue layout.
- 72 related frontend/Motion tests across 18 files pass; the WinUI-filtered Rust
  suite has 68 passes and two desktop tests ignored there and run separately
  above. Style architecture, formatting and diff checks pass. Reader captures
  in light/Chinese and dark/English are byte-identical to the preceding batch;
  the new focus host did not change those layouts. Captures exclude DWM.
- Windows denied physical foreground activation for reader-focus and posted-
  Space assertions, which explicitly skipped. Handler/control tests do not
  establish actual keyboard dispatch, physical IME, external paste or mixed DPI.
  No hosted Actions or user data were used for these native fixture regressions.
- The normal Debug launcher also passed the TypeScript/native-debug frontend
  build, asset-isolation check and Rust/native build with existing warnings.
  One ordinary WinUI Debug process was restored and its exact checkout DLL
  verified; no fixture/CDP arguments remain. Physical acceptance is still open.

Native reader keyboard follow-up evidence is under ignored
`src-tauri/tmp/winui-auxiliary-input-20261115/`. `reader-key-red.log` reproduces
toolbar Space being consumed by the reader at stage 1181. `reader-key-green.log`
passes through stage 134 after checking button/glyph origins, native pin/close
invocation, Escape and preserved content shortcuts. It exercises the production
key handler with realized controls, not physical keyboard dispatch. Windows
denied foreground activation for the separate posted-Space check, which skipped.

Consolidated closeout evidence is under ignored
`src-tauri/tmp/winui-closeout-20261115/`:

- `queue-session-red.log` fails at stage 132: the old reply clears the reentered
  draft (`selected=0 enabled=0`). `history-green.log` passes through stage 134
  with that draft retained (`selected=1 enabled=1`), late/current failure, retry
  and duplicate-response checks. These stage numbers identify assertions within
  one native test, not separate test-case counts.
- `shell.log`: actual-XAML/HWND shell stage 21 passed again, including spring,
  interrupted motion, geometry notifications and constrained queue density.
- `rust-winui.log`: 68 passed, two desktop suites ignored in that command and
  run separately. `rust-queue.log`: 45 focused queue/activation/storage tests
  passed. These filtered suites overlap; do not sum them as unique test cases.
- `lifecycle.log`: the actual Debug App, isolated synthetic database and Tauri
  IPC passed six inactive-queue mutation guards without changing queue state,
  visible reader reuse/pin protection, three cold close/reopen cycles, settings
  destruction/recreation and guide release. No main WebView was created. The
  queue was not activated; no clipboard hook or external paste was tested.
- Native Debug build, 22 related source-contract/Motion tests, style check and
  Rust formatting passed. Restarting through the normal Debug launcher also
  passed the native-debug frontend build and asset-isolation check. The
  preceding frontend production build and 797-case
  unit run remain applicable to unchanged frontend inputs, with the same six
  unrelated release-upload test failures/exclusion documented below.
- The marked fixture was stopped after verification. Foreground-dependent
  assertions still explicitly skipped where Windows denied activation. Physical
  DPI, DWM, input, live capture and external paste remain pending below. No
  workflow, macOS implementation, installer or release file was changed.

Follow-up evidence is under ignored
`src-tauri/tmp/winui-final-parity-20261115/`:

- `history-red.log` reproduces enabled Add/Cancel missing pointer hits and
  uncentered labels at stage 115. `shell-red.log` rejects the old slower spring
  at stage 14. `header-red.log` rejects the extra native entry point.
- `history-hit-geometry.log` records the flat-versus-elevated diagnostic.
  `history-green.log` passes the final real-XAML history/queue stage 131,
  including pointer targets, Add button invocation with selected hashes,
  feedback close, header controls and reduced-motion/contrast overrides.
- `shell-green.log` passes real-XAML/HWND stage 21, including the faster spring,
  immediate disabled-motion settlement, header layout, dock interruption,
  geometry and queue density. Local synthetic captures include both languages,
  light/dark and the narrow header/selection bar.
- `rust-winui-unit.log`: 68 passed, zero failed, two desktop suites ignored
  here and run separately above. Rust formatting and style architecture passed.
- `frontend-unit-final.log`: 797 passed across 110 files. The full unit run
  initially also executed the unchanged six release-upload shell tests, which
  fail because this Windows host resolves Bash to WSL while the fixture supplies
  `C:/...` asset paths (`Release assets directory not found`). They are recorded
  in `frontend-unit.log`, not relabeled as passing or edited in this UI change.
  The final run excludes only that unrelated file. Production frontend build
  passed (`frontend-build.log`).
- Physical foreground-dependent posted-Space/queue-focus assertions remain
  explicitly skipped when Windows denies activation. Actual mouse/keyboard,
  DWM/backdrop and mixed-DPI acceptance still belong to the manual pass below.
  No GitHub Actions were added, modified or dispatched.

Earlier stage-2/3 evidence is under ignored
`src-tauri/tmp/winui-parity-stages123-20261115/`:

- `auxiliary-lifecycle.log`: actual Debug App + marked synthetic database +
  WebView2 CDP. `node scripts/check-winui-auxiliary-lifecycle.mjs <marked-fixture>`
  passed visible reader reuse, pinned-content protection, three cold
  cancellation/reopen cycles, settings destruction/recreation, guide release
  and absence of a main WebView. No saved user settings/history were used.
- `winui-audit-unit.log`: `cargo test --manifest-path src-tauri/Cargo.toml
  --features winui-debug --bin vPaste winui_ -- --test-threads=1` passed 68
  tests with zero failures. The two desktop suites are ignored in this command;
  their separate actual-XAML results are listed below, not counted as 68 passes.
- Source/XAML/build results from the immediately preceding implementation pass
  remain valid: the merged product files have the same content identities.
  See `submission-evidence.md` for exact commands/blob identities and
  `src-tauri/tmp/winui-desktop-parity-polish-20261115/` for their full output.
  The two desktop suites passed shell stage 21 and history/queue stage 131;
  foreground-dependent posted-Space/queue assertions explicitly skipped.
- Browser/Tauri-mock results are supplementary only; they cannot render this
  XAML or establish native focus. No workflow was modified or dispatched.
- All 51 local reference targets in this matrix resolve, all reference labels
  are defined, and `git diff --check` passed. Those initial stages added
  documentation only; their product sources were byte-identical to PR 379.
  Their unchanged successful style, frontend build, formatting and XAML checks
  are reused. No hosted check
  was manually dispatched and no visual snapshot was reapproved.

## One consolidated manual desktop pass

All entries below are **pending** physical acceptance. Use the actual Debug
build, your normal target applications and disposable records where appropriate.
One session can cover several rows; no per-control review round trip is needed.

1. **Composition and settings:** check the trailing `+`, tab labels/indicator,
   queue/settings/conditional-update toolbar and rounded card selection; change language, theme,
   single/double-click and all three panel sizes. Preview/cancel/close a size
   change and reopen settings. Check the persisted result after restarting.
2. **Input and auto-hide:** use a Chinese IME, quick Enter after search,
   Space/hold-Space, arrows/Tab/Ctrl+Tab, Alt quick selection and the custom
   plain-paste binding. Open menus/editors/confirmation first and verify those
   keys operate the control instead of pasting another card. Click outside,
   switch apps and return through the tray/global shortcut. Cancel filter/delete
   dialogs or menus after a search submission, then search again; delayed
   results must not paste after cancellation. Check update cancellation only
   when offered. Hide/reopen with a delete confirmation open; the old prompt
   must stay closed and a fresh confirmation must remain usable.
3. **Reader continuity:** mix text, tall/wide images, files, rich HTML, links,
   PDF and OCR. Navigate rapidly through both renderers, pin/unpin, hover across
   card and reader, then close during loading. No stale reader may reopen;
   keyboard input must return to the dock. In the native reader, focus the pin
   or close button: Space activates it, Tab/Shift+Tab navigate controls and
   Escape closes the reader. Content-origin preview shortcuts still work after
   automatic focus handoff, without first focusing a toolbar button.
4. **Queue and destructive actions:** enter selection by opening queue, add
   two batches, cancel/reenter during an Add and select again, then
   reorder/remove/reverse, paste and Undo. Verify
   queue focus/scroll. Test delete/edit/clear confirmation with disposable items;
   test storage/import/reset/cleanup only in a separate disposable data profile.
   After a history reset, an old Add must not block a new selection and an old
   delete confirmation, image-export chooser and item/tag context menus must
   close; use only disposable data for that reset check. Separately verify
   ordinary image export/cancel/retry. Focus an ordinary toolbar/card button and
   verify bare Escape dismisses the panel while menus retain their own Escape.
5. **External drag/paste:** try text, link, image, several files and a folder
   against OneNote, Explorer/Directory Opus and a browser. Check actual dropped
   content, cancel a drag, and then drag an ordinary file in Explorer. Distinguish
   a target application's unsupported format from a vPaste regression.
6. **Physical displays:** check the displays/scales in use (100/150/200% where
   available), including a negative-origin monitor, work-area/taskbar changes,
   queue placement and preview/editor anchors. Repeat show/hide and size preview
   while moving between monitors. Do not infer this pass from injected events.
7. **System presentation:** check real DWM shadows/Acrylic in light/dark,
   animations enabled/disabled, Windows contrast theme and Narrator. Windows 10
   requires a separate machine; it has not been tested by this Windows 11 run.
8. **Ordinary App services:** verify live copy capture while hidden/visible,
   sensitive/ignored-source exclusions, tray and global shortcuts, tutorial
   shortcut practice, on-demand settings close/reopen and external paste focus.
   The isolated automated fixture intentionally disables several such services.

[main]: ../../../src-tauri/src/main.rs
[mode]: ../../../src-tauri/src/main_panel_mode.rs
[bridge]: ../../../src-tauri/src/winui_panel.rs
[bridge-doc]: ../development/windows-winui-bridge.md
[layout]: ../../../src-tauri/src/winui_panel/layout.rs
[panel]: ../../../src-tauri/native-demo/windows/winui/WinUiPanel.cpp
[appearance]: ../../../src-tauri/native-demo/windows/winui/WinUiAppearance.h
[dock]: ../../../src-tauri/native-demo/windows/winui/WinUiDockMotion.h
[indicator]: ../../../src-tauri/native-demo/windows/winui/WinUiTabIndicator.h
[web-header]: ../../../src/clipboard/ClipboardHeader.tsx
[web-tabs]: ../../../src/clipboard/customTabs.ts
[web-search]: ../../../src/clipboard/clipboardSearch.ts
[web-keys]: ../../../src/clipboard/clipboardKeyboard.ts
[web-lifecycle]: ../../../src/clipboard/useClipboardLifecycleSubscriptions.ts
[web-card]: ../../../src/clipboard/ClipboardCard.tsx
[web-css]: ../../../src/clipboard/Clipboard.module.css
[web-actions]: ../../../src/clipboard/clipboardItemActions.ts
[web-menu]: ../../../src/clipboard/clipboardContextMenu.ts
[web-queue]: ../../../src/clipboard/PasteQueue.tsx
[web-drag]: ../../../src/clipboard/clipboardDrag.ts
[filter-editor]: ../../../src-tauri/native-demo/windows/winui/WinUiFilterEditor.cpp
[filters]: ../../../src-tauri/src/winui_panel/filters.rs
[record-editor]: ../../../src-tauri/native-demo/windows/winui/WinUiRecordTagEditor.cpp
[tags]: ../../../src-tauri/src/winui_tags.rs
[tab-order]: ../../../src-tauri/src/winui_panel/tab_order.rs
[search]: ../../../src-tauri/src/winui_panel/search.rs
[viewport]: ../../../src-tauri/native-demo/windows/winui/WinUiHistoryViewport.cpp
[presentation]: ../../../src-tauri/src/winui_panel/presentation.rs
[content]: ../../../src-tauri/native-demo/windows/winui/WinUiCardContent.cpp
[keys]: ../../../src-tauri/native-demo/windows/winui/WinUiKeyboard.cpp
[card-actions]: ../../../src-tauri/native-demo/windows/winui/WinUiCardActions.cpp
[actions]: ../../../src-tauri/src/winui_panel/actions.rs
[queue]: ../../../src-tauri/native-demo/windows/winui/WinUiQueueView.cpp
[queue-window]: ../../../src-tauri/native-demo/windows/winui/WinUiQueueWindow.cpp
[queue-rust]: ../../../src-tauri/src/winui_queue.rs
[reader-route]: ../../../src-tauri/src/winui_panel/reader.rs
[reader]: ../../../src-tauri/native-demo/windows/winui/WinUiReader.cpp
[preview]: ../../../src-tauri/src/winui_panel/preview.rs
[drag]: ../../../src-tauri/native-demo/windows/winui/WinUiDrag.cpp
[drag-route]: ../../../src-tauri/src/winui_panel/drag.rs
[focus]: ../../../src-tauri/src/winui_panel/focus.rs
[config]: ../../../src/config/Config.tsx
[guide]: ../../../src/clipboard/NativeOnboardingWindow.tsx
[guide-route]: ../../../src-tauri/src/winui_panel/onboarding.rs
[size-setting]: ../../../src/config/sections/PanelSizeSetting.tsx
[size]: ../../../src-tauri/src/panel_size.rs
[behavior]: ../../../src-tauri/src/winui_panel/behavior.rs
[app-actions]: ../../../src-tauri/native-demo/windows/winui/WinUiAppActions.cpp
[motion-tokens]: ../../../src/ui/motion/tokens.json
[motion]: ../../../src-tauri/native-demo/windows/winui/WinUiMotion.h
[build]: ../../../src-tauri/build.rs
