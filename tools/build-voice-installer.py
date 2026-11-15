"""Build a self-contained installer with no credentials and no network code."""
import base64
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / "home-assistant/custom_components/alice_gpt_voice"
files = {}
for path in sorted(source.rglob("*")):
    if not path.is_file() or "__pycache__" in path.parts:
        continue
    data = path.read_bytes().replace(b"\r\n", b"\n")
    files[path.relative_to(source).as_posix()] = {
        "data": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()
    }
payload = base64.b64encode(json.dumps(files).encode()).decode()
installer = '''"""Install only alice_gpt_voice; never modify existing configuration or credentials."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import argparse
import uuid

FILES = json.loads(base64.b64decode("PAYLOAD"))

def install(base, update=False):
    base = Path(base).resolve()
    if not (base / "configuration.yaml").is_file():
        raise SystemExit("Upload this installer beside configuration.yaml, then run it again.")
    parent = base / "custom_components"
    if parent.is_symlink():
        raise SystemExit("Refusing a symlink custom_components directory.")
    parent.mkdir(exist_ok=True)
    target = parent / "alice_gpt_voice"
    if target.is_symlink():
        raise SystemExit("Refusing a symlink component directory.")
    if target.exists() and not update:
        raise SystemExit("alice_gpt_voice already exists; nothing was overwritten.")
    if target.exists():
        old_manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        if old_manifest.get("domain") != "alice_gpt_voice":
            raise SystemExit("Refusing to update an unrelated component.")
    temporary = Path(tempfile.mkdtemp(prefix=".alice-gpt-install-", dir=parent))
    try:
        for name, item in FILES.items():
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise SystemExit("Invalid package path.")
            data = base64.b64decode(item["data"], validate=True)
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise SystemExit("Package checksum mismatch.")
            path = temporary / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        manifest = json.loads((temporary / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("domain") != "alice_gpt_voice":
            raise SystemExit("Invalid package domain.")
        backup = None
        if target.exists():
            backup = parent / (".alice-gpt-backup-" + uuid.uuid4().hex)
            os.rename(target, backup)
        try:
            os.rename(temporary, target)
        except BaseException:
            if backup is not None:
                os.rename(backup, target)
            raise
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    print("Installed alice_gpt_voice 0.3.0. Restart Home Assistant. Existing pairing is preserved.")
    if backup is not None:
        print("Previous component saved in " + str(backup))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("base", nargs="?", default=Path(__file__).parent)
    parser.add_argument("--update", action="store_true")
    args = parser.parse_args()
    install(args.base, update=args.update)
'''.replace("PAYLOAD", payload)
destination = root / "public/install-alice-gpt-voice.py"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(installer, encoding="utf-8", newline="\n")
print(f"Built installer: {len(files)} files")
