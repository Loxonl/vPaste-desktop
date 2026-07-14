#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://downloads.vpaste.app/macos}"
VERSION="${VERSION:-}"
NOTES_PATH="${NOTES_PATH:-}"
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
export MACOSX_DEPLOYMENT_TARGET
OUTPUT_PATH="${OUTPUT_PATH:-}"
SKIP_STAPLING="${SKIP_STAPLING:-}"
UNSIGNED="${UNSIGNED:-}"
MACOS_RELEASE_LTO="${MACOS_RELEASE_LTO:-false}"
unsigned_build=false

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS release packages must be built on macOS." >&2
  exit 1
fi

if [[ "${UNSIGNED}" == "1" || "${UNSIGNED}" == "true" ]]; then
  unsigned_build=true
fi

if [[ "${unsigned_build}" == false && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -n "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "${TAURI_SIGNING_PRIVATE_KEY}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY}"
  unset TAURI_SIGNING_PRIVATE_KEY
fi

if [[ "${unsigned_build}" == false && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  default_key="${HOME}/.tauri/vpaste-updater-ci.key"
  if [[ -f "${default_key}" ]]; then
    export TAURI_SIGNING_PRIVATE_KEY_PATH="${default_key}"
  else
    echo "Updater signing key is not set and ${default_key} does not exist." >&2
    exit 1
  fi
fi

export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

if [[ "${unsigned_build}" == false && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "${TAURI_SIGNING_PRIVATE_KEY_PATH}")"
fi

if [[ -z "${VERSION}" ]]; then
  VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
fi

build_args=(tauri build --ci -b app,dmg)
if [[ -n "${MACOS_BUILD_TARGET}" ]]; then
  build_args+=("--target" "${MACOS_BUILD_TARGET}")
fi
if [[ "${SKIP_STAPLING}" == "1" || "${SKIP_STAPLING}" == "true" ]]; then
  build_args+=("--skip-stapling")
fi
if [[ "${unsigned_build}" == true ]]; then
  build_args+=("--config" '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-","hardenedRuntime":false,"dmg":{"windowSize":{"width":660,"height":420},"appPosition":{"x":170,"y":170},"applicationFolderPosition":{"x":490,"y":170}}}}}')
fi

release_dir="src-tauri/target/release"
if [[ -n "${MACOS_BUILD_TARGET}" ]]; then
  release_dir="src-tauri/target/${MACOS_BUILD_TARGET}/release"
fi

clean_window_vibrancy_release_cache() {
  cargo clean --manifest-path src-tauri/Cargo.toml -p window-vibrancy >/dev/null 2>&1 || true
  rm -rf "${release_dir}/.fingerprint"/window-vibrancy-* 2>/dev/null || true
  rm -f "${release_dir}/deps"/libwindow_vibrancy-*.rlib 2>/dev/null || true
  rm -f "${release_dir}/deps"/libwindow_vibrancy-*.rmeta 2>/dev/null || true
  rm -f "${release_dir}/deps"/window_vibrancy-*.d 2>/dev/null || true
}

# macOS release builds can fail in LTO while reading stale dependency bitcode,
# especially after Rust or Xcode updates. Disable LTO by default for packaging;
# set MACOS_RELEASE_LTO=true to opt back into the Cargo.toml release profile.
export CARGO_PROFILE_RELEASE_LTO="${MACOS_RELEASE_LTO}"
clean_window_vibrancy_release_cache

build_log="$(mktemp)"
run_tauri_build() {
  npx "${build_args[@]}" 2>&1 | tee "${build_log}"
  return "${PIPESTATUS[0]}"
}

if ! run_tauri_build; then
  if grep -q "failed to load bitcode" "${build_log}" && grep -q "window_vibrancy" "${build_log}"; then
    echo "Detected stale window-vibrancy bitcode during release LTO; cleaning that package and retrying once." >&2
    clean_window_vibrancy_release_cache
    run_tauri_build
  else
    exit 1
  fi
fi
rm -f "${build_log}"

bundle_dir="src-tauri/target/release/bundle"
if [[ -n "${MACOS_BUILD_TARGET}" ]]; then
  bundle_dir="src-tauri/target/${MACOS_BUILD_TARGET}/release/bundle"
fi

if [[ ! -d "${bundle_dir}" ]]; then
  echo "Bundle directory not found: ${bundle_dir}" >&2
  exit 1
fi

dmg_artifact="$(find "${bundle_dir}" -type f -path "*/dmg/*.dmg" -print | sort | tail -n 1)"
if [[ -z "${dmg_artifact}" ]]; then
  echo "DMG artifact not found under ${bundle_dir}" >&2
  exit 1
fi
echo "DMG artifact: ${dmg_artifact}"

if [[ "${unsigned_build}" == true ]]; then
  echo "Local ad-hoc signed macOS package build complete."
  echo "Updater archive, signature, and manifest were skipped because UNSIGNED=1."
  echo "Developer ID signing and notarization are still required for public distribution."
  exit 0
fi

updater_artifact="$(find "${bundle_dir}" -type f -name "*.app.tar.gz" -print | sort | tail -n 1)"
if [[ -z "${updater_artifact}" ]]; then
  echo "macOS updater archive (*.app.tar.gz) not found under ${bundle_dir}" >&2
  echo "Check that bundle.createUpdaterArtifacts is enabled in src-tauri/tauri.conf.json." >&2
  exit 1
fi
signature="${updater_artifact}.sig"

if [[ ! -f "${signature}" ]]; then
  signer_args=(tauri signer sign)
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    signer_args+=("-f" "${TAURI_SIGNING_PRIVATE_KEY_PATH}")
  else
    signer_args+=("-k" "${TAURI_SIGNING_PRIVATE_KEY}")
  fi
  signer_args+=("--password=${TAURI_SIGNING_PRIVATE_KEY_PASSWORD}" "${updater_artifact}")
  npx "${signer_args[@]}"
fi

if [[ ! -f "${signature}" ]]; then
  echo "Updater signature not found: ${signature}" >&2
  exit 1
fi

host_arch="$(uname -m)"
case "${MACOS_BUILD_TARGET:-${host_arch}}" in
  universal-apple-darwin)
    platform_keys="darwin-aarch64,darwin-x86_64"
    ;;
  aarch64-apple-darwin|arm64)
    platform_keys="darwin-aarch64"
    ;;
  x86_64-apple-darwin|x86_64)
    platform_keys="darwin-x86_64"
    ;;
  *)
    echo "Unsupported macOS release target: ${MACOS_BUILD_TARGET:-${host_arch}}" >&2
    exit 1
    ;;
esac

if [[ -z "${OUTPUT_PATH}" ]]; then
  OUTPUT_PATH="${bundle_dir}/updater/latest.json"
fi

manifest_args=(
  scripts/generate-macos-updater-manifest.mjs
  --base-url "${BASE_URL}"
  --version "${VERSION}"
  --artifact "${updater_artifact}"
  --signature "${signature}"
  --platform-keys "${platform_keys}"
  --output "${OUTPUT_PATH}"
)
if [[ -n "${NOTES_PATH}" ]]; then
  manifest_args+=(--notes-path "${NOTES_PATH}")
fi

node "${manifest_args[@]}"

echo "Updater artifact: ${updater_artifact}"
echo "Updater signature: ${signature}"
echo "Updater manifest: ${OUTPUT_PATH}"
