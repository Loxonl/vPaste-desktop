#!/usr/bin/env bash
set -euo pipefail

tag="${1:?Usage: upload-published-release-assets.sh <tag> <assets-directory>}"
assets_dir="${2:?Usage: upload-published-release-assets.sh <tag> <assets-directory>}"
if [[ ! -d "$assets_dir" ]]; then
  echo "Release assets directory not found: $assets_dir" >&2
  exit 1
fi

assets=()
while IFS= read -r -d '' asset; do
  assets+=("$asset")
done < <(find "$assets_dir" -maxdepth 1 -type f -print0)
if [[ "${#assets[@]}" -eq 0 ]]; then
  echo "No release assets were staged." >&2
  exit 1
fi

if ! release_json="$(gh release view "$tag" --json isDraft,isImmutable,assets)"; then
  echo "Existing release $tag was not found; no release was created." >&2
  exit 1
fi
if [[ "$(jq -r '.isDraft' <<<"$release_json")" != "false" ]]; then
  echo "Release $tag is still a draft; publish it before uploading packages." >&2
  exit 1
fi
if [[ "$(jq -r '.isImmutable' <<<"$release_json")" != "false" ]]; then
  echo "Cannot upload packages to immutable release $tag." >&2
  exit 1
fi

new_assets=()
for asset in "${assets[@]}"; do
  name="$(basename "$asset")"
  remote_digest="$(jq -r --arg name "$name" '.assets[] | select(.name == $name) | .digest // ""' <<<"$release_json")"
  if [[ -z "$remote_digest" ]]; then
    if jq -e --arg name "$name" '.assets[] | select(.name == $name)' <<<"$release_json" >/dev/null; then
      echo "Release asset $name has no digest; refusing to replace it." >&2
      exit 1
    fi
    new_assets+=("$asset")
    continue
  fi

  local_digest="sha256:$(sha256sum "$asset" | awk '{print $1}')"
  if [[ "$remote_digest" != "$local_digest" ]]; then
    echo "Release asset $name has a different digest; refusing to replace it." >&2
    exit 1
  fi
  echo "Release asset $name already matches; skipping."
done

if [[ "${#new_assets[@]}" -gt 0 ]]; then
  gh release upload "$tag" "${new_assets[@]}"
fi
