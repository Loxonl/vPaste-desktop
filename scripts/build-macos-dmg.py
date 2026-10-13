#!/usr/bin/env python3
"""Build and inspect the macOS drag-to-Applications disk image."""

import argparse
import json
import os
import plistlib
import re
import struct
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LAYOUT = ROOT / "src-tauri" / "macos" / "dmg" / "layout.json"


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as image:
        header = image.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"{path} is not a PNG image")
    return struct.unpack(">II", header[16:24])


def inspect_layout(path: Path) -> dict:
    layout = json.loads(path.read_text(encoding="utf-8"))
    background = path.parent / layout["background"]
    retina = background.with_name(f"{background.stem}@2x{background.suffix}")
    window_size = (layout["windowSize"]["width"], layout["windowSize"]["height"])
    background_size = png_size(background)
    retina_size = png_size(retina)
    if background_size != window_size:
        raise ValueError(f"{background} must be {window_size[0]}x{window_size[1]}")
    expected_retina = (window_size[0] * 2, window_size[1] * 2)
    if retina_size != expected_retina:
        raise ValueError(f"{retina} must be {expected_retina[0]}x{expected_retina[1]}")
    return {
        "window_size": list(window_size),
        "icon_size": layout["iconSize"],
        "icon_locations": {
            "vPaste.app": [layout["appPosition"]["x"], layout["appPosition"]["y"]],
            "Applications": [layout["applicationFolderPosition"]["x"], layout["applicationFolderPosition"]["y"]],
        },
        "background_size": list(background_size),
        "retina_size": list(retina_size),
    }


def build_settings(app: Path, layout_path: Path) -> dict:
    if not app.is_dir() or app.name != "vPaste.app":
        raise ValueError(f"Expected vPaste.app directory: {app}")
    layout = inspect_layout(layout_path)
    return {
        "files": [str(app)],
        "symlinks": {"Applications": "/Applications"},
        "background": str(layout_path.parent / json.loads(layout_path.read_text(encoding="utf-8"))["background"]),
        "icon_locations": {name: tuple(position) for name, position in layout["icon_locations"].items()},
        "window_rect": ((100, 100), tuple(layout["window_size"])),
        "icon_size": layout["icon_size"],
        "default_view": "icon-view",
        "format": "UDZO",
        "filesystem": "HFS+",
    }


def tiff_sizes(path: Path) -> list[tuple[int, int]]:
    result = subprocess.run(["tiffutil", "-info", str(path)], check=True, capture_output=True, text=True)
    return [(int(width), int(height)) for width, height in re.findall(r"Image Width: (\d+) Image Length: (\d+)", result.stdout)]


