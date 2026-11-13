# Windows WinUI follow-up: stages 5–7

## Acceptance criteria

1. Native motion and accessibility: reuse the shared motion-token source for
   small opacity feedback; let WinUI own its built-in menu/control transitions.
   Do not animate the dock, drag transforms or initial history batches. Honor
   Windows animation settings, keep keyboard targets/names usable and make the
   branded card chrome readable in contrast themes without recoloring copied
   rich content. System preference subscriptions must be revoked at shutdown.
2. Resources and measurement: exercise 36-card history, 100 queue items and
   repeated image/text reader lifecycles with synthetic data. Record actual
   process memory/handles and timings, verify removed native content is released,
   and keep caches/window creation bounded. Do not infer a production memory
   reduction from a component test or compare different workloads as equivalent.
3. Bridge and platform boundaries: document and validate the private Rust/WinUI
   protocol before native initialization. Centralize its message limits and DTO;
   reject incompatible DLLs clearly. Preserve existing operations, queue/tag
   payloads, stale-reply guards and platform-specific compilation.
4. Preserve all accepted stages 1–4, shipping layout and business behavior.
   Settings remains React/MUI, created on demand and destroyed on close. Leave
   macOS/Liquid Glass, public Tauri commands, storage/configuration formats,
   installers, releases and hosted workflows untouched. Run checks locally and
   restart the experimental native Debug once at the end for consolidated review.

Stages 8–9 (distribution, clean-machine acceptance and the Windows default
switch) remain separate. Physical Narrator, Windows contrast themes, multiple
monitors/scales and Windows 10 require manual acceptance; synthetic overrides
and XAML screenshots do not establish those results.

## Verification and remaining checks

Local evidence (2026-11-13 and 2026-11-14) is in the ignored directory
`src-tauri/tmp/winui-stages567-20261113/`.

- 61 Rust/WinUI cases passed. The live native control regression reached stage
  129 with `S_OK`, including queue/tag envelopes, stale reader requests, normal
  and disabled-animation feedback, contrast chrome restoration and the 24px
  favorite target. The favorite-size regression first failed at stage 126
  against the old 18px target. The isolated-profile routing check also failed
  before the WinUI setup fix and passed afterward.
- Posted Space and foreground-dependent queue assertions explicitly skipped
  because Windows denied foreground activation to the synthetic test window.
  Real keyboard/focus behavior still needs manual review.
- Existing frontend motion/preview and WinUI source-contract checks passed:
  83 cases after updating the old single-theme source expectation. The related
  shared UI/component subset also passed (overlapping cases, not extra unique
  coverage). The final isolated-profile regression and preview build contracts
  passed all 8 cases; its new capture/warmup assertion failed before the fix.
  The trusted-origin/profile-isolation Rust tests passed with and without
  `winui-debug`. Style architecture, Rust formatting, the ordinary Windows build
  without `winui-debug`, production Vite build and production/native-Debug asset
  isolation checks passed. No hosted workflow was added or dispatched.

### Synthetic resource cycles

These counters belong to the full native regression host after earlier UI
cases. They are lifecycle evidence, not an App/Release memory comparison.
Times include actual render-frame and image-decode waits.

| Workload | Private commit before / after | Handles before / after | Total time |
| --- | --- | --- | --- |
| 20 text/image/hide reader cycles | 235,806,720 / 235,819,008 bytes | 1630 / 1633 | 1327 ms |
| 6 replacements of 36 cards, then clear | 235,819,008 / 235,798,528 bytes | 1632 / 1620 | 421 ms |
| 6 refreshes of 100 queue items, then destroy | 235,798,528 / 239,267,840 bytes | 1620 / 1616 | 1529 ms |

Weak-reference assertions verified release of every retired card surface, the
destroyed queue root, and each replaced/hidden reader's text and image content.
The reader reused one HWND and stopped both timers after every hide. USER/GDI
counts did not grow over the reader/history loops; destroying the queue removed
two USER objects. The queue's approximately 3.3 MiB commit increase alone does
not establish a leak or an optimization opportunity; allocator/framework caches
and longer real workloads require separate profiling before changing behavior.

### Full-process first-page observation

The isolated fixture has 500 deterministic mixed records. Both runs used the
same final Debug executable (SHA-256
`CF020776D8570A4E110F968B5C11A86AE4DA1DB6B2F34A5F5E873DA9468EA5C0`),
the same synthetic database at startup and the ordinary first-page query. Both
loaded 36 records: WinUI exposed 36 history `ListViewItem` cards after the
virtualized list settled; the WebView's real acceptance driver completed with
`loadedCount=36`, 13 resident card elements and no error. The WebView driver also
rejects auxiliary-window contamination and hidden windows.

No forced collection/cache trimming is used. Both ran visibly on this Windows
11 machine (build 26300). The read-only observer sampled each for 15 seconds after at
least 8 seconds of warmup, with 1-second spacing plus CIM enumeration time.
Each run produced 11 samples. Private commit is summed over the complete process
tree; working sets are not added for the comparison because shared pages can be
counted repeatedly.

| Renderer | Median private commit | p95 | Processes |
| --- | --- | --- | --- |
| WinUI | 132.76 MiB | 132.83 MiB | 1; no WebView descendant |
| WebView | 344.24 MiB | 352.34 MiB | 7; App plus 6 WebView processes |

Evidence: `memory-winui-final-main-5956.json` and
`memory-webview-final-main-5956.json`, plus their `profile-*-final-*.log` files
in the local evidence folder. The WebView's final `complete` row is in the
marked temporary fixture's `samples.jsonl`. Earlier blank/empty-history
profiles, samples from a different executable hash and older native
observations are not part of this matched comparison.

This is one sequential Debug first-page observation, with existing fixture and
WebView disk caches. It excludes live capture, tray/updater startup, settings,
preview warmup and user interactions for both renderers. It is not a randomized
benchmark, a Release result or a guaranteed saving under every workload. Do not
use the observed difference as a production memory-saving percentage.

The profile startup now loads embedded assets from Tauri's trusted origin when
`custom-protocol` is enabled, provides the frontend logger, skips waiting for a
clipboard monitor that deliberately does not run, and skips resident preview
warmup. These changes are restricted to the existing isolated Debug profile;
normal startup still captures the clipboard and prewarms the WebView preview.

### Consolidated manual review

1. Enter/leave queue multi-selection and perform copy/favorite actions. Check
   the small selection-bar/status fade, keyboard focus and repeated clicks.
   Disable Windows animation effects and repeat: no custom fade may linger or
   leave a translucent surface behind.
2. Enable a Windows contrast theme, check card titles/timestamps/favorite
   controls, then restore the normal theme. Copied rich content must retain its
   own formatting. Check Narrator names and selection-count announcements.
3. Rapidly navigate text/image/native and rich/link/PDF previews, close/reopen
   them, and open/close settings. Repeated closure must release media content;
   settings must still be created on demand and destroyed on close.
4. Check the Windows versions, physical 100/150/200% scales and monitors used
   for release acceptance. Neither synthetic contrast overrides nor browser
   platform mocks establish these physical/native-platform results.
