# Mac App Store build

The Mac App Store edition is a separate compile time variant of vPaste. It checks the public App Store listing for Apple ID `6824847075` and sends the user to the App Store application to install an update. The direct DMG edition keeps its signed in-app updater. The build command creates a signed `.pkg` for App Store Connect; it does not upload it.

The App Store edition requires macOS 13 or later because its sandboxed background service and login item use `SMAppService`. The direct DMG edition continues to support macOS 11 or later.

The App Store sandbox uses a separate application data container. When moving from the DMG edition, export history in the old app and import it in the App Store edition; the build does not migrate history automatically.

## Prerequisites

- macOS with Xcode command line tools, Node 24, npm 11, Rust 1.91.1, and both `aarch64-apple-darwin` and `x86_64-apple-darwin` targets.
- An **Apple Distribution** signing certificate and a **Mac Installer Distribution** signing certificate in the build keychain.
- A **Mac App Store** provisioning profile for bundle ID `com.loxonl.vpaste` and the same Apple Team ID as the signing certificate.
- The App Store Connect listing with Apple ID `6824847075`. The listing must be publicly available before the in-app lookup can report a newer version.

## Build

Set these variables in the build shell (keep the profile and signing keys outside the repository):

```sh
export APP_STORE_TEAM_ID='YOURTEAMID'
export APP_STORE_PROFILE='/absolute/path/to/vPaste_App_Store.provisionprofile'
export APP_STORE_APP_SIGNING_IDENTITY='Apple Distribution: Your Name (YOURTEAMID)'
export APP_STORE_INSTALLER_SIGNING_IDENTITY='Mac Installer Distribution: Your Name (YOURTEAMID)'
export APP_STORE_COPYRIGHT='Copyright 2026 Your Name'
export APP_STORE_USES_NON_EXEMPT_ENCRYPTION=false
npm ci
npm run build:macos-app-store
```

`VPASTE_APP_STORE_ID` defaults to `6824847075`; set it explicitly only if the App Store Connect item changes. Set `APP_STORE_USES_NON_EXEMPT_ENCRYPTION` to the value appropriate for the app's actual export-compliance declaration. The signed result is `src-tauri/target/app-store-build/vPaste_1.6.0_mac_app_store.pkg`, or the path in `OUTPUT_PATH`.

The command checks the provisioning profile, signs the sandboxed app and installer, verifies both signatures, and ensures the background service LaunchAgent remains bundled for onboarding. It disables updater archives, the direct feed, and the Tauri updater plugin for this edition. The app uses a separate `mac-app-store` Cargo feature and temporarily removes the macOS private API feature from its build manifest, then restores the direct edition's manifest. The App Store listing lookup uses the Mac's region and treats a missing or unavailable listing as a check error.

## GitHub Actions

The [Build Mac App Store package](../../.github/workflows/mac-app-store.yml) workflow runs when a stable `vX.Y.Z` tag is pushed for a commit on `main`. It skips `-rc.N` tags because App Store release versions use three numeric components. It sets the build version from the tag, uses the `release` environment, builds the universal app on `macos-14`, and saves the signed `.pkg` as a GitHub Actions artifact for seven days. It does not upload or submit the package to App Store Connect. The existing Developer ID DMG workflow is separate.

Configure these **environment secrets** under GitHub **Settings → Environments → release**:

| Name | Value |
| --- | --- |
| `APP_STORE_APP_CERTIFICATE_BASE64` | Base64 contents of the `.p12` containing the **Apple Distribution** certificate and private key. |
| `APP_STORE_APP_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12`. |
| `APP_STORE_INSTALLER_CERTIFICATE_BASE64` | Base64 contents of the `.p12` containing the **Mac Installer Distribution** certificate and private key. |
| `APP_STORE_INSTALLER_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12`. |
| `APP_STORE_PROFILE_BASE64` | Base64 contents of the Mac App Store distribution `.provisionprofile` for `com.loxonl.vpaste`. |

On macOS, `base64 -i /absolute/path/to/file.p12 | pbcopy` copies a file's Base64 contents for pasting into a secret. Run it separately for each `.p12` and the provisioning profile. Keep the original files and passwords outside the repository.

Configure these **environment variables** in the same `release` environment:

| Name | Value |
| --- | --- |
| `APP_STORE_TEAM_ID` | The ten-character Apple Developer Team ID used by both certificates and the profile. |
| `APP_STORE_COPYRIGHT` | The copyright notice to put in the app's About panel, for example `Copyright 2026 Your Name`. |
| `APP_STORE_USES_NON_EXEMPT_ENCRYPTION` | `true` or `false`, matching the app's export-compliance declaration. |

The workflow discovers the signing identity names from the imported certificates. Existing `APPLE_CERTIFICATE` / Developer ID secrets are for the direct DMG build and cannot sign the App Store package. After configuring the settings and merging the workflow, push a new stable version tag such as `v1.7.0` to run it, then download the `mac-app-store-v1.7.0` artifact when the job succeeds. The tag's source commit must contain this workflow. A successful local build or Actions artifact still needs signed sandbox testing before submission.

Install and exercise the signed build on a clean test Mac before submission, including clipboard capture, paste Accessibility permission, global shortcuts, background service approval, file import/export, and App Store handoff. App Store review and release availability cannot be verified by local packaging alone.
