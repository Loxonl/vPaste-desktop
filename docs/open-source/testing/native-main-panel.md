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


### Native pointer affordance follow-up: SwiftUI toolbar pass-through

Acceptance criteria: hovering any SwiftUI toolbar control (search, refresh, info,
settings, close and the filter tabs) shows the pointing-hand cursor inside that
control's bounds, while clicks still reach the SwiftUI button and toolbar gaps
keep the ordinary arrow. The macOS 11 AppKit fallback, keyboard focus, search
editing and window geometry must remain unchanged.

`PanelCursorRegion` returns nil from `hitTest` so SwiftUI button actions keep
receiving clicks. AppKit resolves cursor rectangles and `cursorUpdate` events
through hit testing, so that same nil result prevented the previously registered
cursor rects from ever being used. The region now installs an `.inVisibleRect`
`NSTrackingArea` with `.mouseEnteredAndExited` and `.cursorUpdate`, sets its
cursor from `mouseEntered(with:)`/`cursorUpdate(with:)`, and restores the arrow
from `mouseExited(with:)`. A real-window check inside `NSHostingView` confirmed
that `mouseEntered`/`mouseExited` are delivered for this pass-through view while
`cursorUpdate` is not. The cursor rect registration is retained for
completeness. No cursor push/pop stack or additional hover timer is introduced,
and disabled regions ignore entry/update events. The legacy
`PanelPointerButton` cursor rect path is untouched.

Validation: production Swift and the focused XCTest sources typechecked against
the macOS 11 deployment target. A standalone AppKit check confirmed the tracking
options, the unchanged nil `hitTest`, and enabled/disabled entry behavior. A
real SwiftUI window with the production `PanelCursorRegion` reported the
pointing hand over the button and the arrow after leaving it. The running
panel's own cursor appearance still needs a manual hover check.


### Animated filter-selection indicator

Acceptance criteria: switching filter tabs moves a single accent underline from
the previously selected tab to the newly selected one, matching the WebView's
shared Motion `layoutId` indicator. The underline keeps the 10-point inset,
3-point height and tab-width geometry, stays under the selected tab after the
strip scrolls, and switches instantly when Reduce Motion is enabled. Tab widths,
labels, hover states, selection callbacks and the macOS 11 AppKit fallback remain
unchanged.

`PanelFilterStrip` no longer draws a per-tab underline. One `Capsule` is
positioned from `PanelFilterIndicatorLayout` over the strip and animates its
horizontal offset and width with the WebView layout spring (mass 0.9, stiffness
320, damping 34); Reduce Motion disables that animation. The geometry helper is
covered by a focused XCTest that checks the first and second tab rectangles, the
3-point height and an out-of-range selection at 80%, 90% and 100% panel scale.

Validation: production Swift plus the focused XCTest sources typechecked, the
geometry check was compiled and executed against the production helper (PASS at
all three scales), and `cargo check` rebuilt the Swift sources. The animated
transition itself still needs a manual run; it was not visually captured.


### Filter-result card motion

Acceptance criteria: switching a filter tab replays the WebView's result-card
motion for the newly loaded page. Cards fade in over 180 ms with the enter curve
and slide from 16 points right with Motion's gentle spring (mass 1, stiffness
220, damping 28); the slide is staggered by `(index % 12) * 18 ms`. Identical
result sets, Reduce Motion, refreshes, search reloads and the "load more"
placeholder must not animate. Card reuse, scrolling, drag, selection and paste
behavior stay unchanged.

`changeFilter` captures the previously loaded first-page hashes before `reload()`
and arms the motion only when Reduce Motion is off. `accept` compares the new
first-page hashes and, when they differ, starts a new sequence with that page's
hashes. `configure` asks the card view to play the motion once per sequence and
hash; `PanelCardView.playFilterEntry` adds a `CASpringAnimation` for
`transform.translation.x` and a 180 ms `CABasicAnimation` for opacity, and
`releaseContent` clears them so reused or retired views never keep a transform.

