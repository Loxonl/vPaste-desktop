# macOS DEV native main-panel experiment

## Entry and acceptance criteria

By default the React main window remains the app's main window. On macOS, start a
Debug build with `npm run dev:debug` and click **Native panel / 原生主界面** in the
main window's DEV toolbar. The existing native-controls demo has a separate entry.

To use the native panel for every main-window wake in that DEV process:

```sh
sudo npm run dev:debug -- --main-ui=native
sudo npm run dev:debug -- --main-ui=webview
```

`--main-ui native` and `--main-ui webview` are accepted too. The launcher also
reads `npm_config_main_ui` when npm consumes an option before the `--` separator;
explicit script arguments take priority. It prints the chosen interface and app
arguments before launch, including when an existing instance blocks startup.
To change backends, stop the existing `dev:debug` command and restart it: the
current Tauri runner keeps its arguments across Rust rebuilds. Omission defaults
to WebView. Invalid/missing/duplicate values and unsupported native selections fail
before startup. Native requires macOS, Debug and `--dev-mode`; the option is never
saved to user configuration.

In native mode there is no `clipboard` WebView at startup, while collapsed or on
repeated wake. A guard in its builder rejects accidental creation. Native startup
readiness needs no frontend acknowledgement and does not prewarm a preview
WebView. The macOS clipboard listener owns an AppHandle instead of a window; the
single existing watcher, OCR worker and cleanup services keep their Rust paths.
Startup, the main shortcut, tray's main-panel action, second-instance activation
and macOS reopen select the same backend. Existing auxiliary pages are created
only on explicit use. Settings, paste fallback and return-from-preview/editor no
longer need a main WebView. The size slider previews an AppKit panel without
activating it or taking keyboard/mouse focus from Settings.

First-run native startup directly shows the native list. It does not run the
WebView tutorial or mark onboarding complete; switching back to WebView preserves
that tutorial state. The existing tutorial itself still requires WebView mode.

| Requirement | Implementation |
| --- | --- |
| macOS DEV only | Frontend DEV/platform gate, Rust Debug + `--dev-mode` guard, and macOS Debug-only Swift compilation |
| Keep the current default interface | With no option or `--main-ui=webview`, preserve the existing main window, routing and show/hide; only explicit macOS DEV native mode reroutes wakes |
| Use real history | Share the existing Rust database, history query service, thumbnails and original-format actions |
| Isolate the two readers | One bounded query per owner, with separate request generations; opening/closing either owner preserves the other |
| Recycle data and media | Viewport-sized AppKit items and card payloads, bounded metadata pages, 16 MiB/48-entry decoded-image cache, close-time cancellation and cleanup |
| Make the experiment usable | Native search/IME, type/favorite filters, horizontal paging, image/GIF/rich-text cards, keyboard navigation and context actions |
| Hide scrollbars while preserving browsing | No horizontal/vertical scrollers; the dominant wheel axis browses the horizontal row, including mostly vertical trackpad input with X noise |
| Match the current main panel position | Copy the live main NSWindow frame on the AppKit thread, including the screen bottom and horizontal bleed; fall back to full-screen bounds and shared Rust dimensions |
| Match show/hide behavior | Use the shared 150/200 ms durations and easing values, pre-position content before ordering front, animate one glass/content layer, and finish immediately with Reduce Motion |
| Keep the host fixed | Borderless, nonmovable panel with no background dragging or AppKit default ordering animation; retain clipboard-item dragging |

## Ownership and lifecycle

`src-tauri/native-panel/` implements an AppKit `NSPanel`, `NSCollectionView` and
TextKit cards in Swift. It creates no WebView. The panel activates only after the
explicit DEV action or the process-local native-mode selection. It appears above
the current main window in side-by-side mode, closes on Escape or loss of key
focus, and can be opened repeatedly. It uses the current panel scale,
show/hide timing curves, theme and mouse-paste preference. macOS Reduce Motion
skips the content slide. The host frame matches the current main window rather
than the screen's Dock-excluding visible frame. It remains fixed throughout both
transitions. The window is borderless and cannot be dragged; clipboard-item drag
sessions remain available.

The glass/content child uses the same explicit Core Animation position transition
as the current main panel. Opening starts below the clipped host before it becomes
visible. Closing during an opening uses the current presentation position, and
transition generations discard superseded completion callbacks. Repeated close
requests do not restart a hide. Opening Settings, preview, the editor or OCR waits
asynchronously for close completion; paste starts the hide concurrently with the
existing focus/paste path so it does not acquire an extra animation delay.

On macOS 26+, when built with a macOS 26+ SDK, the background is one native
`NSGlassEffectView` using the clear Liquid Glass style. Controls are embedded
through its documented `contentView`; the glass and content slide together. The
window remains transparent and the system handles appearance/accessibility
preferences. Earlier systems or SDKs retain the `NSVisualEffectView` frosted-glass
background. This does not raise the deployment target or change the existing main
WebView. No additional per-card glass layers are created.

