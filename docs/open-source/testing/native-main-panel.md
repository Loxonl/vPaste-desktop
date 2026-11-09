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
the current main window in side-by-side mode, closes on Escape or external
focus loss under the shared main/preview rules, and can be opened repeatedly. It uses the current panel scale,
show/hide timing curves, theme and mouse-paste preference. macOS Reduce Motion
skips the content slide. The host frame matches the current main window rather
than the screen's Dock-excluding visible frame. It remains fixed throughout both
transitions. The window is borderless and cannot be dragged; clipboard-item drag
sessions remain available.

The glass/content child uses the same explicit Core Animation position transition
as the current main panel. Opening starts below the clipped host before it becomes
visible. Closing during an opening uses the current presentation position, and
transition generations discard superseded completion callbacks. Repeated close
requests do not restart a hide. Opening Settings, the editor or OCR waits
asynchronously for close completion; ordinary item preview keeps the native main
panel alive. Paste starts the hide concurrently with the existing focus/paste
path so it does not acquire an extra animation delay.

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
edit and OCR close the experimental panel before appearing. Ordinary preview
shares focus/selection with the still-visible native panel. Favorite/delete
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
The icon/category tabs retain their bottom selection indicator and pointer hover
states. Toolbar buttons do not participate in Tab/Shift+Tab focus or show focus
rings; they use mouse actions and explicit shortcuts. The native search editor
remains focusable, and list keyboard navigation remains available. Tabs scroll
horizontally if space is limited; the expanded search width also adapts. Refresh, native diagnostics, Settings and Close have
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
| Keep existing platform and deployment support | Compile only in macOS Debug; macOS 11 retains `PanelLegacyToolbar`; the SwiftUI renderer uses macOS 12+ APIs |

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
  mapping/close guards, nonempty search retention, callback cleanup and keyboard
  routing across toolbar/editor focus. Coverage was typechecked, not executed.
  No process-memory reduction is claimed from this integration.

### Rounded-card content follow-up

Native card content now clips through one flipped inner view with the same
14-point radius as the WebView card, scaled by the active panel size. This
replaces the source-icon-only shape mask and clips images, source icons, labels
and tags together. The outer card remains unclipped so its existing selection
outline and shadow retain their appearance. Card dimensions, alpha and actions
are unchanged.

The macOS Debug build and production/Swift XCTest typechecking passed. Focused
coverage checks the rounded content boundary at 80%, 90% and 100% sizes while
preserving the outer outline/shadow; these cases were not executed. Actual
isolated native-window inspection with opaque synthetic source icons confirmed
rounded image-card corners and the complete selection outline. Regression suites
were not run.

### Toolbar focus follow-up

Toolbar action/category buttons no longer accept keyboard focus on either the
SwiftUI path or the macOS 11 AppKit fallback. SwiftUI buttons explicitly disable
focus, both hosting surfaces stay out of the AppKit key-view loop, and custom
focus outlines plus per-button arrow-key traversal are removed. Category
selection underlines, pointer hover, accessibility button labels, mouse actions,
window shortcuts and native search editing remain available.

The macOS Debug build and Swift/XCTest typechecking passed. In the actual
isolated native window, ten forward Tabs and ten Shift+Tabs kept focus on the
history collection without focusing toolbar buttons. Mouse category selection,
refresh, Cmd+F, search text entry and clearing search also worked. The final
window was inspected with no toolbar focus rectangle. Focused responder coverage
was added and typechecked; regression suites were not executed. The AppKit
fallback was reviewed/compiled but not run on a macOS 11 host.

### Toolbar typography follow-up

The native toolbar now mirrors `Clipboard.module.css` typography: 14.5-point
category labels in an 18-point line box, CSS weights 590/740 for ordinary/selected
labels, 13-point / 450 search text and 9-point / 800 developer text. CoreText
variable-font weights avoid AppKit's named-weight quantization. The DEV prefix
uses the WebView badge's 0.08em tracking while the full native renderer label
remains visible in the existing developer capsule.

Type labels render their emoji and text together at the same font size, instead
of enlarging the emoji independently. Fixed/type tab widths use the same minimums,
maximum, icon/gap and horizontal padding as WebView and include the selected font's
actual width. SF Symbol artwork is sized to match MUI's visible SVG artwork within
the same icon/control boxes. These measurements scale with the existing panel
size; window geometry, toolbar height, card appearance and the no-Tab-focus policy
remain unchanged. The macOS 11 toolbar uses the shared font and width metrics.

