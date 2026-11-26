# Windows WinUI bridge ownership

This bridge belongs to the opt-in Windows native UI. It is compiled on Windows
x64 with the `winui` feature in Debug or Release; `winui-debug` remains a
compatibility alias. It is not a public Tauri command or a format stored in user
configuration. macOS keeps its independent Swift UI and existing activation gate.
The shipping WebView remains the default unless `--main-ui=winui` is supplied.

## Initialization and messages

Rust loads the adjacent DLL and checks `vpaste_winui_protocol_version` before
initialization. Version 8 is defined by `winui_panel/bridge.rs` and `WinUiBridge.h`.
A missing or incompatible version is a startup error with a rebuild instruction;
an old DLL must not silently run against a new Rust host.

Requests use UTF-8 JSON with `id` and `op`, bounded to 16 KiB. The common DTO
parses history/navigation fields and retains the full payload for the existing
queue and tag parsers. Do not drop their `hashes`, `name`, reorder or assignment
fields while changing the common envelope. Unknown operations retain an explicit
error response. Results are bounded to 4 MiB and preserve `id`/`op` when replacing
oversized data with a recoverable error. Native bytes are copied before callback
return; asynchronous work never retains a borrowed FFI buffer.
Only plain-text editor open/save and OCR copy use the larger document wire
envelope, so JSON escaping cannot lower the existing 8 MiB text limit. Neither
the normal history nor reader payload budget increases.

Rust owns history, configuration, queries, capture, paste, files, OCR, queue and
tag rules. WinUI owns native controls, focus/geometry, interaction drafts and
presentation. Windows-only helpers must not be moved into shared business code
merely to reuse UI types. Keep the existing request IDs, query/reader generations
and queue revisions authoritative over late responses.

The WinUI tray popup is independent of the dock HWND. Rust projects the same
capture, update and preference state as the legacy menu using
`nativeTrayShow`/`nativeTrayState`; `nativeTrayAction` returns to the existing
commands. No tray WebView is prewarmed in this renderer. The popup is created
on first use, and its outside-click timer runs only while visible.
The tray click enters the first row with pointer focus, not a remembered
keyboard cue. Subsequent Tab and arrow navigation keep system focus visuals.

Callbacks on the WinUI STA may enqueue Tauri main-thread work; they must not
synchronously wait for that event loop when it may already be waiting for WinUI.
The reader HWND export is an atomic snapshot. Other UI objects are accessed only
on their owning STA. Release islands, timers and preference subscriptions on
that STA before COM shutdown.

Avoid function-static WinRT objects in bridge helpers: App SDK/COM can be torn
down before a DLL-static reference is released. Cache only immutable resource
bytes or plain C++ values, and create short-lived WinRT projections on the STA.

## UI and motion

`WinUiAppearance.h` owns native styles, live theme resources and control sizes.
`WinUiMotion.h` reads the embedded `src/ui/motion/tokens.json`, also consumed by
React and Rust. Built-in menus, dialogs and controls retain WinUI's transitions.
App-authored status/search feedback affects opacity and honors Windows animation
settings. The shared tab underline uses a native Composition spring, calculated
from the shared `spring.tabIndicator` preset; existing React spring presets are
unchanged. Native items still own hover, press,
keyboard focus and selection semantics. Scrolling and layout changes realign the
underline; contrast mode and disabled Windows animations settle it immediately.
The main dock, preview geometry and active drag retain their separate owners.
Feedback opacity uses `UIElement.StartAnimation`/`StopAnimation` and the current
thread's `CompositionTarget` compositor. Keep the active animation in the
element's resources so interruption/disabled motion stops it before resetting
opacity. Do not call `GetElementVisual` on an element using XAML facade properties
such as elevation's `Translation`: mixing those paths made the queue action bar
visible but absent from pointer hit testing. A button automation Invoke alone
does not cover this defect; regress the topmost XAML hit over real cards too.
The dock's STA timer moves the whole HWND using the shipping Rust panel model's
150/200-ms curves, sent through the private behavior projection. Rapid toggles
reverse from the actual position. Logical visibility changes at the request;
the physical hide finishes after sliding. Hide-for-paste is immediate. A hidden
dock parks at its canonical bounds so later monitor queries cannot select the
monitor below it. DPI/display/layout changes cancel obsolete endpoints, and no
animation wait blocks either event loop.
The private `get_layout` export snapshots canonical physical bounds on the STA.
Monitor selection and preview placement use that snapshot while the dock moves;
an actual DPI event supplies the new scale after cancelling the old motion.
Contrast detection uses desktop `SPI_GETHIGHCONTRAST` and the owning HWND's
`WM_SETTINGCHANGE`/`WM_THEMECHANGED` messages. Do not require a WinRT
`HighContrastChanged` subscription: registration failed with `0x80070490` in the
unpackaged desktop host. Native control startup is part of the regression gate.