`src-tauri/src/native_panel/` exposes a small, versioned C callback table with
borrowed byte buffers. Both sides copy buffers before returning. Queries and
resource/action work execute in Rust workers; AppKit creation and delivery run on
the main thread. Session and query generations discard stale work.

The existing main reader retains its existing singleton query behavior within the
`Main` owner. The experiment has a separate `NativeExperiment` owner. Closing it
invalidates its pending opens, drops its query, unregisters its four event
listeners, clears Swift callbacks/data/image caches and stops GIF/hover timers.
There is no second clipboard watcher or always-on polling loop.

The collection layout supplies only attributes near the requested rectangle.
Its explicit horizontal flow direction keeps AppKit's scroll extent consistent
with the virtual content width. Card projections cover the viewport plus two
items on either side. Metadata pages are retained around that viewport, with the
existing Rust page/byte budgets also enforced. A drag can temporarily retain its
source card until the drag ends. History and filter scroll views show no
scrollbars, including after AppKit attaches a horizontal collection document.
Both horizontal and vertical wheel/trackpad input browse the row using the
dominant axis; precise input keeps pixel deltas and momentum events, mouse-wheel
notches retain their existing multiplier, and offsets stop at the row boundaries.
Keyboard navigation remains available.

Images use Rust's existing disk-thumbnail resolver and ImageIO file URLs. No
image base64 travels over the bridge. Selected visible GIFs decode one frame at
a time. Rich-text display uses bounded attributed runs, basic styles, tables and
local image attachments; it does not invoke an HTML WebView/importer. Full
original MIME data remains in Rust and is requested only for explicit actions.

Copy/paste reuse the original Rust paths, including accessibility fallback and
focus restoration. Preview, edit and OCR reuse the existing auxiliary windows;
the experimental panel closes before those windows appear. Favorite/delete
changes affect the shared history and notify the existing main reader. Delete
requires confirmation in the native UI.

## Native appearance matching the main interface

The page keeps Clear Liquid Glass and existing card alpha. A theme-aware tint
above the glass makes the content background less transparent: 30% opacity in
light appearance and 36% in dark appearance. The 48-point toolbar retains its
denser gradient (light: 90% to 82%; dark: 92% to 86%) and thin bottom edge. The
content background therefore stays more translucent than the toolbar. The tint
also applies to the older-system frosted-glass fallback and redraws on appearance
changes; window motion, geometry and card alpha are preserved. These values
belong to the native experiment; React's shared tokens and the existing main
WebView are unchanged.

The native style mirrors the main panel's 220 × 230 cards, 16-point gaps,
24-point side insets, 14-point corners, 48-point card headers, 13/11-point
header typography, external selection outline, ordinary shadows, Rich/GIF pills,
source-icon crop, favorite/tag badges and image metadata capsules. Small images
respect their original dimensions instead of upscaling generated thumbnails.
Rich preview canvas defaults remain independent of the application theme, while
copied colors and the original data/actions remain preserved.

Search starts as a circular button and expands into a field on click or Cmd+F.
The icon/category tabs have a bottom selection indicator, hover/focus states and
keyboard navigation. Tabs scroll horizontally if space is limited; the expanded
search width also adapts. Refresh, native diagnostics, Settings and Close have
named circular controls. Settings opens the existing settings window. Link,
file and color cards have type-specific presentation rather than raw text paths.
The native file preview uses bounded vector/symbol presentation for common types;
it does not load the frontend's complete SVG icon registry.

The always-visible diagnostic footer is replaced by an expandable bar under the
info button. It remains available, and action/error feedback opens it when
needed. The normal browsing layout therefore has the same card height as the
main interface. Loading/no-results states remain visible with diagnostics closed.
No new viewport animation is introduced; existing native show/hide and Reduce
Motion behavior continue to own the window content movement.

## SwiftUI toolbar integration

The macOS DEV native panel now uses SwiftUI on macOS 12 and later for the
48-point toolbar, circular action buttons, developer badge and seven category
filters. The badge reads **DEV · SwiftUI** so the active implementation is
visible. `NSHostingView` embeds real SwiftUI `Button`, `Image`, `Text` and layout
views inside the existing AppKit panel. `ObservableObject` owns only small
selection/search/diagnostic state; history pages, cards and decoded images do
not enter the SwiftUI model.

