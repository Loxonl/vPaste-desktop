# Windows native settings parity

The shipping React settings window and shared Rust configuration remain the
reference. WinUI is a consumer of that configuration, not a second settings
store. This audit distinguishes a connected consumer from a physically tested
interaction; neither a source search nor an isolated fixture establishes that
all settings work on a user's desktop.

## Configuration consumers

| Persisted field | Runtime consumer and reference behavior | Evidence / remaining boundary |
| --- | --- | --- |
| `startup` | `main.rs::save_config`, shared autostart registration and portable guards | Shared path retained; this pass does not alter the user's startup registration. |
| `display_tray_icon` | `sync_tray_visibility`; in WinUI mode the tray icon opens the lazy native WinUI tray popup, while WebView mode reuses the shipping `/tray-menu` WebView | Native tray popup and legacy WebView menu share the same Rust state/commands. Actual shell icon visibility remains manual. |
| `multilingual` | `language-changed` → native `set_language`; settings uses the existing language provider | Native language/control tests; real app guide/language check separately recorded. |
| `theme_mode` | shared theme event and native `apply_theme`, including reader/editors | Native light/dark checks; system contrast/DWM appearance remains manual. |
| `storage_history` | Legacy serialized field; no current UI or runtime consumer was found in either renderer | Preserve compatibility; do not invent a new native retention policy. |
| `auto_cleanup` | `auto_cleanup.rs` reads current policy and emits shared history notifications | Existing shared tests; destructive checks use disposable data only. |
| `storage_dir` | `history_storage_dir`, shared validation/migration and `history-reset` | Native history reset tests; user history is not moved for this audit. |
| `retain_search_history` | `behavior::from_config` → `PrepareMainShow`; false clears search on every fresh show | Native on/off and reopen regression. |
| `retain_last_position` | same projection → selected hash and history offset restoration/reset | Native viewport and reopen regression; actual mouse/physical DPI remains manual. |
| `retain_tab_position` | same projection → reset builtin/custom/record selection to All when false | Repeated hide/layout/toggle test, including hide reversal; the reported ordinary-App alternation has not yet been independently reproduced. |
| `link_auto_preview` | shared `background_resources.rs` checks the preference both at submission and worker execution; native visible cards use that service | Shared worker tests; already cached link metadata is retained as in WebView. |
| `image_ocr_enabled` | shared `image_ocr` checks scheduling and job acquisition | Existing OCR disable tests; no separate native OCR switch. |
| `mouse_paste_mode` | `apply_click_mode` → native click/double-click policy | Native activation tests; focus in the destination application remains manual. |
| `clipboard_panel_size` | shared `panel_size` preview/session/save commands and native physical layout | Native preview/restore/density tests; physical cross-monitor resize remains manual. |
| `hover_preview_enabled` | `behavior::from_config` → native hover controller and pointer/focus guards | Native hover controller regression; physical hover after tab/search remains manual if foreground is denied to the test. |
| `sensitive_content_protection` | unchanged Windows clipboard capture filter before database insertion | Shared capture path; isolated UI fixture intentionally disables live capture. |
| `quick_input_enabled` | native keyboard resolver controls numbered quick paste | Native keyboard policy tests for enabled/disabled states. |
| `tab_quick_select_enabled` | same resolver controls the existing category shortcuts | Native keyboard policy tests; no additional shortcut scheme. |
| `onboarding_completed` | shared startup/complete-onboarding commands; temporary guide uses saved filters | Frontend unit and browser behavior tests; actual native-host evidence is separate. |
| `update_check_enabled` | shared updater configuration and automatic-check worker | Shared path retained; no release/install action is run by this audit. |
| `last_update_check_at` | updater-owned timestamp; `save_config` preserves the current worker value | Shared save ownership retained. |
| `ignored_update_version` | Legacy serialized field; no current consumer found in either renderer | Preserve the field; do not claim it is an active feature. |
| `ignored_app_sources` | unchanged Windows capture filter checks source identity before capture | Shared path; live third-party source exclusions remain manual. |
| `shortcut_keys` | See the subfield inventory below | Shared global registration plus native local input policy. |

## Shortcut subfields