### Shipping-panel parity

The shipping WebView is React, not Vue. Its clipboard header, card layout and
window behavior remain the product baseline; WinUI supplies native interaction
and accessibility rather than a different file-manager layout.

| Surface | Native implementation and preserved behavior |
| --- | --- |
| Search | `AutoSuggestBox` with native query/clear buttons; live filtering, IME, Ctrl+F, latest-query Enter paste and two-step Escape. The collapsed circular trigger keeps the header compact. |
| Header actions | Circular surfaces, in order: developer tools, queue, conditional update, settings. Settings is the final standard action; the persistent overflow button and duplicate copy/paste/favorite/queue-selection actions are removed. There is no extra combined-filter button. The trailing `+` has only New filter tab and New tag, matching WebView; existing tags retain edit/delete through double-click and context menus. Card actions and queue selection keep their corresponding card/queue entry points. |
| Categories and tags | `SelectorBar` in a horizontal `ScrollViewer`; the pinned template is centered in the 48-DIP header and its internal pill is replaced by one shared composition underline. Add follows the final tab. Tag/filter editors open above their anchor using unconstrained native `Flyout`. |
| Cards | `ListView` with horizontal `ItemsStackPanel`; details are loaded for realized containers. A 2-DIP selection/focus outline sits 2 DIP outside the 14-DIP rounded card, in an unclipped sibling with its own gutter. Selection maps through list item indices rather than casting the visual content to a card border; contrast themes keep system focus and selection visuals. |
| Menus and confirmations | Native `MenuFlyout`, `ComboBox` and `ContentDialog` retain their templates, dismissal, keyboard behavior and default shadows. Do not add a second shadow behind them. |
| Elevation | DWM owns the dock, queue and reader window shadows. `WinUiAppearance.h` owns small inline `ThemeShadow` elevations for cards, header and toolbar controls; contrast mode removes decorative shadows. The clipped record-tag track does not own a second shadow. |
| Auto-hide | External deactivation schedules a delayed recheck. Reopening, internal focus, editors, dialogs, drag, preview pinning and existing hide suppression protect the panel from stale blur events. |
| Queue | The existing Rust queue remains authoritative; the separate non-activating native window keeps paste focus on the target app. Its toolbar toggle and multi-selection actions remain separate. Centered title/count, Reverse/More, separator rows and bottom Undo follow the reference hierarchy. Native OLE sorting with an insertion line, always-visible Remove and InfoBar errors remain documented differences from WebView. |
| Settings | The existing WebView settings page remains in use and is destroyed on close. It is not part of this native UI migration. |
| First run and replay | The native XAML tutorial replaces the dock's history content, with no auxiliary window or WebView. It retains the welcome, filters, shortcut practice and completion sequence; Debug Windows/Mac reads saved tabs but only projects a temporary draft. The configured shortcut resumes the same view, and Finish releases it before returning to the history. |
| Edit and OCR | Plain text, links, colors and text-file entries use a native multiline editor and the shared revision-checked save transaction; rich HTML/RTF editing keeps the shipping WebView. OCR reuses the native reader and the shared recognizer and clipboard/history commands, preserving draft edits, selection/copy-all, and pinning. |

