# DEV memory monitor

Run `npm run dev:debug`, then select the chip icon between the flask and grid
icons in the DEV toolbar. It opens a separate, resizable memory monitor that
stays above other application windows. Selecting the button again focuses the
existing monitor. Switching focus leaves it open and keeps the main clipboard
window visible when the monitor is active. DEV language and theme previews
also update the monitor.

The first opening starts native sampling once per second. Closing the monitor
destroys its window and WebView; sampling continues until **Background sampling**
is turned off. Reopening creates a new window and reads the existing history.
The monitor's own renderer is included in the report. History is limited to 61
samples within the latest 60 seconds.

The dialog supports immediate refresh, selecting an older sample and setting a
baseline. The baseline delta is unavailable when either sample is partial.
No monitoring data is written to the application database or configuration.

## Reading the counters

- Totals cover identified related processes and count each PID once. Resident
  memory can include shared pages and is not exclusive per-window physical RAM.
- macOS shows resident bytes and `proc_pid_rusage` physical footprint. Window
  attribution uses each WKWebView's main renderer PID; separate subframe
  processes may be omitted. Identified shared GPU and network processes have
  their own rows.
- Windows shows working set and private committed bytes. WebView2 extended
  process/frame information maps renderers, including child frames, to windows.
  Old runtimes that lack these interfaces report unavailable mappings.
- A process identified before a window closes remains visible while it lives.
  Process creation identity prevents a recycled PID inheriting old attribution.
  Missing counters display an em dash and mark the total partial.
- macOS footprint and Windows private committed bytes have different meanings;
  do not treat them as directly comparable platform measurements.

## Release boundary

The native collector module is guarded by `debug_assertions`; commands also
require `--dev-mode`. Private WebKit PID selectors are absent from release
compilation. The React window is imported only under `import.meta.env.DEV` and
is excluded from the production JavaScript bundle.

## Local verification

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --bin vPaste dev_memory::
cargo run --locked --manifest-path src-tauri/Cargo.toml --example dev_memory_probe
npm run check:styles
npm run check:ui
```

The Debug-only native probe uses temporary pages in an isolated Tauri runtime.
It verifies PID/counter discovery, monitor reuse, visibility after another window
takes focus, native topmost level, inclusion of the monitor's own renderer,
auxiliary destruction and recreation, hidden-window background sampling and
stopping. It also immediately reopens a closing
window and checks that a delayed close on the old instance leaves the new one
alive. It does not initialize the clipboard
monitor, history database or application configuration.

For manual review, open the monitor, set a baseline, close it, open and
close an auxiliary window, and reopen the monitor. Inspect previous samples
and retained processes; WebKit can cache resources after a window is destroyed.
Check a shared renderer is listed once and that stopping sampling freezes its
timestamp. Windows still requires a native Windows runtime smoke check.

## Auxiliary lifecycle

Auxiliary windows use destruction and lazy recreation, except that one blank
preview page is prewarmed after the main page is ready. Closing the preview
clears its content/state and hides it, retaining its WebView until app exit.
Warmup does not load clipboard content, media or websites. Account for this
resident renderer when reviewing memory; there is no idle-release timer.
The main clipboard window keeps its own presentation lifecycle; the text
editor still confirms dirty drafts before closing. Cold openings wait for their
new page's listeners before sending payloads.

Tauri queues `destroy()`. A resource on each native window marks it Open,
Closing or Closed, and recreation waits for `Destroyed` before reusing its label.
Queued paste-queue activation records pending toggle intent so a second press
can cancel a cold opening. Stale requests cannot close a newer pending or active
instance. Transient auxiliary UI state is reset when its window is recreated.

## Validation recorded on macOS

The results below were recorded before the later native resource migration and
upstream preview-continuity integration. Regression suites were not rerun for
the final PR tree, as requested by the user. Final-tree verification is limited
to the build, style and native compile checks recorded in the PR.

- Rust: 294 tests passed, including native counter reads, partial discovery,
  shared/retained PIDs, identity reuse, queued toggles, close barriers and
  preview focus handling during and after its opening grace period.
- Frontend: 539 unit tests passed; styles and production build passed.
- Memory window: normal and reduced-motion browser interaction checks passed;
  separate-window opening, table scrolling, baseline, refresh, stop, Escape,
  persistence after focus changes, and language/theme preview sync were checked.
- Native Tauri probe: collection, destruction/recreation, immediate reopening,
  stale handles, monitor reuse/self-accounting and hidden-window sampling/start/stop
  passed. The monitor stayed visible after another window took focus, with
  macOS native window level 103 above existing vPaste popups at levels 101/102.
- Release boundary: compiling the Rust root with Debug assertions disabled
  produced LLVM IR without the private PID selectors; production JS contained
  no memory collection/opening commands or monitor route.
- The Windows collector passed an isolated type check against its exact COM
  bindings. A full Windows cross-build requires the Windows C SDK, unavailable
  on this host; Windows runtime validation remains outstanding.
- The full visual suite is not green: macOS screenshot baselines are missing,
  and existing undo/geometry/pixel checks fail on the unchanged HEAD as well.
  Generated missing baselines were removed rather than accepted automatically.
