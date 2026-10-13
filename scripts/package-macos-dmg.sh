#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: $0 APP_PATH DMG_PATH SIGNING_IDENTITY" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
venv="${root}/src-tauri/target/.macos-dmg-venv"
if [[ ! -x "${venv}/bin/python" ]]; then
  python3 -m venv "${venv}"
fi
if ! "${venv}/bin/python" -c 'import importlib.metadata as m; assert all(m.version(name) == version for name, version in (("dmgbuild", "1.6.7"), ("ds_store", "1.3.3"), ("mac_alias", "2.2.3")))' >/dev/null 2>&1; then
  "${venv}/bin/python" -m pip install -r "${root}/scripts/requirements-macos-dmg.txt"
fi
build_args=(build --app "$1" --output "$2" --identity "$3")
if [[ "$3" != "-" && ( "${SKIP_STAPLING:-}" == "1" || "${SKIP_STAPLING:-}" == "true" ) ]]; then
  build_args+=(--skip-staple-validation)
fi
"${venv}/bin/python" "${root}/scripts/build-macos-dmg.py" "${build_args[@]}"