def verify_mounted_volume(mount: Path, layout_path: Path, require_staple: bool = False) -> None:
    from ds_store import DSStore
    from mac_alias import Alias

    layout = inspect_layout(layout_path)
    app = mount / "vPaste.app"
    if not app.is_dir() or not (app / "Contents" / "Info.plist").is_file():
        raise ValueError("DMG does not contain vPaste.app with Info.plist")
    applications = mount / "Applications"
    if not applications.is_symlink() or os.readlink(applications) != "/Applications":
        raise ValueError("DMG Applications link must target /Applications")
    background = mount / ".background.tiff"
    if not background.is_file():
        raise ValueError("DMG Retina background .background.tiff is missing")
    if tiff_sizes(background) != [tuple(layout["background_size"]), tuple(layout["retina_size"])]:
        raise ValueError("DMG background TIFF does not contain the expected normal and Retina sizes")
    ds_store = mount / ".DS_Store"
    if not ds_store.is_file():
        raise ValueError("DMG Finder layout .DS_Store is missing")
    with DSStore.open(str(ds_store), "r") as store:
        bounds = store["."]["bwsp"]["WindowBounds"]
        width, height = layout["window_size"]
        if bounds != f"{{{{100, 100}}, {{{width}, {height}}}}}":
            raise ValueError(f"DMG Finder window bounds differ: {bounds}")
        icon_view = store["."]["icvp"]
        if icon_view["backgroundType"] != 2 or not icon_view.get("backgroundImageAlias"):
            raise ValueError("DMG Finder background reference is missing")
        if icon_view["iconSize"] != layout["icon_size"] or icon_view["arrangeBy"] != "none":
            raise ValueError("DMG Finder icon view settings differ")
        if store["."]["icvl"][1] != b"icnv":
            raise ValueError("DMG does not open in icon view")
        for name, location in layout["icon_locations"].items():
            if tuple(store[name]["Iloc"]) != tuple(location):
                raise ValueError(f"DMG Finder icon location differs for {name}")
        try:
            alias = Alias.from_bytes(icon_view["backgroundImageAlias"])
            alias_matches = (
                os.fsdecode(alias.target.filename) == background.name
                and alias.target.cnid == background.stat().st_ino
            )
        except Exception as error:
            raise ValueError("DMG Finder background alias is invalid") from error
        if not alias_matches:
            raise ValueError("DMG Finder background alias does not target .background.tiff")
    executable = app / "Contents" / "MacOS" / "vPaste"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError("DMG app executable is missing or not executable")
    try:
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as error:
        raise ValueError(f"DMG app code signature is invalid: {error.stderr.strip()}") from error
    if require_staple:
        try:
            subprocess.run(["xcrun", "stapler", "validate", str(app)], check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            raise ValueError(f"DMG app has no valid stapled notarization ticket: {error.stderr.strip()}") from error


def mount_device(entities: list[dict], mount: Path) -> str:
    for entity in entities:
        path = entity.get("mount-point")
        if path and Path(path).resolve() == mount.resolve():
            return entity["dev-entry"]
    raise ValueError(f"hdiutil did not mount at {mount}")


def verify_dmg(dmg: Path, layout_path: Path, require_staple: bool = False) -> None:
    if not dmg.is_file():
        raise ValueError(f"DMG not found: {dmg}")
    with tempfile.TemporaryDirectory(prefix="vpaste-dmg-verify-") as directory:
        mount = Path(directory) / "volume"
        mount.mkdir()
        attached = subprocess.run(
            ["hdiutil", "attach", "-plist", "-nobrowse", "-readonly", "-mountpoint", str(mount), str(dmg)],
            check=True,
            capture_output=True,
        )
        entities = plistlib.loads(attached.stdout)["system-entities"]
        attached_devices = [entity["dev-entry"] for entity in entities if entity.get("mount-point")]
        try:
            mount_device(entities, mount)
            verify_mounted_volume(mount, layout_path, require_staple)
        finally:
            for device in attached_devices:
                subprocess.run(["hdiutil", "detach", device], check=True)


def build_dmg(app: Path, output: Path, identity: str, layout_path: Path, skip_staple_validation: bool = False) -> None:
    import dmgbuild

    settings = build_settings(app, layout_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    dmgbuild.build_dmg(str(output), "vPaste", settings=settings)
    sign_command = ["codesign", "--force", "--sign", identity]
    if identity != "-":
        sign_command.append("--timestamp")
    subprocess.run([*sign_command, str(output)], check=True)
    subprocess.run(["codesign", "--verify", "--strict", str(output)], check=True)
    verify_dmg(output, layout_path, require_staple=identity != "-" and not skip_staple_validation)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT)
    build = commands.add_parser("build")
    build.add_argument("--app", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--identity", required=True)
    build.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT)
    build.add_argument("--skip-staple-validation", action="store_true")
    verify = commands.add_parser("verify")
    verify.add_argument("--dmg", type=Path, required=True)
    verify.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT)
    verify.add_argument("--require-staple", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            print(json.dumps(inspect_layout(args.layout)))
        elif args.command == "build":
            build_dmg(args.app, args.output, args.identity, args.layout, args.skip_staple_validation)
            print(f"Built and verified {args.output}")
        else:
            verify_dmg(args.dmg, args.layout, args.require_staple)
            print(f"Verified {args.dmg}")
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
