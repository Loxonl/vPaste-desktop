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
uses a nonpersistent store. Focus-loss auto-hide is disabled only for this marked
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
exits before another trial. HMR is not a new trial.

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
