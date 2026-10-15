"""Compact staged release metadata without changing any application package."""

import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlparse
import zipfile


def prepare(assets: Path, version: str, manifest: Path | None = None) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-rc\.\d+)?", version):
        raise ValueError("Expected a stable or RC version without the v prefix")
    metadata = {
        name: assets / name
        for name in (
            "LICENSE", "third-party-notices.md", "THIRD_PARTY_LICENSES.json",
            f"vPaste_{version}_sbom.cdx.json",
        )
    }
    for name, file in metadata.items():
        if not file.is_file():
            raise ValueError(f"Required release metadata is missing: {name}")

    if manifest is not None:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if data["version"] != version:
            raise ValueError("Updater manifest version does not match the release")
        if set(data["platforms"]) != {"windows-x86_64", "darwin-aarch64", "darwin-x86_64"}:
            raise ValueError("Updater manifest must contain all three update platforms")
        for entry in data["platforms"].values():
            name = unquote(urlparse(entry["url"]).path.rsplit("/", 1)[-1])
            if not name or "/" in name or "\\" in name or name in {".", ".."}:
                raise ValueError("Invalid updater package name")
            signature = assets / f"{name}.sig"
            if not (assets / name).is_file() or not signature.is_file():
                raise ValueError(f"Updater package or signature is missing: {name}")
            if not entry["signature"].strip() or signature.read_text(encoding="utf-8").strip() != entry["signature"].strip():
                raise ValueError(f"Updater signature does not match the manifest: {name}")
        metadata["latest.json"] = manifest

    for signature in assets.glob("*.sig"):
        metadata[signature.name] = signature

    # Fixed ZIP timestamps and sorted members make retries byte-for-byte stable.
    archive = assets / f"vPaste_{version}_release-metadata.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, file in sorted(metadata.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, file.read_bytes())

    for name, file in metadata.items():
        if name != "latest.json":
            file.unlink()
    # The original WinGet manifest remains in the Windows Actions artifact.
    (assets / "Loxonl.vPaste.yaml").unlink(missing_ok=True)
    checksums = []
    for file in sorted(assets.iterdir()):
        if file.is_file() and file.name != "SHA256SUMS.txt":
            with file.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            checksums.append(f"{digest}  {file.name}")
    (assets / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="ascii")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    prepare(args.assets_dir, args.version, args.manifest)
    print(f"Prepared compact release assets in {args.assets_dir}")
