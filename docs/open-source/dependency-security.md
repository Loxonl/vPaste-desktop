# Dependency Security

GitHub Dependabot alerts track published dependency advisories. A package in the cross-platform Cargo lockfile may not be compiled for every supported platform; check both the dependency path and the affected API before assessing application impact.

## TLS Remediation

The October 2026 remediation removes `rumqttc`, which was declared but not referenced by application code. This also removes `rustls-webpki` 0.102.8 and the old Rustls 0.22 stack. No MQTT feature or other application behavior is removed.

The updater's remaining TLS stack resolves to `rustls` 0.23.45 and `rustls-webpki` 0.103.15. This addresses [GHSA-2mjx-qc3c-rqvc](https://github.com/rustls/rustls/security/advisories/GHSA-2mjx-qc3c-rqvc) and the four WebPKI alerts, including [GHSA-82j2-j2ch-gfr8](https://github.com/rustls/webpki/security/advisories/GHSA-82j2-j2ch-gfr8).

`tests/unit/scripts/dependencySecurity.test.ts` checks every locked copy of these packages against the patched version floors. It prevents reintroducing these known vulnerable versions; it does not replace Dependabot or detect newly published advisories.

## Remaining Upstream Alerts

These alerts remain open. They have not been dismissed or declared fixed.

| Dependency / advisory | Current dependency path and exposure | Follow-up |
|---|---|---|
| `lru` 0.12.5 / [RUSTSEC-2026-0002](https://rustsec.org/advisories/RUSTSEC-2026-0002.html) | Tantivy 0.22.1 requires `lru` 0.12. The advisory affects `IterMut`. The locked Tantivy source uses `LruCache` only in its stored-document block cache, with `get`, `put`, and `len`; it does not call the affected iterator. | Adopt an upstream fix or a compatible reviewed backport. An upgrade to a newer Tantivy release must verify existing search-index readability, search results, and pagination before shipping. |
| `glib` 0.18.5 / [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | GTK/Tauri's Linux dependency graph requires `glib` 0.18. Target-filtered Cargo trees contain no `glib` for Windows or macOS, the currently supported platforms. | Follow a compatible upstream GTK/Tauri fix. Reassess this advisory before adding Linux support; do not force an incompatible GLib version into the framework. |

The source reviewed for the LRU assessment is [Tantivy 0.22.1's stored-document reader](https://github.com/quickwit-oss/tantivy/blob/0.22.1/src/store/reader.rs), together with its [dependency constraints](https://github.com/quickwit-oss/tantivy/blob/0.22.1/Cargo.toml). Reassess API reachability whenever the search implementation or its dependencies change.

## Verification

Run `npm run test:unit`, `npm run check:licenses`, and the existing Windows/macOS PR checks after changing these dependencies. Use `cargo tree --locked --manifest-path src-tauri/Cargo.toml --target <target> -i <package>` to check platform reachability. After merging, confirm the affected Dependabot alerts are marked fixed on the default branch.