| Field | Current behavior |
| --- | --- |
| `main_window` | Existing configurable global shortcut, including the isolated Win+V helper, routes to the selected renderer. |
| `paste_queue_toggle` | Existing configurable global shortcut routes to the shared queue activation controller and native queue. |
| `paste_into_plain_text` | Existing configurable local binding is projected to native keyboard/menu labels; empty means the shipping Shift+Enter fallback. |
| `copy_and_show_shortcut` | Legacy serialized field, not exposed/registered by the shipping settings UI. Preserve it without creating a new feature. |
| `copy_and_exec_shortcut` | Same legacy status. |
| `translate` | Same legacy status. |
| `preview` | Legacy configurable field is not consumed by either renderer; the current UI documents the fixed Space shortcut. |
| `quick_selection` | Legacy configurable field is not consumed; the current UI documents fixed arrows/numbered selection with the existing enable switch. |

## Lifecycle and drag boundary

Settings still uses the existing WebView, is created on demand and destroyed on
close. WinUI mode must never create the main `clipboard` WebView. The isolated
actual-App lifecycle script checks those lifetimes, preview reuse/pinning and
guide release; it does not enable live clipboard capture or global hooks.

Windows settings movement previously emitted `panel-size-display-changed` for
every pixel. The notification now compares native monitor bounds, work area,
window DPI and window identity before crossing into WebView. Moving within one
unchanged display does not need another panel-size recommendation. A regression
first observed 80 notifications for 80 identical display snapshots; the fixed
policy emits one and still notifies for monitor/work-area/DPI/window changes.
Other platforms retain their prior notification path.

The manual `WM_NCLBUTTONDOWN` workaround did **not** pass the user's physical
test: movement still stalled and input could remain captured after release.
It has been removed, rather than adding another capture/focus repair loop.
The locked Wry 0.57.0 runtime enables WebView2's non-client regions through
`ICoreWebView2Settings9`. Windows settings now marks the existing three caption
regions with CSS `app-region: drag`, and attaches no JS mouse-down drag handler
there. macOS and other hosts retain the standard `startDragging` bridge.
The close controls remain `no-drag`; there is no settings-specific Rust drag
command, custom capture, or synchronous modal move entered from an IPC callback.

`ConfigDrag.test.tsx` first reproduced three unwanted Windows IPC drag starts
while the macOS route passed. `check-winui-media-settings.mjs` checks the actual
App's computed caption regions, absent competing requests and file-preview
policy in an explicitly marked fixture. Neither DOM dispatch nor computed CSS
proves physical mouse-move smoothness or post-release desktop interaction.
Hold/move/release, rapid clicks, another-app clicks without Alt+Tab, resizing,
and mixed-DPI movement remain manual acceptance criteria.

On 2026-11-17, the rebuilt App passed that marked-fixture check: all three
caption regions computed to `drag`, close controls computed to `no-drag`, and
DOM down/up dispatch produced zero competing drag IPC requests. The separate
auxiliary lifecycle check also passed settings destruction and recreation.
These are actual-App routing and lifecycle results, not a physical dragging
pass. The user reported both movement stalling and capture remaining stuck
after release; both symptoms must be checked in the ordinary Debug build.

Programmatic actual-App movement did not reproduce the reported whole-desktop
stall: the earlier 80-move sample had 5.585ms mean position IPC and a 17.5ms
maximum requestAnimationFrame gap. This is not equivalent to holding the mouse
in Windows' native modal move loop. Do not mark that physical symptom resolved
until the ordinary Debug window has passed the same drag used to report it.

After notification deduplication, another actual-App 80-move run emitted zero
display-change notifications on the unchanged display. Its mean position IPC
was 9.899ms and maximum frame gap was 17.6ms. This confirms notification removal,
not a measured improvement in total movement latency or proof of the reported
physical stall's cause. Cross-monitor/work-area/DPI changes remain covered by
the notification policy regression and require physical display acceptance.

See the [acceptance matrix](windows-winui-acceptance-matrix.md) for the broader
source/native/actual-App/manual evidence split. No GitHub Actions or visual
snapshot approvals are implied by this inventory.
