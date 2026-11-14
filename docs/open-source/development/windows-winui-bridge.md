# Windows WinUI bridge ownership

This bridge belongs to the opt-in Windows native UI. It is compiled only with
Windows, Debug assertions and `winui-debug`; it is not a public Tauri command or
a format stored in user configuration. macOS keeps its independent Swift UI.

## Initialization and messages

Rust loads the adjacent DLL and checks `vpaste_winui_protocol_version` before
initialization. Version 1 is defined by `winui_panel/bridge.rs` and `WinUiBridge.h`.
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

## UI and motion

`WinUiAppearance.h` owns native styles, live theme resources and control sizes.
`WinUiMotion.h` reads the embedded `src/ui/motion/tokens.json`, also consumed by
React and Rust. Built-in menus, dialogs and controls retain WinUI's transitions.
App-authored feedback affects opacity only and honors Windows animation settings.
The main dock, preview geometry and active drag retain their separate owners.
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

The shell parity regression runs real controls on the WinUI STA with synthetic
records and no user database. Native rendering snapshots cannot prove DWM
shadows, acrylic, IME composition or external-app focus transitions; verify
those on an interactive Windows desktop, including mixed DPI. Keep visual
checks local and do not add hosted screenshot jobs for this workstream.

## Resource measurement

The Debug-only memory-profile path initializes the selected native renderer
before requesting its first show. It must not create the main WebView as a
fallback for a WinUI measurement. The existing explicitly marked temporary
fixture supplies synthetic records; ordinary user history is never the fixture.
With `custom-protocol` enabled (including `winui-debug`), profile WebViews use
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
change. Check the ordinary Windows build without `winui-debug` and inspect the
macOS/source diff. Shared Rust changes need tests for both consumers; browser
platform mocks cannot establish a native macOS runtime pass.
