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