The shell parity regression runs real controls on the WinUI STA with synthetic
records and no user database. Native rendering snapshots cannot prove DWM
shadows, acrylic, IME composition or external-app focus transitions; verify
those on an interactive Windows desktop, including mixed DPI. Keep visual
checks local and do not add hosted screenshot jobs for this workstream.

The header remains 48 DIPs high with 32-DIP circular actions and explicit 16-DIP
glyphs. Native tab labels use 14 DIPs (the React baseline is 14.5), a 5-DIP
icon/text gap and at most 128 DIPs for custom tabs. Full names remain accessible
through tooltips and automation names. Keep Windows text scaling enabled; do
not compensate for display DPI by changing font sizes.

Dock bounds use the full physical monitor, matching the shipping panel. Queue
and reader bounds use the monitor work area and preserve valid placement. They
recheck physical outer bounds on DPI, display and taskbar/work-area changes.
Native dock and auxiliary clients already match their outer HWND bounds through
`WM_NCCALCSIZE`; do not reapply the WebView's client-to-frame correction to them.

The last tutorial step temporarily routes the main shortcut to the guide so it
can hide and reopen the same page. Other steps only restore it. Main-panel show
requests, including a second launch, restore an active guide rather than showing
the dock over it. Completing the guide returns the shortcut to the native panel.

Leaving queue selection invalidates its pending Add request and submitted-hash
snapshot; a history dataset reset does the same. The Rust write may already
have committed, so its queue state can still arrive, but its reply must not
clear or block a later selection draft. A current failure preserves the draft
for retry; repeated success replies clear it once.

A history reset retires and closes the current item-delete confirmation. Its
asynchronous completion must still own that exact dialog before clearing modal
state or sending Delete, including when its Primary result is already closing.
Bare Escape from ordinary toolbar/card action buttons uses the existing panel
dismiss operation when search is closed. A visible search retains WebView's
two-step Escape priority even after focus moves to cards or ordinary buttons:
clear its text first, then collapse the empty search. Menus, dialogs, editors,
composition and modified Escape retain their existing ownership; native button
Enter/Space activation is unchanged.

A history reset also retires record-tag and custom-filter flyouts, pending
editor replies and queued focus-return callbacks. Late tag creation must not
chain an assignment against replacement history; late filter completion must
not apply an old editor's list or close a newer editor. This is UI-session
retirement, not cancellation or rollback of an already submitted Rust write.
Successful filter writes still trigger an authoritative filter-list refresh.

History reset also cancels the dataset-owned image-export UI session and hides
open card and dynamic-tab context menus before new query results arrive. A late
export preparation cannot reopen the picker; cancellation during its modal loop
must keep modal begin/end paired and prevent a new export request. This does
not cancel a file write that Rust has already received. New-dataset actions and
ordinary export cancellation/retry keep their existing native controls.

Fresh main-panel shows clear and collapse search when search retention is off,
matching the WebView show plan. Enabled retention preserves search visibility
and text; same-session restoration, such as returning from editing, does not
apply fresh-show resets.

Opening a custom-filter editor, item-delete confirmation, native modal or main
panel menu retires any deferred Enter-to-paste search action. This includes
pointer-opened card menus, record/filter-tab menus, creation and developer tools.
Canceling that overlay must not rearm the old action: a late query may refresh
history but cannot paste. A fresh
explicit search submission still supports ordinary, plain-text and quick paste.
This does not cancel a paste or Rust operation that has already been sent.
On Windows, ordinary paste verifies the saved external HWND and process before
sending keys, even when an editable UI Automation element could not be saved.
The queue shortcut only intercepts Ctrl+V in an external window. It keeps that
window's identity with the request. Row clicks save the external window and
editable focus before enqueueing, or reuse the previous external target if
vPaste owns the current foreground.
The worker checks the target before the clipboard write and again before key
injection. A missing or changed target produces the existing retry state without
consuming the queue item. This is not an acknowledgement from the receiving app.
Hiding the panel cancels an unconfirmed tab deletion so its dialog cannot
reappear over a later show. Single-card deletion does not open a dialog.
Native automatic card/tab/creation-menu dismissal on hide/reopen is retained.

