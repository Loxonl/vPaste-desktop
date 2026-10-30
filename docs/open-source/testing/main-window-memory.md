# Main-window memory profiling

The optimization target is a >=50% reduction in the normally visible DEV main
renderer, measured separately for the first-page settled interval, the active
500-record browse interval and the settled interval after browsing. Samples are
physical footprint, not reserved virtual address space or JS heap alone. Related
process totals must also decrease, and the OS lifetime peak must not increase.

The Debug-only `--memory-profile-dir` startup requires a newly marked temporary
profile. It uses the real clipboard React route, WebKit renderer, history database
and Rust commands. It does not install a mocked Tauri API. A synthetic fixture is
prepared in a separate process, then copied into each trial's data directory.
Profiling does not initialize personal data, clipboard capture, global shortcuts,
autostart synchronization, tray, cleanup or update checks. The isolated webview
uses a nonpersistent store. An executable-adjacent `portable.flag` rejects the
profile before any startup side effects; copy the Debug executable to a separate
temporary directory before profiling a portable build. The marked root is
authoritative even if runtime directory selection changes later; portable
autostart/WebView setup is skipped and Windows WebView data is directed into the
marked directory. Focus-loss auto-hide is disabled only for this marked
profile so that desktop focus changes do not invalidate the visible scenario.
The profile window is nonfocusable and ignores desktop mouse input; scripted
scrolling still drives the real DOM and native pagination. It has no simulated
hover. Visible intervals reject hidden samples, S1 requires exactly 36 records,
and extra auxiliary windows invalidate the trial. The explicit hide/reopen
scenario still uses the normal native commands.

Start Vite on port 1421 and build a Debug binary, then run:

```sh
CARGO_TARGET_DIR=src-tauri/target/target cargo build --locked --manifest-path src-tauri/Cargo.toml --bin vPaste
node scripts/profile-main-window-memory.mjs --output /absolute/path/to/baseline
```

Use `--fixture <baseline-manifest-fixture-directory>` for the after build so both
runs use exactly the same data and assets. The fixture contains 500 deterministic
mixed text, image, file, link, rich-text, GIF and text-file records; automatic link
fetching is disabled in both runs. The report stores sizes, IDs and counters,
never user clipboard contents. DEV and release results cannot be interchanged.

Each trial settles for 30 seconds, samples the first page for 30 seconds, browses
forward and back at a 500ms viewport cadence, samples the settled page for 30
seconds, and records 60 seconds hidden before reopening. The driver records missed
pagination and rejects incomplete/partial runs. OS lifetime peak is read from
`proc_pid_rusage` v4 on macOS; 1Hz sample maxima are not labeled lifetime peaks.
Inspector and the memory-monitor window remain closed. No GC or memory-pressure
trigger is used. Every trial uses a new process and verifies the old renderer
exits before another trial. HMR is not a new trial. The manifest records source, executable and driver
SHA-256 identities; a source/executable mutation during a trial rejects the
cohort.

The user requested no regression runs. This workstream uses only focused memory
profiling, compilation/type/style checks and code review; unit/visual regression
coverage may be updated but is not executed. Windows runtime profiling remains
separate from the macOS footprint target.

## Measurements

Baseline and after reports are recorded as JSON/JSONL with fixture/build/viewport
identity, per-process counters, OS peaks, mounted card count and scenario P95.
No reduction is claimed until the matched three-trial comparison is complete.

### Before optimization: macOS, DEV, three fresh trials

Fixture hash: `76c5cab6eea0447ce0e3cc9bae86fe7e1c982f76a607caef16f97aa5248c28e3`.
Viewport width 1944 logical pixels, DPR 2, light theme; visible noninteractive
profile with the real 500-record query/rendering path. Inspector/monitor closed.

| Scenario | Renderer P95, median of three trials |
| --- | ---: |
| First 36 records, settled | 159.81 MiB |
| Active forward/back browse of 500 records | 449.50 MiB |
| Settled after browsing | 390.39 MiB |
| Hidden after browsing, secondary metric | 417.78 MiB |

All visible intervals were visible, all three traces reached 500 records, and no
missed pagination or partial counter was accepted. The list retained 500 mounted
cards after browsing and while hidden. The fixture's retained text/HTML/source
fields total approximately 0.46 MiB (field bytes, not JS heap), so the observed
hundreds of MiB of growth justify prioritizing DOM/media lifetime before a new
native pagination API. Invalid exploratory runs with hidden or extra windows
were excluded. Exact per-trial JSONL, process identities and OS peaks remain in
the task's local measurement artifacts.

### Preservation-route candidate: screening only, target not achieved

The latest valid screening trial used the same fixture, viewport, DPR and DEV
mode, reached all 500 records with zero pagination misses and kept at most 14
cards mounted while browsing. It is one fresh trial compared with the baseline
median of three; it is not the final three-trial acceptance result. This snapshot
also precedes the final drag-completion cleanup, so a future final report must
record the final source/binary identity again.

