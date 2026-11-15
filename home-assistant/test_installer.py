import importlib.util
import pathlib
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
