# Windows WinUI current parity and desktop acceptance

Audit date: 2026-11-15. Product baseline: `c573d83` (PR 379).
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
| Right toolbar | [WebView header][web-header], [panel][panel], [app actions][app-actions] | S, X: realized header geometry and command order | Settings is deliberately last, as requested. Native command focus/press states remain native; conditional Debug/update tools are retained. |
| Tab text, icons, selected state and trailing `+` | [Header][web-header], [appearance][appearance], [panel][panel], [indicator][indicator] | S, X: Chinese/English, light/dark, 640/960-DIP headers; selected foreground checked against actual accent indicator | Native `SelectorBar` feedback is retained. M: font rendering and Windows contrast-theme appearance. |
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
| Queue entry and repeated batch selection | [WebView queue][web-queue], [panel][panel], [Rust queue routes][queue-rust] | S, U, X: opening enters selection, successful Add clears only the submitted batch and retains mode, failure retains the draft | M: live copy-to-queue and external paste target. Closing queue must leave selection mode. |
| Queue reorder, remove, reverse, clear and Undo | [WebView queue][web-queue], [native queue][queue], [Rust queue routes][queue-rust] | S, U, X: real native controls, revision/busy guards, local reorder and confirmation behavior | M: real drag handle and queue-paste/Undo flow. Existing shared queue storage and paste semantics remain authoritative. |
| Queue window, scroll and compact density | [Queue window][queue-window], [queue][queue], [appearance][appearance] | S, X: 100-item refresh, constrained viewport and 80/90/100% density | M: actual short monitors, scaling and focus continuity. Queue owns a separate HWND and does not resize/replace the main dock. |

## Preview, focus and auxiliary windows

| Area | Reference and current native path | Evidence | Remaining acceptance / deliberate difference |
| --- | --- | --- | --- |
| Common native reader and continuous navigation | [Shared preview][main], [reader routing][reader-route], [native reader][reader] | S, U, X: real history payloads, reused reader HWND, stale generations, sizing and content release | M: hold Space, rapidly navigate across differently sized content, close and continue keyboard input. The synthetic posted-Space path explicitly skipped when Windows denied foreground activation. |
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

The stage-2 source/route inventory and stage-3 isolated lifecycle run did not
reproduce an additional product defect requiring another implementation change.
The tables retain the native control, bounded rich-card, reader fallback and
temporary tutorial differences explicitly. This is not a claim of complete
pixel parity or completed physical desktop acceptance. No new design decision
is required to preserve the currently approved boundaries.

## Verification record

Local evidence for this pass is under ignored
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
  are defined, and `git diff --check` passed. Stages 2-3 add documentation only;
  the product sources are byte-identical to PR 379. Their unchanged successful
  style, frontend build, formatting and XAML checks are reused. No hosted check
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
   switch apps and return through the tray/global shortcut.
3. **Reader continuity:** mix text, tall/wide images, files, rich HTML, links,
   PDF and OCR. Navigate rapidly through both renderers, pin/unpin, hover across
   card and reader, then close during loading. No stale reader may reopen;
   keyboard input must return to the dock.
4. **Queue and destructive actions:** enter selection by opening queue, add
   two batches, cancel selection, reorder/remove/reverse, paste and Undo. Verify
   queue focus/scroll. Test delete/edit/clear confirmation with disposable items;
   test storage/import/reset/cleanup only in a separate disposable data profile.
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