| Acceptance criterion | Implementation |
| --- | --- |
| Introduce real SwiftUI controls in the native main panel | `PanelSwiftUIToolbarHost` hosts the toolbar; the filter scroll document hosts `PanelFilterStrip` |
| Keep the current layout and actions | Preserve the toolbar height, gradient density, circular controls, underlined filters, filter indices and existing Rust callbacks |
| Preserve search and input-method composition | Bridge the same `NSSearchField` through `NSViewRepresentable`; retain controller delegates, marked-text checks and debounced queries |
| Keep main commands usable across focus changes | Route Cmd+F/Cmd+R from toolbar/window focus; leave text-copy, cursor movement and composition Escape with the search editor |
| Preserve list virtualization, window motion and glass | Keep `NSCollectionView`, `PanelScroll`, the fixed `NSPanel`, existing Core Animation transitions and backdrop |
| Release the hosted view on close | Clear callbacks, invalidate delayed search-focus requests, detach the hosting view and clear the search delegate |
| Keep existing platform and deployment support | Compile only in macOS Debug; macOS 11 retains `PanelLegacyToolbar` because SwiftUI focus APIs require macOS 12 |

Manual AppKit drawing of toolbar controls is replaced only on the SwiftUI path.
The old implementation remains in `NativePanelAppKitToolbar.swift` for macOS 11.
The history list and individual cards continue to use AppKit; this change does
not migrate them to a SwiftUI `ScrollView` or change resource budgets. There is
no new toolbar animation, third-party dependency, deployment-target increase or
main WebView. The same native-mode launch command applies; Swift source changes
require a native rebuild rather than frontend hot reload.

## Experimental limits

- The native header has fixed type/favorite filters. Custom-tab management, tag
  editing and the rest of the settings UI continue in the existing interface.
- Native rich-text preview supports a bounded subset of HTML styling. It does not
  reproduce arbitrary CSS, nested layout, or merged table-cell geometry. Display
  is limited to 16,384 characters / 512 attributed runs and 24 × 12 table cells;
  original copy/paste formats and full-content auxiliary previews are preserved.
- The footer reports retained card payloads and this panel's decoded-image cache,
  not process resident memory or physical footprint. AppKit allocations live in
  the Rust host process. The original main WebView remains alive in the default
  side-by-side experiment; `--main-ui=native` skips it. Neither path is a measured
  memory-reduction result
  without separate profiling.
- Swift sources and the Rust native-panel module are absent from Release and
  Windows builds. The release command stub rejects attempts to invoke the panel.

## Isolated interactive verification

The existing memory fixture can be used without the user's history or clipboard
watcher. Create a new directory whose name starts with `vpaste-memory-`, containing
only `.vpaste-memory-profile` with `vpaste-memory-v1` followed by a newline. Run:

```sh
src-tauri/target/debug/vPaste --dev-mode --memory-profile-dir /private/tmp/vpaste-memory-example --memory-profile-prepare
VPASTE_MEMORY_PROFILE_PORT=19141 src-tauri/target/debug/vPaste --dev-mode --memory-profile-dir /private/tmp/vpaste-memory-example --native-panel-check
```

Serve the frontend at that loopback port with `npm run dev -- --host 127.0.0.1
--port 19141`. The native-check flag enables interaction with the existing fixture
window and disables its automatic scrolling driver. The DEV button still uses
the same command/Swift/history path as normal development. Scalar native geometry
and close-time counters are logged only with this flag; history text is not logged.

Verification for this change uses macOS compilation/type/style checks and manual
interaction with the real Tauri/AppKit bridge. Focused coverage for the toolbar
platform gate, history-owner isolation and bounded rich-text conversion is added
for future execution. `tests/native-panel/NativePanelWindowBehaviorTests.swift`
also covers wheel axes/units/bounds, scrollbar-free collection attachment,
immovable docking, and normal/reduced-motion content transitions. These Swift
cases are typechecked alongside the production sources using the Xcode XCTest
Swift overlay; they are not executed in this workflow. Regression suites are
intentionally not run, per request.

### Window-behavior follow-up: local results

- macOS Debug compilation and Swift typechecking passed, including the glass-SDK
  build and the older-SDK fallback branch. The focused XCTest source was
  typechecked with the production Swift sources, without running a test suite.
- The real DEV-button path produced a host frame of `{{-12, 0}, {1944, 302}}`,
  exactly matching the existing main NSWindow. Mid-transition logs retained that
  host frame while the glass/content layer moved; show/hide used 150/200 ms.
- AppKit and accessibility reported no scrollers after collection layout.
  Vertical down/up gestures moved the horizontal viewport from zero into the row
  and back to zero. Horizontal wheel input remained usable, with no bottom bar.
- Dragging a blank toolbar area left the host frame unchanged. The existing item
  drag implementation was preserved; this follow-up did not repeat drag export.
- Opening Settings waited for the native hide to complete. Close counters reported
  zero retained cards, metadata pages, decoded bytes, native history views and
  event listeners. The existing settings window then appeared successfully.