Validation: production Swift and the focused XCTest sources typechecked. A
runtime AppKit check constructed the production card view and confirmed the
spring values, the 18 ms stagger, the 180 ms fade, duplicate suppression,
replacement on a new sequence and animation cleanup on release (PASS). The
visual transition still needs a manual run.


### CJK tab weights follow the WebView fallback

Acceptance criteria: unselected filter tabs use the WebView's 590 weight and only
the selected tab renders bold (740). Latin weights, tab widths, point sizes and
the AppKit fallback must not change.

SF Pro honours the CoreText `wght` variation, but CJK glyphs fall back to
PingFang, which ignores that axis and selects its face from the base
`NSFont.Weight`. Mapping 590 to `.semibold` therefore rendered unselected Chinese
tabs in PingFang Semibold even though the Latin glyphs used weight 590. The base
mapping is now `.regular` below 550, `.medium` from 550 to 699 and `.bold` at 700
and above; the variation axis still supplies the exact Latin weight. The base
selection is exposed as `PanelToolbarTypography.baseWeight(for:)` and covered by
XCTest.

Validation: production Swift plus the focused XCTest sources typechecked; the
Latin advance widths still match WebKit exactly (590 → 63.43 pt, 740 → 66.07 pt)
and CJK advances stay constant. A WebKit screenshot of the real WebView tab bar
confirmed unselected Chinese labels are lighter than the selected one, and a
rendered native toolbar with the new mapping matches that relationship. The
`cargo check`, card-motion and cursor runtime checks still passed.


### Card surface opacity over Liquid Glass

Acceptance criteria: paste cards must keep their text readable when the desktop
behind the panel is colorful. Card geometry, header gradient, selection outline,
shadow, hover/drag behavior and the toolbar/glass appearance must not change.

The native card previously used white at 0.88 (light) and near-black at 0.95
(dark); the 12% light bleed let the variable Desktop behind the glass reduce
contrast. `PanelStyle.cardSurface(_:)` now returns 0.98 light and 0.99 dark. This
deliberately exceeds the WebView's 0.74 CSS surface because that surface sits on
a flat page rather than Liquid Glass.

Validation: production Swift plus the focused XCTest sources typechecked; a new
XCTest asserts the surface alpha floor. The production card rendered over a
saturated red/blue/yellow backdrop keeps only a faint tint with readable text.
`cargo check`, geometry, motion and cursor checks passed. The real panel's glass
was not visually captured in this run.


### No pale fringe on selected card corners

Acceptance criteria: the selected-card outline keeps its existing 2-point offset,
but the card's rounded top corners must not show a light line where the header's
antialiased edge meets the outline gap. Card colors, radius, header gradient,
outline geometry and body opacity must not change.

The card previously filled the whole rounded surface first and drew the header
gradient over it. Both fills shared the same antialiased rounded clip, so the
gradient's partial edge pixels let the light card surface show through and
produced a pale fringe around the header's curved corners. The surface is now
painted only below the header (with a one-point overlap), and the opaque header
is drawn last, so the header edge blends with whatever is behind the card.

Validation: production Swift and the focused XCTest sources typechecked;
`cargo check` passed. A pixel diff of the production card rendered before and
after the change shows the corner edge pixels losing the extra light component
(for example R/G/B 186/169/132 becomes 182/127/82 over a red backdrop), while
the straight header edge and body colors are unchanged. The real panel's glass
was not visually captured in this run.


### Drag thumbnail shows the whole card

Acceptance criteria: starting a card drag shows a 60%-scaled snapshot of the
entire card (header, text or media, card surface) instead of the card's media
image or source icon. The thumbnail must not include the selection outline or
drag feedback, must be offset 18 points down-right of the pointer (scaled with
the panel), and must not add extra thumbnails for multi-file drags. Pasteboard
payloads, the 5-point drag threshold, cursor feedback and drop operations must
not change.

The WebView clones the whole `.clipboard-card` into a 132x138 preview (a 0.6
scale of the 220x230 card) and sets the drag hotspot to (18, 18).
`PanelCardView.dragPreviewImage()` renders the card's own view into a 60%-sized
`NSImage` with the selection outline temporarily hidden, and `mouseDragged`
places that image at the pointer plus (18, 18) in the card's flipped coordinate
space for the first dragging item. Remaining file items use a 1x1 transparent
image so a multi-file drag still shows one card thumbnail.