| Scenario | Baseline renderer P95 | Screening renderer P95 | 50% threshold |
| --- | ---: | ---: | ---: |
| First 36 records, settled | 159.81 MiB | 133.88 MiB | 79.90 MiB |
| Active forward/back browse of 500 records | 449.50 MiB | 317.44 MiB | 224.75 MiB |
| Settled after browsing | 390.39 MiB | 260.74 MiB | 195.20 MiB |
| Hidden, secondary metric | 417.78 MiB | 229.63 MiB | Not a primary gate |

The implementation replaces accumulated DOM cards with viewport slots, retains
at most two interaction sources, and drops card DOM after the native hidden
event. Hash-based node registration replaces global DOM-array indexing for
scrolling and keyboard context-menu positioning. Card images own abortable blob
URLs and release them on unmount. Rust supplies 240/480/720 pixel thumbnail tiers
while retaining original metadata, original action content and GIF behavior.
Secondary overlays load on first use; generated icon data has no duplicate
inline source map. Window geometry, visual effects and the normal DEV server
experience remain unchanged.

The fixture's small retained payload and actual WebKit Inspector snapshots
(roughly 6.6 to 17.1 MB of live JS objects during browsing) do not support
introducing a broad native history-view service as the next memory remedy.
Full Item records and the existing synchronous original drag MIME are retained.
The conditional native paging/payload and rich-image-token stages remain
deferred; unusually large real payloads are not covered by the small synthetic
field-byte observation.

Separate diagnostics are never mixed into the acceptance samples. Removing the
main backdrop saved only about 7 MiB in one diagnostic. The public in-memory
WebKit cache removal API did not materially reduce first-page memory. Temporary
cache-model, animation-backend, containment and bounded-compositor experiments
missed the goal and were removed. No new private cache policy ships. An empty
DEV document was about 21 MiB; an empty React/MUI/Motion provider shell about
38 MiB; loading main-page modules without rendering was about 48 MiB. These are
staged diagnostic snapshots, not additive budgets or a claimed engine floor.
Runs with zero loaded cards, stalled pagination or incomplete counters are
excluded.

Keyboard/reopen latency, reduced-motion runtime behavior, Windows runtime
behavior and the final three fresh trials still require acceptance. Builds and
style checks are not substitutes for those results. Unit and visual coverage is
present for viewport/resource/gesture mechanisms but has not been executed, in
accordance with the user's instruction.


## Bounded history and file resources (2026-10-30)

The real main route now uses `open_history_view` / `read_history_view_page`
for metadata and `read_history_card_payloads` only for resident cards.
Normal windows retain at most three 36-record metadata pages; very wide windows
retain the pages required to cover the viewport. Complete card/MIME adapters
follow the viewport, overscan and up to two active gestures. There is no reusable
complete-body LRU. Metadata prefetch does not extend the exposed scroll track
until load-more requests the next logical page. Record identities and global
indices remain independent of the resident array.

Images use Rust file assets directly. The card fetch/Blob/object-URL ownership
layer and the full-image data-URL fallback are removed from the history display
path. Rich display HTML contains only tokens resolved through its own native
resource map. Original synchronous drag MIME remains separate and may contain
inline images, and its full byte count is reported; it is not used for display.
Legacy/tutorial presentation Items retain their existing presentation contract.
Native query caches are bounded independently, and closing the native-hidden
view releases the frontend owner and the native query session. Late results
cannot refill a closed owner.

One real macOS DEV full round trip used the unchanged synthetic 500-record
fixture, 1944 CSS-pixel viewport, DPR 2, Inspector closed, no forced GC. It
completed with zero reported misses. This is screening evidence, not the final
three-trial 50% acceptance. P95 renderer footprint was:

| Phase | MiB |
|---|---:|
| First page | 135.77 |
| Active browse | 404.31 |
| Settled after browse | 369.05 |

Metadata peaked at 108 references; the canonical resident card/MIME cache peaked
at 14 entries and 8,938 UTF-8 bytes for this small-content fixture. These counters
are ownership diagnostics, not an estimate of all renderer heap or transient
React/IPC allocations. Stable hidden samples had zero metadata refs, resident
cards, pending loads and native-view cache bytes. Settled samples verified all
four history media elements had source URLs, `complete` and positive natural
width, with no data/blob display URLs. Physical renderer accounting remained
high after release. The prior Blob candidate had lower active/settled screening
values (317.44 / 260.74 MiB); this change must not be presented as an achieved
physical-memory saving or a 50% reduction. The specific native retention source
has not been apportioned by this data-window run.

The earlier first-page-only probe was excluded from memory-benefit evidence
because a StrictMode setup/cleanup issue could leave images without src. The
combined review fix restores src on setup, resets invalidated pagination owners,
uses global deletion successors, clamps EOF navigation, handles HTML src case /
spacing / entities and persists recovered temporary rich images in a disk render
manifest. The full run followed those fixes. A later legacy presentation guard
and Debug resource-diagnostic entry point do not change the measured native
history branch; the cohort is not labeled final acceptance for the latest tree.

