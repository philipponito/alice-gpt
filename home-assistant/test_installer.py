import importlib.util
import pathlib
import tempfile
import unittest
import json
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[1] / "public/install-alice-gpt-voice.py"
spec = importlib.util.spec_from_file_location("installer", path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    def test_installs_package_and_preserves_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            base = pathlib.Path(folder)
            config = base / "configuration.yaml"
            config.write_text("default_config:\n", encoding="utf-8")
            installer.install(base)
            component = base / "custom_components/alice_gpt_voice"
            self.assertTrue((component / "__init__.py").is_file())
            self.assertTrue((component / "translations/ru.json").is_file())
            self.assertEqual(config.read_text(encoding="utf-8"), "default_config:\n")
            with self.assertRaises(SystemExit):
                installer.install(base)

    def test_rejects_wrong_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(SystemExit):
                installer.install(folder)
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])

    def test_update_backs_up_component_and_keeps_pairing_and_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            base = pathlib.Path(folder)
            (base / "configuration.yaml").write_text("default_config:\n", encoding="utf-8")
            storage = base / ".storage"
            storage.mkdir()
            (storage / "core.config_entries").write_text("synthetic-existing-pairing", encoding="utf-8")
            installer.install(base)
            target = base / "custom_components/alice_gpt_voice"
            (target / "old-marker").write_text("old version", encoding="utf-8")
            installer.install(base, update=True)
            self.assertFalse((target / "old-marker").exists())
            backups = list((base / "alice_gpt_voice_backups").glob("alice-gpt-backup-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / "old-marker").read_text(encoding="utf-8"), "old version")
            self.assertEqual((storage / "core.config_entries").read_text(encoding="utf-8"), "synthetic-existing-pairing")
            self.assertEqual((base / "configuration.yaml").read_text(encoding="utf-8"), "default_config:\n")

    def test_migrates_legacy_backups_and_avoids_duplicate_domains_in_loader_scan(self):
        with tempfile.TemporaryDirectory() as folder:
            base = pathlib.Path(folder)
            (base / "configuration.yaml").write_text("default_config:\n", encoding="utf-8")
            installer.install(base)
            parent = base / "custom_components"
            for index, version in enumerate(("0.2.0", "0.3.0")):
                old = parent / (".alice-gpt-backup-" + str(index) * 32)
                old.mkdir()
                (old / "manifest.json").write_text(json.dumps({"domain": "alice_gpt_voice", "version": version}), encoding="utf-8")
                (old / "marker").write_text(version, encoding="utf-8")
            unrelated = parent / "other_integration"
            unrelated.mkdir()
            (unrelated / "marker").write_text("keep", encoding="utf-8")
            installer.install(base, update=True)
            # HA 2026.11 scans every child directory and indexes by manifest
            # domain: old dot backups must not override the real component.
            matches = [p.name for p in parent.iterdir() if p.is_dir() and (p / "manifest.json").exists()
                       and json.loads((p / "manifest.json").read_text(encoding="utf-8")).get("domain") == "alice_gpt_voice"]
            self.assertEqual(matches, ["alice_gpt_voice"])
            saved = base / "alice_gpt_voice_backups"
            for index, version in enumerate(("0.2.0", "0.3.0")):
                self.assertEqual((saved / (".alice-gpt-backup-" + str(index) * 32) / "marker").read_text(encoding="utf-8"), version)
            self.assertEqual((unrelated / "marker").read_text(encoding="utf-8"), "keep")
            self.assertEqual(len(list(saved.iterdir())), 3)

    def test_rejects_symlink_backup_location_before_replacing_component(self):
        with tempfile.TemporaryDirectory() as folder:
            base = pathlib.Path(folder)
            (base / "configuration.yaml").write_text("default_config:\n", encoding="utf-8")
            installer.install(base)
            real_check = pathlib.Path.is_symlink
            with patch.object(pathlib.Path, "is_symlink", lambda p: p.name == "alice_gpt_voice_backups" or real_check(p)):
                with self.assertRaises(SystemExit):
                    installer.install(base, update=True)
            self.assertTrue((base / "custom_components/alice_gpt_voice/__init__.py").exists())

    def test_failed_update_restores_previous_component(self):
        with tempfile.TemporaryDirectory() as folder:
            base = pathlib.Path(folder)
            (base / "configuration.yaml").write_text("default_config:\n", encoding="utf-8")
            installer.install(base)
            target = base / "custom_components/alice_gpt_voice"
            (target / "old-marker").write_text("old", encoding="utf-8")
            rename = installer.os.rename

            def fail_new_package(source, destination):
                if pathlib.Path(source).name.startswith(".alice-gpt-install-"):
                    raise OSError("synthetic installation failure")
                return rename(source, destination)

            with patch.object(installer.os, "rename", side_effect=fail_new_package):
                with self.assertRaises(OSError):
                    installer.install(base, update=True)
            self.assertEqual((target / "old-marker").read_text(encoding="utf-8"), "old")


if __name__ == "__main__":
    unittest.main()
