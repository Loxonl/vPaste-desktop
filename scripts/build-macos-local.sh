#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS packages must be built on macOS." >&2
  exit 1
fi

npx tauri build --bundles app --config src-tauri/tauri.local.conf.json
bundle_dir="src-tauri/target/release/bundle"
app="${bundle_dir}/macos/vPaste.app"
version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
arch="$(uname -m)"
if [[ "$arch" == "arm64" ]]; then arch="aarch64"; fi
bash scripts/package-macos-dmg.sh "$app" "${bundle_dir}/dmg/vPaste_${version}_${arch}.dmg" "-"