- Actual interaction used one attached display. The Reduce Motion cases were
  typechecked but not executed; the user's system accessibility settings were
  not changed. Regression suites were not run.

### Acceptance criteria for process-local backend selection

| Criterion | Changed mechanism |
| --- | --- |
| `npm run dev:debug -- --main-ui=native` reaches Rust with the choice | Shared launcher option parser canonicalizes both argument forms; platform validation runs before launching |
| Omission and explicit `webview` preserve the existing route | Process-local Rust selection defaults to WebView; Windows/release native requests are rejected |
| Native starts/wakes without a main renderer | Skip the main builder and frontend readiness/prewarm; central show/toggle routes use AppKit; the builder rejects native-mode calls |
| Capture does not need a window | macOS listener emits through AppHandle with the same capture/retry/queue logic |
| Auxiliary actions do not manufacture a hidden main window | Optional source for settings, target-screen fallback notices, native return focus and AppKit size previews |
| Configuration still applies | Native wake reads Rust language/theme settings and the target display's configured/recommended size |

Launcher/parser, Swift focus and existing source coverage are kept for future
execution. Local checks compile/typecheck and exercise the real isolated runtime;
regression suites remain disabled by request.

### Backend-selection local results

- Native-only startup and repeated app activation used the real Swift/history
  bridge with `nativeDefault=true webviews=[]` in the isolated runtime log.
- Opening Settings succeeded with no main WebView. Holding/releasing its panel
  height slider created and disposed an AppKit preview; the window inventory was
  only `["config"]`. Closing Settings and reopening the native panel restored an
  empty WebView inventory in the same process.
- Last-auxiliary-window close requests keep native background services alive;
  explicit Quit/restart requests still proceed. Coverage includes both cases.
- Debug build, Release check, Rust test-code compilation, Node syntax checks and
  Swift/XCTest typechecking passed. The Rust clipboard watcher was verified by
  compilation and path review; the isolated fixture does not start a live watcher.
  Regression suites were not executed. Windows native mode is intentionally
  rejected; Windows behavior was reviewed but not run on this Mac.

### npm argument forwarding follow-up

The reported shortcut mismatch had a running Tauri child with
`--dev-mode --main-ui=webview`; its launcher had no script arguments. A controlled
npm reproduction showed that `npm run dev:debug --main-ui=native` supplies an
empty argv and `npm_config_main_ui=native`, whereas the documented separator form
supplies `--main-ui=native` in argv. The launcher now accepts both transports,
validates npm values, keeps explicit argv precedence and prints the selected
backend. Tests covering these cases are added without running the regression
suite. No main-window routing or shortcut behavior is weakened by this change.

The forwarding follow-up was checked through isolated npm invocations of the
actual launcher (with only the Tauri executable and process precheck replaced
by local stubs). Both npm argument forms forwarded
`["dev", "--", "--", "--dev-mode", "--main-ui=native"]`; omission kept WebView and
explicit script argv overrode npm configuration. Node syntax and diff whitespace
checks passed; regression suites were not run. A targeted-input attempt in the
isolated GUI did not conclusively verify the OS global-hotkey event, so it is not
counted as a passing shortcut interaction check.

After restarting the real developer runner, its Tauri child and application both
carried `--main-ui=native`. The user then confirmed that their normal main-panel
shortcut opened the native interface. This is the manual shortcut confirmation
for the reported issue, separate from the inconclusive targeted-input attempt.

### SwiftUI toolbar local results

- macOS Debug build and Release check passed. Production Swift and both focused
  XCTest sources typechecked against the macOS 11 deployment target; the
  regression suites were not run.
- The actual isolated Tauri process reported `toolbar=SwiftUI` and
  `nativeDefault=true webviews=[]`. Light English and dark Chinese toolbars were
  inspected in the real window; category selection, underline, labels and
  circular actions rendered correctly. macOS 11 fallback was reviewed and
  compiled but was not run on a macOS 11 host.
- Image filtering, expanded/collapsed search, an ASCII search producing no
  matching history, clearing search, refresh preserving the selected filter,
  opening diagnostics and opening Settings all used the real Rust bridge.
  Repeated Cmd+F after closing an empty search correctly restored field focus.
  Chinese labels were checked; input-method composition was preserved by the
  unchanged native editor path, not manually exercised by the automation.
- Closing through the SwiftUI button retained the fixed host and existing
  200 ms slide. Close logs reported `cards=0 pages=0 decodedBytes=0`,
  `nativeViews=0 listeners=0`. No SwiftUI state-publication or constraint errors
  appeared in the checked runtime logs.
- `NativePanelToolbarTests.swift` adds coverage for renderer selection, category
  mapping/wraparound, nonempty search retention, callback cleanup and keyboard
  routing across toolbar/editor focus. Coverage was typechecked, not executed.
  No process-memory reduction is claimed from this integration.
