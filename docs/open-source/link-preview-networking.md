# Link preview networking

Card metadata, preview images/site icons, and Space webpage documents use the shared `preview_http` transport.

## Routing and trust boundary

- Use the dependency's Windows/macOS system HTTP/HTTPS proxy matcher, including standard proxy environment variables and bypass rules. There are no hardcoded local ports or process-name checks.
- Each URL and redirect is validated before a request. Only the existing HTTPS domain destinations are accepted; literal IPs, localhost/local/internal suffixes and unsupported schemes remain blocked.
- A direct request uses the existing public-address-only DNS resolver. Its actual connection uses those validated addresses; Fake-IP ranges are not treated as public addresses.
- An applicable user-configured proxy is a trusted network egress. The destination hostname is sent through its HTTPS CONNECT tunnel without applying local destination DNS/Fake-IP filtering. The proxy endpoint can legitimately be local or private and has a separate client/resolver.
- Proxy-side destination DNS is outside vPaste's visibility. This path does not offer an independently enforced final-IP guarantee equivalent to direct requests.
- Proxy failure does not retry via direct. An explicit bypass rule, in contrast, deliberately selects the strict direct route.
- System matching currently covers static HTTP/HTTPS settings, not PAC/WPAD script evaluation. Pure TUN/Fake-IP without an applicable proxy stays fail-closed and produces a specific message.
- Stock matcher behavior applies to malformed or unrecognized proxy configuration; it is not a configuration validator.

## Preserved behavior

Clients are scoped to the existing fetch, with a shared cookie jar only for card fetches. The fixed HTTPS proxy client is reused across redirects and image/icon requests. Every redirect re-evaluates bypass routing and validates the destination, keeping the former redirect-count convention and one eight-second deadline across the request chain. TLS certificate and hostname validation stay enabled. Space documents retain the existing sandbox and subresource CSP.

Already cached card metadata is not forcibly refreshed when the network changes. Fallback icon order and clipboard history identity, timestamps, favorites and tags are preserved.

## Card preview recovery and persistence

- Main-panel search results, including subsequent pages, enter a URL-deduplicated background queue. One worker processes batches of at most ten records serially and continues until the loaded queue is drained. Cached entries do not block later records. A new search replaces pending work; hiding the panel cancels it. An already-running blocking request may finish, but cancellation prevents subsequent icon/link requests and stale persistence.
- Background work re-reads each loaded record by its ID and hash, then conditionally updates the same unchanged record. Deleted, replaced or edited records are not resurrected or overwritten by late results. This path does not scan the entire history.
- The regular seven-day refresh window remains in place. An explicitly loaded older link without a usable cached image may also be repaired; an older link with a valid image is left alone. The legacy URL-based command can locate a matching record beyond the former newest-500 lookup limit, but keeps its existing ten-input/seven-day limits.
- Completed attempts retain the existing five content fields: URL, image path, title, image kind and local natural day. Successful previews/icons, pages with no usable image (`default-icon`) and failed page requests (`request-failed`) are persisted for the day. Missing titles use the original hostname. Reopening or copying again does not refetch a completed same-day result, including a negative result. Unprocessed raw URLs have no recorded day; cancellation does not mark them as failed.
- Failed or empty-image refreshes retain a previous valid image and title. Existing legacy generated/brand icon replacement behavior is retained.
- Inline icons accept only base64 PNG, JPEG, GIF, WebP and ICO raster payloads. Decoded data is capped at 1 MiB, dimensions at 2048 by 2048, and decoder allocation at 16 MiB. The declared MIME type must match the detected format and decoding must succeed before the existing disk cache is used. Inline HTML/SVG, malformed, oversized and mislabeled payloads are rejected without a network request. HTTPS image requests keep the existing network and validation policies.

## Failures and diagnostics

The native boundary returns stable `link_preview_*` codes. The UI translates known codes, falls back to a generic network message for unknown errors, and offers the existing `open_url_in_browser` action. Logs record the destination hostname, stage, route, category, optional HTTP status and a bounded, sanitized transport cause chain. Full URLs, credentials, query parameters and response content are not logged.

Tests include a subprocess-local proxy fixture (no user proxy setting changes), authenticated localhost CONNECT, bypass/direct routing, private/Fake-IP filtering, redirect destination validation, proxy failures, localized error UI and the successful document sandbox. Optional live smoke mode on `preview_proxy_tests::system_proxy_probe` is activated only with `VPASTE_TEST_PREVIEW_PROXY_PROBE=live-system`.
