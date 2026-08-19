# Third-Party Notices and Attribution

vPaste Desktop is licensed under GPL-3.0-only. It also uses third-party open-source packages from the JavaScript and Rust ecosystems.

This document records public attribution notes for the clean repository. The lockfiles remain the source of truth for exact package versions:

- `package-lock.json` for npm packages.
- `src-tauri/Cargo.lock` for Rust crates.

The Release workflow runs `npm run check:licenses` and publishes `THIRD_PARTY_LICENSES.json`, generated from both lockfiles, with every binary release. A custom, missing, or denied third-party license fails the workflow and requires explicit review.

## Direct npm Dependencies

The current lockfile resolves these direct npm dependencies:

| Package | Version | License | Scope |
|---|---:|---|---|
| `@emotion/react` | 11.14.0 | MIT | runtime |
| `@emotion/styled` | 11.14.1 | MIT | runtime |
| `@mui/icons-material` | 5.18.0 | MIT | runtime |
| `@mui/material` | 5.18.0 | MIT | runtime |
| `@tauri-apps/api` | 2.11.0 | Apache-2.0 OR MIT | runtime |
| `@tauri-apps/plugin-cli` | 2.4.1 | MIT OR Apache-2.0 | runtime |
| `@tauri-apps/plugin-dialog` | 2.7.1 | MIT OR Apache-2.0 | runtime |
| `@tauri-apps/plugin-global-shortcut` | 2.3.1 | MIT OR Apache-2.0 | runtime |
| `@tauri-apps/plugin-log` | 2.8.0 | MIT OR Apache-2.0 | runtime |
| `@tauri-apps/plugin-notification` | 2.3.3 | MIT OR Apache-2.0 | runtime |
| `@tauri-apps/plugin-process` | 2.3.1 | MIT OR Apache-2.0 | runtime |
| `material-icon-theme` | 5.37.0 | MIT | runtime |
| `motion` | 13.1.0 | MIT | runtime |
| `react` | 18.3.1 | MIT | runtime |
| `react-dom` | 18.3.1 | MIT | runtime |
| `react-router-dom` | 6.30.4 | MIT | runtime |
| `@tauri-apps/cli` | 2.11.2 | Apache-2.0 OR MIT | development |
| `@types/react` | 18.3.27 | MIT | development |
| `@types/react-dom` | 18.3.7 | MIT | development |
| `@vitejs/plugin-react` | 6.0.3 | MIT | development |
| `typescript` | 5.9.3 | Apache-2.0 | development |
| `vite` | 8.1.4 | MIT | development |

## npm Attribution Notes

The current npm graph uses 0BSD, Apache-2.0, BSD-3-Clause, ISC, MIT, and MPL-2.0 license expressions. The generated Release inventory records the exact package, version, scope, and expression from the lockfile.

## Rust Dependency Notes

The Rust/Tauri side uses direct crates listed in `src-tauri/Cargo.toml`, with resolved versions in `src-tauri/Cargo.lock`. Most direct Rust dependencies are MIT, Apache-2.0, MIT/Apache dual licensed, ISC, or similarly permissive licenses.

Notable attribution or license-selection items from the current locked dependency graph:

| Crate(s) | License | Notice |
|---|---|---|
| `cssparser`, `selectors`, `cssparser-macros`, `dtoa-short`, `option-ext` | MPL-2.0 | Keep MPL-2.0 notices and source-file license obligations in release attribution. |
| `r-efi` | MIT OR Apache-2.0 OR LGPL-2.1-or-later | vPaste selects the MIT/Apache-2.0 licensing path for distribution notices. |
| ICU crates, including `icu_collections`, `icu_locale_core`, `icu_normalizer`, `icu_properties`, `icu_provider`, and data crates | Unicode-3.0 | Include Unicode license attribution in binary-release notices when these crates are present. |
| `unicode-ident` | (MIT OR Apache-2.0) AND Unicode-3.0 | Include Unicode license attribution. |
| `webpki-root-certs` | CDLA-Permissive-2.0 | Include CDLA-Permissive-2.0 attribution. |
| `clipboard-win` | BSL-1.0 | Windows clipboard dependency; include Boost Software License attribution. |
| `libfuzzer-sys` | (MIT OR Apache-2.0) AND NCSA | Include NCSA attribution if the crate remains in the locked graph. |

## Installer Tooling

Windows packages are compiled with Inno Setup 6.7.3. Its bundled `license.txt` grants use for any purpose, including commercial applications, subject to preservation and origin requirements. The official project also requests commercial users to purchase a commercial license, and the unregistered compiler identifies builds as non-commercial; commercial vPaste releases must clear that gate before publishing.

The Simplified Chinese Inno messages are downloaded from the official `jrsoftware/issrc` `is-6_7_3` tag during the build and accepted only when SHA-256 equals `7d544b9bb1d142cfa11f2e5d3cc8abe2e55f8e066c5124e3772675aa236e1278`. The translation file credits its maintainer in the source comments retained by the build cache.

## Release Maintainer Checklist

Before publishing official binary artifacts:

1. Run `npm run check:licenses` and review the generated Release inventory.
2. Confirm this document still covers all non-MIT/Apache/ISC/BSD attribution items.
3. Include the applicable third-party notices with release artifacts or link to this document from the release notes.
4. Review every newly introduced custom or reciprocal license before merging the dependency change.