A separate real-process resource diagnostic loaded an uppercase/spaced Base64
image and a local-file image with identical bytes. Both displayed through one
native file resource; display HTML was 271 bytes and the original drag fragment
was 297,511 bytes. A second process, after the temporary local image was deleted,
still loaded both images from the persisted native resource manifest. The
Debug-only `--memory-profile-resource-check` driver records the resource and MIME
checks against an explicitly marked temporary profile.

Evidence is under `.superpowers/sdd/2026-10-29-history-data-release/artifacts/`:
`full-browse/summary.json`, `resource-check.json`, build/type/style logs and the
implementation ledger. No unit, visual or broad regression suite was executed.
The browser interaction fixtures have a test-only bridge for the new IPC
contract; that bridge never participates in native memory measurements. macOS
Debug build/runtime and native release compilation are checked separately;
Windows native behavior has not been executed locally.

### Capture-time thumbnails (2026-10-30)

Static card thumbnails are now prepared synchronously on the native capture
worker, before storing/publishing an image history record. Captured image bytes
are reused directly. Copied single image files also prepare a thumbnail while
retaining their existing file-reference semantics and source-content validation.
The main native window's scale factor selects the same 240/480/720 pixel tier as
the frontend. Foreground resolution reuses the disk PNG and generates it only
when absent, including legacy history, failed preparation or a different tier.
Image-file source validation retains content-keyed PNG reuse and explicit refresh
behavior. GIF playback and full original copy/drag behavior are unchanged.

List-driven thumbnail prewarming and its fixed 720px work are removed. Link fetching
and Windows clipboard-format prewarming keep their visibility/cancellation path.
Thumbnail preparation failures are logged and do not prevent storing the image;
existing source/pixel/allocation limits still apply.

A Debug-only headless diagnostic calls the real image/file capture-store helpers
and native foreground resolver in a fresh marked temporary profile, without
opening or modifying the system clipboard:

```sh
src-tauri/target/debug/vPaste --dev-mode --memory-profile-dir /private/tmp/vpaste-memory-EXAMPLE --memory-profile-capture-check
```

The directory must contain only `.vpaste-memory-profile` with the exact contents
`vpaste-memory-v1\n` before launch. The diagnostic writes `capture-check.json`.
The macOS run used synthetic 1920×1080 PNGs at scale 2 and verified 480×270 thumbnails
already existed when capture returned; foreground cache hits preserved their
paths and modification times. A removed thumbnail was rebuilt by the foreground
resolver and all original bytes remained unchanged. Capture/store took 267.89–271.07ms,
cache-hit native resolution 2.15–2.39ms, and the forced cache-miss resolution 267.58ms
in this Debug build. These are native path timings, not end-to-end UI timings or
physical-memory measurements.

Evidence is under `.superpowers/sdd/2026-10-30-capture-thumbnails/artifacts/`:
`capture-check.json`, `incremental.patch`, native Debug/release compile logs and
focused coverage compilation. Focused native cases were added but not executed,
following the user's no-regression-suite instruction. No UI behavior was changed;
Windows runtime verification remains outstanding.

### Trial: keep the collapsed main window visible (2026-10-30)

The user selected a reversible parking version for manual comparison. With
`CLIPBOARD_PARK_WHEN_COLLAPSED` enabled, the normal collapse path moves the native
window below the complete display layout, disables native keyboard/mouse
interaction and emits `window-parked`. It does not call native hide. The frontend
keeps its bounded viewport card DOM, history view and media references, makes the
parked surface inert and hides it from accessibility. Normal show still refreshes
history through the existing synchronization/paste gate. Window dimensions,
gutters, 170/140ms durations, easing and reduced-motion paths are retained.

Shortcut toggles and clipboard-dependent positioning now use logical presentation
state. Reopening restores interaction, records the previous app and starts at the
target screen's lower edge rather than the distant parking position. A positioning
failure falls back to real hide and its existing `window-hidden` data cleanup.
Setting the trial constant to false restores that cold-collapse path; retaining
the trial as a permanent policy needs separate user acceptance. There is no idle
timer in this version. The earlier zero-cache hidden-memory measurements do not
describe this warm parked state.

The Debug-only `--memory-profile-parking-check` diagnostic uses the real shortcut
toggle function with a marked synthetic profile. On macOS with one display, two
collapse/reopen rounds kept `nativeVisible=true`, set `presented=false`, verified
the parked rectangle was outside every display, and retained the same 11 card DOM
nodes. Reopening returned to the original 302px-height rectangle. A toggle during
the 140ms collapse also reopened successfully without a stale collapse winning.
The probe deliberately remains nonfocusable; interactive focus return is left to
manual trial. Windows, display hot-plug/multiple-display layouts and reduced-motion
runtime were not exercised. No frame-rate or memory-saving claim is made.

Evidence: `.superpowers/sdd/2026-10-30-park-main-window/artifacts/parking-check.json`
and build/style/type logs. Focused lifecycle/DOM coverage is included but no unit,
visual or regression suite was executed, following the user's instruction.
