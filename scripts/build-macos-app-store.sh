#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Mac App Store packages must be built on macOS." >&2
  exit 1
fi
export MACOSX_DEPLOYMENT_TARGET=13.0
export CARGO_PROFILE_RELEASE_LTO="${MACOS_RELEASE_LTO:-false}"
for name in APP_STORE_APP_SIGNING_IDENTITY APP_STORE_INSTALLER_SIGNING_IDENTITY; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required for Mac App Store packaging." >&2
    exit 1
  fi
done
if [[ "${APP_STORE_APP_SIGNING_IDENTITY}" != *"Apple Distribution:"* ]]; then
  echo "APP_STORE_APP_SIGNING_IDENTITY must name an Apple Distribution certificate." >&2
  exit 1
fi
if [[ "${APP_STORE_INSTALLER_SIGNING_IDENTITY}" != *"Mac Installer Distribution:"* ]]; then
  echo "APP_STORE_INSTALLER_SIGNING_IDENTITY must name a Mac Installer Distribution certificate." >&2
  exit 1
fi
for name in APP_STORE_APP_SIGNING_IDENTITY APP_STORE_INSTALLER_SIGNING_IDENTITY; do
  if [[ "${!name}" != *"(${APP_STORE_TEAM_ID:-})" ]]; then
    echo "$name must belong to APP_STORE_TEAM_ID." >&2
    exit 1
  fi
done

build_dir="src-tauri/target/app-store-build"
export VPASTE_APP_STORE_ID="${VPASTE_APP_STORE_ID:-6824847075}"
config_path="$(node scripts/prepare-macos-app-store.mjs "$build_dir")"
profile_plist="$(mktemp)"
manifest_backup=""
cleanup() {
  if [[ -n "$manifest_backup" ]]; then
    if cp "$manifest_backup" src-tauri/Cargo.toml; then
      rm -f "$manifest_backup"
    else
      echo "Could not restore src-tauri/Cargo.toml; backup: $manifest_backup" >&2
    fi
  fi
  rm -f "$profile_plist"
}
trap cleanup EXIT
security cms -D -i "$build_dir/embedded.provisionprofile" > "$profile_plist"
python3 - "$profile_plist" "$APP_STORE_TEAM_ID" "com.loxonl.vpaste" <<'PY'
import datetime
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    profile = plistlib.load(source)
team_id, bundle_id = sys.argv[2:]
actual_team_ids = profile.get("TeamIdentifier", [])
actual_app_id = profile.get("Entitlements", {}).get("com.apple.application-identifier")
allows_debugging = profile.get("Entitlements", {}).get("get-task-allow")
expires = profile.get("ExpirationDate")
if team_id not in actual_team_ids or actual_app_id != f"{team_id}.{bundle_id}":
    raise SystemExit("Provisioning profile does not match APP_STORE_TEAM_ID and bundle identifier")
if allows_debugging is not False or profile.get("ProvisionedDevices") or profile.get("ProvisionsAllDevices"):
    raise SystemExit("An App Store distribution provisioning profile is required")
if not expires or expires <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
    raise SystemExit("Provisioning profile has expired")
PY

export APPLE_SIGNING_IDENTITY="$APP_STORE_APP_SIGNING_IDENTITY"
export VPASTE_PUBLIC_UPDATE_FEED=0
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

manifest_backup="$(mktemp)"
if ! cp src-tauri/Cargo.toml "$manifest_backup"; then
  rm -f "$manifest_backup"
  manifest_backup=""
  exit 1
fi
cp "$build_dir/Cargo.appstore.toml" src-tauri/Cargo.toml
npx tauri build --ci --bundles app --target universal-apple-darwin --features mac-app-store --config "$config_path"
cp "$manifest_backup" src-tauri/Cargo.toml
rm -f "$manifest_backup"
manifest_backup=""

app="src-tauri/target/universal-apple-darwin/release/bundle/macos/vPaste.app"
if [[ ! -d "$app" ]]; then
  echo "Mac App Store app bundle was not produced: $app" >&2
  exit 1
fi
architectures="$(lipo -archs "$app/Contents/MacOS/vPaste")"
if [[ " $architectures " != *" arm64 "* || " $architectures " != *" x86_64 "* ]]; then
  echo "Mac App Store app must contain both arm64 and x86_64 architectures: $architectures" >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$app"
signed_team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
if [[ "$signed_team" != "$APP_STORE_TEAM_ID" ]]; then
  echo "The signed app's TeamIdentifier does not match APP_STORE_TEAM_ID." >&2
  exit 1
fi
codesign -d --entitlements :- "$app" > "$build_dir/actual-entitlements.plist" 2>/dev/null
python3 - "$build_dir/actual-entitlements.plist" "$APP_STORE_TEAM_ID" "com.loxonl.vpaste" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    entitlements = plistlib.load(source)
team_id, bundle_id = sys.argv[2:]
if entitlements.get("com.apple.security.app-sandbox") is not True:
    raise SystemExit("The signed App Store bundle is missing App Sandbox")
if entitlements.get("com.apple.application-identifier") != f"{team_id}.{bundle_id}":
    raise SystemExit("The signed App Store bundle has the wrong application identifier")
if entitlements.get("com.apple.security.network.client") is not True:
    raise SystemExit("The signed App Store bundle cannot check the App Store listing")
if entitlements.get("com.apple.security.files.user-selected.read-write") is not True:
    raise SystemExit("The signed App Store bundle cannot use import/export file selections")
PY
if [[ ! -e "$app/Contents/Library/LaunchAgents/com.loxonl.vpaste.background.plist" ]]; then
  echo "The App Store bundle is missing the background service needed by onboarding." >&2
  exit 1
fi

version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
output_path="${OUTPUT_PATH:-$build_dir/vPaste_${version}_mac_app_store.pkg}"
mkdir -p "$(dirname "$output_path")"
xcrun productbuild --sign "$APP_STORE_INSTALLER_SIGNING_IDENTITY" --component "$app" /Applications "$output_path"
pkgutil --check-signature "$output_path"
echo "Mac App Store submission package: $output_path"
