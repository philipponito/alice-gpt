import importlib.util
import pathlib
import tempfile
import unittest
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
            backups = list(target.parent.glob(".alice-gpt-backup-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / "old-marker").read_text(encoding="utf-8"), "old version")
            self.assertEqual((storage / "core.config_entries").read_text(encoding="utf-8"), "synthetic-existing-pairing")
            self.assertEqual((base / "configuration.yaml").read_text(encoding="utf-8"), "default_config:\n")

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