Validation: production Swift and the focused XCTest sources typechecked; a new
XCTest asserts the 132x138 preview size for a 220x230 card. The production card
rendered through `dragPreviewImage()` shows the complete header and body at 60%
with no selection outline. `cargo check` passed; the real drag session still
needs a manual run.


### Drag exports the item content, not only its preview

Acceptance criteria: dragging a Text, Color or Link card writes the actual
content to the pasteboard, matching the WebView's `text/plain` (`textContent ||
content`), `text/html` and link URL behavior. File and Image cards keep dragging
their real file paths. The card preview thumbnail, drag threshold, cursor and
drop behavior must not change.

The native `drag` action returned `item.text_content`, which is empty for plain
Text, Color and Link records; the actual value lives in `content`. The drag
session therefore advertised only the thumbnail image. `drag_plain_text` now
mirrors the WebView fallback, splits the `url|||title` Link content into the URL,
and Link drags also expose `public.url` plus an escaped `<a href>` HTML fragment.
The Swift drag item sets `NSPasteboard.PasteboardType.URL` when the payload has a
URL. TextFile still uses `plain_text_content`, and File/Image still use file URLs.

Validation: `cargo fmt --check` and `cargo check` passed. Three focused Rust
tests executed and passed (content fallback, item-type mapping, link escaping);
production Swift plus the focused XCTest sources typechecked. A real drag into
another app still needs a manual check.


### Deleting a history item is immediate

Acceptance criteria: the native panel's Delete action (context menu and
Delete/Forward Delete keys) removes the history record without a confirmation
sheet, matching the WebView's `delete_clipboard_item` flow. Custom tab and record
tag deletion keep their existing confirmations, and reload/empty-state behavior
after deletion must not change.

The controller opened an `NSAlert` sheet before every history-item delete. The
sheet is removed; `action(_:at:)` now calls `perform("delete", hash:)` directly.
The WebView only confirms tab and record-tag deletion, which remain separate
flows and are not part of the native item action path.

Validation: production Swift plus the focused XCTest sources typechecked and
`cargo check` passed. The immediate delete still needs a manual run in the
panel.


### Deleting a card updates the list in place

Acceptance criteria: deleting a card removes only that collection item and lets
the following cards move forward; the panel must not clear the grid, show the
loading state or re-run the whole query. Selection moves to the next card (or the
previous one at the end), and the deleted card's preview/payload is released.
Pagination must keep working when the visible page is refilled.

The delete success path previously called `reload()`, which cleared every page,
showed "Loading history…" and issued a fresh `open` request. It now calls
`PanelPageSplice.remove`, which removes the ref from the loaded contiguous page
window and re-chunks the remaining refs at the 36-item boundaries; the controller
then decrements the count (and terminal count), updates the layout item count and
calls `deleteItems(at:)` for the single index. In-flight page responses from the
old offsets are discarded with a page epoch. Visible items are reconfigured so
their captured indices stay correct.

The last loaded page is refetched after the splice without clearing the view: if
the result set still has more items, the refetched coverage is restored and the
new tail item is inserted with `insertItems(at:)`; if the page became terminal,
the normal page acceptance path reconciles the "load more" row. Real page
timing/2-display behavior is unchanged.

Validation: production Swift and the focused XCTest sources typechecked; a new
`PanelPageSplice` XCTest covers first-page and second-page deletion, the
35-item tail, covered range and a mismatched hash. A standalone run of the
production splice logic passed, and `cargo check` passed. The animated in-place
delete still needs a manual run in the panel.


### Delete follow-up: server page cache and self-notifications

Acceptance criteria: after an in-place delete, refetching the tail page must
return the shifted result set, not the pre-delete page, and the panel's own
delete notification must not schedule a reload. External clipboard changes must
still reload the panel as before.

The Rust history view caches 36-item pages, anchors and the terminal count. A
delete changes every later offset, so the native `delete` action now calls
`history_views::invalidate_native_cache()` after the database delete and before
responding; the next page read rebuilds pages from the current rows. This also
prevents the deleted hash from being reintroduced, which previously left a card
with no payload stuck on "Loading…". The action's `listen_new_clipboard` emit is
suppressed for the panel's own listener (the WebView and other listeners still
receive it), so the local batch update is not followed by a debounced reload.

Validation: `cargo fmt --check` and `cargo check` passed; the in-place delete's
Swift/XCTest typechecking from the previous section still passes. A manual delete
in the running panel is still the final check.


### Add tabs from the native toolbar

Acceptance criteria and implementation scope:

- Add a pointing-hand, non-Tab-focusable `+` button after all tabs, inside the
  horizontal filter viewport. Reserve its full 36-point width plus 1-point margin
  at each panel scale, including the macOS 11 AppKit fallback.
- Offer Filter Tag / Record Tag with the same localized descriptions as WebView.
  Convert the click's AppKit screen position to top-left logical screen coordinates
  and reuse the existing WebView tab editor and all its form fields.
- Native-only startup must open the editor without creating a clipboard WebView.
  Saving refreshes the native tabs and selects the new stable tab id, including
  when an older refresh is still pending; new tabs retain the database tail order.
  Cancel/close returns focus to the native panel without adding a tab.
- Preserve the existing card-menu create-and-assign record-tag operation, search,
  filter selection, shortcuts, focus appearance, docking and animation. Release
  the new callbacks when the toolbar closes. Windows and Release keep their
  existing WebView commands.

The focused cases cover callback release, add-button extent, the two menu
choices/localizations and screen-coordinate conversion. Additional focused
coverage maps a newly created tab by stable identity instead of assuming its
index. Local regression suites are not
executed at the user's request; compilation and scoped interactive verification
are recorded separately.

The native-only editor uses the editor WebView itself as the shared command's
fallback source; monitor bounds still come from the published native surface.
Only the editor is created, never a clipboard WebView. The editor and its emoji
picker use levels 104/105 while the native panel is active, above the panel's 103.
Both the editor's normal close command and native close request return focus.
The card menu uses the same record-tag editor, with creation-time assignment
handled in Rust as described below.

Final verification for the completion pass: Debug build, `cargo check --tests`
(compile only), Release check, both SDK-flag variants of production Swift plus
all focused XCTest sources, style governance, formatting and diff checks passed.
No local regression suites were executed. The user confirmed that both the type
menu and editor now display above the native panel. The menu uses the existing
card-context-menu popup path with the native parent window. Full save/cancel and
older-macOS visual acceptance were not automated in this pass.

New-tab ordering also covers an empty or incomplete stored order: preserve the
stored prefix, append previously unstored existing tabs, then the newly created
id. Repeated save notifications do not move an already-stored tab. A newer manual
filter choice cancels a pending automatic selection, and stale tab-list responses
cannot replace the latest refresh.


### Share the record-tag editor between toolbar and card menu

Acceptance criteria:

- Card menu Create Record Tag opens the same existing WebView `tabEditor` in
  record/add mode as the toolbar, including all current fields and emoji picker.
  Remove the old AppKit name-only alert and its duplicate name validation.
- Saving from the card menu also assigns the newly created tag to the original
  clicked history item, once, even if the current selection has changed. Toolbar
  creation has no assignment target. Keep existing tags and ordering intact.
- Cancel/close, a failed open, and panel disposal clear the pending assignment;
  stale panel sessions and rename notifications cannot consume a new target.
  Assignment failure is reported in the native panel rather than silently ignored.
- Preserve editor positioning/layering, focus return, and the existing WebView
  forms. Windows and Release keep their current paths.

Coverage is added before replacing the path for one-shot assignment to the
original item, stale sessions, rename notifications, and absent/cancelled targets.
Local regression suites are not executed at the user's request.

Validation: macOS Debug build, Release check, Rust test-source compilation,
production Swift/XCTest typechecking with both SDK flags, formatting, style
architecture and diff checks passed. No local regression suite was executed.
A scoped manual run used the isolated synthetic-history profile: card-menu
creation opened `vPaste Tabs` with the existing Add Record Tag, Emoji prefix,
Name and Save controls. Saving selected the new record-tag tab and displayed the
original history card with its tag badge. A read-only fixture database check
confirmed one tag with exactly one item association. The isolated process and
frontend service were stopped afterward. Automated comparison through the
separate toolbar entry and older-macOS visual acceptance were not completed.


### Native toolbar tab context menu

Acceptance criteria and behavior mapping:

- A context click (right click or Control-click) on a dynamic filter tab or
  record-tag tab offers only Edit Tab and Delete, matching the WebView. It does
  not select the tab; All and Favorites do not offer these actions. Both SwiftUI
  and macOS 11 AppKit toolbar paths forward the stable tab id, not its position.
- Edit opens the existing WebView tab editor in edit mode with its saved fields,
  id and current filter-tab list. Existing editor positioning, elevated window
  levels and close-to-native focus behavior are reused. Creation and card-menu
  creation-time assignment stay on the existing add path.
- Delete requires confirmation. Removing a filter tab keeps clipboard records;
  removing a record tag removes its associations and keeps clipboard records.
  Only the deleted id is removed from stored order. Native refresh keeps the
  active tab by identity or falls back to All when that tab was deleted.
- Closing the toolbar releases context-menu callbacks. Menus are associated
  with the elevated panel window and cancel pending hover preview work.

Focused Swift coverage and Rust payload/target validation coverage are added
before implementation. Local regression suites are not executed at the user's
request. No WebView UI, database schema, Release or Windows behavior is replaced.
Filter-editor save notifications include their existing add/edit mode so an
edit is not appended as a newly created tab when stored order is empty or
incomplete. The editor's fields, save behavior and WebView appearance are kept.

Validation: macOS Debug build, Rust test-source compilation (`cargo check
--tests`, without execution), production Swift/XCTest typechecking with both
SDK flags, TypeScript `--noEmit`, style governance, Rust formatting and diff
checks passed. No local regression suites were executed.

A scoped manual run used a separate copy of the 500-record synthetic history
profile. It confirmed the SwiftUI right-click menu, Control-click menu, fixed-tab
protection, prefilled filter and record-tag WebView editors, filter save/refresh,
record-tag delete confirmation and cancellation, and close-to-panel focus.
A read-only fixture check afterward confirmed 500 history rows, the existing
tag and its one association, unchanged filter ids and an unchanged empty stored
order after the filter edit. The check app and private frontend were stopped.
Confirmed deletion was not performed interactively; older-macOS AppKit visual
acceptance and Windows runtime checks were not performed.


### Native toolbar drag-to-reorder

Acceptance criteria:

- Filter tabs and record-tag tabs reorder together by stable id. All, Favorites
  and the add button remain fixed. Normal click and context-click behavior stay.
- A local AppKit drag session shows a tab preview and insertion marker, supports
  horizontal edge scrolling, suspends hover preview/focus-loss dismissal, and
  releases its timer, cursor and callbacks on finish, cancel or teardown.
- Drop commits once through Rust using the latest known tabs. Cancel or dropping
  outside the panel commits nothing. Reordering preserves the selected tab and
  history viewport without fetching history again.
- The database order is applied at WebView startup and changes notify both
  surfaces. Preserve unseen ids while tab data loads. Editing a filter tab does
  not append it again; new tabs still go after the existing tabs.

Coverage is added before implementation for mixed-kind before/after moves,
invalid targets, newly added tabs, history preservation, geometry/edge scrolling,
teardown and non-moving edit notifications. Local regression suites are not
executed at the user's request.

The WebView drop path now asks Rust to move ids rather than replacing order from
an older UI snapshot; its existing target-index placement is retained. Rust
validates dynamic ids, fills missing known entries and replaces order
inside an immediate transaction. A tab-order-changed event refreshes only native
tabs and updates the WebView cache/state; it does not reopen history. The old
startup state-normalization effect is removed so unloaded record-tag ids are not
lost. Add/edit mode now also reaches the WebView receiver, and creation uses
current tab data instead of mount-time callback data.

The shared AppKit row surface owns the drag preview, insertion marker, local-only
move payload, edge timer and cleanup. Its recognizer has priority over descendant
button gestures so a successful drag cannot also activate a tab. Clicks without
movement and right-click menus retain their existing paths. The existing AppKit
fallback teardown is moved beside its content to release the drag surface too.

Verification: the final macOS Debug build, Release check, Swift production and
focused XCTest typechecking with both SDK flags, Rust test-source compilation
without execution, TypeScript, style governance, Rust formatting and diff checks
passed. SwiftUI teardown explicitly releases the drag surface once, before
waiting for representable dismantling, so closing the panel stops edge scrolling
immediately. A scoped isolated run with 500 synthetic history rows confirmed before/
after mixed-tag movement, active-tab preservation, ordinary clicking, context
menus, drag-out cancellation and fixed-tab protection. Read-only database
inspection confirmed the resulting order and retained 500 history rows and one
tag association. The isolated app and private frontend were stopped. No local
regression suite was run; Windows/macOS 11 runtime checks, sustained edge-hover
scrolling and explicit Escape cancellation were not exercised interactively.


### Native toolbar paste queue entry

Acceptance criteria and implementation mapping:

- Add a pointer-only queue toggle beside Settings in both SwiftUI and the macOS
  11 AppKit toolbar. Reuse Rust activation and the existing pasteQueue WebView;
  do not create a clipboard WebView or duplicate queue items in Swift.
- Apply the initial active/revision snapshot and live queue events without
  allowing an older snapshot to overwrite newer state. Toggling, the configured
  queue shortcut and closing the queue window all update the same indicator.
  Closing the native panel releases its queue listener and callbacks.
- Use the native panel's monitor when opening the queue, order it above the
  native panel, and retain the existing WebView positioning and levels otherwise.
  Restore the ordinary queue level when the native main panel closes.
- Queue-window paste hides either main surface before restoring the external
  target and running the existing paste action. Foreground tracking recognizes
  native visibility too. Missing Accessibility permission opens the existing
  permission guide even when no clipboard WebView exists.
- Native history multiselection is described below. Automatic capture, queue
  editing, keyboard interception and the queue's existing WebView controls
  continue to use the existing Rust implementation.

Focused coverage is written before implementation for stale status snapshots,
minimal event payloads, toolbar forwarding/teardown, AppKit state and geometry.
Local regression suites are not executed at the user's request.

Verification: macOS Debug build, production Swift and focused XCTest typechecking
with and without the Liquid Glass SDK flag, Rust test-source compilation without
execution, and style governance passed. A scoped run used a separate copy of
500 synthetic history records with an empty queue. The native toolbar displayed
the queue button beside Settings. This temporary app had no Accessibility grant:
clicking the button opened the existing permission guide, and Not now returned
to the native panel with the queue indicator off. Logs showed no clipboard
WebView, and native views/listeners were released on dismissal. Read-only checks
retained all 500 records and an empty queue. The isolated app and frontend were
stopped. No system permissions were changed and no copy/paste action was run.
The authorized queue path, configured shortcut, real paste target restoration,
multiple-monitor placement and macOS 11 visuals were not exercised at runtime.
Local regression suites were not run.


### Native history selection for the paste queue

Acceptance criteria and behavior mapping:

- While the queue is active, a card click or Enter toggles its hash in an
  ordered pending selection instead of copying, pasting or closing the panel.
  The ordinary single/double-click paste path resumes when the queue closes.
  Keyboard navigation and explicit Space preview remain available.
- Show the existing-style outer outline and a bottom-right check on every
  selected card, including images and files. Reused/offscreen cards, searches
  and tab changes keep selection by hash rather than collection index.
- Show a bottom overlay with the selected count and Add N items. Submit once in
  click order using the existing Rust queue transaction. Success clears pending
  selection and keeps queue mode active; failure retains it and reports the
  error. Keep pending hashes in Rust memory across native-controller teardown,
  clear them when the queue closes, and reject stale activation epochs.
- Queue selection disables hover selection/automatic preview and external card
  dragging, retains scrolling and explicit preview, and uses a pointing-hand
  cursor. The ordinary mode retains its existing drag cursor and paste behavior.
- Initial queue/selection metadata is supplied before the first native frame.
  Revision checks reject old state; submission completion remains correct when
  the panel closes or a newer queue session starts. No history/media payloads
  are retained solely for selection, and no database schema is added.

Focused Swift and Rust coverage is added before implementation. Per the user's
request, local regression suites will not be executed.

Verification: production Swift and focused XCTest sources typecheck with and
without the Liquid Glass SDK flag; Rust test sources compile without execution.
The final macOS Debug build, style governance, Rust formatting and diff checks
passed. No local regression suites were run.

A temporary interactive preview used the production NativePanelController,
SwiftUI toolbar, card views and queue action row with 36 synthetic records and a
mock bridge. The mock prohibited copy, paste and external file dragging. It
confirmed single-click selection of image/file cards even with the ordinary
double-click preference, Enter toggling, count/check indicators, selection after
a filter/list rebuild, retained selection and visible failure feedback, clear
selection after success while queue mode stays active, and restoration of the
ordinary mode after closing the queue. Failure feedback is kept separately from
statistics so subsequent media/viewport updates cannot overwrite it. Logs showed
no copy, paste or external-drag requests; the preview process was stopped.

This preview validates the production Swift interaction path, not live queue
transactions or system paste. The temporary Tauri app has no Accessibility grant;
no permissions or real clipboard contents were changed. Actual paste, queue
shortcuts, in-flight close/reopen with the Rust backend, macOS 11 visuals and
Windows runtime behavior were not exercised. Rust coverage for ordered hashes,
failure/success, stale epochs and late completions is compiled but not executed.

The Rust normal-paste entry also checks current queue activation before copying.
If a queue shortcut beats its UI notification, the activation still selects the
hash and returns queue metadata; it cannot paste accidentally. Explicit copy and
plain-text context-menu paste retain their existing paths.

Queue action-row appearance acceptance: on macOS 26 with the supported SDK,
use NSGlassEffectView with the regular Liquid Glass style and embed the controls
in its documented contentView. Give light appearance a subtle white tint (0.18)
to reduce the grey cast; retain the system dark appearance. Let the system draw
the glass rim instead of adding a dark border. Older systems/SDKs use an active
NSVisualEffectView popover material. Keep rounded geometry, controls, selection
state and window motion. This replaces the traditional menu material, which
rendered as an overly grey surface in the supplied screenshot. Only existing
button-inspection coverage is updated for the glass content hierarchy; no local
regression tests are executed.

Liquid Glass validation: production Swift and focused test sources typechecked
with and without the Liquid Glass SDK flag; the macOS Debug build passed. A
read-only screenshot of the production Swift panel in the synthetic preview on
macOS 26.5.1 showed a light glass surface with blurred image colors and a system
glass rim. No mouse/keyboard actions or system clipboard operations were used;
the temporary preview was stopped. Older-system appearance was typechecked but
not visually exercised. No local regression suites were executed.

Queue action-row sizing acceptance: compute the floating bar from the native
fitting size of its horizontal content row, including the actual button bezel
insets. Prompt, count and button title must fit in English and Chinese at the
three panel scales (0.8, 0.9, 1), and update when count digits change. Preserve the
centered placement and Liquid Glass effect, with room between text and glass
edges. Replace manual string-width/button-frame arithmetic with native layout;
keep queue actions and window geometry intact. Focused clipping coverage is
added before implementation and compiled without running local regressions.

Sizing verification: Swift sources and focused XCTest coverage typechecked, and
the Debug app built. A read-only production-panel screenshot in the synthetic
preview showed the English prompt and full Add 0 items title within the glass
bounds with clear side insets. No Auto Layout conflicts were logged; the preview
was stopped. Digit-growth and Chinese/scale coverage is compiled but not run,
following the no-local-regression instruction.
