import json
import importlib.util
from unittest import mock
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build-macos-dmg.py"
SPEC = importlib.util.spec_from_file_location("build_macos_dmg", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def png_with_size(path: Path, width: int, height: int) -> None:
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + struct.pack(">II", width, height)
        + b"\x08\x06\x00\x00\x00"
    )


def make_mounted_volume(mount: Path, app_position: tuple[int, int] = (170, 170), alias: bytes | None = None) -> None:
    from ds_store import DSStore
    from mac_alias import Alias

    (mount / "vPaste.app" / "Contents").mkdir(parents=True)
    (mount / "vPaste.app" / "Contents" / "Info.plist").write_bytes(b"plist")
    (mount / "Applications").symlink_to("/Applications")
    background = mount / ".background.tiff"
    background.write_bytes(b"tiff")
    if alias is None:
        record = Alias.for_file(str(background))
        record.target.cnid_path = []
        alias = record.to_bytes()
    with DSStore.open(str(mount / ".DS_Store"), "w+") as store:
        store["."]["bwsp"] = {"WindowBounds": "{{100, 100}, {660, 400}}"}
        store["."]["icvp"] = {
            "backgroundType": 2, "backgroundImageAlias": alias,
            "iconSize": 128, "arrangeBy": "none",
        }
        store["."]["icvl"] = (b"type", b"icnv")
        store["vPaste.app"]["Iloc"] = app_position
        store["Applications"]["Iloc"] = (490, 170)