The macOS Debug build and Swift/XCTest typechecking passed. The actual WebView
and native Chinese toolbars were compared using the same isolated synthetic
history, display and scale; category text, emoji and complete DEV label were
inspected. CoreText font lookup/variation measurements confirmed the local system
font and exact 590/740 weight axes. Focused size/weight/width coverage includes
English and Chinese labels at 80%, 90% and 100%; coverage was typechecked, not run.
Regression suites were not executed. The macOS 11 fallback was compiled/reviewed,
not run on a macOS 11 host.


### Native main/preview continuity follow-up

Acceptance criteria and implementation:

| Criterion | Implementation |
| --- | --- |
| Space opens/toggles preview without hiding or recreating the main panel | Remove the ordinary-preview `close_for_action` call; use the existing preview preparation/commit pipeline and focus the live native controller on return |
| Moving focus between main and preview preserves both; external focus loss follows WebView rules | Share the existing blur decisions and cursor focus watcher with the native surface; observe both native key-window and application activation notifications; preserve pinned readers |
| Hover obeys the current setting and interaction policy | Pass `hover_preview_enabled` into Swift; use cancellable 500 ms open / 250 ms leave delays, retain while the pointer is in preview, and cancel on input/filter/search/close; the backend rechecks the setting and mode policy |
| Preview stays outside the main panel on the target display | Publish the actual screen-relative native frame, use the area above it with the existing 16-point gap, and fit the preview to that area on small screens |
| Selection updates preserve direction, motion and rapid-navigation correctness | Route preview keyboard/pointer events through Rust to the active main backend, reuse existing window geometry interpolation and React Motion transitions/Reduce Motion, and discard stale native requests before rendering |
| Closing releases native-only work | Cancel timers, remove application observers and bridge callbacks, invalidate requests, and close unpinned previews when their native owner closes |

The removed mechanisms are ordinary preview's close-before-open path, unconditional
native dismissal when focus moves to preview, and direct preview-to-`clipboard`
event delivery that assumed a WebView main window existed. Settings/editor/OCR
close-before-open behavior stays in place. The existing WebView command signature
and event payloads remain compatible; the new transport commands fall back to the
same WebView events on Windows, Release and ordinary WebView mode. No new preview
renderer or independent animation system is introduced.

Local verification used a separate app bundle and the existing marked synthetic
history profile, without a clipboard watcher. Space opened a real preview with
`visible=true mainKey=true`; repeated Space toggled only preview. Rapid Right-key
navigation reached text, image and GIF previews without recreating the main
controller. Runtime geometry changed from 760 × 560 to 792 × 492 and 420 × 374,
with `animated=true` for size changes and every preview above the main frame at
screen Y=778. Initial native startup still reported `nativeDefault=true webviews=[]`.

Rust all-target compilation, Debug build, Release check, TypeScript checking,
UI style governance and production/Swift XCTest typechecking passed. Coverage
was added before implementation for preview transport, hover delays/configuration,
stale-work cancellation, app-focus observer cleanup and scaled/negative-screen
geometry. Per the requested workflow, regression suites were not executed.
The checked host used normal motion. Reduced Motion and multi-display branches
were reviewed/compiled, not manually exercised. The automation does not expose a
pointer-move operation, so hover entry/transfer and the complete external-click
sequence are not claimed as completed manual checks; their event paths and cleanup
are implemented and covered for future execution. Windows received source review
of the existing-event fallback and was not run on this macOS host.


### Native pointer affordance follow-up

Acceptance criteria: actionable SwiftUI and AppKit toolbar buttons use the
pointing-hand cursor inside their bounds only; draggable cards use the open hand
and switch to the closed hand after the existing drag threshold; release/exit and
window cleanup restore the appropriate cursor. Search remains a text-input
surface, toolbar gaps remain ordinary pointer areas, and native drag copy/forbidden
feedback remains owned by AppKit. Cursor registration must not intercept button
clicks, add Tab focus or alter window motion/geometry.

SwiftUI button styles install non-intercepting AppKit cursor regions; the macOS
11 button subclasses use the same pointing-hand affordance through native cursor
rectangles. Cards register open-hand rectangles, show the closed hand only after
the existing 5-point threshold, and restore on release/cancel/end. No cursor
push/pop stack or additional hover timer is introduced. Native drag operation
masks, button actions, keyboard focus and search editing remain unchanged.

The macOS Debug build and production/Swift XCTest typechecking passed. Focused
coverage checks enabled/disabled cursor regions without intercepting clicks, and
that crossing the drag threshold changes the hand while release restores it and
does not also activate paste. The coverage was compiled, not executed; regression
suites were not run. System cursor appearance was not manually inspected.


### Keep Liquid Glass stable during preview focus handoff

