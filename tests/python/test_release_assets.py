import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/prepare-release-assets.py"
spec = importlib.util.spec_from_file_location("release_assets", SCRIPT)
release_assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_assets)


class ReleaseAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.assets.mkdir()
        self.version = "1.6.2-rc.1"
        self.packages = {
            f"vPaste_{self.version}_windows_x64_setup.exe": b"installer",
            f"vPaste_{self.version}_windows_x64_portable.zip": b"portable",
            **{f"vPaste_{self.version}_macos_{arch}.dmg": arch.encode()
               for arch in ("aarch64", "x86_64", "universal")},
            **{f"vPaste_{self.version}_macos_{arch}.app.tar.gz": arch.encode()
               for arch in ("aarch64", "x86_64")},
        }
        self.metadata = {
            "LICENSE": b"GPL",
            "third-party-notices.md": b"notices",
            "THIRD_PARTY_LICENSES.json": b"{}",
            f"vPaste_{self.version}_sbom.cdx.json": b"{}",
        }
        platforms = {}
        for platform, suffix in (
            ("windows-x86_64", "windows_x64_setup.exe"),
            ("darwin-aarch64", "macos_aarch64.app.tar.gz"),
            ("darwin-x86_64", "macos_x86_64.app.tar.gz"),
        ):
            name = f"vPaste_{self.version}_{suffix}"
            self.metadata[f"{name}.sig"] = f"signature-{platform}".encode()
            platforms[platform] = {
                "url": f"https://github.com/Loxonl/vPaste-desktop/releases/download/v{self.version}/{name}",
                "signature": f"signature-{platform}",
            }
        self.manifest = self.root / "latest.json"
        self.manifest.write_text(json.dumps({"version": self.version, "platforms": platforms}))
        for name, data in {**self.packages, **self.metadata}.items():
            (self.assets / name).write_bytes(data)
        (self.assets / "Loxonl.vPaste.yaml").write_text("winget")
        (self.assets / "SHA256SUMS.txt").write_text("old checksums")

    def test_compacts_to_nine_assets_without_changing_packages(self):
        release_assets.prepare(self.assets, self.version, self.manifest)
        self.assertEqual(len(list(self.assets.iterdir())), 9)
        for name, data in self.packages.items():
            self.assertEqual((self.assets / name).read_bytes(), data)
        archive = self.assets / f"vPaste_{self.version}_release-metadata.zip"
        with zipfile.ZipFile(archive) as bundle:
            self.assertEqual(set(bundle.namelist()), {*self.metadata, "latest.json"})
            for name, data in self.metadata.items():
                self.assertEqual(bundle.read(name), data)
            self.assertEqual(bundle.read("latest.json"), self.manifest.read_bytes())
        checksums = (self.assets / "SHA256SUMS.txt").read_text()
        self.assertIn(archive.name, checksums)
        self.assertNotIn(".sig", checksums)
        self.assertNotIn("Loxonl.vPaste.yaml", checksums)
        for line in checksums.splitlines():
            digest, name = line.split("  ")
            self.assertEqual(digest, hashlib.sha256((self.assets / name).read_bytes()).hexdigest())

    def test_rebuilding_metadata_ignores_source_file_timestamps(self):
        release_assets.prepare(self.assets, self.version, self.manifest)
        archive = self.assets / f"vPaste_{self.version}_release-metadata.zip"
        original = archive.read_bytes()
        for name, data in self.metadata.items():
            (self.assets / name).write_bytes(data)
        release_assets.prepare(self.assets, self.version, self.manifest)
        self.assertEqual(archive.read_bytes(), original)

    def test_rejects_missing_license_before_mutating_staging(self):
        (self.assets / "LICENSE").unlink()
        before = sorted(path.name for path in self.assets.iterdir())
        with self.assertRaisesRegex(ValueError, "LICENSE"):
            release_assets.prepare(self.assets, self.version, self.manifest)
        self.assertEqual(before, sorted(path.name for path in self.assets.iterdir()))

    def test_rejects_a_mismatched_signature(self):
        name = f"vPaste_{self.version}_windows_x64_setup.exe.sig"
        (self.assets / name).write_text("wrong signature")
        with self.assertRaisesRegex(ValueError, "signature"):
            release_assets.prepare(self.assets, self.version, self.manifest)
        self.assertTrue((self.assets / "LICENSE").exists())

    def test_supports_unsigned_drafts_and_preserves_other_tools(self):
        for name in self.metadata:
            if name.endswith(".sig"):
                (self.assets / name).unlink()
        (self.assets / "support-tool_windows_x64.exe").write_bytes(b"tool")
        release_assets.prepare(self.assets, self.version)
        self.assertTrue((self.assets / "support-tool_windows_x64.exe").exists())
        with zipfile.ZipFile(self.assets / f"vPaste_{self.version}_release-metadata.zip") as bundle:
            self.assertNotIn("latest.json", bundle.namelist())


if __name__ == "__main__":
    unittest.main()
