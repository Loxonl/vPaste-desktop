# Windows WinUI bridge ownership

This bridge belongs to the opt-in Windows native UI. It is compiled on Windows
x64 with the `winui` feature in Debug or Release; `winui-debug` remains a
compatibility alias. It is not a public Tauri command or a format stored in user
configuration. macOS keeps its independent Swift UI and existing activation gate.
The shipping WebView remains the default unless `--main-ui=winui` is supplied.

## Initialization and messages

Rust loads the adjacent DLL and checks `vpaste_winui_protocol_version` before
initialization. Version 2 is defined by `winui_panel/bridge.rs` and `WinUiBridge.h`.
A missing or incompatible version is a startup error with a rebuild instruction;
an old DLL must not silently run against a new Rust host.

Requests use UTF-8 JSON with `id` and `op`, bounded to 16 KiB. The common DTO
parses history/navigation fields and retains the full payload for the existing
queue and tag parsers. Do not drop their `hashes`, `name`, reorder or assignment
fields while changing the common envelope. Unknown operations retain an explicit
error response. Results are bounded to 4 MiB and preserve `id`/`op` when replacing
oversized data with a recoverable error. Native bytes are copied before callback
return; asynchronous work never retains a borrowed FFI buffer.

Rust owns history, configuration, queries, capture, paste, files, OCR, queue and
tag rules. WinUI owns native controls, focus/geometry, interaction drafts and
presentation. Windows-only helpers must not be moved into shared business code
merely to reuse UI types. Keep the existing request IDs, query/reader generations
and queue revisions authoritative over late responses.

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
from the same spring parameters as React. Native items still own hover, press,
keyboard focus and selection semantics. Scrolling and layout changes realign the
underline; contrast mode and disabled Windows animations settle it immediately.
The main dock, preview geometry and active drag retain their separate owners.
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
| Header actions | Circular surfaces, in order: developer tools, queue, settings, conditional update. `CommandBar` keeps native keyboard navigation and overflow; developer actions use a native menu. |
| Categories and tags | `SelectorBar` in a horizontal `ScrollViewer`; add follows the final tab. Tag/filter editors open above their anchor using unconstrained native `Flyout`. |
| Cards | `ListView` with horizontal `ItemsStackPanel`; details are loaded for realized containers. One 14-DIP rounded outline covers selection and keyboard focus without resizing content; contrast themes keep system focus and selection visuals. |
| Menus and confirmations | Native `MenuFlyout`, `ComboBox` and `ContentDialog` retain their templates, dismissal, keyboard behavior and default shadows. Do not add a second shadow behind them. |
| Elevation | DWM owns the dock, queue and reader window shadows. `WinUiAppearance.h` owns small inline `ThemeShadow` elevations for cards, header, tag chips and toolbar controls; contrast mode removes decorative shadows. |
| Auto-hide | External deactivation schedules a delayed recheck. Reopening, internal focus, editors, dialogs, drag, preview pinning and existing hide suppression protect the panel from stale blur events. |
| Queue | The existing Rust queue remains authoritative; the separate non-activating native window keeps paste focus on the target app. Its toolbar toggle and multi-selection actions remain separate. |
| Settings | The existing WebView settings page remains in use and is destroyed on close. It is not part of this native UI migration. |
| First run | A temporary `/native-onboarding` auxiliary page reuses the shipping tutorial without mounting the main clipboard WebView. It retains saved filters, completion and the configured shortcut; completion or cancellation destroys the page. Cancellation does not mark onboarding complete. |

The shell parity regression runs real controls on the WinUI STA with synthetic
records and no user database. Native rendering snapshots cannot prove DWM
shadows, acrylic, IME composition or external-app focus transitions; verify
those on an interactive Windows desktop, including mixed DPI. Keep visual
checks local and do not add hosted screenshot jobs for this workstream.

The header remains 48 DIPs high with 28-DIP circular actions and explicit 16-DIP
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

## Auxiliary renderer lifecycle

Native Text/Image/Link readers remain native where supported. HTML, PDF and OCR
can create the shared auxiliary reader without creating the main WebView.
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
notices in `runtime/`; the build also writes `SHA256SUMS.txt`. If the 2.6 runtime
is missing, run the included `Install-WinUiRuntime.ps1` once. It checks package
identity/version and uses `Add-AppxPackage` for the current user, without
downloading, forcing other applications to close or bypassing enterprise
policies. `-WhatIf` checks the proposed installation without changing the system.
The bootstrap reports this installation step when runtime initialization fails.

The current SDK's runtime manifest requires Windows 10 **1809 / build 17763** or
newer; do not infer 1709 support from older framework documentation. Windows 11
materials may fall back on Windows 10. WebView2 Evergreen is still required for
settings and rich auxiliary pages; it must already be installed on an offline
machine. The WinUI archive does not install WebView2 or replace the existing
formal release workflow. Testing this package is not publication authorization.

## Resource measurement

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
It exercises visible reuse, pin protection, canceled cold creation, reopening,
settings recreation and guide release. It neither starts nor stops vPaste and
does not substitute for physical keyboard, external-app focus or DPI checks.
