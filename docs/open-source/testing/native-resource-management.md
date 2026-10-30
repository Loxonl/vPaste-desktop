# Native main-page resource management

The main page keeps React rendering, DOM visibility, interaction and animations.
Rust owns the following resource work:

- Native search fills logical pages across filtered database/index batches and
  returns the final scan cursor. The TS adapter performs one IPC request per page
  and discards obsolete responses.
- Two lazy background lanes handle media prewarm and link metadata refresh. Each
  page submits at most six images and ten links, with live preference checks.
  Media prewarm waits 900 ms; Windows clipboard conversion waits another 1800 ms
  and covers at most two images. The native show/hide transition lock controls
  visibility epochs. Hide cancels queued work; an executing operation can finish,
  but stale epochs cannot schedule work or update the next visible UI session.
- Resource completion events carry the epoch and trigger a visible background
  search. Such a search cannot schedule another resource batch. Main-page
  clipboard changes while hidden wait for the existing show synchronization.
- `resolve_history_media` returns asset paths and metadata. Its 96-entry native
  cache includes in-flight loads and retains no pixel buffers. At most two media
  builders execute; the existing single image-decoder lock is retained. The
  prewarm identity set is bounded to 256 entries. TS retains small URLs/metadata,
  not full base64 images.
- Image and file/GIF cards share the existing 32 MiB source, 40 million pixels,
  16384 dimension and 20 MiB animated-GIF budgets. Oversized files retain the
  existing large-image indication. Metadata uses image headers; SVG metadata
  disables external-image resolution, and AVIF/HEIF dimensions use container
  metadata so browser-supported codecs retain original-asset fallback.
- Explicit refresh invalidates the old disk metadata/thumbnail identity and
  creates a content-keyed fresh asset, including same-size/same-timestamp file
  replacements. Original fallback is permitted only by native budgets.

Existing persisted formats, system proxy rules, native geometry, mouse paste
preferences, editor drafts, other auxiliary destruction and the DEV monitor are
preserved. List virtualization, large-text hover interaction, network response
caps and native permission-object cleanup are separate work.

## Preview window reuse

After the main page is ready, one asynchronous warmup shares the serialized
window creation/readiness path with ordinary preview requests. It creates only
a hidden, unfocused, empty page; no clipboard payload, media or website is loaded.
Repeated page-ready signals do not schedule another warmup.

Ordinary preview closure clears pending content/geometry and pin/hover state,
then hides the existing WebView until app exit. Reopening reuses its page and
listeners without an idle timer. Cancelled preparations return without hiding,
clearing or destroying a page that a newer request may have adopted. Other
auxiliary windows keep their destruction/recreation lifecycle.

File presentation and its icon modules are loaded only when needed. A local
Suspense boundary delays the file preview's ready signal until that content has
committed, preserving readiness-before-show. Image/text budgets, rich HTML
sanitization, pinning, geometry and focus behavior are unchanged. Native logs
separate window creation/readiness, payload preparation, render wait and visible
commit using scalar timings, never clipboard content or paths. Browser page-ready
benchmarks exclude native window creation and are not key-to-visible timings.

## Original resource migration verification

The user explicitly requested no regression test runs. Only frontend build/type
checking, style architecture checking, native `cargo check`, and independent
read-only review are used for this delivery. Focused coverage was added/updated
for future execution; it was not run. Runtime behavior on Windows was not checked
on this macOS host. No measured memory reduction is claimed from compilation.