## Auxiliary renderer lifecycle

### Properties-style auxiliary surfaces

For native inspector and editor surfaces, reuse the `AuxiliaryCaption`,
`AuxiliaryGroup`, `StyleAuxiliaryAction`, and `AuxiliaryFooter` patterns in
`WinUiAppearance.h`. In WinUI mode, use one Desktop Acrylic material:
`DesktopWindowXamlSource.SystemBackdrop` on the native island and the DWM
transient backdrop behind the transparent browser renderer. Do not depend on
a transparent XAML root to expose a host HWND backdrop. Windows owns the outer
corners and shadow; the WinUI-mode browser content does not draw another
blurred, rounded window. When DWM supplies the browser fallback's backdrop,
leave the HWND's background brush unset and make only the WebView2 controller
transparent. The combined Tauri setter would give Tao a background brush that
ignores alpha on Windows. When the material is unavailable or Windows contrast
mode is on, use a solid theme/system color. Match the native reading layer at
the WebView preview's neutral inset; preserve an adaptive document canvas for
explicit rich-text ink and let PDFs and websites draw their own media colors.
The editor form itself does not draw an opaque canvas: the input
fills its working region, and content such as the original OCR image sits in
its own softly outlined group. Native tag editors retain their anchored
Flyout and its system presenter; the inner form uses the same group and
header/footer rules. Tag management uses the same grouped surface for its list.

Use a compact title aligned left and named 32-DIP caption controls aligned
right, with 16-DIP reader insets and 8-DIP group/control gaps. Separate the
entire caption (title and actions) from its contents with a single themed
bottom stroke. Use the feature's existing glyph before the title when it aids
recognition; it is not a separate control. Custom headers such as tag
management and the queue reuse the stroke without changing their layout.
Give content groups an 8-DIP radius, one theme-resource outline and no
separate shadow. Put OCR's image and result labels on the same heading row,
the two working surfaces on the same fill row, and feedback below both.
Use a 12-DIP gap below the divider before the first form label, then 8 DIPs
between the label and its content. Use that same heading treatment for editing.
When a form has commit actions, place 36-DIP buttons on the right after a
single, subtle top separator. Use the stock WinUI Button for secondary
actions and `AccentButtonStyle` for a commit such as Save, without overriding
the template's colors, typography, padding, or corners. Preserve native focus
visuals and visible error text. The ordinary reader keeps its single pin rather than a
form footer; OCR uses pin and Close in the title row and Copy all in the
footer. WinUI's browser-based preview fallbacks mirror the reader's localized
title, 40-DIP caption and single pin above their content. Leave an 8-DIP
content gutter under the caption and use the same 12-DIP preview corners.
Plain reading text has the rich preview's 24-DIP horizontal and 22-DIP
vertical document insets; media retains its own aspect ratio and fit rules.
The Windows WinUI rich editor matches the native 14-DIP field labels,
36-DIP buttons and 4-DIP control corners with scoped Fluent colors. The
WebView still owns HTML/RTF formatting, undo and save. Drag its header via
WebView2's native app region (excluding Close), as in Settings. The WinUI
OCR and plain-text editor move from their caption with pointer capture,
resetting capture on release, cancellation, loss of capture or close. They
never post a synthetic mouse press or start a system modal move loop.
Ordinary previews remain positioned by the reader's anchor logic. Legacy
platform routes retain their appearance. Close, Escape and
unsaved-change confirmation retain their existing command owners. Use WinUI's existing MenuFlyout, ComboBox and ContentDialog
templates for short system interactions rather than nesting another window.

