# Windows WinUI current parity and desktop acceptance

Audit date: 2026-11-15. Closeout base: `3153543` (PR 381), including the earlier
`c573d83` (PR 379) implementation. The follow-up is recorded below.
This is the current acceptance index; [windows-winui-parity.md](windows-winui-parity.md)
retains the chronological implementation and regression history.

The reference UI is the shipping **React WebView**, not Vue. Preserve its
layout, operations and Rust behavior; use actual WinUI controls for native
input, menus and dialogs. This audit does not switch the default renderer,
remove the WebView implementation, change distribution or benchmark Release.

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

## Main panel, tabs and history

| Area | Reference and current native path | Evidence | Remaining acceptance / deliberate difference |
| --- | --- | --- | --- |
| Renderer ownership | [Window creation][main], [mode/bridge][bridge], [panel][panel] | S, A: no `/clipboard` WebView during the entire auxiliary run | Opt-in `--main-ui=winui`; WebView remains the default. This is not a renderer-default migration. |
| Bottom dock, height and monitor bounds | [Shared geometry][main], [native layout][layout], [dock motion][dock] | S, U, X: HWND bounds and size-preview regression | M: negative-origin mixed-DPI monitors, work-area changes and 100/150/200% scaling. |
| Right toolbar | [WebView header][web-header], [panel][panel], [app actions][app-actions] | S, X: realized header geometry, command order and pointer targets | Settings is deliberately last, as requested. The migration-only combined-filter button is removed. Native command focus/press states remain native; conditional Debug/update tools are retained. |
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
| Onboarding and shortcut practice | [Existing tutorial host][guide], [native positioning/shortcut route][guide-route] | S, U; A: temporary guide opens, restores the native main panel and releases on completion | Reuse the shipping tutorial in a temporary WebView aligned to the dock. M: Alt+V hide/show practice and positioning on real monitors. |

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
   Settings-last toolbar and rounded card selection; change language, theme,
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