Acceptance criteria: entering an item or webpage preview must preserve the native
panel's active glass appearance while the preview retains keyboard focus; glass
style, content tint, alpha, frame, and animation stay unchanged. Hidden/closing
panels, Settings size previews, other app windows, WebView main mode, Windows and
Release must retain their existing focus behavior. AppKit's main-window role and
key-window role must remain separate rather than forcing keyboard focus back.

The focus watcher intentionally transfers keyboard focus to an ordinary or pinned
preview. Tao 0.37.1 implements both `canBecomeKeyWindow` and `canBecomeMainWindow`
using the same focusable flag, so that standard preview window can also replace
the native panel as AppKit's main window. The panel then has neither active role.
The fixed content tint was not being changed: Liquid Glass was adopting AppKit's
inactive-window appearance. Unlike the frosted fallback's explicit `.active`
state, the selected SDK's `NSGlassEffectView` exposes no active-state property.

AppKit documents separate main and key roles in its
[Window Programming Guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/WinPanel/Concepts/ChangingMainKeyWindow.html).
The fix sends the actual item/webpage preview window number through the existing
macOS DEV bridge when it gains focus. Swift waits until the native focus event
unwinds, confirms that exact window still owns keyboard focus, and calls the
public `makeMain()` on the visible native panel without making it key or ordering
it front. Main-role notifications cover repeated clicks on an already-key
preview. Known preview windows are weakly referenced; the observer is removed on
panel close. Inactive apps, hidden/closing panels and Settings size previews are
excluded. This preview handoff uses the public main-window API without alpha
compensation; the additional appearance guard for app deactivation is described
in the dismissal section below.

The macOS Debug build, Release check and production/Swift XCTest typechecking
passed. A focused interactive AppKit case covers main-role retention with preview
keyboard focus, unchanged alpha/geometry, and hidden/size-preview exclusions.
Coverage was compiled only; no local regression tests were executed. Repeated
pointer-transfer visual acceptance was not completed by automation.


### Keep Liquid Glass stable through dismissal

Acceptance criteria:

1. Liquid Glass must retain its active appearance while the native panel slides
   out after Escape, shortcut toggle, paste, or an outside click. Keep the existing
   glass style, page/toolbar tint, alpha, geometry, 150/200 ms curves and reduced
   motion behavior.
2. Preview windows and other apps must keep keyboard focus and app activation.
   Retaining appearance during dismissal must not reclaim key/main status,
   activate the app, or delay paste until the slide finishes.
3. Scope any appearance override to macOS 26+ DEV native history panels. Keep
   Settings size previews, older-system frosted glass, WebView mode, Windows and
   Release on their existing paths. Detect unavailable or changed interfaces and
   fall back safely.

The previous main-role retention fixes transfers within the app, but cannot cover
app deactivation. Native paste explicitly restores the destination app alongside
the hide animation; outside-click dismissal also starts after deactivation. In
those paths Liquid Glass can switch to its inactive appearance while the 200 ms
position animation is still visible. No focus handler changes the configured
alpha or the fixed content tint.

The macOS 26.5.1 AppKit Objective-C runtime exposes
`-[NSWindow _setForceMainAppearance:]` with type encoding `v20@0:8B16`.
The selected SDK's `NSGlassEffectView` exposes no public active-state property.
The override below is private API, restricted to the existing DEV native
experiment and guarded by runtime selector/signature checks. It holds appearance
without changing actual key/main status, and stays set through window close so
cleanup cannot expose an inactive final frame. Settings size previews disable it.

Focused AppKit coverage is added before the implementation: relinquish both real
focus roles while the panel remains visible, require its main appearance to stay
active, preserve alpha/frame, then disable the override for a size preview. It is
not executed locally, as requested.

Validation: the macOS Debug build, Release check, Rust formatting and diff checks
passed. Production Swift plus the focused XCTest sources typechecked with both
the Liquid Glass SDK flag and the fallback branch. No local regression suites
were executed. An isolated synthetic-history launch exercised the real
Rust/Swift native-main path: logs confirmed `keep-glass-appearance=1`,
`NSGlassEffectView`, `nativeDefault=true webviews=[]`, the existing 150/200 ms
show/hide transitions, an unchanged `{{-12, 0}, {1944, 302}}` host, and close-time
`cards=0 pages=0 decodedBytes=0`, `nativeViews=0 listeners=0`. The window closed
successfully. The automation did not capture the 200 ms exit frame by frame;
absence of a visible last-frame flash still needs visual confirmation.

Submission checks: `npm run check:styles` and `git diff --check` passed. These
static checks do not execute regression tests.