The layering reference is [Files' properties page](https://github.com/files-community/Files/blob/48d3136967534ea00b58e6fa00339cc3681e9351/src/Files.App/Views/Properties/MainPropertiesPage.xaml).
Its material settings are independent of this layout pattern. Do not reduce
whole-window opacity or add a second opaque page fill to imitate the material.

### Branded guide exception

The in-panel native tutorial follows `TutorialOverlay.tsx`,
`TutorialOverlay.module.css`, and the tutorial palette in `src/ui/tokens.css`,
not the properties-window style. Keep the horizontal logo/wordmark/underline
welcome, numbered left rail, center illustrations or five filter tiles, and
the right-side pill action; fold to the single-column scrolling layout at
900 DIPs. Center the constrained step inside the actual viewport in both
layouts. Keep the original SVG illustrations and shortcut press/pulse.
The shortcut SVG already includes its surface; do not wrap it in another
border. The Debug Windows and Mac entries put their icon and short label in
the same horizontal row.
`WinUiOnboardingStyles.xaml` owns the guide's visual styles and high-contrast
resources; the filter tiles contain stock, named WinUI `ToggleSwitch` controls.
Use shared motion timings, remove decorative motion when Windows animations are disabled, and
leave the welcome hold, existing draft/save policy, and real shortcut practice
under their current owners.

### Reader and editor lifetime

The native reader leaves activation and focus-navigation keys to toolbar
buttons, including events originating from their glyphs. Escape still closes
the reader; content-origin Space/arrows/Tab and Ctrl+Tab keep their preview
shortcuts. Root key routing must check the original control's ancestry before
handling those shortcuts. A requested native focus handoff targets a named,
focusable content host, not the pin button; the content layout and the Rust
decision about whether to activate the reader remain unchanged.

Supported text, image, color and file readers are native. OCR uses the same
native reader window with a form whose text controls own navigation and IME.
HTML, links and PDF can create the shared auxiliary reader without creating the
main WebView.
While visible, that reader retains the existing continuous content/geometry
transitions. In a WinUI session, closing it hides and clears the session, then
queues destruction of the shell and browser renderer on the Tauri main thread.
Reservations and retirement share the pending-preview lock. The exact window
instance, inactive request generation, visibility and pin state are checked
before destruction, so a newer request or pin invalidates an old retirement.
An asynchronous creation that finishes after closure is retired as well.
Ordinary WebView sessions and macOS retain their existing reader policy.

## Local Release build and deployment

```powershell
npm run build:windows:winui
```

This builds the production frontend and a Release executable with `winui`,
without bundling the existing installer or creating updater artifacts. It checks
the executable's side-effect-free `--winui-build-info` result, production-tool
isolation, required native exports and absence of native Debug probes/Debug CRT
imports. Each build creates a new timestamped directory and ZIP under
`src-tauri/target/release/bundle/windows-winui/`; existing portable data is not
cleared. `-SkipAppBuild` may stage an already verified Release binary.

Extract the complete archive and use `Start-vPaste.cmd`. It selects WinUI only
for that process and uses a new portable data directory, without migrating the
installed app's history. The executable, `VPasteWinUiPanel.dll` and
`Microsoft.WindowsAppRuntime.Bootstrap.dll` must remain adjacent. A second
installed vPaste process should be closed before testing the portable.

Enabling autostart from a Windows WinUI session records `--main-ui=winui` in
the existing login entry. A Debug developer session also retains `--dev-mode`
so its data remains isolated; profiling and other diagnostic arguments are
never forwarded. Portable entry ownership follows the quoted executable path,
while reconciliation compares the complete command. A secondary launch from
the same path leaves that entry alone; the primary session reconciles its
selected mode during setup. Ordinary WebView and non-Windows startup arguments
remain unchanged. Updating an existing portable entry's arguments preserves a
Task Manager startup disable; only explicitly enabling startup resets it.
No backend is saved to the user configuration file.

Deployment is framework-dependent. The matching Windows App SDK Runtime NuGet
package supplies four Microsoft-signed x64 MSIX packages, runtime license and
notices in `runtime/`. The build also writes `SHA256SUMS.txt`. If Windows App
Runtime 2.6.5 or a compatible 2.6 update is missing, run the included
`Install-WinUiRuntime.ps1` once. Keep the complete bundle, including
`SHA256SUMS.txt`. The script checks all four files, hashes,
expected package identities, architecture and minimum Windows versions before
the first installation. It then skips same/newer installed versions and uses
`Add-AppxPackage` for the current user, without
downloading, forcing other applications to close or bypassing enterprise
policies. `-WhatIf` checks the proposed installation without changing the system.
The manifest's hashes detect incomplete/corrupt copies; `Add-AppxPackage` still
verifies Microsoft signatures. This is preflight, not transactional installation:
a later Windows/policy error can still leave some validated packages installed.
When runtime initialization fails, vPaste shows its error and the
`--main-ui=webview` recovery command.

The package scripts use .NET streaming SHA256 rather than depending on
`Get-FileHash`, which was unavailable in the npm-spawned Windows PowerShell 5.1
host on the acceptance machine. Installer tests use generated ZIP manifests and
mock both Appx cmdlets; they never install/uninstall a runtime on the developer's
machine.

Local verification on 2026-11-14: the bundled runtime passed `-WhatIf`; the six
mocked installer scenarios passed, including missing, corrupt and wrong-identity
bundles rejected before any install call. The opt-in WinUI Release build and
portable manifest checks passed. Twenty-one focused Rust autostart/backend
tests passed after adding a portable-mode guard to the legacy login-entry
cleanup. A Release memory comparison and physical keyboard/IME/mixed-DPI checks
were not completed in this run; see the task's local evidence before treating
those as accepted.

The current SDK's runtime manifest requires Windows 10 **1809 / build 17763** or
newer; do not infer 1709 support from older framework documentation. Windows 11
materials may fall back on Windows 10. WebView2 Evergreen is still required for
settings and rich auxiliary pages; it must already be installed on an offline
machine. The WinUI archive does not install WebView2 or replace the existing
formal release workflow. Testing this package is not publication authorization.

## Resource measurement

Selection/focus changes update selection chrome only. They must not reapply the
whole panel theme or reconstruct unrelated file artwork. Keep file presentation
identity while its data and effective theme are unchanged; explicit new detail
responses and real theme changes still update it. An unchanged `set_theme`
message on summon is a no-op, not a second initial-render pass. The native shell
regression checks child identity, card-request counts, real theme changes and
explicit detail replacement. Its replay of the former 36-card focus restyle is
a component benchmark, not an end-to-end summon or Release-memory result.

Both the card and the native file reader receive
`light`/`dark` file artwork as `{name, asset}`. `name` remains the logical
icon identity; `asset` selects a PNG resource embedded in the WinUI DLL. The
build rasterizes the same installed Material icon manifest and the three
product glyphs, with a maximum edge of 256 pixels. The XAML thread weakly
shares live `BitmapImage` sources by asset. The WebView artwork, file path
and badge rules, and images/PDFs opened as preview content are unchanged.

Batch visible local verification. Run source/unit checks, builds and read-only
resource sampling silently during implementation. Announce one final interval
for mapped native/actual-App tests; do not repeatedly open test windows after
each edit, inject desktop input into the user's session, or automatically
restart ordinary Debug afterward. Any repeated visible runs needed to correct
a failing test stay within that announced interval. Keep physical smoothness,
mouse/keyboard focus, DPI and live external-App behavior explicitly manual.

Filter and record-tag context deletion use the panel-owned confirmation dialog,
with the reference's type-specific description. Do not construct an editor or
query source apps for a deletion. Cancel/hide/history reset retire confirmation;
only a primary result with current ownership sends a write. Pending writes block
duplicate tab deletes, surface errors, and refresh authoritative lists even if
the panel was hidden. Neither editing form contains a Delete action.

Tab captions and card/source labels do not need duplicate hover text. Preserve
accessible names/help, shortcut hints for assistive technology, the native
pointer-over/pressed states, keyboard focus and useful icon-command/error
tooltips. Card record tags are separate ordered pills in a non-interactive,
clipped overlay. More than two tags use the shared marquee timing; hidden,
unloaded and reduced-motion states stop the track.

Card-only text previews use `AutoScrollCardPreview` and the shared
`cardPreview` Motion tokens for delayed automatic scrolling and the bottom
pause/reset/restart cycle. The viewport cannot receive pointer or keyboard
scrolling. Focus/hover starts the overflowing preview; inactivity, hiding,
unloading and disabled Windows animation stop/reset it. Full readers keep
their existing interactive scrolling. The main panel rejects its own card
drops while suppressing that target's drag adorners; external data providers,
target negotiation and tab/queue sorting remain separate.

Native developer tools use the same Debug plus exact `--dev-mode` gate as
WebView. Eight independent buttons precede the eye toggle: Windows tutorial,
Mac tutorial, language preview, theme preview, Test Room, memory monitor, native
demo and UI Lab. The group starts expanded; ordinary dev and Release hide it.
Language/theme previews last only for the session and never save configuration;
real configuration events retire the preview. Windows and macOS reuse the same
Debug tutorial builder and isolated draft. UI Lab stays Vite-only and opens in
the browser; native-debug assets include tutorial/Test Room/memory routes while
production excludes them. No main WebView is created for a developer action.

The Debug-only memory-profile path initializes the selected native renderer
before requesting its first show. It must not create the main WebView as a
fallback for a WinUI measurement. The existing explicitly marked temporary
fixture supplies synthetic records; ordinary user history is never the fixture.
With `custom-protocol` enabled (including `winui` and `winui-debug`), profile WebViews use
the embedded `App` routes. A normal development build retains its loopback
developer origin. In a custom-protocol build, merely changing `devUrl` does not
make a remote page local to Tauri; do not grant remote IPC to work around this.
Verify the real first-page readiness and visible window before accepting a run.
The isolated fixture intentionally starts no live clipboard monitor, so its
capture synchronization returns no pending capture. Its frontend logger remains
available, and resident preview warmup is suppressed for either renderer's
first-page comparison. Normal startup retains both mechanisms.
`scripts/measure-windows-app-memory.ps1` observes the selected executable's full
process tree without changing focus, starting/stopping apps or trimming memory.
Compare private committed bytes; summed working sets can count shared pages
more than once. Record binary, workload, UI backend, cache state and measurement
interval, and distinguish Debug/dev-server evidence from packaged Release use.

Run the native control regression plus bridge/queue/tag tests after a transport
change. Check the ordinary Windows build without `winui` and inspect the
macOS/source diff. Shared Rust changes need tests for both consumers; browser
platform mocks cannot establish a native macOS runtime pass.

For local auxiliary lifecycle verification, a marked Debug memory fixture can
add `--memory-profile-auxiliary-check` to open settings as a trusted control page.
It does not enable remote IPC or create a main WebView. This option is reachable
only through the existing explicitly isolated Debug fixture, never in Release.
Check real reader destruction/recreation, rapid close/reopen, pinning, OCR
completion, settings close/reopen and guide shortcut practice on the desktop.

With that isolated process running and WebView2 CDP on localhost port 9345:

```powershell
node scripts/check-winui-auxiliary-lifecycle.mjs <marked-memory-fixture-directory>
```

The check verifies the exact process data directory before invoking commands.
It exercises six inactive-queue mutation guards, visible reuse, pin protection,
canceled cold creation, reopening, settings recreation, guide completion and
absence of guide/main WebView targets. It
does not activate the queue/input interceptor or paste to another App. Successful
queue mutations are covered separately by the Rust database and actual-XAML
regressions. It neither starts nor stops vPaste and does not substitute for
physical keyboard, external-app focus or DPI checks.

Native migration regressions must exercise the real projection and presentation
boundary. Lightweight card payloads omit drag HTML even when stored rich content
exists. Determine the native Rich badge from render/stored-format presence; do
not enable drag expansion just to populate a chip. The native tutorial starts
its welcome timer after the dock is shown, independently of data initialization.
Its controls remain in the same XAML root when shortcut practice hides and
restores the dock.

Reader handoff preserves the current physical rectangle across native/shared
renderers, then interpolates to the accepted content's size. Keep the old
renderer mapped until the replacement is ready. Pending image decode must not
retarget the accepted resize; commit the new content and geometry together.
Bound native window callbacks:
WinRT exceptions must be logged and must never unwind across Win32's callback
ABI. Focus restoration schedules ordinary XAML layout rather than forcing
`UpdateLayout` during focus/preview callbacks.

For settings consumers and the distinction between source/native/actual-App
evidence and physical acceptance, use the
[configuration inventory](../testing/windows-winui-settings-parity.md) and
[scenario matrix](../testing/windows-winui-acceptance-matrix.md). The tray keeps
the shipping React WebView menu in WinUI mode too. On Windows it is prepared
hidden and hidden/reused after dismissal, avoiding a cold WebView creation at
each right-click; its React layout and actions are unchanged. Settings remains
on-demand and is still destroyed on close. Its Windows title-bar drag now uses
WebView2 non-client CSS caption regions with no competing JS/IPC drag handler.
The manual packed-coordinate move workaround did not pass the user's physical
test and was removed. Other platforms retain their existing drag route.
Drag formats must be declared synchronously before the
WinUI core operation begins; asynchronous Rust preparation supplies their
values and cancellation must release pending provider requests.

File-preview eligibility is shared by React and WinUI: ordinary files such as
MP4 remain type-icon presentations and no longer invoke Shell thumbnail/codecs.
Image, text, PDF and multi-file paths retain their existing behavior. A single
image File has the Image *visual header* while retaining File identity, category
queries and native file drag semantics. The native reader exposes a system
material around a thin theme-resource content layer and keeps an opaque
system-theme window fallback; rich WebView rendering is preserved. A source icon without a dominant color
uses the reference neutral gray header; an empty replacement clears any prior
decoded source artwork. Do not infer an application identity from that generic
fallback. See the scenario matrix for the separate
unit/XAML/actual-App/manual evidence boundaries.

### Material comparison: Files (2026-11-17)

The main island already uses the SDK `DesktopAcrylicBackdrop`, attached to
`DesktopWindowXamlSource.SystemBackdrop`. A supported backdrop makes the shared
window canvas transparent; initialization failure uses the existing light/dark
opaque canvas and contrast mode uses the system background. Content cards keep
their readable surfaces. This is background material, not whole-window opacity.

Files' `AppSystemBackdrop` supports Mica, Mica Alt, base Acrylic and Thin Acrylic.
Its Thin Acrylic path explicitly chooses `DesktopAcrylicKind.Thin`; the light
recipe uses tint opacity 0 and luminosity opacity 0.44, the dark recipe 0 and
0.64, with separate fallback colors. It also updates input-active state from the
window activation event. vPaste currently leaves the base Acrylic recipe and
activation policy with the SDK. The user's local Files material selection was
not inspected; source support alone does not prove which recipe they see.

Translucency also depends on opaque foreground surfaces, wallpaper/other windows,
activation, Windows transparency settings, battery saver and contrast mode.
Therefore lowering the whole window's opacity would not reproduce Files and
would also fade text. No material redesign is included in the queue/shortcut
fix. A future comparison should hold backdrop content, theme, activation, DPI
and foreground surfaces constant, comparing base and Thin Acrylic on the
window background only; retain readable cards and system fallbacks.

Primary references:
- [Files AppSystemBackdrop at 754c991](https://github.com/files-community/Files/blob/754c99145e9cee89eb9005a7dd1d86a0705c08b8/src/Files.App/Helpers/UI/AppSystemBackdrop.cs)
- [Microsoft Acrylic material](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)
- [Microsoft DesktopAcrylicBackdrop](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.media.desktopacrylicbackdrop)

### Retired standalone sample

The obsolete native sample command/FFI and its Win32/Swift demo windows have
been removed. The `native-demo/windows/winui` directory still contains the real
WinUI application and must not be deleted as sample cleanup. The real macOS
Debug panel now compiles directly against `native-panel/NativePanelBridge.h`
into `VPasteNativePanel`; its entry and focus guard remain independent. Debug
keeps seven individual shared tools (the mac native-panel entry is additional),
with the same Debug plus `--dev-mode` gate.
