# Windows WinUI current parity and desktop acceptance

Audit date: 2026-11-15; latest desktop-report follow-up: 2026-11-21. Closeout base: `3153543` (PR 381), including the earlier
`c573d83` (PR 379) implementation. The follow-up is recorded below.
This is the current acceptance index; [windows-winui-parity.md](windows-winui-parity.md)
retains the chronological implementation and regression history.

The reference UI is the shipping **React WebView**, not Vue. Preserve its
layout, operations and Rust behavior; use actual WinUI controls for native
input, menus and dialogs. This audit does not switch the default renderer,
remove the WebView implementation or change distribution. The later local
Release memory comparison is recorded separately below.

For D1–D8 results and later acceptance work, see the
[concrete differences and decision list](windows-winui-next-decisions.md).
It separates this completed implementation batch from scenarios awaiting
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

## 2026-11-23 Windows native search S01–S08

Base `a453767`. Native checks use a Debug x64 panel on a separate Windows desktop with synthetic rows and a recording bridge. The search probe runs through the shell parity export with `VPASTE_WINUI_SEARCH_CHECK=1`.

| Rule | Evidence |
| --- | --- |
| S01 | **S/X**. The shell checks the loaded command order: conditional developer controls, tools, queue, settings, conditional update. |
| S02 | **X/A**. Expanded search contains one TextBox and hides the trigger. The shell invokes the built-in clear button, types again, submits, collapses and reopens search. The actual App exposed the search field and neither magnifier after expansion. |
| S03 | **X**. Simulated composition suspends the timer and ignores Enter and Escape. Composition end schedules the final text. An earlier reply is discarded even when the final text equals the earlier request. |
| S04 | **X**. On the baseline an oversized B query caused a second recorded paste of A. The fixed probe covers late A, successful B, zero matches, failed dispatch with zero rows, canceled Enter, a selected row disappearing during refresh and queue selection. Stage 312 replays an OCR notification followed by the ordinary refresh and verifies that only the latest reply pastes B. |
| S05 | **X/A**. Escape clears, then collapses, including from toolbar focus. Repeat leaves the field open. Stages 311–312 cancel a pending Enter when an empty field collapses, a populated field loses focus, or the panel receives native deactivation. In the actual App, two posted Escape keys cleared the query then collapsed the field. |
| S06 | **X/A**. Retained rows show progress. The recording bridge blocks stale paste, plain paste, quick paste and deletion. Retry reissues the same query and filter. In the actual App, Delete on retained B after a failed send left B in SQLite. The same key removed a fresh control row C. |
| S07 | **X/A**. The actual App showed copying guidance in a fresh empty database, Clear filters for a successful empty query, Retry for failure with zero rows, and a warning with Retry when a failed query retained rows. The native probe invoked the recovery controls. |
| S08 | **S/U/X/A**. Three Rust adapter tests cover literal tag text, prior whitespace normalization and UTF-16 highlights. In the actual App, an explicit FixtureTag excluded untagged A and returned B for the literal query `tag:PhaseOchreB`. A multi-space query still matched single-space fixture text. |

**Actual App and remaining manual checks.** The Debug acceptance executable used two marked synthetic profiles and inactive desktops. External paste was excluded because creating a separate window station failed with Windows error 5. Its clipboard and an interactive target must be isolated before external-delivery and physical IME testing. The broader history/queue regression stops at its rich-card stage 32 on both baseline and the phase-one build (`E_NOINTERFACE`). Its fixture casts the card viewport to `ScrollViewer`; the card uses `ScrollView`.

## 2026-11-19 queue controls and WebView inventory

**S:** Remove only Copy as plain text from the WinUI card context menu. Paste
as plain text, its shortcut, and other copy variants are unchanged. The queue
keeps the WebView reference's centered title/count, row actions, and Rust
operation/lifetime contract. The deliberate Windows differences are:

- Reverse and Clear are two named WinUI icon Buttons, with 40-DIP targets and
  no overflow. Clear still requires confirmation. An AppBarButton in the
  intermediate design arranged at 40 DIP but failed the outer-edge hit test.
