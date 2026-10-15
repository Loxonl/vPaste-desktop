# Update Feed Publication and Client Update Behavior

This page covers how a published Release reaches the public updater manifest
and how the desktop client prepares and installs updates.

## Channels

| Tag | Channel | Website file | Public URL |
| --- | --- | --- | --- |
| `vX.Y.Z` | Stable | `download/stable/latest.json` | `https://vpaste.app/download/stable/latest.json` |
| `vX.Y.Z-rc.N` | RC (testing) | `download/rc/latest.json` | `https://vpaste.app/download/rc/latest.json` |

The channel comes from the tag, and the client built from that tag checks the
same channel (`VPASTE_UPDATE_CHANNEL`). Publishing a Release always updates
that channel's manifest; there is no separate publication switch. Users have no
channel setting.

`VPASTE_PUBLIC_UPDATE_FEED=1` is a compile-time env set by `tag-release.yml`
for published Releases so the built client checks the public feed. Private
Draft and normal local builds leave it unset, so the client reports "online
updates are not enabled" and never contacts production.

Debug builds keep using `VPASTE_DEBUG_UPDATE_ENDPOINT` for a locally signed
test feed. Do not point it at, or modify, the production manifests to simulate
an upgrade.

## Publication flow

`tag-release.yml` (job "Upload packages to published release") runs, in order:

1. Build, sign and notarize the platform packages; merge and validate the
   updater manifest fragments; verify every package signature locally.
2. Archive licenses, SBOM, detached signatures, and a manifest snapshot in
   `vPaste_<version>_release-metadata.zip`; keep the installer and updater
   packages directly downloadable. Generate checksums for the final public
   assets, upload them, and confirm the Release lists every package the manifest
   references. Normalize bilingual notes to `## English` before `## 中文`, then
   append or refresh the English-first download table at the end of the Release
   notes. Existing handwritten content is preserved.
3. `scripts/publish-updater-manifest.mjs`:
   - rejects channel mismatches (Stable never publishes `-rc` versions, RC only
     publishes `-rc` versions);
   - compares each manifest entry with the staged package and its `.sig`;
   - downloads every referenced package **without credentials** and requires
     the exact staged size and SHA-256 (a 200 or HEAD response is not enough);
   - reads `download/<channel>/latest.json` from `Loxonl/vPaste-website@main`:
     a newer remote version fails the run, an identical re-run is a no-op, and
     the same version with different packages or signatures fails;
   - writes only that file, conditional on the remote blob it compared, so a
     concurrent publication fails with a conflict instead of being overwritten;
   - polls `https://vpaste.app/download/<channel>/latest.json` until the
     public site serves the new release (about 10 minutes), and fails otherwise.

Any failing step stops the job before the website manifest changes.

## One-time setup

The workflow's own `GITHUB_TOKEN` cannot write to another repository, so the
website write needs its own credential. Without it, the publish step fails and
the website manifest stays unchanged.

1. Create a fine-grained token limited to `Loxonl/vPaste-website` with
   **Contents: read and write** and nothing else. Store it as the `release`
   environment secret `VPASTE_WEBSITE_RELEASE_TOKEN` in this repository. It is
   passed only to the publish step and only sent to `api.github.com`; never
   place it in source, artifacts, or logs. Replace it before it expires.
2. The token's owner must be allowed to push directly to the website's `main`
   branch (no rule that requires a pull request for that path).
3. Confirm how `Loxonl/vPaste-website` is deployed (it previously served
   GitHub Pages from the root of `main`). If the branch or folder changes,
   update `--branch` in `tag-release.yml`.
4. Release assets must be anonymously downloadable; otherwise the anonymous
   download check fails and nothing is published.

Because publishing a Release now updates its channel immediately, run the
manual validation in [release-checklist.md](release-checklist.md) on RC builds
before publishing a Stable Release.

## Recovering from a failed publication

- **Anonymous download mismatch or HTTP error:** fix the Release asset
  visibility or contents; never edit the manifest to point elsewhere. Re-run
  the job once the assets are correct.
- **"already points to newer":** a newer release is live. Do not force an older
  manifest; publish a new version instead.
- **"references different packages or signatures":** the same version was
  rebuilt. Bump to a new version rather than swapping packages under a
  published version.
- **"changed while publishing":** another publication won the race. Re-run
  after checking what the remote manifest now contains.
- **Public manifest did not update in time:** the commit succeeded but the
  site did not deploy. Check the website deployment, then re-run; the write
  step is idempotent and only the public check repeats.

## Client behavior

- The first automatic check runs about 60 seconds after launch, then once 24
  hours after the last **successful** check. A failed check never records a
  successful check time; retries back off 15 minutes → 1 hour → 6 hours and
  reset after a success. A system clock moved backwards does not stop checks.
- Manifest checks time out after 20 seconds (10 seconds to connect). Package
  downloads may take up to 30 minutes but fail after 60 seconds without data.
- The internal `update_check_enabled` setting still gates automatic checks and
  cancels an automatic download when turned off; manual checks still work.
- Updates download silently. A package becomes **ready** only after it is fully
  downloaded, its minisign signature verifies, and it is written to the update
  cache and verified again from disk. Downloads, partial files, signature or
  disk failures never show the ready entry.
- The cache lives in `<app local data>/updates/`: `<version>/<package>` plus
  `pending.json` (version, signature, platform target, file name, size, date,
  notes). `pending.json` is replaced only after the package is complete, so an
  interrupted write keeps the previous valid cache. Older caches are removed
  once a newer one is committed or the app already runs that version.
- When ready, a round blue sync icon appears right of the settings button in
  the main panel; clicking it asks for confirmation before installing. Settings
  and the tray offer the same "Update and restart" action. All three use one backend operation lock, so only one check,
  download, or install runs at a time.
- Installing re-verifies the cached package first. Windows launches the cached
  Inno Setup installer with the existing silent arguments and exits only after
  it starts; macOS installs through the Tauri updater and restarts. If the
  installer cannot start, the verified package stays ready to retry; if the
  cache is missing or modified, it is discarded and the user is asked to check
  again.
- Windows restores a valid cache offline at launch. macOS needs one manifest
  check to rebuild the Tauri install object (a limitation of
  `tauri-plugin-updater` 2.10.1), so the ready icon returns after the first
  successful check; that check is not delayed by the 24-hour interval. While
  offline the cache is kept but not offered.
- Windows shows its existing "update ready" notification at most once per
  version, including across restarts. macOS adds no notification.
- Portable builds only report the new version and link to the Release page.