class MacosDmgLayoutTests(unittest.TestCase):
    def run_inspect(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "inspect", *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_inspect_reports_the_background_and_icon_layout(self) -> None:
        result = self.run_inspect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "window_size": [660, 400],
                "icon_size": 128,
                "icon_locations": {
                    "vPaste.app": [170, 170],
                    "Applications": [490, 170],
                },
                "background_size": [660, 400],
                "retina_size": [1320, 800],
            },
        )

    def test_inspect_rejects_a_wrong_retina_size(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "layout.json").write_text(
                json.dumps(
                    {
                        "windowSize": {"width": 660, "height": 400},
                        "iconSize": 128,
                        "appPosition": {"x": 170, "y": 170},
                        "applicationFolderPosition": {"x": 490, "y": 170},
                        "background": "background.png",
                    }
                ),
                encoding="utf-8",
            )
            png_with_size(directory / "background.png", 660, 400)
            png_with_size(directory / "background@2x.png", 660, 400)

            result = self.run_inspect("--layout", str(directory / "layout.json"))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("background@2x.png", result.stderr)
            self.assertIn("1320x800", result.stderr)

    def test_inspect_rejects_a_background_that_does_not_fill_the_window(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "layout.json").write_text(
                json.dumps(
                    {
                        "windowSize": {"width": 660, "height": 400},
                        "iconSize": 128,
                        "appPosition": {"x": 170, "y": 170},
                        "applicationFolderPosition": {"x": 490, "y": 170},
                        "background": "background.png",
                    }
                ),
                encoding="utf-8",
            )
            png_with_size(directory / "background.png", 320, 200)
            png_with_size(directory / "background@2x.png", 1320, 800)

            result = self.run_inspect("--layout", str(directory / "layout.json"))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("background.png", result.stderr)
            self.assertIn("660x400", result.stderr)

    def test_build_settings_keep_app_and_folder_at_layout_positions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "vPaste.app"
            app.mkdir()
            settings = MODULE.build_settings(app, MODULE.DEFAULT_LAYOUT)

        self.assertEqual(settings["files"], [str(app)])
        self.assertEqual(settings["symlinks"], {"Applications": "/Applications"})
        self.assertEqual(settings["icon_locations"], {
            "vPaste.app": (170, 170),
            "Applications": (490, 170),
        })
        self.assertEqual(settings["window_rect"][1], (660, 400))
        self.assertEqual(settings["icon_size"], 128)
        self.assertEqual(settings["default_view"], "icon-view")
        self.assertEqual(settings["background"], str(MODULE.DEFAULT_LAYOUT.parent / "background.png"))

    def test_mount_device_accepts_canonicalized_mount_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            real = Path(temporary) / "real"
            real.mkdir()
            alias = Path(temporary) / "alias"
            alias.symlink_to(real, target_is_directory=True)
            entities = [{"dev-entry": "/dev/disk4s1", "mount-point": str(alias)}]
            self.assertEqual(MODULE.mount_device(entities, real), "/dev/disk4s1")

    def test_tiff_sizes_include_normal_and_retina_representations(self) -> None:
        output = "Directory at 0x1\n  Image Width: 660 Image Length: 400\nDirectory at 0x2\n  Image Width: 1320 Image Length: 800\n"
        with mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)):
            self.assertEqual(MODULE.tiff_sizes(Path("background.tiff")), [(660, 400), (1320, 800)])

    @unittest.skipUnless(importlib.util.find_spec("ds_store"), "dmgbuild dependencies are not installed")
    def test_verify_mounted_volume_rejects_a_shifted_app_icon(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)
            make_mounted_volume(mount, app_position=(180, 170))
            with mock.patch.object(MODULE, "tiff_sizes", return_value=[(660, 400), (1320, 800)]):
                with self.assertRaisesRegex(ValueError, "vPaste.app"):
                    MODULE.verify_mounted_volume(mount, MODULE.DEFAULT_LAYOUT)

    @unittest.skipUnless(importlib.util.find_spec("ds_store"), "dmgbuild dependencies are not installed")
    def test_verify_mounted_volume_rejects_an_incomplete_app(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)
            make_mounted_volume(mount)
            with mock.patch.object(MODULE, "tiff_sizes", return_value=[(660, 400), (1320, 800)]):
                with self.assertRaisesRegex(ValueError, "executable"):
                    MODULE.verify_mounted_volume(mount, MODULE.DEFAULT_LAYOUT)

    @unittest.skipUnless(importlib.util.find_spec("ds_store"), "dmgbuild dependencies are not installed")
    def test_verify_mounted_volume_rejects_an_invalid_background_alias(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)
            make_mounted_volume(mount, alias=b"not-an-alias")
            with mock.patch.object(MODULE, "tiff_sizes", return_value=[(660, 400), (1320, 800)]):
                with self.assertRaisesRegex(ValueError, "background alias"):
                    MODULE.verify_mounted_volume(mount, MODULE.DEFAULT_LAYOUT)

    @unittest.skipUnless(importlib.util.find_spec("ds_store"), "dmgbuild dependencies are not installed")
    def test_verify_mounted_volume_rejects_an_invalid_app_signature(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)
            make_mounted_volume(mount)
            executable = mount / "vPaste.app" / "Contents" / "MacOS" / "vPaste"
            executable.parent.mkdir()
            executable.write_bytes(b"executable")
            executable.chmod(0o755)
            failed = subprocess.CalledProcessError(1, ["codesign"], stderr="broken signature")
            with mock.patch.object(MODULE, "tiff_sizes", return_value=[(660, 400), (1320, 800)]):
                with mock.patch.object(MODULE.subprocess, "run", side_effect=failed):
                    with self.assertRaisesRegex(ValueError, "signature"):
                        MODULE.verify_mounted_volume(mount, MODULE.DEFAULT_LAYOUT)

    @unittest.skipUnless(importlib.util.find_spec("ds_store"), "dmgbuild dependencies are not installed")
    def test_signed_volume_requires_a_stapled_app(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)
            make_mounted_volume(mount)
            executable = mount / "vPaste.app" / "Contents" / "MacOS" / "vPaste"
            executable.parent.mkdir()
            executable.write_bytes(b"executable")
            executable.chmod(0o755)
            signed = subprocess.CompletedProcess(["codesign"], 0, "")
            unstapled = subprocess.CalledProcessError(1, ["xcrun", "stapler"], stderr="ticket missing")
            with mock.patch.object(MODULE, "tiff_sizes", return_value=[(660, 400), (1320, 800)]):
                with mock.patch.object(MODULE.subprocess, "run", side_effect=[signed, unstapled]):
                    with self.assertRaisesRegex(ValueError, "stapled"):
                        MODULE.verify_mounted_volume(mount, MODULE.DEFAULT_LAYOUT, require_staple=True)


if __name__ == "__main__":
    unittest.main()