- Compact themed rows and a left grip follow the visual examples in
  [Files' Details layout](https://github.com/files-community/Files/blob/main/src/Files.App/Views/Layouts/DetailsLayoutPage.xaml)
  and [PowerToys' Power Display profiles](https://github.com/microsoft/PowerToys/blob/main/src/settings-ui/Settings.UI/SettingsXAML/Views/PowerDisplayPage.xaml).
  Keep vPaste's pointer capture and shared sort; use a non-intercepting insertion
  line instead of shifting other rows during the drag. Releasing outside the
  list cancels. Keyboard moves, edge scrolling, and concurrent updates stay.
- The queue HWND has its own opaque, theme-aware canvas, independent of the main
  panel's Acrylic. Suppress only the extra DWM frame border where supported,
  preserving the shadow, corners, contrast-theme border, and control focus visuals.

**U:** 24 Rust queue/bridge tests and 226 focused frontend tests passed. The
separate release-upload fixture is excluded from the green rerun because WSL
Bash cannot open its Windows-style synthetic asset paths. Style and native
Debug asset checks passed.

**X:** Isolated native shell stage 257 and history/queue stage 153 passed in
separate processes. The real queue HWND had two 40×40-DIP controls with topmost
XAML hits near the corners; the short work area and 80/90% density did not
distort its layout. The drag replay checked an insertion marker, fixed neighbor
positions, commit once, cancellation, concurrent deletion and 100 rows.
The clear dialog retired on close/reopen without sending a clear operation.

**A:** The Debug executable with the tested native DLL passed the marked
fixture's settings recreation, guide release, visible preview reuse and three
close/reopen cycles without creating a main WebView. Queue activation and
external paste were deliberately excluded from this App probe.

**M:** real mouse capture/edge scroll, Clear/cancel, and the intermittent frame
outline when clicking the queue during Add mode. The synthetic suite does not
verify physical focus, compositor output, or external paste.

**S:** The Windows WinUI session uses these WebView surfaces. A legacy builder
remaining in source is not evidence that WinUI creates its window.

| Surface | Lifetime in WinUI mode |
| --- | --- |
| Tray menu | Native tray icon and lazy WinUI popup. Only the legacy renderer warms and reuses the styled `trayMenu` WebView. |
| Settings and text editor | `config` and `textEditor` are opened on demand and destroyed on close. |
| First-run and Debug tutorials | `nativeOnboarding` and `devTutorial` are temporary WebView content layers owned by the native main panel. The ordinary Windows permission status does not require the separate permission guide. |
| Rich, link, PDF, OCR, unsupported or oversized previews | `clipboardPreview` is lazy and reused while visible; closing retires it and the optional webpage renderer `previewBrowser`. Common text, image, file and color previews use the native reader. |
| Debug tools | `devMemory` and `testRoom` are on demand. UI Lab opens in an external browser, not an in-app WebView. |

The main panel, queue, tag editors, and their emoji picker are native in this
mode. The React paste-fallback notice is not the native card error route.

## 2026-11-19 queue interaction follow-up

- **S — queue:** supersede the insertion-line experiment with the reference
  [pointer-sort interaction](../../../src/clipboard/PasteQueue.tsx).
  The source row follows the pointer, crossed rows move aside, and “Next” follows
  the previewed first item. Drop displays the new order before the Rust reply;
  failure restores the old order unless a newer authoritative snapshot arrived.
  Keep the direct Reverse/Clear buttons, root pointer capture, keyboard moves,
  edge scrolling and shared queue commands. Cancel outside still leaves the
  order unchanged. Reduced motion keeps tracking but skips the neighbor easing.
- **S — copy and visuals:** use the reference empty, selection, clear,
  paste-success and restore text in Chinese and English. “Next” has been in the
  WebView queue since `9069166`. Match the WebView toolbar's resting icon,
  surface and subtle stroke colors without changing button/artwork dimensions or
  overriding contrast-theme brushes, focus, active or update behavior.
- **U — Ctrl+V:** check Windows modifiers at the V event, rather than using an
  old modifier snapshot. Do not send a Ctrl release while the key is already
  held. Simulated real presses, held/released Ctrl, tagged injected events and
  five distinct ordered queue records pass. The same serial Rust queue and
  copy/consume rules serve both renderers. 50 focused Rust tests, 227 frontend
  tests and the style, format and native Debug asset checks passed.
- **X:** on a separate desktop the full native history/queue suite passed at
  stage 153. The loaded drag fixture shifted the source 132 DIP and both
  crossed rows −66 DIP, maintained a single preview order, preserved the
  immediate drop and rollback, and reset offsets on cancellation. The
  reduced-motion fixture used direct offsets with no neighbor transition.
  It also exercised 120 moves over 100 rows, clear/cancel and selection-bar
  layout/text in Chinese and English. The shell and toolbar checks separately
  verify 28-DIP command targets, centered 16-DIP glyphs and light/dark brushes.
- **A — startup only:** the ordinary `winui-debug` App was gracefully restarted
  with the matching rebuilt executable and native DLL. It loaded the updated
  native panel and rendered the initial history query. No test keys or clipboard
  payload were sent on the interactive desktop.
- **M:** paste three distinct records into a normal external app, both by
  tapping V with Ctrl held and with separate Ctrl+V presses. Verify the queue
  advances each time. Also verify physical drag/drop, edge scroll and
  cancellation with motion enabled and disabled, and the toolbar weight on
  screen in both themes.

## 2026-11-19 Release memory comparison

**A:** Built optimized x64 from `c4d8a6d` with the production frontend and the
local-only `winui-acceptance` feature. On Windows 11 build 26300, used the same
executable, WinUI DLL and 500-record fixture for both backends, in separate
marked portable profiles on a non-input desktop. Clipboard capture, hotkeys,
startup reconciliation and updater activity were excluded. Tray and preview
warmup policies were left intact; neither backend was trimmed or reset during
a run. The ordinary Debug session was left running.

The fixture includes Text, image, file, link, rich-text, GIF and large-text
records. Each cloned profile includes the hash-named internal thumbnails;
without those, the shared materializer can legitimately display an existing
original as a File instead of an Image. That setup error invalidated the first
trial as a mixed-image benchmark. The corrected pair (`winui-media3`,
`webview-media3`) verified the first mixed result, 12 category changes,
two identical horizontal-scroll sequences and two Settings/PDF open-close
cycles per renderer. Category tests temporarily used the App's existing blur
suppression in both modes; physical focus and motion were not assessed.

| Private commit in MiB, matched pair | WinUI | WebView |
| --- | ---: | ---: |
| Settled first page, main process | 239.6 | 27.9 |
| Settled first page, complete process tree | 410.6 | 510.3 |
| 8–15 seconds after the second close, main process | 335.1 | 45.1 |
| 8–15 seconds after the second close, complete process tree | 562.8 | 650.9 |
| Highest observed sample with PDF open, complete process tree | 1,110.0 | 979.4 |

Use medians for settled windows. First-page tree medians across three corrected
starts per renderer were **410–414 MiB WinUI vs 508–516 MiB WebView**. WinUI
starts with a smaller tree, not a smaller main process: XAML/media live inside
that process, whereas WebView keeps much of the footprint in descendants.
With PDF open, both trees approached or passed 1 GiB across the corrected runs.
Settings was destroyed in both modes. WinUI destroyed the PDF fallback while
WebView hid and retained its reader; WinUI's WebView2 environment and warmed
tray could still have resident children after closing. The two cycles do not
prove a leak or its absence, and the historical ~600 MiB Debug main-process
report was not reproduced as a Release host plateau. The peak WinUI host
sample in the matched pair was 356.7 MiB.

**A/M — category latency:** Off-desktop WinUI UI Automation selection includes
a repeatable ~2-second wait before its selection observation. It verifies the
result and scroll, but cannot stand in for physical click latency. The
WebView's programmatic click-to-result DOM samples were about 150–181 ms in
the matched pair; its DOM and WinUI automation endpoints are not a frame
timing comparison. A separate run of the current Debug binary, on the same
marked fixture, logged 18 category switches over three batches. The last
batch started more than two minutes after launch. Native request dispatch
to response took **8.3–14.4 ms**; applying 36 card rows took **46.3–79.3 ms**.
One cold-start response took 331.6 ms during concurrent fixture startup work;
it is not a warm-tab sample or a proven database stall. No reproduced warm
half-second delay justified changing query/cache/animation behavior. Capture
physical selection and first presented frame with the real history if it
recurs; these tests do not certify desktop motion or long-run memory.

Raw fixtures, inputs, logs and samples are under ignored
`.codex/tmp/winui-phase3-release/`. The read-only memory observer timestamps
samples and discards a complete interval if a descendant disappears mid-read;
it does not count a partial tree or silently accept a lost root. Its isolated
regression reproduced the old failure and verified the new sample/exit rules.
Working-set sums remain diagnostic and can count shared pages more than once.
Some cold fixture starts logged a search-index publication error; the category
results above did not depend on keyword search. Do not treat this as search-index
or installed-package acceptance.

### 2026-11-19 follow-up: pre-rasterized native file icons

**S/U/X:** WinUI card and file-reader artwork uses the original manifest,
theme association and product glyphs, rasterized to PNG at build time and
embedded in the existing DLL. The v4 bridge sends the logical name and asset
ID, not SVG markup. WebView and opened file/image/PDF content are unchanged.
All 635 resource IDs were looked up against the built DLL and matched the
generated PNG bytes. The native regression rendered eight representative
assets in both themes, checked sharing across aliases, and retained the
card/reader layout and missing-file behavior. Physical DPI and focus remain
**M**; Windows did not grant physical foreground focus to the test desktop.

**A:** On the same machine, compared optimized x64 builds from `c4d8a6d`
and this change with cloned 500-record profiles (18 File items interleaved
in the first page; 14 extension variants). Both arms used the existing blur
suppression on isolated desktops and confirmed the same first File card by
UI Automation before three settled samples. Orders were new–old, then
old–new. The figures below are medians in MiB for the main process, **not**
total process-tree memory. The workload is deliberately file-heavy.

| Metric | Pair 1: old → new | Pair 2: old → new |
| --- | ---: | ---: |
| Private commit | 539.1 → 131.8 | 536.0 → 129.8 |
| Working set | 563.6 → 174.9 | 576.6 → 172.9 |

**X:** Two separate Release DLL component pairs independently measured
254.2–254.6 → 122.9–123.5 MiB private commit after realizing the same nine
file types by horizontal scrolling. This separates icon rendering from the
database and WebView2 children; it is not an estimate of savings for every
history or proof of a leak. The uncompressed Release EXE + DLL grew by about
1.6 MiB. Raw samples are under ignored `.codex/tmp/winui-memory-attribution/`;
the initial resource-name and visibility attempts were excluded.

## #389 closeout: main flows, windows and focus

- **Main flows (U/X):** the capture worker replays the ownerless plain and
  confirmed rich phases through a disposable database. Loaded XAML covers
  zero-result editing, late replies/IME, clearing a nonempty search, and the
  Enter and right-click routes. Queue tests cover sorting, preserving concurrent
  captures, failure recovery, consume/undo and the selection of a paste target.
  The actual isolated App verifies six inactive-queue mutation guards. It does
  not activate the clipboard interceptor or send an external paste.
- **Windows and focus (U/X/A):** the full native shell and history probes
  reached stages 257 and 153, including synthetic DPI changes, remembered and
  reset tab/search/position behavior, and native reader continuity. The actual
  App's settings caption stays native without a second drag IPC; closing and
  reopening recreates the WebView. The isolated App also verifies retained
  fallback preview replacement, three close/reopen cycles, OCR topmost
  false → true → false, and a nonoverlapping PDF toolbar.
- **Browser:** five headless checks against the production bundle passed,
  including both motion preferences, light/dark tray and popup surfaces. The
  first cold Vite-dev preview run repeatedly remained in the lazy route's
  loading UI past its readiness assertion; it is not used as a desktop
  failure or as passing evidence. The packaged-assets run keeps the same
  assertions. It does not measure physical tray-menu latency.
- **M:** still validate real QQ capture and return-to-target paste; queue drag,
  paste and Undo with another app; settings drag/release followed immediately
  by a click outside; Escape inside the PDF viewer and OCR outside-click;
  native-to-WebView transitions, physical mixed DPI and first/second tray
  clicks. Do not require a data reset or a renderer change for these checks.

## 2026-11-18 approved single-card context menu

- **S:** The Windows WinUI card still uses a native `ContextFlyout`. “复制并粘贴”
  / “Copy and paste” uses the existing paste path; Ctrl+C still copies without
  pasting. Preview/Space, favorite, and type-specific copy, path, and image
  actions remain. Edit and image text recognition move near the top. Only the
  single-card queue menu entry is removed; the toolbar and batch workflow remain.
- **S:** The Tags submenu uses the current record tags and the clicked card's
  membership. “Remove all assigned tags” appears at the bottom only when
  applicable. Only an authoritative empty tag list offers “Create and assign
  tag”; the tag editor opens after the context menu has closed. Single-row
  context-menu deletion is immediate. At this stage the Delete key still
  confirmed; the later single-card follow-up below aligns both entry points.
  The WebView menu, macOS and shared Rust commands are unchanged.
- **U/X:** 144 targeted frontend/contract tests and 76 WinUI-filtered Rust tests
  passed. The isolated native menu probe (`VPASTE_WINUI_CARD_MENU_CHECK=1`,
  stage 276) exercised loaded controls and verified the clicked vs. selected
  row route, tag membership changes, first-tag creation and assignment, delete
  confirmation boundaries, and toolbar batch addition against a test bridge.
  The adjacent reader/preview toolbar probe passed stage 1244 separately.
- **M:** Real pointer and keyboard input, returning focus to an external target
  and pasting into it still need a desktop pass. Use a disposable record to
  verify immediate delete; do not delete existing tags just to exercise the
  empty-list branch.

## 2026-11-18 shared preview pin and OCR follow-up

The Windows WinUI native reader and on-demand WebView previews now have one
32-DIP pin in a reserved 40-DIP header row, with the same Segoe Pin/PinnedFill
glyphs. Native windows use a WinUI ToggleButton; fallback windows keep the
shared MUI toolbar control. The header does not overlap the PDF viewer or link
browser. This supersedes the pin/close pair recorded in R4 below. Ordinary
WebView and macOS are unchanged.

- **S/U:** the WebView reference labels OCR “查看图片文字” / “View image text”.
  Windows WinUI changes the menu label to “识别图片文字” / “Recognize text in
  image” and uses Fluent Scan Text. It still invokes the same OCR route. The
  editor's draft protection does not make the window topmost; edits, Copy all
  and OCR input handling remain. The separately approved menu structure changes
  are recorded above.
- **X:** the focused native shell probe (`VPASTE_WINUI_PREVIEW_TOOLBAR_CHECK=1`)
  passed stage 1244, including Scan Text menu invocation, the single pin,
  keyboard ownership, navigation, retained-window updates, and reader release.
  Foreground-dependent assertions were skipped. The submission replay of the
  broad history/queue probe passed stage 153, including the reader and queue
  checks. The fixture now checks the separate undo row, waits for the tag
  submenu's native Toggle control, and separates retained XAML focus from
  foreground window activation. Posted Space still needs physical focus.
- **A:** an isolated App with a disposable image record verified that OCR opens
  unpinned, its actual Windows topmost flag follows false → true → false,
  selection cannot replace it, Escape retires it, and reopening starts
  unpinned. A real PDF starts below the header. The PDF viewer does not forward
  its keydown to the preview DOM; the replacement route is the preview's scoped
  WebView2 Escape accelerator. CDP input and an inactive desktop cannot verify
  the physical focused-PDF accelerator or clicking outside to dismiss OCR.
- **U/browser:** 100 preview-filtered Rust tests, 878 frontend tests and 13
  focused Chromium tests (including both motion settings) passed. The six
  release-upload tests were excluded on this host because WSL cannot resolve
  their Windows fixture paths.

## 2026-11-18 empty search editing follow-up

**S/X:** A query returning no cards dismisses any unpinned preview. The shared
preview-close path in turn queues a native history-focus message, even if the
main search editor already owns the keyboard. The earlier stale-query test
checked text value, not this focus handoff. An automatic return to history now
leaves the active search control alone; explicit keyboard navigation and a
return from outside the search control keep their existing behavior.

On the isolated desktop, the new native scenario produced one match, then no
matches, and replayed the preview-close message. It failed at stage 267 before
the fix. It passed stage 268 after the fix, preserving the editor and caret,
not pasting the old match, and recovering the result after removing the last
character. Explicit keyboard focus transfer to history still worked. The 76
focused WinUI Rust tests and 60 targeted frontend tests passed. **M:** verify
typing, Backspace and IME in the ordinary Windows App. The card context menu
was compared with the WebView reference separately; its behavior was not edited.

## 2026-11-18 desktop follow-up: shortcuts, search, guide, toolbar and memory

| Item | Implementation and local evidence | Remaining acceptance boundary |
| --- | --- | --- |
| W1: Alt+A/F badges | **S/X:** compare the [WebView shortcut styles][web-css]. Loaded native layout measured both 14-DIP badges 5 DIP from the right edge, vertically centered, with no width change or obstruction of the labels in either language. The badges are not hit-test targets. | **M:** hold/release Alt and click both tabs at the actual display scale. |
| W2: search input | **S/X:** use one native TextBox rather than an AutoSuggestBox and its deferred editor. Loaded control replay preserves `ddd` across an older query reply and checks clear/debounce. Existing IME guards and pending-Enter routing remain. | **M:** fast typing, backspace, clear, physical IME and Enter after results settle. The original intermittent keyboard sequence was not reproduced on the ordinary desktop. |
| W3: embedded Debug and Settings tutorials | **S/U/X; browser:** both derive the filter switches from the saved filter list. Debug projects the draft into the native header, validates the live preview session and discards it on close; Settings retains its existing save path. React tests verify the draft and no writes; loaded WinUI rejects an old session and restores the header after detachment. | **M:** actual pointer interaction from the Win/Mac Debug buttons and Settings; opening the native guide here did not certify macOS itself. |
| W4: right toolbar | **S/X:** use the [WebView artwork and order][web-header] in native Buttons, retaining WinUI focus and states. Loaded queue/settings controls measured 28×28 DIP, centered 16-DIP icon slots, 8-DIP gap and 28-DIP right inset. The conditional updater stays after Settings. | **M:** compare normal, Debug and update-ready states in both themes and at the display scales in use. |
| W5: card-resource memory | **S/A:** keep half a viewport of total offscreen prefetch instead of four, and reuse live file-type SVG sources on the owning XAML thread without keeping expired sources alive. Card media, pagination and full previews still use the same Rust contracts. The isolated App returned the same 36-record first page. | **M:** browse/scroll mixed history for several minutes, including reverse scroll, and compare private bytes/working set after idle. No fixed cap or leak resolution is claimed. |

The ordinary Debug sample was about **631 MiB of main-process private commit**.
WinUI/XAML is loaded into that executable, so this does not measure Rust-owned
data alone. In isolated controls, an empty history settled near **111 MiB**,
500 text items near **134 MiB**, and a 500-item mixed history near **380 MiB**.
One valid image raised the one-image cohort to **189 MiB**, compared with
**138 MiB** when all image resources were missing; warm media caches did not
remove the growth. File cards with missing paths still incurred the type-artwork
cost. This identifies native media/card realization as a substantial contributor,
not an allocation-stack attribution of the entire ordinary process.

On the same marked 500-item fixture, using average private commit from seconds
5–9 in two alternating runs, the previous and updated WinUI builds measured
**377.6/378.8 MiB** and **239.3/239.9 MiB**, respectively (about **37% less**).
Measurements exclude auxiliary WebViews; no heap trimming, thumbnail removal,
or user data reset was used. Logs and samples are under the ignored
`.codex/tmp/winui-desktop-followup-20261118/` folder. An additional actual-App
run with `VPASTE_WINUI_MEDIA_PROBE=1` confirmed two successful file-type SVG
loads; bitmap presentation did not emit completion on this isolated desktop
and remains a visible-desktop check. The focused native suite passed stage 265
on the isolated desktop, not the interactive compositor and focus suite.
The production and native-debug frontend builds, asset isolation, styles,
876 frontend tests (excluding the known WSL release-upload fixture), 76 WinUI
Rust tests and six onboarding browser cases passed; one browser case passed on
retry. The ordinary Debug process was not restarted and no hosted Actions ran.

## 2026-11-18 reported runtime parity follow-up

This pass records the R1–R8 implementation and local verification. It does not
claim the running ordinary Debug loaded these uncommitted sources or that the
reported warm-session latency has been reproduced and resolved on real history.

| Item | Implementation and local evidence | Remaining acceptance boundary |
| --- | --- | --- |
| R1: Debug guide previews | **S/U:** in WinUI Debug, both platform variants use the ordinary onboarding attachment and panel-relative bounds. The temporary owned WebView is released on close; no resident main WebView is created. The session-only tutorial draft does not write onboarding, filters or appearance settings. Focused React draft and Rust shortcut-policy tests pass. | **M:** launch both variants, practice the shortcut, finish/close and reopen without changing saved preferences. Actual macOS is not part of this WinUI test. |
| R2: GIF/Rich badges | **S/U:** use the same resolved source-app accent when card details arrive and when appearance is reapplied; high contrast uses the shared native caption style. Focused Rust/source regressions pass, and the XAML assertions were compiled but not run in this pass. | **M:** real GIF and rich-text captures across apps, delayed detail loading, light/dark and high-contrast themes. |
| R3: GIF card preview | **S/U:** when a cached preview is empty or invalid, the original GIF is resolved through the bounded card-media path to a static first-frame thumbnail; GIF identity, original bytes and full animated preview remain separate. Extensionless two-frame GIF coverage passes. | **M:** real GIF copy, first-frame appearance, drag and Space preview. |
| R4: preview toolbar | **S/U; browser:** Windows WinUI's WebView-backed previews match the native reader's pin/close pair. The toolbar has its own row; a browser fixture checks that the PDF iframe starts below it and checks keyboard ownership in both motion modes. macOS and ordinary WebView keep their existing layout. | **M:** text/rich/image/file/PDF/OCR in the Windows App, including pin/close clicks and actual PDF controls. |
| R5: Enter-to-paste | **S:** handle bare Enter before ListView consumes it, including after a category query. In queue-selection mode, Enter or the configured plain-paste shortcut toggles the focused card without sending paste. Source contracts pass. New XAML probes for normal paste, repeat suppression, focused multiselect and missing focus are compiled, not run. | **M:** physical Enter after fresh show and after category selection; search/IME, target focus and queue-selection mode. |
| R6: warm-session category response | **S:** avoid OCR-triggered history reloads with no search or during IME composition; committed search still refreshes, and a waiting Enter follows the replacement query. A request carrying the current text retires its pending search debounce. Source regressions failed before the guard changes and pass after; new XAML work-count assertions are compiled, not run. **Earlier X:** 36-to-12 result application improved from 24.02–25.26 ms to 9.97–10.80 ms using synthetic items. | **M:** retest after several minutes of real history and capture activity. The earlier component benchmark excludes database and end-to-end latency; the cause of the reported half-second pause is not established. |
| R7: queue feedback and target focus | **S/U:** busy protects actions without inserting a working message; completed paste has the reference bottom Undo action. Remove the redundant queue re-show, and restrict click-target preparation to queue-window clicks. Shortcut requests keep their shared paste path. Seven Rust queue-target tests and focused source contracts pass. | **M:** compare click versus shortcut, original-target focus, successive items, failure/retry and Undo; ensure the queue stays visible without stealing focus. |
| R8: tag submenu spacing | **S:** remove the icon on the creation row that reserves an extra column in the submenu; retain native checked options, accessibility and keyboard navigation. Focused source regression passes. | **M:** open a card's Tags submenu at the user's DPI and confirm label alignment, checkmarks and navigation. |

Local verification on 2026-11-18:

- **S/U/build:** style architecture, production and native-debug frontend builds,
  Debug asset isolation, Rust formatting, isolated WinUI compilation, 76
  WinUI-filtered Rust tests, 7 queue-target tests and 872 frontend unit tests
  (123 files, with the existing release-upload fixture file excluded) passed.
- **Browser:** 11 focused headless Playwright checks passed, including normal
  and reduced-motion resident preview cases. This does not render native XAML.
- **X/A/M:** the two mapped-window XAML suites were not started to avoid
  interrupting the desktop; no actual-App, physical keyboard/IME, external
  paste, mixed-DPI, or macOS acceptance was performed in this pass.

The six excluded release-upload tests fail in local WSL Bash because it cannot
resolve Windows `C:/` fixture paths. An OCR unit test and one browser fixture
timed out when their suites overlapped; each passed on an independent run.

## 2026-11-17 eight-item parity follow-up

The user approved D1–D8 together, in their numbered order. This section
supersedes those eight outstanding differences in the previous decision list.
It records implementation and local regression results, not physical acceptance
of the entire native migration.

| Item | Implementation and evidence | Remaining acceptance boundary |
| --- | --- | --- |
| D1: file reader | **S/U/X:** follow `Preview.tsx`, `FileTypePresentation` and the shared Rust file classification. Restore type artwork, main filename, compact path, multiple-file note and missing-file warning. Real-history payload tests cover files/folders, multiple paths, missing video and PDF routing; loaded reader tests check structure and theme-specific artwork. | **M:** real file/folder samples, long names and mixed-DPI appearance. Existing PDF/rich/OCR fallback and media decoding limits remain. |
| D2: transparent image reader | **S/U/X:** place the checkerboard behind the actual fitted image, with natural sizing for small images. Reuse the theme-cached source as repeated 256-DIP tiles with 8-DIP cells, rather than stretching a single patch. Loaded tests check 2-pixel image sizing, both themes across tile boundaries, image failure, cancellation and reader reuse. High contrast retains its fallback. | **M:** transparent PNG/GIF samples, perceived continuous resize and actual high-contrast/DPI behavior. Loaded pixels do not establish physical frame rate. |
| D3: queue failure recovery | **S/X:** WinUI InfoBar now exposes Retry and Delete for the exact failed hash. Preserve busy, repeated-click, stale-response and missing-item guards. General command errors clear the earlier failure association. Loaded automation checks actions, errors/retry, exact removal, concurrent state and disabled controls. | **M:** recovering from a real unavailable external paste target. The synthetic bridge does not deliver a system paste. |
| D4: queue continuity | **S/X:** retain row controls by hash across broadcasts/replies, update indexes and enabled state, fade additions/removals using shared Motion tokens, and clear noninteractive exiting surfaces on Undo/re-add or suspension. Keep the existing pointer sorting; no layout animation or drag-engine replacement. Tests cover control identity, focus/scroll, repeated revisions, reduced motion, cancellation and 100 items. | **M:** real handle capture, edge scrolling, sorting followed by a paste click, concurrent capture and perceived motion. |
| D5: source apps | **S/U/X:** restore up to two unmasked source icons, missing-icon placeholders and a text/count summary. Keep searchable native CheckBox selection. A source contract checks all 44 process-name aliases against the shipping Chinese/English labels; loaded controls verify display-name/raw-name search and unchanged saved identifiers. Tests open the actual Flyout, wait for Opened/Loaded, and close it before saving/reopening. | **M:** actual cached app icons and physical keyboard interaction. The searchable native selector is an intentional retained native interaction. |
| D6: rich cards | **S/U/X:** add shared Office/webpage/code/table HTML fixtures for both the WebView reference sanitizer and Windows projection. Restore allowed class emphasis, inline precedence, list numbering/nesting, pt conversion, strikethrough, trusted image dimensions, merged-cell spans and exterior table edges. Empty/unsupported repeated class rules cannot erase valid prior rules. Mac keeps `convert()`; Windows uses `convert_for_windows()`, with new default fields omitted from the old JSON contract. | **M:** representative actual Office/browser copies and macOS compilation/runtime. The bounded native projection remains deliberately less complete than browser HTML/CSS; no extra main WebView is introduced. |
| D7: search | **S/X:** short input-only feedback and search-icon return feedback, with shared animation tokens; no animated window/input width. Match the reference 120-ms nonempty/40-ms empty debounce. Native composition events suspend querying and Enter submission. Loaded tests cover composition state, clear, two Escapes, queued focus return, reopen, fixed root width and immediate reduced-motion completion. | **M:** physical Chinese IME candidate confirmation, repeated keyboard input and perceived motion. Synthetic composition calls do not prove an actual IME session. |
| D8: native density | **S/X:** use a shared compact 32-DIP action Button style; Emoji uses 28-DIP cells, 16-DIP text and a 224-DIP content area, retaining all 112 options, names, native Flyout/GridView selection and focus behavior. | **M:** physical pointer/keyboard and theme/DPI checks. SDK Desktop Acrylic, whole-window opacity and material fallbacks are unchanged; Files Thin Acrylic remains a separate design decision. |

The same loaded 100-item queue builder compared forced full reconstruction with
retained rows. In the final run, mean synchronous update cost was **143.64 ms
versus 7.57 ms** (ratio 0.053); earlier runs were approximately 131–137 ms versus
6.9–7.1 ms. This measures control/layout work in that fixture, not live capture,
external paste, end-to-end latency, process memory or physical FPS. No additional
layout compensation animation was needed or enabled.

Both native suites pass: shell through stage 257, history/queue/reader through
stage 153, with posted Space also reaching its final stage. Their callback is
synthetic; no new **A** actual-App acceptance or **M** physical acceptance is
claimed. Test fixes preserve lifecycle assertions: source search must be loaded
inside its popup; Escape's queued focus handoff completes before a fresh reopen;
checkerboard pixel checks count light/dark crossings so antialiasing cannot
double-count one edge. Both themes measure 70 crossings over 560 pixels.

Local artifacts are in ignored `.codex/tmp/winui-eight-parity-20261117/`,
including failing-before-fix logs and settled light/Chinese and dark/English
captures of queue recovery, source selection, Emoji, and file/image readers.
XAML captures deliberately exclude DWM/Acrylic composition; their transparent
outer gutters are not evidence that the actual desktop material is absent.
The dark reader captures also show a white pin-button background with weak
glyph contrast. Pin creation, styling and appearance handling are unchanged
from the base, and the capture alone cannot distinguish an existing runtime
style issue from transparent/composition capture behavior. Check this control
in the actual dark App during **M** review; do not treat it as a verified new
regression or silently change its style from the screenshot alone.

Local architecture checks and frontend production/native-debug builds pass,
including native-debug asset isolation. The `winui-debug` App build and
`cargo check --release --features winui` pass; this is not an installer or
Release package acceptance. Focused WinUI Rust tests pass 67 with
the two desktop suites run separately. Frontend unit tests pass **854 across
120 files** with the known release-upload fixture file excluded after a full
run reproduced its six local Bash/WSL/path failures. Release tooling is unchanged.

The full Rust run records **590 passed, seven failed, seven ignored**. All seven
fail before their functional assertions because Windows cannot create the
isolated clipboard station on this host; those tests were not weakened.
The full headless browser run records 293 passed and five failures. Two Office
fixtures were corrected to mount virtualized cards and use approved preview
resource tokens, retaining identity/decoding/sizing and rejection assertions;
both pass on rerun. The other three are pre-existing React result-focus races
(normal Mac/Windows and reduced-motion Windows), independently reproduced with
selection present but focus on BODY. The corresponding React implementation
and `window-shells.spec.ts` are unchanged; this native batch does not claim an
all-green browser run or silently alter those unrelated focus semantics.

Mapped native tests were grouped in the announced final interval, without
desktop input automation. Ordinary Debug remains stopped. No workflow, renderer
default, installer, publication or macOS UI was changed.

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
| Search, category, favorite, source and explicit tag filters | [WebView search][web-search], [native search adapter][search], [query bridge][bridge] | S, U, X: literal query text, independent filters and UTF-16 highlights; see S08 above. | M: real data containing the user's source names and languages. |
| Search submission and stale results | [WebView keyboard][web-keys], [native keyboard][keys], [panel][panel] | S, X: native TextBox, pending query/refresh guards and Enter handling; see S02–S07 above. | M: IME composition and quick Enter in the actual foreground App. |
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
| Single-card deletion and text editing | [WebView actions][web-actions], [panel][panel], [bridge][bridge] | S, U: the card menu displays Delete; both single-card entry points dispatch direct deletion. Keep confirmation for separate tag and clear actions, and keep edit request/identity and discard guards. | M: physical focus return and keyboard ownership. Plain editing is native; rich editing opens an on-demand WebView. Use disposable history for destructive checks. |
| Queue entry and repeated batch selection | [WebView queue][web-queue], [panel][panel], [Rust queue routes][queue-rust] | S, U, X: opening enters selection, successful Add clears only the submitted batch and retains mode, failure retains the draft; cancel/reenter isolates the new draft from old replies; enabled Add/Cancel topmost pointer hits and centered labels over cards in both languages/widths, with hovered cards and disabled motion/contrast overrides | M: physical pointer, live copy-to-queue and external paste target. Closing queue must leave selection mode. |
| Queue reorder, remove, reverse, clear and Undo | [WebView queue][web-queue], [native queue][queue], [Rust queue routes][queue-rust] | S, U, X: real native controls, revision/busy guards, local reorder and confirmation behavior | M: real drag handle and queue-paste/Undo flow. Existing shared queue storage and paste semantics remain authoritative. |
| Queue window, scroll and compact density | [Queue window][queue-window], [queue][queue], [appearance][appearance] | S, X: 100-item refresh, constrained viewport and 80/90/100% density | M: actual short monitors, scaling and focus continuity. Queue owns a separate HWND and does not resize/replace the main dock. |

## Preview, focus and auxiliary windows

| Area | Reference and current native path | Evidence | Remaining acceptance / deliberate difference |
| --- | --- | --- | --- |
| Common native reader and continuous navigation | [Shared preview][main], [reader routing][reader-route], [native reader][reader] | S, U, X: real history payloads, reused reader HWND, stale generations, sizing, content release and toolbar/glyph key ownership | M: hold Space, rapidly navigate across differently sized content, close and continue keyboard input. The synthetic posted-Space path explicitly skipped when Windows denied foreground activation. |
| Hover preview, pin and close races | [Shared preview][main], [preview adapter][preview], [reader route][reader-route] | S, U, X; A verifies WebView fallback pin protection and three cold close/reopen cycles | M: cross between the real card/reader, pin/unpin, switch apps and ensure no stale reopen. A fallback-window test does not establish native pointer hover. |
| Rich HTML, links, PDF and oversized content | [Shared preview][main], [native fallback decision][reader-route] | S, U; A: visible rich-preview replacement reuses its renderer, close retires it | On-demand WebView is intentional for fidelity. M: both native-to-WebView and WebView-to-native handoff with real files and links. OCR is now separate and native. |
| External text/link/image/multi-file drag | [WebView drag][web-drag], [native drag][drag], [Rust payload][drag-route] | S, U, X: original paths/full text, multi-file payloads, native data-package/deferral ownership and cancellation | M: Explorer/Directory Opus, OneNote and browser targets; cancel mid-drag and verify ordinary Windows file dragging still works. A cursor or accepted drop effect does not prove insertion. |
| Auto-hide and internal focus | [Shared focus/hide][main], [native blur policy][focus], [panel][panel] | S, U, X: generation, suppression, drag/modal/internal-window and protected-preview guards | M: outside click, app switching, taskbar/tray activation and auxiliary close. The isolated fixture suppresses blur hiding, so its lifecycle pass is not auto-hide acceptance. |
| React settings lifetime | [Settings window][main], [Config][config] | S, A: close destroys the window and reopening creates a new instance | Keep current React/MUI settings. No native settings migration or resident settings/main WebView. |
| Onboarding and shortcut practice | [WebView behavior reference][guide], [native shortcut/config adapter][guide-route] | S, U, X: shared settings schema, first-run defaults, safe Debug draft, same XAML root and restored history input | No guide HWND/WebView in WinUI mode. M: actual tutorial layout, Alt+V practice, motion and positioning on real monitors. |

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

### Native text editing, onboarding and OCR (2026-11-19)

| Scenario | Evidence and remaining checks |
| --- | --- |
| Edit and save a plain-text record | **S/U:** the native editor loads the same document revision and calls the same save transaction/event as WebView. Existing rich-format, duplicate and changed-record tests pass. **X:** the native editor opens separately, blocks save for an unchanged draft, shows the discard dialog, and retains text on a stale-revision response. Rich documents still open in the existing HTML/RTF editor by design. **M:** F2/menu entry, Chinese IME, real save/focus return and rich-format round trip. |
| Open and complete the guide | **S/U:** the native guide keeps the existing tab schema, first-run defaults and saved empty choice, and isolates Debug drafts. **X:** shared XAML root and history bounds, same instance across hide/restore, saved-tab projection, stale-session rejection, and native switch, Next and Finish events. **A:** a marked Debug App passed preference completion, settings destruction/recreation and no main/tutorial WebView target in the lifecycle check. **M:** real Alt+V or configured shortcut, Windows/Mac Debug steps, DPI and welcome/finish motion. |
| Edit and copy the OCR result | **S/U:** same original image/preview resource, OCR recognition queue, 500 ms polling interval and explicit copy/history operation. **X:** OCR reuses the native reader, starts unpinned, lets the text field own navigation, preserves an edited draft across updates, and handles a copy failure and late post-close response. **M:** actual recognized language, copying selection/all into another app and history, pin and focus behavior. The synthetic XAML case does not access the user's clipboard. |

The Debug App test used an isolated desktop and synthetic history. No results
from automated checks are claimed as physical input, DWM motion or DPI passes.
Validation: 510 focused frontend/WebView tests and 98 focused Rust tests;
the complete native shell (stage 257) and history/queue (stage 153) suites
passed on separate desktops. The OS-dependent posted-Space check was skipped
without foreground activation.

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

### Native Windows tray menu

**S:** Windows WinUI mode now opens a lazy popup on the existing WinUI STA,
without showing the main panel or warming a tray WebView. The tray icon, its
paused indicator, existing Rust commands, captions and order are unchanged.
The base surface is 200 × 154 DIP (8-DIP fit margin, 36-DIP state row and
34-DIP actions); a ready update adds one row. Settings uses the popup's
monitor. The legacy Windows renderer and macOS retain their WebView paths.
The popup uses WinUI buttons and system acrylic with a solid themed fallback;
DWM supplies the outer frame. There is no product-authored opacity/slide
animation for opening or closing.

**U:** `tray_restart_row_matches_webview_readiness` covers ready,
installing, portable and Store results. Source and React tests cover the WinUI
route, no WinUI prewarm, shared command dispatch and unchanged legacy menu.

**X:** The isolated `VPASTE_WINUI_TRAY_CHECK=1` shell case passed at stage
27810. It checks the independent popup while the dock is hidden, row sizes and
fonts, both languages and pause states, one extra update row, negative-origin
placement at 100/125/150% simulated DPI, pending action guards, Settings
coordinates, and Escape/deactivation/outside-press dismissal. Ordinary shell
(257) and history/queue (153) also passed in separate processes; the history
suite passed when rerun alone after an existing editor frame assertion failed
during parallel build. Windows did not grant foreground for the posted-Space
assertion.

**A:** A marked, empty Debug profile ran `--memory-profile-tray-check` on an
isolated desktop. The normal app route reported `webview_created=false` and
the DLL showed the cold native popup. This bypasses the Explorer icon and
does not use the user's history or clipboard.

**M:** Check left/right click on the Windows tray icon, live pause/resume and
the icon's pause mark, Settings and Show Main, Escape/outside dismissal, and
the frame/shadow on actual light/dark, high-contrast and mixed-DPI monitors.
The visual preview was the design reference, not compositor capture.

### Properties-style auxiliary windows and WebView guide design (2026-11-20)

- **S:** Native preview, plain-text editor, OCR, both tag forms and tag management
  share the [auxiliary window standard](../development/windows-winui-bridge.md#properties-style-auxiliary-surfaces).
  Forms keep their existing save, cancel, copy and pin commands. The native
  guide separately uses the React reference's welcome, step layout, artwork,
  filter tiles and motion; the native controls keep the same Rust session and
  preference route. Rich-text editing and browser-based preview fallbacks are
  unchanged.
- **U:** 720 focused frontend/source checks and 72 WinUI Rust checks passed.
  The unrelated release-script mocks were excluded from the focused pass; the
  full run needs local `jq` for those mocks.
- **X:** The reader-specific regression (12475), full history/queue (153), and
  native shell (257) passed on separate desktops. Reader checks cover the
  editing/reading surfaces, copy/save/close, a poll arriving before the OCR
  edit notification, and in-place preview geometry. Tag checks retain source
  filtering and save/cancel. Guide checks cover welcome, five filter toggles,
  640/980-DIP reflow, permission artwork, shortcut practice and returning to
  the panel, including reduced motion. Light/dark captures render XAML only;
  they do not capture the DWM backdrop or shadow.
- **A:** The marked isolated Debug App completed and persisted onboarding,
  verified Settings close/reopen and the existing preview fallback lifecycle,
  and reported no main-panel or guide WebView. It did not read the user's
  history or capture/paste to another app.
- **M:** Confirm actual acrylic, shadow and motion on the desktop, mixed DPI,
  physical Alt+V and IME, and live copy/focus return. The isolated desktop did
  not get foreground, so posted Space is not a physical keyboard pass.

### Caption, guide alignment and Chrome duplicate-capture follow-up

| Evidence | Observed result |
| --- | --- |
| **S** — Window chrome | The shared native caption uses a themed bottom separator. Preview titles and pin-only chrome agree between the native reader and WinUI's browser fallback, without covering PDF content. OCR uses its existing scan icon, aligned section headings and equal-height panes. Plain-text editing uses stock Cancel and accent Save; formatting-preserving editing and the shipping WebView toolbar stay on their existing paths. |
| **S** — Guide and capture | Center the branded guide in its viewport, use five stock `ToggleSwitch` controls, and keep only the icon on the Windows Debug entry. Preserve tutorial drafts and actions. Both Windows renderers use [one capture worker](../../../src-tauri/src/clipboard/windows/listen.rs); the older QQ fix matched exact text within 50 ms. A Chrome-only 100-ms grace additionally checks the complete HTML selection when the plain formats differ, with existing source and queue-epoch guards. No old records are removed. |
| **U** — Regression tests | 55 focused frontend/source and 72 WinUI Rust tests passed. Clipboard capture passed 35 tests, including two-stage linked selections up to 86 ms apart, one rich record/queue insertion, and rejection of partial text or a different owner. Seven system-clipboard tests stopped at isolated window-station creation before exercising capture. Style, formatting, native Debug build and asset checks passed. |
| **X** — Loaded XAML | Reader and full shell passed on isolated desktops, including the reduced-motion shell. Checked caption stroke, OCR pane geometry, editor button styles, and five guide tiles through 640-DIP reflow and the centered 1,080-DIP content cap at 1,320 DIPs. Inspected light/dark and guide captures; XAML PNGs omit the DWM material. |
| **A** — Isolated App | A marked, empty Debug profile verified the fallback title and single pin, visible replacement, close/reopen, Settings recreation, and saved guide completion with no main-panel or guide WebView. Focused browser visuals passed (21 directly and one existing first-run case on retry), including PDF/link toolbar and Escape with normal/reduced motion. |
| **M** — Physical desktop | Repeat the reported Chrome linked selection once: expect one rich card with the link retained; then copy a different selection to check it stays separate. Also check OCR light/dark alignment, editor Save/Cancel, preview title/pin, and the guide switches at the real DPI. Live Chrome, compositor material, physical keyboard and focus are not established by the fixtures. |

### Consistent preview/editor spacing and tray opening focus

- **S:** Native previews leave an 8-DIP gutter below the caption and plain
  reading text uses the rich preview's text insets. OCR and the native text
  editor separate their field labels from the caption and body. Only the
  Windows WinUI rich-editor fallback uses the matching caption, edit glyph
  and footer; the document transaction, rich formatting and other platform
  routes are unchanged. The Win/Mac Debug labels sit beside, not on top of,
  their icons. The original shortcut SVG supplies its own surface.
- **U:** 160 focused frontend/source checks and 72 WinUI Rust unit checks
  passed. Style governance, formatting, native Debug frontend and asset checks
  passed; 10 browser cases against the built frontend passed, including rich
  save/undo/discard and preview switching with and without reduced motion.
- **X:** The old DLL reproduced the missing reader gutter. The new reader
  checks cover text insets, file/image spacing, themed file icons, aligned
  OCR panels and the native editor heading/field. The shell passed in normal
  and reduced-motion modes, including the equal Win/Mac button geometry and
  shortcut SVG without an extra wrapper. The tray case first reproduced a
  keyboard focus cue persisting on mouse open, then verified pointer focus
  on open/reopen, system focus on arrow navigation and Escape dismissal.
  Wait for observable theme/layout state rather than counting a fixed number
  of rendering callbacks. The inspected XAML captures do not include DWM.
  The broader history/queue suite stopped at the update-confirmation assertion
  (stage 102) with both the old and new DLLs on this isolated desktop; it is
  not counted as a pass.
- **A:** On an isolated desktop with marked synthetic history, the actual
  Debug app displayed the new rich-editor chrome and saved updated HTML and
  an RTF hyperlink. A separate empty-profile run verified the fallback
  preview and Settings lifetimes and native guide completion. Neither run
  accessed the live clipboard or the user's history.
- **M:** Compare plain text, rich text, link, image, color and file previews
  on the physical desktop. Check the plain/rich fields and OCR alignment in
  both themes. From Explorer, right-click the tray icon, navigate by keyboard
  and close; reopen by mouse after using another app and verify only the
  keyboard navigation shows a focus ring. Physical focus, transparency and
  high-DPI acceptance remain pending.

### Editor and preview frame, caption drag, and developer glyphs

- **S:** In WinUI mode Windows owns the frame and corners. The reader and
  native editor use their XAML Island's Acrylic slot; the browser fallback uses
  the equivalent DWM backdrop and removes its CSS shadow, blur and outer radius.
  Keep the preview client anchored when translating to the new frame bounds.
  The rich editor matches the native heading and action styling without
  replacing the HTML/RTF editor. WebView2 owns the rich-editor drag region,
  like Settings. OCR/plain-text captions use one pointer capture and no
  synthetic title-bar message. Normal previews retain their existing anchor
  and pin behavior. Win and Mac each have a separate icon and label; the
  developer toolbar draws glyphs once in a 16-DIP viewport.
- **U:** 35 focused frontend/source checks, style governance and the native
  Debug asset check passed. Against the built frontend, the new editor frame
  assertion failed first at the old CSS radius (12 px); both themes now pass.
  Ten browser cases cover editor formatting, discard, action styles and
  PDF/link preview and pin/close behavior with normal and reduced motion.
- **X:** Off-desktop Reader tests check the non-client inset, material
  selection, OCR and editor move/release state, plus pin, continuity and the
  editor draft flow. Native history/queue checks include pixel assertions for
  the four separated Windows panes and the visible span of the Memory glyph.
  The full shell passed with normal and reduced motion. XAML renders do not
  capture the DWM shadow.
- **A:** A marked isolated Debug profile checks the rich-editor caption,
  formatting-preserving save, preview replacement and renderer retirement.
  The rich editor and preview HWNDs reported transient backdrop and rounded
  corner attributes at 120 DPI. The cold-close fixture now waits for Rust
  to accept the open before sending the close. These runs do not use live
  clipboard capture or paste.
- **M:** Compare the plain/rich editor frames and preview frames on the
  desktop in both themes. Drag the blank title area of OCR, plain text and
  rich text, release over another app, and immediately click or type outside.
  Repeat across monitors. Physical capture, rounding and acrylic are not
  proven by the fixtures.

### Auxiliary Acrylic and reading-layer follow-up, 2026-11-21

- **S:** The old combined setter configured both the Win32 host and the browser
  controller. With a color set, Tao handled `WM_ERASEBKGND` with an RGB brush,
  so alpha zero did not expose the DWM material. Leave the host fill unset when
  the backdrop is available and set the controller color separately. Keep a
  solid theme/system fallback. WinUI-mode browser previews share one neutral
  reading layer; rich-text contrast and document/website pixels remain local
  to the content. The native XAML reader, legacy renderer and editor save
  contract are unchanged.
- **U / browser:** 21 focused tests and 10 browser cases passed. The ownership
  contract and shared reading layer failed first against the old source/bundle.
  Check normal/reduced motion, light/dark, dark ink versus light ink, PDF/link
  toolbar placement, and formatting-preserving editing. Style, asset,
  formatting and native Debug build checks passed.
- **X:** No XAML code changed; the preceding XAML results above are unchanged.
  Browser captures cannot show the OS material.
- **A:** On the same isolated 120-DPI system, both rich-editor and rich-preview
  HWNDs kept transient-backdrop and round-corner attributes; the erase message
  changed from handled (`1`) to unhandled (`0`) on each. WebView2 rendered the
  shared layer; the rich editor preserved HTML and an RTF hyperlink on save.
  Fallback preview reuse/pin/three cold close-reopen cycles, settings recreation
  and guide completion passed with a marked synthetic profile. The ordinary
  WinUI Debug was restarted once with matching executable/DLL hashes; no
  foreground input or user clipboard data was used for verification.
- **M:** Compare preview kinds and both editor frames in one session with the
  same Windows theme, transparency and focus state. Verify only the content
  (e.g. light ink on a dark canvas or a PDF's page) changes its fill. Window
  erase ownership is not a measurement of DWM output. The prioritized remaining
  coverage and renderer inventory are in the [next decisions list](windows-winui-next-decisions.md).

### Capture, paste delivery, and window self-check, 2026-11-21

- **S / U — capture:** replay the plain-to-rich phases for QQ and Chrome and
  recopy the same Chrome selection after a different one. Three completed
  captures leave two formatted history records; the recopied item's original
  hash moves to the end of the queue. No capture or deduplication policy changed.
  A probe confirmed access denied (`5`) creating a named test window station
  under the current account. The OS-generated name was already in use (`183`).
  The native clipboard tests now require a newly created station and report the
  OS error; they must never fall back to the user's station. The full Rust run
  passed 603 tests; the seven native clipboard tests stopped in that setup, and
  seven tests were ignored by the ordinary invocation.
- **S / U — paste:** queue Ctrl+V captures the external HWND and process at
  keydown and does not intercept in vPaste's own windows. The serial worker
  rechecks the target before clipboard restoration and before key injection;
  failure retains the queued item and its retry state. Queue-window clicks
  keep their saved target. Ordinary paste also requires the recorded foreground
  window independently of editable-control capture. Three source regressions
  failed before the change. Target identity (including reused handles), rapid
  shortcut order, undo, capture format and focus-policy tests passed. No
  assertion equates successful `SendInput` with delivery to the target control.
- **X — windows:** the focused loaded reader/OCR/editor regression passed after
  replacing a frame-count wait for confirmation dismissal with a bounded
  wall-clock wait. The dialog, draft-preservation and later Save assertions
  are unchanged. The full shell passed with ordinary and reduced motion.
  The history/queue run exercised OLE formats and queued row
  sorting, then stopped at the pre-existing Debug glyph pixel check (stage 981),
  also reproduced against the baseline; it is not a complete XAML suite pass.
- **A / browser:** the isolated app passed fallback preview replacement/pin,
  three canceled cold opens with reopen, settings recreation, and no second
  drag request from the settings caption. Rich editing retained HTML and RTF.
  The fixture did not activate the keyboard hook or write to the clipboard.
  The 23 focused frontend/source and 10 visual cases passed, including both
  browser motion preferences. Source formatting and the Debug build passed.
- **M — pending:** real Chrome/QQ copy and repeated external paste without
  history reentry, delivery/focus in external targets and physical drag cancel,
  native-to-WebView transitions on the actual desktop, IME, real mixed DPI and
  Windows contrast. Tests on a separate desktop do not cover input or the
  clipboard of a separate station; use an independent test session or a
  supervised pass. No user data or foreground input was used here.

### On-demand webpage renderer in WinUI previews

- **S:** In WinUI mode, creating the shared preview shell no longer prewarms
  `previewBrowser`. The committed link's existing geometry synchronization
  creates it if needed. Rich HTML and PDF still use the shared shell. Once
  used, the webpage renderer parks on a non-link and is reused until the
  preview closes. Legacy Windows WebView and macOS keep their prewarm path.
- **U / browser:** Four Rust browser-preview tests, 40 focused frontend/source
  tests and the style check passed. All 12 preview-resident and link-network
  cases passed against the built frontend with normal and reduced motion.
  Two initial Vite runs timed out before the mocked preview listener registered.
- **X:** No XAML code changed; no new XAML pass is claimed.
- **A:** The old Release failed the lifecycle assertion with an extra
  `about:blank` target during rich-text preview. The new Release passed cold
  rich and link opens, an intercepted HTML page rendered in the real webpage
  view, link-to-rich-to-link reuse, pinning, three canceled cold opens and
  renderer retirement. The legacy Windows mode still created the warm targets.
- **A / memory:** Two runs of each x64 Release used the same native DLL,
  marked 500-record profile and one-page PDF. Settings was closed before
  sampling rich HTML followed by PDF (no link opened). The PDF asset returned
  HTTP 200 in all four runs. WebView2 private-commit medians were 261–282 to
  235–237 MiB for rich text and 493–595 to 475–497 MiB for PDF. Each non-link
  phase consistently had one fewer WebView2 process (7 to 6 and 10 to 9).
  The host already differed by about 26 MiB before opening any preview; the
  ranges isolate WebView2 and do not claim a fixed reduction in app total.
  After close, all four runs returned to zero WebView2 processes.
- **M:** Physical keyboard/focus, live external websites and macOS were not
  exercised. The Windows runtime runs used an isolated, non-input desktop.

### Native-reference tint and typography for rich preview and editor

- **S:** The reported light-theme samples measured `#f9f9f9` on the
  native preview surround versus `#d3d3d3` on the rich preview surround.
  In WinUI mode only, the two WebView shells now share a theme-aware
  translucent tint and the native title/body typography roles. There is no
  extra blur, outer edge or shadow; DWM still owns the frame. Rich document
  canvases and authored formatting remain separate. Plain editing and OCR
  keep their native controls. No preview lifetime, geometry or save change.
- **U / browser:** The old bundle failed all four new light/dark and motion
  assertions for the unpainted window surround. The new bundle passes 64
  focused units, 20 browser cases, styles and the native-debug asset check.
  Compositing the preview CSS over the reported gray substrate gives about
  `#f9f9f9` for the surround and `#fcfcfc` for the reading layer; this is a
  controlled browser test, not a desktop capture. The existing dark/light ink,
  pin, Escape, PDF/link layout and HTML/RTF save assertions still pass.
- **X:** The unchanged native reader check passed at stage 12475 with plain
  editor and OCR form captures in both themes. Its XAML output excludes DWM.
- **A:** With the new embedded assets in the real Debug app on an isolated
  120-DPI desktop, the rich editor and rich preview both applied the new
  tint and the 16/600 title and 14/400 body styles. Both HWNDs still reported
  transient backdrop, rounded corners and an unhandled erase message.
  The editor saved formatted HTML and an RTF hyperlink; the preview and
  editor both closed. No user history or physical input was used.
- **M:** Compare the final composed windows over the same desktop in light and
  dark and in comparable focus states. A source color that needs its own
  reading canvas may still differ inside the document; its surround must not.

### Single-card Delete and rich-editor startup (2026-11-21)

- **S:** Match the shipping history's direct single-record deletion. The
  native card menu displays `Delete` as a hint, not a global accelerator.
  The menu uses the clicked row and the key uses the selected row; both
  dismiss any associated preview and dispatch the same Rust delete. Modifier,
  repeat, multi-selection and modal guards remain. Tab and clear confirmations
  are separate and unchanged.
- **S:** The WinUI rich editor keeps the existing theme, editing, save and
  discard behavior. It opens a dedicated HTML entry with one script and one
  stylesheet, consumes the document already read to choose the editor, and
  skips the speculative fetch before the target is available. Plain text
  still opens natively. A fresh WebView is created only when requested and
  is destroyed when the editor closes.
- **U / browser:** Both new source/component checks failed before the relevant
  fix. 635 related frontend tests, 9 Rust editor tests and 10 browser cases
  passed. The browser cases include the separate editor entry in light and
  dark and editing, save failure, discard and undo. Style and single-bundle
  asset checks pass for native Debug and production.
- **X:** The loaded menu checked the shortcut label across card types before
  an unrelated tag-toggle assertion (stage 2733). The broader presentation
  check stopped at the Debug guide glyph pixel assertion (981). Both failures
  reproduce with the old DLL too; neither overall suite is marked as passed.
- **A:** Isolated actual-App runs posted the editor/Delete keys to the native
  panel and invoked the real card menu via UI Automation. Each delete removed
  only its synthetic record without confirming. The editor loaded the rich
  document and released its WebView on close. In the final bundle, an actual
  edit saved formatted HTML and an RTF hyperlink, and kept the approved
  editor/preview tint, text roles, backdrop and rounded native frame.
- **A / timing:** With Settings already open (a warm WebView2 runtime),
  five open/destroy cycles per build measured median show time 768 → 632 ms
  and median editable-content time 1,273 → 683 ms (31 → 1 scripts). In the
  paired first-open test with no Settings WebView the HWND became visible in
  1,664 ms before and 1,709 ms after; this does not establish a cold-start
  improvement. Failed isolated profile launches during search index setup
  occurred on both builds, before any editor timing, and are not samples.
- **M:** Verify physical right-click and keyboard ownership on a disposable
  record and compare the first and subsequent rich edits on a normal profile.

### Long text card body clipping (2026-11-21)

The following records the initial fix and its isolation checks. The user
still observed body text over the card header while moving between cards;
the fixed-position capture below did not rule out a live-compositor issue.

- **S:** The shipping WebView scrolls within the body element. WinUI instead
  translates the text visual on the compositor. Give that shared card
  viewport a stationary rectangular clip, updated from its arranged size;
  never move the clip with the text. Plain, long-file text and rich-text cards
  share it. Keep the activation, timing, cancellation, normal/reduced-motion
  policy and the separate Space reader unchanged.
- **U:** The viewport source contract failed against the old code. The new
  contract and related WinUI card/WebView auto-scroll checks pass (21 tests).
- **X:** The focused loaded WinUI probe passed (`VPASTE_WINUI_CARD_PREVIEW_CHECK`,
  stage 257). After resizing from a 200×120-DIP viewport to 164×92, a
  translated text frame rendered 458 matching text pixels inside the body
  and none in the header or footer. Start, reduced motion, hiding, and
  unload still use the existing animation lifecycle.
- **A:** The rebuilt Debug app rendered three synthetic history records
  (plain text, TextFile and rich text) in the real native main panel. This
  verifies loading, not physical hover. The isolated search index reported a
  temporary write-access error; it did not prevent the cards from rendering.
- **M:** Hover a long plain or rich record until it scrolls. The source name,
  timestamp and badges must remain untouched when new lines enter or leave the
  body. Move to another card to check the inactive body's return to its start.

### Long text card scroll ownership follow-up

- **S:** The earlier fix supplied a viewport clip but kept a separate
  compositor translation on the body. The user's switching sequence is a
  reproduction clue, not a rule that the second card causes the defect.
  Preserve the desktop reference's real viewport scrolling: the card-only
  `ScrollView` animates its offsets, retains the stationary body clip, uses
  the existing delay/speed/pauses, and never translates the text directly.
  Only phase changes use a timer. Retirement resets the offset and ignores
  completion events from old scroll requests. Space readers are unchanged.
- **U:** The revised source contract fails on the translated-body path and
  passes with native offsets. 21 focused card, viewport and WebView reference
  tests and the UI style check pass.
- **X:** The old DLL passed the single fixed-position pixel check but failed
  the loaded main-panel transition test: neither card advanced its viewport
  offset. The native-offset DLL passes `VPASTE_WINUI_CARD_PREVIEW_CHECK`,
  stage 2586. It covers two active cards (selected and hovered), retirement
  of the stopped card, restarting on return, rapid switches, and a complete
  bottom/return/restart cycle. A single render of the panel samples both
  positions while nonzero; the test found zero matching text pixels outside
  either body's measured bounds. This is an XAML render, not a physical DWM
  capture. Keep this animated, multi-card check as the regression gate; a
  static translated glyph fixture cannot establish scroll ownership.
- **A:** The actual Debug app rendered all three synthetic long-card types.
  Automation could select fixture cards but could not read the private body
  viewport's scroll pattern, so offset and pixel evidence above comes from
  the loaded native test. No user history or physical input was used.
- **M:** On a normal interactive desktop, try several long cards in different
  orders, including a previously healthy card before and after a transition.
  Check both cards' title, icon and time during scrolling. An off-desktop
  selection action or XAML capture does not establish physical pointer parity.

### Command-menu opening focus

This initial attempt was superseded by the focus-stroke follow-up below. Its
synthetic source and focus injection did not verify the reported opening path.

- **S:** The reported black outline is consistent with WinUI's first menu
  item receiving keyboard focus when the menu was opened with the pointer.
  Scope the opening adjustment to the pointer's own menu and keep the
  native item selection, hover, keyboard focus visuals and dismissal. The
  same rule covers both custom-tab types, the add-tab button, card context
  menus and both queue-row context anchors. The tray already sets pointer
  opening focus separately. Emoji and source pickers are regular flyouts;
  editor controls and confirmation dialogs retain their intentional focus.
- **U:** 30 focused menu, keyboard, queue and native interaction source
  checks pass, including the new all-entrances focus contract. UI style and
  formatting checks pass.
- **X:** `VPASTE_WINUI_MENU_FOCUS_CHECK` passes at stage 27908 on the
  isolated desktop. A loaded native menu seeded with keyboard focus switches
  to pointer focus only for its own pointer opening. Reopens, an unrelated
  pointer source, a disabled first command and subsequent keyboard focus are
  covered without disabling system focus visuals. The isolated tray and
  desktop follow-up also pass (27810 and 268). The broader history/queue
  suite hits the same stage-32 `0x80004002` on both the before and after DLLs;
  it does not establish physical queue-menu parity.
- **A:** The built WinUI app opened the real card menu via an Apps-key
  message on an isolated desktop. Its Delete command remained actionable
  via UI Automation and deleted only the synthetic fixture record. This
  checks keyboard/command routing, not a physical pointer gesture.
- **M:** After using the keyboard, right-click each tab type and click `+`.
  Repeat after closing and reopening the panel, and check a card, its Tags
  submenu, an item in the queue, and the tray. Nothing should draw an idle
  keyboard rectangle on the first command after a mouse open. Open with
  the keyboard and use Up/Down, Enter and Escape to check that keyboard
  focus remains visible, including with a Windows contrast theme.

### Command-menu focus stroke before the first key

- **S:** The user's screenshots covered Add tab, the card menu and the filter
  menu. The outline moved to the next row on Down, confirming a focus cue
  rather than a menu border. The first attempt inferred a pointer source and
  corrected the first item's focus once at `Opened`. Keep native focus now:
  suppress the two focus strokes before painting a non-keyboard open, restore
  stock theme brushes on the first menu key or close, and preserve them from
  the start when the opening is part of a routed keyboard gesture. Apply the
  same policy to record tags, submenu commands and queue items; keep the tray's
  existing behavior and leave form controls and confirmations alone.
- **U:** 30 focused checks (menu wiring, keyboard, cards and queue) plus the
  UI style and diff checks pass.
- **X:** The new real-control check failed on the previous DLL at 27901 (the
  Add tab command still had both visible focus strokes). It passes at 27905
  with the current DLL across Add tab, card, filter tag and record tag. It
  holds the first cue off even when the first item acquires keyboard focus
  late, verifies Down moves focus and restores the second item's strokes,
  verifies Escape dismissal, and checks that closing and reopening with Space
  leaves stock resources in place. The tray and desktop checks also pass.
- **A:** An isolated app profile opened the real Add tab using Space, closed
  it with Escape, and reopened it through the button's UI Automation Invoke
  path. Sampling the popup's rendered upper row edges showed a continuous
  dark first-row stroke on the old build and no dark first-row stroke on the
  new build. Both kept logical focus; after injected Down the second-row
  stroke was visible and Escape dismissed the menu. On a direct Space open the
  new build rendered the first-row stroke immediately. This is a rendered
  comparison of the real app, not physical mouse input. An Apps-key event
  opened the card menu, and its existing Delete action removed only the
  isolated fixture record, without a confirmation prompt.
- **M:** The three user screenshots are the physical before evidence. Recheck
  those same entries with the mouse and with Down/Escape on the updated Debug
  build. Contrast-theme rendering and physical submenu/queue/record-tag
  coverage remain manual.

### Integrated WinUI follow-ups (2026-11-22)

- **S / U:** On the #401 / #403 integration base, build, style and asset
  checks passed, along with 900 frontend tests, 617 Rust tests and 20
  browser cases (including reduced motion). The 120 affected source
  checks passed again after #403. Seven Rust clipboard-station fixtures
  could not create their isolated station on this host; the Linux
  release-upload fixtures were not run on Windows.
- **X:** Menu focus (27905), card scroll (2586), reader and editor/OCR
  controls (12475), tray (27810), and the #401 regression suite (2016)
  passed on an isolated desktop. The scrolling probe counted no body
  text pixels outside the two moving card viewports.
- **A:** The current app rendered the Add-tab focus cue only on a
  keyboard open or after Down, and both tested opening paths dismissed
  with Escape. A cold rich editor opened through F2, retired its WebView
  on close, and the card-menu Delete removed only the synthetic record.
  The lifecycle probe passed on-demand webpage allocation, preview
  reuse and pinning, Settings recreation, and guide completion without
  a guide or main-panel WebView. No external paste was exercised.
- **M:** The user confirmed the reported menu-outline fix before this
  integration. The integrated base was not rechecked by physical input;
  the desktop material, contrast and external-paste checks remain separate.

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
   keyboard input must return to the dock. In the native reader, focus the pin:
   Space toggles it, Tab/Shift+Tab navigate controls and
   Escape closes the reader. Content-origin preview shortcuts still work after
   automatic focus handoff, without first focusing a toolbar button. Include a
   GIF and verify its card uses a static first frame while its full preview is
   animated; test GIF/Rich badge accents after details load and in both themes.
   Confirm the PDF controls remain unobscured and press Escape with focus inside
   the PDF itself. Open OCR from an image card, edit the text, and check the
   shared pin and outside-click behavior in both fixed and unfixed states.
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
   shortcut practice, both Debug guide previews inside the real main-panel host,
   on-demand settings close/reopen and external paste focus. Confirm guide
   previews do not alter saved onboarding/preferences. After a warm session,
   repeatedly switch categories with real history and note whether any delay
   remains; synthetic component timings are not an end-to-end pass. Check card
   Enter after a fresh summon/category switch and compare queue click-paste with
   the queue shortcut. Open a card's Tags submenu and check label alignment,
   checked state and keyboard navigation.
   The isolated automated fixture intentionally disables several such services.
9. **Duplicate capture versus repeated paste:** make a single real rich copy
   in Chrome and QQ; each should record one complete item. Re-copy the exact
   same payload, then copy a different selection and compare history and queue.
   Separately paste repeatedly to another app (Enter and queued Ctrl+V); check
   target content and queue advancement without creating a history item from
   an internal clipboard write. Do not count fixture-only capture tests or
   modifier replay as this live pass.

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
